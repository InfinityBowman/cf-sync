import { usePresence, useSyncStatus } from '@cf-sync/client/react'
import { useLiveQuery } from '@tanstack/react-db'
import { useEffect, useRef, useState } from 'react'
import { ulid } from 'ulidx'
import { NotesField, notesFieldId } from './NotesField'
import { displayName, syncClient, todos, workspaceId } from './sync'

/** Stable per-peer hue so a cursor keeps its color as it moves. */
function hueOf(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0
  return ((hash % 360) + 360) % 360
}

export function App() {
  const [title, setTitle] = useState('')
  // Which todos have their notes open — purely local UI state; the field
  // handle underneath is acquired/released as the panel mounts/unmounts.
  const [openNotes, setOpenNotes] = useState<ReadonlySet<string>>(new Set())
  const status = useSyncStatus(syncClient)
  const peers = usePresence(syncClient)
  const mainRef = useRef<HTMLElement>(null)

  const { data: items } = useLiveQuery((q) =>
    q.from({ todo: todos }).orderBy(({ todo }) => todo.createdAt, 'asc'),
  )

  // Live cursors: identity was announced via initialPresence at client
  // construction, so every mousemove is a bare presence.update — the client
  // throttles trailing-edge (100ms) for you, and the shallow merge
  // never re-states `name`. Coordinates are relative to the centered column
  // so they line up across window sizes; leaving the window drops the cursor
  // (`cursor: undefined` clears just that field) but keeps the avatar.
  useEffect(() => {
    const move = (event: MouseEvent) => {
      const rect = mainRef.current?.getBoundingClientRect()
      if (!rect) return
      syncClient.presence.update({
        cursor: { x: Math.round(event.clientX - rect.left), y: Math.round(event.clientY - rect.top) },
      })
    }
    const leave = () => syncClient.presence.update({ cursor: undefined })
    document.addEventListener('mousemove', move)
    document.documentElement.addEventListener('mouseleave', leave)
    return () => {
      document.removeEventListener('mousemove', move)
      document.documentElement.removeEventListener('mouseleave', leave)
      // Retract only the cursor: identity is tab-scoped (initialPresence),
      // and clear() here would wipe it across a StrictMode remount — true
      // departure is the socket close broadcasting null.
      syncClient.presence.update({ cursor: undefined })
    }
  }, [])

  const addTodo = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    // `priority` is omitted: the schema default fills it in (client and server).
    todos.insert({ id: ulid(), title: trimmed, completed: false, createdAt: new Date().toISOString() })
    setTitle('')
  }

  const toggleNotes = (id: string) => {
    setOpenNotes((open) => {
      const next = new Set(open)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const clearCompleted = () => {
    // Intent-based mutation, typed against the shared registry (a typo'd
    // name is a compile error, and names autocomplete). The same mutator the
    // server runs applies locally first: the completed rows vanish instantly
    // as one atomic overlay — one wire mutation, rolled back together if
    // it's rejected.
    void syncClient.mutate.todos.clearCompleted().catch(() => {})
  }

  return (
    <main
      ref={mainRef}
      style={{ maxWidth: 480, margin: '3rem auto', fontFamily: 'system-ui, sans-serif', position: 'relative' }}
    >
      <h1 style={{ fontSize: '1.4rem' }}>
        cf-sync demo <small style={{ color: '#888' }}>#{workspaceId}</small>
      </h1>
      <p style={{ color: status === 'synced' ? '#2a2' : '#c80' }}>status: {status}</p>
      <p style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: '0.85rem' }}>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            background: `hsl(${hueOf(syncClient.clientId)} 70% 90%)`,
            border: `1px solid hsl(${hueOf(syncClient.clientId)} 60% 60%)`,
          }}
        >
          {displayName} (you)
        </span>
        {peers.map((peer) => (
          <span
            key={peer.clientId}
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: `hsl(${hueOf(peer.clientId)} 70% 90%)`,
              border: `1px solid hsl(${hueOf(peer.clientId)} 60% 60%)`,
            }}
          >
            {peer.state.name}
          </span>
        ))}
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTodo()}
          placeholder="Add a todo and press Enter"
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={addTodo}>Add</button>
      </div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {items.map((todo) => {
          const notesOpen = openNotes.has(todo.id)
          // Presence-driven invitation: a badge when someone is typing in
          // this todo's notes, visible even while the panel is closed.
          const typingHere = peers.some((peer) => peer.state.editing === notesFieldId(todo.id))
          return (
            <li key={todo.id} style={{ padding: '6px 0' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => todos.update(todo.id, (draft) => (draft.completed = !draft.completed))}
                />
                <span style={{ flex: 1, textDecoration: todo.completed ? 'line-through' : 'none' }}>
                  {todo.title}
                </span>
                <button
                  onClick={() => toggleNotes(todo.id)}
                  style={{ fontSize: '0.8rem' }}
                  title="Collaborative notes (Yjs field)"
                >
                  {notesOpen ? 'notes ▾' : 'notes ▸'}
                  {typingHere && <span style={{ color: '#2a2' }}> ●</span>}
                </button>
                <button onClick={() => todos.delete(todo.id)}>×</button>
              </div>
              {notesOpen && <NotesField todoId={todo.id} />}
            </li>
          )
        })}
      </ul>
      <button onClick={clearCompleted} disabled={!items.some((t) => t.completed)}>
        Clear completed (server intent)
      </button>
      <p style={{ color: '#888', fontSize: '0.85rem' }}>
        Open this page in a second tab: mutations sync, peer cursors move live, and a todo's notes
        merge character-by-character while both tabs type. Use a URL hash (e.g. #team-a) to switch
        workspaces.
      </p>
      {peers.map(
        (peer) =>
          peer.state.cursor && (
            <div
              key={peer.clientId}
              style={{
                position: 'absolute',
                left: peer.state.cursor.x,
                top: peer.state.cursor.y,
                pointerEvents: 'none',
                zIndex: 10,
                // Presence frames arrive at the 100ms throttle cadence;
                // easing between them keeps the motion smooth.
                transition: 'left 90ms linear, top 90ms linear',
              }}
            >
              <svg width="14" height="18" viewBox="0 0 14 18" style={{ display: 'block' }}>
                <path
                  d="M1 1 L13 10 L7.5 10.8 L4.5 16 Z"
                  fill={`hsl(${hueOf(peer.clientId)} 70% 55%)`}
                  stroke="white"
                  strokeWidth="1"
                />
              </svg>
              <span
                style={{
                  marginLeft: 10,
                  padding: '1px 6px',
                  borderRadius: 4,
                  fontSize: '0.7rem',
                  color: 'white',
                  background: `hsl(${hueOf(peer.clientId)} 70% 45%)`,
                  whiteSpace: 'nowrap',
                }}
              >
                {peer.state.name}
              </span>
            </div>
          ),
      )}
    </main>
  )
}
