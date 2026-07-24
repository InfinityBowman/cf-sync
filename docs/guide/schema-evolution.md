# Schema evolution

The rule is short: **every schema change requires a version bump, paired with a migration entry.** Additive changes too. The engine enforces this instead of trusting you to remember.

## Bumping the version

`version` is an integer starting at 1. When the schema changes, bump it and add a `migrations` entry keyed by the version it migrates *to*:

```ts
export const app = defineApp({
  version: 2,
  schema, // issues now also have `priority`
  mutators,
  migrations: {
    2: (tx) => {
      for (const { id, data } of tx.list('issues')) {
        tx.put('issues', id, { priority: 'normal', ...data })
      }
    },
    // an additive change that needs no data rewrite is an explicit null:
    // 3: null
  },
})
```

The chain is validated at startup, in both bundles: entries must be consecutive and end at `version`. Bumping the version without saying what happens to existing data is a **loud error at boot**, not silent skew at runtime.

## What happens on deploy

A workspace Durable Object can sleep through any number of deploys. On its first wake after one:

1. The DO replays the migration chain from its stored version to the current one, **atomically** — a workspace that slept from v1 to v5 replays 2, 3, 4, 5 in order.
2. The *net result* is validated against the current schema. A chain that produces invalid rows aborts instead of committing garbage.
3. Old clients are rejected at hello with `VersionNotSupported` and reload into the new bundle.
4. A stored version *outside* the chain (e.g. a rollback deploy) aborts initialization rather than restamping data it can't interpret.

## Why additive changes need a bump too

Two failure modes, both silent without the bump:

- Rows written before the change never gain the new field at runtime — your zod defaults apply on *write*, not on read, so old rows stay in the old shape indefinitely.
- During a deploy window, old and new bundles share the same workspace. An old bundle doing a full-row write (`sync.put`) can silently strip a field it doesn't know about.

A `null` entry (or a backfill `migrate` when the new field needs a value on old rows) closes both holes.

## Drift detection

This is enforced mechanically, not by convention — twice, at different distances from the mistake.

**In CI, before the deploy** (the one to actually rely on): add one test with `checkSchemaEvolution` from `@cf-sync/server/testing`, and a schema change without a version bump fails the build with the exact migrations entry to add:

```ts
it('every schema change ships with a version bump', async () => {
  await checkSchemaEvolution(app, new URL('./schema-snapshot.json', import.meta.url))
})
```

The snapshot file works like a jest snapshot — the first run scaffolds it, a legitimate version bump rewrites it automatically, and you commit it. It records the same structural fingerprint the engine uses, so the two layers can never disagree about what counts as a change. (Presence is deliberately excluded — reshaping it needs no bump.)

**At runtime, after the fact**: each workspace also stores that fingerprint next to its version. If a deploy slips through with changed schemas under an unbumped version, the DO logs a warning that names the same fix:

```
[cf-sync] table schemas changed under schema version 3 (fingerprint a41f… -> 9c02…).
Every schema change requires a version bump: set version: 4 in defineApp and add
migrations: { 4: ... } (a migrate function if existing rows need backfilling,
null if the change is additive)
```

The runtime layer only warns (the fingerprint derives from zod's JSON Schema emission, which a zod upgrade could shift with no semantic change — a heuristic gets to shout, never to brick a workspace). The CI layer can afford to be strict: a false positive there is one deleted snapshot file, not an outage.

Both layers read zod's JSON Schema emission, so **drift detection only covers zod tables**. A table defined with another Standard Schema vendor fingerprints as opaque — its drift is invisible — and rather than silently passing forever, `checkSchemaEvolution` refuses to run over such tables and says so. Non-zod schemas still work for everything else (typing, validation); they just don't get the tripwire.

## Testing migrations

Migrations are unit-testable in plain node with [`createTestEngine`](/guide/testing) — seed rows in their **old** shape at an old stored version, and the chain replays exactly as it would on the DO's first wake:

```ts
const engine = createTestEngine(app, {
  storedVersion: 1,
  rows: { issues: { i1: { id: 'i1', title: 'old', column: 'doing' } } },
})
expect(engine.get('issues', 'i1')?.priority).toBe('normal')
```

A chain that produces schema-invalid rows throws from `createTestEngine` itself — the same guarantee the DO gives you, in milliseconds.

## What never changes

Mutator names deployed under a schema version are never removed — a queued mutation from an old client must always find its mutator when it finally arrives. (Replicache documents the failure mode: stubbing missing mutators to no-ops silently loses effects. cf-sync refuses to have the problem.)

Presence schemas are the exception to all of this: presence is ephemeral, nothing is stored, so reshaping it needs **no version bump** — see [Presence](/guide/presence#evolving-the-presence-schema).
