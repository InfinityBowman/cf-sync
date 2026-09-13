import { createTestEngine } from '@cf-sync/server/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SyncClient } from '../src/client'
import { createCollections } from '../src/collection'
import { defineApp, defineMutators, defineSchema } from '../src/index'
import { MemorySyncStore } from '../src/store'
import { FakeSocket, flushMicrotasks } from './fake-socket'

// The seed's three paths (ARCHITECTURE.md#optimistic-intents): minted at
// mutate() time, persisted with the outbox entry, carried on the wire — so
// the optimistic run, a post-reload replay, and the authoritative run all
// mint the same ids.

const schema = defineSchema({
  cells: z.object({ id: z.string(), studyId: z.string() }),
})

const mutators = defineMutators(schema, {
  'cells.materialize': {
    args: z.object({ studyId: z.string(), count: z.number() }),
    apply: (tx, { studyId, count }, ctx) => {
      for (let i = 0; i < count; i++) {
        const id = ctx.nextId()
        tx.put('cells', id, { id, studyId })
      }
    },
  },
})

const app = defineApp({ version: 1, schema, mutators })
const CLIENT_ID = 'client-a'

function session(store?: MemorySyncStore) {
  const sockets: FakeSocket[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: CLIENT_ID,
    autoStart: false,
    app,
    store,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  })
  const { cells } = createCollections(client)
  client.start()
  return { client, cells, latest: () => sockets[sockets.length - 1]! }
}

function bootstrap(socket: FakeSocket): void {
  socket.receive({ type: 'pokeStart', pokeId: 'boot', baseCursor: null })
  socket.receive({ type: 'pokePart', pokeId: 'boot', patch: [{ op: 'clear' }], lastMutationIdChanges: { [CLIENT_ID]: 0 } })
  socket.receive({ type: 'pokeEnd', pokeId: 'boot', cursor: { backendId: 'b1', version: 1 }, pageInfo: { more: false } })
}

type Push = { type: 'push'; mutations: Array<{ id: number; name: string; args: unknown; seed: string }> }

describe('mutation seeds', () => {
  it('the optimistic run and the authoritative run mint identical ids', async () => {
    const { client, cells, latest } = session()
    await flushMicrotasks()
    const socket = latest()
    socket.open()
    bootstrap(socket)
    await flushMicrotasks()

    void client.mutate('cells.materialize', { studyId: 's1', count: 3 }).catch(() => {})
    await flushMicrotasks()
    const push = socket.takeSent().find((m) => m.type === 'push') as Push
    const [mutation] = push.mutations
    expect(mutation!.seed).toMatch(/\S/)

    // The server's seat: the same mutation applied under the wire's seed.
    const engine = createTestEngine(app, { nextSeed: () => mutation!.seed })
    expect(engine.mutate('cells.materialize', { studyId: 's1', count: 3 }).error).toBeUndefined()
    const optimistic = [...cells.keys()].sort()
    const authoritative = engine.list('cells').map((r) => r.id).sort()
    expect(optimistic).toHaveLength(3)
    expect(optimistic).toEqual(authoritative)
    await client.destroy()
  })

  it('two mutations in one push carry different seeds', async () => {
    const { client, latest } = session()
    await flushMicrotasks()
    const socket = latest()
    socket.open()
    bootstrap(socket)
    await flushMicrotasks()
    void client.mutate('cells.materialize', { studyId: 's1', count: 1 }).catch(() => {})
    void client.mutate('cells.materialize', { studyId: 's2', count: 1 }).catch(() => {})
    await flushMicrotasks()
    const seeds = (socket.takeSent().filter((m) => m.type === 'push') as Push[]).flatMap((p) =>
      p.mutations.map((m) => m.seed),
    )
    expect(seeds).toHaveLength(2)
    expect(seeds[0]).not.toBe(seeds[1])
    await client.destroy()
  })

  it('a queued mutation replayed after a reload mints the ids of its first run', async () => {
    const store = new MemorySyncStore()
    const first = session(store)
    await flushMicrotasks()
    void first.client.mutate('cells.materialize', { studyId: 's1', count: 2 }).catch(() => {})
    await flushMicrotasks()
    const before = [...first.cells.keys()].sort()
    expect(before).toHaveLength(2)
    await first.client.destroy()
    const persisted = (await store.load())!.outbox
    expect(persisted[0]!.seed).toMatch(/\S/)

    const second = session(store)
    await flushMicrotasks()
    expect([...second.cells.keys()].sort()).toEqual(before)
    const socket = second.latest()
    socket.open()
    bootstrap(socket)
    await flushMicrotasks()
    const push = socket.takeSent().find((m) => m.type === 'push') as Push
    expect(push.mutations[0]!.seed).toBe(persisted[0]!.seed)
    await second.client.destroy()
  })

  it('an entry persisted without a seed gets one at replay, and the wire carries it', async () => {
    const store = new MemorySyncStore()
    await store.saveOutbox([{ id: null, name: 'cells.materialize', args: { studyId: 's1', count: 1 } }], 0)
    const { client, cells, latest } = session(store)
    await flushMicrotasks()
    expect(cells.size).toBe(1)
    const socket = latest()
    socket.open()
    bootstrap(socket)
    await flushMicrotasks()
    const push = socket.takeSent().find((m) => m.type === 'push') as Push
    expect(push.mutations[0]!.seed).toMatch(/\S/)
    expect((await store.load())!.outbox[0]!.seed).toBe(push.mutations[0]!.seed)
    await client.destroy()
  })
})
