import { z } from 'zod'

/**
 * Thrown by mutators to reject a mutation permanently. The engine still
 * advances the client's last_mutation_id (DESIGN.md §6 invariant 2) and
 * reports the error back via mutationResults. Any other thrown error is
 * treated as transient: the transaction rolls back and the client retries.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export interface MutatorContext {
  clientId: string
}

/**
 * The authoritative view a mutator runs against. Reads see the mutation's own
 * buffered writes; writes are flushed to SQLite only if the mutator completes
 * without error.
 */
export interface MutatorTx {
  get(tbl: string, id: string): Record<string, unknown> | null
  list(tbl: string): Array<{ id: string; data: Record<string, unknown> }>
  put(tbl: string, id: string, data: Record<string, unknown>): void
  del(tbl: string, id: string): void
}

export type Mutator = (tx: MutatorTx, args: unknown, ctx: MutatorContext) => void

const crudTarget = {
  tbl: z.string().min(1),
  id: z.string().min(1),
}
const putArgsSchema = z.object({ ...crudTarget, data: z.record(z.string(), z.unknown()) })
const delArgsSchema = z.object(crudTarget)

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args)
  if (!parsed.success) throw new AppError('InvalidArgs', parsed.error.message)
  return parsed.data
}

/**
 * Full-row last-write-wins CRUD as degenerate "intent" mutators (DESIGN.md §7).
 * Apps spread these into their registry and add real intent-based mutators
 * (e.g. `issue.move`) alongside.
 */
export const crudMutators: Record<string, Mutator> = {
  'sync.put': (tx, args) => {
    const { tbl, id, data } = parseArgs(putArgsSchema, args)
    tx.put(tbl, id, data)
  },
  'sync.del': (tx, args) => {
    const { tbl, id } = parseArgs(delArgsSchema, args)
    tx.del(tbl, id)
  },
}
