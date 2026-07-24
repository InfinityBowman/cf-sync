# cf-sync demo

A todo app exercising every plane of the sync engine — rows, intent
mutations (including a visible server rejection), presence, and Tier 2
collaborative text — in ~600 lines you can read top to bottom.

## Run it

```sh
pnpm dev:worker   # wrangler dev on :8787 (the Workspace DO)
pnpm dev:web      # vite on :5173, in a second terminal
```

Open http://localhost:5173 in **two tabs**. To ship it: `pnpm run deploy`
(builds the web UI and deploys the worker serving it; same-origin socket).

## What to try

- **Rows**: add/complete/delete todos in one tab, watch the other. Go
  offline (devtools), mutate, reload — the IndexedDB mirror hydrates
  instantly and the outbox replays on reconnect.
- **Intent mutation**: "Clear completed" runs one named mutator on the
  server — concurrent clicks can't resurrect rows, and the local overlay
  applies (and rolls back) atomically.
- **Server rejection**: complete a todo, then click its priority dot. The
  optimistic change applies instantly; the server's rule (guarded by
  `ctx.authoritative`, so it runs only on the authoritative apply) rejects
  it, the overlay rolls back, and the banner shows the `AppError` — the
  whole permanent-error path, visible in one click.
- **Migration**: every todo carries a priority dot. `priority` arrived in
  schema v2; rows written under v1 were backfilled to `normal` by the
  migration in `src/schema.ts`, new rows get the zod default.
- **Presence**: move the mouse (live cursors), focus a notes box — the
  other tab shows who's typing where. Ephemeral: nothing stored.
- **Yjs field**: open the same todo's `notes ▸` in both tabs and type in
  both at once — characters merge instead of last-write-wins. Kill the
  network mid-sentence; edits merge on resume.
- **Workspaces**: `#team-a` in the URL hash is its own isolated Durable
  Object with its own storage, sockets, and fields.

## File tour

| File | What it demonstrates |
| --- | --- |
| `src/schema.ts` | `defineApp`: one object carrying schema, mutators, presence shape, version + migration chain — imported by **both** bundles so they can't disagree |
| `src/sync.ts` | `SyncClient` construction (persist, initialPresence), `createCollections`, `createYjsFields`, `onMutationRejected` feeding the banner store |
| `src/App.tsx` | Typed collections + live queries, `mutate.*` intents, `useSyncStatus`, `usePresence`, cursor overlay, rejection banner |
| `src/NotesField.tsx` | The reference field integration: `getDoc`/`release` ref-counting, `whenSynced`, reactive `canWrite`, a minimal Y.Text↔textarea binding, field-level presence |
| `worker/worker.ts` | `createWorkspaceDO` + `yjsFields()` extension, sync/admin routers, R2 log export, bearer-token admin auth |

## Notes on the field integration

Field ids are an app convention (`todo-notes:<todoId>`); the engine never
interprets them. The textarea binding is a deliberate minimum — production
editors hand `handle.text`/`handle.doc` to y-codemirror or y-prosemirror.
Deleting a todo leaves its field behind by design (the engine can't see the
app's row→field pointer convention); an app that wants them collected
deletes fields through the same admin surface that can export/import them.

Write access defaults to "any member". To gate per field, stamp context in
the sync router's `authorize` and give the extension a predicate over
`{ fieldId, auth, principal, clientId }` — see the comment in
`worker/worker.ts`.

## Admin surface

Set a token once (`wrangler secret put ADMIN_TOKEN`), then:

```sh
curl -H "Authorization: Bearer $TOKEN" https://<worker>/admin/demo/stats
curl -H "Authorization: Bearer $TOKEN" https://<worker>/admin/demo/export   # rows + fields
```

Stats include the extension's gauges (field count, frozen fields, pending
update rows, cached docs). Export/import round-trips fields alongside rows;
an import carrying fields cycles live sockets so both planes rebuild
consistently.
