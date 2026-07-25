import { PROTOCOL_VERSION } from '@cf-sync/protocol/internal'
import { describe, expect, it } from 'vitest'
import { TestClient } from './harness'

let n = 0
const ws = () => `w-${++n}-${Date.now()}`

describe('bootstrap and hello', () => {
  it('null cursor gets clear + snapshot and a lmid baseline', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    const poke = await c1.syncOnce()
    expect(poke.baseCursor).toBeNull()
    expect(poke.patch[0]).toEqual({ op: 'clear' })
    expect(poke.lastMutationIdChanges).toEqual({ c1: 0 })
    expect(poke.cursor.version).toBe(0)
    c1.close()
  })

  it('rejects mismatched schema versions and closes', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    c1.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, schemaVersion: 999, cursor: null })
    const msg = await c1.next()
    expect(msg).toMatchObject({ type: 'error', code: 'VersionNotSupported' })
  })

  it('a cursor from another history (bad backendId) triggers a reset', async () => {
    const workspace = ws()
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'x' } } }])
    await c1.pokeUntilLmid(1)

    const c2 = await TestClient.connect(workspace, 'c2')
    c2.cursor = { backendId: 'not-this-backend', version: 1 }
    const poke = await c2.syncOnce()
    expect(poke.baseCursor).toBeNull()
    expect(poke.patch[0]).toEqual({ op: 'clear' })
    expect(c2.rows.get('todos/t1')).toEqual({ title: 'x' })
    c1.close()
    c2.close()
  })
})

describe('push', () => {
  it('applies mutations, confirms the origin, and broadcasts to others', async () => {
    const workspace = ws()
    const c1 = await TestClient.connect(workspace, 'c1')
    const c2 = await TestClient.connect(workspace, 'c2')
    await c1.syncOnce()
    await c2.syncOnce()

    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'hello' } } }])

    const p1 = await c1.nextPoke()
    expect(p1.baseCursor).toEqual({ backendId: p1.cursor.backendId, version: 0 })
    expect(p1.lastMutationIdChanges).toEqual({ c1: 1 })
    expect(p1.mutationResults).toEqual([{ id: 1 }])

    const p2 = await c2.nextPoke()
    expect(p2.patch).toEqual([{ op: 'put', tbl: 'todos', id: 't1', value: { title: 'hello' } }])
    expect(c1.rows).toEqual(c2.rows)
    c1.close()
    c2.close()
  })

  it('replayed mutations are skipped idempotently and re-confirmed to the origin only', async () => {
    const workspace = ws()
    const c1 = await TestClient.connect(workspace, 'c1')
    const c2 = await TestClient.connect(workspace, 'c2')
    await c1.syncOnce()
    await c2.syncOnce()

    const batch = [{ id: 1, name: 'counter.increment', args: { id: 'a', by: 5 } }]
    c1.push(batch)
    await c1.pokeUntilLmid(1)
    await c2.pokeUntilVersion(1)

    c1.push(batch) // duplicate delivery
    const rePoke = await c1.nextPoke()
    expect(rePoke.patch).toEqual([])
    expect(rePoke.lastMutationIdChanges).toEqual({ c1: 1 })
    expect(c1.rows.get('counters/a')).toEqual({ value: 5 }) // applied once

    await c2.expectNoMessage()
    c1.close()
    c2.close()
  })

  it('rejects a gap in the mutation sequence', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    await c1.syncOnce()
    c1.push([{ id: 7, name: 'sync.put', args: { tbl: 'todos', id: 't', data: {} } }])
    const msg = await c1.next()
    expect(msg).toMatchObject({ type: 'error', code: 'PushInvalid' })
  })

  it('rejects push before hello', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't', data: {} } }])
    const msg = await c1.next()
    expect(msg).toMatchObject({ type: 'error', code: 'PushInvalid' })
  })
})

