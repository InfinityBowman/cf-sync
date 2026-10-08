import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { AppError, workspaceAdmin } from '../src/index'
import type { testMutators } from './fixture/worker'
import { TestClient } from './harness'

// Mutations from server code (ARCHITECTURE.md#server-mutations): workspaceAdmin().mutate runs a
// registered mutator in the DO, fans the rows out to live clients, and is the only way to run an
// `internal` one; rows() reads a table back.

const ws = (name: string) => `server-mutate-${name}-${Date.now()}`
const admin = (workspace: string) => workspaceAdmin<typeof testMutators>(env.WORKSPACE, workspace)

describe('workspaceAdmin().mutate', () => {
  it('applies a mutator and pokes every live client', async () => {
    const workspace = ws('poke')
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()

    const { version } = await admin(workspace).mutate('counter.increment', { id: 'n', by: 2 })
    await c1.pokeUntilVersion(version)
    expect(c1.rows.get('counters/n')).toEqual({ value: 2 })

    // A read-modify-write mutator sees the stored row, like a client push would.
    await admin(workspace).mutate('counter.increment', { id: 'n', by: 3 })
    await c1.pokeUntilVersion(version + 1)
    expect(c1.rows.get('counters/n')).toEqual({ value: 5 })
    c1.close()
  })

  it('runs internal mutators with the given clientId, authoritatively', async () => {
    const workspace = ws('internal')
    await admin(workspace).mutate('server.stamp', { id: 's', note: 'built' }, { clientId: 'builder' })
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()
    expect(c1.rows.get('todos/s')).toEqual({ note: 'built', clientId: 'builder', authoritative: true })
    c1.close()
  })

  it('rejects an internal mutator pushed by a client, permanently and without writes', async () => {
    const workspace = ws('forged')
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'server.stamp', args: { id: 'x', note: 'forged' } }])
    const poke = await c1.nextPoke()
    expect(poke.mutationResults).toEqual([{ id: 1, error: { code: 'InternalMutator', message: '"server.stamp" runs only from the server' } }])
    expect(c1.rows.has('todos/x')).toBe(false)
    c1.close()
  })

  it("rejects with the mutator's AppError, writing nothing", async () => {
    const workspace = ws('app-error')
    const error = await admin(workspace).mutate('writes.thenFails', undefined).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ code: 'Nope', message: 'wrote then failed' })
    const exported = await admin(workspace).export()
    expect(exported.rows).toEqual([])
  })

  it('validates args', async () => {
    const workspace = ws('args')
    // @ts-expect-error by must be a number
    const error = await admin(workspace).mutate('counter.increment', { id: 'n', by: 'two' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'InvalidArgs' })
  })

  it('reads a table back, as the server has it', async () => {
    const workspace = ws('rows')
    await admin(workspace).mutate('counter.increment', { id: 'b', by: 2 })
    await admin(workspace).mutate('counter.increment', { id: 'a', by: 1 })
    const { version, rows } = await admin(workspace).rows('counters')
    expect(version).toBe(2)
    expect(rows).toEqual([
      { id: 'a', data: { value: 1 } },
      { id: 'b', data: { value: 2 } },
    ])
    expect((await admin(workspace).rows('todos')).rows).toEqual([])
    await expect(admin(workspace).rows('no such; table')).rejects.toThrow(/invalid table name/)
  })

  it('is an admin route too', async () => {
    const workspace = ws('route')
    const res = await SELF.fetch(`https://test/admin/${workspace}/mutate`, {
      method: 'POST',
      headers: { 'x-test-admin': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'counter.increment', args: { id: 'n', by: 1 } }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 1 })
  })
})
