# cf-sync-engine — Design

A server-authoritative, Linear-style sync engine built on Cloudflare Durable Objects —
a standalone library intended as the data foundation for collaborative, offline-capable
apps. Client state is managed by TanStack DB via a custom collection adapter.

This document locks the decisions that are expensive to reverse. Every mechanism here is
grounded in prior art cloned into `reference/` (file:line citations throughout):

- `reference/rocicorp-mono` — Replicache push/pull/poke contracts, versioning strategies, Zero's server mutators
- `reference/livestore` — the most mature CF-native sync backend (`@livestore/sync-cf`)
- `reference/tanstack-db` — the client collection contract our adapter implements
- `reference/partyserver`, `reference/tldraw-sync-cloudflare` — production DO hibernation patterns

## 1. Goals and non-goals

**Goals**

- Server-authoritative sync: the server is the only writer of canonical state; clients are optimistic caches that converge.
- Linear-grade UX: instant optimistic mutations, real-time propagation to other clients, offline-tolerant reconnect.
- Cloudflare-native: Workers + Durable Objects + DO SQLite only. No external database tier.
- A protocol simple enough to hold in your head, testable by deterministic simulation.

**Non-goals (v1)**

- Row-level read permissions / partial sync. v1 syncs a whole workspace to any member (§10).
- Collaborative text editing. Character-level merging never flows through the row-sync mutation log. See §14 for the tiered strategy (revised 2026-07: LWW rows by default, in-workspace-DO Yjs for fields that prove to need merging).
- Cross-workspace transactions. Moving data between workspaces is an application-level saga.
- General-purpose infrastructure. One partition scheme, one conflict strategy, one client (TanStack DB).

## 2. Architecture overview

```
 browser                      edge worker                durable object (one per workspace)
┌──────────────────────┐     ┌──────────────┐           ┌───────────────────────────────┐
│ TanStack DB          │     │ auth at      │           │ WorkspaceDO                   │
│  collections         │ WS  │ upgrade,     │ idFromName│  ├─ SQLite: rows, mutation    │
│  optimistic overlay  │◄───►│ route by     │──────────►│  │  log, client LMIDs, meta   │
│  custom sync adapter │     │ workspaceId  │           │  ├─ authoritative mutators    │
│  pending mutations   │     └──────────────┘           │  ├─ hibernating WebSockets    │
└──────────────────────┘                                │  └─ broadcast (data pokes)    │
                                                        └───────────┬───────────────────┘
                                                                    │ async export
                                                                    ▼
                                                         R2 (mutation-log archive, backups)
```

Flow: client applies a named mutation optimistically → pushes it over the WebSocket →
the DO re-runs the mutator authoritatively against SQLite, stamps changed rows with the
next per-DO version, advances the client's `lastMutationId` in the same transaction →
broadcasts a data-carrying poke (patch + confirmations) to all connected clients →
each client applies the patch as new base state and drops/rebases optimistic mutations.

