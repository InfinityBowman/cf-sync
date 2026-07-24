import {
  AppError,
  CLOSE_AUTH_CONTEXT_INVALID,
  CLOSE_REFRESH,
  CLOSE_SUPERSEDED,
  CLOSE_UNAUTHORIZED,
  CLOSE_VERSION_NOT_SUPPORTED,
  MAX_ID_LENGTH,
  MAX_PRESENCE_BYTES,
  MAX_ROW_BYTES,
  TABLE_NAME_RE,
  migrationPath,
  type AnySyncSchema,
  type AppDefinition,
  type Cursor,
  type MutatorContext,
  type PatchOp,
} from '@cf-sync/protocol'
import {
  KEEPALIVE_PING,
  KEEPALIVE_PONG,
  MAX_PART_PATCH_BYTES,
  PROTOCOL_VERSION,
  chunkBySize,
  clientMsgSchema,
  formatIssues,
  jsonByteSize,
  truncateCloseReason,
  type ErrorCode,
  type HelloMsg,
  type Mutation,
  type MutationResult,
  type PokeEndMsg,
  type PokePartMsg,
  type PokeStartMsg,
  type PresenceMsg,
  type PresencePeersMsg,
  type PresenceUpdateMsg,
  type PushMsg,
  type ServerMsg,
} from '@cf-sync/protocol/internal'
import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import { WriteSet, validateRow, type EngineRowStore } from './engine-core'
import { presenceFingerprint, schemaFingerprint } from './fingerprint'
import { loadOrInitMeta, migrate, type Meta } from './storage'

/** Set by the worker routers so the DO can learn its own workspace id. */
export const WORKSPACE_HEADER = 'x-cf-sync-workspace'

// Stamp-forwarding design: DESIGN.md §15.3.
/**
 * Carries the authorize verdict's stamps from `createSyncFetch` to the DO.
 * The router strips any inbound value before setting its own, so it cannot
 * be spoofed from outside; the DO trusts whatever the router says, exactly
 * like `WORKSPACE_HEADER`.
 */
export const AUTH_HEADER = 'x-cf-sync-auth'

/** What the router serializes into `AUTH_HEADER` from an ok-verdict. */
export interface AuthStamps {
  principal?: string
  context?: unknown
  expiresAt?: number
}

/**
 * Serializes an authorize verdict's stamps into the value the router sets on
 * {@link AUTH_HEADER} — the counterpart of {@link decodeAuthStamps}, for
 * custom routers replacing `createSyncFetch`. Header values must be byte
 * strings, so the UTF-8 JSON is base64-encoded: principals and contexts with
 * any characters survive the hop.
 */
export function encodeAuthStamps(stamps: AuthStamps): string {
  const bytes = new TextEncoder().encode(JSON.stringify(stamps))
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin)
}

/**
 * Parses an {@link AUTH_HEADER} value back into the {@link AuthStamps} that
 * {@link encodeAuthStamps} serialized. The DO calls this at upgrade to read
 * the stamps the router forwarded; a custom router only needs it to inspect
 * its own header. Throws when the payload does not decode to an object.
 */
export function decodeAuthStamps(value: string): AuthStamps {
  const bin = atob(value)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('auth stamps must be an object')
  return parsed as AuthStamps
}

/**
 * Socket attachments cap at 2KB serialized (platform limit). The DO measures
 * the JSON size of the full attachment — clientId plus auth stamps — and
 * fails the upgrade loudly when it does not fit, rather than truncating.
 */
export const MAX_ATTACHMENT_BYTES = 2048

/**
 * Accept-then-close (DESIGN.md §15.2): a browser WebSocket cannot observe the
 * HTTP status of a failed upgrade — a 403 is indistinguishable from a network
 * error — so rejections complete the upgrade with a local pair and close it
 * with a policy code + reason the client can act on. The local pair initiates
 * the close itself, so the DO's close-reciprocation rule does not apply.
 */
export function rejectUpgrade(code: number, reason: string): Response {
  const pair = new WebSocketPair()
  pair[1].accept()
  pair[1].close(code, truncateCloseReason(reason))
  return new Response(null, { status: 101, webSocket: pair[0] })
}

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
}

const DEFAULT_TOMBSTONE_RETENTION = 10_000
const DEFAULT_COMPACTION_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_EXPORT_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_EXPORT_BATCH_ROWS = 5_000
const DEFAULT_EXPORT_MAX_OBJECTS = 20

