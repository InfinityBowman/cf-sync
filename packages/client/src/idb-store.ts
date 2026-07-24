import type { Cursor } from '@cf-sync/protocol'
import type { PersistedOutboxEntry, PersistedState, PokePersist, SyncStore } from './store'

/**
 * Constructor options for {@link IndexedDBSyncStore} — where its database
 * lives and which clientId's outbox partition it owns.
 */
export interface IndexedDBSyncStoreOptions {
  /** One database per workspace; safe to share across tabs. */
  workspaceId: string
  /** Partitions the outbox: each tab/session replays only its own mutations. */
  clientId: string
  /** Database name prefix. Default: "cf-sync". */
  dbNamePrefix?: string
  /** Outbox records from clientIds idle longer than this are GC'd on load. Default: 30 days. */
  outboxMaxAgeMs?: number
  /** Injectable for tests. Default: globalThis.indexedDB. */
  indexedDB?: IDBFactory
}

interface MetaRecord {
  schemaVersion: number
  cursor: Cursor
}

interface OutboxRecord {
  entries: PersistedOutboxEntry[]
  confirmedLmid: number
  updatedAt: number
}

const ROWS = 'rows' // key: [tbl, id] -> row value
const META = 'meta' // key: 'state' -> MetaRecord
const OUTBOX = 'outbox' // key: clientId -> OutboxRecord

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function txnDone(txn: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    txn.oncomplete = () => resolve()
    txn.onabort = () => reject(txn.error ?? new Error('IndexedDB transaction aborted'))
    txn.onerror = () => reject(txn.error ?? new Error('IndexedDB transaction failed'))
  })
}

/**
 * SyncStore over IndexedDB. Rows, cursor, and outbox commit in a single
 * IndexedDB transaction spanning all three object stores, which is what
 * upholds the cursor-never-newer-than-rows contract.
 *
 * The rows and meta stores are shared by every tab on the workspace; a
 * subsumption guard makes concurrent writers safe: a poke whose cursor does
 * not advance past the stored one is skipped, because catch-up patches carry
 * current row state (not historical deltas), so the newer writer's rows
 * already cover it. Outbox records are per-clientId, so tabs never touch
 * each other's pending mutations.
 *
 * All operations run through an internal queue, preserving call order even
 * though callers fire-and-forget.
 */
export class IndexedDBSyncStore implements SyncStore {
  readonly #dbName: string
  readonly #clientId: string
  readonly #outboxMaxAgeMs: number
  readonly #factory: IDBFactory
  #db: Promise<IDBDatabase> | null = null
  #queue: Promise<unknown> = Promise.resolve()

  constructor(opts: IndexedDBSyncStoreOptions) {
    this.#dbName = `${opts.dbNamePrefix ?? 'cf-sync'}:${opts.workspaceId}`
    this.#clientId = opts.clientId
    this.#outboxMaxAgeMs = opts.outboxMaxAgeMs ?? 30 * 24 * 60 * 60 * 1000
    this.#factory = opts.indexedDB ?? globalThis.indexedDB
    if (!this.#factory) throw new Error('IndexedDB is not available in this environment')
  }

  #open(): Promise<IDBDatabase> {
    if (this.#db) return this.#db
    this.#db = new Promise((resolve, reject) => {
      const req = this.#factory.open(this.#dbName, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(ROWS)) db.createObjectStore(ROWS)
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META)
        if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('failed to open IndexedDB'))
      req.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'))
    })
    return this.#db
  }

  #enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(op)
    this.#queue = result.catch(() => {}) // one failure must not poison the queue
    return result
  }

  load(): Promise<PersistedState | null> {
    return this.#enqueue(async () => {
      const db = await this.#open()
      const txn = db.transaction([ROWS, META, OUTBOX], 'readwrite')
      const meta = (await request(txn.objectStore(META).get('state'))) as MetaRecord | undefined
      const outboxStore = txn.objectStore(OUTBOX)
      const mine = (await request(outboxStore.get(this.#clientId))) as OutboxRecord | undefined

      // GC outbox records from long-dead clientIds (closed tabs).
      const staleBefore = Date.now() - this.#outboxMaxAgeMs
      const keys = (await request(outboxStore.getAllKeys())) as string[]
      for (const key of keys) {
        if (key === this.#clientId) continue
        const record = (await request(outboxStore.get(key))) as OutboxRecord | undefined
        if (record && record.updatedAt < staleBefore) outboxStore.delete(key)
      }

      let rows: PersistedState['rows'] = []
      if (meta) {
        const rowStore = txn.objectStore(ROWS)
        const values = (await request(rowStore.getAll())) as Record<string, unknown>[]
        const rowKeys = (await request(rowStore.getAllKeys())) as [string, string][]
        rows = rowKeys.map((key, i) => ({ tbl: key[0], id: key[1], value: values[i]! }))
      }
      await txnDone(txn)

      if (!meta && !mine) return null
      return {
        schemaVersion: meta?.schemaVersion ?? null,
        cursor: meta?.cursor ?? null,
        confirmedLmid: mine?.confirmedLmid ?? 0,
        rows,
        outbox: mine?.entries ?? [],
      }
    })
  }

  applyPoke(update: PokePersist): Promise<void> {
    return this.#enqueue(async () => {
      const db = await this.#open()
      const txn = db.transaction([ROWS, META, OUTBOX], 'readwrite')
      const metaStore = txn.objectStore(META)
      const stored = (await request(metaStore.get('state'))) as MetaRecord | undefined

      const subsumed =
        !update.clear &&
        stored !== undefined &&
        stored.cursor.backendId === update.cursor.backendId &&
        stored.cursor.version >= update.cursor.version

      if (!subsumed) {
        const rowStore = txn.objectStore(ROWS)
        if (update.clear) rowStore.clear()
        for (const op of update.ops) {
          if (op.op === 'put') rowStore.put(op.value, [op.tbl, op.id])
          else rowStore.delete([op.tbl, op.id])
        }
        metaStore.put({ schemaVersion: update.schemaVersion, cursor: update.cursor } satisfies MetaRecord, 'state')
      }
      txn.objectStore(OUTBOX).put(
        { entries: update.outbox, confirmedLmid: update.confirmedLmid, updatedAt: Date.now() } satisfies OutboxRecord,
        this.#clientId,
      )
      await txnDone(txn)
    })
  }

  saveOutbox(outbox: PersistedOutboxEntry[], confirmedLmid: number): Promise<void> {
    return this.#enqueue(async () => {
      const db = await this.#open()
      const txn = db.transaction(OUTBOX, 'readwrite')
      txn
        .objectStore(OUTBOX)
        .put({ entries: outbox, confirmedLmid, updatedAt: Date.now() } satisfies OutboxRecord, this.#clientId)
      await txnDone(txn)
    })
  }

  reset(): Promise<void> {
    return this.#enqueue(async () => {
      const db = await this.#open()
      const txn = db.transaction([ROWS, META, OUTBOX], 'readwrite')
      txn.objectStore(ROWS).clear()
      txn.objectStore(META).clear()
      txn.objectStore(OUTBOX).clear()
      await txnDone(txn)
    })
  }

  /** Closes the database connection (tests and teardown). */
  async close(): Promise<void> {
    if (!this.#db) return
    const db = await this.#db
    db.close()
    this.#db = null
  }
}
