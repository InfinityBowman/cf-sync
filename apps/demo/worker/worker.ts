import { createSyncFetch, createWorkspaceDO, crudMutators } from '@cf-sync/server'
import { SCHEMA_VERSION } from '../src/schema'

interface Env {
  WORKSPACE: DurableObjectNamespace
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
})

const fetchHandler = createSyncFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  // v1 auth policy (DESIGN.md §10): anyone who can reach the workspace has
  // full access. Real deployments plug session validation in here.
  authorize: () => true,
})

export default {
  fetch: (request: Request, env: Env) => fetchHandler(request, env),
}
