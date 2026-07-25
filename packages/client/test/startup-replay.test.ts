import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SyncClient, type MutationError } from '../src/client'
import { createCollections } from '../src/collection'
import { AppError, crudMutators, defineApp, defineMutators, defineSchema } from '../src/index'
import { MemorySyncStore } from '../src/store'
import { FakeSocket, flushMicrotasks } from './fake-socket'

// Startup replay of queued intents (DESIGN.md §7.2): hydration re-runs each
// restored outbox entry's shared `apply` against the hydrated base and lays
// the writes as the same atomic overlay a live `mutate` produces, so the
// reloaded UI matches the pre-reload optimistic view. Replay failures
// degrade — no overlay, entry stays queued — never drop.

const schema = defineSchema({
  todos: z.object({
    id: z.string(),
    title: z.string(),
    completed: z.boolean(),
    priority: z.string().default('normal'),
  }),
})

const mutators = defineMutators(schema, {
  ...crudMutators(schema),
  'todos.add': {
    args: z.object({ id: z.string(), title: z.string() }),
    apply: (tx, { id, title }) => {
      tx.put('todos', id, { id, title, completed: false })
    },
  },
  'todos.complete': {
    args: z.object({ id: z.string() }),
    apply: (tx, { id }) => {
      const todo = tx.get('todos', id)
      if (!todo) throw new AppError('NotFound', `todo ${id} does not exist`)
      tx.put('todos', id, { ...todo, completed: true })
    },
  },
  'todos.clearCompleted': {
    apply: (tx) => {
      for (const { id, data } of tx.list('todos')) {
        if (data.completed) tx.del('todos', id)
      }
    },
  },
})

const app = defineApp({ version: 1, schema, mutators })
const SCHEMA_VERSION = 1
const CLIENT_ID = 'client-a'

/** One "browser session": a client plus its collections over a shared store. */
function session(
  store: MemorySyncStore,
  overrides: { onMutationRejected?: (error: MutationError, mutation: { name: string; args: unknown }) => void } = {},
) {
  const sockets: FakeSocket[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: CLIENT_ID,
    autoStart: false,
    app,
    store,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    ...overrides,
  })
  const { todos } = createCollections(client)
  client.start()
  return { client, todos, sockets, latest: () => sockets[sockets.length - 1]! }
}

/** Seeds the store as if a previous session had synced rows and queued mutations. */
async function seedStore(
  store: MemorySyncStore,
  opts: {
    rows?: { tbl: string; id: string; value: Record<string, unknown> }[]
    outbox?: { id: number | null; name: string; args: unknown }[]
  },
): Promise<void> {
  if (opts.rows) {
    await store.applyPoke({
      ops: opts.rows.map((r) => ({ op: 'put' as const, tbl: r.tbl, id: r.id, value: r.value })),
      clear: true,
      cursor: { backendId: 'b1', version: 1 },
      schemaVersion: SCHEMA_VERSION,
      confirmedLmid: 0,
      outbox: [],
    })
  }
  if (opts.outbox) await store.saveOutbox(opts.outbox, 0)
}

/** Bootstrap-with-clear poke confirming nothing (fresh server). */
function bootstrap(socket: FakeSocket): void {
  socket.receive({ type: 'pokeStart', pokeId: 'boot', baseCursor: null })
  socket.receive({ type: 'pokePart', pokeId: 'boot', patch: [{ op: 'clear' }], lastMutationIdChanges: { [CLIENT_ID]: 0 } })
  socket.receive({ type: 'pokeEnd', pokeId: 'boot', cursor: { backendId: 'b1', version: 1 }, pageInfo: { more: false } })
}

