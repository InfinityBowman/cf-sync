import type { AnySyncSchema, StandardSchemaV1 } from '@cf-sync/protocol'
import { z } from 'zod'

/**
 * A structural fingerprint of the app's table schemas, stored in DO meta next
 * to the schema version. Its only job is drift detection: when a wake sees
 * the same version but a different fingerprint, a version bump was forgotten
 * (DESIGN.md §9 — every schema change requires one), so the engine warns once
 * and restamps. A warning rather than a hard error by design: the fingerprint
 * derives from zod's JSON Schema emission, which a zod upgrade could shift
 * with no semantic change — a heuristic gets to shout, never to brick.
 *
 * Zod tables are fingerprinted via their JSON Schema (zod is already the
 * protocol's one dependency); other standard-schema vendors are opaque, so
 * their drift is undetectable and never warns. Object keys are sorted before
 * hashing so a refactor that only reorders declarations hashes the same.
 */
export function schemaFingerprint(schema: AnySyncSchema): string {
  const shape: Record<string, unknown> = {}
  for (const [name, table] of Object.entries(schema.tables as Record<string, StandardSchemaV1>)) {
    shape[name] = tableShape(table)
  }
  return fnv1a(stableStringify(shape))
}

function tableShape(table: StandardSchemaV1): unknown {
  if (table['~standard'].vendor !== 'zod') {
    return { opaque: table['~standard'].vendor }
  }
  try {
    return z.toJSONSchema(table as unknown as z.ZodType, { unrepresentable: 'any' })
  } catch {
    return { opaque: 'zod-unrepresentable' }
  }
}

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
