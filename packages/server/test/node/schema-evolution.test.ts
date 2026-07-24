import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { crudMutators, defineApp, defineSchema } from '@cf-sync/protocol'
import { checkSchemaEvolution } from '../../src/testing'

const dirs: string[] = []
function snapshotPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-sync-schema-'))
  dirs.push(dir)
  return join(dir, 'schema-snapshot.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeApp(version: number, withPriority = false, presence?: z.ZodType) {
  const schema = defineSchema({
    todos: withPriority
      ? z.object({ id: z.string(), title: z.string(), priority: z.string().default('normal') })
      : z.object({ id: z.string(), title: z.string() }),
  })
  const migrations = Object.fromEntries(Array.from({ length: version - 1 }, (_, i) => [i + 2, null]))
  return defineApp({ version, schema, mutators: crudMutators(schema), migrations, presence })
}

describe('checkSchemaEvolution', () => {
  it('scaffolds the snapshot on first run and passes on an unchanged app', async () => {
    const path = snapshotPath()
    const app = makeApp(1)
    const first = await checkSchemaEvolution(app, path)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1, fingerprint: first.fingerprint })

    // Same app, second run: stable.
    await expect(checkSchemaEvolution(app, path)).resolves.toEqual(first)
  })

  it('throws — with the exact fix — when the schema changes under an unbumped version', async () => {
    const path = snapshotPath()
    await checkSchemaEvolution(makeApp(1), path)

    // todos gains `priority`, version still 1: the forgotten-bump bug.
    await expect(checkSchemaEvolution(makeApp(1, true), path)).rejects.toThrow(
      /version is still 1.*version: 2.*migrations\[2\]/s,
    )
  })

  it('re-baselines automatically when the version legitimately bumps', async () => {
    const path = snapshotPath()
    await checkSchemaEvolution(makeApp(1), path)

    const bumped = await checkSchemaEvolution(makeApp(2, true), path)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 2, fingerprint: bumped.fingerprint })
    // And the new baseline holds from here.
    await expect(checkSchemaEvolution(makeApp(2, true), path)).resolves.toEqual(bumped)
  })

  it('throws on a version rollback (snapshot newer than the app)', async () => {
    const path = snapshotPath()
    await checkSchemaEvolution(makeApp(2, true), path)
    await expect(checkSchemaEvolution(makeApp(1), path)).rejects.toThrow(/rollback|stale branch/)
  })

  it('ignores presence changes — reshaping presence needs no version bump', async () => {
    const path = snapshotPath()
    const first = await checkSchemaEvolution(makeApp(1), path)
    const withPresence = makeApp(1, false, z.object({ name: z.string() }))
    await expect(checkSchemaEvolution(withPresence, path)).resolves.toEqual(first)
  })

  it('rejects a file it did not write, pointing at re-baselining', async () => {
    const path = snapshotPath()
    writeFileSync(path, '{"not": "a snapshot"}')
    await expect(checkSchemaEvolution(makeApp(1), path)).rejects.toThrow(/delete the file to re-baseline/)
  })
})
