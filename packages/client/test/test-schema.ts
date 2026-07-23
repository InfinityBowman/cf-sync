import { defineSchema } from '@cf-sync/protocol'
import { z } from 'zod'

/** Loose row schemas: client behavior tests write arbitrary shapes. */
export const testSchema = defineSchema({
  todos: z.record(z.string(), z.unknown()),
  notes: z.record(z.string(), z.unknown()),
})
