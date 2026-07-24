import { usePresence } from '@cf-sync/client/react'
import type { YjsFieldHandle } from '@cf-sync/yjs/client'
import { useEffect, useState } from 'react'
import { syncClient, yfields } from './sync'

/** Field ids are an app convention the engine never interprets (§17.1). */
export const notesFieldId = (todoId: string) => `todo-notes:${todoId}`

/**
 * Collaborative notes for one todo — the reference Tier 2 field integration:
 *
 * - `yfields.getDoc(fieldId)` acquires a ref-counted handle; `release()` on
 *   unmount drops local state at refcount zero. StrictMode's double mount is
 *   fine: the second acquire shares the entry the first created.
 * - `whenSynced` gates first paint ("can I render this field"), `canWrite`
 *   + `subscribe` drive read-only state reactively, and `handle.text` is the
 *   paved-path Y.Text every client agrees on.
 * - Reconnects re-sync the doc by themselves; there is no reconnect glue
 *   here, and edits typed while offline merge on resume.
 *
 * The textarea binding below is a minimal prefix/suffix diff — right for a
 * demo, and honest about its limits (a remote edit can move your caret). A
 * production editor drops `handle.text` (or `handle.doc`) into y-codemirror,
 * y-prosemirror, etc., which own caret math properly.
 */
export function NotesField({ todoId }: { todoId: string }) {
  const fieldId = notesFieldId(todoId)
  const [handle, setHandle] = useState<YjsFieldHandle | null>(null)
  const [synced, setSynced] = useState(false)
  const [canWrite, setCanWrite] = useState(false)
  const [value, setValue] = useState('')

  const peers = usePresence(syncClient)
  const editingPeers = peers.filter((peer) => peer.state.editing === fieldId)

  useEffect(() => {
    const h = yfields.getDoc(fieldId)
    let alive = true
    setHandle(h)
    setSynced(false)
    setCanWrite(h.canWrite)
    setValue(h.text.toString())

    // Y.Text -> React: one observer covers local echoes and remote updates
    // alike (both commit through the doc).
    const render = () => {
      if (alive) setValue(h.text.toString())
    }
    h.text.observe(render)
    // canWrite flips on the server's STATE flag or any REJECT — read-only is
    // told, never guessed.
    const unsubscribe = h.subscribe(() => {
      if (alive) setCanWrite(h.canWrite)
    })
    void h.whenSynced.then(() => {
      if (alive) {
        setSynced(true)
        setCanWrite(h.canWrite)
        render()
      }
    })
    return () => {
      alive = false
      unsubscribe()
      h.text.unobserve(render)
      h.release()
    }
  }, [fieldId])

  const onChange = (next: string) => {
    if (!handle || !canWrite) return
    const prev = handle.text.toString()
    // Minimal diff (common prefix/suffix), applied as one transaction so
    // peers receive a single update per keystroke/paste.
    let start = 0
    while (start < prev.length && start < next.length && prev[start] === next[start]) start++
    let prevEnd = prev.length
    let nextEnd = next.length
    while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
      prevEnd--
      nextEnd--
    }
    handle.doc.transact(() => {
      if (prevEnd > start) handle.text.delete(start, prevEnd - start)
      if (nextEnd > start) handle.text.insert(start, next.slice(start, nextEnd))
    })
  }

  if (!synced) {
    return <p style={{ margin: '4px 0 8px 28px', color: '#888', fontSize: '0.8rem' }}>loading notes…</p>
  }

  return (
    <div style={{ margin: '4px 0 8px 28px' }}>
      <textarea
        value={value}
        readOnly={!canWrite}
        onChange={(e) => onChange(e.target.value)}
        // Field-level presence (§16) beside field-level text (§17): focus
        // announces which field this tab is in; blur retracts just that key.
        onFocus={() => syncClient.presence.update({ editing: fieldId })}
        onBlur={() => syncClient.presence.update({ editing: undefined })}
        placeholder="Notes — open this todo in another tab and type in both at once"
        rows={3}
        // The editor-side length guard is the paved path (§17.3): the user
        // sees the limit here, with native undo, long before the transport
        // frame guard (MAX_FIELD_UPDATE_BYTES) or the 700KB field ceiling
        // could ever refuse anything.
        maxLength={4000}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: 8,
          fontFamily: 'inherit',
          fontSize: '0.9rem',
          background: canWrite ? 'white' : '#f3f3f3',
          border: '1px solid #ccc',
          borderRadius: 4,
          resize: 'vertical',
        }}
      />
      <p style={{ margin: '2px 0 0', fontSize: '0.75rem', color: '#888' }}>
        {!canWrite && <span style={{ color: '#c40' }}>read-only · </span>}
        {editingPeers.length > 0
          ? `${editingPeers.map((peer) => peer.state.name).join(', ')} ${editingPeers.length === 1 ? 'is' : 'are'} typing here`
          : 'merges character-by-character (Yjs), synced on the same socket as the rows'}
      </p>
    </div>
  )
}
