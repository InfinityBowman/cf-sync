import { SyncClient, createCollections } from '@cf-sync/client'
import { createYjsFields } from '@cf-sync/yjs/client'
import { app } from './schema'

// Dev runs vite (:5173) and wrangler (:8787) separately; the deployed build
// is served by the worker itself, so the sync socket is same-origin.
const WORKER_URL =
  import.meta.env.VITE_SYNC_URL ??
  (import.meta.env.DEV ? 'ws://localhost:8787' : location.origin.replace(/^http/, 'ws'))
const workspaceId = location.hash.slice(1) || 'demo'

// One display name per tab (same lifetime as the clientId): reloads keep it,
// a second tab gets its own.
export const displayName = (() => {
  const KEY = 'cf-sync-demo:name'
  try {
    const existing = sessionStorage.getItem(KEY)
    if (existing) return existing
  } catch {
    // sessionStorage unavailable: a fresh name per load is fine for a demo
  }
  const adjectives = ['amber', 'brisk', 'coral', 'dusky', 'fuzzy', 'ivory', 'lucid', 'mellow', 'nimble', 'vivid']
  const animals = ['fox', 'heron', 'lynx', 'mole', 'newt', 'otter', 'raven', 'seal', 'tern', 'wren']
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)]!
  const name = `${pick(adjectives)} ${pick(animals)}`
  try {
    sessionStorage.setItem(KEY, name)
  } catch {
    // see above
  }
  return name
})()

/**
 * The demo's rejection surface: `onMutationRejected` below feeds the latest
 * rejection into this tiny external store, and App.tsx renders it as a
 * dismissible banner — so rejections with no awaiting caller (collection
 * writes, outbox replays after a reload) are visible, not just console noise.
 */
export interface RejectionNotice {
  name: string
  code: string
  message: string
}
let lastRejection: RejectionNotice | null = null
const rejectionListeners = new Set<() => void>()
export const rejections = {
  subscribe(listener: () => void): () => void {
    rejectionListeners.add(listener)
    return () => rejectionListeners.delete(listener)
  },
  get: (): RejectionNotice | null => lastRejection,
  dismiss(): void {
    lastRejection = null
    for (const listener of rejectionListeners) listener()
  },
}

export const syncClient = new SyncClient({
  url: WORKER_URL,
  workspaceId,
  // The shared app definition: schema version, typed mutate calls with local
  // fail-fast validation, and collections that infer their row types.
  app,
  // Durable local mirror in IndexedDB: reloads hydrate instantly and resume
  // by cursor; mutations made offline replay on reconnect. The clientId
  // lifecycle (one per tab/session) is managed by the client, and so is
  // fatal recovery (throttled reload into the current bundle). Connecting
  // starts here too — pass autoStart: false to defer it (e.g. SSR).
  persist: true,
  // Identity once, at construction: every later presence call is a bare
  // update({...}) with no mount-order concerns about who announces first.
  initialPresence: { name: displayName },
  // One place to surface rejections — including ones with no awaiting caller
  // (collection writes, offline mutations replayed after a reload). With this
  // set, fire-and-forget mutate calls need no per-call .catch().
  onMutationRejected: (error, { name }) => {
    lastRejection = { name, code: error.code, message: error.message }
    for (const listener of rejectionListeners) listener()
  },
})

// One typed collection per schema table (syncing starts immediately);
// components read status via useSyncStatus(syncClient) from '@cf-sync/client/react'.
export const { todos } = createCollections(syncClient)

// Tier 2 fields: real-merge text (two people typing in one prose box) on the
// same socket, attached through the client's binary seam. Handles are
// ref-counted (`getDoc`/`release`) and re-sync themselves on every
// reconnect — components write no reconnect glue.
export const yfields = createYjsFields(syncClient)

export { workspaceId }
