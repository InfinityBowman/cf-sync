import { crudMutators, defineApp, defineMutators, defineSchema, type RowOf } from '@cf-sync/protocol'
import { z } from 'zod'

const schema = defineSchema({
  todos: z.object({
    id: z.string(),
    title: z.string(),
    completed: z.boolean(),
    createdAt: z.string(),
    /** Added in demo-2; existing rows got 'normal' via the migration below. */
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
  }),
})

const mutators = defineMutators(schema, {
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

// One definition drives everything: server-side row validation, mutator arg
// validation, collection row types, typed client.mutate calls, and the
// schema-version rollout. Bumping `version` without adding a migration step
// fails at startup — in both bundles — instead of silently skewing.
export const app = defineApp({
  version: 'demo-2',
  schema,
  mutators,
  migrations: [
    // demo-1 -> demo-2: todos gain a priority field. Replays once per
    // workspace, atomically, on the first wake after deploy; old clients are
    // rejected at hello and reload into the new bundle.
    {
      from: 'demo-1',
      to: 'demo-2',
      migrate: (tx) => {
        for (const { id, data } of tx.list('todos')) {
          tx.put('todos', id, { priority: 'normal', ...data })
        }
      },
    },
  ],
})

export type Todo = RowOf<typeof schema, 'todos'>
