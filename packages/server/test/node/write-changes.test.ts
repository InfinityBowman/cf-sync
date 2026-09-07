import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppError, createTestEngine, crudMutators, defineApp, defineMutators, defineSchema } from '../../src/testing'

// The change list a mutation reports — what onMutationCommitted receives —
// is the net effect per row: the stored image at first touch against what
// the mutation left, whatever happened in between.

const schema = defineSchema({
  todos: z.object({ title: z.string(), done: z.boolean().default(false) }),
})

const mutators = defineMutators(schema, {
  ...crudMutators(schema),
  'todo.toggleTwice': {
    args: z.object({ id: z.string() }),
    apply: (tx, { id }) => {
      const row = tx.get('todos', id)
      if (!row) throw new AppError('NotFound', id)
      tx.put('todos', id, { ...row, done: !row.done })
      // Reads see the overlay, so this flips it back: the net effect is a
      // rewrite of the same image.
      const flipped = tx.get('todos', id)!
      tx.put('todos', id, { ...flipped, done: !flipped.done })
    },
  },
  'todo.mutateInPlace': {
    args: z.object({ id: z.string() }),
    apply: (tx, { id }) => {
      const row = tx.get('todos', id)!
      row.done = true
      tx.put('todos', id, row)
    },
  },
  'todo.createThenDelete': {
    args: z.object({ id: z.string() }),
    apply: (tx, { id }) => {
      tx.put('todos', id, { title: 'ephemeral' })
      tx.del('todos', id)
    },
  },
  'todo.deleteThenCreate': {
    args: z.object({ id: z.string() }),
    apply: (tx, { id }) => {
      tx.del('todos', id)
      tx.put('todos', id, { title: 'reborn' })
    },
  },
  'todo.writeThenFail': {
    args: z.object({ id: z.string() }),
    apply: (tx, { id }) => {
      tx.put('todos', id, { title: 'ghost' })
      throw new AppError('Nope', 'wrote then failed')
    },
  },
})

const app = defineApp({ version: 1, schema, mutators })

describe('mutation change list', () => {
  it('reports inserts, updates, and deletes as before/after pairs, in touch order', () => {
    const engine = createTestEngine(app)

    expect(engine.mutate('sync.put', { tbl: 'todos', id: 'a', data: { title: 'a' } }).changes).toEqual([
      { tbl: 'todos', id: 'a', before: null, after: { title: 'a', done: false } },
    ])
    expect(engine.mutate('sync.put', { tbl: 'todos', id: 'a', data: { title: 'a2' } }).changes).toEqual([
      { tbl: 'todos', id: 'a', before: { title: 'a', done: false }, after: { title: 'a2', done: false } },
    ])
    expect(engine.mutate('sync.del', { tbl: 'todos', id: 'a' }).changes).toEqual([
      { tbl: 'todos', id: 'a', before: { title: 'a2', done: false }, after: null },
    ])
  })

  it('collapses repeated touches of one row to its net effect', () => {
    const engine = createTestEngine(app)
    engine.seed('todos', 'a', { title: 'a' })

    expect(engine.mutate('todo.toggleTwice', { id: 'a' }).changes).toEqual([
      { tbl: 'todos', id: 'a', before: { title: 'a', done: false }, after: { title: 'a', done: false } },
    ])
    expect(engine.mutate('todo.deleteThenCreate', { id: 'a' }).changes).toEqual([
      { tbl: 'todos', id: 'a', before: { title: 'a', done: false }, after: { title: 'reborn', done: false } },
    ])
  })

  it('keeps the before-image private when a mutator edits the row it read in place', () => {
    const engine = createTestEngine(app)
    engine.seed('todos', 'a', { title: 'a' })

    expect(engine.mutate('todo.mutateInPlace', { id: 'a' }).changes).toEqual([
      { tbl: 'todos', id: 'a', before: { title: 'a', done: false }, after: { title: 'a', done: true } },
    ])
  })

  it('is empty when nothing was written, and the version does not move', () => {
    const engine = createTestEngine(app)
    const before = engine.version

    expect(engine.mutate('sync.del', { tbl: 'todos', id: 'absent' })).toEqual({ changes: [] })
    expect(engine.mutate('todo.createThenDelete', { id: 'x' })).toEqual({ changes: [] })
    expect(engine.version).toBe(before)
  })

  it('is empty on a permanent error, with the write discarded', () => {
    const engine = createTestEngine(app)

    const result = engine.mutate('todo.writeThenFail', { id: 'g' })
    expect(result.error).toMatchObject({ code: 'Nope' })
    expect(result.changes).toEqual([])
    expect(engine.get('todos', 'g')).toBeNull()
  })
})
