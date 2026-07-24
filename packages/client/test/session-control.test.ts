import { createCollection } from '@tanstack/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SyncClient, SyncFatalError } from '../src/client'
import { workspaceCollectionOptions } from '../src/collection'
import {
  AppError,
  CLOSE_REFRESH,
  CLOSE_UNAUTHORIZED,
  crudMutators,
  defineApp,
  defineMutators,
  defineSchema,
} from '../src/index'
import { testApp } from './test-schema'
import { FakeSocket, flushMicrotasks } from './fake-socket'

// Session control (DESIGN.md §15): permanent close codes go fatal with the
// close {code, reason} attached; 4300 refreshes reconnect immediately exactly
// once per streak; the `auth` option feeds optimistic runs as ctx.auth.

const CLIENT_ID = 'client-a'

function makeClient(overrides: Partial<ConstructorParameters<typeof SyncClient>[0]> = {}) {
  const sockets: FakeSocket[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: CLIENT_ID,
    autoStart: false,
    app: testApp,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    ...overrides,
  })
  return { client, sockets, latest: () => sockets[sockets.length - 1]! }
}

function bootstrap(socket: FakeSocket): void {
  const pokeId = 'poke-bootstrap'
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: null })
  socket.receive({ type: 'pokePart', pokeId, patch: [{ op: 'clear' }], lastMutationIdChanges: { [CLIENT_ID]: 0 } })
  socket.receive({ type: 'pokeEnd', pokeId, cursor: { backendId: 'b1', version: 0 }, pageInfo: { more: false } })
}

describe('permanent close codes', () => {
  it('goes fatal with the close {code, reason} attached', async () => {
    let fatal: SyncFatalError | null = null
    const { client, latest } = makeClient({ onFatal: (e) => (fatal = e) })
    client.start()
    const socket = latest()
    socket.open()
    bootstrap(socket)

    const confirmed = client.mutate('sync.put', { tbl: 'todos', id: 't1', data: {} })
    socket.serverClose(CLOSE_UNAUTHORIZED, 'membership-revoked')

    expect(client.status).toBe('fatal')
    expect(fatal).toBeInstanceOf(SyncFatalError)
    expect(fatal!.code).toBe(4403)
    expect(fatal!.reason).toBe('membership-revoked')
    // Queued mutations settle instead of hanging.
    await expect(confirmed).rejects.toThrow(SyncFatalError)
  })

  it('does not reconnect after a permanent close', () => {
    vi.useFakeTimers()
    try {
      const { client, sockets, latest } = makeClient({ onFatal: () => {} })
      client.start()
      latest().open()
      latest().serverClose(4409, 'superseded')
      expect(client.status).toBe('fatal')
      vi.advanceTimersByTime(120_000)
      expect(sockets.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('refresh (4300)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reconnects immediately on the first refresh', () => {
    const { client, sockets, latest } = makeClient()
    client.start()
    latest().open()
    bootstrap(latest())

    latest().serverClose(CLOSE_REFRESH, 'refresh')
    // No timer involved: the reconnect is synchronous with the close event.
    expect(sockets.length).toBe(2)
    expect(client.status).toBe('reconnecting') // until the fresh socket opens
    latest().open()
    expect(client.status).toBe('syncing')
  })

  it('a ready connection resets the streak, so a later refresh is again immediate', () => {
    const { client, sockets, latest } = makeClient()
    client.start()
    latest().open()
    bootstrap(latest())

    latest().serverClose(CLOSE_REFRESH, 'refresh')
    expect(sockets.length).toBe(2)
    latest().open()
    bootstrap(latest()) // reaches ready — breaks the streak
    expect(client.status).toBe('synced')

    latest().serverClose(CLOSE_REFRESH, 'refresh')
    expect(sockets.length).toBe(3)
  })

  it('consecutive refreshes with no ready connection fall back to backoff', () => {
    vi.useFakeTimers()
    const { client, sockets, latest } = makeClient()
    client.start()
    latest().open()
    bootstrap(latest())

    latest().serverClose(CLOSE_REFRESH, 'refresh')
    expect(sockets.length).toBe(2) // first refresh: immediate

    latest().open()
    latest().serverClose(CLOSE_REFRESH, 'refresh') // no ready in between
    expect(sockets.length).toBe(2) // paced, not immediate
    expect(client.status).toBe('reconnecting')

    vi.advanceTimersByTime(30_000)
    expect(sockets.length).toBe(3) // the backoff timer reconnected
  })
})

describe('the auth option', () => {
  const schema = defineSchema({
    todos: z.object({ id: z.string(), title: z.string() }),
  })
  const mutators = defineMutators(
    schema,
    {
      ...crudMutators(schema),
      // Fail-fast shape: no `authoritative` guard, so the optimistic run
      // enforces locally too.
      'todos.removeStrict': {
        args: z.object({ id: z.string() }),
        apply(tx, { id }, ctx) {
          if (!ctx.auth?.writeAllowed) throw new AppError('ReadOnly', 'no write access')
          tx.del('todos', id)
        },
      },
      // Server-enforced shape: optimistic run proceeds, the server rejects.
      'todos.removeGuarded': {
        args: z.object({ id: z.string() }),
        apply(tx, { id }, ctx) {
          if (ctx.authoritative && !ctx.auth?.writeAllowed) throw new AppError('ReadOnly', 'no write access')
          tx.del('todos', id)
        },
      },
    },
    { authContext: z.object({ writeAllowed: z.boolean() }) },
  )
  const app = defineApp({ version: 1, schema, mutators })

  function setup(auth?: { writeAllowed: boolean }) {
    const sockets: FakeSocket[] = []
    const client = new SyncClient({
      url: 'ws://test',
      workspaceId: 'w1',
      clientId: CLIENT_ID,
      autoStart: false,
      app,
      auth,
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    const todos = createCollection(workspaceCollectionOptions({ client, table: 'todos', startSync: true }))
    client.start()
    const socket = sockets[sockets.length - 1]!
    socket.open()
    socket.receive({ type: 'pokeStart', pokeId: 'p1', baseCursor: null })
    socket.receive({
      type: 'pokePart',
      pokeId: 'p1',
      patch: [{ op: 'clear' }, { op: 'put', tbl: 'todos', id: 't1', value: { id: 't1', title: 'x' } }],
      lastMutationIdChanges: { [CLIENT_ID]: 0 },
    })
    socket.receive({ type: 'pokeEnd', pokeId: 'p1', cursor: { backendId: 'b1', version: 1 }, pageInfo: { more: false } })
    return { client, todos, socket }
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('optimistic runs see ctx.auth, so unguarded checks fail fast locally', async () => {
    const { client, todos } = setup({ writeAllowed: false })
    await expect(client.mutate('todos.removeStrict', { id: 't1' })).rejects.toMatchObject({ code: 'ReadOnly' })
    expect(todos.has('t1')).toBe(true) // nothing queued, nothing applied
  })

  it('the authoritative guard lets the optimistic run proceed', async () => {
    const { client, todos, socket } = setup({ writeAllowed: false })
    const pending = client.mutate('todos.removeGuarded', { id: 't1' })
    void pending.catch(() => {}) // settled later by the server's verdict; not under test here
    await flushMicrotasks()
    expect(todos.has('t1')).toBe(false) // optimistic overlay applied
    expect(socket.sent.some((m) => m.type === 'push')).toBe(true) // reached the wire
  })

  it('validates auth against the authContext schema at construction', () => {
    expect(() => setup({ writeAllowed: 'yes' as unknown as boolean })).toThrow(/authContext/)
  })
})
