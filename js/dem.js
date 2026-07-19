import {
  TILE_SIZE,
  lngLatToGlobalPixel,
  metersPerPixel,
  clampTerrainZoom,
  globalPixelToLngLat,
} from "./geo.js";
import { applyAirspaceToDem, demBbox } from "./airspace.js";
import { openAipConfigured } from "./openaip-client.js";
import { clipBoundsToDeclaredCells, getCachedOverlayAirspaces, MISSING_CACHED_AIRSPACE_MSG, resolveComputeGridBounds } from "./cache-area.js";
import { fetchTerrainTileDecoded, fetchTerrainTileDecodedCachedOnly } from "./terrain-tiles.js";

function sampleGlobalPixel(tiles, gx, gy, z) {
  const tileX = Math.floor(gx / TILE_SIZE);
  const tileY = Math.floor(gy / TILE_SIZE);
  const localX = Math.floor(gx) - tileX * TILE_SIZE;
  const localY = Math.floor(gy) - tileY * TILE_SIZE;
  const key = `${z}/${tileX}/${tileY}`;
  const tile = tiles.get(key);
  if (!tile) {
    return NaN;
  }
  return tile.elevation[localY * TILE_SIZE + localX];
}

function computeGridExtents(seedPixels, radiusPx) {
  let minGx = Infinity;
  let maxGx = -Infinity;
  let minGy = Infinity;
  let maxGy = -Infinity;

  for (const seed of seedPixels) {
    minGx = Math.min(minGx, seed.gx);
    maxGx = Math.max(maxGx, seed.gx);
    minGy = Math.min(minGy, seed.gy);
    maxGy = Math.max(maxGy, seed.gy);
  }

  const spanGx = maxGx - minGx;
  const spanGy = maxGy - minGy;
  const width = spanGx + 2 * radiusPx + 1;
  const height = spanGy + 2 * radiusPx + 1;

  return {
    minGx,
    minGy,
    width,
    height,
    radiusPx,
  };
}

function computeGridExtentsFromLngLatBounds(bounds, z) {
  const nw = lngLatToGlobalPixel(bounds.west, bounds.north, z);
  const se = lngLatToGlobalPixel(bounds.east, bounds.south, z);
  const gx0 = Math.floor(nw.gx);
  const gy0 = Math.floor(nw.gy);
  const gx1 = Math.ceil(se.gx);
  const gy1 = Math.ceil(se.gy);
  return {
    gx0,
    gy0,
    width: Math.max(1, gx1 - gx0),
    height: Math.max(1, gy1 - gy0),
  };
}

function gridLngLatBounds(gx0, gy0, width, height, z) {
  const nw = globalPixelToLngLat(gx0, gy0, z);
  const se = globalPixelToLngLat(gx0 + width, gy0 + height, z);
  return {
    west: nw.lng,
    north: nw.lat,
    east: se.lng,
    south: se.lat,
  };
}

function clipGridToCachedCells(gx0, gy0, width, height, z) {
  const clippedBounds = clipBoundsToDeclaredCells(gridLngLatBounds(gx0, gy0, width, height, z));
  if (!clippedBounds) {
    throw new Error(MISSING_CACHED_AIRSPACE_MSG);
  }
  return computeGridExtentsFromLngLatBounds(clippedBounds, z);
}

function requiresCachedAirspace(params) {
  return Boolean(
    params.includeAirspace && params.openAipConfig && openAipConfigured(params.openAipConfig)
  );
}

/**
 * Build a DEM grid large enough for every seed, with glide radius on each side.
 */
