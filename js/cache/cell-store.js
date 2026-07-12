export const CACHE_CELL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CELL_CACHE_STORAGE_KEY = "gpu-mc-cell-cache-v1";

/** @type {Map<string, { cellKey: string, bounds: object, airports: object[], airspaces: object[], fetchedAt: number, airportFetches: number, airspaceFetches: number }>} */
const cellCache = new Map();
/** @type {string[]} Last cell keys passed to Cache (for re-select on reopen). */
let lastCachedCellKeys = [];

export function isCellCacheFresh(entry, now = Date.now()) {
  return entry != null && now - entry.fetchedAt < CACHE_CELL_TTL_MS;
}

function persistCellCache() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(
      CELL_CACHE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        cells: Object.fromEntries(cellCache),
        lastCachedCellKeys,
      })
    );
  } catch (error) {
    console.warn("Failed to persist airport cell cache", error);
  }
}

function purgeExpiredCellCache(now = Date.now()) {
  let changed = false;
  for (const [cellKey, entry] of cellCache) {
    if (!isCellCacheFresh(entry, now)) {
      cellCache.delete(cellKey);
      changed = true;
    }
  }
  if (changed) {
    persistCellCache();
  }
}

export function initCellCacheFromStorage() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const raw = localStorage.getItem(CELL_CACHE_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const [cellKey, entry] of Object.entries(data.cells ?? {})) {
      if (isCellCacheFresh(entry, now)) {
        cellCache.set(cellKey, entry);
      }
    }
    lastCachedCellKeys = Array.isArray(data.lastCachedCellKeys) ? data.lastCachedCellKeys : [];
  } catch (error) {
    console.warn("Failed to load airport cell cache", error);
  }
  purgeExpiredCellCache();
}

export function getCellEntry(cellKey) {
  return cellCache.get(cellKey);
}

export function setCellEntry(cellKey, entry) {
  cellCache.set(cellKey, entry);
  persistCellCache();
}

export function getDeclaredCachedCellKeys() {
  return [...lastCachedCellKeys];
}

export function getLastCachedCellKeysForSelection() {
  return getDeclaredCachedCellKeys();
}

export function setLastCachedCellKeys(cellKeys) {
  lastCachedCellKeys = [...cellKeys];
  persistCellCache();
}

export function clearAllCellCache() {
  cellCache.clear();
  lastCachedCellKeys = [];
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.removeItem(CELL_CACHE_STORAGE_KEY);
  } catch (error) {
    console.warn("Failed to clear airport cell cache", error);
  }
}

export function isCellCached(cellKey) {
  return isCellCacheFresh(cellCache.get(cellKey));
}

export function isCellFullyCached(cellKey) {
  const entry = cellCache.get(cellKey);
  if (!isCellCacheFresh(entry)) {
    return false;
  }
  return Array.isArray(entry.airports) && Array.isArray(entry.airspaces);
}

export function needsStartupCacheMode() {
  const declared = getDeclaredCachedCellKeys();
  if (declared.length === 0) {
    return true;
  }
  return declared.some((cellKey) => !isCellFullyCached(cellKey));
}

export function getCachedCellKeys() {
  return [...cellCache.keys()];
}

initCellCacheFromStorage();
