# cf-sync-engine

A server-authoritative, Linear-style sync engine built on Cloudflare Durable Objects,
with TanStack DB as the client store. See **[DESIGN.md](./DESIGN.md)** for the
architecture, locked decisions, and invariants.

## Layout

| Package | What it is |
|---|---|
| `@cf-sync/protocol` | Wire types (hello / push / poke), frame chunking, and the shared definition kit: `defineSchema`, `defineMutators`, `crudMutators`, `AppError` — importable from both worker and browser |
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

## Defining the schema and mutations (shared)

One definition file, imported by both the worker and the web app, drives
everything: server-side row and args validation, collection row types, and
typed `mutate` calls.

```ts
// src/schema.ts — shared between worker and browser
import { defineSchema, defineMutators, crudMutators, AppError } from '@cf-sync/protocol'
import { z } from 'zod'

export const schema = defineSchema({
  issues: z.object({
    id: z.string(),
    title: z.string(),
    column: z.string().default('backlog'),
  }),
})

export const mutators = defineMutators(schema, {
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
```

The server validates every row write against the table's schema and every
mutation's args against its `args` schema before `apply` runs — a client can
never write a shape the schema doesn't allow, no matter what it sends.

## Defining a workspace server

```ts
import { createWorkspaceDO, createSyncFetch } from '@cf-sync/server'
import { schema, mutators } from '../src/schema'

export const WorkspaceDO = createWorkspaceDO({
  schemaVersion: 'app-1',
  schema,
  mutators,
})

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
import { IndexedDBSyncStore, SyncClient, workspaceCollectionOptions } from '@cf-sync/client'
import { createCollection } from '@tanstack/react-db'
import { schema, mutators } from './schema'

const client = new SyncClient({
  url: `wss://your-worker/sync/${workspaceId}?clientId=${clientId}`,
  clientId, // unique per tab/session — never share across tabs
  schemaVersion: 'app-1',
  schema,
  mutators,
  // Optional: durable local mirror. Reloads hydrate instantly from cache and
  // resume by cursor; mutations made offline survive reloads and replay
  // exactly once (the LMID contract makes replay idempotent).
  store: new IndexedDBSyncStore({ workspaceId, clientId }),
})

// Row type, runtime validation, and the key function derive from the schema.
const issues = createCollection(workspaceCollectionOptions({ client, table: 'issues' }))
client.start()

issues.insert({ id: ulid(), title: 'ship it' })   // optimistic; `column` filled by its default
await client.mutate('issue.move', { id, column }) // typed: a typo'd name or bad args is a compile error
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

With `export: { bucket: (env) => env.EXPORT_BUCKET }` on the DO config, a periodic
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
