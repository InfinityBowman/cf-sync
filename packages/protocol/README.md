# @cf-sync/protocol

The shared definition kit for [cf-sync](https://github.com/InfinityBowman/cf-sync-engine) — a server-authoritative sync engine on Cloudflare Durable Objects.

One definition file, imported by **both** the worker and the browser, drives everything: server-side validation, collection row types, typed `mutate` calls, and the schema-version rollout. This package is the only one importable from both sides, and its only runtime dependency is `zod` (a peer).

```sh
npm install @cf-sync/protocol zod
```

```ts
// src/schema.ts — shared between worker and browser
import { defineApp, defineSchema, defineMutators, AppError } from '@cf-sync/protocol'
import { z } from 'zod'

const schema = defineSchema({
  issues: z.object({
    id: z.string(),
    title: z.string(),
    column: z.string().default('backlog'),
  }),
})

const mutators = defineMutators(schema, {
  'issue.move': {
    args: z.object({ id: z.string(), column: z.string() }),
    apply: (tx, { id, column }) => {
      const issue = tx.get('issues', id)
      if (!issue) throw new AppError('NotFound', `issue ${id} does not exist`)
      tx.put('issues', id, { ...issue, column })
    },
  },
})

export const app = defineApp({ version: 1, schema, mutators })
```

Hand `app` to `createWorkspaceDO` ([@cf-sync/server](https://www.npmjs.com/package/@cf-sync/server)) on the worker and `SyncClient` ([@cf-sync/client](https://www.npmjs.com/package/@cf-sync/client)) in the browser — the same value on both sides, so they can't disagree.

Also exported: `crudMutators`, presence typing, and migration-chain validation. The wire-level frame schemas and chunking used by the engine packages live behind `@cf-sync/protocol/internal` — available to advanced integrations, but that surface tracks the wire protocol and carries no compatibility promise.

**Docs:** [Defining your app](https://github.com/InfinityBowman/cf-sync-engine/blob/main/docs/guide/defining-your-app.md) · [Schema evolution](https://github.com/InfinityBowman/cf-sync-engine/blob/main/docs/guide/schema-evolution.md) · [Repository](https://github.com/InfinityBowman/cf-sync-engine)

MIT
