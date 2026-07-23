import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { crudMutators, defineApp, defineSchema, migrationPath } from '../src/index'

const schema = defineSchema({ todos: z.record(z.string(), z.unknown()) })
const mutators = crudMutators(schema)

describe('defineApp', () => {
  it('accepts an app with no migrations', () => {
    const app = defineApp({ version: 'v1', schema, mutators })
    expect(app.version).toBe('v1')
    expect(app.migrations).toEqual([])
  })

  it('rejects an empty version', () => {
    expect(() => defineApp({ version: '', schema, mutators })).toThrow(/non-empty/)
  })

  it('rejects a chain that does not end at the current version', () => {
    expect(() =>
      defineApp({
        version: 'v3',
        schema,
        mutators,
        migrations: [{ from: 'v1', to: 'v2' }],
      }),
    ).toThrow(/ends at "v2" but version is "v3"/)
  })

  it('rejects a broken chain', () => {
    expect(() =>
      defineApp({
        version: 'v4',
        schema,
        mutators,
        migrations: [
          { from: 'v1', to: 'v2' },
          { from: 'v3', to: 'v4' },
        ],
      }),
    ).toThrow(/must chain/)
  })

  it('rejects a self-migration and a revisited version', () => {
    expect(() =>
      defineApp({ version: 'v1', schema, mutators, migrations: [{ from: 'v1', to: 'v1' }] }),
    ).toThrow(/to itself/)
    expect(() =>
      defineApp({
        version: 'v1',
        schema,
        mutators,
        migrations: [
          { from: 'v1', to: 'v2' },
          { from: 'v2', to: 'v1' },
        ],
      }),
    ).toThrow(/revisits/)
  })
})

describe('migrationPath', () => {
  const app = defineApp({
    version: 'v3',
    schema,
    mutators,
    migrations: [
      { from: 'v1', to: 'v2' },
      { from: 'v2', to: 'v3' },
    ],
  })

  it('is empty when already current', () => {
    expect(migrationPath(app, 'v3')).toEqual([])
  })

  it('returns the suffix from the stored version', () => {
    expect(migrationPath(app, 'v1').map((s) => s.to)).toEqual(['v2', 'v3'])
    expect(migrationPath(app, 'v2').map((s) => s.to)).toEqual(['v3'])
  })

  it('throws for a version outside the chain, naming the history', () => {
    expect(() => migrationPath(app, 'v0')).toThrow(/v1 -> v2 -> v3/)
    expect(() => migrationPath(app, 'v9')).toThrow(/no migration path/)
  })

  it('throws when no migrations are declared and versions differ', () => {
    const bare = defineApp({ version: 'v2', schema, mutators })
    expect(() => migrationPath(bare, 'v1')).toThrow(/no migrations declared/)
  })
})
