// The app-author surface: the definition kit (defineApp / defineSchema /
// defineMutators / crudMutators / AppError) plus the handful of wire constants
// and types that appear in the public @cf-sync/server and @cf-sync/client
// APIs. Everything here is curated by hand — engine plumbing (migrationPath,
// name/id validation constants) and wire-level internals (frame schemas,
// chunking, binary field frames) live in '@cf-sync/protocol/internal' and
// carry no compatibility promise. AUTH_CONTEXT is the one exception: the
// symbol itself must be root-exported so downstream declaration emit can name
// registry types (see its export note below).
export {
  defineSchema,
  type AnySyncSchema,
  type RowInputOf,
  type RowOf,
  type SyncSchema,
  type TableName,
  type TableSchema,
} from './schema'
export {
  AppError,
  crudMutators,
  defineMutators,
  // The authContext stamp: AUTH_CONTEXT is the symbol defineMutators stamps a
  // registry's authContext schema under, AuthContextCarrier the named type
  // declaration emit references for it. Both are root-exported so a package
  // that re-exports its registry with declaration emit on can name the
  // inferred type (TS4023 otherwise); read the context type via AuthContextOf.
  AUTH_CONTEXT,
  type AuthContextCarrier,
  type AnyMutators,
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
} from './mutators'
export {
  defineApp,
  type AppDefinition,
  type MigrationTx,
  type PresenceOf,
  type PresencePeer,
  type SchemaMigration,
  type SchemaMigrationFn,
} from './app'
export type { StandardSchemaV1 } from './standard-schema'
export {
  CLOSE_AUTH_CONTEXT_INVALID,
  CLOSE_PERMANENT_MAX,
  CLOSE_PERMANENT_MIN,
  CLOSE_REFRESH,
  CLOSE_SUPERSEDED,
  CLOSE_UNAUTHORIZED,
  CLOSE_VERSION_NOT_SUPPORTED,
  isPermanentCloseCode,
  MAX_PRESENCE_BYTES,
  MAX_ROW_BYTES,
  type Cursor,
  type PatchOp,
} from './messages'
