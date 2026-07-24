import {
  createAdminFetch,
  createSyncFetch,
  createWorkspaceDO,
  crudMutators,
  defineApp,
  defineMutators,
  defineSchema,
} from '@cf-sync/server'
import { z } from 'zod'
import { yjsFields } from '../../src/server'

interface Env {
  WORKSPACE: DurableObjectNamespace
  AUTHW: DurableObjectNamespace
  PERFIELD: DurableObjectNamespace
  COMPACT: DurableObjectNamespace
}

const schema = defineSchema({ notes: z.record(z.string(), z.unknown()) })
const app = defineApp({ version: 1, schema, mutators: crudMutators(schema) })

/**
 * App with a declared authContext: `yjsFields({ app: authApp, … })` below
 * derives authorizeWrite's `auth` type from it — this fixture compiling is
 * the inference test (property access on an untyped `auth` would not).
 */
const authApp = defineApp({
  version: 1,
  schema,
  mutators: defineMutators(schema, {}, { authContext: z.object({ writeAllowed: z.boolean().optional() }) }),
})

/** Default: any member writes any field. Exported in the documented shape (empty subclass — see server fixture). */
export class WorkspaceDO extends createWorkspaceDO({ app, extension: yjsFields() }) {}

/** Write-gated on the §15 stamps (the '/auth' route below supplies them). */
export const AuthWriteDO = createWorkspaceDO({
  app: authApp,
  extension: yjsFields({
    app: authApp,
    authorizeWrite: ({ auth }) => auth?.writeAllowed === true,
  }),
})

/** Per-field policy: the write context's fieldId and principal drive the verdict. */
export const PerFieldDO = createWorkspaceDO({
  app,
  extension: yjsFields({
    authorizeWrite: ({ fieldId, principal }) => fieldId === `notes:${principal}`,
  }),
})

/** Tiny thresholds so compaction and LRU drills stay fast. */
export const CompactDO = createWorkspaceDO({
  app,
  extension: yjsFields({ compactionThreshold: 3, maxCachedDocs: 2 }),
})

const mainHandler = createSyncFetch<Env>({ namespace: (env) => env.WORKSPACE, authorize: 'public' })
const authHandler = createSyncFetch<Env>({
  namespace: (env) => env.AUTHW,
  pathPrefix: '/auth',
  authorize: (request) => {
    const context = request.headers.get('x-test-auth')
    return {
      ok: true,
      principal: request.headers.get('x-test-principal') ?? undefined,
      context: context !== null ? (JSON.parse(context) as unknown) : undefined,
    }
  },
})
const perFieldHandler = createSyncFetch<Env>({
  namespace: (env) => env.PERFIELD,
  pathPrefix: '/perfield',
  authorize: (request) => ({
    ok: true,
    principal: request.headers.get('x-test-principal') ?? undefined,
  }),
})
const compactHandler = createSyncFetch<Env>({ namespace: (env) => env.COMPACT, pathPrefix: '/compact', authorize: 'public' })
const adminHandler = createAdminFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  authorize: () => true,
})

export default {
  fetch: (request: Request, env: Env) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/admin/')) return adminHandler(request, env)
    if (pathname.startsWith('/auth/')) return authHandler(request, env)
    if (pathname.startsWith('/perfield/')) return perFieldHandler(request, env)
    if (pathname.startsWith('/compact/')) return compactHandler(request, env)
    return mainHandler(request, env)
  },
}
