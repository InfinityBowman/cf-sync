import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { decodeAuthStamps, encodeAuthStamps, workspaceAdmin } from '../src/index'
import { TestClient } from './harness'

// Session control (ARCHITECTURE.md#session-control): verdict stamps ride the connection, kick
// and refresh close live sockets, expiry gates both writes (inbound frames)
// and reads (poke fan-out), and the supersede rule makes newest-socket-wins.

const AUTH = { role: 'member', writeAllowed: true }
const authHeaders = (overrides: Record<string, string> = {}): Record<string, string> => ({
  'x-test-principal': 'u1',
  'x-test-auth': JSON.stringify(AUTH),
  ...overrides,
})

async function adminDisconnect(workspace: string, body: unknown): Promise<{ disconnected: number }> {
  const response = await SELF.fetch(`https://test/admin/${encodeURIComponent(workspace)}/disconnect`, {
    method: 'POST',
    headers: { 'x-test-admin': 'yes' },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return response.json()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('verdict stamps', () => {
  it('mutators see principal, validated auth context, and authoritative: true', async () => {
    const workspace = `sc-stamps-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', authHeaders())
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'ctx.echo', args: { id: 'echo' } }])
    await c1.pokeUntilLmid(1)
    expect(c1.rows.get('todos/echo')).toEqual({ principal: 'u1', auth: AUTH, authoritative: true })
    c1.close()
  })

  it('a route with no authorize hook stamps nothing', async () => {
    const workspace = `sc-nostamps-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'ctx.echo', args: { id: 'echo' } }])
    await c1.pokeUntilLmid(1)
    expect(c1.rows.get('todos/echo')).toEqual({ principal: null, auth: null, authoritative: true })
    c1.close()
  })

  it('a spoofed x-cf-sync-auth header from outside is stripped', async () => {
    const workspace = `sc-spoof-${Date.now()}`
    const spoofed = encodeAuthStamps({ principal: 'evil', context: { role: 'owner', writeAllowed: true } })
    const c1 = await TestClient.connect(workspace, 'c1', '/sync', { 'x-cf-sync-auth': spoofed })
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'ctx.echo', args: { id: 'echo' } }])
    await c1.pokeUntilLmid(1)
    expect(c1.rows.get('todos/echo')).toEqual({ principal: null, auth: null, authoritative: true })
    c1.close()
  })

  it('auth stamps are stored in the socket attachment (the hibernation-surviving seat)', async () => {
    const workspace = `sc-attach-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', authHeaders())
    await c1.syncOnce()
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspace))
    await runInDurableObject(stub, async (_instance, state) => {
      const attachments = state.getWebSockets().map((ws) => ws.deserializeAttachment() as Record<string, unknown>)
      expect(attachments).toEqual([
        expect.objectContaining({ clientId: 'c1', ready: true, principal: 'u1', auth: AUTH }),
      ])
    })
    c1.close()
  })

  it('stamps survive DO eviction: a reconnect re-runs authorize and re-stamps', async () => {
    const workspace = `sc-evict-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', authHeaders())
    await c1.syncOnce()
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspace))
    await runInDurableObject(stub, async (_instance, state) => {
      state.abort()
    }).catch(() => {
      // abort() kills the object; the call itself is expected to fail
    })
    await c1.reconnect()
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'ctx.echo', args: { id: 'echo' } }])
    await c1.pokeUntilLmid(1)
    expect(c1.rows.get('todos/echo')).toEqual({ principal: 'u1', auth: AUTH, authoritative: true })
    c1.close()
  })
})

