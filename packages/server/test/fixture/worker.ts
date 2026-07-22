import {
  AppError,
  createAdminFetch,
  createSyncFetch,
  createWorkspaceDO,
  crudMutators,
  type WorkspaceEngineConfig,
} from '../../src/index'

interface Env {
  WORKSPACE: DurableObjectNamespace
  COMPACT: DurableObjectNamespace
  ROLLOUT: DurableObjectNamespace
  EXPORT_BUCKET: R2Bucket
}

export const WorkspaceDO = createWorkspaceDO({
  schemaVersion: 'test-1',
  mutators: {
    ...crudMutators,
    // Intent-based mutator: server-side read-modify-write.
    'counter.increment': (tx, args) => {
      const { id, by } = args as { id: string; by: number }
      const current = tx.get('counters', id) ?? { value: 0 }
      tx.put('counters', id, { value: (current.value as number) + by })
    },
    // Intent-based mutator that scans.
    'todos.clearCompleted': (tx) => {
      for (const { id, data } of tx.list('todos')) {
        if (data.completed === true) tx.del('todos', id)
      }
    },
    // Permanent failure: must advance the LMID without data effects.
    'always.fails': () => {
      throw new AppError('Nope', 'this mutator always fails')
    },
    // Writes then fails: the write must be rolled back, the LMID advanced.
    'writes.thenFails': (tx) => {
      tx.put('todos', 'should-not-exist', { title: 'ghost' })
      throw new AppError('Nope', 'wrote then failed')
    },
  },
  export: {
    bucket: (env) => (env as Env).EXPORT_BUCKET,
    maxBatchRows: 5, // small batches so tests exercise multi-object runs
  },
})

// Same mutators, but tombstones compact immediately when the alarm fires.
export const CompactingDO = createWorkspaceDO({
  schemaVersion: 'test-1',
  mutators: { ...crudMutators },
  compaction: { tombstoneRetentionVersions: 0, intervalMs: 60 * 60 * 1000 },
})

// Schema-rollout drill fixture: tests mutate this config ("deploy v2"), then
// evict the DO so the next wake constructs against the new version. Works
// because tests and DOs share one isolate under vitest-pool-workers, and
// createWorkspaceDO reads config properties at use time.
export const rolloutConfig: WorkspaceEngineConfig = {
  schemaVersion: 'test-1',
  mutators: { ...crudMutators },
}
export const RolloutDO = createWorkspaceDO(rolloutConfig)

const mainHandler = createSyncFetch<Env>({ namespace: (env) => env.WORKSPACE })
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
    if (pathname.startsWith('/compact/')) return compactHandler(request, env)
    if (pathname.startsWith('/rollout/')) return rolloutHandler(request, env)
    return mainHandler(request, env)
  },
}
