import { usePresence } from '@cf-sync/client/react'
import { useYjsField } from '@cf-sync/yjs/react'
import { useEffect, useState } from 'react'
import { syncClient, yfields } from './sync'

/** Field ids are an app convention the engine never interprets (§17.1). */
export const notesFieldId = (todoId: string) => `todo-notes:${todoId}`

/**
 * Collaborative notes for one todo — the reference Tier 2 field integration:
 *
 * - `useYjsField` owns the whole handle lifecycle: acquire on mount, release
 *   on unmount, re-acquire on field change, StrictMode-safe. `synced` gates
 *   first paint and `canWrite` is reactive (the server's writable flag, or a
 *   REJECT flipping it off) — no manual `getDoc`/`subscribe`/`release` glue.
 * - Reconnects re-sync the doc by themselves; there is no reconnect glue
 *   here, and edits typed while offline merge on resume.
 *
 * The textarea binding below is a minimal prefix/suffix diff — right for a
 * demo, and honest about its limits (a remote edit can move your caret). A
 * production editor drops `field.text` (or `field.doc`) into y-codemirror,
 * y-prosemirror, etc., which own caret math properly.
 */
export function NotesField({ todoId }: { todoId: string }) {
  const fieldId = notesFieldId(todoId)
  const field = useYjsField(yfields, fieldId)
  const [value, setValue] = useState('')

  const peers = usePresence(syncClient)
  const editingPeers = peers.filter((peer) => peer.state.editing === fieldId)

  // Y.Text -> React: one observer covers local echoes and remote updates
  // alike (both commit through the doc). The hook deliberately does not
  // re-render per keystroke — content binding belongs to the editor.
  useEffect(() => {
    if (!field.synced) return
    const text = field.text
    const render = () => setValue(text.toString())
    render()
    text.observe(render)
    return () => text.unobserve(render)
  }, [field.synced, field.text])

  const onChange = (next: string) => {
    if (!field.synced || !field.canWrite) return
    const prev = field.text.toString()
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
    field.doc.transact(() => {
      if (prevEnd > start) field.text.delete(start, prevEnd - start)
      if (nextEnd > start) field.text.insert(start, next.slice(start, nextEnd))
    })
  }

  if (!field.synced) {
    return <p className="text-ink-faint mt-1.5 mb-1 ml-7 font-mono text-xs">loading notes…</p>
  }

  return (
    <div className="border-line mt-2 mb-1 ml-7 border-l-2 pl-3">
      <textarea
        value={value}
        readOnly={!field.canWrite}
        onChange={(e) => onChange(e.target.value)}
        // Field-level presence (§16) beside field-level text (§17): focus
        // announces which field this tab is in; blur retracts just that key.
        onFocus={() => syncClient.presence.update({ editing: fieldId })}
        onBlur={() => syncClient.presence.update({ editing: undefined })}
        placeholder="Notes: open this todo in another tab and type in both at once"
        rows={3}
        // The editor-side length guard is the paved path (§17.3): the user
        // sees the limit here, with native undo, long before the transport
        // frame guard (MAX_FIELD_UPDATE_BYTES) or the 700KB field ceiling
        // could ever refuse anything.
        maxLength={4000}
        className={`border-line placeholder:text-ink-faint box-border w-full resize-y rounded-lg border px-3 py-2 font-sans text-sm outline-none ${
          field.canWrite
            ? 'bg-paper focus:border-[hsl(var(--self-hue)_55%_60%)] focus:bg-white focus:ring-2 focus:ring-[hsl(var(--self-hue)_70%_86%)]'
            : 'text-ink-soft bg-[#efeff1]'
        }`}
      />
      <p className="text-ink-faint mt-0.5 font-mono text-[0.7rem]">
        {!field.canWrite && <span className="text-reject">read-only · </span>}
        {editingPeers.length > 0 ? (
          <span className="text-[#2e7d4c]">
            {editingPeers.map((peer) => peer.state.name).join(', ')}{' '}
            {editingPeers.length === 1 ? 'is' : 'are'} typing here
          </span>
        ) : (
          'merges character-by-character (Yjs), synced on the same socket as the rows'
        )}
      </p>
    </div>
  )
}
