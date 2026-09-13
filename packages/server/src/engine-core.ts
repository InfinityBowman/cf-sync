import {
  AppError,
  MAX_ROW_BYTES,
  type AnySyncSchema,
  type FilterValue,
  type MutatorTx,
  type StandardSchemaV1,
} from '@cf-sync/protocol'
import { MAX_ID_LENGTH, TABLE_NAME_RE, compileWhere, formatIssues, jsonByteSize } from '@cf-sync/protocol/internal'
import type { RowChange } from './config'

/**
 * The storage-agnostic core of the workspace engine: row validation and the
 * per-mutation write buffer. `do.ts` drives it against DO SQLite; the test
 * engine (`@cf-sync/server/testing`) drives the same code against in-memory
 * maps, so tested semantics are the shipped semantics.
 */

/**
 * The row reads/writes a WriteSet needs from its backing storage. Rows
 * returned by `get`/`list` must be private copies — callers may mutate them.
 */
export interface EngineRowStore {
  /** The live (non-deleted) row, or null. */
  get(tbl: string, id: string): Record<string, unknown> | null
  /**
   * Live rows in a table. `where` is a hint: the store may return a superset
   * of the matching rows (or ignore it); the WriteSet applies the exact predicate.
   */
  list(tbl: string, where?: Record<string, FilterValue>): Array<{ id: string; data: Record<string, unknown> }>
  /** Insert or replace a live row stamped with `version`. */
  put(tbl: string, id: string, data: Record<string, unknown>, version: number): void
  /** Tombstone a live row stamped with `version`; returns rows affected (0 when absent). */
  del(tbl: string, id: string, version: number): number
}

/**
 * Validates a row payload against its table's schema and returns the parsed
 * output (defaults applied). Only `put` is schema-strict — reads and deletes
 * stay loose so migrations can touch tables that left the schema.
 */
export function validateRow(
  schema: AnySyncSchema,
  tbl: string,
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const tableSchema = (schema.tables as Record<string, StandardSchemaV1<unknown, Record<string, unknown>>>)[tbl]
  if (!tableSchema) {
    throw new AppError('InvalidArgs', `table "${tbl}" is not defined in the schema`)
  }
  const result = tableSchema['~standard'].validate(data)
  if (result instanceof Promise) {
    // Mutations apply inside a synchronous transaction; an async validator
    // can never succeed here, so fail permanently and loudly.
    void result.catch(() => {})
    throw new AppError('InvalidArgs', `table "${tbl}": async validation is not supported`)
  }
  if (result.issues) {
    throw new AppError('InvalidArgs', `invalid row ${tbl}/${id}: ${formatIssues(result.issues)}`)
  }
  return result.value
}

export function validateTarget(tbl: string, id: string): void {
  if (!TABLE_NAME_RE.test(tbl)) throw new AppError('InvalidArgs', `invalid table name "${tbl}"`)
  if (id.length === 0 || id.length > MAX_ID_LENGTH || id.includes('\u0000')) {
    throw new AppError('InvalidArgs', `invalid row id for table "${tbl}"`)
  }
}

export function rowKey(tbl: string, id: string): string {
  return `${tbl}\u0000${id}`
}

interface RowWrite {
  tbl: string
  id: string
  data: Record<string, unknown>
}

/**
 * Buffers a single mutation's writes so they can be discarded on AppError
 * while the LMID advance still commits (invariant 2, ARCHITECTURE.md#invariants).
 * Reads see the overlay.
 *
 * `validateAtFlush` defers row validation from `put` to `flush` — schema
 * migration replays need it, because intermediate steps of a chain may write
 * shapes that only become schema-valid after a later step rewrites them; only
 * the chain's net result must parse. Mutations keep validating at `put` so a
 * mutator reading back its own write sees the parsed output (defaults
 * applied), exactly what a poke will carry.
 *
 * `trackChanges` makes `flush` report each written row's before/after pair
 * (the post-commit hook's payload). It costs one stored-row read per row the
 * mutation writes blind — a `tx.get` that reached storage doubles as the
 * image — so it stays off unless something consumes the list.
 */
export class WriteSet {
  #puts = new Map<string, RowWrite>()
  #dels = new Map<string, { tbl: string; id: string }>()
  // The stored row at the mutation's first touch of it, keyed like the
  // buffers, so the change list reports the net effect (before -> after)
  // rather than intermediate overlay states. Insertion order is touch order.
  #before = new Map<string, Record<string, unknown> | null>()
  readonly #validateAtFlush: boolean
  readonly #trackChanges: boolean

