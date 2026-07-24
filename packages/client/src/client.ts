import {
  AppError,
  CLOSE_REFRESH,
  KEEPALIVE_PING,
  MAX_PRESENCE_BYTES,
  PROTOCOL_VERSION,
  cursorEquals,
  formatIssues,
  isPermanentCloseCode,
  jsonByteSize,
  serverMsgSchema,
  type AnyMutators,
  type AnySyncSchema,
  type AppDefinition,
  type AuthContextOf,
  type ClientMsg,
  type Cursor,
  type ErrorMsg,
  type MutationArgs,
  type MutationResult,
  type MutatorTx,
  type PatchOp,
  type PokeEndMsg,
  type PresencePeer,
  type StandardSchemaV1,
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

/**
 * What `onFatal` receives when the server permanently rejects this client
 * (DESIGN.md §15.2). `code` is the WebSocket close code (4400–4499) when the
 * rejection arrived as a close frame, or the server error code
 * (`VersionNotSupported`, `Unauthorized`) when it arrived in-band. `reason`
 * is the close frame's slug (`membership-revoked`, `project-deleted`) —
 * stable strings apps can branch on.
 */
export class SyncFatalError extends Error {
  constructor(
    readonly code: number | string,
    readonly reason: string,
  ) {
    super(`sync connection permanently rejected (${code}): ${reason}`)
    this.name = 'SyncFatalError'
  }
}

type PresenceInputOf<P> = P extends StandardSchemaV1 ? StandardSchemaV1.InferInput<P> : never
type PresenceStateOf<P> = P extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<P> : never

/**
 * `client.presence` — ephemeral peer state on the existing socket (DESIGN.md
 * §16). The library owns transport and lifecycle: `set` coalesces
 * trailing-edge at `presenceThrottleMs` (safe to call at input frequency) and
 * the last state is re-announced on every reconnect, so apps write neither
 * throttle nor reconnect glue. Peers exclude self (render your own state from
 * your own source of truth) and reset to empty on disconnect — stale presence
 * is worse than absent presence. Requires a `presence` schema in `defineApp`;
 * without one `set`/`clear` throw (and the state type is `never`).
 */
export interface PresenceApi<TIn = unknown, TOut = unknown> {
  /** Replace this client's presence state. Validated locally; fail-fast like mutate-time args. */
  set(state: TIn): void
  /**
   * Shallow-merge into the current state — `update({ cursor })` from one call
   * site never clobbers what another call site set, so no component has to
   * hold the canonical whole. The merged result is validated like `set`
   * (starting from `{}` when nothing is set, so required fields must arrive
   * by then). Clear one field with `update({ field: undefined })`.
   */
  update(state: Partial<TIn>): void
  /** Clear this client's presence; peers see `state: null`. */
  clear(): void
  /**
   * This client's own last-set state (parsed, defaults applied — the same
   * shape peers receive of you), or null when unset/cleared. Presence never
   * round-trips to self: render "you" from here, not from `peers`.
   */
  readonly self: TOut | null
  /** Synchronous snapshot of peers, self excluded. Stable identity between changes. */
  readonly peers: ReadonlyArray<PresencePeer<TOut>>
  /** Notifies on any peer change; returns an unsubscribe function. Plugs into `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void
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
  P extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
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
  app: AppDefinition<S, M, P>
  /**
   * This client's own view of its auth context — the same shape the server's
   * `authorize` hook stamps (typed by the registry's `authContext` schema).
   * Optimistic mutator runs see it as `ctx.auth` with
   * `ctx.authoritative: false`, so permission checks written without the
   * `authoritative` guard fail fast locally instead of surfacing as a server
   * round-trip rejection. Validated against the app's `authContext` schema at
   * construction when one is declared. The server's stamps remain
   * authoritative either way.
   */
  auth?: AuthContextOf<M>
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
  /**
   * Memory-only clients (no `store`/`persist`): reject unconfirmed mutations
   * after this long — the mutation is discarded and TanStack DB rolls the
   * optimistic overlay back, which is honest because nothing would survive a
   * reload anyway. Ignored when a durable store is present: a queued mutation
   * survives reloads and still applies when connectivity returns, so the
   * promise stays pending until a connection confirms it (it settles early
   * only on permanent app error, `stop()`, or a fatal). Default: 30s.
   */
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
  /**
   * Trailing-edge coalescing cadence for `presence.set` — the client sends at
   * most one presence frame per window, carrying the latest state, so apps
   * call `set` at input frequency without throttle glue. Default: 100ms
   * (Liveblocks' default, proven at far larger scale).
   */
  presenceThrottleMs?: number
  /**
   * The presence state announced as soon as the connection is ready, before
   * any `presence.set` call — Liveblocks' initialPresence-at-room-entry
   * shape. Provide identity here once (validated at construction, like
   * `auth`) and every later call can be a bare `presence.update(partial)`:
   * without it, an `update` firing before some component's `set` (mount
   * order, a mousemove handler) merges into `{}` and throws on missing
   * required fields — a race that presents as a schema error. Requires a
   * `presence` schema in the app.
   */
  initialPresence?: PresenceInputOf<P>
  /** Constructor-time convenience; for dynamic subscribers use `subscribeStatus`. */
  onStatusChange?: (status: SyncStatus) => void
  /**
   * Called when the server permanently rejects this client — an in-band
   * VersionNotSupported/Unauthorized error, or a close code in the permanent
   * band [4400, 4499] (an `authorize` rejection or an admin kick, DESIGN.md
   * §15.2). The error carries the close `{code, reason}`, so apps can branch
   * on the rejection slug:
   *
   * ```ts
   * onFatal: (err) => {
   *   if (err.reason === 'membership-revoked') return leaveProject()
   *   if (err.reason === 'project-deleted') return cleanupAndRedirect()
   *   location.reload()
   * }
   * ```
   *
   * Default in the browser: reload the page — the designed recovery for a
   * version mismatch is loading the new bundle — throttled to once per
   * minute per workspace so a bad deploy window (e.g. stale web assets)
   * degrades to a slow retry instead of a reload loop. Pass a handler to
   * customize, or a no-op to disable.
   */
  onFatal?: (error: SyncFatalError) => void
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

export class SyncClient<
  S extends AnySyncSchema = AnySyncSchema,
  M extends AnyMutators = AnyMutators,
  P extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  readonly #opts: SyncClientOptions<S, M, P>
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
  #auth: unknown
  /**
   * Consecutive 4300 (refresh) closes with no intervening ready connection.
   * Only the first reconnects immediately; a streak means something is
   * refreshing on every connect (a bug, or a stuck webhook), and pacing the
   * retries keeps that from becoming a zero-delay authorize storm (§15.2).
   */
  #refreshStreak = 0
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

  // Presence (§16). `#presenceState` is this client's last-set state
  // (undefined = never set, null = cleared); it survives reconnects so the
  // library can re-announce. `#presenceLive` flips on `presencePeers` receipt
  // — the server's "presence is live on this connection" signal — and off on
  // disconnect.
  readonly #presencePeers = new Map<string, PresencePeer>()
  readonly #presenceListeners = new Set<() => void>()
  #presenceState: unknown = undefined
  #presenceSnapshot: ReadonlyArray<PresencePeer> | null = null
  #presenceLive = false
  #presenceTimer: ReturnType<typeof setTimeout> | null = null
  #presenceLastSentAt = 0

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
   * skips the overlay (warns once) but still reaches the server.
   *
   * Settlement is honest about durability: with a durable store
   * (`persist`/`store`) the promise stays *pending* while offline — the
   * mutation is queued durably and applies when connectivity returns, so a
   * rejection always means the mutation will not apply (permanent app error,
   * `stop()`, or fatal). Only memory-only clients reject with `Timeout` after
   * `confirmTimeoutMs`, discarding the mutation along with its overlay.
   */
  readonly mutate: Mutate<M>

  /** Ephemeral peer state on the sync socket — see {@link PresenceApi}. */
  readonly presence: PresenceApi<PresenceInputOf<P>, PresenceStateOf<P>>

  constructor(opts: SyncClientOptions<S, M, P>) {
    if (!opts.workspaceId) throw new Error('SyncClient: workspaceId is required')
    if (opts.store && opts.persist) {
      throw new Error('SyncClient: pass either `store` or `persist`, not both')
    }
    this.#opts = opts
    this.#auth = opts.auth
    if (opts.auth !== undefined && opts.app.authContext) {
      // Fail fast on drift between the app's authorize hook shape and what
      // this client was handed — the same check the server runs at upgrade.
      const result = opts.app.authContext['~standard'].validate(opts.auth)
      if (result instanceof Promise) {
        void result.catch(() => {})
        throw new Error('SyncClient: async authContext validation is not supported')
      }
      if (result.issues) {
        throw new Error(`SyncClient: auth fails the app's authContext schema: ${formatIssues(result.issues)}`)
      }
      this.#auth = result.value
    }
    this.#clientId = opts.clientId ?? defaultClientId(opts.workspaceId)
    this.#url = buildSyncUrl(opts.url, opts.pathPrefix ?? '/sync', opts.workspaceId, this.#clientId)
    this.#store = opts.store ?? (opts.persist ? createDefaultStore(opts.workspaceId, this.#clientId) : undefined)
    this.mutate = buildMutate(Object.keys(opts.app.mutators), (name, args) => this.#mutateByName(name, args))
    const self = this
    this.presence = {
      set: (state) => this.#presenceSet(state),
      update: (partial) => this.#presenceUpdate(partial),
      clear: () => this.#presenceSet(null),
      get self() {
        return self.#presenceState === undefined ? null : self.#presenceState
      },
      get peers() {
        return self.#presencePeersList()
      },
      subscribe: (listener) => {
        self.#presenceListeners.add(listener)
        return () => {
          self.#presenceListeners.delete(listener)
        }
      },
    } as PresenceApi<PresenceInputOf<P>, PresenceStateOf<P>>
    // Announced when the connection reaches ready, exactly like a pre-connect
    // set; invalid state throws here, at construction (fail fast, like auth).
    if (opts.initialPresence !== undefined) this.#presenceSet(opts.initialPresence)
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
    this.#presenceDisconnected()
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
      // No server verdict exists here: no principal, and `authoritative:
      // false` is the honest signal permission checks key on (§15.4).
      def.apply(writes.tx, applyArgs, { clientId: this.#clientId, auth: this.#auth, authoritative: false })
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
    return new Promise<void>((resolve, reject) => {
      const entry: OutboxEntry = { id: null, name, args, resolve, reject, timer: null, settled: false }
      if (this.#store === undefined) {
        // Memory-only: an unconfirmed mutation would not survive a reload, so
        // rejecting (and discarding it) after the timeout is honest. With a
        // durable store the mutation is queued and still applies when
        // connectivity returns — a Timeout rejection there would report a
        // failure that isn't one, so the promise stays pending instead.
        const timeoutMs = this.#opts.confirmTimeoutMs ?? 30_000
        entry.timer = setTimeout(() => {
          this.#settleEntry(entry, new MutationError('Timeout', `mutation "${name}" unconfirmed after ${timeoutMs}ms`))
        }, timeoutMs)
      }
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
    socket.addEventListener('close', (event: { code?: number; reason?: string }) => {
      if (socket !== this.#socket) return
      this.#onDisconnect(event?.code, event?.reason)
    })
    socket.addEventListener('error', () => {
      // a close event always follows; nothing to do here
    })
  }

  #onDisconnect(code?: number, reason?: string): void {
    this.#socket = null
    this.#poke = null
    this.#awaitingCatchUp = false
    this.#stopHeartbeat()
    this.#presenceDisconnected()
    // Close codes are the rejection channel (DESIGN.md §15.2): a browser
    // cannot see the HTTP status of a failed upgrade, so the server
    // accept-then-closes with a policy code instead.
    if (code !== undefined && isPermanentCloseCode(code)) {
      this.#fatal(new SyncFatalError(code, reason || 'connection rejected'))
      return
    }
    if (code === CLOSE_REFRESH) {
      this.#refreshStreak++
      if (this.#refreshStreak === 1) {
        // Expected during normal operation (entitlement/role change, expired
        // stamps): reconnect immediately so authorize re-runs and the new
        // connection carries fresh stamps. Consecutive refreshes with no
        // ready connection in between fall through to the paced backoff.
        this.#setStatus('reconnecting')
        this.#connect()
        return
      }
    }
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
        this.#presenceDisconnected()
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
      case 'presence':
        this.#applyPeerUpdate(msg.clientId, msg.principal, msg.state)
        break
      case 'presencePeers': {
        // The snapshot right after hello is the server's "presence is live"
        // signal: adopt it, then re-announce our own state (§16.4) — apps
        // never write reconnect glue.
        this.#presenceLive = true
        this.#presencePeers.clear()
        for (const peer of msg.peers) {
          if (peer.clientId === this.#clientId) continue
          const entry: PresencePeer = { clientId: peer.clientId, state: peer.state, receivedAt: Date.now() }
          if (peer.principal !== undefined) entry.principal = peer.principal
          this.#presencePeers.set(peer.clientId, entry)
        }
        this.#notifyPresence()
        if (this.#presenceState !== undefined && this.#presenceState !== null) this.#sendPresence()
        break
      }
      case 'presencePoll':
        // Hibernation dropped the server's map (§16.3): re-send unprompted.
        if (this.#presenceState !== undefined && this.#presenceState !== null) this.#sendPresence()
        break
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
      this.#refreshStreak = 0 // a ready connection breaks a 4300 streak
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
        this.#fatal(new SyncFatalError(msg.code, msg.message ?? msg.code))
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
      case 'PresenceInvalid':
        // Local validation should have caught this — reaching here means
        // client/server schema skew (mid-deploy) or a bug. Not worth a
        // reconnect: presence self-heals on the next set.
        console.warn(`[cf-sync] server rejected presence state: ${msg.message ?? 'PresenceInvalid'}`)
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

  #settleEntry(entry: OutboxEntry, error?: Error): void {
    if (!entry.settled) {
      entry.settled = true
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      if (error) entry.reject(error)
      else entry.resolve()
    }
    this.#outbox = this.#outbox.filter((e) => e !== entry)
    this.#persistOutbox()
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
  // presence (§16)
  // -------------------------------------------------------------------------

  #presenceSet(state: unknown): void {
    const schema = this.#opts.app.presence
    if (!schema) {
      throw new Error(
        'SyncClient: the app declares no presence schema — add `presence: <schema>` to defineApp to use client.presence',
      )
    }
    // Validation runs per call even though sends coalesce to one frame per
    // window — deliberate: the throw lands at the offending call site, and
    // `self` always holds a checked value. At presence's 8KB cap the parse
    // plus size measure is microseconds; revisit only with profiler evidence.
    if (state !== null) {
      const result = schema['~standard'].validate(state)
      if (result instanceof Promise) {
        // Async validators can't gate a synchronous set; the server's parse
        // rejects authoritatively (same policy as mutate-time args).
        void result.catch(() => {})
      } else if (result.issues) {
        throw new Error(`SyncClient: presence state fails the app's presence schema: ${formatIssues(result.issues)}`)
      } else {
        // Keep the parsed output (defaults applied): it is what `self`
        // exposes, what `update` merges into, and — matching the server's
        // relay of parsed state — the same shape peers see of you.
        state = result.value
      }
      if (jsonByteSize(state) > MAX_PRESENCE_BYTES) {
        throw new Error(`SyncClient: presence state exceeds ${MAX_PRESENCE_BYTES} bytes`)
      }
    }
    this.#presenceState = state
    this.#schedulePresenceSend()
  }

  #presenceUpdate(partial: unknown): void {
    const current = this.#presenceState
    const base = typeof current === 'object' && current !== null ? current : {}
    this.#presenceSet({ ...base, ...(partial as object) })
  }

  /**
   * Trailing-edge coalescing: at most one frame per cadence window, carrying
   * whatever `#presenceState` holds when it fires — so `set` is safe at input
   * frequency and the last call always wins.
   */
  #schedulePresenceSend(): void {
    if (this.#presenceTimer !== null) return // the pending send picks up the latest state
    const cadence = this.#opts.presenceThrottleMs ?? 100
    const elapsed = Date.now() - this.#presenceLastSentAt
    if (elapsed >= cadence) {
      this.#sendPresence()
      return
    }
    this.#presenceTimer = setTimeout(() => {
      this.#presenceTimer = null
      this.#sendPresence()
    }, cadence - elapsed)
  }

  #sendPresence(): void {
    if (!this.#presenceLive || !this.#socket || this.#presenceState === undefined) return
    this.#presenceLastSentAt = Date.now()
    this.#send({ type: 'presence', state: this.#presenceState })
  }

  #applyPeerUpdate(clientId: string, principal: string | undefined, state: unknown): void {
    if (clientId === this.#clientId) return // self renders from its own source of truth
    if (state === null || state === undefined) {
      if (!this.#presencePeers.delete(clientId)) return
    } else {
      // receivedAt is the §16.3 staleness bound: local receipt time, so apps
      // fade ghost-window entries with one Date.now() comparison instead of
      // wrapping subscribe to keep their own timestamp map.
      const peer: PresencePeer = { clientId, state, receivedAt: Date.now() }
      if (principal !== undefined) peer.principal = principal
      this.#presencePeers.set(clientId, peer)
    }
    this.#notifyPresence()
  }

  /** Peers reset to empty on disconnect — stale presence is worse than absent presence. */
  #presenceDisconnected(): void {
    this.#presenceLive = false
    if (this.#presenceTimer) {
      clearTimeout(this.#presenceTimer)
      this.#presenceTimer = null
    }
    if (this.#presencePeers.size === 0) return
    this.#presencePeers.clear()
    this.#notifyPresence()
  }

  #notifyPresence(): void {
    this.#presenceSnapshot = null
    for (const listener of this.#presenceListeners) listener()
  }

  #presencePeersList(): ReadonlyArray<PresencePeer> {
    // Cached between changes so useSyncExternalStore sees a stable snapshot.
    this.#presenceSnapshot ??= [...this.#presencePeers.values()]
    return this.#presenceSnapshot
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

  #fatal(error: SyncFatalError): void {
    this.#setStatus('fatal')
    this.#stopHeartbeat()
    this.#presenceDisconnected()
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
