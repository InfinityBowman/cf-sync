# SyncClient

The per-workspace sync client from `@cf-sync/client`. It owns the WebSocket to the workspace's Durable Object, the outbox of unconfirmed mutations, optimistic application and rollback, presence, and reconnection with cursor catch-up. Construct one instance per workspace per tab; it connects on construction unless [`autoStart: false`](#autostart).

```ts
import { SyncClient } from '@cf-sync/client'
import { app } from './schema'

const client = new SyncClient({
  url: 'wss://sync.example.com',
  workspaceId: 'team-a',
  app,
  persist: true,
})
```

## Options

Options are fixed for the instance's lifetime — to change one, [`destroy()`](#destroy) and construct a new client. Only `url`, `workspaceId`, and `app` are required.

### url

`string` · **required**

Base URL of the sync worker — origin plus any mount path, no sync route: `wss://sync.example.com`. `http(s)://` is accepted and converted. The client appends `<pathPrefix>/<workspaceId>?clientId=<clientId>` itself, so the clientId in the URL (which the server binds at upgrade) can never diverge from the one used for confirmation matching.

### workspaceId

`string` · **required**

The workspace to sync. Names the server-side Durable Object (via the URL path), the local IndexedDB database, and the collection ids.

### app

`AppDefinition` · **required**

