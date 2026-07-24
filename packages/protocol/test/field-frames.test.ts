import { describe, expect, it } from 'vitest'
import {
  FIELD_MSG_GET,
  FIELD_MSG_REJECT,
  FIELD_MSG_STATE,
  FIELD_MSG_UPDATE,
  MAX_FIELD_ID_BYTES,
  decodeFieldFrame,
  decodeFieldReject,
  decodeFieldState,
  encodeFieldFrame,
  encodeFieldReject,
  encodeFieldState,
} from '../src/field-frames'

describe('field frames', () => {
  it('round-trips every message type', () => {
    const payload = new Uint8Array([1, 2, 3, 255, 0, 42])
    for (const msgType of [FIELD_MSG_GET, FIELD_MSG_STATE, FIELD_MSG_UPDATE, FIELD_MSG_REJECT] as const) {
      const frame = encodeFieldFrame(msgType, 'recon-notes:q3', payload)
      const decoded = decodeFieldFrame(frame)
      expect(decoded).not.toBeNull()
      expect(decoded!.msgType).toBe(msgType)
      expect(decoded!.fieldId).toBe('recon-notes:q3')
      expect([...decoded!.payload]).toEqual([...payload])
    }
  })

  it('round-trips an empty payload and non-ascii field ids', () => {
    const frame = encodeFieldFrame(FIELD_MSG_GET, 'ノート:π', new Uint8Array(0))
    const decoded = decodeFieldFrame(frame)
    expect(decoded!.fieldId).toBe('ノート:π')
    expect(decoded!.payload.byteLength).toBe(0)
  })

  it('decodes from an ArrayBuffer as delivered by the socket', () => {
    const frame = encodeFieldFrame(FIELD_MSG_UPDATE, 'f', new Uint8Array([9]))
    const buffer = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer
    const decoded = decodeFieldFrame(buffer)
    expect(decoded!.fieldId).toBe('f')
    expect([...decoded!.payload]).toEqual([9])
  })

  it('decodes a frame whose bytes sit at a nonzero buffer offset', () => {
    const frame = encodeFieldFrame(FIELD_MSG_UPDATE, 'off', new Uint8Array([7, 8]))
    const padded = new Uint8Array(frame.byteLength + 4)
    padded.set(frame, 4)
    const view = padded.subarray(4)
    const decoded = decodeFieldFrame(view)
    expect(decoded!.fieldId).toBe('off')
    expect([...decoded!.payload]).toEqual([7, 8])
  })

  it('rejects malformed frames instead of throwing', () => {
    expect(decodeFieldFrame(new Uint8Array(0))).toBeNull()
    expect(decodeFieldFrame(new Uint8Array([FIELD_MSG_GET, 0]))).toBeNull() // too short
    expect(decodeFieldFrame(new Uint8Array([0, 0, 1, 65]))).toBeNull() // unknown type
    expect(decodeFieldFrame(new Uint8Array([99, 0, 1, 65]))).toBeNull() // unknown type
    expect(decodeFieldFrame(new Uint8Array([FIELD_MSG_GET, 0, 0]))).toBeNull() // empty field id
    expect(decodeFieldFrame(new Uint8Array([FIELD_MSG_GET, 0, 5, 65]))).toBeNull() // id truncated
  })

  it('enforces the field id length cap on encode and decode', () => {
    const longId = 'x'.repeat(MAX_FIELD_ID_BYTES + 1)
    expect(() => encodeFieldFrame(FIELD_MSG_GET, longId, new Uint8Array(0))).toThrow(/fieldId/)
    expect(() => encodeFieldFrame(FIELD_MSG_GET, '', new Uint8Array(0))).toThrow(/fieldId/)
    // Hand-build a frame claiming an over-cap id length.
    const frame = new Uint8Array(3 + MAX_FIELD_ID_BYTES + 1)
    frame[0] = FIELD_MSG_GET
    new DataView(frame.buffer).setUint16(1, MAX_FIELD_ID_BYTES + 1, false)
    expect(decodeFieldFrame(frame)).toBeNull()
  })

  it('round-trips STATE payloads, writable bit both ways', () => {
    const sv = new Uint8Array([1, 2, 3])
    const diff = new Uint8Array([4, 5])
    for (const writable of [true, false]) {
      const decoded = decodeFieldState(encodeFieldState({ writable, stateVector: sv, diff }))
      expect(decoded).not.toBeNull()
      expect(decoded!.writable).toBe(writable)
      expect([...decoded!.stateVector]).toEqual([1, 2, 3])
      expect([...decoded!.diff]).toEqual([4, 5])
    }
  })

  it('round-trips an empty state vector and empty diff', () => {
    const decoded = decodeFieldState(
      encodeFieldState({ writable: true, stateVector: new Uint8Array(0), diff: new Uint8Array(0) }),
    )
    expect(decoded!.stateVector.byteLength).toBe(0)
    expect(decoded!.diff.byteLength).toBe(0)
  })

  it('rejects malformed STATE payloads', () => {
    expect(decodeFieldState(new Uint8Array(0))).toBeNull()
    expect(decodeFieldState(new Uint8Array([1, 0]))).toBeNull()
    expect(decodeFieldState(new Uint8Array([1, 0, 9, 1]))).toBeNull() // sv truncated
  })

  it('round-trips REJECT reasons and rejects unknown codes', () => {
    for (const reason of ['NotWritable', 'Frozen', 'TooLarge'] as const) {
      expect(decodeFieldReject(encodeFieldReject(reason))).toBe(reason)
    }
    expect(decodeFieldReject(new Uint8Array([0]))).toBeNull()
    expect(decodeFieldReject(new Uint8Array([4]))).toBeNull()
    expect(decodeFieldReject(new Uint8Array([1, 1]))).toBeNull()
    expect(decodeFieldReject(new Uint8Array(0))).toBeNull()
  })

  it('STATE round-trips inside a full frame', () => {
    const payload = encodeFieldState({
      writable: false,
      stateVector: new Uint8Array([10, 11]),
      diff: new Uint8Array([12, 13, 14]),
    })
    const frame = decodeFieldFrame(encodeFieldFrame(FIELD_MSG_STATE, 'nested', payload))
    const state = decodeFieldState(frame!.payload)
    expect(state!.writable).toBe(false)
    expect([...state!.stateVector]).toEqual([10, 11])
    expect([...state!.diff]).toEqual([12, 13, 14])
  })
})
