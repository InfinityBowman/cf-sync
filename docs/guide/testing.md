# Testing your app

Your mutators and migrations are plain functions over a transaction — they deserve unit tests that run in milliseconds, not a workerd harness. `@cf-sync/server/testing` exports an in-memory engine that runs **the same write-buffer, validation, and error semantics as the Durable Object** — shared code, not a reimplementation.

```ts
import { createTestEngine } from '@cf-sync/server/testing'
import { app } from '../src/schema'

it('clearCompleted deletes only completed todos', () => {
  const engine = createTestEngine(app)
  engine.seed('todos', 't1', { id: 't1', title: 'keep', done: false })
  engine.seed('todos', 't2', { id: 't2', title: 'drop', done: true })

  const result = engine.mutate('todo.clearCompleted', {})

  expect(result.error).toBeUndefined()
  expect(engine.get('todos', 't1')).toBeDefined()
  expect(engine.get('todos', 't2')).toBeNull()
})
```

Runs in plain vitest or jest, in node — no workerd, no miniflare, no bindings.

::: warning Import paths matter in node
The server's **main** entry imports `cloudflare:workers`, which node can't load — never import it in test files that run outside workerd. To make that mistake hard, `@cf-sync/server/testing` re-exports the whole definition kit (`defineApp`, `defineSchema`, `defineMutators`, `crudMutators`, `AppError`, and their types), so a test file needs exactly one import source. Importing the kit from `@cf-sync/protocol` works identically.
:::

## Testing migrations

Seed rows in their **old** shape at an old stored version; the migration chain replays inside `createTestEngine`, exactly like the DO's first wake after a deploy:

```ts
it('the 1 -> 2 migration backfills priority', () => {
  const engine = createTestEngine(app, {
    storedVersion: 1,
    rows: { issues: { i1: { id: 'i1', title: 'old', column: 'doing' } } },
  })
  expect(engine.get('issues', 'i1')?.priority).toBe('normal')
})
```

A chain that produces schema-invalid rows throws from `createTestEngine` itself — you find out in the test run, not on a production workspace's first wake.

## The schema-evolution tripwire

One more test makes the *forgotten* migration impossible to ship — a schema change with no version bump fails CI with the exact `migrations` entry to add:

```ts
it('every schema change ships with a version bump', async () => {
  await checkSchemaEvolution(app, new URL('./schema-snapshot.json', import.meta.url))
})
```

Commit the snapshot file it scaffolds; a legitimate version bump rewrites it automatically. Details in [Schema evolution](/guide/schema-evolution#drift-detection).

## The semantics are the real ones

The engine honors the [engine invariants](https://github.com/InfinityBowman/cf-sync/blob/main/ARCHITECTURE.md#invariants):

- An `AppError` from a mutator (or invalid args) reports as `result.error` — **permanent**, no data written, and `engine.lastMutationId()` still advances. Assert on both when testing rejection paths.
- Any other throw is **transient**: rethrown, nothing committed.
- Auth-dependent mutators can be exercised by passing a principal and auth context, so `ctx.authoritative` permission checks are testable without a socket in sight.

## Testing the full stack

For end-to-end coverage (sockets, hibernation, convergence), the engine's own test suite runs against real workerd via `@cloudflare/vitest-pool-workers` — including a seeded multi-client convergence simulation. Most apps don't need to replicate that layer: if your mutators are correct against `createTestEngine`, the engine's contract tests cover the transport. Put your effort into mutator edge cases and migration coverage.
