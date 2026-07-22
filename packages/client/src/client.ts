import {
  PROTOCOL_VERSION,
  cursorEquals,
  serverMsgSchema,
  type ClientMsg,
  type Cursor,
  type ErrorMsg,
  type MutationResult,
  type PatchOp,
  type PokeEndMsg,
} from '@cf-sync/protocol'

export type SyncStatus = 'idle' | 'connecting' | 'syncing' | 'synced' | 'reconnecting' | 'fatal'

/** Minimal socket surface so tests and non-browser runtimes can inject one. */
export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void
}

export type TableWriteOp =
  | { type: 'put'; id: string; value: Record<string, unknown> }
  | { type: 'del'; id: string }

/** What a table (collection adapter) must implement to receive synced data. */
export interface TableHooks {
  begin(): void
  write(op: TableWriteOp): void
  commit(): void
  /** Called inside an open begin()…commit() to reset the table (bootstrap/reset). */
  truncate(): void
  markReady(): void
}

export class MutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MutationError'
  }
}

export interface SyncClientOptions {
  /** Full websocket URL: ws(s)://host/sync/<workspaceId>?clientId=<clientId> */
  url: string
  /**
   * Must be unique per SyncClient instance (per tab/session), never shared
   * across concurrent tabs: the clientId identifies one contiguous mutation
   * sequence.
   */
  clientId: string
  schemaVersion: string
  createSocket?: (url: string) => WebSocketLike
  /** Reject unconfirmed mutations after this long; TanStack DB then rolls back. */
  confirmTimeoutMs?: number
  maxBackoffMs?: number
  onStatusChange?: (status: SyncStatus) => void
  onFatal?: (error: Error) => void
  /** Progress during large pokes (bootstrap): ops received so far vs. still to come. */
  onSyncProgress?: (progress: { receivedOps: number; remainingOps: number }) => void
}

interface OutboxEntry {
  id: number | null // assigned once the server baseline (LMID) is known
  name: string
  args: unknown
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  settled: boolean
}

interface PokeBuffer {
  pokeId: string
  baseMismatch: boolean
  patch: PatchOp[]
  lastMutationIdChanges: Record<string, number>
  mutationResults: MutationResult[]
}

export class SyncClient {
  readonly #opts: Required<Pick<SyncClientOptions, 'url' | 'clientId' | 'schemaVersion'>> & SyncClientOptions
  readonly #tables = new Map<string, TableHooks>()
  readonly #warnedTables = new Set<string>()

  #socket: WebSocketLike | null = null
  #status: SyncStatus = 'idle'
  #cursor: Cursor | null = null
  #confirmedLmid = 0
  #outbox: OutboxEntry[] = []
  #poke: PokeBuffer | null = null
  #syncedThisConnection = false
  #awaitingCatchUp = false
  #needsRebase = false
  #started = false
  #stopped = false
  #attempt = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #retryPushTimer: ReturnType<typeof setTimeout> | null = null
  #flushScheduled = false

  constructor(opts: SyncClientOptions) {
    this.#opts = opts
  }

  get status(): SyncStatus {
    return this.#status
  }

  get cursor(): Cursor | null {
    return this.#cursor
  }

