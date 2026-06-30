/**
 * Local override: copy to js/openaip-config.js (gitignored).
 * Defaults match openaip-config.public.js (proxy pipeline).
 *
 * Legacy direct API key (disabled by default — set USE_OPENAIP_PROXY = false):
 *   USE_OPENAIP_PROXY = false
 *   OPENAIP_API_KEY = "your-key"
 *   OPENAIP_PROXY_BASE = ""
 */
export const OPENAIP_API_KEY = "";
export const OPENAIP_PROXY_BASE = "https://openaip-proxy.gabriel-briffe.workers.dev";
export const USE_OPENAIP_PROXY = true;
