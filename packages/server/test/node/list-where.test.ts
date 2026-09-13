import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestEngine, crudMutators, defineApp, defineMutators, defineSchema } from '../../src/testing'

// `tx.list(tbl, { where })` is the same read as an unfiltered list plus the
// predicate: it sees the mutation's own buffered writes (a put can make a row
// start or stop matching), never a deleted row, and compares with `===`.

const schema = defineSchema({
  checklists: z.object({
    studyId: z.string(),
    assignedTo: z.string().nullable(),
    done: z.boolean().default(false),
    priority: z.number().default(1),
  }),
  echo: z.object({ ids: z.array(z.string()) }),
})

const mutators = defineMutators(schema, {
  ...crudMutators(schema),
  'echo.where': {
    args: z.object({ into: z.string(), where: z.record(z.string(), z.unknown()) }),
    apply: (tx, { into, where }) => {
      tx.put('echo', into, { ids: tx.list('checklists', { where: where as never }).map((r) => r.id) })
    },
  },
  'scan.withOverlay': {
    args: z.object({ into: z.string() }),
    apply: (tx, { into }) => {
      tx.put('checklists', 'new', { studyId: 's1', assignedTo: 'u1' }) // buffered, matches
      const row = tx.get('checklists', 'c1')!
      tx.put('checklists', 'c1', { ...row, studyId: 's2' }) // stored match rewritten away
      tx.del('checklists', 'c2') // stored match deleted
      tx.put('echo', into, { ids: tx.list('checklists', { where: { studyId: 's1' } }).map((r) => r.id) })
    },
  },
})

const app = defineApp({ version: 1, schema, mutators })

function engineWithRows() {
  return createTestEngine(app, {
    rows: {
      checklists: {
        c1: { studyId: 's1', assignedTo: 'u1', done: true, priority: 1 },
        c2: { studyId: 's1', assignedTo: 'u2', done: false, priority: 2 },
        c3: { studyId: 's2', assignedTo: 'u1', done: false, priority: 1 },
        c4: { studyId: 's2', assignedTo: null, done: false, priority: 1 },
      },
    },
  })
}

function echoed(engine: ReturnType<typeof engineWithRows>, where: Record<string, unknown>): string[] {
  const result = engine.mutate('echo.where', { into: 'out', where })
  expect(result.error).toBeUndefined()
  return engine.get('echo', 'out')!.ids
}

describe('tx.list where', () => {
  it('filters on one or several fields with strict equality', () => {
    const engine = engineWithRows()
    expect(echoed(engine, { studyId: 's1' })).toEqual(['c1', 'c2'])
    expect(echoed(engine, { studyId: 's1', assignedTo: 'u1' })).toEqual(['c1'])
    expect(echoed(engine, { done: true })).toEqual(['c1'])
    expect(echoed(engine, { assignedTo: null })).toEqual(['c4'])
    expect(echoed(engine, { priority: 1, done: false })).toEqual(['c3', 'c4'])
    expect(echoed(engine, { studyId: 'nope' })).toEqual([])
  })

  it('agrees with the unfiltered list after filtering', () => {
    const engine = engineWithRows()
    const all = engine.list('checklists').filter((r) => r.data.studyId === 's2').map((r) => r.id)
    expect(echoed(engine, { studyId: 's2' })).toEqual(all)
  })

  it('sees the mutation\'s own buffered writes and excludes deleted rows', () => {
    const engine = engineWithRows()
    const result = engine.mutate('scan.withOverlay', { into: 'out' })
    expect(result.error).toBeUndefined()
    // c1 was rewritten to s2, c2 deleted, `new` buffered in: only `new` is left under s1.
    expect(engine.get('echo', 'out')!.ids).toEqual(['new'])
  })

  it('rejects a non-scalar filter value permanently', () => {
    const engine = engineWithRows()
    const result = engine.mutate('echo.where', { into: 'out', where: { assignedTo: ['u1'] } })
    expect(result.error?.code).toBe('InvalidArgs')
    expect(engine.get('echo', 'out')).toBeNull()
  })
})
