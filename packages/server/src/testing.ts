import {
  AppError,
  type AnyMutators,
  type AnySyncSchema,
  type AppDefinition,
  type EngineErrorCode,
  type MutationArgs,
  type MutatorContext,
  type RowInputOf,
  type RowOf,
  type TableName,
} from '@cf-sync/protocol'
import { formatIssues, migrationPath } from '@cf-sync/protocol/internal'
import { WriteSet, rowKey, validateRow, type EngineRowStore } from './engine-core'
import { schemaFingerprint, unfingerprintableTables } from './fingerprint'

export { schemaFingerprint }

// One import source for node test files: the definition kit, re-exported so
// a test never touches the main entry — that one imports `cloudflare:workers`
// and dies outside workerd with an error that never names this fix.
export { AppError, crudMutators, defineApp, defineMutators, defineSchema } from '@cf-sync/protocol'
export type { AppDefinition, MigrationTx, MutatorContext, MutatorTx } from '@cf-sync/protocol'

/** Options for {@link createTestEngine}: initial state, stored schema version, and the identity mutators observe. */
export interface TestEngineOptions {
  /**
   * Simulate a workspace whose data was stored under an older schema version:
   * `rows` are stored as-is (old shapes, no validation) and the app's
   * migration chain replays during construction. Defaults to `app.version`
   * (a fresh, current workspace; `rows` are then validated like an import).
   */
  storedVersion?: number
  /** Initial rows, keyed table -> id -> row data. */
  rows?: Record<string, Record<string, Record<string, unknown>>>
  /** The clientId `mutate` runs as (mutators see it via ctx). Default: "test". */
  clientId?: string
  /** The principal mutators see as `ctx.principal` — what an authorize verdict would stamp. */
  principal?: string
  /**
   * The auth context mutators see as `ctx.auth`. Validated against the app's
   * `authContext` schema at construction when one is declared (the parsed
   * output is what mutators read), mirroring the DO's connect-time check.
   */
  auth?: unknown
}

/** The outcome of one authoritative mutation: `error` is the permanent app error, if any. */
export interface TestMutationResult {
  /** `code` is an {@link EngineErrorCode} built-in or an app-defined `AppError` code. */
  error?: { code: EngineErrorCode | (string & {}); message: string }
}

interface StoredRow {
  tbl: string
  id: string
  data: Record<string, unknown>
  version: number
  deleted: boolean
}

/** EngineRowStore over a Map — the test-engine counterpart of the DO's SQLite store. */
class MemoryRowStore implements EngineRowStore {
  readonly rows = new Map<string, StoredRow>()

  get(tbl: string, id: string): Record<string, unknown> | null {
    const row = this.rows.get(rowKey(tbl, id))
    return row && !row.deleted ? structuredClone(row.data) : null
  }

  list(tbl: string): Array<{ id: string; data: Record<string, unknown> }> {
    const out: Array<{ id: string; data: Record<string, unknown> }> = []
    for (const row of this.rows.values()) {
      if (row.tbl === tbl && !row.deleted) out.push({ id: row.id, data: structuredClone(row.data) })
    }
    return out
  }

  put(tbl: string, id: string, data: Record<string, unknown>, version: number): void {
    this.rows.set(rowKey(tbl, id), { tbl, id, data: structuredClone(data), version, deleted: false })
  }

  del(tbl: string, id: string, version: number): number {
    const row = this.rows.get(rowKey(tbl, id))
    if (!row || row.deleted) return 0
    row.deleted = true
    row.version = version
    return 1
  }
}

