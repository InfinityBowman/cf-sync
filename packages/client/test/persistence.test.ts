import type { Cursor } from '@cf-sync/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { SyncClient, type TableWriteOp } from '../src/client'
import { MemorySyncStore } from '../src/store'
import { testSchema } from './test-schema'
import { FakeSocket, flushMicrotasks } from './fake-socket'

const SCHEMA = 'test-1'
const CLIENT_ID = 'client-a'

class RecordingHooks {
  rows = new Map<string, Record<string, unknown>>()
  ready = false
  truncates = 0
  #pending: TableWriteOp[] | null = null
  #pendingTruncate = false

  hooks = {
    begin: () => {
      this.#pending = []
      this.#pendingTruncate = false
    },
    write: (op: TableWriteOp) => {
      this.#pending!.push(op)
    },
    commit: () => {
      if (this.#pendingTruncate) {
        this.rows.clear()
        this.truncates++
      }
      for (const op of this.#pending!) {
        if (op.type === 'put') this.rows.set(op.id, op.value)
        else this.rows.delete(op.id)
      }
      this.#pending = null
    },
    truncate: () => {
      this.#pendingTruncate = true
    },
    markReady: () => {
      this.ready = true
    },
  }
}

function makeClient(store: MemorySyncStore, overrides: Partial<ConstructorParameters<typeof SyncClient>[0]> = {}) {
  const sockets: FakeSocket[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: CLIENT_ID,
    schemaVersion: SCHEMA,
    schema: testSchema,
    store,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    ...overrides,
  })
  return { client, sockets, latest: () => sockets[sockets.length - 1]! }
}

function cursor(version: number, backendId = 'b1'): Cursor {
  return { backendId, version }
}

/** Seeds a store as if a previous session had synced this state. */
async function seedStore(
  store: MemorySyncStore,
  opts: { rows?: { tbl: string; id: string; value: Record<string, unknown> }[]; version?: number; lmid?: number },
): Promise<void> {
  await store.applyPoke({
    ops: (opts.rows ?? []).map((r) => ({ op: 'put' as const, tbl: r.tbl, id: r.id, value: r.value })),
    clear: true,
    cursor: cursor(opts.version ?? 1),
    schemaVersion: SCHEMA,
    confirmedLmid: opts.lmid ?? 0,
    outbox: [],
  })
}

function poke(
  socket: FakeSocket,
  opts: {
    pokeId?: string
    base: Cursor | null
    patch?: import('@cf-sync/protocol').PatchOp[]
    cursor: Cursor
    lmid?: number
  },
): void {
  const pokeId = opts.pokeId ?? 'poke-1'
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: opts.base })
  socket.receive({
    type: 'pokePart',
    pokeId,
    patch: opts.patch ?? [],
    lastMutationIdChanges: opts.lmid === undefined ? {} : { [CLIENT_ID]: opts.lmid },
  })
  socket.receive({ type: 'pokeEnd', pokeId, cursor: opts.cursor, pageInfo: { more: false } })
}

