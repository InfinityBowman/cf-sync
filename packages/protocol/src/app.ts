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
  P extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  readonly version: number
  readonly schema: S
  readonly mutators: M
  /** Ascending by `to`; consecutive versions (each step's `to` is the previous step's `to` + 1). */
  readonly migrations: readonly SchemaMigration[]
  // Auth-context validation at connect is DESIGN.md §15.4.
  /**
   * The `authContext` schema declared with the mutator registry
   * (`defineMutators`' third argument), lifted here so the server can
   * validate each authorize verdict's context at connect and the client can
   * fail-fast-validate its `auth` option.
   */
  readonly authContext?: StandardSchemaV1<any, any>
  // Presence design is DESIGN.md §16.
  /**
   * Schema for the app's ephemeral presence payload. Declaring
   * it enables `client.presence` / `usePresence`; the server validates every
   * inbound state against it before relaying, so peers' state reaches app
   * code as a checked, typed value. Unlike table schemas, changing it needs
   * NO version bump: presence is never stored, so drift only warns softly.
   * Prefer tolerant changes (add optional fields rather than reshaping) —
   * during a deploy window old and new bundles share the workspace, and
   * invalid peer state is dropped gracefully on both sides.
   *
   * The schema must parse its own output — plain object schemas, no
   * `transform`s: `presence.update` merges partials into the previously
   * *parsed* state and re-validates the result, and reconnect re-announces
   * parsed state, so output that fails input validation breaks both.
   * Enforced: the client round-trips the first successful parse and throws
   * a descriptive error at that first `set`/`initialPresence` if the schema
   * cannot re-parse what it produced.
   */
  readonly presence?: P
}

/**
 * The presence payload type of an app definition — what `presence.set` takes
 * and what peers' `state` carries. `never` when the app declares no presence
 * schema (so `presence.set` is uncallable at the type level, matching the
 * runtime throw).
 */
export type PresenceOf<A extends { presence?: StandardSchemaV1 | undefined }> =
  NonNullable<A['presence']> extends never
    ? never
    : StandardSchemaV1.InferOutput<NonNullable<A['presence']>>

/**
 * One peer's presence as apps consume it (`client.presence.peers`,
 * `usePresence`): identity is server-attested — `clientId`/`principal` are
 * stamped from the socket attachment, never taken from the payload — and
 * `state` is validated against the app's presence schema before relay.
 */
export interface PresencePeer<T = unknown> {
  clientId: string
  principal?: string
  state: T
  // The ghost window is DESIGN.md §16.3.
  /**
   * Local receipt time (`Date.now()`) of the update that produced `state` —
   * local clock, so it compares against `Date.now()`, never against other
   * machines. This is the staleness bound to render presence with: a
   * silently-dead peer lingers until TCP teardown surfaces (~75s+), so
   * claims like "X is editing this field" should fade on
   * `Date.now() - receivedAt`, not trust the entry forever.
   */
  receivedAt: number
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
export function defineApp<
  S extends AnySyncSchema,
  M extends MutatorsFor<S>,
  P extends StandardSchemaV1 | undefined = undefined,
>(def: {
  version: number
  schema: S
  mutators: M
  migrations?: { readonly [toVersion: number]: SchemaMigrationFn | null }
  presence?: P
  crud: false
}): AppDefinition<S, M, P>
export function defineApp<
  S extends AnySyncSchema,
  M extends MutatorsFor<S> = Record<never, never>,
  P extends StandardSchemaV1 | undefined = undefined,
>(def: {
  version: number
  schema: S
  mutators?: M
  migrations?: { readonly [toVersion: number]: SchemaMigrationFn | null }
  presence?: P
  crud?: true
}): AppDefinition<S, M & CrudMutators<S>, P>
export function defineApp<S extends AnySyncSchema>(def: {
  version: number
  schema: S
  mutators?: MutatorsFor<S>
  migrations?: { readonly [toVersion: number]: SchemaMigrationFn | null }
  presence?: StandardSchemaV1
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
  const app: {
    version: number
    schema: S
    mutators: AnyMutators
    migrations: SchemaMigration[]
    authContext?: StandardSchemaV1<any, any>
    presence?: StandardSchemaV1
  } = { version, schema, mutators, migrations }
  if (authContext !== undefined) app.authContext = authContext
  if (def.presence !== undefined) app.presence = def.presence
  return app
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
