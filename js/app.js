import {
  gridBoundsLngLat,
  gridCellDistanceM,
  gridCellToLngLat,
  gridIndexFromLngLat,
  pickTerrainZoom,
  clampTerrainZoom,
  metersPerPixel,
} from "./geo.js";
import { buildDemGrid } from "./dem.js";
import { buildAltitudeContours } from "./contours.js";
import { GlideConeEngine } from "./glidecone.js";
import {
  initOpenAipTiles,
  getViewportOpenAipAirports,
  getOpenAipAirportsInBounds,
  queryOpenAipAirspacesAt,
  airspaceFeatureKey,
  setOpenAipAirspaceVisible,
  OPENAIP_AIRPORT_MIN_ZOOM,
} from "./openaip-tiles.js";
import { loadOpenAipConfig } from "./openaip-client.js";

const DEFAULT_MAX_ALTITUDE = 3050;
const LONG_PRESS_MS = 550;
const MIN_SEEDS = 1;
const AIRPORT_RECT_MIN_DEG = 1e-5;
const AIRPORT_HANDLE_HIT_PX = 12;
const AIRPORT_HANDLE_CURSORS = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
};
const MAP_CENTER = { lng: 9.0788, lat: 47.1194 };
const INITIAL_TERRAIN_Z = pickTerrainZoom(MAP_CENTER.lat);
const MAP_MAX_ZOOM = 22;
let map;

const EMPTY_PATH = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: [] },
  properties: {},
};

const info = document.getElementById("info");
const airspaceInfoEl = document.getElementById("airspace-info");
const statusEl = document.getElementById("status");
const cellInfoEl = document.getElementById("cell-info");
const paramsForm = document.getElementById("params");
const vizModeSelect = document.getElementById("viz-mode");
const previewFieldEl = document.getElementById("preview-field");
const vizHintEl = document.getElementById("viz-hint");
const gridRadiusHintEl = document.getElementById("grid-radius-hint");
const terrainZoomInput = document.getElementById("terrain-zoom");
const terrainResolutionHintEl = document.getElementById("terrain-resolution-hint");
const includeAirspaceInput = document.getElementById("include-airspace");
const paramHelpPopover = document.getElementById("param-help-popover");
const compareLosBtn = document.getElementById("compare-los");
const compareLosRow = document.getElementById("compare-los-row");
const downloadContoursBtn = document.getElementById("download-contours");
const stopComputeBtn = document.getElementById("stop-compute");
const runComputeBtn = document.getElementById("run-compute");
const selectViewportAirportsBtn = document.getElementById("select-viewport-airports");
const toggleAirportAreaSelectBtn = document.getElementById("toggle-airport-area-select");
const addAirportAreaBtn = document.getElementById("add-airport-area");
const addAirportsFromAreasBtn = document.getElementById("add-airports-from-areas");
const clearAirportAreasBtn = document.getElementById("clear-airport-areas");
const debugModeInput = document.getElementById("debug-mode");
const seedListEl = document.getElementById("seed-list");
const paramsPanel = document.getElementById("params-panel");
const paramsShell = document.getElementById("params-shell");
const paramsScrollEl = document.getElementById("params-scroll");
const seedsSectionEl = document.getElementById("seeds-section");
const airportAreaSelectPanel = document.getElementById("airport-area-select-panel");
const clearOverlayBtn = document.getElementById("clear-overlay");
const clearAllSeedsBtn = document.getElementById("clear-all-seeds");
const seedInputHintEl = document.getElementById("seed-input-hint");
const pathInputHintEl = document.getElementById("path-input-hint");

let engine = null;
let computing = false;
let computeShouldStop = false;
let overlayCanvas = null;
let compareOverlayCanvas = null;
let coneState = null;
let pathLayerReady = false;
let contourLayersReady = false;
let lastHoverCell = null;
let pendingSeeds = [];
let seedLayersReady = false;
let openAipConfig = null;
let touchHandledRecently = false;
let longPressTimer = null;
let longPressDone = false;
let touchStartPoint = null;
let footerStatusText = "Loading WebGPU…";
let footerCellHtml = null;
let airportAreaSelectMode = false;
let airportAreaDrawMode = false;
let airportSelectRects = [];
let airportSelectLayersReady = false;
let airportRectInteraction = null;

const interaction = {
  hoverPath: false,
  tapPath: false,
  clickSeed: false,
  longPressSeed: false,
};

function detectInteractionMode() {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const fine = window.matchMedia("(pointer: fine)").matches;
  const hover = window.matchMedia("(hover: hover)").matches;

  interaction.hoverPath = hover && fine;
  interaction.tapPath = coarse;
  interaction.clickSeed = fine;
  interaction.longPressSeed = coarse;

  updateInteractionHints();
}

function updateInteractionHints() {
  const seedParts = [];
  const pathParts = [];

  if (interaction.clickSeed) {
    seedParts.push("Click the map to place a seed");
  }
  if (interaction.longPressSeed) {
    seedParts.push("long-press the map to place a seed");
  }
  if (interaction.hoverPath) {
    pathParts.push("Hover over the overlay to show the glide path");
  }
  if (interaction.tapPath) {
    pathParts.push("tap the overlay to show the glide path");
  }

  if (seedInputHintEl) {
    seedInputHintEl.textContent =
      seedParts.length > 0 ? `${seedParts.join("; ")}.` : "";
  }
  if (pathInputHintEl) {
    pathInputHintEl.textContent =
      pathParts.length > 0 ? `${pathParts.join("; ")}.` : "";
  }
}

function markTouchHandled() {
  touchHandledRecently = true;
  window.setTimeout(() => {
    touchHandledRecently = false;
  }, 400);
}

