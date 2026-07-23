import type { AnySyncSchema } from './schema'
import type { AnyMutators, MutatorsFor, MutatorTx } from './mutators'

/**
 * One step in the app's schema-version history: how data stored under `from`
 * becomes data stored under `to`. Steps form a chain (each step's `from` is
 * the previous step's `to`), so a workspace that slept through several
 * deploys replays every step between its stored version and the current one.
 *
 * Omit `migrate` for additive changes — the stored version is restamped with
 * no data rewrite, and existing cursors stay valid.
 */
export interface SchemaMigration {
  from: string
  to: string
  /**
   * Rewrites rows through tx. All steps in a replay run against one write
   * buffer inside one transaction: later steps read earlier steps' writes,
   * everything commits atomically at a single new data version, and the *net
   * result* of the chain is validated against the current schema at commit —
   * intermediate shapes are transient, so shipped steps never need editing
   * when a later version reshapes the same table.
   */
  migrate?: (tx: MutatorTx) => void
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
  readonly version: string
  readonly schema: S
  readonly mutators: M
  readonly migrations: readonly SchemaMigration[]
}

/**
 * Declares the app: current schema version, tables (`defineSchema`), mutators
 * (`defineMutators`), and the ordered migration chain that carries old
 * workspaces forward.
 *
 * ```ts
 * export const app = defineApp({
 *   version: 'demo-2',
 *   schema,
 *   mutators,
 *   migrations: [
 *     { from: 'demo-1', to: 'demo-2', migrate: (tx) => { ... } },
 *   ],
 * })
 * ```
 *
 * The chain is validated here — contiguous, acyclic, ending at `version` — so
 * bumping the version without adding a migration step fails at startup in
 * both bundles, not silently at data-touch time.
 */
export function defineApp<S extends AnySyncSchema, M extends MutatorsFor<S>>(def: {
  version: string
  schema: S
  mutators: M
  migrations?: readonly SchemaMigration[]
}): AppDefinition<S, M> {
  const { version, schema, mutators } = def
  const migrations = def.migrations ?? []
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('defineApp: version must be a non-empty string')
  }
  const seen = new Set<string>()
  for (const [i, step] of migrations.entries()) {
    if (!step.from || !step.to) {
      throw new Error(`defineApp: migrations[${i}] must name both "from" and "to" versions`)
    }
    if (step.from === step.to) {
      throw new Error(`defineApp: migrations[${i}] migrates "${step.from}" to itself`)
    }
    if (i === 0) {
      seen.add(step.from)
    } else if (step.from !== migrations[i - 1]!.to) {
      throw new Error(
        `defineApp: migrations must chain — migrations[${i}] starts from "${step.from}" ` +
          `but the previous step ends at "${migrations[i - 1]!.to}"`,
      )
    }
    if (seen.has(step.to)) {
      throw new Error(`defineApp: migration chain revisits version "${step.to}"`)
    }
    seen.add(step.to)
    if (step.migrate !== undefined && typeof step.migrate !== 'function') {
      throw new Error(`defineApp: migrations[${i}].migrate must be a function when present`)
    }
  }
  const last = migrations[migrations.length - 1]
  if (last && last.to !== version) {
    throw new Error(
      `defineApp: the migration chain ends at "${last.to}" but version is "${version}" — ` +
        `when bumping the version, add a step { from: '${last.to}', to: '${version}' } `
        + `(with a migrate function if rows need rewriting)`,
    )
  }
  return { version, schema, mutators, migrations }
}

/**
 * The migration steps that carry a workspace stored at `storedVersion`
 * forward to `app.version`: empty when already current, a suffix of the chain
 * when the stored version appears in it, and an error otherwise (a rollback
 * deploy or a version that predates the declared history) — callers abort
 * rather than restamp data they cannot interpret.
 */
export function migrationPath(
  app: Pick<AppDefinition, 'version' | 'migrations'>,
  storedVersion: string,
): readonly SchemaMigration[] {
  if (storedVersion === app.version) return []
  const index = app.migrations.findIndex((step) => step.from === storedVersion)
  if (index === -1) {
    const chain = [
      ...(app.migrations.length > 0 ? [app.migrations[0]!.from] : []),
      ...app.migrations.map((s) => s.to),
    ]
    throw new Error(
      `no migration path from stored schema version "${storedVersion}" to "${app.version}"` +
        (chain.length > 0 ? ` (declared history: ${chain.join(' -> ')})` : ' (no migrations declared)') +
        ' — was this a rollback deploy, or is a migration step missing from defineApp?',
    )
  }
  return app.migrations.slice(index)
}
