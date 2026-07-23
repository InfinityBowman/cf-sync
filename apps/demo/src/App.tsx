import { useLiveQuery } from '@tanstack/react-db'
import { useEffect, useState } from 'react'
import { ulid } from 'ulidx'
import type { SyncStatus } from '@cf-sync/client'
import { syncClient, todos, workspaceId } from './sync'

export function App() {
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<SyncStatus>(syncClient.status)

  useEffect(() => {
    const onStatus = (event: Event) => setStatus((event as CustomEvent<SyncStatus>).detail)
    document.addEventListener('sync-status', onStatus)
    return () => document.removeEventListener('sync-status', onStatus)
  }, [])

  const { data: items } = useLiveQuery((q) =>
    q.from({ todo: todos }).orderBy(({ todo }) => todo.createdAt, 'asc'),
  )

  const addTodo = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    // `priority` is omitted: the schema default fills it in (client and server).
    todos.insert({ id: ulid(), title: trimmed, completed: false, createdAt: new Date().toISOString() })
    setTitle('')
  }

  const clearCompleted = () => {
    // Intent-based mutation: optimistic local effect + named server mutator,
    // typed against the shared registry (a typo'd name is a compile error).
    void syncClient.mutate('todos.clearCompleted').catch(() => {})
    for (const todo of items.filter((t) => t.completed)) {
      todos.delete(todo.id)
    }
  }

  return (
    <main style={{ maxWidth: 480, margin: '3rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.4rem' }}>
        cf-sync demo <small style={{ color: '#888' }}>#{workspaceId}</small>
      </h1>
      <p style={{ color: status === 'synced' ? '#2a2' : '#c80' }}>status: {status}</p>
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
        {items.map((todo) => (
          <li key={todo.id} style={{ display: 'flex', gap: 8, padding: '6px 0', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => todos.update(todo.id, (draft) => (draft.completed = !draft.completed))}
            />
            <span style={{ flex: 1, textDecoration: todo.completed ? 'line-through' : 'none' }}>
              {todo.title}
            </span>
            <button onClick={() => todos.delete(todo.id)}>×</button>
          </li>
        ))}
      </ul>
      <button onClick={clearCompleted} disabled={!items.some((t) => t.completed)}>
        Clear completed (server intent)
      </button>
      <p style={{ color: '#888', fontSize: '0.85rem' }}>
        Open this page in a second tab to watch mutations sync. Use a URL hash (e.g. #team-a) to
        switch workspaces.
      </p>
    </main>
  )
}
