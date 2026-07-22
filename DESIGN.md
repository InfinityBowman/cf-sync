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
- Collaborative text editing. Character-level editing goes through per-document CRDT (Yjs) DOs, outside this engine. The row-sync engine stores document metadata and a pointer.
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

Mutators are plain TypeScript functions `(tx, args, ctx) => void | AppError` registered
in a versioned map. The same map (minus authority checks) runs on the client for
optimistic application — shared-mutator isomorphism is the Replicache/Zero model.

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
  the UI shows last-synced state until the server confirms. Avoiding this would
  require client-side mutator implementations for rewind/replay, which the
  server-authoritative design deliberately rejects.
- With a store, a confirm timeout settles the caller's promise (rejects, so the
  optimistic overlay rolls back) but keeps the mutation queued: durable intent
  outlives the UI signal. Without a store, timeout still discards.
- `stop()` rejects in-flight callers but leaves the durable outbox intact; a
  schema-version mismatch at hydration discards cache *and* queued mutations
  (they target the old schema); a `backendId` change flows through naturally as
  a clear poke.

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
  (tldraw `TldrawDurableObject.ts:44`).
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
- `schemaVersion` (string): identifies the app-data shape + mutator set. Policy:
  additive-only changes within a version; renames/removals require a new version.
  **Never remove a mutator name that shipped under a live schema version** (§3 D10).
- Storage-format changes inside the DO are ordinary SQLite migrations in `onStart`,
  invisible to the protocol.

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
   once under the LMID contract. Remaining: schema-version rollout drill,
   per-document Yjs DO integration for text.

## 13. Open questions (deliberately deferred)

- Per-table typed SQLite columns in the DO (enables server-side queries/indexes) vs.
  staying generic — revisit at M2 with real workloads.
- HTTP transport fallback for restrictive networks — protocol is ready for it; add
  when a real user hits it.
- Hot-workspace sharding (read-replica DOs fanning out pokes) — the ~hundreds of
  pushes/sec per-DO ceiling is far above Linear-style human workloads; revisit only
  with evidence.
- Presence/ephemeral state (cursors, "who's viewing") — likely a separate lightweight
  channel on the same socket, never written to SQLite.
