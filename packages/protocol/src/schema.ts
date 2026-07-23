import type { StandardSchemaV1 } from './standard-schema'

/**
 * Row payloads must be JSON objects, so table schemas are standard schemas
 * whose input and output are both plain records (a zod `z.object(...)` is the
 * expected shape).
 */
export type TableSchema = StandardSchemaV1<Record<string, unknown>, Record<string, unknown>>

export interface SyncSchema<Tables extends Record<string, TableSchema> = Record<string, TableSchema>> {
  readonly tables: Tables
}

/**
 * Constraint-position alias. Deliberately `any`-based: concrete schemas must
 * remain assignable in both directions across generic boundaries (method
 * bivariance handles MutatorTx), which `SyncSchema` with concrete table types
 * would block.
 */
export type AnySyncSchema = SyncSchema<Record<string, any>>

export type TableName<S extends AnySyncSchema> = keyof S['tables'] & string

/** The stored row shape for a table: the schema's output (defaults applied). */
export type RowOf<S extends AnySyncSchema, K extends TableName<S>> =
  S['tables'][K] extends StandardSchemaV1<any, infer Output>
    ? Output extends Record<string, unknown>
      ? Output
      : Record<string, unknown>
    : Record<string, unknown>

/** The writable row shape for a table: the schema's input (defaults omissible). */
export type RowInputOf<S extends AnySyncSchema, K extends TableName<S>> =
  S['tables'][K] extends StandardSchemaV1<infer Input, any>
    ? Input extends Record<string, unknown>
      ? Input
      : Record<string, unknown>
    : Record<string, unknown>

/** Table names must be identifier-like: they are quoted into error messages and R2 keys. */
export const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const MAX_ID_LENGTH = 256

/**
 * Declares the synced tables and their row schemas — the single source of
 * truth shared by server and client. The server validates every row write
 * against it (DESIGN.md §6a); collections infer their row types from it.
 *
 * Validation must be synchronous — mutations apply inside a synchronous
 * SQLite transaction. A schema whose validate returns a Promise (e.g. a zod
 * async refinement) is rejected at validation time as a permanent error.
 */
export function defineSchema<Tables extends Record<string, TableSchema>>(tables: Tables): SyncSchema<Tables> {
  for (const name of Object.keys(tables)) {
    if (!TABLE_NAME_RE.test(name)) {
      throw new Error(`defineSchema: invalid table name "${name}" (must match ${TABLE_NAME_RE})`)
    }
  }
  return { tables }
}
