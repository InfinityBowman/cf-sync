import { AppError, createSyncFetch, createWorkspaceDO, crudMutators } from '../../src/index'

interface Env {
  WORKSPACE: DurableObjectNamespace
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
})

const fetchHandler = createSyncFetch<Env>({ namespace: (env) => env.WORKSPACE })

export default {
  fetch: (request: Request, env: Env) => fetchHandler(request, env),
}
