import type { AnySyncSchema, StandardSchemaV1 } from '@cf-sync/protocol'
import { z } from 'zod'

// Schema-evolution rules: DESIGN.md §9.
/**
 * A structural fingerprint of the app's table schemas, stored in DO meta next
 * to the schema version. Its only job is drift detection: when a wake sees
 * the same version but a different fingerprint, a version bump was forgotten
 * — every schema change requires one — so the engine warns once
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

/**
 * The presence schema's own fingerprint, tracked separately from the table
 * fingerprint because its drift is priced differently (DESIGN.md §16.1):
 * presence is ephemera — never stored, at most one connection long — so a
 * shape change warns softly and never demands a version bump, while a table
 * change under an unbumped version is a real bug. '' = no presence declared.
 */
export function presenceFingerprint(presence: StandardSchemaV1 | undefined): string {
  return presence ? fnv1a(stableStringify(tableShape(presence))) : ''
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

/**
 * The tables whose shape fingerprints as opaque — non-zod vendors, or zod
 * schemas JSON Schema cannot represent. Drift in these tables is invisible
 * to both the runtime warning and `checkSchemaEvolution`, which is why the
 * latter refuses to run over them: a check that cannot see is a false green.
 */
export function unfingerprintableTables(schema: AnySyncSchema): Array<{ table: string; vendor: string }> {
  const out: Array<{ table: string; vendor: string }> = []
  for (const [name, table] of Object.entries(schema.tables as Record<string, StandardSchemaV1>)) {
    const shape = tableShape(table)
    if (shape !== null && typeof shape === 'object' && 'opaque' in shape) {
      out.push({ table: name, vendor: String((shape as { opaque: unknown }).opaque) })
    }
  }
  return out
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
