import {
  FIELD_MSG_STATE,
  FIELD_MSG_REJECT,
  decodeFieldFrame,
  encodeFieldFrame,
  encodeFieldReject,
  encodeFieldState,
  type FieldFrame,
  type FieldRejectReason,
} from '@cf-sync/protocol/internal'
import * as Y from 'yjs'
import type { YjsFieldsClient } from '../src/client'

/** Scripted stand-in for the SyncClient seam (ARCHITECTURE.md#yjs-fields). */
export class FakeSeam implements YjsFieldsClient {
  status = 'connecting'
  sent: FieldFrame[] = []
  #binary = new Set<(bytes: Uint8Array) => void>()
  #status = new Set<(status: string) => void>()

  sendBinary(bytes: Uint8Array): void {
    const frame = decodeFieldFrame(bytes)
    if (!frame) throw new Error('add-on sent an undecodable frame')
    this.sent.push(frame)
  }

  onBinary(listener: (bytes: Uint8Array) => void): () => void {
    this.#binary.add(listener)
    return () => {
      this.#binary.delete(listener)
    }
  }

  subscribeStatus(listener: (status: string) => void): () => void {
    this.#status.add(listener)
    return () => {
      this.#status.delete(listener)
    }
  }

  setStatus(status: string): void {
    this.status = status
    for (const listener of this.#status) listener(status)
  }

  deliver(msgType: number, fieldId: string, payload: Uint8Array): void {
    const frame = encodeFieldFrame(msgType as 1 | 2 | 3 | 4, fieldId, payload)
    for (const listener of this.#binary) listener(frame)
  }

  /** Answers the client like the server would: STATE from a server-side doc. */
  state(fieldId: string, serverDoc: Y.Doc, clientSV: Uint8Array, writable = true): void {
    this.deliver(
      FIELD_MSG_STATE,
      fieldId,
      encodeFieldState({
        writable,
        stateVector: Y.encodeStateVector(serverDoc),
        diff: clientSV.byteLength === 0 ? Y.encodeStateAsUpdate(serverDoc) : Y.encodeStateAsUpdate(serverDoc, clientSV),
      }),
    )
  }

  reject(fieldId: string, reason: FieldRejectReason): void {
    this.deliver(FIELD_MSG_REJECT, fieldId, encodeFieldReject(reason))
  }

  takeSent(): FieldFrame[] {
    const out = this.sent
    this.sent = []
    return out
  }
}
