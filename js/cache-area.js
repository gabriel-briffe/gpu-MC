import { TILE_SIZE, lngLatToGlobalPixel } from "./geo.js";
import { fetchTerrainTileBlob } from "./terrain-tiles.js";
import { airspacesToGeoJsonFeatures, dedupeAirspaces, fetchOverlayAirspaces } from "./airspace.js";
import { dedupeAirports, fetchAirportsInBbox } from "./openaip-airports.js";
import { openAipConfigured } from "./openaip-client.js";
import { airportPropertiesWithId } from "./airports/airport-id.js";

export const CACHE_TERRAIN_Z_MIN = 3;
export const CACHE_TERRAIN_Z_MAX = 9;
export const CACHE_CELL_TTL_MS = 24 * 60 * 60 * 1000;
const TERRAIN_PREFETCH_CONCURRENCY = 8;
const CELL_CACHE_STORAGE_KEY = "gpu-mc-cell-cache-v1";

/** @type {Map<string, { cellKey: string, bounds: object, airports: object[], airspaces: object[], fetchedAt: number, airportFetches: number, airspaceFetches: number }>} */
const cellCache = new Map();
/** @type {string[]} Last cell keys passed to Cache (for re-select on reopen). */
let lastCachedCellKeys = [];

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
  lastCachedCellKeys = lastCachedCellKeys.filter((cellKey) => isCellCached(cellKey));
}

/** Cell keys from the last Cache action, still fresh — pre-select in cache mode. */
export function getLastCachedCellKeysForSelection() {
  return lastCachedCellKeys.filter((cellKey) => isCellCached(cellKey));
}

export function setLastCachedCellKeys(cellKeys) {
  lastCachedCellKeys = [...cellKeys];
  persistCellCache();
}

export function isCellCached(cellKey) {
  return isCellCacheFresh(cellCache.get(cellKey));
}

export function hasCachedAreas() {
  return cellCache.size > 0;
}

export function getCachedCellKeys() {
  return [...cellCache.keys()];
}

export function getCachedCellEntry(cellKey) {
  return cellCache.get(cellKey) ?? null;
}

export function isCellCacheFresh(entry, now = Date.now()) {
  return entry != null && now - entry.fetchedAt < CACHE_CELL_TTL_MS;
}

export function cacheCellKey(lng, lat) {
  return `${Math.floor(lng)},${Math.floor(lat)}`;
}

export function cacheCellBounds(cellKey) {
  const [west, south] = cellKey.split(",").map(Number);
  return {
    west,
    south,
    east: west + 1,
    north: south + 1,
  };
}

/** 1° grid cells intersecting a bbox (west/south/east/north in degrees). */
export function cellKeysInBbox(west, south, east, north) {
  const minLng = Math.floor(west);
  const maxLng = Math.ceil(east);
  const minLat = Math.max(-85, Math.floor(south));
  const maxLat = Math.min(85, Math.ceil(north));
  const cellKeys = [];

  for (let lng = minLng; lng < maxLng; lng += 1) {
    for (let lat = minLat; lat < maxLat; lat += 1) {
      cellKeys.push(`${lng},${lat}`);
    }
  }

  return cellKeys;
}

export function getFreshCachedCellKeysInBbox(west, south, east, north) {
  return cellKeysInBbox(west, south, east, north).filter((cellKey) => isCellCached(cellKey));
}

export function isLngLatInCachedCell(lng, lat) {
  return isCellCached(cacheCellKey(lng, lat));
}

/** Intersect a bbox with the union of fresh cached 1° cells overlapping it. */
export function clipBoundsToCachedCells(bounds) {
  const cellKeys = getFreshCachedCellKeysInBbox(
    bounds.west,
    bounds.south,
    bounds.east,
    bounds.north
  );
  if (cellKeys.length === 0) {
    return null;
  }

  const cachedUnion = unionCellBounds(cellKeys);
  const clipped = {
    west: Math.max(bounds.west, cachedUnion.west),
    south: Math.max(bounds.south, cachedUnion.south),
    east: Math.min(bounds.east, cachedUnion.east),
    north: Math.min(bounds.north, cachedUnion.north),
  };

  if (clipped.west >= clipped.east || clipped.south >= clipped.north) {
    return null;
  }

  return clipped;
}

export const MISSING_CACHED_AIRSPACE_MSG =
  "No cached airspace for this area — use Cache data or disable include prohibited airspace";

/** Grid bounds for compute: clip to cached cells only when airspace capping needs cached OpenAIP. */
export function resolveComputeGridBounds(bounds, { requireCachedAirspace = false } = {}) {
  if (!requireCachedAirspace) {
    return bounds;
  }
  return clipBoundsToCachedCells(bounds);
}

