import { FIELD_MSG_STATE, FIELD_MSG_UPDATE, decodeFieldState } from '@cf-sync/protocol'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { FieldTestClient, applyRemote, edit } from './harness'

async function readText(client: FieldTestClient, fieldId: string): Promise<string> {
  const frame = await client.nextFrame()
  expect(frame.msgType).toBe(FIELD_MSG_STATE)
  expect(frame.fieldId).toBe(fieldId)
  const state = decodeFieldState(frame.payload)
  expect(state).not.toBeNull()
  const doc = new Y.Doc()
  if (state!.diff.byteLength > 2) applyRemote(doc, state!.diff)
  return doc.getText('t').toString()
}

describe('workspace isolation (§17.5 per-instance extension)', () => {
  it('two workspaces on one class share no extension storage, cache, or delivery', async () => {
    const wsA = `iso-a-${Date.now()}`
    const wsB = `iso-b-${Date.now()}`
    const a1 = await FieldTestClient.ready(wsA, 'a1')
    const a2 = await FieldTestClient.ready(wsA, 'a2')
    // B's instance is constructed while A is live — the exact sequence where
    // a shared extension singleton re-pointed A's storage and broadcast at B.
    const b1 = await FieldTestClient.ready(wsB, 'b1')

    const docA = new Y.Doc()
    a1.update('notes:1', edit(docA, () => docA.getText('t').insert(0, 'alpha')))

    // The relay reaches A's peer and never crosses to B's socket.
    const relayed = await a2.nextFrame()
    expect(relayed.msgType).toBe(FIELD_MSG_UPDATE)
    expect(relayed.fieldId).toBe('notes:1')
    await b1.expectNoFrame()

    // The same fieldId written in B (the doc cache is keyed by fieldId and
    // must not alias across instances) stays invisible to A, and vice versa.
    const docB = new Y.Doc()
    b1.update('notes:1', edit(docB, () => docB.getText('t').insert(0, 'bravo')))
    await a2.expectNoFrame()

    a2.get('notes:1')
    expect(await readText(a2, 'notes:1')).toBe('alpha')
    const b2 = await FieldTestClient.ready(wsB, 'b2')
    b2.get('notes:1')
    expect(await readText(b2, 'notes:1')).toBe('bravo')

    a1.close()
    a2.close()
    b1.close()
    b2.close()
  })
})
