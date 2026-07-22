# cf-sync-engine

A server-authoritative, Linear-style sync engine built on Cloudflare Durable Objects,
with TanStack DB as the client store. See **[DESIGN.md](./DESIGN.md)** for the
architecture, locked decisions, and invariants.

## Layout

| Package | What it is |
|---|---|
| `@cf-sync/protocol` | Wire types (hello / push / poke), zod schemas, frame chunking |
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

## Defining a workspace server

```ts
import { createWorkspaceDO, createSyncFetch, crudMutators, AppError } from '@cf-sync/server'

export const WorkspaceDO = createWorkspaceDO({
  schemaVersion: 'app-1',
  mutators: {
    ...crudMutators, // full-row LWW: sync.put / sync.del
    'issue.move': (tx, args, ctx) => {
      const { id, column } = args as { id: string; column: string }
      const issue = tx.get('issues', id)
      if (!issue) throw new AppError('NotFound', `issue ${id} does not exist`)
      tx.put('issues', id, { ...issue, column })
    },
  },
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
import { SyncClient, workspaceCollectionOptions } from '@cf-sync/client'
import { createCollection } from '@tanstack/react-db'

const client = new SyncClient({
  url: `wss://your-worker/sync/${workspaceId}?clientId=${clientId}`,
  clientId, // unique per tab/session — never share across tabs
  schemaVersion: 'app-1',
})

const issues = createCollection(
  workspaceCollectionOptions({ client, table: 'issues', getKey: (i) => i.id }),
)
client.start()

issues.insert({ id: ulid(), title: 'ship it' })   // optimistic, confirmed by the server
await client.mutate('issue.move', { id, column }) // intent-based mutation
```

## Status

M0 (protocol core) is complete: push/pull/poke over hibernating WebSockets, the LMID
idempotency contract, chunked bootstrap, catch-up by cursor, TanStack DB adapter, and
a seeded multi-client convergence simulation. See DESIGN.md §12 for the roadmap
(compaction, R2 export, client persistence).
