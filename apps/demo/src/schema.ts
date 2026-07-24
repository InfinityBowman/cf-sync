import { AppError, defineApp, defineMutators, defineSchema, type RowOf } from '@cf-sync/protocol'
import { z } from 'zod'

const schema = defineSchema({
  todos: z.object({
    id: z.string(),
    title: z.string(),
    completed: z.boolean(),
    createdAt: z.string(),
    /** Added in version 2; existing rows got 'normal' via the migration below. */
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
  }),
})

// Intent-based mutators; the full-row CRUD pair (sync.put / sync.del) that
// collections emit is included by defineApp automatically.
const mutators = defineMutators(schema, {
  // The server scans authoritatively, so two clients clicking
  // "clear completed" concurrently can't resurrect rows.
  'todos.clearCompleted': {
    apply: (tx) => {
      for (const { id, data } of tx.list('todos')) {
        if (data.completed) tx.del('todos', id)
      }
    },
  },
  'todos.setPriority': {
    args: z.object({ id: z.string(), priority: z.enum(['low', 'normal', 'high']) }),
    apply: (tx, { id, priority }, ctx) => {
      const todo = tx.get('todos', id)
      if (!todo) throw new AppError('NotFound', `todo ${id} does not exist`)
      // Guarded by `ctx.authoritative`: the optimistic run applies, then the
      // server's AppError rolls the overlay back and surfaces through
      // onMutationRejected — click a completed todo's priority dot to watch
      // the whole permanent-error path. A real app would usually check on
      // both runs for fail-fast UX; this one wants the round trip visible.
      if (ctx.authoritative && todo.completed) {
        throw new AppError('CompletedLocked', 'completed todos cannot be reprioritized')
      }
      tx.put('todos', id, { ...todo, priority })
    },
  },
})

// One definition drives everything: server-side row validation, mutator arg
// validation, collection row types, typed client.mutate calls, and the
// schema-version rollout. Bumping `version` without a matching migrations
// entry fails at startup — in both bundles — instead of silently skewing.
export const app = defineApp({
  version: 3,
  schema,
  mutators,
  // Ephemeral peer state (who's here, live cursors) relayed over the sync
  // socket — never persisted. The payload shape is app-defined; the server
  // validates every state against this before relaying. Changing this shape
  // needs NO version bump (presence drift only warns softly) — prefer
  // additive/optional changes, like `cursor?` here. Cursor coordinates are
  // relative to the centered <main> column, so they line up across
  // differently-sized windows.
  presence: z.object({
    name: z.string(),
    cursor: z.object({ x: z.number(), y: z.number() }).optional(),
    /**
     * Which notes field this peer has focused (`todo-notes:<id>`), if any —
     * field-level "who's editing" comes from presence (§16), while the text
     * itself merges through the Yjs field (§17). Added later, additively:
     * exactly the kind of presence change that needs no version bump.
     */
    editing: z.string().optional(),
  }),
  migrations: {
    // 1 -> 2: todos gain a priority field. Replays once per workspace,
    // atomically, on the first wake after deploy; old clients are rejected
    // at hello and reload into the new bundle. (Use `null` instead of a
    // function for additive changes that need no row rewrite.)
    2: (tx) => {
      for (const { id, data } of tx.list('todos')) {
        tx.put('todos', id, { priority: 'normal', ...data })
      }
    },
    // 2 -> 3: shipped alongside adding presence, before presence changes
    // were exempted from version bumps. Harmless history; kept because a
    // deployed version can never roll back.
    3: null,
  },
})

export type Todo = RowOf<typeof schema, 'todos'>
