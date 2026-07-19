import { TILE_SIZE, terrariumElevation } from "../geo.js";
import {
  fetchTerrainTileBlobCachedOnly,
  putTerrainTileBlob,
  invalidateDecodedTerrainTile,
} from "../terrain-tiles.js";

const HALF = TILE_SIZE / 2;

function elevationToTerrariumRgb(elev) {
  const h = elev + 32768;
  const r = Math.min(255, Math.max(0, Math.floor(h / 256)));
  const rem = h - r * 256;
  const g = Math.min(255, Math.max(0, Math.floor(rem)));
  const b = Math.min(255, Math.max(0, Math.round((rem - g) * 256)));
  return [r, g, b];
}

async function decodeElevationFromBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("No 2d context for terrarium decode");
  }
  ctx.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
  bitmap.close?.();
  const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const elevation = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i += 1) {
    const p = i * 4;
    elevation[i] = terrariumElevation(data[p], data[p + 1], data[p + 2]);
  }
  return elevation;
}

async function encodeElevationToWebpBlob(elevation) {
  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("No 2d context for terrarium encode");
  }
  const imageData = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  const { data } = imageData;
  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i += 1) {
    const [r, g, b] = elevationToTerrariumRgb(elevation[i]);
    const p = i * 4;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  const blob = await new Promise((resolve, reject) => {
    const finish = (result, type) => {
      if (!result) {
        reject(new Error(`Failed to encode terrarium tile as ${type}`));
        return;
      }
      resolve(result);
    };
    canvas.toBlob((result) => {
      if (result) {
        finish(result, "image/webp");
        return;
      }
      canvas.toBlob((png) => finish(png, "image/png"), "image/png");
    }, "image/webp", 1);
  });
  return blob;
}

/**
 * For each parent pixel covered by a present child tile, set elev to max of the
 * four aligned child samples (same geographic footprint).
 */
function maxPoolChildIntoParent(parentElev, childElev, childOx, childOy) {
  const x0 = childOx * HALF;
  const y0 = childOy * HALF;
  for (let j = 0; j < HALF; j += 1) {
    for (let i = 0; i < HALF; i += 1) {
      const lx = i * 2;
      const ly = j * 2;
      const a = childElev[ly * TILE_SIZE + lx];
      const b = childElev[ly * TILE_SIZE + lx + 1];
      const c = childElev[(ly + 1) * TILE_SIZE + lx];
      const d = childElev[(ly + 1) * TILE_SIZE + lx + 1];
      parentElev[(y0 + j) * TILE_SIZE + (x0 + i)] = Math.max(a, b, c, d);
    }
  }
}

async function loadCachedElevation(z, x, y) {
  const { blob } = await fetchTerrainTileBlobCachedOnly(z, x, y);
  return decodeElevationFromBlob(blob);
}

/**
 * Raise each parent-Z sample to the max of its four child-Z samples wherever the
 * matching child tile is present in the cache job list.
 */
export async function maxPoolParentFromChildren(parentZ, childZ, tileJobs, onStatus) {
  const childTiles = tileJobs.filter((job) => job.z === childZ);
  if (!childTiles.length) {
    return { parentsUpdated: 0, parentsSkipped: 0 };
  }

  /** @type {Map<string, { x: number, y: number, children: { x: number, y: number }[] }>} */
  const parents = new Map();
  for (const { x, y } of childTiles) {
    const px = Math.floor(x / 2);
    const py = Math.floor(y / 2);
    const key = `${px}/${py}`;
    let entry = parents.get(key);
    if (!entry) {
      entry = { x: px, y: py, children: [] };
      parents.set(key, entry);
    }
    entry.children.push({ x, y });
  }

  const parentList = [...parents.values()];
  let parentsUpdated = 0;
  let parentsSkipped = 0;
  let done = 0;

  onStatus?.(`Raising z${parentZ} ridges from z${childZ} 0/${parentList.length}…`);

  for (const parent of parentList) {
    try {
      const parentElev = await loadCachedElevation(parentZ, parent.x, parent.y);
      for (const child of parent.children) {
        try {
          const childElev = await loadCachedElevation(childZ, child.x, child.y);
          maxPoolChildIntoParent(parentElev, childElev, child.x % 2, child.y % 2);
        } catch {
          // Missing/corrupt child — leave that quadrant of parent unchanged.
        }
      }
      const blob = await encodeElevationToWebpBlob(parentElev);
      await putTerrainTileBlob(parentZ, parent.x, parent.y, blob);
      invalidateDecodedTerrainTile(parentZ, parent.x, parent.y);
      parentsUpdated += 1;
    } catch (error) {
      parentsSkipped += 1;
      console.warn(`z${parentZ} max-pool skipped for ${parent.x}/${parent.y}`, error);
    } finally {
      done += 1;
      onStatus?.(
        `Raising z${parentZ} ridges from z${childZ} ${done}/${parentList.length}…`
      );
    }
  }

  return { parentsUpdated, parentsSkipped };
}

/** z9 → z8 ridge raise (run before z8 → z7). */
export function maxPoolZ8FromZ9(tileJobs, onStatus) {
  return maxPoolParentFromChildren(8, 9, tileJobs, onStatus);
}

/** z8 → z7 ridge raise (uses z8 after z9 max-pool when that ran first). */
export function maxPoolZ7FromZ8(tileJobs, onStatus) {
  return maxPoolParentFromChildren(7, 8, tileJobs, onStatus);
}
