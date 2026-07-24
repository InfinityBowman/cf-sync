import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncClient } from '../src/client'
import { FakeSocket, flushMicrotasks } from './fake-socket'
import { presenceApp, testApp } from './test-schema'

// Client half of DESIGN.md §16: the library owns pacing and re-announcement —
// `set` coalesces trailing-edge, the last state re-announces on every
// connection that reaches ready (presencePeers receipt) and on presencePoll,
// peers exclude self and reset to empty on disconnect.

const CLIENT_ID = 'client-a'

function makeClient(app: typeof presenceApp | typeof testApp = presenceApp) {
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
  })
  return { client, sockets, latest: () => sockets[sockets.length - 1]! }
}

function bootstrap(socket: FakeSocket): void {
  const pokeId = 'poke-bootstrap'
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: null })
  socket.receive({ type: 'pokePart', pokeId, patch: [{ op: 'clear' }], lastMutationIdChanges: { [CLIENT_ID]: 0 } })
  socket.receive({ type: 'pokeEnd', pokeId, cursor: { backendId: 'b1', version: 0 }, pageInfo: { more: false } })
}

/** Connects, syncs, and delivers the post-hello snapshot (presence goes live). */
function goLive(client: SyncClient<any, any, any>, latest: () => FakeSocket, peers: unknown[] = []): FakeSocket {
  client.start()
  const socket = latest()
  socket.open()
  bootstrap(socket)
  socket.receive({ type: 'presencePeers', peers: peers as never })
  return socket
}

function sentPresence(socket: FakeSocket): unknown[] {
  return socket.sent.filter((m) => m.type === 'presence').map((m) => (m as { state: unknown }).state)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('presence.set', () => {
  it('throws without a presence schema in the app', () => {
    const { client } = makeClient(testApp)
    expect(() => (client.presence as { set(s: unknown): void }).set({ name: 'a' })).toThrow(/no presence schema/)
    expect(() => client.presence.clear()).toThrow(/no presence schema/)
    client.stop()
  })

  it('fails fast on state that fails the schema, and on oversized state', () => {
    const { client } = makeClient()
    expect(() => (client.presence as { set(s: unknown): void }).set({ name: 42 })).toThrow(/presence schema/)
    expect(() => client.presence.set({ name: 'x'.repeat(9_000) })).toThrow(/exceeds/)
    client.stop()
  })

  it('state set before the connection is live is announced on presencePeers receipt', () => {
    const { client, latest } = makeClient()
    client.presence.set({ name: 'early' })
    const socket = goLive(client, latest)
    expect(sentPresence(socket)).toEqual([{ name: 'early' }])
    client.stop()
  })

  it('coalesces trailing-edge: rapid sets produce one immediate and one trailing frame with the latest state', () => {
    vi.useFakeTimers()
    const { client, latest } = makeClient()
    const socket = goLive(client, latest)

    client.presence.set({ name: 'a' })
    client.presence.set({ name: 'b' })
    client.presence.set({ name: 'c' })
    expect(sentPresence(socket)).toEqual([{ name: 'a' }])

    vi.advanceTimersByTime(100)
    expect(sentPresence(socket)).toEqual([{ name: 'a' }, { name: 'c' }])

    // The trailing send opened a fresh window; once it lapses the next set
    // is leading-edge again.
    vi.advanceTimersByTime(100)
    client.presence.set({ name: 'd' })
    expect(sentPresence(socket)).toEqual([{ name: 'a' }, { name: 'c' }, { name: 'd' }])
    client.stop()
  })

  it('clear sends null', () => {
    vi.useFakeTimers()
    const { client, latest } = makeClient()
    const socket = goLive(client, latest)
    client.presence.set({ name: 'a' })
    client.presence.clear()
    vi.advanceTimersByTime(100)
    expect(sentPresence(socket)).toEqual([{ name: 'a' }, null])
    client.stop()
  })

  it('re-sends the current state on presencePoll', () => {
    const { client, latest } = makeClient()
    const socket = goLive(client, latest)
    client.presence.set({ name: 'a' })
    socket.sent = []
    socket.receive({ type: 'presencePoll' })
    expect(sentPresence(socket)).toEqual([{ name: 'a' }])
    client.stop()
  })
})

describe('presence.peers', () => {
  it('adopts the snapshot (self excluded), applies updates and nulls, and keeps a stable identity between changes', () => {
    const { client, latest } = makeClient()
    const socket = goLive(client, latest, [
      { clientId: CLIENT_ID, state: { name: 'me' } },
      { clientId: 'peer-1', principal: 'user-1', state: { name: 'p1' } },
    ])
    expect(client.presence.peers).toEqual([{ clientId: 'peer-1', principal: 'user-1', state: { name: 'p1' } }])

    const before = client.presence.peers
    expect(client.presence.peers).toBe(before) // stable until something changes

    const seen: number[] = []
    const unsubscribe = client.presence.subscribe(() => seen.push(client.presence.peers.length))
    socket.receive({ type: 'presence', clientId: 'peer-2', state: { name: 'p2' } })
    expect(client.presence.peers).not.toBe(before)
    expect(client.presence.peers.map((p) => p.clientId).sort()).toEqual(['peer-1', 'peer-2'])

    socket.receive({ type: 'presence', clientId: 'peer-1', principal: 'user-1', state: null })
    expect(client.presence.peers).toEqual([{ clientId: 'peer-2', state: { name: 'p2' } }])
    expect(seen).toEqual([2, 1])

    // A null for an unknown peer changes nothing and does not notify.
    socket.receive({ type: 'presence', clientId: 'peer-9', state: null })
    expect(seen).toEqual([2, 1])
    unsubscribe()
    client.stop()
  })

  it('resets to empty on disconnect and re-announces own state on the next connection', async () => {
    const { client, latest } = makeClient()
    const socket = goLive(client, latest, [{ clientId: 'peer-1', state: { name: 'p1' } }])
    client.presence.set({ name: 'me' })
    expect(client.presence.peers.length).toBe(1)

    let notified = 0
    client.presence.subscribe(() => notified++)
    socket.dropConnection()
    expect(client.presence.peers).toEqual([])
    expect(notified).toBe(1)

    // Reconnect (first retry is timer-driven).
    await new Promise((resolve) => setTimeout(resolve, 600))
    const next = latest()
    expect(next).not.toBe(socket)
    next.open()
    bootstrap(next)
    next.receive({ type: 'presencePeers', peers: [] })
    expect(sentPresence(next)).toEqual([{ name: 'me' }])
    await flushMicrotasks()
    client.stop()
  })
})
