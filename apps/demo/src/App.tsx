import { usePresence, useSyncStatus } from '@cf-sync/client/react'
import { useLiveQuery } from '@tanstack/react-db'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ulid } from 'ulidx'
import { NotesField, notesFieldId } from './NotesField'
import type { Todo } from './schema'
import { WORKSPACES, displayName, network, rejections, sessions, type Session } from './sync'

/** Stable per-peer hue so a cursor keeps its color as it moves. */
function hueOf(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0
  return ((hash % 360) + 360) % 360
}

const PRIORITY_ORDER = ['low', 'normal', 'high'] as const
const PRIORITY_COLOR: Record<Todo['priority'], string> = {
  low: 'text-[#5e93cf]',
  normal: 'text-ink-faint',
  high: 'text-[#d64545]',
}
const nextPriority = (p: Todo['priority']) =>
  PRIORITY_ORDER[(PRIORITY_ORDER.indexOf(p) + 1) % PRIORITY_ORDER.length]!

function PeerChip({ hue, name, self }: { hue: number; name: string; self?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border bg-white py-0.5 pr-2.5 pl-2 text-xs font-medium"
      style={{
        borderColor: `hsl(${hue} 45% 78%)`,
        color: `hsl(${hue} 45% 32%)`,
        boxShadow: self ? `0 0 0 2px hsl(${hue} 70% 88%)` : undefined,
      }}
    >
      <span className="size-1.5 rounded-full" style={{ background: `hsl(${hue} 70% 48%)` }} />
      {name}
      {self && <span className="text-ink-faint font-normal">· you</span>}
    </span>
  )
}

/**
 * Everything below the shell belongs to one workspace, so the whole subtree is
 * keyed on `workspaceId`: switching unmounts it (releasing every Yjs handle and
 * live query) and mounts a fresh one against the new session's collections. No
 * hook has to reason about its client changing underneath it.
 */
export function App() {
  const session = useSyncExternalStore(sessions.subscribe, sessions.get, sessions.get)
  return <Workspace key={session.workspaceId} session={session} />
}

function WorkspaceSwitcher({ current }: { current: string }) {
  // An id typed into the URL hash is offered alongside the built-in three.
  const ids = WORKSPACES.includes(current) ? WORKSPACES : [...WORKSPACES, current]
  return (
    <div className="border-line mt-3 inline-flex rounded-lg border bg-white p-0.5">
      {ids.map((id) => (
        <button
          key={id}
          onClick={() => void sessions.switchTo(id)}
          aria-current={id === current ? 'page' : undefined}
          title={
            id === current
              ? `#${id} — the workspace you are in`
              : `Switch to #${id}: a separate Durable Object with its own rows, sockets, and fields`
          }
          className={`cursor-pointer rounded-md px-2.5 py-1 font-mono text-xs ${
            id === current
              ? 'bg-[hsl(var(--self-hue)_60%_95%)] text-[hsl(var(--self-hue)_45%_32%)] font-medium'
              : 'text-ink-soft hover:text-ink hover:bg-paper'
          }`}
        >
          #{id}
        </button>
      ))}
    </div>
  )
}

