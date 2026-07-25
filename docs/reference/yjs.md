# Yjs fields

The collaborative-text add-on from `@cf-sync/yjs` — per-field Y.Docs hosted inside the same Workspace Durable Object as your rows, synced over a binary lane on the existing socket. Three entry points, one per side: `./server` registers the extension on the DO, `./client` attaches field handles to a [`SyncClient`](/reference/sync-client), `./react` wraps a handle in a hook. `yjs` is a peer dependency of the add-on (react an optional one); the cf-sync core stays yjs-free. For the model and when to reach for it, see [Collaborative text](/guide/collaborative-text).

```ts
// worker
extension: yjsFields({ app, authorizeWrite: ({ auth }) => auth?.role !== 'viewer' })

// browser
const fields = createYjsFields(client)
const handle = fields.getDoc(`todo-notes:${todoId}`)
```

## Server — `@cf-sync/yjs/server`

### yjsFields

`(options?: YjsFieldsOptions) => () => EngineExtension`

The extension factory, passed to [`createWorkspaceDO`](/reference/server)'s `extension` option. It returns a factory rather than an extension: the DO calls it once per workspace instance, so the doc cache and per-socket refusal state are per-workspace by construction — Cloudflare colocates instances of one DO class in a shared isolate, and extension state must never cross workspaces. Storage is two SQLite tables in the workspace DO (snapshot per field plus an update log); the typing path appends and relays without ever materializing a document.

### authorizeWrite

`(ctx: YjsFieldWriteContext) => boolean` · default: any member writes

