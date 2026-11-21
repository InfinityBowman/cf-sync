// Sockets whose client is gone without a close (ARCHITECTURE.md#connections-and-lifecycle): the edge
// dropped the connection and the client reconnected on a new socket, but the Durable Object was never
// told. A live client pings every 25s (about once a minute from a background tab), and the edge drops
// a connection quiet for ~75-130s, so a socket with no ping in SILENT_MS has no one on the other end.

/** How long a socket may go without a keepalive ping before it is taken for one whose client is gone. */
export const SILENT_MS = 150_000

/** A socket's last keepalive (null before its first) and when it was accepted (unknown on sockets from older code). */
export interface SocketSeen {
  lastPing: number | null
  acceptedAt: number | undefined
}

/** Whether a socket's client is gone: no ping in SILENT_MS, counted from its accept when it never pinged. Unknown stays open. */
export function isSilent({ lastPing, acceptedAt }: SocketSeen, now: number): boolean {
  const since = lastPing ?? acceptedAt
  return since !== undefined && now - since > SILENT_MS
}
