import { describe, expect, it } from 'vitest'
import { createAdminRoute, createSyncRoute } from '../src/worker'

// The composable-route contract: null strictly means "not my traffic, keep
// routing"; anything that IS this route's traffic gets a real Response.
// (The namespace accessor throws if touched — proving unmatched requests
// never reach the DO.)
const untouchable = () => {
  throw new Error('namespace resolved for a request the route should have passed on')
}

describe('createSyncRoute', () => {
  const route = createSyncRoute({ namespace: untouchable })

  it('passes on paths outside its prefix, including bare and nested ones', async () => {
    for (const path of ['/', '/other', '/syncx/ws', '/sync', '/sync/', '/sync/ws/extra']) {
      expect(await route(new Request(`https://w${path}`), {})).toBeNull()
    }
  })

  it('answers its own malformed traffic instead of passing it on', async () => {
    // Matched path, no websocket upgrade: 426 is this route's answer.
    const sync = createSyncRoute({ namespace: untouchable })
    const res = await sync(new Request('https://w/sync/ws1'), {})
    expect(res?.status).toBe(426)
  })
})

describe('createAdminRoute', () => {
  const route = createAdminRoute({ namespace: untouchable, authorize: () => true })

  it('passes on non-admin paths and unknown ops', async () => {
    for (const path of ['/', '/adminx/ws/stats', '/admin', '/admin/ws', '/admin/ws/nope', '/admin/ws/stats/extra']) {
      expect(await route(new Request(`https://w${path}`), {})).toBeNull()
    }
  })

  it('answers its own traffic: wrong method is 405, denied authorize is 403', async () => {
    const denied = createAdminRoute({ namespace: untouchable, authorize: () => false })
    expect((await route(new Request('https://w/admin/ws/stats', { method: 'POST' }), {}))?.status).toBe(405)
    expect((await denied(new Request('https://w/admin/ws/reset', { method: 'POST' }), {}))?.status).toBe(403)
  })
})
