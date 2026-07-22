import type { CollectionConfig } from '@tanstack/db'
import type { SyncClient } from './client'

export interface WorkspaceCollectionConfig<T extends object> {
  client: SyncClient
  /** Server-side table name (rows.tbl). One collection per table. */
  table: string
  getKey: (row: T) => string
  /** Start syncing immediately instead of on first subscriber. */
  startSync?: boolean
}

/**
 * TanStack DB collection options creator backed by a cf-sync SyncClient.
 *
 * Synced data flows through the poke pipeline (begin/write/commit per poke,
 * truncate on reset). Local writes become `sync.put` / `sync.del` mutations;
 * each handler resolves only when the server confirms the mutation, at which
 * point TanStack DB drops the optimistic overlay (rebase is handled by the
 * store, see DESIGN.md §7).
 */
export function workspaceCollectionOptions<T extends object>(
  cfg: WorkspaceCollectionConfig<T>,
): CollectionConfig<T, string> {
  const { client, table, getKey } = cfg

  return {
    id: `workspace-${table}`,
    getKey,
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
              write({ type, value: op.value as T })
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
          client.mutate('sync.put', { tbl: table, id: getKey(m.modified as T), data: m.modified }),
        ),
      )
    },
    onUpdate: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map((m) =>
          client.mutate('sync.put', { tbl: table, id: getKey(m.modified as T), data: m.modified }),
        ),
      )
    },
    onDelete: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map((m) => client.mutate('sync.del', { tbl: table, id: String(m.key) })),
      )
    },
  }
}
