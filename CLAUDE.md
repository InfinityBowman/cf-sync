# cf-sync-engine

Server-authoritative sync engine on Cloudflare Durable Objects. Read `DESIGN.md` before
changing protocol, storage schema, or sync semantics — it records the locked decisions
and the invariants the tests enforce.

Layout:
- `packages/protocol` — wire types, zod schemas, frame chunking, and the shared app-definition kit (`defineApp`, `defineSchema`, `defineMutators`, `crudMutators`, `AppError`) — the one package importable from both worker and browser. No runtime deps besides zod. `defineApp` bundles version + schema + mutators + the migration chain into the one object both `createWorkspaceDO` and `SyncClient` take.
- `packages/server` — `createWorkspaceDO` (the Workspace Durable Object) + `createSyncFetch`/`createAdminFetch`/`bearerTokenAuth` (worker routers). Tests run in workerd via `@cloudflare/vitest-pool-workers`. The `./testing` subpath exports `createTestEngine` (in-memory engine over the shared engine-core, runs in plain node — never import the main index from node, it pulls cloudflare:workers).
- `packages/client` — `SyncClient` (socket, outbox, poke application; connects on construction unless `autoStart: false`) + `workspaceCollectionOptions`/`createCollections` (TanStack DB collection adapter). The `./react` subpath exports `useSyncStatus`.
- `apps/demo` — todo demo; `pnpm dev:worker` (wrangler) + `pnpm dev:web` (vite) in two terminals.
- `reference/` — shallow clones of prior art (gitignored). Cited by file:line in DESIGN.md.

Invariants that must never break (see DESIGN.md §6):
1. A mutation's data effects and the client's `last_mutation_id` advance commit in the same SQLite transaction.
2. Permanent app errors still advance `last_mutation_id`.
3. All DO WebSocket handlers stay synchronous — no `await` between reading state and sending frames.
