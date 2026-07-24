import {
  PROTOCOL_VERSION,
  serverMsgSchema,
  type Cursor,
  type Mutation,
  type PokeEndMsg,
  type PokePartMsg,
  type ServerMsg,
} from '@cf-sync/protocol'
import { SELF } from 'cloudflare:test'

export interface Poke {
  baseCursor: Cursor | null
  patch: PokePartMsg['patch']
  lastMutationIdChanges: Record<string, number>
  mutationResults: NonNullable<PokePartMsg['mutationResults']>
  cursor: Cursor
  end: PokeEndMsg
}

/** Presence frames travel beside poke traffic; tests read them from their own lane. */
export type PresenceLaneMsg = Extract<ServerMsg, { type: 'presence' | 'presencePeers' | 'presencePoll' }>
type SyncLaneMsg = Exclude<ServerMsg, PresenceLaneMsg>

function isPresenceLane(msg: ServerMsg): msg is PresenceLaneMsg {
  return msg.type === 'presence' || msg.type === 'presencePeers' || msg.type === 'presencePoll'
}

/**
 * A raw protocol client for exercising the DO contract from tests. It keeps a
 * materialized row map so convergence can be asserted structurally.
 */
export class TestClient {
  readonly rows = new Map<string, Record<string, unknown>>()
  cursor: Cursor | null = null
  lmid = 0
  /** The app schema this client claims at hello (rollout tests override it). */
  schemaVersion = 1
  errors: Extract<ServerMsg, { type: 'error' }>[] = []
  /** The close event, once one arrives (session-control assertions). */
  closeEvent: { code: number; reason: string } | null = null

