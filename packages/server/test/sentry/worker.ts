import { instrumentDurableObjectWithSentry } from '@sentry/cloudflare'
import { createSyncFetch, createWorkspaceDO } from '../../src/index'
import { testApp } from '../fixture/worker'

interface Env {
  SENTRY_WORKSPACE: DurableObjectNamespace
}

/**
 * The engine DO exactly as an app would wrap it for error reporting — the
 * documented composition this fixture exists to keep honest.
 *
 * Sentry's wrapper is a Proxy whose `construct` trap replaces `ctx` with an
 * instrumented clone and reassigns `fetch`/`alarm`/`webSocketMessage`/
 * `webSocketClose`/`webSocketError` as own properties on the instance,
 * shadowing our prototype methods. Both of those touch load-bearing engine
 * behavior (hibernation dispatch, invariant 3's synchronous sends), so the
 * compatibility claim is worth a real socket driven through a real wrap.
 */
export const SentryWorkspaceDO = instrumentDurableObjectWithSentry(
  // Annotate the callback's env even when unused: Sentry infers its `Env`
  // type parameter from here, and a bare `() => ({…})` collapses it to
  // `unknown`, which then rejects the engine class.
  (_env: Env) => ({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    // Everything on: the wrapper's span/scope machinery is what wraps our
    // handlers, so sampling it out would test less than an app runs.
    tracesSampleRate: 1,
    // Nothing leaves the isolate — vitest-pool-workers has no outbound, and
    // an offline transport keeps the test about dispatch, not delivery.
    transport: () => ({
      send: () => Promise.resolve({}),
      flush: () => Promise.resolve(true),
    }),
  }),
  createWorkspaceDO<typeof testApp.schema, Env>({ app: testApp }),
)

export default {
  fetch: createSyncFetch<Env>({ namespace: (env) => env.SENTRY_WORKSPACE, authorize: 'public' }),
}
