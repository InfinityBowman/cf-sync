# Test engine

The in-memory workspace engine from `@cf-sync/server/testing`, for unit-testing [app definitions](/reference/define-kit#defineapp) — mutators and schema migrations — in plain vitest or jest. It runs in node with no workerd, miniflare, or bindings, yet executes the same write-buffer, validation, and error semantics as the [Workspace Durable Object](/reference/server) — shared engine core, not a reimplementation. See [Testing your app](/guide/testing) for the workflow.

```ts
import { createTestEngine } from '@cf-sync/server/testing'
import { app } from '../src/schema'

const engine = createTestEngine(app)
engine.seed('todos', 't1', { id: 't1', title: 'x', done: true })
const result = engine.mutate('todo.clearCompleted', {})
expect(result.error).toBeUndefined()
expect(engine.list('todos')).toEqual([])
```

Import paths matter in node: this subpath and `@cf-sync/protocol` are safe, but the server's **main** entry imports `cloudflare:workers`, which node cannot load — never import `@cf-sync/server` itself in test files that run outside workerd.

## createTestEngine

`(app: AppDefinition, options?: TestEngineOptions) => TestEngine`

Creates a `TestEngine` from the shared app definition. Construction is where migration replay happens (see [`storedVersion`](#storedversion)), so a broken migration chain throws here — in the test run, not on a production workspace's first wake.

## Options

### clientId

`string` · default `"test"`

The clientId [`mutate`](#mutate) runs as; mutators see it as `ctx.clientId`. Use [`mutateAs`](#mutateas) to act as other clients without reconstructing the engine.

### principal

`string`

The principal mutators see as `ctx.principal` — what an `authorize` verdict would stamp on a real connection. Together with [`auth`](#auth), this makes `ctx.authoritative` permission checks testable without a socket in sight. See [Auth & sessions](/guide/auth).

### auth

`unknown`

The auth context mutators see as `ctx.auth`. Validated against the app's `authContext` schema at construction when one is declared — the parsed output is what mutators read — mirroring the DO's connect-time check, so an auth object your server would reject fails the test at construction too. Async validation is not supported and throws.

### storedVersion

`number` · default `app.version`

Simulates a workspace whose data was stored under an older schema version. When it equals `app.version` (the default), [`rows`](#rows) describe a fresh, current workspace and are validated like an admin import. When older, `rows` are stored **as-is** — old shapes, no validation — and the app's migration chain replays during construction, exactly like the DO's first wake after a deploy: one write buffer, net result validated at flush. A throwing migration step, a missing path, or a chain that produces schema-invalid rows throws from `createTestEngine` itself. See [Testing migrations](/guide/schema-evolution#testing-migrations).

### rows

`Record<string, Record<string, Record<string, unknown>>>`

Initial rows, keyed table → id → row data. Whether they are validated or taken raw depends on [`storedVersion`](#storedversion) above.

### nextSeed

`() => string` · default a random UUID per mutation

Mints the seed each [`mutate`](#mutate) runs under — `ctx.seed`, the value behind [`ctx.nextId()`](/reference/define-kit#mutatorcontext). The default is what a real client does. Supply a counter for reproducible ids, so a test can assert on the rows a batched mutator created:

```ts
let n = 0
const engine = createTestEngine(app, { nextSeed: () => `seed-${++n}` })
```

## Methods

### mutate

`(name, args?) => TestMutationResult`

Applies a named mutation authoritatively as the engine's default client, with the server's semantics: args are parsed first (invalid args are a permanent error), then the mutator runs against a write buffer that only commits on success. Names and args are typed from the app definition, and `tx.put` validates rows against the table schema — mutators read back parsed output with defaults applied. The outcome splits exactly as the [engine invariants](/guide/mutations) demand:

- An `AppError` thrown by the mutator — or invalid args — is a **permanent** rejection: writes are discarded, the result carries [`error`](#testmutationresult), and [`lastMutationId`](#lastmutationid) still advances. Assert on both when testing rejection paths.
- Any other throw is **transient**: it rethrows out of `mutate`, nothing commits, and the LMID does not advance — the real client would retry the push.

A successful result also carries [`changes`](#testmutationresult) — the rows the mutation wrote or deleted as before/after pairs, exactly what the Durable Object hands to [`onMutationCommitted`](/reference/server#onmutationcommitted) — so the logic behind a hook is testable here too.

### mutateAs

`(clientId, name, args?) => TestMutationResult`

[`mutate`](#mutate) as a specific clientId — for testing mutators that read `ctx.clientId`, or for multi-client LMID assertions. Each clientId keeps its own mutation sequence.

### get

`(table, id) => RowOf | null`

The live row, parsed through the table schema when it was written. Returns `null` for a row that does not exist **or was deleted** — assert `toBeNull()` for deletions, not `toBeUndefined()`.

### list

`(table) => Array<{ id, data }>`

All live rows in a table.

### seed

`(table, id, data) => void`

Stores a row directly, outside any mutation — test setup for state the server would already hold. Validated against the table schema with defaults applied, like every server-side write, so seeds cannot put the engine in a state the real server could never reach.

### lastMutationId

`(clientId?) => number`

The last mutation id confirmed for a client (the engine's default client when omitted); `0` before any mutation. Permanent errors advance it too — that is invariant 2, and the thing worth asserting alongside `result.error`.

### clientId · version

Read-only getters: the default clientId, and the current data version — bumps only when a mutation or seed actually writes rows.

## Types

### TestMutationResult

`{ error?: { code: string; message: string }; changes: RowChange[] }`

The outcome of one authoritative mutation. `error` is present only for permanent rejections: `code` is an engine built-in (`InvalidArgs`, `UnknownMutator`, …) or an app-defined `AppError` code passed through verbatim — the same vocabulary the client's [`MutationError`](/reference/sync-client#mutationerror) carries. Transient failures never produce a result; they throw.

`changes` lists the rows the mutation wrote or deleted, in the order it first touched them, as `{ tbl, id, before, after }` — `before` the stored row when the mutation began (`null` for an insert), `after` what it left (`null` for a delete); a row touched more than once appears once with its net effect. Empty on a permanent error and when the writes net to nothing (then `version` does not move either). This is the same list the Durable Object passes to [`onMutationCommitted`](/reference/server#onmutationcommitted).

## Schema-drift helpers

The CI side of [drift detection](/guide/schema-evolution#drift-detection) — catching the one schema mistake the type system cannot: changing a table schema without bumping `version`.

### checkSchemaEvolution

`(app, snapshotPath: string | URL) => Promise<SchemaSnapshot>`

One test next to your app definition that fails the build on an unbumped schema change — the deployed engine only detects it after the fact, as a warning in Durable Object logs. The snapshot file works like a jest snapshot: commit it. The first run scaffolds it; a legitimate version bump rewrites it automatically (the bump is the fix, so the test passes); a schema change **without** a bump throws with the exact `migrations` entry to add. Presence is deliberately outside the fingerprint — never stored, so reshaping it needs no bump. Node-only, like everything in this subpath.

```ts
it('every schema change ships with a version bump', async () => {
  await checkSchemaEvolution(app, new URL('./schema-snapshot.json', import.meta.url))
})
```

### schemaFingerprint

`(schema) => string`

The structural fingerprint of the table schemas — the same one the Durable Object stores for runtime drift detection. Exposed for custom tooling; `checkSchemaEvolution` calls it for you. It derives from zod's JSON Schema emission, so a zod upgrade can shift it with no semantic change (the rare false positive — delete the snapshot file to re-baseline); non-zod standard-schema tables are opaque and never trigger drift.

### SchemaSnapshot

`{ version: number; fingerprint: string }`

What `checkSchemaEvolution` stores in — and returns from — its snapshot file.
