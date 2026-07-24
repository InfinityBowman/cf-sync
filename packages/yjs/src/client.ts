import {
  FIELD_MSG_GET,
  FIELD_MSG_REJECT,
  FIELD_MSG_STATE,
  FIELD_MSG_UPDATE,
  MAX_FIELD_ID_BYTES,
  MAX_FIELD_UPDATE_BYTES,
  decodeFieldFrame,
  decodeFieldState,
  encodeFieldFrame,
} from '@cf-sync/protocol/internal'
import * as Y from 'yjs'

/**
 * Maximum size in bytes of a single field update frame — an update larger
 * than this is rejected by the transport with `TooLarge`. Re-exported so
 * editors can guard input size (e.g. a textarea `maxLength`) against the
 * same limit the transport enforces, without reaching into
 * `@cf-sync/protocol/internal`.
 */
export { MAX_FIELD_UPDATE_BYTES }

/**
 * The client half of the extension seam, structurally satisfied by
 * `SyncClient` — the add-on is plain library code with no privileged
 * access. `status === 'synced'` is the ready signal: the server
 * only accepts binary frames on ready sockets, and every transition back to
 * 'synced' is a fresh connection to re-sync against.
 */
export interface YjsFieldsClient {
  sendBinary(bytes: Uint8Array): void
  onBinary(listener: (bytes: Uint8Array) => void): () => void
  subscribeStatus(listener: (status: string) => void): () => void
  readonly status: string
  /**
   * When the client exposes a destroy hook (`SyncClient` does), the add-on
   * registers its own `destroy` there, so `client.destroy()` tears down the
   * fields too — no separate call to remember.
   */
  onDestroy?(callback: () => void): () => void
}

/**
 * A ref-counted live view of one field. Two components
 * holding the same fieldId share one `doc`; `release()` drops local state at
 * refcount zero. There is no local persistence: a reload re-fetches small
 * documents in one round-trip, and an app that wants offline field durability
 * attaches y-indexeddb to `doc` itself.
 */
export interface YjsFieldHandle {
  readonly doc: Y.Doc
  /**
   * The paved path: a Y.Text at a fixed library-owned key, so every reader
   * and writer of a field agrees on type and key with nothing to coordinate.
   * Rich text (a Y.XmlFragment for y-prosemirror and the like) drops to
   * `doc` and the app owns the key — one field is one shape, chosen once.
   */
  readonly text: Y.Text
  /**
   * Whether this client may write the field — from the server's `STATE`
   * writable flag, flipped false by any `REJECT`. A REJECT-flipped false is
   * sticky for the handle's lifetime: only this client knows its local doc
   * holds an op the server refused, so a later `STATE` saying writable must
   * not resume the push-back. Meaningful after `whenSynced`; starts false
   * (never guessed).
   */
  readonly canWrite: boolean
  /**
   * Resolves on the first `STATE` and stays resolved — it answers "can I
   * render this field", not "am I currently live"; liveness is the client's
   * sync status.
   */
  readonly whenSynced: Promise<void>
  /** Notifies when `canWrite` (or first-sync state) changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  release(): void
}

export interface YjsFields {
  /** Get (or share) the live doc for a field. Fields are created implicitly on first use. */
  getDoc(fieldId: string): YjsFieldHandle
  /** Detaches from the client and destroys every held doc. */
  destroy(): void
}

/** The paved-path text key — fixed and library-owned (DESIGN.md §17.1). */
const TEXT_KEY = 't'

/** Transaction origin marking updates applied from the server (never re-sent). */
const REMOTE_ORIGIN = Symbol('cf-sync-yjs-remote')

/** An update with no structs and no deletes encodes as two zero varints. */
function isEmptyUpdate(update: Uint8Array): boolean {
  return update.byteLength <= 2
}

const textEncoder = new TextEncoder()

