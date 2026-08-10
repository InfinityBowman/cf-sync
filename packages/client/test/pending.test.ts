import type { Cursor } from '@cf-sync/protocol'
import { describe, expect, it } from 'vitest'
import { SyncClient } from '../src/client'
import { MemorySyncStore } from '../src/store'
import { testApp } from './test-schema'
import { FakeSocket, flushMicrotasks } from './fake-socket'

const CLIENT_ID = 'client-a'

function makeClient(store?: MemorySyncStore) {
  const sockets: FakeSocket[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: CLIENT_ID,
    autoStart: false,
    app: testApp,
    store,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  })
  return { client, sockets, latest: () => sockets[sockets.length - 1]! }
}

function cursor(version: number): Cursor {
  return { backendId: 'b1', version }
}

function poke(
  socket: FakeSocket,
  opts: { pokeId?: string; base: Cursor | null; cursor: Cursor; lmid?: number },
): void {
  const pokeId = opts.pokeId ?? 'poke-1'
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: opts.base })
  socket.receive({
    type: 'pokePart',
    pokeId,
    patch: [],
    lastMutationIdChanges: opts.lmid === undefined ? {} : { [CLIENT_ID]: opts.lmid },
  })
  socket.receive({ type: 'pokeEnd', pokeId, cursor: opts.cursor, pageInfo: { more: false } })
}

describe('SyncClient pending', () => {
  it('counts an unconfirmed mutation and drains on the confirm poke', async () => {
    const { client, latest } = makeClient()
    client.start()
    await flushMicrotasks()
    const socket = latest()
    socket.open()
    poke(socket, { base: null, cursor: cursor(1), lmid: 0 })

    expect(client.pending).toBe(0)
    client.mutate('sync.put', { tbl: 'todos', id: 't1', data: {} }).catch(() => {})
    expect(client.pending).toBe(1)

    poke(socket, { pokeId: 'poke-confirm', base: cursor(1), cursor: cursor(2), lmid: 1 })
    await flushMicrotasks()
    expect(client.pending).toBe(0)
  })

  it('notifies subscribers on both transitions and not after unsubscribe', async () => {
    const { client, latest } = makeClient()
    client.start()
    await flushMicrotasks()
    const socket = latest()
    socket.open()
    poke(socket, { base: null, cursor: cursor(1), lmid: 0 })

    const seen: number[] = []
    const unsubscribe = client.subscribePending((pending) => seen.push(pending))

    client.mutate('sync.put', { tbl: 'todos', id: 't1', data: {} }).catch(() => {})
    expect(seen).toEqual([1])

    poke(socket, { pokeId: 'poke-confirm', base: cursor(1), cursor: cursor(2), lmid: 1 })
    await flushMicrotasks()
    expect(seen).toEqual([1, 0])

    unsubscribe()
    client.mutate('sync.put', { tbl: 'todos', id: 't2', data: {} }).catch(() => {})
    expect(seen).toEqual([1, 0])
  })

  it('counts entries restored from the store after a reload', async () => {
    const store = new MemorySyncStore()

    // Session 1: mutation queued while the socket never connects.
    const first = makeClient(store)
    first.client.start()
    await flushMicrotasks()
    first.client.mutate('sync.put', { tbl: 'todos', id: 't1', data: { title: 'offline' } }).catch(() => {})
    await flushMicrotasks()
    void first.client.destroy()
    await flushMicrotasks()

    // Session 2 ("after reload"): the restored entry has no promise attached
    // but must still count — outbox length is the reload-safe measure.
    const second = makeClient(store)
    const seen: number[] = []
    second.client.subscribePending((pending) => seen.push(pending))
    second.client.start()
    await flushMicrotasks()

    expect(second.client.pending).toBe(1)
    expect(seen).toEqual([1])
  })

  it('destroy() drops pending to 0 and notifies', async () => {
    const store = new MemorySyncStore()
    const { client } = makeClient(store)
    client.start()
    await flushMicrotasks()
    client.mutate('sync.put', { tbl: 'todos', id: 't1', data: {} }).catch(() => {})
    expect(client.pending).toBe(1)

    const seen: number[] = []
    client.subscribePending((pending) => seen.push(pending))
    void client.destroy()
    await flushMicrotasks()

    expect(client.pending).toBe(0)
    expect(seen).toEqual([0])
  })
})
