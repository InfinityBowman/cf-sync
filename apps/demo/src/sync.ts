import { SyncClient, workspaceCollectionOptions } from '@cf-sync/client'
import { createCollection } from '@tanstack/react-db'
import { ulid } from 'ulidx'
import { SCHEMA_VERSION, type Todo } from './schema'

const WORKER_URL = import.meta.env.VITE_SYNC_URL ?? 'ws://localhost:8787'
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
  onStatusChange: (status) => {
    document.dispatchEvent(new CustomEvent('sync-status', { detail: status }))
  },
  onFatal: () => location.reload(),
})

export const todos = createCollection(
  workspaceCollectionOptions<Todo>({
    client: syncClient,
    table: 'todos',
    getKey: (todo) => todo.id,
    startSync: true,
  }),
)

syncClient.start()

export { workspaceId }
