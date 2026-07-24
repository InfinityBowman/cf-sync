# API reference

The reference is organized by what you're building against, not by package internals. Everything documented here is the supported surface; anything importable but undocumented (notably `@cf-sync/protocol/internal`) carries no compatibility promise.

| Page | Covers |
|---|---|
| [SyncClient](/reference/sync-client) | The client: constructor options, `mutate`, presence, lifecycle, errors, React hooks |
| [Collections](/reference/collections) | The TanStack DB adapter: `createCollections`, per-table options, reading with live queries |
| [defineApp & the definition kit](/reference/define-kit) | `defineApp` · `defineSchema` · `defineMutators` · `AppError` · migrations · limits |
| [Server](/reference/server) | `createWorkspaceDO`, the sync and admin routers, `authorize`, `workspaceAdmin` |
| [Test engine](/reference/testing) | `createTestEngine` — the real engine semantics in plain node |
| [Yjs fields](/reference/yjs) | The collaborative-text add-on: server extension, client handles, `useYjsField` |

## Packages

| Package | Import from | Runs in |
|---|---|---|
| `@cf-sync/protocol` | both bundles — the shared definition kit | worker + browser + node |
| `@cf-sync/server` | the worker entry (plus `/testing` in node tests) | workerd (testing: node) |
| `@cf-sync/client` | the browser bundle (plus `/react`) | browser |
| `@cf-sync/yjs` | `/server`, `/client`, `/react` subpaths | per subpath |

`zod` and `@tanstack/db` are peer dependencies; `react`, `@tanstack/react-db`, and `yjs` are optional/add-on peers. The server's main entry imports `cloudflare:workers` — in node, import `@cf-sync/server/testing` instead ([why](/guide/testing)).

Every symbol here also carries its documentation as JSDoc — hovering it in your editor shows the same contracts, defaults, and examples.
