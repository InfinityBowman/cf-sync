import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { crudMutators, defineApp, defineSchema, type StandardSchemaV1 } from '@cf-sync/protocol'
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

  it('refuses tables it cannot fingerprint instead of passing a false green', async () => {
    // A minimal non-zod standard schema: drift in it is invisible to the
    // fingerprint, so the check must refuse rather than always pass.
    const opaque = {
      '~standard': {
        version: 1,
        vendor: 'valibot',
        validate: (value: unknown) => ({ value: value as Record<string, unknown> }),
      },
    } as StandardSchemaV1<Record<string, unknown>, Record<string, unknown>>
    const schema = defineSchema({ todos: opaque })
    const app = defineApp({ version: 1, schema, mutators: crudMutators(schema) })
    await expect(checkSchemaEvolution(app, snapshotPath())).rejects.toThrow(/"todos" \(valibot\).*false green/s)
  })
})

describe('checkSchemaEvolution with allowOptionalAdditions', () => {
  const allow = { allowOptionalAdditions: true }
  function appWith(todo: z.ZodObject, extra?: Record<string, z.ZodObject>) {
    const schema = defineSchema({ todos: todo, ...extra })
    return defineApp({ version: 1, schema, mutators: crudMutators(schema) })
  }
  const base = z.object({ id: z.string(), title: z.string(), meta: z.object({ by: z.string() }) })

  it('takes in fields added as optional, nested ones too, without a bump', async () => {
    const path = snapshotPath()
    await checkSchemaEvolution(appWith(base), path, allow)
    const grown = appWith(base.extend({ note: z.string().optional(), meta: z.object({ by: z.string(), at: z.number().optional() }) }))
    const after = await checkSchemaEvolution(grown, path, allow)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1, fingerprint: after.fingerprint })
    await expect(checkSchemaEvolution(grown, path, allow)).resolves.toEqual(after)
  })

  it.each([
    ['a required field', base.extend({ due: z.string() }), /which fields are required changed/],
    ['a field with a default', base.extend({ priority: z.string().default('normal') }), /required changed|added with a default/],
    ['a removed field', z.object({ id: z.string(), meta: z.object({ by: z.string() }) }), /removed|required changed/],
    ['a changed type', base.extend({ title: z.number() }), /todos\.title/],
    ['a field made optional', base.extend({ title: z.string().optional() }), /which fields are required changed/],
  ])('still demands a bump for %s', async (_, todo, why) => {
    const path = snapshotPath()
    await checkSchemaEvolution(appWith(base), path, allow)
    await expect(checkSchemaEvolution(appWith(todo), path, allow)).rejects.toThrow(why)
  })

  it('still demands a bump for an added table', async () => {
    const path = snapshotPath()
    await checkSchemaEvolution(appWith(base), path, allow)
    await expect(checkSchemaEvolution(appWith(base, { tags: z.object({ id: z.string() }) }), path, allow)).rejects.toThrow(
      /table "tags" added/,
    )
  })

  it('records the shapes into a snapshot written without the option, then compares against them', async () => {
    const path = snapshotPath()
    await checkSchemaEvolution(appWith(base), path)
    expect(JSON.parse(readFileSync(path, 'utf8')).tables).toBeUndefined()
    await checkSchemaEvolution(appWith(base), path, allow)
    expect(JSON.parse(readFileSync(path, 'utf8')).tables).toBeDefined()
    await expect(checkSchemaEvolution(appWith(base.extend({ note: z.string().optional() })), path, allow)).resolves.toBeDefined()
  })

  it('cannot tell an addition from a change on a snapshot that has no shapes', async () => {
    const path = snapshotPath()
    await checkSchemaEvolution(appWith(base), path)
    await expect(checkSchemaEvolution(appWith(base.extend({ note: z.string().optional() })), path, allow)).rejects.toThrow(
      /predates allowOptionalAdditions/,
    )
  })

  it('leaves snapshots alone without the option', async () => {
    const path = snapshotPath()
    await checkSchemaEvolution(appWith(base), path)
    await expect(checkSchemaEvolution(appWith(base.extend({ note: z.string().optional() })), path)).rejects.toThrow(
      /version is still 1/,
    )
  })
})
