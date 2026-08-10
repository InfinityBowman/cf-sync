import {
  AppError,
  CLOSE_REFRESH,
  MAX_PRESENCE_BYTES,
  isPermanentCloseCode,
  type AnyMutators,
  type AnySyncSchema,
  type AppDefinition,
  type Cursor,
  type PatchOp,
  type PresencePeer,
  type StandardSchemaV1,
} from '@cf-sync/protocol'
import {
  KEEPALIVE_PING,
  PROTOCOL_VERSION,
  cursorEquals,
  formatIssues,
  jsonByteSize,
  serverMsgSchema,
  type ClientMsg,
  type ErrorMsg,
  type MutationResult,
  type PokeEndMsg,
} from '@cf-sync/protocol/internal'
import {
  buildSyncUrl,
  consoleLogger,
  createDefaultStore,
  defaultClientId,
  defaultFatalRecovery,
  withToken,
} from './defaults'
import { MissingApplierError, MutationError, SyncFatalError } from './errors'
import { LocalWriteSet } from './local-writes'
import { buildMutate, type Mutate } from './mutate'
import type { PersistedOutboxEntry, PersistedRowOp, PersistedState, SyncStore } from './store'
import {
  RAW_MUTATE,
  type IntentTransactionRunner,
  type PresenceApi,
  type PresenceInputOf,
  type PresenceStateOf,
  type SyncClientOptions,
  type SyncStatus,
  type TableApplier,
  type TableHooks,
  type WebSocketLike,
} from './types'

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

