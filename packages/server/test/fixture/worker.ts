import { z } from 'zod'
import {
  AppError,
  createAdminFetch,
  createSyncFetch,
  createWorkspaceDO,
  crudMutators,
  defineApp,
  defineMutators,
  defineSchema,
  type WorkspaceEngineConfig,
} from '../../src/index'

interface Env {
  WORKSPACE: DurableObjectNamespace
  COMPACT: DurableObjectNamespace
  ROLLOUT: DurableObjectNamespace
  EXPORT_BUCKET: R2Bucket
}

// Loose row schemas for the tables the behavioral tests write arbitrary
// shapes into; `typed` exercises real row validation (defaults, rejection).
export const testSchema = defineSchema({
  todos: z.record(z.string(), z.unknown()),
  counters: z.record(z.string(), z.unknown()),
  blobs: z.record(z.string(), z.unknown()),
  typed: z.object({
    name: z.string(),
    n: z.number().default(1),
  }),
})

export const testMutators = defineMutators(testSchema, {
  ...crudMutators(testSchema),
  // Writes the mutator context into a row so tests can assert what the
  // server stamped (§15.4).
  'ctx.echo': {
    args: z.object({ id: z.string() }),
    apply: (tx, { id }, ctx) => {
      tx.put('todos', id, {
        principal: ctx.principal ?? null,
        auth: ctx.auth ?? null,
        authoritative: ctx.authoritative,
      })
    },
  },
  // Intent-based mutator with validated args: server-side read-modify-write.
  'counter.increment': {
    args: z.object({ id: z.string(), by: z.number() }),
    apply: (tx, { id, by }) => {
      const current = tx.get('counters', id) ?? { value: 0 }
      tx.put('counters', id, { value: (current.value as number) + by })
    },
  },
  // Intent-based mutator that scans; takes no args.
  'todos.clearCompleted': {
    apply: (tx) => {
      for (const { id, data } of tx.list('todos')) {
        if (data.completed === true) tx.del('todos', id)
      }
    },
  },
  // Permanent failure: must advance the LMID without data effects.
  'always.fails': {
    apply: () => {
      throw new AppError('Nope', 'this mutator always fails')
    },
  },
  // Writes then fails: the write must be rolled back, the LMID advanced.
  'writes.thenFails': {
    apply: (tx) => {
      tx.put('todos', 'should-not-exist', { title: 'ghost' })
      throw new AppError('Nope', 'wrote then failed')
    },
  },
}, {
  // Verdicts arriving through the '/auth' route validate against this at
  // upgrade (§15.4); '/sync' has no authorize hook, so it stamps nothing.
  authContext: z.object({ role: z.string(), writeAllowed: z.boolean() }),
})

export const testApp = defineApp({
  version: 1,
  schema: testSchema,
  mutators: testMutators,
})

export const WorkspaceDO = createWorkspaceDO({
  app: testApp,
  export: {
    bucket: (env: Env) => env.EXPORT_BUCKET,
    maxBatchRows: 5, // small batches so tests exercise multi-object runs
  },
})

// Same mutators, but tombstones compact immediately when the alarm fires.
export const CompactingDO = createWorkspaceDO({
  app: defineApp({ version: 1, schema: testSchema, mutators: { ...crudMutators(testSchema) } }),
  compaction: { tombstoneRetentionVersions: 0, intervalMs: 60 * 60 * 1000 },
})

// Schema-rollout drill fixture: tests swap in a new app ("deploy v2"), then
// evict the DO so the next wake constructs against the new version. Works
// because tests and DOs share one isolate under vitest-pool-workers, and
// createWorkspaceDO reads config properties at use time.
export const rolloutApp = defineApp({
  version: 1,
  schema: testSchema,
  mutators: { ...crudMutators(testSchema) },
})
export const rolloutConfig: WorkspaceEngineConfig = { app: rolloutApp }
export const RolloutDO = createWorkspaceDO(rolloutConfig)

const mainHandler = createSyncFetch<Env>({ namespace: (env) => env.WORKSPACE })

// Session-control drills (§15): the verdict is driven entirely by request
// headers so each test scripts its own authorize outcome.
const verdictHandler = createSyncFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  pathPrefix: '/auth',
  authorize: (request) => {
    const reject = request.headers.get('x-test-reject')
    if (reject !== null) {
      const [code, reason] = reject.split(':', 2)
      return { ok: false, code: code ? Number(code) : undefined, reason: reason || undefined }
    }
    if (request.headers.get('x-test-deny') !== null) return false
    const context = request.headers.get('x-test-auth')
    const expiresInMs = request.headers.get('x-test-expires-in')
    return {
      ok: true,
      principal: request.headers.get('x-test-principal') ?? undefined,
      context: context !== null ? (JSON.parse(context) as unknown) : undefined,
      expiresAt: expiresInMs !== null ? Date.now() + Number(expiresInMs) : undefined,
    }
  },
})
const compactHandler = createSyncFetch<Env>({ namespace: (env) => env.COMPACT, pathPrefix: '/compact' })
const rolloutHandler = createSyncFetch<Env>({ namespace: (env) => env.ROLLOUT, pathPrefix: '/rollout' })
const adminHandler = createAdminFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  authorize: (request) => request.headers.get('x-test-admin') === 'yes',
})

export default {
  fetch: (request: Request, env: Env) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/admin/')) return adminHandler(request, env)
    if (pathname.startsWith('/auth/')) return verdictHandler(request, env)
    if (pathname.startsWith('/compact/')) return compactHandler(request, env)
    if (pathname.startsWith('/rollout/')) return rolloutHandler(request, env)
    return mainHandler(request, env)
  },
}
