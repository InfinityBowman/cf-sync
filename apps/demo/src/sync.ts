import { IndexedDBSyncStore, SyncClient, workspaceCollectionOptions } from '@cf-sync/client'
import { createCollection } from '@tanstack/react-db'
import { ulid } from 'ulidx'
import { SCHEMA_VERSION, mutators, schema } from './schema'

// Dev runs vite (:5173) and wrangler (:8787) separately; the deployed build
// is served by the worker itself, so the sync socket is same-origin.
const WORKER_URL =
  import.meta.env.VITE_SYNC_URL ??
  (import.meta.env.DEV ? 'ws://localhost:8787' : location.origin.replace(/^http/, 'ws'))
const workspaceId = location.hash.slice(1) || 'demo'

// One clientId per tab/session: the clientId names a contiguous mutation
// sequence, so concurrent tabs must never share one. sessionStorage gives
// reload continuity without cross-tab sharing.
const stored = sessionStorage.getItem('cf-sync-client-id')
const clientId = stored ?? ulid()
if (!stored) sessionStorage.setItem('cf-sync-client-id', clientId)

export const syncClient = new SyncClient({
  url: `${WORKER_URL}/sync/${encodeURIComponent(workspaceId)}?clientId=${clientId}`,
  clientId,
  schemaVersion: SCHEMA_VERSION,
  // The shared schema + mutators: typed mutate calls with local fail-fast
  // validation, and collections that infer their row types.
  schema,
  mutators,
  // Durable local mirror: reloads hydrate instantly from IndexedDB and
  // resume by cursor; mutations made offline replay on reconnect.
  store: new IndexedDBSyncStore({ workspaceId, clientId }),
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
