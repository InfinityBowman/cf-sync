import { describe, expect, it } from 'vitest'
import { isSilent, SILENT_MS } from '../../src/silent'

describe('isSilent', () => {
  const now = 1_000_000

  it('closes a socket whose last ping is older than SILENT_MS', () => {
    expect(isSilent({ lastPing: now - SILENT_MS - 1, acceptedAt: now - 10 * SILENT_MS }, now)).toBe(true)
    expect(isSilent({ lastPing: now - SILENT_MS, acceptedAt: now - 10 * SILENT_MS }, now)).toBe(false)
  })

  it('counts from the accept for a socket that never pinged', () => {
    expect(isSilent({ lastPing: null, acceptedAt: now - SILENT_MS - 1 }, now)).toBe(true)
    expect(isSilent({ lastPing: null, acceptedAt: now - 1_000 }, now)).toBe(false)
  })

  it('keeps a socket from older code it knows nothing about', () => {
    expect(isSilent({ lastPing: null, acceptedAt: undefined }, now)).toBe(false)
  })
})