// Permanent-vs-transient error semantics: DESIGN.md §6 invariant 2.
/**
 * In-memory workspace engine for unit-testing app definitions — mutators and
 * schema migrations — in plain vitest/jest, no workerd required. It runs the
 * same WriteSet, validation, and error semantics as the Durable Object
 * (engine-core.ts is shared code, not a reimplementation):
 *
 * - `tx.put` validates rows against the table schema; mutators read back
 *   parsed output (defaults applied).
 * - A mutator that throws `AppError` is a permanent rejection: its writes are
 *   discarded but the client's lastMutationId still advances.
 * - Any other throw is transient: nothing commits and the LMID does not
 *   advance (the real client would retry the push).
 *
 * ```ts
 * const engine = createTestEngine(app)
 * engine.seed('todos', 't1', { id: 't1', title: 'x', done: true })
 * const result = engine.mutate('todo.clearCompleted', {})
 * expect(result.error).toBeUndefined()
 * expect(engine.list('todos')).toEqual([])
 * ```
 *
 * Migration tests construct the engine as a workspace that slept through
 * deploys: rows are stored raw under `storedVersion` (old shapes welcome) and
 * the migration chain replays immediately, exactly like the DO's first wake —
 * a throwing step or a missing path throws from `createTestEngine` itself.
 *
 * ```ts
 * const engine = createTestEngine(app, {
 *   storedVersion: 1,
 *   rows: { todos: { t1: { id: 't1', title: 'x', done: false } } },
 * })
 * expect(engine.get('todos', 't1')?.priority).toBe('normal')
 * ```
 */
export class TestEngine<S extends AnySyncSchema = AnySyncSchema, M extends AnyMutators = AnyMutators> {
  readonly #app: AppDefinition<S, M>
  readonly #store = new MemoryRowStore()
  readonly #lmids = new Map<string, number>()
  readonly #clientId: string
  readonly #principal: string | undefined
  readonly #auth: unknown
  #version = 0

