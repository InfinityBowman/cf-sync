import { serverMsgSchema } from '@cf-sync/protocol/internal'
import { describe, expect, it } from 'vitest'
import { CLEAR_OP, packPatch, pokeFrames, utf8ByteLength } from '../../src/frames'

const encoder = new TextEncoder()
const put = (id: string, value: unknown) => JSON.stringify({ op: 'put', tbl: 'todos', id, value })

describe('utf8ByteLength', () => {
  it('matches TextEncoder across ASCII, multi-byte, paired and lone surrogates', () => {
    for (const text of ['', 'plain ascii', 'café', 'naïve résumé', '日本語', '🙂 emoji', 'a\ud800b', 'end\udbff', '\udc00lead']) {
      expect(utf8ByteLength(text)).toBe(encoder.encode(text).length)
    }
  })
})

describe('packPatch', () => {
  it('keeps every part under the byte budget, counting multi-byte characters as bytes', () => {
    const ops = Array.from({ length: 200 }, (_, i) => put(`r${i}`, { title: 'é'.repeat(40) }))
    const { parts, counts, total } = packPatch(ops, 2_000)
    expect(total).toBe(200)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(200)
    for (const part of parts) expect(encoder.encode(`[${part}]`).length).toBeLessThanOrEqual(2_000 + 2)
    expect(parts.join(',')).toBe(ops.join(','))
  })

  it('always yields one part, empty when there are no ops', () => {
    expect(packPatch([])).toEqual({ parts: [''], counts: [0], total: 0 })
  })
})

describe('pokeFrames', () => {
  it('produces frames the client schema accepts, with settlement on the first part only', () => {
    const ops = [CLEAR_OP, ...Array.from({ length: 50 }, (_, i) => put(`r${i}`, { n: i, s: 'ü' }))]
    const frames = pokeFrames({
      pokeId: 'p1',
      baseCursor: null,
      patch: packPatch(ops, 600),
      lastMutationIdChanges: { c1: 3 },
      mutationResults: [{ id: 3 }],
      cursor: { backendId: 'b', version: 7 },
    })
    const msgs = frames.map((f) => serverMsgSchema.parse(JSON.parse(f)))
    expect(msgs[0]).toEqual({ type: 'pokeStart', pokeId: 'p1', baseCursor: null })
    expect(msgs.at(-1)).toEqual({ type: 'pokeEnd', pokeId: 'p1', cursor: { backendId: 'b', version: 7 }, pageInfo: { more: false } })
    const parts = msgs.slice(1, -1) as Array<Extract<(typeof msgs)[number], { type: 'pokePart' }>>
    expect(parts.length).toBeGreaterThan(1)
    expect(parts[0]!.lastMutationIdChanges).toEqual({ c1: 3 })
    expect(parts[0]!.mutationResults).toEqual([{ id: 3 }])
    expect(parts.slice(1).every((p) => p.lastMutationIdChanges === undefined && p.mutationResults === undefined)).toBe(true)
    expect(parts.flatMap((p) => p.patch)).toEqual(ops.map((op) => JSON.parse(op)))
    expect(parts.at(-1)!.remaining).toBe(0)
  })
})
