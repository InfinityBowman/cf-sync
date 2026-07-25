// Bindings from test/fixture/wrangler.jsonc, surfaced on `env` from
// cloudflare:test (typed as Cloudflare.Env).
declare namespace Cloudflare {
  interface Env {
    WORKSPACE: DurableObjectNamespace
    COMPACT: DurableObjectNamespace
    ROLLOUT: DurableObjectNamespace
    EXPORT_BUCKET: R2Bucket
    // From test/sentry/wrangler.jsonc — that project's own fixture (the
    // Sentry wrapper needs nodejs_compat), sharing this one Env declaration.
    SENTRY_WORKSPACE: DurableObjectNamespace
  }
}