function cancelLongPress() {
  if (longPressTimer !== null) {
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function updateParamsFooter() {
  if (!cellInfoEl || !statusEl) {
    return;
  }
  if (footerCellHtml) {
    cellInfoEl.innerHTML = footerCellHtml;
    cellInfoEl.hidden = false;
    statusEl.hidden = true;
    return;
  }
  cellInfoEl.hidden = true;
  statusEl.hidden = false;
  statusEl.textContent = footerStatusText;
}

function clearCellInspect() {
  footerCellHtml = null;
  lastHoverCell = null;
  clearGlidePath();
  updateParamsFooter();
}

function showCellInspect(cell) {
  if (!cell) {
    clearCellInspect();
    return;
  }

  footerCellHtml = formatHoverTip(cell);

  if (cell.isReachable) {
    lastHoverCell = cell;
    refreshHoverPath(cell);
  } else {
    lastHoverCell = null;
    clearGlidePath();
  }

  updateParamsFooter();
}

function startComputeSession() {
  computeShouldStop = false;
  computing = true;
  stopComputeBtn.hidden = false;
  stopComputeBtn.disabled = false;
  if (runComputeBtn) {
    runComputeBtn.disabled = true;
  }
  if (selectViewportAirportsBtn) {
    selectViewportAirportsBtn.disabled = true;
  }
  if (airportAreaSelectMode) {
    exitAirportAreaSelectMode(false);
  }
  syncCompareLosButton();
}

function endComputeSession() {
  computing = false;
  computeShouldStop = false;
  stopComputeBtn.hidden = true;
  stopComputeBtn.disabled = false;
  updateSeedMarkers();
  syncCompareLosButton();
}

function requestStopCompute() {
  computeShouldStop = true;
  stopComputeBtn.disabled = true;
  setStatus("Stopping after current GPU step…");
}

function formatComputeDone(result, extra = "") {
  const suffix = result.stopped ? " (stopped)" : "";
  return `Done — ${result.iterations} iters, ${result.elapsedMs.toFixed(0)} ms GPU${suffix}${extra}`;
}

function makeComputeOptions(dem, glideParams) {
  return {
    onProgress: makeComputeProgressHandler(dem, glideParams),
    shouldStop: () => computeShouldStop,
  };
}

let openParamHelpButton = null;

const PARAM_HELP = {
  ld: "Glide ratio (distance : altitude loss). Horizontal reach from a seed is roughly (altitude − terrain) × L/D. Together with max altitude, this also sets the grid extent (radius ≈ max altitude × L/D).",
  circuit:
    "Height above terrain at each seed before glide-down. Seed altitude = terrain MSL + circuit height.",
  clearance:
    "Minimum height above terrain for reachable cells. The flyable surface in the DEM is terrain + this clearance.",
  "max-alt":
    "Ceiling for the simulation. Unreachable cells stay at this value. With L/D, it caps how large the computed grid can be.",
  "terrain-zoom":
    "Mapterhorn DEM tile zoom (7–10). Higher zoom = finer cell resolution and larger grids. Resolution shown is the ground distance per DEM cell at the map centre.",
  "include-airspace":
    "Show airspace on the map and cap the DEM under prohibited volumes and overflight-restriction areas (OpenAIP types: prohibited, overflight restriction). Airports stay visible either way.",
  "los-run":
    "Line-of-sight check for distance calculation using the Bresenham algorithm.\n\nN = 0 — Raytrace all the way back to the source. Accurate, but slower.\n\nN = 10 — Raytrace back until the ray hits 10 consecutive pixels already validated as in line of sight of the source. Faster, and often accurate enough.\n\nN = 1 — Stop on the first pixel along the ray that was already validated in LOS (same 1-pixel match rule). Fast, but usually not accurate enough.",
  "viz-mode":
    "Stripes — 100 m altitude bands. Raw raster — per-cell altitude colors. Contours — 100 m isolines with labels; exportable as GeoJSON after a run.",
  preview:
    "How often the map refreshes during GPU compute (stripes and raw raster only). 0 = update once at the end.",
  "compare-los":
    "Runs a full Bresenham line-of-sight overlay in red on the current grid, without the LOS run N shortcut. Use this to check how accurate your shortcut is compared to the exact raytrace.",
};

const VIZ_HINTS = {
  stripes: "100 m bands relative to seed altitude.",
  raw: "Per-cell altitude colors.",
  contours: "100 m isolines with labels; GeoJSON export after run.",
};

function parseVizMode() {
  const mode = vizModeSelect?.value ?? "stripes";
  return {
    mode,
    raw: mode === "raw",
    contours: mode === "contours",
  };
}

function syncParamVisibility() {
  const { mode } = parseVizMode();
  if (previewFieldEl) {
    previewFieldEl.hidden = mode === "contours";
  }
  if (vizHintEl) {
    vizHintEl.textContent = VIZ_HINTS[mode] ?? "";
  }
}

function isDebugMode() {
  return debugModeInput?.checked ?? false;
}

function getParamHelpText(key) {
  let text = PARAM_HELP[key];
  if (!text) {
    return null;
  }
  if (key === "los-run") {
    text += isDebugMode()
      ? "\n\nFull Bresenham comparison and path-length diagnostics are available (Debug mode on)."
      : "\n\nEnable Debug mode at the bottom of this panel for Full Bresenham comparison and path-length diagnostics.";
  }
  return text;
}

function syncDebugUi() {
  paramsShell?.classList.toggle("debug-mode", isDebugMode());
  if (openParamHelpButton?.dataset.help === "los-run" && paramHelpPopover) {
    const text = getParamHelpText("los-run");
    if (text) {
      paramHelpPopover.textContent = text;
    }
  }
  syncCompareLosButton();
  syncDownloadContoursButton();
  if (lastHoverCell) {
    showCellInspect(lastHoverCell);
  }
}

function isIncludeAirspaceEnabled() {
  return includeAirspaceInput?.checked ?? false;
}

function syncAirspaceUi() {
  setOpenAipAirspaceVisible(map, isIncludeAirspaceEnabled());
  if (isIncludeAirspaceEnabled()) {
    info.classList.add("visible");
  } else {
    info.classList.remove("visible");
    if (airspaceInfoEl) {
      airspaceInfoEl.textContent = "—";
    }
  }
}

function updateGridRadiusHint() {
  if (!gridRadiusHintEl) {
    return;
  }
  const glideRatio = Number.parseFloat(document.getElementById("ld").value);
  const maxAltitude = Number.parseFloat(document.getElementById("max-alt").value);
  if (!Number.isFinite(glideRatio) || glideRatio <= 0 || !Number.isFinite(maxAltitude) || maxAltitude <= 0) {
    gridRadiusHintEl.textContent = "";
    return;
  }
  const radiusKm = (maxAltitude * glideRatio) / 1000;
  gridRadiusHintEl.textContent = `Grid radius ≈ ${Math.round(radiusKm)} km`;
}

function getMapCenterLat() {
  return map?.getCenter?.().lat ?? MAP_CENTER.lat;
}

function updateTerrainResolutionHint() {
  if (!terrainResolutionHintEl) {
    return;
  }
  const zoom = clampTerrainZoom(Number.parseInt(terrainZoomInput?.value ?? "", 10));
  const cellSizeM = metersPerPixel(getMapCenterLat(), zoom);
  terrainResolutionHintEl.textContent = `Resolution: ~${Math.round(cellSizeM)} m`;
}

function syncTerrainTileMaxZoom() {
  if (!map?.getStyle?.()?.sources?.hillshadeSource) {
    return;
  }
  const zoom = clampTerrainZoom(Number.parseInt(terrainZoomInput?.value ?? "", 10));
  setTerrainTileMaxZoom(zoom);
}

function onTerrainZoomChange() {
  updateTerrainResolutionHint();
  syncTerrainTileMaxZoom();
}

function closeParamHelp() {
  if (!paramHelpPopover) {
    return;
  }
  paramHelpPopover.hidden = true;
  openParamHelpButton = null;
}

function openParamHelp(button) {
  const key = button.dataset.help;
  const text = getParamHelpText(key);
  if (!text || !paramHelpPopover) {
    return;
  }
  if (openParamHelpButton === button) {
    closeParamHelp();
    return;
  }
  paramHelpPopover.textContent = text;
  paramHelpPopover.hidden = false;
  const rect = button.getBoundingClientRect();
  paramHelpPopover.style.top = `${rect.bottom + 6}px`;
  paramHelpPopover.style.left = `${Math.min(rect.left, window.innerWidth - 290)}px`;
  openParamHelpButton = button;
}

function initParamPanel() {
  syncParamVisibility();
  updateGridRadiusHint();
  updateTerrainResolutionHint();

  for (const button of document.querySelectorAll(".param-help")) {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openParamHelp(button);
    });
  }

  document.addEventListener("click", (event) => {
    if (
      openParamHelpButton &&
      event.target !== openParamHelpButton &&
      event.target !== paramHelpPopover
    ) {
      closeParamHelp();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeParamHelp();
    }
  });

  for (const id of ["ld", "max-alt"]) {
    document.getElementById(id)?.addEventListener("input", updateGridRadiusHint);
  }

  terrainZoomInput?.addEventListener("input", onTerrainZoomChange);

  includeAirspaceInput?.addEventListener("change", () => {
    syncAirspaceUi();
    if (isIncludeAirspaceEnabled() && map) {
      const center = map.getCenter();
      updateAirspaceInfo(center.lng, center.lat);
    }
  });

  debugModeInput?.addEventListener("change", syncDebugUi);

  document.getElementById("los-run")?.addEventListener("input", syncCompareLosButton);
  detectInteractionMode();
  for (const query of ["(pointer: coarse)", "(pointer: fine)", "(hover: hover)"]) {
    window.matchMedia(query).addEventListener("change", detectInteractionMode);
  }
  syncCompareLosButton();
  syncDebugUi();
  updateParamsFooter();
}