describe('permanent app errors (invariant 2, ARCHITECTURE.md#invariants)', () => {
  it('advance the LMID, report the error, and write nothing', async () => {
    const workspace = ws()
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()

    c1.push([
      { id: 1, name: 'always.fails', args: {} },
      { id: 2, name: 'writes.thenFails', args: {} },
      { id: 3, name: 'no.such.mutator', args: {} },
      { id: 4, name: 'sync.put', args: { tbl: 'todos', id: 'real', data: { ok: true } } },
    ])
    await c1.pokeUntilLmid(4)

    // All four advanced the LMID; only the last one wrote data.
    expect(c1.lmid).toBe(4)
    expect(c1.rows.has('todos/should-not-exist')).toBe(false)
    expect(c1.rows.get('todos/real')).toEqual({ ok: true })

    // A fresh bootstrap agrees: the rolled-back write never existed.
    const c2 = await TestClient.connect(workspace, 'c2')
    await c2.syncOnce()
    expect(c2.rows).toEqual(c1.rows)
    expect(c2.cursor!.version).toBe(1) // only the successful put advanced the data version
    c1.close()
    c2.close()
  })

  it('oversized rows are rejected as RowTooLarge', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    await c1.syncOnce()
    c1.push([
      { id: 1, name: 'sync.put', args: { tbl: 'todos', id: 'big', data: { blob: 'x'.repeat(750_000) } } },
    ])
    const poke = await c1.nextPoke()
    expect(poke.mutationResults[0]?.error?.code).toBe('RowTooLarge')
    expect(c1.rows.size).toBe(0)
    c1.close()
  })
})

describe('intent-based mutators', () => {
  it('read-modify-write mutators serialize across clients', async () => {
    const workspace = ws()
    const c1 = await TestClient.connect(workspace, 'c1')
    const c2 = await TestClient.connect(workspace, 'c2')
    await c1.syncOnce()
    await c2.syncOnce()

    c1.push([{ id: 1, name: 'counter.increment', args: { id: 'a', by: 1 } }])
    c2.push([{ id: 1, name: 'counter.increment', args: { id: 'a', by: 10 } }])
    await c1.pokeUntilVersion(2)
    await c2.pokeUntilVersion(2)

    expect(c1.rows.get('counters/a')).toEqual({ value: 11 })
    expect(c2.rows.get('counters/a')).toEqual({ value: 11 })
    c1.close()
    c2.close()
  })

  it('mutators can scan and delete (tombstones flow to other clients)', async () => {
    const workspace = ws()
    const c1 = await TestClient.connect(workspace, 'c1')
    const c2 = await TestClient.connect(workspace, 'c2')
    await c1.syncOnce()
    await c2.syncOnce()

    c1.push([
      { id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { completed: true } } },
      { id: 2, name: 'sync.put', args: { tbl: 'todos', id: 't2', data: { completed: false } } },
      { id: 3, name: 'todos.clearCompleted', args: {} },
    ])
    await c1.pokeUntilLmid(3)
    await c2.pokeUntilVersion(c1.cursor!.version)

    expect(c1.rows.has('todos/t1')).toBe(false)
    expect(c1.rows.get('todos/t2')).toEqual({ completed: false })
    expect(c2.rows).toEqual(c1.rows)
    c1.close()
    c2.close()
  })
})

