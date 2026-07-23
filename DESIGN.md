# cf-sync-engine — Design

A server-authoritative, Linear-style sync engine built on Cloudflare Durable Objects,
intended as the data foundation for documents/repos/corates. Client state is managed by
TanStack DB via a custom collection adapter.

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
  schemaVersion: string
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
  code: 'VersionNotSupported' | 'CursorInvalid' | 'Unauthorized' | 'PushInvalid'
  detail?: Json
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
- With a store, a confirm timeout settles the caller's promise (rejects, so the
  optimistic overlay rolls back) but keeps the mutation queued: durable intent
  outlives the UI signal. Without a store, timeout still discards.
- `stop()` rejects in-flight callers but leaves the durable outbox intact; a
  schema-version mismatch at hydration discards cache *and* queued mutations
  (they target the old schema); a `backendId` change flows through naturally as
  a clear poke.

### 7.2 Optimistic intent mutators (decided, implemented)

Intent mutations (`client.mutate('todos.clearCompleted')`) run the shared
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
  timeout rolls the overlay back but keeps the mutation queued. Startup
  replay of queued intents (Replicache does this) is now *possible* and
  deliberately deferred — it needs its own pass on ordering and error
  handling before `markReady`.
- **Timeout is unchanged but now visible.** A `Timeout` rejection rolls the
  overlay back while a durably-stored mutation stays queued and still applies
  on reconnect — the rows then *reappear* via the confirm patch. Identical to
  today's collection-handler behavior, but auto-optimistic intents make it
  observable; the README must say plainly that rejection means "your overlay
  rolled back," not "the mutation won't apply," and a test pins the
  rollback-then-reappear sequence.

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

**Deferred, deliberately.** Two seams this design leaves open without
blocking:
- *Typed action namespace* — `actions.todos.clearCompleted()` instead of
  `mutate('todos.clearCompleted')` is a pure type-level wrapper over `mutate`
  (Zero's `MakeCustomMutatorInterfaces` pattern,
  `zero-client/src/client/custom.ts:95-110`).
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
- Storage-format changes inside the DO are ordinary SQLite migrations in `onStart`,
  invisible to the protocol.
- **App-schema rollout (drilled, M3):** exact-match policy — the server rejects any
  other `schemaVersion` at hello with `VersionNotSupported`; the client goes fatal
  and the app reloads into the new bundle, whose `SyncStore` cache is discarded on
  the version mismatch (§7.1) and re-bootstraps. Server-side data rewrites are
  declared as the app's **migration chain** (`defineApp`'s
  `migrations: [{ from, to, migrate? }, …]`): an append-only version history,
  validated at definition time (contiguous, acyclic, ending at `version`). On the
  first wake under a new version, the DO replays every step from its stored
  version, before any traffic — a workspace that slept through several deploys
  replays multiple hops. All steps run against one write buffer (later steps read
  earlier steps' writes); the net result is validated against the *current* schema
  at commit, so shipped steps are never edited when a later version reshapes the
  same table. Everything commits atomically at a single new data version with the
  version restamp; `min_cursor_version` advances to it so no pre-migration cursor
  can catch up; `backendId` is untouched (same history — no outbox renumbering);
  per-client LMIDs survive, so mutations queued in old-bundle tabs still dedupe
  correctly after their tab upgrades. A replay of migrate-less steps (additive
  changes) just restamps and leaves cursors valid. A throwing step — or a stored
  version outside the declared chain, e.g. a rollback deploy — aborts DO
  initialization: old-shaped data is never served under the new version, and the
  next wake retries. The log records one `$schema.migrate` entry under client
  `$system` spanning the whole jump. Deploy order: worker before (or atomically
  with) web assets, so no client ever speaks a schema the server hasn't reached.
  The full chain is enforced by `schema-rollout.test.ts` and was exercised live
  (demo-1 → demo-2, 2026-07).

## 10. Permissions (v1 scope)

Workspace-coarse: membership is checked at upgrade and re-checked inside every mutator;
every member syncs the entire workspace. No row-level read filtering exists anywhere in
the broadcast path — this is an explicit punt, recorded here so it is a decision and
not an accident. If corates later needs finer read scopes, the plan is separate sync
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
4. **M3 — product hardening for corates.** Phase 1 *(done)*: client persistence via
   the `SyncStore` seam (§7.1) — IndexedDB-backed row mirror + cursor + durable
   outbox, instant hydration before connect, offline mutations replayed exactly
   once under the LMID contract. Remaining: optimistic intent mutators (§7.2,
   designed), collaborative text per the tiered strategy in §14 (built only when a
   field type proves to need real merging).

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
co-edited. The actual corates workload is the opposite shape — **hundreds of small
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
