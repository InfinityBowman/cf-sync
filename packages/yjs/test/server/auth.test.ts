import { FIELD_MSG_REJECT, FIELD_MSG_STATE, decodeFieldReject, decodeFieldState } from '@cf-sync/protocol'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { FieldTestClient, applyRemote, edit } from './harness'

const reader = { 'x-test-auth': JSON.stringify({ writeAllowed: false }) }
const writer = { 'x-test-auth': JSON.stringify({ writeAllowed: true }) }

describe('authorizeWrite over the §15 stamps (§17.4)', () => {
  it('a reader gets writable: false in STATE, can GET, and its UPDATEs are refused with NotWritable', async () => {
    const workspace = `y-auth-${Date.now()}`
    const w = await FieldTestClient.ready(workspace, 'w', '/auth', writer)
    const docW = new Y.Doc()
    w.update('notes:1', edit(docW, () => docW.getText('t').insert(0, 'writer text')))

    const r = await FieldTestClient.ready(workspace, 'r', '/auth', reader)
    r.get('notes:1')
    const frame = await r.nextFrame()
    expect(frame.msgType).toBe(FIELD_MSG_STATE)
    const state = decodeFieldState(frame.payload)!
    expect(state.writable).toBe(false)
    const docR = new Y.Doc()
    applyRemote(docR, state.diff)
    expect(docR.getText('t').toString()).toBe('writer text') // reads flow

    // Writes are refused with a reason — told, never guessed.
    docR.getText('t').insert(0, 'sneaky ')
    r.update('notes:1', Y.encodeStateAsUpdate(docR, state.stateVector))
    const rejectFrame = await r.nextFrame()
    expect(rejectFrame.msgType).toBe(FIELD_MSG_REJECT)
    expect(rejectFrame.fieldId).toBe('notes:1')
    expect(decodeFieldReject(rejectFrame.payload)).toBe('NotWritable')

    // The collapse rule: later UPDATEs from this socket for this field are
    // dropped without another round-trip.
    const more = edit(docR, () => docR.getText('t').insert(0, 'again '))
    r.update('notes:1', more)
    await r.expectNoFrame()

    // Nothing landed: the writer's view is untouched.
    const check = await FieldTestClient.ready(workspace, 'check', '/auth', writer)
    check.get('notes:1')
    const checkState = decodeFieldState((await check.nextFrame()).payload)!
    const docC = new Y.Doc()
    applyRemote(docC, checkState.diff)
    expect(docC.getText('t').toString()).toBe('writer text')
    w.close()
    r.close()
    check.close()
  })

  it('a refused field goes read-only for later GETs on the same socket, other fields unaffected', async () => {
    const workspace = `y-auth2-${Date.now()}`
    const r = await FieldTestClient.ready(workspace, 'r', '/auth', reader)
    const doc = new Y.Doc()
    r.update('notes:1', edit(doc, () => doc.getText('t').insert(0, 'x')))
    expect(decodeFieldReject((await r.nextFrame()).payload)).toBe('NotWritable')

    r.get('notes:1')
    expect(decodeFieldState((await r.nextFrame()).payload)!.writable).toBe(false)
    // A reader is read-only on every field (predicate, not per-field) — but
    // the refusal set itself is per-field; a writer's Frozen refusal on one
    // field must not leak (covered in limits tests). Here: GET on another
    // field still answers.
    r.get('notes:2')
    expect((await r.nextFrame()).msgType).toBe(FIELD_MSG_STATE)
    r.close()
  })
})
