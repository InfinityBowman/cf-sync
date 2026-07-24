# Auth & sessions

cf-sync deliberately owns no identity. Your users, roles, and entitlements live in your own authority (your app database, your auth provider); the engine gives that data a **lifecycle on the connection**: a way to stamp it, carry it to mutators, revoke it, and refresh it.

## The `authorize` hook

Every socket upgrade passes through `authorize` in the worker — before the Durable Object ever wakes:

```ts
createSyncFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  authorize: async (request, { workspaceId, clientId, env }) => {
    const session = await verifyAuth(request, env)
    if (!session) return { ok: false, reason: 'unauthenticated' }

    const member = await getMember(env.DB, workspaceId, session.userId)
    if (!member) return { ok: false, reason: 'not-a-member' }

    return {
      ok: true,
      principal: session.userId,
      context: { role: member.role, writeAllowed: member.entitled },
    }
  },
})
```

`authorize` may return:

- `true` / `false` — admit or reject (a bare `false` answers HTTP 403)
- a `Response` — full control over the rejection
- an **`AuthVerdict`** — `{ ok: true, principal?, context?, expiresAt? }` or `{ ok: false, code?, reason? }`

The verdict's `principal` and `context` are stamped onto the connection, survive DO hibernation, and cannot be spoofed from outside (the internal header that carries them is stripped from inbound requests).

::: tip Rejections are observable in the browser
A browser can't see the HTTP status of a failed WebSocket upgrade — a 403 looks identical to a network error. So on a structured rejection, the router completes the upgrade and immediately closes with a code and your `reason` slug. The client gets a real close event, your `onFatal` gets the reason, and the DO never wakes. Keep reasons short stable slugs (`membership-revoked`, not prose) — WebSocket close reasons cap at 123 bytes.
:::

## Reading the verdict in mutators

Type the context once with `authContext`, and every mutator sees it as `ctx.auth`:

```ts
const mutators = defineMutators(schema, {
  'issue.delete': {
    args: z.object({ id: z.string() }),
    apply(tx, { id }, ctx) {
      if (ctx.authoritative && !ctx.auth?.writeAllowed)
        throw new AppError('ReadOnly', 'subscription lapsed')
      tx.del('issues', id)
    },
  },
}, { authContext: z.object({ role: z.enum(['owner', 'member']), writeAllowed: z.boolean() }) })
```

Two details that keep this honest:

- **`ctx.authoritative`** is `true` on the server, `false` in optimistic client runs — where no server verdict exists. `if (ctx.authoritative && !allowed) throw` enforces on the server and lets the optimistic apply proceed; a rejection rolls back through the normal path.
- **Validation at connect, not mid-mutation**: the DO validates the verdict's `context` against `authContext` at upgrade. If your `authorize` hook and your mutators ship disagreeing shapes, the connection fails immediately with a descriptive reason — a configuration bug surfaces at connect time, not as a runtime surprise during someone's mutation.

`ctx.principal` (the server-attested user id) and `ctx.clientId` are always available.

## Revoking and refreshing live sessions

Membership removal must stop *reads*, not just writes — so revocation closes sockets. From a command handler or webhook:

```ts
import { workspaceAdmin } from '@cf-sync/server'

const ws = workspaceAdmin(env.WORKSPACE, workspaceId)

// membership revoked → close their sockets, client goes fatal with the reason
await ws.disconnect({ principal: userId, mode: 'kick', reason: 'membership-revoked' })

// entitlements changed → everyone reconnects and re-runs authorize with fresh stamps
await ws.disconnect({ mode: 'refresh' })
```

Selectors: `principal`, `clientId`, or neither (all sockets). The same op is exposed over HTTP as `POST /admin/<workspaceId>/disconnect` — see [Operations](/guide/operations).

### Stamps with an expiry

Push-driven revocation depends on the webhook arriving. If you want a bound on how long stamps stay trusted without being re-derived, return `expiresAt` (epoch ms) in the verdict — past-due sockets are closed with the *refresh* code at the next interaction, and the reconnect re-runs `authorize`. Omitted means no expiry: apps with reliable revocation webhooks don't pay for one.

## Close codes {#close-codes}

The client sorts server-initiated closes into two behaviors:

- **Refresh (4300)** — reconnect immediately with a fresh `authorize` run. Not an error; this is the entitlement-freshness mechanism working. (Loop guard: consecutive refreshes without a successful sync fall back to normal backoff, so a stuck webhook can't storm your auth database.)
- **Permanent (4400–4499)** — stop reconnecting and call `onFatal` with `{ code, reason }`. This is `VersionNotSupported` after a deploy, a kick, or an auth-context validation failure.

```ts
new SyncClient({
  url, workspaceId, app, persist: true,
  onFatal: (err) => {
    if (err.reason === 'membership-revoked') return leaveWorkspace()
    if (err.reason === 'workspace-deleted') return cleanupAndRedirect()
    location.reload() // default behavior, throttled to once per minute
  },
})
```

Without `onFatal`, the default is a page reload throttled to once per minute — so a bad deploy window degrades to a paced retry, not a reload loop.

## One place evaluates auth

All auth evaluation happens in `authorize`, in the worker, against your database. The DO never re-derives it — refresh is a socket bounce, and the cursor catch-up path makes reconnects cheap. One place to audit, one place to get right.
