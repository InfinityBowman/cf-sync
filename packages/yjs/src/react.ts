import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import type { YjsFieldHandle, YjsFields } from './client'

/**
 * What {@link useYjsField} returns — discriminated on `synced` so the
 * loading state is impossible to forget:
 *
 * - `synced: false` — the first `STATE` hasn't arrived (or the component
 *   just switched fields). Render a placeholder; `doc`/`text` are null.
 * - `synced: true` — `doc`, `text`, and `canWrite` are live. `canWrite`
 *   updates reactively (the server's writable flag, or a REJECT flipping it
 *   off); bind `text` (or `doc`) to your editor.
 */
export type YjsFieldState =
  | {
      readonly synced: false
      readonly handle: null
      readonly doc: null
      readonly text: null
      readonly canWrite: false
    }
  | {
      readonly synced: true
      readonly handle: YjsFieldHandle
      readonly doc: Y.Doc
      readonly text: Y.Text
      readonly canWrite: boolean
    }

const UNSYNCED: YjsFieldState = { synced: false, handle: null, doc: null, text: null, canWrite: false }

/** What one mounted hook instance last published, keyed by what it was for. */
interface Snap {
  fields: YjsFields
  fieldId: string
  state: YjsFieldState
}

/**
 * The paved-path React binding for one Tier 2 field (DESIGN.md §17.6): owns
 * the whole handle lifecycle — acquire on mount, `release()` on unmount,
 * re-acquire on `fieldId` change — plus the sync gate and reactive
 * `canWrite`, so a component is just:
 *
 * ```tsx
 * const field = useYjsField(yfields, `todo-notes:${todoId}`)
 * if (!field.synced) return <Spinner />
 * return <Editor text={field.text} readOnly={!field.canWrite} />
 * ```
 *
 * Re-renders happen on sync and permission changes only — **not** per
 * keystroke. Deliberate: editor bindings (y-codemirror, y-prosemirror, a
 * hand-rolled textarea observer) attach to `text`/`doc` and own content
 * updates themselves, exactly as everywhere else in the Yjs ecosystem.
 *
 * StrictMode's double mount is safe (the second acquire re-fetches in one
 * round-trip), and server rendering returns the unsynced state — matching
 * the client's first paint, so hydration agrees.
 */
export function useYjsField(fields: YjsFields, fieldId: string): YjsFieldState {
  const [snap, setSnap] = useState<Snap | null>(null)

  useEffect(() => {
    const handle = fields.getDoc(fieldId)
    let alive = true
    let synced = false
    const publish = (): void => {
      if (!alive) return
      setSnap((prev) => {
        // Same field, same permission: keep the previous object so React
        // bails out instead of re-rendering on a no-op notify.
        if (
          prev !== null &&
          prev.fields === fields &&
          prev.fieldId === fieldId &&
          prev.state.synced &&
          prev.state.handle === handle &&
          prev.state.canWrite === handle.canWrite
        ) {
          return prev
        }
        return {
          fields,
          fieldId,
          state: { synced: true, handle, doc: handle.doc, text: handle.text, canWrite: handle.canWrite },
        }
      })
    }
    // Publish only once whenSynced has resolved: notify can fire for
    // pre-sync bookkeeping, and `synced: true` must never front-run the
    // first STATE.
    const unsubscribe = handle.subscribe(() => {
      if (synced) publish()
    })
    void handle.whenSynced.then(() => {
      synced = true
      publish()
    })
    return () => {
      alive = false
      unsubscribe()
      handle.release()
    }
  }, [fields, fieldId])

  // A snapshot for a different field (the props just changed; the effect
  // hasn't re-run yet) must not leak through as this field's content.
  return snap !== null && snap.fields === fields && snap.fieldId === fieldId ? snap.state : UNSYNCED
}
