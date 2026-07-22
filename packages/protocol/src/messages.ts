import { z } from 'zod'

export const PROTOCOL_VERSION = 1

/**
 * Hibernated DO WebSockets can fail on frames just under 1MB (empirical, see
 * DESIGN.md D9), so all frames stay at or below this budget.
 */
export const MAX_FRAME_BYTES = 900_000
/** Patch-op budget per pokePart, leaving headroom for the message envelope. */
export const MAX_PART_PATCH_BYTES = 850_000
/** A single row must fit inside a frame with room to spare. */
export const MAX_ROW_BYTES = 700_000

export const cursorSchema = z.object({
  backendId: z.string().min(1),
  version: z.number().int().nonnegative(),
})
export type Cursor = z.infer<typeof cursorSchema>

export function cursorEquals(a: Cursor | null, b: Cursor | null): boolean {
  if (a === null || b === null) return a === b
  return a.backendId === b.backendId && a.version === b.version
}

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------

export const mutationSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  args: z.unknown(),
})
export type Mutation = z.infer<typeof mutationSchema>

export const helloMsgSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int(),
  schemaVersion: z.string().min(1),
  cursor: cursorSchema.nullable(),
})
export type HelloMsg = z.infer<typeof helloMsgSchema>

export const pushMsgSchema = z.object({
  type: z.literal('push'),
  mutations: z.array(mutationSchema).min(1),
})
export type PushMsg = z.infer<typeof pushMsgSchema>

export const clientMsgSchema = z.discriminatedUnion('type', [helloMsgSchema, pushMsgSchema])
export type ClientMsg = z.infer<typeof clientMsgSchema>

// ---------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------

export const patchOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('put'),
    tbl: z.string().min(1),
    id: z.string().min(1),
    value: z.record(z.string(), z.unknown()),
  }),
  z.object({ op: z.literal('del'), tbl: z.string().min(1), id: z.string().min(1) }),
  z.object({ op: z.literal('clear') }),
])
export type PatchOp = z.infer<typeof patchOpSchema>

export const mutationResultSchema = z.object({
  id: z.number().int().positive(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})
export type MutationResult = z.infer<typeof mutationResultSchema>

export const pokeStartMsgSchema = z.object({
  type: z.literal('pokeStart'),
  pokeId: z.string().min(1),
  baseCursor: cursorSchema.nullable(),
})
export type PokeStartMsg = z.infer<typeof pokeStartMsgSchema>

export const pokePartMsgSchema = z.object({
  type: z.literal('pokePart'),
  pokeId: z.string().min(1),
  patch: z.array(patchOpSchema),
  /** Patch ops still to come after this part — bootstrap progress reporting. */
  remaining: z.number().int().nonnegative().optional(),
  lastMutationIdChanges: z.record(z.string(), z.number().int().nonnegative()).optional(),
  mutationResults: z.array(mutationResultSchema).optional(),
})
export type PokePartMsg = z.infer<typeof pokePartMsgSchema>

export const pageInfoSchema = z.union([
  z.object({ more: z.literal(false) }),
  z.object({ more: z.literal(true), remaining: z.number().int().nonnegative() }),
])
export type PageInfo = z.infer<typeof pageInfoSchema>

export const pokeEndMsgSchema = z.object({
  type: z.literal('pokeEnd'),
  pokeId: z.string().min(1),
  cursor: cursorSchema,
  pageInfo: pageInfoSchema,
})
export type PokeEndMsg = z.infer<typeof pokeEndMsgSchema>

export const errorCodeSchema = z.enum([
  'VersionNotSupported',
  'CursorInvalid',
  'BadMessage',
  'PushInvalid',
  'Unauthorized',
  'Internal',
])
export type ErrorCode = z.infer<typeof errorCodeSchema>

export const errorMsgSchema = z.object({
  type: z.literal('error'),
  code: errorCodeSchema,
  message: z.string().optional(),
})
export type ErrorMsg = z.infer<typeof errorMsgSchema>

export const serverMsgSchema = z.discriminatedUnion('type', [
  pokeStartMsgSchema,
  pokePartMsgSchema,
  pokeEndMsgSchema,
  errorMsgSchema,
])
export type ServerMsg = z.infer<typeof serverMsgSchema>
