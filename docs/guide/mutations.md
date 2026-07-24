# Mutations & optimistic writes

There are two ways to write data, and they end up on the same wire:

```ts
// Collection writes — full-row LWW, emitted as the built-in sync.put / sync.del
issues.insert({ id: ulid(), title: 'ship it' })

// Intent mutations — named mutators from your app definition
await client.mutate.issue.move({ id, column: 'done' })
// equivalent string form:
await client.mutate('issue.move', { id, column: 'done' })
```

`mutate` is fully typed from your app definition: names autocomplete, bad args are a compile error.

## What "optimistic" means here

When you call `mutate`, the shared mutator's `apply` runs **locally first**, against your collections, and all of its writes land as **one atomic overlay**:

- Visible instantly — no waiting on the network.
- Swapped for the server's authoritative patch on confirm.
- Rolled back **together** if the server rejects.

A multi-row intent like `clearCompleted` is one line in the mutator, one wire mutation, one overlay. There is no separate "optimistic effect" to hand-write and keep in sync with the server logic, and no per-row CRUD echo.

For this to feel seamless, your mutators must be deterministic and tolerant of lagging local state — the [two authoring rules](/guide/defining-your-app#the-two-authoring-rules).

## The one semantic to internalize

::: warning A rejection always means the mutation will not apply
If the promise from `mutate` rejects, that mutation is finished — it has been rolled back locally and will never land on the server. There is no "maybe it went through". Conversely, while the promise is pending with persistence on, the mutation is durably queued and *will* apply when connectivity returns.
:::

What resolution looks like depends on whether the client has a durable store:

| | `persist: true` (or a custom store) | memory-only |
|---|---|---|
| Online, accepted | resolves on server confirm | resolves on server confirm |
| Online, rejected | rejects with the server's code | rejects with the server's code |
| Offline | stays **pending** — queued durably, replays exactly once, survives reloads | rejects with `Timeout` after `confirmTimeoutMs` (default 30s) and is discarded |

The memory-only timeout is honest: without a store, a queued mutation would not survive a reload anyway, so the client refuses to pretend otherwise.

Beyond server rejection, a pending mutation can also reject with `Stopped` (`client.stop()` / `client.destroy()` was called) or `Fatal` (the connection hit a permanent failure — see [Auth & sessions](/guide/auth#close-codes)).

## Rejection codes

Rejected mutations throw `MutationError`, which carries a typed `code`:

```ts
import { MutationError } from '@cf-sync/client'

try {
  await client.mutate.issue.move({ id, column })
} catch (e) {
  if (e instanceof MutationError && e.code === 'NotFound') {
    toast('That issue was deleted by someone else.')
  }
}
```

The vocabulary, in three groups:

- **Engine rejections** (`EngineErrorCode`) — the server refused before your mutator ran: `InvalidArgs`, `UnknownMutator`, `RowTooLarge`.
- **Client-local outcomes** — `Timeout`, `Stopped`, `Fatal`, `LocalApplyFailed` (your mutator threw during the optimistic run; nothing was sent).
- **Your codes** — whatever your mutators throw in an `AppError('YourCode', …)`.

The built-in set is exported as `MutationErrorCode`, so branching on codes autocompletes.

## One handler instead of a catch per call site

Per-call `try`/`catch` is right when the caller can *do* something specific. For everything else — toasting, logging, telemetry — set `onMutationRejected` once at construction:

```ts
const client = new SyncClient({
  // …
  onMutationRejected: (error, { name }) => {
    toast.error(`"${name}" was rejected: ${error.message}`)
  },
})
```

It fires for **every** rejection, including the ones that have no awaiting caller and would otherwise roll back invisibly: collection `insert`/`update`/`delete` writes, and offline mutations replayed from the persisted outbox after a reload. (Filter on `error.code` if you only want server verdicts — the lifecycle codes `Stopped`/`Timeout`/`Fatal` arrive here too.)

With the handler set, fire-and-forget calls are safe: `void client.mutate.todos.clearCompleted()` needs no `.catch()` — the rejection is considered handled by the hook, while awaiting callers still see it normally.

## Permanent vs transient, precisely

An `AppError` (or invalid args) is **permanent**: the server records the mutation as processed — its data effects are refused, but the client's `lastMutationId` still advances, in the same SQLite transaction. This is what makes rejection final and the queue unblockable: a poison mutation can't wedge everything behind it.

Any other throw in an authoritative run is **transient**: nothing commits, the mutation stays unprocessed, and it is retried on the next connection. Infrastructure blips heal themselves; business-rule violations reject exactly once.

## Watching sync state

```ts
const unsubscribe = client.subscribeStatus((status) => { /* 'idle' | 'connecting' | … | 'synced' */ })
```

```tsx
import { useSyncStatus } from '@cf-sync/client/react'
const status = useSyncStatus(client)
```

Status is about the *pipe*, not about individual mutations — individual outcomes arrive through each `mutate` promise.
