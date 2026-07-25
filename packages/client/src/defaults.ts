import { IndexedDBSyncStore } from './idb-store'
import type { SyncStore } from './store'
import type { SyncLogger } from './types'

export const consoleLogger: SyncLogger = (level, message, ...detail) => console[level](message, ...detail)

/**
 * `<base><prefix>/<workspaceId>?clientId=<id>` — the shape createSyncFetch
 * routes. `http(s)` is mapped to `ws(s)`; a trailing slash on the base is
 * tolerated so `location.origin`-derived URLs compose cleanly. A query or
 * fragment on the base is rejected at construction: the sync path is
 * appended after it, so the URL would come out malformed — credentials
 * belong in the `authToken` option, which appends per connection attempt.
 */
export function buildSyncUrl(base: string, prefix: string, workspaceId: string, clientId: string): string {
  if (base.includes('?') || base.includes('#')) {
    throw new Error(
      `SyncClient: url must not carry a query or fragment (got "${base}") — the sync path is appended to it. ` +
        'To send a credential, use the authToken option; it rides the URL as ?token=… on every connection attempt.',
    )
  }
  const wsBase = base.replace(/^http/, 'ws').replace(/\/+$/, '')
  return `${wsBase}${prefix}/${encodeURIComponent(workspaceId)}?clientId=${encodeURIComponent(clientId)}`
}

/** The sync URL always ends in `?clientId=…`, so the token appends with `&`. */
export function withToken(url: string, token: string): string {
  return `${url}&token=${encodeURIComponent(token)}`
}

/**
 * One clientId per tab/session, per workspace: the clientId names a
 * contiguous mutation sequence, so concurrent tabs must never share one.
 * sessionStorage gives reload continuity without cross-tab sharing; where it
 * is unavailable (SSR, workers, blocked storage), a fresh random id per
 * instance is always safe — it just forfeits reload continuity.
 */
export function defaultClientId(workspaceId: string): string {
  const key = `cf-sync:client-id:${encodeURIComponent(workspaceId)}`
  try {
    const stored = sessionStorage.getItem(key)
    if (stored) return stored
    const id = crypto.randomUUID()
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
}

const FATAL_RELOAD_MIN_INTERVAL_MS = 60_000

/**
 * Default fatal handling: reload into the (presumably newer) bundle — the
 * protocol's designed recovery for VersionNotSupported — throttled per
 * workspace so a bad deploy window (stale web assets, a rollback that left
 * the client ahead of the server) degrades to one reload per minute instead
 * of a reload loop. Outside the browser there is nothing to reload; the
 * client just stays stopped in 'fatal'.
 */
export function defaultFatalRecovery(workspaceId: string, error: Error, log: SyncLogger): void {
  if (typeof location === 'undefined') {
    log('warn', '[cf-sync] fatal, and no onFatal handler to recover:', error)
    return
  }
  const key = `cf-sync:fatal-reload:${encodeURIComponent(workspaceId)}`
  let lastReloadAt = 0
  try {
    lastReloadAt = Number(sessionStorage.getItem(key)) || 0
  } catch {
    // storage blocked: fall through with 0 — reloading is still the best move
  }
  if (Date.now() - lastReloadAt < FATAL_RELOAD_MIN_INTERVAL_MS) {
    log(
      'warn',
      '[cf-sync] fatal again within a minute of reloading — waiting instead of looping (deploy skew?):',
      error,
    )
    return
  }
  try {
    sessionStorage.setItem(key, String(Date.now()))
  } catch {
    // best effort; without storage the throttle just resets per load
  }
  log('warn', '[cf-sync] fatal; reloading to pick up the current bundle:', error)
  location.reload()
}

export function createDefaultStore(workspaceId: string, clientId: string, log: SyncLogger): SyncStore | undefined {
  try {
    return new IndexedDBSyncStore({ workspaceId, clientId })
  } catch (err) {
    log('warn', '[cf-sync] persist: true, but IndexedDB is unavailable — continuing without local persistence', err)
    return undefined
  }
}
