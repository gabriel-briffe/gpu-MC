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
 *   GET /core/airports?...      → OpenAIP Core airports API
 *
 * Edge-caches successful upstream responses for 7 days.
 * Client-facing Cache-Control is no-store (browsers must not freeze MISS).
 */

const TILES_ORIGIN = "https://api.tiles.openaip.net";
const CORE_ORIGIN = "https://api.core.openaip.net";

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "X-GPU-MC-Cache, X-GPU-MC-Cache-Layer, CF-Cache-Status",
};

const STRIP_UPSTREAM_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "vary",
]);

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) {
    headers.set(key, value);
  }
  headers.set("Cache-Control", "no-store");
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
    target.searchParams.append(key, value);
  }
}

function copySafeHeaders(from) {
  const headers = new Headers();
  from.forEach((value, key) => {
    if (STRIP_UPSTREAM_HEADERS.has(key.toLowerCase())) {
      return;
    }
    headers.set(key, value);
  });
  return headers;
}

async function fetchUpstreamCached(upstreamUrl, init = {}) {
  const cache = caches.default;
  const cacheKey = new Request(upstreamUrl, { method: "GET" });

  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const headers = copySafeHeaders(cached.headers);
      headers.set("X-GPU-MC-Cache", "HIT");
      headers.set("X-GPU-MC-Cache-Layer", "cache-api");
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers,
      });
    }
  } catch {
    // Cache API unavailable on some setups.
  }

  const upstream = await fetch(upstreamUrl, {
    method: "GET",
    headers: init.headers,
    cf: {
      cacheTtl: CACHE_TTL_SECONDS,
      cacheEverything: true,
    },
  });

  const cfStatus = (upstream.headers.get("CF-Cache-Status") || "").toUpperCase();
  const cfHit = cfStatus === "HIT" || cfStatus === "REVALIDATED" || cfStatus === "UPDATING";

  const headers = copySafeHeaders(upstream.headers);
  headers.set("X-GPU-MC-Cache", cfHit ? "HIT" : "MISS");
  headers.set("X-GPU-MC-Cache-Layer", cfHit ? "cf-fetch" : "origin");
  if (cfStatus) {
    headers.set("CF-Cache-Status", cfStatus);
  }

  const body = await upstream.arrayBuffer();
  const response = new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  if (upstream.ok) {
    try {
      const storeHeaders = new Headers(headers);
      storeHeaders.set(
        "Cache-Control",
        `public, max-age=${CACHE_TTL_SECONDS}`
      );
      await cache.put(
        cacheKey,
        new Response(body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: storeHeaders,
        })
      );
    } catch {
      // ignore
    }
  }

  return response;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: CORS });
    }

    const url = new URL(request.url);
    const apiKey = env.OPENAIP_API_KEY;
    if (!apiKey) {
      return new Response("OPENAIP_API_KEY not configured on worker", {
        status: 500,
        headers: CORS,
      });
    }

    const tileMatch = url.pathname.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (tileMatch) {
      const [, z, x, y] = tileMatch;
      const target = new URL(`${TILES_ORIGIN}/api/data/openaip/${z}/${x}/${y}.pbf`);
      copySearchParams(url, target, { skip: ["apiKey"] });
      target.searchParams.set("apiKey", apiKey);
      const upstream = await fetchUpstreamCached(target.toString(), {
        headers: { Accept: request.headers.get("Accept") ?? "*/*" },
      });
      return withCors(upstream);
    }

    if (url.pathname === "/core/airspaces") {
      const target = new URL(`${CORE_ORIGIN}/api/airspaces`);
      copySearchParams(url, target, { skip: ["apiKey"] });
      target.searchParams.set("apiKey", apiKey);
      const upstream = await fetchUpstreamCached(target.toString());
      return withCors(upstream);
    }

    if (url.pathname === "/core/airports") {
      const target = new URL(`${CORE_ORIGIN}/api/airports`);
      copySearchParams(url, target, { skip: ["apiKey"] });
      target.searchParams.set("apiKey", apiKey);
      const upstream = await fetchUpstreamCached(target.toString());
      return withCors(upstream);
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
