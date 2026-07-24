# cf-sync-engine

A server-authoritative, Linear-style sync engine built on Cloudflare Durable Objects,
with TanStack DB as the client store. See **[DESIGN.md](./DESIGN.md)** for the
architecture, locked decisions, and invariants.

## Layout

| Package | What it is |
|---|---|
| `@cf-sync/protocol` | Wire types (hello / push / poke), frame chunking, and the shared definition kit: `defineApp`, `defineSchema`, `defineMutators`, `crudMutators`, `AppError` — importable from both worker and browser |
| `@cf-sync/server` | `createWorkspaceDO` — the per-workspace Durable Object — and `createSyncFetch`, the worker router with an `authorize` hook |
| `@cf-sync/client` | `SyncClient` (socket, outbox, poke application, reconnect) and `workspaceCollectionOptions`, a TanStack DB collection adapter |
| `apps/demo` | Two-tab todo demo (React + `@tanstack/react-db`) |

## Quick start

```sh
pnpm install
pnpm test            # protocol + client (node) and server contract/convergence tests (workerd)
pnpm typecheck
pnpm build           # bundle each package to dist/ (tsdown: ESM + .d.ts)
pnpm check:packages  # build, pack as publishing would, gate with publint + arethetypeswrong
```

Packages are ESM-only. In the monorepo, `exports` point at TypeScript source
(vite/wrangler/vitest consume it directly); `publishConfig` swaps them to
`dist/` at pack time, and CI verifies the packed artifacts.

Run the demo (two terminals):

```sh
cd apps/demo
pnpm dev:worker    # wrangler dev on :8787 (the sync worker + Workspace DO)
pnpm dev:web       # vite dev server for the UI
```

Open the vite URL in **two tabs** — mutations apply optimistically and converge
through the server. Use a URL hash (`#team-a`) to switch workspaces (each workspace is
its own Durable Object).

## Defining the app (shared)

One definition file, imported by both the worker and the web app, drives
everything: server-side row and args validation, collection row types, typed
`mutate` calls, and the schema-version rollout. `defineApp` bundles the
version, schema, mutators, and migration history into one object — the server
and every client are configured with the *same value*, so they can't disagree.

```ts
// src/schema.ts — shared between worker and browser
import { defineApp, defineSchema, defineMutators, AppError } from '@cf-sync/protocol'
import { z } from 'zod'

const schema = defineSchema({
  issues: z.object({
    id: z.string(),
    title: z.string(),
    column: z.string().default('backlog'),
  }),
})

// Intent-based mutations. The full-row LWW CRUD pair (sync.put / sync.del —
// what collections emit for local writes) is included by defineApp
// automatically; pass `crud: false` there for an intent-only app.
const mutators = defineMutators(schema, {
  'issue.move': {
    args: z.object({ id: z.string(), column: z.string() }),
    apply: (tx, { id, column }) => {          // args are validated and typed
      const issue = tx.get('issues', id)      // typed: { id, title, column } | null
      if (!issue) throw new AppError('NotFound', `issue ${id} does not exist`)
      tx.put('issues', id, { ...issue, column })
    },
  },
})

export const app = defineApp({ version: 1, schema, mutators })
```

The server validates every row write against the table's schema and every
mutation's args against its `args` schema before `apply` runs — a client can
never write a shape the schema doesn't allow, no matter what it sends.

The same `apply` also runs **on the client** when you call `mutate`, producing
the optimistic effect (see "Consuming it from the client"). Two authoring
rules follow: reserve `throw` for genuine invariant violations — a local throw
rejects the call immediately and sends nothing, and local state can be
*behind* the server, so "row not synced yet" must not be an error — and pass
nondeterministic values (ids, timestamps) in as args rather than computing
them inside `apply`, so the local prediction matches what the server echoes.

### Evolving the schema

Bump `version` (integers, starting at 1) and add a `migrations` entry keyed by
the version it migrates *to* in the same object. A workspace that slept
through several deploys replays every hop in order; the entries are validated
at startup (in both bundles) — consecutive, ending at `version` — so bumping
the version without saying what happens to existing data is a loud error, not
silent skew.

```ts
export const app = defineApp({
  version: 2,
  schema, // issues now also have `priority`
  mutators,
  migrations: {
    2: (tx) => {
      for (const { id, data } of tx.list('issues')) {
        tx.put('issues', id, { priority: 'normal', ...data })
      }
    },
    // additive change, no data rewrite: 3: null
  },
})
```

On the first wake after a deploy, the workspace DO replays the chain from its
stored version atomically — the *net result* is validated against the current
schema, old clients are rejected at hello and reload into the new bundle, and
a stored version outside the chain (e.g. a rollback deploy) aborts
initialization instead of restamping data it can't interpret.

**Every schema change requires a version bump** — additive ones too (a `null`
entry, or a `migrate` backfill when the new field has a default; without one,
rows written before the change never gain the field at runtime, and old
bundles sharing the version can silently strip it via full-row writes). This
is enforced: each workspace stores a structural fingerprint of the table
schemas, and a deploy that changes them *without* bumping the version makes
the DO log a warning telling you which entry to add, instead of drifting
silently.

