import type {
  AnyMutators,
  AnySyncSchema,
  AppDefinition,
  AuthContextOf,
  PresencePeer,
  StandardSchemaV1,
} from '@cf-sync/protocol'
import type { MutationError, SyncFatalError } from './errors'
import type { SyncStore } from './store'

/**
 * The client's connection lifecycle — one value describing the pipe, not any
 * individual mutation (those settle through `mutate`'s promise and
 * `onMutationRejected`). `idle` is before `start()` and after `destroy()`;
 * `connecting` covers hydration and the first socket attempt; `syncing` means
 * the socket is open and catch-up is in flight; `synced` means this
 * connection has caught up (the status holds there between pokes);
 * `reconnecting` means the connection dropped and backoff retries are running
 * — queued mutations wait, nothing is lost; `fatal` means the server
 * permanently rejected this client (see `SyncClientOptions.onFatal`).
 */
export type SyncStatus = 'idle' | 'connecting' | 'syncing' | 'synced' | 'reconnecting' | 'fatal'

// Binary lane: DESIGN.md §17.3.
/**
 * Minimal socket surface so tests and non-browser runtimes can inject one.
 * A custom `createSocket` that wraps a real browser WebSocket must set
 * `binaryType = 'arraybuffer'` — binary-lane frames must arrive as
 * ArrayBuffer, not Blob — which the default factory does.
 */
export interface WebSocketLike {
  send(data: string | ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void
}

/**
 * One row operation delivered to a table's hooks: a full-row `put` (rows are
 * last-writer-wins documents, so `value` replaces the row entirely) or a
 * `del` by id.
 */
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

/**
 * The sink for the client's diagnostics. `message` arrives fully formatted
 * (including the `[cf-sync]` prefix); `detail` carries any associated error
 * or payload. The default writes to `console[level]`.
 */
export type SyncLogger = (level: 'warn' | 'error', message: string, ...detail: unknown[]) => void

export type PresenceInputOf<P> = P extends StandardSchemaV1 ? StandardSchemaV1.InferInput<P> : never
export type PresenceStateOf<P> = P extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<P> : never

// Presence protocol: DESIGN.md §16.
/**
 * `client.presence` — ephemeral peer state on the existing sync socket.
 * The library owns transport and lifecycle: `set` is throttled
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
   * by then — `initialPresence` is the mount-order-proof way to provide
   * them). Clear one field with `update({ field: undefined })`. The merge
   * base is the *parsed* state, so the presence schema must parse its own
   * output (no `transform`s — see `defineApp`'s `presence` docs).
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
  /** Notifies on any peer change and on local `set`/`update`/`clear` (so `self` is reactive too); returns an unsubscribe function. Plugs into `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void
}

/**
 * Constructor options for {@link SyncClient} — fixed for the instance's
 * lifetime. Only `url`, `workspaceId`, and `app` are required; the rest
 * tune persistence, connection behavior, presence, and the lifecycle hooks.
 */
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
   * The connection credential. Browsers cannot set headers on a WebSocket
   * upgrade, so the token travels as a `token` query parameter on the sync
   * URL, where the worker's `authorize` hook reads it:
   * `new URL(request.url).searchParams.get('token')`.
   *
   * A function is invoked fresh on **every** connection attempt — including
   * the immediate reconnect after a 4300 refresh close — so short-lived
   * tokens renew naturally: `authToken: () => getSession().accessToken`.
   * It may be async; a rejection is treated like a failed connection
   * attempt (logged, retried with backoff).
   */
  authToken?: string | (() => string | Promise<string>)
  /**
   * This client's own view of its auth context — the same shape the server's
   * `authorize` hook stamps (typed by the registry's `authContext` schema).
   * Optimistic mutator runs see it as `ctx.auth` with
   * `ctx.authoritative: false`, so permission checks written without the
   * `authoritative` guard fail fast locally instead of surfacing as a server
   * round-trip rejection. Validated against the app's `authContext` schema at
   * construction when one is declared. The server's stamps remain
   * authoritative either way.
   *
   * Not a credential: it is never transmitted, and the server never trusts
   * it. (If you're arriving from Replicache or Zero, their `auth` option is
   * the transmitted token — here that's {@link authToken}.)
   */
  authContext?: AuthContextOf<M>
  /**
   * Durable storage for synced rows, the cursor, and the outbox. When set,
   * start() hydrates registered tables from the store (collections show
   * cached data before the socket connects), hello resumes from the
   * persisted cursor, and unconfirmed mutations survive reloads — re-shown
   * as optimistic overlays at hydration and replayed to the server exactly
   * once. A schema version mismatch discards the cache and bootstraps fresh.
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
   * Where the client's diagnostics go — reconnect/backoff decisions, dropped
   * frames, persistence failures. Default: the console. Inject to route them
   * into your own logging (the first place you'll want this is a bug report
   * whose reconnect behavior you can no longer reproduce).
   */
  logger?: SyncLogger
  /**
   * Memory-only clients (no `store`/`persist`): reject unconfirmed mutations
   * after this long — the mutation is discarded and TanStack DB rolls the
   * optimistic overlay back, which is honest because nothing would survive a
   * reload anyway. Ignored when a durable store is present: a queued mutation
   * survives reloads and still applies when connectivity returns, so the
   * promise stays pending until a connection confirms it (it settles early
   * only on permanent app error, `destroy()`, or a fatal). Default: 30s.
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
   * Trailing-edge throttle window for `presence.set` — the client sends at
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
   * One place to learn that a mutation was rejected — its optimistic overlay
   * rolled back and this session will not apply it. Fires for every
   * rejection `mutate` (or a collection write) would deliver: server app
   * errors, local fail-fast (`InvalidArgs`, `UnknownMutator`,
   * `LocalApplyFailed`), and the lifecycle codes (`Timeout`, `Stopped`,
   * `Fatal` — filter on `error.code` if you only want server verdicts).
   * Crucially it also fires for rejections that have **no awaiting caller**:
   * collection `insert`/`update`/`delete` handlers, and mutations restored
   * from the persisted outbox after a reload — without this hook, those
   * roll back silently.
   *
   * ```ts
   * onMutationRejected: (error, { name }) =>
   *   toast.error(`"${name}" was rejected: ${error.message}`)
   * ```
   *
   * With the hook set, fire-and-forget calls (`void client.mutate.todos.clear()`)
   * no longer surface unhandled-rejection noise — the rejection is considered
   * handled here. Awaiting callers still see the rejection too.
   */
  onMutationRejected?: (error: MutationError, mutation: { name: string; args: unknown }) => void
  /**
   * Called when the server permanently rejects this client — an in-band
   * VersionNotSupported/Unauthorized error, or a close code in the permanent
   * band [4400, 4499] (an `authorize` rejection or an admin kick). The
   * error carries the close `{code, reason}`, so apps can branch
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
