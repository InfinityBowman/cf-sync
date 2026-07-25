import { createWorkspace, type WebSocketLike } from '@cf-sync/client'
import { createYjsFields } from '@cf-sync/yjs/client'
import { app } from './schema'

// Dev runs vite (:5173) and wrangler (:8787) separately; the deployed build
// is served by the worker itself, so the sync socket is same-origin.
const WORKER_URL =
  import.meta.env.VITE_SYNC_URL ??
  (import.meta.env.DEV ? 'ws://localhost:8787' : location.origin.replace(/^http/, 'ws'))

// One display name per tab, kept across workspace switches and reloads: it is
// the person, not the connection.
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

/**
 * The demo's offline switch — "no network" is the state a sync engine exists
 * for (mutations queue, presence drops, Yjs edits pile up locally and merge on
 * resume), and the one state a visitor can't reach without devtools.
 *
 * It rides the client's `createSocket` seam, the same injection point the tests
 * use: while offline every connect attempt gets a socket that never opens, so
 * the client parks in `reconnecting` exactly as it would with the wifi off.
 * Nothing in the engine is special-cased or aware of this — note that `stop()`
 * is *not* the mechanism, since it is terminal and settles the outbox.
 */
class OfflineSocket implements WebSocketLike {
  readonly #closeListeners = new Set<(event: { code?: number; reason?: string }) => void>()
  /** Never opens, so the client never pushes; the outbox holds the work. */
  send(): void {}
  close(): void {}
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    if (type === 'close') this.#closeListeners.add(listener)
  }
  /** Report the drop so the reconnect path runs now instead of after a backoff. */
  drop(): void {
    for (const listener of this.#closeListeners) listener({ code: 1006, reason: 'demo: back online' })
  }
}

let offline = false
let liveSocket: WebSocket | null = null
let parkedSocket: OfflineSocket | null = null
const networkListeners = new Set<() => void>()

function createSocket(url: string): WebSocketLike {
  if (offline) {
    parkedSocket = new OfflineSocket()
    return parkedSocket
  }
  const ws = new WebSocket(url)
  // Binary-lane frames (the Yjs field) must arrive as ArrayBuffer, not Blob.
  // The built-in factory sets this; a custom one has to as well.
  ws.binaryType = 'arraybuffer'
  liveSocket = ws
  return ws as unknown as WebSocketLike
}

export const network = {
  subscribe(listener: () => void): () => void {
    networkListeners.add(listener)
    return () => networkListeners.delete(listener)
  },
  isOffline: (): boolean => offline,
  toggle(): void {
    offline = !offline
    if (offline) {
      // An ordinary close: the client runs its normal disconnect path (1000 is
      // outside the permanent band, so it retries rather than going fatal), and
      // every retry from here lands on a socket that never opens. Mutations
      // queue in the durable outbox and their promises stay pending — a
      // persisted client has no confirm timeout, so nothing is discarded.
      liveSocket?.close(1000, 'demo offline')
      liveSocket = null
    } else {
      // Toggling back before the backoff timer fired leaves nothing parked —
      // the pending retry simply finds `offline` false and opens a real socket.
      parkedSocket?.drop()
      parkedSocket = null
    }
    for (const listener of networkListeners) listener()
  },
}

/**
 * One workspace's live objects. Every one of them belongs to a single
 * `workspaceId` — that is the whole point of the switcher below: none of this
 * is global state, and switching rebuilds all of it.
 */
function createSession(workspaceId: string) {
  // One call bootstraps the client and a typed collection per schema table
  // (syncing starts immediately); `workspace.destroy` is the matching one-call
  // teardown — the unit a workspace-switching app rebuilds per project.
  const workspace = createWorkspace({
    url: WORKER_URL,
    workspaceId,
    // The demo's offline switch (above) lives here — in normal apps this is
    // omitted and the client builds its own browser WebSocket.
    createSocket,
    // The shared app definition: schema version, typed mutate calls with local
    // fail-fast validation, and collections that infer their row types.
    app,
    // Durable local mirror in IndexedDB: reloads hydrate instantly and resume
    // by cursor; mutations made offline replay on reconnect. The clientId
    // lifecycle (one per tab/session, per workspace) is managed by the client,
    // and so is fatal recovery (throttled reload into the current bundle).
    // Connecting starts here too — pass autoStart: false to defer it (e.g. SSR).
    persist: true,
    // Identity once, at construction: every later presence call is a bare
    // update({...}) with no mount-order concerns about who announces first.
    initialPresence: { name: displayName },
  })

  // One place to surface rejections — including ones with no awaiting caller
  // (collection writes, offline mutations replayed after a reload). The
  // subscription form attaches after construction (a toast layer would too);
  // with a listener attached, fire-and-forget mutate calls need no per-call
  // .catch(). The `onMutationRejected` constructor option works identically.
  workspace.client.onMutationRejected((error, { name }) => {
    lastRejection = { name, code: error.code, message: error.message }
    for (const listener of rejectionListeners) listener()
  })

  return {
    workspaceId,
    client: workspace.client,
    // Components read status via useSyncStatus(session.client).
    todos: workspace.collections.todos,
    // Tier 2 fields: real-merge text (two people typing in one prose box) on
    // the same socket, attached through the client's binary seam. Handles are
    // ref-counted (`getDoc`/`release`) and re-sync themselves on every
    // reconnect — components write no reconnect glue. The add-on registers its
    // own teardown via `client.onDestroy`, so `workspace.destroy()` below
    // collects it too; there is nothing extra to unwind per switch.
    yfields: createYjsFields(workspace.client),
    destroy: workspace.destroy,
  }
}

export type Session = ReturnType<typeof createSession>

/** Offered by the switcher; any other id still works by typing a URL hash. */
export const WORKSPACES = ['demo', 'team-a', 'team-b']

const workspaceFromHash = (): string => location.hash.slice(1) || 'demo'

let session = createSession(workspaceFromHash())
const sessionListeners = new Set<() => void>()

export const sessions = {
  subscribe(listener: () => void): () => void {
    sessionListeners.add(listener)
    return () => sessionListeners.delete(listener)
  },
  get: (): Session => session,
  /**
   * Switch workspaces without a reload — the lifecycle `createWorkspace` was
   * shaped for. The new workspace is built *before* the old one is torn down:
   * the ids differ, so the two never share a clientId, a socket, or an
   * IndexedDB store, and the UI never renders an in-between empty state.
   *
   * Re-entrant by construction — a second click mid-switch just chains another
   * create/destroy pair, since `session` is already the newer one by then.
   */
  async switchTo(id: string): Promise<void> {
    if (id === session.workspaceId) return
    const previous = session
    session = createSession(id)
    // Keep the URL shareable. Assigning the hash fires `hashchange`, which
    // lands back here as a no-op now that `session` already moved.
    if (workspaceFromHash() !== id) location.hash = id
    for (const listener of sessionListeners) listener()
    // App.tsx keys its subtree on workspaceId, so by the time this resolves
    // the old tree has unmounted and released every Yjs handle it held.
    // Releasing after a destroy is a guarded no-op anyway.
    await previous.destroy()
  },
}

// Editing the hash by hand (or the back button) switches too.
window.addEventListener('hashchange', () => void sessions.switchTo(workspaceFromHash()))
