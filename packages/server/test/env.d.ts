// Bindings from test/fixture/wrangler.jsonc, surfaced on `env` from
// cloudflare:test (typed as Cloudflare.Env).
declare namespace Cloudflare {
  interface Env {
    WORKSPACE: DurableObjectNamespace
    COMPACT: DurableObjectNamespace
  }
}