initParamPanel();

function getGlideParams() {
  const glideRatio = Number.parseFloat(document.getElementById("ld").value);
  const circuitHeight = Number.parseFloat(document.getElementById("circuit").value);
  const groundClearance = Number.parseFloat(document.getElementById("clearance").value);
  const maxAltitude = Number.parseFloat(document.getElementById("max-alt").value);
  const originRunN = Number.parseInt(document.getElementById("los-run").value, 10);
  const terrainZoom = clampTerrainZoom(
    Number.parseInt(document.getElementById("terrain-zoom")?.value ?? "", 10)
  );
  const includeAirspace = isIncludeAirspaceEnabled();
  const updateMapMs = Number.parseInt(document.getElementById("update-map").value, 10);
  const { raw, contours } = parseVizMode();

  return {
    glideRatio: Number.isFinite(glideRatio) && glideRatio > 0 ? glideRatio : 20,
    circuitHeight: Number.isFinite(circuitHeight) && circuitHeight >= 0 ? circuitHeight : 250,
    groundClearance:
      Number.isFinite(groundClearance) && groundClearance >= 0 ? groundClearance : 100,
    maxAltitude:
      Number.isFinite(maxAltitude) && maxAltitude > 0 ? maxAltitude : DEFAULT_MAX_ALTITUDE,
    terrainZoom,
    includeAirspace,
    originRunN:
      Number.isFinite(originRunN) && originRunN === 0
        ? 0
        : Number.isFinite(originRunN) && originRunN >= 1
          ? originRunN
          : 0,
    raw,
    contours,
    updateMapMs:
      Number.isFinite(updateMapMs) && updateMapMs >= 0 ? updateMapMs : 100,
  };
}

map = new maplibregl.Map({
  container: "map",
  hash: "map",
  zoom: INITIAL_TERRAIN_Z,
  maxZoom: MAP_MAX_ZOOM,
  center: [MAP_CENTER.lng, MAP_CENTER.lat],
  style: {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      hillshadeSource: {
        type: "raster-dem",
        url: "https://tiles.mapterhorn.com/tilejson.json",
        encoding: "terrarium",
        tileSize: 512,
        maxzoom: INITIAL_TERRAIN_Z,
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
    ],
  },
});

map.addControl(new maplibregl.NavigationControl(), "top-right");

function updateAirspaceInfo(lng, lat) {
  if (!isIncludeAirspaceEnabled()) {
    return;
  }

  const openKeys = new Set();
  for (const el of airspaceInfoEl.querySelectorAll("details[open]")) {
    if (el.dataset.key) {
      openKeys.add(el.dataset.key);
    }
  }

  const features = queryOpenAipAirspacesAt(map, lng, lat);
  airspaceInfoEl.replaceChildren();

  if (!features.length) {
    airspaceInfoEl.textContent = "—";
    return;
  }

  for (const feature of features) {
    const key = airspaceFeatureKey(feature);
    const details = document.createElement("details");
    details.dataset.key = key;
    if (openKeys.has(key)) {
      details.open = true;
    }

    const summary = document.createElement("summary");
    const props = feature.properties ?? {};
    summary.textContent = props.name ?? props.icao_code ?? props.type ?? key;

    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(props, null, 2);

    details.append(summary, pre);
    airspaceInfoEl.append(details);
  }
}

function setStatus(text) {
  footerStatusText = text;
  updateParamsFooter();
}

function setTerrainTileMaxZoom(zoom) {
  const style = map.getStyle();
  if (!style?.sources?.hillshadeSource) {
    return;
  }

  style.sources.hillshadeSource.maxzoom = zoom;

  const cache = map.style?.sourceCaches?.hillshadeSource;
  if (cache?._source) {
    cache._source.maxzoom = zoom;
    cache.reload();
  }
}

function isSeedCell(x, y, dem) {
  if (dem.seeds?.length) {
    return dem.seeds.some((seed) => seed.x === x && seed.y === y);
  }
  return x === dem.homeX && y === dem.homeY;
}

function ensureSeedLayers() {
  if (seedLayersReady) {
    return;
  }

  map.addSource("seeds", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "seeds-circle",
    type: "circle",
    source: "seeds",
    paint: {
      "circle-radius": 7,
      "circle-color": "#ffcc00",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });

  map.addLayer({
    id: "seeds-label",
    type: "symbol",
    source: "seeds",
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 12,
      "text-offset": [0, -1.4],
      "text-anchor": "bottom",
    },
    paint: {
      "text-color": "#fff8dc",
      "text-halo-color": "rgba(18, 22, 28, 0.92)",
      "text-halo-width": 2,
    },
  });

  seedLayersReady = true;
}

function seedKey(seed) {
  return `${seed.lng.toFixed(5)},${seed.lat.toFixed(5)}`;
}

function formatAirportLabel(airport) {
  const props = airport.properties ?? {};
  const icao = props.icao_code ?? props.icaoCode;
  const name = props.name;
  if (icao && name) {
    return `${icao} — ${name}`;
  }
  return name ?? icao ?? `${airport.lat.toFixed(4)}°, ${airport.lng.toFixed(4)}°`;
}

function normalizeAirportSelectRect(a, b) {
  return {
    west: Math.min(a.lng, b.lng),
    east: Math.max(a.lng, b.lng),
    south: Math.min(a.lat, b.lat),
    north: Math.max(a.lat, b.lat),
  };
}

function airportSelectRectRing(rect) {
  const { west, south, east, north } = rect;
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

function airportSelectRectCorners(rect) {
  return [
    { handle: "nw", lng: rect.west, lat: rect.north },
    { handle: "ne", lng: rect.east, lat: rect.north },
    { handle: "se", lng: rect.east, lat: rect.south },
    { handle: "sw", lng: rect.west, lat: rect.south },
  ];
}

function resizeAnchorForHandle(rect, handle) {
  switch (handle) {
    case "nw":
      return { lng: rect.east, lat: rect.south };
    case "ne":
      return { lng: rect.west, lat: rect.south };
    case "se":
      return { lng: rect.west, lat: rect.north };
    case "sw":
      return { lng: rect.east, lat: rect.north };
    default:
      return { lng: rect.east, lat: rect.south };
  }
}

function hitTestRectHandle(point) {
  for (let index = airportSelectRects.length - 1; index >= 0; index -= 1) {
    const rect = airportSelectRects[index];
    for (const corner of airportSelectRectCorners(rect)) {
      const projected = map.project([corner.lng, corner.lat]);
      if (Math.hypot(point.x - projected.x, point.y - projected.y) <= AIRPORT_HANDLE_HIT_PX) {
        return { rectIndex: index, handle: corner.handle };
      }
    }
  }
  return null;
}

function syncAreaSelectCursor(point) {
  if (!airportAreaSelectMode || !map?.getCanvas() || airportRectInteraction) {
    return;
  }
  const hit = hitTestRectHandle(point);
  if (hit) {
    map.getCanvas().style.cursor = AIRPORT_HANDLE_CURSORS[hit.handle];
    return;
  }
  map.getCanvas().style.cursor = airportAreaDrawMode ? "crosshair" : "";
}

function ensureAirportSelectLayers() {
  if (airportSelectLayersReady) {
    return;
  }

  map.addSource("airport-select-areas", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "airport-select-areas-fill",
    type: "fill",
    source: "airport-select-areas",
    filter: ["!=", ["get", "handle"], true],
    paint: {
      "fill-color": "#5a9fd4",
      "fill-opacity": ["case", ["get", "preview"], 0.12, 0.22],
    },
  });

  map.addLayer({
    id: "airport-select-areas-line",
    type: "line",
    source: "airport-select-areas",
    filter: ["!=", ["get", "handle"], true],
    paint: {
      "line-color": "#5a9fd4",
      "line-width": 2,
    },
  });

  map.addLayer({
    id: "airport-select-handles",
    type: "circle",
    source: "airport-select-areas",
    filter: ["==", ["get", "handle"], true],
    paint: {
      "circle-radius": 5,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#5a9fd4",
      "circle-stroke-width": 2,
    },
  });

  airportSelectLayersReady = true;
}

