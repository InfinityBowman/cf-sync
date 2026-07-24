import { env, evictDurableObject, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { TestClient } from './harness'

// A workspace whose stored state cannot be loaded (here: a schema version
// that predates numeric versions) must not brick its own remedy: the error
// message tells the operator to reset, so admin reset stays reachable while
// everything else answers with the failure.

const admin = (workspace: string, op: string, method: 'GET' | 'POST' = 'GET') =>
  SELF.fetch(`https://test/admin/${encodeURIComponent(workspace)}/${op}`, {
    method,
    headers: { 'x-test-admin': 'yes' },
  })

describe('initialization failure', () => {
  it('serves only admin reset, which heals the workspace', async () => {
    const workspace = `init-fail-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { n: 1 } } }])
    await c1.pokeUntilLmid(1)
    c1.close()

    // Corrupt the stored version the way pre-numeric workspaces are, then
    // evict so the next wake re-runs initialization against it.
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspace))
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE meta SET schema_version = 'demo-1' WHERE id = 1`)
    })
    await evictDurableObject(stub, { webSockets: 'close' })

    // Upgrades fail as plain HTTP; the client keeps its paced reconnect.
    await expect(TestClient.connect(workspace, 'c1')).rejects.toThrow('upgrade failed: 503')

    // Other admin ops answer with the why instead of a blind exception.
    const stats = await admin(workspace, 'stats')
    expect(stats.status).toBe(500)
    expect(((await stats.json()) as { error: string }).error).toContain('not a positive integer')

    // The remedy itself works — and everything is normal again after it.
    const reset = await admin(workspace, 'reset', 'POST')
    expect(reset.status).toBe(200)
    const { backendId } = (await reset.json()) as { backendId: string }
    expect(backendId).toBeTruthy()

    const c2 = await TestClient.connect(workspace, 'c1')
    const boot = await c2.syncOnce()
    expect(boot.patch).toEqual([{ op: 'clear' }]) // fresh history, no rows
    expect(c2.cursor!.backendId).toBe(backendId)
    c2.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { n: 2 } } }])
    await c2.pokeUntilLmid(1)
    expect(c2.rows.get('todos/t1')).toEqual({ n: 2 })

    // The workspace name survived the heal (recovered from the routing header).
    const healed = await admin(workspace, 'stats')
    expect(((await healed.json()) as { workspaceId: string }).workspaceId).toBe(workspace)
    c2.close()
  })
})
