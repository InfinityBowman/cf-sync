# @cf-sync/yjs

Collaborative text for [cf-sync](https://github.com/InfinityBowman/cf-sync-engine): Yjs fields that live in the **same Workspace Durable Object** as your rows — one storage authority, one socket, one export/import surface. Rows stay last-write-wins; only the fields that genuinely need character-level merging pay for a CRDT.

`yjs` is a peer dependency; the cf-sync core stays yjs-free.

```sh
npm install @cf-sync/yjs yjs
```

```ts
// worker — register the engine extension
import { createWorkspaceDO } from '@cf-sync/server'
import { yjsFields } from '@cf-sync/yjs/server'

export const WorkspaceDO = createWorkspaceDO({ app, extensions: [yjsFields()] })
```

```ts
// browser — attach to the SyncClient, get per-field handles
import { createYjsFields } from '@cf-sync/yjs/client'

const fields = createYjsFields(client)
const handle = fields.getDoc(`todo-notes:${todoId}`)
await handle.whenSynced
handle.text            // Y.Text — bind it to a textarea, y-codemirror, y-prosemirror…
handle.canWrite        // reactive: readers render read-only from first paint
fields.release(handle) // ref-counted
```

Field ids are an app convention; the engine never interprets them. Updates travel on a binary lane over the existing sync socket, and offline edits merge on resume instead of overwriting.

**Docs:** [Collaborative text](https://github.com/InfinityBowman/cf-sync-engine/blob/main/docs/guide/collaborative-text.md) · [demo `NotesField.tsx`](https://github.com/InfinityBowman/cf-sync-engine/blob/main/apps/demo/src/NotesField.tsx) · [Repository](https://github.com/InfinityBowman/cf-sync-engine)

MIT
