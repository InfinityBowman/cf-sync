import type { Cursor } from '@cf-sync/protocol'
import { describe, expect, it } from 'vitest'
import { SyncClient } from '../src/client'
import { testApp } from './test-schema'
import { FakeSocket } from './fake-socket'

const SCHEMA = 'test-1'
const CLIENT_ID = 'hb-client'

const noopHooks = {
  begin: () => {},
  write: () => {},
  commit: () => {},
  truncate: () => {},
  markReady: () => {},
}

function cursor(version: number): Cursor {
  return { backendId: 'b1', version }
}

function bootstrap(socket: FakeSocket, version = 1): void {
  const pokeId = 'boot'
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: null })
  socket.receive({ type: 'pokePart', pokeId, patch: [{ op: 'clear' }], lastMutationIdChanges: { [CLIENT_ID]: 0 } })
  socket.receive({ type: 'pokeEnd', pokeId, cursor: cursor(version), pageInfo: { more: false } })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeClient(overrides: Partial<ConstructorParameters<typeof SyncClient>[0]> = {}) {
  const sockets: FakeSocket[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: CLIENT_ID,
    app: testApp,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    ...overrides,
  })
  return { client, sockets }
}

describe('connection resilience', () => {
  it('a throwing createSocket schedules a retry instead of dying', async () => {
    let fail = true
    const sockets: FakeSocket[] = []
    const { client } = makeClient({
      createSocket: () => {
        if (fail) throw new Error('CSP says no')
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    client.registerTable('todos', noopHooks)
    expect(() => client.start()).not.toThrow()
    expect(client.status).toBe('reconnecting')

    // constructor recovers; the backoff retry (≤500ms) must still be alive
    fail = false
    await sleep(700)
    expect(sockets.length).toBe(1)
    sockets[0]!.open()
    bootstrap(sockets[0]!)
    expect(client.status).toBe('synced')
    client.stop()
  })

  it('a persistently-throwing createSocket keeps retrying with backoff', async () => {
    let attempts = 0
    const { client } = makeClient({
      createSocket: () => {
        attempts++
        throw new Error('still no')
      },
    })
    client.registerTable('todos', noopHooks)
    client.start()
    await sleep(900) // enough for the initial call + at least one retry
    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(client.status).toBe('reconnecting')
    client.stop()
  })

  it('sends keepalive pings on the configured cadence', async () => {
    const { client, sockets } = makeClient({ pingIntervalMs: 20 })
    client.registerTable('todos', noopHooks)
    client.start()
    const socket = sockets[0]!
    socket.open()
    bootstrap(socket)
    socket.takeSent()

    // keep the connection "alive" so only pings flow
    const keep = setInterval(() => socket.receive({ type: 'pong' } as never), 15)
    await sleep(120)
    clearInterval(keep)
    const pings = socket.takeSent().filter((m) => (m as { type: string }).type === 'ping')
    expect(pings.length).toBeGreaterThanOrEqual(2)
    expect(sockets.length).toBe(1) // liveness satisfied: no reconnect
    client.stop()
  })

  it('declares a silent socket dead and reconnects — without any close event', async () => {
    const { client, sockets } = makeClient({ pingIntervalMs: 20, idleTimeoutMs: 60 })
    client.registerTable('todos', noopHooks)
    client.start()
    const first = sockets[0]!
    first.open()
    bootstrap(first, 7)
    first.takeSent()

    // total silence: the fake socket never answers, never closes.
    await sleep(900)
    expect(sockets.length).toBeGreaterThanOrEqual(2) // heartbeat forced a new connection
    const second = sockets[1]!
    second.open()
    const [hello] = second.takeSent()
    // resume by cursor: the dead connection cost nothing
    expect(hello).toMatchObject({ type: 'hello', cursor: cursor(7) })
    client.stop()
  })

  it('pingIntervalMs 0 disables the heartbeat', async () => {
    const { client, sockets } = makeClient({ pingIntervalMs: 0 })
    client.registerTable('todos', noopHooks)
    client.start()
    const socket = sockets[0]!
    socket.open()
    bootstrap(socket)
    socket.takeSent()
    await sleep(150)
    expect(socket.takeSent()).toEqual([]) // no pings
    expect(sockets.length).toBe(1) // no forced reconnect
    client.stop()
  })
})