The per-field write gate. `ctx` is `{ fieldId, auth, principal, clientId }` — the target field plus the connection's identity as stamped by the sync router's [`authorize` hook](/guide/auth) (`auth` is the verdict's context, `undefined` when no hook stamped one). `fieldId` makes per-field policies expressible: encode the owning entity into your ids (`note:<noteId>`) and derive the check from there. A `false` verdict is not an error path — it sets `writable: false` in the sync reply so [`canWrite`](#yjsfieldhandle) is read-only from first paint, and an update that arrives anyway earns a `NotWritable` reject.

### app

`AppDefinition` · typing only

The same [app definition](/reference/define-kit#defineapp) the DO takes. Passing it closes the type loop: `authorizeWrite`'s `auth` derives from the `authContext` schema already declared in `defineMutators` — one declaration, flowing everywhere. Without an app value in scope, the explicit generic (`yjsFields<MyAuthContext>({ authorizeWrite })`) is the escape hatch.

### maxCachedDocs

`number` · default `8`

Y.Docs held in memory (LRU) — sync requests are served from here instead of rebuilding snapshot-plus-tail from SQLite. Fields cap at 700 000 bytes each, so the default bounds worst-case doc memory around ~6MB per workspace.

### compactionThreshold

`number` · default `200`

Pending update-log rows per field that trigger compaction — materialize, re-encode as one snapshot, delete the tail — on the DO's maintenance alarm. Lower means smaller logs and faster cold loads at the cost of more alarm work.

## Client — `@cf-sync/yjs/client`

### createYjsFields

`(client: YjsFieldsClient) => YjsFields`

Attaches the fields surface to a client. `YjsFieldsClient` is a structural interface satisfied by `SyncClient` (its `sendBinary`/`onBinary`/`subscribeStatus`/`onDestroy` [extension seam](/reference/sync-client#registertable--registerapplier--sendbinary--onbinary)) — the add-on is plain library code with no privileged access. The library owns transport and lifecycle: every connection that reaches `synced` re-syncs every held doc in one round-trip each way (edits typed offline merge on resume — apps write no reconnect glue), and `client.destroy()` tears the fields down too via `onDestroy`.

The returned `YjsFields` has two methods: `getDoc(fieldId)` returns a [`YjsFieldHandle`](#yjsfieldhandle) (fields are created implicitly on first use; ids must be 1–256 UTF-8 bytes or `getDoc` throws), and `destroy()` detaches from the client and destroys every held doc.

### YjsFieldHandle

A ref-counted live view of one field. Two call sites holding the same `fieldId` share one underlying doc; `release()` decrements, and at refcount zero local state is dropped and the doc destroyed. There is no local persistence — a reload re-fetches small documents in one round-trip, and an app that wants offline field durability attaches y-indexeddb to `doc` itself.

- `doc` — the underlying `Y.Doc`, for rich-text bindings (a `Y.XmlFragment` for y-prosemirror and the like); the app owns the key — one field is one shape, chosen once.
- `text` — the paved path: a `Y.Text` at a fixed, library-owned key, so every reader and writer of a field agrees on type and key with nothing to coordinate.
- `whenSynced` — resolves on the first server state and stays resolved. It answers "can I render this field", not "am I currently live" — liveness is the client's [`SyncStatus`](/reference/sync-client#syncstatus).
- `canWrite` — whether this client may write, reactively: the server's writable flag, flipped `false` by any reject. A reject-flipped `false` is **sticky for the handle's lifetime** — only this client knows its local doc holds an op the server refused, so a later state saying writable must not resume uploading (it would re-send the refused op forever). Starts `false` and is meaningful after `whenSynced` — never guessed, so readers get no flash of editable UI.
- `writeBlocked` — *why* `canWrite` is false, or `null` while writable (or pre-sync): `'NotWritable'` (no write access), `'Frozen'` (administratively frozen), `'TooLarge'` (the server refused an oversized update), `'LocalTooLarge'` (the client's own frame guard tripped before sending). Render the difference — "this document is full" and "you can't edit this" deserve different UI.
- `subscribe(listener)` — notifies on `canWrite`/`writeBlocked` or first-sync changes; returns an unsubscribe function.
- `release()` — drop this reference; idempotent.

A non-writable field never sends: local edits stay buffered in the doc, and the apply-then-reject path is designed out rather than handled.

### MAX_FIELD_UPDATE_BYTES

`number` · `200_000`

The transport's ceiling on a single field update frame — the server rejects anything larger with `TooLarge`, and the client's own frame guard refuses to send it first (the field collapses to read-only locally, with a console warning, before an in-flight tail can poison the server's log). It is re-exported here so editor bindings can guard input size — a textarea `maxLength`, a paste guard — against the same limit the transport enforces, without reaching into `@cf-sync/protocol/internal`. The guard in the editor is the paved fix; the frame guard is the backstop.

## React — `@cf-sync/yjs/react`

### useYjsField

`(fields: YjsFields, fieldId: string) => YjsFieldState`

The paved-path binding for one field: owns the whole handle lifecycle — acquire on mount, `release()` on unmount, re-acquire on `fieldId` change — plus the sync gate and reactive `canWrite`.

```tsx
const field = useYjsField(fields, `todo-notes:${todoId}`)
if (!field.synced) return <Spinner />
return <Editor text={field.text} readOnly={!field.canWrite} />
```

Re-renders happen on sync and permission changes only — **not** per keystroke. Deliberate: editor bindings (y-codemirror, y-prosemirror, a hand-rolled textarea observer) attach to `text`/`doc` and own content updates themselves, exactly as everywhere else in the Yjs ecosystem. StrictMode's double mount is safe (the second acquire re-fetches in one round-trip), and server rendering returns the unsynced state — matching the client's first paint, so hydration agrees. Switching `fieldId` snaps back to unsynced rather than leaking the previous field's content through one render.

### YjsFieldState

Discriminated on `synced`, so the loading state is impossible to forget:

```ts
type YjsFieldState =
  | { synced: false; handle: null; doc: null; text: null; canWrite: false; writeBlocked: null }
  | { synced: true; handle: YjsFieldHandle; doc: Y.Doc; text: Y.Text; canWrite: boolean; writeBlocked: WriteBlockedReason | null }
```

`writeBlocked` carries the [reason](#yjsfieldhandle) `canWrite` is false, so the read-only banner can say why.

## Field ids are an app convention

The engine never interprets field ids — `todo-notes:<todoId>` is your pointer, not its foreign key. Consequently **deleting a row does not delete its field**; an app that wants orphaned fields collected deletes them through the same [admin surface](/guide/operations) that exports and imports them.

## Operations

The [admin surface](/guide/operations) is fields-aware. `stats` includes the extension's gauges — `fields`, `frozenFields`, `fieldBytes`, `pendingUpdates`, `cachedDocs` — and `export`/`import` round-trip fields alongside rows: export compacts each field to one base64 snapshot, import validates every snapshot by applying it (a snapshot that cannot build a doc fails the whole import, not a future read) and replaces the field tables wholesale.