export async function buildDemGrid(seeds, params) {
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new Error("At least one seed is required");
  }

  const { glideRatio, maxAltitude, groundClearance, terrainZoom } = params;
  const centerLat = seeds.reduce((sum, seed) => sum + seed.lat, 0) / seeds.length;
  const z = clampTerrainZoom(terrainZoom);
  const cellSizeM = metersPerPixel(centerLat, z);
  const radiusM = maxAltitude * glideRatio;
  const radiusPx = Math.ceil(radiusM / cellSizeM);

  const seedPixels = seeds.map((seed) => {
    const { gx, gy } = lngLatToGlobalPixel(seed.lng, seed.lat, z);
    return {
      gx: Math.floor(gx),
      gy: Math.floor(gy),
      lng: seed.lng,
      lat: seed.lat,
    };
  });

  let gx0;
  let gy0;
  let width;
  let height;
  let gridRadiusPx;
  const requireCachedAirspace = requiresCachedAirspace(params);

  if (params.gridBounds) {
    const bounds = resolveComputeGridBounds(params.gridBounds, { requireCachedAirspace });
    if (!bounds) {
      throw new Error(MISSING_CACHED_AIRSPACE_MSG);
    }
    ({ gx0, gy0, width, height } = computeGridExtentsFromLngLatBounds(bounds, z));
    gridRadiusPx = radiusPx;
  } else {
    const extents = computeGridExtents(seedPixels, radiusPx);
    gridRadiusPx = extents.radiusPx;
    gx0 = extents.minGx - gridRadiusPx;
    gy0 = extents.minGy - gridRadiusPx;
    width = extents.width;
    height = extents.height;
    if (requireCachedAirspace) {
      ({ gx0, gy0, width, height } = clipGridToCachedCells(gx0, gy0, width, height, z));
    }
  }

  const minTileX = Math.floor(gx0 / TILE_SIZE);
  const maxTileX = Math.floor((gx0 + width - 1) / TILE_SIZE);
  const minTileY = Math.floor(gy0 / TILE_SIZE);
  const maxTileY = Math.floor((gy0 + height - 1) / TILE_SIZE);

  const tiles = new Map();
  const tileCount = (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
  const onStatus = params.onStatus;
  const fetchTerrainTile = requireCachedAirspace
    ? fetchTerrainTileDecodedCachedOnly
    : fetchTerrainTileDecoded;
  onStatus?.(
    requireCachedAirspace
      ? `Loading cached DEM z${z} (~${Math.round(cellSizeM)} m) — ${seeds.length} airports, ${tileCount} terrain tiles…`
      : `Fetching DEM z${z} (~${Math.round(cellSizeM)} m) — ${seeds.length} airports, ${tileCount} terrain tiles…`
  );

  let tilesLoaded = 0;
  const fetches = [];
  for (let ty = minTileY; ty <= maxTileY; ty += 1) {
    for (let tx = minTileX; tx <= maxTileX; tx += 1) {
      fetches.push(
        fetchTerrainTile(z, tx, ty).then((tile) => {
          tiles.set(`${z}/${tx}/${ty}`, tile);
          tilesLoaded += 1;
          onStatus?.(
            requireCachedAirspace
              ? `Loading cached DEM z${z} — terrain tiles ${tilesLoaded}/${tileCount}…`
              : `Fetching DEM z${z} — terrain tiles ${tilesLoaded}/${tileCount}…`
          );
        })
      );
    }
  }
  await Promise.all(fetches);

  const terrainMsl = new Float32Array(width * height);
  const elevation = new Float32Array(width * height);
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const gx = gx0 + i;
      const gy = gy0 + j;
      let elev = sampleGlobalPixel(tiles, gx, gy, z);
      if (Number.isNaN(elev)) {
        elev = params.maxAltitude + 1000;
      }
      terrainMsl[j * width + i] = elev;
      elevation[j * width + i] = elev + groundClearance;
    }
  }

  let airspaces = [];
  let airspaceAffectedCells = 0;
  if (
    params.includeAirspace &&
    params.openAipConfig &&
    openAipConfigured(params.openAipConfig)
  ) {
    const bbox = demBbox({ gx0, gy0, width, height, zoom: z });
    airspaces = getCachedOverlayAirspaces(bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat);
    onStatus?.(
      airspaces.length > 0
        ? `Applying ${airspaces.length} cached airspace volumes to grid…`
        : "No cached airspace volumes in grid area"
    );
  }

  const gridSeeds = seedPixels
    .map((seed) => ({
      x: seed.gx - gx0,
      y: seed.gy - gy0,
      lng: seed.lng,
      lat: seed.lat,
    }))
    .filter((seed) => seed.x >= 0 && seed.x < width && seed.y >= 0 && seed.y < height);

  if (gridSeeds.length === 0) {
    throw new Error("No airports fall inside the compute grid");
  }

  const dem = {
    elevation,
    terrainMsl,
    width,
    height,
    seeds: gridSeeds,
    homeX: gridSeeds[0].x,
    homeY: gridSeeds[0].y,
    cellSizeM,
    zoom: z,
    gx0,
    gy0,
    tileCount: tiles.size,
    groundClearance,
    radiusPx: gridRadiusPx,
    airspaces,
    airspaceAffectedCells,
  };

  if (airspaces.length) {
    airspaceAffectedCells = applyAirspaceToDem(dem, airspaces);
    dem.airspaceAffectedCells = airspaceAffectedCells;
  }

  return dem;
}
