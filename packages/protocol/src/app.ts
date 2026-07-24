import type { AnySyncSchema } from './schema'
import type { StandardSchemaV1 } from './standard-schema'
import { AUTH_CONTEXT, crudMutators, type AnyMutators, type CrudMutators, type MutatorsFor, type MutatorTx } from './mutators'

/**
 * Rewrites rows stored under version `to - 1` into the shape expected at
 * version `to`. All steps in a replay run against one write buffer inside one
 * transaction: later steps read earlier steps' writes, everything commits
 * atomically at a single new data version, and the *net result* of the chain
 * is validated against the current schema at commit — intermediate shapes are
 * transient, so shipped steps never need editing when a later version
 * reshapes the same table.
 */
export type SchemaMigrationFn = (tx: MutatorTx) => void

/**
 * One step in the app's schema-version history, normalized from the
 * `migrations` record passed to `defineApp`: how data stored under `to - 1`
 * becomes data stored under `to`. `migrate` is null for additive changes —
 * the stored version is restamped with no data rewrite, and existing cursors
 * stay valid.
 */
export interface SchemaMigration {
  to: number
  migrate: SchemaMigrationFn | null
}

/**
 * The complete definition of a synced app — version, table schemas, mutator
 * registry, and schema-version history — as one value shared verbatim by the
 * server (`createWorkspaceDO({ app })`) and every client
 * (`new SyncClient({ app })`). Bundling them makes "client and server
 * disagree about the schema or mutators" unrepresentable.
 */
export interface AppDefinition<
  S extends AnySyncSchema = AnySyncSchema,
  M extends AnyMutators = AnyMutators,
> {
  readonly version: number
  readonly schema: S
  readonly mutators: M
  /** Ascending by `to`; consecutive versions (each step's `to` is the previous step's `to` + 1). */
  readonly migrations: readonly SchemaMigration[]
  /**
   * The `authContext` schema declared with the mutator registry
   * (`defineMutators`' third argument), lifted here so the server can
   * validate each authorize verdict's context at connect and the client can
   * fail-fast-validate its `auth` option (DESIGN.md §15.4).
   */
  readonly authContext?: StandardSchemaV1<any, any>
}

/**
 * Declares the app: current schema version (a positive integer — start at 1,
 * bump by 1 for every schema change), tables (`defineSchema`), mutators
 * (`defineMutators`), and the migrations that carry old workspaces forward.
 *
 * `migrations` is keyed by the version each entry migrates *to*; the value is
 * either a rewrite function or `null` for a purely additive change (rows are
 * restamped, nothing is rewritten):
 *
 * ```ts
 * export const app = defineApp({
 *   version: 3,
 *   schema,
 *   mutators,
 *   migrations: {
 *     2: (tx) => { ... },  // 1 -> 2: rows need rewriting
 *     3: null,             // 2 -> 3: additive, no rewrite
 *   },
 * })
 * ```
 *
 * The keys must be consecutive integers ending at `version`, so bumping the
 * version without declaring what happens to existing data fails at startup in
 * both bundles, not silently at data-touch time. Old entries below the
 * versions still in the field may be dropped; a workspace stored below the
 * oldest declared entry re-raises the error at wake instead of restamping
 * data it cannot interpret.
 *
 * The full-row CRUD mutators (`sync.put` / `sync.del` — what collections emit
 * for local writes) are included automatically; `mutators` adds intent-based
 * mutations alongside them and may be omitted for a pure-CRUD app. Pass
 * `crud: false` for an intent-only registry — collections then refuse to
 * attach, and every write must go through a named mutator.
 */
