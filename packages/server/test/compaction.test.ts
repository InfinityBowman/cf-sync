import { env, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { TestClient } from './harness'

/**
 * Compaction contract (DESIGN.md D8): tombstones behind the retention horizon
 * are hard-deleted; min_cursor_version advances to the youngest deleted
 * tombstone. Clients at or past the horizon still get valid deltas; clients
 * behind it re-bootstrap via clear + snapshot. The fixture's CompactingDO uses
 * tombstoneRetentionVersions: 0, so every tombstone compacts when the alarm
 * fires.
 */

const PREFIX = '/compact'

async function compact(workspaceId: string): Promise<void> {
  const stub = env.COMPACT.get(env.COMPACT.idFromName(workspaceId))
  const ran = await runDurableObjectAlarm(stub)
  expect(ran).toBe(true)
}

describe('tombstone compaction', () => {
  it('a client behind the horizon is reset; one at the horizon gets deltas', async () => {
    const workspace = `compact-${Date.now()}`
    const writer = await TestClient.connect(workspace, 'writer', PREFIX)
    await writer.syncOnce()

    // v1..v3: three rows.
    writer.push([
      { id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { n: 1 } } },
      { id: 2, name: 'sync.put', args: { tbl: 'todos', id: 't2', data: { n: 2 } } },
      { id: 3, name: 'sync.put', args: { tbl: 'todos', id: 't3', data: { n: 3 } } },
    ])
    await writer.pokeUntilLmid(3)

    // A straggler last saw v3 (before any deletes exist).
    const straggler = await TestClient.connect(workspace, 'straggler', PREFIX)
    await straggler.syncOnce()
    expect(straggler.cursor!.version).toBe(3)
    straggler.close()

    // v4: delete t2 (tombstone). The writer sees it; the straggler is gone.
    writer.push([{ id: 4, name: 'sync.del', args: { tbl: 'todos', id: 't2' } }])
    await writer.pokeUntilLmid(4)
    expect(writer.cursor!.version).toBe(4)

    await compact(workspace)

    // The writer's cursor (v4) sits exactly at the horizon: still valid.
    await writer.reconnect()
    const writerCatchUp = await writer.syncOnce()
    expect(writerCatchUp.baseCursor).toEqual({ backendId: writer.cursor!.backendId, version: 4 })
    expect(writerCatchUp.patch).toEqual([])

    // The straggler (v3) predates the deleted tombstone: forced re-bootstrap.
    const back = await TestClient.connect(workspace, 'straggler', PREFIX)
    back.cursor = { backendId: writer.cursor!.backendId, version: 3 }
    const reset = await back.syncOnce()
    expect(reset.baseCursor).toBeNull()
    expect(reset.patch[0]).toEqual({ op: 'clear' })
    expect([...back.rows.keys()].sort()).toEqual(['todos/t1', 'todos/t3'])

    writer.close()
    back.close()
  })

  it('compaction with no tombstones behind the horizon changes nothing', async () => {
    const workspace = `compact-noop-${Date.now()}`
    const writer = await TestClient.connect(workspace, 'writer', PREFIX)
    await writer.syncOnce()
    writer.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { n: 1 } } }])
    await writer.pokeUntilLmid(1)

    await compact(workspace)

    // Cursor v0 (older than everything) is still valid: nothing was discarded.
    const reader = await TestClient.connect(workspace, 'reader', PREFIX)
    reader.cursor = { backendId: writer.cursor!.backendId, version: 0 }
    const catchUp = await reader.syncOnce()
    expect(catchUp.baseCursor).not.toBeNull()
    expect(catchUp.patch).toEqual([{ op: 'put', tbl: 'todos', id: 't1', value: { n: 1 } }])
    writer.close()
    reader.close()
  })
})