  constructor(
    private readonly rows: EngineRowStore,
    private readonly schema: AnySyncSchema,
    opts: { validateAtFlush?: boolean; trackChanges?: boolean } = {},
  ) {
    this.#validateAtFlush = opts.validateAtFlush ?? false
    this.#trackChanges = opts.trackChanges ?? false
  }

  readonly tx: MutatorTx = {
    get: (tbl, id) => {
      validateTarget(tbl, id)
      const k = rowKey(tbl, id)
      if (this.#dels.has(k)) return null
      const buffered = this.#puts.get(k)
      if (buffered) return structuredClone(buffered.data)
      const stored = this.rows.get(tbl, id)
      if (!this.#trackChanges || this.#before.has(k)) return stored
      // Read-modify-write is the common mutator shape: keep this read as
      // the before-image so `put` need not fetch the row a second time. The
      // caller may mutate what it gets back, so the kept copy is private.
      this.#before.set(k, structuredClone(stored))
      return stored
    },
    list: (tbl, opts) => {
      if (!TABLE_NAME_RE.test(tbl)) throw new AppError('InvalidArgs', `invalid table name "${tbl}"`)
      const where = opts?.where as Record<string, FilterValue> | undefined
      const matches = compileWhere(where)
      const merged = new Map<string, Record<string, unknown>>()
      for (const row of this.rows.list(tbl, where)) if (matches(row.data)) merged.set(row.id, row.data)
      for (const del of this.#dels.values()) if (del.tbl === tbl) merged.delete(del.id)
      for (const put of this.#puts.values()) {
        if (put.tbl !== tbl) continue
        // A buffered rewrite can make a stored row stop matching.
        if (matches(put.data)) merged.set(put.id, structuredClone(put.data))
        else merged.delete(put.id)
      }
      return [...merged].map(([id, data]) => ({ id, data }))
    },
    put: (tbl, id, data) => {
      validateTarget(tbl, id)
      const stored = this.#validateAtFlush
        ? (data as Record<string, unknown>)
        : validateRow(this.schema, tbl, id, data)
      const bytes = jsonByteSize(stored)
      if (bytes > MAX_ROW_BYTES) {
        throw new AppError('RowTooLarge', `row ${tbl}/${id} is ${bytes} bytes (max ${MAX_ROW_BYTES})`)
      }
      const k = rowKey(tbl, id)
      this.#rememberBefore(k, tbl, id)
      this.#dels.delete(k)
      this.#puts.set(k, { tbl, id, data: structuredClone(stored) })
    },
    del: (tbl, id) => {
      validateTarget(tbl, id)
      const k = rowKey(tbl, id)
      this.#rememberBefore(k, tbl, id)
      this.#puts.delete(k)
      this.#dels.set(k, { tbl, id })
    },
  }

  #rememberBefore(k: string, tbl: string, id: string): void {
    if (this.#trackChanges && !this.#before.has(k)) this.#before.set(k, this.rows.get(tbl, id))
  }

  /**
   * Flushes buffered writes stamped with `version`. `written` counts rows
   * actually written or deleted; `changes` lists them as before/after pairs
   * in first-touch order when `trackChanges` is on, and is empty otherwise.
   */
  flush(version: number): { written: number; changes: RowChange[] } {
    const after = new Map<string, Record<string, unknown> | null>()
    for (const { tbl, id, data } of this.#puts.values()) {
      const stored = this.#validateAtFlush ? validateRow(this.schema, tbl, id, data) : data
      if (this.#validateAtFlush) {
        const bytes = jsonByteSize(stored)
        if (bytes > MAX_ROW_BYTES) {
          throw new AppError('RowTooLarge', `row ${tbl}/${id} is ${bytes} bytes (max ${MAX_ROW_BYTES})`)
        }
      }
      this.rows.put(tbl, id, stored, version)
      after.set(rowKey(tbl, id), stored)
    }
    for (const { tbl, id } of this.#dels.values()) {
      // Deleting a row that never existed is a no-op, not a tombstone: no
      // client can hold a row the server never had.
      if (this.rows.del(tbl, id, version) > 0) after.set(rowKey(tbl, id), null)
    }
    const changes: RowChange[] = []
    for (const [k, before] of this.#before) {
      if (!after.has(k)) continue
      const target = this.#puts.get(k) ?? this.#dels.get(k)!
      changes.push({ tbl: target.tbl, id: target.id, before, after: after.get(k) as Record<string, unknown> | null })
    }
    return { written: after.size, changes }
  }
}
