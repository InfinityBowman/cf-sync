import { SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError, crudMutators, defineApp, type SchemaMigrationFn } from '../src/index'
import { rolloutApp, rolloutConfig, testSchema } from './fixture/worker'
import { TestClient } from './harness'

// Import accepts a snapshot from an older schema version and replays the
// migration chain over it in memory (ARCHITECTURE.md#schema-evolution) — the
// same steps a sleeping workspace runs on wake — so retained backups survive
// a version bump. Newer snapshots stay rejected; a broken chain leaves the
// workspace untouched.

const AUTH = { 'x-test-admin': 'yes', 'content-type': 'application/json' }

async function admin(workspaceId: string, op: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`https://test/rollout-admin/${workspaceId}/${op}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: AUTH,
    body: body === undefined ? null : JSON.stringify(body),
  })
}

/** Simulates deploying a new app bundle to the rollout DO class. */
function deploy(version: number, migrations: { [to: number]: SchemaMigrationFn | null } = {}): void {
  rolloutConfig.app = defineApp({ version, schema: testSchema, mutators: { ...crudMutators(testSchema) }, migrations })
}

const addDone: SchemaMigrationFn = (tx) => {
  for (const { id, data } of tx.list('todos')) tx.put('todos', id, { ...data, done: false })
}

const v1Snapshot = {
  formatVersion: 1,
  schemaVersion: 1,
  rows: [
    { tbl: 'todos', id: 't1', data: { title: 'a' } },
    { tbl: 'todos', id: 't2', data: { title: 'b' } },
  ],
}

afterEach(() => {
  rolloutConfig.app = rolloutApp
})

describe('import of an older snapshot', () => {
  it('replays the migration chain over the snapshot and reports the source version', async () => {
    deploy(3, { 2: addDone, 3: null })
    const workspace = `imp-mig-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/rollout')
    c1.schemaVersion = 3
    await c1.syncOnce()

    const result = (await (await admin(workspace, 'import', v1Snapshot)).json()) as Record<string, unknown>
    expect(result).toMatchObject({ imported: 2, version: 1, migratedFrom: 1 })

    await c1.pokeUntilVersion(1)
    expect(c1.rows.get('todos/t1')).toEqual({ title: 'a', done: false })
    expect(c1.rows.get('todos/t2')).toEqual({ title: 'b', done: false })
    c1.close()
  })

  it('a current-version snapshot imports as before, without migratedFrom', async () => {
    deploy(2, { 2: addDone })
    const workspace = `imp-cur-${Date.now()}`
    const result = (await (
      await admin(workspace, 'import', { ...v1Snapshot, schemaVersion: 2, rows: [{ tbl: 'todos', id: 't1', data: { title: 'a', done: true } }] })
    ).json()) as Record<string, unknown>
    expect(result).toEqual({ imported: 1, version: 1 })
  })

  it('still rejects a snapshot newer than the server', async () => {
    deploy(2, { 2: addDone })
    const res = await admin(`imp-new-${Date.now()}`, 'import', { ...v1Snapshot, schemaVersion: 3 })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'snapshot is schema version 3, server is 2' })
  })

  it('a missing migration step rejects and leaves the workspace untouched', async () => {
    deploy(3, { 3: null }) // no step for 1 -> 2
    const workspace = `imp-gap-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/rollout')
    c1.schemaVersion = 3
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 'keep', data: { title: 'mine' } } }])
    await c1.pokeUntilLmid(1)

    const res = await admin(workspace, 'import', v1Snapshot)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/^snapshot migration from version 1 failed: /)

    const stats = (await (await admin(workspace, 'stats')).json()) as { currentVersion: number; rows: { live: number } }
    expect(stats.currentVersion).toBe(1)
    expect(stats.rows.live).toBe(1)
    c1.close()
  })

  it('a throwing migration step rejects the same way', async () => {
    deploy(2, {
      2: () => {
        throw new AppError('Broken', 'cannot migrate this')
      },
    })
    const res = await admin(`imp-throw-${Date.now()}`, 'import', v1Snapshot)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'snapshot migration from version 1 failed: cannot migrate this' })
  })
})
