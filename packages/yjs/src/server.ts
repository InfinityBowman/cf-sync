import {
  FIELD_MSG_GET,
  FIELD_MSG_REJECT,
  FIELD_MSG_STATE,
  FIELD_MSG_UPDATE,
  MAX_FIELD_BYTES,
  MAX_FIELD_UPDATE_BYTES,
  decodeFieldFrame,
  encodeFieldFrame,
  encodeFieldReject,
  encodeFieldState,
  type FieldRejectReason,
} from '@cf-sync/protocol'
import type {
  EngineExtension,
  EngineExtensionContext,
  EngineExtensionMessageContext,
} from '@cf-sync/server'
import * as Y from 'yjs'

export interface YjsFieldsOptions {
  /**
   * Gates field writes on the §15 auth stamps (the verdict's `context`, as
   * stamped at upgrade). Default: any member writes — the same coarse model
   * as the rest of the engine (membership to read, one app predicate to
   * write). A `false` verdict is not an error path: it sets `writable: false`
   * in the `GET` reply so the binding is read-only from the first paint, and
   * an `UPDATE` that arrives anyway earns a `NotWritable` `REJECT`.
   */
  authorizeWrite?: (auth: unknown) => boolean
  /**
   * Y.Docs held in memory (snapshot-plus-tail loads are served from here).
   * Fields cap at MAX_FIELD_BYTES, so the default 8 bounds worst-case doc
   * memory around ~6MB.
   */
  maxCachedDocs?: number
  /**
   * Pending update rows that trigger compaction (materialize, re-encode as
   * one snapshot, delete the tail) on the maintenance alarm.
   */
  compactionThreshold?: number
}

const DEFAULT_MAX_CACHED_DOCS = 8
const DEFAULT_COMPACTION_THRESHOLD = 200

interface FieldRow {
  snapshot: ArrayBuffer | null
  snapshotSeq: number
  byteTotal: number
  frozen: boolean
}

/** DO SQLite binds blobs as ArrayBuffer, never as a view. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function fromBase64(value: string): Uint8Array {
  const bin = atob(value)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * Tier 2 Yjs fields hosted inside the workspace DO (DESIGN.md §17): per-field
 * Y.Docs on the existing socket, appended-and-relayed without materializing on
 * the typing path. Register on the DO:
 *
 * ```ts
 * export const Workspace = createWorkspaceDO({
 *   app,
 *   extension: yjsFields({ authorizeWrite: (auth) => auth?.writeAllowed === true }),
 * })
 * ```
 *
 * Returns a factory, not an extension: `createWorkspaceDO` calls it once per
 * workspace DO instance, so the doc cache, refusal sets, and storage binding
 * are per-workspace by construction — Cloudflare colocates instances of one
 * class in a shared isolate, and extension state must never cross workspaces.
 */
export function yjsFields(options: YjsFieldsOptions = {}): () => EngineExtension {
  return () => createExtension(options)
}

