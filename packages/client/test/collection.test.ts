import { createCollection } from '@tanstack/db'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { MutationError, SyncClient } from '../src/client'
import { workspaceCollectionOptions } from '../src/collection'
import { crudMutators, defineApp, defineMutators, defineSchema } from '../src/index'
import { FakeSocket, flushMicrotasks } from './fake-socket'

const schema = defineSchema({
  todos: z.object({
    id: z.string(),
    title: z.string(),
    completed: z.boolean(),
  }),
})

const mutators = defineMutators(schema, {
  ...crudMutators(schema),
  'todos.clearCompleted': { apply: () => {} },
})

type Todo = { id: string; title: string; completed: boolean }

const CLIENT_ID = 'client-a'

function setup() {
  const sockets: FakeSocket[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: CLIENT_ID,
    app: defineApp({ version: 'test-1', schema, mutators }),
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  })
  // Row type, key function, and runtime validation all derive from the schema.
  const todos = createCollection(
    workspaceCollectionOptions({
      client,
      table: 'todos',
      startSync: true,
    }),
  )
  client.start()
  const socket = sockets[sockets.length - 1]!
  socket.open()
  return { client, todos, socket }
}

function bootstrap(socket: FakeSocket, patch: Array<{ id: string; title: string; completed: boolean }>): void {
  const pokeId = 'poke-bootstrap'
  socket.receive({ type: 'pokeStart', pokeId, baseCursor: null })
  socket.receive({
    type: 'pokePart',
    pokeId,
    patch: [
      { op: 'clear' },
      ...patch.map((value) => ({ op: 'put' as const, tbl: 'todos', id: value.id, value })),
    ],
    lastMutationIdChanges: { [CLIENT_ID]: 0 },
  })
  socket.receive({
    type: 'pokeEnd',
    pokeId,
    cursor: { backendId: 'b1', version: 1 },
    pageInfo: { more: false },
  })
}

describe('workspaceCollectionOptions + TanStack DB', () => {
  it('bootstrap populates the collection and marks it ready', async () => {
    const { todos, socket } = setup()
    bootstrap(socket, [{ id: 't1', title: 'first', completed: false }])
    await todos.preload()
    expect(todos.get('t1')).toMatchObject({ id: 't1', title: 'first', completed: false })
    expect(todos.size).toBe(1)
  })

  it('optimistic insert is visible immediately and settles on server confirm', async () => {
    const { todos, socket } = setup()
    bootstrap(socket, [])
    await todos.preload()
    socket.takeSent()

    const tx = todos.insert({ id: 't2', title: 'optimistic', completed: false })
    // Optimistic overlay is visible before any server round-trip.
    expect(todos.get('t2')).toMatchObject({ title: 'optimistic' })

    await flushMicrotasks()
    const pushes = socket.takeSent().filter((m) => m.type === 'push')
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({
      mutations: [{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't2' } }],
    })

    // Server applies authoritatively and confirms.
    const pokeId = 'poke-confirm'
    socket.receive({ type: 'pokeStart', pokeId, baseCursor: { backendId: 'b1', version: 1 } })
    socket.receive({
      type: 'pokePart',
      pokeId,
      patch: [{ op: 'put', tbl: 'todos', id: 't2', value: { id: 't2', title: 'optimistic', completed: false } }],
      lastMutationIdChanges: { [CLIENT_ID]: 1 },
      mutationResults: [{ id: 1 }],
    })
    socket.receive({
      type: 'pokeEnd',
      pokeId,
      cursor: { backendId: 'b1', version: 2 },
      pageInfo: { more: false },
    })

    await tx.isPersisted.promise
    expect(todos.get('t2')).toMatchObject({ title: 'optimistic' })
    expect(todos.size).toBe(1)
  })

  it('server-side changes from other clients flow into the collection', async () => {
    const { todos, socket } = setup()
    bootstrap(socket, [{ id: 't1', title: 'first', completed: false }])
    await todos.preload()

    const pokeId = 'poke-remote'
    socket.receive({ type: 'pokeStart', pokeId, baseCursor: { backendId: 'b1', version: 1 } })
    socket.receive({
      type: 'pokePart',
      pokeId,
      patch: [
        { op: 'put', tbl: 'todos', id: 't1', value: { id: 't1', title: 'renamed', completed: true } },
        { op: 'put', tbl: 'todos', id: 't3', value: { id: 't3', title: 'new', completed: false } },
      ],
    })
    socket.receive({
      type: 'pokeEnd',
      pokeId,
      cursor: { backendId: 'b1', version: 2 },
      pageInfo: { more: false },
    })

    expect(todos.get('t1')).toMatchObject({ title: 'renamed', completed: true })
    expect(todos.get('t3')).toMatchObject({ title: 'new' })
    expect(todos.size).toBe(2)
  })

  it('infers the collection row type from the schema', () => {
    const { todos } = setup()
    expectTypeOf(todos.get('t1')?.title).toEqualTypeOf<string | undefined>()
    expectTypeOf(todos.get('t1')?.completed).toEqualTypeOf<boolean | undefined>()
    // @ts-expect-error properties outside the schema are compile errors
    void todos.get('t1')?.nope
  })
})

describe('typed mutate', () => {
  it('types names/args from the registry and validates args before queueing', async () => {
    const { client } = setup()
    // no-args mutator: callable with no second argument
    void client.mutate('todos.clearCompleted').catch(() => {})
    // @ts-expect-error unknown mutator names are compile errors
    void client.mutate('todos.claerCompleted').catch(() => {})

    // bad args fail fast with InvalidArgs — no server round-trip, nothing queued
    await expect(
      client.mutate('sync.del', { tbl: 'todos' } as never),
    ).rejects.toSatisfy((e) => e instanceof MutationError && e.code === 'InvalidArgs')
  })

  it('rejects mutators missing from the registry immediately', async () => {
    const { client } = setup()
    await expect(
      (client as SyncClient).mutate('no.such.mutator', {}),
    ).rejects.toSatisfy((e) => e instanceof MutationError && e.code === 'UnknownMutator')
  })
})
