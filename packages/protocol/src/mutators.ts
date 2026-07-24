import { z } from 'zod'
import type { AnySyncSchema, RowInputOf, RowOf, TableName } from './schema'
import type { StandardSchemaV1 } from './standard-schema'

/**
 * The codes the engine itself rejects mutations with, reserved alongside
 * app-defined `AppError` codes:
 *
 * - `InvalidArgs` — the mutation's args failed its `args` schema, or a row
 *   write failed the table schema / referenced an unknown table or bad id.
 * - `UnknownMutator` — no mutator by that name in the app's registry.
 * - `RowTooLarge` — a written row exceeds the per-row byte cap.
 *
 * All are permanent: the LMID advances, nothing is written. Apps may branch
 * on them via `MutationError.code` (client) or `result.error.code` (test
 * engine); pick different codes for your own `AppError`s.
 */
export type EngineErrorCode = 'InvalidArgs' | 'UnknownMutator' | 'RowTooLarge'

// Permanent errors advancing the LMID is DESIGN.md §6 invariant 2.
/**
 * Thrown by mutators to reject a mutation permanently. The engine discards
 * the mutation's writes but still advances the client's `last_mutation_id` in
 * the same transaction — a permanently rejected mutation is done, never
 * retried, never blocking the queue behind it — and the rejection surfaces on
 * the client as a `MutationError` carrying this `code`. Any other thrown
 * error is treated as transient: the transaction rolls back and the client
 * retries.
 *
 * `code` is app-defined (`NotFound`, `ReadOnly`, …) — the {@link EngineErrorCode}
 * values are reserved by the engine's own rejections.
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

/**
 * The third argument every mutator's `apply` receives: who is pushing the
 * mutation and which run this is. The same `apply` executes optimistically on
 * the client and authoritatively on the server, and the context is how a
 * mutator tells those runs apart.
 */
export interface MutatorContext<A = unknown> {
  /**
   * The stable id of the client that pushed the mutation — the `SyncClient`'s
   * own `clientId` in optimistic runs, the pushing socket's attested id on
   * the server, so both runs of one mutation see the same value.
   */
  clientId: string
  // Authorize verdicts and stamps are DESIGN.md §15.
  /**
   * The principal the worker's `authorize` hook stamped on the connection —
   * undefined when no authorize hook stamped one, and always undefined in
   * optimistic client runs (the client has no server verdict).
   */
  principal?: string
  /**
   * The verdict's context, validated against the registry's `authContext`
   * schema at connect. On the client this is the value the app passed as the
   * SyncClient `auth` option, if any.
   */
  auth?: A
  /**
   * True on the server's authoritative run, false in optimistic client runs.
   * Permission checks written as `if (ctx.authoritative && !allowed) throw`
   * enforce on the server while letting the optimistic apply proceed — a
   * server rejection rolls back through the normal permanent-error path.
   */
  authoritative: boolean
}

/**
 * The key under which a registry built by `defineMutators` carries the
 * `authContext` schema declared as its third argument. It lives on the
 * registry object itself as an enumerable symbol property (object spread
 * keeps it) because mutators are the schema's consumer; `defineApp` lifts it
 * onto the app definition for the server and client.
 */
export const AUTH_CONTEXT: unique symbol = Symbol.for('cf-sync.authContext')

/** Extracts the validated auth-context type a mutator registry declares, `unknown` when it declares none. */
export type AuthContextOf<M> = M extends { [AUTH_CONTEXT]: StandardSchemaV1<any, infer AC> } ? AC : unknown

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

/**
 * One named mutation: an optional args schema plus the `apply` function that
 * performs it. A mutator registry maps mutation names to values of this
 * shape; `defineMutators` builds one with everything typed from the schema.
 */
export interface MutatorDef<S extends AnySyncSchema = AnySyncSchema, In = any, Out = In> {
  /**
   * Standard schema for the mutation's args. The server validates before
   * `apply` runs (invalid args are a permanent error that still advances the
   * LMID); a SyncClient constructed with the mutators validates at `mutate()`
   * time as a fail-fast. Omit for mutators that take no args.
   */
  args?: StandardSchemaV1<In, Out>
  /**
   * The mutation itself. The same function runs twice — optimistically on the
   * client the moment `mutate` is called, authoritatively on the server when
   * the push arrives — so it must be deterministic: pass ids, timestamps, and
   * random values in as args, never compute them inside, or the server's
   * result will not match the local prediction. Throwing {@link AppError}
   * rejects the mutation permanently; any other throw is transient and the
   * mutation is retried.
   */
  apply(tx: MutatorTx<S>, args: Out, ctx: MutatorContext): void
}