  /**
   * Registers a table's hooks. Returns an unregister function. Registering
   * after the first sync completes forces a full resync, since the engine
   * keeps no mirror of already-applied data — register all collections
   * before meaningful traffic to avoid the extra round-trip.
   */
  registerTable(tbl: string, hooks: TableHooks): () => void {
    if (this.#tables.has(tbl)) throw new Error(`table "${tbl}" is already registered`)
    this.#tables.set(tbl, hooks)
    if (this.#syncedThisConnection) this.#requestFullResync()
    return () => {
      if (this.#tables.get(tbl) === hooks) this.#tables.delete(tbl)
    }
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#setStatus('connecting')
    this.#connect()
  }

  stop(): void {
    this.#stopped = true
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    if (this.#retryPushTimer) clearTimeout(this.#retryPushTimer)
    const socket = this.#socket
    this.#socket = null
    try {
      socket?.close(1000, 'client stopped')
    } catch {
      // already closed
    }
    for (const entry of [...this.#outbox]) {
      this.#settleEntry(entry, new MutationError('Stopped', 'sync client stopped'))
    }
    this.#outbox = []
    this.#setStatus('idle')
  }

  /**
   * Queues a named mutation. Resolves when the server confirms it (the
   * client's LMID reaches the mutation's id), rejects on permanent app error
   * or timeout. Callers apply optimistic state before calling (TanStack DB
   * does this via its transaction lifecycle).
   */
  mutate(name: string, args: unknown): Promise<void> {
    if (this.#status === 'fatal') {
      return Promise.reject(new MutationError('Fatal', 'sync client is in a fatal state'))
    }
    const timeoutMs = this.#opts.confirmTimeoutMs ?? 30_000
    return new Promise<void>((resolve, reject) => {
      const entry: OutboxEntry = { id: null, name, args, resolve, reject, timer: null, settled: false }
      entry.timer = setTimeout(() => {
        this.#settleEntry(entry, new MutationError('Timeout', `mutation "${name}" unconfirmed after ${timeoutMs}ms`))
      }, timeoutMs)
      this.#outbox.push(entry)
      if (this.#syncedThisConnection) {
        entry.id = this.#nextMutationId()
        this.#schedulePush()
      }
    })
  }

  // -------------------------------------------------------------------------
  // connection lifecycle
  // -------------------------------------------------------------------------

  #connect(): void {
    if (this.#stopped) return
    const createSocket = this.#opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike)
    const socket = createSocket(this.#opts.url)
    this.#socket = socket
    this.#syncedThisConnection = false
    socket.addEventListener('open', () => {
      if (socket !== this.#socket) return
      this.#setStatus('syncing')
      this.#sendHello()
    })
    socket.addEventListener('message', (event: { data: unknown }) => {
      if (socket !== this.#socket) return
      this.#onMessage(String(event.data))
    })
    socket.addEventListener('close', () => {
      if (socket !== this.#socket) return
      this.#onDisconnect()
    })
    socket.addEventListener('error', () => {
      // a close event always follows; nothing to do here
    })
  }

  #onDisconnect(): void {
    this.#socket = null
    this.#poke = null
    this.#awaitingCatchUp = false
    if (this.#stopped || this.#status === 'fatal') return
    this.#setStatus('reconnecting')
    const cap = this.#opts.maxBackoffMs ?? 30_000
    const delay = Math.min(cap, 500 * 2 ** this.#attempt) * (0.5 + Math.random() * 0.5)
    this.#attempt++
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay)
  }

  #sendHello(): void {
    this.#awaitingCatchUp = true
    this.#send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: this.#opts.schemaVersion,
      cursor: this.#cursor,
    })
  }

  #requestResync(): void {
    if (this.#awaitingCatchUp || !this.#socket) return
    this.#sendHello()
  }

  #requestFullResync(): void {
    this.#cursor = null
    this.#awaitingCatchUp = false
    if (this.#socket && this.#status !== 'connecting') this.#sendHello()
  }

  // -------------------------------------------------------------------------
  // inbound
  // -------------------------------------------------------------------------

  #onMessage(raw: string): void {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return
    }
    const parsed = serverMsgSchema.safeParse(json)
    if (!parsed.success) return // unknown frame (e.g. pong): ignore
    const msg = parsed.data

    switch (msg.type) {
      case 'pokeStart': {
        this.#poke = {
          pokeId: msg.pokeId,
          baseMismatch: !cursorEquals(msg.baseCursor, this.#cursor),
          patch: [],
          lastMutationIdChanges: {},
          mutationResults: [],
        }
        break
      }
      case 'pokePart': {
        const poke = this.#poke
        if (!poke || poke.pokeId !== msg.pokeId) {
          this.#poke = null
          this.#requestResync()
          break
        }
        poke.patch.push(...msg.patch)
        Object.assign(poke.lastMutationIdChanges, msg.lastMutationIdChanges)
        if (msg.mutationResults) poke.mutationResults.push(...msg.mutationResults)
        if (msg.remaining !== undefined && !poke.baseMismatch) {
          this.#opts.onSyncProgress?.({ receivedOps: poke.patch.length, remainingOps: msg.remaining })
        }
        break
      }
      case 'pokeEnd': {
        const poke = this.#poke
        this.#poke = null
        if (!poke || poke.pokeId !== msg.pokeId) {
          this.#requestResync()
          break
        }
        // A clear poke is a complete state replacement (server reset/import):
        // it is safe to apply from ANY base. Anything else based on a cursor
        // we don't hold means we missed a poke — resync by cursor instead.
        const isReset = poke.patch.some((op) => op.op === 'clear')
        if (poke.baseMismatch && !isReset) {
          this.#requestResync()
          break
        }
        this.#applyPoke(poke, msg)
        break
      }
      case 'error':
        this.#onServerError(msg)
        break
    }
  }

  #applyPoke(poke: PokeBuffer, end: PokeEndMsg): void {
    const hasClear = poke.patch.some((op) => op.op === 'clear')
    const byTable = new Map<string, Extract<PatchOp, { op: 'put' | 'del' }>[]>()
    for (const op of poke.patch) {
      if (op.op === 'clear') continue
      let ops = byTable.get(op.tbl)
      if (!ops) byTable.set(op.tbl, (ops = []))
      ops.push(op)
    }

    const applyOps = (hooks: TableHooks, ops: Extract<PatchOp, { op: 'put' | 'del' }>[]): void => {
      for (const op of ops) {
        hooks.write(op.op === 'put' ? { type: 'put', id: op.id, value: op.value } : { type: 'del', id: op.id })
      }
    }

    if (hasClear) {
      // Reset: every registered table truncates, then rebuilds from the patch
      // inside one sync transaction per table (atomic swap).
      for (const [tbl, hooks] of this.#tables) {
        hooks.begin()
        hooks.truncate()
        applyOps(hooks, byTable.get(tbl) ?? [])
        hooks.commit()
        byTable.delete(tbl)
      }
      for (const tbl of byTable.keys()) this.#warnUnregistered(tbl)
    } else {
      for (const [tbl, ops] of byTable) {
        const hooks = this.#tables.get(tbl)
        if (!hooks) {
          this.#warnUnregistered(tbl)
          continue
        }
        hooks.begin()
        applyOps(hooks, ops)
        hooks.commit()
      }
    }

    // A new backendId is a new history (admin reset / wiped DO): the server
    // no longer knows our LMID, so the outbox renumbers from the new baseline.
    const backendChanged = this.#cursor !== null && this.#cursor.backendId !== end.cursor.backendId
    this.#cursor = end.cursor
    this.#awaitingCatchUp = false

    if (backendChanged) {
      this.#confirmedLmid = poke.lastMutationIdChanges[this.#opts.clientId] ?? 0
      this.#rebaseOutboxIds()
    } else {
      const confirmed = poke.lastMutationIdChanges[this.#opts.clientId]
      if (confirmed !== undefined && confirmed > this.#confirmedLmid) this.#confirmedLmid = confirmed
    }
    this.#settleOutbox(poke.mutationResults)

    if (this.#needsRebase) {
      this.#needsRebase = false
      this.#rebaseOutboxIds()
    }

    if (!this.#syncedThisConnection) {
      this.#syncedThisConnection = true
      this.#attempt = 0
      this.#setStatus('synced')
      for (const hooks of this.#tables.values()) hooks.markReady()
      this.#assignPendingIds()
    }
    this.#schedulePush()
  }

  #onServerError(msg: ErrorMsg): void {
    switch (msg.code) {
      case 'VersionNotSupported':
      case 'Unauthorized':
        this.#fatal(new MutationError(msg.code, msg.message ?? msg.code))
        break
      case 'CursorInvalid':
        this.#requestFullResync()
        break
      case 'PushInvalid':
        // Our mutation-id sequence is out of step with the server. Resync to
        // refresh the confirmed LMID, then renumber unconfirmed mutations.
        this.#needsRebase = true
        this.#requestResync()
        break
      case 'BadMessage':
      case 'Internal':
        if (this.#retryPushTimer) clearTimeout(this.#retryPushTimer)
        this.#retryPushTimer = setTimeout(() => this.#flushPush(), 1_000)
        break
    }
  }

  // -------------------------------------------------------------------------
  // outbox
  // -------------------------------------------------------------------------

  #nextMutationId(): number {
    let max = this.#confirmedLmid
    for (const entry of this.#outbox) if (entry.id !== null && entry.id > max) max = entry.id
    return max + 1
  }

  #assignPendingIds(): void {
    for (const entry of this.#outbox) {
      if (entry.id === null) entry.id = this.#nextMutationId()
    }
  }

  #rebaseOutboxIds(): void {
    let next = this.#confirmedLmid
    for (const entry of this.#outbox) {
      if (!entry.settled) entry.id = ++next
    }
  }

  #settleOutbox(results: MutationResult[]): void {
    const errorById = new Map(results.filter((r) => r.error).map((r) => [r.id, r.error!]))
    for (const entry of [...this.#outbox]) {
      if (entry.id !== null && entry.id <= this.#confirmedLmid) {
        const error = errorById.get(entry.id)
        this.#settleEntry(entry, error ? new MutationError(error.code, error.message) : undefined)
      }
    }
  }

  #settleEntry(entry: OutboxEntry, error?: Error): void {
    if (entry.settled) return
    entry.settled = true
    if (entry.timer) clearTimeout(entry.timer)
    this.#outbox = this.#outbox.filter((e) => e !== entry)
    if (error) entry.reject(error)
    else entry.resolve()
  }

  #schedulePush(): void {
    if (this.#flushScheduled) return
    this.#flushScheduled = true
    queueMicrotask(() => {
      this.#flushScheduled = false
      this.#flushPush()
    })
  }

  #flushPush(): void {
    if (!this.#socket || !this.#syncedThisConnection) return
    const mutations = this.#outbox
      .filter((e) => e.id !== null && e.id > this.#confirmedLmid)
      .sort((a, b) => a.id! - b.id!)
      .map((e) => ({ id: e.id!, name: e.name, args: e.args }))
    if (mutations.length > 0) this.#send({ type: 'push', mutations })
  }

  // -------------------------------------------------------------------------
  // plumbing
  // -------------------------------------------------------------------------

  #send(msg: ClientMsg): void {
    try {
      this.#socket?.send(JSON.stringify(msg))
    } catch {
      // socket is broken; the close event drives reconnection
    }
  }

  #setStatus(status: SyncStatus): void {
    if (this.#status === status) return
    this.#status = status
    this.#opts.onStatusChange?.(status)
  }

  #fatal(error: Error): void {
    this.#setStatus('fatal')
    // markReady so any pending collection.preload() settles instead of hanging.
    for (const hooks of this.#tables.values()) hooks.markReady()
    for (const entry of [...this.#outbox]) this.#settleEntry(entry, error)
    try {
      this.#socket?.close(1000, 'fatal')
    } catch {
      // already closed
    }
    this.#socket = null
    this.#opts.onFatal?.(error)
  }

  #warnUnregistered(tbl: string): void {
    if (this.#warnedTables.has(tbl)) return
    this.#warnedTables.add(tbl)
    console.warn(`[cf-sync] dropping synced data for unregistered table "${tbl}"`)
  }
}
