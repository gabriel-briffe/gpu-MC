import { TILE_SIZE, lngLatToGlobalPixel } from "../geo.js";
import { isDeclaredCell } from "./cell-store.js";

export const CACHE_CELL_SIZE_DEG = 3;
export const CACHE_TERRAIN_Z_MIN = 3;
export const CACHE_TERRAIN_Z_MAX = 9;
/** Terrain tile failures at this zoom and above are silent (no infobox warning). */
export const CACHE_TERRAIN_WARN_Z_MAX = 7;

function alignCellOrigin(value) {
  return Math.floor(value / CACHE_CELL_SIZE_DEG) * CACHE_CELL_SIZE_DEG;
}

export function cacheCellKey(lng, lat) {
  return `${alignCellOrigin(lng)},${alignCellOrigin(lat)}`;
}

export function cacheCellBounds(cellKey) {
  const [west, south] = cellKey.split(",").map(Number);
  return {
    west,
    south,
    east: west + CACHE_CELL_SIZE_DEG,
    north: south + CACHE_CELL_SIZE_DEG,
  };
}

/** 3° grid cells intersecting a bbox (west/south/east/north in degrees). */
export function cellKeysInBbox(west, south, east, north) {
  const minLng = alignCellOrigin(west);
  const minLat = alignCellOrigin(south);
  const cellKeys = [];

  for (let lng = minLng; lng < east; lng += CACHE_CELL_SIZE_DEG) {
    for (let lat = minLat; lat < north; lat += CACHE_CELL_SIZE_DEG) {
      cellKeys.push(`${lng},${lat}`);
    }
  }

  return cellKeys;
}

/** Declared coverage cells overlapping a bbox (selection mask — not OpenAIP TTL). */
export function declaredCellsInBbox(west, south, east, north) {
  return cellKeysInBbox(west, south, east, north).filter((cellKey) => isDeclaredCell(cellKey));
}

/** @deprecated Use declaredCellsInBbox */
export function getFreshCachedCellKeysInBbox(west, south, east, north) {
  return declaredCellsInBbox(west, south, east, north);
}

/** True when lng/lat falls in a declared coverage cell. */
export function isLngLatInDeclaredCoverage(lng, lat) {
  return isDeclaredCell(cacheCellKey(lng, lat));
}

/** @deprecated Use isLngLatInDeclaredCoverage */
export function isLngLatInCachedCell(lng, lat) {
  return isLngLatInDeclaredCoverage(lng, lat);
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

/** Intersect a bbox with the union of declared coverage cells overlapping it. */
export function clipBoundsToDeclaredCells(bounds) {
  const cellKeys = declaredCellsInBbox(
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

/** @deprecated Use clipBoundsToDeclaredCells */
export function clipBoundsToCachedCells(bounds) {
  return clipBoundsToDeclaredCells(bounds);
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

/** Unique terrarium tile jobs (z/x/y) needed to cover each cache cell at z3–z9. */
export function terrariumTileJobsForCellKeys(cellKeys) {
  const seen = new Set();
  const jobs = [];

  for (const cellKey of cellKeys) {
    const { west, south, east, north } = cacheCellBounds(cellKey);
    for (let z = CACHE_TERRAIN_Z_MIN; z <= CACHE_TERRAIN_Z_MAX; z += 1) {
      for (const tile of terrariumTileIndicesForBounds(west, south, east, north, z)) {
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        jobs.push(tile);
      }
    }
  }

  return jobs;
}