// `any` keeps concrete registries assignable in constraint position across generics.
/**
 * Any mutator registry, whatever its schema and mutations — the bound to use
 * for generic helpers over a registry (`<M extends AnyMutators>`). Every
 * `defineMutators` result is assignable to it.
 */
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
 *
 * The optional third argument declares the shape of `ctx.auth` — the
 * connection-time context the app's `authorize` hook stamps on each socket.
 * Mutators are its consumer, so it is declared with them; `defineApp` picks
 * it up from the registry, the server validates each verdict's context
 * against it at connect (drift between authorize and mutators fails the
 * upgrade with 4401, not mid-mutation), and `ctx.auth` types from it:
 *
 * ```ts
 * const mutators = defineMutators(schema, {
 *   'study.delete': {
 *     args: z.object({ id: z.string() }),
 *     apply(tx, { id }, ctx) {
 *       if (ctx.authoritative && !ctx.auth?.writeAllowed)
 *         throw new AppError('ReadOnly', 'subscription lapsed')
 *       tx.del('studies', id)
 *     },
 *   },
 * }, { authContext: z.object({ role: z.enum(['owner', 'member']), writeAllowed: z.boolean() }) })
 * ```
 */
export function defineMutators<S extends AnySyncSchema, A extends Record<string, unknown>, D, AC>(
  schema: S,
  defs: {
    [K in keyof A]: {
      args?: StandardSchemaV1<any, A[K]>
      apply: (tx: MutatorTx<S>, args: A[K], ctx: MutatorContext<AC>) => void
    }
  } & D,
  opts: { authContext: StandardSchemaV1<any, AC> },
): D & { [AUTH_CONTEXT]: StandardSchemaV1<any, AC> }
export function defineMutators<S extends AnySyncSchema, A extends Record<string, unknown>, D>(
  schema: S,
  defs: {
    [K in keyof A]: {
      args?: StandardSchemaV1<any, A[K]>
      apply: (tx: MutatorTx<S>, args: A[K], ctx: MutatorContext) => void
    }
  } & D,
): D
// `A extends Record<string, unknown>` (not `any`): a mutator with no args
// schema has no inference site for A[K], so it falls back to the constraint —
// `unknown`, which the body must narrow, instead of a silent `any`.
export function defineMutators<S extends AnySyncSchema, A extends Record<string, unknown>, D>(
  schema: S,
  defs: {
    [K in keyof A]: {
      args?: StandardSchemaV1<any, A[K]>
      apply: (tx: MutatorTx<S>, args: A[K], ctx: MutatorContext<any>) => void
    }
  } & D,
  opts?: { authContext?: StandardSchemaV1<any, any> },
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
  if (opts?.authContext) {
    Object.defineProperty(defs, AUTH_CONTEXT, {
      value: opts.authContext,
      enumerable: true, // spread must carry it (defineApp spreads registries)
      configurable: true,
      writable: true,
    })
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
/**
 * The full-row CRUD pair — `sync.put` and `sync.del`, the mutations
 * collections emit for local `insert`/`update`/`delete` — that `defineApp`
 * adds to every registry unless `crud: false`. Typed against the schema:
 * `sync.put` args are a union over the declared tables, so direct
 * `mutate.sync.put(...)` calls type-check per table.
 */
export type CrudMutators<S extends AnySyncSchema> = {
  'sync.put': { args: StandardSchemaV1<CrudPutArgs<S>, CrudPutArgs<S>>; apply(tx: MutatorTx<S>, args: CrudPutArgs<S>, ctx: MutatorContext): void }
  'sync.del': { args: StandardSchemaV1<CrudDelArgs<S>, CrudDelArgs<S>>; apply(tx: MutatorTx<S>, args: CrudDelArgs<S>, ctx: MutatorContext): void }
}

// CRUD-as-degenerate-mutators is DESIGN.md §7.
/**
 * Full-row last-write-wins CRUD as degenerate "intent" mutators — the
 * mutations the TanStack DB collection adapter emits. `defineApp` includes
 * them automatically (opt out with `crud: false`); calling this directly is
 * only needed for hand-assembled registries. Row payloads are validated
 * against the table's schema by the engine's `put`.
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
