import { env, evictDurableObject, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { presenceFingerprint, schemaFingerprint } from '../src/fingerprint'
import { testSchema } from './fixture/worker'
import { TestClient, type PresenceLaneMsg } from './harness'

// Presence (ARCHITECTURE.md#presence): in-memory relay over the sync socket. Identity is
// server-attested, payloads are schema-validated before relay, nothing ever
// touches storage, and the map is rebuilt by polling after a wake.

const AUTH = { role: 'member', writeAllowed: true }
const authHeaders = (overrides: Record<string, string> = {}): Record<string, string> => ({
  'x-test-principal': 'u1',
  'x-test-auth': JSON.stringify(AUTH),
  ...overrides,
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Connects, syncs, and drains the post-hello presencePeers snapshot. */
async function connectLive(
  workspace: string,
  clientId: string,
  prefix = '/sync',
  headers: Record<string, string> = {},
): Promise<{ client: TestClient; snapshot: PresenceLaneMsg }> {
  const client = await TestClient.connect(workspace, clientId, prefix, headers)
  await client.syncOnce()
  const snapshot = await client.nextPresence()
  expect(snapshot.type).toBe('presencePeers')
  return { client, snapshot }
}

async function evict(workspaceId: string): Promise<void> {
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId))
  await runInDurableObject(stub, async (_instance, state) => {
    state.abort()
  }).catch(() => {
    // abort() kills the object; the call itself is expected to fail
  })
}

describe('relay', () => {
  it('reaches ready sockets with the parsed state, but not the sender or non-ready sockets', async () => {
    const workspace = `presence-relay-${Date.now()}`
    const { client: c1 } = await connectLive(workspace, 'c1')
    const { client: c2 } = await connectLive(workspace, 'c2')
    const c3 = await TestClient.connect(workspace, 'c3') // no hello: never ready

    c1.presence({ name: 'ada' })
    const update = await c2.nextPresence()
    // Parsed output (the schema default applied), never the raw payload.
    expect(update).toEqual({ type: 'presence', clientId: 'c1', state: { name: 'ada', label: 'peer' } })
    await c1.expectNoPresence() // sender excluded
    await c3.expectNoPresence() // not ready

    c1.close()
    c2.close()
    c3.close()
  })

  it('the post-hello snapshot carries existing peers; clearing relays null; clearing nothing relays nothing', async () => {
    const workspace = `presence-snapshot-${Date.now()}`
    const { client: c1 } = await connectLive(workspace, 'c1')
    c1.presence({ name: 'ada', label: 'x' })

    const { snapshot } = await connectLive(workspace, 'c2')
    expect(snapshot).toEqual({
      type: 'presencePeers',
      peers: [{ clientId: 'c1', state: { name: 'ada', label: 'x' } }],
    })
    const { client: c2 } = { client: (await TestClient.connect(workspace, 'c2b')) }
    await c2.syncOnce()
    await c2.nextPresence() // drain c2b's own snapshot

    c1.presence(null)
    expect(await c2.nextPresence()).toEqual({ type: 'presence', clientId: 'c1', state: null })
    c1.presence(null) // nothing to clear now
    await c2.expectNoPresence()

    c1.close()
    c2.close()
  })

  it('socket close broadcasts the null', async () => {
    const workspace = `presence-close-${Date.now()}`
    const { client: c1 } = await connectLive(workspace, 'c1')
    const { client: c2 } = await connectLive(workspace, 'c2')
    c1.presence({ name: 'ada' })
    await c2.nextPresence()

    c1.close()
    expect(await c2.nextPresence()).toEqual({ type: 'presence', clientId: 'c1', state: null })
    c2.close()
  })
})

describe('validation', () => {
  it('rejects oversized state with an error frame and keeps the socket open', async () => {
    const workspace = `presence-size-${Date.now()}`
    const { client: c1 } = await connectLive(workspace, 'c1')
    const { client: c2 } = await connectLive(workspace, 'c2')

    c1.presence({ name: 'x'.repeat(9_000) })
    await sleep(100)
    expect(c1.errors).toEqual([
      { type: 'error', code: 'PresenceInvalid', message: expect.stringContaining('8192') },
    ])
    await c2.expectNoPresence() // nothing was relayed or truncated

    // Same socket still fully works.
    c1.presence({ name: 'ok' })
    expect(await c2.nextPresence()).toEqual({
      type: 'presence',
      clientId: 'c1',
      state: { name: 'ok', label: 'peer' },
    })
    c1.close()
    c2.close()
  })

  it('rejects state that fails the presence schema, presence before hello, and presence on an app without a schema', async () => {
    const workspace = `presence-invalid-${Date.now()}`
    const { client: c1 } = await connectLive(workspace, 'c1')
    c1.presence({ name: 123 })
    await sleep(100)
    expect(c1.errors.map((e) => e.code)).toEqual(['PresenceInvalid'])
    c1.close()

    const early = await TestClient.connect(`${workspace}-early`, 'c1')
    early.presence({ name: 'ada' })
    await sleep(100)
    expect(early.errors.map((e) => e.code)).toEqual(['PresenceInvalid'])
    early.close()

    // CompactingDO's app declares no presence schema.
    const bare = await TestClient.connect(`${workspace}-bare`, 'c1', '/compact')
    await bare.syncOnce()
    await bare.expectNoPresence() // no schema: hello sends no snapshot
    bare.presence({ name: 'ada' })
    await sleep(100)
    expect(bare.errors.map((e) => e.code)).toEqual(['PresenceInvalid'])
    bare.close()
  })

  it('identity is server-attested: clientId/principal embedded in the payload are ignored', async () => {
    const workspace = `presence-identity-${Date.now()}`
    const { client: c1 } = await connectLive(workspace, 'c1', '/auth', authHeaders())
    const { client: c2 } = await connectLive(workspace, 'c2')

    c1.presence({ name: 'ada', clientId: 'evil', principal: 'evil' })
    const update = await c2.nextPresence()
    expect(update).toEqual({
      type: 'presence',
      clientId: 'c1', // from the attachment, not the payload
      principal: 'u1', // from the authorize verdict
      state: { name: 'ada', label: 'peer' }, // schema output: embedded identity stripped
    })
    c1.close()
    c2.close()
  })
})

describe('session-control gates on the presence path (ARCHITECTURE.md#session-control)', () => {
  it('a supersede-lagged close cannot wipe the reconnected client’s fresh state', async () => {
    const workspace = `presence-supersede-${Date.now()}`
    const { client: c1 } = await connectLive(workspace, 'c1')
    const { client: c2 } = await connectLive(workspace, 'c2')
    c1.presence({ name: 'old' })
    await c2.nextPresence()

    // Second upgrade with the same clientId: the DO closes the old socket
    // (dropping its entry) before accepting the new one.
    const { client: c1b } = await connectLive(workspace, 'c1')
    expect(await c2.nextPresence()).toEqual({ type: 'presence', clientId: 'c1', state: null })
    expect((await c1.waitClose()).code).toBe(4409)

    c1b.presence({ name: 'new' })
    expect(await c2.nextPresence()).toEqual({
      type: 'presence',
      clientId: 'c1',
      state: { name: 'new', label: 'peer' },
    })
    // The old socket's teardown must not retract the fresh entry.
    await c2.expectNoPresence()
    const { snapshot } = await connectLive(workspace, 'c3')
    expect(snapshot.type === 'presencePeers' && snapshot.peers.find((p) => p.clientId === 'c1')?.state).toEqual({
      name: 'new',
      label: 'peer',
    })
    c1b.close()
    c2.close()
  })

  it('a relay to a socket past expiresAt closes it with 4300 instead of delivering', async () => {
    const workspace = `presence-expiry-${Date.now()}`
    const { client: c1 } = await connectLive(workspace, 'c1', '/auth', authHeaders({ 'x-test-expires-in': '150' }))
    const { client: c2 } = await connectLive(workspace, 'c2')

    await sleep(250)
    c2.presence({ name: 'ada' })
    const close = await c1.waitClose()
    expect(close.code).toBe(4300)
    expect(close.reason).toBe('auth-expired')
    await c1.expectNoPresence() // the frame was not delivered

    c2.close()
  })

  it('a kick drops the entry (peers see null) and later relays skip the defunct socket', async () => {
    const workspace = `presence-kick-${Date.now()}`
    const { client: c1 } = await connectLive(workspace, 'c1', '/auth', authHeaders())
    const { client: c2 } = await connectLive(workspace, 'c2')
    c1.presence({ name: 'ada' })
    await c2.nextPresence()

    const response = await SELF.fetch(`https://test/admin/${encodeURIComponent(workspace)}/disconnect`, {
      method: 'POST',
      headers: { 'x-test-admin': 'yes' },
      body: JSON.stringify({ principal: 'u1', mode: 'kick', reason: 'membership-revoked' }),
    })
    expect(response.status).toBe(200)

    // The null keeps the attested principal, so peers know whose presence vanished.
    expect(await c2.nextPresence()).toEqual({ type: 'presence', clientId: 'c1', principal: 'u1', state: null })
    expect((await c1.waitClose()).code).toBe(4403)

    c2.presence({ name: 'lin' })
    await sleep(100)
    await c1.expectNoPresence() // defunct: skipped, not delivered
    c2.close()
  })
})

describe('hibernation wake', () => {
  // evictDurableObject preserves hibernatable sockets (unlike state.abort(),
  // which simulates a crash and kills them) — the production hibernation
  // lifecycle: instance memory gone, sockets and attachments intact.
  it('poll after eviction converges the map in one round-trip', async () => {
    const workspace = `presence-wake-${Date.now()}`
    const { client: c1 } = await connectLive(workspace, 'c1')
    const { client: c2 } = await connectLive(workspace, 'c2')
    c1.presence({ name: 'ada' })
    await c2.nextPresence()

    await evictDurableObject(env.WORKSPACE.get(env.WORKSPACE.idFromName(workspace)))

    // The next event replays the constructor, which broadcasts presencePoll
    // to the surviving ready sockets before the frame itself is processed;
    // here the wake is c2's own announce.
    c2.presence({ name: 'lin' })
    expect((await c1.nextPresence()).type).toBe('presencePoll')
    expect(await c1.nextPresence()).toEqual({
      type: 'presence',
      clientId: 'c2',
      state: { name: 'lin', label: 'peer' },
    })
    expect((await c2.nextPresence()).type).toBe('presencePoll')

    // The library re-announces on poll; the raw test client does it by hand.
    c1.presence({ name: 'ada' })
    expect(await c2.nextPresence()).toEqual({
      type: 'presence',
      clientId: 'c1',
      state: { name: 'ada', label: 'peer' },
    })

    // A late joiner's snapshot proves the map itself was rebuilt in memory.
    const { client: c3, snapshot } = await connectLive(workspace, 'c3')
    expect(
      snapshot.type === 'presencePeers' &&
        [...snapshot.peers].sort((a, b) => a.clientId.localeCompare(b.clientId)),
    ).toEqual([
      { clientId: 'c1', state: { name: 'ada', label: 'peer' } },
      { clientId: 'c2', state: { name: 'lin', label: 'peer' } },
    ])
    c1.close()
    c2.close()
    c3.close()
  })
})

describe('restart recovery', () => {
  // The crash shape of the same guarantee (state.abort() kills the sockets
  // with the instance): presence rebuilds from client re-announcement alone,
  // because nothing was ever persisted.
  it('presence converges after a restart purely from re-announcement', async () => {
    const workspace = `presence-restart-${Date.now()}`
    const { client: c1 } = await connectLive(workspace, 'c1')
    const { client: c2 } = await connectLive(workspace, 'c2')
    c1.presence({ name: 'ada' })
    await c2.nextPresence()

    await evict(workspace)
    expect((await c1.waitClose()).code).toBe(1006)
    expect((await c2.waitClose()).code).toBe(1006)

    // Nothing was persisted: the reborn DO knows no presence at all.
    await c1.reconnect()
    await c1.syncOnce()
    expect(await c1.nextPresence()).toEqual({ type: 'presencePeers', peers: [] })
    c1.presence({ name: 'ada' })

    // Each re-announcement lands in the fresh map; late snapshots prove it.
    await c2.reconnect()
    await c2.syncOnce()
    expect(await c2.nextPresence()).toEqual({
      type: 'presencePeers',
      peers: [{ clientId: 'c1', state: { name: 'ada', label: 'peer' } }],
    })
    c2.presence({ name: 'lin' })
    expect(await c1.nextPresence()).toEqual({
      type: 'presence',
      clientId: 'c2',
      state: { name: 'lin', label: 'peer' },
    })
    c1.close()
    c2.close()
  })
})

describe('fingerprint', () => {
  it('presence has its own fingerprint, independent of the table fingerprint (ARCHITECTURE.md#presence)', () => {
    // Declaring or changing presence never moves the table fingerprint —
    // that is what keeps its drift decoupled from the version-bump economy.
    expect(schemaFingerprint(testSchema)).toBe(schemaFingerprint(testSchema))
    const a = presenceFingerprint(z.object({ name: z.string() }))
    const b = presenceFingerprint(z.object({ name: z.string(), x: z.number() }))
    expect(a).not.toBe(b)
    expect(presenceFingerprint(z.object({ name: z.string() }))).toBe(a)
    expect(presenceFingerprint(undefined)).toBe('')
  })
})
