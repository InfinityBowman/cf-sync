import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SyncClient } from '../src/client'
import { crudMutators, defineApp } from '../src/index'
import { FakeSocket, flushMicrotasks } from './fake-socket'
import { presenceApp, testApp, testSchema } from './test-schema'

// Client half of DESIGN.md §16: the library owns pacing and re-announcement —
// `set` throttles trailing-edge, the last state re-announces on every
// connection that reaches ready (presencePeers receipt) and on presencePoll,
// peers exclude self and reset to empty on disconnect.

const CLIENT_ID = 'client-a'

function makeClient(
  app: typeof presenceApp | typeof testApp = presenceApp,
  extra: Record<string, unknown> = {},
) {
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
    ...extra,
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

describe('definition traps surfaced early', () => {
  it('a presence schema that cannot parse its own output throws at the first set, naming the transform rule', () => {
    // Typechecks fine; would otherwise break merge/re-announce at runtime.
    const transformApp = defineApp({
      version: 1,
      schema: testSchema,
      mutators: crudMutators(testSchema),
      presence: z.object({ name: z.string() }).transform((s) => s.name),
    })
    const { client } = makeClient(transformApp as never)
    expect(() => (client.presence as { set(s: unknown): void }).set({ name: 'ada' })).toThrow(
      /parse its own output.*no transform/s,
    )
    client.stop()
  })

  it('update() before any presence exists names the mount-order cause and the initialPresence fix', () => {
    const { client } = makeClient() // presenceApp requires `name`
    expect(() => client.presence.update({ cursor: { x: 1, y: 2 } })).toThrow(/mount-order.*initialPresence/s)
    client.stop()
  })
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

  it('throttles trailing-edge: rapid sets produce one immediate and one trailing frame with the latest state', () => {
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

  it('update shallow-merges into the current state and validates the merged result', () => {
    vi.useFakeTimers()
    const { client, latest } = makeClient()
    const socket = goLive(client, latest)

    // Before anything is set, update merges into {} — required fields must
    // arrive by validation time.
    expect(() => client.presence.update({ cursor: { x: 1, y: 2 } })).toThrow(/presence schema/)

    client.presence.set({ name: 'ada' })
    client.presence.update({ cursor: { x: 1, y: 2 } }) // no need to re-state name
    vi.advanceTimersByTime(100)
    client.presence.update({ cursor: undefined }) // clears one field, keeps the rest
    vi.advanceTimersByTime(100)
    expect(sentPresence(socket)).toEqual([
      { name: 'ada' },
      { name: 'ada', cursor: { x: 1, y: 2 } },
      { name: 'ada' },
    ])
    client.stop()
  })

  it('self exposes the parsed last-set state, and null when unset or cleared', () => {
    vi.useFakeTimers()
    const { client, latest } = makeClient()
    goLive(client, latest)
    expect(client.presence.self).toBeNull()
    client.presence.set({ name: 'ada' })
    expect(client.presence.self).toEqual({ name: 'ada' })
    client.presence.update({ cursor: { x: 3, y: 4 } })
    expect(client.presence.self).toEqual({ name: 'ada', cursor: { x: 3, y: 4 } })
    client.presence.clear()
    expect(client.presence.self).toBeNull()
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

describe('initialPresence', () => {
  it('is announced when presence goes live, with no set call', () => {
    const { client, latest } = makeClient(presenceApp, { initialPresence: { name: 'ada' } })
    expect(client.presence.self).toEqual({ name: 'ada' })
    const socket = goLive(client, latest)
    expect(sentPresence(socket)).toEqual([{ name: 'ada' }])
    client.stop()
  })

  it('makes update-before-set a non-event instead of a mount-order race', () => {
    const { client, latest } = makeClient(presenceApp, { initialPresence: { name: 'ada' } })
    // A mousemove handler firing before any component called set: merges
    // into the construction-time identity, not into {}.
    client.presence.update({ cursor: { x: 1, y: 2 } })
    const socket = goLive(client, latest)
    expect(sentPresence(socket)).toEqual([{ name: 'ada', cursor: { x: 1, y: 2 } }])
    client.stop()
  })

  it('is validated at construction, like auth', () => {
    expect(() => makeClient(presenceApp, { initialPresence: { name: 42 } })).toThrow(/presence schema/)
    expect(() => makeClient(testApp, { initialPresence: { name: 'ada' } })).toThrow(/no presence schema/)
  })
})

describe('presence.peers', () => {
  it('adopts the snapshot (self excluded), applies updates and nulls, and keeps a stable identity between changes', () => {
    const { client, latest } = makeClient()
    const socket = goLive(client, latest, [
      { clientId: CLIENT_ID, state: { name: 'me' } },
      { clientId: 'peer-1', principal: 'user-1', state: { name: 'p1' } },
    ])
    expect(client.presence.peers).toEqual([
      // receivedAt is the local receipt time — the §16.3 staleness bound.
      { clientId: 'peer-1', principal: 'user-1', state: { name: 'p1' }, receivedAt: expect.any(Number) },
    ])

    const before = client.presence.peers
    expect(client.presence.peers).toBe(before) // stable until something changes

    const seen: number[] = []
    const unsubscribe = client.presence.subscribe(() => seen.push(client.presence.peers.length))
    socket.receive({ type: 'presence', clientId: 'peer-2', state: { name: 'p2' } })
    expect(client.presence.peers).not.toBe(before)
    expect(client.presence.peers.map((p) => p.clientId).sort()).toEqual(['peer-1', 'peer-2'])

    socket.receive({ type: 'presence', clientId: 'peer-1', principal: 'user-1', state: null })
    expect(client.presence.peers).toEqual([
      { clientId: 'peer-2', state: { name: 'p2' }, receivedAt: expect.any(Number) },
    ])
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
