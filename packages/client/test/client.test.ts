import type { Cursor, PatchOp } from '@cf-sync/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { MutationError, SyncClient, SyncFatalError, type TableWriteOp } from '../src/client'
import { testApp } from './test-schema'
import { FakeSocket, flushMicrotasks } from './fake-socket'

const SCHEMA = 1
const CLIENT_ID = 'client-a'

class RecordingHooks {
  rows = new Map<string, Record<string, unknown>>()
  ready = false
  truncates = 0
  commits = 0
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
      this.commits++
    },
    truncate: () => {
      this.#pendingTruncate = true
    },
    markReady: () => {
      this.ready = true
    },
  }
}

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

function cursor(version: number): Cursor {
  return { backendId: 'b1', version }
}

function bootstrap(socket: FakeSocket, opts: { patch?: PatchOp[]; version?: number; lmid?: number } = {}): void {
  const pokeId = 'poke-bootstrap'
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: null })
  socket.receive({
    type: 'pokePart',
    pokeId,
    patch: [{ op: 'clear' }, ...(opts.patch ?? [])],
    lastMutationIdChanges: { [CLIENT_ID]: opts.lmid ?? 0 },
  })
  socket.receive({ type: 'pokeEnd', pokeId, cursor: cursor(opts.version ?? 0), pageInfo: { more: false } })
}

