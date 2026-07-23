import { describe, expect, it } from 'vitest'
import { z } from 'zod'
// The definition kit comes from @cf-sync/protocol (not ../src/index) so this
// file runs under a plain node pool too — the server's main index imports
// cloudflare:workers, which only the testing entry point avoids. User test
// files should import the same way.
import { AppError, crudMutators, defineApp, defineMutators, defineSchema } from '@cf-sync/protocol'
import { createTestEngine } from '../src/testing'

/**
 * The exported test engine (`@cf-sync/server/testing`): app developers unit
 * test mutators and migrations against the same engine core the DO runs.
 */

const schema = defineSchema({
  todos: z.object({
    id: z.string(),
    title: z.string(),
    completed: z.boolean(),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
  }),
})

const mutators = defineMutators(schema, {
  ...crudMutators(schema),
  'todos.clearCompleted': {
    apply: (tx) => {
      for (const { id, data } of tx.list('todos')) {
        if (data.completed) tx.del('todos', id)
      }
    },
  },
  'todos.rename': {
    args: z.object({ id: z.string(), title: z.string().min(1) }),
    apply: (tx, { id, title }, ctx) => {
      const todo = tx.get('todos', id)
      if (!todo) throw new AppError('NotFound', `todo ${id} does not exist`)
      tx.put('todos', id, { ...todo, title: `${title} (by ${ctx.clientId})` })
    },
  },
  'todos.explode': {
    apply: () => {
      throw new TypeError('transient bug')
    },
  },
})

const app = defineApp({
  version: 2,
  schema,
  mutators,
  migrations: {
    2: (tx) => {
      for (const { id, data } of tx.list('todos')) {
        tx.put('todos', id, { priority: 'normal', ...data })
      }
    },
  },
})

describe('createTestEngine: mutators', () => {
  it('applies intent mutators against seeded state', () => {
    const engine = createTestEngine(app)
    engine.seed('todos', 't1', { id: 't1', title: 'keep', completed: false })
    engine.seed('todos', 't2', { id: 't2', title: 'drop', completed: true })

    const result = engine.mutate('todos.clearCompleted')
    expect(result.error).toBeUndefined()
    expect(engine.list('todos').map((r) => r.id)).toEqual(['t1'])
    expect(engine.lastMutationId()).toBe(1)
  })

  it('seeds and reads parsed rows (schema defaults applied)', () => {
    const engine = createTestEngine(app)
    engine.seed('todos', 't1', { id: 't1', title: 'x', completed: false })
    expect(engine.get('todos', 't1')).toEqual({ id: 't1', title: 'x', completed: false, priority: 'normal' })
  })

  it('AppError is permanent: LMID advances, writes are discarded', () => {
    const engine = createTestEngine(app)
    const before = engine.version

    const result = engine.mutate('todos.rename', { id: 'missing', title: 'nope' })
    expect(result.error).toMatchObject({ code: 'NotFound' })
    expect(engine.lastMutationId()).toBe(1) // invariant 2: errors still advance
    expect(engine.version).toBe(before) // no data version bump
    expect(engine.list('todos')).toEqual([])
  })

  it('invalid args are a permanent InvalidArgs error', () => {
    const engine = createTestEngine(app)
    const result = engine.mutate('todos.rename', { id: 't1', title: '' })
    expect(result.error).toMatchObject({ code: 'InvalidArgs' })
    expect(engine.lastMutationId()).toBe(1)
  })

  it('unknown mutators are permanent UnknownMutator errors', () => {
    const engine = createTestEngine(app)
    const result = (engine as ReturnType<typeof createTestEngine>).mutate('no.such.thing')
    expect(result.error).toMatchObject({ code: 'UnknownMutator' })
    expect(engine.lastMutationId()).toBe(1)
  })

  it('non-AppError throws are transient: rethrown, nothing commits', () => {
    const engine = createTestEngine(app)
    expect(() => engine.mutate('todos.explode')).toThrow('transient bug')
    expect(engine.lastMutationId()).toBe(0)
  })

  it('mutators see ctx.clientId (mutate vs mutateAs)', () => {
    const engine = createTestEngine(app, { clientId: 'alice' })
    engine.seed('todos', 't1', { id: 't1', title: 'x', completed: false })

    engine.mutate('todos.rename', { id: 't1', title: 'renamed' })
    expect(engine.get('todos', 't1')?.title).toBe('renamed (by alice)')

    engine.mutateAs('bob', 'todos.rename', { id: 't1', title: 'again' })
    expect(engine.get('todos', 't1')?.title).toBe('again (by bob)')
    expect(engine.lastMutationId('alice')).toBe(1)
    expect(engine.lastMutationId('bob')).toBe(1)
  })

  it('crud mutators run through the same path', () => {
    const engine = createTestEngine(app)
    engine.mutate('sync.put', { tbl: 'todos', id: 't1', data: { id: 't1', title: 'x', completed: false } })
    expect(engine.get('todos', 't1')?.priority).toBe('normal')
    engine.mutate('sync.del', { tbl: 'todos', id: 't1' })
    expect(engine.get('todos', 't1')).toBeNull()
  })
})

describe('createTestEngine: migrations', () => {
  it('replays the migration chain over old-shaped rows at construction', () => {
    const engine = createTestEngine(app, {
      storedVersion: 1,
      rows: {
        // Version-1 shape: no priority field (would fail the v2 schema as-is
        // without the default — the migration stamps it explicitly).
        todos: { t1: { id: 't1', title: 'old row', completed: false } },
      },
    })
    expect(engine.get('todos', 't1')).toEqual({
      id: 't1',
      title: 'old row',
      completed: false,
      priority: 'normal',
    })
  })

  it('throws at construction when the chain leaves a schema-invalid row', () => {
    const badApp = defineApp({
      version: 2,
      schema,
      mutators,
      migrations: {
        2: (tx) => {
          tx.put('todos', 't1', { wrong: true } as never)
        },
      },
    })
    expect(() =>
      createTestEngine(badApp, { storedVersion: 1, rows: { todos: { t1: { id: 't1' } } } }),
    ).toThrow(/invalid row todos\/t1/)
  })

  it('throws at construction when no migration path covers the stored version', () => {
    expect(() => createTestEngine(app, { storedVersion: 0 })).toThrow(/no migration path/)
  })

  it('validates initial rows against the current schema when no storedVersion is given', () => {
    expect(() => createTestEngine(app, { rows: { todos: { t1: { id: 't1' } } } })).toThrow(
      /invalid row todos\/t1/,
    )
  })
})
