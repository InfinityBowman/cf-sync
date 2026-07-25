import { truncateCloseReason } from '@cf-sync/protocol/internal'

/** Set by the worker routers so the DO can learn its own workspace id. */
export const WORKSPACE_HEADER = 'x-cf-sync-workspace'

// Stamp-forwarding design: ARCHITECTURE.md#session-control.
/**
 * Carries the authorize verdict's stamps from `createSyncFetch` to the DO.
 * The router strips any inbound value before setting its own, so it cannot
 * be spoofed from outside; the DO trusts whatever the router says, exactly
 * like `WORKSPACE_HEADER`.
 */
export const AUTH_HEADER = 'x-cf-sync-auth'

/** What the router serializes into `AUTH_HEADER` from an ok-verdict. */
export interface AuthStamps {
  principal?: string
  context?: unknown
  expiresAt?: number
}

/**
 * Serializes an authorize verdict's stamps into the value the router sets on
 * {@link AUTH_HEADER} — the counterpart of {@link decodeAuthStamps}, for
 * custom routers replacing `createSyncFetch`. Header values must be byte
 * strings, so the UTF-8 JSON is base64-encoded: principals and contexts with
 * any characters survive the hop.
 */
export function encodeAuthStamps(stamps: AuthStamps): string {
  const bytes = new TextEncoder().encode(JSON.stringify(stamps))
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin)
}

/**
 * Parses an {@link AUTH_HEADER} value back into the {@link AuthStamps} that
 * {@link encodeAuthStamps} serialized. The DO calls this at upgrade to read
 * the stamps the router forwarded; a custom router only needs it to inspect
 * its own header. Throws when the payload does not decode to an object.
 */
export function decodeAuthStamps(value: string): AuthStamps {
  const bin = atob(value)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('auth stamps must be an object')
  return parsed as AuthStamps
}

/**
 * Socket attachments cap at 2KB serialized (platform limit). The DO measures
 * the JSON size of the full attachment — clientId plus auth stamps — and
 * fails the upgrade loudly when it does not fit, rather than truncating.
 */
export const MAX_ATTACHMENT_BYTES = 2048

/**
 * Accept-then-close (ARCHITECTURE.md#session-control): a browser WebSocket cannot observe the
 * HTTP status of a failed upgrade — a 403 is indistinguishable from a network
 * error — so rejections complete the upgrade with a local pair and close it
 * with a policy code + reason the client can act on. The local pair initiates
 * the close itself, so the DO's close-reciprocation rule does not apply.
 */
export function rejectUpgrade(code: number, reason: string): Response {
  const pair = new WebSocketPair()
  pair[1].accept()
  pair[1].close(code, truncateCloseReason(reason))
  return new Response(null, { status: 101, webSocket: pair[0] })
}
