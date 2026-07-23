import { crudMutators, defineApp, defineSchema } from '@cf-sync/protocol'
import { z } from 'zod'

/** Loose row schemas: client behavior tests write arbitrary shapes. */
export const testSchema = defineSchema({
  todos: z.record(z.string(), z.unknown()),
  notes: z.record(z.string(), z.unknown()),
})

/** The default app client tests construct SyncClient with (version 'test-1'). */
export const testApp = defineApp({
  version: 'test-1',
  schema: testSchema,
  mutators: crudMutators(testSchema),
})

/** An app identical to testApp except for its version (mismatch tests). */
export function testAppAt(version: string) {
  return defineApp({ version, schema: testSchema, mutators: crudMutators(testSchema) })
}