function updateAirportSelectLayer() {
  if (!airportSelectLayersReady) {
    return;
  }

  const features = airportSelectRects.flatMap((rect, index) => {
    const polygon = {
      type: "Feature",
      properties: { index, preview: false, handle: false },
      geometry: {
        type: "Polygon",
        coordinates: [airportSelectRectRing(rect)],
      },
    };
    const handles = airportSelectRectCorners(rect).map((corner) => ({
      type: "Feature",
      properties: { index, handle: true, corner: corner.handle },
      geometry: {
        type: "Point",
        coordinates: [corner.lng, corner.lat],
      },
    }));
    return [polygon, ...handles];
  });

  if (airportRectInteraction?.kind === "draw") {
    features.push({
      type: "Feature",
      properties: { preview: true, handle: false },
      geometry: {
        type: "Polygon",
        coordinates: [
          airportSelectRectRing(
            normalizeAirportSelectRect(airportRectInteraction.start, airportRectInteraction.current)
          ),
        ],
      },
    });
  }

  map.getSource("airport-select-areas").setData({
    type: "FeatureCollection",
    features,
  });
}

function syncAirportAreaSelectUi() {
  if (toggleAirportAreaSelectBtn) {
    toggleAirportAreaSelectBtn.disabled = computing || !map.getSource("openaip");
  }
  if (addAirportsFromAreasBtn) {
    addAirportsFromAreasBtn.disabled =
      computing || airportSelectRects.length === 0 || !map.getSource("openaip");
  }
  if (clearAirportAreasBtn) {
    clearAirportAreasBtn.disabled = computing || airportSelectRects.length === 0;
  }
  if (addAirportAreaBtn) {
    addAirportAreaBtn.disabled =
      computing || !airportAreaSelectMode || airportAreaDrawMode || airportRectInteraction;
  }
  if (airportAreaSelectPanel) {
    airportAreaSelectPanel.hidden = !airportAreaSelectMode;
  }
  if (map?.getCanvas() && !airportAreaSelectMode) {
    map.getCanvas().style.cursor = "";
  }
}

function cancelAirportRectInteraction() {
  if (airportRectInteraction) {
    map.dragPan.enable();
  }
  airportRectInteraction = null;
  updateAirportSelectLayer();
}

function scrollToSeedsSection() {
  if (!paramsScrollEl || !seedsSectionEl) {
    return;
  }
  paramsScrollEl.scrollTo({
    top: Math.max(0, seedsSectionEl.offsetTop - 8),
    behavior: "smooth",
  });
}

function enterAirportAreaSelectMode() {
  if (computing || !map.getSource("openaip")) {
    return;
  }
  airportAreaSelectMode = true;
  airportAreaDrawMode = airportSelectRects.length === 0;
  if (paramsPanel) {
    paramsPanel.open = false;
  }
  ensureAirportSelectLayers();
  syncAirportAreaSelectUi();
  setStatus(
    airportAreaDrawMode
      ? "Drag on the map to draw an area."
      : "Pan and zoom freely, or use Add new area to draw another."
  );
}

function startAddAirportArea() {
  if (!airportAreaSelectMode || computing) {
    return;
  }
  airportAreaDrawMode = true;
  syncAirportAreaSelectUi();
  setStatus("Drag on the map to draw a new area.");
}

function exitAirportAreaSelectMode(reopenParams = false) {
  airportAreaSelectMode = false;
  airportAreaDrawMode = false;
  cancelAirportRectInteraction();
  syncAirportAreaSelectUi();
  if (reopenParams && paramsPanel) {
    paramsPanel.open = true;
    window.requestAnimationFrame(() => scrollToSeedsSection());
  }
  if (map?.getCanvas()) {
    map.getCanvas().style.cursor = "";
  }
}

function commitAirportSelectRect(endLngLat) {
  const { start } = airportRectInteraction ?? {};
  if (!start || !endLngLat) {
    return false;
  }

  const rect = normalizeAirportSelectRect(start, endLngLat);
  if (rect.east - rect.west < AIRPORT_RECT_MIN_DEG || rect.north - rect.south < AIRPORT_RECT_MIN_DEG) {
    return false;
  }

  airportSelectRects.push(rect);
  airportAreaDrawMode = false;
  syncAirportAreaSelectUi();
  setStatus(
    `${airportSelectRects.length} area${airportSelectRects.length === 1 ? "" : "s"} drawn — pan/zoom freely, or Add new area`
  );
  return true;
}

function beginAirportAreaInteraction(lngLat, point) {
  if (!airportAreaSelectMode || computing) {
    return false;
  }

  ensureAirportSelectLayers();

  const hit = hitTestRectHandle(point);
  if (hit) {
    const rect = airportSelectRects[hit.rectIndex];
    airportRectInteraction = {
      kind: "resize",
      rectIndex: hit.rectIndex,
      handle: hit.handle,
      anchor: resizeAnchorForHandle(rect, hit.handle),
    };
    map.dragPan.disable();
    updateAirportSelectLayer();
    return true;
  }

  if (!airportAreaDrawMode) {
    return false;
  }

  airportRectInteraction = {
    kind: "draw",
    start: lngLat,
    current: lngLat,
  };
  map.dragPan.disable();
  updateAirportSelectLayer();
  return true;
}

function updateAirportAreaInteraction(lngLat) {
  if (!airportRectInteraction) {
    return;
  }

  if (airportRectInteraction.kind === "draw") {
    airportRectInteraction.current = lngLat;
  } else if (airportRectInteraction.kind === "resize") {
    const { rectIndex, anchor } = airportRectInteraction;
    airportSelectRects[rectIndex] = normalizeAirportSelectRect(anchor, lngLat);
  }

  updateAirportSelectLayer();
}

function finishAirportAreaInteraction(lngLat) {
  if (!airportRectInteraction) {
    return false;
  }

  if (airportRectInteraction.kind === "draw") {
    commitAirportSelectRect(lngLat);
  }

  cancelAirportRectInteraction();
  syncAirportAreaSelectUi();
  return true;
}

