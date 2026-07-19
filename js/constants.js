import { pickTerrainZoom } from "./geo.js";
import { OPENAIP_VECTOR_LAYER_IDS } from "./openaip-tiles.js";

export const DEFAULT_MAX_ALTITUDE = 4050;
export const MIN_SEEDS = 1;
export const AUTO_WINDOW_SIZE_DEFAULT_KM = 100;
export const AUTO_WINDOW_GLIDE_FACTOR = 1.25;
export const AUTO_MAX_OFFSET_FROM_CENTER = 0.25;
export const AUTO_COMPUTE_DEBOUNCE_MS = 400;
export const AIRPORT_PICK_HIT_PX = 14;
export const MAP_CENTER = { lng: 10.13, lat: 45.77 };
export const MAP_INITIAL_ZOOM = 5.69;
export const CACHE_SELECT_ZOOM = 5;
export const INITIAL_TERRAIN_Z = pickTerrainZoom(MAP_CENTER.lat);
export const MAP_MAX_ZOOM = 22;

export const MANUAL_INSPECT_MS = 5000;
export const OPENAIP_EXPIRY_WARN_DAYS = 6;
export const OPENAIP_UPDATE_OK_COUNTDOWN_STEP_MS = 1000;

export const GRADIENT_MAX_ALT_MIN = 500;
export const GRADIENT_MAX_ALT_MAX = 9000;
export const GRADIENT_MAX_ALT_STEP = 500;
export const GRADIENT_MAX_ALT_DEFAULT = 5000;
export const GRADIENT_MIN_ALT_DEFAULT = 0;
export const GRADIENT_RASTER_OPACITY = 0.6;

export const MISSING_TERRAIN_CACHE_MSG =
  'No terrain has been cached for this location — open the menu and use Add data';

export function isMissingCachedCoverageError(message) {
  const text = String(message ?? "");
  return (
    text === "No airports fall inside the compute grid" ||
    (text.includes("not cached") && text.toLowerCase().includes("terrain"))
  );
}

export const REST_AIRSPACE_SOURCE = "rest-airspaces";
export const REST_AIRSPACE_FILL_LAYER = "rest-airspaces-fill";
export const REST_AIRSPACE_LINE_LAYER = "rest-airspaces-line";

export const EMPTY_PATH = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: [] },
  properties: {},
};

export const MANUAL_AIRPORT_SELECT_HIDDEN_LAYER_IDS = [
  "glide-cone",
  "glide-contours-line",
  "glide-contours-label",
  "glide-sectors-line",
  "airports-cached-hit",
  "glide-path",
  "glide-path-ground",
  "glide-path-geo",
  "glide-path-geo-ground",
];

export const CACHE_HIDDEN_LAYER_IDS = [
  "glide-cone",
  "glide-contours-line",
  "glide-contours-label",
  "glide-sectors-line",
  "airports-cached-hit",
  ...OPENAIP_VECTOR_LAYER_IDS,
  "pending-manual-airport-circle",
  "glide-path",
  "glide-path-ground",
  "glide-path-geo",
  "glide-path-geo-ground",
];

export const COMPUTE_DONE_STATUS_CLEAR_MS = 2000;

export const CACHE_SELECT_FOOTER_HINT = 'Select areas of interest, then hit "cache"';

export const PARAM_HELP = {
  ld: "Glide ratio",
  circuit:
    "Height AGL for beginning of downwind leg",
  clearance:
    "Minimum height AGL. Don't set too low, it is the margin above mountain passes, and above slowly descending ground.",
  "max-alt":
    "Max altitude that you are interested in.",
  "terrain-zoom":
    "Mapterhorn DEM tile zoom (7–10). Leave at 7. zoom 8 has about 2X better resolution but takes 4X more time, zoom 9: 16x and so on.",
  "auto-window-size":
    "In auto mode, the computed window is following the position of the center of the screen. Bigger window, longer wait during updates..",
  "auto-window-from-glide":
    "In auto mode, the computed window is following the position of the center of the screen. Bigger window, longer wait during updates. \n\nSets window half-width to 1.25 × max altitude (m) × L/D",
  "include-airspace":
    "Include prohibited/overflight-restriction airspace types from OpenAIP so that trajectories go above or around.",
  "viz-mode":
    "Path only — glide paths on hover/tap, no overlay. \n\nSectors — per-airport colors with grey borders. \n\nContours — 100 m isolines with labels. \n\nContours + sectors — sector fill and borders with contour lines on top. \n\nStripes, raw raster, and modified cells (debug) — alternating 100 m bands, per-cell colors, or last-iteration dirty flags.",
  preview:
    "How often the map refreshes during GPU compute (sectors, stripes, and raw raster). 0 = update once at the end.",
};

export const VIZ_HINTS = {
  "path-only": "No overlay — hover or tap the map to inspect glide paths.",
  sectors: "Per-airport fill colors (lat/lon hash); grey borders as map lines between sectors.",
  "contours-sectors":
    "Sector fill and borders with 100 m contour lines on top; GeoJSON export after run.",
  stripes: "100 m bands relative to airport altitude.",
  raw: "Per-cell altitude colors.",
  "modified-cells": "Black = cells modified on the last GPU iteration; transparent elsewhere.",
  contours: "100 m isolines with labels; GeoJSON export after run.",
};

export const GLIDE_PATH_GROUND_FILTER = ["==", ["get", "segment"], "downhill-ground"];
export const GLIDE_PATH_DEFAULT_FILTER = [
  "any",
  ["!", ["has", "segment"]],
  ["!=", ["get", "segment"], "downhill-ground"],
];

export function glidePathLayerFilter(role, ground = false) {
  return [
    "all",
    ["==", ["get", "role"], role],
    ground ? GLIDE_PATH_GROUND_FILTER : GLIDE_PATH_DEFAULT_FILTER,
  ];
}

export const GLIDE_PATH_PAINT = {
  "line-color": "#8b1515",
  "line-width": 3,
  "line-opacity": 0.95,
};

export const GLIDE_PATH_GROUND_PAINT = {
  "line-color": "#111111",
  "line-width": 3,
  "line-opacity": 0.95,
  "line-dasharray": [0, 2.5],
};

export const GLIDE_PATH_GROUND_LAYOUT = {
  "line-cap": "round",
};

export { CELL_COUNTRIES, countriesForCellKeys } from "./openaip-cell-countries.js";
