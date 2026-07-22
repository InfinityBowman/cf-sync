import { describe, expect, it } from 'vitest'
import { OversizeItemError, chunkBySize, jsonByteSize } from '../src/chunk'

const sizeOf = (s: string) => s.length

describe('chunkBySize', () => {
  it('returns no chunks for no items', () => {
    expect(chunkBySize([], { maxBytes: 10, sizeOf })).toEqual([])
  })

  it('packs greedily under the byte budget', () => {
    const chunks = chunkBySize(['aaaa', 'bbbb', 'cccc'], { maxBytes: 9, sizeOf })
    expect(chunks).toEqual([['aaaa', 'bbbb'], ['cccc']])
  })

  it('respects maxItems independently of bytes', () => {
    const chunks = chunkBySize(['a', 'b', 'c'], { maxBytes: 100, maxItems: 2, sizeOf })
    expect(chunks).toEqual([['a', 'b'], ['c']])
  })

  it('a chunk may contain exactly one max-size item', () => {
    const chunks = chunkBySize(['aaaaa', 'b'], { maxBytes: 5, sizeOf })
    expect(chunks).toEqual([['aaaaa'], ['b']])
  })

  it('throws on a single item over budget', () => {
    expect(() => chunkBySize(['aaaaaa'], { maxBytes: 5, sizeOf })).toThrow(OversizeItemError)
  })

  it('jsonByteSize measures utf-8 encoded JSON', () => {
    expect(jsonByteSize('a')).toBe(3) // "a"
    expect(jsonByteSize({ a: 'é' })).toBe(new TextEncoder().encode('{"a":"é"}').length)
  })
})
