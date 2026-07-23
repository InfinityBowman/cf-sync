import { SyncClient, workspaceCollectionOptions } from '@cf-sync/client'
import { createCollection } from '@tanstack/react-db'
import { app } from './schema'

// Dev runs vite (:5173) and wrangler (:8787) separately; the deployed build
// is served by the worker itself, so the sync socket is same-origin.
const WORKER_URL =
  import.meta.env.VITE_SYNC_URL ??
  (import.meta.env.DEV ? 'ws://localhost:8787' : location.origin.replace(/^http/, 'ws'))
const workspaceId = location.hash.slice(1) || 'demo'

export const syncClient = new SyncClient({
  url: WORKER_URL,
  workspaceId,
  // The shared app definition: schema version, typed mutate calls with local
  // fail-fast validation, and collections that infer their row types.
  app,
  // Durable local mirror in IndexedDB: reloads hydrate instantly and resume
  // by cursor; mutations made offline replay on reconnect. The clientId
  // lifecycle (one per tab/session) is managed by the client.
  persist: true,
  onStatusChange: (status) => {
    document.dispatchEvent(new CustomEvent('sync-status', { detail: status }))
  },
  onFatal: () => location.reload(),
})

export const todos = createCollection(
  // Row type and key come from the schema; no generics, no getKey.
  workspaceCollectionOptions({
    client: syncClient,
    table: 'todos',
    startSync: true,
  }),
)

syncClient.start()

export { workspaceId }
