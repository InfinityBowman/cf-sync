import { createCollection } from '@tanstack/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SyncClient } from '../src/client'
import { MutationError } from '../src/errors'
import { createCollections, workspaceCollectionOptions } from '../src/collection'
import { AppError, crudMutators, defineApp, defineMutators, defineSchema } from '../src/index'
import { FakeSocket, flushMicrotasks } from './fake-socket'

// Optimistic intent execution (ARCHITECTURE.md#optimistic-intents): `mutate` runs the shared
// mutator locally against the collections and lands its writes as one atomic
// overlay — one wire mutation, no crud echoes, rolled back on rejection.

const schema = defineSchema({
  todos: z.object({
    id: z.string(),
    title: z.string(),
    completed: z.boolean(),
    priority: z.string().default('normal'),
  }),
  notes: z.object({
    id: z.string(),
    body: z.string(),
  }),
})

const mutators = defineMutators(schema, {
  ...crudMutators(schema),
  'todos.clearCompleted': {
    apply: (tx) => {
      for (const { id, data } of tx.list('todos')) {
        if (data.completed) tx.del('todos', id)
      }
    },
  },
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
  'todos.mirrorToNotes': {
    args: z.object({ id: z.string() }),
    apply: (tx, { id }) => {
      const todo = tx.get('todos', id)
      if (todo) tx.put('notes', id, { id, body: String(todo.title) })
    },
  },
  'todos.blowUp': {
    apply: () => {
      throw new TypeError('not an AppError')
    },
  },
})

const app = defineApp({ version: 1, schema, mutators })
const CLIENT_ID = 'client-a'

type Todo = { id: string; title: string; completed: boolean; priority: string }

function setup(opts: { confirmTimeoutMs?: number } = {}) {
  const sockets: FakeSocket[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: CLIENT_ID,
    autoStart: false,
    app,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    ...opts,
  })
  // Only `todos` gets a collection: `notes` stays unattached so degradation
  // is observable. The applier attaches at sync start (startSync: true).
  const todos = createCollection(
    workspaceCollectionOptions({ client, table: 'todos', startSync: true }),
  )
  client.start()
  const socket = sockets[sockets.length - 1]!
  socket.open()
  return { client, todos, socket }
}

function bootstrap(socket: FakeSocket, rows: Todo[]): void {
  const pokeId = 'poke-bootstrap'
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: null })
  socket.receive({
    type: 'pokePart',
    pokeId,
    patch: [{ op: 'clear' }, ...rows.map((value) => ({ op: 'put' as const, tbl: 'todos', id: value.id, value }))],
    lastMutationIdChanges: { [CLIENT_ID]: 0 },
  })
  socket.receive({ type: 'pokeEnd', pokeId, cursor: { backendId: 'b1', version: 1 }, pageInfo: { more: false } })
}

/** Confirms mutations up to `lmid`, applying `patch` rows in the same poke. */
function confirm(
  socket: FakeSocket,
  lmid: number,
  patch: Array<{ op: 'put'; tbl: string; id: string; value: Record<string, unknown> } | { op: 'del'; tbl: string; id: string }>,
  opts: { version?: number; errors?: Array<{ id: number; code: string; message: string }> } = {},
): void {
  const pokeId = `poke-confirm-${lmid}`
  const results = []
  for (let id = 1; id <= lmid; id++) {
    const error = opts.errors?.find((e) => e.id === id)
    results.push(error ? { id, error: { code: error.code, message: error.message } } : { id })
  }
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: { backendId: 'b1', version: opts.version ?? 1 } })
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
    cursor: { backendId: 'b1', version: (opts.version ?? 1) + 1 },
    pageInfo: { more: false },
  })
}