function addAirportsFromSelectAreas() {
  if (airportSelectRects.length === 0) {
    setStatus("Draw one or more areas on the map first");
    return;
  }

  const existing = new Set(pendingSeeds.map((seed) => seedKey(seed)));
  let added = 0;
  for (const rect of airportSelectRects) {
    const airports = getOpenAipAirportsInBounds(
      map,
      rect.west,
      rect.south,
      rect.east,
      rect.north
    );
    for (const airport of airports) {
      const seed = {
        lng: airport.lng,
        lat: airport.lat,
        label: formatAirportLabel(airport),
        source: "airport",
      };
      const key = seedKey(seed);
      if (existing.has(key)) {
        continue;
      }
      existing.add(key);
      pendingSeeds.push(seed);
      added += 1;
    }
  }

  updateSeedMarkers();
  const areaCount = airportSelectRects.length;
  clearAirportSelectAreas();
  exitAirportAreaSelectMode(true);
  if (added === 0) {
    setStatus(`No new airports in the drawn areas — zoom in to z${OPENAIP_AIRPORT_MIN_ZOOM} or higher`);
  } else {
    setStatus(
      `Added ${added} airport${added === 1 ? "" : "s"} from ${areaCount} area${areaCount === 1 ? "" : "s"} — ${pendingSeeds.length} seed${pendingSeeds.length === 1 ? "" : "s"} total`
    );
  }
}

function clearAirportSelectAreas() {
  airportSelectRects = [];
  airportAreaDrawMode = airportAreaSelectMode;
  cancelAirportRectInteraction();
  if (airportSelectLayersReady && map.getSource("airport-select-areas")) {
    updateAirportSelectLayer();
  }
  syncAirportAreaSelectUi();
}

function seedDisplayLabel(seed) {
  if (seed.label) {
    return seed.label;
  }
  return `${seed.lat.toFixed(4)}°, ${seed.lng.toFixed(4)}°`;
}

function sortedSeedEntries() {
  return pendingSeeds
    .map((seed, index) => ({ seed, index }))
    .sort((a, b) =>
      seedDisplayLabel(a.seed).localeCompare(seedDisplayLabel(b.seed), undefined, {
        sensitivity: "base",
      })
    );
}

function updateSeedList() {
  if (!seedListEl) {
    return;
  }
  seedListEl.replaceChildren();

  if (pendingSeeds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "seed-list-empty";
    empty.textContent = "Click the map, select viewport airports, or draw areas";
    seedListEl.append(empty);
    return;
  }

  for (const { seed, index } of sortedSeedEntries()) {
    const row = document.createElement("div");
    row.className = "seed-list-item";

    const label = document.createElement("span");
    label.className = "seed-list-label";
    label.textContent = seedDisplayLabel(seed);
    label.title = seedDisplayLabel(seed);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "seed-list-delete";
    del.setAttribute("aria-label", `Remove ${seedDisplayLabel(seed)}`);
    del.textContent = "×";
    del.addEventListener("click", () => removePendingSeed(index));

    row.append(label, del);
    seedListEl.append(row);
  }
}

function removePendingSeed(index) {
  if (computing || index < 0 || index >= pendingSeeds.length) {
    return;
  }
  pendingSeeds.splice(index, 1);
  updateSeedMarkers();
  updateSeedList();
  if (pendingSeeds.length === 0) {
    setStatus("Seeds cleared — click the map or select viewport airports");
  } else {
    setStatus(`${pendingSeeds.length} seed${pendingSeeds.length === 1 ? "" : "s"} selected`);
  }
}

function updateSeedMarkers() {
  ensureSeedLayers();
  const features = pendingSeeds.map((seed, index) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [seed.lng, seed.lat],
    },
    properties: {
      label: String(index + 1),
    },
  }));

  map.getSource("seeds").setData({
    type: "FeatureCollection",
    features,
  });

  if (runComputeBtn) {
    runComputeBtn.disabled = pendingSeeds.length < MIN_SEEDS || computing;
  }
  if (selectViewportAirportsBtn) {
    selectViewportAirportsBtn.disabled = computing || !map.getSource("openaip");
  }
  syncAirportAreaSelectUi();
  updateSeedList();
}

function addPendingSeed(lng, lat) {
  const key = seedKey({ lng, lat });
  if (pendingSeeds.some((seed) => seedKey(seed) === key)) {
    setStatus("Seed already in list");
    return;
  }
  pendingSeeds.push({ lng, lat, source: "map" });
  updateSeedMarkers();
  updateAirspaceInfo(lng, lat);
  setStatus(`${pendingSeeds.length} seed${pendingSeeds.length === 1 ? "" : "s"} selected`);
}

function addViewportAirportsToSeeds() {
  const airports = getViewportOpenAipAirports(map);
  if (airports.length === 0) {
    setStatus(`No airports in viewport — zoom in to z${OPENAIP_AIRPORT_MIN_ZOOM} or higher`);
    return;
  }

  const existing = new Set(pendingSeeds.map((seed) => seedKey(seed)));
  let added = 0;
  for (const airport of airports) {
    const seed = {
      lng: airport.lng,
      lat: airport.lat,
      label: formatAirportLabel(airport),
      source: "airport",
    };
    const key = seedKey(seed);
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    pendingSeeds.push(seed);
    added += 1;
  }

  updateSeedMarkers();
  if (added === 0) {
    setStatus("All viewport airports are already in the list");
  } else {
    setStatus(
      `Added ${added} airport${added === 1 ? "" : "s"} — ${pendingSeeds.length} seed${pendingSeeds.length === 1 ? "" : "s"} total`
    );
  }
}

function clearPendingSeeds() {
  pendingSeeds = [];
  updateSeedMarkers();
  setStatus("Seeds cleared — click the map or select viewport airports");
}

function raisePathLayer() {
  if (pathLayerReady && map.getLayer("glide-path")) {
    map.moveLayer("glide-path");
  }
  if (contourLayersReady && map.getLayer("glide-contours-label")) {
    map.moveLayer("glide-contours-line");
    map.moveLayer("glide-contours-label");
  }
}

function ensurePathLayer() {
  if (pathLayerReady) {
    return;
  }
  map.addSource("glide-path", {
    type: "geojson",
    data: EMPTY_PATH,
  });
  map.addLayer({
    id: "glide-path",
    type: "line",
    source: "glide-path",
    paint: {
      "line-color": "#ffcc00",
      "line-width": 3,
      "line-opacity": 0.95,
    },
  });
  pathLayerReady = true;
  raisePathLayer();
}

function setConeState(dem, result, glideParams) {
  coneState = {
    dem,
    altitudes: result.altitudes,
    originX: result.originX,
    originY: result.originY,
    ground: result.ground,
    imageData: result.imageData,
    maxAltitude: glideParams?.maxAltitude ?? DEFAULT_MAX_ALTITUDE,
    raw: glideParams?.raw ?? false,
    contours: glideParams?.contours ?? false,
    glideRatio: glideParams?.glideRatio ?? 20,
    circuitHeight: glideParams?.circuitHeight ?? 250,
    contourGeojson: null,
  };
}

function traceOriginRelayPath(x, y, dem, originX, originY) {
  let totalDistM = 0;
  let cx = x;
  let cy = y;
  const visited = new Set();
  const maxSteps = dem.width + dem.height;

  for (let step = 0; step < maxSteps; step += 1) {
    const key = cellKey(cx, cy);
    if (visited.has(key)) {
      return { distanceM: totalDistM, seedX: cx, seedY: cy, complete: false };
    }
    visited.add(key);

    const idx = cellIndex(cx, cy, dem);
    const ox = originX[idx];
    const oy = originY[idx];
    if (ox < 0 || oy < 0) {
      return null;
    }

    totalDistM += gridCellDistanceM(cx, cy, ox, oy, dem);

    if (ox === cx && oy === cy) {
      return { distanceM: totalDistM, seedX: cx, seedY: cy, complete: true };
    }

    cx = ox;
    cy = oy;
  }

  return { distanceM: totalDistM, seedX: cx, seedY: cy, complete: false };
}

