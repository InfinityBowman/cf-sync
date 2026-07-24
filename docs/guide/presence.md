# Presence

Who's online, live cursors, "X is editing this field" — ephemeral peer state relayed over the same socket as your data, and **never persisted**.

## Declare the shape once

Add a `presence` schema to `defineApp` and the whole surface lights up, typed end to end. The server validates every inbound state against it before relaying, so peers can't feed junk into your UI:

```ts
export const app = defineApp({
  version: 1,
  schema,
  mutators,
  presence: z.object({
    name: z.string(),
    cursor: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
})
```

## The client surface

Provide identity once at construction; afterwards every call site can be a bare merge, immune to component mount order:

```ts
const client = new SyncClient({ ..., initialPresence: { name: 'ada' } })

client.presence.update({ cursor: { x, y } })  // shallow merge — no re-stating `name`
client.presence.update({ cursor: undefined }) // clear one field, keep the rest
client.presence.set({ name: 'ada lovelace' }) // full replace, when you mean it
client.presence.self                          // your own parsed state (never in peers)
client.presence.clear()                       // peers see you go quiet
```

```tsx
import { usePresence } from '@cf-sync/client/react'

const peers = usePresence(client) // typed by the presence schema, self excluded
peers.map((p) => <Cursor key={p.clientId} name={p.state.name} at={p.state.cursor} />)
```

## What the library owns so apps don't

- **Pacing** — call `set`/`update` straight from a `mousemove` handler; the client throttles trailing-edge (one frame per `presenceThrottleMs`, default 100ms, latest state wins). No throttle glue in app code.
- **Lifecycle** — the last-set state re-announces on every reconnect and after DO hibernation wakes; peers reset to empty on disconnect. Stale presence is worse than absent presence.
- **Identity** — `clientId` and `principal` on every peer update are stamped by the server from the connection's [auth verdict](/guide/auth), never read from the payload. A modified client cannot impersonate another user's presence.

::: tip One avatar per user
Peers are per *connection* — the same user in two tabs is two peers. Key avatar stacks by `principal` (falling back to `clientId` when unauthenticated) and you get "one avatar per user" for free, attested by the server rather than claimed by the payload.
:::

## Two semantics to know

::: info Presence is ephemeral — no version bumps
Nothing is ever stored, so changing the presence schema needs **no version bump**. A reshape logs a soft server-side warning and that is all. Prefer additive changes (optional fields): old and new bundles share a workspace during a deploy window, and invalid state is dropped gracefully on both sides.
:::

::: warning Liveness is TCP-bound — treat presence as advisory
A peer that dies silently (laptop lid, network partition) lingers until socket teardown surfaces — anywhere from ~75 seconds to a couple of minutes. Never hard-lock UI on presence. Every peer entry carries `receivedAt` (local receipt time), so a tighter staleness bound is one comparison:

```ts
const stale = Date.now() - p.receivedAt > 30_000
```
:::
