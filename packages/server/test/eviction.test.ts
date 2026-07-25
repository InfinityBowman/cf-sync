import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { TestClient } from './harness'

/**
 * DO eviction/restart fault test (ARCHITECTURE.md#testing): after the object is killed
 * mid-life, a fresh instance must recover meta from storage — same backendId,
 * same version counter, same per-client LMIDs — so reconnecting clients
 * resume by cursor instead of re-bootstrapping, and replayed mutations stay
 * idempotent.
 */

async function evict(workspaceId: string): Promise<void> {
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId))
  await runInDurableObject(stub, async (_instance, state) => {
    state.abort()
  }).catch(() => {
    // abort() kills the object; the call itself is expected to fail
  })
}

describe('durable object eviction', () => {
  it('cursor, backendId, and LMIDs survive a restart', async () => {
    const workspace = `evict-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([
      { id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { n: 1 } } },
      { id: 2, name: 'counter.increment', args: { id: 'a', by: 7 } },
    ])
    await c1.pokeUntilLmid(2)
    const backendId = c1.cursor!.backendId
    const version = c1.cursor!.version

    await evict(workspace)

    // Reconnect by cursor: no reset, identical history identity.
    await c1.reconnect()
    const catchUp = await c1.syncOnce()
    expect(catchUp.baseCursor).toEqual({ backendId, version })
    expect(catchUp.patch).toEqual([])
    expect(catchUp.lastMutationIdChanges).toEqual({ c1: 2 })

    // A replayed mutation is still recognized as a duplicate.
    c1.push([{ id: 2, name: 'counter.increment', args: { id: 'a', by: 7 } }])
    const rePoke = await c1.nextPoke()
    expect(rePoke.patch).toEqual([])

    // And the sequence continues where it left off.
    c1.push([{ id: 3, name: 'counter.increment', args: { id: 'a', by: 1 } }])
    await c1.pokeUntilLmid(3)
    expect(c1.rows.get('counters/a')).toEqual({ value: 8 })
    c1.close()
  })

  it('a fresh bootstrap after restart sees identical state', async () => {
    const workspace = `evict-boot-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([
      { id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { n: 1 } } },
      { id: 2, name: 'sync.del', args: { tbl: 'todos', id: 'missing' } }, // lmid-only advance
    ])
    await c1.pokeUntilLmid(2)

    await evict(workspace)

    const c2 = await TestClient.connect(workspace, 'c2')
    await c2.syncOnce()
    expect(c2.rows).toEqual(c1.rows)
    expect(c2.cursor).toEqual(c1.cursor)
    c1.close()
    c2.close()
  })
})
