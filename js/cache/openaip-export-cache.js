/** One-day cache for raw OpenAIP GCS country exports (apt/asp GeoJSON) before clipping. */

const EXPORT_CACHE_NAME = "gpu-mc-openaip-exports-v1";
export const OPENAIP_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const CACHED_AT_HEADER = "x-gpu-mc-cached-at";

function cachesAvailable() {
  return typeof caches !== "undefined" && typeof caches.open === "function";
}

async function openExportCache() {
  if (!cachesAvailable()) {
    return null;
  }
  return caches.open(EXPORT_CACHE_NAME);
}

/**
 * Fetch a country export URL as JSON, reusing Cache API entries younger than 1 day.
 * @returns {{ json: object|null, fromNetwork: boolean, status: number }}
 */
export async function fetchCountryExportJson(url) {
  if (!url) {
    return { json: null, fromNetwork: false, status: 0 };
  }

  const cache = await openExportCache();
  if (cache) {
    try {
      const cached = await cache.match(url);
      if (cached) {
        const cachedAt = Number(cached.headers.get(CACHED_AT_HEADER));
        if (Number.isFinite(cachedAt) && Date.now() - cachedAt < OPENAIP_EXPORT_TTL_MS) {
          if (cached.ok) {
            return { json: await cached.json(), fromNetwork: false, status: cached.status };
          }
          return { json: null, fromNetwork: false, status: cached.status };
        }
        await cache.delete(url);
      }
    } catch (error) {
      console.warn("OpenAIP export cache read failed", error);
    }
  }

  const response = await fetch(url);
  const status = response.status;

  if (cache && (response.ok || status === 404)) {
    try {
      const headers = new Headers(response.headers);
      headers.set(CACHED_AT_HEADER, String(Date.now()));
      headers.set("Content-Type", response.headers.get("Content-Type") ?? "application/json");
      const body = await response.clone().arrayBuffer();
      await cache.put(
        url,
        new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      );
    } catch (error) {
      console.warn("OpenAIP export cache write failed", error);
    }
  }

  if (status === 404) {
    return { json: null, fromNetwork: true, status };
  }
  if (!response.ok) {
    return { json: null, fromNetwork: true, status };
  }

  return { json: await response.json(), fromNetwork: true, status };
}

/** Drop all cached country export files (optional; TTL also expires them). */
export async function clearOpenAipExportCache() {
  if (!cachesAvailable()) {
    return;
  }
  try {
    await caches.delete(EXPORT_CACHE_NAME);
  } catch (error) {
    console.warn("Failed to clear OpenAIP export cache", error);
  }
}
