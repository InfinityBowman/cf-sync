# Offline & persistence

One option turns on the whole story:

```ts
const client = new SyncClient({ url, workspaceId, app, persist: true })
```

`persist: true` gives you a durable local mirror in IndexedDB:

- **Instant reloads** — the UI hydrates from cache immediately, then resumes from the server *by cursor*: only what changed since the last sync crosses the wire, not a re-bootstrap.
- **A durable outbox** — mutations made offline survive reloads and replay **exactly once** when connectivity returns. The idempotency contract (per-client `lastMutationId`) makes replay safe: the server skips what it has already processed, no matter how many times a reconnect retries it.
- **Reloads keep your pending edits visible** — at hydration, each queued mutation's mutator re-runs locally against the cached rows and its optimistic overlay comes back, so what you saw before the reload is what you see after it. The server's verdict still settles each one: a confirm swaps the overlay for the authoritative rows, a rejection rolls it back and reports through [`onMutationRejected`](/guide/mutations#one-handler-instead-of-a-catch-per-call-site).
- **Honest pending promises** — while offline, `mutate` promises simply stay pending; they resolve when the queued mutation finally confirms. Memory-only clients instead reject with `Timeout` (default 30s), because without a store the mutation wouldn't survive a reload anyway. See [Mutations](/guide/mutations#the-one-semantic-to-internalize).

## What's managed for you

- **clientId lifecycle** — one per tab/session, minted and persisted automatically. Pass `clientId` explicitly to take it over.
- **Storage** — `IndexedDBSyncStore` under the hood; pass `store` to substitute your own `SyncStore` implementation (the contract is exported, and `MemorySyncStore` is the reference).
- **Fatal handling** — a permanent connection failure (e.g. `VersionNotSupported` after a deploy) reloads the page, throttled to once per minute so a bad deploy window can't reload-loop. Pass `onFatal` to customize — see [Auth & sessions](/guide/auth#close-codes).
- **Connection timing** — the client connects on construction. Pass `autoStart: false` (SSR, auth gating) and call `client.start()` yourself.

## Rendering before the network answers {#first-paint}

An offline launch has everything it needs on disk, but it has to know that before it paints. `useSyncStatus` won't tell you: `connecting` covers hydration, so it reads the same whether the cache is full or empty. Neither will the collection — no rows mid-hydration looks exactly like a workspace that genuinely has none, which is precisely the first-launch case you must not paint as "empty".

`useHydrated` is that signal. It flips true once cached rows are restored and collections are ready:

```tsx
import { useSyncStatus, useHydrated } from '@cf-sync/client/react'

function WorkspaceGate({ client, children }) {
  const status = useSyncStatus(client)
  const hydrated = useHydrated(client)

  // Cache restored → paint now, offline or not. Otherwise wait for the server.
  if (hydrated || status === 'synced') return children
  if (status === 'fatal') return <Reconnect />
  return <Spinner />
}
```

It stays `false` when there is nothing cached to paint — no store, a first launch, a cache discarded by a version bump, or a store that failed to open. That's deliberate: those all mean "wait for the first sync", which is the branch above. It settles once and survives reconnects, so a dropped socket never sends you back to the spinner.

Outside React, `await client.whenHydrated` resolves to the same boolean.

## Closing a workspace {#closing-a-workspace}

`client.destroy()` is the one-call teardown: stops syncing, cleans up every collection from `createCollections`, detaches add-ons (yjs fields), and closes the store connection.

Nothing durable is lost. Persisted rows and the offline outbox stay on disk, and the managed clientId is reused — mutations queued offline still replay exactly once when a client for that workspace is next constructed.

A destroyed client is inert: `start()` throws, `mutate` rejects with `Stopped`. To switch workspaces — one workspace per project, say — destroy and reconstruct:

```ts
await client.destroy()
client = new SyncClient({ url, workspaceId: nextProjectId, app, persist: true })
collections = createCollections(client, { startSync: true })
```

## Multi-tab behavior

Each tab is its own client with its own clientId and socket — that's what makes presence per-tab and keeps the protocol simple. The IndexedDB store handles concurrent tabs against the same workspace safely; convergence between tabs happens through the server, which is never more than a poke away.

## What offline can't do

Offline writes are optimistic against a **lagging local state** — the server may reject them on reconnect (a permission change, a row deleted by someone else). That's the same rejection path as online: the overlay rolls back atomically and the `mutate` promise rejects with the server's code. Design mutators so that "state moved underneath me" degrades gracefully — see [the two authoring rules](/guide/defining-your-app#the-two-authoring-rules).
