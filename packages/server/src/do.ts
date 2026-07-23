import {
  AppError,
  KEEPALIVE_PING,
  KEEPALIVE_PONG,
  MAX_ID_LENGTH,
  MAX_PART_PATCH_BYTES,
  MAX_ROW_BYTES,
  PROTOCOL_VERSION,
  TABLE_NAME_RE,
  chunkBySize,
  clientMsgSchema,
  formatIssues,
  jsonByteSize,
  migrationPath,
  type AnySyncSchema,
  type AppDefinition,
  type Cursor,
  type ErrorCode,
  type HelloMsg,
  type Mutation,
  type MutationResult,
  type MutatorContext,
  type MutatorTx,
  type PatchOp,
  type PokeEndMsg,
  type PokePartMsg,
  type PokeStartMsg,
  type PushMsg,
  type StandardSchemaV1,
} from '@cf-sync/protocol'
import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import { schemaFingerprint } from './fingerprint'
import { loadOrInitMeta, migrate, type Meta } from './storage'

/** Set by the worker routers so the DO can learn its own workspace id. */
export const WORKSPACE_HEADER = 'x-cf-sync-workspace'

export interface CompactionConfig {
  /**
   * Tombstones older than currentVersion - retention are hard-deleted on the
   * compaction alarm; clients whose cursor predates the youngest deleted
   * tombstone re-bootstrap (DESIGN.md D8).
   */
  tombstoneRetentionVersions?: number
  intervalMs?: number
  disabled?: boolean
}

export interface ExportConfig<Env = unknown> {
  /**
   * Resolves the R2 bucket from the worker env. Annotate the parameter to
   * type the whole DO's env: `(env: Env) => env.EXPORT_BUCKET`.
   */
  bucket: (env: Env) => R2Bucket
  intervalMs?: number
  /** Log entries per exported object. */
  maxBatchRows?: number
  /** Bound on objects written per maintenance run. */
  maxObjectsPerRun?: number
  /** Key prefix; objects land at `<prefix>/<workspaceId>/mutation-log/<range>.ndjson`. */
  prefix?: string
}

export interface WorkspaceEngineConfig<S extends AnySyncSchema = AnySyncSchema, Env = unknown> {
  /**
   * The shared app definition (`defineApp`): version, table schemas, mutator
   * registry, and the schema-version migration chain — the same object every
   * client is constructed with. Every `tx.put` — from mutators, schema
   * migrations, and admin imports — is validated against the target table's
   * schema; the validated output (defaults applied) is what gets stored.
   *
   * When the DO wakes with data stored under an older version, the migration
   * chain from that version replays before any traffic (DESIGN.md §9): all
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
  /** Stream the mutation log to R2 for archive/analytics (DESIGN.md D3). */
  export?: ExportConfig<Env>
}

const DEFAULT_TOMBSTONE_RETENTION = 10_000
const DEFAULT_COMPACTION_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_EXPORT_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_EXPORT_BATCH_ROWS = 5_000
const DEFAULT_EXPORT_MAX_OBJECTS = 20

