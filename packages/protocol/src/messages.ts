import { z } from 'zod'

export const PROTOCOL_VERSION = 1

/**
 * Hibernated DO WebSockets can fail on frames just under 1MB (empirical, see
 * DESIGN.md D9), so all frames stay at or below this budget.
 */
export const MAX_FRAME_BYTES = 900_000
/** Patch-op budget per pokePart, leaving headroom for the message envelope. */
export const MAX_PART_PATCH_BYTES = 850_000
/**
 * The per-row byte cap: a row's JSON-serialized data may be at most 700,000
 * bytes, so a single row always fits inside a WebSocket frame with room to
 * spare. A `tx.put` that exceeds it rejects the mutation permanently with the
 * `RowTooLarge` engine error code; the admin write API rejects oversized rows
 * with a 400.
 */
export const MAX_ROW_BYTES = 700_000
// Presence design is DESIGN.md §16.2.
/**
 * The per-client presence-state byte cap (8 KiB of JSON) — presence payloads
 * are cursor-cadence ephemera, not documents. Oversized states are rejected
 * with an error frame — never truncated or coerced.
 */
export const MAX_PRESENCE_BYTES = 8_192

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
 * Lower bound (inclusive) of the permanent-rejection band `[4400, 4499]`: a
 * close in this band makes the client stop reconnecting and call `onFatal`
 * with the close `{code, reason}` attached. Reconnecting cannot help — the
 * server told this client to go away.
 */
export const CLOSE_PERMANENT_MIN = 4400
/** Upper bound (inclusive) of the permanent-rejection close-code band `[4400, 4499]`. */
export const CLOSE_PERMANENT_MAX = 4499
/** Protocol or schema version mismatch — the designed recovery is loading the new bundle. */
export const CLOSE_VERSION_NOT_SUPPORTED = 4400
/**
 * The authorize verdict's context failed validation against the app's
 * `authContext` schema — authorize and mutators shipped disagreeing shapes.
 * An app configuration bug, surfaced at connect rather than mid-mutation.
 */
export const CLOSE_AUTH_CONTEXT_INVALID = 4401
/**
 * The connection was rejected as unauthorized (4403). Sent when the worker's
 * `authorize` hook rejects a connection without naming its own close code,
 * and as the default code for an admin kick. In the permanent band, so the
 * client stops reconnecting and reports it through `onFatal`.
 */
export const CLOSE_UNAUTHORIZED = 4403
// The supersede rule is DESIGN.md §15.3.
/**
 * A newer socket with the same clientId took over — the server keeps exactly
 * one live socket per clientId and closes the older one. The closed socket is
 * almost always a half-open zombie its client already abandoned; a live
 * client seeing this has two tabs sharing a clientId, which the clientId
 * contract forbids.
 */
export const CLOSE_SUPERSEDED = 4409
/**
 * Refresh: reconnect immediately so the worker re-runs `authorize` and the
 * connection carries fresh stamps. Not fatal, not backoff — expected during
 * normal operation (entitlement/role changes, expired stamps).
 */
export const CLOSE_REFRESH = 4300

/**
 * Tests whether a WebSocket close code falls in the permanent-rejection band
 * `[4400, 4499]`. A permanent close means reconnecting cannot help: on seeing
 * one the client stops its reconnect loop and reports the close through
 * `onFatal` instead of backing off and retrying.
 */
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
/**
 * A client's position in a workspace's change history: which history
 * (`backendId`, minted when the workspace is created and again on admin
 * reset) and the data version reached within it (`version`). The client
 * presents its cursor on connect to resume incrementally; a cursor from a
 * different backendId or outside the retained version window triggers a
 * reset — `clear` plus a full snapshot — rather than an error.
 */
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

/**
 * The client's own presence state (DESIGN.md §16.2); null clears it. The
 * payload is opaque here — the server validates it against the app's
 * `presence` schema before relaying, and identity is never carried in the
 * message: the relay stamps `clientId`/`principal` from the socket attachment.
 */
export const presenceMsgSchema = z.object({
  type: z.literal('presence'),
  state: z.unknown(),
})
export type PresenceMsg = z.infer<typeof presenceMsgSchema>

export const clientMsgSchema = z.discriminatedUnion('type', [
  helloMsgSchema,
  pushMsgSchema,
  presenceMsgSchema,
])
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
/**
 * One row change carried by a poke: `put` upserts a row's full validated
 * value, `del` removes a row, and `clear` drops all local rows — the reset
 * that precedes a full snapshot when a client's cursor cannot be resumed.
 * Pokes carry ordered arrays of these; the client applies each poke's ops
 * atomically to local state.
 */
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

/**
 * A peer's presence changed: payload is client-claimed, identity is
 * server-attested — `clientId`/`principal` come from the socket attachment,
 * never from the sender's payload. `state: null` means the peer cleared its
 * presence or disconnected.
 */
export const presenceUpdateMsgSchema = z.object({
  type: z.literal('presence'),
  clientId: z.string().min(1),
  principal: z.string().optional(),
  state: z.unknown(),
})
export type PresenceUpdateMsg = z.infer<typeof presenceUpdateMsgSchema>

export const presencePeerSchema = z.object({
  clientId: z.string().min(1),
  principal: z.string().optional(),
  state: z.unknown(),
})

/**
 * Full peer snapshot, sent once right after hello completes. Doubles as the
 * client's "presence is live on this connection" signal: receipt triggers
 * re-announcement of its own state (DESIGN.md §16.4).
 */
export const presencePeersMsgSchema = z.object({
  type: z.literal('presencePeers'),
  peers: z.array(presencePeerSchema),
})
export type PresencePeersMsg = z.infer<typeof presencePeersMsgSchema>

/**
 * "Re-send your state": hibernation dropped the server's in-memory presence
 * map while the sockets survived; the map converges in one round-trip as
 * clients re-announce (DESIGN.md §16.3).
 */
export const presencePollMsgSchema = z.object({ type: z.literal('presencePoll') })
export type PresencePollMsg = z.infer<typeof presencePollMsgSchema>

export const errorCodeSchema = z.enum([
  'VersionNotSupported',
  'CursorInvalid',
  'BadMessage',
  'PushInvalid',
  'PresenceInvalid',
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
  presenceUpdateMsgSchema,
  presencePeersMsgSchema,
  presencePollMsgSchema,
  errorMsgSchema,
])
export type ServerMsg = z.infer<typeof serverMsgSchema>
