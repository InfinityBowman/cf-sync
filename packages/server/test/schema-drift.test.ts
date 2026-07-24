import { env, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { schemaFingerprint } from '../src/fingerprint'
import { crudMutators, defineApp, defineSchema, type AnySyncSchema } from '../src/index'
import { rolloutApp, rolloutConfig, testSchema } from './fixture/worker'
import { TestClient } from './harness'

/**
 * Schema-drift detection: table schemas changing while the version string
 * stays put — a forgotten version bump (DESIGN.md §9: every schema change
 * requires one). The engine warns once per change and restamps the stored
 * fingerprint; deliberately a warning, not an init failure, because the
 * fingerprint can shift on a zod upgrade with no semantic change.
 */

async function evict(workspaceId: string): Promise<void> {
  const stub = env.ROLLOUT.get(env.ROLLOUT.idFromName(workspaceId))
  await runInDurableObject(stub, async (_instance, state) => {
    state.abort()
  }).catch(() => {
    // abort() kills the object; the call itself is expected to fail
  })
}

function deploy(version: number, schema: AnySyncSchema, presence?: z.ZodType): void {
  rolloutConfig.app = defineApp({
    version,
    schema,
    mutators: { ...crudMutators(schema) },
    migrations: version === 1 ? {} : { 2: null },
    presence,
  })
}

function connect(workspaceId: string, schemaVersion = 1): Promise<TestClient> {
  return TestClient.connect(workspaceId, 'c1', '/rollout').then((c) => {
    c.schemaVersion = schemaVersion
    return c
  })
}

/** testSchema with one table's shape changed (typed gains a field). */
const driftedSchema = defineSchema({
  todos: z.record(z.string(), z.unknown()),
  counters: z.record(z.string(), z.unknown()),
  blobs: z.record(z.string(), z.unknown()),
  typed: z.object({
    name: z.string(),
    n: z.number().default(1),
    added: z.string().optional(),
  }),
})

const driftWarnings = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((args) => String(args[0]).includes('table schemas changed'))

const presenceWarnings = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((args) => String(args[0]).includes('presence schema changed'))

afterEach(() => {
  rolloutConfig.app = rolloutApp
  vi.restoreAllMocks()
})

describe('schemaFingerprint', () => {
  it('is stable for structurally identical schemas and sensitive to shape', () => {
    const a = defineSchema({ t: z.object({ id: z.string(), n: z.number().default(1) }) })
    const b = defineSchema({ t: z.object({ id: z.string(), n: z.number().default(1) }) })
    const c = defineSchema({ t: z.object({ id: z.string(), n: z.number().default(1), x: z.boolean() }) })
    expect(schemaFingerprint(a)).toBe(schemaFingerprint(b))
    expect(schemaFingerprint(a)).not.toBe(schemaFingerprint(c))
  })

  it('treats non-zod tables as opaque (drift undetectable, never warns)', () => {
    const custom = (marker: string) => ({
      '~standard': {
        version: 1 as const,
        vendor: 'custom',
        validate: (value: unknown) => ({ value: { marker, ...(value as object) } }),
      },
    })
    const a = defineSchema({ t: custom('one') })
    const b = defineSchema({ t: custom('two') })
    expect(schemaFingerprint(a)).toBe(schemaFingerprint(b))
  })
})

describe('schema drift under an unchanged version', () => {
  it('warns exactly once per change, then restamps', async () => {
    const workspace = `drift-${Date.now()}`
    const warn = vi.spyOn(console, 'warn')

    const c1 = await connect(workspace)
    await c1.syncOnce()
    c1.close()
    expect(driftWarnings(warn)).toHaveLength(0)

    // "Deploy" changed table schemas without bumping the version.
    deploy(1, driftedSchema)
    await evict(workspace)
    const c2 = await connect(workspace)
    await c2.syncOnce()
    c2.close()
    const warned = driftWarnings(warn)
    expect(warned).toHaveLength(1)
    expect(String(warned[0]![0])).toContain('schema version 1')

    // Fingerprint restamped: the same drifted schema does not warn again.
    await evict(workspace)
    const c3 = await connect(workspace)
    await c3.syncOnce()
    c3.close()
    expect(driftWarnings(warn)).toHaveLength(1)
  })

  it('does not warn when the schema change ships with a version bump', async () => {
    const workspace = `drift-bump-${Date.now()}`
    const warn = vi.spyOn(console, 'warn')

    const c1 = await connect(workspace)
    await c1.syncOnce()
    c1.close()

    // Changed schemas AND a bumped version with a migration step: the
    // legitimate rollout path stays silent.
    deploy(2, driftedSchema)
    await evict(workspace)
    const c2 = await connect(workspace, 2)
    await c2.syncOnce()
    c2.close()
    expect(driftWarnings(warn)).toHaveLength(0)
  })

  it('the fixture schema fingerprints differently from the drifted one', () => {
    expect(schemaFingerprint(testSchema)).not.toBe(schemaFingerprint(driftedSchema))
  })
})

describe('presence drift under an unchanged version (§16.1)', () => {
  it('first declaration is silent; reshaping warns softly once with no version machinery', async () => {
    const workspace = `presence-drift-${Date.now()}`
    const warn = vi.spyOn(console, 'warn')

    const c1 = await connect(workspace)
    await c1.syncOnce()
    c1.close()

    // Declaring presence for the first time: additive by construction, silent.
    deploy(1, testSchema, z.object({ name: z.string() }))
    await evict(workspace)
    const c2 = await connect(workspace)
    await c2.syncOnce() // same schemaVersion: clients are NOT rejected
    c2.close()
    expect(presenceWarnings(warn)).toHaveLength(0)

    // Reshaping it: one soft warning, clients still connect, and it is
    // never priced as table drift.
    deploy(1, testSchema, z.object({ user: z.string() }))
    await evict(workspace)
    const c3 = await connect(workspace)
    await c3.syncOnce()
    c3.close()
    expect(presenceWarnings(warn)).toHaveLength(1)
    expect(driftWarnings(warn)).toHaveLength(0)

    // Restamped: the same shape does not warn again.
    await evict(workspace)
    const c4 = await connect(workspace)
    await c4.syncOnce()
    c4.close()
    expect(presenceWarnings(warn)).toHaveLength(1)
  })
})
