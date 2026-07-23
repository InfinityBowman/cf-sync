import {
  AppError,
  KEEPALIVE_PING,
  PROTOCOL_VERSION,
  cursorEquals,
  formatIssues,
  serverMsgSchema,
  type AnyMutators,
  type AnySyncSchema,
  type AppDefinition,
  type ClientMsg,
  type Cursor,
  type ErrorMsg,
  type MutationArgs,
  type MutationResult,
  type MutatorTx,
  type PatchOp,
  type PokeEndMsg,
  type TableSchema,
} from '@cf-sync/protocol'
import { IndexedDBSyncStore } from './idb-store'
import type { PersistedOutboxEntry, PersistedRowOp, PersistedState, SyncStore } from './store'

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

/**
 * What a table's collection exposes for optimistic intent execution
 * (adapter-facing, like `TableHooks`). Reads must reflect the collection's
 * combined view — synced state plus earlier pending optimistic overlays — so
 * overlapping intents read each other. Writes are only ever invoked inside
 * the `IntentTransactionRunner`'s atomic scope. Row values must be plain data
 * (no adapter-specific virtual fields): they flow back into mutator `tx.get`
 * reads and from there potentially onto the wire.
 */
export interface TableApplier {
  has(id: string): boolean
  get(id: string): Record<string, unknown> | null
  list(): Array<{ id: string; data: Record<string, unknown> }>
  insert(data: Record<string, unknown>): void
  update(id: string, data: Record<string, unknown>): void
  delete(id: string): void
}

/**
 * Runs `flush` (the intent's buffered writes, translated to collection ops)
 * as one atomic optimistic transaction whose sole persistence step is
 * `persist` (enqueue the intent mutation and await server confirm). Must
 * resolve/reject with `persist`'s outcome, roll every flushed write back on
 * rejection, and — critically — still call `persist` when `flush` produced
 * zero effective writes (local state may be behind; the server's run is the
 * one that counts).
 */
export type IntentTransactionRunner = (
  intent: string,
  flush: () => void,
  persist: () => Promise<void>,
) => Promise<void>

/**
 * Internal seam for the collection adapter: enqueue a mutation *without* the
 * speculative local run. Collection mutation handlers (`onInsert` etc.) must
 * use this — their optimistic effect already happened via the collection
 * write itself, and routing them through `mutate` would recursively spawn a
 * second transaction re-applying it. Not part of the public API.
 */
export const RAW_MUTATE = Symbol('cf-sync.rawMutate')

export class MutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MutationError'
  }
}

type NamespaceHeads<K extends string> = K extends `${infer H}.${string}` ? H : K
type NamespaceSub<M, H extends string> = {
  [K in keyof M & `${H}.${string}` as K extends `${H}.${infer R}` ? R : never]: M[K]
}

/**
 * The property-access half of `client.mutate`: dots in mutator names become
 * namespaces, so `'todos.clearCompleted'` is called as
 * `client.mutate.todos.clearCompleted()` — names autocomplete, args are typed
 * from the mutator's schema. (`defineMutators` rejects a name that is both a
 * mutator and a namespace prefix of another, so the tree is unambiguous.)
 */
export type MutateNamespace<M> = {
  [H in NamespaceHeads<keyof M & string>]: H extends keyof M
    ? (...args: MutationArgs<M[H]>) => Promise<void>
    : MutateNamespace<NamespaceSub<M, H>>
}

/**
 * `client.mutate` is both a function and a namespace tree: call it with a
 * mutator name (`mutate('todos.clearCompleted')`) or through properties
 * (`mutate.todos.clearCompleted()`). Both forms are identical at runtime.
 */
export type Mutate<M extends AnyMutators> = (<K extends keyof M & string>(
  name: K,
  ...args: MutationArgs<M[K]>
) => Promise<void>) &
  MutateNamespace<M>

/**
 * Builds the callable namespace tree from the registry's names. The root is a
 * function (the string-name form), so leaves and namespaces are attached with
 * defineProperty — plain assignment would throw for names that shadow
 * non-writable function properties like "name" or "length".
 */
function buildMutate(names: Iterable<string>, invoke: (name: string, args: unknown) => Promise<void>): any {
  const define = (node: any, key: string, value: unknown): void => {
    Object.defineProperty(node, key, { value, enumerable: true, configurable: true, writable: true })
  }
  const root: any = (name: string, ...rest: unknown[]) => invoke(name, rest[0])
  for (const name of names) {
    const segments = name.split('.')
    let node = root
    for (const segment of segments.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(node, segment)) define(node, segment, {})
      node = node[segment]
    }
    const leaf = segments[segments.length - 1]!
    const call = (...rest: unknown[]) => invoke(name, rest[0])
    // A registry that dodged defineMutators' prefix check can hold both a
    // mutator "a" and "a.b"; keep any children already attached under the name.
    const existing = Object.prototype.hasOwnProperty.call(node, leaf) ? node[leaf] : undefined
    if (existing !== undefined && typeof existing === 'object') Object.assign(call, existing)
    define(node, leaf, call)
  }
  return root
}

