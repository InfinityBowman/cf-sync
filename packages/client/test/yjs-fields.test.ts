import {
  FIELD_MSG_GET,
  FIELD_MSG_REJECT,
  FIELD_MSG_STATE,
  FIELD_MSG_UPDATE,
  decodeFieldFrame,
  encodeFieldFrame,
  encodeFieldReject,
  encodeFieldState,
} from '@cf-sync/protocol/internal'
import { createYjsFields } from '@cf-sync/yjs/client'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { SyncClient } from '../src/client'
import { FakeSocket } from './fake-socket'
import { testApp } from './test-schema'

/**
 * Integration of the add-on with the real SyncClient over the ARCHITECTURE.md#yjs-fields seams
 * (sendBinary / onBinary / subscribeStatus) — also the compile-time proof
 * that SyncClient structurally satisfies YjsFieldsClient.
 */
describe('createYjsFields over a real SyncClient', () => {
  it('GETs on ready, syncs a field, sends local edits, re-GETs after reconnect', async () => {
    const sockets: FakeSocket[] = []
    const client = new SyncClient({
      url: 'ws://test',
      workspaceId: 'w1',
      clientId: 'client-a',
      autoStart: false,
      app: testApp,
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    const latest = () => sockets[sockets.length - 1]!
    const ready = (socket: FakeSocket) => {
      // Complete hello so the client reaches 'synced' (= binary-lane ready).
      const pokeId = `poke-${sockets.length}`
      socket.receive({ type: 'pokeStart', pokeId, baseCursor: null })
      socket.receive({ type: 'pokePart', pokeId, patch: [{ op: 'clear' }], lastMutationIdChanges: { 'client-a': 0 } })
      socket.receive({ type: 'pokeEnd', pokeId, cursor: { backendId: 'b1', version: 1 }, pageInfo: { more: false } })
    }

    const yfields = createYjsFields(client)
    const handle = yfields.getDoc('notes:q3')
    expect(sockets.length).toBe(0) // nothing sent pre-start

    client.start()
    latest().open()
    ready(latest())
    expect(client.status).toBe('synced')

    // The add-on's GET went out over the real socket as a binary frame.
    const get = decodeFieldFrame(latest().sentBinary[0]!)!
    expect(get.msgType).toBe(FIELD_MSG_GET)
    expect(get.fieldId).toBe('notes:q3')

    // Server answers with STATE; the handle syncs and becomes writable.
    const serverDoc = new Y.Doc()
    serverDoc.getText('t').insert(0, 'server copy')
    latest().receiveBinary(
      encodeFieldFrame(
        FIELD_MSG_STATE,
        'notes:q3',
        encodeFieldState({
          writable: true,
          stateVector: Y.encodeStateVector(serverDoc),
          diff: Y.encodeStateAsUpdate(serverDoc),
        }),
      ),
    )
    await handle.whenSynced
    expect(handle.text.toString()).toBe('server copy')
    expect(handle.canWrite).toBe(true)

    // A local edit flows out as an UPDATE frame.
    latest().sentBinary = []
    handle.text.insert(0, 'mine: ')
    const update = decodeFieldFrame(latest().sentBinary[0]!)!
    expect(update.msgType).toBe(FIELD_MSG_UPDATE)
    Y.applyUpdate(serverDoc, update.payload)
    expect(serverDoc.getText('t').toString()).toBe('mine: server copy')

    // Drop the connection; the reconnect that reaches ready re-GETs.
    latest().dropConnection()
    await new Promise((resolve) => setTimeout(resolve, 700)) // paced reconnect
    latest().open()
    ready(latest())
    const reGet = decodeFieldFrame(latest().sentBinary[0]!)!
    expect(reGet.msgType).toBe(FIELD_MSG_GET)
    expect(reGet.fieldId).toBe('notes:q3')
    // Carrying the doc's current state vector, so the server diffs from it.
    expect(Y.encodeStateAsUpdate(handle.doc, reGet.payload).byteLength).toBeLessThanOrEqual(2)

    handle.release()
    yfields.destroy()
    void client.destroy()
  })

  it('surfaces the rejection reason: writeBlocked distinguishes "full" from "no access"', async () => {
    const sockets: FakeSocket[] = []
    const client = new SyncClient({
      url: 'ws://test',
      workspaceId: 'w1',
      clientId: 'client-a',
      autoStart: false,
      app: testApp,
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    const latest = () => sockets[sockets.length - 1]!
    const yfields = createYjsFields(client)
    const handle = yfields.getDoc('notes:q3')
    expect(handle.writeBlocked).toBeNull() // nothing known pre-STATE

    client.start()
    latest().open()
    const pokeId = 'poke-1'
    latest().receive({ type: 'pokeStart', pokeId, baseCursor: null })
    latest().receive({ type: 'pokePart', pokeId, patch: [{ op: 'clear' }], lastMutationIdChanges: { 'client-a': 0 } })
    latest().receive({ type: 'pokeEnd', pokeId, cursor: { backendId: 'b1', version: 1 }, pageInfo: { more: false } })

    const serverDoc = new Y.Doc()
    latest().receiveBinary(
      encodeFieldFrame(
        FIELD_MSG_STATE,
        'notes:q3',
        encodeFieldState({
          writable: true,
          stateVector: Y.encodeStateVector(serverDoc),
          diff: Y.encodeStateAsUpdate(serverDoc),
        }),
      ),
    )
    await handle.whenSynced
    expect(handle.canWrite).toBe(true)
    expect(handle.writeBlocked).toBeNull()

    let notified = 0
    handle.subscribe(() => notified++)
    latest().receiveBinary(encodeFieldFrame(FIELD_MSG_REJECT, 'notes:q3', encodeFieldReject('TooLarge')))
    expect(handle.canWrite).toBe(false)
    expect(handle.writeBlocked).toBe('TooLarge')
    expect(notified).toBe(1)

    // Sticky: a later STATE claiming writable keeps the rejection and its reason.
    latest().receiveBinary(
      encodeFieldFrame(
        FIELD_MSG_STATE,
        'notes:q3',
        encodeFieldState({
          writable: true,
          stateVector: Y.encodeStateVector(serverDoc),
          diff: Y.encodeStateAsUpdate(serverDoc),
        }),
      ),
    )
    expect(handle.canWrite).toBe(false)
    expect(handle.writeBlocked).toBe('TooLarge')

    handle.release()
    yfields.destroy()
    void client.destroy()
  })

  it('a non-writable STATE reads as NotWritable', async () => {
    const sockets: FakeSocket[] = []
    const client = new SyncClient({
      url: 'ws://test',
      workspaceId: 'w1',
      clientId: 'client-a',
      autoStart: false,
      app: testApp,
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    const latest = () => sockets[sockets.length - 1]!
    const yfields = createYjsFields(client)
    const handle = yfields.getDoc('notes:q3')
    client.start()
    latest().open()
    const pokeId = 'poke-1'
    latest().receive({ type: 'pokeStart', pokeId, baseCursor: null })
    latest().receive({ type: 'pokePart', pokeId, patch: [{ op: 'clear' }], lastMutationIdChanges: { 'client-a': 0 } })
    latest().receive({ type: 'pokeEnd', pokeId, cursor: { backendId: 'b1', version: 1 }, pageInfo: { more: false } })

    const serverDoc = new Y.Doc()
    latest().receiveBinary(
      encodeFieldFrame(
        FIELD_MSG_STATE,
        'notes:q3',
        encodeFieldState({
          writable: false,
          stateVector: Y.encodeStateVector(serverDoc),
          diff: Y.encodeStateAsUpdate(serverDoc),
        }),
      ),
    )
    await handle.whenSynced
    expect(handle.canWrite).toBe(false)
    expect(handle.writeBlocked).toBe('NotWritable')

    handle.release()
    yfields.destroy()
    void client.destroy()
  })
})
