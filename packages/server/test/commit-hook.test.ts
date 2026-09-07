import { SELF, env, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { crudMutators, defineApp, type MutationCommitted } from '../src/index'
import { rolloutApp, rolloutConfig, testSchema } from './fixture/worker'
import { TestClient } from './harness'

// The post-commit seam (ARCHITECTURE.md#mutation-processing): one call per
// mutation that changed rows, after its transaction committed, carrying the
// net before/after images. It observes and never participates — a failing
// hook is a logger line, not a failed push.

let n = 0
const ws = () => `hook-${++n}-${Date.now()}`

function connect(workspace: string, clientId: string, principal?: string): Promise<TestClient> {
  return TestClient.connect(workspace, clientId, '/rollout', principal ? { 'x-test-principal': principal } : {})
}

async function evict(workspaceId: string): Promise<void> {
  const stub = env.ROLLOUT.get(env.ROLLOUT.idFromName(workspaceId))
  await runInDurableObject(stub, async (_instance, state) => {
    state.abort()
  }).catch(() => {
    // abort() kills the object; the call itself is expected to fail
  })
}

function admin(workspaceId: string, op: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`https://test/rollout-admin/${workspaceId}/${op}`, {
    method: 'POST',
    headers: { 'x-test-admin': 'yes', 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
}

afterEach(() => {
  delete rolloutConfig.onMutationCommitted
  delete rolloutConfig.logger
  rolloutConfig.app = rolloutApp
  vi.restoreAllMocks()
})

describe('onMutationCommitted', () => {
  it('fires once per committed mutation with net before/after images and the committed version', async () => {
    const workspace = ws()
    const hook = vi.fn()
    rolloutConfig.onMutationCommitted = hook

    const c1 = await connect(workspace, 'c1', 'alice')
    await c1.syncOnce()
    c1.push([
      { id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'a' } } },
      { id: 2, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'b' } } },
      { id: 3, name: 'sync.del', args: { tbl: 'todos', id: 't1' } },
    ])
    await c1.pokeUntilLmid(3)
    c1.close()

    expect(hook).toHaveBeenCalledTimes(3)
    const events = hook.mock.calls.map((call) => call[0] as MutationCommitted)
    expect(events[0]).toEqual({
      workspaceId: workspace,
      name: 'sync.put',
      args: { tbl: 'todos', id: 't1', data: { title: 'a' } },
      principal: 'alice',
      clientId: 'c1',
      version: 1,
      changes: [{ tbl: 'todos', id: 't1', before: null, after: { title: 'a' } }],
    })
    expect(events[1]).toMatchObject({
      name: 'sync.put',
      version: 2,
      changes: [{ tbl: 'todos', id: 't1', before: { title: 'a' }, after: { title: 'b' } }],
    })
    expect(events[2]).toMatchObject({
      name: 'sync.del',
      version: 3,
      changes: [{ tbl: 'todos', id: 't1', before: { title: 'b' }, after: null }],
    })
    // The worker env rides along so a hook can reach its own bindings.
    expect(hook.mock.calls[0]![1]).toHaveProperty('ROLLOUT')
  })

  it('passes args as the mutator received them: parsed, with defaults applied', async () => {
    const workspace = ws()
    const hook = vi.fn()
    rolloutConfig.onMutationCommitted = hook

    const c1 = await connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'typed', id: 'x', data: { name: 'n' } } }])
    await c1.pokeUntilLmid(1)
    c1.close()

    const event = hook.mock.calls[0]![0] as MutationCommitted
    expect(event.principal).toBeUndefined()
    expect(event.changes).toEqual([{ tbl: 'typed', id: 'x', before: null, after: { name: 'n', n: 1 } }])
  })

  it('stays silent for rejected mutations and for writes that net to nothing', async () => {
    const workspace = ws()
    const hook = vi.fn()
    rolloutConfig.onMutationCommitted = hook

    const c1 = await connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([
      // Permanent error: the LMID advances, nothing is written.
      { id: 1, name: 'sync.put', args: { tbl: 'not-a-table', id: 't1', data: { title: 'a' } } },
      // Deleting a row that never existed writes no tombstone.
      { id: 2, name: 'sync.del', args: { tbl: 'todos', id: 'absent' } },
      { id: 3, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'a' } } },
    ])
    await c1.pokeUntilLmid(3)
    c1.close()

    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0]![0]).toMatchObject({ name: 'sync.put', version: 1 })
  })

  it('a throwing or rejecting hook is reported to the logger and never blocks confirmation', async () => {
    const workspace = ws()
    const logger = vi.fn()
    rolloutConfig.logger = logger
    rolloutConfig.onMutationCommitted = (event) => {
      if (event.version === 1) throw new Error('sync boom')
      return Promise.reject(new Error('async boom'))
    }

    const c1 = await connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([
      { id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'a' } } },
      { id: 2, name: 'sync.put', args: { tbl: 'todos', id: 't2', data: { title: 'b' } } },
    ])
    await c1.pokeUntilLmid(2)
    expect(c1.rows.get('todos/t2')).toEqual({ title: 'b' })
    c1.close()

    await vi.waitFor(() => expect(logger).toHaveBeenCalledTimes(2))
    const [thrown, rejected] = logger.mock.calls.map((call) => ({
      level: call[0],
      message: String(call[1]),
      context: call[2],
      error: call[3],
      detail: call[4],
    }))
    expect(thrown).toMatchObject({
      level: 'error',
      message: '[cf-sync] onMutationCommitted threw',
      context: { workspaceId: workspace },
      detail: { name: 'sync.put', version: 1 },
    })
    expect((thrown!.error as Error).message).toBe('sync boom')
    expect(rejected).toMatchObject({
      level: 'error',
      message: '[cf-sync] onMutationCommitted rejected',
      detail: { name: 'sync.put', version: 2 },
    })
    expect((rejected!.error as Error).message).toBe('async boom')
  })

  it('does not fire for schema migrations', async () => {
    const workspace = ws()
    const hook = vi.fn()
    rolloutConfig.onMutationCommitted = hook

    const c1 = await connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'a' } } }])
    await c1.pokeUntilLmid(1)
    c1.close()
    expect(hook).toHaveBeenCalledTimes(1)

    // "Deploy" v2 with a migration that rewrites every row, then wake the DO.
    rolloutConfig.app = defineApp({
      version: 2,
      schema: testSchema,
      mutators: { ...crudMutators(testSchema) },
      migrations: {
        2: (tx) => {
          for (const { id, data } of tx.list('todos')) tx.put('todos', id, { ...data, migrated: true })
        },
      },
    })
    await evict(workspace)
    const c2 = await connect(workspace, 'c2')
    c2.schemaVersion = 2
    const poke = await c2.syncOnce()
    expect(c2.rows.get('todos/t1')).toEqual({ title: 'a', migrated: true })
    expect(poke.cursor.version).toBe(2)
    c2.close()

    expect(hook).toHaveBeenCalledTimes(1)
  })

  it('does not fire for admin import or reset', async () => {
    const workspace = ws()
    const hook = vi.fn()
    rolloutConfig.onMutationCommitted = hook

    const c1 = await connect(workspace, 'c1')
    await c1.syncOnce()
    const imported = await admin(workspace, 'import', {
      formatVersion: 1,
      schemaVersion: 1,
      rows: [{ tbl: 'todos', id: 't1', data: { title: 'imported' } }],
    })
    expect(imported.status).toBe(200)
    const poke = await c1.nextPoke()
    expect(poke.patch).toContainEqual({ op: 'put', tbl: 'todos', id: 't1', value: { title: 'imported' } })
    expect((await admin(workspace, 'reset')).status).toBe(200)
    await c1.nextPoke()
    c1.close()

    expect(hook).not.toHaveBeenCalled()
  })
})