export interface SyncClientOptions<
  S extends AnySyncSchema = AnySyncSchema,
  M extends AnyMutators = AnyMutators,
> {
  /**
   * Base URL of the sync worker — origin plus any mount path, no sync route:
   * `wss://sync.example.com`. `http(s)://` is accepted and converted. The
   * client appends `<pathPrefix>/<workspaceId>?clientId=<clientId>` itself,
   * so the clientId in the URL (which the server binds at upgrade) can never
   * diverge from the one used for confirmation matching.
   */
  url: string
  /**
   * The workspace to sync. Names the server-side Durable Object (via the URL
   * path), the local IndexedDB database, and the collection ids.
   */
  workspaceId: string
  /** URL prefix for sync routes, matching the server router's `pathPrefix`. Default: "/sync". */
  pathPrefix?: string
  /**
   * Identifies one contiguous mutation sequence — unique per SyncClient
   * instance (per tab/session), never shared across concurrent tabs. Default:
   * managed by the library — persisted per workspace in sessionStorage
   * (reload continuity without cross-tab sharing), random where
   * sessionStorage is unavailable.
   */
  clientId?: string
  /**
   * The shared app definition (`defineApp`) — the same object the server is
   * configured with: schema version, table schemas, and mutator registry.
   * Collections created via `workspaceCollectionOptions` derive their row
   * types and runtime validation from its schema; `mutate` is typed by
   * mutator name and validates args locally before queueing, so bad calls
   * fail immediately instead of surfacing as a server round-trip error (the
   * server's validation remains authoritative).
   */
  app: AppDefinition<S, M>
  /**
   * Durable storage for synced rows, the cursor, and the outbox. When set,
   * start() hydrates registered tables from the store (collections show
   * cached data before the socket connects), hello resumes from the
   * persisted cursor, and unconfirmed mutations survive reloads. A schema
   * version mismatch discards the cache and bootstraps fresh.
   */
  store?: SyncStore
  /**
   * Shorthand for the common case: `store: new IndexedDBSyncStore(...)`
   * built from `workspaceId` and the managed clientId. Where IndexedDB is
   * unavailable (SSR, some workers), the client warns and runs without
   * persistence instead of throwing. Mutually exclusive with `store`.
   */
  persist?: boolean
  /**
   * Connect on construction (the default). Pass false when construction and
   * connection must be decoupled — SSR (module-scope construction would open
   * sockets from the server; Node 22+ has a global WebSocket), tests, or
   * apps that gate syncing on auth — and call `start()` yourself.
   */
  autoStart?: boolean
  createSocket?: (url: string) => WebSocketLike
  /** Reject unconfirmed mutations after this long; TanStack DB then rolls back. */
  confirmTimeoutMs?: number
  maxBackoffMs?: number
  /**
   * Keepalive ping cadence. Pings keep idle edge connections alive (the
   * server's auto-response answers without waking the DO) and give the
   * heartbeat a liveness signal. 0 disables the heartbeat entirely.
   * Default: 25s.
   */
  pingIntervalMs?: number
  /**
   * Force a reconnect when no frame of any kind has arrived for this long —
   * the only way to detect a half-open socket, which never emits a close
   * event. Default: 2×pingInterval + 5s.
   */
  idleTimeoutMs?: number
  /** Constructor-time convenience; for dynamic subscribers use `subscribeStatus`. */
  onStatusChange?: (status: SyncStatus) => void
  /**
   * Called when the server permanently rejects this client
   * (VersionNotSupported, Unauthorized). Default in the browser: reload the
   * page — the designed recovery for a version mismatch is loading the new
   * bundle — throttled to once per minute per workspace so a bad deploy
   * window (e.g. stale web assets) degrades to a slow retry instead of a
   * reload loop. Pass a handler to customize, or a no-op to disable.
   */
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

export class SyncClient<S extends AnySyncSchema = AnySyncSchema, M extends AnyMutators = AnyMutators> {
  readonly #opts: SyncClientOptions<S, M>
  readonly #clientId: string
  readonly #url: string
  readonly #store: SyncStore | undefined
  readonly #tables = new Map<string, TableHooks>()
  readonly #appliers = new Map<string, TableApplier>()
  readonly #warnedTables = new Set<string>()
  readonly #warnedNoApplier = new Set<string>()
  readonly #statusListeners = new Set<(status: SyncStatus) => void>()
  #intentRunner: IntentTransactionRunner | null = null

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
  #persistScheduled = false
  #hydrating = false
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null
  #startNudgeTimer: ReturnType<typeof setTimeout> | null = null
  #lastFrameAt = 0

  /**
   * Applies a named mutation optimistically and queues it for the server.
   * Callable two ways — `mutate.todos.clearCompleted(args)` (dots in mutator
   * names are namespaces; names and args are typed from the app's registry)
   * or `mutate('todos.clearCompleted', args)` — both identical at runtime.
   * Resolves when the server confirms the mutation (the client's LMID reaches
   * the mutation's id), rejects on permanent app error or timeout. Args are
   * validated locally before queueing (the wire still carries the original
   * args — the server's parse is authoritative).
   *
   * When collections are attached (`createCollections` /
   * `workspaceCollectionOptions`), the shared mutator's `apply` runs locally
   * first against the collections' current view, and its writes land as one
   * atomic optimistic overlay: visible immediately, swapped for the server's
   * authoritative patch on confirm, rolled back together on rejection. The
   * overlay is a frozen prediction — a remote change arriving mid-flight
   * rebases the *originally computed* writes, and the confirm patch replaces
   * them with the server's authoritative result (which ran against current
   * state). A mutator that throws `AppError` locally rejects immediately and
   * queues nothing; one that touches a table without an attached collection
   * skips the overlay (warns once) but still reaches the server. Note that a
   * `Timeout` rejection rolls the overlay back while — with a durable store —
   * the mutation *stays queued*: rejection means "your overlay is gone", not
   * "this will never apply"; the rows reappear if the mutation later confirms.
   */
  readonly mutate: Mutate<M>

  constructor(opts: SyncClientOptions<S, M>) {
    if (!opts.workspaceId) throw new Error('SyncClient: workspaceId is required')
    if (opts.store && opts.persist) {
      throw new Error('SyncClient: pass either `store` or `persist`, not both')
    }
    this.#opts = opts
    this.#clientId = opts.clientId ?? defaultClientId(opts.workspaceId)
    this.#url = buildSyncUrl(opts.url, opts.pathPrefix ?? '/sync', opts.workspaceId, this.#clientId)
    this.#store = opts.store ?? (opts.persist ? createDefaultStore(opts.workspaceId, this.#clientId) : undefined)
    this.mutate = buildMutate(Object.keys(opts.app.mutators), (name, args) => this.#mutateByName(name, args))
    // Nothing consumes registered tables synchronously (hydration awaits the
    // store; a real socket's open event is async), so collections created
    // right after the constructor still attach before the first sync.
    if (opts.autoStart !== false) this.start()
  }

  get status(): SyncStatus {
    return this.#status
  }

  get cursor(): Cursor | null {
    return this.#cursor
  }

  get workspaceId(): string {
    return this.#opts.workspaceId
  }

  /** The resolved clientId — the configured one, or the library-managed default. */
  get clientId(): string {
    return this.#clientId
  }

  /** The app definition this client was constructed with. */
  get app(): AppDefinition<S, M> {
    return this.#opts.app
  }

  /** The table schema from the app definition (used by collections). */
  get schema(): S {
    return this.#opts.app.schema
  }

  /**
   * Subscribes to status changes; returns an unsubscribe function. An arrow
   * property, so it can be passed around unbound — it plugs directly into
   * React: `useSyncExternalStore(client.subscribeStatus, () => client.status)`.
   */
  readonly subscribeStatus = (listener: (status: SyncStatus) => void): (() => void) => {
    this.#statusListeners.add(listener)
    return () => {
      this.#statusListeners.delete(listener)
    }
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
    if (!this.#started && this.#startNudgeTimer === null) {
      // Forgetting start() otherwise yields silent nothing: collections sit
      // empty and mutations queue forever. Make it loud instead.
      this.#startNudgeTimer = setTimeout(() => {
        this.#startNudgeTimer = null
        if (!this.#started && !this.#stopped) {
          console.warn('[cf-sync] tables are registered but start() was never called — nothing will sync')
        }
      }, 5_000)
    }
    return () => {
      if (this.#tables.get(tbl) === hooks) this.#tables.delete(tbl)
    }
  }

  /**
   * Attaches a table's collection applier so `mutate` can run the shared
   * mutator locally for an instant optimistic effect (adapter-facing, like
   * `registerTable`; `workspaceCollectionOptions` and `createCollections`
   * call it for you). Re-registering a table replaces its applier. The
   * runner supplies the atomic-transaction primitive; every adapter passes
   * an equivalent one, so the last registration wins.
   */
  registerApplier(tbl: string, applier: TableApplier, runner: IntentTransactionRunner): void {
    this.#appliers.set(tbl, applier)
    this.#intentRunner = runner
  }

  /** Begins hydration and connection. Called from the constructor unless `autoStart: false`; idempotent. */
  start(): void {
    if (this.#started) return
    this.#started = true
    this.#clearStartNudge()
    this.#setStatus('connecting')
    const store = this.#store
    if (store) {
      this.#hydrating = true
      void this.#hydrate(store).finally(() => {
        this.#hydrating = false
        // Flush mutations queued while hydrating; skip when empty so a
        // discarded cache (schema mismatch) stays discarded.
        if (this.#outbox.length > 0) this.#persistOutbox()
        if (!this.#stopped) this.#connect()
      })
    } else {
      this.#connect()
    }
  }

  stop(): void {
    this.#stopped = true
    this.#clearStartNudge()
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    if (this.#retryPushTimer) clearTimeout(this.#retryPushTimer)
    this.#stopHeartbeat()
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
   * Restores persisted state before the first connection: outbox entries
   * re-queue under their original ids (LMID makes replay exactly-once), and
   * cached rows feed registered tables so collections are ready with data
   * before any network I/O. Restored mutations have no awaiting caller, so
   * they carry no confirm timeout — they stay queued until the server
   * settles them.
   */
  async #hydrate(store: SyncStore): Promise<void> {
    let state: PersistedState | null = null
    try {
      state = await store.load()
    } catch (err) {
      console.warn('[cf-sync] failed to load persisted state; bootstrapping fresh', err)
      return
    }
    if (!state || this.#stopped) return
    if (state.schemaVersion !== null && state.schemaVersion !== this.#opts.app.version) {
      // The cache (and any queued mutations) target a different app schema.
      // Safest is to drop both and bootstrap from the server.
      try {
        await store.reset()
      } catch (err) {
        console.warn('[cf-sync] failed to reset persisted state', err)
      }
      return
    }

    this.#cursor = state.cursor
    this.#confirmedLmid = state.confirmedLmid
    const noop = (): void => {}
    const restored: OutboxEntry[] = state.outbox.map((e) => ({
      id: e.id,
      name: e.name,
      args: e.args,
      resolve: noop,
      reject: noop,
      timer: null,
      settled: false,
    }))
    // Mutations queued while hydration was in flight sort after restored ones.
    this.#outbox = [...restored, ...this.#outbox]

    if (state.cursor === null) return // outbox-only state: nothing to show yet
    const byTable = new Map<string, PersistedState['rows']>()
    for (const row of state.rows) {
      let rows = byTable.get(row.tbl)
      if (!rows) byTable.set(row.tbl, (rows = []))
      rows.push(row)
    }
    for (const [tbl, hooks] of this.#tables) {
      hooks.begin()
      for (const row of byTable.get(tbl) ?? []) {
        hooks.write({ type: 'put', id: row.id, value: row.value })
      }
      hooks.commit()
      hooks.markReady()
      byTable.delete(tbl)
    }
    for (const tbl of byTable.keys()) this.#warnUnregistered(tbl)
  }

  /** The runtime behind both forms of `mutate` (see the property's docs). */
  #mutateByName(name: string, args: unknown): Promise<void> {
    if (this.#status === 'fatal') {
      return Promise.reject(new MutationError('Fatal', 'sync client is in a fatal state'))
    }
    const def = (this.#opts.app.mutators as AnyMutators)[name]
    if (!def) {
      return Promise.reject(
        new MutationError('UnknownMutator', `no mutator named "${name}" in the app passed to SyncClient`),
      )
    }
    let applyArgs: unknown = args
    if (def.args) {
      const result = def.args['~standard'].validate(args)
      if (result instanceof Promise) {
        // Async validators can't gate a synchronous queue (or a synchronous
        // local run); the server rejects them authoritatively.
        void result.catch(() => {})
        return this.#enqueue(name, args)
      }
      if (result.issues) {
        return Promise.reject(
          new MutationError('InvalidArgs', `invalid args for "${name}": ${formatIssues(result.issues)}`),
        )
      }
      // The local run mirrors the server: apply sees the parsed args.
      applyArgs = result.value
    }

    const runner = this.#intentRunner
    if (!runner || this.#appliers.size === 0) return this.#enqueue(name, args)

    // Speculative run against a buffered write set (the client mirror of the
    // server's WriteSet): reads see the buffer first, then the collections'
    // optimistic view; puts validate through the table schema so the overlay
    // carries the parsed output (defaults applied) — the same shape the
    // confirm poke will carry.
    const writes = new LocalWriteSet(this.schema, this.#appliers)
    try {
      def.apply(writes.tx, applyArgs, { clientId: this.#clientId })
    } catch (err) {
      if (err instanceof MissingApplierError) {
        this.#warnNoApplier(name, err.tbl)
        return this.#enqueue(name, args)
      }
      // Fail fast, nothing queued: an AppError here would be a permanent
      // server rejection too (mutators must reserve throws for genuine
      // invariant violations, not "row not synced yet" races).
      if (err instanceof AppError) {
        return Promise.reject(new MutationError(err.code, err.message))
      }
      const detail = err instanceof Error ? err.message : String(err)
      return Promise.reject(
        new MutationError('LocalApplyFailed', `mutator "${name}" threw during local apply: ${detail}`),
      )
    }
    if (writes.isEmpty()) return this.#enqueue(name, args)
    return runner(
      name,
      () => this.#flushLocalWrites(writes),
      () => this.#enqueue(name, args),
    )
  }

  /**
   * The adapter's raw path (see `RAW_MUTATE`): validate and enqueue, no
   * speculative local run — collection mutation handlers already *are* the
   * optimistic effect.
   */
  [RAW_MUTATE](name: string, args: unknown): Promise<void> {
    if (this.#status === 'fatal') {
      return Promise.reject(new MutationError('Fatal', 'sync client is in a fatal state'))
    }
    const def = (this.#opts.app.mutators as AnyMutators)[name]
    if (!def) {
      return Promise.reject(
        new MutationError('UnknownMutator', `no mutator named "${name}" in the app passed to SyncClient`),
      )
    }
    if (def.args) {
      const result = def.args['~standard'].validate(args)
      if (result instanceof Promise) {
        void result.catch(() => {})
      } else if (result.issues) {
        return Promise.reject(
          new MutationError('InvalidArgs', `invalid args for "${name}": ${formatIssues(result.issues)}`),
        )
      }
    }
    return this.#enqueue(name, args)
  }

  /** Translates an intent's net writes to collection ops (inside the runner's atomic scope). */
  #flushLocalWrites(writes: LocalWriteSet): void {
    for (const { tbl, id, data } of writes.puts()) {
      const applier = this.#appliers.get(tbl)
      if (!applier) continue // detached mid-flight; the server still applies
      if (applier.has(id)) applier.update(id, data)
      else applier.insert(data)
    }
    for (const { tbl, id } of writes.dels()) {
      const applier = this.#appliers.get(tbl)
      if (applier?.has(id)) applier.delete(id)
    }
  }

  #warnNoApplier(mutator: string, tbl: string): void {
    if (this.#warnedNoApplier.has(tbl)) return
    this.#warnedNoApplier.add(tbl)
    console.warn(
      `[cf-sync] mutator "${mutator}" touched table "${tbl}" which has no attached collection — ` +
        `the mutation still applies on the server, but without a local optimistic effect. ` +
        `Create the table's collection (createCollections covers every schema table) to restore it.`,
    )
  }

  /** Queues a validated mutation; resolves/rejects on server confirm (the LMID contract). */
  #enqueue(name: string, args: unknown): Promise<void> {
    if (this.#status === 'fatal') {
      return Promise.reject(new MutationError('Fatal', 'sync client is in a fatal state'))
    }
    const timeoutMs = this.#opts.confirmTimeoutMs ?? 30_000
    return new Promise<void>((resolve, reject) => {
      const entry: OutboxEntry = { id: null, name, args, resolve, reject, timer: null, settled: false }
      entry.timer = setTimeout(() => {
        // With a durable store the timeout only settles the promise (so the
        // caller's optimistic overlay rolls back); the mutation itself stays
        // queued and still applies when connectivity returns.
        this.#settleEntry(entry, new MutationError('Timeout', `mutation "${name}" unconfirmed after ${timeoutMs}ms`), {
          keepQueued: this.#store !== undefined,
        })
      }, timeoutMs)
      this.#outbox.push(entry)
      if (this.#syncedThisConnection) {
        entry.id = this.#nextMutationId()
        this.#schedulePush()
      }
      this.#persistOutbox()
    })
  }

  // -------------------------------------------------------------------------
  // connection lifecycle
  // -------------------------------------------------------------------------

  #connect(): void {
    if (this.#stopped) return
    const createSocket = this.#opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike)
    let socket: WebSocketLike
    try {
      socket = createSocket(this.#url)
    } catch (err) {
      // Browsers throw synchronously from `new WebSocket` for malformed URLs
      // and some CSP blocks. Treat it as an instant disconnect — an uncaught
      // throw here (especially from the reconnect timer) would kill the
      // reconnect loop permanently.
      console.warn('[cf-sync] failed to create socket; retrying', err)
      this.#socket = null
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket
    this.#syncedThisConnection = false
    socket.addEventListener('open', () => {
      if (socket !== this.#socket) return
      this.#lastFrameAt = Date.now()
      this.#startHeartbeat()
      this.#setStatus('syncing')
      this.#sendHello()
    })
    socket.addEventListener('message', (event: { data: unknown }) => {
      if (socket !== this.#socket) return
      // Any frame counts as liveness — including pongs and frames the
      // message schema does not recognize.
      this.#lastFrameAt = Date.now()
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
    this.#stopHeartbeat()
    this.#scheduleReconnect()
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#status === 'fatal') return
    this.#setStatus('reconnecting')
    const cap = this.#opts.maxBackoffMs ?? 30_000
    const delay = Math.min(cap, 500 * 2 ** this.#attempt) * (0.5 + Math.random() * 0.5)
    this.#attempt++
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay)
  }

  // -------------------------------------------------------------------------
  // heartbeat
  // -------------------------------------------------------------------------

  /**
   * Idle edge connections die unpredictably (NAT/edge timeouts, observed
   * live anywhere from ~75s to >130s), and a half-open socket never emits a
   * close event — send() just vanishes. Pings keep the path warm (the server
   * runtime answers them without waking the DO), and a missed idle deadline
   * is the only reliable dead-socket signal: declare it dead locally and
   * run the normal reconnect + cursor catch-up.
   */
  #startHeartbeat(): void {
    this.#stopHeartbeat()
    const interval = this.#opts.pingIntervalMs ?? 25_000
    if (interval <= 0) return
    const deadline = this.#opts.idleTimeoutMs ?? interval * 2 + 5_000
    this.#heartbeatTimer = setInterval(() => {
      const socket = this.#socket
      if (!socket) return
      if (Date.now() - this.#lastFrameAt > deadline) {
        this.#socket = null // ignore any late events from the dead socket
        try {
          socket.close(4408, 'heartbeat timeout')
        } catch {
          // already dead — that's the point
        }
        this.#poke = null
        this.#awaitingCatchUp = false
        this.#stopHeartbeat()
        this.#scheduleReconnect()
        return
      }
      try {
        socket.send(KEEPALIVE_PING)
      } catch {
        // send failure surfaces via the close event or the next deadline check
      }
    }, interval)
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = null
    }
  }

  #clearStartNudge(): void {
    if (this.#startNudgeTimer) {
      clearTimeout(this.#startNudgeTimer)
      this.#startNudgeTimer = null
    }
  }

  #sendHello(): void {
    this.#awaitingCatchUp = true
    this.#send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: this.#opts.app.version,
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
      this.#confirmedLmid = poke.lastMutationIdChanges[this.#clientId] ?? 0
      this.#rebaseOutboxIds()
    } else {
      const confirmed = poke.lastMutationIdChanges[this.#clientId]
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

    // Durable mirror of what was just applied: rows, cursor, confirmedLmid,
    // and the outbox commit together, so the persisted cursor can never be
    // newer than the persisted rows (see SyncStore contract).
    const store = this.#store
    if (store) {
      const ops: PersistedRowOp[] = []
      for (const op of poke.patch) {
        if (op.op === 'put') ops.push({ op: 'put', tbl: op.tbl, id: op.id, value: op.value })
        else if (op.op === 'del') ops.push({ op: 'del', tbl: op.tbl, id: op.id })
      }
      void store
        .applyPoke({
          ops,
          clear: hasClear,
          cursor: end.cursor,
          schemaVersion: this.#opts.app.version,
          confirmedLmid: this.#confirmedLmid,
          outbox: this.#outboxSnapshot(),
        })
        .catch((err) => console.warn('[cf-sync] failed to persist poke', err))
    }
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
    this.#persistOutbox()
  }

  #rebaseOutboxIds(): void {
    // Everything still in the outbox is unpushed-or-unconfirmed (settled
    // entries only stay queued to be replayed), so all of it renumbers.
    let next = this.#confirmedLmid
    for (const entry of this.#outbox) {
      entry.id = ++next
    }
    this.#persistOutbox()
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

  #settleEntry(entry: OutboxEntry, error?: Error, opts?: { keepQueued?: boolean }): void {
    if (!entry.settled) {
      entry.settled = true
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      if (error) entry.reject(error)
      else entry.resolve()
    }
    if (!opts?.keepQueued) {
      this.#outbox = this.#outbox.filter((e) => e !== entry)
      this.#persistOutbox()
    }
  }

  #schedulePush(): void {
    if (this.#flushScheduled) return
    this.#flushScheduled = true
    queueMicrotask(() => {
      this.#flushScheduled = false
      this.#flushPush()
    })
  }

  #outboxSnapshot(): PersistedOutboxEntry[] {
    return this.#outbox.map((e) => ({ id: e.id, name: e.name, args: e.args }))
  }

  /**
   * Persists the outbox alone (microtask-coalesced). Suppressed during
   * hydration (a partial snapshot would clobber restored entries) and after
   * stop (stopping must not discard the durable outbox).
   */
  #persistOutbox(): void {
    const store = this.#store
    if (!store || this.#hydrating || this.#stopped || this.#persistScheduled) return
    this.#persistScheduled = true
    queueMicrotask(() => {
      this.#persistScheduled = false
      if (this.#stopped) return
      void store
        .saveOutbox(this.#outboxSnapshot(), this.#confirmedLmid)
        .catch((err) => console.warn('[cf-sync] failed to persist outbox', err))
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
    for (const listener of this.#statusListeners) listener(status)
  }

  #fatal(error: Error): void {
    this.#setStatus('fatal')
    this.#stopHeartbeat()
    // markReady so any pending collection.preload() settles instead of hanging.
    for (const hooks of this.#tables.values()) hooks.markReady()
    for (const entry of [...this.#outbox]) this.#settleEntry(entry, error)
    try {
      this.#socket?.close(1000, 'fatal')
    } catch {
      // already closed
    }
    this.#socket = null
    if (this.#opts.onFatal) this.#opts.onFatal(error)
    else defaultFatalRecovery(this.#opts.workspaceId, error)
  }

  #warnUnregistered(tbl: string): void {
    if (this.#warnedTables.has(tbl)) return
    this.#warnedTables.add(tbl)
    console.warn(`[cf-sync] dropping synced data for unregistered table "${tbl}"`)
  }
}

/** Signals the speculative run touched a table with no attached collection (degrade, not error). */
class MissingApplierError extends Error {
  constructor(readonly tbl: string) {
    super(`no collection attached for table "${tbl}"`)
    this.name = 'MissingApplierError'
  }
}

/**
 * Buffers a single intent's local writes — the client mirror of the server's
 * WriteSet (DESIGN.md §6). Reads see the mutation's own buffer first, then
 * fall through to the table's collection (whose view already includes earlier
 * pending intents' overlays, so overlapping intents read each other). Any
 * touched table without an attached collection aborts the speculative run via
 * `MissingApplierError` — a partial overlay would be worse than none.
 */
class LocalWriteSet {
  readonly #puts = new Map<string, { tbl: string; id: string; data: Record<string, unknown> }>()
  readonly #dels = new Map<string, { tbl: string; id: string }>()

  constructor(
    private readonly schema: AnySyncSchema,
    private readonly appliers: Map<string, TableApplier>,
  ) {}

  #applier(tbl: string): TableApplier {
    const applier = this.appliers.get(tbl)
    if (!applier) throw new MissingApplierError(tbl)
    return applier
  }

  readonly tx: MutatorTx = {
    get: (tbl, id) => {
      const applier = this.#applier(tbl)
      const k = rowKey(tbl, id)
      if (this.#dels.has(k)) return null
      const buffered = this.#puts.get(k)
      if (buffered) return structuredClone(buffered.data)
      const row = applier.get(id)
      return row ? structuredClone(row) : null
    },
    list: (tbl) => {
      const applier = this.#applier(tbl)
      const merged = new Map<string, Record<string, unknown>>()
      for (const { id, data } of applier.list()) merged.set(id, structuredClone(data))
      for (const del of this.#dels.values()) if (del.tbl === tbl) merged.delete(del.id)
      for (const put of this.#puts.values()) if (put.tbl === tbl) merged.set(put.id, structuredClone(put.data))
      return [...merged].map(([id, data]) => ({ id, data }))
    },
    put: (tbl, id, data) => {
      // Schema validation first: a table outside the schema is a permanent
      // InvalidArgs on the server too, so fail fast. A schema table without a
      // collection only degrades (checked after).
      const stored = validateLocalRow(this.schema, tbl, id, data as Record<string, unknown>)
      this.#applier(tbl)
      const k = rowKey(tbl, id)
      this.#dels.delete(k)
      this.#puts.set(k, { tbl, id, data: stored })
    },
    del: (tbl, id) => {
      this.#applier(tbl)
      const k = rowKey(tbl, id)
      this.#puts.delete(k)
      this.#dels.set(k, { tbl, id })
    },
  }

  isEmpty(): boolean {
    return this.#puts.size === 0 && this.#dels.size === 0
  }

  puts(): Iterable<{ tbl: string; id: string; data: Record<string, unknown> }> {
    return this.#puts.values()
  }

  dels(): Iterable<{ tbl: string; id: string }> {
    return this.#dels.values()
  }
}

function rowKey(tbl: string, id: string): string {
  return `${tbl}\u0000${id}`
}

/** The client mirror of the server's `validateRow`: parsed output in the overlay, or a permanent AppError. */
function validateLocalRow(
  schema: AnySyncSchema,
  tbl: string,
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const tableSchema = (schema.tables as Record<string, TableSchema>)[tbl]
  if (!tableSchema) {
    throw new AppError('InvalidArgs', `table "${tbl}" is not defined in the schema`)
  }
  const result = tableSchema['~standard'].validate(data)
  if (result instanceof Promise) {
    void result.catch(() => {})
    throw new AppError('InvalidArgs', `table "${tbl}": async validation is not supported`)
  }
  if (result.issues) {
    throw new AppError('InvalidArgs', `invalid row ${tbl}/${id}: ${formatIssues(result.issues)}`)
  }
  return result.value as Record<string, unknown>
}

/**
 * `<base><prefix>/<workspaceId>?clientId=<id>` — the shape createSyncFetch
 * routes. `http(s)` is mapped to `ws(s)`; a trailing slash on the base is
 * tolerated so `location.origin`-derived URLs compose cleanly.
 */
function buildSyncUrl(base: string, prefix: string, workspaceId: string, clientId: string): string {
  const wsBase = base.replace(/^http/, 'ws').replace(/\/+$/, '')
  return `${wsBase}${prefix}/${encodeURIComponent(workspaceId)}?clientId=${encodeURIComponent(clientId)}`
}

/**
 * One clientId per tab/session, per workspace: the clientId names a
 * contiguous mutation sequence, so concurrent tabs must never share one.
 * sessionStorage gives reload continuity without cross-tab sharing; where it
 * is unavailable (SSR, workers, blocked storage), a fresh random id per
 * instance is always safe — it just forfeits reload continuity.
 */
function defaultClientId(workspaceId: string): string {
  const key = `cf-sync:client-id:${encodeURIComponent(workspaceId)}`
  try {
    const stored = sessionStorage.getItem(key)
    if (stored) return stored
    const id = crypto.randomUUID()
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
}

const FATAL_RELOAD_MIN_INTERVAL_MS = 60_000

/**
 * Default fatal handling: reload into the (presumably newer) bundle — the
 * protocol's designed recovery for VersionNotSupported — throttled per
 * workspace so a bad deploy window (stale web assets, a rollback that left
 * the client ahead of the server) degrades to one reload per minute instead
 * of a reload loop. Outside the browser there is nothing to reload; the
 * client just stays stopped in 'fatal'.
 */
function defaultFatalRecovery(workspaceId: string, error: Error): void {
  if (typeof location === 'undefined') {
    console.warn('[cf-sync] fatal, and no onFatal handler to recover:', error)
    return
  }
  const key = `cf-sync:fatal-reload:${encodeURIComponent(workspaceId)}`
  let lastReloadAt = 0
  try {
    lastReloadAt = Number(sessionStorage.getItem(key)) || 0
  } catch {
    // storage blocked: fall through with 0 — reloading is still the best move
  }
  if (Date.now() - lastReloadAt < FATAL_RELOAD_MIN_INTERVAL_MS) {
    console.warn(
      '[cf-sync] fatal again within a minute of reloading — waiting instead of looping (deploy skew?):',
      error,
    )
    return
  }
  try {
    sessionStorage.setItem(key, String(Date.now()))
  } catch {
    // best effort; without storage the throttle just resets per load
  }
  console.warn('[cf-sync] fatal; reloading to pick up the current bundle:', error)
  location.reload()
}

function createDefaultStore(workspaceId: string, clientId: string): SyncStore | undefined {
  try {
    return new IndexedDBSyncStore({ workspaceId, clientId })
  } catch (err) {
    console.warn('[cf-sync] persist: true, but IndexedDB is unavailable — continuing without local persistence', err)
    return undefined
  }
}
