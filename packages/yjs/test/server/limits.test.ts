import {
  FIELD_MSG_REJECT,
  FIELD_MSG_STATE,
  FIELD_MSG_UPDATE,
  MAX_FIELD_BYTES,
  MAX_FIELD_UPDATE_BYTES,
  decodeFieldReject,
  decodeFieldState,
} from '@cf-sync/protocol'
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

/** Types `chars` ascii chars into the doc and sends the update; returns its size. */
function typeChunk(client: FieldTestClient, fieldId: string, doc: Y.Doc, chars: number): number {
  const text = doc.getText('t')
  const update = edit(doc, () => text.insert(text.length, 'x'.repeat(chars)))
  client.update(fieldId, update)
  return update.byteLength
}

describe('transport frame guard and field ceiling (§17.3)', () => {
  it('an update over MAX_FIELD_UPDATE_BYTES gets a TooLarge REJECT, the socket stays open, and the in-flight tail is refused', async () => {
    const workspace = `y-large-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const doc = new Y.Doc()
    // A paste bigger than the frame guard, then two keystrokes sent before
    // the REJECT could possibly arrive — the poison window.
    const paste = edit(doc, () => doc.getText('t').insert(0, 'p'.repeat(MAX_FIELD_UPDATE_BYTES + 100)))
    expect(paste.byteLength).toBeGreaterThan(MAX_FIELD_UPDATE_BYTES)
    a.update('notes:1', paste)
    a.update('notes:1', edit(doc, () => doc.getText('t').insert(0, 'k1 ')))
    a.update('notes:1', edit(doc, () => doc.getText('t').insert(0, 'k2 ')))

    const reject = await a.nextFrame()
    expect(reject.msgType).toBe(FIELD_MSG_REJECT)
    expect(decodeFieldReject(reject.payload)).toBe('TooLarge')
    await a.expectNoFrame() // exactly one REJECT; the tail is dropped silently
    expect(a.closeEvent).toBeNull()

    // The server-side collapse kept the log gapless: nothing landed, so a
    // fresh reader sees an empty field instead of a truncated one.
    const b = await FieldTestClient.ready(workspace, 'b')
    b.get('notes:1')
    const state = decodeFieldState((await b.nextFrame()).payload)!
    const fresh = new Y.Doc()
    if (state.diff.byteLength > 2) applyRemote(fresh, state.diff)
    expect(fresh.getText('t').toString()).toBe('')

    // Other fields from the same socket still apply.
    const doc2 = new Y.Doc()
    a.update('notes:2', edit(doc2, () => doc2.getText('t').insert(0, 'fine')))
    const relayed = await b.nextFrame()
    expect(relayed.msgType).toBe(FIELD_MSG_UPDATE)
    expect(relayed.fieldId).toBe('notes:2')
    a.close()
    b.close()
  })

  it('crossing MAX_FIELD_BYTES accepts the crossing update, freezes the field, and the freeze survives a wake', async () => {
    const workspace = `y-freeze-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const b = await FieldTestClient.ready(workspace, 'b')
    const doc = new Y.Doc()

    const CHUNK = 60_000
    let sent = 0
    let updates = 0
    while (sent <= MAX_FIELD_BYTES) {
      sent += typeChunk(a, 'big:1', doc, CHUNK)
      updates++
    }
    // The crossing update was accepted and relayed — peers converge on the
    // intact content rather than diverging at the ceiling.
    const docB = new Y.Doc()
    for (let i = 0; i < updates; i++) {
      const frame = await b.nextFrame(5_000)
      expect(frame.msgType).toBe(FIELD_MSG_UPDATE)
      applyRemote(docB, frame.payload)
    }
    expect(docB.getText('t').length).toBe(doc.getText('t').length)

    // The next update is refused: the field is frozen.
    a.update('big:1', edit(doc, () => doc.getText('t').insert(0, 'one more')))
    const reject = await a.nextFrame()
    expect(reject.msgType).toBe(FIELD_MSG_REJECT)
    expect(decodeFieldReject(reject.payload)).toBe('Frozen')

    // A fresh GET reports read-only, and — because `frozen` is a persisted
    // column — still does after eviction wipes all in-memory state.
    const before = await FieldTestClient.ready(workspace, 'before')
    before.get('big:1')
    expect(decodeFieldState((await before.nextFrame(5_000)).payload)!.writable).toBe(false)
    before.close()

    a.close()
    b.close()
    await evict(env.WORKSPACE, workspace)

    const after = await FieldTestClient.ready(workspace, 'after')
    after.get('big:1')
    expect(decodeFieldState((await after.nextFrame(5_000)).payload)!.writable).toBe(false)
    after.close()
  }, 30_000)

  it('compaction reconciles the over-estimating byte_total to the true encoded size', async () => {
    const workspace = `y-reconcile-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a', '/compact')
    const doc = new Y.Doc()
    // Insert-then-delete churn below the ceiling: the byte log (~300KB) far
    // exceeds what the materialized doc encodes to after the delete.
    let logged = 0
    for (let i = 0; i < 5; i++) logged += typeChunk(a, 'churn:1', doc, 60_000)
    const text = doc.getText('t')
    a.update('churn:1', edit(doc, () => text.delete(0, text.length - 5)))
    await a.expectNoFrame() // no refusal: well under the ceiling

    const stub = env.COMPACT.get(env.COMPACT.idFromName(workspace))
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ byte_total: number; frozen: number }>(
          `SELECT byte_total, frozen FROM yjs_fields WHERE field_id = 'churn:1'`,
        )
        .one()
      // Reconciled to the encoded snapshot: a fraction of the 300KB log.
      expect(Number(row.byte_total)).toBeGreaterThan(0)
      expect(Number(row.byte_total)).toBeLessThan(logged / 10)
      expect(Number(row.frozen)).toBe(0)
      const pending = state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM yjs_updates`).one()
      expect(Number(pending.n)).toBe(0)
    })

    // Content round-trips byte-for-byte through the snapshot.
    const b = await FieldTestClient.ready(workspace, 'b', '/compact')
    b.get('churn:1')
    const state = decodeFieldState((await b.nextFrame()).payload)!
    const docB = new Y.Doc()
    applyRemote(docB, state.diff)
    expect(docB.getText('t').toString()).toBe(doc.getText('t').toString())
    a.close()
    b.close()
  }, 30_000)
})