## 3. Locked decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | One DO per **workspace**, addressed via `idFromName(workspaceId)` | Matches Linear's sync scope; coarse enough that cross-partition ops are rare. LiveStore (`storeId`), tldraw (`roomId`), partyserver all use this pattern. |
| D2 | Replicache-style protocol: **push / pull / data-carrying poke** | Battle-tested contract with normative docs (`reference/rocicorp-mono/packages/replicache-doc/docs/`). On a persistent socket we deliver the pull payload inside the poke (Replicache's internal `Poke {baseCookie, pullResponse}`, `packages/replicache/src/types.ts:12-20`) — no pull round-trip in steady state. |
| D3 | **DO SQLite is the system of record.** Mutation log streamed to R2 asynchronously for archive/analytics. | Half-committing (dual synchronous writes to DO + external DB) is where sync engines get miserable. DO SQLite has point-in-time recovery; R2 export covers everything beyond it. LiveStore's D1 backend exists and brings 1MB-response workarounds we simply avoid (`sync-cf/.../sync-storage.ts:45-73`). |
| D4 | Versioning: **per-DO monotonic version counter** (the "per-space version" strategy). Cursor = `{ backendId, version }`. | The DO's single-threaded execution provides exactly the serialization that makes a monotonic integer cursor correct — it eliminates the timestamp race Replicache documents (`strategies/global-version.md:161-179`). `backendId` (random id minted when the DO's history begins, LiveStore pattern) detects resets/truncation: cursor with stale `backendId` → full re-bootstrap. |
| D5 | Mutations are **named, intent-based ops** with client-assigned sequential ids; server enforces the **lastMutationId contract** | `issue.move`, not "set field X". Intent survives rebase and lets the server enforce invariants. Idempotency: per-client LMID; incoming id `< LMID+1` skip, `= LMID+1` apply, `>` reject (`server-push.md:189-192`; Zero `process-mutations.ts:662-682`). |
| D6 | Client is a **TanStack DB custom collection** (collection options creator) | First-class extension point (`reference/tanstack-db/docs/guides/collection-options-creator.md`). Confirmation = the mutation handler resolves only when the server confirms the mutation id (Electric's `awaitTxId` pattern, `electric.ts:709-769`). |
| D7 | **Snapshot-then-tail is the only bootstrap path.** Fresh client = cursor 0. | One code path, exercised constantly. The `clear` patch op (Replicache `patch-operation.ts:37-49`) makes reset a normal protocol message, not a special mode. |
| D8 | Deletes are **tombstones** (`deleted` flag + version bump), compacted after a horizon; `minCursorVersion` tracks the horizon | Required for incremental pull correctness. Clients whose cursor predates `minCursorVersion` get `clear` + snapshot. |
| D9 | Transport: **hibernating WebSockets**, chunked at **900 KB** | LiveStore found frames just under 1MB fail on hibernated sockets (`sync-cf/src/common/constants.ts`). HTTP-polling fallback is a v2 concern; the protocol messages are transport-agnostic JSON so adding it later is mechanical. |
| D10 | Protocol and mutators are **versioned**; incompatible clients are told to reload, never fed data they half-understand | `VersionNotSupported` response (Replicache `error-responses.ts:32-58`). Mutator names deployed under a schema version are never removed — Replicache stubs missing mutators to no-ops during rebase and silently loses effects (`db/rebase.ts:44-59`). |

## 4. Wire protocol

All messages are JSON over the WebSocket. `protocolVersion` and `schemaVersion` are
exchanged at connect; a mismatch closes the socket with a typed error.

### 4.1 Client → server

```ts
// Sent once after connect. Also (re)subscribes and requests catch-up.
type HelloMsg = {
  type: 'hello'
  protocolVersion: number
  schemaVersion: number       // the app's integer schema version (defineApp)
  cursor: { backendId: string; version: number } | null   // null = bootstrap
}

type Mutation = {
  id: number                  // per-client sequence, 1-based, contiguous
  name: string                // mutator name, e.g. 'issue.move'
  args: Json
}

type PushMsg = {
  type: 'push'
  mutations: Mutation[]       // ascending by id
}
```

The clientId is bound at connection time (URL param at upgrade, stored in the socket
attachment) rather than carried per-message, so a connection cannot speak for another
client mid-stream. A clientId names one contiguous mutation sequence, so it must be
unique per SyncClient instance (per tab/session — sessionStorage, not localStorage);
two tabs sharing a clientId would collide on mutation ids.

Modeled on Replicache `PushRequestV1` / `MutationV1` (`sync/push.ts:36-78`). We drop
`timestamp` (unused in the protocol per their own docs) and `profileID`.

### 4.2 Server → client

```ts
// The data-carrying poke. Also the response to catch-up and bootstrap —
// bootstrap is just a poke stream starting from a `clear`.
type PokeStartMsg = { type: 'pokeStart'; pokeId: string; baseCursor: Cursor | null }
type PokePartMsg  = {
  type: 'pokePart'
  pokeId: string
  patch: PatchOp[]                              // chunked ≤ 900KB per frame
  remaining?: number                             // ops still to come (bootstrap progress)
  lastMutationIdChanges?: Record<string, number> // clientId -> confirmed LMID
  mutationResults?: MutationResult[]             // per-mutation app errors (§6)
}
type PokeEndMsg   = {
  type: 'pokeEnd'
  pokeId: string
  cursor: Cursor
  pageInfo: { more: false } | { more: true; remaining: number }
}

type PatchOp =
  | { op: 'put'; tbl: string; id: string; value: Json }   // full row
  | { op: 'del'; tbl: string; id: string }
  | { op: 'clear' }                                       // reset all synced state

type ErrorMsg = {
  type: 'error'
  code: 'VersionNotSupported' | 'CursorInvalid' | 'BadMessage' | 'PushInvalid'
      | 'Unauthorized' | 'Internal'
  message?: string
}
```

The three-part poke is Zero's shape (`zero-protocol/src/poke.ts:32-73`) — it exists so
large payloads stream in chunks without server-side buffering, and it doubles as our
chunked bootstrap. `pageInfo` countdown is LiveStore's progress signal
(`sync-backend.ts:143-155`), which lets the client render bootstrap progress.

Client-side validation rules (from Replicache `handlePullResponseV1`,
`sync/pull.ts:203-302`): a poke whose `baseCursor` doesn't match the client's current
cursor is discarded and the client requests catch-up (`hello` with its cursor); cursors
and per-client LMIDs must never move backward.

### 4.3 Cursor and reset semantics

- `cursor.version` is the per-DO monotonic version at `pokeEnd` time.
- `cursor.backendId` mismatch, or `cursor.version < minCursorVersion` (compaction
  horizon), or unknown cursor → server replies `pokeStart(baseCursor: null)` +
  `clear` + full snapshot. Reset is not an error; it's the bootstrap path.
- A poke whose patch contains `clear` is a complete state replacement, so clients
  apply it from **any** base (admin import/reset converge live clients in one trip).
  Any other base-mismatched poke means a missed poke → resync by cursor. A changed
  `backendId` in `pokeEnd.cursor` is a new history: the client resets its confirmed
  LMID and renumbers its unconfirmed outbox from the new baseline.

## 5. Durable Object storage schema

```sql
-- Canonical rows. Generic JSON storage in v1; per-table typed columns are a
-- migration inside the DO, invisible to the protocol.
CREATE TABLE rows (
  tbl        TEXT    NOT NULL,
  id         TEXT    NOT NULL,      -- client-generated ULID
  data       TEXT    NOT NULL,      -- JSON
  version    INTEGER NOT NULL,      -- per-DO version at last write
  deleted    INTEGER NOT NULL DEFAULT 0,   -- tombstone
  PRIMARY KEY (tbl, id)
) STRICT;
CREATE INDEX rows_by_version ON rows (version);

-- Applied-mutation log (audit + R2 export + debugging; NOT used for pull).
-- Keyed by its own sequence: a mutation that writes no rows (app error,
-- no-op) advances the client's LMID without a data version, so cursor
-- versions track data changes only and LMID-only advances never force a
-- broadcast to keep other clients' cursors aligned.
CREATE TABLE mutation_log (
  log_seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  version    INTEGER,               -- data version, NULL if nothing was written
  client_id  TEXT    NOT NULL,
  mutation_id INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  args       TEXT    NOT NULL,
  result     TEXT    NOT NULL       -- 'ok' | serialized app error
) STRICT;

-- Per-client sync state.
CREATE TABLE clients (
  client_id        TEXT PRIMARY KEY,
  last_mutation_id INTEGER NOT NULL DEFAULT 0,
  last_seen_at     TEXT NOT NULL
) STRICT;

-- One row of workspace metadata.
CREATE TABLE meta (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  backend_id         TEXT    NOT NULL,   -- random id, minted at first init
  current_version    INTEGER NOT NULL DEFAULT 0,
  min_cursor_version INTEGER NOT NULL DEFAULT 0,  -- compaction horizon
  schema_version     TEXT    NOT NULL
) STRICT;
```

Pull-after-cursor is a single indexed scan: `SELECT ... FROM rows WHERE version > ?`
(tombstones included). This is the per-space-version strategy's O(index scan) pull —
the reason we chose it over CVR/row-version diffing.

Compaction (implemented in M1): a DO alarm periodically hard-deletes tombstones with
`version <= current_version - retention` and advances `min_cursor_version` to the
youngest deleted tombstone — any client at or past it already received every delete
being discarded. Clients under the horizon re-bootstrap (§4.3). Configured per DO
class via `compaction: { tombstoneRetentionVersions, intervalMs }` (defaults: 10k
versions, 6h). `backend_id` changes only if the DO is wiped entirely.

Storage-format changes run through an append-only migration list tracked in a
`_migrations` table (DO SQLite doesn't expose `PRAGMA user_version`), applied once
per DO inside the constructor's `blockConcurrencyWhile`.

## 6. Server mutation processing

Per push message, inside `blockConcurrencyWhile` (LiveStore serializes its head
check-and-append the same way, `push.ts:63-87`):

```
for each mutation m in push.mutations:
  expected = clients[clientId].last_mutation_id + 1
  if m.id < expected:  continue            // duplicate delivery — idempotent skip
  if m.id > expected:  reject push, error 'PushInvalid'   // gap — client must resync

  in one SQLite transaction:
    result = run mutator m.name(m.args)    // validates auth + invariants, writes rows
                                           // every written row gets version = current_version + 1
    if result is a PERMANENT app error:
       // still advance LMID and log the error result — otherwise the client
       // retries forever (Replicache server-push.md:165-202, Zero's 3-phase apply)
    clients[clientId].last_mutation_id = m.id      // same tx as data effects — atomicity is the contract
    meta.current_version += 1
    append to mutation_log

after the batch: build one poke (patch of rows with version > previous current_version,
lastMutationIdChanges, mutationResults) and broadcast to all sockets, chunked.
```

Two invariants carry the whole design:

1. **Atomicity** — a mutation's data effects and its LMID advance commit together
   (`server-push.md:155-159`). This is what makes confirmation on the client sound.
2. **Permanent errors advance the LMID.** Only transient errors (storage failure)
   abort without advancing, which the client treats as "server offline, retry".

Mutators are `{ args?, apply }` definitions registered via `defineMutators(schema, …)`
in `@cf-sync/protocol` (the only package importable from both worker and browser):
`args` is a standard schema (zod in practice) the engine validates *before* `apply`
runs, and `apply(tx, args, ctx)` is a plain synchronous function. The registry is
shared: the server runs `apply` authoritatively; the client uses the same object for
typed `mutate(name, args)` calls and local fail-fast args validation (the wire always
carries the caller's original args — the server's parse is authoritative).
Shared-mutator isomorphism for optimistic application is the Replicache/Zero model
and stays open as a future step on the same registry.

Version, schema, mutators, and the migration chain (§9) travel together as one
`defineApp({ version, schema, mutators, migrations })` value — the single object
passed to both `createWorkspaceDO` and `SyncClient`. This makes "client and server
disagree about the shape or the mutator set" unrepresentable, and puts the version
bump and its migration step in the same literal so forgetting one is a startup
error in both bundles (the chain must end at `version`), not silent skew.

### 6a. Schema and shape authority

`defineSchema` declares every synced table's row schema (standard schema, zod in
practice) and reaches both `createWorkspaceDO` and `SyncClient` inside the shared
`defineApp` value. The engine enforces it at the only place rows enter storage —
`tx.put`, shared by mutators, schema migrations, and admin import:

- `put` to a table not in the schema, or with a payload that fails its schema, is a
  permanent `InvalidArgs` app error (LMID still advances, §6 invariant 2). What gets
  stored is the *parsed output* — schema defaults are applied server-side.
- `get`/`list`/`del` stay schema-loose at runtime so schema migrations can read and
  clean up tables that left the schema; reads return raw stored JSON (during a
  migration that is whatever shape the previous version — or previous chain step —
  left). Migration replays defer `put` validation to commit: the chain's *net
  result* must parse, intermediate shapes are transient (§9).
- Validation must be synchronous (mutations commit inside `transactionSync`); a
  validator returning a Promise is rejected as a permanent error.

Type-side, the same schema gives mutators a typed `tx`, collections their row types
(input type for inserts — defaults omissible — output type for reads), and
`mutate` its per-mutator args types. The server was already the authority on
conflicts and invariants; the schema makes it the authority on shape.

## 7. Client: TanStack DB adapter

The adapter is a collection options creator implementing `SyncConfig.sync`
(`reference/tanstack-db/packages/db/src/types.ts:327-360`). Mapping:

| Engine concept | TanStack DB call |
|---|---|
| `pokeStart` | `begin()` |
| `pokePart` patch op `put`/`del` | `write({type, value…})` — one collection per `tbl` |
| `pokePart` patch op `clear` | `truncate()` (preserves optimistic overlay via its snapshot mechanism, `sync.ts:214-248`) |
| `pokeEnd` | `commit()`; the cursor is persisted by the client-level `SyncStore` (§7.1), not per-collection metadata — one workspace cursor spans every table |
| first `pokeEnd` with `more: false` | `markReady()` — also called in the error path so `preload()` never hangs |

The adapter derives everything per-table from the shared schema (§6a): the row type
and TanStack's `schema` option (client-side validation of optimistic writes) come
from `defineSchema`'s table entry, and `getKey` defaults to `row.id` when the row
schema has a string `id`.

**Mutation path (Pattern B — the adapter owns the handlers):** `onInsert/onUpdate/onDelete`
enqueue named mutations into a per-client outbox with the next sequential id, send a
`push`, and return a promise that resolves when `lastMutationIdChanges[clientId] >= id`
arrives in a poke — the direct analogue of Electric's `awaitTxId`
(`electric.ts:709-769`). TanStack DB then drops the optimistic overlay for confirmed
keys and recomputes it from still-pending transactions (`state.ts:1146-1189`) — the
client-side rebase comes for free from the store; we never implement rewind/replay
ourselves.

Races are handled by the paved paths: the core auto-downgrades echo inserts that
deep-equal existing rows into updates (`sync.ts:133-164`), and the collection guide
mandates buffer-then-dedup between bootstrap and live events
(`collection-options-creator.md`).

### 7.1 Offline durability: the `SyncStore` seam (M3, decided)

We evaluated `@tanstack/db-sqlite-persistence-core` (0.2.x alpha) and
`@tanstack/offline-transactions` (1.0.x) and decided to own this layer. Rationale:

- **The cursor is per-workspace; their persistence is per-collection.** One poke
  spans many tables and commits against one cursor. TanStack's model has no
  transaction covering "all tables' rows + the cursor". IndexedDB does: one
  transaction spans object stores, so rows, cursor, `confirmedLmid`, and the outbox
  commit atomically — the client-side mirror of invariant §6.1.
- **offline-transactions duplicates the LMID contract.** It brings its own
  idempotency keys, retry scheduler, and replay; ours is the protocol itself
  (contiguous per-client ids, server dedup). Its `mutationFn` would wrap
  `SyncClient.mutate`, nesting one outbox inside another, and its optimistic
  restore reaches into `collection._state` internals.
- What we *did* adopt from their design: delay `markReady` until hydration
  completes, and hydrate before any network I/O.

`SyncClient` takes an optional `store: SyncStore` (`packages/client/src/store.ts`);
`IndexedDBSyncStore` is the browser implementation, `MemorySyncStore` the test
double. If TanStack's sqlite stack matures, it can implement `SyncStore` without
touching the protocol.

**Invariant: the persisted cursor is never newer than the persisted rows.** Behind
is always safe — patches are idempotent full-row puts/dels, so re-applying a delta
converges. Ahead would silently skip deltas.

**Multi-tab.** Rows + cursor are shared per workspace (db `cf-sync:<workspaceId>`);
outbox records are partitioned by clientId (each tab replays only its own
mutations; stale records GC'd after 30 days). Concurrent writers need no leader
election: catch-up patches carry *current row state as of the poke's end cursor*,
not historical deltas, so a poke that doesn't advance the stored cursor is wholly
subsumed by what a newer writer already stored and is skipped (the subsumption
guard in `applyPoke`).

**Semantics locked in:**
- After a reload, replayed-but-unconfirmed mutations do not show optimistically —
  the UI shows last-synced state until the server confirms. (§7.2's local apply
  makes Replicache-style startup replay *possible*; it is deliberately deferred —
  see the phase-2 note there — so this rule stands.)
- With a store, there is **no confirm timeout** (revised 2026-07-23): the
  caller's promise stays pending until a connection confirms — the durable
  intent *will* apply, so a `Timeout` rejection would report a failure that
  isn't one (the original design rejected-but-kept-queued, which made
  rejection mean "overlay gone" rather than "won't apply" — a trap for every
  `catch` block). A rejection now always means the mutation will not apply:
  permanent app error, `stop()`, or fatal. Without a store,
  `confirmTimeoutMs` still rejects *and discards* — honest, because a
  memory-only mutation would not survive a reload anyway.
- `stop()` rejects in-flight callers but leaves the durable outbox intact; a
  schema-version mismatch at hydration discards cache *and* queued mutations
  (they target the old schema); a `backendId` change flows through naturally as
  a clear poke.
- `onMutationRejected` (added 2026-07-24) is the central rejection surface:
  every `MutationError` a `mutate` or collection-write promise would carry is
  also delivered to this constructor hook, including rejections with **no
  awaiting caller** — collection handler writes, and outbox entries restored
  after a reload (whose promises died with the previous session; without the
  hook, a replayed mutation the server refuses rolls back invisibly — the
  silent-revert trap). With the hook set, returned promises are pre-marked
  handled, so fire-and-forget call sites raise no unhandled-rejection noise
  while awaiting callers still observe the same rejection.

### 7.2 Optimistic intent mutators (decided, implemented)

Intent mutations (`client.mutate.todos.clearCompleted()`) run the shared
`apply` **speculatively on the client** so their effects show instantly,
while the server's authoritative run remains the truth. No new public API:
`mutate` becomes optimistic when collections are attached; without them it
degrades to today's server-only behavior. This kills the double-mutation
workaround (intent mutation + N manual crud mirrors = N+1 wire mutations for
one user action — and the mirrors are *competing server mutations*, not an
overlay: they'd commit even if the intent were rejected).

**Prior art.** Three models exist for an intent's optimistic effect; which
one we're in matters more than any API choice. Replicache/Zero store a
re-executable recipe (`{mutatorName, args}`) and **re-execute** it against the
new base on rebase (`replicache/src/db/rebase.ts:25-99`; replay set selection
in `sync/pull.ts:354-394`). LiveStore makes the mutator canonical: mutations
are an event log, state is materialized from it, and rebase rolls back
per-event changesets and re-runs materializers over the reordered log
(`@livestore/common/src/sync/ClientSessionSyncProcessor.ts:170-247`) — hard
determinism required. TanStack DB stores a **frozen diff**: the optimistic
callback runs once and rebase re-layers the snapshots; logic never re-runs.
We are in the TanStack model by prior decision (§7: "we never implement
rewind/replay ourselves"). Two ecosystem facts support the design: TanStack's
own mutations guide recommends exactly this transaction pattern for
intent-based, multi-collection mutations (`docs/guides/mutations.md:161-199`),
and our registry independently converged on Zero's newest mutator API shape
(`zql/src/mutate/mutator.ts:191-199`), which is why their client-execution
story ports cleanly onto our shared `apply`.

**Mechanism.** TanStack DB provides exactly the needed seams, verified against
its source:

1. Collection writes inside an explicit transaction's `mutate()` callback join
   that transaction and **bypass `onInsert`/`onUpdate`/`onDelete`**
   (`collection/mutations.ts:224`) — the transaction's `mutationFn` is the sole
   persistence path. So: one `createTransaction` per intent mutation, overlay
   writes across any number of collections, `mutationFn` = enqueue in the
   outbox and await confirm (the existing path, untouched).
2. While a transaction is `persisting`, synced commits buffer instead of
   applying (`collection/state.ts:876`), and `#applyPoke` writes the
   authoritative patch into the table hooks *before* settling the confirm
   promise. Net ordering: patch buffers → confirm resolves → transaction
   completes → buffered patch applies and the overlay drops in one recompute —
   an atomic swap, not just a favorable ordering. The crud path already rides
   this. (One exception: `hasTruncateSync` bypasses the buffer, so a reset
   poke's `clear` applies immediately even mid-persist — benign, truncate
   preserves overlays via its snapshot mechanism.)
3. On synced changes underneath a pending transaction, TanStack recomputes the
   overlay from each pending mutation's **frozen** `modified` value
   (`collection/state.ts:611-637`) — pending logic is never re-run.
4. Our mutator surface is already client-executable: `apply` is synchronous —
   matching TanStack's synchronous-`onMutate` rule exactly (Zero needed async
   plumbing; we don't) — `MutatorTx` is four methods, and `MutatorContext` is
   `{ clientId }`, which the client has.

The speculative run goes through a `LocalWriteSet` mirroring the server's
`WriteSet`: reads check its own buffer first, then the collection's optimistic
view (which already includes earlier pending transactions, so back-to-back
intents read each other); `put` validates input → stored output through the
table schema exactly like the server. Only after `apply` completes does the
buffer flush into the TanStack transaction (insert-vs-update by key presence;
`transaction.metadata` tagged with the intent name for debuggability).

Plumbing: `SyncClient` stays framework-agnostic — the collection adapter
injects one applier function, and `client.ts` never imports TanStack. The
crud handlers (`onInsert`/`onUpdate`/`onDelete`) switch to an internal
raw-enqueue path so a `sync.put` emitted by a collection write doesn't
recursively spawn a second transaction.

**Decisions:**

- **Rebase = frozen writes, not re-run.** A `clearCompleted` overlay won't
  retroactively clear a todo completed remotely mid-flight; the server's run
  sees current state and its confirm patch replaces the overlay. Prediction,
  then truth. Re-running `apply` on rebase (Replicache's model) would
  contradict this section's premise that TanStack owns rebase, for a
  divergence window bounded by one round-trip.
- **Determinism travels in args.** Mutators must be deterministic functions of
  `(tx, args, ctx)`: IDs, timestamps, and anything random are generated at the
  call site and passed as args — never `Date.now()`/`crypto.randomUUID()`
  inside `apply`. This is the zbugs convention (args schemas carry `id`,
  `created`, `modified`: `apps/zbugs/shared/mutators.ts:19-33`; the server may
  still substitute authoritative values, `server-mutators.ts:35-46`) and is
  what makes the local guess byte-identical to the server echo, so the confirm
  swap is invisible. Documented convention, not enforced — divergence is
  temporary either way, since the confirm patch replaces the overlay.
- **Local throw = fail fast.** An `AppError` from the speculative run rejects
  with its code (a `MutationError`, same shape as a server permanent error);
  any other throw rejects as `LocalApplyFailed`. Nothing queued, nothing
  shown — mirrors the `InvalidArgs` fail-fast and Replicache (a client-side
  throw commits and pushes nothing, `replicache-impl.ts:1582-1589`). This puts
  a burden on mutator authors — local state can be behind the server, so a
  missing-row `NotFound` throw locally rejects a mutation the server would
  accept. The mutator-authoring docs must teach the pattern (guard or no-op on
  missing rows; reserve throws for true invariants) right where the README's
  `issue.move` example lives.
- **Degrade, never lie.** If `apply` touches a table with no attached
  collection, the speculative run is discarded (warn once) but the mutation
  **still enqueues** — optimism lost, correctness kept. `createCollections`
  attaches every schema table, so the paved path always qualifies.
- **Empty write set skips the transaction.** TanStack resolves a zero-mutation
  commit *without calling `mutationFn`* (`transactions.ts:512`), which would
  silently drop the mutation from the wire. A no-op-locally intent (stale
  local view) must still reach the server: empty buffer → enqueue directly.
- **Offline/reload semantics unchanged (phase 2).** §7.1's rules stand:
  no optimistic display of replayed-but-unconfirmed mutations after reload;
  durably queued mutations stay pending rather than timing out. Startup
  replay of queued intents (Replicache does this) is now *possible* and
  deliberately deferred — it needs its own pass on ordering and error
  handling before `markReady`.
- **Timeout only exists without a store** (revised 2026-07-23; supersedes the
  original "reject but keep queued" behavior — see the §7.1 rule). With a
  durable store the promise stays pending while offline, so the overlay
  stays up and there is no rollback-then-reappear flicker to explain; a
  rejection always means the mutation will not apply. Memory-only clients
  keep `confirmTimeoutMs`, and the rejection there discards the mutation
  along with its overlay. Tests pin both: pending-past-timeout-then-confirm
  (with store) and reject-and-roll-back (without).

**Registration is at creation, not sync-start.** `workspaceCollectionOptions`
registers its table hooks with the client when the options are created,
fronted by a compacting buffer (last op per row id + a pending-clear flag —
sufficient because patches are full-row LWW). Pokes arriving before TanStack
starts the sync pipeline (lazy collections: first subscriber after bootstrap)
absorb into the buffer; when `sync.sync` runs, the buffer drains through
`begin`/`write`/`commit` as one synced transaction and the hooks become
pass-through (no retention). This **removes the late-`registerTable` full
resync** for every collection created before first subscription — previously
any lazily-subscribed collection cost a whole re-hello. The full-resync path
remains only for genuinely late creation (a collection constructed after
first sync) and for restart-after-cleanup, both rare. The optimistic surface
(collection instances for `LocalWriteSet` reads/writes) attaches in
`createCollections` immediately after each `createCollection`; `sync.sync`'s
`params.collection` is the fallback attach for hand-rolled setups.

**Known sharp edge (accepted).** TanStack rollback cascades: if intent A is
rejected and pending intent B touched the same row, B's overlay rolls back
too — but B's wire mutation is already queued and may still succeed, so the
row flickers until B's confirm patch restores it. Transient and convergent;
opting out would show state built on a rejected premise.

**Deferred, deliberately.** One seam this design leaves open without
blocking (a second — the typed action namespace, Zero's
`MakeCustomMutatorInterfaces` pattern, `zero-client/src/client/custom.ts:95-110`
— shipped 2026-07 as the property-access form of `mutate` itself:
`client.mutate.todos.clearCompleted()`, with the string form kept as the
untyped escape hatch):
- *Per-mutator local override* — there is intentionally no way to hand-write
  a local effect; a mutator that reads server-only state degrades to
  non-optimistic with no recourse. Zero's registry-level overrides are the
  precedent if this is ever wanted; it composes with the no-new-API surface
  and is not built speculatively.

## 8. Connections, hibernation, lifecycle

All patterns below are lifted from partyserver/tldraw/LiveStore and are considered
settled:

- **Auth at upgrade, in the worker, before the DO is reached.** Validate the session,
  check workspace membership, reject with 4xx. (partyserver `onBeforeConnect`,
  `index.ts:548`; LiveStore `validatePayload`, `worker.ts:170-259`.) The DO re-checks
  workspace membership per push inside mutators — connection auth is coarse, mutation
  auth is authoritative.
- **All per-connection state lives in the socket attachment**
  (`serializeAttachment`): `{clientId, workspaceId, schemaVersion}`. Nothing about a
  connection is held only in DO memory, so hibernation eviction is free.
- **`ctx.setWebSocketAutoResponse(ping, pong)`** so keepalives never wake the DO
  (tldraw `TldrawDurableObject.ts:44`). The ping/pong strings are the shared
  `KEEPALIVE_PING`/`KEEPALIVE_PONG` constants in the protocol package.
- **The client heartbeats** (added after live testing, 2026-07): `SyncClient` sends
  `KEEPALIVE_PING` every 25s and force-reconnects if no frame of any kind arrives
  within 55s. Live-observed rationale: idle edge connections die unpredictably
  (one run lost a socket at ~75s idle, another survived 130s), and a half-open
  socket emits no close event — sends just vanish. The missed-deadline check is
  the only reliable dead-socket signal; recovery is the ordinary reconnect +
  cursor catch-up. Configurable via `pingIntervalMs` (0 disables) and
  `idleTimeoutMs`. A synchronously-throwing `WebSocket` constructor (malformed
  URL, CSP) is likewise treated as an instant disconnect so the backoff loop
  never dies.
- **Once-only `onStart` under `blockConcurrencyWhile`** re-runs schema migrations and
  loads `meta` on wake (partyserver `#ensureInitialized`, `index.ts:875`).
- **Reciprocate close frames** (except reserved codes 1005/1006/1015) or clients
  observe 1006 (partyserver `closeQuietly`, `index.ts:786-796`).
- **Broadcast iterates `ctx.getWebSockets()` live**; a failed `send` closes that socket
  with 1011. Slow clients are not backpressured in v1 (LiveStore has the same gap) —
  the mitigation is that pokes are deltas and a reconnecting client catches up by
  cursor, so dropping a laggard is always safe.
- **Frame budget 900 KB**, chunker packs by both item count and encoded bytes
  (LiveStore `splitArrayBySize`, `transport-chunking.ts:38-85`).

## 9. Schema and protocol evolution

- `protocolVersion` (integer): server supports N and N-1; older clients get
  `VersionNotSupported` and the app hard-reloads. Server deploys before clients
  (Zero's rule, `protocol-version.ts:15-77`).
- `schemaVersion` (string): identifies the app-data shape + mutator set. Policy
  (revised 2026-07, now that the migration chain makes a bump one line): **every
  schema change requires a version bump** — additive changes too, as a
  migrate-less step (or with a `migrate` backfill when the new field has a
  default). Two reasons the old additive-within-a-version allowance was unsound:
  rows written before the change are never migrated, so a field with a default
  is absent at runtime while `RowOf` claims it's present (defaults apply at
  write, reads return raw stored JSON); and old bundles sharing the version
  string stay connected indefinitely, where their full-row `sync.put`s silently
  strip any new field a new-bundle client set. A bump closes both: the migration
  backfills, and old bundles are rejected at hello within one reconnect.
  **Never remove a mutator name that shipped under a live schema version** (§3 D10).
  The policy is enforced by drift detection: the DO stores a structural
  fingerprint of the table schemas (JSON-Schema-derived for zod tables,
  `fingerprint.ts`) next to the stored version, and a wake that sees the same
  version with a different fingerprint warns once and restamps. Deliberately a
  warning, not a hard error: the fingerprint derives from zod's JSON Schema
  emission, which a zod upgrade could shift with no semantic change — a
  heuristic detector gets to shout, never to take down availability.
  The strict layer lives in CI instead (added 2026-07-24):
  `checkSchemaEvolution(app, snapshotPath)` in `@cf-sync/server/testing`
  compares the same fingerprint against a committed snapshot file and fails
  the build when schemas change under an unbumped version — a false positive
  there costs one deleted file, not availability, so it gets to be an error.
- Storage-format changes inside the DO are ordinary SQLite migrations in `onStart`,
  invisible to the protocol.
- **App-schema rollout (drilled, M3):** exact-match policy — the server rejects any
  other `schemaVersion` at hello with `VersionNotSupported`; the client goes fatal
  and the app reloads into the new bundle, whose `SyncStore` cache is discarded on
  the version mismatch (§7.1) and re-bootstraps. Server-side data rewrites are
  declared as the app's **migration chain** (`defineApp`'s
  `migrations: { [toVersion]: migrateFn | null }`, keyed by integer target
  version — `null` marks an additive change): a version history validated at
  definition time (consecutive integers ending at `version`; entries below the
  oldest version still in the field may be dropped, and a workspace stored
  below the oldest entry aborts at wake instead of restamping). On the
  first wake under a new version, the DO replays every step from its stored
  version, before any traffic — a workspace that slept through several deploys
  replays multiple hops. All steps run against one write buffer (later steps read
  earlier steps' writes); the net result is validated against the *current* schema
  at commit, so shipped steps are never edited when a later version reshapes the
  same table. Everything commits atomically at a single new data version with the
  version restamp; `min_cursor_version` advances to it so no pre-migration cursor
  can catch up; `backendId` is untouched (same history — no outbox renumbering);
  per-client LMIDs survive, so mutations queued in old-bundle tabs still dedupe
  correctly after their tab upgrades. A replay of `null` steps (additive
  changes) just restamps and leaves cursors valid. A throwing step — or a stored
  version outside the declared chain, e.g. a rollback deploy — aborts DO
  initialization: old-shaped data is never served under the new version, and the
  next construction retries. An init-failed workspace is **quarantined, not
  bricked** (learned 2026-07-24 from a live workspace predating numeric schema
  versions): upgrades fail as HTTP 503 (clients keep their paced reconnect and
  recover unaided), admin ops answer 500 with the failure message — except
  `POST reset`, which stays reachable and heals, because the failure message
  names it as the remedy and a remedy must not sit behind the failure
  (`init-failure.test.ts`). The log records one `$schema.migrate` entry under
  client `$system` spanning the whole jump. Deploy order: worker before (or atomically
  with) web assets, so no client ever speaks a schema the server hasn't reached.
  The full chain is enforced by `schema-rollout.test.ts` and was exercised live
  (demo v1 → v2, 2026-07).

## 10. Permissions (v1 scope)

Workspace-coarse: membership is checked at upgrade and re-checked inside every mutator;
every member syncs the entire workspace. No row-level read filtering exists anywhere in
the broadcast path — this is an explicit punt, recorded here so it is a decision and
not an accident. If an app later needs finer read scopes, the plan is separate sync
scopes (additional DOs / filtered spaces with their own cursors), not per-row filtering
of pokes. Zero's approach (permission rules compiled into query rewrites,
`read-authorizer.ts:61-119`) is the reference if we ever need the general thing —
fail-closed, enforced at read time, never post-filtered.

## 11. Testing strategy

The engine's value is its guarantees, so the simulation harness is a deliverable of the
first milestone, not an afterthought:

- **Deterministic simulation:** N virtual clients + one in-memory DO harness (miniflare/
  `workerd` runtime via `wrangler dev` or `@cloudflare/vitest-pool-workers`), a seeded
  PRNG driving mutation generation, message delivery, reordering at the boundaries the
  real system allows (per-connection FIFO, cross-client interleaving), disconnects,
  duplicate delivery, and DO eviction/restart.
- **Invariants asserted every step:** per-client LMIDs monotonic; cursors monotonic;
  after quiescence all clients' synced state deep-equals the DO's rows (convergence);
  no optimistic mutation survives confirmation; a client that re-bootstraps mid-run
  converges identically.
- **Fault menu:** kill the DO between mutation apply and broadcast (poke lost → cursor
  catch-up must recover); compaction racing a stale client; push replay after
  reconnect (idempotency); schema-version mismatch handshake.
- **App-developer testing (shipped 2026-07):** `@cf-sync/server/testing` exports
  `createTestEngine(app)` — an in-memory engine over the same `WriteSet`/validation
  core the DO runs (`engine-core.ts` is shared code, not a reimplementation), so app
  teams unit-test mutators and migration chains in plain node vitest with the engine
  invariants intact (AppError advances the LMID with writes discarded; transient
  throws commit nothing; migration replay validates the chain's net result).

## 12. Milestones

1. **M0 — protocol core** *(done)*. Workspace DO (schema §5, push path §6),
   `hello`/catch-up, chunked pokes, TanStack DB adapter, two browser tabs converging
   through optimistic mutations. Simulation harness with convergence + idempotency
   invariants.
2. **M1 — resilience** *(done)*. Reconnect/backoff, bootstrap progress (`remaining` on
   poke parts), tombstone compaction + horizon resets, DO-eviction fault tests
   (restart preserves backendId/version/LMIDs), close-code hygiene, append-only
   migration runner.
3. **M2 — operability** *(done)*. R2 mutation-log export (ndjson objects keyed by
   log_seq range, cursor advances only after a successful put — idempotent by
   construction), admin surface via `createAdminFetch` with a mandatory authorize
   hook (GET stats / GET export / POST import / POST reset), per-DO metrics (SQL
   gauges + since-start counters; no server-side wall-clock latency — workers freeze
   `Date.now()` during execution, so latency is measured from clients). Import
   replaces state at one new version and bumps `min_cursor_version`; reset mints a
   new `backendId`.
4. **M3 — product hardening.** Phase 1 *(done)*: client persistence via
   the `SyncStore` seam (§7.1) — IndexedDB-backed row mirror + cursor + durable
   outbox, instant hydration before connect, offline mutations replayed exactly
   once under the LMID contract. Phase 2 *(done)*: optimistic intent mutators
   (§7.2) — `mutate` runs the shared `apply` locally as one atomic overlay, and
   collection hooks register at creation behind a compacting gate (no
   late-registration resync). Remaining: startup replay of queued intents (§7.2's
   deferred phase), collaborative text per the tiered strategy in §14 (built only
   when a field type proves to need real merging).

## 13. Open questions (deliberately deferred)

- Per-table typed SQLite columns in the DO (enables server-side queries/indexes) vs.
  staying generic — revisit at M2 with real workloads.
- HTTP transport fallback for restrictive networks — protocol is ready for it; add
  when a real user hits it.
- Hot-workspace sharding (read-replica DOs fanning out pokes) — the ~hundreds of
  pushes/sec per-DO ceiling is far above Linear-style human workloads; revisit only
  with evidence.
- Presence/ephemeral state (cursors, "who's viewing") — likely a separate lightweight
  channel on the same socket, never written to SQLite. Note that §14 tier 1 (field
  edit indicators) is the first concrete consumer.

## 14. Collaborative text (revised 2026-07)

The original plan was one Yjs DO per document, modeled on Linear/Notion-style
products: a handful of long pages, opened one at a time, sometimes heavily
co-edited. The engine's target workload (form-heavy collaborative record apps) is
the opposite shape — **hundreds of small
text fields per workspace, at most ~4 collaborators, low typing frequency** — and
that shape inverts the tradeoff. A record view showing 30 fields would need 30
sockets and 30 DO wakes just to render, and per-document isolation defends against
write contention that 4 quiet users will never generate. DO granularity must match
access granularity, and the unit of access here is the workspace, not the field.

The revised strategy is tiered; each tier is built only when the previous one
demonstrably falls short:

1. **Default: text fields are ordinary rows (LWW).** Full-row last-write-wins
   through the existing mutation path. The failure mode — a true simultaneous edit
   of one field loses one side's keystrokes — is rare at 4 collaborators with low
   typing frequency. Mitigate with field-level presence ("X is editing this
   field"), which discourages collisions instead of merging them. This covers most
   of the hundreds of fields with zero new infrastructure.
2. **Fields that prove to need real merging (long-form notes people actually
   co-write): Yjs hosted *inside* the workspace DO.** A `yjs_updates` table in the
   same SQLite keyed by fieldId; Yjs sync/awareness frames multiplexed over the
   existing WebSocket as a new message type beside hello/push/poke; Y.Docs loaded
   lazily per field behind an LRU; update logs compacted into snapshots by the
   existing alarm. One socket, one DO, one authorize hook. Single-threading is not
   a concern at this scale — a DO sustains hundreds of messages/sec and 4 slow
   typists produce a fraction of that. CRDT state stays out of the rows table and
   the mutation log (the non-goal in §1 stands); the row for a field holds
   metadata and a fieldId pointer only.
3. **Back pocket: per-document Yjs DOs**, if a future feature reintroduces the
   big-shared-page shape (many concurrent editors on one hot document). This
   composes cleanly alongside tiers 1–2 — a second DO class and a `/doc/<docId>`
   route — and nothing in the workspace DO changes. Do not build it on
   speculation.

## 15. Session control (implemented 2026-07-23)

Membership-gated apps keep identity, roles, and entitlements in an external
authority (their app database), and under the one-authority-per-fact model that
data is never mirrored into the workspace: everything a mutator needs from
outside the workspace (identity, role, entitlement) is looked up once in
`authorize` and
stamped onto the connection — so the connection's auth state needs a lifecycle:
a way to carry it to mutators, a way to revoke it (membership removal must stop
*reads*, not just writes), and a way to refresh it (billing changed → reconnect
re-runs `authorize`). Designed top-down from what the app writes. Presence
(§16) and Tier 2 fields (§17) both consume the stamps defined here — this
section sequences first in any implementation order.

### 15.1 What the app writes

```ts
// worker — the authorize hook grows a structured verdict (boolean | Response
// still accepted, unchanged semantics):
createSyncFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  authorize: async (request, { workspaceId, clientId, env }) => {
    const session = await verifyAuth(request, env)
    if (!session) return { ok: false, reason: 'unauthenticated' }
    const member = await getProjectMember(env.DB, workspaceId, session.userId)
    if (!member) {
      const exists = await projectExists(env.DB, workspaceId)
      return { ok: false, reason: exists ? 'not-a-member' : 'project-deleted' }
    }
    return {
      ok: true,
      principal: session.userId,
      context: { role: member.role, writeAllowed: await entitled(env.DB, workspaceId) },
    }
  },
})

// shared — mutators read the stamps synchronously:
const mutators = defineMutators(schema, {
  'study.delete': {
    args: z.object({ id: z.string() }),
    apply(tx, { id }, ctx) {
      if (ctx.authoritative && !ctx.auth?.writeAllowed)
        throw new AppError('ReadOnly', 'subscription lapsed')
      tx.del('studies', id)
    },
  },
}, { authContext: z.object({ role: z.enum(['owner', 'member']), writeAllowed: z.boolean() }) })

// worker (commands/webhooks) — revoke or refresh live sessions:
import { workspaceAdmin } from '@cf-sync/server'
const ws = workspaceAdmin(env.WORKSPACE, projectId)
await ws.disconnect({ principal: userId, mode: 'kick', reason: 'membership-revoked' })
await ws.disconnect({ mode: 'refresh' }) // e.g. subscription changed: everyone re-authorizes

// client — distinguishable rejection surfaces:
new SyncClient({
  ...,
  onFatal: (err) => {
    if (err.reason === 'membership-revoked') return leaveProject()
    if (err.reason === 'project-deleted') return cleanupAndRedirect()
    location.reload()
  },
})
```

### 15.2 Verdicts and rejection delivery

`authorize` may return `boolean | Response` (unchanged) or an `AuthVerdict`:
`{ok: true, principal?: string, context?: unknown, expiresAt?: number}` /
`{ok: false, code?: number, reason?: string}`.

`expiresAt` (epoch ms) bounds how long the stamps stay trusted without being
re-derived. Revocation is otherwise entirely push-driven (webhook →
`disconnect`), and a missed webhook would leave a socket authorized forever;
the ecosystem answer is periodic revalidation (Zero re-runs auth context on a
`revalidateAt` deadline, Liveblocks bounds exposure with short-lived tokens).
The engine's variant fits the hibernation constraints: the deadline is stamped
in the attachment and checked at two synchronous points, both closing past-due
sockets with 4300 so the reconnect re-runs `authorize`. Inbound frames gate
*writes*. Reads are gated at the **broadcast fan-out**: before relaying any
frame (poke, presence, field update) to a socket, the DO reads its attachment
deadline and closes instead of sending. Fan-out is where reads happen, so
checking there is both necessary and sufficient — a passive reader generates
no inbound frames the DO ever sees (keepalive pings are auto-responded
without waking it, per §16.3), and a fully idle workspace relays nothing, so
there is nothing to bound. No alarm, no await, no background timer. Omitted
means no expiry — apps with reliable revocation webhooks don't pay for one.

The delivery problem: a browser WebSocket client cannot observe the HTTP status
of a failed upgrade — a 403 looks identical to a network error, which is why
collaborative apps conventionally accept-then-close with a policy code + reason
instead. The engine adopts the same trick, but in the **worker router**: on a
structured rejection,
`createSyncFetch` completes the upgrade with a local `WebSocketPair` and
immediately closes it with `(code, reason)` — the client gets a real close
event, and the DO never wakes. (partyserver does the same accept-then-close
for the same devtools-visibility reason, but inside the DO; doing it in the
router is the platform win. The worker-side pair initiates the close itself,
so §8's close-reciprocation rule doesn't apply to it.) A bare `false` keeps
returning HTTP 403 (back-compat, and correct for non-browser callers).

`reason` strings ride the WebSocket close frame, which caps reasons at **123
bytes** of UTF-8 — reasons are short stable slugs (`membership-revoked`,
`project-deleted`), not prose; anything longer belongs in logs.

Close-code space (constants exported from `@cf-sync/protocol`):

- `[4400, 4499]` — **permanent**: the client stops reconnecting and calls
  `onFatal` with `{code, reason}` attached to the error. Existing: 4400
  VersionNotSupported. New: 4403 default rejection/kick, 4401 auth-context
  validation failure (15.4).
- `4300` — **refresh**: the client reconnects immediately (fresh `authorize`
  run, fresh stamps). Not fatal, not backoff — this is the entitlement/role
  freshness mechanism, expected during normal operation. Loop guard: only the
  first 4300 reconnects immediately; consecutive 4300s with no intervening
  `ready` fall back to the normal reconnect backoff, so a bug (or a stuck
  webhook retrying `disconnect({mode: 'refresh'})`) that refreshes on every
  connect degrades to a paced retry instead of a zero-delay `authorize` storm
  against the app's database.

The ecosystem alternative — in-band reauth over the live socket (Zero's
`updateAuth` message, Ably's `AUTH` frame) — was considered and rejected:
`authorize` runs in the worker against the app's database, and the DO cannot
re-run it; a reconnect keeps all auth evaluation in exactly one place at the
cost of a socket bounce, which the cursor catch-up path already makes cheap.
A workspace-wide `refresh` makes every socket reconnect at once; at the
target workload (≤4 sockets per workspace) the herd is a non-issue — revisit
with server-paced backoff hints (what Zero's backoff errors carry) if
fan-outs grow.

### 15.3 Carrying the verdict to the DO

The router serializes `{principal, context}` into an internal header
(`x-cf-sync-auth`) on the forwarded request, exactly like `WORKSPACE_HEADER` —
and strips any inbound value of that header first, so it cannot be spoofed from
outside. The DO parses it at upgrade and stores both in the socket attachment
beside `clientId`/`ready`, so they survive hibernation. Attachments cap at 2KB
serialized: the docs state the budget and the DO fails the upgrade loudly if
the auth payload doesn't fit, rather than truncating. The trust model is
unchanged: the DO believes whatever the router says (do.ts already requires an
authorize hook in front of it).

**Supersede rule**: an upgrade whose `clientId` already has a live socket
closes the old socket before accepting the new one — newer wins. The old
socket is almost always a half-open zombie the client already abandoned
(reconnect after a silent network death); without the rule, an edge-buffered
frame from the zombie can arrive *after* the fresh socket's traffic and be
attributed to the same client — the stale-overwrite race that awareness-style
clocks exist to prevent (§16 leans on this rule instead of clocks).

**Close beats push (implementation note).** A server-initiated close is not
instantaneous: the runtime keeps delivering inbound frames already in flight
until the peer acks the close frame. Every DO-initiated close (kick,
supersede, expiry, version rejection) therefore marks the attachment
`defunct` before closing, and `webSocketMessage` drops frames from defunct
sockets. The mark lives in the attachment — one storage write on a rare
path — so it survives hibernation, and it is deliberately scoped to
DO-initiated closes only: a frame racing a *client's* own close is
legitimate traffic and must still land. `readyState` cannot make that
distinction — workerd flips it to CLOSING as soon as the peer's close frame
*arrives*, before dispatching the data frames queued ahead of it, so a
readyState guard silently drops valid mutations (caught by the §11
convergence simulation).

### 15.4 MutatorContext grows three fields

```ts
interface MutatorContext<A = unknown> {
  clientId: string
  principal?: string   // from the verdict; undefined when no authorize hook set it
  auth?: A             // the verdict's context, validated against authContext
  authoritative: boolean // true on the server, false in optimistic client runs
}
```

- **Typing**: the optional `authContext` standard schema is declared as a third
  argument to `defineMutators` — mutators are its consumer, so it lives with
  them — and `defineApp` picks it up from the registry. `ctx.auth` infers from
  it; without one it stays `unknown`.
- **Validation**: the DO validates the verdict's `context` against
  `authContext` at upgrade time, so drift between the app's authorize hook and
  its mutators fails at connect, not mid-mutation. A failure closes with
  permanent 4401 and a descriptive reason — it's an app configuration bug
  (authorize and mutators shipped disagreeing shapes), so reconnecting cannot
  help and backoff would only hide it.
- **Optimistic runs**: mutators also run client-side, where no server verdict
  exists. `ctx.authoritative` is the honest signal — permission checks written
  as `if (ctx.authoritative && !allowed) throw` enforce on the server and let
  the optimistic apply proceed (a rejected mutation rolls back through the
  normal permanent-error path, which is already the model for any server-only
  failure). Apps that want fail-fast UX can pass `authContext` to `SyncClient`
  options and check it without the `authoritative` guard; the server remains
  authoritative either way.

### 15.5 The `disconnect` op and `workspaceAdmin`

New admin op beside stats/export/import/reset:
`POST /admin/<workspaceId>/disconnect` with body
`{principal?: string, clientId?: string, mode?: 'kick' | 'refresh', code?: number, reason?: string}` —
no selector means all sockets. `kick` closes with 4403 (or the given code) and
the reason; `refresh` closes with 4300. The DO walks `getWebSockets()`,
matching on attachment principal/clientId — synchronous, no awaits (invariant
§6.3 applies to this handler like any other).

`workspaceAdmin(namespace, workspaceId)` is a thin typed helper over
`stub.fetch` for same-worker callers (app command handlers, billing webhooks) so
server code doesn't hand-build admin HTTP requests against its own routes; it
exposes the existing ops too (`stats()`, `export()`, `import(body)`,
`reset()`, `disconnect(opts)`). `createAdminFetch` gains the op for external
callers; its `authorize` receives `op: 'disconnect'` like any other.

### 15.6 Tests that lock this

Kick closes only matching sockets and the client goes fatal with the reason;
refresh triggers a reconnect that re-runs authorize (assert new stamps
observable via a mutator); attachment auth survives `state.abort()` eviction;
oversized auth context fails the upgrade; spoofed `x-cf-sync-auth` from outside
is stripped; a kicked client's queued push never lands (close beats push); a
frame arriving after `expiresAt` gets 4300 and the reconnect carries fresh
stamps; a relay (poke, presence, or field update) to a socket past
`expiresAt` closes it with 4300 and the frame is not delivered;
consecutive 4300s without a `ready` back off instead of looping; a
second upgrade with the same clientId closes the first socket, and a frame
sent on the superseded socket is not processed.

## 16. Presence (implemented 2026-07-24)

Ephemeral peer state on the existing socket: who's here, what they're doing.
The §14 Tier 1 mitigation ("X is editing this field") and typical
collaborative-review UIs (live cursors, per-field presence, online avatars)
both need it. The
library owns transport and lifecycle; the payload is opaque app data.

### 16.1 What the app writes

```ts
// shared — presence payload schema is part of the app definition:
const app = defineApp({
  version: 3,
  schema,
  mutators,
  presence: z.object({
    user: z.object({ userId: z.string(), name: z.string(), image: z.string().optional() }),
    cursor: z.object({ x: z.number(), y: z.number() }).optional(),
    editingField: z.string().optional(),
  }),
})

// client — identity once at construction (validated there, like `auth`);
// afterwards every call site can be a bare merge, immune to mount order:
new SyncClient({ ..., initialPresence: { user } })
client.presence.set({ user, editingField: 'q3-notes' })
client.presence.update({ cursor: { x, y } }) // shallow merge: no re-stating `user`
client.presence.self                         // own parsed state (never in `peers`)
client.presence.clear()

// react — peers, self excluded, typed by the app's presence schema:
const peers = usePresence(client)
// Array<{ clientId, principal?, state: PresenceOf<typeof app>, receivedAt }>
// receivedAt = local receipt time: the §16.3 ghost-window staleness bound
```

`presence.set` is safe to call at input frequency: the client throttles
trailing-edge at a configurable cadence (default 100ms — Liveblocks' default,
proven at far larger scale) so apps never write throttle glue. The server
still relays what it receives — pacing is a client-library concern, not a
protocol one.

**Presence drift is advisory — no version bump (revised 2026-07-24).** The
original design put presence in the §9 structural fingerprint, pricing a
presence change like a table change. Review caught what that costs: a version
bump force-reloads every connected client and discards every client's
IndexedDB cache for a full re-bootstrap — all for data that is never stored
and lives at most one connection long. The skew the bump would prevent (an
old bundle sending old-shape presence mid-deploy) already degrades
gracefully: the server rejects with `PresenceInvalid`, the client warns and
self-heals on the next set. Liveblocks and Yjs awareness version presence not
at all. So presence gets its own fingerprint (`presence_hash` in meta, apart
from `schema_hash`): reshaping it under an unchanged version logs a soft
one-time warning and restamps — no rejection, no cache discard, no migration
entry. First declaration is silent (additive by construction). Prefer
tolerant changes (add optional fields rather than reshaping), since old and
new bundles share the workspace during a deploy window.

### 16.2 Wire protocol

Three new message types beside hello/push/poke:

- client → server `{type: 'presence', state: <json> | null}` — null clears.
- server → clients `{type: 'presence', clientId, principal?, state | null}` —
  the relay. `clientId`/`principal` are stamped by the server from the socket
  attachment: payload is client-claimed, **identity is server-attested** (a
  client cannot impersonate another user's presence).
- server → client `{type: 'presencePeers', peers: [...]}` — full snapshot,
  sent once right after hello completes so late joiners render peers
  immediately.
- server → clients `{type: 'presencePoll'}` — "re-send your state", used after
  hibernation wake (16.3).

Presence frames are ordinary frames for keepalive/idle accounting and are only
accepted on `ready` sockets. The server validates inbound state against the
app's presence schema before relaying — `usePresence` hands peers' state to
app code as a typed value, and a typed surface the server never checked would
let one modified client feed junk into every peer's code path; at the target
workload (≤4 collaborators, ≤8KB payloads) validation costs microseconds even
at cursor cadence. Invalid or oversized (`MAX_PRESENCE_BYTES`, 8KB) states are
rejected with an error frame, never truncated or coerced.

### 16.3 Server: in-memory only, rebuilt by polling

A `Map<clientId, state>` in DO memory; relay handlers are synchronous fan-out
(invariant §6.3). Nothing is ever persisted — presence never touches SQLite or
the mutation log. Hibernation drops the map while sockets survive; on wake the
DO broadcasts `presencePoll` and the map converges in one round-trip as clients
re-send. A client whose hello lands during that window gets a sparse
`presencePeers` snapshot that fills in as poll replies relay — a recorded
decision, not a surprise: presence is eventually-correct by construction, and
holding the snapshot until the poll settles would add a wait to every wake for
a cosmetic gap. Socket close/error removes the entry and broadcasts the null. This
buys hibernation-compatibility without a single storage write on the 50ms
cursor path — the reason presence must NOT live in socket attachments
(`serializeAttachment` is a storage write per update; at cursor frequency that
would defeat hibernation entirely).

**The ghost window (recorded trade).** There is no TTL/heartbeat expiry: the
keepalive ping is auto-responded without waking the DO, so the server never
observes client liveness — a peer that dies silently (network partition,
laptop lid) lingers in the map until TCP teardown surfaces a close, observed
anywhere from ~75s to a couple of minutes. This is the same trade the
hibernating-CF prior art makes deliberately: y-partyserver strips y-awareness's
15s/30s clock-renewal interval and tldraw's CF template sets
`clientTimeout: Infinity`, both to preserve hibernation. At the target
workload a minutes-stale avatar is cosmetic, but apps using presence for the
§14 "X is editing this field" mitigation should treat the claim as advisory —
render it with a client-side staleness bound from the update's local receipt
time (exposed as `receivedAt` on every peer entry, stamped by the library so
apps never keep their own timestamp map), never hard-lock a field on it. Revisit shape if evidence demands: a
low-cadence client renewal plus an alarm sweep armed only while the map is
non-empty. The §15 supersede rule (newer socket wins per clientId) closes the
related zombie-socket race — a late frame from an abandoned half-open socket
can't overwrite the reconnected client's fresh state, which is why
awareness-style clocks stay unnecessary in this single-relay topology.

**Relay goes through the §15 send gate (noted 2026-07-24).** This section was
designed before the close-beats-push discovery recorded in §15.3. Presence
relay is a second fan-out path beside pokes, so every per-socket delivery must
apply the same two gates the poke loop applies: skip sockets marked `defunct`
(a DO-initiated close is in flight; the socket is dead even though frames
still dispatch), and a socket past its `expiresAt` is closed with 4300
instead of being sent to — the §15.6 test "a relay (poke, presence, or field
update) to a socket past `expiresAt` closes it" already anticipates this.
Implemented as the one `#deliver` helper both fan-out paths send through;
§17 field updates reuse it rather than growing a third copy of the checks.

**Implementation decisions (2026-07-24):**

- Map entries remember their **owning socket**. The supersede rule closes the
  old socket *before* the new one announces, but the old socket's close
  *event* can be delivered after — teardown cleanup only removes an entry the
  closing socket still owns, so a lagged close cannot wipe the reconnected
  client's fresh state (locked by test).
- Relay carries the presence schema's **parsed output** (defaults applied),
  matching what the typed surface promises — the same rule row validation
  follows (§6a: the validated output is what gets stored).
- Rejections use a dedicated `PresenceInvalid` error code rather than
  overloading `BadMessage`; the client treats it as a warning (presence
  self-heals on the next set), never a reconnect.
- The null broadcast on close/clear keeps the attested `principal`, so peers
  know *whose* presence vanished without holding their own id→principal map.
- The wake poll is broadcast from the DO constructor — the constructor *is*
  the wake signal — guarded on the app declaring presence and ≥1 ready
  socket, so cold starts and presence-free apps pay nothing.
- Without a `presence` schema in `defineApp`, `presence.set`/`clear` throw
  (and the state type is `never`), the server rejects presence frames, and
  no snapshot/poll traffic exists at all.

### 16.4 Client: the library owns re-announcement

`presence.set` validates against the app's presence schema (fail fast, same
philosophy as mutate-time args validation), sends when connected, and stores
the last state — the *parsed* output, which `presence.self` exposes and
`presence.update(partial)` shallow-merges into (added 2026-07-24 on review:
full-replace `set` alone forces every call site to re-state the whole payload,
the tax Liveblocks' `updateMyPresence` and Yjs' `setLocalStateField` exist to
remove; the merged result re-validates, so required fields still fail fast). On every (re)connect that reaches `ready`, and on
`presencePoll`, the client re-sends that state unprompted — apps never write
reconnect glue. `presence.peers` is a synchronous snapshot;
`presence.subscribe` notifies on any change; `usePresence` wraps them with
`useSyncExternalStore`. Self is excluded from peers (apps render their own
state from their own source of truth). Peers reset to empty on disconnect —
stale presence is worse than absent presence.

### 16.5 Non-goals

No persistence, no history, no delivery guarantees (a dropped presence frame
is repaired by the next one), no server-side throttling in v1 (≤4 collaborators
per workspace; revisit with evidence), no cross-workspace presence.

### 16.6 Tests that lock this

Relay reaches all ready sockets but not the sender or non-ready sockets;
snapshot arrives after hello; poll-after-eviction converges; close broadcasts
the null; a supersede-lagged close cannot wipe the reconnected client's fresh
entry; oversized payload rejected without disconnect; identity stamping
ignores any clientId/principal a client embeds in its own payload; relay
skips defunct sockets, and relay to a socket past `expiresAt` closes it with
4300 instead of delivering (the §15.6 send-gate test, exercised on the
presence path). Client side: trailing-edge throttling, re-announce on
`presencePeers` and `presencePoll`, peers reset on disconnect, `set` throws
without a schema, `update` merges without clobbering and validates the
merged result, `self` tracks set/update/clear, `initialPresence` announces
with no set call and turns update-before-set into a merge instead of a
mount-order schema error (invalid values throw at construction), and peer
entries carry `receivedAt`. Presence drift under an unchanged version warns
softly once and is never priced as table drift (`schema-drift.test.ts`).

**Testing hibernation (learned 2026-07-24):** `state.abort()` simulates a
*crash* — it kills the sockets with the instance (clients observe 1006) — so
it can never exercise the wake-poll path. The right tool is
`evictDurableObject(stub)` from `cloudflare:test` (vitest-pool-workers ≥
0.16.20), which preserves hibernatable sockets through the eviction like
production does; `{webSockets: 'close'}` opts into the crash shape instead.
Both shapes are locked: eviction → constructor poll → one-round-trip
convergence, and crash → sockets die → convergence purely from
re-announcement on reconnect.

## 17. Tier 2 Yjs fields (implemented 2026-07-24)

The §14 Tier 2 design made concrete: individual text fields that need real
merging (two people typing in the same prose box at once) get per-field Yjs
documents hosted inside the workspace DO, on the existing socket. Everything
else stays rows. Designed top-down from what the app writes.

### 17.1 What the app writes

```ts
// worker — register the extension on the DO:
import { yjsFields } from '@cf-sync/yjs/server'
export const Workspace = createWorkspaceDO({
  app,
  extension: yjsFields({
    app, // types authorizeWrite's `auth` from the app's authContext schema
    // optional: gate writes on the write context — the target fieldId plus the
    // §15 auth stamps (default: any member writes). fieldId makes per-field
    // policies expressible: encode the owning entity into field ids.
    authorizeWrite: ({ auth }) => auth?.writeAllowed === true,
  }),
})

// browser — attach to the SyncClient, get live docs by field id:
import { createYjsFields } from '@cf-sync/yjs/client'
const yfields = createYjsFields(client)

const handle = yfields.getDoc('recon-notes:q3')  // { doc, text, canWrite, whenSynced, subscribe, release }
await handle.whenSynced                          // server state applied
editorBinding(handle.text, textarea)             // handle.text is doc.getText('t')
handle.subscribe(() => setReadOnly(!handle.canWrite)) // reader, or field went read-only (17.6)
// on unmount:
handle.release()
```

The convention connecting rows to fields is the app's: a row stores a fieldId
string (`recon-notes:q3`), the UI calls `getDoc` with it. Fields are created
implicitly on first use — no registration, no schema entry; to the engine a
fieldId is an opaque key. Which fields are Tier 2 is a UI decision, invisible
to the sync schema.

Within a field, `handle.text` is the paved path — a `Y.Text` at a fixed
library-owned key (`'t'`) — so every reader and writer of a field agrees on
type and key with nothing to coordinate. A mismatched key is the same
silent-divergence footgun as two copies of yjs in a bundle (§17.2): two code
paths edit different named types in the same doc and never see each other's
text. `handle.text` closes it for the common single-text-field case by not
exposing the choice. Rich text (a `Y.XmlFragment` for y-prosemirror and the
like) drops to `handle.doc` and the app owns the key — exactly as it already
owns the fieldId convention; one field is one shape, chosen once.

### 17.2 Packaging: an add-on, core stays yjs-free

New package `@cf-sync/yjs` with `/server` and `/client` entry points and
**`yjs` as a peer dependency**. Rationale: most apps (and most fields in any
app) live entirely on Tier 1 — baking yjs into `@cf-sync/server`/`client`
would tax every app with a dependency it may never use, and `@cf-sync/protocol`
keeps its no-deps-but-zod rule (the binary frame helpers in 17.3 are
dependency-free). Peer-dep because the app's editor bindings must share one
yjs module instance with the sync layer — two copies of yjs in a bundle is a
known footgun. The alternative (yjs in core) was rejected for exactly the
standalone-library reason; the seam it plugs into is 17.5.

A `/react` entry (react as an optional peer, mirroring `@cf-sync/client`)
ships `useYjsField`: the 17.6 handle lifecycle (acquire/release/re-acquire),
the whenSynced gate, and reactive `canWrite` as one hook, its result
discriminated on `synced`. It re-renders on sync and permission changes only
— content binding stays with the editor attached to `text`/`doc`, matching
the Yjs ecosystem's binding model.

### 17.3 Wire: a binary lane beside the JSON protocol

All existing protocol messages are JSON text frames. Field traffic is **binary
frames** — the frame type itself is the mux, no envelope inside the JSON
protocol and no base64 inflation. Layout (helpers in `@cf-sync/protocol`):

    [u8 msgType][u16 fieldIdLen][fieldId utf8][payload bytes]

Four message types:

- `GET` (client → server): payload = Yjs state vector (empty for a fresh
  client). Server replies with `STATE`.
- `STATE` (server → client): payload = `[u8 flags][u16 svLen][server state
  vector][diff]` — the update diff the client is missing
  (`Y.encodeStateAsUpdate(doc, clientSV)`) plus the server's own state vector.
  `flags` bit 0 is **writable**: a false bit (a reader per `authorizeWrite`, or
  a frozen field, 17.4) renders the binding read-only from the first paint, so a
  client that cannot write never optimistically diverges — the apply-then-reject
  path is designed out, not handled. On receipt the client applies the diff,
  then computes
  `Y.encodeStateAsUpdate(doc, serverSV)` and, when non-empty, sends it back as
  an ordinary `UPDATE`. Sync is **bidirectional** (y-protocols' step-1/step-2
  in both directions) — pull-only would leave permanent gaps: an `UPDATE` lost
  in flight (socket died before the server persisted it) or a corrupt row
  skipped on load (17.4) would never be re-uploaded, and Yjs makes gaps silent
  and sticky — later ops that depend on the missing one park in the pending
  queue forever, quietly truncating the field for every future reader. The
  push-back leg is what makes both recovery stories true.
- `UPDATE` (both directions): one incremental Yjs update. Client → server:
  persist, then relay. Server → client: apply.
- `REJECT` (server → client): payload = `[u8 reasonCode]`, fieldId in the frame
  header. Sent when a specific `UPDATE` is refused — `NotWritable` (sender is a
  reader), `Frozen` (field hit its ceiling, 17.4), or `TooLarge` (update
  exceeded the transport frame guard). The client marks the field read-only and
  **stops sending and pushing back its updates for that field** (17.6) — the one
  rule that keeps a refusal from re-uploading forever through the bidirectional
  leg. The server applies the same collapse on its side: after any `REJECT` for
  a (socket, field), that socket's later `UPDATE`s for the field are refused
  without touching storage. `NotWritable` and `Frozen` are persistent conditions
  that re-refuse for free; the rule only adds state for `TooLarge`, and it is
  load-bearing there — updates already in flight when the `REJECT` lands (one
  RTT of keystrokes) depend on the refused op's client clocks, and appending
  them would plant a permanent gap in the log: every future reader parks them
  in the pending queue and the field silently truncates, the exact poison the
  push-back leg exists to prevent (and cannot heal — re-uploading includes the
  too-large op, refused again forever). An in-memory per-socket set is enough:
  hibernation dropping it is safe because the client went read-only one RTT
  after the refusal, long before any wake.

This is y-protocols' symmetric sync folded into fewer frames: `GET` is the
client's syncStep1, `STATE` is the server's syncStep2 *and* its syncStep1 (the
appended state vector), the push-back `UPDATE` is the client's syncStep2 —
full cross-sync in two messages instead of four. The one deliberate drop from
y-websocket's flow is server-initiated syncStep1 on connect: y-partyserver
needs it because its doc is memory-only and hibernation wake must beg
surviving clients for state back; here authority lives in SQLite, wake loses
nothing, and the server never has a reason to ask first.

**No subscription tracking.** The server relays every field `UPDATE` to every
ready socket; clients ignore fields they don't have open. This is the
load-bearing simplification: per-socket subscription sets *could* survive
hibernation in attachments (tldraw stores per-socket session state there), but
attachment space is budgeted for auth (§15.3) and subscription recovery
machinery buys nothing at this scale — broadcasting makes wake a non-event.
Cost: idle tabs receive keystroke-size frames, ~4 clients × ~5 updates/s ×
~100B ≈ 2KB/s per socket worst case — trivial. (Prior art for many docs on
one socket: Liveblocks Yjs subdocuments sync over a single room connection;
one-doc-per-connection y-websocket is the pattern this outgrows.) The real
revisit trigger is not typing volume but **bulk programmatic writes**: a
migration or seed pushing hundreds of fields through the socket path would
broadcast the whole corpus to every tab — seeding goes through admin import
(17.7), which bypasses the relay entirely.

Binary frames are only accepted on `ready` sockets. Two independent limits:

- `MAX_FIELD_UPDATE_BYTES` (200KB) is a **transport frame guard** — the
  binary-lane analogue of the 900KB poke chunk (D9), not a field-semantics
  limit; the server refuses a larger update with a `TooLarge` `REJECT`. The
  number is derived, not felt: accept-then-freeze (below) admits one crossing
  update, so ceiling + one guarded update = 700KB + 200KB = the 900KB D9
  budget — the worst `STATE` a frozen field can ever serve still fits one
  frame. It cannot be smaller with impunity either: the push-back leg (17.6)
  merges a whole disconnect's edits into ONE update, so the guard must
  dwarf any live-typing frame — what trips it is a huge paste or an extreme
  offline backlog. The paved place to keep edits under it is the editor
  binding's own paste/length guard — where the undo is native and the user
  sees the limit before anything happens — so the library exposes the
  constant for exactly that.
- `MAX_FIELD_BYTES` (700KB) is the **field ceiling**. A field is a note, not a
  document. The number is the binary-lane mirror of `MAX_ROW_BYTES`'s rule — a
  single field must fit inside a frame with room to spare: a fresh client's
  `STATE` carries the whole doc diff in one binary frame, and pure-insert text
  encodes at roughly its content size, so a ceiling near 1MB would let that
  frame cross the 900KB hibernated-socket budget (D9). Capping the *field*
  keeps `STATE` unchunked — the machinery this section refuses — instead of
  guarding the frame after the fact. Rather than reject the crossing update —
  which would leave the
  client's doc permanently ahead of the server, a silent and sticky divergence —
  the server **accepts the update that crosses the line, then freezes the
  field**: every later `UPDATE` gets a `Frozen` `REJECT` and the client goes
  read-only. Peers converge on intact content and the freeze is loud (17.4
  persists it, 17.6 renders it). "Un-freezing" is not an engine gesture: what a
  full note becomes — split it, replace it — is the app's data model a layer up,
  and an admin import with a smaller field resets the ceiling.

### 17.4 Server: append-and-relay hot path, docs only on demand

Storage, two tables beside the engine's own:

    yjs_fields(field_id TEXT PRIMARY KEY, snapshot BLOB, snapshot_seq INTEGER,
               byte_total INTEGER, frozen INTEGER)
    yjs_updates(field_id TEXT, seq INTEGER, bytes BLOB, PRIMARY KEY(field_id, seq))

The typing path never materializes a document: an inbound `UPDATE` is appended
to `yjs_updates` and relayed, synchronously — persist-then-broadcast, so no
client ever sees state the server hasn't durably stored (the same ordering
rule as poke-after-commit; strictly stronger than the debounce-savers in this
space — y-partyserver's 2s-debounced `onSave` and y-sweet's background S3
flush can both lose the last seconds of typing on a crash). Y.Docs are only
built for `GET` (diff needs a doc) and compaction, loaded snapshot-plus-tail
behind a small LRU (~8 docs; fields cap at 700KB so worst case ~6MB). One
coherence rule on the append path: if the field's doc is already in the LRU,
the inbound update is also applied to it (or the entry evicted) — a cached
doc must never fall behind the log, or the next `GET` it serves returns an
incomplete diff with a stale server state vector. Corrupt update rows are
skipped-and-logged on load; any connected client still holding the lost ops
re-uploads them through the push-back leg in 17.3 (not just the client that
produced them). If no live client holds them, dependent later ops park
permanently in the doc's pending queue and the field is truncated at the gap
— logged and visible in stats, unrecoverable by design (fail loudly, never
guess); corrupt snapshots throw outright. Compaction rides the existing alarm: any field with more than ~200
pending updates gets materialized, re-encoded as one snapshot at
`snapshot_seq`, tail deleted. Fields are capped (17.3) so snapshots never
approach SQLite's 2MB row limit — no chunking machinery.

The field ceiling (17.3) is enforced on this same append path without ever
materializing: `byte_total` is a running sum of appended update bytes,
incremented in the append transaction. When an append crosses `MAX_FIELD_BYTES`
the update still commits (peers converge on it) and `frozen` is set in the same
transaction; every later `UPDATE` for the field is refused with `Frozen` before
it touches storage. The running sum is a deliberate over-estimate — Yjs deletes
and duplicate structs make the materialized doc smaller than the byte log — so
compaction, which materializes anyway, reconciles `byte_total` to the true
encoded size. The freeze is sticky: un-freezing on shrink would need per-update
net-size classification, which means materializing on the hot path — the one
thing this section refuses. Because `frozen` is a persisted column it survives
hibernation with no in-memory state to rebuild, so a `GET` after wake reports
the field read-only in `STATE` directly from storage.

CRDT bytes never touch the rows table, the mutation log, or pokes (§1's
non-goal stands). Writes are gated by the extension's `authorizeWrite`
predicate over the §15 auth stamps — same coarse model as everything else:
membership to read, one app-defined predicate to write. A `false` verdict is
not an error path: it sets the `writable` bit false in the `GET` reply (17.3),
and an `UPDATE` that arrives anyway earns a `NotWritable` `REJECT`.

### 17.5 The extension seam in core

Core (`@cf-sync/server`) gains one config slot and a types-only interface —
no yjs import anywhere in core:

```ts
interface EngineExtension {
  init(ctx: {
    sql: SqlStorage
    transactionSync<T>(fn: () => T): T   // atomic multi-statement writes (17.4's append+freeze)
    broadcast(bytes, opts?: { except? }): void
    send(ws, bytes): void
  }): void
  onBinaryMessage(ws, bytes, ctx: { clientId; principal?; auth?; ready }): void
  onAlarm?(): void
  onExport?(): unknown           // merged into admin export under "extension"
  onImport?(data: unknown): void // called by admin import
  onReset?(): void
  onStats?(): Record<string, number>
}
```

`broadcast(bytes)` and `send(ws, bytes)` route through core's existing
per-socket delivery gate (`#deliver`, generalized from text to bytes), so the
§15 defunct/expiry checks that guard every poke also guard the binary lane — the
extension cannot send to a socket core is already tearing down, and
`onBinaryMessage` stays synchronous end-to-end like every other handler
(invariant 3): it appends and relays in one turn with no `await` between.

One slot (`extension`), not an array: multiple extensions would need a routing
byte on every binary frame for a consumer that doesn't exist. Generalize when
a second extension is real, not before. The config slot carries a **factory**
(`extension: () => EngineExtension`), invoked once per workspace DO instance
in `init` — never a shared object: Cloudflare colocates instances of one DO
class in a shared isolate, so a singleton extension's closure state (doc
cache, storage binding, refusal sets) would silently bridge workspaces —
`yjsFields(options)` accordingly returns the factory, keeping call sites
(`extension: yjsFields()`) unchanged. The client seam is equally small:
`SyncClient` exposes `sendBinary(bytes)`, `onBinary(cb)`, and ready-transition
notifications — enough for `createYjsFields` to be plain library code with no
privileged access.

### 17.6 Client: in-memory docs, re-sync on ready, no persistence

`getDoc(fieldId)` is ref-counted: first call creates the Y.Doc and sends
`GET`; `release()` drops local state at refcount zero. (Ref-counted shared
handles are the Liveblocks `getYjsProviderForRoom` shape, not y-partyserver's
provider-per-component — two components on one field share one doc.) Local
`update` events (non-remote origin) send immediately when connected, else
buffer in memory. On every reconnect that reaches ready, the add-on re-sends
`GET` with the current state vector for every held doc — edits typed during a
disconnect merge server-side on resume, because that's what Yjs is for.
`whenSynced` is one-shot: it resolves on the first `STATE` and stays
resolved — it answers "can I render this field", not "am I currently live";
liveness is the client's sync status. (y-websocket's `synced` flag re-arms on
disconnect; apps that need that granularity can combine the two signals.)

A held doc carries a **writability** signal on its handle: `handle.canWrite`
(reactive) and `handle.subscribe(cb)`. It starts from the `writable` flag in the
`GET` reply (`STATE`, 17.3) and flips to false on a `REJECT` for the field. The
load-bearing rule hangs off it: **when a field is not writable the add-on
neither sends nor pushes back its local updates.** A read-only binding means the
common case produces no outbound update at all; the rule is the backstop for a
field that freezes mid-session, and it is what turns a server refusal into a
one-time, loud event instead of an op that re-uploads forever through the
bidirectional leg (17.3). The three refusal reasons — `authorizeWrite` false,
`Frozen`, `TooLarge` — collapse to this one client concept: writable or not,
always told, never guessed. A `REJECT`-flipped false is **sticky for the
handle's lifetime**: a reconnect's `STATE` honestly reports `writable: true`
in the `TooLarge` case (the server refused one update, not the field), but
only the client knows its local doc now holds an op the server will never
accept — flipping back would resume the poisoned push-back. A fresh handle
after reload rebuilds from server state and starts clean.

The frame guard bounds the push-back leg too, and that is the one place the
collapse can bite honest edits: a disconnect's ops merge into one update, so
a client that writes more than `MAX_FIELD_UPDATE_BYTES` of new ops into a
single field while offline trips the local guard on reconnect and the field
goes read-only with those ops stranded (no persistence — a reload loses
them). **Accepted residual risk, not machinery**: the guard is sized (17.3)
so only a huge paste or an extreme offline backlog can reach it, splitting a
Yjs update is not a paved operation, and the editor binding's length guard —
the same one that stops pastes — bounds offline growth at the source. The
collapse is loud (`canWrite` flips, console warns) so the app can tell the
user before a reload makes the loss real.

**Decided: no local persistence of field docs** (resolving the open
question carried since the §14 revision). Field co-editing is an online
activity; a reload re-fetches small documents in one round-trip. The engine's
durable plane (rows, cursor, outbox in the `SyncStore`) is unaffected. The
escape hatch is composability, not configuration: `handle.doc` is a standard
Y.Doc, so an app that wants offline field durability attaches y-indexeddb to
it itself — no library surface needed.

In-text remote cursors (selection ranges inside a field) are a non-goal:
field-level presence ("X is editing this field") comes from §16 payloads;
character-level cursors would need Yjs awareness plumbing and no target UI
requires them.

### 17.7 Admin surface

The extension contributes to the existing ops via 17.5 hooks: export gains a
`fields` map (fieldId → base64 snapshot, updates compacted at export time),
import restores it, reset clears both tables, stats reports field count and
byte totals. This is also the migration seam: seeding a workspace's Tier 2
fields is just an admin import whose `fields` map was built by encoding fresh
Y.Docs from source text.

Import under live sockets: the client-side re-`GET` fires on ready
*transitions*, so an import that lands while sockets stay ready would go
unnoticed — clients holding docs would neither pull the restored state nor
push back ops the restore lost. Import therefore closes every socket with a
refresh (4300); reconnecting clients re-`GET` and the bidirectional exchange
merges any ops they still hold — restore is **convergence-preserving**
(crash-recovery semantics). This overrides the row plane's own live-socket
behavior for any import that carries fields: a row-only import hot-swaps state
with a `clear` poke and leaves sockets open (the import path in §5's admin
surface), but an import whose snapshot includes a `fields` map cycles every
socket with 4300 instead and drops that poke — a refreshed reconnect
re-bootstraps rows at hello (`clear` + snapshot, since `min_cursor_version`
advanced) *and* re-`GET`s fields, so one close keeps both planes consistent
rather than hot-swapping rows over the socket while fields silently wait for a
reconnect that never comes. The row-only path is unchanged when no fields are
present. A rollback that must *discard* client-held ops is
the other admin gesture: `disconnect` kick before importing, so apps reload
and rebuild every doc from the restored server state (no client persistence
makes this clean). Orphaned fields (row deleted, field remains) are scoped out by layer, not
deferred: the row→field link is an app pointer convention the engine never
sees, so the engine cannot know a field is orphaned in order to GC it. They are
cheap to store and visible in stats; an app that wants them collected deletes
the field through the same admin/extension surface it created it with. Coupling
automatic GC to a convention core can't observe would be the engine guessing —
the thing this design refuses everywhere.

### 17.8 Tests that lock this

Persist-then-relay ordering (a relayed update is always readable back);
`GET` with a stale state vector returns exactly the missing diff; compaction
round-trips content byte-for-byte (encode → compact → load → same state);
eviction mid-session (`state.abort`) followed by client `GET` converges,
including updates typed while disconnected; reconnect after a send the server
never persisted converges (the `STATE` push-back leg re-uploads the missing
ops); corrupt update row skipped, doc still loads; an update over the transport
frame guard is refused with a `TooLarge` `REJECT` and the socket stays open;
crossing `MAX_FIELD_BYTES` accepts-and-relays the crossing update then freezes —
later `UPDATE`s get `Frozen`, `byte_total` reconciles to the true encoded size
at compaction, and the freeze survives a hibernation wake (a post-wake `GET`
reports the field read-only in `STATE`); a refused update, for any reason, is
**not** re-uploaded on the next reconnect — the push-back leg stays suppressed
for a non-writable field (the regression that locks the no-silent-wedge fix);
after a `TooLarge` `REJECT`, in-flight `UPDATE`s from the same socket for the
same field are refused, never appended (the server-side collapse: no gap ever
lands in the log), while the same client's `UPDATE`s for *other* fields still
apply;
binary frame before ready rejected; `authorizeWrite: false` socket gets
`writable: false` in `STATE`, can `GET`, and its `UPDATE`s are refused with
`NotWritable`; export → reset → import round-trips fields;
an `UPDATE` arriving while the field's doc sits in the LRU keeps the cached
doc log-coherent (a `GET` served right after returns the complete diff);
import under live sockets cycles them and both directions converge (restored
state pulled, client-held ops pushed back); two clients typing concurrently
in one field converge to identical state (seeded interleaving, the §11
convergence-sim pattern applied to text); two workspaces on one class share
no extension storage, cache, or delivery — writes to the same `fieldId` in
each stay invisible to the other (the regression that locks the 17.5
per-instance factory); a corrupt snapshot on one field neither blocks other
fields' compaction nor throws out of the maintenance alarm, and its own
update tail survives the rolled-back attempt; a `STATE` with an undecodable
state vector still resolves `whenSynced` (the push-back encode is guarded
like the diff-apply); `getDoc` refuses a fieldId the wire format cannot
carry before registering any state, and one field's failed re-`GET` on a
ready transition never starves the rest.