const importSnapshotSchema = z.object({
  formatVersion: z.literal(1),
  schemaVersion: z.string().min(1),
  rows: z.array(
    z.object({
      tbl: z.string().min(1),
      id: z.string().min(1),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
})

/** Per-connection state; lives in the socket attachment so it survives hibernation. */
interface Attachment {
  clientId: string
  /** True once hello succeeded; only ready sockets receive broadcasts. */
  ready: boolean
}

const PING = KEEPALIVE_PING
const PONG = KEEPALIVE_PONG
/** Close codes with no peer to reciprocate to (RFC 6455 reserved). */
const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015])

interface RowWrite {
  tbl: string
  id: string
  data: Record<string, unknown>
}

/**
 * Validates a row payload against its table's schema and returns the parsed
 * output (defaults applied). Only `put` is schema-strict — reads and deletes
 * stay loose so migrations can touch tables that left the schema.
 */
function validateRow(schema: AnySyncSchema, tbl: string, id: string, data: Record<string, unknown>): Record<string, unknown> {
  const tableSchema = (schema.tables as Record<string, StandardSchemaV1<unknown, Record<string, unknown>>>)[tbl]
  if (!tableSchema) {
    throw new AppError('InvalidArgs', `table "${tbl}" is not defined in the schema`)
  }
  const result = tableSchema['~standard'].validate(data)
  if (result instanceof Promise) {
    // Mutations apply inside a synchronous SQLite transaction; an async
    // validator can never succeed here, so fail permanently and loudly.
    void result.catch(() => {})
    throw new AppError('InvalidArgs', `table "${tbl}": async validation is not supported`)
  }
  if (result.issues) {
    throw new AppError('InvalidArgs', `invalid row ${tbl}/${id}: ${formatIssues(result.issues)}`)
  }
  return result.value
}

/**
 * Buffers a single mutation's writes so they can be discarded on AppError
 * while the LMID advance still commits (DESIGN.md §6). Reads see the overlay.
 *
 * `validateAtFlush` defers row validation from `put` to `flush` — schema
 * migration replays need it, because intermediate steps of a chain may write
 * shapes that only become schema-valid after a later step rewrites them; only
 * the chain's net result must parse. Mutations keep validating at `put` so a
 * mutator reading back its own write sees the parsed output (defaults
 * applied), exactly what a poke will carry.
 */
class WriteSet {
  #puts = new Map<string, RowWrite>()
  #dels = new Map<string, { tbl: string; id: string }>()

  constructor(
    private readonly sql: SqlStorage,
    private readonly schema: AnySyncSchema,
    private readonly validateAtFlush = false,
  ) {}

  readonly tx: MutatorTx = {
    get: (tbl, id) => {
      validateTarget(tbl, id)
      const k = rowKey(tbl, id)
      if (this.#dels.has(k)) return null
      const buffered = this.#puts.get(k)
      if (buffered) return structuredClone(buffered.data)
      const rows = this.sql
        .exec<{ data: string }>(`SELECT data FROM rows WHERE tbl = ? AND id = ? AND deleted = 0`, tbl, id)
        .toArray()
      const row = rows[0]
      return row ? (JSON.parse(row.data) as Record<string, unknown>) : null
    },
    list: (tbl) => {
      if (!TABLE_NAME_RE.test(tbl)) throw new AppError('InvalidArgs', `invalid table name "${tbl}"`)
      const merged = new Map<string, Record<string, unknown>>()
      for (const row of this.sql.exec<{ id: string; data: string }>(
        `SELECT id, data FROM rows WHERE tbl = ? AND deleted = 0`,
        tbl,
      )) {
        merged.set(row.id, JSON.parse(row.data) as Record<string, unknown>)
      }
      for (const del of this.#dels.values()) if (del.tbl === tbl) merged.delete(del.id)
      for (const put of this.#puts.values()) if (put.tbl === tbl) merged.set(put.id, structuredClone(put.data))
      return [...merged].map(([id, data]) => ({ id, data }))
    },
    put: (tbl, id, data) => {
      validateTarget(tbl, id)
      const stored = this.validateAtFlush
        ? (data as Record<string, unknown>)
        : validateRow(this.schema, tbl, id, data)
      const bytes = jsonByteSize(stored)
      if (bytes > MAX_ROW_BYTES) {
        throw new AppError('RowTooLarge', `row ${tbl}/${id} is ${bytes} bytes (max ${MAX_ROW_BYTES})`)
      }
      const k = rowKey(tbl, id)
      this.#dels.delete(k)
      this.#puts.set(k, { tbl, id, data: structuredClone(stored) })
    },
    del: (tbl, id) => {
      validateTarget(tbl, id)
      const k = rowKey(tbl, id)
      this.#puts.delete(k)
      this.#dels.set(k, { tbl, id })
    },
  }

  /** Flushes buffered writes stamped with `version`. Returns rows actually written. */
  flush(version: number): number {
    let written = 0
    for (const { tbl, id, data } of this.#puts.values()) {
      const stored = this.validateAtFlush ? validateRow(this.schema, tbl, id, data) : data
      if (this.validateAtFlush) {
        const bytes = jsonByteSize(stored)
        if (bytes > MAX_ROW_BYTES) {
          throw new AppError('RowTooLarge', `row ${tbl}/${id} is ${bytes} bytes (max ${MAX_ROW_BYTES})`)
        }
      }
      this.sql.exec(
        `INSERT INTO rows (tbl, id, data, version, deleted) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (tbl, id) DO UPDATE SET data = excluded.data, version = excluded.version, deleted = 0`,
        tbl,
        id,
        JSON.stringify(stored),
        version,
      )
      written++
    }
    for (const { tbl, id } of this.#dels.values()) {
      // Deleting a row that never existed is a no-op, not a tombstone: no
      // client can hold a row the server never had.
      const cursor = this.sql.exec(
        `UPDATE rows SET deleted = 1, version = ? WHERE tbl = ? AND id = ? AND deleted = 0`,
        version,
        tbl,
        id,
      )
      written += cursor.rowsWritten
    }
    return written
  }
}

function rowKey(tbl: string, id: string): string {
  return `${tbl}\u0000${id}`
}

function validateTarget(tbl: string, id: string): void {
  if (!TABLE_NAME_RE.test(tbl)) throw new AppError('InvalidArgs', `invalid table name "${tbl}"`)
  if (id.length === 0 || id.length > MAX_ID_LENGTH || id.includes('\u0000')) {
    throw new AppError('InvalidArgs', `invalid row id for table "${tbl}"`)
  }
}

export function createWorkspaceDO<S extends AnySyncSchema, Env = unknown>(config: WorkspaceEngineConfig<S, Env>) {
  const maintenanceIntervalMs = Math.min(
    config.compaction?.intervalMs ?? DEFAULT_COMPACTION_INTERVAL_MS,
    config.export ? (config.export.intervalMs ?? DEFAULT_EXPORT_INTERVAL_MS) : Number.POSITIVE_INFINITY,
  )

  class WorkspaceDO extends DurableObject<Env> {
    #sql: SqlStorage
    #meta!: Meta
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
      // Keepalives answered by the runtime so idle sockets never wake the DO.
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
      ctx.blockConcurrencyWhile(async () => {
        migrate(this.#sql)
        const fingerprint = schemaFingerprint(config.app.schema)
        this.#meta = loadOrInitMeta(this.#sql, config.app.version, fingerprint)
        if (this.#meta.schemaVersion !== config.app.version) {
          this.#migrateAppSchema(fingerprint)
        } else if (this.#meta.schemaHash !== fingerprint) {
          // Same version, different table schemas: additive drift is allowed
          // (DESIGN.md §9), anything else is silent skew — say so, once per
          // change. '' predates the fingerprint column; backfill quietly.
          if (this.#meta.schemaHash !== '') {
            console.warn(
              `[cf-sync] table schemas changed under schema version "${config.app.version}" ` +
                `(fingerprint ${this.#meta.schemaHash} -> ${fingerprint}). Additive changes are fine ` +
                `within a version; renames, removals, or type changes need a version bump and a ` +
                `migration step in defineApp — without one, old clients and cached rows keep being ` +
                `accepted as "${config.app.version}".`,
            )
          }
          this.#sql.exec(`UPDATE meta SET schema_hash = ? WHERE id = 1`, fingerprint)
          this.#meta.schemaHash = fingerprint
        }
        if (this.#maintenanceEnabled() && (await ctx.storage.getAlarm()) === null) {
          await ctx.storage.setAlarm(Date.now() + maintenanceIntervalMs)
        }
      })
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
    #migrateAppSchema(fingerprint: string): void {
      const from = this.#meta.schemaVersion
      const to = config.app.version
      const steps = migrationPath(config.app, from)
      let migratedVersion: number | null = null
      this.ctx.storage.transactionSync(() => {
        // One write buffer across the chain: later steps read earlier steps'
        // writes, and the net result is validated against the current schema
        // at flush (intermediate shapes are transient).
        const writes = new WriteSet(this.#sql, config.app.schema, true)
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
        this.#sql.exec(`UPDATE meta SET schema_version = ?, schema_hash = ? WHERE id = 1`, to, fingerprint)
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
      if (migratedVersion !== null) {
        this.#meta.currentVersion = migratedVersion
        this.#meta.minCursorVersion = migratedVersion
      }
    }

    #maintenanceEnabled(): boolean {
      return !config.compaction?.disabled || config.export !== undefined
    }

    override async alarm(): Promise<void> {
      try {
        if (!config.compaction?.disabled) this.#compact()
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
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      this.ctx.acceptWebSocket(server)
      const attachment: Attachment = { clientId, ready: false }
      server.serializeAttachment(attachment)
      return new Response(null, { status: 101, webSocket: client })
    }

    // Handlers below are intentionally synchronous end-to-end (DESIGN.md
    // invariant 3): no await between reading engine state and sending frames,
    // so per-socket frame order is FIFO relative to version advances.
    override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
      const attachment = ws.deserializeAttachment() as Attachment
      try {
        if (typeof raw !== 'string') {
          this.#sendError(ws, 'BadMessage', 'binary frames are not supported')
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
        else this.#handlePush(ws, attachment, parsed.data)
      } catch (err) {
        console.error('cf-sync-engine internal error', err)
        this.#sendError(ws, 'Internal')
      }
    }

    override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
      // Reciprocate the close or clients observe an abnormal 1006.
      if (!RESERVED_CLOSE_CODES.has(code)) {
        try {
          ws.close(code, reason)
        } catch {
          // already closed
        }
      }
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
              { error: `snapshot is schema "${snapshot.schemaVersion}", server is "${config.app.version}"` },
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
          // Full state replace at a single new version. Every existing cursor
          // is invalidated (min_cursor_version = new version): live clients
          // get the reset poke below; reconnecting ones reset at hello.
          const version = this.#meta.currentVersion + 1
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
            this.#sql.exec(`UPDATE meta SET current_version = ?, min_cursor_version = ? WHERE id = 1`, version, version)
          })
          this.#meta.currentVersion = version
          this.#meta.minCursorVersion = version
          this.#sendPoke(this.#readySockets(), {
            baseCursor: null,
            patch: [{ op: 'clear' }, ...this.#snapshotPatch()],
          })
          return json({ imported: snapshot.rows.length, version })
        }

        case 'POST reset': {
          // Wipe the workspace and start a new history: fresh backendId, so
          // every surviving cursor is rejected. Connected clients converge via
          // the clear poke (a clear poke applies from any base).
          const workspaceId = this.#meta.workspaceId
          await this.ctx.storage.deleteAll()
          migrate(this.#sql)
          this.#meta = loadOrInitMeta(this.#sql, config.app.version, schemaFingerprint(config.app.schema))
          if (workspaceId) {
            this.#sql.exec(`UPDATE meta SET workspace_id = ? WHERE id = 1`, workspaceId)
            this.#meta.workspaceId = workspaceId
          }
          if (this.#maintenanceEnabled()) {
            await this.ctx.storage.setAlarm(Date.now() + maintenanceIntervalMs)
          }
          this.#sendPoke(this.#readySockets(), { baseCursor: null, patch: [{ op: 'clear' }] })
          return json({ backendId: this.#meta.backendId })
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
        },
        counters: { ...this.#counters },
      }
    }

    #handleHello(ws: WebSocket, attachment: Attachment, msg: HelloMsg): void {
      if (msg.protocolVersion !== PROTOCOL_VERSION || msg.schemaVersion !== config.app.version) {
        this.#sendError(
          ws,
          'VersionNotSupported',
          `server speaks protocol ${PROTOCOL_VERSION}, schema "${config.app.version}"`,
        )
        ws.close(4400, 'VersionNotSupported')
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
        const error = this.#applyMutation(clientId, mutation)
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
    #applyMutation(clientId: string, mutation: Mutation): { code: string; message: string } | undefined {
      const mutator = config.app.mutators[mutation.name]
      const ctx: MutatorContext = { clientId }
      let appError: { code: string; message: string } | undefined
      let committedVersion: number | null = null

      this.ctx.storage.transactionSync(() => {
        let wroteVersion: number | null = null
        if (!mutator) {
          // Unknown mutator names are permanent: schemaVersion matched at
          // hello, so this is a registry bug, and retrying can never succeed.
          appError = { code: 'UnknownMutator', message: `no mutator named "${mutation.name}"` }
        } else {
          const writes = new WriteSet(this.#sql, config.app.schema)
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
      return this.ctx
        .getWebSockets()
        .filter((socket) => (socket.deserializeAttachment() as Attachment | null)?.ready === true)
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
      this.#counters.framesSent += frames.length * sockets.length
      this.#counters.lastFanout = sockets.length

      for (const socket of sockets) {
        try {
          for (const frame of frames) socket.send(frame)
        } catch {
          // Slow/broken socket: dropping it is always safe — the client
          // catches up by cursor on reconnect (DESIGN.md §8).
          try {
            socket.close(1011, 'send failed')
          } catch {
            // already closed
          }
        }
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
