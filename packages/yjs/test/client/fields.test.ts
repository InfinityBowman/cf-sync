import {
  FIELD_MSG_GET,
  FIELD_MSG_STATE,
  FIELD_MSG_UPDATE,
  MAX_FIELD_UPDATE_BYTES,
  decodeFieldFrame,
  encodeFieldState,
} from '@cf-sync/protocol/internal'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createYjsFields } from '../../src/client'
import { FakeSeam } from '../fake-seam'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createYjsFields (ARCHITECTURE.md#yjs-fields)', () => {
  it('getDoc sends GET when synced, and defers it to the ready transition otherwise', () => {
    const seam = new FakeSeam()
    const yf = createYjsFields(seam)
    yf.getDoc('f1') // not synced yet: nothing goes out
    expect(seam.sent).toEqual([])

    seam.setStatus('synced')
    const [get] = seam.takeSent()
    expect(get!.msgType).toBe(FIELD_MSG_GET)
    expect(get!.fieldId).toBe('f1')

    // Already synced: a new field GETs immediately.
    yf.getDoc('f2')
    expect(seam.takeSent()[0]!.fieldId).toBe('f2')
    yf.destroy()
  })

  it('STATE applies the diff, resolves whenSynced once, and sets canWrite from the flag', async () => {
    const seam = new FakeSeam()
    seam.status = 'synced'
    const yf = createYjsFields(seam)
    const handle = yf.getDoc('f1')
    expect(handle.canWrite).toBe(false) // never guessed before STATE
    const [get] = seam.takeSent()

    const serverDoc = new Y.Doc()
    serverDoc.getText('t').insert(0, 'from server')
    seam.state('f1', serverDoc, get!.payload)

    await handle.whenSynced
    expect(handle.text.toString()).toBe('from server')
    expect(handle.canWrite).toBe(true)
    // The client had nothing the server missed: no push-back frame.
    expect(seam.takeSent()).toEqual([])
    yf.destroy()
  })

  it('pushes back what the server is missing — edits typed before sync upload on the first STATE', async () => {
    const seam = new FakeSeam()
    const yf = createYjsFields(seam)
    const handle = yf.getDoc('f1')
    handle.doc.getText('t').insert(0, 'typed offline') // buffered in the doc itself
    expect(seam.sent).toEqual([])

    seam.setStatus('synced')
    const [get] = seam.takeSent()
    const serverDoc = new Y.Doc()
    seam.state('f1', serverDoc, get!.payload)
    await handle.whenSynced

    const [pushBack] = seam.takeSent()
    expect(pushBack!.msgType).toBe(FIELD_MSG_UPDATE)
    Y.applyUpdate(serverDoc, pushBack!.payload)
    expect(serverDoc.getText('t').toString()).toBe('typed offline')
    yf.destroy()
  })

  it('suppresses the push-back and local sends for a read-only field', async () => {
    const seam = new FakeSeam()
    seam.status = 'synced'
    const yf = createYjsFields(seam)
    const handle = yf.getDoc('f1')
    handle.doc.getText('t').insert(0, 'local')
    const [get] = seam.takeSent()

    const serverDoc = new Y.Doc()
    seam.state('f1', serverDoc, get!.payload, false) // writable: false
    await handle.whenSynced
    expect(handle.canWrite).toBe(false)
    expect(seam.takeSent()).toEqual([]) // no push-back

    handle.doc.getText('t').insert(0, 'more ')
    expect(seam.takeSent()).toEqual([]) // no sends either
    yf.destroy()
  })

  it('sends local edits while writable, and applies relayed updates without echoing them', async () => {
    const seam = new FakeSeam()
    seam.status = 'synced'
    const yf = createYjsFields(seam)
    const handle = yf.getDoc('f1')
    const [get] = seam.takeSent()
    const serverDoc = new Y.Doc()
    seam.state('f1', serverDoc, get!.payload)
    await handle.whenSynced

    handle.text.insert(0, 'mine')
    const [update] = seam.takeSent()
    expect(update!.msgType).toBe(FIELD_MSG_UPDATE)

    // A peer's relayed update applies but never goes back out.
    const peer = new Y.Doc()
    peer.getText('t').insert(0, 'peer ')
    seam.deliver(FIELD_MSG_UPDATE, 'f1', Y.encodeStateAsUpdate(peer))
    expect(handle.text.toString()).toContain('peer ')
    expect(seam.takeSent()).toEqual([])

    // Frames for fields nobody holds are ignored.
    seam.deliver(FIELD_MSG_UPDATE, 'not-open', Y.encodeStateAsUpdate(peer))
    yf.destroy()
  })

  it('REJECT flips canWrite, notifies subscribers, and stays sticky across a reconnect STATE', async () => {
    const seam = new FakeSeam()
    seam.status = 'synced'
    const yf = createYjsFields(seam)
    const handle = yf.getDoc('f1')
    const [get] = seam.takeSent()
    const serverDoc = new Y.Doc()
    seam.state('f1', serverDoc, get!.payload)
    await handle.whenSynced
    expect(handle.canWrite).toBe(true)

    const changes: boolean[] = []
    handle.subscribe(() => changes.push(handle.canWrite))

    handle.text.insert(0, 'refused op')
    seam.takeSent() // the UPDATE the server is about to refuse
    seam.reject('f1', 'TooLarge')
    expect(handle.canWrite).toBe(false)
    expect(changes).toEqual([false])

    // Reconnect: the server honestly reports writable (it refused one
    // update, not the field) — but this doc holds an op the server will
    // never accept, so the handle must not resume the push-back.
    seam.setStatus('reconnecting')
    seam.setStatus('synced')
    const [reGet] = seam.takeSent()
    expect(reGet!.msgType).toBe(FIELD_MSG_GET)
    seam.state('f1', serverDoc, reGet!.payload, true)
    expect(handle.canWrite).toBe(false) // sticky
    expect(seam.takeSent()).toEqual([]) // push-back stays suppressed
    yf.destroy()
  })

  it('re-GETs every held field on each ready transition with its current state vector', async () => {
    const seam = new FakeSeam()
    seam.status = 'synced'
    const yf = createYjsFields(seam)
    const h1 = yf.getDoc('f1')
    const h2 = yf.getDoc('f2')
    const gets = seam.takeSent()
    const serverDoc = new Y.Doc()
    seam.state('f1', serverDoc, gets[0]!.payload)
    seam.state('f2', serverDoc, gets[1]!.payload)
    await h1.whenSynced
    await h2.whenSynced

    h1.text.insert(0, 'held state')
    seam.takeSent()

    seam.setStatus('reconnecting')
    seam.setStatus('synced')
    const reGets = seam.takeSent()
    expect(reGets.map((f) => f.fieldId).sort()).toEqual(['f1', 'f2'])
    // The re-GET carries the doc's current state vector, not a fresh one:
    // applying it against the server yields only what the server is missing.
    const sv = reGets.find((f) => f.fieldId === 'f1')!.payload
    expect(Y.encodeStateAsUpdate(h1.doc, sv).byteLength).toBeLessThanOrEqual(2)
    yf.destroy()
  })

  it('ref-counts handles: one doc shared, dropped at zero, rebuilt fresh after', async () => {
    const seam = new FakeSeam()
    seam.status = 'synced'
    const yf = createYjsFields(seam)
    const h1 = yf.getDoc('f1')
    const h2 = yf.getDoc('f1')
    expect(seam.takeSent().length).toBe(1) // one GET, shared entry
    expect(h1.doc).toBe(h2.doc)

    h1.doc.getText('t').insert(0, 'shared')
    h1.release()
    h1.release() // double-release is a no-op
    expect(h2.doc.getText('t').toString()).toBe('shared') // still held

    h2.release()
    const h3 = yf.getDoc('f1')
    expect(h3.doc.getText('t').toString()).toBe('') // local state dropped at zero
    expect(seam.takeSent().length).toBe(1) // fresh GET
    yf.destroy()
  })

  it('trips the local frame guard on an oversized update: read-only, warned, nothing sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seam = new FakeSeam()
    seam.status = 'synced'
    const yf = createYjsFields(seam)
    const handle = yf.getDoc('f1')
    const [get] = seam.takeSent()
    seam.state('f1', new Y.Doc(), get!.payload)
    await handle.whenSynced

    handle.text.insert(0, 'x'.repeat(MAX_FIELD_UPDATE_BYTES + 100))
    expect(seam.takeSent()).toEqual([])
    expect(handle.canWrite).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    yf.destroy()
  })

  it('a STATE whose state vector cannot be decoded still resolves whenSynced and notifies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seam = new FakeSeam()
    seam.status = 'synced'
    const yf = createYjsFields(seam)
    const handle = yf.getDoc('f1')
    handle.doc.getText('t').insert(0, 'edits the push-back would carry')
    seam.takeSent() // the GET

    const changes: boolean[] = []
    handle.subscribe(() => changes.push(handle.canWrite))
    // Well-formed envelope, garbage state vector: 0xff is a varint with its
    // continuation bit set and nothing after it, so the push-back encode
    // throws inside Yjs.
    seam.deliver(FIELD_MSG_STATE, 'f1', encodeFieldState({ writable: true, stateVector: new Uint8Array([0xff]), diff: new Uint8Array([0, 0]) }))

    await handle.whenSynced // must not wedge
    expect(handle.canWrite).toBe(true)
    expect(changes).toEqual([true])
    expect(seam.takeSent()).toEqual([]) // the push-back failed, nothing half-sent
    expect(warn).toHaveBeenCalledOnce()
    yf.destroy()
  })

  it('getDoc refuses an id the wire format cannot carry, before any state is registered', () => {
    const seam = new FakeSeam()
    seam.status = 'synced'
    const yf = createYjsFields(seam)
    expect(() => yf.getDoc('')).toThrow(/fieldId/)
    expect(() => yf.getDoc('x'.repeat(257))).toThrow(/fieldId/)
    expect(() => yf.getDoc('é'.repeat(130))).toThrow(/fieldId/) // 260 utf-8 bytes
    expect(seam.sent).toEqual([])

    // No zombie entries: a valid field still syncs, and a reconnect re-GETs
    // it (nothing broken is sitting in the entry map to abort the loop).
    yf.getDoc('f1')
    expect(seam.takeSent().map((f) => f.fieldId)).toEqual(['f1'])
    seam.setStatus('reconnecting')
    seam.setStatus('synced')
    expect(seam.takeSent().map((f) => f.fieldId)).toEqual(['f1'])
    yf.destroy()
  })

  it('one field failing to re-GET does not starve the others on reconnect', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seam = new FakeSeam()
    seam.status = 'synced'
    const yf = createYjsFields(seam)
    yf.getDoc('f1')
    yf.getDoc('f2')
    seam.takeSent()

    const realSend = seam.sendBinary.bind(seam)
    vi.spyOn(seam, 'sendBinary').mockImplementation((bytes) => {
      if (decodeFieldFrame(bytes)?.fieldId === 'f1') throw new Error('transport hiccup')
      realSend(bytes)
    })
    seam.setStatus('reconnecting')
    seam.setStatus('synced')
    expect(seam.takeSent().map((f) => f.fieldId)).toEqual(['f2'])
    expect(error).toHaveBeenCalledOnce()
    yf.destroy()
  })

  it('destroy detaches from the seam and later frames are ignored', async () => {
    const seam = new FakeSeam()
    seam.status = 'synced'
    const yf = createYjsFields(seam)
    const handle = yf.getDoc('f1')
    const [get] = seam.takeSent()
    seam.state('f1', new Y.Doc(), get!.payload)
    await handle.whenSynced

    yf.destroy()
    expect(() => seam.deliver(FIELD_MSG_UPDATE, 'f1', new Uint8Array([0, 0]))).not.toThrow()
    expect(() => yf.getDoc('f2')).toThrow(/destroyed/)
  })
})
