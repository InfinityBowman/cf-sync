import { describe, expect, it } from 'vitest'
import { createIdSource, mintSeed } from '../src/ids'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('createIdSource', () => {
  it('is a pure function of the seed, call by call', () => {
    const a = createIdSource('seed-1')
    const b = createIdSource('seed-1')
    const first = Array.from({ length: 5 }, () => a())
    expect(Array.from({ length: 5 }, () => b())).toEqual(first)
    expect(new Set(first).size).toBe(5)
  })

  it('emits UUID-v4-shaped ids that differ across seeds', () => {
    const one = createIdSource('seed-1')()
    const two = createIdSource('seed-2')()
    expect(one).toMatch(UUID_V4)
    expect(two).toMatch(UUID_V4)
    expect(one).not.toBe(two)
  })

  it('is stable across releases: a pinned seed yields pinned ids', () => {
    // Changing this breaks agreement between a client bundle and a server
    // that shipped different protocol builds — bump PROTOCOL_VERSION.
    const next = createIdSource('cf-sync')
    expect([next(), next()]).toEqual([
      'af2d5718-5870-4c5c-b6fd-d77110fee8b3',
      'ca854afe-f0b8-43b2-a17b-1b65289e701b',
    ])
  })

  it('mintSeed produces distinct seeds', () => {
    expect(mintSeed()).not.toBe(mintSeed())
  })
})
