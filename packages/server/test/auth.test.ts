import { describe, expect, it } from 'vitest'
import { bearerTokenAuth } from '../src/index'

interface Env {
  ADMIN_TOKEN?: string
}

const authorize = bearerTokenAuth<Env>((env) => env.ADMIN_TOKEN)
const request = (authorization?: string) =>
  new Request('https://test/admin/w1/stats', {
    headers: authorization ? { authorization } : {},
  })

describe('bearerTokenAuth', () => {
  it('accepts exactly the configured token', () => {
    const env = { ADMIN_TOKEN: 'secret-token' }
    expect(authorize(request('Bearer secret-token'), { env })).toBe(true)
    expect(authorize(request('Bearer secret-tokeN'), { env })).toBe(false)
    expect(authorize(request('Bearer secret-token-longer'), { env })).toBe(false)
    expect(authorize(request('Bearer '), { env })).toBe(false)
  })

  it('rejects missing or non-bearer authorization headers', () => {
    const env = { ADMIN_TOKEN: 'secret-token' }
    expect(authorize(request(), { env })).toBe(false)
    expect(authorize(request('Basic secret-token'), { env })).toBe(false)
    expect(authorize(request('secret-token'), { env })).toBe(false)
  })

  it('fails closed when the secret is unset or empty', () => {
    expect(authorize(request('Bearer anything'), { env: {} })).toBe(false)
    expect(authorize(request('Bearer '), { env: { ADMIN_TOKEN: '' } })).toBe(false)
  })
})