interface Entry {
  fieldId: string
  doc: Y.Doc
  refs: number
  canWrite: boolean
  /** Sticky refusal: a REJECT (or local frame-guard trip) outlives later STATEs. */
  rejected: boolean
  synced: boolean
  resolveSynced: () => void
  whenSynced: Promise<void>
  listeners: Set<() => void>
}

/**
 * Attaches Yjs fields to a `SyncClient`:
 *
 * ```ts
 * const yfields = createYjsFields(client)
 * const handle = yfields.getDoc('recon-notes:q3')
 * await handle.whenSynced
 * editorBinding(handle.text, textarea)
 * // on unmount: handle.release()
 * ```
 *
 * The library owns transport and lifecycle: docs sync bidirectionally on
 * every connection that reaches ready (edits typed offline merge on resume),
 * and a non-writable field never sends — the apply-then-reject path is
 * designed out, not handled.
 */
export function createYjsFields(client: YjsFieldsClient): YjsFields {
  const entries = new Map<string, Entry>()
  let destroyed = false

  function notify(entry: Entry): void {
    for (const listener of entry.listeners) listener()
  }

  function sendGet(entry: Entry): void {
    client.sendBinary(encodeFieldFrame(FIELD_MSG_GET, entry.fieldId, Y.encodeStateVector(entry.doc)))
  }

  function sendUpdate(entry: Entry, update: Uint8Array): void {
    if (update.byteLength > MAX_FIELD_UPDATE_BYTES) {
      // The local frame guard tripped: the op exists only in this doc now,
      // and sending it would be refused anyway — collapse to read-only here,
      // with no round-trip and no in-flight tail to poison the log. The
      // paved place to prevent this is the editor binding's own paste/length
      // guard (MAX_FIELD_UPDATE_BYTES is exported for exactly that).
      entry.rejected = true
      if (entry.canWrite) {
        entry.canWrite = false
        notify(entry)
      }
      console.warn(
        `[cf-sync/yjs] field "${entry.fieldId}" produced an update over ${MAX_FIELD_UPDATE_BYTES} bytes ` +
          `(a paste, or an offline backlog merged by the push-back) — the field is now read-only ` +
          `locally and these ops will not reach the server; guard sizes in the editor binding`,
      )
      return
    }
    client.sendBinary(encodeFieldFrame(FIELD_MSG_UPDATE, entry.fieldId, update))
  }

  function onFrame(bytes: Uint8Array): void {
    const frame = decodeFieldFrame(bytes)
    if (!frame) return
    const entry = entries.get(frame.fieldId)
    if (!entry) return // a field some other tab has open: not ours, ignore

    if (frame.msgType === FIELD_MSG_UPDATE) {
      try {
        Y.applyUpdate(entry.doc, frame.payload, REMOTE_ORIGIN)
      } catch (err) {
        console.warn(`[cf-sync/yjs] failed to apply relayed update for field "${frame.fieldId}"`, err)
      }
      return
    }

    if (frame.msgType === FIELD_MSG_STATE) {
      const state = decodeFieldState(frame.payload)
      if (!state) return
      try {
        if (!isEmptyUpdate(state.diff)) Y.applyUpdate(entry.doc, state.diff, REMOTE_ORIGIN)
      } catch (err) {
        console.warn(`[cf-sync/yjs] failed to apply STATE diff for field "${frame.fieldId}"`, err)
        return
      }
      const wasWritable = entry.canWrite
      const wasSynced = entry.synced
      // Sticky rejection wins over the server's writable flag (see canWrite docs).
      entry.canWrite = state.writable && !entry.rejected
      entry.synced = true
      if (entry.canWrite) {
        // The push-back leg (§17.3): everything the server's state vector is
        // missing — edits typed during a disconnect, or ops a crash lost —
        // goes back up as one ordinary UPDATE. Suppressed for non-writable
        // fields: the one rule that keeps a refusal from re-uploading forever.
        // Guarded like the diff-apply above: the state vector is wire bytes,
        // and a throw here must not wedge whenSynced or starve the notify.
        try {
          const pushBack = Y.encodeStateAsUpdate(entry.doc, state.stateVector)
          if (!isEmptyUpdate(pushBack)) sendUpdate(entry, pushBack)
        } catch (err) {
          console.warn(`[cf-sync/yjs] failed to compute push-back for field "${frame.fieldId}"`, err)
        }
      }
      if (entry.canWrite !== wasWritable || !wasSynced) notify(entry)
      entry.resolveSynced()
      return
    }

    if (frame.msgType === FIELD_MSG_REJECT) {
      entry.rejected = true
      if (entry.canWrite) {
        entry.canWrite = false
        notify(entry)
      }
    }
  }

  const unsubscribeBinary = client.onBinary(onFrame)
  const unregisterDestroy = client.onDestroy?.(() => api.destroy())
  const unsubscribeStatus = client.subscribeStatus((status) => {
    // Every connection that reaches ready re-syncs every held doc: GET with
    // the current state vector pulls what we missed, the STATE push-back
    // sends what the server missed. Apps write no reconnect glue.
    if (status === 'synced') {
      // Isolated per entry: one field's failure must never starve the rest
      // of the re-GET that keeps them converging.
      for (const entry of entries.values()) {
        try {
          sendGet(entry)
        } catch (err) {
          console.error(`[cf-sync/yjs] re-sync GET failed for field "${entry.fieldId}"`, err)
        }
      }
    }
  })

  const api: YjsFields = {
    getDoc(fieldId: string): YjsFieldHandle {
      if (destroyed) throw new Error('createYjsFields: destroyed')
      // Validate before any state mutation: an id the wire format cannot
      // carry would otherwise throw from encodeFieldFrame after the entry is
      // registered, leaving a zombie whose whenSynced never resolves.
      const idLen = textEncoder.encode(fieldId).byteLength
      if (idLen === 0 || idLen > MAX_FIELD_ID_BYTES) {
        throw new Error(`createYjsFields: fieldId must be 1..${MAX_FIELD_ID_BYTES} utf-8 bytes, got ${idLen}`)
      }
      let entry = entries.get(fieldId)
      if (!entry) {
        const doc = new Y.Doc()
        let resolveSynced!: () => void
        const whenSynced = new Promise<void>((resolve) => {
          resolveSynced = resolve
        })
        const created: Entry = {
          fieldId,
          doc,
          refs: 0,
          canWrite: false,
          rejected: false,
          synced: false,
          resolveSynced,
          whenSynced,
          listeners: new Set(),
        }
        doc.on('update', (update: Uint8Array, origin: unknown) => {
          if (origin === REMOTE_ORIGIN) return
          // Not yet told we can write (pre-STATE, read-only, or offline):
          // the doc itself is the buffer — the next STATE's push-back leg
          // uploads everything the server is missing, if we may write.
          if (!created.canWrite || client.status !== 'synced') return
          sendUpdate(created, update)
        })
        entries.set(fieldId, created)
        if (client.status === 'synced') sendGet(created)
        entry = created
      }
      entry.refs++

      const held = entry
      let released = false
      return {
        doc: held.doc,
        text: held.doc.getText(TEXT_KEY),
        get canWrite() {
          return held.canWrite
        },
        whenSynced: held.whenSynced,
        subscribe(listener: () => void): () => void {
          held.listeners.add(listener)
          return () => {
            held.listeners.delete(listener)
          }
        },
        release(): void {
          if (released) return
          released = true
          held.refs--
          if (held.refs === 0) {
            entries.delete(held.fieldId)
            held.doc.destroy()
          }
        },
      }
    },

    destroy(): void {
      if (destroyed) return
      destroyed = true
      unregisterDestroy?.()
      unsubscribeBinary()
      unsubscribeStatus()
      for (const entry of entries.values()) entry.doc.destroy()
      entries.clear()
    },
  }
  return api
}
