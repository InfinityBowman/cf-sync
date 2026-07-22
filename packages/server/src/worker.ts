import { WORKSPACE_HEADER } from './do'

export interface SyncFetchOptions<Env> {
  namespace: (env: Env) => DurableObjectNamespace
  /**
   * Connection-time authorization, run in the worker before the DO is
   * reached (DESIGN.md §8). Return false or a Response to reject. v1 policy:
   * workspace membership grants full access; mutation-level checks live in
   * mutators.
   */
  authorize?: (
    request: Request,
    params: { workspaceId: string; clientId: string; env: Env },
  ) => boolean | Response | Promise<boolean | Response>
  /** URL prefix for sync routes. Default: "/sync" (routes are `${prefix}/<workspaceId>`). */
  pathPrefix?: string
}

export function createSyncFetch<Env>(opts: SyncFetchOptions<Env>) {
  const prefix = opts.pathPrefix ?? '/sync'
  return async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(`${prefix}/`)) return new Response('not found', { status: 404 })
    const workspaceId = decodeURIComponent(url.pathname.slice(prefix.length + 1))
    if (!workspaceId || workspaceId.includes('/')) return new Response('not found', { status: 404 })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }
    const clientId = url.searchParams.get('clientId')
    if (!clientId) return new Response('missing clientId', { status: 400 })

    if (opts.authorize) {
      const verdict = await opts.authorize(request, { workspaceId, clientId, env })
      if (verdict instanceof Response) return verdict
      if (!verdict) return new Response('unauthorized', { status: 403 })
    }

    const namespace = opts.namespace(env)
    const stub = namespace.get(namespace.idFromName(workspaceId))
    const headers = new Headers(request.headers)
    headers.set(WORKSPACE_HEADER, workspaceId)
    return stub.fetch(request.url, { headers })
  }
}

export type AdminOp = 'stats' | 'export' | 'import' | 'reset'

const ADMIN_METHODS: Record<AdminOp, string> = {
  stats: 'GET',
  export: 'GET',
  import: 'POST',
  reset: 'POST',
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
 * GET stats, GET export, POST import (snapshot body), POST reset.
 */
export function createAdminFetch<Env>(opts: AdminFetchOptions<Env>) {
  const prefix = opts.pathPrefix ?? '/admin'
  return async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(`${prefix}/`)) return new Response('not found', { status: 404 })
    const parts = url.pathname.slice(prefix.length + 1).split('/')
    if (parts.length !== 2) return new Response('not found', { status: 404 })
    const workspaceId = decodeURIComponent(parts[0]!)
    const op = parts[1] as AdminOp
    if (!workspaceId || !(op in ADMIN_METHODS)) return new Response('not found', { status: 404 })
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
