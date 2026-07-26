# Troubleshooting

The engine tries hard to make its error messages name the fix. This page collects the failure modes that happen *before* a good error message can reach you, plus context for the warnings you may see in logs.

## The DO deploys fine, then fails on first SQL access

You declared the Durable Object with `new_classes` instead of **`new_sqlite_classes`**. The workspace DO requires SQLite-backed storage, and the storage backend of a deployed class cannot be changed — you'll need a new class name (or a fresh worker in dev):

```jsonc
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceDO"] }]
```

## `Cannot resolve "cloudflare:workers"` in tests or scripts

Something running in node imported `@cf-sync/server`'s main entry. Only workerd can load it. In test files and node scripts, import `@cf-sync/server/testing` and get the definition kit from `@cf-sync/protocol` — see [Testing your app](/guide/testing).

## `[cf-sync] dropped a binary frame that was not an ArrayBuffer`

You passed a custom `createSocket` and the socket it returns defaults to Blob binary frames. Set `binaryType = 'arraybuffer'` on it. Binary frames carry [yjs field](/guide/collaborative-text) traffic; without this, fields never sync.

## `[cf-sync] table schemas changed under schema version N (fingerprint …)`

A deploy changed table schemas without bumping `version`. The warning names the exact entry to add. This is drift detection working — fix it before old and new bundles disagree about row shapes. See [Schema evolution](/guide/schema-evolution#drift-detection).

## `defineApp: migrations end at N but version is M`

The migration chain must be consecutive and end at `version`. Every bump gets an entry: a `migrate` function if existing rows need rewriting, an explicit `null` if the change is additive.

## The page reloads after a deploy

Working as intended: an old bundle was told `VersionNotSupported` and reloaded into the new one. Reloads are throttled to once per minute, so a bad deploy window degrades to paced retries. Pass `onFatal` to handle it yourself — see [Auth & sessions](/guide/auth#close-codes).

## A mutation rejected with `RowTooLarge`

Single rows are capped (they must fit comfortably inside a chunked frame). Rows are for structured state, not payloads — put large text in a [yjs field](/guide/collaborative-text) and blobs in R2 with a key in the row.

## Mutations reject with `Timeout` after ~30s

You're running memory-only (no `persist`). Without a durable store, a queued mutation can't survive a reload, so the client rejects rather than pretend. Turn on `persist: true` for a durable outbox with pending-until-delivered semantics — see [Offline & persistence](/guide/offline-persistence).

## A departed peer's presence lingers

Liveness is TCP-bound: silent deaths (laptop lid, network partition) take ~75s+ to surface. Use each peer's `receivedAt` to fade stale entries on your own deadline — see [Presence](/guide/presence#two-semantics-to-know).

## `workspaceCollectionOptions: table "…" is not in the schema`

The collection name must match a table key in `defineSchema`. The error lists the known tables — usually it's a typo, or the client and worker are importing different copies of the app definition. There must be exactly one `defineApp` value shared by both bundles.

## Duplicate clients under Vite HMR / React Fast Refresh

A module-scope `createWorkspace(...)` (or `new SyncClient(...)`) is safe as long as the module it lives in triggers a full reload on change. The moment it's exported from a file Fast Refresh *accepts* — a component file, usually — a hot update re-evaluates the module and constructs a **second live client** sharing the first one's sessionStorage clientId: two sockets, duplicate collections, confusing double traffic. Dev-only, but it looks exactly like a sync bug.

Two fixes: keep the workspace in its own module that no component file re-exports (the demo's `sync.ts` pattern), or register a dispose hook so the old client is torn down before the module re-evaluates:

```ts
export const ws = createWorkspace({ url, workspaceId, app, persist: true })
if (import.meta.hot) {
  import.meta.hot.dispose(() => void ws.destroy())
}
```

## Two tabs, one user — two presence avatars

Peers are per connection by design. Group by `principal` (server-attested) for one-avatar-per-user — see [Presence](/guide/presence).

## Still stuck?

[Open an issue](https://github.com/InfinityBowman/cf-sync/issues) — include the full error text; the messages are written to be quoted.
