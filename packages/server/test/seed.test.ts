import { PROTOCOL_VERSION, createIdSource } from '@cf-sync/protocol/internal'
import { describe, expect, it } from 'vitest'
import { TestClient } from './harness'

let n = 0
const ws = () => `seed-${++n}-${Date.now()}`

describe('mutation seeds on the wire', () => {
  it('the DO mints ids from the wire seed, so any run over that seed agrees', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'ids.mint', args: { count: 2 }, seed: 'pinned' }])
    await c1.pokeUntilLmid(1)
    const expected = createIdSource('pinned')
    expect(c1.rows.get(`todos/${expected()}`)).toEqual({ seed: 'pinned' })
    expect(c1.rows.get(`todos/${expected()}`)).toEqual({ seed: 'pinned' })
    expect(c1.rows.size).toBe(2)
    c1.close()
  })

  it('a push without a seed is a bad message', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    await c1.syncOnce()
    c1.send({ type: 'push', mutations: [{ id: 1, name: 'ids.mint', args: { count: 1 } }] } as never)
    const msg = await c1.next()
    expect(msg).toMatchObject({ type: 'error', code: 'BadMessage' })
    c1.close()
  })

  it('a protocol-1 client is turned away at hello', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    c1.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION - 1, schemaVersion: 1, cursor: null })
    const msg = await c1.next()
    expect(msg).toMatchObject({ type: 'error', code: 'VersionNotSupported' })
  })
})