describe('rejection delivery', () => {
  it('a structured rejection completes the upgrade and closes with the code and reason', async () => {
    const workspace = `sc-reject-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', { 'x-test-reject': '4403:membership-revoked' })
    expect(await c1.waitClose()).toEqual({ code: 4403, reason: 'membership-revoked' })
  })

  it('a bare rejection defaults to 4403 unauthorized', async () => {
    const workspace = `sc-reject-default-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', { 'x-test-reject': ':' })
    expect(await c1.waitClose()).toEqual({ code: 4403, reason: 'unauthorized' })
  })

  it('a boolean false still rejects with HTTP 403 (non-browser callers)', async () => {
    const workspace = `sc-deny-${Date.now()}`
    await expect(TestClient.connect(workspace, 'c1', '/auth', { 'x-test-deny': '1' })).rejects.toThrow(
      'upgrade failed: 403',
    )
  })

  it('context that fails the authContext schema closes with 4401 at connect', async () => {
    const workspace = `sc-drift-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', {
      'x-test-principal': 'u1',
      'x-test-auth': JSON.stringify({ role: 'member' }), // writeAllowed missing
    })
    const close = await c1.waitClose()
    expect(close.code).toBe(4401)
    expect(close.reason).toContain('writeAllowed')
  })

  it('a verdict that stamps no context at all is the same drift bug', async () => {
    const workspace = `sc-drift-empty-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', { 'x-test-principal': 'u1' })
    expect((await c1.waitClose()).code).toBe(4401)
  })

  it('an oversized auth context fails the upgrade instead of truncating', async () => {
    const workspace = `sc-oversize-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', {
      'x-test-principal': 'u1',
      'x-test-auth': JSON.stringify({ role: 'x'.repeat(3000), writeAllowed: true }),
    })
    const close = await c1.waitClose()
    expect(close.code).toBe(4401)
    expect(close.reason).toContain('attachment budget')
  })
})

describe('disconnect: kick and refresh', () => {
  it('kick closes only matching sockets, with the code and reason', async () => {
    const workspace = `sc-kick-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', authHeaders())
    const c2 = await TestClient.connect(workspace, 'c2', '/auth', authHeaders({ 'x-test-principal': 'u2' }))
    await c1.syncOnce()
    await c2.syncOnce()

    const result = await adminDisconnect(workspace, {
      principal: 'u1',
      mode: 'kick',
      reason: 'membership-revoked',
    })
    expect(result).toEqual({ disconnected: 1 })
    expect(await c1.waitClose()).toEqual({ code: 4403, reason: 'membership-revoked' })

    // The survivor still syncs.
    c2.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { n: 1 } } }])
    await c2.pokeUntilLmid(1)
    expect(c2.closeEvent).toBeNull()
    c2.close()
  })

  it("a kicked client's queued push never lands", async () => {
    const workspace = `sc-kick-push-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', authHeaders())
    await c1.syncOnce()
    await adminDisconnect(workspace, { clientId: 'c1' })
    await c1.waitClose()
    try {
      c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 'ghost', data: {} } }])
    } catch {
      // sending on a closed socket may throw locally — either way it must not land
    }
    await sleep(150)

    const c2 = await TestClient.connect(workspace, 'c2')
    const boot = await c2.syncOnce()
    expect(c2.rows.has('todos/ghost')).toBe(false)
    expect(boot.lastMutationIdChanges.c1).toBeUndefined() // c1's LMID never advanced past hello
    c2.close()
  })

  it('refresh closes with 4300 and the reconnect observes fresh stamps', async () => {
    const workspace = `sc-refresh-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', authHeaders())
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'ctx.echo', args: { id: 'echo' } }])
    await c1.pokeUntilLmid(1)
    expect((c1.rows.get('todos/echo') as { auth: typeof AUTH }).auth.writeAllowed).toBe(true)

    // Entitlement changes out of band; the webhook refreshes the workspace.
    const result = await adminDisconnect(workspace, { mode: 'refresh' })
    expect(result).toEqual({ disconnected: 1 })
    expect(await c1.waitClose()).toEqual({ code: 4300, reason: 'refresh' })

    // The reconnect re-runs authorize, now returning different stamps.
    c1.headers['x-test-auth'] = JSON.stringify({ role: 'member', writeAllowed: false })
    await c1.reconnect()
    await c1.syncOnce()
    c1.push([{ id: 2, name: 'ctx.echo', args: { id: 'echo' } }])
    await c1.pokeUntilLmid(2)
    expect(c1.rows.get('todos/echo')).toEqual({
      principal: 'u1',
      auth: { role: 'member', writeAllowed: false },
      authoritative: true,
    })
    c1.close()
  })

  it('workspaceAdmin drives the same ops from worker code', async () => {
    const workspace = `sc-admin-helper-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', authHeaders())
    await c1.syncOnce()

    const admin = workspaceAdmin(env.WORKSPACE, workspace)
    const stats = await admin.stats()
    expect(stats.connections).toMatchObject({ total: 1, ready: 1 })

    const result = await admin.disconnect({ principal: 'u1', mode: 'kick', reason: 'membership-revoked' })
    expect(result).toEqual({ disconnected: 1 })
    expect(await c1.waitClose()).toEqual({ code: 4403, reason: 'membership-revoked' })
  })
})

describe('expiry (expiresAt)', () => {
  it('a frame after expiresAt gets 4300 and the reconnect carries fresh stamps', async () => {
    const workspace = `sc-expire-write-${Date.now()}`
    const c1 = await TestClient.connect(workspace, 'c1', '/auth', authHeaders({ 'x-test-expires-in': '150' }))
    await c1.syncOnce()
    await sleep(250)

    c1.push([{ id: 1, name: 'ctx.echo', args: { id: 'late' } }])
    expect(await c1.waitClose()).toEqual({ code: 4300, reason: 'auth-expired' })

    // Reconnect = fresh authorize run = fresh deadline; the write now lands.
    await c1.reconnect()
    await c1.syncOnce()
    expect(c1.rows.has('todos/late')).toBe(false) // the expired frame was never processed
    c1.push([{ id: 1, name: 'ctx.echo', args: { id: 'late' } }])
    await c1.pokeUntilLmid(1)
    expect(c1.rows.get('todos/late')).toMatchObject({ principal: 'u1' })
    c1.close()
  })

  it('a relay to a socket past expiresAt closes it instead of delivering', async () => {
    const workspace = `sc-expire-read-${Date.now()}`
    const reader = await TestClient.connect(workspace, 'reader', '/auth', authHeaders({ 'x-test-expires-in': '200' }))
    await reader.syncOnce()
    const writer = await TestClient.connect(workspace, 'writer', '/auth', authHeaders({ 'x-test-principal': 'u2' }))
    await writer.syncOnce()
    await sleep(300)

    // The passive reader sends nothing; the fan-out is where its expiry bites.
    writer.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { n: 1 } } }])
    await writer.pokeUntilLmid(1)

    expect(await reader.waitClose()).toEqual({ code: 4300, reason: 'auth-expired' })
    await reader.expectNoMessage() // the poke was withheld, not delivered then closed
    expect(reader.rows.has('todos/t1')).toBe(false)
    writer.close()
  })
})

describe('supersede rule', () => {
  it('a second upgrade with the same clientId closes the first socket', async () => {
    const workspace = `sc-supersede-${Date.now()}`
    const zombie = await TestClient.connect(workspace, 'c1', '/auth', authHeaders())
    await zombie.syncOnce()

    const fresh = await TestClient.connect(workspace, 'c1', '/auth', authHeaders())
    expect(await zombie.waitClose()).toEqual({ code: 4409, reason: 'superseded' })
    await fresh.syncOnce()

    // A late frame from the superseded socket is never processed.
    try {
      zombie.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 'stale', data: {} } }])
    } catch {
      // closed socket may throw locally
    }
    await sleep(150)
    fresh.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 'fresh', data: {} } }])
    await fresh.pokeUntilLmid(1)
    expect(fresh.rows.has('todos/stale')).toBe(false)
    expect(fresh.rows.has('todos/fresh')).toBe(true)
    fresh.close()
  })
})

describe('auth stamp codec', () => {
  it('round-trips principals and contexts with any characters', () => {
    const stamps = {
      principal: 'user-π-⚡',
      context: { role: 'member', note: '日本語 "quotes" \\ backslash' },
      expiresAt: 1_753_000_000_000,
    }
    expect(decodeAuthStamps(encodeAuthStamps(stamps))).toEqual(stamps)
  })

  it('rejects garbage', () => {
    expect(() => decodeAuthStamps('not-base64!!')).toThrow()
    expect(() => decodeAuthStamps(btoa('"a string"'))).toThrow()
  })
})