export function defineApp<S extends AnySyncSchema, M extends MutatorsFor<S>>(def: {
  version: number
  schema: S
  mutators: M
  migrations?: { readonly [toVersion: number]: SchemaMigrationFn | null }
  crud: false
}): AppDefinition<S, M>
export function defineApp<S extends AnySyncSchema, M extends MutatorsFor<S> = Record<never, never>>(def: {
  version: number
  schema: S
  mutators?: M
  migrations?: { readonly [toVersion: number]: SchemaMigrationFn | null }
  crud?: true
}): AppDefinition<S, M & CrudMutators<S>>
export function defineApp<S extends AnySyncSchema>(def: {
  version: number
  schema: S
  mutators?: MutatorsFor<S>
  migrations?: { readonly [toVersion: number]: SchemaMigrationFn | null }
  crud?: boolean
}): AppDefinition<S, AnyMutators> {
  const { version, schema } = def
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`defineApp: version must be a positive integer (got ${JSON.stringify(version)})`)
  }
  if (def.crud === false && (!def.mutators || Object.keys(def.mutators).length === 0)) {
    throw new Error('defineApp: crud: false with no mutators declares an app nothing can write to')
  }
  // User entries win on name collision, so an explicit crudMutators spread
  // (or a hand-rolled sync.put) overrides the built-ins rather than duplicating.
  const mutators: AnyMutators =
    def.crud === false ? { ...def.mutators } : { ...crudMutators(schema), ...def.mutators }
  const migrations: SchemaMigration[] = []
  for (const key of Object.keys(def.migrations ?? {})) {
    const to = Number(key)
    const migrate = def.migrations![to as keyof typeof def.migrations] as SchemaMigrationFn | null
    if (!Number.isInteger(to) || to < 2) {
      throw new Error(
        `defineApp: migrations["${key}"] is not a valid target version — keys are the integer ` +
          `versions (>= 2) each migration produces`,
      )
    }
    if (to > version) {
      throw new Error(
        `defineApp: migrations[${to}] targets a version beyond the current one (${version}) — ` +
          `bump version to ${to} or remove the entry`,
      )
    }
    if (migrate !== null && typeof migrate !== 'function') {
      throw new Error(
        `defineApp: migrations[${to}] must be a migrate function, or null for an additive change`,
      )
    }
    migrations.push({ to, migrate })
  }
  migrations.sort((a, b) => a.to - b.to)
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1]!.to
    const next = migrations[i]!.to
    if (next !== prev + 1) {
      throw new Error(
        `defineApp: migrations must cover consecutive versions — found entries for ${prev} and ` +
          `${next} but nothing for ${prev + 1}`,
      )
    }
  }
  const last = migrations[migrations.length - 1]
  if (last && last.to !== version) {
    throw new Error(
      `defineApp: migrations end at ${last.to} but version is ${version} — when bumping the ` +
        `version, add an entry for each step (a migrate function if rows need rewriting, ` +
        `null if the change is additive): migrations: { ..., ${version}: null }`,
    )
  }
  // The registry carries its authContext schema under a symbol key (survives
  // the spread above); lift it onto the definition for server and client.
  const authContext = (mutators as Record<typeof AUTH_CONTEXT, StandardSchemaV1<any, any> | undefined>)[AUTH_CONTEXT]
  return authContext !== undefined
    ? { version, schema, mutators, migrations, authContext }
    : { version, schema, mutators, migrations }
}

/**
 * The migration steps that carry a workspace stored at `storedVersion`
 * forward to `app.version`: empty when already current, the declared steps
 * `storedVersion + 1 .. app.version` when all of them exist, and an error
 * otherwise (a rollback deploy, or a stored version older than the declared
 * history) — callers abort rather than restamp data they cannot interpret.
 */
export function migrationPath(
  app: Pick<AppDefinition, 'version' | 'migrations'>,
  storedVersion: number,
): readonly SchemaMigration[] {
  if (storedVersion === app.version) return []
  if (!Number.isInteger(storedVersion) || storedVersion > app.version) {
    throw new Error(
      `stored schema version ${storedVersion} is ahead of the deployed version ${app.version} — ` +
        `was this a rollback deploy?`,
    )
  }
  const steps = app.migrations.filter((step) => step.to > storedVersion)
  if (steps.length !== app.version - storedVersion) {
    const declared =
      app.migrations.length > 0
        ? `declared migrations cover ${app.migrations[0]!.to - 1} -> ${app.version}`
        : 'no migrations declared'
    throw new Error(
      `no migration path from stored schema version ${storedVersion} to ${app.version} ` +
        `(${declared}) — is a migration entry missing from defineApp?`,
    )
  }
  return steps
}
