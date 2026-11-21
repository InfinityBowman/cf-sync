# cf-sync

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
- `packages/yjs` — the Yjs fields add-on (ARCHITECTURE.md#yjs-fields): `./server` exports `yjsFields` (an `EngineExtension` for `createWorkspaceDO`), `./client` exports `createYjsFields` (attaches to `SyncClient` via its binary seams), `./react` exports `useYjsField` (handle lifecycle + sync gate + reactive `canWrite` as a hook). `yjs` is a peer dependency, react an optional one; core stays yjs-free.
- `apps/demo` — todo demo; `pnpm demo:worker` (wrangler) + `pnpm demo:web` (vite) from the repo root, in two terminals.
- `reference/` — shallow clones of prior art (gitignored). Cited by file:line in ARCHITECTURE.md.

Packaging: ESM-only; `exports` point at `src/*.ts` for monorepo dev, `publishConfig.exports` swaps to `dist/` on `pnpm pack`/publish (built by tsdown). `pnpm check:packages` (also CI) packs each package and gates on publint + arethetypeswrong — run it after touching any package.json or public type surface. zod and @tanstack/db are peer dependencies, never regular ones.

Invariants that must never break (see ARCHITECTURE.md#invariants):
1. A mutation's data effects and the client's `last_mutation_id` advance commit in the same SQLite transaction.
2. Permanent app errors still advance `last_mutation_id`.
3. All DO WebSocket handlers stay synchronous — no `await` between reading state and sending frames.

## Releasing

Releases run in CI: bump `version` in the package's package.json and merge to main. `.github/workflows/release.yml` (also runnable with `gh workflow run release.yml`) typechecks, tests, then runs `pnpm release`, which builds and publishes every package whose version is not on npm yet. It authenticates through npm trusted publishing (OIDC), so no token is stored; each `@cf-sync/*` package trusts `release.yml` in `InfinityBowman/cf-sync` with direct publish allowed. No changesets or tags.

A failed publish shows ENEEDAUTH when a package's trusted publisher is missing or the workflow filename or `repository.url` no longer matches it. A new package must exist on npm before a trusted publisher can be added, so Jacob publishes its first version locally (`pnpm release` after `npm login`), then runs `npm trust github @cf-sync/<name> --file release.yml --repo InfinityBowman/cf-sync --allow-publish --yes` (needs his 2FA); CI publishes from then on. Locally, `pnpm release` still works as a fallback with a logged-in npm (`npm login`). Then `pnpm --filter @cf-sync/demo deploy` if the demo should pick the release up. Consumers on pnpm hold new versions for the release-age window unless they exclude `@cf-sync/*` (corates does).