const todo = (id: string, title: string, completed = false): Todo => ({ id, title, completed, priority: 'normal' })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('optimistic intent mutations', () => {
  it('applies the shared mutator locally and pushes exactly one wire mutation', async () => {
    const { client, todos, socket } = setup()
    bootstrap(socket, [todo('t1', 'keep'), todo('t2', 'done', true), todo('t3', 'also done', true)])
    await todos.preload()
    socket.takeSent()

    const pending = client.mutate('todos.clearCompleted')
    // Optimistic overlay: completed rows vanish synchronously.
    expect(todos.has('t2')).toBe(false)
    expect(todos.has('t3')).toBe(false)
    expect(todos.has('t1')).toBe(true)

    await flushMicrotasks()
    const pushes = socket.takeSent().filter((m) => m.type === 'push')
    expect(pushes).toHaveLength(1)
    // One intent mutation — no sync.del echoes from the optimistic deletes.
    expect(pushes[0]!.mutations).toEqual([{ id: 1, name: 'todos.clearCompleted', args: undefined }])

    confirm(socket, 1, [
      { op: 'del', tbl: 'todos', id: 't2' },
      { op: 'del', tbl: 'todos', id: 't3' },
    ])
    await pending
    expect([...todos.keys()]).toEqual(['t1'])
  })

  it('swaps overlay for the authoritative patch without the row flickering', async () => {
    const { client, todos, socket } = setup()
    bootstrap(socket, [])
    await todos.preload()
    socket.takeSent()

    const pending = client.mutate('todos.add', { id: 't9', title: 'new' })
    expect(todos.get('t9')).toMatchObject({ title: 'new', completed: false })

    // Watch for any event that removes t9 between optimistic apply and confirm.
    const removals: unknown[] = []
    const subscription = todos.subscribeChanges((changes) => {
      for (const change of changes) if (change.type === 'delete' && change.key === 't9') removals.push(change)
    })

    await flushMicrotasks()
    confirm(socket, 1, [
      { op: 'put', tbl: 'todos', id: 't9', value: { id: 't9', title: 'new', completed: false, priority: 'normal' } },
    ])
    await pending
    subscription.unsubscribe()

    expect(removals).toEqual([])
    expect(todos.get('t9')).toMatchObject({ title: 'new', priority: 'normal' })
    expect(todos.size).toBe(1)
  })

  it('the overlay carries the schema-parsed output (defaults applied), like the confirm patch will', async () => {
    const { client, todos, socket } = setup()
    bootstrap(socket, [])
    await todos.preload()
    socket.takeSent()

    void client.mutate('todos.add', { id: 't1', title: 'x' }).catch(() => {})
    // `priority` was not written by the mutator; the schema default fills it
    // in locally exactly as the server's put will.
    expect(todos.get('t1')).toMatchObject({ priority: 'normal' })
  })

  it('rolls the overlay back when the server permanently rejects the mutation', async () => {
    const { client, todos, socket } = setup()
    bootstrap(socket, [todo('t1', 'a')])
    await todos.preload()
    socket.takeSent()

    const pending = client.mutate('todos.complete', { id: 't1' })
    expect(todos.get('t1')).toMatchObject({ completed: true })

    await flushMicrotasks()
    // Server: permanent app error — LMID advances, no data effects.
    confirm(socket, 1, [], { errors: [{ id: 1, code: 'NotFound', message: 'gone on the server' }] })

    await expect(pending).rejects.toMatchObject({ code: 'NotFound' })
    expect(todos.get('t1')).toMatchObject({ completed: false })
  })

  it('fails fast on a local AppError: rejects with its code, queues nothing, no overlay', async () => {
    const { client, todos, socket } = setup()
    bootstrap(socket, [todo('t1', 'a')])
    await todos.preload()
    socket.takeSent()

    await expect(client.mutate('todos.complete', { id: 'ghost' })).rejects.toMatchObject({
      name: 'MutationError',
      code: 'NotFound',
    })
    await flushMicrotasks()
    expect(socket.takeSent().filter((m) => m.type === 'push')).toHaveLength(0)
    expect(todos.size).toBe(1)
  })

  it('rejects non-AppError local throws as LocalApplyFailed', async () => {
    const { client, todos, socket } = setup()
    bootstrap(socket, [])
    await todos.preload()

    await expect(client.mutate('todos.blowUp')).rejects.toMatchObject({ code: 'LocalApplyFailed' })
  })

  it('still enqueues when the local run writes nothing (local state may be behind)', async () => {
    const { client, todos, socket } = setup()
    bootstrap(socket, [todo('t1', 'active')]) // nothing completed locally
    await todos.preload()
    socket.takeSent()

    const pending = client.mutate('todos.clearCompleted')
    await flushMicrotasks()
    const pushes = socket.takeSent().filter((m) => m.type === 'push')
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.mutations).toEqual([{ id: 1, name: 'todos.clearCompleted', args: undefined }])

    confirm(socket, 1, [])
    await pending
  })

  it('still enqueues when the flush nets out to zero collection writes (delete of an absent row)', async () => {
    const { client, todos, socket } = setup()
    bootstrap(socket, [])
    await todos.preload()
    socket.takeSent()

    // Write set is non-empty (one del) but the collection has nothing to
    // delete — TanStack would resolve the empty transaction without ever
    // calling mutationFn; the runner must fall through to a direct enqueue.
    const pending = client.mutate('sync.del', { tbl: 'todos', id: 'ghost' })
    await flushMicrotasks()
    const pushes = socket.takeSent().filter((m) => m.type === 'push')
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.mutations).toEqual([{ id: 1, name: 'sync.del', args: { tbl: 'todos', id: 'ghost' } }])

    confirm(socket, 1, [])
    await pending
  })

  it('degrades to no overlay (warn once) when the mutator touches a table with no collection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, todos, socket } = setup()
    bootstrap(socket, [todo('t1', 'a')])
    await todos.preload()
    socket.takeSent()

    const first = client.mutate('todos.mirrorToNotes', { id: 't1' })
    const second = client.mutate('todos.mirrorToNotes', { id: 't1' })
    await flushMicrotasks()

    // Both mutations still reach the server; the warning fires once.
    const pushes = socket.takeSent().filter((m) => m.type === 'push')
    expect(pushes.flatMap((p) => p.mutations.map((m) => m.name))).toEqual([
      'todos.mirrorToNotes',
      'todos.mirrorToNotes',
    ])
    const degradedWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('no attached collection'))
    expect(degradedWarnings).toHaveLength(1)

    confirm(socket, 2, [])
    await Promise.all([first, second])
  })

  it('overlapping intents read each other: the second sees the first pending overlay', async () => {
    const { client, todos, socket } = setup()
    bootstrap(socket, [todo('t1', 'a')])
    await todos.preload()
    socket.takeSent()

    const complete = client.mutate('todos.complete', { id: 't1' })
    // clearCompleted's tx.list must see t1 as completed via the pending overlay.
    const clear = client.mutate('todos.clearCompleted')
    expect(todos.has('t1')).toBe(false)

    await flushMicrotasks()
    const pushed = socket
      .takeSent()
      .filter((m) => m.type === 'push')
      .flatMap((p) => p.mutations.map((m) => m.name))
    expect(pushed).toEqual(['todos.complete', 'todos.clearCompleted'])

    confirm(socket, 2, [{ op: 'del', tbl: 'todos', id: 't1' }])
    await Promise.all([complete, clear])
    expect(todos.size).toBe(0)
  })

  it('a timeout rejection (memory-only client) rolls the overlay back', async () => {
    vi.useFakeTimers()
    try {
      const { client, todos, socket } = setup({ confirmTimeoutMs: 50 })
      bootstrap(socket, [todo('t2', 'done', true)])
      const preloaded = todos.preload()
      await vi.runAllTimersAsync()
      await preloaded
      socket.takeSent()

      const pending = client.mutate('todos.clearCompleted')
      const rejection = expect(pending).rejects.toMatchObject({ code: 'Timeout' })
      expect(todos.has('t2')).toBe(false)

      await vi.advanceTimersByTimeAsync(60)
      await rejection
      // No confirm ever arrived: the optimistic delete is rolled back.
      expect(todos.has('t2')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('crud collection writes still push exactly one mutation (no recursive re-apply)', async () => {
    const { todos, socket } = setup()
    bootstrap(socket, [])
    await todos.preload()
    socket.takeSent()

    todos.insert({ id: 't1', title: 'direct', completed: false })
    await flushMicrotasks()
    const pushes = socket.takeSent().filter((m) => m.type === 'push')
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.mutations).toHaveLength(1)
    expect(pushes[0]!.mutations[0]).toMatchObject({ name: 'sync.put', args: { tbl: 'todos', id: 't1' } })
    expect(todos.size).toBe(1)
  })

  it('a lazy collection created up front syncs without a second hello (no late-registration resync)', async () => {
    const sockets: FakeSocket[] = []
    const client = new SyncClient({
      url: 'ws://test',
      workspaceId: 'w3',
      clientId: CLIENT_ID,
      autoStart: false,
      app,
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    // No startSync and no subscriber: TanStack's sync pipeline stays idle.
    const todos = createCollection(workspaceCollectionOptions({ client, table: 'todos' }))
    client.start()
    const socket = sockets[sockets.length - 1]!
    socket.open()
    bootstrap(socket, [todo('t1', 'buffered', false)])

    // Data arrived while nothing was subscribed — the gate buffered it.
    await todos.preload()
    expect(todos.get('t1')).toMatchObject({ title: 'buffered' })

    // One hello total: registration at creation means first subscription
    // drains the buffer instead of forcing a full resync.
    const hellos = socket.sent.filter((m) => m.type === 'hello')
    expect(hellos).toHaveLength(1)
  })

  it('the gate compacts buffered ops: last write per row wins across pokes', async () => {
    const sockets: FakeSocket[] = []
    const client = new SyncClient({
      url: 'ws://test',
      workspaceId: 'w4',
      clientId: CLIENT_ID,
      autoStart: false,
      app,
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    const todos = createCollection(workspaceCollectionOptions({ client, table: 'todos' }))
    client.start()
    const socket = sockets[sockets.length - 1]!
    socket.open()
    bootstrap(socket, [todo('t1', 'v1'), todo('t2', 'doomed')])
    // A second poke lands while still unsubscribed: t1 rewritten, t2 deleted.
    confirm(socket, 0, [
      { op: 'put', tbl: 'todos', id: 't1', value: todo('t1', 'v2') },
      { op: 'del', tbl: 'todos', id: 't2' },
    ])

    await todos.preload()
    expect(todos.get('t1')).toMatchObject({ title: 'v2' })
    expect(todos.has('t2')).toBe(false)
    expect(todos.size).toBe(1)
  })

  it('createCollections attaches appliers at creation, before any subscriber', async () => {
    const sockets: FakeSocket[] = []
    const client = new SyncClient({
      url: 'ws://test',
      workspaceId: 'w2',
      clientId: CLIENT_ID,
      autoStart: false,
      app,
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    const { todos } = createCollections(client)
    client.start()
    const socket = sockets[sockets.length - 1]!
    socket.open()
    bootstrap(socket, [])
    socket.takeSent()

    // No subscriber yet — the eager applier still gives the intent an overlay.
    void client.mutate('todos.add', { id: 't1', title: 'early' }).catch(() => {})
    expect(todos.get('t1')).toMatchObject({ title: 'early' })

    await flushMicrotasks()
    const pushes = socket.takeSent().filter((m) => m.type === 'push')
    expect(pushes.flatMap((p) => p.mutations.map((m) => m.name))).toEqual(['todos.add'])
  })
})

describe('property-access mutate namespace', () => {
  it('mutate.todos.add() is the same call as mutate("todos.add")', async () => {
    const { client, todos, socket } = setup()
    bootstrap(socket, [])
    await todos.preload()
    socket.takeSent()

    const pending = client.mutate.todos.add({ id: 't9', title: 'via namespace' })
    // Same optimistic overlay as the string form...
    expect(todos.get('t9')).toMatchObject({ title: 'via namespace', completed: false })

    await flushMicrotasks()
    // ...and the identical wire mutation.
    const pushes = socket.takeSent().filter((m) => m.type === 'push')
    expect(pushes[0]!.mutations).toEqual([
      { id: 1, name: 'todos.add', args: { id: 't9', title: 'via namespace' } },
    ])

    confirm(socket, 1, [
      { op: 'put', tbl: 'todos', id: 't9', value: { id: 't9', title: 'via namespace', completed: false, priority: 'normal' } },
    ])
    await pending
  })

  it('no-arg leaves and validation behave like the string form', async () => {
    const { client, todos, socket } = setup()
    bootstrap(socket, [todo('t1', 'done', true)])
    await todos.preload()
    socket.takeSent()

    // Local fail-fast arg validation is shared with the string form.
    await expect(client.mutate.todos.add({ id: 1 } as never)).rejects.toSatisfy(
      (e) => e instanceof MutationError && e.code === 'InvalidArgs',
    )

    const pending = client.mutate.todos.clearCompleted()
    expect(todos.has('t1')).toBe(false)
    await flushMicrotasks()
    const pushes = socket.takeSent().filter((m) => m.type === 'push')
    expect(pushes[0]!.mutations).toEqual([{ id: 1, name: 'todos.clearCompleted', args: undefined }])
    confirm(socket, 1, [{ op: 'del', tbl: 'todos', id: 't1' }])
    await pending
  })

  it('tolerates mutator names that shadow Function properties', async () => {
    const shadowSchema = defineSchema({ todos: z.record(z.string(), z.unknown()) })
    const shadowMutators = defineMutators(shadowSchema, {
      ...crudMutators(shadowSchema),
      name: { apply: () => {} },
      length: { apply: () => {} },
      'call.me': { apply: () => {} },
    })
    const sockets: FakeSocket[] = []
    const client = new SyncClient({
      url: 'ws://test',
      workspaceId: 'w1',
      clientId: CLIENT_ID,
      autoStart: false,
      app: defineApp({ version: 1, schema: shadowSchema, mutators: shadowMutators }),
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    expect(typeof client.mutate.name).toBe('function')
    expect(typeof client.mutate.length).toBe('function')
    expect(typeof client.mutate.call.me).toBe('function')

    client.start()
    const socket = sockets[0]!
    socket.open()
    socket.receive({ type: 'pokeStart', pokeId: 'p', baseCursor: null })
    socket.receive({ type: 'pokePart', pokeId: 'p', patch: [{ op: 'clear' }], lastMutationIdChanges: { [CLIENT_ID]: 0 } })
    socket.receive({ type: 'pokeEnd', pokeId: 'p', cursor: { backendId: 'b1', version: 1 }, pageInfo: { more: false } })
    socket.takeSent()

    const pending = client.mutate.call.me()
    await flushMicrotasks()
    const pushes = socket.takeSent().filter((m) => m.type === 'push')
    expect(pushes[0]!.mutations).toEqual([{ id: 1, name: 'call.me', args: undefined }])
    socket.receive({ type: 'pokeStart', pokeId: 'c', baseCursor: { backendId: 'b1', version: 1 } })
    socket.receive({
      type: 'pokePart',
      pokeId: 'c',
      patch: [],
      lastMutationIdChanges: { [CLIENT_ID]: 1 },
      mutationResults: [{ id: 1 }],
    })
    socket.receive({ type: 'pokeEnd', pokeId: 'c', cursor: { backendId: 'b1', version: 1 }, pageInfo: { more: false } })
    await pending
  })
})
