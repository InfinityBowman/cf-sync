import { env, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { TestClient } from './harness'

/**
 * R2 mutation-log export (DESIGN.md D3): the maintenance alarm ships log
 * entries past the export cursor as ndjson objects keyed by log_seq range.
 * The fixture uses maxBatchRows: 5 so multi-object runs are exercised.
 */

async function runAlarm(workspaceId: string): Promise<void> {
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId))
  expect(await runDurableObjectAlarm(stub)).toBe(true)
}

async function listExports(workspaceId: string): Promise<string[]> {
  const listed = await env.EXPORT_BUCKET.list({ prefix: `cf-sync/${workspaceId}/` })
  return listed.objects.map((o) => o.key).sort()
}

describe('r2 mutation-log export', () => {
  it('exports the log as ndjson and resumes from the cursor', async () => {
    const workspace = `export-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()

    // 7 mutations → batches of 5 + 2.
    const mutations = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      name: 'sync.put',
      args: { tbl: 'todos', id: `t${i + 1}`, data: { n: i + 1 } },
    }))
    c1.push(mutations)
    await c1.pokeUntilLmid(7)

    await runAlarm(workspace)

    const keys = await listExports(workspace)
    expect(keys).toEqual([
      `cf-sync/${workspace}/mutation-log/000000000001-000000000005.ndjson`,
      `cf-sync/${workspace}/mutation-log/000000000006-000000000007.ndjson`,
    ])

    const first = await env.EXPORT_BUCKET.get(keys[0]!)
    const lines = (await first!.text()).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(5)
    expect(lines[0]).toMatchObject({
      logSeq: 1,
      version: 1,
      clientId: 'c1',
      mutationId: 1,
      name: 'sync.put',
      result: 'ok',
    })
    expect(lines[0].createdAt).toMatch(/^\d{4}-/)

    // A second run with no new entries writes nothing.
    await runAlarm(workspace)
    expect(await listExports(workspace)).toHaveLength(2)

    // New mutations export from the cursor, not from the beginning.
    c1.push([{ id: 8, name: 'sync.del', args: { tbl: 'todos', id: 't1' } }])
    await c1.pokeUntilLmid(8)
    await runAlarm(workspace)
    const after = await listExports(workspace)
    expect(after).toHaveLength(3)
    expect(after[2]).toBe(`cf-sync/${workspace}/mutation-log/000000000008-000000000008.ndjson`)
    c1.close()
  })

  it('app errors appear in the exported log with their result', async () => {
    const workspace = `export-err-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'always.fails', args: {} }])
    await c1.pokeUntilLmid(1)

    await runAlarm(workspace)
    const keys = await listExports(workspace)
    const body = await (await env.EXPORT_BUCKET.get(keys[0]!))!.text()
    const entry = JSON.parse(body.trim())
    expect(entry).toMatchObject({
      name: 'always.fails',
      version: null, // no data effects
      result: { code: 'Nope' },
    })
    c1.close()
  })
})
