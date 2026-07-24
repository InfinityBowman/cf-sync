import { useSyncExternalStore } from 'react'
import type { PresencePeer } from '@cf-sync/protocol'
import type { PresenceApi, SyncClient, SyncStatus } from './client'

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

/**
 * Peers' presence as React state, typed by the app's presence schema and
 * excluding self — render your own state from `presence.self`, not here:
 *
 * ```tsx
 * const peers = usePresence(syncClient)
 * return <>{peers.map((p) => <Avatar key={p.clientId} name={p.state.name} />)}</>
 * ```
 *
 * The snapshot is stable between changes, and the server pre-render sees the
 * same empty peers a fresh client does, so SSR/hydration match.
 */
export function usePresence<TOut>(client: { presence: PresenceApi<any, TOut> }): ReadonlyArray<PresencePeer<TOut>> {
  const presence = client.presence
  return useSyncExternalStore(
    presence.subscribe,
    () => presence.peers,
    () => presence.peers,
  )
}
