import type { EngineErrorCode } from '@cf-sync/protocol'

/**
 * The known codes a rejected `mutate` promise carries — the engine's built-in
 * rejections ({@link EngineErrorCode}) plus the client-local outcomes:
 *
 * - `Timeout` — memory-only client, unconfirmed past `confirmTimeoutMs`.
 * - `Stopped` — `destroy()` was called with the mutation still unconfirmed.
 * - `Fatal` — the client is in (or entered) the fatal state.
 * - `LocalApplyFailed` — the optimistic apply threw a non-`AppError`; nothing
 *   was sent.
 *
 * App-defined `AppError` codes flow through as themselves, so `code` stays
 * open to any string — this union is the vocabulary that autocompletes.
 */
export type MutationErrorCode = EngineErrorCode | 'Timeout' | 'Stopped' | 'Fatal' | 'LocalApplyFailed'

/**
 * The error a refused mutation settles with — what an awaited `mutate` call
 * rejects with and what `onMutationRejected` receives. `code` is the
 * branchable identity, drawn from three groups: the engine's built-in
 * rejections ({@link EngineErrorCode}, e.g. `InvalidArgs`,
 * `UnknownMutator`), the client-local outcomes (`Timeout`, `Stopped`,
 * `Fatal`, `LocalApplyFailed`), and app-defined `AppError` codes passed
 * through verbatim — {@link MutationErrorCode} is the full vocabulary.
 * `message` is diagnostic prose; branch on `code`, not on it. `mutation`
 * carries the rejected mutation's name and args when the client knows them —
 * an awaiting `catch` gets the same context `onMutationRejected` receives.
 */
export class MutationError extends Error {
  constructor(
    readonly code: MutationErrorCode | (string & {}),
    message: string,
    readonly mutation?: { name: string; args: unknown },
  ) {
    super(message)
    this.name = 'MutationError'
  }
}

/**
 * What {@link SyncFatalError.code} can hold: the WebSocket close code
 * (4400–4499) when the rejection arrived as a close frame, or the in-band
 * server code — only `VersionNotSupported` and `Unauthorized` are ever fatal.
 */
export type SyncFatalCode = number | 'VersionNotSupported' | 'Unauthorized'

// Permanent-rejection protocol: DESIGN.md §15.2.
/**
 * What `onFatal` receives when the server permanently rejects this client.
 * `reason` is the close frame's slug (`membership-revoked`,
 * `project-deleted`) — stable strings apps can branch on.
 */
export class SyncFatalError extends Error {
  constructor(
    readonly code: SyncFatalCode,
    readonly reason: string,
  ) {
    super(`sync connection permanently rejected (${code}): ${reason}`)
    this.name = 'SyncFatalError'
  }
}

/** Signals the speculative run touched a table with no attached collection (degrade, not error). */
export class MissingApplierError extends Error {
  constructor(readonly tbl: string) {
    super(`no collection attached for table "${tbl}"`)
    this.name = 'MissingApplierError'
  }
}
