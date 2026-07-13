const SHELL_CACHE = "gpu-mc-shell-f54e96fbe4";
const PRECACHE_URLS = ["index.html","app.min.js","app.min.css","manifest.webmanifest","sw-register.js","sw.js","icons/icon.svg","vendor/maplibre-gl/maplibre-gl.js","vendor/maplibre-gl/maplibre-gl.css","vendor/maplibre-gl/maplibre-gl-csp-worker.js","vendor/gribinfo/gribinfo_bg.wasm","vendor/idw-regrid/idw_regrid_bg.wasm","sprites/sprite.json","sprites/sprite.png","sprites/sprite@2x.json","sprites/sprite@2x.png"];

/** Service worker — SHELL_CACHE and PRECACHE_URLS are injected by scripts/build.mjs. */

const GLYPH_CACHE = "gpu-mc-glyphs-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("gpu-mc-shell-") && key !== SHELL_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.hostname === "demotiles.maplibre.org" || url.hostname === "protomaps.github.io") {
    event.respondWith(cacheGlyphRequest(request));
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request, "index.html"));
    return;
  }

  event.respondWith(staleWhileRevalidateShell(request));
});

async function cacheGlyphRequest(request) {
  const cache = await caches.open(GLYPH_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function networkFirstShell(request, fallbackPath) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      if (fallbackPath) {
        await cache.put(fallbackPath, response.clone());
      }
    }
    return response;
  } catch {
    const cached =
      (await cache.match(request)) || (fallbackPath ? await cache.match(fallbackPath) : null);
    if (cached) {
      return cached;
    }
    return Response.error();
  }
}

async function staleWhileRevalidateShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    void networkPromise;
    return cached;
  }

  const response = await networkPromise;
  if (response) {
    return response;
  }
  return Response.error();
}
