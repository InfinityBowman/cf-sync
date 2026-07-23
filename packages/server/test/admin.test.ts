import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { TestClient } from './harness'

/** Admin surface (M2): stats, export/import snapshots, reset. */

const AUTH = { 'x-test-admin': 'yes' }

async function admin(
  workspaceId: string,
  op: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  return SELF.fetch(`https://test/admin/${workspaceId}/${op}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.headers ?? AUTH), ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : null,
  })
}

async function seed(workspace: string): Promise<TestClient> {
  const c1 = await TestClient.connect(workspace, 'c1')
  await c1.syncOnce()
  c1.push([
    { id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'a' } } },
    { id: 2, name: 'sync.put', args: { tbl: 'todos', id: 't2', data: { title: 'b' } } },
    { id: 3, name: 'sync.del', args: { tbl: 'todos', id: 't2' } },
  ])
  await c1.pokeUntilLmid(3)
  return c1
}

describe('admin authorization', () => {
  it('rejects unauthorized and unknown operations', async () => {
    expect((await admin('w', 'stats', { headers: { 'x-test-admin': 'no' } })).status).toBe(403)
    expect((await admin('w', 'destroy')).status).toBe(404)
    expect((await admin('w', 'reset', { method: 'GET' })).status).toBe(405)
  })
})

describe('import validation', () => {
  it('rejects snapshots whose rows fail the schema', async () => {
    const workspace = `import-invalid-${Date.now()}`
    const res = await admin(workspace, 'import', {
      method: 'POST',
      body: {
        formatVersion: 1,
        schemaVersion: 1,
        rows: [{ tbl: 'typed', id: 'x', data: { n: 'not-a-number' } }],
      },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid row typed\/x/)
  })
})

describe('stats', () => {
  it('reports gauges and counters', async () => {
    const workspace = `stats-${Date.now()}`
    const c1 = await seed(workspace)
    const stats = (await (await admin(workspace, 'stats')).json()) as any
    expect(stats).toMatchObject({
      workspaceId: workspace,
      schemaVersion: 1,
      currentVersion: 3,
      rows: { live: 1, tombstones: 1 },
      mutationLogEntries: 3,
      knownClients: 1,
    })
    expect(stats.backendId).toBeTruthy()
    expect(stats.databaseSizeBytes).toBeGreaterThan(0)
    expect(stats.connections.ready).toBe(1)
    expect(stats.counters).toMatchObject({ pushes: 1, mutationsApplied: 3 })
    c1.close()
  })
})

describe('export and import', () => {
  it('round-trips a workspace snapshot into another workspace', async () => {
    const source = `exp-${Date.now()}`
    const c1 = await seed(source)

    const snapshot = (await (await admin(source, 'export')).json()) as any
    expect(snapshot).toMatchObject({ formatVersion: 1, schemaVersion: 1, version: 3 })
    expect(snapshot.rows).toEqual([{ tbl: 'todos', id: 't1', data: { title: 'a' } }])

    // Import into a different workspace that already has data + a live client.
    const target = `imp-${Date.now()}`
    const c2 = await TestClient.connect(target, 'c2')
    await c2.syncOnce()
    c2.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 'old', data: { title: 'stale' } } }])
    await c2.pokeUntilLmid(1)

    const result = (await (await admin(target, 'import', { method: 'POST', body: snapshot })).json()) as any
    expect(result).toMatchObject({ imported: 1, version: 2 })

    // The connected client converges through the reset poke alone.
    await c2.pokeUntilVersion(2)
    expect([...c2.rows.entries()]).toEqual([['todos/t1', { title: 'a' }]])

    // Stale cursors (pre-import) are behind min_cursor_version: fresh bootstrap.
    const c3 = await TestClient.connect(target, 'c3')
    c3.cursor = { backendId: c2.cursor!.backendId, version: 1 }
    const reset = await c3.syncOnce()
    expect(reset.baseCursor).toBeNull()
    expect(c3.rows).toEqual(c2.rows)

    c1.close()
    c2.close()
    c3.close()
  })

  it('rejects snapshots from a different schema version', async () => {
    const res = await admin(`imp-bad-${Date.now()}`, 'import', {
      method: 'POST',
      body: { formatVersion: 1, schemaVersion: 999, rows: [] },
    })
    expect(res.status).toBe(400)
  })
})

describe('reset', () => {
  it('starts a new history and converges connected clients', async () => {
    const workspace = `reset-${Date.now()}`
    const c1 = await seed(workspace)
    const oldBackendId = c1.cursor!.backendId

    const result = (await (await admin(workspace, 'reset', { method: 'POST' })).json()) as any
    expect(result.backendId).toBeTruthy()
    expect(result.backendId).not.toBe(oldBackendId)

    // The live client receives the clear poke and lands on the new history.
    const poke = await c1.nextPoke()
    expect(poke.patch).toEqual([{ op: 'clear' }])
    expect(c1.rows.size).toBe(0)
    expect(c1.cursor).toEqual({ backendId: result.backendId, version: 0 })

    // The client can immediately write into the new history (fresh LMIDs).
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 'new', data: { title: 'post-reset' } } }])
    await c1.pokeUntilVersion(1)
    expect(c1.rows.get('todos/new')).toEqual({ title: 'post-reset' })
    c1.close()
  })
})
