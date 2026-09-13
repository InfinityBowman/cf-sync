import type { FilterValue } from '@cf-sync/protocol'
import type { EngineRowStore } from './engine-core'

// Only identifier-like keys go into a JSON path; the rest match in JS alone.
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * EngineRowStore over DO SQLite — the storage half of the shared WriteSet
 * (engine-core.ts). Parsed JSON is always a fresh object, satisfying the
 * private-copy contract.
 */
export class SqlRowStore implements EngineRowStore {
  constructor(private readonly sql: SqlStorage) {}

  get(tbl: string, id: string): Record<string, unknown> | null {
    const rows = this.sql
      .exec<{ data: string }>(`SELECT data FROM rows WHERE tbl = ? AND id = ? AND deleted = 0`, tbl, id)
      .toArray()
    const row = rows[0]
    return row ? (JSON.parse(row.data) as Record<string, unknown>) : null
  }

  list(tbl: string, where?: Record<string, FilterValue>): Array<{ id: string; data: Record<string, unknown> }> {
    // SQL is a prefilter: json_extract equality is looser than `===` (true
    // reads as 1, a JSON null as a missing key), so the WriteSet re-checks
    // every parsed row. The expression form here is what an index would cover.
    const clauses: string[] = []
    const params: Array<string | number> = [tbl]
    for (const [field, value] of Object.entries(where ?? {})) {
      if (!FIELD_RE.test(field)) continue
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
    for (const row of this.sql.exec<{ id: string; data: string }>(
      `SELECT id, data FROM rows WHERE tbl = ? AND deleted = 0${filter}`,
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
