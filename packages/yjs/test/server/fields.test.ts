import {
  FIELD_MSG_GET,
  FIELD_MSG_STATE,
  FIELD_MSG_UPDATE,
  decodeFieldState,
  encodeFieldFrame,
} from '@cf-sync/protocol'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { FieldTestClient, applyRemote, edit, mulberry32 } from './harness'

async function readState(client: FieldTestClient, fieldId: string) {
  const frame = await client.nextFrame()
  expect(frame.msgType).toBe(FIELD_MSG_STATE)
  expect(frame.fieldId).toBe(fieldId)
  const state = decodeFieldState(frame.payload)
  expect(state).not.toBeNull()
  return state!
}

describe('field sync hot path (§17.3/17.4)', () => {
  it('GET on a nonexistent field returns an empty, writable STATE (implicit creation)', async () => {
    const a = await FieldTestClient.ready(`f-fresh-${Date.now()}`, 'a')
    a.get('never-written')
    const state = await readState(a, 'never-written')
    expect(state.writable).toBe(true)
    const doc = new Y.Doc()
    if (state.diff.byteLength > 2) applyRemote(doc, state.diff)
    expect(doc.getText('t').toString()).toBe('')
    a.close()
  })

  it('persist-then-relay: a relayed update is always readable back', async () => {
    const workspace = `f-relay-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const b = await FieldTestClient.ready(workspace, 'b')

    const docA = new Y.Doc()
    a.update('notes:1', edit(docA, () => docA.getText('t').insert(0, 'hello')))

    // B (never GETed) still receives the relay — no subscription tracking.
    const relayed = await b.nextFrame()
    expect(relayed.msgType).toBe(FIELD_MSG_UPDATE)
    expect(relayed.fieldId).toBe('notes:1')
    const docB = new Y.Doc()
    applyRemote(docB, relayed.payload)
    expect(docB.getText('t').toString()).toBe('hello')

    // Readable back immediately: persisted before the relay went out.
    b.get('notes:1')
    const state = await readState(b, 'notes:1')
    const docCheck = new Y.Doc()
    applyRemote(docCheck, state.diff)
    expect(docCheck.getText('t').toString()).toBe('hello')

    // The sender is excluded from its own relay.
    await a.expectNoFrame()
    a.close()
    b.close()
  })

  it('GET with a stale state vector returns exactly the missing diff', async () => {
    const workspace = `f-diff-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const docA = new Y.Doc()
    const first = edit(docA, () => docA.getText('t').insert(0, 'one '))
    a.update('notes:1', first)
    const second = edit(docA, () => docA.getText('t').insert(4, 'two'))
    a.update('notes:1', second)

    // A client that only holds the first update asks for the rest.
    const partial = new Y.Doc()
    applyRemote(partial, first)
    const b = await FieldTestClient.ready(workspace, 'b')
    b.get('notes:1', partial)
    const state = await readState(b, 'notes:1')
    applyRemote(partial, state.diff)
    expect(partial.getText('t').toString()).toBe('one two')

    // Exactly the missing ops: the diff alone cannot build the field —
    // applied to a fresh doc, the dependent ops park and no text appears.
    const fresh = new Y.Doc()
    applyRemote(fresh, state.diff)
    expect(fresh.getText('t').toString()).toBe('')
    a.close()
    b.close()
  })

  it('bidirectional sync: the STATE push-back leg re-uploads what the server is missing', async () => {
    const workspace = `f-push-${Date.now()}`
    // A typed while offline: its doc holds ops the server never saw.
    const docA = new Y.Doc()
    docA.getText('t').insert(0, 'offline edit')

    const a = await FieldTestClient.ready(workspace, 'a')
    a.get('notes:1', docA)
    const state = await readState(a, 'notes:1')
    expect(state.writable).toBe(true)
    // The client computes what the server's state vector is missing and
    // sends it back as an ordinary UPDATE (the add-on does this; the raw
    // harness mirrors it).
    const pushBack = Y.encodeStateAsUpdate(docA, state.stateVector)
    expect(pushBack.byteLength).toBeGreaterThan(2)
    a.update('notes:1', pushBack)

    const b = await FieldTestClient.ready(workspace, 'b')
    b.get('notes:1')
    const stateB = await readState(b, 'notes:1')
    const docB = new Y.Doc()
    applyRemote(docB, stateB.diff)
    expect(docB.getText('t').toString()).toBe('offline edit')
    a.close()
    b.close()
  })

  it('rejects binary frames before ready without touching storage', async () => {
    const workspace = `f-ready-${Date.now()}`
    const a = await FieldTestClient.connect(workspace, 'a') // no hello
    const doc = new Y.Doc()
    a.update('notes:1', edit(doc, () => doc.getText('t').insert(0, 'sneak')))
    a.get('notes:1')
    await a.expectNoFrame()

    // The socket is intact: hello still works, and the pre-ready update
    // never landed.
    await a.becomeReady()
    a.get('notes:1')
    const state = await readState(a, 'notes:1')
    const check = new Y.Doc()
    if (state.diff.byteLength > 2) applyRemote(check, state.diff)
    expect(check.getText('t').toString()).toBe('')
    a.close()
  })

  it('drops malformed binary frames and malformed updates; the socket stays open', async () => {
    const workspace = `f-malformed-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    a.sendRaw(new Uint8Array([0xff, 0xff, 0xff])) // not a field frame
    a.sendRaw(encodeFieldFrame(FIELD_MSG_UPDATE, 'notes:1', new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff])))
    a.sendRaw(encodeFieldFrame(FIELD_MSG_STATE, 'notes:1', new Uint8Array([1, 0, 0]))) // client may not send STATE
    await a.expectNoFrame()
    expect(a.errors).toEqual([])
    expect(a.closeEvent).toBeNull()

    // Still fully functional, and the garbage never entered the log.
    a.get('notes:1')
    const state = await readState(a, 'notes:1')
    const check = new Y.Doc()
    if (state.diff.byteLength > 2) applyRemote(check, state.diff)
    expect(check.getText('t').toString()).toBe('')
    a.close()
  })

  it('two clients typing concurrently in one field converge to identical state', async () => {
    const workspace = `f-converge-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const b = await FieldTestClient.ready(workspace, 'b')
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const random = mulberry32(0xc0ffee)
    const words = ['sync', 'field', 'merge', 'crdt', 'note']

    // Seeded interleaving: both sides type without waiting for each other;
    // relays queue and are drained in bursts (the §11 convergence-sim
    // pattern applied to text).
    for (let i = 0; i < 30; i++) {
      const [client, doc] = random() < 0.5 ? ([a, docA] as const) : ([b, docB] as const)
      const text = doc.getText('t')
      const update = edit(doc, () => {
        if (text.length > 0 && random() < 0.3) {
          const at = Math.floor(random() * text.length)
          text.delete(at, Math.min(2, text.length - at))
        } else {
          const at = text.length > 0 ? Math.floor(random() * text.length) : 0
          text.insert(at, `${words[Math.floor(random() * words.length)]} `)
        }
      })
      client.update('notes:1', update)
      if (random() < 0.25) {
        // occasionally drain a pending relay mid-stream
        for (const [peer, peerDoc] of [
          [a, docA],
          [b, docB],
        ] as const) {
          try {
            const frame = await peer.nextFrame(50)
            if (frame.msgType === FIELD_MSG_UPDATE) applyRemote(peerDoc, frame.payload)
          } catch {
            // nothing pending
          }
        }
      }
    }

    // Drain everything still in flight.
    for (const [peer, peerDoc] of [
      [a, docA],
      [b, docB],
    ] as const) {
      for (;;) {
        try {
          const frame = await peer.nextFrame(200)
          if (frame.msgType === FIELD_MSG_UPDATE) applyRemote(peerDoc, frame.payload)
        } catch {
          break
        }
      }
    }

    expect(docA.getText('t').toString()).toBe(docB.getText('t').toString())

    // And both equal the server's materialized state.
    const c = await FieldTestClient.ready(workspace, 'c')
    c.get('notes:1')
    const state = decodeFieldState((await c.nextFrame()).payload)!
    const docC = new Y.Doc()
    applyRemote(docC, state.diff)
    expect(docC.getText('t').toString()).toBe(docA.getText('t').toString())
    a.close()
    b.close()
    c.close()
  })

  it('GET on a ready socket ignores stray GETs from other message types', async () => {
    // Guard against the mux misrouting: a GET must never be interpreted as
    // an UPDATE (which would append a state vector to the log as CRDT bytes).
    const workspace = `f-mux-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const doc = new Y.Doc()
    doc.getText('t').insert(0, 'x')
    a.sendRaw(encodeFieldFrame(FIELD_MSG_GET, 'notes:1', Y.encodeStateVector(doc)))
    const state = await readState(a, 'notes:1')
    expect(state.writable).toBe(true)
    a.get('notes:1')
    const state2 = await readState(a, 'notes:1')
    const check = new Y.Doc()
    if (state2.diff.byteLength > 2) applyRemote(check, state2.diff)
    expect(check.getText('t').toString()).toBe('')
    a.close()
  })
})
