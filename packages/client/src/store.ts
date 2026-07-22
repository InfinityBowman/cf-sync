import type { Cursor } from '@cf-sync/protocol'

/** A queued mutation in durable form. `id` is null until a baseline is known. */
export interface PersistedOutboxEntry {
  id: number | null
  name: string
  args: unknown
}

/** A put/del row operation in durable form (clear is signaled separately). */
export type PersistedRowOp =
  | { op: 'put'; tbl: string; id: string; value: Record<string, unknown> }
  | { op: 'del'; tbl: string; id: string }

export interface PersistedState {
  schemaVersion: string | null
  /** Null when mutations were queued before the first successful sync. */
  cursor: Cursor | null
  confirmedLmid: number
  rows: { tbl: string; id: string; value: Record<string, unknown> }[]
  outbox: PersistedOutboxEntry[]
}

export interface PokePersist {
  ops: PersistedRowOp[]
  /** True when the poke contained a clear op (reset/bootstrap): replace all rows. */
  clear: boolean
  cursor: Cursor
  schemaVersion: string
  confirmedLmid: number
  outbox: PersistedOutboxEntry[]
}

/**
 * Durable client-side storage for synced rows, the cursor, and the outbox.
 *
 * The contract mirrors the server's transaction invariant (DESIGN.md §6) on
 * the client: applyPoke must commit rows, cursor, confirmedLmid, and the
 * outbox snapshot atomically, so the persisted cursor is never newer than
 * the persisted rows. A cursor that lags the rows is harmless — patches are
 * idempotent full-row puts/dels, so re-applying a delta converges.
 *
 * Implementations must apply operations in call order.
 */
export interface SyncStore {
  /** Load everything needed for hydration; null when nothing is stored. */
  load(): Promise<PersistedState | null>
  /** Atomically persist a poke's effects plus the resulting outbox. */
  applyPoke(update: PokePersist): Promise<void>
  /** Persist the outbox alone (enqueue, settle, or renumber without a poke). */
  saveOutbox(outbox: PersistedOutboxEntry[], confirmedLmid: number): Promise<void>
  /** Discard all persisted state (schema change or corrupt cache). */
  reset(): Promise<void>
}

/**
 * In-memory SyncStore: reference implementation and test double. Also usable
 * to pass a fresh "store" that intentionally forgets on reload.
 */
export class MemorySyncStore implements SyncStore {
  #schemaVersion: string | null = null
  #cursor: Cursor | null = null
  #confirmedLmid = 0
  #rows = new Map<string, Map<string, Record<string, unknown>>>()
  #outbox: PersistedOutboxEntry[] = []
  #hasState = false

  async load(): Promise<PersistedState | null> {
    if (!this.#hasState) return null
    const rows: PersistedState['rows'] = []
    for (const [tbl, byId] of this.#rows) {
      for (const [id, value] of byId) rows.push({ tbl, id, value })
    }
    return {
      schemaVersion: this.#schemaVersion,
      cursor: this.#cursor,
      confirmedLmid: this.#confirmedLmid,
      rows,
      outbox: this.#outbox.map((e) => ({ ...e })),
    }
  }

  async applyPoke(update: PokePersist): Promise<void> {
    // Subsumption guard (multi-writer stores): a poke that does not advance
    // the persisted cursor is already covered by what a newer writer stored.
    if (
      !update.clear &&
      this.#cursor !== null &&
      this.#cursor.backendId === update.cursor.backendId &&
      this.#cursor.version >= update.cursor.version
    ) {
      await this.saveOutbox(update.outbox, update.confirmedLmid)
      return
    }
    if (update.clear) this.#rows.clear()
    for (const op of update.ops) {
      let byId = this.#rows.get(op.tbl)
      if (op.op === 'put') {
        if (!byId) this.#rows.set(op.tbl, (byId = new Map()))
        byId.set(op.id, op.value)
      } else {
        byId?.delete(op.id)
      }
    }
    this.#cursor = update.cursor
    this.#schemaVersion = update.schemaVersion
    this.#confirmedLmid = update.confirmedLmid
    this.#outbox = update.outbox.map((e) => ({ ...e }))
    this.#hasState = true
  }

  async saveOutbox(outbox: PersistedOutboxEntry[], confirmedLmid: number): Promise<void> {
    this.#outbox = outbox.map((e) => ({ ...e }))
    this.#confirmedLmid = confirmedLmid
    this.#hasState = true
  }

  async reset(): Promise<void> {
    this.#schemaVersion = null
    this.#cursor = null
    this.#confirmedLmid = 0
    this.#rows.clear()
    this.#outbox = []
    this.#hasState = false
  }
}
