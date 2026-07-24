# Operations

Every workspace exposes an admin surface: stats, export/import, reset, and session control. It's a separate router from sync, and `authorize` is **mandatory** — these endpoints read and destroy whole workspaces.

## Setup

```ts
import { createAdminFetch, bearerTokenAuth } from '@cf-sync/server'

const adminHandler = createAdminFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  authorize: bearerTokenAuth((env) => env.ADMIN_TOKEN), // wrangler secret put ADMIN_TOKEN
})
```

`bearerTokenAuth` compares in constant time and **fails closed** when the secret is unset. Your `authorize` receives the op name (`'stats'`, `'export'`, `'import'`, `'reset'`, `'disconnect'`), so per-op policies are one `switch` away.

## The endpoints

```
GET  /admin/<workspaceId>/stats       gauges + counters (rows, versions, connections, db size)
GET  /admin/<workspaceId>/export      JSON snapshot of live rows
POST /admin/<workspaceId>/import      replace state from a snapshot (live clients converge via reset poke)
POST /admin/<workspaceId>/reset       wipe the workspace; new history (backendId)
POST /admin/<workspaceId>/disconnect  kick or refresh live sessions ({principal?, clientId?, mode})
```

With the [yjs fields extension](/guide/collaborative-text) registered, `stats` includes its gauges and `export`/`import` round-trip fields alongside rows.

Live clients need no special handling around any of these: an `import` or `reset` changes the workspace's history id, and connected clients converge through a reset poke — a full re-bootstrap delivered as a normal protocol message.

## Same-worker callers

Don't hand-build HTTP requests against your own routes — `workspaceAdmin` wraps every op as a typed method on the DO stub:

```ts
import { workspaceAdmin } from '@cf-sync/server'

const ws = workspaceAdmin(env.WORKSPACE, workspaceId)
await ws.stats()
await ws.disconnect({ principal: userId, mode: 'kick', reason: 'membership-revoked' })
await ws.reset()
```

This is the natural home for billing webhooks and app command handlers — see [Auth & sessions](/guide/auth#revoking-and-refreshing-live-sessions) for the kick/refresh semantics.

## `reset` as the recovery hatch

A workspace whose stored state can no longer be loaded (e.g. written by a much older deploy, outside the migration chain) is **quarantined**: sync upgrades answer 503 and admin ops report the failure — but `reset` stays reachable by design. Export what you can, reset, re-import: the workspace is healthy again with a new `backendId`, and clients re-bootstrap automatically.

## R2 mutation-log archive

Add an `export` bucket to the DO config and a periodic alarm streams the mutation log to R2 as ndjson — archive and analytics without touching the hot path:

```ts
export const WorkspaceDO = createWorkspaceDO({
  app,
  export: { bucket: (env: Env) => env.EXPORT_BUCKET }, // the annotation types the whole DO's env
})
```

Objects land at `cf-sync/<workspaceId>/mutation-log/<from>-<to>.ndjson`. DO SQLite remains the system of record (it has point-in-time recovery of its own); R2 covers everything beyond it.

## What to monitor

`stats` is designed to be scraped: row counts, schema version, live connections, and database size per workspace. The engine also logs actionable warnings worth alerting on — most notably the [schema-drift warning](/guide/schema-evolution#drift-detection), which means a deploy changed table schemas without a version bump.
