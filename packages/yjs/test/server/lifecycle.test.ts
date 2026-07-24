import { FIELD_MSG_STATE, FIELD_MSG_UPDATE, decodeFieldState } from '@cf-sync/protocol/internal'
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { FieldTestClient, applyRemote, edit } from './harness'

async function evict(namespace: DurableObjectNamespace, workspaceId: string): Promise<void> {
  const stub = namespace.get(namespace.idFromName(workspaceId))
  await runInDurableObject(stub, async (_instance, state) => {
    state.abort()
  }).catch(() => {
    // abort() kills the object; the call itself is expected to fail
  })
}

async function readFieldText(client: FieldTestClient, fieldId: string): Promise<string> {
  client.get(fieldId)
  const frame = await client.nextFrame()
  expect(frame.msgType).toBe(FIELD_MSG_STATE)
  const state = decodeFieldState(frame.payload)!
  const doc = new Y.Doc()
  if (state.diff.byteLength > 2) applyRemote(doc, state.diff)
  return doc.getText('t').toString()
}

describe('field lifecycle across crashes and corruption (§17.4/17.6)', () => {
  it('eviction mid-session converges, including updates typed while disconnected', async () => {
    const workspace = `y-evict-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const docA = new Y.Doc()
    a.update('notes:1', edit(docA, () => docA.getText('t').insert(0, 'before ')))
    // Give the frame a beat to land before killing the object.
    expect(await readFieldText(a, 'notes:1')).toBe('before ')

    await evict(env.WORKSPACE, workspace)
    // Typed while the DO was gone (socket dead, client offline).
    docA.getText('t').insert(7, 'during ')
    docA.getText('t').insert(14, 'after')

    // Reconnect: GET with the current state vector, push back the gap.
    await a.reconnectReady()
    a.get('notes:1', docA)
    const state = decodeFieldState((await a.nextFrame()).payload)!
    applyRemote(docA, state.diff) // nothing new expected, but keep the flow honest
    const pushBack = Y.encodeStateAsUpdate(docA, state.stateVector)
    expect(pushBack.byteLength).toBeGreaterThan(2)
    a.update('notes:1', pushBack)

    const b = await FieldTestClient.ready(workspace, 'b')
    expect(await readFieldText(b, 'notes:1')).toBe('before during after')
    a.close()
    b.close()
  })

  it('a corrupt update row is skipped, the doc still loads, and a syncing client repairs the gap', async () => {
    const workspace = `y-corrupt-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const docA = new Y.Doc()
    a.update('notes:1', edit(docA, () => docA.getText('t').insert(0, 'one ')))
    a.update('notes:1', edit(docA, () => docA.getText('t').insert(4, 'two ')))
    a.update('notes:1', edit(docA, () => docA.getText('t').insert(8, 'three')))
    expect(await readFieldText(a, 'notes:1')).toBe('one two three')

    // Corrupt the middle row on disk, then crash the object so no cached
    // doc can paper over it.
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspace))
    await runInDurableObject(stub, async (_instance, state) => {
      const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
      state.storage.sql.exec(
        `UPDATE yjs_updates SET bytes = ? WHERE field_id = 'notes:1' AND seq = 2`,
        garbage.buffer.slice(0),
      )
    })
    await evict(env.WORKSPACE, workspace)

    // A fresh reader sees the field truncated at the gap — skipped and
    // logged, never guessed — and the DO did not throw.
    const b = await FieldTestClient.ready(workspace, 'b')
    expect(await readFieldText(b, 'notes:1')).toBe('one ')

    // Any client still holding the lost ops re-uploads them through the
    // push-back leg (not just the one that produced them — but here it is).
    await a.reconnectReady()
    a.get('notes:1', docA)
    const state = decodeFieldState((await a.nextFrame()).payload)!
    const pushBack = Y.encodeStateAsUpdate(docA, state.stateVector)
    expect(pushBack.byteLength).toBeGreaterThan(2)
    a.update('notes:1', pushBack)

    // B receives the repair as an ordinary relay; the server is whole again.
    const relay = await b.nextFrame()
    expect(relay.msgType).toBe(FIELD_MSG_UPDATE)
    const c = await FieldTestClient.ready(workspace, 'c')
    expect(await readFieldText(c, 'notes:1')).toBe('one two three')
    a.close()
    b.close()
    c.close()
  })

  it('an UPDATE arriving while the doc sits in the LRU keeps the cache log-coherent', async () => {
    const workspace = `y-lru-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a', '/compact') // maxCachedDocs: 2
    const docA = new Y.Doc()
    a.update('hot:1', edit(docA, () => docA.getText('t').insert(0, 'first ')))
    // GET loads (and caches) the doc...
    expect(await readFieldText(a, 'hot:1')).toBe('first ')
    // ...an update lands while it is cached...
    a.update('hot:1', edit(docA, () => docA.getText('t').insert(6, 'second')))
    // ...and a GET served right after returns the complete diff.
    expect(await readFieldText(a, 'hot:1')).toBe('first second')

    // Flood the 2-slot LRU so hot:1 evicts, then write again: the reload
    // path (snapshot + tail) must also be complete.
    const docB = new Y.Doc()
    const docC = new Y.Doc()
    a.update('cold:1', edit(docB, () => docB.getText('t').insert(0, 'b')))
    a.update('cold:2', edit(docC, () => docC.getText('t').insert(0, 'c')))
    expect(await readFieldText(a, 'cold:1')).toBe('b')
    expect(await readFieldText(a, 'cold:2')).toBe('c')
    a.update('hot:1', edit(docA, () => docA.getText('t').insert(12, ' third')))
    expect(await readFieldText(a, 'hot:1')).toBe('first second third')
    a.close()
  })

  it('compaction round-trips content byte-for-byte (encode → compact → load → same state)', async () => {
    const workspace = `y-compact-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a', '/compact') // compactionThreshold: 3
    const doc = new Y.Doc()
    for (const word of ['alpha ', 'beta ', 'gamma ', 'delta ', 'epsilon']) {
      a.update('notes:1', edit(doc, () => doc.getText('t').insert(doc.getText('t').length, word)))
    }
    const before = doc.getText('t').toString()
    const stateBefore = Y.encodeStateVector(doc)
    // Round-trip barrier: frames are FIFO per socket, so a served GET means
    // every update above has been appended — the alarm must not race them.
    expect(await readFieldText(a, 'notes:1')).toBe(before)

    const stub = env.COMPACT.get(env.COMPACT.idFromName(workspace))
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    await runInDurableObject(stub, async (_instance, state) => {
      const pending = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM yjs_updates WHERE field_id = 'notes:1'`)
        .one()
      expect(Number(pending.n)).toBe(0)
      const field = state.storage.sql
        .exec<{ snapshot: ArrayBuffer | null; snapshot_seq: number }>(
          `SELECT snapshot, snapshot_seq FROM yjs_fields WHERE field_id = 'notes:1'`,
        )
        .one()
      expect(field.snapshot).not.toBeNull()
      expect(Number(field.snapshot_seq)).toBe(5)
    })

    // Kill the cache too: the snapshot alone must rebuild the doc.
    await evict(env.COMPACT, workspace)
    const b = await FieldTestClient.ready(workspace, 'b', '/compact')
    b.get('notes:1')
    const state = decodeFieldState((await b.nextFrame()).payload)!
    const rebuilt = new Y.Doc()
    applyRemote(rebuilt, state.diff)
    expect(rebuilt.getText('t').toString()).toBe(before)
    expect([...Y.encodeStateVector(rebuilt)]).toEqual([...stateBefore])

    // New updates append after the snapshot seq and still converge.
    b.update('notes:1', (() => {
      const d = rebuilt
      return edit(d, () => d.getText('t').insert(0, 'zeta '))
    })())
    expect(await readFieldText(b, 'notes:1')).toBe(`zeta ${before}`)
    a.close()
    b.close()
  })

  it('one field with a corrupt snapshot does not block the others from compacting', async () => {
    const workspace = `y-compact-iso-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a', '/compact') // compactionThreshold: 3
    const stub = env.COMPACT.get(env.COMPACT.idFromName(workspace))

    // Give 'bad' a snapshot to corrupt: cross the threshold and compact once.
    const badDoc = new Y.Doc()
    for (const word of ['one ', 'two ', 'three ', 'four']) {
      a.update('bad', edit(badDoc, () => badDoc.getText('t').insert(badDoc.getText('t').length, word)))
    }
    expect(await readFieldText(a, 'bad')).toBe('one two three four')
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    await runInDurableObject(stub, async (_instance, state) => {
      const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
      state.storage.sql.exec(`UPDATE yjs_fields SET snapshot = ? WHERE field_id = 'bad'`, garbage.buffer.slice(0))
    })

    // Both fields cross the threshold again; 'bad' sorts first, so with an
    // unisolated loop its throw would starve 'good' of compaction entirely.
    const goodDoc = new Y.Doc()
    for (const word of ['five ', 'six ', 'seven ', 'eight']) {
      a.update('bad', edit(badDoc, () => badDoc.getText('t').insert(badDoc.getText('t').length, word)))
      a.update('good', edit(goodDoc, () => goodDoc.getText('t').insert(goodDoc.getText('t').length, word)))
    }
    expect(await readFieldText(a, 'good')).toBe('five six seven eight')

    // The alarm completes rather than throwing out of the maintenance turn.
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    await runInDurableObject(stub, async (_instance, state) => {
      const count = (field: string) =>
        Number(
          state.storage.sql
            .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM yjs_updates WHERE field_id = ?`, field)
            .one().n,
        )
      expect(count('good')).toBe(0) // compacted despite 'bad'
      expect(count('bad')).toBe(4) // its transaction rolled back whole; the tail is intact
    })
    a.close()
  })
})
