// The app-author surface: the definition kit (defineApp / defineSchema /
// defineMutators / crudMutators / AppError) plus the handful of wire constants
// and types that appear in the public @cf-sync/server and @cf-sync/client
// APIs. Wire-level internals — frame schemas, chunking, binary field frames —
// live in '@cf-sync/protocol/internal' and carry no compatibility promise.
export * from './schema'
export * from './mutators'
export * from './app'
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
