import type { Cursor } from '@cf-sync/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationError, RAW_MUTATE, SyncClient } from '../src/client'
import { MemorySyncStore } from '../src/store'
import { FakeSocket, flushMicrotasks } from './fake-socket'
import { testApp } from './test-schema'

const CLIENT_ID = 'client-a'

type Rejection = { error: MutationError; name: string; args: unknown }

function makeClient(overrides: Partial<ConstructorParameters<typeof SyncClient>[0]> = {}) {
  const sockets: FakeSocket[] = []
  const rejections: Rejection[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: CLIENT_ID,
    autoStart: false,
    app: testApp,
    onMutationRejected: (error, { name, args }) => rejections.push({ error, name, args }),
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    ...overrides,
  })
  return { client, sockets, rejections, latest: () => sockets[sockets.length - 1]! }
}

function cursor(version: number): Cursor {
  return { backendId: 'b1', version }
}

function bootstrap(socket: FakeSocket): void {
  const pokeId = 'poke-bootstrap'
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: null })
  socket.receive({ type: 'pokePart', pokeId, patch: [{ op: 'clear' }], lastMutationIdChanges: { [CLIENT_ID]: 0 } })
  socket.receive({ type: 'pokeEnd', pokeId, cursor: cursor(0), pageInfo: { more: false } })
}

function rejectMutation(socket: FakeSocket, id: number, code: string, message: string): void {
  const pokeId = `poke-reject-${id}`
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: cursor(0) })
  socket.receive({
    type: 'pokePart',
    pokeId,
    patch: [],
    lastMutationIdChanges: { [CLIENT_ID]: id },
    mutationResults: [{ id, error: { code, message } }],
  })
  socket.receive({ type: 'pokeEnd', pokeId, cursor: cursor(0), pageInfo: { more: false } })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('onMutationRejected', () => {
  it('fires on a server permanent rejection — and the awaiting caller still sees it', async () => {
    const { client, rejections, latest } = makeClient()
    client.start()
    const socket = latest()
    socket.open()
    bootstrap(socket)

    const args = { tbl: 'todos', id: 't1', data: { title: 'x' } }
    const pending = client.mutate('sync.put', args)
    await flushMicrotasks()
    rejectMutation(socket, 1, 'Nope', 'server said no')
    await flushMicrotasks()

    await expect(pending).rejects.toThrow(MutationError)
    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toMatchObject({ name: 'sync.put', args })
    expect(rejections[0]!.error.code).toBe('Nope')
    void client.destroy()
  })

  it('makes fire-and-forget safe: an uncaught mutate call reports here, not as an unhandled rejection', async () => {
    const { client, rejections, latest } = makeClient()
    client.start()
    const socket = latest()
    socket.open()
    bootstrap(socket)

    // Deliberately no .catch(): if the guard did not mark the rejection
    // handled, vitest would fail this test on the unhandled rejection.
    void client.mutate('sync.put', { tbl: 'todos', id: 't1', data: {} })
    await flushMicrotasks()
    rejectMutation(socket, 1, 'ReadOnly', 'nope')
    await flushMicrotasks()

    expect(rejections).toHaveLength(1)
    expect(rejections[0]!.error.code).toBe('ReadOnly')
    void client.destroy()
    await flushMicrotasks()
  })

  it('fires for local fail-fast rejections, including the raw collection path', async () => {
    const { client, rejections } = makeClient()

    // Missing args fail sync.put validation before anything is queued.
    void client.mutate('sync.put', { tbl: 'todos' } as never)
    // The adapter's raw path (what collection handlers call) guards the same way.
    void (client as SyncClient)[RAW_MUTATE]('sync.del', { tbl: 'todos' })
    await flushMicrotasks()

    expect(rejections.map((r) => ({ name: r.name, code: r.error.code }))).toEqual([
      { name: 'sync.put', code: 'InvalidArgs' },
      { name: 'sync.del', code: 'InvalidArgs' },
    ])
  })

  it('fires for a restored-outbox mutation rejected after a reload — the case with no caller at all', async () => {
    const store = new MemorySyncStore()

    // Session 1: queue offline and "reload" (abandon without stop()).
    const first = makeClient({ store, onMutationRejected: undefined })
    first.client.start()
    await flushMicrotasks()
    first.client.mutate('sync.put', { tbl: 'todos', id: 't1', data: { title: 'offline' } }).catch(() => {})
    await flushMicrotasks()
    expect((await store.load())?.outbox).toHaveLength(1)

    // Session 2: the replayed mutation has no awaiting caller; the hook is
    // the only surface that can report the server's refusal.
    const second = makeClient({ store })
    second.client.start()
    await flushMicrotasks()
    const socket = second.latest()
    socket.open()
    bootstrap(socket)
    await flushMicrotasks()
    rejectMutation(socket, 1, 'Conflict', 'row was archived')
    await flushMicrotasks()

    expect(second.rejections).toHaveLength(1)
    expect(second.rejections[0]).toMatchObject({
      name: 'sync.put',
      args: { tbl: 'todos', id: 't1', data: { title: 'offline' } },
    })
    expect(second.rejections[0]!.error.code).toBe('Conflict')
    void second.client.destroy()
  })

  it('a throwing hook is contained: the caller still gets the rejection', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, latest } = makeClient({
      onMutationRejected: () => {
        throw new Error('hook exploded')
      },
    })
    client.start()
    const socket = latest()
    socket.open()
    bootstrap(socket)

    const pending = client.mutate('sync.put', { tbl: 'todos', id: 't1', data: {} })
    await flushMicrotasks()
    rejectMutation(socket, 1, 'Nope', 'no')

    await expect(pending).rejects.toThrow(MutationError)
    expect(consoleError).toHaveBeenCalledWith('[cf-sync] onMutationRejected threw', expect.any(Error))
    void client.destroy()
  })
})

