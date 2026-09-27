import type { FilterValue } from '@cf-sync/protocol'
import { TABLE_NAME_RE } from '@cf-sync/protocol/internal'
import type { EngineRowStore } from './engine-core'

// Only identifier-like keys go into a JSON path; the rest match in JS alone.
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// SQLite identifiers are case-insensitive and table/field names are not, so
// the name carries both in hex rather than risk two filters sharing an index.
function hex(text: string): string {
  return Array.from(text, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}

/**
 * EngineRowStore over DO SQLite — the storage half of the shared WriteSet
 * (engine-core.ts). Parsed JSON is always a fresh object, satisfying the
 * private-copy contract.
 */
export class SqlRowStore implements EngineRowStore {
  constructor(private readonly sql: SqlStorage) {}

  /**
   * A filter over a field gets a partial expression index on first use
   * (ARCHITECTURE.md#mutation-processing): one table's rows, keyed by the
   * same json_extract text the query uses, so SQLite can match them. Without
   * it every filtered list scans and parses the whole table.
   */
  #ensureIndex(tbl: string, field: string): void {
    // Issued on every list rather than remembered: a no-op costs under a
    // microsecond, and a mutation that rolls back takes a new index with it.
    // tbl passed TABLE_NAME_RE and field FIELD_RE: both are safe inline.
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS rows_where_${hex(tbl)}_${hex(field)}
       ON rows (json_extract(data, '$.${field}')) WHERE tbl = '${tbl}'`,
    )
  }

  get(tbl: string, id: string): Record<string, unknown> | null {
    const rows = this.sql
      .exec<{ data: string }>(`SELECT data FROM rows WHERE tbl = ? AND id = ? AND deleted = 0`, tbl, id)
      .toArray()
    const row = rows[0]
    return row ? (JSON.parse(row.data) as Record<string, unknown>) : null
  }

  list(tbl: string, where?: Record<string, FilterValue>): Array<{ id: string; data: Record<string, unknown> }> {
    if (!TABLE_NAME_RE.test(tbl)) throw new Error(`invalid table name "${tbl}"`)
    // SQL is a prefilter: json_extract equality is looser than `===` (true
    // reads as 1, a JSON null as a missing key), so the WriteSet re-checks
    // every parsed row. The expression form here is what an index would cover.
    const clauses: string[] = []
    const params: Array<string | number> = []
    for (const [field, value] of Object.entries(where ?? {})) {
      if (!FIELD_RE.test(field)) continue
      this.#ensureIndex(tbl, field)
      const path = `json_extract(data, '$.${field}')`
      if (value === null) clauses.push(`${path} IS NULL`)
      else if (typeof value === 'number' && !Number.isFinite(value)) clauses.push('0')
      else {
        clauses.push(`${path} = ?`)
        params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
      }
    }
    const filter = clauses.map((c) => ` AND ${c}`).join('')
    const out: Array<{ id: string; data: Record<string, unknown> }> = []
    // tbl is inlined, not bound: a partial index is only usable when the
    // query's own WHERE repeats its `tbl = '...'` term as a literal.
    for (const row of this.sql.exec<{ id: string; data: string }>(
      `SELECT id, data FROM rows WHERE tbl = '${tbl}' AND deleted = 0${filter}`,
      ...params,
    )) {
      out.push({ id: row.id, data: JSON.parse(row.data) as Record<string, unknown> })
    }
    return out
  }

  put(tbl: string, id: string, data: Record<string, unknown>, version: number): void {
    this.sql.exec(
      `INSERT INTO rows (tbl, id, data, version, deleted) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (tbl, id) DO UPDATE SET data = excluded.data, version = excluded.version, deleted = 0`,
      tbl,
      id,
      JSON.stringify(data),
      version,
    )
  }

  del(tbl: string, id: string, version: number): number {
    const cursor = this.sql.exec(
      `UPDATE rows SET deleted = 1, version = ? WHERE tbl = ? AND id = ? AND deleted = 0`,
      version,
      tbl,
      id,
    )
    return cursor.rowsWritten
  }
}
