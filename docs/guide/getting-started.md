# Getting started

This walks a fresh project from zero to two browser tabs converging through a Durable Object. Time budget: about ten minutes.

::: tip Not published to npm yet
The `@cf-sync/*` packages are not on the public registry yet. Until they are, the fastest way to try the engine is to clone the [repository](https://github.com/InfinityBowman/cf-sync-engine) and run the [demo app](https://github.com/InfinityBowman/cf-sync-engine/tree/main/apps/demo) (`pnpm dev:worker` + `pnpm dev:web`). The steps below are what a consuming project looks like.
:::

## Prerequisites

- A Cloudflare account and [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) (Durable Objects with SQLite are available on the free plan)
- Node 18+ and a bundler for the web side (examples use Vite)

## 1. Install

```sh
npm install @cf-sync/protocol @cf-sync/server @cf-sync/client @tanstack/db zod
```

`zod` and `@tanstack/db` are peer dependencies. React is optional — the core client is framework-agnostic.

## 2. Define the app (shared)

One file, imported by **both** the worker and the browser. This is the central idea: the server and every client are configured with the *same value*, so they can't disagree about the schema, the mutators, or the version.

```ts
// src/schema.ts
import { defineApp, defineSchema, defineMutators, AppError } from '@cf-sync/protocol'
import { z } from 'zod'

const schema = defineSchema({
  todos: z.object({
    id: z.string(),
    title: z.string(),
    done: z.boolean().default(false),
  }),
})

const mutators = defineMutators(schema, {
  'todo.toggle': {
    args: z.object({ id: z.string() }),
    apply: (tx, { id }) => {
      const todo = tx.get('todos', id)
      if (!todo) throw new AppError('NotFound', `todo ${id} does not exist`)
      tx.put('todos', id, { ...todo, done: !todo.done })
    },
  },
})

export const app = defineApp({ version: 1, schema, mutators })
```

## 3. The worker

```ts
// worker/worker.ts
import { createWorkspaceDO, createSyncFetch } from '@cf-sync/server'
import { app } from '../src/schema'

export const WorkspaceDO = createWorkspaceDO({ app })

export default {
  fetch: createSyncFetch({
    namespace: (env) => env.WORKSPACE,
    authorize: async (request, { workspaceId }) => {
      // Validate the session, check workspace membership.
      // Returning true admits everyone — fine for a first run, not for production.
      return true
    },
  }),
}
```

```jsonc
// wrangler.jsonc
{
  "name": "my-sync-worker",
  "main": "./worker/worker.ts",
  "compatibility_date": "2025-08-01",
  "durable_objects": {
    "bindings": [{ "name": "WORKSPACE", "class_name": "WorkspaceDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceDO"] }]
}
```

::: warning `new_sqlite_classes`, not `new_classes`
The workspace DO requires SQLite-backed storage. Declaring it with `new_classes` is the classic footgun — the deploy succeeds, and the DO fails at runtime on its first SQL access. If you've already deployed with `new_classes`, you need a [new class name](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/); the storage backend of an existing class can't be changed.
:::

## 4. The client

```ts
// src/main.ts
import { SyncClient, createCollections } from '@cf-sync/client'
import { app } from './schema'

const client = new SyncClient({
  url: 'ws://localhost:8787',   // wss://your-worker in production
  workspaceId: 'my-first-workspace',
  app,
  persist: true,                // IndexedDB mirror + durable offline outbox
})

const { todos } = createCollections(client)

// Optimistic local write, synced as a full-row mutation:
todos.insert({ id: crypto.randomUUID(), title: 'ship it' })

// Typed intent mutation — runs instantly locally, authoritatively on the server:
await client.mutate.todo.toggle({ id })
```

The client connects on construction (pass `autoStart: false` to decouple that — SSR, auth gating), appends `/sync/<workspaceId>?clientId=…` to your URL, and manages the clientId lifecycle for you. `createCollections` gives you one typed collection per schema table — row types, runtime validation, and keys all derive from the schema — and syncing starts immediately (the socket carries every table's pokes regardless; pass `{ startSync: false }` to defer to first subscriber). For per-table control, use `workspaceCollectionOptions`.

In React, read collections with `useLiveQuery` from `@tanstack/react-db` — install it alongside `@cf-sync/client` (it's declared as an optional peer, so your package manager will flag a version pair whose pinned `@tanstack/db` disagrees). Sync state comes from the shipped hooks:

```tsx
import { useSyncStatus } from '@cf-sync/client/react'

const status = useSyncStatus(client) // 'idle' | 'connecting' | … | 'synced'
```

## 5. Run it

```sh
npx wrangler dev        # the worker + Workspace DO on :8787
npm run dev             # your vite dev server, second terminal
```

Open the app in **two tabs**. Mutations apply instantly in the originating tab and propagate to the other through the server. Then try turning the network off in devtools, mutating, and reloading — the mirror hydrates instantly and the outbox replays on reconnect.

Each `workspaceId` is its own Durable Object with its own storage and sockets. Switching workspaces means constructing a new client — see [Offline & persistence](/guide/offline-persistence#closing-a-workspace).

## Where next

- [Defining your app](/guide/defining-your-app) — schemas, mutators, and the two rules that keep optimistic and authoritative runs in agreement
- [Mutations & optimistic writes](/guide/mutations) — what confirm, reject, and offline actually mean
- [Auth & sessions](/guide/auth) — a real `authorize` hook, typed auth context in mutators, kick and refresh
- [Testing your app](/guide/testing) — unit-test mutators and migrations in plain node, no workerd
