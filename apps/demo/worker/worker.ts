import { createAdminFetch, createSyncFetch, createWorkspaceDO, crudMutators } from '@cf-sync/server'
import { SCHEMA_VERSION } from '../src/schema'

interface Env {
  WORKSPACE: DurableObjectNamespace
  EXPORT_BUCKET: R2Bucket
}

export const WorkspaceDO = createWorkspaceDO({
  schemaVersion: SCHEMA_VERSION,
  mutators: {
    ...crudMutators,
    // An intent-based mutator: the server scans authoritatively, so two
    // clients clicking "clear completed" concurrently can't resurrect rows.
    'todos.clearCompleted': (tx) => {
      for (const { id, data } of tx.list('todos')) {
        if (data.completed === true) tx.del('todos', id)
      }
    },
  },
  export: {
    bucket: (env) => (env as Env).EXPORT_BUCKET,
  },
})

const syncHandler = createSyncFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  // v1 auth policy (DESIGN.md §10): anyone who can reach the workspace has
  // full access. Real deployments plug session validation in here.
  authorize: () => true,
})

// DANGER: open admin surface for local development. Gate this behind real
// auth (or remove it) before deploying anywhere shared.
const adminHandler = createAdminFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  authorize: () => true,
})

export default {
  fetch: (request: Request, env: Env) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/admin/')) return adminHandler(request, env)
    return syncHandler(request, env)
  },
}