## Defining a workspace server

```ts
import { createWorkspaceDO, createSyncFetch } from '@cf-sync/server'
import { app } from '../src/schema'

export const WorkspaceDO = createWorkspaceDO({ app })

export default {
  fetch: createSyncFetch({
    namespace: (env) => env.WORKSPACE,
    authorize: async (request, { workspaceId }) => {
      // validate the session, check workspace membership
      return true
    },
  }),
}
```

And the matching `wrangler.jsonc` (this is the demo's working config):

```jsonc
{
  "name": "my-sync-worker",
  "main": "./worker/worker.ts",
  "compatibility_date": "2025-08-01",
  "durable_objects": {
    "bindings": [{ "name": "WORKSPACE", "class_name": "WorkspaceDO" }]
  },
  // new_sqlite_classes, NOT new_classes: the workspace DO requires
  // SQLite-backed storage. Using new_classes here is the classic footgun —
  // the DO deploys fine and then fails at runtime on its first SQL access.
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceDO"] }]
}
```

## Consuming it from the client

```ts
import { SyncClient, createCollections } from '@cf-sync/client'
import { app } from './schema'

const client = new SyncClient({
  url: 'wss://your-worker', // the client appends /sync/<workspaceId>?clientId=…
  workspaceId,
  app,
  // Optional: durable local mirror in IndexedDB. Reloads hydrate instantly
  // from cache and resume by cursor; mutations made offline survive reloads
  // and replay exactly once (the LMID contract makes replay idempotent).
  // The clientId lifecycle (one per tab/session) is managed for you; pass
  // `clientId`/`store` explicitly to take either over. Fatal errors
  // (VersionNotSupported after a deploy) reload the page, throttled to once
  // per minute so a bad deploy window can't reload-loop; pass `onFatal` to
  // customize. Connecting starts here too — pass `autoStart: false` to
  // decouple construction from connection (SSR, auth gating) and call
  // client.start() yourself.
  persist: true,
})

// One typed collection per schema table: row types, runtime validation, and
// keys all derive from the schema. (Per-table control: workspaceCollectionOptions.)
const { issues } = createCollections(client)

issues.insert({ id: ulid(), title: 'ship it' })  // optimistic; `column` filled by its default
await client.mutate.issue.move({ id, column })   // typed: names autocomplete, bad args are a compile error
// (equivalent string form: client.mutate('issue.move', { id, column }))
```

`mutate` is optimistic out of the box: the shared mutator's `apply` runs
locally against your collections first, and its writes land as one atomic
overlay — visible instantly, swapped for the server's authoritative patch on
confirm, rolled back together if the server rejects. Multi-row intents like
`clearCompleted` are therefore one line and one wire mutation; there is no
separate "optimistic effect" to hand-write, and no per-row crud echo.

One semantic to know: **a rejection always means the mutation will not
apply.** With `persist` on there is no confirm timeout — while offline the
promise simply stays pending (the mutation is durably queued and applies when
connectivity returns), and it rejects only on permanent server error,
`client.stop()`, or a fatal. Memory-only clients do reject with `Timeout`
after `confirmTimeoutMs` (default 30s), discarding the mutation — honest,
since without a store it would not survive a reload anyway.

Sync status is observable via `client.subscribeStatus` (returns an
unsubscribe function, safe to pass unbound) — in React, use the shipped hook:

```ts
import { useSyncStatus } from '@cf-sync/client/react'

const status = useSyncStatus(client) // 'idle' | 'connecting' | … | 'synced'
```

## Presence (ephemeral peer state)

Who's online, live cursors, "X is editing this field" — relayed over the same
socket, never persisted. Declare a payload schema in `defineApp` and the whole
surface lights up, typed end to end:

```ts
// shared — the payload shape is yours; the server validates every inbound
// state against it before relaying, so peers can't feed junk into your UI
export const app = defineApp({
  version: 1,
  schema,
  mutators,
  presence: z.object({
    name: z.string(),
    cursor: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
})

// client — provide identity once at construction (validated there, like
// `auth`); afterwards every call site can be a bare merge, immune to mount order
const client = new SyncClient({ ..., initialPresence: { name: 'ada' } })

client.presence.update({ cursor: { x, y } })  // shallow merge — no re-stating `name`
client.presence.update({ cursor: undefined }) // clear one field, keep the rest
client.presence.set({ name: 'ada lovelace' }) // full replace, when you mean it
client.presence.self                          // your own parsed state (never in peers)
client.presence.clear()                       // peers see you go quiet
```

```tsx
import { usePresence } from '@cf-sync/client/react'

const peers = usePresence(client) // typed by the app's presence schema, self excluded
peers.map((p) => <Cursor key={p.clientId} name={p.state.name} at={p.state.cursor} />)
```

What the library owns so apps don't:

- **Pacing** — call `set`/`update` straight from a `mousemove` handler; the
  client throttles trailing-edge (one frame per `presenceThrottleMs`, default
  100ms, latest state wins). No throttle glue.
- **Lifecycle** — the last-set state re-announces on every reconnect and after
  DO hibernation wakes; peers reset to empty on disconnect (stale presence is
  worse than absent presence).
- **Identity** — `clientId`/`principal` on every peer update are stamped by
  the server from the connection's auth verdict, never read from the payload,
  so a modified client cannot impersonate another user's presence. Peers are
  per *connection* (one `clientId` per tab), so the same user in two tabs is
  two peers — key avatar stacks by `principal` (falling back to `clientId`
  when unauthenticated) and you get "one avatar per user" for free, attested
  by the server rather than claimed by the payload.

Two semantics to know. Presence is *ephemeral*: nothing is ever stored, so
changing the presence schema needs **no version bump** — a reshape logs a
soft server-side warning and that is all; prefer additive changes (optional
fields), since old and new bundles share a workspace during a deploy window
and invalid state is dropped gracefully on both sides. And liveness is
*TCP-bound*: a peer that dies silently (laptop lid, network partition)
lingers until socket teardown surfaces, anywhere from ~75s to a couple of
minutes — treat presence as advisory and never hard-lock UI on it. Every peer
entry carries `receivedAt` (local receipt time) so that staleness bound is one
comparison: `Date.now() - p.receivedAt > 30_000 && fade(p)`.

## Testing your app

`@cf-sync/server/testing` exports an in-memory workspace engine that runs the
same write-buffer, validation, and error semantics as the Durable Object
(shared code, not a reimplementation) — so mutators and migrations unit-test
in plain vitest/jest, no workerd, in milliseconds. Import the definition kit
from `@cf-sync/protocol` in test files (the server's main entry imports
`cloudflare:workers`, which node can't load).

```ts
import { createTestEngine } from '@cf-sync/server/testing'
import { app } from '../src/schema'

it('clearCompleted deletes only completed todos', () => {
  const engine = createTestEngine(app)
  engine.seed('issues', 'i1', { id: 'i1', title: 'keep' })
  const result = engine.mutate('issue.move', { id: 'i1', column: 'done' })
  expect(result.error).toBeUndefined()
  expect(engine.get('issues', 'i1')?.column).toBe('done')
})

it('the 1 -> 2 migration backfills priority', () => {
  const engine = createTestEngine(app, {
    storedVersion: 1, // rows below are stored raw in their old shape,
    rows: { issues: { i1: { id: 'i1', title: 'old', column: 'doing' } } },
  }) // ...and the migration chain replays here, like the DO's first wake
  expect(engine.get('issues', 'i1')?.priority).toBe('normal')
})
```

The engine honors the engine invariants — an `AppError` from a mutator (or
invalid args) reports as `result.error` and still advances
`engine.lastMutationId()` with no data written; any other throw is transient
and rethrown with nothing committed; a migration chain that produces
schema-invalid rows throws from `createTestEngine` itself.

## Operations

`createAdminFetch({ namespace, authorize })` exposes a per-workspace admin surface
(authorize is mandatory — these endpoints read and destroy whole workspaces).
For the common bearer-token setup, `bearerTokenAuth` compares in constant time
and fails closed when the secret is unset:

```ts
const adminHandler = createAdminFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  authorize: bearerTokenAuth((env) => env.ADMIN_TOKEN), // wrangler secret put ADMIN_TOKEN
})
```

```
GET  /admin/<workspaceId>/stats    gauges + counters (rows, versions, connections, db size)
GET  /admin/<workspaceId>/export   JSON snapshot of live rows
POST /admin/<workspaceId>/import   replace state from a snapshot (live clients converge via reset poke)
POST /admin/<workspaceId>/reset    wipe the workspace; new history (backendId)
POST /admin/<workspaceId>/disconnect  kick or refresh live sessions ({principal?, clientId?, mode})
```

`reset` also heals a workspace whose stored state can no longer be loaded
(e.g. one written by a much older deploy): such a workspace is quarantined —
sync upgrades answer 503, admin ops report the failure — but `reset` stays
reachable by design. For same-worker callers, `workspaceAdmin(namespace, id)`
wraps all of these as typed methods.

With `export: { bucket: (env: Env) => env.EXPORT_BUCKET }` on the DO config (the
annotation types the whole DO's env), a periodic
alarm streams the mutation log to R2 as ndjson (`cf-sync/<workspaceId>/mutation-log/
<from>-<to>.ndjson`) for archive and analytics.

## Status

M0 (protocol core), M1 (resilience), M2 (operability), M3 phases 1–2 (client
persistence, optimistic intent mutators), session control (§15), and presence
(§16) are complete: push/pull/poke over hibernating WebSockets, the LMID
idempotency contract, chunked bootstrap, catch-up by cursor, TanStack DB
adapter, a seeded multi-client convergence simulation, tombstone compaction,
schema-version rollout with migration chains, R2 mutation-log export, the
admin surface (including kick/refresh session revocation), an IndexedDB-backed
local mirror with a durable offline outbox, optimistic execution of intent
mutations via the shared mutator registry, auth verdict stamps carried on the
connection with expiry gating, and typed ephemeral presence with live-cursor
throttling. See DESIGN.md §12 for the roadmap (remaining: startup replay of
queued intents, collaborative text per §14's tiered strategy).
