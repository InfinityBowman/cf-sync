import {
  AppError,
  MAX_ID_LENGTH,
  MAX_ROW_BYTES,
  TABLE_NAME_RE,
  type AnySyncSchema,
  type MutatorTx,
  type StandardSchemaV1,
} from '@cf-sync/protocol'
import { formatIssues, jsonByteSize } from '@cf-sync/protocol/internal'

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
  /** All live rows in a table. */
  list(tbl: string): Array<{ id: string; data: Record<string, unknown> }>
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
 * while the LMID advance still commits (DESIGN.md §6). Reads see the overlay.
 *
 * `validateAtFlush` defers row validation from `put` to `flush` — schema
 * migration replays need it, because intermediate steps of a chain may write
 * shapes that only become schema-valid after a later step rewrites them; only
 * the chain's net result must parse. Mutations keep validating at `put` so a
 * mutator reading back its own write sees the parsed output (defaults
 * applied), exactly what a poke will carry.
 */
export class WriteSet {
  #puts = new Map<string, RowWrite>()
  #dels = new Map<string, { tbl: string; id: string }>()

  constructor(
    private readonly rows: EngineRowStore,
    private readonly schema: AnySyncSchema,
    private readonly validateAtFlush = false,
  ) {}

  readonly tx: MutatorTx = {
    get: (tbl, id) => {
      validateTarget(tbl, id)
      const k = rowKey(tbl, id)
      if (this.#dels.has(k)) return null
      const buffered = this.#puts.get(k)
      if (buffered) return structuredClone(buffered.data)
      return this.rows.get(tbl, id)
    },
    list: (tbl) => {
      if (!TABLE_NAME_RE.test(tbl)) throw new AppError('InvalidArgs', `invalid table name "${tbl}"`)
      const merged = new Map<string, Record<string, unknown>>()
      for (const row of this.rows.list(tbl)) merged.set(row.id, row.data)
      for (const del of this.#dels.values()) if (del.tbl === tbl) merged.delete(del.id)
      for (const put of this.#puts.values()) if (put.tbl === tbl) merged.set(put.id, structuredClone(put.data))
      return [...merged].map(([id, data]) => ({ id, data }))
    },
    put: (tbl, id, data) => {
      validateTarget(tbl, id)
      const stored = this.validateAtFlush
        ? (data as Record<string, unknown>)
        : validateRow(this.schema, tbl, id, data)
      const bytes = jsonByteSize(stored)
      if (bytes > MAX_ROW_BYTES) {
        throw new AppError('RowTooLarge', `row ${tbl}/${id} is ${bytes} bytes (max ${MAX_ROW_BYTES})`)
      }
      const k = rowKey(tbl, id)
      this.#dels.delete(k)
      this.#puts.set(k, { tbl, id, data: structuredClone(stored) })
    },
    del: (tbl, id) => {
      validateTarget(tbl, id)
      const k = rowKey(tbl, id)
      this.#puts.delete(k)
      this.#dels.set(k, { tbl, id })
    },
  }

  /** Flushes buffered writes stamped with `version`. Returns rows actually written. */
  flush(version: number): number {
    let written = 0
    for (const { tbl, id, data } of this.#puts.values()) {
      const stored = this.validateAtFlush ? validateRow(this.schema, tbl, id, data) : data
      if (this.validateAtFlush) {
        const bytes = jsonByteSize(stored)
        if (bytes > MAX_ROW_BYTES) {
          throw new AppError('RowTooLarge', `row ${tbl}/${id} is ${bytes} bytes (max ${MAX_ROW_BYTES})`)
        }
      }
      this.rows.put(tbl, id, stored, version)
      written++
    }
    for (const { tbl, id } of this.#dels.values()) {
      // Deleting a row that never existed is a no-op, not a tombstone: no
      // client can hold a row the server never had.
      written += this.rows.del(tbl, id, version)
    }
    return written
  }
}