describe('SyncClient', () => {
  let recorder: RecordingHooks

  beforeEach(() => {
    recorder = new RecordingHooks()
  })

  it('sends hello on open and applies the bootstrap poke', () => {
    const { client, latest } = makeClient()
    client.registerTable('todos', recorder.hooks)
    client.start()
    const socket = latest()
    socket.open()

    const [hello] = socket.takeSent()
    expect(hello).toMatchObject({ type: 'hello', schemaVersion: SCHEMA, cursor: null })

    bootstrap(socket, {
      patch: [{ op: 'put', tbl: 'todos', id: 't1', value: { title: 'hi' } }],
      version: 3,
    })

    expect(recorder.rows.get('t1')).toEqual({ title: 'hi' })
    expect(recorder.ready).toBe(true)
    expect(client.status).toBe('synced')
    expect(client.cursor).toEqual(cursor(3))
  })

  it('confirms a mutation when the server LMID reaches its id', async () => {
    const { client, latest } = makeClient()
    client.registerTable('todos', recorder.hooks)
    client.start()
    const socket = latest()
    socket.open()
    bootstrap(socket)
    socket.takeSent()

    let resolved = false
    const confirmed = client
      .mutate('sync.put', { tbl: 'todos', id: 't1', data: { title: 'x' } })
      .then(() => {
        resolved = true
      })
    await flushMicrotasks()

    const [push] = socket.takeSent()
    expect(push).toMatchObject({ type: 'push', mutations: [{ id: 1, name: 'sync.put' }] })
    expect(resolved).toBe(false)

    const pokeId = 'poke-confirm'
    socket.receive({ type: 'pokeStart', pokeId, baseCursor: cursor(0) })
    socket.receive({
      type: 'pokePart',
      pokeId,
      patch: [{ op: 'put', tbl: 'todos', id: 't1', value: { title: 'x' } }],
      lastMutationIdChanges: { [CLIENT_ID]: 1 },
      mutationResults: [{ id: 1 }],
    })
    socket.receive({ type: 'pokeEnd', pokeId, cursor: cursor(1), pageInfo: { more: false } })

    await confirmed
    expect(resolved).toBe(true)
    expect(recorder.rows.get('t1')).toEqual({ title: 'x' })
  })

  it('rejects a mutation the server reports as a permanent app error', async () => {
    const { client, latest } = makeClient()
    client.registerTable('todos', recorder.hooks)
    client.start()
    const socket = latest()
    socket.open()
    bootstrap(socket)

    // Locally valid — the *server* rejects it as a permanent app error.
    const confirmed = client.mutate('sync.put', { tbl: 'todos', id: 't1', data: {} })
    await flushMicrotasks()

    const pokeId = 'poke-err'
    socket.receive({ type: 'pokeStart', pokeId, baseCursor: cursor(0) })
    socket.receive({
      type: 'pokePart',
      pokeId,
      patch: [],
      lastMutationIdChanges: { [CLIENT_ID]: 1 },
      mutationResults: [{ id: 1, error: { code: 'Nope', message: 'server said no' } }],
    })
    socket.receive({ type: 'pokeEnd', pokeId, cursor: cursor(0), pageInfo: { more: false } })

    await expect(confirmed).rejects.toThrow(MutationError)
  })

  it('re-hellos when a broadcast poke is based on a cursor it does not hold', () => {
    const { client, latest } = makeClient()
    client.registerTable('todos', recorder.hooks)
    client.start()
    const socket = latest()
    socket.open()
    bootstrap(socket, { version: 3 })
    socket.takeSent()

    // Broadcast based on version 5 while we hold 3: a poke was missed.
    const pokeId = 'poke-gap'
    socket.receive({ type: 'pokeStart', pokeId, baseCursor: cursor(5) })
    socket.receive({ type: 'pokePart', pokeId, patch: [{ op: 'del', tbl: 'todos', id: 't9' }] })
    socket.receive({ type: 'pokeEnd', pokeId, cursor: cursor(6), pageInfo: { more: false } })

    const [hello] = socket.takeSent()
    expect(hello).toMatchObject({ type: 'hello', cursor: cursor(3) })
    // The stale poke must not have been applied.
    expect(client.cursor).toEqual(cursor(3))
  })

  it('reconnects with its cursor and re-pushes the unconfirmed outbox', async () => {
    const { client, latest, sockets } = makeClient({ maxBackoffMs: 1 })
    client.registerTable('todos', recorder.hooks)
    client.start()
    const first = latest()
    first.open()
    bootstrap(first, { version: 2 })
    first.takeSent()

    void client.mutate('sync.put', { tbl: 'todos', id: 't1', data: { title: 'x' } }).catch(() => {})
    await flushMicrotasks()
    expect(first.takeSent()).toHaveLength(1) // pushed but never confirmed

    first.dropConnection()
    await new Promise((r) => setTimeout(r, 20))
    expect(sockets.length).toBe(2)
    const second = latest()
    second.open()

    const [hello] = second.takeSent()
    expect(hello).toMatchObject({ type: 'hello', cursor: cursor(2) })

    // Catch-up confirms nothing yet (lmid still 0), so the outbox re-pushes.
    const pokeId = 'poke-catchup'
    second.receive({ type: 'pokeStart', pokeId, baseCursor: cursor(2) })
    second.receive({ type: 'pokePart', pokeId, patch: [], lastMutationIdChanges: { [CLIENT_ID]: 0 } })
    second.receive({ type: 'pokeEnd', pokeId, cursor: cursor(2), pageInfo: { more: false } })
    await flushMicrotasks()

    const [push] = second.takeSent()
    expect(push).toMatchObject({ type: 'push', mutations: [{ id: 1, name: 'sync.put' }] })
  })

  it('applies a clear poke from any base and renumbers the outbox on a new history', async () => {
    const { client, latest } = makeClient()
    client.registerTable('todos', recorder.hooks)
    client.start()
    const socket = latest()
    socket.open()
    bootstrap(socket, {
      patch: [{ op: 'put', tbl: 'todos', id: 't1', value: { title: 'old' } }],
      version: 3,
    })
    socket.takeSent()

    // A mutation is pushed but never confirmed before the server resets.
    void client.mutate('sync.put', { tbl: 'todos', id: 't2', data: {} }).catch(() => {})
    await flushMicrotasks()
    socket.takeSent()

    // Admin reset: clear poke, base null (mismatch), NEW backendId.
    const pokeId = 'poke-reset'
    socket.receive({ type: 'pokeStart', pokeId, baseCursor: null })
    socket.receive({ type: 'pokePart', pokeId, patch: [{ op: 'clear' }] })
    socket.receive({
      type: 'pokeEnd',
      pokeId,
      cursor: { backendId: 'b2', version: 0 },
      pageInfo: { more: false },
    })

    expect(recorder.rows.size).toBe(0)
    expect(client.cursor).toEqual({ backendId: 'b2', version: 0 })

    // The unconfirmed mutation renumbers from the new history's baseline
    // and re-pushes with id 1.
    await flushMicrotasks()
    const [push] = socket.takeSent()
    expect(push).toMatchObject({ type: 'push', mutations: [{ id: 1, name: 'sync.put' }] })
  })

  it('goes fatal on VersionNotSupported and settles everything', async () => {
    let fatal: Error | null = null
    const { client, latest } = makeClient({ onFatal: (e) => (fatal = e) })
    client.registerTable('todos', recorder.hooks)
    client.start()
    const socket = latest()
    socket.open()

    const confirmed = client.mutate('sync.put', { tbl: 'todos', id: 't1', data: {} })
    socket.receive({ type: 'error', code: 'VersionNotSupported' })

    await expect(confirmed).rejects.toThrow(SyncFatalError)
    expect(client.status).toBe('fatal')
    expect(fatal).not.toBeNull()
    expect(recorder.ready).toBe(true) // markReady even on fatal so preload settles
  })

  it('a fatal with no onFatal handler is survivable outside the browser', () => {
    // Default fatal recovery reloads the page; with no `location` (SSR,
    // tests) it must degrade to a warning, never a throw.
    const { client, latest } = makeClient()
    client.registerTable('todos', recorder.hooks)
    client.start()
    const socket = latest()
    socket.open()
    socket.receive({ type: 'error', code: 'Unauthorized' })
    expect(client.status).toBe('fatal')
  })

  it('subscribeStatus notifies on transitions and stops after unsubscribe', () => {
    const { client, latest } = makeClient()
    const seen: string[] = []
    // Passed unbound on purpose — the arrow property keeps `this`.
    const subscribe = client.subscribeStatus
    const unsubscribe = subscribe((status) => seen.push(status))

    client.registerTable('todos', recorder.hooks)
    client.start()
    const socket = latest()
    socket.open()
    bootstrap(socket)
    expect(seen).toEqual(['connecting', 'syncing', 'synced'])

    unsubscribe()
    socket.dropConnection()
    expect(client.status).toBe('reconnecting')
    expect(seen).toEqual(['connecting', 'syncing', 'synced']) // no longer notified
  })
})
