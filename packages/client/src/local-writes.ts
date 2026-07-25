import { AppError, type AnySyncSchema, type MutatorTx, type TableSchema } from '@cf-sync/protocol'
import { formatIssues } from '@cf-sync/protocol/internal'
import { MissingApplierError } from './errors'
import type { TableApplier } from './types'

/**
 * Buffers a single intent's local writes — the client mirror of the server's
 * WriteSet (ARCHITECTURE.md#mutation-processing). Reads see the mutation's own buffer first, then
 * fall through to the table's collection (whose view already includes earlier
 * pending intents' overlays, so overlapping intents read each other). Any
 * touched table without an attached collection aborts the speculative run via
 * `MissingApplierError` — a partial overlay would be worse than none.
 */
export class LocalWriteSet {
  readonly #puts = new Map<string, { tbl: string; id: string; data: Record<string, unknown> }>()
  readonly #dels = new Map<string, { tbl: string; id: string }>()

  constructor(
    private readonly schema: AnySyncSchema,
    private readonly appliers: Map<string, TableApplier>,
  ) {}

  #applier(tbl: string): TableApplier {
    const applier = this.appliers.get(tbl)
    if (!applier) throw new MissingApplierError(tbl)
    return applier
  }

  readonly tx: MutatorTx = {
    get: (tbl, id) => {
      const applier = this.#applier(tbl)
      const k = rowKey(tbl, id)
      if (this.#dels.has(k)) return null
      const buffered = this.#puts.get(k)
      if (buffered) return structuredClone(buffered.data)
      const row = applier.get(id)
      return row ? structuredClone(row) : null
    },
    list: (tbl) => {
      const applier = this.#applier(tbl)
      const merged = new Map<string, Record<string, unknown>>()
      for (const { id, data } of applier.list()) merged.set(id, structuredClone(data))
      for (const del of this.#dels.values()) if (del.tbl === tbl) merged.delete(del.id)
      for (const put of this.#puts.values()) if (put.tbl === tbl) merged.set(put.id, structuredClone(put.data))
      return [...merged].map(([id, data]) => ({ id, data }))
    },
    put: (tbl, id, data) => {
      // Schema validation first: a table outside the schema is a permanent
      // InvalidArgs on the server too, so fail fast. A schema table without a
      // collection only degrades (checked after).
      const stored = validateLocalRow(this.schema, tbl, id, data as Record<string, unknown>)
      this.#applier(tbl)
      const k = rowKey(tbl, id)
      this.#dels.delete(k)
      this.#puts.set(k, { tbl, id, data: stored })
    },
    del: (tbl, id) => {
      this.#applier(tbl)
      const k = rowKey(tbl, id)
      this.#puts.delete(k)
      this.#dels.set(k, { tbl, id })
    },
  }

  isEmpty(): boolean {
    return this.#puts.size === 0 && this.#dels.size === 0
  }

  puts(): Iterable<{ tbl: string; id: string; data: Record<string, unknown> }> {
    return this.#puts.values()
  }

  dels(): Iterable<{ tbl: string; id: string }> {
    return this.#dels.values()
  }
}

export function rowKey(tbl: string, id: string): string {
  return `${tbl}\u0000${id}`
}

/** The client mirror of the server's `validateRow`: parsed output in the overlay, or a permanent AppError. */
export function validateLocalRow(
  schema: AnySyncSchema,
  tbl: string,
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const tableSchema = (schema.tables as Record<string, TableSchema>)[tbl]
  if (!tableSchema) {
    throw new AppError('InvalidArgs', `table "${tbl}" is not defined in the schema`)
  }
  const result = tableSchema['~standard'].validate(data)
  if (result instanceof Promise) {
    void result.catch(() => {})
    throw new AppError('InvalidArgs', `table "${tbl}": async validation is not supported`)
  }
  if (result.issues) {
    throw new AppError('InvalidArgs', `invalid row ${tbl}/${id}: ${formatIssues(result.issues)}`)
  }
  return result.value as Record<string, unknown>
}