  constructor(app: AppDefinition<S, M>, opts: TestEngineOptions = {}) {
    this.#app = app
    this.#clientId = opts.clientId ?? 'test'
    this.#principal = opts.principal
    this.#auth = opts.auth
    if (opts.auth !== undefined && app.authContext) {
      const result = app.authContext['~standard'].validate(opts.auth)
      if (result instanceof Promise) {
        void result.catch(() => {})
        throw new Error('createTestEngine: async authContext validation is not supported')
      }
      if (result.issues) {
        throw new Error(`createTestEngine: auth fails the app's authContext schema: ${formatIssues(result.issues)}`)
      }
      this.#auth = result.value
    }
    const storedVersion = opts.storedVersion ?? app.version

    if (storedVersion === app.version) {
      // Fresh, current workspace: initial rows validate like an admin import.
      for (const [tbl, byId] of Object.entries(opts.rows ?? {})) {
        for (const [id, data] of Object.entries(byId)) this.seedRaw(tbl, id, validateRow(app.schema, tbl, id, data))
      }
      return
    }

    // Old workspace waking after a deploy: raw rows, then the chain replays —
    // one write buffer, net result validated at flush (mirrors do.ts).
    const steps = migrationPath(app, storedVersion)
    for (const [tbl, byId] of Object.entries(opts.rows ?? {})) {
      for (const [id, data] of Object.entries(byId)) this.seedRaw(tbl, id, data)
    }
    const writes = new WriteSet(this.#store, app.schema, true)
    for (const step of steps) step.migrate?.(writes.tx)
    writes.flush(++this.#version)
  }

  /** The clientId `mutate` runs as. */
  get clientId(): string {
    return this.#clientId
  }

  /** The current data version (bumps only when a mutation or seed writes rows). */
  get version(): number {
    return this.#version
  }

  /**
   * Applies a named mutation authoritatively as the engine's default client,
   * with the server's semantics: args are parsed first (invalid args are a
   * permanent error), `AppError` from apply is permanent (LMID advances,
   * writes discarded), any other throw is transient (rethrown, nothing
   * committed).
   */
  mutate<K extends keyof M & string>(name: K, ...rest: MutationArgs<M[K]>): TestMutationResult {
    return this.mutateAs(this.#clientId, name, ...rest)
  }

  /** `mutate` as a specific clientId — for testing mutators that read `ctx.clientId`. */
  mutateAs<K extends keyof M & string>(clientId: string, name: K, ...rest: MutationArgs<M[K]>): TestMutationResult {
    const mutationId = (this.#lmids.get(clientId) ?? 0) + 1
    const mutator = (this.#app.mutators as AnyMutators)[name]
    let appError: { code: string; message: string } | undefined

    if (!mutator) {
      appError = { code: 'UnknownMutator', message: `no mutator named "${name}"` }
    } else {
      const ctx: MutatorContext = {
        clientId,
        principal: this.#principal,
        auth: this.#auth,
        authoritative: true, // the test engine is the server's seat
      }
      const writes = new WriteSet(this.#store, this.#app.schema)
      try {
        let args: unknown = rest[0]
        if (mutator.args) {
          const result = mutator.args['~standard'].validate(args)
          if (result instanceof Promise) {
            void result.catch(() => {})
            throw new AppError('InvalidArgs', `mutator "${name}": async args validation is not supported`)
          }
          if (result.issues) {
            throw new AppError('InvalidArgs', `invalid args for "${name}": ${formatIssues(result.issues)}`)
          }
          args = result.value
        }
        mutator.apply(writes.tx, args, ctx)
        const candidate = this.#version + 1
        if (writes.flush(candidate) > 0) this.#version = candidate
      } catch (err) {
        if (err instanceof AppError) {
          appError = { code: err.code, message: err.message }
        } else {
          throw err // transient: nothing commits, the LMID does not advance
        }
      }
    }

    this.#lmids.set(clientId, mutationId)
    return appError ? { error: appError } : {}
  }

  /** The last mutation id confirmed for a client — permanent errors advance it too. */
  lastMutationId(clientId: string = this.#clientId): number {
    return this.#lmids.get(clientId) ?? 0
  }

  /** The live row, parsed through the table schema when it was written. */
  get<K extends TableName<S>>(tbl: K, id: string): RowOf<S, K> | null {
    return this.#store.get(tbl, id) as RowOf<S, K> | null
  }

  /** All live rows in a table. */
  list<K extends TableName<S>>(tbl: K): Array<{ id: string; data: RowOf<S, K> }> {
    return this.#store.list(tbl) as Array<{ id: string; data: RowOf<S, K> }>
  }

  /**
   * Stores a row directly, outside any mutation — test setup for state the
   * server would already hold. Validated against the table schema (defaults
   * applied), like every server-side write.
   */
  seed<K extends TableName<S>>(tbl: K, id: string, data: RowInputOf<S, K>): void {
    this.seedRaw(tbl, id, validateRow(this.#app.schema, tbl, id, data as Record<string, unknown>))
  }

  private seedRaw(tbl: string, id: string, data: Record<string, unknown>): void {
    this.#store.put(tbl, id, data, ++this.#version)
  }
}

/**
 * Creates an in-memory workspace engine from the shared app definition, for
 * unit-testing mutators and schema migrations in plain node — no workerd, no
 * miniflare, no bindings — with the same write-buffer, validation, and error
 * semantics as the Durable Object (shared engine core, not a
 * reimplementation). See {@link TestEngine} for the full semantics and the
 * migration-testing shape.
 *
 * @example
 * ```ts
 * import { createTestEngine } from '@cf-sync/server/testing'
 * import { app } from '../src/schema'
 *
 * const engine = createTestEngine(app)
 * engine.seed('todos', 't1', { id: 't1', title: 'keep', done: false })
 * engine.seed('todos', 't2', { id: 't2', title: 'drop', done: true })
 * const result = engine.mutate('todo.clearCompleted', {})
 * expect(result.error).toBeUndefined()
 * expect(engine.get('todos', 't2')).toBeNull()
 * ```
 */
export function createTestEngine<S extends AnySyncSchema, M extends AnyMutators>(
  app: AppDefinition<S, M>,
  opts?: TestEngineOptions,
): TestEngine<S, M> {
  return new TestEngine(app, opts)
}

// ---------------------------------------------------------------------------
// Schema-evolution tripwire
// ---------------------------------------------------------------------------

/** What `checkSchemaEvolution` stores in its snapshot file. */
export interface SchemaSnapshot {
  version: number
  /** Structural fingerprint of the table schemas — the same one the DO stores for drift detection. */
  fingerprint: string
}

/**
 * The CI tripwire for the one schema mistake the type system cannot catch:
 * **changing a table schema without bumping `version`** — every schema
 * change requires a bump, because without one rows written before the change
 * never gain new fields at runtime, and old bundles sharing the version can
 * silently strip them via full-row writes. The deployed engine only detects
 * this after the fact, as
 * a warning in Durable Object logs; this check fails the build instead.
 *
 * Add one test next to your app definition:
 *
 * ```ts
 * it('every schema change ships with a version bump', async () => {
 *   await checkSchemaEvolution(app, new URL('./schema-snapshot.json', import.meta.url))
 * })
 * ```
 *
 * The snapshot file works like a jest snapshot — commit it. The first run
 * scaffolds it; a version bump rewrites it automatically (the bump is the
 * fix, so the test passes); a schema change **without** a bump throws with
 * the exact migrations entry to add. Node-only (reads and writes the file),
 * like everything in this subpath.
 *
 * Presence is deliberately outside the fingerprint: presence is ephemeral —
 * never stored — so reshaping it needs no version bump.
 *
 * Rare false positive: the fingerprint derives from zod's JSON Schema
 * emission, so a zod upgrade can shift it with no semantic change — the
 * thrown message says so; delete the snapshot file to re-baseline.
 */
export async function checkSchemaEvolution(
  app: AppDefinition<AnySyncSchema>,
  snapshotPath: string | URL,
): Promise<SchemaSnapshot> {
  // Refuse a false green: fingerprinting reads zod's JSON Schema emission, so
  // a table this cannot see would sail through every run no matter how its
  // schema changed — and the runtime drift warning is blind to it too.
  const opaque = unfingerprintableTables(app.schema)
  if (opaque.length > 0) {
    const list = opaque.map(({ table, vendor }) => `"${table}" (${vendor})`).join(', ')
    throw new Error(
      `checkSchemaEvolution: table(s) ${list} cannot be fingerprinted — drift detection only covers ` +
        `zod table schemas, so a schema change in them would pass this check unseen. Passing here ` +
        `would be a false green, not protection. Define these tables with zod to get the tripwire, ` +
        `or drop this check and own the version-bump discipline manually (every schema change ` +
        `requires a bump — DESIGN.md §9).`,
    )
  }
  const fs = await import('node:fs')
  // workers-types' global URL and @types/node's URL diverge in lib details;
  // at runtime both are WHATWG URLs, which node's fs accepts directly.
  const path = snapshotPath as unknown as string
  const current: SchemaSnapshot = { version: app.version, fingerprint: schemaFingerprint(app.schema) }
  const serialize = (snap: SchemaSnapshot): string =>
    `${JSON.stringify({ __comment: 'cf-sync schema snapshot (checkSchemaEvolution) — commit this file', ...snap }, null, 2)}\n`

  let raw: string
  try {
    raw = fs.readFileSync(path, 'utf8')
  } catch {
    fs.writeFileSync(path, serialize(current))
    return current
  }

  let stored: SchemaSnapshot
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.version !== 'number' || typeof parsed.fingerprint !== 'string') throw new Error('shape')
    stored = { version: parsed.version, fingerprint: parsed.fingerprint }
  } catch {
    throw new Error(
      `checkSchemaEvolution: ${String(snapshotPath)} is not a schema snapshot this helper wrote — ` +
        `delete the file to re-baseline from the current app definition`,
    )
  }

  if (stored.version === current.version) {
    if (stored.fingerprint === current.fingerprint) return current
    throw new Error(
      `checkSchemaEvolution: table schemas changed but version is still ${current.version} ` +
        `(fingerprint ${stored.fingerprint} -> ${current.fingerprint}). Every schema change requires a ` +
        `version bump — additive ones too. Bump defineApp to version: ${current.version + 1} and add ` +
        `migrations[${current.version + 1}] (null when new fields have defaults and no rows need ` +
        `rewriting; a backfill function otherwise). If nothing semantic changed and this is a zod ` +
        `upgrade reshaping its JSON Schema emission, delete ${String(snapshotPath)} to re-baseline.`,
    )
  }
  if (stored.version > current.version) {
    throw new Error(
      `checkSchemaEvolution: the snapshot records version ${stored.version} but the app declares ` +
        `${current.version} — a version rollback (or a stale branch merged over a newer snapshot). ` +
        `Deployed versions never roll back (DESIGN.md §9): restore the higher version, or delete ` +
        `${String(snapshotPath)} if this branch intentionally diverged.`,
    )
  }
  // Version legitimately bumped: re-baseline (defineApp already validated the
  // migration chain reaches the new version in both bundles).
  fs.writeFileSync(path, serialize(current))
  return current
}
