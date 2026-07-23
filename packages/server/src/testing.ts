import {
  AppError,
  formatIssues,
  migrationPath,
  type AnyMutators,
  type AnySyncSchema,
  type AppDefinition,
  type MutationArgs,
  type MutatorContext,
  type RowInputOf,
  type RowOf,
  type TableName,
} from '@cf-sync/protocol'
import { WriteSet, rowKey, validateRow, type EngineRowStore } from './engine-core'

/**
 * In-memory workspace engine for unit-testing app definitions — mutators and
 * schema migrations — in plain vitest/jest, no workerd required. It runs the
 * same WriteSet, validation, and error semantics as the Durable Object
 * (engine-core.ts is shared code, not a reimplementation):
 *
 * - `tx.put` validates rows against the table schema; mutators read back
 *   parsed output (defaults applied).
 * - A mutator that throws `AppError` is a permanent rejection: its writes are
 *   discarded but the client's lastMutationId still advances (DESIGN.md §6
 *   invariant 2).
 * - Any other throw is transient: nothing commits and the LMID does not
 *   advance (the real client would retry the push).
 *
 * ```ts
 * const engine = createTestEngine(app)
 * engine.seed('todos', 't1', { id: 't1', title: 'x', completed: true, createdAt: '...' })
 * const result = engine.mutate('todos.clearCompleted')
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
 *   rows: { todos: { t1: { id: 't1', title: 'x', completed: false, createdAt: '...' } } },
 * })
 * expect(engine.get('todos', 't1')?.priority).toBe('normal')
 * ```
 */

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
}

/** The outcome of one authoritative mutation: `error` is the permanent app error, if any. */
export interface TestMutationResult {
  error?: { code: string; message: string }
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

export class TestEngine<S extends AnySyncSchema = AnySyncSchema, M extends AnyMutators = AnyMutators> {
  readonly #app: AppDefinition<S, M>
  readonly #store = new MemoryRowStore()
  readonly #lmids = new Map<string, number>()
  readonly #clientId: string
  #version = 0

  constructor(app: AppDefinition<S, M>, opts: TestEngineOptions = {}) {
    this.#app = app
    this.#clientId = opts.clientId ?? 'test'
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
      const ctx: MutatorContext = { clientId }
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
 * Creates an in-memory workspace engine from the shared app definition —
 * see `TestEngine` for semantics and examples.
 */
export function createTestEngine<S extends AnySyncSchema, M extends AnyMutators>(
  app: AppDefinition<S, M>,
  opts?: TestEngineOptions,
): TestEngine<S, M> {
  return new TestEngine(app, opts)
}
