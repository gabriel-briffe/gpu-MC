/**
 * OpenAIP API proxy for Cloudflare Workers (committed template — no API key).
 *
 * Setup:
 * 1. Copy cloudflare/openaip-proxy.worker.js (gitignored, has your key) into the CF dashboard.
 *    Or paste this file and set OPENAIP_API_KEY via Workers → Settings → Variables.
 * 2. Worker URL: https://openaip-proxy.gabriel-briffe.workers.dev
 * 3. js/openaip-config.public.js already points at that proxy.
 *
 * Routes:
 *   GET /tiles/{z}/{x}/{y}.pbf  → OpenAIP vector tiles
 *   GET /core/airspaces?...     → OpenAIP Core airspaces API
 */

const TILES_ORIGIN = "https://api.tiles.openaip.net";
const CORE_ORIGIN = "https://api.core.openaip.net";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function copySearchParams(source, target, { skip = [] } = {}) {
  for (const [key, value] of source.searchParams) {
    if (skip.includes(key)) {
      continue;
    }
    target.searchParams.set(key, value);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: CORS });
    }

    const apiKey = env.OPENAIP_API_KEY;
    if (!apiKey) {
      return new Response("OPENAIP_API_KEY not configured on worker", {
        status: 500,
        headers: CORS,
      });
    }

    const url = new URL(request.url);
    const tileMatch = url.pathname.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (tileMatch) {
      const [, z, x, y] = tileMatch;
      const target = new URL(`${TILES_ORIGIN}/api/data/openaip/${z}/${x}/${y}.pbf`);
      copySearchParams(url, target, { skip: ["apiKey"] });
      target.searchParams.set("apiKey", apiKey);
      const upstream = await fetch(target.toString(), {
        method: request.method,
        headers: { Accept: request.headers.get("Accept") ?? "*/*" },
      });
      return withCors(upstream);
    }

    if (url.pathname === "/core/airspaces") {
      const target = new URL(`${CORE_ORIGIN}/api/airspaces`);
      copySearchParams(url, target, { skip: ["apiKey"] });
      target.searchParams.set("apiKey", apiKey);
      const upstream = await fetch(target.toString(), { method: request.method });
      return withCors(upstream);
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
