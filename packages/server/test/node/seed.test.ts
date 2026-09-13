import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createIdSource } from '@cf-sync/protocol/internal'
import { AppError, createTestEngine, defineApp, defineMutators, defineSchema } from '../../src/testing'

// ctx.nextId (ARCHITECTURE.md#optimistic-intents): a pure function of the
// mutation's seed, restarting at the top of every apply, so a batch a
// mutator cannot enumerate at mutate() time still gets ids both runs agree on.

const schema = defineSchema({
  cells: z.object({ studyId: z.string(), seed: z.string() }),
})

const mutators = defineMutators(schema, {
  'cells.materialize': {
    args: z.object({ studyId: z.string(), count: z.number() }),
    apply: (tx, { studyId, count }, ctx) => {
      for (let i = 0; i < count; i++) tx.put('cells', ctx.nextId(), { studyId, seed: ctx.seed })
    },
  },
  'cells.reject': {
    apply: (_tx, _args, ctx) => {
      ctx.nextId()
      ctx.nextId()
      throw new AppError('Nope', 'consumed two ids, then failed')
    },
  },
})

const app = defineApp({ version: 1, schema, mutators, crud: false })
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function counterSeeds() {
  let n = 0
  return () => `seed-${++n}`
}

describe('ctx.seed and ctx.nextId in the test engine', () => {
  it('mints the ids any run over the same seed would, and exposes the seed', () => {
    const engine = createTestEngine(app, { nextSeed: counterSeeds() })
    expect(engine.mutate('cells.materialize', { studyId: 's1', count: 3 }).error).toBeUndefined()
    const expected = createIdSource('seed-1')
    const ids = engine.list('cells').map((r) => r.id)
    expect(ids).toEqual([expected(), expected(), expected()])
    for (const id of ids) expect(id).toMatch(UUID_V4)
    expect(engine.list('cells').every((r) => r.data.seed === 'seed-1')).toBe(true)
  })

  it('gives consecutive mutations different seeds, so their ids never collide', () => {
    const engine = createTestEngine(app, { nextSeed: counterSeeds() })
    engine.mutate('cells.materialize', { studyId: 's1', count: 2 })
    engine.mutate('cells.materialize', { studyId: 's2', count: 2 })
    expect(new Set(engine.list('cells').map((r) => r.id)).size).toBe(4)
  })

  it('restarts the sequence per apply: a rejected mutation does not shift the next one', () => {
    const engine = createTestEngine(app, { nextSeed: counterSeeds() })
    expect(engine.mutate('cells.reject').error?.code).toBe('Nope')
    engine.mutate('cells.materialize', { studyId: 's1', count: 1 })
    expect(engine.list('cells').map((r) => r.id)).toEqual([createIdSource('seed-2')()])
  })

  it('defaults to a fresh random seed per mutation', () => {
    const engine = createTestEngine(app)
    engine.mutate('cells.materialize', { studyId: 's1', count: 1 })
    engine.mutate('cells.materialize', { studyId: 's1', count: 1 })
    const seeds = engine.list('cells').map((r) => r.data.seed)
    expect(seeds[0]).not.toBe(seeds[1])
  })
})
