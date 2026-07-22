import type { ClientMsg, ServerMsg } from '@cf-sync/protocol'
import type { WebSocketLike } from '../src/client'

type Listener = (event: any) => void

/** In-memory socket for driving the SyncClient from a scripted "server". */
export class FakeSocket implements WebSocketLike {
  sent: ClientMsg[] = []
  closed = false
  #listeners = new Map<string, Listener[]>()

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }

  send(data: string): void {
    if (this.closed) throw new Error('socket closed')
    this.sent.push(JSON.parse(data) as ClientMsg)
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

  dropConnection(): void {
    this.closed = true
    this.#emit('close', {})
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
