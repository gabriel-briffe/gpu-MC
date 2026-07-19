import { GRADIENT_RASTER_OPACITY } from "../constants.js";
import { kmBoxAroundLngLat } from "../geo.js";
import {
  BASE_MAP_TERRAIN_MAX_ZOOM,
  TERRAIN_TILE_URL_TEMPLATE,
} from "../terrain-tiles.js";
import { TERRAIN_GRADIENT_TILE_URL_TEMPLATE } from "./terrain-gradient.js";
import { OSM_TILE_URL, SATELLITE_TILE_URL } from "./raster-basemap.js";

const ICON_CACHE_NAME = "gpu-mc-basemap-preview-icons-v3";
const MODES = ["hillshade", "osm", "satellite", "gradient"];

/** Matterhorn — shared preview center for all basemap thumbnails. */
const PREVIEW_CENTER = { lng: 7.6586, lat: 45.9763 };
/** Half-extent so the captured frame is ~100 km × 100 km. */
const PREVIEW_RADIUS_KM = 50;
const CAPTURE_SIZE = 176;
const ICON_SIZE = 88;
const IDLE_TIMEOUT_MS = 20000;

const MODE_LABELS = {
  hillshade: "Hillshade",
  osm: "OSM",
  satellite: "Satellite",
  gradient: "Gradient",
};

/** Floating chrome cycle order (and menu default path). */
export const BASEMAP_CYCLE_ORDER = ["osm", "satellite", "gradient", "hillshade"];

/** @type {Record<string, string>|null} */
let previewIconUrls = null;

export function nextBasemapCycleMode(mode) {
  const index = BASEMAP_CYCLE_ORDER.indexOf(mode);
  const from = index < 0 ? 0 : index;
  return BASEMAP_CYCLE_ORDER[(from + 1) % BASEMAP_CYCLE_ORDER.length];
}

export function getBasemapPreviewIconUrls() {
  return previewIconUrls;
}

export function hasBasemapPreviewIcons() {
  return allIconsPresent(previewIconUrls);
}

export function syncBasemapCycleButton(btn, img, mode) {
  if (!btn) {
    return;
  }
  if (!hasBasemapPreviewIcons()) {
    btn.hidden = true;
    return;
  }
  const url = previewIconUrls[mode] ?? previewIconUrls.osm;
  if (!url) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  if (img) {
    img.src = url;
  }
  btn.setAttribute("aria-label", `Base map: ${MODE_LABELS[mode] ?? mode} (cycle)`);
}

function cachesAvailable() {
  return typeof caches !== "undefined" && typeof caches.open === "function";
}

function iconRequest(mode) {
  return new Request(`https://gpu-mc.local/basemap-preview/${mode}.png`);
}

async function loadCachedIcon(mode) {
  if (!cachesAvailable()) {
    return null;
  }
  try {
    const cache = await caches.open(ICON_CACHE_NAME);
    const match = await cache.match(iconRequest(mode));
    if (!match || !match.ok) {
      return null;
    }
    const blob = await match.blob();
    if (!blob?.size) {
      return null;
    }
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

async function saveCachedIcon(mode, blob) {
  if (!cachesAvailable() || !blob) {
    return;
  }
  try {
    const cache = await caches.open(ICON_CACHE_NAME);
    await cache.put(
      iconRequest(mode),
      new Response(blob, {
        headers: { "Content-Type": "image/png" },
      })
    );
  } catch (error) {
    console.warn(`Failed to cache basemap preview ${mode}`, error);
  }
}

function styleForMode(mode) {
  if (mode === "osm") {
    return {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: [OSM_TILE_URL],
          tileSize: 256,
          maxzoom: 19,
        },
        hillshadeSource: {
          type: "raster-dem",
          tiles: [TERRAIN_TILE_URL_TEMPLATE],
          encoding: "terrarium",
          tileSize: 512,
          maxzoom: BASE_MAP_TERRAIN_MAX_ZOOM,
        },
      },
      layers: [
        {
          id: "osm",
          type: "raster",
          source: "osm",
        },
        {
          id: "hillshade",
          type: "hillshade",
          source: "hillshadeSource",
          paint: {
            "hillshade-shadow-color": "rgba(25, 20, 12, 0.5)",
            "hillshade-highlight-color": "rgba(255, 255, 255, 0.3)",
            "hillshade-accent-color": "rgba(60, 48, 30, 0.32)",
            "hillshade-exaggeration": 0.48,
          },
        },
      ],
    };
  }

  if (mode === "satellite") {
    return {
      version: 8,
      sources: {
        satellite: {
          type: "raster",
          tiles: [SATELLITE_TILE_URL],
          tileSize: 256,
          maxzoom: 19,
        },
      },
      layers: [
        {
          id: "satellite",
          type: "raster",
          source: "satellite",
        },
      ],
    };
  }

  if (mode === "gradient") {
    return {
      version: 8,
      sources: {
        hillshadeSource: {
          type: "raster-dem",
          tiles: [TERRAIN_TILE_URL_TEMPLATE],
          encoding: "terrarium",
          tileSize: 512,
          maxzoom: BASE_MAP_TERRAIN_MAX_ZOOM,
        },
        gradient: {
          type: "raster",
          tiles: [TERRAIN_GRADIENT_TILE_URL_TEMPLATE],
          tileSize: 512,
          maxzoom: BASE_MAP_TERRAIN_MAX_ZOOM,
        },
      },
      layers: [
        {
          id: "hillshade",
          type: "hillshade",
          source: "hillshadeSource",
          paint: {
            "hillshade-shadow-color": "#473b24",
            "hillshade-highlight-color": "#ffffff",
            "hillshade-accent-color": "#5c4a2f",
            "hillshade-exaggeration": 0.5,
          },
        },
        {
          id: "gradient",
          type: "raster",
          source: "gradient",
          paint: { "raster-opacity": GRADIENT_RASTER_OPACITY },
        },
      ],
    };
  }

  // hillshade-only
  return {
    version: 8,
    sources: {
      hillshadeSource: {
        type: "raster-dem",
        tiles: [TERRAIN_TILE_URL_TEMPLATE],
        encoding: "terrarium",
        tileSize: 512,
        maxzoom: BASE_MAP_TERRAIN_MAX_ZOOM,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#1a1f24" },
      },
      {
        id: "hillshade",
        type: "hillshade",
        source: "hillshadeSource",
        paint: {
          "hillshade-shadow-color": "#473b24",
          "hillshade-highlight-color": "#ffffff",
          "hillshade-accent-color": "#5c4a2f",
          "hillshade-exaggeration": 0.5,
        },
      },
    ],
  };
}

