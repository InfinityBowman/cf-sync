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

/**
 * Keepalive frames. The server registers this exact pair with
 * setWebSocketAutoResponse, so the runtime answers pings without waking the
 * DO; the client sends pings to keep idle edge connections alive and detect
 * half-open sockets. These are raw frames outside the message schemas — the
 * DO never sees them — and the strings must match byte-for-byte on both
 * sides, which is why they live here.
 */
export const KEEPALIVE_PING = '{"type":"ping"}'
export const KEEPALIVE_PONG = '{"type":"pong"}'

// ---------------------------------------------------------------------------
// close codes (DESIGN.md §15.2)
// ---------------------------------------------------------------------------

/**
 * Permanent-rejection band `[4400, 4499]`: the client stops reconnecting and
 * calls `onFatal` with the close `{code, reason}` attached. Reconnecting
 * cannot help — the server told this client to go away.
 */
export const CLOSE_PERMANENT_MIN = 4400
export const CLOSE_PERMANENT_MAX = 4499
/** Protocol or schema version mismatch — the designed recovery is loading the new bundle. */
export const CLOSE_VERSION_NOT_SUPPORTED = 4400
/**
 * The authorize verdict's context failed validation against the app's
 * `authContext` schema — authorize and mutators shipped disagreeing shapes.
 * An app configuration bug, surfaced at connect rather than mid-mutation.
 */
export const CLOSE_AUTH_CONTEXT_INVALID = 4401
/** Default structured rejection (`{ok: false}`) and default admin kick. */
export const CLOSE_UNAUTHORIZED = 4403
/**
 * A newer socket with the same clientId took over (DESIGN.md §15.3 supersede
 * rule). The closed socket is almost always a half-open zombie its client
 * already abandoned; a live client seeing this has two tabs sharing a
 * clientId, which the clientId contract forbids.
 */
export const CLOSE_SUPERSEDED = 4409
/**
 * Refresh: reconnect immediately so the worker re-runs `authorize` and the
 * connection carries fresh stamps. Not fatal, not backoff — expected during
 * normal operation (entitlement/role changes, expired stamps).
 */
export const CLOSE_REFRESH = 4300

export function isPermanentCloseCode(code: number): boolean {
  return code >= CLOSE_PERMANENT_MIN && code <= CLOSE_PERMANENT_MAX
}

/**
 * WebSocket close frames cap the reason at 123 bytes of UTF-8 (RFC 6455) and
 * the runtime throws beyond it. Reasons are meant to be short stable slugs;
 * this trims anything longer on a codepoint boundary so a verbose reason
 * degrades to a truncated close instead of an exception.
 */
export function truncateCloseReason(reason: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(reason).byteLength <= 123) return reason
  let out = ''
  let bytes = 0
  for (const ch of reason) {
    const n = encoder.encode(ch).byteLength
    if (bytes + n > 120) break
    out += ch
    bytes += n
  }
  return `${out}…` // the ellipsis is 3 bytes, keeping the total ≤ 123
}

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
  schemaVersion: z.number().int().positive(),
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
