import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncClient, type TableWriteOp } from '../src/client'
import { testApp } from './test-schema'
import { FakeSocket } from './fake-socket'

const SCHEMA = 1

function makeClient(overrides: Partial<ConstructorParameters<typeof SyncClient>[0]> = {}) {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: 'client-a',
    autoStart: false,
    app: testApp,
    createSocket: (url) => {
      urls.push(url)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    ...overrides,
  })
  return { client, sockets, urls, latest: () => sockets[sockets.length - 1]! }
}

function bootstrap(socket: FakeSocket, clientId: string, patch: TableWriteOp[] = []): void {
  const pokeId = 'poke-bootstrap'
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: null })
  socket.receive({
    type: 'pokePart',
    pokeId,
    patch: [
      { op: 'clear' },
      ...patch.map((op) =>
        op.type === 'put'
          ? ({ op: 'put', tbl: 'todos', id: op.id, value: op.value } as const)
          : ({ op: 'del', tbl: 'todos', id: op.id } as const),
      ),
    ],
    lastMutationIdChanges: { [clientId]: 0 },
  })
  socket.receive({ type: 'pokeEnd', pokeId, cursor: { backendId: 'b1', version: 1 }, pageInfo: { more: false } })
}

class RecordingHooks {
  rows = new Map<string, Record<string, unknown>>()
  ready = false
  #pending: TableWriteOp[] = []

  hooks = {
    begin: () => {
      this.#pending = []
    },
    write: (op: TableWriteOp) => {
      this.#pending.push(op)
    },
    commit: () => {
      for (const op of this.#pending) {
        if (op.type === 'put') this.rows.set(op.id, op.value)
        else this.rows.delete(op.id)
      }
    },
    truncate: () => {
      this.rows.clear()
    },
    markReady: () => {
      this.ready = true
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('sync URL construction', () => {
  it('appends /sync/<workspaceId>?clientId=<clientId> to the base URL', () => {
    const { client, urls } = makeClient()
    client.start()
    expect(urls).toEqual(['ws://test/sync/w1?clientId=client-a'])
  })

  it('converts http(s) bases to ws(s) and tolerates a trailing slash', () => {
    const { client, urls } = makeClient({ url: 'https://sync.example.com/' })
    client.start()
    expect(urls).toEqual(['wss://sync.example.com/sync/w1?clientId=client-a'])
  })

  it('honors a custom pathPrefix, matching the server router', () => {
    const { client, urls } = makeClient({ url: 'ws://test/mount', pathPrefix: '/ws' })
    client.start()
    expect(urls).toEqual(['ws://test/mount/ws/w1?clientId=client-a'])
  })

  it('percent-encodes the workspaceId and clientId', () => {
    const { client, urls } = makeClient({ workspaceId: 'team/a', clientId: 'id with spaces' })
    client.start()
    expect(urls).toEqual(['ws://test/sync/team%2Fa?clientId=id%20with%20spaces'])
  })

  it('requires a workspaceId', () => {
    expect(() => makeClient({ workspaceId: '' })).toThrow(/workspaceId/)
  })
})

describe('managed clientId', () => {
  it('confirmation matching uses the same clientId as the URL', () => {
    // The whole point of building the URL internally: the id the server binds
    // at upgrade is the id used to match lastMutationIdChanges.
    const { client, urls, latest } = makeClient({ clientId: undefined })
    const recorder = new RecordingHooks()
    client.registerTable('todos', recorder.hooks)
    client.start()
    expect(urls[0]).toBe(`ws://test/sync/w1?clientId=${encodeURIComponent(client.clientId)}`)

    const socket = latest()
    socket.open()
    bootstrap(socket, client.clientId)
    expect(client.status).toBe('synced')
  })

  it('generates a fresh id per instance when sessionStorage is unavailable', () => {
    const a = makeClient({ clientId: undefined }).client
    const b = makeClient({ clientId: undefined }).client
    expect(a.clientId).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.clientId).not.toBe(b.clientId)
  })

  it('persists the id in sessionStorage, keyed per workspace', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
    })

    const first = makeClient({ clientId: undefined }).client
    const again = makeClient({ clientId: undefined }).client
    const other = makeClient({ clientId: undefined, workspaceId: 'w2' }).client
    expect(again.clientId).toBe(first.clientId) // reload continuity
    expect(other.clientId).not.toBe(first.clientId) // per-workspace sequence
    expect([...backing.keys()]).toEqual(['cf-sync:client-id:w1', 'cf-sync:client-id:w2'])
  })

  it('prefers an explicitly configured clientId', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => 'stored-id',
      setItem: () => {},
    })
    const { client } = makeClient({ clientId: 'explicit' })
    expect(client.clientId).toBe('explicit')
  })
})

describe('persist option', () => {
  it('rejects persist combined with an explicit store', () => {
    expect(() =>
      makeClient({ persist: true, store: { load: async () => null } as never }),
    ).toThrow(/either `store` or `persist`/)
  })

  it('warns and runs without persistence when IndexedDB is unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, latest } = makeClient({ persist: true })
    client.start()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('IndexedDB is unavailable'), expect.anything())

    // Still connects and syncs, just without a durable mirror.
    latest().open()
    bootstrap(latest(), 'client-a')
    expect(client.status).toBe('synced')
  })

  it('round-trips synced rows through the internally-built IndexedDB store', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())

    const first = makeClient({ persist: true })
    first.client.start()
    await vi.waitFor(() => expect(first.sockets.length).toBe(1))
    first.latest().open()
    bootstrap(first.latest(), 'client-a', [{ type: 'put', id: 't1', value: { title: 'persisted' } }])
    expect(first.client.status).toBe('synced')
    // applyPoke persistence is fire-and-forget; retry hydration until it lands.
    await vi.waitFor(
      async () => {
        const second = makeClient({ persist: true })
        const recorder = new RecordingHooks()
        second.client.registerTable('todos', recorder.hooks)
        second.client.start()
        try {
          await vi.waitFor(() => expect(recorder.ready).toBe(true), { timeout: 300 })
          expect(recorder.rows.get('t1')).toEqual({ title: 'persisted' })
        } finally {
          void second.client.destroy()
        }
      },
      { timeout: 5_000, interval: 50 },
    )
    void first.client.destroy()
  })
})

describe('start() nudge', () => {
  it('warns when tables are registered but start() is never called', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = makeClient()
    client.registerTable('todos', new RecordingHooks().hooks)
    vi.advanceTimersByTime(5_001)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('start() was never called'))
    void client // keep the client referenced so nothing collects it mid-test
  })

  it('stays silent once start() is called', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = makeClient()
    client.registerTable('todos', new RecordingHooks().hooks)
    client.start()
    vi.advanceTimersByTime(10_000)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('autoStart', () => {
  it('connects on construction by default; start() stays an idempotent no-op', () => {
    const { client, sockets, latest } = makeClient({ autoStart: undefined })
    expect(sockets).toHaveLength(1) // connected without an explicit start()
    expect(client.status).toBe('connecting')
    client.start()
    expect(sockets).toHaveLength(1) // no second connection
    latest().open()
    expect(client.status).toBe('syncing')
    void client.destroy()
  })

  it('autoStart: false waits for an explicit start()', () => {
    const { client, sockets } = makeClient()
    expect(sockets).toHaveLength(0)
    expect(client.status).toBe('idle')
    client.start()
    expect(sockets).toHaveLength(1)
    void client.destroy()
  })
})
