import { CLOSE_UNAUTHORIZED } from '@cf-sync/protocol'
import { AUTH_HEADER, WORKSPACE_HEADER, encodeAuthStamps, rejectUpgrade } from './do'

/**
 * An `authorize` hook that checks `Authorization: Bearer <token>` against a
 * secret from the env, comparing in constant time — the standard way to lock
 * `createAdminFetch` behind a token:
 *
 * ```ts
 * createAdminFetch<Env>({
 *   namespace: (env) => env.WORKSPACE,
 *   authorize: bearerTokenAuth((env) => env.ADMIN_TOKEN),
 * })
 * ```
 *
 * A missing/empty secret denies everything (an unset `wrangler secret` must
 * fail closed, not open). Compatible with `createSyncFetch` too, for
 * service-to-service sync clients.
 */
export function bearerTokenAuth<Env>(token: (env: Env) => string | undefined) {
  return (request: Request, params: { env: Env }): boolean => {
    const expected = token(params.env)
    if (!expected) return false
    const header = request.headers.get('authorization')
    if (!header?.startsWith('Bearer ')) return false
    return timingSafeEqual(header.slice('Bearer '.length), expected)
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  // Length is not secret (the attacker knows what they sent); bail early so
  // the XOR loop below always runs over equal-length buffers.
  if (aBytes.byteLength !== bBytes.byteLength) return false
  let diff = 0
  for (let i = 0; i < aBytes.byteLength; i++) diff |= aBytes[i]! ^ bBytes[i]!
  return diff === 0
}

/**
 * The structured return of a sync `authorize` hook (DESIGN.md §15.2).
 *
 * `ok: true` stamps `principal` and `context` onto the connection: mutators
 * read them synchronously as `ctx.principal` / `ctx.auth` (validated against
 * the registry's `authContext` schema at upgrade). `expiresAt` (epoch ms)
 * bounds how long the stamps stay trusted without being re-derived — past it,
 * the DO closes the socket with 4300 and the reconnect re-runs `authorize`.
 * Omitted means no expiry: apps with reliable revocation webhooks don't pay
 * for one.
 *
 * `ok: false` completes the upgrade and immediately closes it with
 * `(code, reason)` — a browser client cannot observe the HTTP status of a
 * failed upgrade, so the close frame is what makes rejections
 * distinguishable from network errors. `code` defaults to 4403 (permanent:
 * the client stops reconnecting and calls `onFatal`); `reason` rides the
 * close frame, capped at 123 UTF-8 bytes — short stable slugs
 * (`membership-revoked`), not prose.
 */
export type AuthVerdict =
  | { ok: true; principal?: string; context?: unknown; expiresAt?: number }
  | { ok: false; code?: number; reason?: string }

export interface SyncFetchOptions<Env> {
  namespace: (env: Env) => DurableObjectNamespace
  /**
   * Connection-time authorization, run in the worker before the DO is
   * reached (DESIGN.md §8, §15). Return false or a Response to reject with
   * HTTP 403 (correct for non-browser callers), or an `AuthVerdict` for
   * distinguishable rejections and connection stamps. v1 policy: workspace
   * membership grants full access; mutation-level checks live in mutators
   * (reading the verdict's stamps via `ctx`).
   */
  authorize?: (
    request: Request,
    params: { workspaceId: string; clientId: string; env: Env },
  ) => boolean | Response | AuthVerdict | Promise<boolean | Response | AuthVerdict>
  /** URL prefix for sync routes. Default: "/sync" (routes are `${prefix}/<workspaceId>`). */
  pathPrefix?: string
}

/**
 * The composable form of {@link createSyncFetch}: resolves to `null` when the
 * request is not this route's traffic (path outside `${prefix}/<workspaceId>`),
 * so a worker entry chains routes and owns its own fallback — the
 * partyserver/Agents convention for Durable-Object routers:
 *
 * ```ts
 * const sync = createSyncRoute<Env>({ namespace: (env) => env.WORKSPACE, authorize })
 * const admin = createAdminRoute<Env>({ namespace: (env) => env.WORKSPACE, authorize: bearerTokenAuth(...) })
 * export default {
 *   fetch: async (request: Request, env: Env) =>
 *     (await sync(request, env)) ??
 *     (await admin(request, env)) ??
 *     new Response('not found', { status: 404 }),
 * }
 * ```
 *
 * Requests that *are* this route's traffic but malformed (missing websocket
 * upgrade, missing clientId, failed authorize) return real Responses, never
 * null — null strictly means "not mine, keep routing".
 */
export function createSyncRoute<Env>(opts: SyncFetchOptions<Env>) {
  const prefix = opts.pathPrefix ?? '/sync'
  return async (request: Request, env: Env): Promise<Response | null> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(`${prefix}/`)) return null
    const workspaceId = decodeURIComponent(url.pathname.slice(prefix.length + 1))
    if (!workspaceId || workspaceId.includes('/')) return null
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }
    const clientId = url.searchParams.get('clientId')
    if (!clientId) return new Response('missing clientId', { status: 400 })

    // The auth header is router-owned: strip any inbound value before the
    // authorize verdict can set its own, so it cannot be spoofed (§15.3).
    const headers = new Headers(request.headers)
    headers.delete(AUTH_HEADER)
    headers.set(WORKSPACE_HEADER, workspaceId)

    if (opts.authorize) {
      const verdict = await opts.authorize(request, { workspaceId, clientId, env })
      if (verdict instanceof Response) return verdict
      if (verdict === false) return new Response('unauthorized', { status: 403 })
      if (typeof verdict === 'object') {
        if (!verdict.ok) {
          // Accept-then-close in the router (§15.2): the client gets a real
          // close event with a policy code, and the DO never wakes.
          return rejectUpgrade(verdict.code ?? CLOSE_UNAUTHORIZED, verdict.reason ?? 'unauthorized')
        }
        // A structured ok-verdict always forwards its stamps — even empty —
        // so a declared authContext schema catches a hook that stamps
        // nothing at connect time, not mid-mutation.
        headers.set(
          AUTH_HEADER,
          encodeAuthStamps({
            principal: verdict.principal,
            context: verdict.context,
            expiresAt: verdict.expiresAt,
          }),
        )
      }
    }

    const namespace = opts.namespace(env)
    const stub = namespace.get(namespace.idFromName(workspaceId))
    return stub.fetch(request.url, { headers })
  }
}

