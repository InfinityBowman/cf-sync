import { crudMutators, defineMutators, defineSchema, type RowOf } from '@cf-sync/protocol'
import { z } from 'zod'

export const SCHEMA_VERSION = 'demo-2'

// One definition drives everything: server-side row validation, mutator arg
// validation, collection row types, and typed client.mutate calls.
export const schema = defineSchema({
  todos: z.object({
    id: z.string(),
    title: z.string(),
    completed: z.boolean(),
    createdAt: z.string(),
    /** Added in demo-2; existing rows got 'normal' via the migrateSchema hook. */
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
  }),
})

export const mutators = defineMutators(schema, {
  ...crudMutators(schema),
  // An intent-based mutator: the server scans authoritatively, so two
  // clients clicking "clear completed" concurrently can't resurrect rows.
  'todos.clearCompleted': {
    apply: (tx) => {
      for (const { id, data } of tx.list('todos')) {
        if (data.completed) tx.del('todos', id)
      }
    },
  },
})

export type Todo = RowOf<typeof schema, 'todos'>