describe('client.onMutationRejected (subscription form)', () => {
  it('a listener attached after construction receives rejections, with unsubscribe', async () => {
    const { client, latest } = makeClient({ onMutationRejected: undefined })
    const seen: Rejection[] = []
    const unsubscribe = client.onMutationRejected((error, { name, args }) => seen.push({ error, name, args }))
    client.start()
    const socket = latest()
    socket.open()
    bootstrap(socket)

    const args = { tbl: 'todos', id: 't1', data: { title: 'x' } }
    void client.mutate('sync.put', args).catch(() => {})
    await flushMicrotasks()
    rejectMutation(socket, 1, 'Nope', 'server said no')
    await flushMicrotasks()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ name: 'sync.put', args })
    expect(seen[0]!.error.mutation).toEqual({ name: 'sync.put', args })

    unsubscribe()
    void client.mutate('sync.put', args).catch(() => {})
    await flushMicrotasks()
    rejectMutation(socket, 2, 'Nope', 'again')
    await flushMicrotasks()
    expect(seen).toHaveLength(1) // unsubscribed: no second delivery
    void client.destroy()
  })

  it('constructor option and subscription both fire when both are set', async () => {
    const { client, rejections, latest } = makeClient()
    const seen: Rejection[] = []
    client.onMutationRejected((error, { name, args }) => seen.push({ error, name, args }))
    client.start()
    const socket = latest()
    socket.open()
    bootstrap(socket)

    void client.mutate('sync.put', { tbl: 'todos', id: 't1', data: {} }).catch(() => {})
    await flushMicrotasks()
    rejectMutation(socket, 1, 'Nope', 'no')
    await flushMicrotasks()
    expect(rejections).toHaveLength(1)
    expect(seen).toHaveLength(1)
    void client.destroy()
  })
})

describe('MutationError.mutation', () => {
  it('an awaiting caller gets the mutation name and args on the error itself', async () => {
    const { client } = makeClient({ onMutationRejected: undefined })
    const err = await client.mutate('no.such.mutator' as never).catch((e: MutationError) => e)
    expect(err).toBeInstanceOf(MutationError)
    expect((err as MutationError).mutation?.name).toBe('no.such.mutator')
    void client.destroy()
  })
})