export function getCachedOverlayAirspaces(west, south, east, north) {
  const cellKeys = getFreshCachedCellKeysInBbox(west, south, east, north);
  return mergeCachedAirspaces(cellKeys).filter(
    (airspace) =>
      airspace.bbox.maxLng >= west &&
      airspace.bbox.minLng <= east &&
      airspace.bbox.maxLat >= south &&
      airspace.bbox.minLat <= north
  );
}

export function unionCellBounds(cellKeys) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const cellKey of cellKeys) {
    const bounds = cacheCellBounds(cellKey);
    west = Math.min(west, bounds.west);
    south = Math.min(south, bounds.south);
    east = Math.max(east, bounds.east);
    north = Math.max(north, bounds.north);
  }

  return { west, south, east, north };
}

export function terrariumTileIndicesForBounds(west, south, east, north, z) {
  const nw = lngLatToGlobalPixel(west, north, z);
  const se = lngLatToGlobalPixel(east, south, z);
  const minTileX = Math.floor(Math.min(nw.gx, se.gx) / TILE_SIZE);
  const maxTileX = Math.floor(Math.max(nw.gx, se.gx) / TILE_SIZE);
  const minTileY = Math.floor(Math.min(nw.gy, se.gy) / TILE_SIZE);
  const maxTileY = Math.floor(Math.max(nw.gy, se.gy) / TILE_SIZE);
  const tiles = [];

  for (let ty = minTileY; ty <= maxTileY; ty += 1) {
    for (let tx = minTileX; tx <= maxTileX; tx += 1) {
      tiles.push({ z, x: tx, y: ty });
    }
  }

  return tiles;
}

async function prefetchTerrariumTiles(bounds, onStatus) {
  const jobs = [];
  for (let z = CACHE_TERRAIN_Z_MIN; z <= CACHE_TERRAIN_Z_MAX; z += 1) {
    jobs.push(...terrariumTileIndicesForBounds(bounds.west, bounds.south, bounds.east, bounds.north, z));
  }

  if (jobs.length === 0) {
    return { tileCount: 0, tileFetches: 0 };
  }

  let loaded = 0;
  let tileFetches = 0;
  onStatus?.(`Caching terrarium tiles 0/${jobs.length} (z${CACHE_TERRAIN_Z_MIN}–${CACHE_TERRAIN_Z_MAX})…`);

  for (let index = 0; index < jobs.length; index += TERRAIN_PREFETCH_CONCURRENCY) {
    const batch = jobs.slice(index, index + TERRAIN_PREFETCH_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ z, x, y }) => {
        const { fromNetwork } = await fetchTerrainTileBlob(z, x, y);
        if (fromNetwork) {
          tileFetches += 1;
        }
        loaded += 1;
        onStatus?.(`Caching terrarium tiles ${loaded}/${jobs.length} (z${CACHE_TERRAIN_Z_MIN}–${CACHE_TERRAIN_Z_MAX})…`);
      })
    );
  }

  return { tileCount: jobs.length, tileFetches };
}

async function cacheAirportsForCells(cellKeys, config, onStatus) {
  let airportFetches = 0;
  let cellsFetched = 0;
  let cellsSkipped = 0;

  for (let index = 0; index < cellKeys.length; index += 1) {
    const cellKey = cellKeys[index];
    const existing = cellCache.get(cellKey);
    if (isCellCacheFresh(existing)) {
      cellsSkipped += 1;
      onStatus?.(
        `Airports — cell ${index + 1}/${cellKeys.length} (${cellKey}) fresh (<24h), kept cached`
      );
      continue;
    }

    onStatus?.(`Fetching airports & airspace — cell ${index + 1}/${cellKeys.length} (${cellKey})…`);
    const bounds = cacheCellBounds(cellKey);
    const [{ airports, fetchCount }, airspaces] = await Promise.all([
      fetchAirportsInBbox(bounds, config),
      fetchOverlayAirspaces(
        {
          minLng: bounds.west,
          minLat: bounds.south,
          maxLng: bounds.east,
          maxLat: bounds.north,
        },
        config
      ),
    ]);
    airportFetches += fetchCount;
    cellsFetched += 1;

    cellCache.set(cellKey, {
      cellKey,
      bounds,
      airports,
      airspaces,
      fetchedAt: Date.now(),
      airportFetches: fetchCount,
      airspaceFetches: 1,
    });
  }

  persistCellCache();
  return { airportFetches, cellsFetched, cellsSkipped };
}

