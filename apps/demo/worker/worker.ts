import { bearerTokenAuth, createAdminFetch, createSyncFetch, createWorkspaceDO } from '@cf-sync/server'
import { yjsFields } from '@cf-sync/yjs/server'
import { app } from '../src/schema'

interface Env {
  WORKSPACE: DurableObjectNamespace
  EXPORT_BUCKET: R2Bucket
  /** Set via `wrangler secret put ADMIN_TOKEN`. Unset = admin surface disabled. */
  ADMIN_TOKEN?: string
}

// Version, schema, mutators, and migrations all travel inside `app` — the
// same object the browser passes to SyncClient, so the two can't disagree.
export const WorkspaceDO = createWorkspaceDO({
  app,
  export: {
    // Annotating the param types the whole DO's env — no cast.
    bucket: (env: Env) => env.EXPORT_BUCKET,
  },
  // Tier 2 fields: per-todo collaborative notes ride the same socket as
  // binary Yjs frames — CRDT bytes never touch rows, pokes, or the mutation
  // log. No wrangler migration needed; the extension owns its own tables.
  // This demo's auth policy is "any member writes" (the default). With a
  // real authorize hook stamping context, writes gate per field:
  //
  //   extension: yjsFields<{ userId: string }>({
  //     authorizeWrite: ({ fieldId, auth }) =>
  //       fieldId.startsWith(`todo-notes:`) && auth !== undefined,
  //   }),
  extension: yjsFields(),
})

const syncHandler = createSyncFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  // v1 auth policy (DESIGN.md §10): anyone who can reach the workspace has
  // full access. Real deployments plug session validation in here.
  authorize: () => true,
})

// Admin operations read and destroy whole workspaces: locked behind a bearer
// token (`curl -H "Authorization: Bearer $TOKEN" .../admin/<ws>/stats`),
// compared in constant time; an unset secret denies everything.
const adminHandler = createAdminFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  authorize: bearerTokenAuth((env) => env.ADMIN_TOKEN),
})

export default {
  fetch: (request: Request, env: Env) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/admin/')) return adminHandler(request, env)
    return syncHandler(request, env)
  },
}