/**
 * The per-workspace sync client: it owns the WebSocket to the workspace's
 * Durable Object, the outbox of unconfirmed mutations, optimistic application
 * and rollback, presence, and reconnection with cursor catch-up. Construct
 * one instance per workspace per tab — the clientId names one contiguous
 * mutation sequence, so concurrent tabs must never share one (the managed
 * default handles this) — and it connects on construction unless
 * `autoStart: false`. The shared `defineApp` value passed in
 * {@link SyncClientOptions} types `mutate` and the collections;
 * `persist: true` adds the IndexedDB row mirror and a reload-surviving
 * outbox.
 *
 * Attach TanStack DB collections with `createCollections` (or per-table
 * `workspaceCollectionOptions`) for reads and optimistic writes; drive
 * domain logic through {@link mutate}, which runs the shared mutator locally
 * for an instant overlay and settles on the server's verdict. To switch
 * workspaces, {@link destroy} this client and construct a fresh one.
 *
 * @example
 * ```ts
 * import { SyncClient, createCollections } from '@cf-sync/client'
 * import { app } from './schema' // the shared defineApp value
 *
 * const client = new SyncClient({
 *   url: 'wss://sync.example.com', // ws://localhost:8787 in dev
 *   workspaceId: 'my-first-workspace',
 *   app,
 *   persist: true, // IndexedDB mirror + durable offline outbox
 * })
 *
 * const { todos } = createCollections(client)
 *
 * // Optimistic local write, synced as a full-row mutation:
 * todos.insert({ id: crypto.randomUUID(), title: 'ship it' })
 *
 * // Typed intent mutation — instant locally, authoritative on the server:
 * await client.mutate.todo.toggle({ id })
 * ```
 */
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
  readonly #pendingListeners = new Set<(pending: number) => void>()
  readonly #binaryListeners = new Set<(bytes: Uint8Array) => void>()
  readonly #rejectionListeners = new Set<(error: MutationError, mutation: { name: string; args: unknown }) => void>()

  #log(level: 'warn' | 'error', message: string, ...detail: unknown[]): void {
    ;(this.#opts.logger ?? consoleLogger)(level, message, ...detail)
  }
  #warnedBinaryType = false
  #intentRunner: IntentTransactionRunner | null = null

  #socket: WebSocketLike | null = null
  #status: SyncStatus = 'idle'
  #auth: unknown
  /** Bumped on every #connect entry; an async authToken resolution from a superseded attempt is dropped. */
  #connectEpoch = 0
  /**
   * Consecutive 4300 (refresh) closes with no intervening ready connection.
   * Only the first reconnects immediately; a streak means something is
   * refreshing on every connect (a bug, or a stuck webhook), and pacing the
   * retries keeps that from becoming a zero-delay authorize storm (ARCHITECTURE.md#session-control).
   */
  #refreshStreak = 0
  #cursor: Cursor | null = null
  #confirmedLmid = 0
  #outbox: OutboxEntry[] = []
  #notifiedPending = 0
  #poke: PokeBuffer | null = null
  #syncedThisConnection = false
  #awaitingCatchUp = false
  #needsRebase = false
  #started = false
  #stopped = false
  #destroyed = false
  readonly #teardown = new Set<() => void | Promise<void>>()
  #attempt = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #retryPushTimer: ReturnType<typeof setTimeout> | null = null
  #flushScheduled = false
  #persistScheduled = false
  #hydrating = false
  /**
   * The cache-ready latch (ARCHITECTURE.md#offline-first-render). True once hydration restored a
   * cached snapshot and marked collections ready — the signal an offline
   * launch renders on, since `status` is `connecting` on both sides of that
   * edge and an empty collection can't be told from an unhydrated one.
   */
  #hydrated = false
  #settleHydration: ((restored: boolean) => void) | null = null
  readonly #hydratedListeners = new Set<(hydrated: boolean) => void>()
  readonly #whenHydrated = new Promise<boolean>((resolve) => {
    this.#settleHydration = resolve
  })
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null
  #startNudgeTimer: ReturnType<typeof setTimeout> | null = null
  #lastFrameAt = 0

  // Presence (ARCHITECTURE.md#presence). `#presenceState` is this client's last-set state
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
  /** One-time guard: the presence schema must parse its own output (ARCHITECTURE.md#presence). */
  #presenceRoundTripChecked = false
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
   * `destroy()`, or fatal). Only memory-only clients reject with `Timeout` after
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
    this.#auth = opts.authContext
    if (opts.authContext !== undefined && opts.app.authContext) {
      // Fail fast on drift between the app's authorize hook shape and what
      // this client was handed — the same check the server runs at upgrade.
      const result = opts.app.authContext['~standard'].validate(opts.authContext)
      if (result instanceof Promise) {
        void result.catch(() => {})
        throw new Error('SyncClient: async authContext validation is not supported')
      }
      if (result.issues) {
        throw new Error(`SyncClient: authContext fails the app's authContext schema: ${formatIssues(result.issues)}`)
      }
      this.#auth = result.value
    }
    this.#clientId = opts.clientId ?? defaultClientId(opts.workspaceId)
    this.#url = buildSyncUrl(opts.url, opts.pathPrefix ?? '/sync', opts.workspaceId, this.#clientId)
    this.#store = opts.store ?? (opts.persist ? createDefaultStore(opts.workspaceId, this.#clientId, opts.logger ?? consoleLogger) : undefined)
    this.mutate = buildMutate(Object.keys(opts.app.mutators), (name, args) =>
      this.#guardMutation(name, args, this.#mutateByName(name, args)),
    )
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
    // set; invalid state throws here, at construction (fail fast, like authContext).
    if (opts.initialPresence !== undefined) this.#presenceSet(opts.initialPresence)
    // Nothing consumes registered tables synchronously (hydration awaits the
    // store; a real socket's open event is async), so collections created
    // right after the constructor still attach before the first sync.
    if (opts.autoStart !== false) this.start()
  }

  /** The current connection status — see {@link SyncStatus}; subscribe to changes via {@link subscribeStatus}. */
  get status(): SyncStatus {
    return this.#status
  }

  /**
   * Whether locally cached data has been restored and collections are ready
   * to render — the signal offline-first UIs gate their first paint on.
   *
   * `status` cannot answer this: it reads `connecting` both before and after
   * hydration, so an offline launch holding a full cache looks exactly like
   * one holding nothing. Nor can collection contents — an empty collection
   * mid-hydration is indistinguishable from a genuinely empty workspace.
   *
   * True only when there was a cached snapshot to restore. It stays false
   * when no store is configured, when the store is empty (a first launch),
   * when the cache was discarded because it targets a different app version,
   * and when the store failed to load — in each of those cases there is
   * nothing cached to paint, and the UI should wait for the first sync:
   *
   * ```tsx
   * // Render cached rows immediately when offline, otherwise wait for sync.
   * const status = useSyncStatus(client)
   * const hydrated = useHydrated(client)
   * if (status !== 'synced' && !hydrated) return <Spinner />
   * ```
   *
   * Subscribe to the transition via {@link subscribeHydrated}, or await
   * {@link whenHydrated} outside React.
   */
  get hydrated(): boolean {
    return this.#hydrated
  }

  /**
   * Resolves when hydration settles, with the value {@link hydrated} takes —
   * true if a cached snapshot was restored, false if there was nothing to
   * restore. The imperative form of the same signal, for gating a first
   * render outside React:
   *
   * ```ts
   * if (await client.whenHydrated) renderFromCache()
   * ```
   *
   * A client constructed with `autoStart: false` settles this when `start()`
   * runs, or with false if it is destroyed first — it never hangs past the
   * client's life.
   */
  get whenHydrated(): Promise<boolean> {
    return this.#whenHydrated
  }

  /** The last server cursor this client applied, or null before the first sync. */
  get cursor(): Cursor | null {
    return this.#cursor
  }

  /**
   * The number of mutations applied locally but not yet confirmed durable by
   * the server — entries queued before the connection synced and pushed ones
   * awaiting confirmation both count, as do entries restored from the store
   * on startup. 0 means everything this client has issued is on the server.
   *
   * This is the one durability signal that survives a reload: restored
   * entries have no promise to await ({@link mutate} promises do not outlive
   * the client), but they still count here until confirmed. Subscribe to
   * changes via {@link subscribePending}.
   */
  get pending(): number {
    return this.#outbox.length
  }

  /** The workspace this client syncs, as passed at construction. */
  get workspaceId(): string {
    return this.#opts.workspaceId
  }

  /** The resolved clientId — the configured one, or the library-managed default. */
  get clientId(): string {
    return this.#clientId
  }

  /** The app definition this client was constructed with. */
  get app(): AppDefinition<S, M, P> {
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
   * Subscribes to {@link pending} changes; returns an unsubscribe function.
   * Fires only when the count actually changes. An arrow property, so it
   * plugs straight into React:
   * `useSyncExternalStore(client.subscribePending, () => client.pending)`.
   */
  readonly subscribePending = (listener: (pending: number) => void): (() => void) => {
    this.#pendingListeners.add(listener)
    return () => {
      this.#pendingListeners.delete(listener)
    }
  }

  /**
   * Subscribes to {@link hydrated} changes; returns an unsubscribe function.
   * Fires at most once per client — hydration settles one way and stays
   * settled. An arrow property, so it plugs straight into React:
   * `useSyncExternalStore(client.subscribeHydrated, () => client.hydrated)`.
   */
  readonly subscribeHydrated = (listener: (hydrated: boolean) => void): (() => void) => {
    this.#hydratedListeners.add(listener)
    return () => {
      this.#hydratedListeners.delete(listener)
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
          this.#log('warn', '[cf-sync] tables are registered but start() was never called — nothing will sync')
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

  // Binary-lane framing: ARCHITECTURE.md#yjs-fields.
  /**
   * Sends one binary-lane frame — the client half of the extension seam,
   * used by add-ons like `createYjsFields`. Fire-and-forget
   * like every frame on this socket: a broken socket surfaces through the
   * close event, and binary-lane consumers re-sync on the next ready
   * transition (`subscribeStatus` reaching 'synced'), so nothing is lost.
   * The server only accepts binary frames once the connection is ready.
   */
  sendBinary(bytes: Uint8Array): void {
    try {
      this.#socket?.send(bytes)
    } catch {
      // socket is broken; the close event drives reconnection
    }
  }

  /**
   * Subscribes to inbound binary-lane frames; returns an unsubscribe
   * function. Frames are delivered as-received — framing and dispatch belong
   * to the add-on (see `@cf-sync/protocol`'s field-frame helpers).
   */
  onBinary(listener: (bytes: Uint8Array) => void): () => void {
    this.#binaryListeners.add(listener)
    return () => {
      this.#binaryListeners.delete(listener)
    }
  }

  /** Begins hydration and connection. Called from the constructor unless `autoStart: false`; idempotent. */
  start(): void {
    if (this.#destroyed) {
      throw new Error('SyncClient: destroyed — construct a new SyncClient to reconnect this workspace')
    }
    if (this.#started) return
    this.#started = true
    this.#clearStartNudge()
    this.#listenForWake(true)
    this.#setStatus('connecting')
    const store = this.#store
    if (store) {
      this.#hydrating = true
      void this.#hydrate(store)
        // A load failure is a settled hydration with nothing restored, not a
        // pending one — #hydrate already logged it.
        .catch(() => false)
        .then((restored) => {
          this.#hydrating = false
          // Flush mutations queued while hydrating; skip when empty so a
          // discarded cache (schema mismatch) stays discarded.
          if (this.#outbox.length > 0) this.#persistOutbox()
          // Before #connect: the latch describes local state, and a listener
          // must not see 'syncing' arrive ahead of the cache it gates on.
          this.#settleHydrated(restored)
          if (!this.#stopped) this.#connect()
        })
    } else {
      // No store, so nothing to restore — settle false rather than leave
      // awaiters of whenHydrated pending for the client's lifetime.
      this.#settleHydrated(false)
      this.#connect()
    }
  }

  /**
   * Closes the hydration latch exactly once, at whichever of the three ends
   * comes first: hydration settling, a storeless start, or teardown.
   */
  #settleHydrated(restored: boolean): void {
    const settle = this.#settleHydration
    if (!settle) return
    this.#settleHydration = null
    this.#hydrated = restored
    settle(restored)
    if (restored) for (const listener of [...this.#hydratedListeners]) listener(true)
  }

  /**
   * The synchronous half of {@link destroy}: closes the socket, cancels
   * timers, and rejects every unconfirmed `mutate` promise with `Stopped`.
   * The durable outbox is NOT discarded — queued mutations survive and
   * replay when a future client for this workspace hydrates the same store.
   */
  #shutdown(): void {
    this.#stopped = true
    this.#clearStartNudge()
    this.#listenForWake(false)
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
      this.#settleEntry(entry, new MutationError('Stopped', 'sync client stopped', { name: entry.name, args: entry.args }))
    }
    this.#outbox = []
    // A teardown mid-hydration (or before start()) restores nothing, and an
    // awaiter of whenHydrated must not outlive the client.
    this.#settleHydrated(false)
    this.#setStatus('idle')
  }

  /**
   * Reconnect the moment the environment says connectivity is back: without
   * this, a capped-backoff timer can sit out ~30s on a fine network after a
   * laptop reopens. Listens to `online` and `visibilitychange` where a
   * browser environment provides them; a no-op elsewhere.
   */
  readonly #wake = (): void => {
    if (this.#stopped || this.#status !== 'reconnecting') return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (typeof navigator !== 'undefined' && 'onLine' in navigator && navigator.onLine === false) return
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
    this.#connect()
  }

  #listenForWake(on: boolean): void {
    const g = globalThis as {
      addEventListener?: (type: string, cb: () => void) => void
      removeEventListener?: (type: string, cb: () => void) => void
    }
    if (on) {
      g.addEventListener?.('online', this.#wake)
      if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', this.#wake)
    } else {
      g.removeEventListener?.('online', this.#wake)
      if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', this.#wake)
    }
  }

  /**
   * Registers a teardown callback run (and awaited) by {@link destroy} —
   * how resources created against this client tie their lifetime to it
   * (`createCollections` registers each collection's cleanup here). Returns
   * an unregister function. Apps rarely call this directly.
   */
  onDestroy(callback: () => void | Promise<void>): () => void {
    this.#teardown.add(callback)
    return () => {
      this.#teardown.delete(callback)
    }
  }

  /**
   * The one teardown, idempotent. Synchronously: closes the socket, cancels
   * timers, and rejects every unconfirmed `mutate` promise with `Stopped`
   * (all before the first await, so fire-and-forget `void client.destroy()`
   * is safe in unload paths). Then: runs every {@link onDestroy} callback
   * (collections from `createCollections` clean up here) and closes the
   * store's connection when it has a `close`. The instance is inert
   * afterwards — `start()` throws, `mutate` rejects with `Stopped` — and
   * constructing a fresh SyncClient (plus fresh collections) for the same or
   * another workspace is the supported way to (re)connect: the pattern for
   * workspace-per-project apps switching projects. State is not lost: the
   * durable store keeps its rows and outbox for the next client, and this
   * tab's managed clientId is reused, so mutations queued offline still
   * replay exactly once.
   */
  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#shutdown()
    for (const callback of [...this.#teardown]) {
      try {
        await callback()
      } catch (err) {
        this.#log('warn', '[cf-sync] a destroy callback failed', err)
      }
    }
    this.#teardown.clear()
    try {
      await this.#store?.close?.()
    } catch (err) {
      this.#log('warn', '[cf-sync] failed to close the sync store', err)
    }
  }

  /**
   * Restores persisted state before the first connection: outbox entries
   * re-queue under their original ids (LMID makes replay exactly-once), and
   * cached rows feed registered tables so collections are ready with data
   * before any network I/O. Restored entries then replay locally — their
   * mutators re-run against the hydrated base and their writes land as
   * optimistic overlays (ARCHITECTURE.md#optimistic-intents), so the reloaded UI matches the
   * pre-reload optimistic view. Restored mutations have no awaiting caller,
   * so they carry no confirm timeout — they stay queued until the server
   * settles them.
   *
   * Resolves true when a cached snapshot was restored and collections were
   * marked ready — false on every path that leaves nothing to paint (no
   * cache, a discarded one, a load failure, teardown mid-hydration). That
   * answer is what `hydrated` reports (ARCHITECTURE.md#offline-first-render).
   */
  async #hydrate(store: SyncStore): Promise<boolean> {
    let state: PersistedState | null = null
    try {
      state = await store.load()
    } catch (err) {
      this.#log('warn', '[cf-sync] failed to load persisted state; bootstrapping fresh', err)
      return false
    }
    if (!state || this.#stopped) return false
    if (state.schemaVersion !== null && state.schemaVersion !== this.#opts.app.version) {
      // The cache (and any queued mutations) target a different app schema.
      // Safest is to drop both and bootstrap from the server.
      try {
        await store.reset()
      } catch (err) {
        this.#log('warn', '[cf-sync] failed to reset persisted state', err)
      }
      return false
    }

    this.#cursor = state.cursor
    this.#confirmedLmid = state.confirmedLmid
    const noop = (): void => {}
    const restored: OutboxEntry[] = state.outbox.map((e) => ({
      id: e.id,
      name: e.name,
      args: e.args,
      resolve: noop,
      // No awaiting caller survives a reload — onMutationRejected is the one
      // surface that can still report a replayed mutation the server refuses.
      reject: (err) => this.#notifyRejected(err, e.name, e.args),
      timer: null,
      settled: false,
    }))
    // Mutations queued while hydration was in flight sort after restored ones.
    this.#outbox = [...restored, ...this.#outbox]
    this.#notifyPending()

    if (state.cursor !== null) {
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
        byTable.delete(tbl)
      }
      for (const tbl of byTable.keys()) this.#warnUnregistered(tbl)
    }
    // Startup replay (ARCHITECTURE.md#optimistic-intents): rows commit first so the replayed
    // mutators read the hydrated base (outbox-only state replays against
    // empty collections — offline-created rows still reappear), markReady
    // comes last so the first paint is base-plus-overlays, never a flash of
    // pre-mutation state. Sequential on purpose: each laid overlay is
    // visible to the next entry's reads, the same read-your-predecessor
    // property back-to-back live intents have.
    for (const entry of restored) this.#replayEntry(entry)
    if (state.cursor === null) return false
    for (const hooks of this.#tables.values()) hooks.markReady()
    return true
  }

  /**
   * Re-lays one restored outbox entry's optimistic overlay at hydration
   * (ARCHITECTURE.md#optimistic-intents): re-runs the mutator's `apply` against the hydrated
   * collections and flushes the writes through the intent runner, with the
   * persist step tied to the entry's existing settlement — confirm swaps
   * the overlay for the authoritative patch, rejection rolls it back (and
   * still reaches `onMutationRejected` through the entry's reject). The
   * error policy inverts the live fail-fast: degrade, never drop. A local
   * throw here proves nothing about the server's verdict, so any failure
   * skips the overlay and leaves the entry queued.
   */
  #replayEntry(entry: OutboxEntry): void {
    const runner = this.#intentRunner
    if (!runner || this.#appliers.size === 0) return
    const def = (this.#opts.app.mutators as AnyMutators)[entry.name]
    if (!def) return // the server rejects UnknownMutator authoritatively
    let applyArgs: unknown = entry.args
    if (def.args) {
      const result = def.args['~standard'].validate(entry.args)
      if (result instanceof Promise) {
        // Async validators can't gate a synchronous local run; the server
        // rejects them authoritatively (same policy as mutate time).
        void result.catch(() => {})
        return
      }
      if (result.issues) return // the server's parse is authoritative
      applyArgs = result.value
    }
    const writes = new LocalWriteSet(this.schema, this.#appliers)
    try {
      def.apply(writes.tx, applyArgs, { clientId: this.#clientId, auth: this.#auth, authoritative: false })
    } catch (err) {
      if (err instanceof MissingApplierError) {
        this.#warnNoApplier(entry.name, err.tbl)
      } else {
        this.#log('warn',
          `[cf-sync] startup replay of "${entry.name}" threw locally — it stays queued without an optimistic overlay`,
          err,
        )
      }
      return
    }
    if (writes.isEmpty()) return // already queued; nothing to show

    // The overlay's lifetime is the entry's settlement: the entry's
    // resolve/reject become the runner's persist outcome, so the LMID
    // contract that settles the entry also completes (or rolls back) the
    // transaction — while the original reject still routes the error into
    // onMutationRejected.
    const notify = entry.reject
    const settled = new Promise<void>((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = (err) => {
        reject(err)
        notify(err)
      }
    })
    try {
      // No awaiting caller: rejection reaches the app via onMutationRejected.
      void runner(entry.name, () => this.#flushLocalWrites(writes), () => settled).catch(() => {})
    } catch (err) {
      // A synchronous throw from the overlay flush must not kill hydration —
      // restore the entry's original settlement so `settled` never leaks.
      entry.resolve = () => {}
      entry.reject = notify
      this.#log('warn', `[cf-sync] failed to lay the replay overlay for "${entry.name}"`, err)
    }
  }

  /**
   * Routes a mutation promise's rejection into `onMutationRejected` (and
   * thereby marks it handled, so fire-and-forget call sites don't trip
   * unhandled-rejection reporting). Returns the original promise: awaiting
   * callers observe the identical rejection.
   */
  #guardMutation(name: string, args: unknown, promise: Promise<void>): Promise<void> {
    if (this.#opts.onMutationRejected || this.#rejectionListeners.size > 0) {
      promise.catch((err: unknown) => this.#notifyRejected(err, name, args))
    }
    return promise
  }

  /**
   * Subscribes to permanent mutation rejections — the attach-later
   * counterpart to the `onMutationRejected` constructor option, for layers
   * that mount after the client exists (a toast system, an error boundary).
   * Same payload and same "considered handled" semantics: a mutation issued
   * while at least one listener (or the constructor option) is attached has
   * its rejection routed here instead of tripping unhandled-rejection
   * reporting. Both surfaces fire when both are set. Returns an unsubscribe
   * function.
   */
  onMutationRejected(listener: (error: MutationError, mutation: { name: string; args: unknown }) => void): () => void {
    this.#rejectionListeners.add(listener)
    return () => {
      this.#rejectionListeners.delete(listener)
    }
  }

  #notifyRejected(err: unknown, name: string, args: unknown): void {
    if (!(err instanceof MutationError)) return
    const mutation = { name, args }
    const option = this.#opts.onMutationRejected
    for (const hook of option ? [option, ...this.#rejectionListeners] : [...this.#rejectionListeners]) {
      try {
        hook(err, mutation)
      } catch (hookErr) {
        this.#log('error', '[cf-sync] onMutationRejected threw', hookErr)
      }
    }
  }

  /** The runtime behind both forms of `mutate` (see the property's docs). */
  #mutateByName(name: string, args: unknown): Promise<void> {
    if (this.#status === 'fatal') {
      return Promise.reject(new MutationError('Fatal', 'sync client is in a fatal state', { name, args }))
    }
    const def = (this.#opts.app.mutators as AnyMutators)[name]
    if (!def) {
      return Promise.reject(
        new MutationError('UnknownMutator', `no mutator named "${name}" in the app passed to SyncClient`, { name, args }),
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
          new MutationError('InvalidArgs', `invalid args for "${name}": ${formatIssues(result.issues)}`, { name, args }),
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
      // false` is the honest signal permission checks key on (ARCHITECTURE.md#session-control).
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
        return Promise.reject(new MutationError(err.code, err.message, { name, args }))
      }
      const detail = err instanceof Error ? err.message : String(err)
      return Promise.reject(
        new MutationError('LocalApplyFailed', `mutator "${name}" threw during local apply: ${detail}`, { name, args }),
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
    return this.#guardMutation(name, args, this.#rawMutate(name, args))
  }

  #rawMutate(name: string, args: unknown): Promise<void> {
    if (this.#status === 'fatal') {
      return Promise.reject(new MutationError('Fatal', 'sync client is in a fatal state', { name, args }))
    }
    const def = (this.#opts.app.mutators as AnyMutators)[name]
    if (!def) {
      return Promise.reject(
        new MutationError('UnknownMutator', `no mutator named "${name}" in the app passed to SyncClient`, { name, args }),
      )
    }
    if (def.args) {
      const result = def.args['~standard'].validate(args)
      if (result instanceof Promise) {
        void result.catch(() => {})
      } else if (result.issues) {
        return Promise.reject(
          new MutationError('InvalidArgs', `invalid args for "${name}": ${formatIssues(result.issues)}`, { name, args }),
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
    this.#log('warn', 
      `[cf-sync] mutator "${mutator}" touched table "${tbl}" which has no attached collection — ` +
        `the mutation still applies on the server, but without a local optimistic effect. ` +
        `Create the table's collection (createCollections covers every schema table) to restore it.`,
    )
  }

  /** Queues a validated mutation; resolves/rejects on server confirm (the LMID contract). */
  #enqueue(name: string, args: unknown): Promise<void> {
    if (this.#status === 'fatal') {
      return Promise.reject(new MutationError('Fatal', 'sync client is in a fatal state', { name, args }))
    }
    if (this.#stopped) {
      // Post-stop mutations would queue forever with no connection to drain
      // them; reject honestly instead (TanStack rolls back the optimistic write).
      return Promise.reject(new MutationError('Stopped', 'sync client stopped', { name, args }))
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
          this.#settleEntry(
            entry,
            new MutationError('Timeout', `mutation "${name}" unconfirmed after ${timeoutMs}ms`, { name, args }),
          )
        }, timeoutMs)
      }
      this.#outbox.push(entry)
      this.#notifyPending()
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
    const epoch = ++this.#connectEpoch
    const token = this.#opts.authToken
    if (token === undefined) {
      this.#openSocket(this.#url)
      return
    }
    if (typeof token === 'string') {
      this.#openSocket(withToken(this.#url, token))
      return
    }
    // A token function is invoked fresh on every attempt, so the immediate
    // reconnect after a 4300 refresh close carries a renewed token. The
    // epoch guard drops a resolution that a newer connect has superseded.
    Promise.resolve()
      .then(token)
      .then(
        (value) => {
          if (this.#stopped || epoch !== this.#connectEpoch) return
          this.#openSocket(withToken(this.#url, value))
        },
        (err) => {
          if (this.#stopped || epoch !== this.#connectEpoch) return
          this.#log('warn', '[cf-sync] authToken provider failed; retrying', err)
          this.#socket = null
          this.#scheduleReconnect()
        },
      )
  }

  #openSocket(url: string): void {
    const createSocket =
      this.#opts.createSocket ??
      ((socketUrl: string) => {
        const ws = new WebSocket(socketUrl)
        // Binary lane frames (ARCHITECTURE.md#yjs-fields) must arrive as ArrayBuffer, not Blob.
        ws.binaryType = 'arraybuffer'
        return ws as unknown as WebSocketLike
      })
    let socket: WebSocketLike
    try {
      socket = createSocket(url)
    } catch (err) {
      // Browsers throw synchronously from `new WebSocket` for malformed URLs
      // and some CSP blocks. Treat it as an instant disconnect — an uncaught
      // throw here (especially from the reconnect timer) would kill the
      // reconnect loop permanently.
      this.#log('warn', '[cf-sync] failed to create socket; retrying', err)
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
      // Any frame counts as liveness — including pongs, binary frames, and
      // frames the message schema does not recognize.
      this.#lastFrameAt = Date.now()
      if (typeof event.data === 'string') this.#onMessage(event.data)
      else this.#onBinaryFrame(event.data)
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
    // Close codes are the rejection channel (ARCHITECTURE.md#session-control): a browser
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

  /** Fans a binary-lane frame out to `onBinary` subscribers (ARCHITECTURE.md#yjs-fields). */
  #onBinaryFrame(data: unknown): void {
    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    } else {
      // A Blob means a custom createSocket without binaryType='arraybuffer';
      // async Blob reads would break frame ordering, so surface the fix.
      if (!this.#warnedBinaryType) {
        this.#warnedBinaryType = true
        this.#log('warn', 
          "[cf-sync] dropped a binary frame that was not an ArrayBuffer — set binaryType = 'arraybuffer' on the socket your createSocket returns",
        )
      }
      return
    }
    // Isolated per listener: this is the add-on seam, and one add-on's throw
    // must not starve another of the frame (or escape into socket handling).
    for (const listener of this.#binaryListeners) {
      try {
        listener(bytes)
      } catch (err) {
        this.#log('error', '[cf-sync] onBinary listener threw', err)
      }
    }
  }

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
        // signal: adopt it, then re-announce our own state (ARCHITECTURE.md#presence) — apps
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
        // Hibernation dropped the server's map (ARCHITECTURE.md#presence): re-send unprompted.
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
        .catch((err) => this.#log('warn', '[cf-sync] failed to persist poke', err))
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
        this.#log('warn', `[cf-sync] server rejected presence state: ${msg.message ?? 'PresenceInvalid'}`)
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
        this.#settleEntry(
          entry,
          error
            ? new MutationError(error.code, error.message, { name: entry.name, args: entry.args })
            : undefined,
        )
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
    this.#notifyPending()
    this.#persistOutbox()
  }

  /**
   * Every outbox removal funnels through #settleEntry (the confirm sweep,
   * shutdown, and fatal all settle entry by entry), so notifying there plus
   * the two growth sites (mutate's push, hydration's prepend) is exhaustive.
   */
  #notifyPending(): void {
    const pending = this.#outbox.length
    if (pending === this.#notifiedPending) return
    this.#notifiedPending = pending
    for (const listener of this.#pendingListeners) listener(pending)
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
        .catch((err) => this.#log('warn', '[cf-sync] failed to persist outbox', err))
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
  // presence (ARCHITECTURE.md#presence)
  // -------------------------------------------------------------------------

  #presenceSet(state: unknown): void {
    const schema = this.#opts.app.presence
    if (!schema) {
      throw new Error(
        'SyncClient: the app declares no presence schema — add `presence: <schema>` to defineApp to use client.presence',
      )
    }
    // Validation runs per call even though sends throttle to one frame per
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
        // One-time round-trip check: `update` merges into this *parsed*
        // output and reconnect re-announces it, so the schema must accept
        // its own output as input. A schema with a reshaping `transform`
        // typechecks fine and would otherwise fail later, at some unrelated
        // update or mid-reconnect — surface it at the first set instead.
        if (!this.#presenceRoundTripChecked) {
          this.#presenceRoundTripChecked = true
          const echo = schema['~standard'].validate(state)
          if (!(echo instanceof Promise) && echo.issues) {
            throw new Error(
              `SyncClient: the presence schema does not parse its own output ` +
                `(${formatIssues(echo.issues)}). presence.update merges into previously parsed state and ` +
                `reconnect re-announces it, so the schema must round-trip — use a plain object schema ` +
                `(no transform/pipe) for presence (ARCHITECTURE.md#presence)`,
            )
          }
        }
      }
      if (jsonByteSize(state) > MAX_PRESENCE_BYTES) {
        throw new Error(`SyncClient: presence state exceeds ${MAX_PRESENCE_BYTES} bytes`)
      }
    }
    this.#presenceState = state
    this.#schedulePresenceSend()
    // Local changes notify too: a component rendering `presence.self` must
    // re-render when another component calls set/update/clear.
    this.#notifyPresence()
  }

  #presenceUpdate(partial: unknown): void {
    const current = this.#presenceState
    const base = typeof current === 'object' && current !== null ? current : {}
    try {
      this.#presenceSet({ ...base, ...(partial as object) })
    } catch (err) {
      // The classic mount-order race presents as a schema error: an `update`
      // fired before any identity was set merges into {} and fails on the
      // schema's required fields. Name the real cause and the designed fix.
      if (current === undefined || current === null) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(
          `SyncClient: presence.update() was called before any presence state existed, so the partial ` +
            `merged into {} — a mount-order race, not a data bug. Pass initialPresence at construction ` +
            `(or call presence.set once first); every later call can then stay a bare partial. (${detail})`,
        )
      }
      throw err
    }
  }

  /**
   * Trailing-edge throttle: at most one frame per cadence window, carrying
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
      // receivedAt is the ARCHITECTURE.md#presence staleness bound: local receipt time, so apps
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
    else defaultFatalRecovery(this.#opts.workspaceId, error, this.#opts.logger ?? consoleLogger)
  }

  #warnUnregistered(tbl: string): void {
    if (this.#warnedTables.has(tbl)) return
    this.#warnedTables.add(tbl)
    this.#log('warn', `[cf-sync] dropping synced data for unregistered table "${tbl}"`)
  }
}
