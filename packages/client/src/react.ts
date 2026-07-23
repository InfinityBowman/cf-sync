import { useSyncExternalStore } from 'react'
import type { SyncClient, SyncStatus } from './client'

/**
 * The client's sync status as React state — re-renders on every transition:
 *
 * ```tsx
 * const status = useSyncStatus(syncClient)
 * return <span>{status === 'synced' ? 'saved' : 'syncing…'}</span>
 * ```
 *
 * Server-rendered output reads the same snapshot, so SSR/hydration match
 * (construct the client with `autoStart: false` on the server).
 */
export function useSyncStatus(client: SyncClient<any, any>): SyncStatus {
  return useSyncExternalStore(
    client.subscribeStatus,
    () => client.status,
    () => client.status,
  )
}
