# Reading data

Reads are the half of the sync engine you don't see in the protocol: the whole workspace is already on the client, so **every query is local**. There is no fetch, no loading spinner per query, no cache to invalidate — a query is a live view over synced rows, updated incrementally as pokes land and optimistic writes apply. Collections created by [`createCollections`](/reference/collections) are plain TanStack DB collections; everything on this page is TanStack DB's query engine doing its job over cf-sync's data.

```tsx
import { eq, useLiveQuery } from '@tanstack/react-db' // react-db re-exports all of @tanstack/db
import { issues } from './sync'

const { data: open } = useLiveQuery((q) =>
  q
    .from({ issue: issues })
    .where(({ issue }) => eq(issue.column, 'open'))
    .orderBy(({ issue }) => issue.createdAt, 'asc'),
)
```

The result re-renders when — and only when — a row affecting it changes: a poke from another user, one of your own optimistic writes, a rollback. TanStack DB applies **differential updates** (the query doesn't re-run from scratch), so queries over thousands of rows stay cheap at interactive rates.

## The mental model

Query state and sync state are different axes, and conflating them is the classic mistake:

- A query is **always answerable** — it runs against whatever is local right now. With [`persist: true`](/guide/offline-persistence), that includes every previously synced row from the first paint, before the socket even connects.
- Whether local state is *current* is the client's business, not the query's: render staleness from [`useSyncStatus`](/reference/sync-client#react-hooks), not by making queries wait. `useLiveQuery` does expose `isLoading`/`isReady`, but for synced collections these gate on the collection's first data, not on the server round-trip.

This is also why there are no query params to send anywhere: queries **filter** what's synced, they don't **fetch**. The workspace syncs whole to every member ([by design](/guide/why#honest-non-goals)) — a query can never pull in rows the workspace doesn't hold, and sizing workspaces so that's fine is the one thing the engine asks of your data model.

## Filtering, sorting, shaping

The builder covers the SQL-shaped essentials — `where`, `select`, `orderBy`, `limit`, `offset`, `distinct`, `findOne` — with typed expression helpers imported from `@tanstack/db`:

```ts
import { eq, and, or, not, gt, gte, lt, lte, inArray, like, ilike } from '@tanstack/db'

q.from({ issue: issues })
  .where(({ issue }) => and(eq(issue.column, 'doing'), gt(issue.priority, 1)))
  .orderBy(({ issue }) => issue.createdAt, 'desc')
  .limit(50)
```

Rows are typed from your [schema](/guide/defining-your-app#the-schema), so `issue.column` autocompletes and a typo is a compile error. Aggregations come from the same helper set (`count`, `sum`, `avg`, `min`, `max`) with `groupBy`/`having`:

```ts
import { count, useLiveQuery } from '@tanstack/react-db'

const { data: perColumn } = useLiveQuery((q) =>
  q
    .from({ issue: issues })
    .groupBy(({ issue }) => issue.column)
    .select(({ issue }) => ({ column: issue.column, total: count(issue.id) })),
)
```

## Joins

Synced tables join like tables anywhere — `join` (left by default in TanStack DB's builder), or the explicit `innerJoin`/`leftJoin`/`rightJoin`/`fullJoin`:

```ts
const { data: assigned } = useLiveQuery((q) =>
  q
    .from({ issue: issues })
    .innerJoin({ user: users }, ({ issue, user }) => eq(issue.assigneeId, user.id))
    .select(({ issue, user }) => ({ id: issue.id, title: issue.title, assignee: user.name })),
)
```

Because both sides are local, joins cost no waterfall — this is where the synced-workspace model quietly pays for itself. The one discipline it asks: relations are by id (`assigneeId`), exactly as the [LWW row model](/guide/mutations) wants them, not embedded documents.

## Derived collections

A query can be materialized as a collection of its own with `createLiveQueryCollection` from `@tanstack/db` — module scope, no React required — and further queries can build on it:

```ts
import { createLiveQueryCollection, eq } from '@tanstack/db'

export const myIssues = createLiveQueryCollection((q) =>
  q.from({ issue: issues }).where(({ issue }) => eq(issue.assigneeId, currentUserId)),
)
```

Derived collections are the layering tool: one canonical filter defined once, consumed by many components (each `useLiveQuery` over it stays differential), instead of the same `where` clause copy-pasted per call site. They are read views — writes still go through the [source collections](/reference/collections) or [intent mutations](/guide/mutations).

## Outside React

Collections are framework-free. The imperative surface:

```ts
issues.get(id)          // one row (or undefined)
issues.has(id)
issues.toArray          // snapshot of all rows
issues.size

const unsubscribe = issues.subscribeChanges((changes) => {
  // inserts/updates/deletes since last emission — a differential feed
})
```

`subscribeChanges` plus `createLiveQueryCollection` is the complete vanilla story — what `useLiveQuery` wraps. Solid, Svelte, and Vue adapters exist upstream (`@tanstack/solid-db`, `@tanstack/svelte-db`, `@tanstack/vue-db`); cf-sync itself never assumes React.

## Where the query engine's docs take over

Everything above is TanStack DB surface, documented exhaustively — operators, functional variants, index tuning, `unionAll` — in the [TanStack DB docs](https://tanstack.com/db/latest/docs/overview). What cf-sync adds is the contract underneath: rows arrive validated against the shared schema, appear atomically per mutation (a multi-row intent never renders half-applied), and optimistic writes flow through queries exactly like confirmed state — with rejection rollback arriving as just another change event.
