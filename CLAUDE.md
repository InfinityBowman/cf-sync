# cf-sync-engine

Server-authoritative sync engine on Cloudflare Durable Objects. Read `ARCHITECTURE.md` before
changing protocol, storage schema, or sync semantics — it records the locked decisions
and the invariants the tests enforce. Code comments cite it by anchor
(`ARCHITECTURE.md#optimistic-intents`); keep new comments to the same convention. The
user-facing story lives in `docs/` and must stay self-contained (no ARCHITECTURE.md
references in exported-symbol JSDoc — it ships in the packages' d.ts).

Layout:
- `packages/protocol` — the shared app-definition kit (`defineApp`, `defineSchema`, `defineMutators`, `crudMutators`, `AppError`) — the one package importable from both worker and browser. No runtime deps besides zod. The root export is the curated app-author surface; wire internals (message schemas, frame chunking, field frames) live behind the `./internal` subpath, which the engine packages import and which carries no compatibility promise. `defineApp` bundles version + schema + mutators + the migration chain into the one object both `createWorkspaceDO` and `SyncClient` take.
- `packages/server` — `createWorkspaceDO` (the Workspace Durable Object) + `createSyncFetch`/`createAdminFetch`/`bearerTokenAuth` (worker routers). Tests run in workerd via `@cloudflare/vitest-pool-workers`. The `./testing` subpath exports `createTestEngine` (in-memory engine over the shared engine-core, runs in plain node — never import the main index from node, it pulls cloudflare:workers).
- `packages/client` — `SyncClient` (socket, outbox, poke application; connects on construction unless `autoStart: false`) + `workspaceCollectionOptions`/`createCollections` (TanStack DB collection adapter). The `./react` subpath exports `useSyncStatus`, `useHydrated` (the offline-first first-paint gate), and `usePresence`.
- `packages/yjs` — the Tier 2 fields add-on (ARCHITECTURE.md#yjs-fields): `./server` exports `yjsFields` (an `EngineExtension` for `createWorkspaceDO`), `./client` exports `createYjsFields` (attaches to `SyncClient` via its binary seams), `./react` exports `useYjsField` (handle lifecycle + sync gate + reactive `canWrite` as a hook). `yjs` is a peer dependency, react an optional one; core stays yjs-free.
- `apps/demo` — todo demo; `pnpm demo:worker` (wrangler) + `pnpm demo:web` (vite) from the repo root, in two terminals.
- `reference/` — shallow clones of prior art (gitignored). Cited by file:line in ARCHITECTURE.md.

Packaging: ESM-only; `exports` point at `src/*.ts` for monorepo dev, `publishConfig.exports` swaps to `dist/` on `pnpm pack`/publish (built by tsdown). `pnpm check:packages` (also CI) packs each package and gates on publint + arethetypeswrong — run it after touching any package.json or public type surface. zod and @tanstack/db are peer dependencies, never regular ones.

Invariants that must never break (see ARCHITECTURE.md#invariants):
1. A mutation's data effects and the client's `last_mutation_id` advance commit in the same SQLite transaction.
2. Permanent app errors still advance `last_mutation_id`.
3. All DO WebSocket handlers stay synchronous — no `await` between reading state and sending frames.
