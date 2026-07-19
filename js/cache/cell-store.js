export const CACHE_CELL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OPENAIP_CACHE_STORAGE_KEY = "gpu-mc-openaip-cache-v2";
const LEGACY_CELL_CACHE_STORAGE_KEY = "gpu-mc-cell-cache-v1";

/** @type {string[]} Cells selected for cache (terrain / country resolution). */
let lastCachedCellKeys = [];
/** @type {{ airports: object[], airspaces: object[], fetchedAt: number, airportFetches: number, airspaceFetches: number } | null} */
let openAipCache = null;

export function isOpenAipCacheFresh(now = Date.now()) {
  return openAipCache != null && now - openAipCache.fetchedAt < CACHE_CELL_TTL_MS;
}

export function isCellCacheFresh(entry, now = Date.now()) {
  // Legacy helper name — freshness is global for OpenAIP payloads.
  return isOpenAipCacheFresh(now) && entry != null;
}

function persistOpenAipCache() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(
      OPENAIP_CACHE_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        lastCachedCellKeys,
        openAip: openAipCache,
      })
    );
  } catch (error) {
    console.warn("Failed to persist OpenAIP cache", error);
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
        };
      } else {
        openAipCache = null;
      }
    }
  } catch (error) {
    console.warn("Failed to load OpenAIP cache", error);
  }

  // Drop legacy per-cell payload store (no migration — re-cache).
  try {
    localStorage.removeItem(LEGACY_CELL_CACHE_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** @deprecated Per-cell entries no longer exist; returns a stub when the cell is declared. */
export function getCellEntry(cellKey) {
  if (!lastCachedCellKeys.includes(cellKey) || !isOpenAipCacheFresh()) {
    return null;
  }
  return {
    cellKey,
    airports: openAipCache.airports,
    airspaces: openAipCache.airspaces,
    fetchedAt: openAipCache.fetchedAt,
  };
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
  openAipCache = {
    airports: airports ?? [],
    airspaces: airspaces ?? [],
    fetchedAt: Date.now(),
    airportFetches,
    airspaceFetches,
  };
  persistOpenAipCache();
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
    localStorage.removeItem(LEGACY_CELL_CACHE_STORAGE_KEY);
  } catch (error) {
    console.warn("Failed to clear OpenAIP cache", error);
  }
}

export function isCellCached(cellKey) {
  return isOpenAipCacheFresh() && lastCachedCellKeys.includes(cellKey);
}

export function isCellFullyCached(cellKey) {
  return isCellCached(cellKey);
}

export function needsStartupCacheMode() {
  const declared = getDeclaredCachedCellKeys();
  if (declared.length === 0) {
    return true;
  }
  return !isOpenAipCacheFresh();
}

export function getCachedCellKeys() {
  return isOpenAipCacheFresh() ? [...lastCachedCellKeys] : [];
}

export function estimateOpenAipCacheBytes() {
  if (!isOpenAipCacheFresh()) {
    return 0;
  }
  return new Blob([
    JSON.stringify(openAipCache.airports ?? []),
    JSON.stringify(openAipCache.airspaces ?? []),
  ]).size;
}

export function daysUntilOpenAipExpiry(now = Date.now()) {
  if (!isOpenAipCacheFresh(now)) {
    return null;
  }
  const remaining = CACHE_CELL_TTL_MS - (now - openAipCache.fetchedAt);
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}

export function hasOpenAipCacheData() {
  return isOpenAipCacheFresh();
}

export function shouldWarnOpenAipExpiry(warnDays = 6, now = Date.now()) {
  const days = daysUntilOpenAipExpiry(now);
  return days !== null && days < warnDays;
}

/** Drop OpenAIP payloads; keeps lastCachedCellKeys for re-selection. */
export function clearAllOpenAipData() {
  openAipCache = null;
  persistOpenAipCache();
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

/** Remove specific cells from the selection list. */
export function removeCellKeysFromCache(cellKeys) {
  const remove = new Set(cellKeys);
  if (!remove.size) {
    return false;
  }
  const before = lastCachedCellKeys.length;
  lastCachedCellKeys = lastCachedCellKeys.filter((cellKey) => !remove.has(cellKey));
  if (lastCachedCellKeys.length !== before) {
    if (lastCachedCellKeys.length === 0) {
      openAipCache = null;
    }
    persistOpenAipCache();
    return true;
  }
  return false;
}

initCellCacheFromStorage();