/**
 * {@link createSyncRoute} with a built-in 404 fallback — the right shape when
 * the sync route is the worker's only (or last) route:
 * `export default { fetch: createSyncFetch({ ... }) }`.
 */
export function createSyncFetch<Env>(opts: SyncFetchOptions<Env>) {
  const route = createSyncRoute(opts)
  return async (request: Request, env: Env): Promise<Response> =>
    (await route(request, env)) ?? new Response('not found', { status: 404 })
}

export type AdminOp = 'stats' | 'export' | 'import' | 'reset' | 'disconnect'

const ADMIN_METHODS: Record<AdminOp, string> = {
  stats: 'GET',
  export: 'GET',
  import: 'POST',
  reset: 'POST',
  disconnect: 'POST',
}

export interface AdminFetchOptions<Env> {
  namespace: (env: Env) => DurableObjectNamespace
  /**
   * Required — admin operations read and destroy whole workspaces. Return
   * false or a Response to reject.
   */
  authorize: (
    request: Request,
    params: { workspaceId: string; op: AdminOp; env: Env },
  ) => boolean | Response | Promise<boolean | Response>
  /** URL prefix. Default: "/admin" (routes are `${prefix}/<workspaceId>/<op>`). */
  pathPrefix?: string
}

/**
 * Routes `${prefix}/<workspaceId>/<op>` to the workspace DO's admin surface:
 * GET stats, GET export, POST import (snapshot body), POST reset,
 * POST disconnect (kick/refresh live sockets, DESIGN.md §15.5).
 *
 * The composable form (see {@link createSyncRoute} for the pattern): resolves
 * to `null` when the request is not admin traffic, so it chains with other
 * routes via `??`. {@link createAdminFetch} is the same route with a built-in
 * 404 fallback.
 */
