# Architecture

The contributor document: locked decisions, the invariants the tests enforce, and
the reasoning that is expensive to re-derive. The app-developer story lives in
`docs/` — nothing here is needed to *use* the engine. Code comments cite sections
of this file by anchor (`ARCHITECTURE.md#optimistic-intents`).

Every mechanism here is grounded in prior art cloned into `reference/`
(gitignored, shallow clones; citations are file:line into them):

- `reference/rocicorp-mono` — Replicache push/pull/poke contracts, versioning strategies, Zero's server mutators
- `reference/livestore` — the most mature CF-native sync backend (`@livestore/sync-cf`)
- `reference/tanstack-db` — the client collection contract our adapter implements
- `reference/partyserver`, `reference/tldraw-sync-cloudflare` — production DO hibernation patterns

This file was distilled from the original working design document (`DESIGN.md`,
removed 2026-07-25); the full narrative, including superseded phases and test
inventories, is in git history at that file's deletion commit.

## Invariants

The contracts that carry the whole design. Breaking any of these is a bug even
when every test still passes.

1. **Atomicity.** A mutation's data effects and the client's `last_mutation_id`
   advance commit in the same SQLite transaction (Replicache
   `server-push.md:155-159`). This is what makes client-side confirmation sound.
2. **Permanent app errors still advance the LMID.** Only transient errors
   (storage failure) abort without advancing, which the client treats as
   "server offline, retry" — otherwise a permanently-failing mutation retries
   forever (`server-push.md:165-202`; Zero's 3-phase apply).
3. **All DO WebSocket handlers stay synchronous** — no `await` between reading
   state and sending frames. Fan-out, presence relay, binary-lane handling, and
   the admin `disconnect` walk all obey this.

Client-side mirror: **the persisted cursor is never newer than the persisted
rows.** Behind is safe — patches are idempotent full-row puts/dels, so
re-applying a delta converges. Ahead would silently skip deltas.

## Goals and non-goals

Server-authoritative sync (the server is the only writer of canonical state;
clients are optimistic caches that converge), Linear-grade UX, Cloudflare-native
only (Workers + DOs + DO SQLite, no external database tier), and a protocol
simple enough to hold in your head, testable by deterministic simulation.

Deliberate non-goals, recorded so they are decisions and not accidents:

- Row-level read permissions / partial sync — see [Permissions](#permissions).
- Character-level text merging through the row-sync mutation log — see
  [Collaborative text tiers](#collaborative-text-tiers).
- Cross-workspace transactions (application-level sagas).
- General-purpose infrastructure: one partition scheme, one conflict strategy,
  one client (TanStack DB).

## Overview

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

Flow: client applies a named mutation optimistically → pushes it over the
WebSocket → the DO re-runs the mutator authoritatively against SQLite, stamps
changed rows with the next per-DO version, advances the client's
`lastMutationId` in the same transaction → broadcasts a data-carrying poke
(patch + confirmations) to all connected clients → each client applies the
patch as new base state and drops/rebases optimistic mutations.

## Locked decisions

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

## Wire protocol

Message shapes are the zod schemas in `packages/protocol/src/messages.ts`
(exported via the `./internal` subpath, which carries no compatibility
promise). What the shapes don't say:

- The **three-part poke** (`pokeStart`/`pokePart`/`pokeEnd`) is Zero's shape
  (`zero-protocol/src/poke.ts:32-73`): large payloads stream in chunks without
  server-side buffering, and it doubles as the chunked bootstrap. The
  `remaining`/`pageInfo` countdown is LiveStore's progress signal
  (`sync-backend.ts:143-155`).
- The **clientId is bound at upgrade** (URL param, stored in the socket
  attachment), never carried per-message — a connection cannot speak for
  another client mid-stream. A clientId names one contiguous mutation
  sequence: unique per SyncClient instance (per tab/session — sessionStorage,
  not localStorage), or two tabs collide on mutation ids.
- **Client-side validation** (from Replicache `handlePullResponseV1`,
  `sync/pull.ts:203-302`): a poke whose `baseCursor` doesn't match the current
  cursor is discarded and the client re-hellos with its cursor; cursors and
  per-client LMIDs never move backward.
- **Cursor and reset semantics.** `cursor.version` is the per-DO monotonic
  version at `pokeEnd` time. A `backendId` mismatch, `version <
  minCursorVersion` (compaction horizon), or unknown cursor → the server
  replies `pokeStart(baseCursor: null)` + `clear` + full snapshot. Reset is not
  an error; it is the bootstrap path. A poke whose patch contains `clear` is a
  complete state replacement, so clients apply it from **any** base (admin
  import/reset converge live clients in one trip). A changed `backendId` in
  `pokeEnd.cursor` is a new history: the client resets its confirmed LMID and
  renumbers its unconfirmed outbox from the new baseline.

## Storage

The DDL is `packages/server/src/storage.ts`; the decisions behind it:

- **Pull-after-cursor is one indexed scan** (`SELECT … FROM rows WHERE version
  > ?`, tombstones included) — the per-space-version strategy's O(index scan)
  pull, and the reason it was chosen over CVR/row-version diffing.
- **`mutation_log` has its own sequence** (`log_seq`), separate from the data
  version: a mutation that writes no rows (app error, no-op) advances the
  client's LMID without a data version, so cursor versions track data changes
  only and LMID-only advances never force a broadcast to keep other clients'
  cursors aligned.
- **Compaction** rides a DO alarm: hard-delete tombstones older than the
  retention window, advance `min_cursor_version` to the youngest deleted
  tombstone — any client at or past it already received every delete being
  discarded; clients under the horizon re-bootstrap. `backend_id` changes only
  if the DO's history is wiped (admin reset).
- **Storage-format changes** run through an append-only migration list tracked
  in a `_migrations` table (DO SQLite doesn't expose `PRAGMA user_version`),
  applied once per DO inside the constructor's `blockConcurrencyWhile` —
  invisible to the protocol.

## Mutation processing

Per push message, serialized by the DO (LiveStore serializes its head
check-and-append the same way, `push.ts:63-87`):

```
for each mutation m:  (expected = last_mutation_id + 1)
  m.id < expected → skip (duplicate delivery)     m.id > expected → PushInvalid (gap)
  in one SQLite transaction:
    run mutator; written rows get version = current_version + 1
    permanent app error → still advance LMID, log the error result (invariant 2)
    last_mutation_id = m.id   ← same tx as data effects (invariant 1)
    append to mutation_log
after the batch: one poke (rows with version > previous, lastMutationIdChanges,
mutationResults), broadcast chunked.
```

Mutators are `{ args?, apply }` registered via `defineMutators(schema, …)` in
`@cf-sync/protocol` — the only package importable from both worker and browser.
`args` is a standard schema validated *before* `apply`; `apply(tx, args, ctx)`
is plain and synchronous. The registry is shared: the server runs `apply`
authoritatively, the client uses the same object for typed calls, local
fail-fast validation, and the optimistic run (the wire always carries the
caller's original args — the server's parse is authoritative).

Version, schema, mutators, and the migration chain travel together as one
`defineApp({ version, schema, mutators, migrations })` value passed to both
`createWorkspaceDO` and `SyncClient`. This makes "client and server disagree
about the shape or the mutator set" unrepresentable, and puts the version bump
and its migration step in the same literal — forgetting one is a startup error
in both bundles (the chain must end at `version`), not silent skew.

**Schema authority.** `defineSchema` is enforced at the only place rows enter
storage — `tx.put`, shared by mutators, schema migrations, and admin import:

- A `put` to a table not in the schema, or failing its schema, is a permanent
  `InvalidArgs` app error (LMID still advances). What gets stored is the
  *parsed output* — defaults are applied server-side.
- `get`/`list`/`del` stay schema-loose at runtime so migrations can read and
  clean up tables that left the schema; reads return raw stored JSON. Migration
  replays defer `put` validation to commit: the chain's *net result* must
  parse; intermediate shapes are transient.
- Validation must be synchronous (mutations commit inside `transactionSync`);
  a validator returning a Promise is rejected as a permanent error.

## Client adapter

The adapter is a TanStack DB collection options creator implementing
`SyncConfig.sync` (`reference/tanstack-db/packages/db/src/types.ts:327-360`):

| Engine concept | TanStack DB call |
|---|---|
| `pokeStart` | `begin()` |
| `pokePart` `put`/`del` | `write({type, value…})` — one collection per `tbl` |
| `pokePart` `clear` | `truncate()` (preserves optimistic overlay via its snapshot mechanism, `sync.ts:214-248`) |
| `pokeEnd` | `commit()`; the cursor is persisted by the client-level `SyncStore`, not per-collection metadata — one workspace cursor spans every table |
| first `pokeEnd`, `more: false` | `markReady()` — also called on the error path so `preload()` never hangs |

Row types, TanStack's `schema` option, and `getKey` all derive from the shared
`defineSchema` entry. Mutation path (Pattern B — the adapter owns the
handlers): `onInsert/onUpdate/onDelete` enqueue named mutations with the next
sequential id and resolve when `lastMutationIdChanges[clientId] >= id` arrives
in a poke (Electric's `awaitTxId`, `electric.ts:709-769`). TanStack DB then
drops confirmed overlays and recomputes the rest (`state.ts:1146-1189`) —
**client-side rebase comes from the store; we never implement rewind/replay
ourselves.**

## Offline store

We evaluated `@tanstack/db-sqlite-persistence-core` and
`@tanstack/offline-transactions` and decided to own this layer:

- **The cursor is per-workspace; their persistence is per-collection.** One
  poke spans many tables and commits against one cursor. IndexedDB gives one
  transaction across object stores, so rows, cursor, `confirmedLmid`, and the
  outbox commit atomically — the client-side mirror of invariant 1.
- **offline-transactions duplicates the LMID contract** (its own idempotency
  keys, retry scheduler, replay); ours is the protocol itself. What we did
  adopt from its design: delay `markReady` until hydration completes, and
  hydrate before any network I/O.

The seam is `SyncClient`'s `store: SyncStore` (`packages/client/src/store.ts`);
`IndexedDBSyncStore` is the browser implementation, `MemorySyncStore` the test
double and reference.

**Multi-tab needs no leader election.** Rows + cursor are shared per workspace;
outbox records are partitioned by clientId (each tab replays only its own;
stale records GC'd after 30 days). Catch-up patches carry *current row state as
of the poke's end cursor*, not historical deltas, so a poke that does not
advance the stored cursor is wholly subsumed by what a newer writer already
stored and is skipped (the subsumption guard in `applyPoke`).

**Settlement semantics.** With a store there is no confirm timeout: the
caller's promise stays pending until a connection confirms — the durable intent
*will* apply, so a `Timeout` rejection would report a failure that isn't one. A
rejection always means the mutation will not apply (permanent app error,
`destroy()`, or fatal). Memory-only clients keep `confirmTimeoutMs`, and that
rejection discards the mutation — honest, because it would not survive a reload
anyway. `destroy()` rejects in-flight callers but leaves the durable outbox
intact; a schema-version mismatch at hydration discards cache *and* outbox
(they target the old schema). `onMutationRejected` is the one surface that
reaches rejections with no awaiting caller — collection handler writes, and
outbox entries restored after a reload (whose promises died with the previous
session); without it, a replayed mutation the server refuses rolls back
invisibly.

### Offline-first render

Hydration needs an observable end, or an offline launch cannot tell a full
cache from an empty one. `status` can't carry it: `connecting` is set before
hydration starts and still holds when it finishes, so it reads identically on
both sides of the edge. Collection contents can't either — a collection with no
rows mid-hydration looks exactly like a genuinely empty workspace, which is the
first-launch case a render gate has to get right.

So the latch is explicit: `client.hydrated` (boolean), `client.whenHydrated`
(promise of the same value), `client.subscribeHydrated`, and `useHydrated`. It
closes **true only when there was a snapshot to paint** — the same condition
that calls `markReady`, a persisted cursor. Every other end settles it false:
no store, an empty store, a cache discarded on schema mismatch, a store that
failed to load, and teardown mid-hydration (so no awaiter outlives the client).
False therefore means "nothing cached to show, wait for the first sync", which
is the only thing a gate can act on; the two ways of having nothing are not
worth distinguishing to a caller.

It settles once and stays settled — it describes local state, not the socket,
so a later reconnect leaves it alone. Subscribers fire only on a true
transition: notifying "still false" would re-render every memory-only and
first-launch client for no change.

## Optimistic intents

Intent mutations (`client.mutate.todos.clearCompleted()`) run the shared
`apply` speculatively on the client; the server's authoritative run remains the
truth. Three models exist for an intent's optimistic effect: Replicache/Zero
**re-execute** the recipe against each new base on rebase
(`replicache/src/db/rebase.ts:25-99`); LiveStore makes the event log canonical
and re-materializes; TanStack DB stores a **frozen diff** — the optimistic
callback runs once and rebase re-layers snapshots (`collection/state.ts:611-637`).
We are in the TanStack model. The speculative run goes through a
`LocalWriteSet` mirroring the server's `WriteSet`; one TanStack transaction per
intent (writes inside `tx.mutate` bypass the collection handlers,
`collection/mutations.ts:224`); synced commits buffer while a transaction
persists (`collection/state.ts:876`), so confirm is an atomic
overlay-for-patch swap.

Decisions:

- **Rebase = frozen writes, not re-run.** A remote change arriving mid-flight
  rebases the *originally computed* writes; the confirm patch replaces them
  with the server's result. Prediction, then truth — divergence is bounded by
  one round-trip.
- **Determinism travels in args.** IDs, timestamps, randomness are generated at
  the call site and passed as args (the zbugs convention,
  `apps/zbugs/shared/mutators.ts:19-33`) — what makes the local guess
  byte-identical to the server echo. Documented convention, not enforced.
- **Local throw = fail fast.** An `AppError` from the speculative run rejects
  with its code; nothing queued, nothing shown. Mutator authors must guard or
  no-op on missing rows and reserve throws for true invariants.
- **Degrade, never lie.** If `apply` touches a table with no attached
  collection, the speculative run is discarded (warn once) but the mutation
  still enqueues — optimism lost, correctness kept.
- **Empty write set still enqueues.** TanStack resolves a zero-mutation commit
  without calling `mutationFn` (`transactions.ts:512`), which would silently
  drop the mutation from the wire; a no-op-locally intent must still reach the
  server.
- **Registration at creation, behind a compacting gate.** Collection hooks
  register when options are created, fronted by a buffer (last op per row id +
  pending-clear — sufficient because patches are full-row LWW), drained when
  TanStack starts the sync pipeline. This removes the late-`registerTable`
  full resync for every collection created before first subscription.
- **Startup replay (2026-07-25).** Hydration re-runs each restored outbox
  entry's `apply` — crud and intent alike, sequentially so overlapping intents
  read each other — and lays the writes with `persist` tied to the entry's
  existing settlement: confirm swaps the overlay for the authoritative patch,
  rejection rolls it back and still reports through `onMutationRejected`. This
  is re-execution but not a rebase — it is a fresh speculative run against a
  fresh base, exactly what live `mutate` does, so the frozen-diff rule stands.
  Error policy inverts the live fail-fast: **degrade, never drop** — any replay
  failure skips the overlay (warn) but keeps the entry queued, because a local
  throw proves nothing about the server's verdict and a rejection must always
  mean "will not apply". Replay runs after cached rows commit and before
  `markReady`; outbox-only state (queued before the first-ever sync) replays
  against empty collections, so offline-created rows reappear.
- **Known sharp edge (accepted).** TanStack rollback cascades: if intent A is
  rejected and pending intent B touched the same row, B's overlay rolls back
  too — but B's wire mutation may still succeed, so the row flickers until B's
  confirm patch restores it. Transient and convergent.
- **Deferred:** per-mutator local overrides (Zero's registry-level pattern,
  `zero-client/src/client/custom.ts:95-110`) — a mutator that reads
  server-only state degrades to non-optimistic with no recourse; build only if
  wanted.

## Connections and lifecycle

Lifted from partyserver/tldraw/LiveStore, considered settled:

- **Auth at upgrade, in the worker, before the DO is reached** (partyserver
  `onBeforeConnect`, `index.ts:548`). Connection auth is coarse; mutation auth
  is authoritative (re-checked per push inside mutators).
- **All per-connection state lives in the socket attachment**
  (`serializeAttachment`) — nothing about a connection is held only in DO
  memory, so hibernation eviction is free.
- **`setWebSocketAutoResponse(ping, pong)`** so keepalives never wake the DO
  (tldraw `TldrawDurableObject.ts:44`).
- **The client heartbeats** (live-observed: idle edge connections die
  unpredictably between ~75s and >130s, and a half-open socket emits no close
  event). Ping every 25s; force-reconnect if no frame arrives within the idle
  deadline — the missed deadline is the only reliable dead-socket signal. A
  synchronously-throwing `WebSocket` constructor is treated as an instant
  disconnect so the backoff loop never dies.
- **Once-only `onStart` under `blockConcurrencyWhile`** re-runs migrations and
  loads meta on wake (partyserver `#ensureInitialized`, `index.ts:875`).
- **Reciprocate close frames** (except reserved 1005/1006/1015) or clients
  observe 1006 (partyserver `closeQuietly`, `index.ts:786-796`).
- **Broadcast iterates `getWebSockets()` live**; a failed send closes that
  socket with 1011. Slow clients are not backpressured — pokes are deltas and
  a reconnect catches up by cursor, so dropping a laggard is always safe.
- **Frame budget 900 KB**; the chunker packs by item count and encoded bytes
  (LiveStore `splitArrayBySize`, `transport-chunking.ts:38-85`).

## Schema evolution

- `protocolVersion` (integer): server supports N and N-1; older clients get
  `VersionNotSupported` and hard-reload. Server deploys before clients (Zero's
  rule, `protocol-version.ts:15-77`).
- **Every schema change requires a version bump** — additive too. The old
  additive-within-a-version allowance was unsound twice over: rows written
  before the change are never migrated, so a defaulted field is absent at
  runtime while `RowOf` claims presence (defaults apply at write; reads return
  raw JSON); and old bundles sharing the version string stay connected, where
  their full-row `sync.put`s silently strip any new field a new-bundle client
  set. A bump closes both. Never remove a mutator name shipped under a live
  version (D10).
- **Drift detection is two-layered by blast radius.** At runtime the DO stores
  a structural fingerprint of the table schemas beside the version
  (`fingerprint.ts`); same version + different fingerprint warns once and
  restamps — a heuristic (zod's JSON Schema emission can shift across
  upgrades) gets to shout, never to take down availability. The strict layer is
  CI: `checkSchemaEvolution(app, snapshotPath)` fails the build on unbumped
  changes — a false positive there costs one deleted file.
- **The migration chain** (`defineApp`'s `migrations`, consecutive integer
  targets ending at `version`; `null` marks additive steps) replays on first
  wake under a new version, before any traffic. All steps run against one
  write buffer (later steps read earlier writes); the net result validates
  against the *current* schema at commit, so shipped steps are never edited
  when a later version reshapes the same table. Everything commits atomically
  at one new data version with the restamp; `min_cursor_version` advances so
  no pre-migration cursor catches up; `backendId` and per-client LMIDs are
  untouched, so mutations queued in old-bundle tabs still dedupe after the tab
  upgrades.
- **Quarantined, not bricked.** A throwing step or an out-of-chain stored
  version (rollback deploy) aborts DO initialization: upgrades fail as 503
  (clients keep their paced reconnect and recover unaided), admin ops answer
  500 — except `POST reset`, which stays reachable and heals, because the
  failure message names it as the remedy and a remedy must not sit behind the
  failure.
- Deploy order: worker before (or atomically with) web assets, so no client
  speaks a schema the server hasn't reached.

## Permissions

Workspace-coarse: membership at upgrade, re-checked inside every mutator; every
member syncs the whole workspace. No row-level read filtering exists anywhere
in the broadcast path — an explicit punt, recorded so it is a decision and not
an accident. If finer read scopes are ever needed, the plan is separate sync
scopes (additional DOs / filtered spaces with their own cursors), not per-row
filtering of pokes. Zero's compiled query rewrites
(`read-authorizer.ts:61-119`) are the reference for the general thing —
fail-closed, enforced at read time, never post-filtered.

## Testing

The engine's value is its guarantees, so the simulation harness is a
deliverable, not an afterthought: N virtual clients + the DO under
`@cloudflare/vitest-pool-workers`, a seeded PRNG driving mutation generation,
reordering at the boundaries the real system allows (per-connection FIFO,
cross-client interleaving), disconnects, duplicate delivery, and DO
eviction/restart. Invariants asserted every step: LMIDs and cursors monotonic;
after quiescence all clients deep-equal the DO's rows; no optimistic mutation
survives confirmation; a mid-run re-bootstrap converges identically. Fault
menu: DO killed between apply and broadcast; compaction racing a stale client;
push replay after reconnect; version-mismatch handshake.

`@cf-sync/server/testing` exports `createTestEngine(app)` — an in-memory engine
over the same `WriteSet`/validation core the DO runs (`engine-core.ts` is
shared code, not a reimplementation), so app teams unit-test mutators and
migration chains in plain node with the engine invariants intact.

**Testing hibernation:** `state.abort()` simulates a *crash* (sockets die with
the instance); `evictDurableObject(stub)` from `cloudflare:test` preserves
hibernatable sockets like production. Both shapes are locked in tests.

## Collaborative text tiers

The engine's target workload (form-heavy collaborative record apps) is
hundreds of small text fields per workspace, ≤~4 collaborators, low typing
frequency — the opposite of the long-shared-page shape that motivates
per-document CRDT servers. A record view showing 30 fields must not need 30
sockets; DO granularity must match access granularity, and the unit of access
is the workspace. Each tier is built only when the previous demonstrably falls
short:

1. **Default: text fields are ordinary rows (LWW).** The failure mode — a true
   simultaneous edit of one field loses one side's keystrokes — is rare at this
   scale; field-level presence ("X is editing") discourages collisions instead
   of merging them.
2. **Fields that prove to need real merging: Yjs inside the workspace DO** —
   see [Yjs fields](#yjs-fields). One socket, one DO, one authorize hook. CRDT
   state stays out of the rows table and the mutation log.
3. **Back pocket: per-document Yjs DOs** if a future feature reintroduces the
   hot-shared-page shape. Composes alongside tiers 1–2 (a second DO class and
   route); not built on speculation.

## Session control

Identity, roles, and entitlements live in the app's external authority and are
never mirrored into the workspace (one authority per fact). Everything a
mutator needs from outside is looked up once in `authorize` and **stamped onto
the connection**; the lifecycle below carries, revokes, and refreshes those
stamps.

- **Verdicts.** `authorize` returns `boolean | Response` or an `AuthVerdict`
  (`{ok, principal?, context?, expiresAt?}` / `{ok: false, code?, reason?}`).
  `context` is validated against the registry's `authContext` schema at
  upgrade — drift between the authorize hook and the mutators fails at
  connect (permanent 4401), not mid-mutation.
- **Rejection delivery is accept-then-close, in the worker router.** A browser
  cannot observe the HTTP status of a failed upgrade, so `createSyncFetch`
  completes the upgrade with a local `WebSocketPair` and immediately closes
  with `(code, reason)` — the client gets a real close event and the DO never
  wakes. (partyserver does this inside the DO; the router is the platform
  win.) Reasons are short stable slugs — the close frame caps at 123 bytes.
- **Close-code space:** `[4400, 4499]` permanent → client stops and calls
  `onFatal` (4400 version, 4401 auth-shape, 4403 kick/rejection); `4300`
  refresh → reconnect immediately so `authorize` re-runs with fresh stamps.
  Loop guard: only the first 4300 reconnects immediately; a streak without an
  intervening ready connection falls back to paced backoff, so a stuck refresh
  webhook degrades instead of becoming a zero-delay authorize storm.
- **Rejected alternative:** in-band reauth over the live socket (Zero's
  `updateAuth`, Ably's `AUTH`). `authorize` runs in the worker against the
  app's database and the DO cannot re-run it; a reconnect keeps all auth
  evaluation in one place, and cursor catch-up makes the bounce cheap.
- **Stamps ride an internal header** (`x-cf-sync-auth`) the router strips from
  inbound requests first (unspoofable), parsed at upgrade into the socket
  attachment. Attachments cap at 2KB serialized: the upgrade fails loudly if
  the payload doesn't fit, never truncates.
- **`expiresAt` bounds trust without an alarm.** The deadline is checked at
  two synchronous points: inbound frames gate writes, and the broadcast
  fan-out gates reads — before relaying any frame, the DO reads the socket's
  deadline and closes with 4300 instead of sending. Fan-out is where reads
  happen, so checking there is necessary and sufficient; a fully idle
  workspace relays nothing, so there is nothing to bound. Omitted means no
  expiry.
- **Supersede rule:** an upgrade whose clientId already has a live socket
  closes the old one first — newer wins. The old socket is almost always a
  half-open zombie; without the rule an edge-buffered frame from it can arrive
  after the fresh socket's traffic (the stale-overwrite race awareness-style
  clocks exist to prevent — presence leans on this rule instead of clocks).
- **Close beats push.** A server-initiated close keeps delivering in-flight
  inbound frames until the peer acks, so every DO-initiated close marks the
  attachment `defunct` first and `webSocketMessage` drops frames from defunct
  sockets. Scoped to DO-initiated closes only — a frame racing a *client's*
  own close is legitimate traffic. `readyState` cannot make that distinction:
  workerd flips it to CLOSING when the peer's close frame arrives, before
  dispatching the data frames queued ahead of it.
- **`MutatorContext`** carries `{clientId, principal?, auth?, authoritative}`.
  `authoritative: false` in optimistic client runs is the honest signal:
  permission checks written `if (ctx.authoritative && !allowed) throw` enforce
  on the server and let the optimistic apply proceed; apps wanting fail-fast
  UX pass `authContext` to `SyncClient` and check without the guard.
- **Revocation is push-driven:** the `disconnect` admin op
  (`{principal?, clientId?, mode: 'kick' | 'refresh', …}`) walks
  `getWebSockets()` synchronously; `workspaceAdmin(namespace, id)` is the
  typed helper for same-worker callers.

## Presence

Ephemeral peer state on the existing socket; the payload is opaque app data,
validated server-side against the app's presence schema before relay (a typed
surface the server never checked would let one modified client feed junk into
every peer). Identity is server-attested from the attachment — payload is
client-claimed, `clientId`/`principal` are not.

- **In-memory map only, rebuilt by polling.** Presence never touches SQLite or
  the mutation log — and must NOT live in socket attachments:
  `serializeAttachment` is a storage write per update, which at cursor
  frequency would defeat hibernation entirely. Hibernation drops the map while
  sockets survive; the DO constructor (the wake signal) broadcasts
  `presencePoll` — guarded on the app declaring presence and ≥1 ready socket —
  and the map converges in one round-trip. A hello landing in that window gets
  a sparse snapshot that fills in as replies relay: presence is
  eventually-correct by construction.
- **The ghost window (recorded trade).** No TTL/heartbeat expiry: keepalives
  are auto-responded without waking the DO, so the server never observes
  liveness — a silently-dead peer lingers until TCP teardown (~75s to
  minutes). Same trade as y-partyserver (strips awareness's clock renewal) and
  tldraw's CF template (`clientTimeout: Infinity`), for the same hibernation
  reason. Apps must treat "X is editing" as advisory — render with a staleness
  bound from `receivedAt` (stamped by the library), never hard-lock on it.
- **Map entries remember their owning socket.** The supersede rule closes the
  old socket before the new one announces, but the old close *event* can be
  delivered after — teardown only removes an entry the closing socket still
  owns, so a lagged close cannot wipe the reconnected client's fresh state.
- Relay goes through the same per-socket delivery gate as pokes (`#deliver`:
  defunct skip + expiry close); relay carries the schema's parsed output;
  rejections use `PresenceInvalid` (client warns and self-heals, never
  reconnects); the null broadcast on close/clear keeps the attested principal.
- **Drift is advisory — no version bump.** Presence is never stored and lives
  one connection long; pricing a presence reshape like a table change would
  force-reload every client and discard every IndexedDB cache for data with no
  durability. It gets its own fingerprint (`presence_hash`): reshaping under an
  unchanged version warns softly once and restamps. Mid-deploy skew degrades
  gracefully (`PresenceInvalid` + self-heal).
- Client side: the library owns throttling (trailing-edge, 100ms default —
  Liveblocks' number) and re-announcement (on every ready transition and on
  `presencePoll`), so apps write neither throttle nor reconnect glue.
  `update(partial)` shallow-merges into the *parsed* last state (so the schema
  must round-trip its own output); peers reset to empty on disconnect — stale
  presence is worse than absent presence.

## Yjs fields

Per-field Y.Docs hosted inside the workspace DO, on the existing socket
([tier 2](#collaborative-text-tiers)). A fieldId is an opaque key; fields are
created implicitly on first use; which fields are Tier 2 is a UI decision
invisible to the sync schema. `handle.text` is a `Y.Text` at a fixed
library-owned key so every reader/writer of a field agrees on type and key
with nothing to coordinate; rich text drops to `handle.doc` and the app owns
the key.

- **Packaging: an add-on; core stays yjs-free.** `@cf-sync/yjs` with
  `/server`, `/client`, `/react` entries; `yjs` is a **peer** dependency (the
  app's editor bindings must share one yjs module instance — two copies in a
  bundle is a known silent-divergence footgun).
- **Wire: a binary lane beside the JSON protocol.** The frame type itself is
  the mux — no envelope, no base64. Layout and helpers live in
  `packages/protocol/src/field-frames.ts`. Four messages (GET / STATE / UPDATE
  / REJECT) fold y-protocols' symmetric sync into two round-trip messages:
  GET is the client's syncStep1, STATE is the server's syncStep2 *and*
  syncStep1 (appended state vector), the client's push-back UPDATE is its
  syncStep2. Sync is **bidirectional** on purpose: an UPDATE lost in flight or
  a corrupt row skipped on load would otherwise never be re-uploaded, and Yjs
  makes gaps silent and sticky (dependent ops park in the pending queue
  forever, truncating the field for every future reader). The one drop from
  y-websocket's flow is server-initiated syncStep1 on connect — authority
  lives in SQLite, wake loses nothing, the server never asks first.
- **STATE carries a `writable` bit**, so a reader (per `authorizeWrite`) or a
  frozen field renders read-only from the first paint — apply-then-reject is
  designed out, not handled.
- **The REJECT collapse rule.** After a REJECT (NotWritable / Frozen /
  TooLarge) the client stops sending *and stops pushing back* that field's
  updates; the server refuses that (socket, field)'s later UPDATEs without
  touching storage. Load-bearing for TooLarge: in-flight updates depend on the
  refused op's client clocks, and appending them would plant a permanent gap
  in the log — the exact poison the push-back leg exists to prevent, and
  unhealable, since re-upload includes the too-large op. The client-side flip
  is sticky for the handle's lifetime (only the client knows its doc holds an
  op the server will never accept); a fresh handle after reload starts clean.
- **No subscription tracking.** Every field UPDATE relays to every ready
  socket; clients ignore fields they don't hold. Per-socket subscription sets
  could survive hibernation in attachments, but attachment space is budgeted
  for auth, and broadcasting makes wake a non-event (~4 clients × ~5 updates/s
  × ~100B ≈ 2KB/s worst case). The revisit trigger is bulk programmatic
  writes — which go through admin import, bypassing the relay.
- **Limits are derived, not felt.** `MAX_FIELD_UPDATE_BYTES` (200KB) is the
  transport frame guard; `MAX_FIELD_BYTES` (700KB) is the field ceiling;
  ceiling + one guarded crossing update = the 900KB D9 budget, so the worst
  STATE a frozen field can serve still fits one frame (no STATE chunking
  machinery). The guard can't shrink with impunity either: the push-back leg
  merges a whole disconnect's edits into ONE update. The paved way to stay
  under it is the editor binding's own paste/length guard, which is why the
  constants are exported.
- **Accept-then-freeze.** Rejecting the ceiling-crossing update would leave
  the writer's doc permanently ahead of the server — silent, sticky
  divergence. Instead the crossing update commits (peers converge) and
  `frozen` is set in the same transaction; later UPDATEs get `Frozen`. The
  freeze is sticky (un-freezing on shrink would require materializing on the
  hot path) and persisted, so it survives hibernation with no in-memory state.
  `byte_total` is a deliberate over-estimate reconciled at compaction.
- **Server hot path: append-and-relay, persist-then-broadcast.** No client
  ever sees state the server hasn't durably stored — the same ordering rule as
  poke-after-commit, strictly stronger than the debounce-savers in this space
  (y-partyserver's 2s `onSave`, y-sweet's background flush can lose the last
  seconds of typing on a crash). Y.Docs materialize only for GET and
  compaction, snapshot-plus-tail behind a small LRU; one coherence rule: an
  inbound update also applies to (or evicts) a cached doc, or the next GET
  serves an incomplete diff. Corrupt update rows are skipped-and-logged; any
  connected client holding the lost ops re-uploads them via push-back; if none
  does, the field truncates at the gap — logged, visible in stats,
  unrecoverable by design (fail loudly, never guess).
- **The extension seam** (`EngineExtension` in `packages/server/src/config.ts`)
  is one config slot, not an array (a routing byte for a second extension that
  doesn't exist), carrying a **factory** invoked per DO instance — Cloudflare
  colocates instances of one class in a shared isolate, so a singleton's
  closure state would silently bridge workspaces. Extension `broadcast`/`send`
  route through core's `#deliver` gate, so the defunct/expiry checks guard the
  binary lane too, and `onBinaryMessage` is synchronous end-to-end
  (invariant 3).
- **Client: no local persistence of field docs.** Field co-editing is online;
  a reload re-fetches small docs in one round-trip. Handles are ref-counted
  (Liveblocks' `getYjsProviderForRoom` shape); every ready transition re-GETs
  held docs with the current state vector; `whenSynced` is one-shot ("can I
  render", not "am I live"). The escape hatch is composability: `handle.doc`
  is a standard Y.Doc — attach y-indexeddb yourself.
- **Admin/import.** Export gains a `fields` map, import restores it, reset
  clears, stats report counts and bytes; seeding goes through import. An
  import that carries fields **cycles every socket with 4300** instead of
  hot-swapping: the client re-GET fires on ready transitions, so a live-socket
  import would strand held docs; a refreshed reconnect re-bootstraps rows and
  re-GETs fields, keeping both planes consistent (restore is
  convergence-preserving). Row-only imports keep the live `clear`-poke path.
  Orphaned fields are scoped out by layer: the row→field link is an app
  pointer convention the engine never sees, so GC would be the engine
  guessing.

## Open questions (deliberately deferred)

- Per-table typed SQLite columns in the DO (enables server-side
  queries/indexes) vs. staying generic — revisit with real workloads.
- HTTP transport fallback for restrictive networks — the protocol is ready for
  it; add when a real user hits it.
- Hot-workspace sharding (read-replica DOs fanning out pokes) — the ~hundreds
  of pushes/sec per-DO ceiling is far above Linear-style human workloads;
  revisit only with evidence.
