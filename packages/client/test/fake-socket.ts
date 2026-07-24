import type { ClientMsg, ServerMsg } from '@cf-sync/protocol/internal'
import type { WebSocketLike } from '../src/client'

type Listener = (event: any) => void

/** In-memory socket for driving the SyncClient from a scripted "server". */
export class FakeSocket implements WebSocketLike {
  sent: ClientMsg[] = []
  sentBinary: Uint8Array[] = []
  closed = false
  #listeners = new Map<string, Listener[]>()

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.closed) throw new Error('socket closed')
    if (typeof data === 'string') {
      this.sent.push(JSON.parse(data) as ClientMsg)
    } else if (ArrayBuffer.isView(data)) {
      this.sentBinary.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)))
    } else {
      this.sentBinary.push(new Uint8Array(data.slice(0)))
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.#emit('close', {})
  }

  // ---- test controls ----
  open(): void {
    this.#emit('open', {})
  }

  receive(msg: ServerMsg): void {
    this.#emit('message', { data: JSON.stringify(msg) })
  }

  /** Delivers a binary-lane frame the way a real socket would (ArrayBuffer). */
  receiveBinary(bytes: Uint8Array): void {
    this.#emit('message', { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  }

  /** Delivers an arbitrary message payload (malformed-data drills). */
  receiveRaw(data: unknown): void {
    this.#emit('message', { data })
  }

  dropConnection(): void {
    this.closed = true
    this.#emit('close', {})
  }

  /** Server-initiated close carrying a policy code + reason (DESIGN.md §15.2). */
  serverClose(code: number, reason = ''): void {
    this.closed = true
    this.#emit('close', { code, reason })
  }

  takeSent(): ClientMsg[] {
    const out = this.sent
    this.sent = []
    return out
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }
}

export function flushMicrotasks(times = 5): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}
