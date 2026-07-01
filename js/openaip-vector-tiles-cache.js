import { openAipConfigured, openAipTileUrls } from "./openaip-client.js";

export const OPENAIP_TILE_CACHE_NAME = "gpu-mc-openaip-v1";
export const OPENAIP_CACHE_TILE_URL_TEMPLATE = "openaip-cache://{z}/{x}/{y}.pbf";

const inflightBlobs = new Map();
let protocolRegistered = false;
let tileCacheConfig = null;

function openAipTileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

function openAipNetworkTileUrl(z, x, y, config) {
  const templates = openAipTileUrls(config);
  if (!templates.length) {
    return null;
  }
  return templates[0]
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

async function openOpenAipTileCache() {
  if (typeof caches === "undefined") {
    return null;
  }
  try {
    return await caches.open(OPENAIP_TILE_CACHE_NAME);
  } catch {
    return null;
  }
}

export function setOpenAipTileCacheConfig(config) {
  tileCacheConfig = config;
}

async function fetchOpenAipTileBlobFromNetwork(z, x, y, config) {
  const url = openAipNetworkTileUrl(z, x, y, config);
  if (!url) {
    throw new Error("OpenAIP tile URL not configured");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load OpenAIP tile ${z}/${x}/${y}`);
  }
  const blob = await response.blob();
  const cache = await openOpenAipTileCache();
  if (cache) {
    try {
      await cache.put(url, new Response(blob, { headers: response.headers }));
    } catch {
      // Ignore quota / private-mode cache write failures.
    }
  }
  return blob;
}

/** Persistent (Cache API) + in-flight dedupe; returns raw .pbf blob and fetch source. */
export async function fetchOpenAipTileBlob(z, x, y, config = tileCacheConfig) {
  if (!openAipConfigured(config)) {
    throw new Error("OpenAIP not configured");
  }

  const key = openAipTileKey(z, x, y);
  if (inflightBlobs.has(key)) {
    return inflightBlobs.get(key);
  }

  const promise = (async () => {
    const url = openAipNetworkTileUrl(z, x, y, config);
    if (!url) {
      throw new Error("OpenAIP tile URL not configured");
    }
    const cache = await openOpenAipTileCache();
    if (cache) {
      const cached = await cache.match(url);
      if (cached) {
        return { blob: await cached.blob(), fromNetwork: false };
      }
    }
    const blob = await fetchOpenAipTileBlobFromNetwork(z, x, y, config);
    return { blob, fromNetwork: true };
  })();

  inflightBlobs.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightBlobs.delete(key);
  }
}

export function registerOpenAipTileProtocol(config) {
  if (config) {
    setOpenAipTileCacheConfig(config);
  }
  if (protocolRegistered || typeof maplibregl === "undefined") {
    return;
  }
  protocolRegistered = true;

  maplibregl.addProtocol("openaip-cache", async (params) => {
    const match = params.url.match(/openaip-cache:\/\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) {
      throw new Error(`Invalid OpenAIP cache tile URL: ${params.url}`);
    }
    const z = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const { blob } = await fetchOpenAipTileBlob(z, x, y);
    return { data: await blob.arrayBuffer() };
  });
}