/** Confirms mutations up to `lmid`, applying `patch` in the same poke. */
function confirm(
  socket: FakeSocket,
  lmid: number,
  patch: Array<
    { op: 'put'; tbl: string; id: string; value: Record<string, unknown> } | { op: 'del'; tbl: string; id: string }
  >,
  opts: { base?: number; errors?: Array<{ id: number; code: string; message: string }> } = {},
): void {
  const pokeId = `confirm-${lmid}`
  const results = []
  for (let id = 1; id <= lmid; id++) {
    const error = opts.errors?.find((e) => e.id === id)
    results.push(error ? { id, error: { code: error.code, message: error.message } } : { id })
  }
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: { backendId: 'b1', version: opts.base ?? 1 } })
  socket.receive({
    type: 'pokePart',
    pokeId,
    patch,
    lastMutationIdChanges: { [CLIENT_ID]: lmid },
    mutationResults: results,
  })
  socket.receive({
    type: 'pokeEnd',
    pokeId,
    cursor: { backendId: 'b1', version: (opts.base ?? 1) + 1 },
    pageInfo: { more: false },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startup replay of queued intents', () => {
  it('re-lays intent overlays at hydration, before any connection (real reload flow)', async () => {
    const store = new MemorySyncStore()

    // Session 1: two intents queued while the socket never connects. The
    // second reads the first's overlay — sequencing that must survive replay.
    const first = session(store)
    await flushMicrotasks()
    void first.client.mutate('todos.add', { id: 't1', title: 'offline' }).catch(() => {})
    void first.client.mutate('todos.complete', { id: 't1' }).catch(() => {})
    await flushMicrotasks()
    expect(first.todos.get('t1')).toMatchObject({ title: 'offline', completed: true })
    await first.client.destroy()
    expect((await store.load())?.outbox).toHaveLength(2)

    // Session 2 ("after reload"): overlays are back before the socket opens.
    const second = session(store)
    await flushMicrotasks()
    expect(second.todos.get('t1')).toMatchObject({ title: 'offline', completed: true, priority: 'normal' })
    await second.client.destroy()
  })

  it('replays against hydrated cached rows: clearCompleted hides the cached completed row', async () => {
    const store = new MemorySyncStore()
    await seedStore(store, {
      rows: [
        { tbl: 'todos', id: 't1', value: { id: 't1', title: 'active', completed: false, priority: 'normal' } },
        { tbl: 'todos', id: 't2', value: { id: 't2', title: 'done', completed: true, priority: 'normal' } },
      ],
      outbox: [{ id: null, name: 'todos.clearCompleted', args: undefined }],
    })

    const { client, todos } = session(store)
    await flushMicrotasks()
    expect(todos.has('t1')).toBe(true)
    expect(todos.has('t2')).toBe(false) // hidden by the replayed overlay
    await client.destroy()
  })

  it('crud outbox entries replay too: an offline sync.put reappears', async () => {
    const store = new MemorySyncStore()
    await seedStore(store, {
      outbox: [
        {
          id: null,
          name: 'sync.put',
          args: { tbl: 'todos', id: 't1', data: { id: 't1', title: 'offline row', completed: false } },
        },
      ],
    })

    const { client, todos } = session(store)
    await flushMicrotasks()
    // Overlay carries the schema-parsed output (default applied), like live.
    expect(todos.get('t1')).toMatchObject({ title: 'offline row', priority: 'normal' })
    await client.destroy()
  })

  it('confirm swaps the replayed overlay for the authoritative patch and drains the outbox', async () => {
    const store = new MemorySyncStore()
    await seedStore(store, {
      outbox: [{ id: null, name: 'todos.add', args: { id: 't1', title: 'offline' } }],
    })

    const { client, todos, latest } = session(store)
    await flushMicrotasks()
    const socket = latest()
    socket.open()
    bootstrap(socket)
    await flushMicrotasks()

    const push = socket.takeSent().find((m) => m.type === 'push')
    expect(push).toMatchObject({ mutations: [{ id: 1, name: 'todos.add', args: { id: 't1', title: 'offline' } }] })

    confirm(socket, 1, [
      { op: 'put', tbl: 'todos', id: 't1', value: { id: 't1', title: 'offline', completed: false, priority: 'normal' } },
    ])
    await flushMicrotasks()

    expect(todos.get('t1')).toMatchObject({ title: 'offline' })
    expect(todos.size).toBe(1)
    expect((await store.load())?.outbox).toEqual([])
    await client.destroy()
  })

  it('server rejection rolls the replayed overlay back and reports through onMutationRejected', async () => {
    const store = new MemorySyncStore()
    await seedStore(store, {
      outbox: [{ id: null, name: 'todos.add', args: { id: 't1', title: 'doomed' } }],
    })

    const rejections: Array<{ code: string; name: string }> = []
    const { client, todos, latest } = session(store, {
      onMutationRejected: (error, { name }) => rejections.push({ code: String(error.code), name }),
    })
    await flushMicrotasks()
    expect(todos.has('t1')).toBe(true) // overlay up after hydration

    const socket = latest()
    socket.open()
    bootstrap(socket)
    await flushMicrotasks()
    confirm(socket, 1, [], { errors: [{ id: 1, code: 'Forbidden', message: 'nope' }] })
    await flushMicrotasks()

    expect(todos.has('t1')).toBe(false) // rolled back with the rejection
    expect(rejections).toEqual([{ code: 'Forbidden', name: 'todos.add' }])
    await client.destroy()
  })

  it('a replay throw degrades: no overlay, warns, entry stays queued and still pushes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new MemorySyncStore()
    // `todos.complete` of a row that does not exist locally throws NotFound
    // at replay — but the server's run is the verdict that counts.
    await seedStore(store, {
      outbox: [{ id: null, name: 'todos.complete', args: { id: 'ghost' } }],
    })

    const { client, todos, latest } = session(store)
    await flushMicrotasks()
    expect(todos.size).toBe(0) // no overlay
    expect(warn.mock.calls.some((c) => String(c[0]).includes('startup replay'))).toBe(true)

    const socket = latest()
    socket.open()
    bootstrap(socket)
    await flushMicrotasks()
    const push = socket.takeSent().find((m) => m.type === 'push')
    expect(push).toMatchObject({ mutations: [{ id: 1, name: 'todos.complete', args: { id: 'ghost' } }] })

    confirm(socket, 1, [], { errors: [{ id: 1, code: 'NotFound', message: 'gone' }] })
    await flushMicrotasks()
    expect((await store.load())?.outbox).toEqual([])
    await client.destroy()
  })

  it('replay is skipped without collections: entries queue and push exactly as before', async () => {
    const store = new MemorySyncStore()
    await seedStore(store, {
      outbox: [{ id: null, name: 'todos.add', args: { id: 't1', title: 'no ui' } }],
    })

    const sockets: FakeSocket[] = []
    const client = new SyncClient({
      url: 'ws://test',
      workspaceId: 'w1',
      clientId: CLIENT_ID,
      autoStart: false,
      app,
      store,
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    client.start()
    await flushMicrotasks()
    const socket = sockets[sockets.length - 1]!
    socket.open()
    bootstrap(socket)
    await flushMicrotasks()
    const push = socket.takeSent().find((m) => m.type === 'push')
    expect(push).toMatchObject({ mutations: [{ id: 1, name: 'todos.add' }] })
    await client.destroy()
  })
})
