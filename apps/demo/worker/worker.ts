import { createAdminFetch, createSyncFetch, createWorkspaceDO, crudMutators } from '@cf-sync/server'
import { SCHEMA_VERSION } from '../src/schema'

interface Env {
  WORKSPACE: DurableObjectNamespace
  EXPORT_BUCKET: R2Bucket
  /** Set via `wrangler secret put ADMIN_TOKEN`. Unset = admin surface disabled. */
  ADMIN_TOKEN?: string
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

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  if (aBytes.byteLength !== bBytes.byteLength) return false
  let diff = 0
  for (let i = 0; i < aBytes.byteLength; i++) diff |= aBytes[i]! ^ bBytes[i]!
  return diff === 0
}

// Admin operations read and destroy whole workspaces: locked behind a bearer
// token (`curl -H "Authorization: Bearer $TOKEN" .../admin/<ws>/stats`).
const adminHandler = createAdminFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  authorize: (request, { env }) => {
    if (!env.ADMIN_TOKEN) return false
    const header = request.headers.get('authorization')
    if (!header?.startsWith('Bearer ')) return false
    return timingSafeEqual(header.slice('Bearer '.length), env.ADMIN_TOKEN)
  },
})

export default {
  fetch: (request: Request, env: Env) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/admin/')) return adminHandler(request, env)
    return syncHandler(request, env)
  },
}