export function createAdminRoute<Env>(opts: AdminFetchOptions<Env>) {
  const prefix = opts.pathPrefix ?? '/admin'
  return async (request: Request, env: Env): Promise<Response | null> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(`${prefix}/`)) return null
    const parts = url.pathname.slice(prefix.length + 1).split('/')
    if (parts.length !== 2) return null
    const workspaceId = decodeURIComponent(parts[0]!)
    const op = parts[1] as AdminOp
    if (!workspaceId || !(op in ADMIN_METHODS)) return null
    if (request.method !== ADMIN_METHODS[op]) {
      return new Response('method not allowed', { status: 405 })
    }

    const verdict = await opts.authorize(request, { workspaceId, op, env })
    if (verdict instanceof Response) return verdict
    if (!verdict) return new Response('unauthorized', { status: 403 })

    const namespace = opts.namespace(env)
    const stub = namespace.get(namespace.idFromName(workspaceId))
    const headers = new Headers(request.headers)
    headers.set(WORKSPACE_HEADER, workspaceId)
    return stub.fetch(`https://do/admin/${op}`, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? request.body : null,
    })
  }
}

/** {@link createAdminRoute} with a built-in 404 fallback for standalone mounting. */
export function createAdminFetch<Env>(opts: AdminFetchOptions<Env>) {
  const route = createAdminRoute(opts)
  return async (request: Request, env: Env): Promise<Response> =>
    (await route(request, env)) ?? new Response('not found', { status: 404 })
}

/** Selects which live sockets to close and how (DESIGN.md §15.5). */
export interface DisconnectOptions {
  /** Only sockets whose verdict stamped this principal. */
  principal?: string
  /** Only this clientId's socket. */
  clientId?: string
  /**
   * `kick` (default) closes permanently — the client stops reconnecting and
   * calls `onFatal` with the code and reason. `refresh` closes with 4300 —
   * the client reconnects immediately and the fresh connection re-runs
   * `authorize`, picking up new stamps (role, entitlement).
   */
  mode?: 'kick' | 'refresh'
  /** Kick close code; defaults to 4403. Refresh is always 4300. */
  code?: number
  /** Rides the close frame — a short stable slug (`membership-revoked`), capped at 123 UTF-8 bytes. */
  reason?: string
}

export interface WorkspaceAdmin {
  stats(): Promise<Record<string, unknown>>
  export(): Promise<Record<string, unknown>>
  import(snapshot: unknown): Promise<{ imported: number; version: number }>
  reset(): Promise<{ backendId: string }>
  disconnect(opts?: DisconnectOptions): Promise<{ disconnected: number }>
}

/**
 * Typed admin surface over a workspace DO stub, for same-worker callers —
 * app command handlers, billing webhooks — so server code never hand-builds
 * admin HTTP requests against its own routes:
 *
 * ```ts
 * const ws = workspaceAdmin(env.WORKSPACE, projectId)
 * await ws.disconnect({ principal: userId, mode: 'kick', reason: 'membership-revoked' })
 * await ws.disconnect({ mode: 'refresh' }) // everyone re-authorizes
 * ```
 *
 * Talks straight to the stub (no `createAdminFetch` in between), so it
 * carries the caller's authority — external callers go through
 * `createAdminFetch` and its authorize hook instead.
 */
export function workspaceAdmin(namespace: DurableObjectNamespace, workspaceId: string): WorkspaceAdmin {
  const stub = namespace.get(namespace.idFromName(workspaceId))
  const call = async <T>(op: AdminOp, body?: unknown): Promise<T> => {
    const response = await stub.fetch(`https://do/admin/${op}`, {
      method: ADMIN_METHODS[op],
      headers: { [WORKSPACE_HEADER]: workspaceId },
      body: body === undefined ? null : JSON.stringify(body),
    })
    const json = (await response.json()) as T & { error?: string }
    if (!response.ok) {
      throw new Error(`workspaceAdmin.${op} failed (${response.status}): ${json.error ?? 'unknown error'}`)
    }
    return json
  }
  return {
    stats: () => call('stats'),
    export: () => call('export'),
    import: (snapshot) => call('import', snapshot),
    reset: () => call('reset'),
    disconnect: (opts = {}) => call('disconnect', opts),
  }
}
