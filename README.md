# cf-sync

A server-authoritative, Linear-style sync engine on **Cloudflare Durable Objects**, with **TanStack DB** as the client store.

Optimistic mutations, real-time propagation, offline with exactly-once replay, typed presence, and opt-in collaborative text — as a library, on infrastructure you already run. One Durable Object per workspace, DO SQLite as the system of record, no external database tier.

**[Documentation](./docs/guide/getting-started.md)** · **[Why cf-sync?](./docs/guide/why.md)** · **[Design document](./DESIGN.md)**

```ts
// One definition, imported by both the worker and the browser:
const app = defineApp({ version: 1, schema, mutators })

// Worker — the Durable Object is the backend:
export const WorkspaceDO = createWorkspaceDO({ app })
export default { fetch: createSyncFetch({ namespace: (env) => env.WORKSPACE, authorize }) }

// Browser — typed collections and optimistic intent mutations:
const client = new SyncClient({ url, workspaceId, app, persist: true })
const { issues } = createCollections(client)

issues.insert({ id: ulid(), title: 'ship it' })  // optimistic, converges via the server
await client.mutate.issue.move({ id, column })   // one intent, one wire op, atomic rollback
```

## Highlights

- **Server-authoritative** — the DO re-runs every mutator with full authority; clients are optimistic caches that always converge. No merge functions in app code.
- **Optimistic by default** — a mutator's `apply` runs instantly on the client and authoritatively on the server; rollback, rebase, and replay are the engine's job.
- **Offline that survives reloads** — IndexedDB mirror, durable outbox, exactly-once replay via the per-client `lastMutationId` contract.
- **Schema evolution with teeth** — versioned migration chains, validated at boot; a one-line CI tripwire (`checkSchemaEvolution`) fails the build on a schema change without a version bump, and per-workspace drift detection backstops it at runtime.
- **Typed presence** — declare a zod shape, get throttled live cursors and server-attested identity.
- **Collaborative text where it counts** — rows stay LWW; `@cf-sync/yjs` adds Yjs fields in the same DO for the fields that genuinely need merging.
- **Testable** — `createTestEngine` runs the real engine semantics in plain node; the engine itself is locked by contract tests and a multi-client convergence simulation in workerd.

## Packages

| Package | What it is |
|---|---|
| [`@cf-sync/protocol`](./packages/protocol) | The shared definition kit: `defineApp`, `defineSchema`, `defineMutators`, `crudMutators`, `AppError` — importable from both worker and browser. Wire internals (hello / push / poke schemas, frame chunking, field frames) live behind `@cf-sync/protocol/internal` |
| [`@cf-sync/server`](./packages/server) | `createWorkspaceDO`, worker routers with an `authorize` hook, admin surface, and the in-memory test engine |
| [`@cf-sync/client`](./packages/client) | `SyncClient` (socket, outbox, poke application, reconnect), the TanStack DB collection adapter, React hooks |
| [`@cf-sync/yjs`](./packages/yjs) | Collaborative-text add-on: Yjs fields in the workspace DO, with a `useYjsField` React hook |

React apps read collections with `useLiveQuery` from **`@tanstack/react-db`** — install it alongside `@cf-sync/client` (it is declared as an optional peer, so your package manager will flag a version pair whose pinned `@tanstack/db` disagrees with ours).

## Documentation

- [Why cf-sync](./docs/guide/why.md) — positioning, non-goals, honest comparisons
- [Getting started](./docs/guide/getting-started.md) — zero to two converging tabs
- Core concepts: [Defining your app](./docs/guide/defining-your-app.md) · [Mutations](./docs/guide/mutations.md) · [Schema evolution](./docs/guide/schema-evolution.md) · [Auth & sessions](./docs/guide/auth.md)
- Collaboration: [Presence](./docs/guide/presence.md) · [Collaborative text](./docs/guide/collaborative-text.md)
- Client: [Reading data](./docs/guide/reading-data.md) · [Offline & persistence](./docs/guide/offline-persistence.md)
- Production: [Offline & persistence](./docs/guide/offline-persistence.md) · [Testing](./docs/guide/testing.md) · [Operations](./docs/guide/operations.md) · [Troubleshooting](./docs/guide/troubleshooting.md)
- [API reference](./docs/reference/index.md) — [SyncClient](./docs/reference/sync-client.md) · [Collections](./docs/reference/collections.md) · [Definition kit](./docs/reference/define-kit.md) · [Server](./docs/reference/server.md) · [Test engine](./docs/reference/testing.md) · [Yjs fields](./docs/reference/yjs.md)
- [DESIGN.md](./DESIGN.md) — the architecture, locked decisions, and invariants, with prior-art citations

Run the docs site locally with `pnpm docs:dev`.

## Try it

The [demo](./apps/demo) is a todo app exercising every plane — rows, intents, presence, collaborative text — in ~450 readable lines:

```sh
pnpm install
cd apps/demo
pnpm dev:worker   # wrangler dev on :8787 (the sync worker + Workspace DO)
pnpm dev:web      # vite dev server, second terminal
```

Open the vite URL in **two tabs**; use a URL hash (`#team-a`) to switch workspaces.

## Developing

```sh
pnpm test            # protocol + client (node) and server contract/convergence tests (workerd)
pnpm typecheck
pnpm build           # bundle each package to dist/ (tsdown: ESM + .d.ts)
pnpm check:packages  # pack as publishing would; gate with publint + arethetypeswrong
```

Packages are ESM-only. In the monorepo, `exports` point at TypeScript source; `publishConfig` swaps them to `dist/` at pack time, and CI verifies the packed artifacts. Read [DESIGN.md](./DESIGN.md) before changing protocol, storage schema, or sync semantics.

## Status

M0–M2, M3 phases 1–2, session control, presence, and Tier 2 Yjs fields are implemented and tested. Remaining on the [roadmap](./DESIGN.md#12-milestones): startup replay of queued intents. Packages are not yet published to npm.

## License

[MIT](./LICENSE)
