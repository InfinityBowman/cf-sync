import { CLOSE_REFRESH, FIELD_MSG_STATE, decodeFieldState } from '@cf-sync/protocol'
import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { FieldTestClient, applyRemote, edit } from './harness'

function admin(workspaceId: string, op: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://test/admin/${workspaceId}/${op}`, init)
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

describe('admin surface for fields (§17.7)', () => {
  it('export → reset → import round-trips fields, and stats report them', async () => {
    const workspace = `y-admin-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const doc = new Y.Doc()
    a.update('notes:1', edit(doc, () => doc.getText('t').insert(0, 'keep me')))
    const doc2 = new Y.Doc()
    a.update('notes:2', edit(doc2, () => doc2.getText('t').insert(0, 'me too')))
    expect(await readFieldText(a, 'notes:2')).toBe('me too')
    a.close()

    const exported = (await (await admin(workspace, 'export')).json()) as {
      extension?: { fields?: Record<string, string> }
    }
    expect(Object.keys(exported.extension?.fields ?? {})).toEqual(['notes:1', 'notes:2'])

    const statsBefore = (await (await admin(workspace, 'stats')).json()) as {
      extension: { fields: number; fieldBytes: number }
    }
    expect(statsBefore.extension.fields).toBe(2)
    expect(statsBefore.extension.fieldBytes).toBeGreaterThan(0)

    const reset = await admin(workspace, 'reset', { method: 'POST' })
    expect(reset.status).toBe(200)
    const wiped = await FieldTestClient.ready(workspace, 'wiped')
    expect(await readFieldText(wiped, 'notes:1')).toBe('')
    wiped.close()

    const imported = await admin(workspace, 'import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(exported),
    })
    expect(imported.status).toBe(200)
    const restored = await FieldTestClient.ready(workspace, 'restored')
    expect(await readFieldText(restored, 'notes:1')).toBe('keep me')
    expect(await readFieldText(restored, 'notes:2')).toBe('me too')
    restored.close()
  })

  it('an import carrying fields cycles live sockets with 4300; the reconnect converges both planes', async () => {
    const workspace = `y-cycle-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const doc = new Y.Doc()
    a.update('notes:1', edit(doc, () => doc.getText('t').insert(0, 'v1')))
    expect(await readFieldText(a, 'notes:1')).toBe('v1')

    const exported = await (await admin(workspace, 'export')).text()

    // Typed after the export was taken: the import will not contain this op,
    // but the client still holds it.
    a.update('notes:1', edit(doc, () => doc.getText('t').insert(2, ' plus')))

    const response = await admin(workspace, 'import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: exported,
    })
    expect(response.status).toBe(200)

    // Not a hot row swap: the socket cycles with a refresh close.
    const close = await a.waitClose()
    expect(close.code).toBe(CLOSE_REFRESH)

    // Reconnect: re-GET pulls the restored state, the push-back leg
    // re-uploads the op the restore lost — convergence-preserving restore.
    await a.reconnectReady()
    a.get('notes:1', doc)
    const state = decodeFieldState((await a.nextFrame()).payload)!
    applyRemote(doc, state.diff)
    const pushBack = Y.encodeStateAsUpdate(doc, state.stateVector)
    if (pushBack.byteLength > 2) a.update('notes:1', pushBack)

    const b = await FieldTestClient.ready(workspace, 'b')
    expect(await readFieldText(b, 'notes:1')).toBe('v1 plus')
    a.close()
    b.close()
  })

  it('a row-only import leaves sockets open (the hot-swap path is unchanged)', async () => {
    const workspace = `y-rowonly-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const response = await admin(workspace, 'import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        formatVersion: 1,
        schemaVersion: 1,
        rows: [{ tbl: 'notes', id: 'r1', data: { title: 'hello' } }],
      }),
    })
    expect(response.status).toBe(200)
    // The clear poke arrives over the still-open socket.
    for (;;) {
      const msg = await a.nextJson()
      if (msg.type === 'pokeEnd') break
    }
    expect(a.closeEvent).toBeNull()
    a.close()
  })

  it('an import with a corrupt field snapshot fails whole — rows are not swapped either', async () => {
    const workspace = `y-badimport-${Date.now()}`
    const a = await FieldTestClient.ready(workspace, 'a')
    const doc = new Y.Doc()
    a.update('notes:1', edit(doc, () => doc.getText('t').insert(0, 'survives')))
    expect(await readFieldText(a, 'notes:1')).toBe('survives')

    const response = await admin(workspace, 'import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        formatVersion: 1,
        schemaVersion: 1,
        rows: [{ tbl: 'notes', id: 'r1', data: { title: 'ghost' } }],
        extension: { fields: { 'notes:1': '//////////8=' } }, // varint overflow: cannot build a doc
      }),
    })
    expect(response.status).toBe(400)

    // Same transaction: neither plane changed, and the socket stayed open.
    expect(await readFieldText(a, 'notes:1')).toBe('survives')
    expect(a.closeEvent).toBeNull()
    a.close()
  })
})
