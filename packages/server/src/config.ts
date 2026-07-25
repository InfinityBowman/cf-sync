import type { AnySyncSchema, AppDefinition } from '@cf-sync/protocol'

// Tombstone-compaction decision record: DESIGN.md D8.
/**
 * Tunes tombstone compaction, which runs on the workspace's periodic
 * maintenance alarm to keep deleted-row bookkeeping from growing forever.
 */
export interface CompactionConfig {
  /**
   * How many data versions of tombstones to keep; older ones are
   * hard-deleted on the compaction alarm (default 10 000). A client whose
   * cursor predates the youngest deleted tombstone can no longer catch up
   * incrementally and re-bootstraps on its next connect — larger retention
   * trades storage for fewer forced bootstraps of long-offline clients.
   */
  tombstoneRetentionVersions?: number
  /**
   * Milliseconds between maintenance-alarm runs (default 6 hours). The alarm
   * is shared with the R2 export: the DO schedules at the smaller of the two
   * configured intervals.
   */
  intervalMs?: number
  /**
   * Skips tombstone compaction entirely — tombstones accrue unbounded. The
   * maintenance alarm still runs when an R2 export is configured.
   */
  disabled?: boolean
}

/**
 * Streams the workspace's mutation log to an R2 bucket as ndjson objects on
 * the maintenance alarm — archive and analytics off the hot path. DO SQLite
 * stays the system of record (it has point-in-time recovery of its own); R2
 * covers everything beyond it. Exports are idempotent: object keys embed the
 * log-sequence range, so a re-export after a failed cursor update overwrites
 * the same object.
 */
export interface ExportConfig<Env = unknown> {
  /**
   * Resolves the R2 bucket from the worker env. Annotate the parameter to
   * type the whole DO's env: `(env: Env) => env.EXPORT_BUCKET`.
   */
  bucket: (env: Env) => R2Bucket
  /**
   * Milliseconds between export runs (default 5 minutes) — the archive's
   * worst-case staleness. Shares the maintenance alarm with compaction: the
   * DO schedules at the smaller of the two configured intervals.
   */
  intervalMs?: number
  /** Log entries per exported object. */
  maxBatchRows?: number
  /** Bound on objects written per maintenance run. */
  maxObjectsPerRun?: number
  /** Key prefix; objects land at `<prefix>/<workspaceId>/mutation-log/<range>.ndjson`. */
  prefix?: string
}

// Extension seam design: DESIGN.md §17.5; delivery gate: §15.
/**
 * What an extension's `init` receives: the workspace's SQLite handle, a
 * transaction wrapper, and the outbound delivery seam. `broadcast` and
 * `send` route through core's per-socket delivery gate, so the
 * defunct/expiry checks that guard every poke also guard the binary lane —
 * an extension cannot send to a socket core is already tearing down.
 */
export interface EngineExtensionContext {
  sql: SqlStorage
  /** Atomic multi-statement writes: everything inside `fn` commits together, or rolls back together on a throw. */
  transactionSync<T>(fn: () => T): T
  /** Sends to every ready socket (optionally excluding one, e.g. the sender of a relayed update). */
  broadcast(bytes: Uint8Array, opts?: { except?: WebSocket }): void
  send(ws: WebSocket, bytes: Uint8Array): void
}

/** Per-frame connection context for `onBinaryMessage` — the authorize verdict's stamps plus readiness. */
export interface EngineExtensionMessageContext {
  clientId: string
  principal?: string
  auth?: unknown
  ready: boolean
}

// Extension seam: DESIGN.md §17.5; sync invariant §6.3; import cycling §17.7.
/**
 * The binary-lane extension seam an add-on like `@cf-sync/yjs/server` plugs
 * into: one config slot, types only — core imports nothing from any
 * extension. `init` runs on every wake inside initialization (create tables
 * idempotently; a throw quarantines the workspace like any other init
 * failure). `onBinaryMessage` receives every binary frame from a
 * non-defunct, non-expired socket and must stay synchronous end-to-end,
 * like every DO WebSocket handler. `onExport`'s value lands in the admin
 * export under `extension`; an import that carries extension data is
 * applied via `onImport` (same transaction as the row swap) and then cycles
 * every socket with the refresh code 4300 instead of hot-swapping over live
 * sockets. `onReset` runs after reset wipes storage — recreate tables and
 * drop any in-memory state there. One slot, not an array: multiple
 * extensions would need a routing byte on every binary frame for a consumer
 * that doesn't exist yet.
 *
 * Config carries a *factory* (`() => EngineExtension`), invoked once per
 * workspace DO instance: instances of one class share an isolate, so a
 * single extension object would leak in-memory state (and its storage
 * binding) across workspaces.
 */
export interface EngineExtension {
  init(ctx: EngineExtensionContext): void
  onBinaryMessage(ws: WebSocket, bytes: Uint8Array, ctx: EngineExtensionMessageContext): void
  onAlarm?(): void
  onExport?(): unknown
  onImport?(data: unknown): void
  onReset?(): void
  onStats?(): Record<string, number>
}

/**
 * The sink for the engine's diagnostics. `message` arrives fully formatted
 * (including the `[cf-sync]` prefix); `detail` carries any associated error.
 * The default writes to `console[level]`.
 */
export type EngineLogger = (level: 'warn' | 'error', message: string, ...detail: unknown[]) => void

/**
 * What {@link createWorkspaceDO} takes: the shared app definition, plus
 * optional compaction, R2-export, and extension settings.
 */
export interface WorkspaceEngineConfig<S extends AnySyncSchema = AnySyncSchema, Env = unknown> {
  /**
   * The shared app definition (`defineApp`): version, table schemas, mutator
   * registry, and the schema-version migration chain — the same object every
   * client is constructed with. Every `tx.put` — from mutators, schema
   * migrations, and admin imports — is validated against the target table's
   * schema; the validated output (defaults applied) is what gets stored.
   *
   * When the DO wakes with data stored under an older version, the migration
   * chain from that version replays before any traffic: all
   * steps run against one write buffer, later steps read earlier steps'
   * writes, and everything commits atomically at a single new data version
   * together with the version restamp — `min_cursor_version` advances so
   * every pre-migration cursor re-bootstraps. A replay of restamp-only steps
   * (no rows written) keeps cursors valid. A stored version outside the
   * declared chain (e.g. a rollback deploy), or a throwing step, aborts
   * initialization: the DO serves nothing rather than serving old-shaped
   * data as the new version, and the next wake retries.
   *
   * Migration txs are deliberately loosely typed: rows read mid-chain have
   * whatever shape the previous step (or version) left, and tables removed
   * from the schema can still be listed and deleted. The chain's *net result*
   * is validated against the current schema at commit, so shipped steps never
   * need editing when a later version reshapes the same table.
   */
  app: AppDefinition<S>
  compaction?: CompactionConfig
  /** Stream the mutation log to R2 for archive/analytics — see {@link ExportConfig}. */
  export?: ExportConfig<Env>
  /**
   * Binary-lane extension factory (e.g. `yjsFields()` from
   * `@cf-sync/yjs/server`), called once per workspace DO instance so
   * extension state is never shared across workspaces — see
   * {@link EngineExtension}.
   */
  extension?: () => EngineExtension
  /**
   * Where the engine's diagnostics go — init failures, schema-drift
   * warnings, internal errors. Default: the console (visible in `wrangler
   * tail`). Inject to route them into your own logging pipeline.
   */
  logger?: EngineLogger
}
