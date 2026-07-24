import { bearerTokenAuth, createAdminRoute, createSyncFetch, createWorkspaceDO } from '@cf-sync/server'
import { yjsFields } from '@cf-sync/yjs/server'
import { app } from '../src/schema'

interface Env {
  // Typed with the DO class, matching what `wrangler types` generates.
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>
  EXPORT_BUCKET: R2Bucket
  /** Set via `wrangler secret put ADMIN_TOKEN`. Unset = admin surface disabled. */
  ADMIN_TOKEN?: string
}

// Version, schema, mutators, and migrations all travel inside `app` — the
// same object the browser passes to SyncClient, so the two can't disagree.
// A class declaration (not `export const`) so the name is also a type —
// `wrangler types` needs one to emit the typed WORKSPACE binding above. The
// body stays empty: the engine's handlers are not extension points.
export class WorkspaceDO extends createWorkspaceDO({
  app,
  export: {
    // Annotating the param types the whole DO's env — no cast.
    bucket: (env: Env) => env.EXPORT_BUCKET,
  },
  // Tier 2 fields: per-todo collaborative notes ride the same socket as
  // binary Yjs frames — CRDT bytes never touch rows, pokes, or the mutation
  // log. No wrangler migration needed; the extension owns its own tables.
  // This demo's auth policy is "any member writes" (the default). With a
  // real authorize hook stamping context, writes gate per field — passing
  // `app` types `auth` from the authContext declared in defineMutators:
  //
  //   extension: yjsFields({
  //     app,
  //     authorizeWrite: ({ fieldId, auth }) =>
  //       fieldId.startsWith(`todo-notes:`) && auth !== undefined,
  //   }),
  extension: yjsFields(),
}) {}

const syncHandler = createSyncFetch<Env>({
  namespace: (env) => env.WORKSPACE,
  // v1 auth policy (DESIGN.md §10): anyone who can reach the workspace has
  // full access. Real deployments plug session validation in here.
  authorize: () => true,
})

// Admin operations read and destroy whole workspaces: locked behind a bearer
// token (`curl -H "Authorization: Bearer $TOKEN" .../admin/<ws>/stats`),
// compared in constant time; an unset secret denies everything.
const adminRoute = createAdminRoute<Env>({
  namespace: (env) => env.WORKSPACE,
  authorize: bearerTokenAuth((env) => env.ADMIN_TOKEN),
})

// Routes compose with ?? (null = "not mine"); the sync fetch is the terminal
// handler and carries the 404 fallback.
export default {
  fetch: async (request: Request, env: Env) => (await adminRoute(request, env)) ?? syncHandler(request, env),
}
