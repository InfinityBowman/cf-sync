import { defineApp, defineMutators, defineSchema, type RowOf } from '@cf-sync/protocol'
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
})

// One definition drives everything: server-side row validation, mutator arg
// validation, collection row types, typed client.mutate calls, and the
// schema-version rollout. Bumping `version` without a matching migrations
// entry fails at startup — in both bundles — instead of silently skewing.
export const app = defineApp({
  version: 2,
  schema,
  mutators,
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
  },
})

export type Todo = RowOf<typeof schema, 'todos'>
