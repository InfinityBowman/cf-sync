# @cf-sync/client

The browser half of [cf-sync](https://github.com/InfinityBowman/cf-sync-engine) — a server-authoritative sync engine on Cloudflare Durable Objects, with TanStack DB as the client store.

`SyncClient` owns the socket, the offline outbox, optimistic mutation replay, and presence; `createCollections` derives one typed TanStack DB collection per schema table.

```sh
npm install @cf-sync/client @cf-sync/protocol @tanstack/db zod
```

```ts
import { SyncClient, createCollections } from '@cf-sync/client'
import { app } from './schema' // your defineApp definition — same value the server uses

const client = new SyncClient({
  url: 'wss://your-worker',
  workspaceId,
  app,
  persist: true, // IndexedDB mirror: instant reload hydration, durable offline outbox
})

const { issues } = createCollections(client)

issues.insert({ id: ulid(), title: 'ship it' })  // optimistic, converges via the server
await client.mutate.issue.move({ id, column })   // typed intent mutation, one wire op
```

Mutations are optimistic out of the box: the shared mutator runs locally as one atomic overlay, then is swapped for the server's authoritative patch on confirm — or rolled back together on rejection. A rejection always means the mutation will not apply.

React hooks ship at `@cf-sync/client/react`: `useSyncStatus` and `usePresence`. Read collections with `useLiveQuery` from `@tanstack/react-db` (both React and `@tanstack/react-db` are optional peers).

**Docs:** [Getting started](https://github.com/InfinityBowman/cf-sync-engine/blob/main/docs/guide/getting-started.md) · [Mutations](https://github.com/InfinityBowman/cf-sync-engine/blob/main/docs/guide/mutations.md) · [Offline & persistence](https://github.com/InfinityBowman/cf-sync-engine/blob/main/docs/guide/offline-persistence.md) · [Presence](https://github.com/InfinityBowman/cf-sync-engine/blob/main/docs/guide/presence.md) · [Repository](https://github.com/InfinityBowman/cf-sync-engine)

MIT
