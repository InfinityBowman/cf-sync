import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { AppError, defineApp, defineMutators, defineSchema } from '../src/index'
import type { MigrationTx, MutatorTx } from '../src/index'

// The "types just work" contract: inline mutators in defineApp infer exactly
// like defineMutators, no-args applies see `unknown` (never a silent `any`),
// and migration bodies get Record<string, unknown> reads so typos still fail
// to compile. These are compile-time assertions — `tsc --noEmit` is the test;
// the runtime expects only prove the values assemble.

const schema = defineSchema({
  todos: z.object({ id: z.string(), title: z.string(), done: z.boolean().default(false) }),
})

describe('defineApp inline mutators', () => {
  it('types tx and args without defineMutators', () => {
    const app = defineApp({
      version: 1,
      schema,
      mutators: {
        'todos.rename': {
          args: z.object({ id: z.string(), title: z.string() }),
          apply: (tx, args, ctx) => {
            expectTypeOf(tx).toEqualTypeOf<MutatorTx<typeof schema>>()
            expectTypeOf(args).toEqualTypeOf<{ id: string; title: string }>()
            expectTypeOf(ctx.authoritative).toEqualTypeOf<boolean>()
            const todo = tx.get('todos', args.id)
            if (!todo) throw new AppError('NotFound', 'missing')
            tx.put('todos', args.id, { ...todo, title: args.title })
            // @ts-expect-error a typo'd table name in an inline mutator must not compile
            tx.put('todoz', args.id, {})
          },
        },
      },
    })
    expect(Object.keys(app.mutators)).toContain('todos.rename')
    expect(Object.keys(app.mutators)).toContain('sync.put') // crud auto-included
  })

  it('no-args mutators see unknown args, not any', () => {
    defineMutators(schema, {
      'todos.clear': {
        apply: (_tx, args) => {
          expectTypeOf(args).toEqualTypeOf<unknown>()
        },
      },
    })
    defineApp({
      version: 1,
      schema,
      mutators: {
        'todos.clear': {
          apply: (_tx, args) => {
            expectTypeOf(args).toEqualTypeOf<unknown>()
          },
        },
      },
    })
  })

  it('registries carrying an authContext still flow through defineApp', () => {
    const mutators = defineMutators(
      schema,
      {
        'todos.guarded': {
          args: z.object({ id: z.string() }),
          apply: (tx, { id }, ctx) => {
            expectTypeOf(ctx.auth).toEqualTypeOf<{ writeAllowed: boolean } | undefined>()
            tx.del('todos', id)
          },
        },
      },
      { authContext: z.object({ writeAllowed: z.boolean() }) },
    )
    const app = defineApp({ version: 1, schema, mutators })
    expect(app.authContext).toBeDefined()
    expect(Object.keys(app.mutators)).toContain('todos.guarded')
  })

  it('crud: false with inline mutators keeps the intent-only registry typed', () => {
    const app = defineApp({
      version: 1,
      schema,
      crud: false,
      mutators: {
        'todos.done': {
          args: z.object({ id: z.string() }),
          apply: (tx, { id }) => {
            expectTypeOf(id).toEqualTypeOf<string>()
            const todo = tx.get('todos', id)
            if (todo) tx.put('todos', id, { ...todo, done: true })
          },
        },
      },
    })
    expect(Object.keys(app.mutators)).toEqual(['todos.done']) // no crud pair
  })
})

describe('migration tx typing', () => {
  it('reads come back as Record<string, unknown>, so field typos stay visible', () => {
    const app = defineApp({
      version: 2,
      schema,
      migrations: {
        2: (tx) => {
          expectTypeOf(tx).toEqualTypeOf<MigrationTx>()
          for (const { id, data } of tx.list('todos')) {
            expectTypeOf(data).toEqualTypeOf<Record<string, unknown>>()
            expectTypeOf(data.title).toEqualTypeOf<unknown>() // must be narrowed, never trusted
            tx.put('todos', id, { done: false, ...data })
          }
        },
      },
    })
    expect(app.migrations).toHaveLength(1)
  })
})
