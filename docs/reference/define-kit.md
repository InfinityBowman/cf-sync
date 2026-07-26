# defineApp & the definition kit

The shared app-definition kit from `@cf-sync/protocol` — the one package importable from both the worker and the browser. `defineSchema` declares the tables, `defineMutators` declares the named mutations, and `defineApp` bundles them with a version and migration chain into the single value both [`createWorkspaceDO`](/reference/server) and [`SyncClient`](/reference/sync-client#app) take — so "client and server disagree about the schema or mutators" is unrepresentable.

```ts
import { defineApp, defineSchema, defineMutators, AppError } from '@cf-sync/protocol'
import { z } from 'zod'

const schema = defineSchema({
  issues: z.object({ id: z.string(), title: z.string(), column: z.string().default('backlog') }),
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

## Functions

### defineApp

`(config) => AppDefinition`

The anchor of the kit. `config` takes:

| Field | Type | Notes |
|---|---|---|
| `version` | `number` · **required** | Current schema version — a positive integer, start at 1 |
| `schema` | `SyncSchema` · **required** | The `defineSchema` result |
| `mutators` | mutator registry | Omissible for a pure-CRUD app; required non-empty with `crud: false` |
| `migrations` | `{ [toVersion]: fn \| null }` | The chain that carries old workspaces forward |
| `presence` | standard schema | Enables the typed [presence surface](/guide/presence) |
| `crud` | `boolean` · default `true` | `false` drops the built-in `sync.put`/`sync.del` pair |

Validation happens at definition time, so a bad chain fails at startup in both bundles — not silently at data-touch time. `version` must be a positive integer. `migrations` keys must be integers ≥ 2, none beyond `version`, consecutive (each entry's key is the previous key + 1), and the chain must end exactly at `version` — bumping the version without declaring what happens to existing data throws immediately. Entries below the versions still in the field may be dropped; a workspace stored below the oldest declared entry re-raises the error at wake instead of restamping data it cannot interpret. See [Schema evolution](/guide/schema-evolution).

`mutators` takes a registry built by [`defineMutators`](#definemutators) or the definitions written inline — both infer identically (each `apply`'s `tx` and `args` type from the schema and the sibling `args` schema). `defineMutators` is only *required* when declaring an `authContext`, its third argument.

Unless `crud: false`, the [`crudMutators`](#crudmutators) pair is spread into the registry first — your entries win on a name collision, so a hand-rolled `sync.put` overrides the built-in rather than duplicating it. `crud: false` with no mutators throws (it declares an app nothing can write to), and [collections](/reference/collections) refuse to attach to a `crud: false` app — every write must go through a named mutator. The `authContext` schema declared with `defineMutators` is lifted onto the definition here, so the server can validate authorize verdicts at connect and the client can fail-fast-validate its `authContext` option.

The `presence` schema, unlike table schemas, needs **no** version bump when it changes — presence is never stored, so drift between deploy bundles only warns softly. It must parse its own output (plain object schemas, no `transform`s): `presence.update` merges partials into the previously *parsed* state and re-validates, so output that fails input validation breaks the merge — enforced with a descriptive throw at the first `set`/`initialPresence`.

### defineSchema

`(tables: Record<string, TableSchema>) => SyncSchema`

Declares the synced tables and their row schemas — the single source of truth shared by server and client. Each value is a standard schema whose input and output are plain records (a zod `z.object(...)` is the expected shape). Everything typed derives from it: collection row types, `MutatorTx` reads and writes, server-side row validation.

Table names must match `TABLE_NAME_RE` — identifier-like, a letter or underscore followed by up to 63 letters, digits, or underscores — and `defineSchema` throws at definition time on anything else. Row ids are capped at `MAX_ID_LENGTH` (256 UTF-16 code units); an id that is empty, over the cap, or contains a NUL makes any `tx` operation targeting it reject permanently with `InvalidArgs`.

The server validates **every** row write against the table's schema before it commits — a client can never write a shape the schema doesn't allow, no matter what it sends. Defaults apply on insert: `tx.put` takes the schema's *input* shape (defaults omissible) and stores the validated *output*. Validation must be synchronous — mutations apply inside a synchronous SQLite transaction, so a schema whose validate returns a Promise (a zod async refinement) is rejected at validation time as a permanent error.

### defineMutators

`(schema, defs, options?) => defs`

Declares the named, intent-based mutations for a schema — shared by the server (authoritative apply) and the client (typed `mutate`, fail-fast validation). Each entry is a `MutatorDef`:

- `args` — optional standard schema for the mutation's arguments. The server validates before `apply` runs (invalid args are a permanent `InvalidArgs` error that still advances the LMID); a SyncClient built with the same registry validates at `mutate()` time as a fail-fast. Omit for mutators that take no args.
- `apply(tx, args, ctx)` — the mutation itself, against a [`MutatorTx`](#mutatortx) with a [`MutatorContext`](#mutatorcontext). The same function runs twice — optimistically on the client the moment `mutate` is called, authoritatively on the server when the push arrives — so it must be deterministic: pass ids, timestamps, and random values in as args, never compute them inside, or the server's result will not match the local prediction. See [the two authoring rules](/guide/defining-your-app#the-two-authoring-rules).

Names are validated at definition time: non-empty, no empty dot-segments, and — because dots namespace the `client.mutate` call tree (`mutate.todos.clearCompleted`) — a name cannot be both a mutator and a namespace prefix of another (`todos` alongside `todos.clear` throws).

The optional third argument, `{ authContext: schema }`, declares the shape of `ctx.auth` — the connection-time context the worker's `authorize` hook stamps on each socket. Mutators are its consumer, so it is declared with them; the server validates each verdict's context against it at connect, so drift between authorize and mutators fails the upgrade with 4401 instead of surfacing mid-mutation. See [Auth & sessions](/guide/auth).

### crudMutators

`(schema) => CrudMutators<S>`

The full-row last-write-wins pair — `sync.put` and `sync.del`, the mutations [collections](/reference/collections) emit for local `insert`/`update`/`delete`. `defineApp` includes them automatically (opt out with `crud: false`); calling this directly is only needed for hand-assembled registries. Typed against the schema — `sync.put` args are a union over the declared tables, so direct `mutate.sync.put(...)` calls type-check per table — and row payloads are validated by the engine's `put` like any other write.

## The mutator runtime

### MutatorTx

The authoritative view a mutator runs against, typed from the schema:

- `get(tbl, id)` — the stored row (output shape, defaults applied) or `null`.
- `list(tbl)` — every row as `{ id, data }`.
- `put(tbl, id, data)` — writes the input shape, stores the validated output.
- `del(tbl, id)` — removes the row.

Reads see the mutation's own buffered writes; writes flush to SQLite only if the mutator completes without error, and they commit in the same transaction as the client's `last_mutation_id` advance — the mutation's effects and its bookkeeping are atomic, which is the engine's core invariant. `get`/`list`/`del` accept unknown tables at runtime so [migrations](#migrations) can read and clean up tables that left the schema — only `put` is strict.

### MutatorContext

The third argument every `apply` receives — how a mutator tells its two runs apart:

- `clientId` — the stable id of the pushing client: the SyncClient's own id in optimistic runs, the socket's attested id on the server, so both runs of one mutation see the same value.
- `principal` — the identity the worker's `authorize` hook stamped on the connection; `undefined` when no hook stamped one, and always `undefined` in optimistic runs (the client has no server verdict).
- `auth` — the verdict's context, validated against the `authContext` schema at connect; on the client, the value passed as the SyncClient [`auth`](/reference/sync-client#auth) option.
- `authoritative` — `true` on the server's run, `false` optimistically. Permission checks written as `if (ctx.authoritative && !allowed) throw` enforce on the server while letting the optimistic apply proceed; a server rejection rolls back through the normal permanent-error path.

### AppError

`new AppError(code: string, message: string)`

Thrown by mutators to reject a mutation **permanently**: the engine discards the mutation's writes but still advances the client's `last_mutation_id` in the same transaction — a permanently rejected mutation is *done*, never retried, never blocking the queue behind it — and the rejection surfaces on the client as a [`MutationError`](/reference/sync-client#mutationerror) carrying this `code`, with the optimistic effect rolled back. Any **other** thrown error is treated as transient: the transaction rolls back, nothing advances, and the client retries — so reserve plain `Error` for genuine bugs, never business rules.

`code` is app-defined (`NotFound`, `ReadOnly`, …); the `EngineErrorCode` values — `InvalidArgs`, `UnknownMutator`, `RowTooLarge` — are reserved for the engine's own rejections, all equally permanent.

## Migrations

`SchemaMigrationFn` is `(tx: MigrationTx) => void` — one entry in `defineApp`'s `migrations` record, rewriting rows stored under version `to - 1` into the shape expected at `to`. `null` marks a purely additive change: the stored version is restamped with no data rewrite, and existing cursors stay valid. `defineApp` normalizes the record into an ascending `SchemaMigration[]` (`{ to, migrate }`) on the definition.

`MigrationTx` is deliberately untyped by the current schema: a migration reads rows in their **old** shape (and may touch tables that have since left the schema), so the current row types would be lies. Reads come back as `Record<string, unknown>` — narrow what you touch — rather than `any`, so a typo'd field access still fails to compile. Writes are shape-free here; the *net result* of the whole chain is validated against the current schema at commit.

When a workspace wakes behind the current version, all pending steps replay against one write buffer inside one transaction: later steps read earlier steps' writes, everything commits atomically at a single new data version, and the *net result* of the chain is validated against the current schema at commit — intermediate shapes are transient, so shipped steps never need editing when a later version reshapes the same table. The full rollout story, including what clients experience during a deploy, is in [Schema evolution](/guide/schema-evolution).

## Limits

| Constant | Value | On violation |
|---|---|---|
| `MAX_ROW_BYTES` | 700,000 bytes of JSON per row | permanent `RowTooLarge` rejection (400 via the admin API) |
| `MAX_PRESENCE_BYTES` | 8,192 bytes per presence state | error frame — never truncated or coerced |
| `MAX_ID_LENGTH` | 256 UTF-16 code units per row id | permanent `InvalidArgs` rejection |
| `TABLE_NAME_RE` | `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/` | `defineSchema` throws at definition time |

The row cap exists so a single row always fits a WebSocket frame with room to spare; presence payloads are cursor-cadence ephemera, not documents.

## Types

Helper types exported for building on the kit — most apps never name them, but they are the seams for generic code:

- `RowOf<S, K>` — a table's stored row shape (schema output, defaults applied).
- `RowInputOf<S, K>` — a table's writable row shape (schema input, defaults omissible).
- `TableName<S>` — the union of a schema's table names as string literals.
- `AuthContextOf<M>` — the validated auth-context type a registry declares; `unknown` when none.
- `PresenceOf<A>` — an app's presence payload type; `never` when no presence schema is declared.
- `PresencePeer<T>` — one peer as apps consume it: `{ clientId, principal?, state, receivedAt }`, identity server-attested.
- `EngineErrorCode` — `'InvalidArgs' | 'UnknownMutator' | 'RowTooLarge'`, the reserved rejection codes.
- `MutationArgs<Def>` — the argument tuple `mutate` accepts for one mutator definition.
- `AnySyncSchema` / `AnyMutators` — the bounds to constrain on when writing your own generics over a schema or registry (concrete results are assignable to these, not to the parameterized types).
- `AUTH_CONTEXT` — the symbol `defineMutators` stamps a registry's `authContext` schema under. Root-exported only so a package that re-exports its registry with declaration emit on can name the inferred type; read the context type through `AuthContextOf`, never the symbol.