function createExtension(options: YjsFieldsOptions): EngineExtension {
  const authorizeWrite = options.authorizeWrite ?? (() => true)
  const maxCachedDocs = options.maxCachedDocs ?? DEFAULT_MAX_CACHED_DOCS
  const compactionThreshold = options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD

  let ctx: EngineExtensionContext | null = null
  /** Doc cache, LRU by Map insertion order (delete+set refreshes). */
  let cache = new Map<string, Y.Doc>()
  /**
   * The server half of the refusal collapse (§17.3): fields this socket has
   * been REJECTed on. Frames already in flight when the REJECT lands (one RTT
   * of keystrokes after a TooLarge paste) depend on the refused op's client
   * clocks — appending them would plant a permanent gap in the log, so they
   * are refused without touching storage. In-memory is safe: a hibernation
   * wake happens long after the client went read-only.
   */
  let refused = new WeakMap<WebSocket, Set<string>>()

  const sql = () => {
    if (!ctx) throw new Error('yjsFields: extension used before init')
    return ctx.sql
  }

  function createTables(): void {
    sql().exec(
      `CREATE TABLE IF NOT EXISTS yjs_fields (
        field_id     TEXT PRIMARY KEY,
        snapshot     BLOB,
        snapshot_seq INTEGER NOT NULL DEFAULT 0,
        byte_total   INTEGER NOT NULL DEFAULT 0,
        frozen       INTEGER NOT NULL DEFAULT 0
      ) STRICT`,
    )
    sql().exec(
      `CREATE TABLE IF NOT EXISTS yjs_updates (
        field_id TEXT    NOT NULL,
        seq      INTEGER NOT NULL,
        bytes    BLOB    NOT NULL,
        PRIMARY KEY (field_id, seq)
      ) STRICT`,
    )
  }

  function fieldRow(fieldId: string): FieldRow | null {
    const rows = sql()
      .exec<{ snapshot: ArrayBuffer | null; snapshot_seq: number; byte_total: number; frozen: number }>(
        `SELECT snapshot, snapshot_seq, byte_total, frozen FROM yjs_fields WHERE field_id = ?`,
        fieldId,
      )
      .toArray()
    const row = rows[0]
    if (!row) return null
    return {
      snapshot: row.snapshot,
      snapshotSeq: Number(row.snapshot_seq),
      byteTotal: Number(row.byte_total),
      frozen: Number(row.frozen) !== 0,
    }
  }

  function cacheDoc(fieldId: string, doc: Y.Doc): void {
    cache.delete(fieldId)
    cache.set(fieldId, doc)
    while (cache.size > maxCachedDocs) {
      const oldest = cache.keys().next().value as string
      cache.get(oldest)?.destroy()
      cache.delete(oldest)
    }
  }

  function evictDoc(fieldId: string): void {
    cache.get(fieldId)?.destroy()
    cache.delete(fieldId)
  }

  /**
   * Materializes a field: snapshot plus update tail (DESIGN.md §17.4).
   * Corrupt update rows are skipped-and-logged — any connected client still
   * holding the lost ops re-uploads them through the push-back leg; corrupt
   * snapshots throw outright (fail loudly, never guess). `fresh: true`
   * bypasses the cache (compaction must reflect exactly what the log holds).
   */
  function loadDoc(fieldId: string, opts: { fresh?: boolean } = {}): Y.Doc {
    if (!opts.fresh) {
      const cached = cache.get(fieldId)
      if (cached) {
        cacheDoc(fieldId, cached) // refresh LRU order
        return cached
      }
    }
    const row = fieldRow(fieldId)
    const doc = new Y.Doc()
    if (row?.snapshot) Y.applyUpdate(doc, new Uint8Array(row.snapshot))
    for (const update of sql().exec<{ seq: number; bytes: ArrayBuffer }>(
      `SELECT seq, bytes FROM yjs_updates WHERE field_id = ? AND seq > ? ORDER BY seq`,
      fieldId,
      row?.snapshotSeq ?? 0,
    )) {
      try {
        Y.applyUpdate(doc, new Uint8Array(update.bytes))
      } catch (err) {
        console.error(
          `[cf-sync/yjs] skipping corrupt update row for field "${fieldId}" (seq ${Number(update.seq)}); ` +
            `a connected client holding these ops re-uploads them on its next sync`,
          err,
        )
      }
    }
    cacheDoc(fieldId, doc)
    return doc
  }

  function markRefused(ws: WebSocket, fieldId: string): void {
    let set = refused.get(ws)
    if (!set) refused.set(ws, (set = new Set()))
    set.add(fieldId)
  }

  function reject(ws: WebSocket, fieldId: string, reason: FieldRejectReason): void {
    markRefused(ws, fieldId)
    ctx!.send(ws, encodeFieldFrame(FIELD_MSG_REJECT, fieldId, encodeFieldReject(reason)))
  }

  function handleGet(ws: WebSocket, fieldId: string, clientSV: Uint8Array, msgCtx: EngineExtensionMessageContext): void {
    const row = fieldRow(fieldId)
    const writable =
      authorizeWrite(msgCtx.auth) && !(row?.frozen ?? false) && !(refused.get(ws)?.has(fieldId) ?? false)
    const doc = loadDoc(fieldId)
    let diff: Uint8Array
    try {
      diff = clientSV.byteLength === 0 ? Y.encodeStateAsUpdate(doc) : Y.encodeStateAsUpdate(doc, clientSV)
    } catch {
      // Unparseable state vector: treat the client as fresh rather than fail.
      diff = Y.encodeStateAsUpdate(doc)
    }
    const payload = encodeFieldState({ writable, stateVector: Y.encodeStateVector(doc), diff })
    ctx!.send(ws, encodeFieldFrame(FIELD_MSG_STATE, fieldId, payload))
  }

  /**
   * The typing path (§17.4): append to the log and relay, synchronously —
   * persist-then-broadcast, so no client ever sees state the server has not
   * durably stored. Never materializes a document; the freeze ceiling rides
   * a running byte total kept in the same append transaction.
   */
  function handleUpdate(
    ws: WebSocket,
    fieldId: string,
    update: Uint8Array,
    frame: Uint8Array,
    msgCtx: EngineExtensionMessageContext,
  ): void {
    // The refusal collapse: this socket was already told this field is not
    // writable; anything still arriving is the in-flight tail. Drop it
    // before it can gap the log.
    if (refused.get(ws)?.has(fieldId)) return
    if (!authorizeWrite(msgCtx.auth)) {
      reject(ws, fieldId, 'NotWritable')
      return
    }
    if (update.byteLength > MAX_FIELD_UPDATE_BYTES) {
      reject(ws, fieldId, 'TooLarge')
      return
    }
    const row = fieldRow(fieldId)
    if (row?.frozen) {
      reject(ws, fieldId, 'Frozen')
      return
    }
    // Structural parse only (no doc, no materialization): garbage must never
    // enter the log, where it would surface as a skipped row and a truncated
    // field for every future reader.
    try {
      Y.decodeUpdate(update)
    } catch (err) {
      console.warn(`[cf-sync/yjs] dropping malformed update for field "${fieldId}"`, err)
      return
    }

    const byteTotal = (row?.byteTotal ?? 0) + update.byteLength
    // Accept the crossing update, then freeze (§17.3): rejecting it would
    // leave the sender's doc permanently ahead of the server. The running
    // sum deliberately over-estimates; compaction reconciles it.
    const frozen = byteTotal > MAX_FIELD_BYTES
    ctx!.transactionSync(() => {
      sql().exec(
        `INSERT INTO yjs_fields (field_id, snapshot, snapshot_seq, byte_total, frozen)
         VALUES (?, NULL, 0, ?, ?)
         ON CONFLICT (field_id) DO UPDATE SET byte_total = excluded.byte_total, frozen = excluded.frozen`,
        fieldId,
        byteTotal,
        frozen ? 1 : 0,
      )
      const seqRow = sql()
        .exec<{ next: number }>(
          `SELECT COALESCE(MAX(seq), ?) + 1 AS next FROM yjs_updates WHERE field_id = ?`,
          row?.snapshotSeq ?? 0,
          fieldId,
        )
        .one()
      sql().exec(
        `INSERT INTO yjs_updates (field_id, seq, bytes) VALUES (?, ?, ?)`,
        fieldId,
        Number(seqRow.next),
        toArrayBuffer(update),
      )
    })
    // Log coherence (§17.4): a cached doc must never fall behind the log, or
    // the next GET it serves returns an incomplete diff. Apply or evict.
    const cached = cache.get(fieldId)
    if (cached) {
      try {
        Y.applyUpdate(cached, update)
      } catch (err) {
        console.error(`[cf-sync/yjs] evicting cached doc for field "${fieldId}" after apply failure`, err)
        evictDoc(fieldId)
      }
    }
    // Relay the original frame bytes — persisted first, so every client that
    // sees this update can always read it back.
    ctx!.broadcast(frame, { except: ws })
  }

  function compactField(fieldId: string): void {
    ctx!.transactionSync(() => {
      const last = sql()
        .exec<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM yjs_updates WHERE field_id = ?`, fieldId)
        .one()
      if (last.seq === null) return
      const lastSeq = Number(last.seq)
      // Fresh build: compaction must encode exactly what the log holds. A
      // corrupt row's loss is baked in here (truncated at the gap — logged,
      // unrecoverable by design).
      const doc = loadDoc(fieldId, { fresh: true })
      const snapshot = Y.encodeStateAsUpdate(doc)
      sql().exec(
        `UPDATE yjs_fields SET snapshot = ?, snapshot_seq = ?, byte_total = ? WHERE field_id = ?`,
        toArrayBuffer(snapshot),
        lastSeq,
        // Reconcile the over-estimating running sum to the true encoded
        // size. `frozen` is untouched: the freeze is sticky (§17.4).
        snapshot.byteLength,
        fieldId,
      )
      sql().exec(`DELETE FROM yjs_updates WHERE field_id = ? AND seq <= ?`, fieldId, lastSeq)
      cacheDoc(fieldId, doc) // the fresh build is now the authoritative cache entry
    })
  }

  return {
    init(context) {
      ctx = context
      // Init is "wake": idempotent DDL, all in-memory state rebuilt fresh
      // (also re-run after admin reset wipes storage).
      cache = new Map()
      refused = new WeakMap()
      createTables()
    },

    onBinaryMessage(ws, bytes, msgCtx) {
      if (!msgCtx.ready) return // binary frames are only accepted on ready sockets (§17.3)
      const frame = decodeFieldFrame(bytes)
      if (!frame) {
        console.warn('[cf-sync/yjs] dropping malformed binary frame')
        return
      }
      if (frame.msgType === FIELD_MSG_GET) handleGet(ws, frame.fieldId, frame.payload, msgCtx)
      else if (frame.msgType === FIELD_MSG_UPDATE) handleUpdate(ws, frame.fieldId, frame.payload, bytes, msgCtx)
      // STATE / REJECT are server → client only: drop.
    },

    onAlarm() {
      const candidates = sql()
        .exec<{ field_id: string }>(
          `SELECT field_id FROM yjs_updates GROUP BY field_id HAVING COUNT(*) > ?`,
          compactionThreshold,
        )
        .toArray()
      // Isolated per field: one corrupt snapshot (loadDoc throws outright,
      // by design) must not block every other field's compaction — or the
      // maintenance alarm's remaining work — forever.
      for (const candidate of candidates) {
        try {
          compactField(candidate.field_id)
        } catch (err) {
          console.error(`[cf-sync/yjs] compaction failed for field "${candidate.field_id}"`, err)
        }
      }
    },

    onExport() {
      // Compact at export time: one snapshot per field, whatever the log held.
      const fields: Record<string, string> = {}
      for (const row of sql().exec<{ field_id: string }>(`SELECT field_id FROM yjs_fields ORDER BY field_id`)) {
        fields[row.field_id] = toBase64(Y.encodeStateAsUpdate(loadDoc(row.field_id, { fresh: true })))
      }
      return { fields }
    },

    onImport(data) {
      if (typeof data !== 'object' || data === null || typeof (data as { fields?: unknown }).fields !== 'object') {
        throw new Error('yjsFields: extension snapshot must be { fields: { [fieldId]: base64 } }')
      }
      const fields = (data as { fields: Record<string, unknown> }).fields
      sql().exec(`DELETE FROM yjs_fields`)
      sql().exec(`DELETE FROM yjs_updates`)
      for (const [fieldId, encoded] of Object.entries(fields)) {
        if (typeof encoded !== 'string') throw new Error(`yjsFields: field "${fieldId}" snapshot must be base64`)
        const snapshot = fromBase64(encoded)
        // Validate by applying — a snapshot that cannot build a doc must
        // fail the import (which rolls back whole), not a future GET.
        Y.applyUpdate(new Y.Doc(), snapshot)
        sql().exec(
          `INSERT INTO yjs_fields (field_id, snapshot, snapshot_seq, byte_total, frozen) VALUES (?, ?, 0, ?, ?)`,
          fieldId,
          toArrayBuffer(snapshot),
          snapshot.byteLength,
          // An import with a smaller field resets the ceiling (§17.3).
          snapshot.byteLength > MAX_FIELD_BYTES ? 1 : 0,
        )
      }
      cache = new Map()
    },

    onReset() {
      // Core re-ran init (fresh tables) before this; nothing left to clear,
      // but be explicit so a future core that doesn't re-init stays correct.
      sql().exec(`DELETE FROM yjs_fields`)
      sql().exec(`DELETE FROM yjs_updates`)
      cache = new Map()
      refused = new WeakMap()
    },

    onStats() {
      const fields = sql()
        .exec<{ n: number; frozen: number; bytes: number | null }>(
          `SELECT COUNT(*) AS n, COALESCE(SUM(frozen), 0) AS frozen, SUM(byte_total) AS bytes FROM yjs_fields`,
        )
        .one()
      const pending = sql().exec<{ n: number }>(`SELECT COUNT(*) AS n FROM yjs_updates`).one()
      return {
        fields: Number(fields.n),
        frozenFields: Number(fields.frozen),
        fieldBytes: Number(fields.bytes ?? 0),
        pendingUpdates: Number(pending.n),
        cachedDocs: cache.size,
      }
    },
  }
}
