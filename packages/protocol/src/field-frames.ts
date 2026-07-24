/**
 * Binary lane for Tier 2 Yjs fields (DESIGN.md §17.3). Field traffic travels
 * as binary WebSocket frames beside the JSON protocol — the frame type itself
 * is the mux, so there is no envelope inside the JSON protocol and no base64
 * inflation. These helpers are dependency-free (no zod: the payloads are
 * opaque CRDT bytes, not structures to validate).
 *
 * Frame layout, all integers big-endian:
 *
 *     [u8 msgType][u16 fieldIdLen][fieldId utf8][payload bytes]
 */

/** Client → server: payload is a Yjs state vector (empty = send everything). */
export const FIELD_MSG_GET = 1
/** Server → client: `[u8 flags][u16 svLen][server state vector][diff]` (see encodeFieldState). */
export const FIELD_MSG_STATE = 2
/** Both directions: one incremental Yjs update. */
export const FIELD_MSG_UPDATE = 3
/** Server → client: an UPDATE was refused; payload = `[u8 reasonCode]`. */
export const FIELD_MSG_REJECT = 4

export type FieldMsgType =
  | typeof FIELD_MSG_GET
  | typeof FIELD_MSG_STATE
  | typeof FIELD_MSG_UPDATE
  | typeof FIELD_MSG_REJECT

/**
 * Transport frame guard on a single field UPDATE — the binary-lane analogue
 * of the 900KB poke chunk (D9), not a field-semantics limit. An update this
 * large is a paste or a bug, never typing. The paved place to keep edits
 * under it is the editor binding's own paste/length guard, where the undo is
 * native and the user sees the limit before anything happens — the constant
 * is exported for exactly that.
 */
export const MAX_FIELD_UPDATE_BYTES = 65_536

/**
 * The field ceiling (running byte total of appended updates). A field is a
 * note, not a document. The number mirrors MAX_ROW_BYTES's rule — a single
 * field must fit inside a frame with room to spare: a fresh client's STATE
 * carries the whole doc diff in one binary frame, and pure-insert text
 * encodes at roughly its content size, so a ceiling near 1MB would let that
 * frame cross the 900KB hibernated-socket budget (D9). Crossing the ceiling
 * freezes the field (accept-then-freeze; DESIGN.md §17.3/17.4).
 */
export const MAX_FIELD_BYTES = 700_000

/** Field ids are short app-convention keys (`recon-notes:q3`), not documents. */
export const MAX_FIELD_ID_BYTES = 256

/** STATE flags bit 0: the receiving client may write this field. */
export const FIELD_STATE_WRITABLE = 0b0000_0001

/**
 * Why an UPDATE was refused. All three collapse to one client concept —
 * the field is no longer writable on this connection (DESIGN.md §17.6).
 */
export type FieldRejectReason = 'NotWritable' | 'Frozen' | 'TooLarge'

const REJECT_CODES: Record<FieldRejectReason, number> = {
  NotWritable: 1,
  Frozen: 2,
  TooLarge: 3,
}
const REJECT_REASONS: Record<number, FieldRejectReason> = {
  1: 'NotWritable',
  2: 'Frozen',
  3: 'TooLarge',
}

export interface FieldFrame {
  msgType: FieldMsgType
  fieldId: string
  /** A subarray view into the frame's bytes — copy before storing long-term. */
  payload: Uint8Array
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function encodeFieldFrame(msgType: FieldMsgType, fieldId: string, payload: Uint8Array): Uint8Array {
  const idBytes = textEncoder.encode(fieldId)
  if (idBytes.byteLength === 0 || idBytes.byteLength > MAX_FIELD_ID_BYTES) {
    throw new Error(`fieldId must be 1..${MAX_FIELD_ID_BYTES} utf-8 bytes, got ${idBytes.byteLength}`)
  }
  const frame = new Uint8Array(3 + idBytes.byteLength + payload.byteLength)
  frame[0] = msgType
  new DataView(frame.buffer).setUint16(1, idBytes.byteLength, false)
  frame.set(idBytes, 3)
  frame.set(payload, 3 + idBytes.byteLength)
  return frame
}

/** Returns null on any malformed frame — the receiver drops it (and logs). */
export function decodeFieldFrame(data: Uint8Array | ArrayBuffer): FieldFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.byteLength < 3) return null
  const msgType = bytes[0]!
  if (msgType < FIELD_MSG_GET || msgType > FIELD_MSG_REJECT) return null
  const idLen = new DataView(bytes.buffer, bytes.byteOffset).getUint16(1, false)
  if (idLen === 0 || idLen > MAX_FIELD_ID_BYTES || bytes.byteLength < 3 + idLen) return null
  let fieldId: string
  try {
    fieldId = textDecoder.decode(bytes.subarray(3, 3 + idLen))
  } catch {
    return null
  }
  return { msgType: msgType as FieldMsgType, fieldId, payload: bytes.subarray(3 + idLen) }
}

export interface FieldState {
  /** False renders the binding read-only from the first paint (a reader, or a frozen field). */
  writable: boolean
  /** The server's own state vector — the client's cue to push back what the server is missing. */
  stateVector: Uint8Array
  /** The update diff the client is missing. */
  diff: Uint8Array
}

/** STATE payload: `[u8 flags][u16 svLen][server state vector][diff]`. */
export function encodeFieldState(state: FieldState): Uint8Array {
  if (state.stateVector.byteLength > 0xffff) {
    throw new Error(`state vector exceeds u16 length (${state.stateVector.byteLength} bytes)`)
  }
  const payload = new Uint8Array(3 + state.stateVector.byteLength + state.diff.byteLength)
  payload[0] = state.writable ? FIELD_STATE_WRITABLE : 0
  new DataView(payload.buffer).setUint16(1, state.stateVector.byteLength, false)
  payload.set(state.stateVector, 3)
  payload.set(state.diff, 3 + state.stateVector.byteLength)
  return payload
}

export function decodeFieldState(payload: Uint8Array): FieldState | null {
  if (payload.byteLength < 3) return null
  const svLen = new DataView(payload.buffer, payload.byteOffset).getUint16(1, false)
  if (payload.byteLength < 3 + svLen) return null
  return {
    writable: (payload[0]! & FIELD_STATE_WRITABLE) !== 0,
    stateVector: payload.subarray(3, 3 + svLen),
    diff: payload.subarray(3 + svLen),
  }
}

/** REJECT payload: `[u8 reasonCode]`. */
export function encodeFieldReject(reason: FieldRejectReason): Uint8Array {
  return new Uint8Array([REJECT_CODES[reason]])
}

export function decodeFieldReject(payload: Uint8Array): FieldRejectReason | null {
  if (payload.byteLength !== 1) return null
  return REJECT_REASONS[payload[0]!] ?? null
}
