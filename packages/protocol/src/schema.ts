import type { StandardSchemaV1 } from './standard-schema'

/**
 * Row payloads must be JSON objects, so table schemas are standard schemas
 * whose input and output are both plain records (a zod `z.object(...)` is the
 * expected shape).
 */
export type TableSchema = StandardSchemaV1<Record<string, unknown>, Record<string, unknown>>

/**
 * The schema container `defineSchema` produces: the declared tables, keyed by
 * name, each a standard schema for that table's row shape. Everything typed
 * derives from it — collection row types, `MutatorTx` reads and writes,
 * server-side row validation — which is why it threads through the generic
 * signatures as the `S` parameter.
 */
export interface SyncSchema<Tables extends Record<string, TableSchema> = Record<string, TableSchema>> {
  readonly tables: Tables
}

// Deliberately `any`-based: concrete schemas must remain assignable in both
// directions across generic boundaries (method bivariance handles MutatorTx),
// which `SyncSchema` with concrete table types would block.
/**
 * Any sync schema, whatever its tables — the bound to use when writing your
 * own generic helpers over a schema (`function report<S extends AnySyncSchema>`).
 * Every `defineSchema` result is assignable to it; constraining on `SyncSchema`
 * directly would reject concrete schemas at generic boundaries.
 */
export type AnySyncSchema = SyncSchema<Record<string, any>>

/**
 * The union of a schema's table names, as string literals — the valid first
 * argument to `tx.get`/`tx.put`/`tx.del`/`tx.list` and the key type for
 * collections.
 */
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

/**
 * The allowed table-name shape: identifier-like, a letter or underscore
 * followed by up to 63 letters, digits, or underscores. Table names are
 * quoted into error messages and R2 keys, so `defineSchema` throws on
 * anything else.
 */
export const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/**
 * The maximum row-id length, in UTF-16 code units. An id that is empty,
 * longer than this, or contains a NUL character makes any `tx` operation
 * targeting it reject permanently with the `InvalidArgs` engine error code.
 */
export const MAX_ID_LENGTH = 256

// Server-side row validation is ARCHITECTURE.md#mutation-processing.
/**
 * Declares the synced tables and their row schemas — the single source of
 * truth shared by server and client. The server validates every row write
 * against the table's schema before it commits; collections and `MutatorTx`
 * infer their row types from it.
 *
 * ```ts
 * const schema = defineSchema({
 *   issues: z.object({
 *     id: z.string(),
 *     title: z.string(),
 *     column: z.string().default('backlog'),
 *   }),
 *   labels: z.object({ id: z.string(), name: z.string() }),
 * })
 * ```
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
