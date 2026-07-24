import type { AnySyncSchema, RowInputOf, RowOf, StandardSchemaV1, TableName, TableSchema } from '@cf-sync/protocol'
import { createCollection, createTransaction, type Collection, type CollectionConfig } from '@tanstack/db'
import {
  RAW_MUTATE,
  type IntentTransactionRunner,
  type SyncClient,
  type TableApplier,
  type TableHooks,
  type TableWriteOp,
} from './client'

/**
 * DESIGN.md §7.2: one atomic optimistic transaction per intent mutation.
 * Writes inside `tx.mutate` join the ambient transaction and skip the
 * collections' own mutation handlers; the overlay drops when `persist`
 * resolves (the confirm patch is already applied — synced commits buffer
 * while the transaction persists, so the swap is one recompute) and rolls
 * back when it rejects.
 */
const runIntentTransaction: IntentTransactionRunner = (intent, flush, persist) => {
  const tx = createTransaction({ mutationFn: () => persist(), metadata: { intent } })
  tx.mutate(flush)
  if (tx.mutations.length === 0) {
    // TanStack resolves a mutation-less transaction without calling its
    // mutationFn. The flush can net out to nothing the collections need to
    // change (delete of an absent row, put equal to the current value) —
    // but the mutation must still reach the server: local state may be
    // behind, and the server's run is the one that counts.
    return persist()
  }
  return tx.isPersisted.promise.then(() => undefined)
}

/** TanStack enriches rows with virtual props; keep them out of mutator reads and overlays. */
function stripVirtualProps(row: Record<string, unknown>): Record<string, unknown> {
  const { $synced, $origin, $key, $collectionId, ...data } = row as Record<string, unknown> & {
    $synced?: unknown
    $origin?: unknown
    $key?: unknown
    $collectionId?: unknown
  }
  return data
}

/**
 * Fronts a table's hooks so they can register with the client at options
 * creation, before TanStack starts the (lazy) sync pipeline. While detached
 * it absorbs synced data into a compacting buffer — last op per row id plus a
 * pending-clear flag, sufficient because patches are full-row LWW — and
 * `attach` drains the buffer into the real hooks as one synced transaction,
 * then becomes pass-through. This removes the late-`registerTable` full
 * resync for every collection created before its first subscriber (DESIGN.md
 * §7.2).
 */
interface HookGate {
  hooks: TableHooks
  attach(target: TableHooks): void
  detach(): void
}

function createHookGate(): HookGate {
  let target: TableHooks | null = null
  let pendingClear = false
  let pendingReady = false
  const pendingOps = new Map<string, TableWriteOp>()
  return {
    hooks: {
      begin: () => target?.begin(),
      write: (op) => {
        if (target) target.write(op)
        else pendingOps.set(op.id, op)
      },
      commit: () => target?.commit(),
      truncate: () => {
        if (target) {
          target.truncate()
        } else {
          pendingClear = true
          pendingOps.clear()
        }
      },
      markReady: () => {
        if (target) target.markReady()
        else pendingReady = true
      },
    },
    attach: (t) => {
      target = t
      if (pendingClear || pendingOps.size > 0) {
        t.begin()
        if (pendingClear) t.truncate()
        for (const op of pendingOps.values()) t.write(op)
        t.commit()
      }
      if (pendingReady) t.markReady()
      pendingClear = false
      pendingReady = false
      pendingOps.clear()
    },
    detach: () => {
      target = null
    },
  }
}

function collectionApplier(collection: Collection<any, string, any, any, any>): TableApplier {
  return {
    has: (id) => collection.has(id),
    get: (id) => {
      const row = collection.get(id) as Record<string, unknown> | undefined
      return row ? stripVirtualProps(row) : null
    },
    list: () =>
      Array.from(collection.entries() as IterableIterator<[string, Record<string, unknown>]>, ([id, data]) => ({
        id,
        data: stripVirtualProps(data),
      })),
    insert: (data) => {
      collection.insert(data)
    },
    update: (id, data) => {
      // Full-row replacement through the draft proxy (rows are LWW documents).
      collection.update(id, (draft: Record<string, unknown>) => {
        for (const key of Object.keys(draft)) if (!(key in data)) delete draft[key]
        Object.assign(draft, data)
      })
    },
    delete: (id) => {
      collection.delete(id)
    },
  }
}

