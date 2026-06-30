import { TILE_SIZE, lngLatToGlobalPixel } from "./geo.js";
import { fetchTerrainTileBlob } from "./terrain-tiles.js";
import { dedupeAirports, fetchAirportsInBbox } from "./openaip-airports.js";

export const CACHE_TERRAIN_Z_MIN = 3;
export const CACHE_TERRAIN_Z_MAX = 7;
const TERRAIN_PREFETCH_CONCURRENCY = 8;

let activeCacheBundle = null;

export function getActiveCacheBundle() {
  return activeCacheBundle;
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

async function fetchAirportsForCells(cellKeys, config, onStatus) {
  const all = [];
  let airportFetches = 0;
  let index = 0;

  for (const cellKey of cellKeys) {
    index += 1;
    onStatus?.(`Fetching airports — cell ${index}/${cellKeys.length} (${cellKey})…`);
    const { airports, fetchCount } = await fetchAirportsInBbox(cacheCellBounds(cellKey), config);
    airportFetches += fetchCount;
    all.push(...airports);
  }

  return { airports: dedupeAirports(all), airportFetches };
}

export async function buildCacheBundle(cellKeys, config, onStatus) {
  if (!cellKeys.length) {
    throw new Error("Select at least one 1° cell to cache");
  }

  const bounds = unionCellBounds(cellKeys);
  const { tileCount, tileFetches } = await prefetchTerrariumTiles(bounds, onStatus);
  onStatus?.(`Fetching airports for ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"}…`);
  const { airports, airportFetches } = await fetchAirportsForCells(cellKeys, config, onStatus);
  const networkFetches = tileFetches + airportFetches;

  activeCacheBundle = {
    cellKeys: [...cellKeys],
    bounds,
    airports,
    fetchedAt: Date.now(),
    tileCount,
    tileFetches,
    airportFetches,
  };

  onStatus?.(
    `Cache done — ${tileCount} terrarium tiles, ${airports.length} airports in ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"} (${networkFetches} fetched)`
  );

  return activeCacheBundle;
}
