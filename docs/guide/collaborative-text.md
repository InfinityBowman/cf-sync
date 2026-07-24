# Collaborative text

Row sync is last-write-wins on purpose — character-level merging never flows through the mutation log. But some fields genuinely need it: two people typing in the same notes box should merge, not clobber. For those fields, the `@cf-sync/yjs` add-on gives you **Yjs documents that live in the same Workspace Durable Object** as your rows.

Same storage authority, same socket, same export/import surface. `yjs` is a peer dependency of the add-on; the cf-sync core stays yjs-free — apps that don't need collaborative text never ship a CRDT.

## When to reach for this

Use a Yjs field when concurrent *in-field* editing is an expected workflow (notes, descriptions, documents). Don't use it for titles, statuses, or anything a form submits atomically — LWW rows with intent mutators are simpler, cheaper, and easier to reason about. The demo's rule of thumb: rows by default, a field only where merging has proven necessary.

## Server: register the extension

```ts
import { createWorkspaceDO } from '@cf-sync/server'
import { yjsFields } from '@cf-sync/yjs/server'

export const WorkspaceDO = createWorkspaceDO({
  app,
  extensions: [yjsFields()],
})
```

Field updates travel on a binary lane over the existing sync socket and persist in the DO's SQLite alongside your rows.

## Client: field handles

```ts
import { createYjsFields } from '@cf-sync/yjs/client'

const fields = createYjsFields(client)

const handle = fields.getDoc(`todo-notes:${todoId}`)
await handle.whenSynced          // resolves once the server state has landed
handle.text                      // a Y.Text — bind it to your editor
handle.doc                       // the underlying Y.Doc, for richer bindings
handle.canWrite                  // reactive — readers render read-only from first paint
fields.release(handle)           // handles are ref-counted; release on unmount
```

`handle.text` plugs directly into the Yjs editor ecosystem — y-codemirror, y-prosemirror, or a minimal textarea binding like the demo's [`NotesField.tsx`](https://github.com/InfinityBowman/cf-sync-engine/blob/main/apps/demo/src/NotesField.tsx). Offline edits merge on resume instead of overwriting — that's the CRDT earning its keep.

## Field ids are your convention

The engine never interprets field ids. `todo-notes:<todoId>` is an app convention linking a field to a row — which also means **deleting a row does not delete its field** (the engine can't see your pointer convention). An app that wants orphaned fields collected deletes them through the same [admin surface](/guide/operations) that exports and imports them.

## Write access

Write access defaults to "any workspace member". To gate per field, stamp what you need in the sync router's [`authorize` hook](/guide/auth) and give the extension a predicate:

```ts
yjsFields({
  canWrite: ({ fieldId, auth, principal, clientId }) => {
    return auth?.role !== 'viewer'
  },
})
```

Readers aren't second-class: the sync state carries the writable flag, so `handle.canWrite` is correct from first paint — no flash of editable UI before a rejection.

## Presence for fields

"X is editing this field" is ordinary [presence](/guide/presence) — put a `focusedField` in your presence schema and render it next to the field. The demo wires this end to end.

## Operations

The [admin surface](/guide/operations) is fields-aware: `stats` includes the extension's gauges (field count, frozen fields, pending updates, cached docs), and `export`/`import` round-trip fields alongside rows. An import carrying fields cycles live sockets so both planes rebuild consistently.