The shared [app definition](/reference/define-kit#defineapp) — the same `defineApp` object the server is configured with: schema version, table schemas, and mutator registry. Collections derive their row types and runtime validation from its schema; `mutate` is typed by mutator name and validates args locally before queueing, so bad calls fail immediately instead of surfacing as a server round-trip error (the server's validation remains authoritative).

### persist

`boolean` · default `false`

Shorthand for `store: new IndexedDBSyncStore(...)` built from `workspaceId` and the managed clientId. Turns on the whole [offline story](/guide/offline-persistence): instant reload hydration, cursor resume, and a durable outbox. Where IndexedDB is unavailable (SSR, some workers), the client warns and runs without persistence instead of throwing. Mutually exclusive with `store`.

### store

`SyncStore`

Durable storage for synced rows, the cursor, and the outbox — pass your own [`SyncStore`](#syncstore) implementation instead of the IndexedDB default. When set, `start()` hydrates registered tables from the store (collections show cached data before the socket connects), hello resumes from the persisted cursor, and unconfirmed mutations survive reloads. A schema version mismatch discards the cache and bootstraps fresh.

### clientId

`string` · default: managed by the library

Identifies one contiguous mutation sequence — unique per SyncClient instance (per tab/session), never shared across concurrent tabs. The managed default is persisted per workspace in sessionStorage (reload continuity without cross-tab sharing), random where sessionStorage is unavailable. Pass explicitly to take over the lifecycle.

### authToken

`string | (() => string | Promise<string>)`

The connection credential. Browsers cannot set headers on a WebSocket upgrade, so the token travels as a `token` query parameter on the sync URL, where the worker's [`authorize`](/guide/auth#the-authorize-hook) hook reads it: `new URL(request.url).searchParams.get('token')`. A function is invoked fresh on **every** connection attempt — including the immediate reconnect after a 4300 refresh close — so short-lived tokens renew naturally: `authToken: () => getSession().accessToken`. It may be async; a rejection is treated like a failed connection attempt (logged, retried with backoff). See [Auth & sessions](/guide/auth#sending-a-credential).

### authContext

`AuthContextOf<M>`

This client's own view of its auth context — the same shape the server's `authorize` hook stamps (typed by the app's `authContext` schema). Optimistic mutator runs see it as `ctx.auth` with `ctx.authoritative: false`, so permission checks written without the `authoritative` guard fail fast locally instead of surfacing as a server round-trip rejection. Validated against the app's `authContext` schema at construction when one is declared. The server's stamps remain authoritative either way.

Not a credential: it is never transmitted, and the server never trusts it. (Arriving from Replicache or Zero? Their `auth` option is the transmitted token — here that's [`authToken`](#authtoken).)

### autoStart

`boolean` · default `true`

Connect on construction. Pass `false` when construction and connection must be decoupled — SSR (module-scope construction would open sockets from the server; Node 22+ has a global WebSocket), tests, or apps that gate syncing on auth — and call [`start()`](#start) yourself.

### pathPrefix

`string` · default `"/sync"`

URL prefix for sync routes, matching the server router's `pathPrefix`.

### confirmTimeoutMs

`number` · default `30_000`

Memory-only clients (no `store`/`persist`): reject unconfirmed mutations after this long — the mutation is discarded and the optimistic overlay rolls back, which is honest because nothing would survive a reload anyway. Ignored when a durable store is present: a queued mutation survives reloads and still applies when connectivity returns, so the promise stays pending until a connection confirms it.

### pingIntervalMs

`number` · default `25_000`

Keepalive ping cadence. Pings keep idle edge connections alive (the server's auto-response answers without waking the DO) and give the heartbeat a liveness signal. `0` disables the heartbeat entirely.

### idleTimeoutMs

`number` · default: `2 × pingIntervalMs + 5s`

Force a reconnect when no frame of any kind has arrived for this long — the only way to detect a half-open socket, which never emits a close event.

### maxBackoffMs

`number` · default `30_000`

Cap on the exponential reconnect backoff. The browser's `online` and `visibilitychange` events short-circuit a pending backoff — a reopened laptop reconnects immediately, not after waiting out the timer.

### logger

`SyncLogger` — `(level: 'warn' | 'error', message, ...detail) => void` · default: the console

Where the client's diagnostics go — reconnect decisions, dropped frames, persistence failures. Inject to route them into your own logging; the messages arrive fully formatted (including the `[cf-sync]` prefix).

### createSocket

`(url: string) => WebSocketLike`

Socket factory for tests and non-browser runtimes. A custom factory that wraps a real browser WebSocket must set `binaryType = 'arraybuffer'` — binary-lane frames ([Yjs fields](/reference/yjs)) must arrive as ArrayBuffer, not Blob — which the default factory does.

### initialPresence

`PresenceInput`

The presence state announced as soon as the connection is ready, before any `presence.set` call. Provide identity here once (validated at construction, like `authContext`) and every later call site can be a bare `presence.update(partial)` — immune to component mount order. Requires a `presence` schema in the app. See [Presence](/guide/presence).

### presenceThrottleMs

`number` · default `100`

Trailing-edge throttle window for `presence.set` — the client sends at most one presence frame per window, carrying the latest state, so apps call `set` at input frequency without throttle glue.

### onMutationRejected

`(error: MutationError, mutation: { name: string; args: unknown }) => void`

One place to learn that a mutation was rejected — its optimistic overlay rolled back and this session will not apply it. Fires for every rejection: server app errors, local fail-fast (`InvalidArgs`, `UnknownMutator`, `LocalApplyFailed`), and the lifecycle codes (`Timeout`, `Stopped`, `Fatal` — filter on `error.code` if you only want server verdicts). Crucially it also fires for rejections with **no awaiting caller**: collection `insert`/`update`/`delete` writes, and mutations restored from the persisted outbox after a reload — without this hook, those roll back silently. With the hook set, fire-and-forget calls (`void client.mutate.todos.clear()`) are considered handled; awaiting callers still see the rejection too. See [Mutations](/guide/mutations#one-handler-instead-of-a-catch-per-call-site).

### onFatal

`(error: SyncFatalError) => void`

Called when the server permanently rejects this client — an in-band `VersionNotSupported`/`Unauthorized` error, or a close code in the permanent band `[4400, 4499]` (an `authorize` rejection or an admin kick). The error carries the close `{ code, reason }`, so apps can branch on the rejection slug. Default in the browser: reload the page — the designed recovery for a version mismatch is loading the new bundle — throttled to once per minute per workspace so a bad deploy window degrades to a slow retry instead of a reload loop. See [Auth & sessions](/guide/auth#close-codes).

### onStatusChange

`(status: SyncStatus) => void`

Constructor-time convenience; for dynamic subscribers use [`subscribeStatus`](#subscribestatus).

### onSyncProgress

`(progress: { receivedOps: number; remainingOps: number }) => void`

Progress during large pokes (bootstrap): ops received so far vs. still to come.

## Properties

### mutate

`Mutate<M>`

The typed mutation surface: `client.mutate.issue.move({ id, column })` or the string form `client.mutate('issue.move', args)`. Names autocomplete from the app definition; bad args are a compile error and are validated locally before queueing. The returned promise settles per the [mutation lifecycle](/guide/mutations#the-one-semantic-to-internalize): resolves on server confirm, rejects with a [`MutationError`](#mutationerror) when the mutation will never apply.

### presence

`PresenceApi`

Ephemeral peer state on the existing socket — see [Presence](/guide/presence) for the model.

- `presence.set(state)` — full replace, throttled trailing-edge at `presenceThrottleMs`.
- `presence.update(partial)` — shallow merge into the last state; `{ field: undefined }` clears one field.
- `presence.clear()` — peers see you go quiet.
- `presence.self` — your own parsed state (never included in peers).
- `presence.peers` — the current peers, each `{ clientId, principal?, state, receivedAt }` with identity stamped by the server.
- `presence.subscribe(listener)` — change notifications (peer changes *and* local `set`/`update`/`clear`, so `self` renders reactively); returns an unsubscribe function.

### status · cursor · workspaceId · clientId · app · schema

Read-only getters: the current [`SyncStatus`](#syncstatus), the last confirmed server cursor (`null` before the first sync), and the constructor's identity values.

## Methods

### subscribeStatus

`(listener: (status: SyncStatus) => void) => () => void`

Subscribe to [`SyncStatus`](#syncstatus) transitions; returns an unsubscribe function. React apps use [`useSyncStatus`](#react-hooks) instead.

### start

`() => void`

Connect (only meaningful with `autoStart: false`). Hydrates from the store first when one is configured, then opens the socket. Throws if the client was destroyed.

### destroy

`() => Promise<void>`

The one teardown: stops syncing (socket close, timer cancels, and `Stopped` settlements all happen synchronously, before the first await — `void client.destroy()` in an unload path is safe), cleans up every collection from `createCollections`, detaches add-ons (Yjs fields), and closes the store connection. Nothing durable is lost — persisted rows and the offline outbox stay on disk, and the managed clientId is reused, so offline mutations still replay exactly once on the next construction. See [Closing a workspace](/guide/offline-persistence#closing-a-workspace).

### onMutationRejected (method)

`(listener: (error: MutationError, mutation: { name, args }) => void) => () => void`

The attach-later counterpart to the [`onMutationRejected` option](#onmutationrejected) — same payload, same "considered handled" semantics, both fire when both are set. For layers that mount after the client exists (a toast system, an error boundary). Returns an unsubscribe function.

### onDestroy

`(callback: () => void | Promise<void>) => () => void`

Register teardown work to run during `destroy()`; returns a deregister function. This is how add-ons tie their lifecycle to the client's.

### registerTable · registerApplier · sendBinary · onBinary

The extension seam — how `createCollections` and `@cf-sync/yjs/client` attach. Apps using the shipped adapters never call these; they are public so custom stores, custom collection layers, and binary-lane add-ons are plain library code with no privileged access.

## Errors

### MutationError

What an awaited `mutate` call rejects with and what `onMutationRejected` receives. `code` is the branchable identity, drawn from three groups:

| Group | Codes |
|---|---|
| Engine rejections (server refused before your mutator ran) | `InvalidArgs` · `UnknownMutator` · `RowTooLarge` |
| Client-local outcomes | `Timeout` · `Stopped` · `Fatal` · `LocalApplyFailed` |
| Your app's codes | whatever your mutators throw in `AppError('YourCode', …)`, passed through verbatim |

The built-in vocabulary is exported as `MutationErrorCode`. `message` is diagnostic prose — branch on `code`, not on it. `mutation` carries the rejected mutation's `{ name, args }` when the client knows them, so an awaiting `catch` has the same context the hook receives.

```ts
import { MutationError } from '@cf-sync/client'

try {
  await client.mutate.issue.move({ id, column })
} catch (e) {
  if (e instanceof MutationError && e.code === 'NotFound') {
    toast('That issue was deleted by someone else.')
  }
}
```

### SyncFatalError

What `onFatal` receives when the server permanently rejects this client. `code` is the close code (or `'VersionNotSupported'`/`'Unauthorized'` for in-band errors); `reason` is the close frame's slug (`membership-revoked`, `project-deleted`) — stable strings apps can branch on. The close-code bands (`4300` refresh vs `4400–4499` permanent) are covered in [Auth & sessions](/guide/auth#close-codes).

## Types

### SyncStatus

```ts
type SyncStatus = 'idle' | 'connecting' | 'syncing' | 'synced' | 'reconnecting' | 'fatal'
```

One value describing the pipe, not any individual mutation (those settle through `mutate`'s promise and `onMutationRejected`). `idle` is before `start()` and after `destroy()`; `connecting` covers hydration and the first socket attempt; `syncing` means the socket is open and catch-up is in flight; `synced` holds between pokes; `reconnecting` means backoff retries are running — queued mutations wait, nothing is lost, and the browser's `online`/`visibilitychange` events short-circuit the backoff so a reopened laptop reconnects immediately; `fatal` means the server permanently rejected this client.

### SyncStore

The persistence contract behind `persist`/`store` — implement it to substitute your own storage. `IndexedDBSyncStore` is the shipped default; `MemorySyncStore` is the in-memory reference implementation (useful in tests). Both are exported from `@cf-sync/client`.

## React hooks

From `@cf-sync/client/react` (React is an optional peer):

- `useSyncStatus(client)` — the current [`SyncStatus`](#syncstatus), reactively.
- `usePresence(client)` — the typed peers array, self excluded; re-renders on presence changes.

Collections are read with `useLiveQuery` from `@tanstack/react-db` — see [Collections](/reference/collections).
