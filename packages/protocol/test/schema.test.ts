import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  crudMutators,
  defineMutators,
  defineSchema,
  type CrudPutArgs,
  type MutationArgs,
  type MutatorTx,
  type RowInputOf,
  type RowOf,
} from '../src/index'
import { formatIssues } from '../src/internal'

const todoSchema = z.object({
  id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
})

const schema = defineSchema({ todos: todoSchema })

describe('defineSchema', () => {
  it('rejects invalid table names', () => {
    expect(() => defineSchema({ 'bad table': z.object({}) })).toThrow(/invalid table name/)
    expect(() => defineSchema({ '': z.object({}) })).toThrow(/invalid table name/)
  })

  it('infers row output and input types', () => {
    expectTypeOf<RowOf<typeof schema, 'todos'>>().toEqualTypeOf<{
      id: string
      title: string
      completed: boolean
      priority: 'low' | 'normal' | 'high'
    }>()
    // priority has a default, so the input shape may omit it
    expectTypeOf<RowInputOf<typeof schema, 'todos'>>().toEqualTypeOf<{
      id: string
      title: string
      completed: boolean
      priority?: 'low' | 'normal' | 'high' | undefined
    }>()
  })
})

describe('defineMutators', () => {
  it('returns the definitions and validates their shape', () => {
    const defs = defineMutators(schema, {
      'todos.rename': {
        args: z.object({ id: z.string(), title: z.string() }),
        apply: (tx, args) => {
          const row = tx.get('todos', args.id)
          if (row) tx.put('todos', args.id, { ...row, title: args.title })
        },
      },
      'todos.clearCompleted': {
        apply: (tx) => {
          for (const { id, data } of tx.list('todos')) if (data.completed) tx.del('todos', id)
        },
      },
    })
    expect(Object.keys(defs)).toEqual(['todos.rename', 'todos.clearCompleted'])

    expect(() =>
      defineMutators(schema, { bad: { apply: undefined as unknown as () => void } }),
    ).toThrow(/no apply function/)
  })

  it('types apply args from the schema and mutate args from its input', () => {
    const defs = defineMutators(schema, {
      'todos.setPriority': {
        args: z.object({ id: z.string(), priority: z.enum(['low', 'normal', 'high']).default('normal') }),
        apply: (tx, args) => {
          // output type: default applied
          expectTypeOf(args.priority).toEqualTypeOf<'low' | 'normal' | 'high'>()
          expectTypeOf(tx).toEqualTypeOf<MutatorTx<typeof schema>>()
        },
      },
      'todos.noArgs': { apply: () => {} },
    })
    // mutate() takes the *input* type: priority omissible
    expectTypeOf<MutationArgs<(typeof defs)['todos.setPriority']>>().toEqualTypeOf<
      [args: { id: string; priority?: 'low' | 'normal' | 'high' | undefined }]
    >()
    // a no-args mutator takes no argument at all
    expectTypeOf<MutationArgs<(typeof defs)['todos.noArgs']>>().toEqualTypeOf<[]>()
  })
})

describe('crudMutators', () => {
  it('validates the envelope shape via its args schema', () => {
    const crud = crudMutators(schema)
    const validate = (value: unknown) => crud['sync.put'].args['~standard'].validate(value)
    const bad = validate({ tbl: 'todos' })
    if (bad instanceof Promise) throw new Error('unexpected async validation')
    expect(bad.issues).toBeDefined()
    const ok = validate({ tbl: 'todos', id: 'a', data: { anything: true } })
    if (ok instanceof Promise) throw new Error('unexpected async validation')
    expect(ok.issues).toBeUndefined()
  })

  it('types put args as a per-table union of input rows', () => {
    expectTypeOf<CrudPutArgs<typeof schema>>().toEqualTypeOf<{
      tbl: 'todos'
      id: string
      data: RowInputOf<typeof schema, 'todos'>
    }>()
  })
})

describe('formatIssues', () => {
  it('renders paths and truncates long issue lists', () => {
    expect(formatIssues([{ message: 'required', path: ['data', 'title'] }])).toBe('data.title: required')
    expect(formatIssues([{ message: 'a' }, { message: 'b' }])).toBe('a; b')
    const many = Array.from({ length: 7 }, (_, i) => ({ message: `issue ${i}` }))
    expect(formatIssues(many)).toMatch(/\+2 more$/)
  })
})
