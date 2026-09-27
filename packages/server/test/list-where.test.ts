import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { TestClient } from './harness'

let n = 0
const ws = () => `where-${++n}-${Date.now()}`

// The SQL prefilter in SqlRowStore is looser than `===` (a JSON true extracts
// as 1, a null as a missing key); the WriteSet's re-check must make the
// result exact. These cases run against real DO SQLite.

async function seeded() {
  const c1 = await TestClient.connect(ws(), 'c1')
  await c1.syncOnce()
  const rows: Record<string, Record<string, unknown>> = {
    t_true: { flag: true, n: 1, s: 'a' },
    t_one: { flag: 1, n: 1, s: 'a' },
    t_str1: { flag: '1', n: '1', s: 'b' },
    t_false: { flag: false, n: 0, s: 'A' },
    t_null: { flag: null, n: null, s: '' },
    t_missing: { s: 'b' },
    'odd key': { 'a-b': 'x', s: 'a' },
  }
  let id = 0
  c1.push(
    Object.entries(rows).map(([rowId, data]) => ({
      id: ++id,
      name: 'sync.put',
      args: { tbl: 'todos', id: rowId, data },
    })),
  )
  await c1.pokeUntilLmid(id)
  const echo = async (where: Record<string, unknown>): Promise<string[]> => {
    c1.push([{ id: ++id, name: 'where.echo', args: { into: 'out', where } }])
    await c1.pokeUntilLmid(id)
    return c1.rows.get('counters/out')!.ids as string[]
  }
  return { c1, echo }
}

describe('tx.list where against SQLite', () => {
  it('booleans, numbers, and strings do not cross-match', async () => {
    const { c1, echo } = await seeded()
    expect(await echo({ flag: true })).toEqual(['t_true'])
    expect(await echo({ flag: 1 })).toEqual(['t_one'])
    expect(await echo({ flag: '1' })).toEqual(['t_str1'])
    expect(await echo({ flag: false })).toEqual(['t_false'])
    expect(await echo({ n: 0 })).toEqual(['t_false'])
    expect(await echo({ s: 'a' })).toEqual(['odd key', 't_one', 't_true'])
    expect(await echo({ s: 'A' })).toEqual(['t_false'])
    expect(await echo({ s: '' })).toEqual(['t_null'])
    c1.close()
  })

  it('null matches a stored null, not a missing key', async () => {
    const { c1, echo } = await seeded()
    expect(await echo({ flag: null })).toEqual(['t_null'])
    expect(await echo({ n: null, s: '' })).toEqual(['t_null'])
    c1.close()
  })

  it('non-identifier keys and several clauses still match exactly', async () => {
    const { c1, echo } = await seeded()
    expect(await echo({ 'a-b': 'x' })).toEqual(['odd key'])
    expect(await echo({ flag: true, n: 1, s: 'a' })).toEqual(['t_true'])
    expect(await echo({ flag: true, s: 'b' })).toEqual([])
    c1.close()
  })
})

describe('filter indexes', () => {
  const plan = (workspace: string, sql: string) =>
    runInDurableObject(env.WORKSPACE.get(env.WORKSPACE.idFromName(workspace)), async (_instance, state) => ({
      indexes: state.storage.sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'rows_where_%'`)
        .toArray()
        .map((r) => r.name),
      plan: state.storage.sql
        .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
        .toArray()
        .map((r) => r.detail)
        .join(' | '),
    }))

  it('a filtered list creates a partial index the same query then uses, and admin reset rebuilds it', async () => {
    const workspace = ws()
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()
    let id = 0
    c1.push([
      { id: ++id, name: 'sync.put', args: { tbl: 'todos', id: 'a', data: { s: 'x' } } },
      { id: ++id, name: 'sync.put', args: { tbl: 'todos', id: 'b', data: { s: 'y' } } },
      { id: ++id, name: 'where.echo', args: { into: 'out', where: { s: 'x' } } },
    ])
    await c1.pokeUntilLmid(id)
    expect(c1.rows.get('counters/out')!.ids).toEqual(['a'])

    const query = `SELECT id, data FROM rows WHERE tbl = 'todos' AND deleted = 0 AND json_extract(data, '$.s') = 'x'`
    const before = await plan(workspace, query)
    expect(before.indexes).toHaveLength(1)
    expect(before.plan).toContain(before.indexes[0])

    const reset = await SELF.fetch(`https://test/admin/${workspace}/reset`, {
      method: 'POST',
      headers: { 'x-test-admin': 'yes' },
    })
    expect(reset.status).toBe(200)
    await c1.nextPoke()
    expect((await plan(workspace, query)).indexes).toEqual([])

    c1.lmid = 0
    id = 0
    c1.push([
      { id: ++id, name: 'sync.put', args: { tbl: 'todos', id: 'c', data: { s: 'x' } } },
      { id: ++id, name: 'where.echo', args: { into: 'out', where: { s: 'x' } } },
    ])
    await c1.pokeUntilLmid(id)
    expect(c1.rows.get('counters/out')!.ids).toEqual(['c'])
    expect((await plan(workspace, query)).indexes).toHaveLength(1)
    c1.close()
  })
})
