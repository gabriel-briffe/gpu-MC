export const CACHE_CELL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OPENAIP_CACHE_STORAGE_KEY = "gpu-mc-openaip-cache-v3";
const LEGACY_OPENAIP_CACHE_STORAGE_KEYS = [
  "gpu-mc-openaip-cache-v2",
  "gpu-mc-cell-cache-v1",
];

/** @type {string[]} Declared coverage cells (terrain / country resolution / geo clip). */
let lastCachedCellKeys = [];
/**
 * Shared OpenAIP payloads for the declared cells (not per-cell).
 * @type {{ airports: object[], airspaces: object[], fetchedAt: number, airportFetches: number, airspaceFetches: number, byteSize: number } | null}
 */
let openAipCache = null;

export function isOpenAipCacheFresh(now = Date.now()) {
  return openAipCache != null && now - openAipCache.fetchedAt < CACHE_CELL_TTL_MS;
}

function openAipStoragePayload() {
  return {
    version: 3,
    lastCachedCellKeys,
    openAip: openAipCache,
  };
}

function persistOpenAipCache() {
  if (typeof localStorage === "undefined") {
    return true;
  }
  const json = JSON.stringify(openAipStoragePayload());
  try {
    localStorage.setItem(OPENAIP_CACHE_STORAGE_KEY, json);
    return true;
  } catch (error) {
    console.warn("Failed to persist OpenAIP cache", error);
    try {
      localStorage.removeItem(OPENAIP_CACHE_STORAGE_KEY);
      localStorage.setItem(OPENAIP_CACHE_STORAGE_KEY, json);
      return true;
    } catch (retryError) {
      console.warn("Failed to persist OpenAIP cache after remove", retryError);
      return false;
    }
  }
}

function estimatePayloadBytes(airports, airspaces) {
  try {
    return new Blob([JSON.stringify(airports ?? []), JSON.stringify(airspaces ?? [])]).size;
  } catch {
    return (airports?.length ?? 0) * 900 + (airspaces?.length ?? 0) * 2500;
  }
}

