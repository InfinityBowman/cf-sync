import type { Cursor } from '@cf-sync/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncClient } from '../src/client'
import type { SyncStore, PersistedState } from '../src/store'
import { MemorySyncStore } from '../src/store'
import type { TableWriteOp } from '../src/types'
import { testApp } from './test-schema'
import { FakeSocket, flushMicrotasks } from './fake-socket'

const SCHEMA = 1
const CLIENT_ID = 'client-a'

/** Minimal table sink — hydration's observable effect is rows plus markReady. */
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
      this.#pending = []
    },
    truncate: () => {},
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
  return { client, sockets }
}

function cursor(version: number): Cursor {
  return { backendId: 'b1', version }
}

/** Seeds a store as if a previous session had synced this state. */
async function seedStore(store: MemorySyncStore, opts: { rows?: { id: string; title: string }[]; version?: number } = {}) {
  await store.applyPoke({
    ops: (opts.rows ?? []).map((r) => ({ op: 'put' as const, tbl: 'todos', id: r.id, value: { title: r.title } })),
    clear: true,
    cursor: cursor(opts.version ?? 1),
    schemaVersion: SCHEMA,
    confirmedLmid: 0,
    outbox: [],
  })
}

describe('offline-first render signal', () => {
  let recorder: RecordingHooks

  beforeEach(() => {
    recorder = new RecordingHooks()
  })

  it('reports hydrated once a cached snapshot is restored, before the socket connects', async () => {
    const store = new MemorySyncStore()
    await seedStore(store, { rows: [{ id: 't1', title: 'cached' }], version: 5 })

    const { client, sockets } = makeClient({ store })
    client.registerTable('todos', recorder.hooks)
    expect(client.hydrated).toBe(false)

    client.start()
    // The whole point: 'connecting' reads the same on both sides of the edge,
    // so status cannot be what an offline launch gates its first paint on.
    expect(client.status).toBe('connecting')
    expect(client.hydrated).toBe(false)

    await flushMicrotasks()

    expect(client.hydrated).toBe(true)
    expect(await client.whenHydrated).toBe(true)
    // Cached rows are painted and ready — and no network I/O happened first.
    expect(recorder.rows.get('t1')).toEqual({ title: 'cached' })
    expect(recorder.ready).toBe(true)
    expect(sockets[0]!.sent.length).toBe(0)
  })

  it('settles false on a first launch: an empty store is not a renderable cache', async () => {
    const { client } = makeClient({ store: new MemorySyncStore() })
    client.registerTable('todos', recorder.hooks)
    client.start()
    await flushMicrotasks()

    // The distinction an empty collection cannot make on its own.
    expect(client.hydrated).toBe(false)
    expect(await client.whenHydrated).toBe(false)
    expect(recorder.ready).toBe(false)
  })

  it('settles false when the cache targets a different app version', async () => {
    const store = new MemorySyncStore()
    await seedStore(store, { rows: [{ id: 't1', title: 'stale' }] })
    // The rows are discarded, so there is nothing to paint from.
    const { client } = makeClient({ store, app: { ...testApp, version: SCHEMA + 1 } })
    client.registerTable('todos', recorder.hooks)
    client.start()
    await flushMicrotasks()

    expect(client.hydrated).toBe(false)
    expect(await client.whenHydrated).toBe(false)
    expect(recorder.rows.size).toBe(0)
  })

  it('settles false when the store fails to load', async () => {
    const failing: SyncStore = {
      load: () => Promise.reject(new Error('idb blocked')),
      applyPoke: () => Promise.resolve(),
      saveOutbox: () => Promise.resolve(),
      reset: () => Promise.resolve(),
    }
    const { client, sockets } = makeClient({ store: failing, logger: () => {} })
    client.start()
    await flushMicrotasks()

    expect(client.hydrated).toBe(false)
    expect(await client.whenHydrated).toBe(false)
    // A settled-false latch still lets the client connect and bootstrap.
    expect(sockets.length).toBe(1)
  })

  it('settles false immediately when no store is configured', async () => {
    const { client } = makeClient()
    client.start()

    // Synchronous: there is no store to await, and whenHydrated must never
    // hang for the life of a memory-only client.
    expect(client.hydrated).toBe(false)
    await expect(client.whenHydrated).resolves.toBe(false)
  })

  it('notifies subscribers on the transition, and unsubscribes cleanly', async () => {
    const store = new MemorySyncStore()
    await seedStore(store, { rows: [{ id: 't1', title: 'cached' }] })

    const { client } = makeClient({ store })
    client.registerTable('todos', recorder.hooks)
    const seen: boolean[] = []
    const unsubscribe = client.subscribeHydrated((v) => seen.push(v))
    const dropped = vi.fn()
    client.subscribeHydrated(dropped)()

    client.start()
    await flushMicrotasks()

    expect(seen).toEqual([true])
    expect(dropped).not.toHaveBeenCalled()

    unsubscribe()
    // The latch settles once — no second notification, ever.
    await flushMicrotasks()
    expect(seen).toEqual([true])
  })

  it('does not fire subscribers when there was nothing to restore', async () => {
    const { client } = makeClient({ store: new MemorySyncStore() })
    const listener = vi.fn()
    client.subscribeHydrated(listener)
    client.start()
    await flushMicrotasks()

    // false is the initial value; a "changed to false" notification would be
    // a spurious re-render for every memory-only or first-launch client.
    expect(listener).not.toHaveBeenCalled()
    expect(client.hydrated).toBe(false)
  })

  it('settles the latch on destroy so awaiters never outlive the client', async () => {
    let releaseLoad!: (state: PersistedState | null) => void
    const blocked: SyncStore = {
      load: () =>
        new Promise<PersistedState | null>((resolve) => {
          releaseLoad = resolve
        }),
      applyPoke: () => Promise.resolve(),
      saveOutbox: () => Promise.resolve(),
      reset: () => Promise.resolve(),
    }
    const { client } = makeClient({ store: blocked })
    client.start()
    await flushMicrotasks()
    expect(client.hydrated).toBe(false)

    await client.destroy()

    await expect(client.whenHydrated).resolves.toBe(false)
    // The in-flight load landing afterwards cannot reopen a closed latch.
    releaseLoad(null)
    await flushMicrotasks()
    expect(client.hydrated).toBe(false)
  })

  it('stays hydrated across a reconnect — the latch describes local state, not the socket', async () => {
    const store = new MemorySyncStore()
    await seedStore(store, { rows: [{ id: 't1', title: 'cached' }] })

    const { client, sockets } = makeClient({ store })
    client.registerTable('todos', recorder.hooks)
    client.start()
    await flushMicrotasks()
    expect(client.hydrated).toBe(true)

    sockets[0]!.open()
    sockets[0]!.close() // a plain network drop, not a policy close
    await flushMicrotasks()

    expect(client.status).toBe('reconnecting')
    expect(client.hydrated).toBe(true)
  })
})
