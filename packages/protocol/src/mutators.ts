import { z } from 'zod'
import type { AnySyncSchema, RowInputOf, RowOf, TableName } from './schema'
import type { StandardSchemaV1 } from './standard-schema'

/**
 * Thrown by mutators to reject a mutation permanently. The engine still
 * advances the client's last_mutation_id (DESIGN.md §6 invariant 2) and
 * reports the error back via mutationResults. Any other thrown error is
 * treated as transient: the transaction rolls back and the client retries.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export interface MutatorContext {
  clientId: string
}

/**
 * The authoritative view a mutator runs against. Reads see the mutation's own
 * buffered writes; writes are flushed to SQLite only if the mutator completes
 * without error. `put` takes the schema's *input* shape and stores the
 * validated output (defaults applied); `get`/`list` return the stored output
 * shape. `del`/`get`/`list` accept unknown tables at runtime so schema
 * migrations can read and clean up tables that left the schema — only `put`
 * is strict.
 */
export interface MutatorTx<S extends AnySyncSchema = AnySyncSchema> {
  get<K extends TableName<S>>(tbl: K, id: string): RowOf<S, K> | null
  list<K extends TableName<S>>(tbl: K): Array<{ id: string; data: RowOf<S, K> }>
  put<K extends TableName<S>>(tbl: K, id: string, data: RowInputOf<S, K>): void
  del(tbl: TableName<S>, id: string): void
}

export interface MutatorDef<S extends AnySyncSchema = AnySyncSchema, In = any, Out = In> {
  /**
   * Standard schema for the mutation's args. The server validates before
   * `apply` runs (invalid args are a permanent error that still advances the
   * LMID); a SyncClient constructed with the mutators validates at `mutate()`
   * time as a fail-fast. Omit for mutators that take no args.
   */
  args?: StandardSchemaV1<In, Out>
  apply(tx: MutatorTx<S>, args: Out, ctx: MutatorContext): void
}

/** Constraint-position alias; `any` keeps concrete registries assignable across generics. */
export type AnyMutators = Record<string, MutatorDef<any, any, any>>

/** The mutator registry accepted by the server engine for a given schema. */
export type MutatorsFor<S extends AnySyncSchema> = Record<string, MutatorDef<S, any, any>>

/**
 * The argument tuple `SyncClient.mutate` accepts for one mutator definition:
 * the args schema's *input* type when the mutator declares one (the wire
 * carries the caller's original args; the server's parse is authoritative),
 * nothing when it declares none, and an optional unknown for untyped clients.
 */
export type MutationArgs<Def> = 'args' extends keyof Def
  ? Def extends { args: StandardSchemaV1<infer In, any> }
    ? [args: In]
    : [args?: unknown]
  : []

/**
 * Declares the named, intent-based mutations for a schema — shared by server
 * (authoritative apply) and client (typed `mutate`, fail-fast validation).
 *
 * ```ts
 * export const mutators = defineMutators(schema, {
 *   ...crudMutators(schema),
 *   'issue.move': {
 *     args: z.object({ id: z.string(), column: z.string() }),
 *     apply: (tx, { id, column }) => {
 *       const issue = tx.get('issues', id)
 *       if (!issue) throw new AppError('NotFound', `issue ${id} does not exist`)
 *       tx.put('issues', id, { ...issue, column })
 *     },
 *   },
 * })
 * ```
 *
 * The intersection with `D` captures the literal definition types (so arg
 * schemas keep their exact input/output types for `mutate`), while the mapped
 * type contextually types each `apply` from its sibling `args` schema.
 */
export function defineMutators<S extends AnySyncSchema, A extends Record<string, any>, D>(
  schema: S,
  defs: {
    [K in keyof A]: {
      args?: StandardSchemaV1<any, A[K]>
      apply: (tx: MutatorTx<S>, args: A[K], ctx: MutatorContext) => void
    }
  } & D,
): D {
  void schema // participates in inference only; table validation happens in defineSchema
  const names = new Set(Object.keys(defs as AnyMutators))
  for (const [name, def] of Object.entries(defs as AnyMutators)) {
    if (name.length === 0) throw new Error('defineMutators: mutator names must be non-empty')
    if (name.split('.').some((segment) => segment.length === 0)) {
      throw new Error(`defineMutators: mutator name "${name}" has an empty dot-segment`)
    }
    // Dots namespace the `client.mutate` call tree (mutate.todos.clearCompleted),
    // so a name cannot be both a mutator and a namespace prefix of another.
    for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
      const prefix = name.slice(0, dot)
      if (names.has(prefix)) {
        throw new Error(
          `defineMutators: mutator "${prefix}" collides with the namespace of "${name}" — ` +
            `a name cannot be both a mutator and a prefix of another (rename one of them)`,
        )
      }
    }
    if (typeof def.apply !== 'function') {
      throw new Error(`defineMutators: mutator "${name}" has no apply function`)
    }
  }
  return defs
}

const crudTarget = {
  tbl: z.string().min(1),
  id: z.string().min(1),
}
const putArgsSchema = z.object({ ...crudTarget, data: z.record(z.string(), z.unknown()) })
const delArgsSchema = z.object(crudTarget)

/** `sync.put` args: a typed union over the schema's tables. */
export type CrudPutArgs<S extends AnySyncSchema> = {
  [K in TableName<S>]: { tbl: K; id: string; data: RowInputOf<S, K> }
}[TableName<S>]

/** `sync.del` args: any declared table (deleting is shape-free). */
export type CrudDelArgs<S extends AnySyncSchema> = { tbl: TableName<S>; id: string }

// A type alias, not an interface: aliases get implicit index signatures, so a
// bare `crudMutators(schema)` result is assignable wherever a mutator
// registry (`Record<string, MutatorDef>`) is expected — e.g. `defineApp`.
export type CrudMutators<S extends AnySyncSchema> = {
  'sync.put': { args: StandardSchemaV1<CrudPutArgs<S>, CrudPutArgs<S>>; apply(tx: MutatorTx<S>, args: CrudPutArgs<S>, ctx: MutatorContext): void }
  'sync.del': { args: StandardSchemaV1<CrudDelArgs<S>, CrudDelArgs<S>>; apply(tx: MutatorTx<S>, args: CrudDelArgs<S>, ctx: MutatorContext): void }
}

/**
 * Full-row last-write-wins CRUD as degenerate "intent" mutators (DESIGN.md §7)
 * — the mutations the TanStack DB collection adapter emits. Spread these into
 * your registry and add real intent-based mutators alongside. Row payloads
 * are validated against the table's schema by the engine's `put`.
 */
export function crudMutators<S extends AnySyncSchema>(schema: S): CrudMutators<S> {
  void schema // binds S; per-table row validation happens in the engine's put
  return {
    'sync.put': {
      args: putArgsSchema,
      apply: (tx: MutatorTx, args: { tbl: string; id: string; data: Record<string, unknown> }) =>
        tx.put(args.tbl, args.id, args.data),
    },
    'sync.del': {
      args: delArgsSchema,
      apply: (tx: MutatorTx, args: { tbl: string; id: string }) => tx.del(args.tbl, args.id),
    },
  } as unknown as CrudMutators<S>
}
