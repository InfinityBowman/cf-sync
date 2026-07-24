import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createYjsFields, type YjsFields } from '../../src/client'
import { useYjsField, type YjsFieldState } from '../../src/react'
import { FakeSeam } from '../fake-seam'

// React's act() refuses to run outside a test environment that declares itself.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Renders the hook and captures every snapshot it publishes. */
function probe(fields: YjsFields) {
  const seen: YjsFieldState[] = []
  function Probe({ fieldId }: { fieldId: string }) {
    seen.push(useYjsField(fields, fieldId))
    return null
  }
  const render = (fieldId: string, strict = false) => {
    const el = createElement(Probe, { fieldId })
    act(() => root.render(strict ? createElement(StrictMode, null, el) : el))
  }
  const latest = () => seen[seen.length - 1]!
  return { render, latest }
}

function makeSynced() {
  const seam = new FakeSeam()
  seam.status = 'synced'
  return { seam, yf: createYjsFields(seam) }
}

/** Answers the pending GET for a field with a STATE built from `serverText`. */
async function answerGet(seam: FakeSeam, fieldId: string, serverText: string, writable = true): Promise<void> {
  const get = seam.takeSent().find((f) => f.fieldId === fieldId)
  expect(get, `expected a GET for ${fieldId}`).toBeDefined()
  const serverDoc = new Y.Doc()
  serverDoc.getText('t').insert(0, serverText)
  // The synced flip publishes on the whenSynced microtask; async act flushes it.
  await act(async () => seam.state(fieldId, serverDoc, get!.payload, writable))
}

describe('useYjsField', () => {
  it('starts unsynced, then flips to synced with content and canWrite on the first STATE', async () => {
    const { seam, yf } = makeSynced()
    const { render, latest } = probe(yf)

    render('f1')
    expect(latest()).toMatchObject({ synced: false, text: null, canWrite: false })

    await answerGet(seam, 'f1', 'hello')
    const state = latest()
    expect(state.synced).toBe(true)
    expect(state.text!.toString()).toBe('hello')
    expect(state.canWrite).toBe(true)
  })

  it('reports read-only fields as synced with canWrite false', async () => {
    const { seam, yf } = makeSynced()
    const { render, latest } = probe(yf)

    render('f1')
    await answerGet(seam, 'f1', 'locked', false)
    expect(latest()).toMatchObject({ synced: true, canWrite: false })
  })

  it('re-renders when a REJECT flips canWrite off', async () => {
    const { seam, yf } = makeSynced()
    const { render, latest } = probe(yf)

    render('f1')
    await answerGet(seam, 'f1', 'v1')
    expect(latest().canWrite).toBe(true)

    await act(async () => seam.reject('f1', 'NotWritable'))
    expect(latest()).toMatchObject({ synced: true, canWrite: false })
  })

  it('releases the handle on unmount — a re-acquire starts from a fresh doc', async () => {
    const { seam, yf } = makeSynced()
    const { render } = probe(yf)

    render('f1')
    await answerGet(seam, 'f1', 'held')
    act(() => root.unmount())

    // Refcount hit zero: the entry is gone, so a new acquire re-fetches
    // instead of sharing the released doc.
    const handle = yf.getDoc('f1')
    expect(handle.text.toString()).toBe('')
    handle.release()
  })

  it('switching fieldId shows unsynced immediately, never the old field through the new id', async () => {
    const { seam, yf } = makeSynced()
    const { render, latest } = probe(yf)

    render('f1')
    await answerGet(seam, 'f1', 'first field')
    expect(latest().text!.toString()).toBe('first field')

    render('f2')
    // The very render that saw the new prop must not leak f1's snapshot.
    expect(latest()).toMatchObject({ synced: false, text: null })

    await answerGet(seam, 'f2', 'second field')
    expect(latest().text!.toString()).toBe('second field')
  })

  it('survives StrictMode double-mounting', async () => {
    const { seam, yf } = makeSynced()
    const { render, latest } = probe(yf)

    render('f1', true)
    // StrictMode ran mount → unmount → mount: the released first acquire may
    // have queued its own GET; answer the latest one.
    const gets = seam.takeSent().filter((f) => f.fieldId === 'f1')
    expect(gets.length).toBeGreaterThan(0)
    const serverDoc = new Y.Doc()
    serverDoc.getText('t').insert(0, 'strict')
    await act(async () => seam.state('f1', serverDoc, gets[gets.length - 1]!.payload))

    const state = latest()
    expect(state.synced).toBe(true)
    expect(state.text!.toString()).toBe('strict')
  })
})
