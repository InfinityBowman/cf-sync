# Defining your app

Everything cf-sync knows about your application comes from one object, built with `defineApp` and imported by **both** the worker and the browser bundle:

```ts
import { defineApp, defineSchema, defineMutators, AppError } from '@cf-sync/protocol'
import { z } from 'zod'

export const app = defineApp({ version: 1, schema, mutators })
```

That one value drives server-side row and args validation, collection row types, typed `mutate` calls, presence typing, and the schema-version rollout. Because both sides are configured with the same value, they cannot disagree.

## The schema

`defineSchema` takes a zod object schema per table:

```ts
const schema = defineSchema({
  issues: z.object({
    id: z.string(),
    title: z.string(),
    column: z.string().default('backlog'),
  }),
})
```

The server validates **every row write** against the table's schema before it commits — a client can never write a shape the schema doesn't allow, no matter what it sends. Defaults apply on insert (`column` above is filled in for you). Row types for collections and `tx.get`/`tx.put` all derive from here.

## Mutators

Mutations are **named intents**, not field writes. `issue.move`, not "set column to X" — intent survives rebase against concurrent changes, and gives the server one place to enforce invariants.

```ts
const mutators = defineMutators(schema, {
  'issue.move': {
    args: z.object({ id: z.string(), column: z.string() }),
    apply: (tx, { id, column }) => {          // args are validated and typed
      const issue = tx.get('issues', id)      // typed: { id, title, column } | null
      if (!issue) throw new AppError('NotFound', `issue ${id} does not exist`)
      tx.put('issues', id, { ...issue, column })
    },
  },
})
```

The server validates `args` against the schema before `apply` runs. Inside `apply`, `tx` gives you `get`, `put`, `del`, and `list` over the workspace's tables — every write validated, all of them committed atomically with the mutation's bookkeeping.

The definitions can also be written directly inside `defineApp({ mutators: { ... } })` — inference is identical either way. `defineMutators` is only *required* when declaring an [`authContext`](/guide/auth#reading-the-verdict-in-mutators), its third argument.

### CRUD is included

The full-row last-write-wins pair (`sync.put` / `sync.del`) — what collections emit for local `insert`/`update`/`delete` — is added by `defineApp` automatically. Pass `crud: false` for an intent-only app where every write must go through a named mutator.

## The two authoring rules

The same `apply` runs twice: **optimistically on the client** the moment you call `mutate`, and **authoritatively on the server** when the push arrives. Two rules keep those runs in agreement:

::: warning Rule 1 — reserve `throw` for genuine invariant violations
A local throw rejects the call immediately and sends nothing. But local state can legitimately be *behind* the server — so "row not synced yet" must not be an error. Throw for things that can never be valid, not for things that aren't visible yet.
:::

::: warning Rule 2 — pass nondeterministic values in as args
Ids, timestamps, random values: compute them at the call site and pass them as args, never inside `apply`. Otherwise the client's optimistic prediction and the server's authoritative run produce different results, and the UI flickers on confirm.
:::

```ts
// ✅ deterministic — both runs agree
await client.mutate.issue.create({ id: ulid(), createdAt: Date.now(), title })

// ❌ nondeterministic — server echo won't match the local prediction
apply: (tx, { title }) => tx.put('issues', ulid(), { id: ulid(), createdAt: Date.now(), title })
```

## Errors: `AppError` vs everything else

`throw new AppError(code, message)` is a **permanent** rejection: the server refuses the mutation, tells the client, and the optimistic effect rolls back. Your `code` string surfaces on the client as [`MutationError.code`](/guide/mutations#rejection-codes), so UIs can branch on it.

Any *other* throw is treated as **transient** (a bug, an infrastructure hiccup): nothing commits, and the mutation may be retried. Don't use plain `Error` for business rules — use `AppError` so the outcome is deterministic.

Permanent errors still advance the client's mutation bookkeeping (that's an engine invariant) — a permanently-rejected mutation is *done*, never retried, never blocking the queue behind it.

## Auth context in mutators

Mutators receive a context as their third argument — who is calling, and what your `authorize` hook stamped on the connection:

```ts
const mutators = defineMutators(schema, {
  'issue.delete': {
    args: z.object({ id: z.string() }),
    apply(tx, { id }, ctx) {
      if (ctx.authoritative && ctx.auth?.role !== 'admin')
        throw new AppError('Forbidden', 'admins only')
      tx.del('issues', id)
    },
  },
}, { authContext: z.object({ role: z.enum(['admin', 'member']) }) })
```

`ctx.authoritative` is `true` on the server and `false` in optimistic client runs — the honest signal for permission checks. See [Auth & sessions](/guide/auth) for the full picture.

## Presence shape

Declare an ephemeral presence payload on the same object and the whole presence surface lights up typed — see [Presence](/guide/presence):

```ts
export const app = defineApp({
  version: 1,
  schema,
  mutators,
  presence: z.object({ name: z.string(), cursor: z.object({ x: z.number(), y: z.number() }).optional() }),
})
```

## Versioning

`version` starts at 1 and bumps with **every** schema change, paired with a `migrations` entry. This is load-bearing enough to get its own page: [Schema evolution](/guide/schema-evolution).
