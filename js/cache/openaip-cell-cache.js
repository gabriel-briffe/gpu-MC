/**
 * Per-cell OpenAIP airport / airspace cache (Cache API) — 1 week TTL.
 * Also clears legacy browser cache names from older GCS / OurAirports paths.
 */

export const OPENAIP_CELL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AIRPORT_CELL_TTL_MS = OPENAIP_CELL_TTL_MS;
export const AIRSPACE_CELL_TTL_MS = OPENAIP_CELL_TTL_MS;

const AIRPORT_CACHE_NAME = "gpu-mc-airport-cells-v1";
const AIRSPACE_CACHE_NAME = "gpu-mc-airspace-cells-v1";
const CACHED_AT_HEADER = "x-gpu-mc-cached-at";

/** Leftover Cache API buckets from GCS country exports / OurAirports CSV. */
const LEGACY_CACHE_NAMES = [
  "gpu-mc-openaip-exports-v1",
  "gpu-mc-ourairports-csv-v1",
];

function cachesAvailable() {
  return typeof caches !== "undefined" && typeof caches.open === "function";
}

async function openNamedCache(cacheName) {
  if (!cachesAvailable()) {
    return null;
  }
  return caches.open(cacheName);
}

function cellRequest(kind, cellKey) {
  return new Request(
    `https://gpu-mc.local/${kind}-cell/${encodeURIComponent(String(cellKey))}`
  );
}

