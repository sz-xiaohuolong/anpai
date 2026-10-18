/// <reference types="@cloudflare/workers-types" />

/**
 * Worker 环境绑定。与 wrangler.toml 保持一致。
 */
interface Env {
  AnpaiRoom: DurableObjectNamespace
  ASSETS: Fetcher
}
