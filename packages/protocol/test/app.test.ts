import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { crudMutators, defineApp, defineMutators, defineSchema } from '../src/index'
import { migrationPath } from '../src/internal'

const schema = defineSchema({ todos: z.record(z.string(), z.unknown()) })
const mutators = crudMutators(schema)

describe('defineApp', () => {
  it('accepts an app with no migrations', () => {
    const app = defineApp({ version: 1, schema, mutators })
    expect(app.version).toBe(1)
    expect(app.migrations).toEqual([])
  })

  it('rejects a non-integer or non-positive version', () => {
    expect(() => defineApp({ version: 0, schema, mutators })).toThrow(/positive integer/)
    expect(() => defineApp({ version: 1.5, schema, mutators })).toThrow(/positive integer/)
    expect(() => defineApp({ version: 'v1' as unknown as number, schema, mutators })).toThrow(
      /positive integer/,
    )
  })

  it('normalizes the migrations record into ascending steps', () => {
    const rewrite = (): void => {}
    const app = defineApp({
      version: 3,
      schema,
      mutators,
      migrations: { 3: null, 2: rewrite },
    })
    expect(app.migrations).toEqual([
      { to: 2, migrate: rewrite },
      { to: 3, migrate: null },
    ])
  })

  it('rejects migrations that do not end at the current version', () => {
    expect(() =>
      defineApp({ version: 3, schema, mutators, migrations: { 2: null } }),
    ).toThrow(/end at 2 but version is 3/)
  })

  it('rejects a gap in the migration versions', () => {
    expect(() =>
      defineApp({ version: 4, schema, mutators, migrations: { 2: null, 4: null } }),
    ).toThrow(/nothing for 3/)
  })

  it('rejects entries targeting version 1 or beyond the current version', () => {
    expect(() =>
      defineApp({ version: 2, schema, mutators, migrations: { 1: null, 2: null } }),
    ).toThrow(/valid target version/)
    expect(() =>
      defineApp({ version: 2, schema, mutators, migrations: { 2: null, 3: null } }),
    ).toThrow(/beyond the current one/)
  })

  it('allows dropping history older than the versions still in the field', () => {
    const app = defineApp({ version: 5, schema, mutators, migrations: { 4: null, 5: null } })
    expect(app.migrations.map((s) => s.to)).toEqual([4, 5])
  })
})

describe('defineApp crud mutators', () => {
  it('includes sync.put / sync.del by default, even with no mutators at all', () => {
    const app = defineApp({ version: 1, schema })
    expect(Object.keys(app.mutators).sort()).toEqual(['sync.del', 'sync.put'])
  })

  it('merges intent mutators alongside, with user entries winning on collision', () => {
    const mine = { apply: () => {} }
    const app = defineApp({
      version: 1,
      schema,
      mutators: { 'todos.archive': { apply: () => {} }, 'sync.put': mine },
    })
    expect(Object.keys(app.mutators).sort()).toEqual(['sync.del', 'sync.put', 'todos.archive'])
    expect(app.mutators['sync.put']).toBe(mine)
  })

  it('crud: false keeps the registry intent-only and rejects an empty one', () => {
    const app = defineApp({
      version: 1,
      schema,
      crud: false,
      mutators: { 'todos.archive': { apply: () => {} } },
    })
    expect(Object.keys(app.mutators)).toEqual(['todos.archive'])
    expect(() => defineApp({ version: 1, schema, crud: false, mutators: {} })).toThrow(
      /nothing can write/,
    )
  })
})

describe('migrationPath', () => {
  const app = defineApp({
    version: 3,
    schema,
    mutators,
    migrations: { 2: null, 3: null },
  })

  it('is empty when already current', () => {
    expect(migrationPath(app, 3)).toEqual([])
  })

  it('returns the steps from the stored version', () => {
    expect(migrationPath(app, 1).map((s) => s.to)).toEqual([2, 3])
    expect(migrationPath(app, 2).map((s) => s.to)).toEqual([3])
  })

  it('throws for a stored version ahead of the deployed one', () => {
    expect(() => migrationPath(app, 9)).toThrow(/rollback deploy/)
  })

  it('throws for a stored version older than the declared history', () => {
    const truncated = defineApp({ version: 5, schema, mutators, migrations: { 5: null } })
    expect(() => migrationPath(truncated, 3)).toThrow(/no migration path from stored schema version 3/)
    expect(() => migrationPath(truncated, 3)).toThrow(/cover 4 -> 5/)
  })

  it('throws when no migrations are declared and versions differ', () => {
    const bare = defineApp({ version: 2, schema, mutators })
    expect(() => migrationPath(bare, 1)).toThrow(/no migrations declared/)
  })
})

describe('defineMutators name rules', () => {
  it('rejects a name that is also a namespace prefix of another', () => {
    expect(() =>
      defineMutators(schema, {
        todos: { apply: () => {} },
        'todos.archive': { apply: () => {} },
      }),
    ).toThrow(/collides with the namespace/)
  })

  it('rejects empty dot-segments', () => {
    expect(() => defineMutators(schema, { 'todos..archive': { apply: () => {} } })).toThrow(
      /empty dot-segment/,
    )
  })
})