/**
 * @deprecated OpenAIP REST data is only fetched via Cache mode ({@link buildCacheBundle}).
 */
export async function ensureAirportCellsCachedForBbox(bbox, config, onStatus) {
  const cellKeys = cellKeysInBbox(bbox.west, bbox.south, bbox.east, bbox.north);
  if (cellKeys.length === 0) {
    return { cellKeys, airportFetches: 0, cellsFetched: 0, cellsSkipped: 0 };
  }

  const stats = await cacheAirportsForCells(cellKeys, config, onStatus);
  return { cellKeys, ...stats };
}

/** Merge cached per-cell airport lists for display (deduped at read time). */
export function mergeCachedAirports(cellKeys = null) {
  const keys = cellKeys ?? getCachedCellKeys();
  const all = [];

  for (const cellKey of keys) {
    const entry = cellCache.get(cellKey);
    if (entry?.airports?.length) {
      all.push(...entry.airports);
    }
  }

  return dedupeAirports(all);
}

/** Merge cached per-cell REST airspace lists for display (deduped at read time). */
export function mergeCachedAirspaces(cellKeys = null) {
  const keys = cellKeys ?? getCachedCellKeys();
  const all = [];

  for (const cellKey of keys) {
    const entry = cellCache.get(cellKey);
    if (entry?.airspaces?.length) {
      all.push(...entry.airspaces);
    }
  }

  return dedupeAirspaces(all);
}

export function mergedCachedAirspacesToGeoJsonFeatures(cellKeys = null) {
  return airspacesToGeoJsonFeatures(mergeCachedAirspaces(cellKeys));
}

export function cachedAirspacesToGeoJsonFeatures(west, south, east, north) {
  const cellKeys = cellKeysInBbox(west, south, east, north);
  return airspacesToGeoJsonFeatures(
    mergeCachedAirspaces(cellKeys).filter(
      (airspace) =>
        airspace.bbox.maxLng >= west &&
        airspace.bbox.minLng <= east &&
        airspace.bbox.maxLat >= south &&
        airspace.bbox.minLat <= north
    )
  );
}

export function getCachedAirportsInBounds(west, south, east, north) {
  const cellKeys = cellKeysInBbox(west, south, east, north);
  return mergeCachedAirports(cellKeys).filter(
    (airport) =>
      airport.lng >= west &&
      airport.lng <= east &&
      airport.lat >= south &&
      airport.lat <= north
  );
}

export function cachedAirportsToGeoJsonFeatures(west, south, east, north) {
  return getCachedAirportsInBounds(west, south, east, north).map((airport) => ({
    type: "Feature",
    properties: airportPropertiesWithId(airport.properties ?? {}, airport.lng, airport.lat),
    geometry: {
      type: "Point",
      coordinates: [airport.lng, airport.lat],
    },
  }));
}

export function mergedCachedAirportsToGeoJsonFeatures(cellKeys = null) {
  return mergeCachedAirports(cellKeys).map((airport) => ({
    type: "Feature",
    properties: airportPropertiesWithId(airport.properties ?? {}, airport.lng, airport.lat),
    geometry: {
      type: "Point",
      coordinates: [airport.lng, airport.lat],
    },
  }));
}

export async function buildCacheBundle(cellKeys, config, onStatus) {
  if (!cellKeys.length) {
    throw new Error("Select at least one 1° cell to cache");
  }

  const bounds = unionCellBounds(cellKeys);
  const { tileCount, tileFetches } = await prefetchTerrariumTiles(bounds, onStatus);
  onStatus?.(`Fetching airports & airspace for ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"}…`);
  const { airportFetches, cellsFetched, cellsSkipped } = await cacheAirportsForCells(
    cellKeys,
    config,
    onStatus
  );
  const networkFetches = tileFetches + airportFetches;
  const airportCount = mergeCachedAirports(cellKeys).length;
  const airspaceCount = mergeCachedAirspaces(cellKeys).length;
  setLastCachedCellKeys(cellKeys);

  const keptSuffix =
    cellsSkipped > 0
      ? `, ${cellsSkipped} cell${cellsSkipped === 1 ? "" : "s"} kept`
      : "";

  onStatus?.(
    `Cache done — ${tileCount} terrarium tiles, ${airportCount} airports, ${airspaceCount} airspace volumes in ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"} (${networkFetches} fetched${keptSuffix})`
  );

  return {
    cellKeys: [...cellKeys],
    bounds,
    tileCount,
    tileFetches,
    airportFetches,
    cellsFetched,
    cellsSkipped,
    airportCount,
    airspaceCount,
  };
}

initCellCacheFromStorage();
