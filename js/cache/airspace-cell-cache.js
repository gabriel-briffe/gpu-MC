/** Per-cell OpenAIP airspace cache (Cache API) — 1 week TTL. */

export const AIRSPACE_CELL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_NAME = "gpu-mc-airspace-cells-v1";
const CACHED_AT_HEADER = "x-gpu-mc-cached-at";

function cachesAvailable() {
  return typeof caches !== "undefined" && typeof caches.open === "function";
}

async function openCache() {
  if (!cachesAvailable()) {
    return null;
  }
  return caches.open(CACHE_NAME);
}

function cellRequest(cellKey) {
  return new Request(
    `https://gpu-mc.local/airspace-cell/${encodeURIComponent(String(cellKey))}`
  );
}

/**
 * @returns {{ airspaces: object[], fetchedAt: number } | null}
 */
export async function getCachedAirspacesForCell(cellKey, now = Date.now()) {
  const cache = await openCache();
  if (!cache || !cellKey) {
    return null;
  }
  try {
    const match = await cache.match(cellRequest(cellKey));
    if (!match?.ok) {
      return null;
    }
    const fetchedAt = Number(match.headers.get(CACHED_AT_HEADER));
    if (!Number.isFinite(fetchedAt) || now - fetchedAt >= AIRSPACE_CELL_TTL_MS) {
      await cache.delete(cellRequest(cellKey));
      return null;
    }
    const data = await match.json();
    if (!Array.isArray(data?.airspaces)) {
      return null;
    }
    return { airspaces: data.airspaces, fetchedAt };
  } catch (error) {
    console.warn("Airspace cell cache read failed", cellKey, error);
    return null;
  }
}

export async function putCachedAirspacesForCell(cellKey, airspaces, fetchedAt = Date.now()) {
  const cache = await openCache();
  if (!cache || !cellKey) {
    return false;
  }
  try {
    const headers = new Headers({
      "Content-Type": "application/json",
      [CACHED_AT_HEADER]: String(fetchedAt),
    });
    await cache.put(
      cellRequest(cellKey),
      new Response(
        JSON.stringify({
          version: 1,
          cellKey,
          fetchedAt,
          airspaces: airspaces ?? [],
        }),
        { status: 200, statusText: "OK", headers }
      )
    );
    return true;
  } catch (error) {
    console.warn("Airspace cell cache write failed", cellKey, error);
    return false;
  }
}

export async function deleteCachedAirspacesForCell(cellKey) {
  const cache = await openCache();
  if (!cache || !cellKey) {
    return;
  }
  try {
    await cache.delete(cellRequest(cellKey));
  } catch (error) {
    console.warn("Airspace cell cache delete failed", cellKey, error);
  }
}

/** Drop entries not in keepCellKeys (and expired ones). */
export async function pruneAirspaceCellCacheExcept(keepCellKeys, now = Date.now()) {
  const cache = await openCache();
  if (!cache) {
    return { removed: 0 };
  }
  const keep = new Set((keepCellKeys ?? []).map(String));
  let removed = 0;
  try {
    const keys = await cache.keys();
    for (const request of keys) {
      const url = String(request.url);
      const match = url.match(/\/airspace-cell\/([^/?#]+)/);
      const cellKey = match ? decodeURIComponent(match[1]) : null;
      if (!cellKey || !keep.has(cellKey)) {
        await cache.delete(request);
        removed += 1;
        continue;
      }
      const response = await cache.match(request);
      const fetchedAt = Number(response?.headers.get(CACHED_AT_HEADER));
      if (!Number.isFinite(fetchedAt) || now - fetchedAt >= AIRSPACE_CELL_TTL_MS) {
        await cache.delete(request);
        removed += 1;
      }
    }
  } catch (error) {
    console.warn("Airspace cell cache prune failed", error);
  }
  return { removed };
}

export async function clearAirspaceCellCache() {
  if (!cachesAvailable()) {
    return;
  }
  try {
    await caches.delete(CACHE_NAME);
  } catch (error) {
    console.warn("Failed to clear airspace cell cache", error);
  }
}

export function isAirspaceCellCacheFresh(fetchedAt, now = Date.now()) {
  return Number.isFinite(fetchedAt) && now - fetchedAt < AIRSPACE_CELL_TTL_MS;
}
