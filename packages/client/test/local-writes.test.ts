import { defineSchema } from '@cf-sync/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LocalWriteSet } from '../src/local-writes'
import type { TableApplier } from '../src/types'

// The client's LocalWriteSet answers `list(tbl, { where })` exactly as the
// server's WriteSet does (packages/server/test/node/list-where.test.ts runs
// the same cases through the engine): overlay first, `===` comparisons.

const schema = defineSchema({
  checklists: z.object({
    studyId: z.string(),
    assignedTo: z.string().nullable(),
    done: z.boolean().default(false),
    priority: z.number().default(1),
  }),
})

function mapApplier(rows: Record<string, Record<string, unknown>>): TableApplier {
  const map = new Map(Object.entries(rows))
  return {
    has: (id) => map.has(id),
    get: (id) => map.get(id) ?? null,
    list: () => [...map].map(([id, data]) => ({ id, data })),
    insert: (data) => map.set(String(data.id), data),
    update: (id, data) => map.set(id, data),
    delete: (id) => map.delete(id),
  }
}

function writes() {
  const appliers = new Map<string, TableApplier>([
    [
      'checklists',
      mapApplier({
        c1: { studyId: 's1', assignedTo: 'u1', done: true, priority: 1 },
        c2: { studyId: 's1', assignedTo: 'u2', done: false, priority: 2 },
        c3: { studyId: 's2', assignedTo: 'u1', done: false, priority: 1 },
        c4: { studyId: 's2', assignedTo: null, done: false, priority: 1 },
      }),
    ],
  ])
  return new LocalWriteSet(schema, appliers)
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id)

describe('LocalWriteSet list where', () => {
  it('filters on one or several fields with strict equality', () => {
    const { tx } = writes()
    expect(ids(tx.list('checklists', { where: { studyId: 's1' } }))).toEqual(['c1', 'c2'])
    expect(ids(tx.list('checklists', { where: { studyId: 's1', assignedTo: 'u1' } }))).toEqual(['c1'])
    expect(ids(tx.list('checklists', { where: { done: true } }))).toEqual(['c1'])
    expect(ids(tx.list('checklists', { where: { assignedTo: null } }))).toEqual(['c4'])
    expect(ids(tx.list('checklists', { where: { priority: 1, done: false } }))).toEqual(['c3', 'c4'])
    expect(ids(tx.list('checklists', { where: { studyId: 'nope' } }))).toEqual([])
    expect(ids(tx.list('checklists', { where: {} }))).toEqual(['c1', 'c2', 'c3', 'c4'])
  })

  it('sees its own buffered writes and excludes deleted rows', () => {
    const { tx } = writes()
    tx.put('checklists', 'new', { studyId: 's1', assignedTo: 'u1' })
    tx.put('checklists', 'c1', { ...tx.get('checklists', 'c1')!, studyId: 's2' })
    tx.del('checklists', 'c2')
    expect(ids(tx.list('checklists', { where: { studyId: 's1' } }))).toEqual(['new'])
    expect(ids(tx.list('checklists', { where: { studyId: 's2' } }))).toEqual(['c3', 'c4', 'c1'])
  })

  it('returns private copies', () => {
    const { tx } = writes()
    const [row] = tx.list('checklists', { where: { studyId: 's1' } })
    row!.data.studyId = 'mutated'
    expect(tx.get('checklists', 'c1')!.studyId).toBe('s1')
  })

  it('rejects a non-scalar filter value as InvalidArgs', () => {
    const { tx } = writes()
    expect(() => tx.list('checklists', { where: { assignedTo: ['u1'] as never } })).toThrow(/InvalidArgs|string, number/)
  })
})