function Workspace({ session }: { session: Session }) {
  const { client: syncClient, todos, workspaceId } = session
  const [title, setTitle] = useState('')
  // Which todos have their notes open — purely local UI state; the field
  // handle underneath is acquired/released as the panel mounts/unmounts.
  const [openNotes, setOpenNotes] = useState<ReadonlySet<string>>(new Set())
  const status = useSyncStatus(syncClient)
  const peers = usePresence(syncClient)
  // The latest rejection (sync.ts feeds onMutationRejected into this store),
  // rendered as a dismissible banner below the header.
  const rejection = useSyncExternalStore(rejections.subscribe, rejections.get, rejections.get)
  // The demo's simulated network cut (sync.ts) — the status pill keeps
  // reporting the client's real status, which is `reconnecting` while it holds.
  const offline = useSyncExternalStore(network.subscribe, network.isOffline, network.isOffline)
  const mainRef = useRef<HTMLElement>(null)
  const selfHue = hueOf(syncClient.clientId)

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
  }, [syncClient])

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
    // it's rejected. Fire-and-forget is safe: rejections surface through
    // the client's onMutationRejected (sync.ts), not per call site.
    void syncClient.mutate.todos.clearCompleted()
  }

  return (
    <main
      ref={mainRef}
      // Each tab's accent is its own peer hue (see index.css) — the presence
      // identity threaded through the chrome itself.
      style={{ '--self-hue': selfHue } as React.CSSProperties}
      className="font-sans text-ink relative mx-auto max-w-136 px-5 py-12"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-mono text-lg font-medium tracking-tight">cf-sync</h1>
        {/* Status first, the control that changes it directly underneath. */}
        <span className="ml-auto inline-flex flex-col items-end gap-1.5">
          <span className="inline-flex items-center gap-1.5 font-mono text-xs">
            <span
              className={
                status === 'synced'
                  ? 'size-2 rounded-full bg-[#3a9e5f]'
                  : 'motion-safe:animate-pulse size-2 rounded-full bg-[#d9930d]'
              }
            />
            <span className={status === 'synced' ? 'text-[#2e7d4c]' : 'text-[#a06c07]'}>{status}</span>
          </span>
          <button
            onClick={network.toggle}
            aria-pressed={offline}
            title="Simulate losing the network: mutations queue in the durable outbox and replay on reconnect"
            className={`cursor-pointer rounded-full border px-2.5 py-0.5 font-mono text-xs ${
              offline
                ? 'border-reject/40 bg-reject-soft text-reject'
                : 'border-line text-ink-soft hover:text-ink bg-white'
            }`}
          >
            {offline ? 'go online' : 'go offline'}
          </button>
        </span>
      </header>

      <WorkspaceSwitcher current={workspaceId} />

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <PeerChip hue={selfHue} name={displayName} self />
        {peers.map((peer) => (
          <PeerChip key={peer.clientId} hue={hueOf(peer.clientId)} name={peer.state.name ?? '?'} />
        ))}
      </div>

      {rejection && (
        <div className="border-reject/30 bg-reject-soft text-reject motion-safe:animate-[rise_150ms_ease-out] mt-4 flex items-baseline gap-2 rounded-lg border px-3.5 py-2.5 text-sm">
          <p className="flex-1">
            <strong className="font-semibold">{rejection.name}</strong> rejected{' '}
            <span className="font-mono text-xs">({rejection.code})</span>: {rejection.message}. The
            optimistic change was rolled back.
          </p>
          <button
            onClick={rejections.dismiss}
            aria-label="Dismiss"
            className="cursor-pointer self-center rounded p-1 leading-none hover:bg-white/60"
          >
            ×
          </button>
        </div>
      )}

      <div className="mt-5 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTodo()}
          placeholder="Add a todo and press Enter"
          className="border-line placeholder:text-ink-faint min-w-0 flex-1 rounded-lg border bg-white px-3.5 py-2 text-sm outline-none focus:border-[hsl(var(--self-hue)_55%_60%)] focus:ring-2 focus:ring-[hsl(var(--self-hue)_70%_86%)]"
        />
        <button
          onClick={addTodo}
          className="bg-ink cursor-pointer rounded-lg px-4 py-2 text-sm font-medium text-white hover:bg-[#33333a] focus-visible:ring-2 focus-visible:ring-[hsl(var(--self-hue)_60%_60%)] focus-visible:outline-none"
        >
          Add
        </button>
      </div>

      <ul className="border-line divide-line mt-4 divide-y rounded-xl border bg-white shadow-[0_1px_3px_rgb(0_0_0/0.04)]">
        {items.length === 0 && (
          <li className="text-ink-soft px-4 py-8 text-center text-sm">
            Nothing here yet. Add the first todo, then open this page in a second tab.
          </li>
        )}
        {items.map((todo) => {
          const notesOpen = openNotes.has(todo.id)
          // Presence-driven invitation: a badge when someone is typing in
          // this todo's notes, visible even while the panel is closed.
          const typingHere = peers.some((peer) => peer.state.editing === notesFieldId(todo.id))
          return (
            <li key={todo.id} className="group px-4 py-2.5">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => todos.update(todo.id, (draft) => (draft.completed = !draft.completed))}
                  className="size-4 shrink-0 cursor-pointer accent-[hsl(var(--self-hue)_60%_42%)]"
                />
                {/* The v1→v2 migration made visible: rows written before v2
                    were backfilled to 'normal' (schema.ts), new rows get the
                    schema default. Cycling goes through the setPriority
                    intent, whose completed-todo rule runs only on the server
                    — on a completed todo the dot changes, then snaps back
                    when the rejection arrives (and the banner explains). */}
                <button
                  onClick={() =>
                    void syncClient.mutate.todos.setPriority({ id: todo.id, priority: nextPriority(todo.priority) })
                  }
                  title={`priority: ${todo.priority}. Click to cycle (the server rejects this on completed todos)`}
                  className={`-m-1.5 shrink-0 cursor-pointer p-1.5 text-[0.6rem] leading-none ${PRIORITY_COLOR[todo.priority]}`}
                >
                  ●
                </button>
                <span
                  className={`flex-1 text-sm ${todo.completed ? 'text-ink-faint line-through' : ''}`}
                >
                  {todo.title}
                </span>
                <button
                  onClick={() => toggleNotes(todo.id)}
                  title="Collaborative notes (Yjs field)"
                  className="text-ink-soft hover:border-line cursor-pointer rounded-md border border-transparent px-1.5 py-0.5 font-mono text-xs hover:bg-paper"
                >
                  notes {notesOpen ? '▾' : '▸'}
                  {typingHere && <span className="ml-1 text-[#3a9e5f]">●</span>}
                </button>
                <button
                  onClick={() => todos.delete(todo.id)}
                  aria-label={`Delete "${todo.title}"`}
                  className="text-ink-faint hover:text-reject cursor-pointer rounded-md px-1 py-0.5 leading-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  ×
                </button>
              </div>
              {notesOpen && <NotesField session={session} todoId={todo.id} />}
            </li>
          )
        })}
      </ul>

      <div className="mt-4 flex items-baseline justify-between gap-3">
        <button
          onClick={clearCompleted}
          disabled={!items.some((t) => t.completed)}
          className="border-line text-ink-soft enabled:hover:text-ink cursor-pointer rounded-lg border bg-white px-3 py-1.5 text-xs font-medium enabled:hover:border-[#c9c9cf] disabled:cursor-default disabled:opacity-45"
        >
          Clear completed
        </button>
        <span className="text-ink-faint font-mono text-[0.65rem]">server intent · one wire mutation</span>
      </div>

      <p className="text-ink-soft mt-6 text-xs leading-relaxed">
        Open this page in a second tab: mutations sync, peer cursors move live, and a todo's notes
        merge character-by-character while both tabs type. Complete a todo, then click its priority
        dot: the server rejects the change and the optimistic update rolls back. Hit{' '}
        <span className="font-mono">go offline</span> and keep working — mutations queue locally
        (a reload still shows them, from IndexedDB) and replay when you come back. Switch
        workspaces to reach a different Durable Object, with its own rows and peers: no reload,
        just the old client torn down and a new one built.
      </p>

      {peers.map(
        (peer) =>
          peer.state.cursor && (
            <div
              key={peer.clientId}
              className="pointer-events-none absolute z-10"
              style={{
                left: peer.state.cursor.x,
                top: peer.state.cursor.y,
                // Presence frames arrive at the 100ms throttle cadence;
                // easing between them keeps the motion smooth.
                transition: 'left 90ms linear, top 90ms linear',
              }}
            >
              <svg width="14" height="18" viewBox="0 0 14 18" className="block drop-shadow-sm">
                <path
                  d="M1 1 L13 10 L7.5 10.8 L4.5 16 Z"
                  fill={`hsl(${hueOf(peer.clientId)} 70% 55%)`}
                  stroke="white"
                  strokeWidth="1"
                />
              </svg>
              <span
                className="ml-2.5 rounded px-1.5 py-px text-[0.7rem] whitespace-nowrap text-white shadow-sm"
                style={{ background: `hsl(${hueOf(peer.clientId)} 70% 45%)` }}
              >
                {peer.state.name}
              </span>
            </div>
          ),
      )}
    </main>
  )
}
