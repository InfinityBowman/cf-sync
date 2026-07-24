# Collections

The TanStack DB collection adapter from `@cf-sync/client`. Collections are the read surface for synced rows — live, queryable, optimistic — and the write surface for [full-row LWW writes](/guide/mutations). Row types, runtime validation, and keys all derive from the table's entry in the shared [app definition](/reference/define-kit#defineapp); synced data flows in through the client's poke pipeline, and local writes flow out as the built-in `sync.put`/`sync.del` mutations.

```ts
import { SyncClient, createCollections } from '@cf-sync/client'
import { app } from './schema'

const client = new SyncClient({ url, workspaceId, app })
const { todos, issues } = createCollections(client)

todos.insert({ id: crypto.randomUUID(), title: 'ship it' })
```

## createCollections

`(client: SyncClient, options?: { startSync?: boolean }) => WorkspaceCollections`

One fully typed collection per table in the client's schema — the one-line alternative to a `createCollection(workspaceCollectionOptions(…))` block per table. Rows are keyed by their `id` field (this engine's row model); a table whose rows key differently needs an individual [`workspaceCollectionOptions`](#workspacecollectionoptions) call with its own `getKey`.

Each collection's lifetime is tied to the client: [`client.destroy()`](/reference/sync-client#destroy) cleans them up too, so switching workspaces is one call. Collection ids are scoped by workspace (`workspace-<workspaceId>-<table>`), so an app with two open workspaces never collides on TanStack DB's app-wide ids. The collections also serve as `mutate`'s optimistic surface — [intent mutations](/guide/mutations) run their shared `apply` against them locally, attached at creation so intents fired before a collection has subscribers still get their optimistic effect.

### startSync

`boolean` · default `true`

Collections start syncing immediately — unlike `workspaceCollectionOptions`, which keeps TanStack's lazy default. The client receives pokes for every table on the one socket regardless, so eager sync costs no extra network: it only applies already-buffered data, and first render sees rows without waiting for a subscriber. Pass `{ startSync: false }` to defer each collection's pipeline to its first subscriber anyway.

## workspaceCollectionOptions

`(config: WorkspaceCollectionConfig) => CollectionConfig`

The per-table options creator — pass its result to TanStack DB's `createCollection` when one table needs individual control (a custom `getKey`, per-table `startSync`). The collection's schema, row type, and key function derive from the table's entry in the shared `defineSchema`, so the collection validates rows with the same schema the server enforces.

Table hooks register with the client at options creation, not at first subscriber — synced data buffers until TanStack starts the (lazy) sync pipeline, so a collection created up front never triggers a late-registration full resync no matter when it gets its first subscriber.

Two misconfigurations fail at setup instead of at runtime: a `table` not present in the client's schema throws immediately, and an app defined with `crud: false` throws because its registry lacks the `sync.put`/`sync.del` mutators collections emit — the alternative would be every insert rejecting with `UnknownMutator` and silently rolling back. `defineApp` [includes the CRUD mutators by default](/guide/defining-your-app#crud-is-included).

### client

`SyncClient` · **required**

The workspace client the collection syncs through. One collection per table per client.

### table

`string` · **required**

The server-side table name — a key of the client's schema, autocompleted from the app definition.

### getKey

`(row) => string` · default: `row.id`

Maps a row to its collection key. Required only when the table's row schema has no string `id` field — with one, the field-level default applies and the option is optional (the conditional type enforces this: omitting `getKey` on an id-less table is a compile error).

### startSync

`boolean` · default: TanStack's lazy default

Start the sync pipeline immediately instead of on first subscriber. `createCollections` flips this to `true` for you; here it stays lazy unless you opt in.

## Writes and the wire

Collection writes are the full-row half of the [two write paths](/guide/mutations): `insert` and `update` emit the built-in `sync.put` mutation carrying the complete row, `delete` emits `sync.del` — last-writer-wins per row on the server. Updates are full-row replacement, not field merge: a field absent from the written row is removed, matching the LWW row model.

Each write is optimistic — visible immediately, resolved only when the server confirms, at which point TanStack DB drops the optimistic overlay (its store handles rebasing overlays on top of newly synced state). A rejected write rolls back, and since collection writes have no awaiting caller, the rejection surfaces **only** through [`onMutationRejected`](/reference/sync-client#onmutationrejected) — without that hook set, a rejected insert vanishes silently. Multi-row [intent mutations](/guide/mutations) run against collections as one atomic overlay: all of a mutator's writes appear together and roll back together.

## Reading

Collections are plain TanStack DB collections — read them with `useLiveQuery` from `@tanstack/react-db`:

```tsx
import { eq, useLiveQuery } from '@tanstack/react-db'

const { data: openIssues } = useLiveQuery((q) =>
  q.from({ issue: issues }).where(({ issue }) => eq(issue.status, 'open')),
)
```

`@tanstack/react-db` is an optional peer of `@cf-sync/client` — install it alongside, and your package manager will flag a version pair whose pinned `@tanstack/db` disagrees. Query syntax, joins, and non-React usage are TanStack DB's domain: see the [TanStack DB docs](https://tanstack.com/db/latest). Sync-pipe state (connecting, synced, fatal) comes from [`useSyncStatus`](/reference/sync-client#react-hooks), not from collections.

## Types

### WorkspaceCollectionConfig

The `workspaceCollectionOptions` argument: `{ client, table, getKey?, startSync? }`, with `getKey` required when the row schema lacks a string `id` (see [getKey](#getkey)).

### WorkspaceCollections

What `createCollections` returns: a record with one live TanStack DB `Collection` per table name, each carrying the table's row type and schema — `collections.issues` is a compile error if the schema has no `issues` table.