describe('SyncClient persistence', () => {
  let recorder: RecordingHooks

  beforeEach(() => {
    recorder = new RecordingHooks()
  })

  it('hydrates cached rows and marks ready before the socket connects', async () => {
    const store = new MemorySyncStore()
    await seedStore(store, { rows: [{ tbl: 'todos', id: 't1', value: { title: 'cached' } }], version: 5 })

    const { client, sockets } = makeClient(store)
    client.registerTable('todos', recorder.hooks)
    client.start()
    expect(sockets.length).toBe(0) // hydration precedes any connection
    await flushMicrotasks()

    expect(recorder.rows.get('t1')).toEqual({ title: 'cached' })
    expect(recorder.ready).toBe(true)

    // The connection resumes from the persisted cursor, not from scratch.
    const socket = sockets[0]!
    socket.open()
    const [hello] = socket.takeSent()
    expect(hello).toMatchObject({ type: 'hello', cursor: cursor(5) })
  })

  it('persists applied pokes: rows, cursor, and confirmedLmid together', async () => {
    const store = new MemorySyncStore()
    const { client, latest } = makeClient(store)
    client.registerTable('todos', recorder.hooks)
    client.start()
    await flushMicrotasks()
    const socket = latest()
    socket.open()

    poke(socket, {
      base: null,
      patch: [{ op: 'clear' }, { op: 'put', tbl: 'todos', id: 't1', value: { title: 'a' } }],
      cursor: cursor(3),
      lmid: 2,
    })
    await flushMicrotasks()

    const state = await store.load()
    expect(state?.cursor).toEqual(cursor(3))
    expect(state?.confirmedLmid).toBe(2)
    expect(state?.rows).toEqual([{ tbl: 'todos', id: 't1', value: { title: 'a' } }])

    // A follow-up delta poke updates the mirror incrementally.
    poke(socket, {
      pokeId: 'poke-2',
      base: cursor(3),
      patch: [
        { op: 'put', tbl: 'todos', id: 't2', value: { title: 'b' } },
        { op: 'del', tbl: 'todos', id: 't1' },
      ],
      cursor: cursor(4),
    })
    await flushMicrotasks()
    const after = await store.load()
    expect(after?.cursor).toEqual(cursor(4))
    expect(after?.rows).toEqual([{ tbl: 'todos', id: 't2', value: { title: 'b' } }])
  })

  it('replays a persisted outbox after a reload, exactly once', async () => {
    const store = new MemorySyncStore()

    // Session 1: mutation queued while the socket never connects.
    const first = makeClient(store)
    first.client.registerTable('todos', recorder.hooks)
    first.client.start()
    await flushMicrotasks()
    first.client.mutate('sync.put', { tbl: 'todos', id: 't1', data: { title: 'offline' } }).catch(() => {})
    await flushMicrotasks()
    first.client.stop()
    await flushMicrotasks()

    const persisted = await store.load()
    expect(persisted?.outbox).toEqual([{ id: null, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'offline' } } }])

    // Session 2 ("after reload"): the entry re-queues and pushes once synced.
    const recorder2 = new RecordingHooks()
    const second = makeClient(store)
    second.client.registerTable('todos', recorder2.hooks)
    second.client.start()
    await flushMicrotasks()
    const socket = second.latest()
    socket.open()
    poke(socket, { base: null, patch: [{ op: 'clear' }], cursor: cursor(1), lmid: 0 })
    await flushMicrotasks()

    const push = socket.takeSent().find((m) => m.type === 'push')
    expect(push).toMatchObject({
      mutations: [{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'offline' } } }],
    })

    // Server confirms: the durable outbox drains.
    poke(socket, {
      pokeId: 'poke-confirm',
      base: cursor(1),
      patch: [{ op: 'put', tbl: 'todos', id: 't1', value: { title: 'offline' } }],
      cursor: cursor(2),
      lmid: 1,
    })
    await flushMicrotasks()
    const drained = await store.load()
    expect(drained?.outbox).toEqual([])
    expect(drained?.confirmedLmid).toBe(1)
  })

  it('keeps a timed-out mutation queued when a store is present', async () => {
    const store = new MemorySyncStore()
    const { client, latest } = makeClient(store, { confirmTimeoutMs: 5 })
    client.registerTable('todos', recorder.hooks)
    client.start()
    await flushMicrotasks()
    const socket = latest()
    socket.open()
    poke(socket, { base: null, patch: [{ op: 'clear' }], cursor: cursor(1), lmid: 0 })

    let rejected: Error | null = null
    client.mutate('sync.put', { tbl: 'todos', id: 't1', data: {} }).catch((err: Error) => {
      rejected = err
    })
    await new Promise((r) => setTimeout(r, 20))

    // The caller was told (optimistic overlay rolls back)…
    expect(rejected).toMatchObject({ code: 'Timeout' })
    // …but the durable intent survives and would replay next session.
    const state = await store.load()
    expect(state?.outbox).toHaveLength(1)

    // Late confirmation still drains it.
    poke(socket, {
      pokeId: 'poke-late',
      base: cursor(1),
      patch: [{ op: 'put', tbl: 'todos', id: 't1', value: {} }],
      cursor: cursor(2),
      lmid: 1,
    })
    await flushMicrotasks()
    expect((await store.load())?.outbox).toEqual([])
  })

  it('discards the cache on schema version mismatch', async () => {
    const store = new MemorySyncStore()
    await store.applyPoke({
      ops: [{ op: 'put', tbl: 'todos', id: 't1', value: { title: 'old' } }],
      clear: true,
      cursor: cursor(9),
      schemaVersion: 'ancient-0',
      confirmedLmid: 4,
      outbox: [{ id: 5, name: 'sync.put', args: {} }],
    })

    const { client, sockets } = makeClient(store)
    client.registerTable('todos', recorder.hooks)
    client.start()
    await flushMicrotasks()

    expect(recorder.rows.size).toBe(0) // nothing hydrated
    expect(await store.load()).toBeNull() // cache dropped
    const socket = sockets[0]!
    socket.open()
    const [hello] = socket.takeSent()
    expect(hello).toMatchObject({ cursor: null }) // fresh bootstrap
  })

  it('truncates the mirror on a clear poke and follows a backend reset', async () => {
    const store = new MemorySyncStore()
    await seedStore(store, { rows: [{ tbl: 'todos', id: 't1', value: { title: 'x' } }], version: 7 })

    const { client, latest } = makeClient(store)
    client.registerTable('todos', recorder.hooks)
    client.start()
    await flushMicrotasks()
    const socket = latest()
    socket.open()

    // Server was reset: new backendId, clear poke from any base.
    poke(socket, {
      base: null,
      patch: [{ op: 'clear' }, { op: 'put', tbl: 'todos', id: 'n1', value: { title: 'new world' } }],
      cursor: cursor(1, 'b2'),
      lmid: 0,
    })
    await flushMicrotasks()

    const state = await store.load()
    expect(state?.cursor).toEqual(cursor(1, 'b2'))
    expect(state?.rows).toEqual([{ tbl: 'todos', id: 'n1', value: { title: 'new world' } }])
  })

  it('stop() rejects callers but leaves the durable outbox intact', async () => {
    const store = new MemorySyncStore()
    const { client } = makeClient(store)
    client.registerTable('todos', recorder.hooks)
    client.start()
    await flushMicrotasks()
    client.mutate('sync.put', { tbl: 'todos', id: 't1', data: {} }).catch(() => {})
    await flushMicrotasks()

    client.stop()
    await flushMicrotasks()
    expect((await store.load())?.outbox).toHaveLength(1)
  })
})
