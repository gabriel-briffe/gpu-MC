import { TILE_SIZE, terrariumElevation, lngLatToGlobalPixel, clampTerrainZoom } from "./geo.js";

export const MAPTERHORN_TILE_BASE = "https://tiles.mapterhorn.com";
export const TERRAIN_TILE_CACHE_NAME = "gpu-mc-terrain-v1";
export const TERRAIN_TILE_URL_TEMPLATE = "terrain-cache://{z}/{x}/{y}.webp";
/** Hillshade fetches native tiles up to this zoom; higher map zooms overzoom these tiles. */
export const BASE_MAP_TERRAIN_MAX_ZOOM = 9;

const decodedMemory = new Map();
const inflightBlobs = new Map();
let protocolRegistered = false;

function terrainTileUrl(z, x, y) {
  return `${MAPTERHORN_TILE_BASE}/${z}/${x}/${y}.webp`;
}

function terrainTileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

async function openTerrainCache() {
  if (typeof caches === "undefined") {
    return null;
  }
  try {
    return await caches.open(TERRAIN_TILE_CACHE_NAME);
  } catch {
    return null;
  }
}

async function fetchTerrainTileBlobFromNetwork(z, x, y) {
  const url = terrainTileUrl(z, x, y);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load tile ${z}/${x}/${y}`);
  }
  const blob = await response.blob();
  const cache = await openTerrainCache();
  if (cache) {
    try {
      await cache.put(url, new Response(blob, { headers: response.headers }));
    } catch {
      // Ignore quota / private-mode cache write failures.
    }
  }
  return blob;
}

/** Persistent (Cache API) + in-flight dedupe; returns raw .webp blob and fetch source. */
export async function fetchTerrainTileBlob(z, x, y) {
  const key = terrainTileKey(z, x, y);
  if (inflightBlobs.has(key)) {
    return inflightBlobs.get(key);
  }

  const promise = (async () => {
    const url = terrainTileUrl(z, x, y);
    const cache = await openTerrainCache();
    if (cache) {
      const cached = await cache.match(url);
      if (cached) {
        return { blob: await cached.blob(), fromNetwork: false };
      }
    }
    const blob = await fetchTerrainTileBlobFromNetwork(z, x, y);
    return { blob, fromNetwork: true };
  })();

  inflightBlobs.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightBlobs.delete(key);
  }
}

async function decodeTerrainTileBlob(blob, z, x, y) {
  const bitmap = await createImageBitmap(blob);
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

  return { elevation, z, x, y };
}

/** Persistent (Cache API) only; throws if the tile was not prefetched via Cache. */
export async function fetchTerrainTileBlobCachedOnly(z, x, y) {
  const url = terrainTileUrl(z, x, y);
  const cache = await openTerrainCache();
  if (cache) {
    const cached = await cache.match(url);
    if (cached) {
      return { blob: await cached.blob(), fromNetwork: false };
    }
  }
  throw new Error(
    `Terrain tile z${z}/${x}/${y} not cached — select this area in Cache data first`
  );
}

export async function isTerrainTileCached(z, x, y) {
  const cache = await openTerrainCache();
  if (!cache) {
    return false;
  }
  return Boolean(await cache.match(terrainTileUrl(z, x, y)));
}

/** Session memory + Cache API only (no network). */
export async function fetchTerrainTileDecodedCachedOnly(z, x, y) {
  const key = terrainTileKey(z, x, y);
  if (decodedMemory.has(key)) {
    return decodedMemory.get(key);
  }

  const { blob } = await fetchTerrainTileBlobCachedOnly(z, x, y);
  const payload = await decodeTerrainTileBlob(blob, z, x, y);
  decodedMemory.set(key, payload);
  return payload;
}

/** Session memory + persistent blob cache; returns decoded elevation tile. */
export async function fetchTerrainTileDecoded(z, x, y) {
  const key = terrainTileKey(z, x, y);
  if (decodedMemory.has(key)) {
    return decodedMemory.get(key);
  }

  const { blob } = await fetchTerrainTileBlob(z, x, y);
  const payload = await decodeTerrainTileBlob(blob, z, x, y);
  decodedMemory.set(key, payload);
  return payload;
}

export async function clearTerrainTileCache() {
  decodedMemory.clear();
  if (typeof caches === "undefined") {
    return { removed: 0, bytesFreed: 0 };
  }
  try {
    const cache = await openTerrainCache();
    let removed = 0;
    let bytesFreed = 0;
    if (cache) {
      const keys = await cache.keys();
      removed = keys.length;
      for (const request of keys) {
        const match = await cache.match(request);
        if (match) {
          bytesFreed += (await match.blob()).size;
        }
      }
    }
    await caches.delete(TERRAIN_TILE_CACHE_NAME);
    return { removed, bytesFreed };
  } catch {
    return { removed: 0, bytesFreed: 0 };
  }
}

function parseTerrainTileKeyFromUrl(url) {
  const match = String(url).match(/\/(\d+)\/(\d+)\/(\d+)\.webp$/);
  if (!match) {
    return null;
  }
  return terrainTileKey(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Total byte size of terrarium tiles stored in the Cache API. */
export async function estimateTerrainCacheBytes() {
  const cache = await openTerrainCache();
  if (!cache) {
    return 0;
  }
  let bytes = 0;
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (response) {
      bytes += (await response.blob()).size;
    }
  }
  return bytes;
}

/** Drop cached terrain tiles that are not required by the given job list. */
export async function pruneTerrainTileCache(keepJobs) {
  const keep = new Set(keepJobs.map(({ z, x, y }) => terrainTileKey(z, x, y)));
  decodedMemory.forEach((_value, key) => {
    if (!keep.has(key)) {
      decodedMemory.delete(key);
    }
  });

  const cache = await openTerrainCache();
  if (!cache) {
    return { removed: 0, bytesFreed: 0 };
  }

  let removed = 0;
  let bytesFreed = 0;
  for (const request of await cache.keys()) {
    const key = parseTerrainTileKeyFromUrl(request.url);
    if (!key || keep.has(key)) {
      continue;
    }
    const response = await cache.match(request);
    if (response) {
      bytesFreed += (await response.blob()).size;
    }
    await cache.delete(request);
    decodedMemory.delete(key);
    removed += 1;
  }

  return { removed, bytesFreed };
}

export function registerTerrainTileProtocol() {
  if (protocolRegistered || typeof maplibregl === "undefined") {
    return;
  }
  protocolRegistered = true;

  maplibregl.addProtocol("terrain-cache", async (params) => {
    const match = params.url.match(/terrain-cache:\/\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) {
      throw new Error(`Invalid terrain tile URL: ${params.url}`);
    }
    const z = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const { blob } = await fetchTerrainTileBlob(z, x, y);
    return { data: await blob.arrayBuffer() };
  });
}
