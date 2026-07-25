export { SyncClient } from './client'
export {
  MutationError,
  SyncFatalError,
  type MutationErrorCode,
  type SyncFatalCode,
} from './errors'
export { type Mutate, type MutateNamespace } from './mutate'
export {
  type IntentTransactionRunner,
  type PresenceApi,
  type SyncClientOptions,
  type SyncLogger,
  type SyncStatus,
  type TableApplier,
  type TableHooks,
  type TableWriteOp,
  type WebSocketLike,
} from './types'
export {
  createCollections,
  createWorkspace,
  workspaceCollectionOptions,
  type Workspace,
  type WorkspaceCollectionConfig,
  type WorkspaceCollections,
} from './collection'
// The schema/mutator definition kit lives in @cf-sync/protocol so app code
// shared between worker and browser can import it from one place; re-exported
// here for browser-only code.
export {
  AppError,
  CLOSE_AUTH_CONTEXT_INVALID,
  CLOSE_PERMANENT_MAX,
  CLOSE_PERMANENT_MIN,
  CLOSE_REFRESH,
  CLOSE_SUPERSEDED,
  CLOSE_UNAUTHORIZED,
  CLOSE_VERSION_NOT_SUPPORTED,
  crudMutators,
  defineApp,
  defineMutators,
  defineSchema,
  isPermanentCloseCode,
  type AnyMutators,
  type AnySyncSchema,
  type AppDefinition,
  type AuthContextOf,
  type CrudDelArgs,
  type CrudMutators,
  type CrudPutArgs,
  type EngineErrorCode,
  type MutationArgs,
  type MutatorContext,
  type MutatorDef,
  type MutatorTx,
  type MutatorsFor,
  type PresenceOf,
  type PresencePeer,
  type RowInputOf,
  type RowOf,
  type SchemaMigration,
  type SchemaMigrationFn,
  type StandardSchemaV1,
  type SyncSchema,
  type TableName,
  type TableSchema,
} from '@cf-sync/protocol'
export {
  MemorySyncStore,
  type PersistedOutboxEntry,
  type PersistedRowOp,
  type PersistedState,
  type PokePersist,
  type SyncStore,
} from './store'
export { IndexedDBSyncStore, type IndexedDBSyncStoreOptions } from './idb-store'