function waitForMapIdle(map, timeoutMs = IDLE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Basemap preview idle timeout"));
    }, timeoutMs);

    const onIdle = () => {
      cleanup();
      resolve();
    };

    function cleanup() {
      window.clearTimeout(timer);
      map.off("idle", onIdle);
    }

    map.once("idle", onIdle);
  });
}

function canvasToPngBlob(sourceCanvas) {
  const out = document.createElement("canvas");
  out.width = ICON_SIZE;
  out.height = ICON_SIZE;
  const ctx = out.getContext("2d");
  if (!ctx) {
    return Promise.reject(new Error("No 2d context for basemap preview"));
  }
  ctx.drawImage(sourceCanvas, 0, 0, ICON_SIZE, ICON_SIZE);
  return new Promise((resolve, reject) => {
    out.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to encode basemap preview PNG"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

async function captureModePreview(mode) {
  if (typeof maplibregl === "undefined") {
    throw new Error("MapLibre not available");
  }

  const bounds = kmBoxAroundLngLat(
    PREVIEW_CENTER.lng,
    PREVIEW_CENTER.lat,
    PREVIEW_RADIUS_KM
  );

  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:0",
    `width:${CAPTURE_SIZE}px`,
    `height:${CAPTURE_SIZE}px`,
    "overflow:hidden",
    "pointer-events:none",
    "opacity:0",
  ].join(";");
  document.body.appendChild(container);

  let map = null;
  try {
    map = new maplibregl.Map({
      container,
      style: styleForMode(mode),
      center: [PREVIEW_CENTER.lng, PREVIEW_CENTER.lat],
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      preserveDrawingBuffer: true,
      pitchWithRotate: false,
    });
    map.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: 0, animate: false }
    );
    await waitForMapIdle(map);
    // One extra frame so WebGL presents the idle frame into the canvas.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return await canvasToPngBlob(map.getCanvas());
  } finally {
    try {
      map?.remove();
    } catch {
      // ignore
    }
    container.remove();
  }
}

async function loadAllIcons() {
  const icons = {};
  for (const mode of MODES) {
    icons[mode] = await loadCachedIcon(mode);
  }
  return icons;
}

function allIconsPresent(icons) {
  return MODES.every((mode) => Boolean(icons?.[mode]));
}

async function generateAllIcons() {
  const icons = {};
  const blobs = {};
  for (const mode of MODES) {
    try {
      const blob = await captureModePreview(mode);
      blobs[mode] = blob;
      icons[mode] = URL.createObjectURL(blob);
    } catch (error) {
      console.warn(`Basemap preview capture failed for ${mode}`, error);
      return null;
    }
  }
  for (const mode of MODES) {
    await saveCachedIcon(mode, blobs[mode]);
  }
  return icons;
}

function applyIconsToButtons(buttons, icons) {
  for (const mode of MODES) {
    const btn = buttons?.[mode];
    const url = icons[mode];
    if (!btn || !url) {
      continue;
    }
    btn.classList.add("basemap-preview-ready");
    btn.setAttribute("aria-label", MODE_LABELS[mode]);
    btn.replaceChildren();
    const img = document.createElement("img");
    img.className = "basemap-preview-icon";
    img.src = url;
    img.alt = "";
    img.draggable = false;
    btn.appendChild(img);
  }
}

/**
 * Load or generate Matterhorn basemap thumbnails (hillshade / OSM / satellite / gradient).
 * Applies icons only when all four are present; otherwise leaves text labels.
 */
export async function ensureBasemapPreviewIcons(buttons) {
  if (
    !buttons?.hillshade ||
    !buttons?.osm ||
    !buttons?.satellite ||
    !buttons?.gradient
  ) {
    return false;
  }

  let icons = await loadAllIcons();
  if (!allIconsPresent(icons)) {
    for (const url of Object.values(icons)) {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
    icons = await generateAllIcons();
    if (!allIconsPresent(icons)) {
      return false;
    }
  }

  applyIconsToButtons(buttons, icons);
  previewIconUrls = icons;
  return true;
}
