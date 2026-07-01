import { pickTerrainZoom } from "./geo.js";
import { OPENAIP_AIRSPACE_LAYER } from "./openaip-tiles.js";

export const DEFAULT_MAX_ALTITUDE = 4050;
export const MIN_SEEDS = 1;
export const AUTO_WINDOW_SIZE_DEFAULT_KM = 100;
export const AUTO_WINDOW_GLIDE_FACTOR = 1.25;
export const AUTO_MAX_OFFSET_FROM_CENTER = 0.25;
export const AUTO_COMPUTE_DEBOUNCE_MS = 400;
export const AIRPORT_RECT_MIN_DEG = 1e-5;
export const AIRPORT_HANDLE_HIT_PX = 12;
export const AIRPORT_PICK_HIT_PX = 14;
export const AIRPORT_HANDLE_CURSORS = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
};
export const MAP_CENTER = { lng: 9.0788, lat: 47.1194 };
export const INITIAL_TERRAIN_Z = pickTerrainZoom(MAP_CENTER.lat);
export const MAP_MAX_ZOOM = 22;

export const MANUAL_INSPECT_MS = 5000;

export const REST_AIRSPACE_SOURCE = "rest-airspaces";
export const REST_AIRSPACE_FILL_LAYER = "rest-airspaces-fill";
export const REST_AIRSPACE_LINE_LAYER = "rest-airspaces-line";

export const EMPTY_PATH = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: [] },
  properties: {},
};

export const CACHE_HIDDEN_LAYER_IDS = [
  "glide-cone",
  "glide-cone-full",
  "glide-contours-line",
  "glide-contours-label",
  "glide-sectors-line",
  "airports-cached",
  "airports-cached-labels",
  "airports-cached-hit",
  OPENAIP_AIRSPACE_LAYER,
  "seeds-circle",
  "seeds-label",
  "seeds-hit",
  "pending-manual-airport-circle",
  "glide-path",
  "glide-path-geo",
  "airport-select-areas-fill",
  "airport-select-areas-line",
  "airport-select-handles",
];

export const COMPUTE_DONE_STATUS_CLEAR_MS = 2000;

export const PARAM_HELP = {
  ld: "Glide ratio (distance : altitude loss). Horizontal reach from an airport is roughly (altitude − terrain) × L/D. Together with max altitude, this also sets the grid extent (radius ≈ max altitude × L/D).",
  circuit:
    "Height above terrain at each airport before glide-down. Airport altitude = terrain MSL + circuit height.",
  clearance:
    "Minimum height above terrain for reachable cells. The flyable surface in the DEM is terrain + this clearance.",
  "max-alt":
    "Ceiling for the simulation. Unreachable cells stay at this value. With L/D, it caps how large the computed grid can be.",
  "terrain-zoom":
    "Mapterhorn DEM tile zoom (7–10). Higher zoom = finer cell resolution and larger grids. Resolution shown is the ground distance per DEM cell at the map centre.",
  "auto-window-size":
    "Half-width of the auto search box in km (± from map centre, total span ×2). Ignored when “Window from glide range” is on.",
  "auto-window-from-glide":
    "Set window half-width to 1.25 × max altitude (m) × L/D, converted to km. Updates when max altitude or L/D changes.",
  "include-airspace":
    "Show prohibited/overflight-restriction fills from cached REST data and airspace outlines from OpenAIP vector tiles. DEM capping uses the same REST volumes.",
  "los-run":
    "Line-of-sight check for distance calculation using the Bresenham algorithm.\n\nN = 0 — Raytrace all the way back to the source. Accurate, but slower.\n\nANYTHING ELSE THAN N=0 IS EXPERIMENTAL, MIGHT INTRODUCE MISTAKES, BUGS, PATH ENDING TOO EARLY.. DON'T USE IF YOU DON'T UNDERSTAND THE CODE BEHIND\n\nN = 10 — Raytrace back until the ray hits 10 consecutive pixels already validated as in line of sight of the source. Faster, and often accurate enough.\n\nN = 1 — Stop on the first pixel along the ray that was already validated in LOS (same 1-pixel match rule). Fast, but usually not accurate enough.",
  "viz-mode":
    "Path only — glide paths on hover/tap, no overlay. Sectors — per-airport colors from lat/lon hash; ground transparent. Contours — 100 m isolines with labels; exportable as GeoJSON. Stripes and raw raster (debug) — alternating 100 m bands or per-cell colors.",
  preview:
    "How often the map refreshes during GPU compute (sectors, stripes, and raw raster). 0 = update once at the end.",
  "compare-los":
    "Runs a full Bresenham line-of-sight overlay in red on the current grid, without the LOS run N shortcut. Use this to check how accurate your shortcut is compared to the exact raytrace.",
};

export const VIZ_HINTS = {
  "path-only": "No overlay — hover or tap the map to inspect glide paths.",
  sectors: "Per-airport fill colors (lat/lon hash); grey borders as map lines between sectors.",
  stripes: "100 m bands relative to airport altitude.",
  raw: "Per-cell altitude colors.",
  contours: "100 m isolines with labels; GeoJSON export after run.",
};

export const GLIDE_PATH_PAINT = {
  "line-color": [
    "match",
    ["get", "segment"],
    "downhill-ground",
    "#111111",
    "#8b1515",
  ],
  "line-width": 3,
  "line-opacity": 0.95,
};
