import { describe, expect, it } from 'vitest'
import { patchOpSchema } from '../src/internal'

describe('patchOpSchema', () => {
  it('passes a put value through by reference, with no copy', () => {
    const value = { title: 'x', nested: { n: 1 } }
    const parsed = patchOpSchema.parse({ op: 'put', tbl: 'todos', id: 't1', value })
    expect(parsed).toEqual({ op: 'put', tbl: 'todos', id: 't1', value })
    expect((parsed as { value: unknown }).value).toBe(value)
  })

  it('rejects put values that are not objects', () => {
    for (const value of [null, [], 'x', 1, true, undefined]) {
      expect(patchOpSchema.safeParse({ op: 'put', tbl: 'todos', id: 't1', value }).success).toBe(false)
    }
  })
})
