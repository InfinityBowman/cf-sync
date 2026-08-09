# @cf-sync/server

The server half of [cf-sync](https://github.com/InfinityBowman/cf-sync) — a server-authoritative sync engine on Cloudflare Durable Objects. One Durable Object per workspace, DO SQLite as the system of record, hibernating WebSockets, and a push/poke protocol with per-client idempotency.

```sh
npm install @cf-sync/server @cf-sync/protocol zod
```

```ts
// worker/worker.ts
import { createWorkspaceDO, createSyncFetch } from '@cf-sync/server'
import { app } from '../src/schema' // your defineApp definition

// A class declaration (not `const`) so `wrangler types` can name the type.
export class WorkspaceDO extends createWorkspaceDO({ app }) {}

export default {
  fetch: createSyncFetch<Env>({
    namespace: (env) => env.WORKSPACE,
    authorize: async (request, { workspaceId }) => {
      // validate the session, check workspace membership
      return true
    },
  }),
}
```

```jsonc
// wrangler.jsonc — note new_sqlite_classes, NOT new_classes
{
  "durable_objects": {
    "bindings": [{ "name": "WORKSPACE", "class_name": "WorkspaceDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceDO"] }]
}
```

Also here:

- `createAdminFetch` + `bearerTokenAuth` + `workspaceAdmin` — per-workspace stats, export/import, reset, and session revocation
- `createSyncRoute` / `createAdminRoute` — the composable forms: they resolve to `null` for traffic that isn't theirs, so a worker entry chains routes with `??` instead of hand-routing on `pathname`
- `@cf-sync/server/testing` — `createTestEngine`, an in-memory engine with the same validation and error semantics as the DO (shared code, not a reimplementation), so mutators and migrations unit-test in plain node with no workerd; plus `checkSchemaEvolution`, a one-line CI tripwire that fails the build on a schema change without a version bump

The main entry imports `cloudflare:workers` — import only `@cf-sync/server/testing` from node. It re-exports the definition kit (`defineApp`, `defineSchema`, `defineMutators`, `crudMutators`, `AppError`), so node test files need exactly one import source.

**Docs:** the full guide and API reference ship inside this package at `node_modules/@cf-sync/server/docs`, version-matched to what you installed — `docs/config.json` indexes every page.

Online: [Getting started](https://github.com/InfinityBowman/cf-sync/blob/main/docs/guide/getting-started.md) · [Testing your app](https://github.com/InfinityBowman/cf-sync/blob/main/docs/guide/testing.md) · [Operations](https://github.com/InfinityBowman/cf-sync/blob/main/docs/guide/operations.md) · [Repository](https://github.com/InfinityBowman/cf-sync)

MIT
