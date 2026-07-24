import {
  FIELD_MSG_GET,
  FIELD_MSG_UPDATE,
  PROTOCOL_VERSION,
  decodeFieldFrame,
  encodeFieldFrame,
  serverMsgSchema,
  type FieldFrame,
  type ServerMsg,
} from '@cf-sync/protocol/internal'
import { SELF } from 'cloudflare:test'
import * as Y from 'yjs'

/**
 * A raw protocol client for the binary lane: minimal JSON handling (hello →
 * ready), full field-frame handling. Mirrors the server package's TestClient
 * shape, trimmed to what §17 tests need.
 */
export class FieldTestClient {
  errors: Extract<ServerMsg, { type: 'error' }>[] = []
  closeEvent: { code: number; reason: string } | null = null

  #ws!: WebSocket
  #json: ServerMsg[] = []
  #jsonWaiters: Array<(msg: ServerMsg) => void> = []
  #frames: FieldFrame[] = []
  #frameWaiters: Array<(frame: FieldFrame) => void> = []
  #closeWaiters: Array<(event: { code: number; reason: string }) => void> = []

  private constructor(
    readonly workspaceId: string,
    readonly clientId: string,
    readonly prefix: string,
    readonly headers: Record<string, string>,
  ) {}

  static async connect(
    workspaceId: string,
    clientId: string,
    prefix = '/sync',
    headers: Record<string, string> = {},
  ): Promise<FieldTestClient> {
    const client = new FieldTestClient(workspaceId, clientId, prefix, headers)
    await client.open()
    return client
  }

  /** Connects and completes hello, so binary frames are accepted. */
  static async ready(
    workspaceId: string,
    clientId: string,
    prefix = '/sync',
    headers: Record<string, string> = {},
  ): Promise<FieldTestClient> {
    const client = await FieldTestClient.connect(workspaceId, clientId, prefix, headers)
    await client.becomeReady()
    return client
  }

  async open(): Promise<void> {
    const response = await SELF.fetch(
      `https://test${this.prefix}/${this.workspaceId}?clientId=${encodeURIComponent(this.clientId)}`,
      { headers: { Upgrade: 'websocket', ...this.headers } },
    )
    const ws = response.webSocket
    if (!ws) throw new Error(`upgrade failed: ${response.status}`)
    ws.accept()
    this.#ws = ws
    this.closeEvent = null
    ws.addEventListener('message', (event: MessageEvent) => {
      if (this.#ws !== ws) return
      if (typeof event.data === 'string') {
        const parsed = serverMsgSchema.safeParse(JSON.parse(event.data))
        if (!parsed.success) return
        if (parsed.data.type === 'error') this.errors.push(parsed.data)
        const waiter = this.#jsonWaiters.shift()
        if (waiter) waiter(parsed.data)
        else this.#json.push(parsed.data)
        return
      }
      const frame = decodeFieldFrame(event.data as ArrayBuffer)
      if (!frame) throw new Error('server sent an undecodable binary frame')
      const waiter = this.#frameWaiters.shift()
      if (waiter) waiter(frame)
      else this.#frames.push(frame)
    })
    ws.addEventListener('close', (event: CloseEvent) => {
      if (this.#ws !== ws) return
      this.closeEvent = { code: event.code, reason: event.reason }
      for (const waiter of this.#closeWaiters.splice(0)) waiter(this.closeEvent)
    })
  }

  /** Sends hello and consumes JSON frames until the poke completes. */
  async becomeReady(): Promise<void> {
    this.#ws.send(
      JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, schemaVersion: 1, cursor: null }),
    )
    for (;;) {
      const msg = await this.nextJson()
      if (msg.type === 'error') throw new Error(`hello failed: ${msg.code} ${msg.message ?? ''}`)
      if (msg.type === 'pokeEnd') return
    }
  }

  async reconnectReady(): Promise<void> {
    this.close()
    this.#json = []
    this.#frames = []
    await this.open()
    await this.becomeReady()
  }

  sendRaw(bytes: Uint8Array): void {
    this.#ws.send(bytes)
  }

  get(fieldId: string, doc?: Y.Doc): void {
    const sv = doc ? Y.encodeStateVector(doc) : new Uint8Array(0)
    this.sendRaw(encodeFieldFrame(FIELD_MSG_GET, fieldId, sv))
  }

  update(fieldId: string, update: Uint8Array): void {
    this.sendRaw(encodeFieldFrame(FIELD_MSG_UPDATE, fieldId, update))
  }

  close(): void {
    try {
      this.#ws.close(1000, 'test done')
    } catch {
      // already closed
    }
  }

  waitClose(timeoutMs = 2_000): Promise<{ code: number; reason: string }> {
    if (this.closeEvent) return Promise.resolve(this.closeEvent)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for close (${this.clientId})`)), timeoutMs)
      this.#closeWaiters.push((event) => {
        clearTimeout(timer)
        resolve(event)
      })
    })
  }

  nextJson(timeoutMs = 2_000): Promise<ServerMsg> {
    const queued = this.#json.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for a JSON frame (${this.clientId})`)),
        timeoutMs,
      )
      this.#jsonWaiters.push((msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
  }

  nextFrame(timeoutMs = 2_000): Promise<FieldFrame> {
    const queued = this.#frames.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for a field frame (${this.clientId})`)),
        timeoutMs,
      )
      this.#frameWaiters.push((frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
  }

  async expectNoFrame(waitMs = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    if (this.#frames.length > 0) {
      const frame = this.#frames[0]!
      throw new Error(`expected binary silence, got msgType ${frame.msgType} for "${frame.fieldId}"`)
    }
  }
}

/** Runs a local edit and captures the single Yjs update it produced. */
export function edit(doc: Y.Doc, fn: () => void): Uint8Array {
  let captured: Uint8Array | null = null
  const handler = (update: Uint8Array, origin: unknown): void => {
    if (origin !== 'remote') captured = update
  }
  doc.on('update', handler)
  doc.transact(fn)
  doc.off('update', handler)
  if (!captured) throw new Error('edit produced no update')
  return captured
}

/** Applies a server-sent update/diff with the remote origin marker. */
export function applyRemote(doc: Y.Doc, payload: Uint8Array): void {
  Y.applyUpdate(doc, payload, 'remote')
}

/** Deterministic PRNG (the §11 convergence-sim pattern). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