const importSnapshotSchema = z.object({
  formatVersion: z.literal(1),
  schemaVersion: z.number().int().positive(),
  rows: z.array(
    z.object({
      tbl: z.string().min(1),
      id: z.string().min(1),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  /** Extension-contributed state (DESIGN.md §17.7); shape is the extension's own. */
  extension: z.unknown().optional(),
})

/** Per-connection state; lives in the socket attachment so it survives hibernation. */
interface Attachment {
  clientId: string
  /** True once hello succeeded; only ready sockets receive broadcasts. */
  ready: boolean
  /** The authorize verdict's principal (DESIGN.md §15.3). */
  principal?: string
  /** The verdict's context, validated against the app's authContext schema at upgrade. */
  auth?: unknown
  /**
   * Epoch ms past which the stamps are no longer trusted (§15.2). Checked at
   * the two synchronous points that matter: inbound frames (gates writes) and
   * poke fan-out (gates reads); past-due sockets close with 4300 so the
   * reconnect re-runs authorize.
   */
  expiresAt?: number
  /**
   * Set when the DO itself closes the socket (kick, supersede, expiry). A
   * close is not instantaneous — inbound frames already in flight still fire
   * webSocketMessage until the peer acks — and close must beat push (§15.6):
   * frames from a defunct socket are dropped, never processed. Only
   * DO-initiated closes set this; a frame racing a *client's* own close is
   * legitimate and still lands.
   */
  defunct?: true
}

const disconnectBodySchema = z.object({
  principal: z.string().optional(),
  clientId: z.string().optional(),
  mode: z.enum(['kick', 'refresh']).default('kick'),
  /** Kick close code; must stay in the app close-code space. Refresh is always 4300. */
  code: z.number().int().min(4000).max(4999).optional(),
  reason: z.string().optional(),
})

const PING = KEEPALIVE_PING
const PONG = KEEPALIVE_PONG
/** Close codes with no peer to reciprocate to (RFC 6455 reserved). */
const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015])

/**
 * EngineRowStore over DO SQLite — the storage half of the shared WriteSet
 * (engine-core.ts). Parsed JSON is always a fresh object, satisfying the
 * private-copy contract.
 */
class SqlRowStore implements EngineRowStore {
  constructor(private readonly sql: SqlStorage) {}

  get(tbl: string, id: string): Record<string, unknown> | null {
    const rows = this.sql
      .exec<{ data: string }>(`SELECT data FROM rows WHERE tbl = ? AND id = ? AND deleted = 0`, tbl, id)
      .toArray()
    const row = rows[0]
    return row ? (JSON.parse(row.data) as Record<string, unknown>) : null
  }

  list(tbl: string): Array<{ id: string; data: Record<string, unknown> }> {
    const out: Array<{ id: string; data: Record<string, unknown> }> = []
    for (const row of this.sql.exec<{ id: string; data: string }>(
      `SELECT id, data FROM rows WHERE tbl = ? AND deleted = 0`,
      tbl,
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

/**
 * What `createWorkspaceDO` returns: a Durable Object class to export from the
 * worker entry (named per the wrangler binding). Deliberately opaque — the
 * engine's surface is the sync protocol and the admin routes, not methods on
 * the instance.
 */
export type WorkspaceDOClass<Env = unknown> = new (
  ctx: DurableObjectState,
  env: Env,
) => DurableObject<Env>

/**
 * Builds the Workspace Durable Object class from the shared app definition —
 * the server half of the engine. Export the returned class from the worker
 * entry and bind it in wrangler with `new_sqlite_classes` (the engine
 * requires SQLite-backed storage; a class declared with `new_classes`
 * deploys fine and then fails at runtime on its first SQL access). Each
 * workspace id resolves to one instance holding that workspace's rows,
 * mutation log, and live sockets; traffic reaches it through
 * `createSyncFetch` and `createAdminFetch`/`workspaceAdmin`, never through
 * methods on the instance.
 *
 * @example
 * ```ts
 * // worker/worker.ts
 * import { createWorkspaceDO, createSyncFetch } from '@cf-sync/server'
 * import { app } from '../src/schema' // the same defineApp value the client uses
 *
 * export const WorkspaceDO = createWorkspaceDO({ app })
 *
 * export default {
 *   fetch: createSyncFetch({
 *     namespace: (env) => env.WORKSPACE,
 *     authorize: async (request, { workspaceId }) => {
 *       // Validate the session, check workspace membership.
 *       return true
 *     },
 *   }),
 * }
 * ```
 *
 * ```jsonc
 * // wrangler.jsonc
 * {
 *   "durable_objects": {
 *     "bindings": [{ "name": "WORKSPACE", "class_name": "WorkspaceDO" }]
 *   },
 *   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceDO"] }]
 * }
 * ```
 */
export function createWorkspaceDO<S extends AnySyncSchema, Env = unknown>(
  config: WorkspaceEngineConfig<S, Env>,
): WorkspaceDOClass<Env> {
  const maintenanceIntervalMs = Math.min(
    config.compaction?.intervalMs ?? DEFAULT_COMPACTION_INTERVAL_MS,
    config.export ? (config.export.intervalMs ?? DEFAULT_EXPORT_INTERVAL_MS) : Number.POSITIVE_INFINITY,
  )

  class WorkspaceDO extends DurableObject<Env> {
    #sql: SqlStorage
    #rows: SqlRowStore
    #meta!: Meta
    /**
     * Set when initialization failed (unloadable meta — e.g. a pre-numeric
     * stored schema version — a stored version outside the migration chain,
     * or a throwing migration step). A failed workspace must not brick its
     * own remedy: it serves nothing except `POST /admin/<id>/reset`, which
     * wipes storage and clears this. Everything else answers with the error
     * so operators see *why*; upgrades fail as HTTP 503, which clients treat
     * as "server offline" and keep retrying with backoff — they recover on
     * their own once the workspace is reset (or a fixed bundle deploys and
     * the next construction retries).
     */
    #initError: Error | null = null
    /**
     * This instance's extension, built by the config factory in
     * `#initExtension` (never shared: instances of one class colocate in an
     * isolate, and a shared object would mix workspaces' storage bindings
     * and in-memory state). Null until init succeeds — every use is behind
     * the `#initError` gate.
     */
    #extension: EngineExtension | null = null
    /**
     * Presence, keyed by clientId — in DO memory only, never persisted
     * (DESIGN.md §16.3): a storage write per cursor move would defeat
     * hibernation. Hibernation drops the map while sockets survive; the
     * constructor's presencePoll rebuilds it in one round-trip. Each entry
     * remembers its owning socket so a superseded socket's late close event
     * cannot wipe the reconnected client's fresh state.
     */
    #presence = new Map<string, { ws: WebSocket; principal?: string; state: unknown }>()
    // Since-start operational counters (reset on eviction; durable gauges come
    // from SQL in #stats). No wall-clock latency here: workers freeze Date.now
    // during synchronous execution, so honest latency must be measured by
    // clients or the observability platform.
    #counters = {
      startedAt: new Date().toISOString(),
      pushes: 0,
      mutationsApplied: 0,
      mutationsSkipped: 0,
      mutationErrors: 0,
      pokesSent: 0,
      framesSent: 0,
      lastFanout: 0,
    }

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env)
      this.#sql = ctx.storage.sql
      this.#rows = new SqlRowStore(this.#sql)
      // Keepalives answered by the runtime so idle sockets never wake the DO.
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
      // The constructor runs on every wake: surviving ready sockets mean
      // hibernation just dropped the presence map — ask clients to re-send
      // their state (§16.3). A cold start has no sockets, so this is free.
      if (config.app.presence) {
        const poll = JSON.stringify({ type: 'presencePoll' } satisfies ServerMsg)
        for (const socket of this.#readySockets()) this.#deliver(socket, [poll])
      }
      ctx.blockConcurrencyWhile(async () => {
        try {
          await this.#initialize()
        } catch (err) {
          this.#initError = err instanceof Error ? err : new Error(String(err))
          console.error('[cf-sync] workspace initialization failed; only admin reset is served', err)
        }
      })
    }

    async #initialize(): Promise<void> {
      migrate(this.#sql)
      const fingerprint = schemaFingerprint(config.app.schema)
      const presenceHash = presenceFingerprint(config.app.presence)
      this.#meta = loadOrInitMeta(this.#sql, config.app.version, fingerprint, presenceHash)
      if (this.#meta.schemaVersion !== config.app.version) {
        // The bump path restamps both hashes inside its transaction — a
        // version bump legitimately carries any shape change, so no drift
        // warning applies.
        this.#migrateAppSchema(fingerprint, presenceHash)
      } else if (this.#meta.presenceHash !== presenceHash) {
        // Presence drift is advisory (§16.1): ephemera is never stored, so a
        // shape change needs no version bump — warn softly (mid-deploy skew
        // should stay on the radar) and restamp. '' means the presence schema
        // is new (or the row predates the column): silent.
        if (this.#meta.presenceHash !== '') {
          console.warn(
            `[cf-sync] presence schema changed under schema version ${config.app.version}. ` +
              `Presence is ephemeral (never stored), so no version bump or migration is needed — ` +
              `but until every tab reloads, old and new bundles share this workspace: prefer ` +
              `tolerant changes (add optional fields rather than reshaping); invalid peer state ` +
              `is dropped gracefully on both sides.`,
          )
        }
        this.#sql.exec(`UPDATE meta SET presence_hash = ? WHERE id = 1`, presenceHash)
        this.#meta.presenceHash = presenceHash
      }
      if (this.#meta.schemaHash !== fingerprint) {
        // Same version, different table schemas: a forgotten version bump
        // (DESIGN.md §9 — every schema change requires one). Warn once per
        // change and restamp; a hard error here would brick workspaces on a
        // false positive (the fingerprint can shift with a zod upgrade).
        // '' predates the fingerprint column; backfill quietly.
        if (this.#meta.schemaHash !== '') {
          console.warn(
            `[cf-sync] table schemas changed under schema version ${config.app.version} ` +
              `(fingerprint ${this.#meta.schemaHash} -> ${fingerprint}). Every schema change ` +
              `requires a version bump: set version: ${config.app.version + 1} in defineApp and add ` +
              `migrations: { ${config.app.version + 1}: ... } (a migrate function if existing rows ` +
              `need backfilling, null if the change is additive). Without one, old bundles and ` +
              `cached rows keep being accepted as version ${config.app.version} and rows written ` +
              `before the change are never migrated.`,
          )
        }
        this.#sql.exec(`UPDATE meta SET schema_hash = ? WHERE id = 1`, fingerprint)
        this.#meta.schemaHash = fingerprint
      }
      // Extension init runs on every wake (idempotent DDL, in-memory state
      // rebuild); a throw quarantines the workspace like any init failure.
      this.#initExtension()
      if (this.#maintenanceEnabled() && (await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + maintenanceIntervalMs)
      }
    }

    /**
     * App-schema rollout (distinct from the engine's own storage migrations in
     * storage.ts). Replays the app's migration chain from the stored version
     * and restamps the stored schema version in one transaction; a throw rolls
     * back everything, so a failed migration is retried on the next wake
     * instead of being half-applied. A stored version outside the declared
     * chain throws before the transaction opens (migrationPath) — the DO
     * aborts initialization rather than restamp data it cannot interpret.
     */
    #migrateAppSchema(fingerprint: string, presenceHash: string): void {
      const from = this.#meta.schemaVersion
      const to = config.app.version
      const steps = migrationPath(config.app, from)
      let migratedVersion: number | null = null
      this.ctx.storage.transactionSync(() => {
        // One write buffer across the chain: later steps read earlier steps'
        // writes, and the net result is validated against the current schema
        // at flush (intermediate shapes are transient).
        const writes = new WriteSet(this.#rows, config.app.schema, true)
        for (const step of steps) step.migrate?.(writes.tx)
        const candidate = this.#meta.currentVersion + 1
        if (writes.flush(candidate) > 0) {
          migratedVersion = candidate
          // Rewritten rows are a new data version, and no cursor issued
          // before the migration may catch up from it — force bootstrap.
          this.#sql.exec(
            `UPDATE meta SET current_version = ?, min_cursor_version = ? WHERE id = 1`,
            candidate,
            candidate,
          )
        }
        // schema_version is a TEXT column (STRICT): bind the string form.
        this.#sql.exec(
          `UPDATE meta SET schema_version = ?, schema_hash = ?, presence_hash = ? WHERE id = 1`,
          String(to),
          fingerprint,
          presenceHash,
        )
        // Audit trail: the exported log explains the version jump.
        this.#sql.exec(
          `INSERT INTO mutation_log (version, client_id, mutation_id, name, args, result, created_at)
           VALUES (?, '$system', 0, '$schema.migrate', ?, 'ok', ?)`,
          migratedVersion,
          JSON.stringify({ from, to }),
          new Date().toISOString(),
        )
      })
      this.#meta.schemaVersion = to
      this.#meta.schemaHash = fingerprint
      this.#meta.presenceHash = presenceHash
      if (migratedVersion !== null) {
        this.#meta.currentVersion = migratedVersion
        this.#meta.minCursorVersion = migratedVersion
      }
    }

    /**
     * Builds this instance's extension from the config factory and binds it
     * to this instance's storage and delivery gate. Called on every wake and
     * again after admin reset (which wipes the extension's tables along with
     * everything else) — each call constructs a fresh extension, so `init`
     * is "wake": idempotent DDL, all in-memory state starting fresh.
     */
    #initExtension(): void {
      if (!config.extension) return
      this.#extension = config.extension()
      this.#extension.init({
        sql: this.#sql,
        transactionSync: (fn) => this.ctx.storage.transactionSync(fn),
        broadcast: (bytes, opts) => {
          for (const socket of this.#readySockets()) {
            if (socket === opts?.except) continue
            this.#deliver(socket, [bytes])
          }
        },
        send: (ws, bytes) => this.#deliver(ws, [bytes]),
      })
    }

    #maintenanceEnabled(): boolean {
      return !config.compaction?.disabled || config.export !== undefined
    }

    override async alarm(): Promise<void> {
      if (this.#initError) return // nothing to maintain; a successful reset re-arms the alarm
      try {
        if (!config.compaction?.disabled) this.#compact()
        this.#extension?.onAlarm?.()
        if (config.export) await this.#exportLog()
      } finally {
        if (this.#maintenanceEnabled()) {
          await this.ctx.storage.setAlarm(Date.now() + maintenanceIntervalMs)
        }
      }
    }

    /**
     * Ships mutation_log entries past the export cursor to R2 as ndjson.
     * Object keys embed the log_seq range, so a re-export after a failed
     * cursor update overwrites the same object — idempotent by construction.
     */
    async #exportLog(): Promise<void> {
      const cfg = config.export!
      const bucket = cfg.bucket(this.env)
      const batchRows = cfg.maxBatchRows ?? DEFAULT_EXPORT_BATCH_ROWS
      const maxObjects = cfg.maxObjectsPerRun ?? DEFAULT_EXPORT_MAX_OBJECTS
      const prefix = cfg.prefix ?? 'cf-sync'
      const workspace = this.#meta.workspaceId || this.ctx.id.toString()

      for (let i = 0; i < maxObjects; i++) {
        const rows = this.#sql
          .exec<{
            log_seq: number
            version: number | null
            client_id: string
            mutation_id: number
            name: string
            args: string
            result: string
            created_at: string
          }>(
            `SELECT log_seq, version, client_id, mutation_id, name, args, result, created_at
             FROM mutation_log WHERE log_seq > ? ORDER BY log_seq LIMIT ?`,
            this.#meta.lastExportedSeq,
            batchRows,
          )
          .toArray()
        if (rows.length === 0) return

        const startSeq = Number(rows[0]!.log_seq)
        const endSeq = Number(rows[rows.length - 1]!.log_seq)
        const pad = (n: number) => String(n).padStart(12, '0')
        const key = `${prefix}/${workspace}/mutation-log/${pad(startSeq)}-${pad(endSeq)}.ndjson`
        const body = `${rows
          .map((r) =>
            JSON.stringify({
              logSeq: Number(r.log_seq),
              version: r.version === null ? null : Number(r.version),
              clientId: r.client_id,
              mutationId: Number(r.mutation_id),
              name: r.name,
              args: JSON.parse(r.args) as unknown,
              result: r.result === 'ok' ? 'ok' : (JSON.parse(r.result) as unknown),
              createdAt: r.created_at,
            }),
          )
          .join('\n')}\n`

        await bucket.put(key, body)
        // Cursor advances only after the put succeeds; a crash in between
        // re-exports the identical range to the identical key.
        this.#sql.exec(`UPDATE meta SET last_exported_seq = ? WHERE id = 1`, endSeq)
        this.#meta.lastExportedSeq = endSeq
        if (rows.length < batchRows) return
      }
    }

    /**
     * Hard-deletes tombstones behind the retention horizon and advances the
     * minimum valid cursor to the youngest deleted tombstone: any client at
     * or past it already received every delete we discard.
     */
    #compact(): void {
      const retention = config.compaction?.tombstoneRetentionVersions ?? DEFAULT_TOMBSTONE_RETENTION
      const cutoff = this.#meta.currentVersion - retention
      if (cutoff <= 0) return
      const row = this.#sql
        .exec<{ v: number | null }>(`SELECT MAX(version) AS v FROM rows WHERE deleted = 1 AND version <= ?`, cutoff)
        .one()
      if (row.v === null) return
      const maxDeleted = Number(row.v)
      const newMin = Math.max(this.#meta.minCursorVersion, maxDeleted)
      this.ctx.storage.transactionSync(() => {
        this.#sql.exec(`DELETE FROM rows WHERE deleted = 1 AND version <= ?`, cutoff)
        this.#sql.exec(`UPDATE meta SET min_cursor_version = ? WHERE id = 1`, newMin)
      })
      this.#meta.minCursorVersion = newMin
    }

    override async fetch(request: Request): Promise<Response> {
      // A workspace whose initialization failed serves exactly one thing:
      // the admin reset that heals it. The failure message names the remedy,
      // so the remedy must not sit behind the failure.
      if (this.#initError) {
        const url = new URL(request.url)
        if (url.pathname.startsWith('/admin/')) {
          const op = url.pathname.slice('/admin/'.length)
          if (request.method === 'POST' && op === 'reset') return this.#handleAdmin('reset', request)
          return new Response(JSON.stringify({ error: `workspace unavailable: ${this.#initError.message}` }, null, 2), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
        // Upgrades fail as plain HTTP: clients see a failed connection and
        // keep their paced reconnect, recovering by themselves after a reset.
        return new Response(`workspace unavailable: ${this.#initError.message}`, { status: 503 })
      }
      this.#rememberWorkspaceId(request)
      const url = new URL(request.url)
      if (url.pathname.startsWith('/admin/')) {
        // Only our own worker routers can reach a DO; createAdminFetch
        // requires an authorize hook before forwarding here.
        return this.#handleAdmin(url.pathname.slice('/admin/'.length), request)
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('expected websocket upgrade', { status: 426 })
      }
      const clientId = new URL(request.url).searchParams.get('clientId')
      if (!clientId || clientId.length > 128) {
        return new Response('missing or invalid clientId', { status: 400 })
      }

      // Auth stamps from the router (DESIGN.md §15.3). Malformed stamps,
      // context that fails the app's authContext schema, and an attachment
      // over the 2KB budget all fail the upgrade with a permanent 4401: each
      // is an app configuration bug (authorize and mutators disagree), so
      // reconnecting cannot help and backoff would only hide it.
      const rawAuth = request.headers.get(AUTH_HEADER)
      let stamps: AuthStamps = {}
      if (rawAuth !== null) {
        try {
          stamps = decodeAuthStamps(rawAuth)
        } catch {
          return rejectUpgrade(CLOSE_AUTH_CONTEXT_INVALID, 'malformed auth stamps')
        }
      }
      let auth: unknown = stamps.context
      if (rawAuth !== null && config.app.authContext) {
        const result = config.app.authContext['~standard'].validate(stamps.context)
        if (result instanceof Promise) {
          void result.catch(() => {})
          return rejectUpgrade(CLOSE_AUTH_CONTEXT_INVALID, 'async authContext validation is not supported')
        }
        if (result.issues) {
          return rejectUpgrade(CLOSE_AUTH_CONTEXT_INVALID, `auth context: ${formatIssues(result.issues)}`)
        }
        auth = result.value
      }
      const attachment: Attachment = { clientId, ready: false }
      if (stamps.principal !== undefined) attachment.principal = stamps.principal
      if (auth !== undefined) attachment.auth = auth
      if (stamps.expiresAt !== undefined) attachment.expiresAt = stamps.expiresAt
      if (jsonByteSize(attachment) > MAX_ATTACHMENT_BYTES) {
        return rejectUpgrade(
          CLOSE_AUTH_CONTEXT_INVALID,
          `auth context exceeds the ${MAX_ATTACHMENT_BYTES}-byte attachment budget`,
        )
      }

      // Supersede rule (§15.3): a clientId's newest socket wins. The old one
      // is almost always a half-open zombie the client already abandoned;
      // closing it before accepting keeps a late edge-buffered frame from
      // being attributed to the reconnected client.
      for (const existing of this.ctx.getWebSockets()) {
        if ((existing.deserializeAttachment() as Attachment | null)?.clientId === clientId) {
          this.#closeSocket(existing, CLOSE_SUPERSEDED, 'superseded')
        }
      }

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment(attachment)
      return new Response(null, { status: 101, webSocket: client })
    }

    // Handlers below are intentionally synchronous end-to-end (DESIGN.md
    // invariant 3): no await between reading engine state and sending frames,
    // so per-socket frame order is FIFO relative to version advances.
    override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
      // Sockets can outlive a wake whose initialization failed (hibernation
      // preserves them); nothing behind this handler is safe without #meta.
      if (this.#initError) {
        this.#closeSocket(ws, 1011, 'workspace unavailable')
        return
      }
      const attachment = ws.deserializeAttachment() as Attachment
      // Close beats push (§15.6): a DO-initiated close (kick, supersede,
      // expiry) still delivers in-flight frames until the peer acks — drop
      // them instead of processing.
      if (attachment.defunct) return
      // Expired stamps gate writes (§15.2): close with refresh so the
      // reconnect re-runs authorize. Keepalive pings never reach here — the
      // runtime auto-responds without waking the DO.
      if (attachment.expiresAt !== undefined && Date.now() >= attachment.expiresAt) {
        this.#closeSocket(ws, CLOSE_REFRESH, 'auth-expired')
        return
      }
      try {
        if (typeof raw !== 'string') {
          // The binary lane (DESIGN.md §17.3) — same defunct/expiry gates as
          // text frames (checked above), routed to the extension, which stays
          // synchronous end-to-end like every other handler (invariant §6.3).
          if (!this.#extension) {
            this.#sendError(ws, 'BadMessage', 'binary frames are not supported')
            return
          }
          const msgCtx: EngineExtensionMessageContext = {
            clientId: attachment.clientId,
            ready: attachment.ready === true,
          }
          if (attachment.principal !== undefined) msgCtx.principal = attachment.principal
          if (attachment.auth !== undefined) msgCtx.auth = attachment.auth
          this.#extension.onBinaryMessage(ws, new Uint8Array(raw), msgCtx)
          return
        }
        let json: unknown
        try {
          json = JSON.parse(raw)
        } catch {
          this.#sendError(ws, 'BadMessage', 'invalid JSON')
          return
        }
        const parsed = clientMsgSchema.safeParse(json)
        if (!parsed.success) {
          this.#sendError(ws, 'BadMessage', 'unrecognized message shape')
          return
        }
        if (parsed.data.type === 'hello') this.#handleHello(ws, attachment, parsed.data)
        else if (parsed.data.type === 'presence') this.#handlePresence(ws, attachment, parsed.data)
        else this.#handlePush(ws, attachment, parsed.data)
      } catch (err) {
        console.error('cf-sync-engine internal error', err)
        this.#sendError(ws, 'Internal')
      }
    }

    override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
      this.#dropPresence(ws)
      // Reciprocate the close or clients observe an abnormal 1006.
      if (!RESERVED_CLOSE_CODES.has(code)) {
        try {
          ws.close(code, reason)
        } catch {
          // already closed
        }
      }
    }

    override async webSocketError(ws: WebSocket): Promise<void> {
      this.#dropPresence(ws)
    }

    #rememberWorkspaceId(request: Request): void {
      const name = request.headers.get(WORKSPACE_HEADER) ?? this.ctx.id.name ?? ''
      if (name && name !== this.#meta.workspaceId) {
        this.#sql.exec(`UPDATE meta SET workspace_id = ? WHERE id = 1`, name)
        this.#meta.workspaceId = name
      }
    }

    async #handleAdmin(op: string, request: Request): Promise<Response> {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body, null, 2), {
          status,
          headers: { 'content-type': 'application/json' },
        })

      switch (`${request.method} ${op}`) {
        case 'GET stats':
          return json(this.#stats())

        case 'GET export': {
          const rows = this.#sql
            .exec<{ tbl: string; id: string; data: string }>(
              `SELECT tbl, id, data FROM rows WHERE deleted = 0 ORDER BY tbl, id`,
            )
            .toArray()
            .map((r) => ({ tbl: r.tbl, id: r.id, data: JSON.parse(r.data) as Record<string, unknown> }))
          return json({
            formatVersion: 1,
            schemaVersion: config.app.version,
            workspaceId: this.#meta.workspaceId,
            exportedAt: new Date().toISOString(),
            version: this.#meta.currentVersion,
            rows,
            ...(this.#extension?.onExport ? { extension: this.#extension.onExport() } : {}),
          })
        }

        case 'POST import': {
          let parsed
          try {
            parsed = importSnapshotSchema.safeParse(await request.json())
          } catch {
            return json({ error: 'invalid JSON body' }, 400)
          }
          if (!parsed.success) return json({ error: 'invalid snapshot', detail: parsed.error.message }, 400)
          const snapshot = parsed.data
          if (snapshot.schemaVersion !== config.app.version) {
            return json(
              { error: `snapshot is schema version ${snapshot.schemaVersion}, server is ${config.app.version}` },
              400,
            )
          }
          // Imported rows go through the same schema validation as mutator
          // writes; what lands in storage is the parsed output.
          const importRows: Array<{ tbl: string; id: string; data: Record<string, unknown> }> = []
          for (const row of snapshot.rows) {
            if (!TABLE_NAME_RE.test(row.tbl) || row.id.length > MAX_ID_LENGTH) {
              return json({ error: `invalid row target ${row.tbl}/${row.id}` }, 400)
            }
            let data: Record<string, unknown>
            try {
              data = validateRow(config.app.schema, row.tbl, row.id, row.data)
            } catch (err) {
              if (err instanceof AppError) return json({ error: err.message }, 400)
              throw err
            }
            if (jsonByteSize(data) > MAX_ROW_BYTES) {
              return json({ error: `row ${row.tbl}/${row.id} exceeds ${MAX_ROW_BYTES} bytes` }, 400)
            }
            importRows.push({ tbl: row.tbl, id: row.id, data })
          }
          // Extension state (e.g. §17 fields) restores through the same
          // import. Carrying it without an extension configured would drop
          // data silently — refuse instead.
          const hasExtensionData = snapshot.extension !== undefined
          if (hasExtensionData && !this.#extension?.onImport) {
            return json({ error: 'snapshot carries extension state but no extension with onImport is configured' }, 400)
          }
          // Full state replace at a single new version. Every existing cursor
          // is invalidated (min_cursor_version = new version): live clients
          // get the reset poke below; reconnecting ones reset at hello.
          const version = this.#meta.currentVersion + 1
          try {
            this.ctx.storage.transactionSync(() => {
              this.#sql.exec(`DELETE FROM rows`)
              for (const row of importRows) {
                this.#sql.exec(
                  `INSERT INTO rows (tbl, id, data, version, deleted) VALUES (?, ?, ?, ?, 0)`,
                  row.tbl,
                  row.id,
                  JSON.stringify(row.data),
                  version,
                )
              }
              // Same transaction as the row swap: a bad extension payload
              // rolls back the whole import.
              if (hasExtensionData) this.#extension!.onImport!(snapshot.extension)
              this.#sql.exec(`UPDATE meta SET current_version = ?, min_cursor_version = ? WHERE id = 1`, version, version)
            })
          } catch (err) {
            return json({ error: `import failed: ${err instanceof Error ? err.message : String(err)}` }, 400)
          }
          this.#meta.currentVersion = version
          this.#meta.minCursorVersion = version
          if (hasExtensionData) {
            // §17.7: clients only re-GET fields on ready *transitions*, so an
            // import carrying extension state cycles every socket with a
            // refresh instead of hot-swapping rows over live sockets — one
            // close keeps both planes consistent. The reconnect re-bootstraps
            // rows at hello (min_cursor_version advanced) and re-GETs fields.
            for (const socket of this.ctx.getWebSockets()) {
              this.#closeSocket(socket, CLOSE_REFRESH, 'import')
            }
          } else {
            this.#sendPoke(this.#readySockets(), {
              baseCursor: null,
              patch: [{ op: 'clear' }, ...this.#snapshotPatch()],
            })
          }
          return json({ imported: snapshot.rows.length, version })
        }

        case 'POST reset': {
          // Wipe the workspace and start a new history: fresh backendId, so
          // every surviving cursor is rejected. Connected clients converge via
          // the clear poke (a clear poke applies from any base). Also the one
          // op that heals an init-failed workspace, where #meta was never
          // assigned — recover the name from the routing header instead.
          const workspaceId =
            (this.#meta as Meta | undefined)?.workspaceId ||
            request.headers.get(WORKSPACE_HEADER) ||
            this.ctx.id.name ||
            ''
          await this.ctx.storage.deleteAll()
          migrate(this.#sql)
          this.#meta = loadOrInitMeta(
            this.#sql,
            config.app.version,
            schemaFingerprint(config.app.schema),
            presenceFingerprint(config.app.presence),
          )
          this.#initError = null
          if (workspaceId) {
            this.#sql.exec(`UPDATE meta SET workspace_id = ? WHERE id = 1`, workspaceId)
            this.#meta.workspaceId = workspaceId
          }
          // deleteAll took the extension's tables with it: re-init (fresh
          // DDL + in-memory state), then let the extension observe the reset.
          this.#initExtension()
          this.#extension?.onReset?.()
          if (this.#maintenanceEnabled()) {
            await this.ctx.storage.setAlarm(Date.now() + maintenanceIntervalMs)
          }
          this.#sendPoke(this.#readySockets(), { baseCursor: null, patch: [{ op: 'clear' }] })
          return json({ backendId: this.#meta.backendId })
        }

        case 'POST disconnect': {
          // Revoke or refresh live sessions (DESIGN.md §15.5). No selector
          // means all sockets; given selectors must all match. kick closes
          // permanently (4403 or the given code), refresh closes with 4300 so
          // clients reconnect through a fresh authorize run.
          let parsed
          try {
            const text = await request.text()
            parsed = disconnectBodySchema.safeParse(text.trim() === '' ? {} : JSON.parse(text))
          } catch {
            return json({ error: 'invalid JSON body' }, 400)
          }
          if (!parsed.success) return json({ error: 'invalid disconnect request', detail: parsed.error.message }, 400)
          const { principal, clientId, mode, code, reason } = parsed.data
          const closeCode = mode === 'refresh' ? CLOSE_REFRESH : (code ?? CLOSE_UNAUTHORIZED)
          const closeReason = truncateCloseReason(reason ?? mode)
          let disconnected = 0
          // Synchronous walk (invariant §6.3): the awaits above finished
          // before any socket state is read.
          for (const socket of this.ctx.getWebSockets()) {
            const attachment = socket.deserializeAttachment() as Attachment | null
            if (!attachment) continue
            if (principal !== undefined && attachment.principal !== principal) continue
            if (clientId !== undefined && attachment.clientId !== clientId) continue
            this.#closeSocket(socket, closeCode, closeReason)
            disconnected++
          }
          return json({ disconnected })
        }

        default:
          return json({ error: `unknown admin operation "${request.method} ${op}"` }, 404)
      }
    }

    #stats(): Record<string, unknown> {
      const rowCounts = this.#sql
        .exec<{ live: number; tombstones: number }>(
          `SELECT
             COUNT(*) FILTER (WHERE deleted = 0) AS live,
             COUNT(*) FILTER (WHERE deleted = 1) AS tombstones
           FROM rows`,
        )
        .one()
      const logCount = this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM mutation_log`).one()
      const clientCount = this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM clients`).one()
      return {
        workspaceId: this.#meta.workspaceId,
        backendId: this.#meta.backendId,
        schemaVersion: config.app.version,
        currentVersion: this.#meta.currentVersion,
        minCursorVersion: this.#meta.minCursorVersion,
        lastExportedSeq: this.#meta.lastExportedSeq,
        rows: { live: Number(rowCounts.live), tombstones: Number(rowCounts.tombstones) },
        mutationLogEntries: Number(logCount.n),
        knownClients: Number(clientCount.n),
        databaseSizeBytes: this.#sql.databaseSize,
        connections: {
          total: this.ctx.getWebSockets().length,
          ready: this.#readySockets().length,
          presence: this.#presence.size,
        },
        counters: { ...this.#counters },
        ...(this.#extension?.onStats ? { extension: this.#extension.onStats() } : {}),
      }
    }

    #handleHello(ws: WebSocket, attachment: Attachment, msg: HelloMsg): void {
      if (msg.protocolVersion !== PROTOCOL_VERSION || msg.schemaVersion !== config.app.version) {
        this.#sendError(
          ws,
          'VersionNotSupported',
          `server speaks protocol ${PROTOCOL_VERSION}, schema version ${config.app.version}`,
        )
        this.#closeSocket(ws, CLOSE_VERSION_NOT_SUPPORTED, 'VersionNotSupported')
        return
      }
      const lmid = this.#touchClient(attachment.clientId)
      const cursor = msg.cursor
      const valid =
        cursor !== null &&
        cursor.backendId === this.#meta.backendId &&
        cursor.version >= this.#meta.minCursorVersion &&
        cursor.version <= this.#meta.currentVersion
      // Reset is the bootstrap path, not an error (DESIGN.md D7): stale or
      // unknown cursors get `clear` + full snapshot.
      const patch: PatchOp[] = valid
        ? this.#patchSince(cursor.version)
        : [{ op: 'clear' }, ...this.#snapshotPatch()]
      this.#sendPoke([ws], {
        baseCursor: valid ? cursor : null,
        patch,
        lastMutationIdChanges: { [attachment.clientId]: lmid },
      })
      ws.serializeAttachment({ ...attachment, ready: true } satisfies Attachment)
      if (config.app.presence) {
        // Snapshot so late joiners render peers immediately (§16.2). Sent
        // even when empty: receipt is the client's re-announce trigger. After
        // a hibernation wake this can be sparse until poll replies relay — a
        // recorded decision (§16.3); presence is eventually-correct.
        const peers: PresencePeersMsg['peers'] = []
        for (const [clientId, entry] of this.#presence) {
          if (clientId === attachment.clientId) continue
          const peer: PresencePeersMsg['peers'][number] = { clientId, state: entry.state }
          if (entry.principal !== undefined) peer.principal = entry.principal
          peers.push(peer)
        }
        this.#deliver(ws, [JSON.stringify({ type: 'presencePeers', peers } satisfies PresencePeersMsg)])
      }
    }

    /**
     * Set/clear the sender's presence and relay it (DESIGN.md §16.2). Payload
     * is client-claimed but schema-validated; identity is server-attested —
     * clientId/principal come from the attachment, so a client cannot
     * impersonate another user's presence. Invalid or oversized states are
     * rejected with an error frame (never truncated or coerced) and the
     * socket stays open.
     */
    #handlePresence(ws: WebSocket, attachment: Attachment, msg: PresenceMsg): void {
      const schema = config.app.presence
      if (!schema) {
        this.#sendError(ws, 'PresenceInvalid', 'the app declares no presence schema')
        return
      }
      if (!attachment.ready) {
        this.#sendError(ws, 'PresenceInvalid', 'presence before hello')
        return
      }
      let state: unknown = null
      if (msg.state !== null && msg.state !== undefined) {
        if (jsonByteSize(msg.state) > MAX_PRESENCE_BYTES) {
          this.#sendError(ws, 'PresenceInvalid', `presence state exceeds ${MAX_PRESENCE_BYTES} bytes`)
          return
        }
        const result = schema['~standard'].validate(msg.state)
        if (result instanceof Promise) {
          void result.catch(() => {})
          this.#sendError(ws, 'PresenceInvalid', 'async presence validation is not supported')
          return
        }
        if (result.issues) {
          this.#sendError(ws, 'PresenceInvalid', formatIssues(result.issues))
          return
        }
        // Peers receive the parsed output (defaults applied) — the same
        // shape the presence schema types promise.
        state = result.value
      }
      if (state === null) {
        if (!this.#presence.delete(attachment.clientId)) return // clearing nothing: relay nothing
      } else {
        this.#presence.set(attachment.clientId, { ws, principal: attachment.principal, state })
      }
      this.#relayPresence(ws, attachment.clientId, attachment.principal, state)
    }

    /** Fan a peer's state change out to every ready socket except its own. */
    #relayPresence(from: WebSocket | null, clientId: string, principal: string | undefined, state: unknown): void {
      const update: PresenceUpdateMsg = { type: 'presence', clientId, state }
      if (principal !== undefined) update.principal = principal
      const frame = JSON.stringify(update)
      for (const socket of this.#readySockets()) {
        if (socket === from) continue
        this.#deliver(socket, [frame])
      }
    }

    /**
     * Socket teardown half of presence (§16.3): remove the entry and
     * broadcast the null. Ownership check: after a supersede, the old
     * socket's close event can land *after* the new socket announced — an
     * entry owned by a different socket is the reconnected client's fresh
     * state, not ours to wipe.
     */
    #dropPresence(ws: WebSocket): void {
      if (!config.app.presence) return
      for (const [clientId, entry] of this.#presence) {
        if (entry.ws !== ws) continue
        this.#presence.delete(clientId)
        this.#relayPresence(ws, clientId, entry.principal, null)
        return
      }
    }

    #handlePush(ws: WebSocket, attachment: Attachment, msg: PushMsg): void {
      if (!attachment.ready) {
        this.#sendError(ws, 'PushInvalid', 'push before hello')
        return
      }
      const { clientId } = attachment
      this.#counters.pushes++
      const startVersion = this.#meta.currentVersion
      const startLmid = this.#lastMutationId(clientId)
      let lmid = startLmid
      const results: MutationResult[] = []

      for (const mutation of msg.mutations) {
        const expected = lmid + 1
        if (mutation.id < expected) {
          this.#counters.mutationsSkipped++
          continue // duplicate delivery — idempotent skip
        }
        if (mutation.id > expected) {
          // A gap means the client's sequence is out of sync; nothing at or
          // after the gap is safe to apply. Mutations before it stay applied.
          this.#sendError(ws, 'PushInvalid', `expected mutation ${expected}, got ${mutation.id}`)
          break
        }
        const error = this.#applyMutation(attachment, mutation)
        if (error) this.#counters.mutationErrors++
        else this.#counters.mutationsApplied++
        results.push(error ? { id: mutation.id, error } : { id: mutation.id })
        lmid = mutation.id
      }

      if (lmid === startLmid) {
        // Pure duplicates (or an immediate gap): nothing changed. Re-confirm
        // the current LMID to the origin so a replayed outbox settles.
        this.#sendPoke([ws], {
          baseCursor: this.#cursor(),
          patch: [],
          lastMutationIdChanges: { [clientId]: lmid },
        })
        return
      }

      const patch = this.#patchSince(startVersion)
      // Data changes fan out to everyone; LMID-only advances (app errors,
      // no-op mutations) concern only the origin. Data versions only move
      // when rows change, so other clients' cursors stay aligned.
      const recipients = patch.length > 0 ? this.#readySockets() : [ws]
      this.#sendPoke(recipients, {
        baseCursor: { backendId: this.#meta.backendId, version: startVersion },
        patch,
        lastMutationIdChanges: { [clientId]: lmid },
        mutationResults: results,
      })
    }

    /**
     * Applies one mutation. Returns the permanent app error, if any. The LMID
     * advance, the mutation-log append, and the data effects commit in one
     * SQLite transaction; permanent errors advance the LMID with no data
     * effects; transient errors throw and roll everything back.
     */
    #applyMutation(attachment: Attachment, mutation: Mutation): { code: string; message: string } | undefined {
      const { clientId } = attachment
      const mutator = config.app.mutators[mutation.name]
      const ctx: MutatorContext = {
        clientId,
        principal: attachment.principal,
        auth: attachment.auth,
        authoritative: true,
      }
      let appError: { code: string; message: string } | undefined
      let committedVersion: number | null = null

      this.ctx.storage.transactionSync(() => {
        let wroteVersion: number | null = null
        if (!mutator) {
          // Unknown mutator names are permanent: schemaVersion matched at
          // hello, so this is a registry bug, and retrying can never succeed.
          appError = { code: 'UnknownMutator', message: `no mutator named "${mutation.name}"` }
        } else {
          const writes = new WriteSet(this.#rows, config.app.schema)
          try {
            // Args are validated (and parsed: defaults applied) before apply
            // runs; invalid args are permanent — retrying identical args can
            // never succeed.
            let args: unknown = mutation.args
            if (mutator.args) {
              const result = mutator.args['~standard'].validate(args)
              if (result instanceof Promise) {
                void result.catch(() => {})
                throw new AppError('InvalidArgs', `mutator "${mutation.name}": async args validation is not supported`)
              }
              if (result.issues) {
                throw new AppError('InvalidArgs', `invalid args for "${mutation.name}": ${formatIssues(result.issues)}`)
              }
              args = result.value
            }
            mutator.apply(writes.tx, args, ctx)
            const candidate = this.#meta.currentVersion + 1
            if (writes.flush(candidate) > 0) wroteVersion = candidate
          } catch (err) {
            if (err instanceof AppError) {
              appError = { code: err.code, message: err.message }
            } else {
              throw err // transient: roll back, client retries the whole push
            }
          }
        }
        if (wroteVersion !== null) {
          this.#sql.exec(`UPDATE meta SET current_version = ? WHERE id = 1`, wroteVersion)
        }
        this.#sql.exec(
          `UPDATE clients SET last_mutation_id = ?, last_seen_at = ? WHERE client_id = ?`,
          mutation.id,
          new Date().toISOString(),
          clientId,
        )
        this.#sql.exec(
          `INSERT INTO mutation_log (version, client_id, mutation_id, name, args, result, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          wroteVersion,
          clientId,
          mutation.id,
          mutation.name,
          JSON.stringify(mutation.args ?? null),
          appError ? JSON.stringify(appError) : 'ok',
          new Date().toISOString(),
        )
        committedVersion = wroteVersion
      })

      // In-memory meta updates only after the transaction commits, so a
      // rollback can never leave memory ahead of storage.
      if (committedVersion !== null) this.#meta.currentVersion = committedVersion
      return appError
    }

    #touchClient(clientId: string): number {
      this.#sql.exec(
        `INSERT INTO clients (client_id, last_mutation_id, last_seen_at) VALUES (?, 0, ?)
         ON CONFLICT (client_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        clientId,
        new Date().toISOString(),
      )
      return this.#lastMutationId(clientId)
    }

    #lastMutationId(clientId: string): number {
      const rows = this.#sql
        .exec<{ last_mutation_id: number }>(`SELECT last_mutation_id FROM clients WHERE client_id = ?`, clientId)
        .toArray()
      return rows.length ? Number(rows[0]!.last_mutation_id) : 0
    }

    #patchSince(version: number): PatchOp[] {
      const ops: PatchOp[] = []
      for (const row of this.#sql.exec<{ tbl: string; id: string; data: string; deleted: number }>(
        `SELECT tbl, id, data, deleted FROM rows WHERE version > ? ORDER BY version`,
        version,
      )) {
        ops.push(
          Number(row.deleted)
            ? { op: 'del', tbl: row.tbl, id: row.id }
            : { op: 'put', tbl: row.tbl, id: row.id, value: JSON.parse(row.data) as Record<string, unknown> },
        )
      }
      return ops
    }

    #snapshotPatch(): PatchOp[] {
      const ops: PatchOp[] = []
      for (const row of this.#sql.exec<{ tbl: string; id: string; data: string }>(
        `SELECT tbl, id, data FROM rows WHERE deleted = 0 ORDER BY tbl, id`,
      )) {
        ops.push({ op: 'put', tbl: row.tbl, id: row.id, value: JSON.parse(row.data) as Record<string, unknown> })
      }
      return ops
    }

    #cursor(): Cursor {
      return { backendId: this.#meta.backendId, version: this.#meta.currentVersion }
    }

    #readySockets(): WebSocket[] {
      return this.ctx.getWebSockets().filter((socket) => {
        const attachment = socket.deserializeAttachment() as Attachment | null
        return attachment?.ready === true && attachment.defunct !== true
      })
    }

    #sendPoke(
      sockets: WebSocket[],
      poke: {
        baseCursor: Cursor | null
        patch: PatchOp[]
        lastMutationIdChanges?: Record<string, number>
        mutationResults?: MutationResult[]
      },
    ): void {
      if (sockets.length === 0) return
      const pokeId = crypto.randomUUID()
      const frames: string[] = []
      const start: PokeStartMsg = { type: 'pokeStart', pokeId, baseCursor: poke.baseCursor }
      frames.push(JSON.stringify(start))

      const chunks = chunkBySize(poke.patch, { maxBytes: MAX_PART_PATCH_BYTES, sizeOf: jsonByteSize })
      const partPatches: PatchOp[][] = chunks.length > 0 ? chunks : [[]]
      let sent = 0
      partPatches.forEach((patch, i) => {
        sent += patch.length
        const part: PokePartMsg = { type: 'pokePart', pokeId, patch, remaining: poke.patch.length - sent }
        if (i === 0) {
          if (poke.lastMutationIdChanges) part.lastMutationIdChanges = poke.lastMutationIdChanges
          if (poke.mutationResults?.length) part.mutationResults = poke.mutationResults
        }
        frames.push(JSON.stringify(part))
      })

      const end: PokeEndMsg = { type: 'pokeEnd', pokeId, cursor: this.#cursor(), pageInfo: { more: false } }
      frames.push(JSON.stringify(end))

      this.#counters.pokesSent++
      this.#counters.lastFanout = sockets.length

      for (const socket of sockets) this.#deliver(socket, frames)
    }

    /**
     * The one per-socket delivery gate — every fan-out path (pokes, presence
     * relay/snapshot/poll, and §17 field updates when they land) sends through
     * here so the §15 checks are never duplicated. Skips sockets the DO
     * already closed (defunct — the close is in flight but frames would still
     * dispatch), and closes past-due stamps with 4300 instead of delivering:
     * reads are gated at the fan-out (§15.2) because a passive reader
     * generates no inbound frames, so this is the one place expiry can bite.
     */
    #deliver(socket: WebSocket, frames: readonly (string | Uint8Array)[]): void {
      const attachment = socket.deserializeAttachment() as Attachment | null
      if (attachment?.defunct) return
      if (attachment?.expiresAt !== undefined && Date.now() >= attachment.expiresAt) {
        this.#closeSocket(socket, CLOSE_REFRESH, 'auth-expired')
        return
      }
      try {
        for (const frame of frames) socket.send(frame)
        this.#counters.framesSent += frames.length
      } catch {
        // Slow/broken socket: dropping it is always safe — the client
        // catches up by cursor on reconnect (DESIGN.md §8).
        this.#closeSocket(socket, 1011, 'send failed')
      }
    }

    /**
     * Every DO-initiated close funnels through here: the defunct mark commits
     * before the close so any frame already in flight from this socket is
     * dropped by webSocketMessage — close beats push (§15.6). One
     * serializeAttachment write per close; closes are rare, so this never
     * lands on a hot path.
     */
    #closeSocket(ws: WebSocket, code: number, reason: string): void {
      try {
        const attachment = ws.deserializeAttachment() as Attachment | null
        if (attachment && attachment.defunct !== true) {
          ws.serializeAttachment({ ...attachment, defunct: true } satisfies Attachment)
        }
      } catch {
        // unreadable attachment — still close below
      }
      // A DO-initiated close may never fire webSocketClose (the peer can be
      // gone); drop the presence entry now rather than waiting for a close
      // event that might not come.
      this.#dropPresence(ws)
      try {
        ws.close(code, truncateCloseReason(reason))
      } catch {
        // already closed
      }
    }

    #sendError(ws: WebSocket, code: ErrorCode, message?: string): void {
      try {
        ws.send(JSON.stringify({ type: 'error', code, ...(message ? { message } : {}) }))
      } catch {
        // socket already gone
      }
    }
  }

  return WorkspaceDO
}