function seedAltitudeAt(dem, seedIdx, circuitHeight) {
  const terrain = dem.terrainMsl
    ? dem.terrainMsl[seedIdx]
    : dem.elevation[seedIdx] - dem.groundClearance;
  return terrain + circuitHeight;
}

function seedPathMetrics(cell) {
  const { dem, originX, originY, ground, glideRatio, circuitHeight } = coneState;
  const path = traceOriginRelayPath(cell.gi, cell.gj, dem, originX, originY);
  if (!path) {
    return null;
  }

  const seedIdx = cellIndex(path.seedX, path.seedY, dem);
  const seedAlt = seedAltitudeAt(dem, seedIdx, circuitHeight);
  const requiredAlt = seedAlt + path.distanceM / glideRatio;

  return {
    distanceM: path.distanceM,
    requiredAlt,
    seedAlt,
    isGroundSeed: ground[seedIdx] === 1,
    complete: path.complete,
  };
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function cellIndex(x, y, dem) {
  return y * dem.width + x;
}

function pushPathPoint(coordinates, x, y, dem) {
  const pt = gridCellToLngLat(x, y, dem);
  const last = coordinates[coordinates.length - 1];
  if (last && last[0] === pt.lng && last[1] === pt.lat) {
    return;
  }
  coordinates.push([pt.lng, pt.lat]);
}

function traceGlidePath(gi, gj) {
  const { dem, originX, originY } = coneState;
  const coordinates = [];
  const visited = new Set();
  let x = gi;
  let y = gj;
  const maxSteps = (dem.width + dem.height) * 2;

  for (let step = 0; step < maxSteps; step += 1) {
    const key = cellKey(x, y);
    if (visited.has(key)) {
      break;
    }
    visited.add(key);

    pushPathPoint(coordinates, x, y, dem);

    if (isSeedCell(x, y, dem)) {
      break;
    }

    const idx = cellIndex(x, y, dem);
    const nx = originX[idx];
    const ny = originY[idx];
    if (nx < 0 || ny < 0 || (nx === x && ny === y)) {
      break;
    }

    x = nx;
    y = ny;
  }

  return { coordinates };
}

function refreshHoverPath(cell) {
  const { coordinates } = traceGlidePath(cell.gi, cell.gj);
  if (coordinates.length >= 2) {
    updateGlidePath(coordinates);
  } else if (coordinates.length === 1) {
    const pt = coordinates[0];
    updateGlidePath([pt, pt]);
  } else {
    clearGlidePath();
  }
}

function syncCompareLosButton() {
  const show = isDebugMode() && coneState && !computing;
  if (compareLosRow) {
    compareLosRow.hidden = !show;
  }
  if (compareLosBtn) {
    compareLosBtn.disabled = !show;
  }
}

function setCompareButtonVisible(_visible) {
  syncCompareLosButton();
}

function syncDownloadContoursButton() {
  if (!downloadContoursBtn) {
    return;
  }
  const hasContours = Boolean(coneState?.contourGeojson);
  downloadContoursBtn.hidden = !hasContours;
  downloadContoursBtn.disabled = !hasContours;
}

function setDownloadContoursVisible(_visible) {
  syncDownloadContoursButton();
}

function downloadContourGeojson() {
  if (!coneState?.contourGeojson) {
    return;
  }
  const dem = coneState.dem;
  const blob = new Blob([JSON.stringify(coneState.contourGeojson, null, 2)], {
    type: "application/geo+json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `glide-contours-z${dem.zoom}.geojson`;
  link.click();
  URL.revokeObjectURL(url);
}

function clearCompareOverlay() {
  if (map.getLayer("glide-cone-full")) {
    map.removeLayer("glide-cone-full");
  }
  if (map.getSource("glide-cone-full")) {
    map.removeSource("glide-cone-full");
  }
}

function updateCompareOverlay(imageData, dem) {
  if (!compareOverlayCanvas) {
    compareOverlayCanvas = document.createElement("canvas");
  }
  compareOverlayCanvas.width = imageData.width;
  compareOverlayCanvas.height = imageData.height;
  compareOverlayCanvas.getContext("2d").putImageData(imageData, 0, 0);

  const coords = gridBoundsLngLat(dem.gx0, dem.gy0, dem.width, dem.height, dem.zoom);
  const coordinates = [
    [coords[0].lng, coords[0].lat],
    [coords[1].lng, coords[1].lat],
    [coords[2].lng, coords[2].lat],
    [coords[3].lng, coords[3].lat],
  ];

  if (map.getSource("glide-cone-full")) {
    map.getSource("glide-cone-full").updateImage({
      url: compareOverlayCanvas.toDataURL(),
      coordinates,
    });
    raisePathLayer();
    return;
  }

  map.addSource("glide-cone-full", {
    type: "image",
    url: compareOverlayCanvas.toDataURL(),
    coordinates,
  });

  map.addLayer({
    id: "glide-cone-full",
    type: "raster",
    source: "glide-cone-full",
    paint: {
      "raster-opacity": 1,
    },
  });
  raisePathLayer();
}

function clearAllOverlays() {
  clearRasterOverlay();
  clearContourOverlay();
  clearCompareOverlay();
  clearCellInspect();
  setDownloadContoursVisible(false);
  syncCompareLosButton();
  setStatus("Overlay cleared");
}

function clearRasterOverlay() {
  if (map.getLayer("glide-cone")) {
    map.removeLayer("glide-cone");
  }
  if (map.getSource("glide-cone")) {
    map.removeSource("glide-cone");
  }
}

function clearContourOverlay() {
  if (!contourLayersReady) {
    return;
  }
  map.getSource("glide-contours").setData({
    type: "FeatureCollection",
    features: [],
  });
}

function contourLabelSymbolSpacing() {
  return Math.min(window.innerWidth, window.innerHeight) / 3;
}

function syncContourLabelSpacing() {
  if (!contourLayersReady || !map.getLayer("glide-contours-label")) {
    return;
  }
  map.setLayoutProperty(
    "glide-contours-label",
    "symbol-spacing",
    contourLabelSymbolSpacing()
  );
}

function ensureContourLayers() {
  if (contourLayersReady) {
    return;
  }

  map.addSource("glide-contours", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "glide-contours-line",
    type: "line",
    source: "glide-contours",
    paint: {
      "line-color": "#2878f0",
      "line-width": 1.5,
      "line-opacity": 0.85,
    },
  });

  map.addLayer({
    id: "glide-contours-label",
    type: "symbol",
    source: "glide-contours",
    layout: {
      "symbol-placement": "line",
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-max-angle": 25,
      "symbol-spacing": contourLabelSymbolSpacing(),
      "text-keep-upright": true,
    },
    paint: {
      "text-color": "#a8c8ff",
      "text-halo-color": "rgba(18, 22, 28, 0.92)",
      "text-halo-width": 2,
    },
  });

  contourLayersReady = true;
  syncContourLabelSpacing();
}

function updateContourOverlay(geojson) {
  ensureContourLayers();
  syncContourLabelSpacing();
  map.getSource("glide-contours").setData(geojson);
  raisePathLayer();
}

function updateConeVisualization(result, dem, glideParams) {
  if (glideParams.raw) {
    coneState.contourGeojson = null;
    setDownloadContoursVisible(false);
    clearContourOverlay();
    if (result.imageData) {
      updateOverlay(result.imageData, dem);
    }
    return;
  }

  if (glideParams.contours) {
    clearRasterOverlay();
    const geojson = buildAltitudeContours(
      dem,
      result.altitudes,
      result.ground,
      result.originX,
      glideParams.maxAltitude
    );
    coneState.contourGeojson = geojson;
    updateContourOverlay(geojson);
    setDownloadContoursVisible(true);
    return;
  }

  coneState.contourGeojson = null;
  setDownloadContoursVisible(false);
  clearContourOverlay();
  if (result.imageData) {
    updateOverlay(result.imageData, dem);
  }
}

function updateOverlay(imageData, dem) {
  if (!overlayCanvas) {
    overlayCanvas = document.createElement("canvas");
  }
  overlayCanvas.width = imageData.width;
  overlayCanvas.height = imageData.height;
  overlayCanvas.getContext("2d").putImageData(imageData, 0, 0);

  const coords = gridBoundsLngLat(dem.gx0, dem.gy0, dem.width, dem.height, dem.zoom);
  const coordinates = [
    [coords[0].lng, coords[0].lat],
    [coords[1].lng, coords[1].lat],
    [coords[2].lng, coords[2].lat],
    [coords[3].lng, coords[3].lat],
  ];

  if (map.getSource("glide-cone")) {
    map.getSource("glide-cone").updateImage({
      url: overlayCanvas.toDataURL(),
      coordinates,
    });
    raisePathLayer();
    return;
  }

  map.addSource("glide-cone", {
    type: "image",
    url: overlayCanvas.toDataURL(),
    coordinates,
  });

  map.addLayer({
    id: "glide-cone",
    type: "raster",
    source: "glide-cone",
    paint: {
      "raster-opacity": 1,
    },
  });
  raisePathLayer();
}

function sampleDemCell(lng, lat) {
  if (!coneState) {
    return null;
  }

  const { dem, altitudes, ground, maxAltitude, originX, originY } = coneState;
  const { gi, gj } = gridIndexFromLngLat(lng, lat, dem);

  if (gi < 0 || gj < 0 || gi >= dem.width || gj >= dem.height) {
    return null;
  }

  const idx = gj * dem.width + gi;
  const groundElev = dem.terrainMsl
    ? dem.terrainMsl[idx]
    : dem.elevation[idx] - dem.groundClearance;
  const alt = altitudes[idx];
  const hasOrigin = originX[idx] >= 0 && originY[idx] >= 0;
  const isGroundCell = ground[idx] === 1;
  const isReachable = Number.isFinite(alt) && alt < maxAltitude && hasOrigin;

  return {
    gi,
    gj,
    idx,
    groundElev,
    alt: isReachable ? alt : null,
    isReachable,
    isGround: isGroundCell,
    isCone: isReachable && !isGroundCell,
  };
}

function formatDistanceKm(distanceM) {
  return `${(distanceM / 1000).toFixed(1)} km`;
}

function formatHoverTip(cell) {
  const minAltVal = cell.alt;
  const minAlt = minAltVal !== null ? `${Math.round(minAltVal)} m` : "—";
  const groundElev = `${Math.round(cell.groundElev)} m`;
  const metrics = seedPathMetrics(cell);
  const pathLengthLine =
    metrics !== null ? formatDistanceKm(metrics.distanceM) : "—";
  const requiredLine =
    metrics !== null ? `${Math.round(metrics.requiredAlt)} m` : "—";

  let deltaLine = "—";
  if (minAltVal !== null && metrics !== null) {
    const delta = Math.round(minAltVal - metrics.requiredAlt);
    const sign = delta > 0 ? "+" : "";
    const cls = delta >= 0 ? "delta-pos" : "delta-neg";
    deltaLine = `<span class="${cls}">${sign}${delta} m</span>`;
  }

  let text =
    `minimum alt: ${minAlt}\n` + `ground elevation: ${groundElev}`;

  if (isDebugMode()) {
    text +=
      `\n<span class="path-info-heading">comparison with measured path length (haversine):</span>\n` +
      `path length: ${pathLengthLine}\n` +
      `required alt: ${requiredLine}\n` +
      `delta: ${deltaLine}\n` +
      `<span class="path-info-note">delta heavily positive might mean path went over a saddle, or starts from a mountain well above glide, no issue in that case. use this on flatland at your latitude to check for unacceptable errors</span>`;
  }

  return text;
}

function updateGlidePath(coordinates) {
  ensurePathLayer();
  map.getSource("glide-path").setData({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates,
    },
    properties: {},
  });
  raisePathLayer();
}

function clearGlidePath() {
  if (!pathLayerReady) {
    return;
  }
  map.getSource("glide-path").setData(EMPTY_PATH);
}

function makeComputeProgressHandler(dem, glideParams) {
  return ({ imageData, iteration, elapsedMs }) => {
    if ((glideParams.raw || !glideParams.contours) && imageData) {
      updateOverlay(imageData, dem);
    }
    setTerrainTileMaxZoom(dem.zoom);
    setStatus(`Computing… iter ${iteration}, ${elapsedMs.toFixed(0)} ms GPU`);
  };
}

async function ensureEngine() {
  if (!engine) {
    engine = new GlideConeEngine();
    await engine.init();
  }
  return engine;
}

map.on("load", async () => {
  syncTerrainTileMaxZoom();
  ensurePathLayer();
  map.on("moveend", updateTerrainResolutionHint);
  map.on("resize", syncContourLabelSpacing);
  window.addEventListener("resize", syncContourLabelSpacing);

  try {
    openAipConfig = await loadOpenAipConfig();
    if (initOpenAipTiles(map, openAipConfig)) {
      console.info("OpenAIP vector tiles enabled");
      syncAirspaceUi();
      updateSeedMarkers();
    }
  } catch (error) {
    console.warn(
      "OpenAIP disabled — check OPENAIP_PROXY_BASE in js/openaip-config.public.js",
      error
    );
  }

  ensureSeedLayers();
  updateSeedMarkers();
  try {
    await ensureEngine();
    setStatus("WebGPU ready — add seeds, then Run");
  } catch (error) {
    setStatus(error.message);
    console.error(error);
  }
});

map.on("mousemove", (event) => {
  updateAirspaceInfo(event.lngLat.lng, event.lngLat.lat);

  if (airportAreaSelectMode) {
    if (airportRectInteraction) {
      updateAirportAreaInteraction(event.lngLat);
    } else {
      syncAreaSelectCursor(event.point);
    }
    return;
  }

  if (!interaction.hoverPath) {
    return;
  }

  const cell = sampleDemCell(event.lngLat.lng, event.lngLat.lat);
  if (cell === null) {
    if (!isDebugMode()) {
      clearCellInspect();
    }
    return;
  }

  showCellInspect(cell);
});

map.on("mousedown", (event) => {
  if (event.originalEvent.button !== 0 || !airportAreaSelectMode) {
    return;
  }
  beginAirportAreaInteraction(event.lngLat, event.point);
});

map.on("mouseup", (event) => {
  finishAirportAreaInteraction(event.lngLat);
});

map.on("mouseleave", () => {
  if (airportRectInteraction) {
    cancelAirportRectInteraction();
    syncAirportAreaSelectUi();
  }
  if (!interaction.hoverPath) {
    return;
  }
  if (!isDebugMode()) {
    clearCellInspect();
  }
});

map.on("touchstart", (event) => {
  if (airportAreaSelectMode && !computing && event.points.length === 1) {
    beginAirportAreaInteraction(event.lngLat, event.point);
    return;
  }

  if (!interaction.tapPath && !interaction.longPressSeed) {
    return;
  }

  longPressDone = false;
  touchStartPoint = event.point;
  cancelLongPress();

  if (!interaction.longPressSeed || computing) {
    return;
  }

  const { lng, lat } = event.lngLat;
  longPressTimer = window.setTimeout(() => {
    longPressTimer = null;
    longPressDone = true;
    markTouchHandled();
    addPendingSeed(lng, lat);
  }, LONG_PRESS_MS);
});

map.on("touchmove", (event) => {
  updateAirspaceInfo(event.lngLat.lng, event.lngLat.lat);

  if (airportAreaSelectMode && airportRectInteraction) {
    updateAirportAreaInteraction(event.lngLat);
    return;
  }

  if (longPressTimer === null || !touchStartPoint) {
    return;
  }
  const dx = event.point.x - touchStartPoint.x;
  const dy = event.point.y - touchStartPoint.y;
  if (dx * dx + dy * dy > 100) {
    cancelLongPress();
  }
});

map.on("touchend", (event) => {
  updateAirspaceInfo(event.lngLat.lng, event.lngLat.lat);

  if (airportAreaSelectMode && airportRectInteraction) {
    finishAirportAreaInteraction(event.lngLat);
    markTouchHandled();
    return;
  }

  if (!interaction.tapPath && !interaction.longPressSeed) {
    return;
  }

  markTouchHandled();
  cancelLongPress();

  if (longPressDone) {
    longPressDone = false;
    touchStartPoint = null;
    return;
  }

  touchStartPoint = null;

  if (!interaction.tapPath || !coneState) {
    return;
  }

  const cell = sampleDemCell(event.lngLat.lng, event.lngLat.lat);
  if (cell?.isReachable) {
    showCellInspect(cell);
  }
});

map.on("touchcancel", () => {
  if (airportRectInteraction) {
    cancelAirportRectInteraction();
    syncAirportAreaSelectUi();
  }
  cancelLongPress();
  longPressDone = false;
  touchStartPoint = null;
});

map.on("click", (event) => {
  if (
    computing ||
    touchHandledRecently ||
    airportAreaSelectMode ||
    airportRectInteraction
  ) {
    return;
  }

  if (interaction.clickSeed) {
    addPendingSeed(event.lngLat.lng, event.lngLat.lat);
  }
});

paramsForm.addEventListener("submit", (event) => {
  event.preventDefault();
});

vizModeSelect?.addEventListener("change", () => {
  syncParamVisibility();
  if (coneState && !computing) {
    setStatus("Overlay type changed — click Run to refresh");
  }
});

stopComputeBtn.addEventListener("click", () => {
  if (computing) {
    requestStopCompute();
  }
});

compareLosBtn.addEventListener("click", () => {
  runFullBresenhamCompare();
});

downloadContoursBtn.addEventListener("click", () => {
  downloadContourGeojson();
});

async function runFullBresenhamCompare() {
  if (!coneState || computing) {
    return;
  }

  startComputeSession();
  compareLosBtn.disabled = true;
  setStatus("Running full Bresenham on current grid…");

  try {
    const gpu = await ensureEngine();
    const result = await gpu.compute(coneState.dem, getGlideParams(), {
      fullBresenham: true,
      overlayColor: "red",
      imageOnly: true,
      raw: false,
      shouldStop: () => computeShouldStop,
    });
    updateCompareOverlay(result.imageData, coneState.dem);
    setStatus(formatComputeDone(result));
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  } finally {
    endComputeSession();
    compareLosBtn.disabled = false;
  }
}

async function runComputation(seedsOverride = null) {
  if (computing) {
    return;
  }

  const seeds =
    seedsOverride ?? pendingSeeds.map((seed) => ({ lng: seed.lng, lat: seed.lat }));

  if (seeds.length < MIN_SEEDS) {
    setStatus(`Place at least ${MIN_SEEDS} seed on the map before running`);
    return;
  }
  const glideParams = getGlideParams();
  clearCellInspect();
  clearGlidePath();
  clearCompareOverlay();
  setCompareButtonVisible(false);
  setDownloadContoursVisible(false);

  startComputeSession();

  try {
    const centerLat = seeds.reduce((sum, seed) => sum + seed.lat, 0) / seeds.length;
    const terrainZ = glideParams.terrainZoom;
    const cellSizeM = metersPerPixel(centerLat, terrainZ);

    setStatus(
      `Fetching DEM z${terrainZ} (~${Math.round(cellSizeM)} m) — ${seeds.length} seeds, L/D ${glideParams.glideRatio}, max alt ${glideParams.maxAltitude} m…`
    );
    const dem = await buildDemGrid(seeds, {
      ...glideParams,
      openAipConfig,
    });

    if (computeShouldStop) {
      setStatus("Stopped before GPU compute");
      return;
    }

    const airspaceNote =
      dem.airspaces.length > 0
        ? `, ${dem.airspaces.length} airspace volumes (${dem.airspaceAffectedCells} cells capped)`
        : "";

    setStatus(
      `Computing ${dem.width}×${dem.height} grid (${dem.tileCount} tiles) on GPU${airspaceNote}…`
    );
    const gpu = await ensureEngine();
    const result = await gpu.compute(dem, glideParams, makeComputeOptions(dem, glideParams));

    setConeState(dem, result, glideParams);
    setTerrainTileMaxZoom(dem.zoom);
    updateConeVisualization(result, dem, glideParams);
    ensurePathLayer();
    syncCompareLosButton();
    setDownloadContoursVisible(glideParams.contours);

    setStatus(
      formatComputeDone(
        result,
        ` — z${dem.zoom}, ${dem.width}×${dem.height}, ${seeds.length} seeds`
      )
    );
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  } finally {
    endComputeSession();
  }
}

clearOverlayBtn?.addEventListener("click", () => {
  clearAllOverlays();
});

clearAllSeedsBtn?.addEventListener("click", () => {
  if (computing) {
    return;
  }
  clearPendingSeeds();
});

runComputeBtn?.addEventListener("click", () => {
  if (paramsPanel) {
    paramsPanel.open = false;
  }
  runComputation();
});

selectViewportAirportsBtn?.addEventListener("click", () => {
  if (computing) {
    return;
  }
  addViewportAirportsToSeeds();
});

toggleAirportAreaSelectBtn?.addEventListener("click", () => {
  if (computing) {
    return;
  }
  enterAirportAreaSelectMode();
});

addAirportAreaBtn?.addEventListener("click", () => {
  if (computing) {
    return;
  }
  startAddAirportArea();
});

addAirportsFromAreasBtn?.addEventListener("click", () => {
  if (computing) {
    return;
  }
  addAirportsFromSelectAreas();
});

clearAirportAreasBtn?.addEventListener("click", () => {
  if (computing) {
    return;
  }
  clearAirportSelectAreas();
  setStatus("Airport selection areas cleared");
});

paramsPanel?.addEventListener("toggle", () => {
  if (paramsPanel.open && airportAreaSelectMode) {
    exitAirportAreaSelectMode(false);
  }
});
