import type { Cursor } from '@cf-sync/protocol'
import {
  MAX_PART_PATCH_BYTES,
  OversizeItemError,
  type MutationResult,
  type PokeEndMsg,
  type PokeStartMsg,
} from '@cf-sync/protocol/internal'

/**
 * Poke frames assembled from row JSON as stored, never parsed and
 * re-serialized: a bootstrap is every live row, and a parse plus two
 * stringifies per row was most of what a large hello cost. Each op is its
 * JSON text, so a frame is a string join.
 */

/** A patch op already serialized as JSON text. */
export type OpJson = string

export const CLEAR_OP: OpJson = '{"op":"clear"}'

/**
 * SQL expressions over a `rows` row that produce its patch op as JSON text.
 * SQLite concatenates in one column per row, so a snapshot costs one string
 * per row crossing into JS; `data` is already the value's JSON text.
 */
export const PUT_OP_SQL = `'{"op":"put","tbl":' || json_quote(tbl) || ',"id":' || json_quote(id) || ',"value":' || data || '}'`
export const DEL_OP_SQL = `'{"op":"del","tbl":' || json_quote(tbl) || ',"id":' || json_quote(id) || '}'`

const NON_ASCII = /[^\u0000-\u007f]/

/** UTF-8 byte length of a string, without encoding it. */
export function utf8ByteLength(text: string): number {
  // Row JSON is overwhelmingly ASCII; the native scan is several times
  // faster than the loop below.
  if (!NON_ASCII.test(text)) return text.length
  let bytes = text.length
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) continue
    if (code < 0x800) bytes += 1
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A surrogate pair is two UTF-16 units and four UTF-8 bytes.
        bytes += 2
        i++
      } else bytes += 2 // a lone surrogate encodes as U+FFFD, three bytes
    } else bytes += 2
  }
  return bytes
}

/** A patch split into frame-sized parts, each the comma-joined JSON of its ops. */
export interface PatchParts {
  parts: string[]
  /** Ops in each part, for the `remaining` countdown. */
  counts: number[]
  total: number
}

/** Packs ops greedily under the per-part byte budget (ARCHITECTURE.md#connections-and-lifecycle). */
export function packPatch(ops: readonly OpJson[], maxBytes = MAX_PART_PATCH_BYTES): PatchParts {
  const parts: string[] = []
  const counts: number[] = []
  let current: OpJson[] = []
  let currentBytes = 0
  for (const op of ops) {
    const bytes = utf8ByteLength(op) + 1 // the joining comma
    if (bytes > maxBytes) throw new OversizeItemError(bytes, maxBytes)
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      parts.push(current.join(','))
      counts.push(current.length)
      current = []
      currentBytes = 0
    }
    current.push(op)
    currentBytes += bytes
  }
  if (current.length > 0 || parts.length === 0) {
    parts.push(current.join(','))
    counts.push(current.length)
  }
  return { parts, counts, total: ops.length }
}

/** The full frame sequence of one poke: pokeStart, one pokePart per part, pokeEnd. */
export function pokeFrames(poke: {
  pokeId: string
  baseCursor: Cursor | null
  patch: PatchParts
  lastMutationIdChanges?: Record<string, number>
  mutationResults?: MutationResult[]
  cursor: Cursor
}): string[] {
  const id = JSON.stringify(poke.pokeId)
  const frames = [
    JSON.stringify({ type: 'pokeStart', pokeId: poke.pokeId, baseCursor: poke.baseCursor } satisfies PokeStartMsg),
  ]
  let sent = 0
  poke.patch.parts.forEach((patch, i) => {
    sent += poke.patch.counts[i]!
    let frame = `{"type":"pokePart","pokeId":${id},"patch":[${patch}],"remaining":${poke.patch.total - sent}`
    if (i === 0) {
      if (poke.lastMutationIdChanges) frame += `,"lastMutationIdChanges":${JSON.stringify(poke.lastMutationIdChanges)}`
      if (poke.mutationResults?.length) frame += `,"mutationResults":${JSON.stringify(poke.mutationResults)}`
    }
    frames.push(`${frame}}`)
  })
  frames.push(
    JSON.stringify({
      type: 'pokeEnd',
      pokeId: poke.pokeId,
      cursor: poke.cursor,
      pageInfo: { more: false },
    } satisfies PokeEndMsg),
  )
  return frames
}