export type WorkspaceCollectionConfig<S extends AnySyncSchema, K extends TableName<S>> = {
  client: SyncClient<S, any>
  /** Server-side table name (a key of the client's schema). One collection per table. */
  table: K
  /** Start syncing immediately instead of on first subscriber. */
  startSync?: boolean
} & (RowOf<S, K> extends { id: string }
  ? {
      /** Defaults to `row.id` — the row schema has a string `id` field. */
      getKey?: (row: RowOf<S, K>) => string
    }
  : {
      /** Required: the row schema has no string `id` field to default to. */
      getKey: (row: RowOf<S, K>) => string
    })

/**
 * TanStack DB collection options creator backed by a cf-sync SyncClient.
 * The row type, the collection's runtime validation schema, and the key
 * function all derive from the table's entry in the shared `defineSchema`.
 *
 * Synced data flows through the poke pipeline (begin/write/commit per poke,
 * truncate on reset). Local writes become `sync.put` / `sync.del` mutations;
 * each handler resolves only when the server confirms the mutation, at which
 * point TanStack DB drops the optimistic overlay (rebase is handled by the
 * store, see DESIGN.md §7).
 *
 * Table hooks register with the client at options creation, buffered until
 * TanStack starts the sync pipeline — a lazily-subscribed collection costs no
 * full resync. The collection also serves as `mutate`'s optimistic surface:
 * intent mutations run their shared `apply` against it locally (§7.2).
 */
export function workspaceCollectionOptions<S extends AnySyncSchema, K extends TableName<S>>(
  cfg: WorkspaceCollectionConfig<S, K>,
): CollectionConfig<RowOf<S, K> & object, string, S['tables'][K] & StandardSchemaV1> & {
  schema: S['tables'][K] & StandardSchemaV1
} {
  type Row = RowOf<S, K> & object
  const { client, table } = cfg
  const tableSchema = (client.schema.tables as Record<string, TableSchema>)[table]
  if (!tableSchema) {
    throw new Error(
      `workspaceCollectionOptions: table "${table}" is not in the schema passed to SyncClient — ` +
        `known tables: ${Object.keys(client.schema.tables).join(', ') || '(none)'}`,
    )
  }
  // Collections write through sync.put / sync.del. Fail at setup when the
  // registry lacks them — the alternative is every insert rejecting at
  // runtime with UnknownMutator and silently rolling back its optimistic row.
  for (const required of ['sync.put', 'sync.del'] as const) {
    if (!(client.app.mutators as Record<string, unknown>)[required]) {
      throw new Error(
        `workspaceCollectionOptions: the app's mutator registry has no "${required}", which ` +
          `collections emit for local writes — the app was defined with crud: false; remove it ` +
          `(defineApp includes the crud mutators by default) or drive this table through ` +
          `intent mutators only, without a collection`,
      )
    }
  }
  const getKey =
    cfg.getKey ??
    ((row: Row): string => {
      const id = (row as { id?: unknown }).id
      if (typeof id !== 'string') {
        throw new Error(`workspaceCollectionOptions: row in table "${table}" has no string "id"; provide getKey`)
      }
      return id
    })
  // Collection handlers ARE the optimistic effect, so they enqueue through
  // the raw path — routing them through `mutate` would recursively spawn a
  // second transaction re-applying the same write.
  const mutate = (name: string, args: unknown): Promise<void> => (client as SyncClient)[RAW_MUTATE](name, args)

  // Hooks register with the client NOW — at options creation, not at first
  // subscriber. The gate buffers synced data until TanStack starts the (lazy)
  // sync pipeline, so collections created up front never trigger the
  // late-registration full resync no matter when they get their first
  // subscriber (DESIGN.md §7.2).
  const gate = createHookGate()
  let registered = true
  let unregister = client.registerTable(table, gate.hooks)

  return {
    // Scoped by workspace so an app with two open workspaces never collides
    // on TanStack DB's app-wide collection ids.
    id: `workspace-${client.workspaceId}-${table}`,
    getKey,
    schema: tableSchema as S['tables'][K] & StandardSchemaV1,
    startSync: cfg.startSync,
    sync: {
      rowUpdateMode: 'full',
      sync: (params) => {
        const { begin, write, commit, markReady, truncate } = params
        // Attach the applier for optimistic intent execution (idempotent —
        // createCollections already attached it at creation; this covers
        // hand-rolled createCollection(workspaceCollectionOptions(…)) setups).
        client.registerApplier(table, collectionApplier(params.collection), runIntentTransaction)
        if (!registered) {
          // Restart after cleanup: TanStack wiped the collection's state and
          // the engine keeps no mirror, so this re-registration deliberately
          // triggers the full-resync path (rare).
          unregister = client.registerTable(table, gate.hooks)
          registered = true
        }
        // Tracks keys present in synced state so server puts map to
        // insert-vs-update (the Electric adapter uses the same technique).
        const syncedKeys = new Set<string>()
        gate.attach({
          begin: () => begin(),
          write: (op) => {
            if (op.type === 'put') {
              const type = syncedKeys.has(op.id) ? ('update' as const) : ('insert' as const)
              syncedKeys.add(op.id)
              write({ type, value: op.value as Row })
            } else if (syncedKeys.delete(op.id)) {
              write({ type: 'delete', key: op.id })
            }
          },
          commit: () => commit(),
          truncate: () => {
            syncedKeys.clear()
            truncate()
          },
          markReady: () => markReady(),
        })
        return {
          cleanup: () => {
            gate.detach()
            unregister()
            registered = false
          },
        }
      },
    },
    onInsert: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map((m) =>
          mutate('sync.put', { tbl: table, id: getKey(m.modified as Row), data: m.modified }),
        ),
      )
    },
    onUpdate: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map((m) =>
          mutate('sync.put', { tbl: table, id: getKey(m.modified as Row), data: m.modified }),
        ),
      )
    },
    onDelete: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map((m) => mutate('sync.del', { tbl: table, id: String(m.key) })),
      )
    },
  }
}

