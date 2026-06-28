import {
  TILE_SIZE,
  lngLatToGlobalPixel,
  pickTerrainZoom,
  metersPerPixel,
  terrariumElevation,
} from "./geo.js";

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

/**
 * Option A: build a DEM grid aligned to terrain tile pixels at the chosen zoom.
 */
export async function buildDemGrid(lng, lat, params) {
  const { glideRatio, maxAltitude, groundClearance, maxGridDim } = params;
  const z = pickTerrainZoom(lat);
  const cellSizeM = metersPerPixel(lat, z);
  const radiusM = maxAltitude * glideRatio;
  let radiusPx = Math.ceil(radiusM / cellSizeM);
  const requestedDim = radiusPx * 2 + 1;
  let capped = false;

  if (requestedDim > maxGridDim) {
    radiusPx = Math.floor((maxGridDim - 1) / 2);
    capped = true;
  }

  const { gx: clickGx, gy: clickGy } = lngLatToGlobalPixel(lng, lat, z);
  const homeGx = Math.floor(clickGx);
  const homeGy = Math.floor(clickGy);
  const gx0 = homeGx - radiusPx;
  const gy0 = homeGy - radiusPx;
  const width = radiusPx * 2 + 1;
  const height = radiusPx * 2 + 1;

  const minTileX = Math.floor(gx0 / TILE_SIZE);
  const maxTileX = Math.floor((gx0 + width - 1) / TILE_SIZE);
  const minTileY = Math.floor(gy0 / TILE_SIZE);
  const maxTileY = Math.floor((gy0 + height - 1) / TILE_SIZE);

  const tiles = new Map();
  const fetches = [];
  for (let ty = minTileY; ty <= maxTileY; ty += 1) {
    for (let tx = minTileX; tx <= maxTileX; tx += 1) {
      fetches.push(
        fetchTileDecoded(z, tx, ty).then((tile) => {
          tiles.set(`${z}/${tx}/${ty}`, tile);
        })
      );
    }
  }
  await Promise.all(fetches);

  const elevation = new Float32Array(width * height);
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const gx = gx0 + i;
      const gy = gy0 + j;
      let elev = sampleGlobalPixel(tiles, gx, gy, z);
      if (Number.isNaN(elev)) {
        elev = params.maxAltitude + 1000;
      }
      elevation[j * width + i] = elev + groundClearance;
    }
  }

  const homeX = homeGx - gx0;
  const homeY = homeGy - gy0;

  return {
    elevation,
    width,
    height,
    homeX,
    homeY,
    cellSizeM,
    zoom: z,
    gx0,
    gy0,
    tileCount: tiles.size,
    capped,
    requestedDim,
    groundClearance,
  };
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