describe('catch-up after disconnect', () => {
  it('a reconnecting client with a valid cursor gets only the delta', async () => {
    const workspace = ws()
    const c1 = await TestClient.connect(workspace, 'c1')
    const c2 = await TestClient.connect(workspace, 'c2')
    await c1.syncOnce()
    await c2.syncOnce()

    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { v: 1 } } }])
    await c1.pokeUntilLmid(1)
    await c2.pokeUntilVersion(1)

    await c2.reconnect() // offline while c1 keeps writing
    c1.push([
      { id: 2, name: 'sync.put', args: { tbl: 'todos', id: 't2', data: { v: 2 } } },
      { id: 3, name: 'sync.del', args: { tbl: 'todos', id: 't1' } },
    ])
    await c1.pokeUntilLmid(3)

    const catchUp = await c2.syncOnce()
    expect(catchUp.baseCursor).toEqual({ backendId: c2.cursor!.backendId, version: 1 })
    expect(catchUp.patch).toEqual([
      { op: 'put', tbl: 'todos', id: 't2', value: { v: 2 } },
      { op: 'del', tbl: 'todos', id: 't1' },
    ])
    expect(c2.rows).toEqual(c1.rows)
    c1.close()
    c2.close()
  })

  it('LMID survives reconnects: a replay after reconnect is skipped', async () => {
    const workspace = ws()
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'counter.increment', args: { id: 'a', by: 3 } }])
    await c1.pokeUntilLmid(1)

    await c1.reconnect()
    const catchUp = await c1.syncOnce()
    expect(catchUp.lastMutationIdChanges).toEqual({ c1: 1 })

    c1.push([{ id: 1, name: 'counter.increment', args: { id: 'a', by: 3 } }]) // outbox replay
    const poke = await c1.nextPoke()
    expect(poke.patch).toEqual([])
    expect(c1.rows.get('counters/a')).toEqual({ value: 3 })
    c1.close()
  })
})

describe('schema validation (shape authority)', () => {
  it('rejects writes to tables not in the schema as a permanent error', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'nope', id: 'x', data: { a: 1 } } }])
    const poke = await c1.nextPoke()
    expect(poke.mutationResults[0]?.error?.code).toBe('InvalidArgs')
    expect(poke.mutationResults[0]?.error?.message).toMatch(/not defined in the schema/)
    expect(poke.lastMutationIdChanges).toEqual({ c1: 1 }) // permanent: LMID still advances
    expect(c1.rows.size).toBe(0)
    c1.close()
  })

  it('rejects rows that fail the table schema and reports the issue', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'typed', id: 'x', data: { n: 'not-a-number' } } }])
    const poke = await c1.nextPoke()
    expect(poke.mutationResults[0]?.error?.code).toBe('InvalidArgs')
    expect(poke.mutationResults[0]?.error?.message).toMatch(/invalid row typed\/x/)
    expect(c1.rows.size).toBe(0)
    c1.close()
  })

  it('stores the parsed output: schema defaults are applied server-side', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'typed', id: 'x', data: { name: 'a' } } }])
    await c1.pokeUntilLmid(1)
    expect(c1.rows.get('typed/x')).toEqual({ name: 'a', n: 1 })
    c1.close()
  })

  it('validates mutator args before apply and rejects bad args permanently', async () => {
    const c1 = await TestClient.connect(ws(), 'c1')
    await c1.syncOnce()
    c1.push([
      { id: 1, name: 'counter.increment', args: { id: 'a', by: 'lots' } },
      { id: 2, name: 'counter.increment', args: { id: 'a', by: 2 } },
    ])
    await c1.pokeUntilLmid(2)
    expect(c1.lmid).toBe(2)
    // The invalid mutation had no effect; the valid one applied.
    expect(c1.rows.get('counters/a')).toEqual({ value: 2 })
    c1.close()
  })
})

describe('large payloads', () => {
  it('bootstrap pokes are chunked under the frame budget', async () => {
    const workspace = ws()
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()

    // ~2.4MB of rows, pushed one mutation per frame to stay under the
    // client->server limit.
    for (let i = 1; i <= 12; i++) {
      c1.push([
        { id: i, name: 'sync.put', args: { tbl: 'blobs', id: `b${i}`, data: { blob: 'x'.repeat(200_000) } } },
      ])
      await c1.pokeUntilLmid(i)
    }

    const c2 = await TestClient.connect(workspace, 'c2')
    c2.hello()
    // Count parts by reading raw messages until pokeEnd.
    let parts = 0
    for (;;) {
      const msg = await c2.next(5_000)
      if (msg.type === 'pokePart') parts++
      if (msg.type === 'pokeEnd') break
    }
    expect(parts).toBeGreaterThan(2)
    c1.close()
    c2.close()
  })
})