/** One live TanStack DB collection per table in the app's schema. */
export type WorkspaceCollections<S extends AnySyncSchema> = {
  [K in TableName<S>]: Collection<
    RowOf<S, K> & object,
    string,
    {},
    S['tables'][K] & StandardSchemaV1,
    RowInputOf<S, K> & object
  >
}

/**
 * Creates one collection per table in the client's schema, fully typed —
 * the one-line alternative to a `createCollection(workspaceCollectionOptions(…))`
 * block per table:
 *
 * ```ts
 * const { todos, issues } = createCollections(client)
 * ```
 *
 * Collections start syncing immediately (`startSync` defaults to true here,
 * unlike `workspaceCollectionOptions`, which keeps TanStack's lazy default):
 * the client receives pokes for every table on the one socket regardless, so
 * eager sync costs no extra network — it only applies already-buffered data,
 * and first render sees rows without waiting for a subscriber. Pass
 * `{ startSync: false }` to defer to first subscriber anyway.
 *
 * Rows are keyed by their `id` field (this engine's row model); a table whose
 * rows key differently needs an individual `workspaceCollectionOptions` call
 * with its own `getKey`.
 */
export function createCollections<S extends AnySyncSchema>(
  client: SyncClient<S, any>,
  options?: { startSync?: boolean },
): WorkspaceCollections<S> {
  const collections: Record<string, unknown> = {}
  for (const table of Object.keys(client.schema.tables)) {
    // The per-table conditional getKey type can't resolve over a table-name
    // union; the runtime default (row.id) is exactly what we document here.
    const config = { client, table, startSync: options?.startSync ?? true } as WorkspaceCollectionConfig<
      S,
      TableName<S>
    >
    const collection = createCollection(workspaceCollectionOptions(config))
    // Attach the applier now (not at first sync) so intents fired before a
    // collection has subscribers still get their optimistic effect.
    client.registerApplier(table, collectionApplier(collection), runIntentTransaction)
    // Tie the collection's lifetime to the client: client.destroy() cleans
    // these up too, so teardown (e.g. switching workspaces) is one call.
    client.onDestroy(() => collection.cleanup())
    collections[table] = collection
  }
  return collections as WorkspaceCollections<S>
}
