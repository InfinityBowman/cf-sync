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
pnpm test          # protocol + client (node) and server contract/convergence tests (workerd)
pnpm typecheck
```

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
import { defineApp, defineSchema, defineMutators, crudMutators, AppError } from '@cf-sync/protocol'
import { z } from 'zod'

const schema = defineSchema({
  issues: z.object({
    id: z.string(),
    title: z.string(),
    column: z.string().default('backlog'),
  }),
})

const mutators = defineMutators(schema, {
  ...crudMutators(schema), // full-row LWW: sync.put / sync.del (what collections emit)
  'issue.move': {
    args: z.object({ id: z.string(), column: z.string() }),
    apply: (tx, { id, column }) => {          // args are validated and typed
      const issue = tx.get('issues', id)      // typed: { id, title, column } | null
      if (!issue) throw new AppError('NotFound', `issue ${id} does not exist`)
      tx.put('issues', id, { ...issue, column })
    },
  },
})

export const app = defineApp({ version: 'app-1', schema, mutators })
```

The server validates every row write against the table's schema and every
mutation's args against its `args` schema before `apply` runs — a client can
never write a shape the schema doesn't allow, no matter what it sends.

### Evolving the schema

Bump `version` and append a migration step in the same object. Steps chain,
so a workspace that slept through several deploys replays every hop; the chain
is validated at startup (in both bundles), so bumping the version without a
step is a loud error, not silent skew.

```ts
export const app = defineApp({
  version: 'app-2',
  schema, // issues now also have `priority`
  mutators,
  migrations: [
    {
      from: 'app-1',
      to: 'app-2',
      migrate: (tx) => {
        for (const { id, data } of tx.list('issues')) {
          tx.put('issues', id, { priority: 'normal', ...data })
        }
      },
    },
    // additive change, no data rewrite: { from: 'app-2', to: 'app-3' }
  ],
})
```

On the first wake after a deploy, the workspace DO replays the chain from its
stored version atomically — the *net result* is validated against the current
schema, old clients are rejected at hello and reload into the new bundle, and
a stored version outside the chain (e.g. a rollback deploy) aborts
initialization instead of restamping data it can't interpret.

**Every schema change requires a version bump** — additive ones too (a
migrate-less step, or a `migrate` backfill when the new field has a default;
without one, rows written before the change never gain the field at runtime,
and old bundles sharing the version string can silently strip it via full-row
writes). This is enforced: each workspace stores a structural fingerprint of
the table schemas, and a deploy that changes them *without* bumping the
version makes the DO log a warning telling you which step to add, instead of
drifting silently.

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
  // customize.
  persist: true,
})

// One typed collection per schema table: row types, runtime validation, and
// keys all derive from the schema. (Per-table control: workspaceCollectionOptions.)
const { issues } = createCollections(client)
client.start()

issues.insert({ id: ulid(), title: 'ship it' })   // optimistic; `column` filled by its default
await client.mutate('issue.move', { id, column }) // typed: a typo'd name or bad args is a compile error
```

Sync status is observable via `client.subscribeStatus` (returns an
unsubscribe function, safe to pass unbound) — in React:

```ts
const status = useSyncExternalStore(client.subscribeStatus, () => client.status)
```

## Operations

`createAdminFetch({ namespace, authorize })` exposes a per-workspace admin surface
(authorize is mandatory — these endpoints read and destroy whole workspaces):

```
GET  /admin/<workspaceId>/stats    gauges + counters (rows, versions, connections, db size)
GET  /admin/<workspaceId>/export   JSON snapshot of live rows
POST /admin/<workspaceId>/import   replace state from a snapshot (live clients converge via reset poke)
POST /admin/<workspaceId>/reset    wipe the workspace; new history (backendId)
```

With `export: { bucket: (env: Env) => env.EXPORT_BUCKET }` on the DO config (the
annotation types the whole DO's env), a periodic
alarm streams the mutation log to R2 as ndjson (`cf-sync/<workspaceId>/mutation-log/
<from>-<to>.ndjson`) for archive and analytics.

## Status

M0 (protocol core), M1 (resilience), M2 (operability), and M3 phase 1 (client
persistence) are complete: push/pull/poke over hibernating WebSockets, the LMID
idempotency contract, chunked bootstrap, catch-up by cursor, TanStack DB adapter, a
seeded multi-client convergence simulation, tombstone compaction, migrations, R2
mutation-log export, the admin surface, and an IndexedDB-backed local mirror with a
durable offline outbox. See DESIGN.md §12 for the roadmap (remaining: schema rollout
drill, per-document Yjs DOs).
