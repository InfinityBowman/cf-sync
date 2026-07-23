import type { AnySyncSchema, RowOf, StandardSchemaV1, TableName, TableSchema } from '@cf-sync/protocol'
import type { CollectionConfig } from '@tanstack/db'
import type { SyncClient } from './client'

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
  const getKey =
    cfg.getKey ??
    ((row: Row): string => {
      const id = (row as { id?: unknown }).id
      if (typeof id !== 'string') {
        throw new Error(`workspaceCollectionOptions: row in table "${table}" has no string "id"; provide getKey`)
      }
      return id
    })
  // Internal mutations are envelope-typed; the public typed surface lives on
  // the caller's own registry.
  const mutate = (name: string, args: unknown): Promise<void> =>
    (client as SyncClient).mutate(name, args)

  return {
    id: `workspace-${table}`,
    getKey,
    schema: tableSchema as S['tables'][K] & StandardSchemaV1,
    startSync: cfg.startSync,
    sync: {
      rowUpdateMode: 'full',
      sync: (params) => {
        const { begin, write, commit, markReady, truncate } = params
        // Tracks keys present in synced state so server puts map to
        // insert-vs-update (the Electric adapter uses the same technique).
        const syncedKeys = new Set<string>()
        const unregister = client.registerTable(table, {
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
        return { cleanup: unregister }
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
