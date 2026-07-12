import { TILE_SIZE, lngLatToGlobalPixel } from "../geo.js";
import { isCellCached } from "./cell-store.js";

export const CACHE_TERRAIN_Z_MIN = 3;
export const CACHE_TERRAIN_Z_MAX = 9;
/** Terrain tile failures at this zoom and above are silent (no infobox warning). */
export const CACHE_TERRAIN_WARN_Z_MAX = 7;

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
