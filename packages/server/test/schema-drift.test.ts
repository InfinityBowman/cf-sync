import { env, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { schemaFingerprint } from '../src/fingerprint'
import { crudMutators, defineApp, defineSchema, type AnySyncSchema } from '../src/index'
import { rolloutApp, rolloutConfig, testSchema } from './fixture/worker'
import { TestClient } from './harness'

/**
 * Schema-drift detection: table schemas changing while the version string
 * stays put. Additive drift is legal (DESIGN.md §9); the engine can't tell
 * additive from breaking, so it warns once per change and restamps the
 * stored fingerprint.
 */

async function evict(workspaceId: string): Promise<void> {
  const stub = env.ROLLOUT.get(env.ROLLOUT.idFromName(workspaceId))
  await runInDurableObject(stub, async (_instance, state) => {
    state.abort()
  }).catch(() => {
    // abort() kills the object; the call itself is expected to fail
  })
}

function deploy(version: string, schema: AnySyncSchema): void {
  rolloutConfig.app = defineApp({
    version,
    schema,
    mutators: { ...crudMutators(schema) },
    migrations: version === 'test-1' ? [] : [{ from: 'test-1', to: version }],
  })
}

function connect(workspaceId: string, schemaVersion = 'test-1'): Promise<TestClient> {
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
    deploy('test-1', driftedSchema)
    await evict(workspace)
    const c2 = await connect(workspace)
    await c2.syncOnce()
    c2.close()
    const warned = driftWarnings(warn)
    expect(warned).toHaveLength(1)
    expect(String(warned[0]![0])).toContain('"test-1"')

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
    deploy('test-2', driftedSchema)
    await evict(workspace)
    const c2 = await connect(workspace, 'test-2')
    await c2.syncOnce()
    c2.close()
    expect(driftWarnings(warn)).toHaveLength(0)
  })

  it('the fixture schema fingerprints differently from the drifted one', () => {
    expect(schemaFingerprint(testSchema)).not.toBe(schemaFingerprint(driftedSchema))
  })
})
