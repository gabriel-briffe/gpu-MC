import {
  TILE_SIZE,
  lngLatToGlobalPixel,
  metersPerPixel,
  clampTerrainZoom,
  pickTerrainZoom,
  terrariumElevation,
} from "./geo.js";
import { applyAirspaceToDem, demBbox, fetchOverlayAirspaces } from "./airspace.js";
import { openAipConfigured } from "./openaip-client.js";

const tileCache = new Map();

async function fetchTileDecoded(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) {
    return tileCache.get(key);
  }

  const response = await fetch(`https://tiles.mapterhorn.com/${key}.webp`);
  if (!response.ok) {
    throw new Error(`Failed to load tile ${key}`);
  }

  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const elevation = new Float32Array(TILE_SIZE * TILE_SIZE);
  const data = imageData.data;
  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i += 1) {
    const p = i * 4;
    elevation[i] = terrariumElevation(data[p], data[p + 1], data[p + 2]);
  }

  const payload = { elevation, z, x, y };
  tileCache.set(key, payload);
  return payload;
}

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

  if (params.gridBounds) {
    ({ gx0, gy0, width, height } = computeGridExtentsFromLngLatBounds(params.gridBounds, z));
    gridRadiusPx = radiusPx;
  } else {
    const extents = computeGridExtents(seedPixels, radiusPx);
    gridRadiusPx = extents.radiusPx;
    gx0 = extents.minGx - gridRadiusPx;
    gy0 = extents.minGy - gridRadiusPx;
    width = extents.width;
    height = extents.height;
  }

  const minTileX = Math.floor(gx0 / TILE_SIZE);
  const maxTileX = Math.floor((gx0 + width - 1) / TILE_SIZE);
  const minTileY = Math.floor(gy0 / TILE_SIZE);
  const maxTileY = Math.floor((gy0 + height - 1) / TILE_SIZE);

  const tiles = new Map();
  const tileCount = (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
  const onStatus = params.onStatus;
  onStatus?.(
    `Fetching DEM z${z} (~${Math.round(cellSizeM)} m) — ${seeds.length} airports, ${tileCount} terrain tiles…`
  );

  let tilesLoaded = 0;
  const fetches = [];
  for (let ty = minTileY; ty <= maxTileY; ty += 1) {
    for (let tx = minTileX; tx <= maxTileX; tx += 1) {
      fetches.push(
        fetchTileDecoded(z, tx, ty).then((tile) => {
          tiles.set(`${z}/${tx}/${ty}`, tile);
          tilesLoaded += 1;
          onStatus?.(
            `Fetching DEM z${z} — terrain tiles ${tilesLoaded}/${tileCount}…`
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
    onStatus?.("Fetching airspace volumes…");
    airspaces = await fetchOverlayAirspaces(
      demBbox({ gx0, gy0, width, height, zoom: z }),
      params.openAipConfig
    );
    onStatus?.(
      airspaces.length > 0
        ? `Fetched ${airspaces.length} airspace volumes — applying to grid…`
        : "No airspace volumes in grid area"
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

export async function sampleElevationAt(lng, lat) {
  const z = pickTerrainZoom(lat);
  const { gx, gy } = lngLatToGlobalPixel(lng, lat, z);
  const tileX = Math.floor(gx / TILE_SIZE);
  const tileY = Math.floor(gy / TILE_SIZE);
  const tile = await fetchTileDecoded(z, tileX, tileY);
  const localX = Math.floor(gx) - tileX * TILE_SIZE;
  const localY = Math.floor(gy) - tileY * TILE_SIZE;
  return tile.elevation[localY * TILE_SIZE + localX];
}