function cellKeyFromRequestUrl(kind, url) {
  const match = String(url).match(
    new RegExp(`/${kind}-cell/([^/?#]+)`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * @param {"airport"|"airspace"} kind
 * @param {string} payloadKey - "airports" | "airspaces"
 */
function createCellCacheApi(kind, payloadKey, cacheName) {
  async function getCachedForCell(cellKey, now = Date.now()) {
    const cache = await openNamedCache(cacheName);
    if (!cache || !cellKey) {
      return null;
    }
    try {
      const match = await cache.match(cellRequest(kind, cellKey));
      if (!match?.ok) {
        return null;
      }
      const fetchedAt = Number(match.headers.get(CACHED_AT_HEADER));
      if (!Number.isFinite(fetchedAt) || now - fetchedAt >= OPENAIP_CELL_TTL_MS) {
        await cache.delete(cellRequest(kind, cellKey));
        return null;
      }
      const data = await match.json();
      if (!Array.isArray(data?.[payloadKey])) {
        return null;
      }
      return { [payloadKey]: data[payloadKey], fetchedAt };
    } catch (error) {
      console.warn(`${kind} cell cache read failed`, cellKey, error);
      return null;
    }
  }

  async function putCachedForCell(cellKey, items, fetchedAt = Date.now()) {
    const cache = await openNamedCache(cacheName);
    if (!cache || !cellKey) {
      return false;
    }
    try {
      const headers = new Headers({
        "Content-Type": "application/json",
        [CACHED_AT_HEADER]: String(fetchedAt),
      });
      await cache.put(
        cellRequest(kind, cellKey),
        new Response(
          JSON.stringify({
            version: 1,
            cellKey,
            fetchedAt,
            [payloadKey]: items ?? [],
          }),
          { status: 200, statusText: "OK", headers }
        )
      );
      return true;
    } catch (error) {
      console.warn(`${kind} cell cache write failed`, cellKey, error);
      return false;
    }
  }

  async function deleteCachedForCell(cellKey) {
    const cache = await openNamedCache(cacheName);
    if (!cache || !cellKey) {
      return;
    }
    try {
      await cache.delete(cellRequest(kind, cellKey));
    } catch (error) {
      console.warn(`${kind} cell cache delete failed`, cellKey, error);
    }
  }

  async function pruneExcept(keepCellKeys, now = Date.now()) {
    const cache = await openNamedCache(cacheName);
    if (!cache) {
      return { removed: 0 };
    }
    const keep = new Set((keepCellKeys ?? []).map(String));
    let removed = 0;
    try {
      const keys = await cache.keys();
      for (const request of keys) {
        const cellKey = cellKeyFromRequestUrl(kind, request.url);
        if (!cellKey || !keep.has(cellKey)) {
          await cache.delete(request);
          removed += 1;
          continue;
        }
        const response = await cache.match(request);
        const fetchedAt = Number(response?.headers.get(CACHED_AT_HEADER));
        if (!Number.isFinite(fetchedAt) || now - fetchedAt >= OPENAIP_CELL_TTL_MS) {
          await cache.delete(request);
          removed += 1;
        }
      }
    } catch (error) {
      console.warn(`${kind} cell cache prune failed`, error);
    }
    return { removed };
  }

  async function clearCache() {
    if (!cachesAvailable()) {
      return;
    }
    try {
      await caches.delete(cacheName);
    } catch (error) {
      console.warn(`Failed to clear ${kind} cell cache`, error);
    }
  }

  function isFresh(fetchedAt, now = Date.now()) {
    return Number.isFinite(fetchedAt) && now - fetchedAt < OPENAIP_CELL_TTL_MS;
  }

  return {
    getCachedForCell,
    putCachedForCell,
    deleteCachedForCell,
    pruneExcept,
    clearCache,
    isFresh,
  };
}

const airportsApi = createCellCacheApi("airport", "airports", AIRPORT_CACHE_NAME);
const airspacesApi = createCellCacheApi("airspace", "airspaces", AIRSPACE_CACHE_NAME);

export async function getCachedAirportsForCell(cellKey, now = Date.now()) {
  const hit = await airportsApi.getCachedForCell(cellKey, now);
  return hit ? { airports: hit.airports, fetchedAt: hit.fetchedAt } : null;
}

export async function putCachedAirportsForCell(cellKey, airports, fetchedAt = Date.now()) {
  return airportsApi.putCachedForCell(cellKey, airports, fetchedAt);
}

export async function deleteCachedAirportsForCell(cellKey) {
  return airportsApi.deleteCachedForCell(cellKey);
}

export async function pruneAirportCellCacheExcept(keepCellKeys, now = Date.now()) {
  return airportsApi.pruneExcept(keepCellKeys, now);
}

export async function clearAirportCellCache() {
  return airportsApi.clearCache();
}

export function isAirportCellCacheFresh(fetchedAt, now = Date.now()) {
  return airportsApi.isFresh(fetchedAt, now);
}

export async function getCachedAirspacesForCell(cellKey, now = Date.now()) {
  const hit = await airspacesApi.getCachedForCell(cellKey, now);
  return hit ? { airspaces: hit.airspaces, fetchedAt: hit.fetchedAt } : null;
}

export async function putCachedAirspacesForCell(cellKey, airspaces, fetchedAt = Date.now()) {
  return airspacesApi.putCachedForCell(cellKey, airspaces, fetchedAt);
}

export async function deleteCachedAirspacesForCell(cellKey) {
  return airspacesApi.deleteCachedForCell(cellKey);
}

export async function pruneAirspaceCellCacheExcept(keepCellKeys, now = Date.now()) {
  return airspacesApi.pruneExcept(keepCellKeys, now);
}

export async function clearAirspaceCellCache() {
  return airspacesApi.clearCache();
}

export function isAirspaceCellCacheFresh(fetchedAt, now = Date.now()) {
  return airspacesApi.isFresh(fetchedAt, now);
}

/** Drop leftover Cache API buckets from GCS / OurAirports eras. */
export async function clearLegacyOpenAipBrowserCaches() {
  if (!cachesAvailable()) {
    return;
  }
  for (const name of LEGACY_CACHE_NAMES) {
    try {
      await caches.delete(name);
    } catch (error) {
      console.warn(`Failed to clear legacy cache ${name}`, error);
    }
  }
}

/** Clear live cell caches plus legacy buckets. */
export async function clearAllOpenAipCellCaches() {
  await clearAirportCellCache();
  await clearAirspaceCellCache();
  await clearLegacyOpenAipBrowserCaches();
}
