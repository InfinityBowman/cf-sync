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
    params: { workspaceId: string; clientId: string },
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
      const verdict = await opts.authorize(request, { workspaceId, clientId })
      if (verdict instanceof Response) return verdict
      if (!verdict) return new Response('unauthorized', { status: 403 })
    }

    const namespace = opts.namespace(env)
    const stub = namespace.get(namespace.idFromName(workspaceId))
    return stub.fetch(request)
  }
}
