import { env, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { rolloutConfig } from './fixture/worker'
import { TestClient } from './harness'

/**
 * The schema-version rollout drill (DESIGN.md §9, §12 M3): prove every link
 * in the upgrade chain. A "deploy" is simulated by mutating the shared
 * rolloutConfig and evicting the DO, so the next wake constructs against the
 * new version — the same sequence a real worker deploy produces.
 */

async function evict(workspaceId: string): Promise<void> {
  const stub = env.ROLLOUT.get(env.ROLLOUT.idFromName(workspaceId))
  await runInDurableObject(stub, async (_instance, state) => {
    state.abort()
  }).catch(() => {
    // abort() kills the object; the call itself is expected to fail
  })
}

async function queryLog(workspaceId: string, sql: string): Promise<Record<string, unknown>[]> {
  const stub = env.ROLLOUT.get(env.ROLLOUT.idFromName(workspaceId))
  return runInDurableObject(stub, async (_instance, state) => state.storage.sql.exec(sql).toArray())
}

function connect(workspaceId: string, clientId: string, schemaVersion = 'test-1'): Promise<TestClient> {
  return TestClient.connect(workspaceId, clientId, '/rollout').then((c) => {
    c.schemaVersion = schemaVersion
    return c
  })
}

afterEach(() => {
  rolloutConfig.schemaVersion = 'test-1'
  delete rolloutConfig.migrateSchema
})

describe('schema-version rollout', () => {
  it('runs the full drill: reject old clients, migrate rows once, keep LMIDs', async () => {
    const workspace = `rollout-${Date.now()}`

    // --- life under schema v1 -----------------------------------------------
    const c1 = await connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([
      { id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'ship it' } } },
      { id: 2, name: 'sync.put', args: { tbl: 'todos', id: 't2', data: { title: 'test it' } } },
    ])
    await c1.pokeUntilLmid(2)
    const v1Cursor = c1.cursor!
    const backendId = v1Cursor.backendId

    // --- "deploy v2": title -> text, plus a new field -----------------------
    const seen: { from: string; to: string }[] = []
    rolloutConfig.schemaVersion = 'test-2'
    rolloutConfig.migrateSchema = (tx, versions) => {
      seen.push(versions)
      for (const { id, data } of tx.list('todos')) {
        tx.put('todos', id, { text: data.title, done: false })
      }
    }
    await evict(workspace)

    // Old-schema clients are rejected at hello.
    await c1.reconnect()
    c1.hello()
    const rejection = await c1.next()
    expect(rejection).toMatchObject({ type: 'error', code: 'VersionNotSupported' })

    // The migration ran exactly once, with the right version pair.
    expect(seen).toEqual([{ from: 'test-1', to: 'test-2' }])

    // A new-schema client presenting a pre-migration cursor is forced to
    // re-bootstrap (min_cursor_version advanced past it) and sees migrated
    // rows on the SAME history — same backendId, version advanced by one.
    const c2 = await connect(workspace, 'c1', 'test-2')
    c2.cursor = v1Cursor
    c2.lmid = 0 // fresh session: cache was discarded with the old schema
    const boot = await c2.syncOnce()
    expect(boot.baseCursor).toBeNull()
    expect(boot.patch[0]).toEqual({ op: 'clear' })
    expect(c2.rows.get('todos/t1')).toEqual({ text: 'ship it', done: false })
    expect(c2.rows.get('todos/t2')).toEqual({ text: 'test it', done: false })
    expect(c2.cursor).toEqual({ backendId, version: v1Cursor.version + 1 })

    // LMIDs survive: hello re-confirmed lmid 2 for this clientId, so the
    // sequence continues at 3 — replayed old ids would still dedupe.
    expect(boot.lastMutationIdChanges).toEqual({ c1: 2 })
    expect(c2.lmid).toBe(2)
    c2.push([{ id: 3, name: 'sync.put', args: { tbl: 'todos', id: 't3', data: { text: 'new world', done: false } } }])
    await c2.pokeUntilLmid(3)

    // The log carries the audit entry, exactly one.
    const audits = await queryLog(workspace, `SELECT name, args FROM mutation_log WHERE name = '$schema.migrate'`)
    expect(audits).toEqual([{ name: '$schema.migrate', args: JSON.stringify({ from: 'test-1', to: 'test-2' }) }])

    // A plain restart on the new version must NOT migrate again.
    await evict(workspace)
    await c2.reconnect()
    const catchUp = await c2.syncOnce()
    expect(catchUp.baseCursor).toEqual(c2.cursor)
    expect(catchUp.patch).toEqual([])
    expect(seen).toHaveLength(1)
    c1.close()
    c2.close()
  })

  it('restamps without a hook: additive changes keep cursors valid', async () => {
    const workspace = `rollout-add-${Date.now()}`
    const c1 = await connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'x' } } }])
    await c1.pokeUntilLmid(1)
    const oldCursor = c1.cursor!

    rolloutConfig.schemaVersion = 'test-2' // no migrateSchema: additive change
    await evict(workspace)

    // No rows were rewritten, so a pre-deploy cursor still catches up cleanly
    // (matters for clients whose local cache validity is not schema-keyed).
    const c2 = await connect(workspace, 'c2', 'test-2')
    c2.cursor = oldCursor
    const catchUp = await c2.syncOnce()
    expect(catchUp.baseCursor).toEqual(oldCursor)
    expect(catchUp.patch).toEqual([])
    c1.close()
    c2.close()
  })

  it('a throwing migration aborts initialization and retries next wake', async () => {
    const workspace = `rollout-fail-${Date.now()}`
    const c1 = await connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'precious' } } }])
    await c1.pokeUntilLmid(1)
    c1.close()

    rolloutConfig.schemaVersion = 'test-2'
    rolloutConfig.migrateSchema = () => {
      throw new Error('migration bug')
    }
    await evict(workspace)

    // The DO refuses to serve rather than serving old-shaped data as v2.
    await expect(connect(workspace, 'c2', 'test-2')).rejects.toThrow()

    // "Deploy the fix": the retry migrates and everything is intact.
    rolloutConfig.migrateSchema = (tx) => {
      for (const { id, data } of tx.list('todos')) {
        tx.put('todos', id, { text: data.title, done: false })
      }
    }
    await evict(workspace)
    const c2 = await connect(workspace, 'c2', 'test-2')
    const boot = await c2.syncOnce()
    expect(c2.rows.get('todos/t1')).toEqual({ text: 'precious', done: false })
    expect(boot.lastMutationIdChanges).toEqual({ c2: 0 })
    c2.close()
  })
})