export function initCellCacheFromStorage() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const raw = localStorage.getItem(OPENAIP_CACHE_STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      lastCachedCellKeys = Array.isArray(data.lastCachedCellKeys)
        ? data.lastCachedCellKeys
        : [];
      const payload = data.openAip ?? null;
      if (
        payload &&
        Array.isArray(payload.airports) &&
        Array.isArray(payload.airspaces) &&
        Number.isFinite(payload.fetchedAt) &&
        Date.now() - payload.fetchedAt < CACHE_CELL_TTL_MS
      ) {
        openAipCache = {
          airports: payload.airports,
          airspaces: payload.airspaces,
          fetchedAt: payload.fetchedAt,
          airportFetches: payload.airportFetches ?? 0,
          airspaceFetches: payload.airspaceFetches ?? 0,
          byteSize:
            Number.isFinite(payload.byteSize) && payload.byteSize > 0
              ? payload.byteSize
              : estimatePayloadBytes(payload.airports, payload.airspaces),
        };
      } else {
        openAipCache = null;
      }
    }
  } catch (error) {
    console.warn("Failed to load OpenAIP cache", error);
  }

  // Drop legacy 1° / per-cell stores (no migration — re-cache on 3° grid).
  try {
    for (const key of LEGACY_OPENAIP_CACHE_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

export function getCachedAirports() {
  return isOpenAipCacheFresh() ? openAipCache.airports : [];
}

export function getCachedAirspaces() {
  return isOpenAipCacheFresh() ? openAipCache.airspaces : [];
}

export function setOpenAipCache({
  airports,
  airspaces,
  airportFetches = 0,
  airspaceFetches = 0,
}) {
  const nextAirports = airports ?? [];
  const nextAirspaces = airspaces ?? [];
  openAipCache = {
    airports: nextAirports,
    airspaces: nextAirspaces,
    fetchedAt: Date.now(),
    airportFetches,
    airspaceFetches,
    byteSize: estimatePayloadBytes(nextAirports, nextAirspaces),
  };
  if (!persistOpenAipCache()) {
    console.warn(
      "OpenAIP cache is in memory but could not be saved to localStorage (quota?). It will be lost on reload."
    );
  }
}

/** True when a cell is in the declared coverage set (independent of OpenAIP TTL). */
export function isDeclaredCell(cellKey) {
  return lastCachedCellKeys.includes(cellKey);
}

export function getDeclaredCachedCellKeys() {
  return [...lastCachedCellKeys];
}

export function getLastCachedCellKeysForSelection() {
  return getDeclaredCachedCellKeys();
}

export function setLastCachedCellKeys(cellKeys) {
  lastCachedCellKeys = [...cellKeys];
  persistOpenAipCache();
}

export function clearAllCellCache() {
  openAipCache = null;
  lastCachedCellKeys = [];
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.removeItem(OPENAIP_CACHE_STORAGE_KEY);
    for (const key of LEGACY_OPENAIP_CACHE_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch (error) {
    console.warn("Failed to clear OpenAIP cache", error);
  }
}

/**
 * Open the cache page on startup when there is no usable OpenAIP payload.
 * Declared cells and terrain are independent — not part of this gate.
 */
export function needsStartupCacheMode() {
  return !hasOpenAipCacheData();
}

export function estimateOpenAipCacheBytes() {
  if (!openAipCache) {
    return 0;
  }
  if (Number.isFinite(openAipCache.byteSize) && openAipCache.byteSize > 0) {
    return openAipCache.byteSize;
  }
  return estimatePayloadBytes(openAipCache.airports, openAipCache.airspaces);
}

export function daysUntilOpenAipExpiry(now = Date.now()) {
  if (!openAipCache || !Number.isFinite(openAipCache.fetchedAt)) {
    return null;
  }
  if (!isOpenAipCacheFresh(now)) {
    return 0;
  }
  const remaining = CACHE_CELL_TTL_MS - (now - openAipCache.fetchedAt);
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}

/** True when a shared OpenAIP payload is loaded (clearable), even if empty arrays. */
export function hasOpenAipCacheData() {
  return openAipCache != null;
}

export function shouldWarnOpenAipExpiry(warnDays = 6, now = Date.now()) {
  const days = daysUntilOpenAipExpiry(now);
  return days !== null && days < warnDays;
}

/** Drop OpenAIP payloads; keeps lastCachedCellKeys for re-selection. */
export function clearAllOpenAipData() {
  openAipCache = null;
  if (!persistOpenAipCache()) {
    try {
      localStorage?.removeItem(OPENAIP_CACHE_STORAGE_KEY);
    } catch {
      // ignore
    }
    persistOpenAipCache();
  }
}

/** Keep only selected cell keys in the declaration list. */
export function purgeCellCacheExcept(keepCellKeys) {
  const keep = new Set(keepCellKeys);
  const next = lastCachedCellKeys.filter((cellKey) => keep.has(cellKey));
  if (next.length !== lastCachedCellKeys.length) {
    lastCachedCellKeys = next;
    persistOpenAipCache();
  }
}

/**
 * Remove cells from the declaration list.
 * Shared airport/airspace payloads are invalidated whenever the cell set changes
 * (they were built for the previous union and are no longer valid).
 */
export function removeCellKeysFromCache(cellKeys) {
  const remove = new Set(cellKeys);
  if (!remove.size) {
    return false;
  }
  const before = lastCachedCellKeys.length;
  lastCachedCellKeys = lastCachedCellKeys.filter((cellKey) => !remove.has(cellKey));
  if (lastCachedCellKeys.length !== before) {
    openAipCache = null;
    persistOpenAipCache();
    return true;
  }
  return false;
}

initCellCacheFromStorage();