  #ws!: WebSocket
  #queue: SyncLaneMsg[] = []
  #waiters: Array<(msg: SyncLaneMsg) => void> = []
  #presenceQueue: PresenceLaneMsg[] = []
  #presenceWaiters: Array<(msg: PresenceLaneMsg) => void> = []
  #closeWaiters: Array<(event: { code: number; reason: string }) => void> = []
  #partial: { pokeId: string; baseCursor: Cursor | null; parts: PokePartMsg[] } | null = null

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
  ): Promise<TestClient> {
    const client = new TestClient(workspaceId, clientId, prefix, headers)
    await client.#open()
    return client
  }

  async #open(): Promise<void> {
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
      if (this.#ws !== ws) return // stale socket after a reconnect
      const parsed = serverMsgSchema.safeParse(JSON.parse(String(event.data)))
      if (!parsed.success) return
      const msg = parsed.data
      if (isPresenceLane(msg)) {
        const waiter = this.#presenceWaiters.shift()
        if (waiter) waiter(msg)
        else this.#presenceQueue.push(msg)
        return
      }
      if (msg.type === 'error') this.errors.push(msg)
      const waiter = this.#waiters.shift()
      if (waiter) waiter(msg)
      else this.#queue.push(msg)
    })
    ws.addEventListener('close', (event: CloseEvent) => {
      if (this.#ws !== ws) return
      this.closeEvent = { code: event.code, reason: event.reason }
      for (const waiter of this.#closeWaiters.splice(0)) waiter(this.closeEvent)
    })
  }

  send(msg: unknown): void {
    this.#ws.send(JSON.stringify(msg))
  }

  hello(): void {
    this.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, schemaVersion: this.schemaVersion, cursor: this.cursor })
  }

  push(mutations: Mutation[]): void {
    this.send({ type: 'push', mutations })
  }

  close(): void {
    this.#ws.close(1000, 'test done')
  }

  async reconnect(): Promise<void> {
    this.close()
    // Discard anything from the old connection, including a half-received
    // poke: the post-reconnect catch-up supersedes it.
    this.#queue = []
    this.#presenceQueue = []
    this.#partial = null
    await this.#open()
  }

  /** Resolves with the close event (immediately if the socket already closed). */
  waitClose(timeoutMs = 2_000): Promise<{ code: number; reason: string }> {
    if (this.closeEvent) return Promise.resolve(this.closeEvent)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for close (client ${this.clientId})`)),
        timeoutMs,
      )
      this.#closeWaiters.push((event) => {
        clearTimeout(timer)
        resolve(event)
      })
    })
  }

  next(timeoutMs = 2_000): Promise<SyncLaneMsg> {
    const queued = this.#queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for a message (client ${this.clientId})`)), timeoutMs)
      this.#waiters.push((msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
  }

  /** Reads the next presence-lane frame (presence / presencePeers / presencePoll). */
  nextPresence(timeoutMs = 2_000): Promise<PresenceLaneMsg> {
    const queued = this.#presenceQueue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for a presence frame (client ${this.clientId})`)),
        timeoutMs,
      )
      this.#presenceWaiters.push((msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
  }

  /** Sets or clears (null) this client's presence state. */
  presence(state: unknown): void {
    this.send({ type: 'presence', state })
  }

  /** Reads one complete poke (start → parts → end) and applies it to `rows`. */
  async nextPoke(timeoutMs = 2_000): Promise<Poke> {
    for (;;) {
      const msg = await this.next(timeoutMs)
      if (msg.type === 'error') throw new Error(`server error: ${msg.code} ${msg.message ?? ''}`)
      if (msg.type === 'pokeStart') {
        this.#partial = { pokeId: msg.pokeId, baseCursor: msg.baseCursor, parts: [] }
        continue
      }
      if (msg.type === 'pokePart') {
        if (this.#partial?.pokeId !== msg.pokeId) throw new Error('pokePart without matching pokeStart')
        this.#partial.parts.push(msg)
        continue
      }
      // pokeEnd
      const partial = this.#partial
      this.#partial = null
      if (partial?.pokeId !== msg.pokeId) throw new Error('pokeEnd without matching pokeStart')
      const poke: Poke = {
        baseCursor: partial.baseCursor,
        patch: partial.parts.flatMap((p) => p.patch),
        lastMutationIdChanges: Object.assign({}, ...partial.parts.map((p) => p.lastMutationIdChanges ?? {})),
        mutationResults: partial.parts.flatMap((p) => p.mutationResults ?? []),
        cursor: msg.cursor,
        end: msg,
      }
      this.#apply(poke)
      return poke
    }
  }

  /** Waits for pokes until this client's confirmed LMID reaches `target`. */
  async pokeUntilLmid(target: number, timeoutMs = 2_000): Promise<void> {
    while (this.lmid < target) await this.nextPoke(timeoutMs)
  }

  /** Waits for pokes until the cursor reaches at least `version`. */
  async pokeUntilVersion(version: number, timeoutMs = 2_000): Promise<void> {
    while ((this.cursor?.version ?? -1) < version) await this.nextPoke(timeoutMs)
  }

  async syncOnce(): Promise<Poke> {
    this.hello()
    return this.nextPoke()
  }

  async expectNoMessage(waitMs = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    if (this.#queue.length > 0) {
      throw new Error(`expected silence, got ${JSON.stringify(this.#queue[0])}`)
    }
  }

  async expectNoPresence(waitMs = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    if (this.#presenceQueue.length > 0) {
      throw new Error(`expected presence silence, got ${JSON.stringify(this.#presenceQueue[0])}`)
    }
  }

  #apply(poke: Poke): void {
    for (const op of poke.patch) {
      if (op.op === 'clear') this.rows.clear()
      else if (op.op === 'put') this.rows.set(`${op.tbl}/${op.id}`, op.value)
      else this.rows.delete(`${op.tbl}/${op.id}`)
    }
    this.cursor = poke.cursor
    const confirmed = poke.lastMutationIdChanges[this.clientId]
    if (confirmed !== undefined && confirmed > this.lmid) this.lmid = confirmed
  }
}

/** Deterministic PRNG for the convergence simulation. */
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
