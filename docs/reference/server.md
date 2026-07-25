# Server

The worker half of the engine from `@cf-sync/server`: `createWorkspaceDO` builds the Workspace Durable Object class from the shared [app definition](/reference/define-kit#defineapp), and the router factories (`createSyncFetch`, `createAdminFetch`) route traffic to it. The engine's surface is the sync protocol and the admin routes — never methods on the DO instance. The package also re-exports the whole define kit, so server-only code can import everything from one place.

```ts
// worker/worker.ts
import { createWorkspaceDO, createSyncFetch } from '@cf-sync/server'
import { app } from '../src/schema' // the same defineApp value the client uses

export class WorkspaceDO extends createWorkspaceDO({ app }) {}

export default {
  fetch: createSyncFetch<Env>({
    namespace: (env) => env.WORKSPACE,
    authorize: async (request, { workspaceId }) => true, // see /guide/auth
  }),
}
```

## createWorkspaceDO

`(config: WorkspaceEngineConfig) => WorkspaceDOClass`

Builds the Workspace Durable Object class. Export the returned class from the worker entry and bind it in wrangler with `new_sqlite_classes` — the engine requires SQLite-backed storage, and a class declared with `new_classes` deploys fine and then fails at runtime on its first SQL access:

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "WORKSPACE", "class_name": "WorkspaceDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceDO"] }]
}
```

Each workspace id resolves to one instance holding that workspace's rows, mutation log, and live sockets. The class is deliberately opaque (`WorkspaceDOClass`) — traffic reaches it through the routers below, never through instance methods.

Export it through an empty subclass, as above: a `class` declaration is a type as well as a value, which is what lets `wrangler types` emit `WORKSPACE: DurableObjectNamespace<WorkspaceDO>` (a bare `export const` leaves the generated Env referencing a type that doesn't exist). The subclass exists to *name* the class — keep the body empty. The engine's handlers (`fetch`, `webSocketMessage`, `webSocketClose`, `alarm`) are not extension points; overriding them breaks the invariants the engine maintains. Server-side behavior is added through [`extension`](#extension) instead.

### app

`AppDefinition` · **required**

The shared [app definition](/reference/define-kit#defineapp) — the same `defineApp` object every client is constructed with: schema version, table schemas, mutator registry, and the migration chain. Every `tx.put` — from mutators, migrations, and admin imports — is validated against the target table's schema; the validated output (defaults applied) is what gets stored. When the DO wakes with data stored under an older version, the migration chain replays before any traffic and commits atomically at a single new data version; a stored version outside the declared chain, or a throwing step, quarantines the workspace rather than serving old-shaped data. See [Schema evolution](/guide/schema-evolution).

### compaction

`CompactionConfig`

Tunes tombstone compaction, which runs on the workspace's periodic maintenance alarm to keep deleted-row bookkeeping from growing forever.

- `tombstoneRetentionVersions` — `number` · default `10_000`. How many data versions of tombstones to keep; older ones are hard-deleted on the alarm. A client whose cursor predates the youngest deleted tombstone can no longer catch up incrementally and re-bootstraps on its next connect — larger retention trades storage for fewer forced bootstraps of long-offline clients.
- `intervalMs` — `number` · default `21_600_000` (6 hours). Milliseconds between maintenance-alarm runs. The alarm is shared with the R2 export: the DO schedules at the smaller of the two configured intervals.
- `disabled` — `boolean` · default `false`. Skips tombstone compaction entirely — tombstones accrue unbounded. The maintenance alarm still runs when an R2 export is configured.

### export

`ExportConfig`

Streams the workspace's mutation log to an R2 bucket as ndjson objects on the maintenance alarm — archive and analytics off the hot path. DO SQLite stays the system of record (it has point-in-time recovery of its own); R2 covers everything beyond it. Exports are idempotent: object keys embed the log-sequence range, so a re-export after a failed cursor update overwrites the same object. See [Operations](/guide/operations#r2-mutation-log-archive).

- `bucket` — `(env: Env) => R2Bucket` · **required**. Resolves the R2 bucket from the worker env. Annotate the parameter to type the whole DO's env: `(env: Env) => env.EXPORT_BUCKET`.
- `intervalMs` — `number` · default `300_000` (5 minutes). Milliseconds between export runs — the archive's worst-case staleness. Shares the maintenance alarm with compaction.
- `maxBatchRows` — `number` · default `5_000`. Log entries per exported object.
- `maxObjectsPerRun` — `number` · default `20`. Bound on objects written per maintenance run.
- `prefix` — `string` · default `"cf-sync"`. Key prefix; objects land at `<prefix>/<workspaceId>/mutation-log/<from>-<to>.ndjson`.

### extension

`() => EngineExtension`

Binary-lane extension factory — e.g. `yjsFields()` from [`@cf-sync/yjs/server`](/reference/yjs). A factory, not an instance: it is invoked once per workspace DO instance, because instances of one class share an isolate and a single extension object would leak in-memory state across workspaces. See [EngineExtension](#engineextension) below.

### logger

`EngineLogger` — `(level: 'warn' | 'error', message, ...detail) => void` · default: the console

Where the engine's diagnostics go — init failures, [schema-drift warnings](/guide/schema-evolution#drift-detection), internal errors. The default is visible in `wrangler tail`; inject to route them into your own logging pipeline. Messages arrive fully formatted (including the `[cf-sync]` prefix).

## createSyncFetch · createSyncRoute

`(opts: SyncFetchOptions) => (request, env) => Promise<Response>` · `…Promise<Response | null>`

The worker router for sync WebSocket upgrades at `${pathPrefix}/<workspaceId>`. `createSyncRoute` is the composable form: it resolves to `null` when the request is not this route's traffic, so a worker entry chains routes with `??` and owns its own fallback; requests that *are* its traffic but malformed (missing websocket upgrade, missing clientId, failed authorize) return real Responses, never null. `createSyncFetch` is the same route with a built-in 404 fallback — the right shape when sync is the worker's only (or last) route.

```ts
const sync = createSyncRoute<Env>({ namespace: (env) => env.WORKSPACE, authorize })
const admin = createAdminRoute<Env>({ namespace: (env) => env.WORKSPACE, authorize: bearerTokenAuth((env) => env.ADMIN_TOKEN) })
export default {
  fetch: async (request: Request, env: Env) =>
    (await sync(request, env)) ?? (await admin(request, env)) ?? new Response('not found', { status: 404 }),
}
```

### namespace

`(env: Env) => DurableObjectNamespace<any>` · **required**

Resolves the workspace Durable Object namespace from the worker env — typically `(env) => env.WORKSPACE`. Typed `DurableObjectNamespace<any>` so both a bare binding and the `DurableObjectNamespace<WorkspaceDO>` that `wrangler types` generates are accepted without a cast.

### authorize

`'public' | ((request, { workspaceId, clientId, env }) => boolean | Response | AuthVerdict | Promise<…>)` · **required**

Connection-time authorization, run in the worker before the DO is reached. Required, so "forgot auth" cannot ship looking identical to "chose no auth" — the literal `'public'` is the explicit opt-out (anyone who can reach the worker can read and write every workspace; fine for a demo, written down where a reviewer will see it). v1 policy: workspace membership grants full access; mutation-level checks live in mutators, reading the verdict's stamps via `ctx`. Four return forms for the hook:

| Return | Effect |
|---|---|
| `true` | admit, no stamps |
| `false` | HTTP 403 — correct for non-browser callers |
| a `Response` | full control over the rejection |
| an `AuthVerdict` | distinguishable rejections and connection stamps |

`{ ok: true, principal?, context?, expiresAt? }` stamps `principal` and `context` onto the connection — mutators read them synchronously as `ctx.principal` / `ctx.auth`, validated against the app's `authContext` schema at upgrade, not mid-mutation. `expiresAt` (epoch ms) bounds how long the stamps stay trusted without being re-derived: past it, the DO closes the socket with 4300 and the reconnect re-runs `authorize`. Omitted means no expiry — apps with reliable revocation webhooks don't pay for one.

`{ ok: false, code?, reason? }` completes the upgrade and immediately closes it — a browser cannot observe the HTTP status of a failed upgrade, so the close frame is what makes rejections distinguishable from network errors, and the DO never wakes. `code` defaults to 4403 (permanent: the client stops reconnecting and calls [`onFatal`](/reference/sync-client#onfatal)); `reason` rides the close frame, capped at 123 UTF-8 bytes — short stable slugs (`membership-revoked`), not prose. The full auth story — stamps in mutators, expiry, revocation, close-code bands — is in [Auth & sessions](/guide/auth).

### pathPrefix

`string` · default `"/sync"`

URL prefix for sync routes (`${prefix}/<workspaceId>`), matching the client's [`pathPrefix`](/reference/sync-client#pathprefix).

## createAdminFetch · createAdminRoute

`(opts: AdminFetchOptions) => (request, env) => Promise<Response>` · `…Promise<Response | null>`

The worker router for the workspace admin surface at `${pathPrefix}/<workspaceId>/<op>` (default prefix `"/admin"`). Same route/fetch split as the sync pair. `namespace` works as above; `authorize` is **required** — admin operations read and destroy whole workspaces — and returns `boolean | Response` (no verdict form; there is no connection to stamp). It receives the operation name as `op: AdminOp` (`'stats' | 'export' | 'import' | 'reset' | 'disconnect'`), so a per-op policy — a read-only token that allows `stats` and `export` but not `reset` — is one `switch` away.

The endpoints, mirroring [Operations](/guide/operations):

| Route | Effect |
|---|---|
| `GET /admin/<workspaceId>/stats` | gauges + counters — rows, versions, live connections, db size |
| `GET /admin/<workspaceId>/export` | JSON snapshot of live rows (plus extension state) |
| `POST /admin/<workspaceId>/import` | replace state from a snapshot; live clients converge via reset poke |
| `POST /admin/<workspaceId>/reset` | wipe the workspace; new history under a fresh `backendId` |
| `POST /admin/<workspaceId>/disconnect` | kick or refresh live sessions (`{ principal?, clientId?, mode?, code?, reason? }`) |

### bearerTokenAuth

`(token: (env: Env) => string | undefined) => authorize hook`

An `authorize` hook that checks `Authorization: Bearer <token>` against a secret from the env (`wrangler secret put ADMIN_TOKEN`), comparing in constant time. A missing or empty secret denies everything — an unset secret must fail closed, not open. Compatible with `createSyncFetch` too, for service-to-service sync clients.

## workspaceAdmin

`(namespace: DurableObjectNamespace, workspaceId: string) => WorkspaceAdmin`

Typed admin surface over a workspace DO stub, for same-worker callers — app command handlers, billing webhooks — so server code never hand-builds admin HTTP requests against its own routes. It talks straight to the stub (no `createAdminFetch` in between), so it carries the caller's authority; external callers go through `createAdminFetch` and its authorize hook instead. A failing op throws with the operation name, HTTP status, and the DO's error message. See [Operations](/guide/operations#same-worker-callers).

- `stats()` — operational gauges and counters, designed to be scraped.
- `export()` — a JSON snapshot of every live row (plus extension state when one is registered), accepted back by `import`.
- `import(snapshot)` — replaces the workspace's rows atomically at a single new data version, resolving `{ imported, version }`. Live clients converge on their own: a reset poke re-bootstraps them in place, or — when the snapshot carries extension state — every socket is cycled with a refresh close instead.
- `reset()` — wipes the workspace and starts a new history under a fresh `backendId`, resolving `{ backendId }`. Also the one op a quarantined workspace still serves — the [recovery hatch](/guide/operations#reset-as-the-recovery-hatch).
- `disconnect(opts?)` — closes live sockets matching the selectors (`principal`, `clientId`, or neither for all sockets), resolving `{ disconnected }`. `mode: 'kick'` (default) closes permanently — the client stops reconnecting and calls `onFatal` with `code` (default 4403) and `reason` — while `'refresh'` closes with 4300 so the client reconnects through a fresh `authorize` run and picks up new stamps. See [revoking and refreshing](/guide/auth#revoking-and-refreshing-live-sessions).

## EngineExtension

The binary-lane extension seam an add-on plugs into — [`@cf-sync/yjs/server`](/reference/yjs) is the canonical consumer. One config slot, types only: core imports nothing from any extension. `init(ctx)` runs on every wake inside initialization with the workspace's SQLite handle, a transaction wrapper, and the outbound delivery seam (`broadcast`/`send` route through core's per-socket delivery gate, so an extension cannot send to a socket core is already tearing down). `onBinaryMessage` receives every binary frame from a live socket — with the connection's auth stamps in its context — and must stay synchronous end-to-end, like every DO WebSocket handler. Optional hooks tie into the rest of the engine: `onAlarm`, `onExport`/`onImport` (round-trips extension state through admin export/import), `onReset`, and `onStats` (merged into the `stats` payload). Apps registering the shipped Yjs extension never touch this interface directly.

## Custom routers

`encodeAuthStamps(stamps)` / `decodeAuthStamps(value)` and the `AUTH_HEADER` / `WORKSPACE_HEADER` constants exist for routers replacing `createSyncFetch`. The routers carry the authorize verdict's stamps (`{ principal?, context?, expiresAt? }`) to the DO in `AUTH_HEADER` as base64-encoded JSON, and name the workspace in `WORKSPACE_HEADER`. A custom router must reproduce the security-critical move: **strip any inbound `AUTH_HEADER` before setting its own**, so stamps cannot be spoofed from outside — the DO trusts whatever the router says. `encodeAuthStamps` serializes a verdict's stamps into the header value; `decodeAuthStamps` parses one back (the DO calls it at upgrade; a custom router only needs it to inspect its own header).

`rejectUpgrade(code, reason)` completes the seam: it accepts the upgrade and immediately closes it with the given code and reason — the browser-observable rejection the built-in routers use (a bare 403 is indistinguishable from a network error in a browser). A custom router should reject the same way.
