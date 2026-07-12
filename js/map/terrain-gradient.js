import { TILE_SIZE, terrariumElevation } from "../geo.js";
import {
  GRADIENT_MAX_ALT_DEFAULT,
  GRADIENT_MAX_ALT_MAX,
  GRADIENT_MAX_ALT_MIN,
  GRADIENT_MAX_ALT_STEP,
  GRADIENT_MIN_ALT_DEFAULT,
} from "../constants.js";
import { BASE_MAP_TERRAIN_MAX_ZOOM, fetchTerrainTileBlob } from "../terrain-tiles.js";

/** SRTM-style elevation palette (elevation m → RGB). */
const ELEVATION_COLOR_STOPS = [
  { elev: -500, rgb: [0, 0, 180] },
  { elev: 0, rgb: [0, 120, 0] },
  { elev: 500, rgb: [80, 180, 0] },
  { elev: 1000, rgb: [180, 220, 0] },
  { elev: 1500, rgb: [255, 220, 0] },
  { elev: 2000, rgb: [255, 160, 0] },
  { elev: 2500, rgb: [255, 80, 0] },
  { elev: 3000, rgb: [220, 0, 0] },
  { elev: 3500, rgb: [180, 0, 120] },
  { elev: 4000, rgb: [140, 0, 180] },
  { elev: 5000, rgb: [200, 200, 200] },
  { elev: 6000, rgb: [255, 255, 255] },
];

const BASE_PALETTE_MIN = ELEVATION_COLOR_STOPS[0].elev;
const BASE_PALETTE_MAX = ELEVATION_COLOR_STOPS.at(-1).elev;

export const TERRAIN_GRADIENT_TILE_URL_TEMPLATE =
  "terrain-gradient-cache://{z}/{x}/{y}.png";

const gradientTileCache = new Map();
let protocolRegistered = false;
let gradientMinAltitude = GRADIENT_MIN_ALT_DEFAULT;
let gradientMaxAltitude = GRADIENT_MAX_ALT_DEFAULT;

function stepGradientAltitude(value) {
  return Math.round(value / GRADIENT_MAX_ALT_STEP) * GRADIENT_MAX_ALT_STEP;
}

function scaledColorStops(minAlt, maxAlt) {
  const targetSpan = maxAlt - minAlt;
  if (targetSpan <= 0) {
    return [{ elev: minAlt, rgb: ELEVATION_COLOR_STOPS.at(-1).rgb }];
  }
  const span = BASE_PALETTE_MAX - BASE_PALETTE_MIN;
  return ELEVATION_COLOR_STOPS.map((stop) => ({
    elev: minAlt + ((stop.elev - BASE_PALETTE_MIN) * targetSpan) / span,
    rgb: stop.rgb,
  }));
}

function elevationToRgb(elevation, minAlt, maxAlt) {
  if (elevation === 0) {
    return [255, 255, 255];
  }
  const stops = scaledColorStops(minAlt, maxAlt);
  if (elevation <= stops[0].elev) {
    return stops[0].rgb;
  }
  for (let i = 1; i < stops.length; i += 1) {
    const upper = stops[i];
    const lower = stops[i - 1];
    if (elevation <= upper.elev) {
      const band = upper.elev - lower.elev;
      const t = band > 0 ? (elevation - lower.elev) / band : 0;
      return [
        Math.round(lower.rgb[0] + (upper.rgb[0] - lower.rgb[0]) * t),
        Math.round(lower.rgb[1] + (upper.rgb[1] - lower.rgb[1]) * t),
        Math.round(lower.rgb[2] + (upper.rgb[2] - lower.rgb[2]) * t),
      ];
    }
  }
  return stops.at(-1).rgb;
}

export function clampGradientMaxAltitude(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return GRADIENT_MAX_ALT_DEFAULT;
  }
  return Math.max(
    GRADIENT_MAX_ALT_MIN,
    Math.min(GRADIENT_MAX_ALT_MAX, stepGradientAltitude(numeric))
  );
}

export function clampGradientMinAltitude(value, maxAlt = gradientMaxAltitude) {
  const numeric = Number(value);
  const ceiling = clampGradientMaxAltitude(maxAlt);
  if (!Number.isFinite(numeric)) {
    return GRADIENT_MIN_ALT_DEFAULT;
  }
  return Math.max(0, Math.min(ceiling, stepGradientAltitude(numeric)));
}

export function getGradientMinAltitude() {
  return gradientMinAltitude;
}

export function getGradientMaxAltitude() {
  return gradientMaxAltitude;
}

export function clearGradientTileCache() {
  gradientTileCache.clear();
}

export function setGradientAltitudes({ minAlt, maxAlt } = {}) {
  const nextMax =
    maxAlt === undefined ? gradientMaxAltitude : clampGradientMaxAltitude(maxAlt);
  const nextMin =
    minAlt === undefined
      ? clampGradientMinAltitude(gradientMinAltitude, nextMax)
      : clampGradientMinAltitude(minAlt, nextMax);
  const changed =
    gradientMinAltitude !== nextMin || gradientMaxAltitude !== nextMax;
  gradientMaxAltitude = nextMax;
  gradientMinAltitude = nextMin;
  if (changed) {
    clearGradientTileCache();
  }
  return { minAlt: nextMin, maxAlt: nextMax };
}

export function setGradientMaxAltitude(maxAlt) {
  return setGradientAltitudes({ maxAlt }).maxAlt;
}

export function setGradientMinAltitude(minAlt) {
  return setGradientAltitudes({ minAlt }).minAlt;
}

async function terrainTileToGradientPng(z, x, y, minAlt, maxAlt) {
  const { blob } = await fetchTerrainTileBlob(z, x, y);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const imageData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const data = imageData.data;
  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i += 1) {
    const p = i * 4;
    const elevation = terrariumElevation(data[p], data[p + 1], data[p + 2]);
    const [r, g, b] = elevationToRgb(elevation, minAlt, maxAlt);
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  const pngBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) {
        resolve(result);
      } else {
        reject(new Error(`Failed to encode gradient tile ${z}/${x}/${y}`));
      }
    }, "image/png");
  });
  return pngBlob.arrayBuffer();
}

export function registerTerrainGradientProtocol() {
  if (protocolRegistered || typeof maplibregl === "undefined") {
    return;
  }
  protocolRegistered = true;

  maplibregl.addProtocol("terrain-gradient-cache", async (params) => {
    const match = params.url.match(/terrain-gradient-cache:\/\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) {
      throw new Error(`Invalid terrain gradient tile URL: ${params.url}`);
    }
    const z = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const minAlt = gradientMinAltitude;
    const maxAlt = gradientMaxAltitude;
    const key = `${minAlt}/${maxAlt}/${z}/${x}/${y}`;
    if (gradientTileCache.has(key)) {
      return { data: gradientTileCache.get(key) };
    }
    const data = await terrainTileToGradientPng(z, x, y, minAlt, maxAlt);
    gradientTileCache.set(key, data);
    return { data };
  });
}

export function getTerrainGradientMaxZoom() {
  return BASE_MAP_TERRAIN_MAX_ZOOM;
}
