import {
  gridBoundsLngLat,
  gridCellDistanceM,
  gridCellToLngLat,
  gridIndexFromLngLat,
  pickTerrainZoom,
  clampTerrainZoom,
  metersPerPixel,
  kmBoxAroundLngLat,
  isInsideKmBoxInnerZone,
} from "./geo.js";
import { buildDemGrid } from "./dem.js";
import { buildAltitudeContours } from "./contours.js";
import { GlideConeEngine } from "./glidecone.js";
import {
  initOpenAipAirspaceTiles,
  removeOpenAipVectorTiles,
  queryOpenAipAirspacesAt,
  airspaceFeatureKey,
  setOpenAipAirspaceVisible,
  OPENAIP_AIRPORT_MIN_ZOOM,
  OPENAIP_AIRPORT_LABEL_MIN_ZOOM,
  OPENAIP_AIRSPACE_LAYER,
} from "./openaip-tiles.js";
import { loadOpenAipConfig, openAipConfigured } from "./openaip-client.js";
import {
  registerTerrainTileProtocol,
  TERRAIN_TILE_URL_TEMPLATE,
  BASE_MAP_TERRAIN_MAX_ZOOM,
} from "./terrain-tiles.js";
import {
  buildCacheBundle,
  cacheCellKey,
  cachedAirportsToGeoJsonFeatures,
  cachedAirspacesToGeoJsonFeatures,
  ensureAirportCellsCachedForBbox,
  getCachedAirportsInBounds,
  getLastCachedCellKeysForSelection,
  mergedCachedAirportsToGeoJsonFeatures,
  mergedCachedAirspacesToGeoJsonFeatures,
} from "./cache-area.js";
import {
  AIRSPACE_TYPE_ADVISORY,
  AIRSPACE_TYPE_PROHIBITED,
} from "./airspace.js";

const DEFAULT_MAX_ALTITUDE = 4050;
const MIN_SEEDS = 1;
const AUTO_WINDOW_SIZE_DEFAULT_KM = 100;
const AUTO_WINDOW_GLIDE_FACTOR = 1.25;
const AUTO_MAX_OFFSET_FROM_CENTER = 0.25;
const AUTO_COMPUTE_DEBOUNCE_MS = 400;
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

const MANUAL_INSPECT_MS = 5000;

const REST_AIRSPACE_SOURCE = "rest-airspaces";
const REST_AIRSPACE_FILL_LAYER = "rest-airspaces-fill";
const REST_AIRSPACE_LINE_LAYER = "rest-airspaces-line";

const EMPTY_PATH = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: [] },
  properties: {},
};

const info = document.getElementById("info");
const airspaceInfoEl = document.getElementById("airspace-info");
const statusEl = document.getElementById("status");
const cellInfoEl = document.getElementById("cell-info");
const cellTooltipEl = document.getElementById("cell-tooltip");
const paramsForm = document.getElementById("params");
const vizModeSelect = document.getElementById("viz-mode");
const previewFieldEl = document.getElementById("preview-field");
const vizHintEl = document.getElementById("viz-hint");
const gridRadiusHintEl = document.getElementById("grid-radius-hint");
const terrainZoomInput = document.getElementById("terrain-zoom");
const terrainResolutionHintEl = document.getElementById("terrain-resolution-hint");
const autoWindowSizeInput = document.getElementById("auto-window-size");
const autoWindowFromGlideInput = document.getElementById("auto-window-from-glide");
const autoWindowSizeFieldEl = document.getElementById("auto-window-size-field");
const autoWindowGlideHintEl = document.getElementById("auto-window-glide-hint");
const includeAirspaceInput = document.getElementById("include-airspace");
const paramHelpPopover = document.getElementById("param-help-popover");
const compareLosBtn = document.getElementById("compare-los");
const compareLosRow = document.getElementById("compare-los-row");
const downloadContoursBtn = document.getElementById("download-contours");
const stopComputeBtn = document.getElementById("stop-compute");
const runComputeBtn = document.getElementById("run-compute");
const toggleAirportAreaSelectBtn = document.getElementById("toggle-airport-area-select");
const toggleManualAirportSelectBtn = document.getElementById("toggle-manual-airport-select");
const addAirportAreaBtn = document.getElementById("add-airport-area");
const addAirportsFromAreasBtn = document.getElementById("add-airports-from-areas");
const clearAirportAreasBtn = document.getElementById("clear-airport-areas");
const addManualAirportBtn = document.getElementById("add-manual-airport");
const clearManualAirportBtn = document.getElementById("clear-manual-airport");
const finishManualAirportBtn = document.getElementById("finish-manual-airport");
const manualAirportNameInput = document.getElementById("manual-airport-name");
const manualAirportListEl = document.getElementById("manual-airport-list");
const debugModeInput = document.getElementById("debug-mode");
const highlightDownhillGroundPathInput = document.getElementById("highlight-downhill-ground-path");
const losRunInput = document.getElementById("los-run");
const computeContextBarEl = document.getElementById("compute-context-bar");
const computeContextMinAltEl = document.getElementById("compute-context-min-alt");
const computeContextMinAltValueEl = document.getElementById("compute-context-min-alt-value");
const computeContextParamsEl = document.getElementById("compute-context-params");
const seedListEl = document.getElementById("seed-list");
const paramsPanel = document.getElementById("params-panel");
const paramsShell = document.getElementById("params-shell");
const paramsModeAutoBtn = document.getElementById("params-mode-auto");
const paramsModeManualBtn = document.getElementById("params-mode-manual");
const paramsScrollEl = document.getElementById("params-scroll");
const seedsSectionEl = document.getElementById("seeds-section");
const airportAreaSelectPanel = document.getElementById("airport-area-select-panel");
const manualAirportSelectPanel = document.getElementById("manual-airport-select-panel");
const clearOverlayBtn = document.getElementById("clear-overlay");
const clearAllSeedsBtn = document.getElementById("clear-all-seeds");
const pathInputHintEl = document.getElementById("path-input-hint");
const openCacheDataBtn = document.getElementById("open-cache-data");
const cacheDataPanel = document.getElementById("cache-data-panel");
const runCacheDownloadBtn = document.getElementById("run-cache-download");
const finishCacheSelectBtn = document.getElementById("finish-cache-select");

const CACHE_HIDDEN_LAYER_IDS = [
  "glide-cone",
  "glide-cone-full",
  "glide-contours-line",
  "glide-contours-label",
  "airports-cached",
  "airports-cached-labels",
  OPENAIP_AIRSPACE_LAYER,
  "seeds-circle",
  "seeds-label",
  "pending-manual-airport-circle",
  "glide-path",
  "glide-path-geo",
  "airport-select-areas-fill",
  "airport-select-areas-line",
  "airport-select-handles",
];

let engine = null;
let computing = false;
let computeShouldStop = false;
let overlayCanvas = null;
let compareOverlayCanvas = null;
let coneState = null;
let pathLayerReady = false;
let contourLayersReady = false;
let lastInspectCell = null;
let pendingSeeds = [];
let seedLayersReady = false;
let openAipConfig = null;
let touchHandledRecently = false;
let footerStatusText = "Loading WebGPU…";
let autoComputePending = false;
let autoComputeDebounceTimer = null;
let autoComputeNeedsAirportRefresh = false;
let autoComputeRegion = null;
let statusClearTimer = null;

const COMPUTE_DONE_STATUS_CLEAR_MS = 10000;
let footerCellHtml = null;
let lastInspectAnchor = null;
let lastInspectLngLat = null;
let lastPathScreenBounds = null;
let manualInspectTimeout = null;
let lastGeoLngLat = null;
let geolocateControl = null;
let geoTrackPanZoom = null;
let geoTrackInitialPanPending = false;
let airportAreaSelectMode = false;
let airportAreaDrawMode = false;
let airportSelectRects = [];
let airportSelectLayersReady = false;
let airportRectInteraction = null;
let manualAirportSelectMode = false;
let manualStagingAirports = [];
let pendingManualAirport = null;
let pendingManualAirportLayerReady = false;
let manualTouchStart = null;
let cacheSelectMode = false;
let cacheGridReady = false;
let cacheAirportsReady = false;
let restAirspaceLayersReady = false;
let cachedAirportMapReady = false;
let cacheDownloadInProgress = false;
let overlayVisibilityBeforeCache = null;
const selectedCacheCells = new Set();

const interaction = {
  hoverPath: false,
  tapPath: false,
};

function detectInteractionMode() {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const fine = window.matchMedia("(pointer: fine)").matches;
  const hover = window.matchMedia("(hover: hover)").matches;

  interaction.hoverPath = hover && fine;
  interaction.tapPath = coarse;

  updateInteractionHints();
}

function airportCountStatus(count) {
  return `${count} airport${count === 1 ? "" : "s"} selected`;
}

function airportCountTotal(count) {
  return `${count} airport${count === 1 ? "" : "s"} total`;
}

function updateInteractionHints() {
  const pathParts = [];

  if (interaction.hoverPath) {
    pathParts.push("Hover over the overlay to show the glide path");
  }
  if (interaction.tapPath) {
    pathParts.push("tap the overlay to show the glide path");
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

function updateParamsFooter() {
  if (!statusEl) {
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = footerStatusText;
}

function pathScreenBounds(coordinates) {
  if (!coordinates?.length) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [lng, lat] of coordinates) {
    const pt = map.project([lng, lat]);
    minX = Math.min(minX, pt.x);
    minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x);
    maxY = Math.max(maxY, pt.y);
  }

  const pad = 14;
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

function tooltipOverlapsPath(left, top, width, height) {
  if (!lastPathScreenBounds) {
    return false;
  }
  const { minX, minY, maxX, maxY } = lastPathScreenBounds;
  return left < maxX && left + width > minX && top < maxY && top + height > minY;
}

function viewportInsets() {
  const pad = 10;
  const bottomPad =
    pad +
    (document.body.classList.contains("has-compute-context")
      ? computeContextBarEl?.offsetHeight ?? 48
      : 0);
  return {
    left: pad,
    top: pad,
    right: window.innerWidth - pad,
    bottom: window.innerHeight - bottomPad,
  };
}

function positionCellTooltip() {
  if (!cellTooltipEl || cellTooltipEl.hidden || !lastInspectAnchor) {
    return;
  }

  const { x, y } = lastInspectAnchor;
  const gap = 16;
  const width = cellTooltipEl.offsetWidth;
  const height = cellTooltipEl.offsetHeight;
  const { left: minLeft, top: minTop, right: maxRight, bottom: maxBottom } = viewportInsets();

  const placements = [
    { left: x + gap, top: y + gap },
    { left: x - gap - width, top: y + gap },
    { left: x + gap, top: y - gap - height },
    { left: x - gap - width, top: y - gap - height },
  ];

  let chosen = placements.find(
    (place) =>
      place.left >= minLeft &&
      place.top >= minTop &&
      place.left + width <= maxRight &&
      place.top + height <= maxBottom &&
      !tooltipOverlapsPath(place.left, place.top, width, height)
  );

  if (!chosen && lastPathScreenBounds) {
    const pcx = (lastPathScreenBounds.minX + lastPathScreenBounds.maxX) / 2;
    const pcy = (lastPathScreenBounds.minY + lastPathScreenBounds.maxY) / 2;
    const dx = x - pcx;
    const dy = y - pcy;
    const len = Math.hypot(dx, dy) || 1;
    const push = Math.max(width, height) / 2 + gap + 24;
    chosen = {
      left: x + (dx / len) * push - width / 2,
      top: y + (dy / len) * push - height / 2,
    };
  }

  chosen ??= placements[0];

  chosen.left = Math.max(minLeft, Math.min(chosen.left, maxRight - width));
  chosen.top = Math.max(minTop, Math.min(chosen.top, maxBottom - height));

  cellTooltipEl.style.left = `${chosen.left}px`;
  cellTooltipEl.style.top = `${chosen.top}px`;
}

function updateCellTooltip() {
  if (!cellTooltipEl) {
    return;
  }
  if (!footerCellHtml) {
    cellTooltipEl.hidden = true;
    cellTooltipEl.innerHTML = "";
    return;
  }

  cellTooltipEl.innerHTML = footerCellHtml;
  cellTooltipEl.hidden = false;
  window.requestAnimationFrame(() => positionCellTooltip());
}

function clearManualInspectTimer() {
  if (manualInspectTimeout !== null) {
    window.clearTimeout(manualInspectTimeout);
    manualInspectTimeout = null;
  }
}

function isManualInspectActive() {
  return manualInspectTimeout !== null;
}

function isGeoTrackingOn() {
  if (!geolocateControl) {
    return false;
  }
  const state = geolocateControl._watchState;
  return state === "ACTIVE_LOCK" || state === "BACKGROUND" || state === "WAITING_ACTIVE";
}

function scheduleManualInspectClear() {
  clearManualInspectTimer();
  manualInspectTimeout = window.setTimeout(() => {
    manualInspectTimeout = null;
    clearCellInspect();
  }, MANUAL_INSPECT_MS);
}

function getGeoSampleCell() {
  if (!lastGeoLngLat || !coneState) {
    return null;
  }
  return sampleDemCell(lastGeoLngLat.lng, lastGeoLngLat.lat);
}

function updateGeoLocationPath() {
  if (!isGeoTrackingOn() || !coneState || !lastGeoLngLat) {
    clearGeoPath();
    return;
  }

  const cell = getGeoSampleCell();
  if (!cell?.isReachable) {
    clearGeoPath();
    return;
  }

  refreshGeoPath(cell);
}

function clearCellInspect() {
  clearManualInspectTimer();
  footerCellHtml = null;
  lastInspectAnchor = null;
  lastInspectLngLat = null;
  lastInspectCell = null;
  lastPathScreenBounds = null;
  clearInspectPath();
  updateCellTooltip();
  updateParamsFooter();
}

function isPointerOverParams(clientX, clientY) {
  if (!paramsShell) {
    return false;
  }
  const target = document.elementFromPoint(clientX, clientY);
  return Boolean(target && paramsShell.contains(target));
}

function showCellInspect(cell, anchorPoint = null, { temporary = false } = {}) {
  if (!cell) {
    clearCellInspect();
    return;
  }

  footerCellHtml = formatHoverTip(cell);

  if (coneState?.dem) {
    const pt = gridCellToLngLat(cell.gi, cell.gj, coneState.dem);
    lastInspectLngLat = { lng: pt.lng, lat: pt.lat };
  }

  if (anchorPoint) {
    lastInspectAnchor = { x: anchorPoint.x, y: anchorPoint.y };
  } else if (lastInspectLngLat) {
    const projected = map.project([lastInspectLngLat.lng, lastInspectLngLat.lat]);
    lastInspectAnchor = { x: projected.x, y: projected.y };
  }

  if (cell.isReachable) {
    lastInspectCell = cell;
    refreshInspectPath(cell);
  } else {
    lastInspectCell = null;
    lastPathScreenBounds = null;
    clearInspectPath();
    updateCellTooltip();
  }

  if (temporary) {
    scheduleManualInspectClear();
  }

  updateParamsFooter();
}

function syncInspectOnMapMove() {
  if (!lastInspectCell || !lastInspectLngLat || !footerCellHtml) {
    return;
  }
  const projected = map.project([lastInspectLngLat.lng, lastInspectLngLat.lat]);
  lastInspectAnchor = { x: projected.x, y: projected.y };
  refreshInspectPath(lastInspectCell);
}

function startComputeSession() {
  computeShouldStop = false;
  computing = true;
  stopComputeBtn.hidden = false;
  stopComputeBtn.disabled = false;
  if (runComputeBtn) {
    runComputeBtn.disabled = true;
  }
  if (airportAreaSelectMode) {
    exitAirportAreaSelectMode(false);
  }
  if (manualAirportSelectMode) {
    exitManualAirportSelectMode(false);
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
  if (isAutoParamsMode() && autoComputePending) {
    void flushAutoCompute();
  }
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
    "Stripes — 100 m altitude bands. Raw raster — per-cell altitude colors. Contours — 100 m isolines with labels; exportable as GeoJSON after a run.",
  preview:
    "How often the map refreshes during GPU compute (stripes and raw raster only). 0 = update once at the end.",
  "compare-los":
    "Runs a full Bresenham line-of-sight overlay in red on the current grid, without the LOS run N shortcut. Use this to check how accurate your shortcut is compared to the exact raytrace.",
};

const VIZ_HINTS = {
  stripes: "100 m bands relative to airport altitude.",
  raw: "Per-cell altitude colors.",
  contours: "100 m isolines with labels; GeoJSON export after run.",
};

function parseVizMode() {
  const mode = vizModeSelect?.value ?? "contours";
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

function isAutoParamsMode() {
  return paramsShell?.classList.contains("auto-mode") ?? false;
}

function setParamsMode(mode) {
  const auto = mode === "auto";
  paramsShell?.classList.toggle("auto-mode", auto);
  paramsModeAutoBtn?.setAttribute("aria-pressed", String(auto));
  paramsModeManualBtn?.setAttribute("aria-pressed", String(!auto));
  if (auto) {
    if (manualAirportSelectMode) {
      exitManualAirportSelectMode(true);
    }
    if (airportAreaSelectMode) {
      exitAirportAreaSelectMode(true);
    }
    if (openParamHelpButton?.dataset.help) {
      const manualOnlyHelp = new Set([
        "viz-mode",
        "preview",
        "compare-los",
        "los-run",
      ]);
      if (manualOnlyHelp.has(openParamHelpButton.dataset.help)) {
        closeParamHelp();
      }
    }
    scheduleAutoCompute({ refreshAirports: true });
  } else {
    clearTimeout(autoComputeDebounceTimer);
    autoComputeDebounceTimer = null;
    autoComputePending = false;
    autoComputeNeedsAirportRefresh = false;
    autoComputeRegion = null;
  }
  syncSeedLayerVisibility();
}

function computeAutoWindowSizeFromGlideKm() {
  const glideRatio = Number.parseFloat(document.getElementById("ld")?.value ?? "");
  const maxAltitude = Number.parseFloat(document.getElementById("max-alt")?.value ?? "");
  if (
    !Number.isFinite(glideRatio) ||
    glideRatio <= 0 ||
    !Number.isFinite(maxAltitude) ||
    maxAltitude <= 0
  ) {
    return AUTO_WINDOW_SIZE_DEFAULT_KM;
  }
  return (AUTO_WINDOW_GLIDE_FACTOR * maxAltitude * glideRatio) / 1000;
}

function isAutoWindowFromGlideEnabled() {
  return autoWindowFromGlideInput?.checked ?? false;
}

function getAutoWindowSizeKm() {
  if (isAutoWindowFromGlideEnabled()) {
    return computeAutoWindowSizeFromGlideKm();
  }
  const value = Number.parseFloat(autoWindowSizeInput?.value ?? "");
  return Number.isFinite(value) && value > 0 ? value : AUTO_WINDOW_SIZE_DEFAULT_KM;
}

function syncAutoWindowSizeUi() {
  const fromGlide = isAutoWindowFromGlideEnabled();
  if (autoWindowSizeFieldEl) {
    autoWindowSizeFieldEl.hidden = fromGlide;
    autoWindowSizeFieldEl.classList.toggle("auto-window-size-hidden", fromGlide);
  }
  if (autoWindowGlideHintEl) {
    if (fromGlide) {
      const km = computeAutoWindowSizeFromGlideKm();
      autoWindowGlideHintEl.textContent = `${Math.round(km)} km half-width — ${Math.round(km * 2)} km total span`;
      autoWindowGlideHintEl.hidden = false;
    } else {
      autoWindowGlideHintEl.hidden = true;
      autoWindowGlideHintEl.textContent = "";
    }
  }
}

function areOpenAipAirportsAvailable() {
  return openAipConfigured(openAipConfig);
}

function syncOpenAipVectorTiles() {
  if (!map) {
    return;
  }
  const wantTiles = isIncludeAirspaceEnabled() && areOpenAipAirportsAvailable();
  if (wantTiles) {
    if (initOpenAipAirspaceTiles(map, openAipConfig)) {
      setOpenAipAirspaceVisible(map, true);
    }
    return;
  }
  removeOpenAipVectorTiles(map);
}

async function runAutoComputation({ refreshAirports = false } = {}) {
  if (!isAutoParamsMode() || cacheSelectMode || !areOpenAipAirportsAvailable()) {
    if (isAutoParamsMode()) {
      setStatus("Auto mode needs OpenAIP — check configuration");
    }
    return;
  }

  const windowSizeKm = getAutoWindowSizeKm();
  const center = map.getCenter();
  const bounds = kmBoxAroundLngLat(center.lng, center.lat, windowSizeKm);
  autoComputeRegion = { ...bounds, windowSizeKm };

  let seedsForCompute;

  if (refreshAirports) {
    await ensureAirportCellsCachedForBbox(bounds, openAipConfig, setStatus);
    refreshCachedAirportMapLayer();
    refreshRestAirspaceLayerData();
    setStatus(`Finding airports in ${windowSizeKm * 2} km window…`);
    const airports = getCachedAirportsInBounds(
      bounds.west,
      bounds.south,
      bounds.east,
      bounds.north
    );

    if (airports.length < MIN_SEEDS) {
      setStatus(
        `Auto: no airports in ${windowSizeKm * 2} km window — pan map or cache cells first`
      );
      return;
    }

    pendingSeeds = airports.map((airport) => ({
      lng: airport.lng,
      lat: airport.lat,
      label: formatAirportLabel(airport),
      source: "airport",
    }));
    updateSeedMarkers();
    setStatus(`Found ${airports.length} airports — fetching terrain…`);
    seedsForCompute = pendingSeeds.map((seed) => ({ lng: seed.lng, lat: seed.lat }));
  } else if (pendingSeeds.length >= MIN_SEEDS) {
    setStatus(`Recomputing ${pendingSeeds.length} airports…`);
    seedsForCompute = pendingSeeds.map((seed) => ({ lng: seed.lng, lat: seed.lat }));
  } else {
    await runAutoComputation({ refreshAirports: true });
    return;
  }

  await runComputation(seedsForCompute, { gridBounds: bounds });
}

function cancelPendingAutoCompute() {
  clearTimeout(autoComputeDebounceTimer);
  autoComputeDebounceTimer = null;
  autoComputePending = false;
  autoComputeNeedsAirportRefresh = false;
}

function scheduleAutoCompute({ debounce = false, refreshAirports = false } = {}) {
  if (!isAutoParamsMode() || cacheSelectMode) {
    return;
  }
  autoComputePending = true;
  if (refreshAirports) {
    autoComputeNeedsAirportRefresh = true;
  }
  if (computing) {
    computeShouldStop = true;
    return;
  }
  clearTimeout(autoComputeDebounceTimer);
  if (debounce) {
    autoComputeDebounceTimer = window.setTimeout(() => {
      autoComputeDebounceTimer = null;
      void flushAutoCompute();
    }, AUTO_COMPUTE_DEBOUNCE_MS);
    return;
  }
  void flushAutoCompute();
}

async function flushAutoCompute() {
  if (!autoComputePending || !isAutoParamsMode() || cacheSelectMode || computing) {
    return;
  }
  autoComputePending = false;
  const refreshAirports = autoComputeNeedsAirportRefresh;
  autoComputeNeedsAirportRefresh = false;
  await runAutoComputation({ refreshAirports });
}

function onAutoModeMapMoveEnd() {
  if (!isAutoParamsMode() || cacheSelectMode || !autoComputeRegion || computing) {
    return;
  }
  const center = map.getCenter();
  if (
    isInsideKmBoxInnerZone(
      center.lng,
      center.lat,
      autoComputeRegion,
      AUTO_MAX_OFFSET_FROM_CENTER
    )
  ) {
    return;
  }
  scheduleAutoCompute({ debounce: true, refreshAirports: true });
}

function isDebugMode() {
  return debugModeInput?.checked ?? false;
}

function isHighlightDownhillGroundPathEnabled() {
  return highlightDownhillGroundPathInput?.checked ?? false;
}

function getParamHelpText(key) {
  let text = PARAM_HELP[key];
  if (!text) {
    return null;
  }
  if (key === "los-run" && isDebugMode()) {
    text +=
      "\n\nFull Bresenham comparison and path-length diagnostics are available in Debug mode.";
  }
  return text;
}

function syncDebugUi() {
  const debug = isDebugMode();
  paramsShell?.classList.toggle("debug-mode", debug);
  if (!debug && losRunInput) {
    losRunInput.value = "0";
  }
  if (!debug && openParamHelpButton?.dataset.help === "los-run") {
    closeParamHelp();
  }
  if (openParamHelpButton?.dataset.help === "los-run" && paramHelpPopover) {
    const text = getParamHelpText("los-run");
    if (text) {
      paramHelpPopover.textContent = text;
    }
  }
  syncCompareLosButton();
  syncDownloadContoursButton();
  if (lastInspectCell) {
    showCellInspect(lastInspectCell);
  }
}

function isIncludeAirspaceEnabled() {
  return includeAirspaceInput?.checked ?? false;
}

function syncAirspaceUi() {
  if (cacheSelectMode) {
    return;
  }
  const enabled = isIncludeAirspaceEnabled() && areOpenAipAirportsAvailable();
  syncOpenAipVectorTiles();
  if (enabled) {
    ensureRestAirspaceLayers();
    refreshRestAirspaceLayerData();
    setRestAirspaceFillVisible(true);
    setRestAirspaceLineVisible(false);
    if (map?.getSource("openaip")) {
      setOpenAipAirspaceVisible(map, true);
    }
    info.classList.add("visible");
  } else {
    if (map?.getSource("openaip")) {
      setOpenAipAirspaceVisible(map, false);
    }
    setRestAirspaceFillVisible(false);
    setRestAirspaceLineVisible(false);
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

function syncBaseMapTerrainMaxZoom() {
  if (!map?.getStyle?.()?.sources?.hillshadeSource) {
    return;
  }
  setTerrainTileMaxZoom(BASE_MAP_TERRAIN_MAX_ZOOM);
}

function onTerrainZoomChange() {
  updateTerrainResolutionHint();
  if (isAutoParamsMode()) {
    scheduleAutoCompute({ debounce: true });
  }
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
  setParamsMode("auto");
  updateGridRadiusHint();
  updateTerrainResolutionHint();
  syncAutoWindowSizeUi();

  paramsModeAutoBtn?.addEventListener("click", () => setParamsMode("auto"));
  paramsModeManualBtn?.addEventListener("click", () => setParamsMode("manual"));

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
    document.getElementById(id)?.addEventListener("input", () => {
      updateGridRadiusHint();
      syncAutoWindowSizeUi();
      if (isAutoParamsMode()) {
        scheduleAutoCompute({ debounce: true });
      }
    });
  }

  for (const id of ["circuit", "clearance"]) {
    document.getElementById(id)?.addEventListener("input", () => {
      if (isAutoParamsMode()) {
        scheduleAutoCompute({ debounce: true });
      }
    });
  }

  autoWindowSizeInput?.addEventListener("input", () => {
    if (isAutoParamsMode()) {
      scheduleAutoCompute({ debounce: true, refreshAirports: true });
    }
  });

  autoWindowFromGlideInput?.addEventListener("change", () => {
    syncAutoWindowSizeUi();
    if (isAutoParamsMode()) {
      scheduleAutoCompute({ debounce: true, refreshAirports: true });
    }
  });

  terrainZoomInput?.addEventListener("input", onTerrainZoomChange);

  includeAirspaceInput?.addEventListener("change", () => {
    syncAirspaceUi();
    if (isIncludeAirspaceEnabled() && map?.getSource("openaip")) {
      const center = map.getCenter();
      updateAirspaceInfo(center.lng, center.lat);
    }
    if (isAutoParamsMode()) {
      scheduleAutoCompute({ debounce: true });
    }
  });

  debugModeInput?.addEventListener("change", syncDebugUi);

  highlightDownhillGroundPathInput?.addEventListener("change", () => {
    if (lastInspectCell) {
      refreshInspectPath(lastInspectCell);
    }
    if (isGeoTrackingOn()) {
      updateGeoLocationPath();
    }
  });

  document.getElementById("los-run")?.addEventListener("input", syncCompareLosButton);
  detectInteractionMode();
  for (const query of ["(pointer: coarse)", "(pointer: fine)", "(hover: hover)"]) {
    window.matchMedia(query).addEventListener("change", detectInteractionMode);
  }
  syncCompareLosButton();
  syncDebugUi();
  updateParamsFooter();

  paramsShell?.addEventListener("pointerenter", clearCellInspect);
  paramsShell?.addEventListener("touchstart", clearCellInspect, { passive: true });
}

initParamPanel();

function getGlideParams() {
  const glideRatio = Number.parseFloat(document.getElementById("ld").value);
  const circuitHeight = Number.parseFloat(document.getElementById("circuit").value);
  const groundClearance = Number.parseFloat(document.getElementById("clearance").value);
  const maxAltitude = Number.parseFloat(document.getElementById("max-alt").value);
  const originRunN = isDebugMode()
    ? Number.parseInt(document.getElementById("los-run").value, 10)
    : 0;
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

registerTerrainTileProtocol();

map = new maplibregl.Map({
  container: "map",
  hash: "map",
  zoom: Math.min(INITIAL_TERRAIN_Z, MAP_MAX_ZOOM),
  maxZoom: MAP_MAX_ZOOM,
  center: [MAP_CENTER.lng, MAP_CENTER.lat],
  style: {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      hillshadeSource: {
        type: "raster-dem",
        tiles: [TERRAIN_TILE_URL_TEMPLATE],
        encoding: "terrarium",
        tileSize: 512,
        maxzoom: BASE_MAP_TERRAIN_MAX_ZOOM,
        attribution: '<a href="https://mapterhorn.com" target="_blank" rel="noopener">Mapterhorn</a>',
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

function lockGeolocatePanZoom() {
  if (!map || !geolocateControl) {
    return;
  }
  geoTrackPanZoom = map.getZoom();
  geoTrackInitialPanPending = true;
  geolocateControl.options.fitBoundsOptions = {
    maxZoom: geoTrackPanZoom,
    minZoom: geoTrackPanZoom,
    linear: true,
  };
}

function panGeolocateToPosition(coords) {
  if (geoTrackPanZoom === null) {
    return;
  }
  map.easeTo(
    {
      center: [coords.longitude, coords.latitude],
      zoom: geoTrackPanZoom,
      bearing: map.getBearing(),
      duration: 500,
    },
    { geolocateSource: true }
  );
  geoTrackInitialPanPending = false;
}

map.addControl(new maplibregl.NavigationControl(), "top-right");
geolocateControl = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
});
map.addControl(geolocateControl, "top-right");
geolocateControl._container?.addEventListener("click", lockGeolocatePanZoom, true);

geolocateControl.on("geolocate", (event) => {
  lastGeoLngLat = {
    lng: event.coords.longitude,
    lat: event.coords.latitude,
  };
  if (geoTrackInitialPanPending) {
    panGeolocateToPosition(event.coords);
  }
  updateGeoLocationPath();
  syncComputeContextBar();
});

geolocateControl.on("trackuserlocationstart", () => {
  lockGeolocatePanZoom();
  updateGeoLocationPath();
  syncComputeContextBar();
});

geolocateControl.on("trackuserlocationend", () => {
  geoTrackInitialPanPending = false;
  if (!isGeoTrackingOn()) {
    lastGeoLngLat = null;
    clearGeoPath();
    syncComputeContextBar();
  }
});

function updateAirspaceInfo(lng, lat) {
  if (!isIncludeAirspaceEnabled() || !map?.getSource("openaip")) {
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

function setStatus(text, { clearAfterMs } = {}) {
  if (statusClearTimer !== null) {
    window.clearTimeout(statusClearTimer);
    statusClearTimer = null;
  }
  footerStatusText = text;
  updateParamsFooter();
  if (clearAfterMs) {
    const snapshot = text;
    statusClearTimer = window.setTimeout(() => {
      statusClearTimer = null;
      if (footerStatusText === snapshot) {
        footerStatusText = "";
        updateParamsFooter();
      }
    }, clearAfterMs);
  }
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
  if (!map.getSource("seeds")) {
    map.addSource("seeds", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }

  if (!map.getLayer("seeds-circle")) {
    map.addLayer({
      id: "seeds-circle",
      type: "circle",
      source: "seeds",
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          OPENAIP_AIRPORT_MIN_ZOOM,
          4,
          14,
          10,
        ],
        "circle-color": "#ffcc00",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });
  }

  if (!map.getLayer("seeds-label")) {
    map.addLayer({
      id: "seeds-label",
      type: "symbol",
      source: "seeds",
      minzoom: OPENAIP_AIRPORT_LABEL_MIN_ZOOM,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "text-offset": [0, -1.35],
        "text-anchor": "bottom",
        "text-max-width": 14,
        "symbol-sort-key": 200,
        "text-optional": false,
      },
      paint: {
        "text-color": "#ffe066",
        "text-halo-color": "rgba(18, 22, 28, 0.92)",
        "text-halo-width": 2,
      },
    });
  }

  seedLayersReady = true;
  syncSeedLayerVisibility();
  raisePathLayer();
}

function syncSeedLayerVisibility() {
  if (!seedLayersReady || !map) {
    return;
  }
  const visibility = isAutoParamsMode() ? "none" : "visible";
  for (const layerId of ["seeds-circle", "seeds-label"]) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
  }
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
    toggleAirportAreaSelectBtn.disabled = computing || !areOpenAipAirportsAvailable();
  }
  if (toggleManualAirportSelectBtn) {
    toggleManualAirportSelectBtn.disabled = computing;
  }
  if (addAirportsFromAreasBtn) {
    addAirportsFromAreasBtn.disabled =
      computing || airportSelectRects.length === 0 || !areOpenAipAirportsAvailable();
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
  syncManualAirportSelectUi();
  if (map?.getCanvas() && !airportAreaSelectMode && !manualAirportSelectMode) {
    map.getCanvas().style.cursor = "";
  }
}

function ensurePendingManualAirportLayer() {
  if (pendingManualAirportLayerReady) {
    return;
  }

  map.addSource("pending-manual-airport", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "pending-manual-airport-circle",
    type: "circle",
    source: "pending-manual-airport",
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        OPENAIP_AIRPORT_MIN_ZOOM,
        4,
        14,
        10,
      ],
      "circle-color": "#ffcc00",
      "circle-stroke-width": 3,
      "circle-stroke-color": "#4da3ff",
      "circle-opacity": 0.85,
    },
  });

  pendingManualAirportLayerReady = true;
}

function updatePendingManualAirportLayer() {
  if (!pendingManualAirportLayerReady) {
    return;
  }

  const features = pendingManualAirport
    ? [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [pendingManualAirport.lng, pendingManualAirport.lat],
          },
          properties: {},
        },
      ]
    : [];

  map.getSource("pending-manual-airport").setData({
    type: "FeatureCollection",
    features,
  });
}

function syncManualAirportSelectUi() {
  if (manualAirportSelectPanel) {
    manualAirportSelectPanel.hidden = !manualAirportSelectMode;
  }
  const hasPending = pendingManualAirport !== null;
  const hasStaging = manualStagingAirports.length > 0;
  if (addManualAirportBtn) {
    addManualAirportBtn.disabled = computing || !manualAirportSelectMode || !hasPending;
  }
  if (clearManualAirportBtn) {
    clearManualAirportBtn.disabled = computing || !manualAirportSelectMode || !hasPending;
  }
  if (finishManualAirportBtn) {
    finishManualAirportBtn.hidden = !manualAirportSelectMode || !hasStaging;
    finishManualAirportBtn.disabled = computing;
  }
  if (manualAirportNameInput) {
    manualAirportNameInput.disabled = computing || !manualAirportSelectMode;
  }
}

function clearPendingManualAirport() {
  pendingManualAirport = null;
  updatePendingManualAirportLayer();
  syncManualAirportSelectUi();
}

function setPendingManualAirport(lng, lat) {
  pendingManualAirport = { lng, lat };
  ensurePendingManualAirportLayer();
  updatePendingManualAirportLayer();
  updateAirspaceInfo(lng, lat);
  syncManualAirportSelectUi();
  setStatus("Enter a name (optional), then Add airport.");
  if (manualAirportNameInput) {
    manualAirportNameInput.focus();
  }
}

function enterManualAirportSelectMode() {
  if (computing) {
    return;
  }
  if (airportAreaSelectMode) {
    exitAirportAreaSelectMode(false);
  }
  manualAirportSelectMode = true;
  manualStagingAirports = [];
  updateManualStagingList();
  if (paramsPanel) {
    paramsPanel.open = false;
  }
  ensurePendingManualAirportLayer();
  updateSeedMarkers();
  syncManualAirportSelectUi();
  setStatus("Click the map to place an airport.");
}

function exitManualAirportSelectMode(reopenParams = false) {
  manualAirportSelectMode = false;
  manualStagingAirports = [];
  clearPendingManualAirport();
  updateManualStagingList();
  updateSeedMarkers();
  syncManualAirportSelectUi();
  if (reopenParams && paramsPanel) {
    paramsPanel.open = true;
    window.requestAnimationFrame(() => scrollToSeedsSection());
  }
  if (map?.getCanvas()) {
    map.getCanvas().style.cursor = "";
  }
}

function sortedManualStagingEntries() {
  return manualStagingAirports
    .map((seed, index) => ({ seed, index }))
    .sort((a, b) =>
      seedDisplayLabel(a.seed).localeCompare(seedDisplayLabel(b.seed), undefined, {
        sensitivity: "base",
      })
    );
}

function updateManualStagingList() {
  if (!manualAirportListEl) {
    return;
  }
  manualAirportListEl.replaceChildren();

  if (manualStagingAirports.length === 0) {
    manualAirportListEl.hidden = true;
    return;
  }

  manualAirportListEl.hidden = false;
  for (const { seed, index } of sortedManualStagingEntries()) {
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
    del.addEventListener("click", () => removeManualStagingAirport(index));

    row.append(label, del);
    manualAirportListEl.append(row);
  }
}

function removeManualStagingAirport(index) {
  if (computing || index < 0 || index >= manualStagingAirports.length) {
    return;
  }
  manualStagingAirports.splice(index, 1);
  updateManualStagingList();
  updateSeedMarkers();
  syncManualAirportSelectUi();
  if (manualStagingAirports.length === 0) {
    setStatus("Click the map to place an airport.");
  } else {
    setStatus(
      `${manualStagingAirports.length} airport${manualStagingAirports.length === 1 ? "" : "s"} picked — click Finished when done`
    );
  }
}

function commitPendingManualAirport() {
  if (!pendingManualAirport) {
    return;
  }

  const { lng, lat } = pendingManualAirport;
  const name = manualAirportNameInput?.value.trim() ?? "";
  const key = seedKey({ lng, lat });
  if (
    pendingSeeds.some((seed) => seedKey(seed) === key) ||
    manualStagingAirports.some((seed) => seedKey(seed) === key)
  ) {
    setStatus("Airport already in list");
    return;
  }

  const seed = { lng, lat, source: "map" };
  if (name) {
    seed.label = name;
  }
  manualStagingAirports.push(seed);

  if (manualAirportNameInput) {
    manualAirportNameInput.value = "";
  }
  clearPendingManualAirport();
  updateManualStagingList();
  updateSeedMarkers();
  syncManualAirportSelectUi();
  setStatus(
    `${manualStagingAirports.length} airport${manualStagingAirports.length === 1 ? "" : "s"} picked — click Finished when done`
  );
}

function finishManualAirportSelection() {
  if (manualStagingAirports.length === 0 || computing) {
    return;
  }

  const existing = new Set(pendingSeeds.map((seed) => seedKey(seed)));
  let added = 0;
  for (const seed of manualStagingAirports) {
    const key = seedKey(seed);
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    pendingSeeds.push({ ...seed });
    added += 1;
  }

  const pickedCount = manualStagingAirports.length;
  manualStagingAirports = [];
  updateManualStagingList();
  updateSeedMarkers();
  exitManualAirportSelectMode(true);

  if (added === 0) {
    setStatus("All picked airports are already in the list");
  } else if (added < pickedCount) {
    setStatus(
      `Added ${added} airport${added === 1 ? "" : "s"} — ${airportCountTotal(pendingSeeds.length)}`
    );
  } else {
    setStatus(
      `Added ${added} airport${added === 1 ? "" : "s"} — ${airportCountTotal(pendingSeeds.length)}`
    );
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
  if (computing || !areOpenAipAirportsAvailable()) {
    return;
  }
  if (manualAirportSelectMode) {
    exitManualAirportSelectMode(false);
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

async function addAirportsFromSelectAreas() {
  if (airportSelectRects.length === 0) {
    setStatus("Draw one or more areas on the map first");
    return;
  }

  const existing = new Set(pendingSeeds.map((seed) => seedKey(seed)));
  let added = 0;
  for (const rect of airportSelectRects) {
    await ensureAirportCellsCachedForBbox(rect, openAipConfig, setStatus);
    const airports = getCachedAirportsInBounds(
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
  refreshCachedAirportMapLayer();
  const areaCount = airportSelectRects.length;
  clearAirportSelectAreas();
  exitAirportAreaSelectMode(true);
  if (added === 0) {
    setStatus(`No new airports in the drawn areas — cache cells or draw a larger area`);
  } else {
    setStatus(
      `Added ${added} airport${added === 1 ? "" : "s"} from ${areaCount} area${areaCount === 1 ? "" : "s"} — ${airportCountTotal(pendingSeeds.length)}`
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
    empty.textContent = "Use Manual selection or Draw airport areas";
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
    setStatus("Airports cleared — add airports, then Run");
  } else {
    setStatus(airportCountStatus(pendingSeeds.length));
  }
}

function updateSeedMarkers() {
  ensureSeedLayers();
  const mapAirports = [...pendingSeeds];
  if (manualAirportSelectMode) {
    mapAirports.push(...manualStagingAirports);
  }
  const features = mapAirports.map((seed) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [seed.lng, seed.lat],
    },
    properties: {
      label: seedDisplayLabel(seed),
    },
  }));

  map.getSource("seeds").setData({
    type: "FeatureCollection",
    features,
  });

  syncSeedLayerVisibility();
  if (runComputeBtn) {
    runComputeBtn.disabled = pendingSeeds.length < MIN_SEEDS || computing;
  }
  syncAirportAreaSelectUi();
  updateSeedList();
}

function addPendingSeed(lng, lat, { label, source = "map" } = {}) {
  const key = seedKey({ lng, lat });
  if (pendingSeeds.some((seed) => seedKey(seed) === key)) {
    setStatus("Airport already in list");
    return false;
  }
  const seed = { lng, lat, source };
  if (label) {
    seed.label = label;
  }
  pendingSeeds.push(seed);
  updateSeedMarkers();
  updateAirspaceInfo(lng, lat);
  setStatus(airportCountStatus(pendingSeeds.length));
  return true;
}

function clearPendingSeeds() {
  if (manualAirportSelectMode) {
    exitManualAirportSelectMode(false);
  }
  pendingSeeds = [];
  clearPendingManualAirport();
  clearComputeResults();
  updateSeedMarkers();
  setStatus("Airports cleared — add airports, then Run");
}

function raisePathLayer() {
  if (contourLayersReady && map.getLayer("glide-contours-line")) {
    map.moveLayer("glide-contours-line");
    map.moveLayer("glide-contours-label");
  }
  for (const layerId of ["airports-cached", "airports-cached-labels"]) {
    if (map.getLayer(layerId)) {
      map.moveLayer(layerId);
    }
  }
  if (seedLayersReady && map.getLayer("seeds-circle")) {
    map.moveLayer("seeds-circle");
  }
  if (seedLayersReady && map.getLayer("seeds-label")) {
    map.moveLayer("seeds-label");
  }
  if (pendingManualAirportLayerReady && map.getLayer("pending-manual-airport-circle")) {
    map.moveLayer("pending-manual-airport-circle");
  }
  if (pathLayerReady && map.getLayer("glide-path-geo")) {
    map.moveLayer("glide-path-geo");
  }
  if (pathLayerReady && map.getLayer("glide-path")) {
    map.moveLayer("glide-path");
  }
}

const GLIDE_PATH_PAINT = {
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

function ensurePathLayer() {
  if (pathLayerReady) {
    return;
  }

  for (const sourceId of ["glide-path-geo", "glide-path"]) {
    map.addSource(sourceId, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: sourceId,
      type: "line",
      source: sourceId,
      paint: GLIDE_PATH_PAINT,
    });
  }

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
    groundClearance: glideParams?.groundClearance ?? 100,
    contourGeojson: null,
  };
  syncComputeContextBar();
  updateGeoLocationPath();
}

function syncComputeContextBar() {
  if (!computeContextBarEl) {
    return;
  }
  if (!coneState) {
    computeContextBarEl.hidden = true;
    if (computeContextMinAltEl) {
      computeContextMinAltEl.hidden = true;
    }
    if (computeContextMinAltValueEl) {
      computeContextMinAltValueEl.textContent = "";
    }
    if (computeContextParamsEl) {
      computeContextParamsEl.textContent = "";
    }
    document.body.classList.remove("has-compute-context");
    return;
  }

  const { glideRatio, groundClearance, circuitHeight } = coneState;
  const geoCell = isGeoTrackingOn() ? getGeoSampleCell() : null;

  if (computeContextMinAltEl && computeContextMinAltValueEl) {
    if (geoCell?.isReachable && geoCell.alt !== null) {
      computeContextMinAltValueEl.textContent = `${Math.round(geoCell.alt)} m`;
      computeContextMinAltEl.hidden = false;
    } else {
      computeContextMinAltEl.hidden = true;
      computeContextMinAltValueEl.textContent = "";
    }
  }

  if (computeContextParamsEl) {
    computeContextParamsEl.textContent = `L/D : ${glideRatio} - Ground : ${groundClearance} m - Circuit : ${circuitHeight} m`;
  }

  computeContextBarEl.hidden = false;
  document.body.classList.add("has-compute-context");

  if (lastInspectCell && footerCellHtml) {
    window.requestAnimationFrame(() => positionCellTooltip());
  }
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

function terrainMslAtCell(x, y, dem) {
  const idx = cellIndex(x, y, dem);
  return dem.terrainMsl
    ? dem.terrainMsl[idx]
    : dem.elevation[idx] - dem.groundClearance;
}

function isDownhillGroundSegment(from, to, ground, dem) {
  const fromIdx = cellIndex(from.x, from.y, dem);
  const toIdx = cellIndex(to.x, to.y, dem);
  if (ground[fromIdx] !== 1 || ground[toIdx] !== 1) {
    return false;
  }
  return terrainMslAtCell(to.x, to.y, dem) < terrainMslAtCell(from.x, from.y, dem);
}

function cellToLngLatCoord(x, y, dem) {
  const pt = gridCellToLngLat(x, y, dem);
  return [pt.lng, pt.lat];
}

function buildPathGeoJson(cells, dem, ground, coordinates) {
  if (!isHighlightDownhillGroundPathEnabled() || cells.length < 2) {
    return {
      type: "FeatureCollection",
      features:
        coordinates.length >= 2
          ? [
              {
                type: "Feature",
                geometry: { type: "LineString", coordinates },
                properties: {},
              },
            ]
          : [],
    };
  }

  const features = [];
  let segmentCoords = [];
  let segmentKind = null;

  for (let i = 1; i < cells.length; i += 1) {
    const from = cells[i - 1];
    const to = cells[i];
    const kind = isDownhillGroundSegment(from, to, ground, dem)
      ? "downhill-ground"
      : "default";
    const fromCoord = cellToLngLatCoord(from.x, from.y, dem);
    const toCoord = cellToLngLatCoord(to.x, to.y, dem);

    if (segmentKind === kind && segmentCoords.length > 0) {
      segmentCoords.push(toCoord);
    } else {
      if (segmentCoords.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: segmentCoords },
          properties: { segment: segmentKind },
        });
      }
      segmentKind = kind;
      segmentCoords = [fromCoord, toCoord];
    }
  }

  if (segmentCoords.length >= 2) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: segmentCoords },
      properties: { segment: segmentKind },
    });
  }

  return { type: "FeatureCollection", features };
}

function traceGlidePath(gi, gj) {
  const { dem, originX, originY } = coneState;
  const coordinates = [];
  const cells = [];
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

    cells.push({ x, y });
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

  return { coordinates, cells };
}

function refreshGeoPath(cell) {
  const path = traceGlidePath(cell.gi, cell.gj);
  if (path.coordinates.length >= 2) {
    setPathSourceData("glide-path-geo", path);
  } else if (path.coordinates.length === 1) {
    const pt = path.coordinates[0];
    setPathSourceData("glide-path-geo", { coordinates: [pt, pt], cells: path.cells });
  } else {
    clearGeoPath();
  }
}

function refreshInspectPath(cell) {
  const path = traceGlidePath(cell.gi, cell.gj);
  if (path.coordinates.length >= 2) {
    setPathSourceData("glide-path", path);
    lastPathScreenBounds = pathScreenBounds(path.coordinates);
  } else if (path.coordinates.length === 1) {
    const pt = path.coordinates[0];
    setPathSourceData("glide-path", { coordinates: [pt, pt], cells: path.cells });
    lastPathScreenBounds = pathScreenBounds([pt, pt]);
  } else {
    clearInspectPath();
    lastPathScreenBounds = null;
  }
  updateCellTooltip();
}

function setPathSourceData(sourceId, pathData) {
  ensurePathLayer();
  const coordinates = pathData.coordinates ?? pathData;
  const cells = pathData.cells ?? [];
  const { dem, ground } = coneState ?? {};

  map.getSource(sourceId).setData(
    dem && ground
      ? buildPathGeoJson(cells, dem, ground, coordinates)
      : {
          type: "FeatureCollection",
          features:
            coordinates.length >= 2
              ? [
                  {
                    type: "Feature",
                    geometry: { type: "LineString", coordinates },
                    properties: {},
                  },
                ]
              : [],
        }
  );
  raisePathLayer();
}

function clearGeoPath() {
  if (!pathLayerReady || !map.getSource("glide-path-geo")) {
    return;
  }
  map.getSource("glide-path-geo").setData({
    type: "FeatureCollection",
    features: [],
  });
}

function clearInspectPath() {
  if (!pathLayerReady || !map.getSource("glide-path")) {
    return;
  }
  map.getSource("glide-path").setData({
    type: "FeatureCollection",
    features: [],
  });
}

function clearAllGlidePaths() {
  clearGeoPath();
  clearInspectPath();
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

function clearComputeResults() {
  coneState = null;
  syncComputeContextBar();
  clearRasterOverlay();
  clearContourOverlay();
  clearCompareOverlay();
  clearCellInspect();
  clearAllGlidePaths();
  setDownloadContoursVisible(false);
  syncCompareLosButton();
}

function clearAllOverlays() {
  clearComputeResults();
  setStatus("Overlay cleared");
}

function syncCacheDownloadButton() {
  if (!runCacheDownloadBtn) {
    return;
  }
  runCacheDownloadBtn.disabled =
    !cacheSelectMode || selectedCacheCells.size === 0 || cacheDownloadInProgress;
}

function buildCacheGridFeatures() {
  if (!map) {
    return [];
  }

  const bounds = map.getBounds();
  const west = Math.floor(bounds.getWest());
  const east = Math.ceil(bounds.getEast());
  const south = Math.max(-85, Math.floor(bounds.getSouth()));
  const north = Math.min(85, Math.ceil(bounds.getNorth()));
  const features = [];

  for (let lng = west; lng < east; lng += 1) {
    for (let lat = south; lat < north; lat += 1) {
      const cellKey = `${lng},${lat}`;
      features.push({
        type: "Feature",
        properties: {
          cellKey,
          selected: selectedCacheCells.has(cellKey),
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [lng, lat],
              [lng + 1, lat],
              [lng + 1, lat + 1],
              [lng, lat + 1],
              [lng, lat],
            ],
          ],
        },
      });
    }
  }

  return features;
}

function ensureCacheGridLayers() {
  if (!map || cacheGridReady) {
    return;
  }

  map.addSource("cache-grid", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "cache-grid-fill",
    type: "fill",
    source: "cache-grid",
    paint: {
      "fill-color": [
        "case",
        ["boolean", ["get", "selected"], false],
        "rgba(80, 140, 255, 0.42)",
        "rgba(255, 255, 255, 0.04)",
      ],
    },
  });

  map.addLayer({
    id: "cache-grid-line",
    type: "line",
    source: "cache-grid",
    paint: {
      "line-color": "#000000",
      "line-width": 1,
    },
  });

  cacheGridReady = true;
}

function buildCacheAirportFeatures() {
  return mergedCachedAirportsToGeoJsonFeatures();
}

function ensureCachedAirportMapLayers() {
  if (!map || cachedAirportMapReady) {
    return;
  }

  map.addSource("airports-cached", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "airports-cached",
    type: "circle",
    source: "airports-cached",
    minzoom: OPENAIP_AIRPORT_MIN_ZOOM,
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        OPENAIP_AIRPORT_MIN_ZOOM,
        2,
        14,
        5,
      ],
      "circle-color": "#bf2d2d",
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff",
    },
  });

  map.addLayer({
    id: "airports-cached-labels",
    type: "symbol",
    source: "airports-cached",
    minzoom: OPENAIP_AIRPORT_LABEL_MIN_ZOOM,
    layout: {
      "text-field": ["coalesce", ["get", "icao_code"], ["get", "icaoCode"], ["get", "name"]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 10,
      "text-offset": [0, -1.2],
      "text-anchor": "bottom",
      "text-max-width": 10,
      "symbol-sort-key": 0,
      "text-optional": false,
    },
    paint: {
      "text-color": "#f5f7fa",
      "text-halo-color": "rgba(18, 22, 28, 0.92)",
      "text-halo-width": 2,
    },
  });

  cachedAirportMapReady = true;
  raisePathLayer();
}

function refreshCachedAirportMapLayer() {
  if (!cachedAirportMapReady || cacheSelectMode || !map?.getSource("airports-cached")) {
    return;
  }
  const bounds = map.getBounds();
  map.getSource("airports-cached").setData({
    type: "FeatureCollection",
    features: cachedAirportsToGeoJsonFeatures(
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth()
    ),
  });
}

function restAirspaceFillPaint() {
  return {
    "fill-color": [
      "match",
      ["get", "type"],
      AIRSPACE_TYPE_PROHIBITED,
      "#c62828",
      AIRSPACE_TYPE_ADVISORY,
      "#e65100",
      "#c62828",
    ],
    "fill-opacity": 0.28,
  };
}

function restAirspaceLinePaint() {
  return {
    "line-color": [
      "match",
      ["get", "type"],
      AIRSPACE_TYPE_PROHIBITED,
      "#9a0e0e",
      AIRSPACE_TYPE_ADVISORY,
      "#bf360c",
      "#9a0e0e",
    ],
    "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 12, 2],
    "line-opacity": 0.85,
  };
}

function ensureRestAirspaceLayers() {
  if (!map || restAirspaceLayersReady) {
    return;
  }

  map.addSource(REST_AIRSPACE_SOURCE, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: REST_AIRSPACE_FILL_LAYER,
    type: "fill",
    source: REST_AIRSPACE_SOURCE,
    paint: restAirspaceFillPaint(),
  });

  map.addLayer({
    id: REST_AIRSPACE_LINE_LAYER,
    type: "line",
    source: REST_AIRSPACE_SOURCE,
    paint: restAirspaceLinePaint(),
  });

  restAirspaceLayersReady = true;
  raisePathLayer();
}

function refreshRestAirspaceLayerData({ allCells = false } = {}) {
  if (!restAirspaceLayersReady || !map?.getSource(REST_AIRSPACE_SOURCE)) {
    return;
  }

  let features;
  if (allCells) {
    features = mergedCachedAirspacesToGeoJsonFeatures();
  } else {
    const bounds = map.getBounds();
    features = cachedAirspacesToGeoJsonFeatures(
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth()
    );
  }

  map.getSource(REST_AIRSPACE_SOURCE).setData({
    type: "FeatureCollection",
    features,
  });
}

function setRestAirspaceFillVisible(visible) {
  if (!map?.getLayer(REST_AIRSPACE_FILL_LAYER)) {
    return;
  }
  map.setLayoutProperty(REST_AIRSPACE_FILL_LAYER, "visibility", visible ? "visible" : "none");
}

function setRestAirspaceLineVisible(visible) {
  if (!map?.getLayer(REST_AIRSPACE_LINE_LAYER)) {
    return;
  }
  map.setLayoutProperty(REST_AIRSPACE_LINE_LAYER, "visibility", visible ? "visible" : "none");
}

function ensureCacheAirportLayers() {
  if (!map || cacheAirportsReady) {
    return;
  }

  map.addSource("cache-airports", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "cache-airports",
    type: "circle",
    source: "cache-airports",
    minzoom: OPENAIP_AIRPORT_MIN_ZOOM,
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        OPENAIP_AIRPORT_MIN_ZOOM,
        2,
        14,
        5,
      ],
      "circle-color": "#bf2d2d",
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff",
    },
  });

  map.addLayer({
    id: "cache-airport-labels",
    type: "symbol",
    source: "cache-airports",
    minzoom: OPENAIP_AIRPORT_LABEL_MIN_ZOOM,
    layout: {
      "text-field": ["coalesce", ["get", "icao_code"], ["get", "icaoCode"], ["get", "name"]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 10,
      "text-offset": [0, -1.2],
      "text-anchor": "bottom",
      "text-max-width": 10,
      "symbol-sort-key": 0,
      "text-optional": false,
    },
    paint: {
      "text-color": "#f5f7fa",
      "text-halo-color": "rgba(18, 22, 28, 0.92)",
      "text-halo-width": 2,
    },
  });

  cacheAirportsReady = true;
}

function updateCacheAirportData() {
  if (!cacheAirportsReady || !map.getSource("cache-airports")) {
    return;
  }
  map.getSource("cache-airports").setData({
    type: "FeatureCollection",
    features: buildCacheAirportFeatures(),
  });
}

function clearCacheAirportLayers() {
  if (!map || !cacheAirportsReady) {
    return;
  }
  if (map.getLayer("cache-airport-labels")) {
    map.removeLayer("cache-airport-labels");
  }
  if (map.getLayer("cache-airports")) {
    map.removeLayer("cache-airports");
  }
  if (map.getSource("cache-airports")) {
    map.removeSource("cache-airports");
  }
  cacheAirportsReady = false;
}

function refreshCacheSelectOverlays() {
  if (!cacheSelectMode) {
    return;
  }
  ensureCacheGridLayers();
  updateCacheGridData();
  ensureRestAirspaceLayers();
  refreshRestAirspaceLayerData({ allCells: true });
  setRestAirspaceFillVisible(true);
  setRestAirspaceLineVisible(true);
  ensureCacheAirportLayers();
  updateCacheAirportData();
}

function updateCacheGridData() {
  if (!cacheGridReady || !map.getSource("cache-grid")) {
    return;
  }
  map.getSource("cache-grid").setData({
    type: "FeatureCollection",
    features: buildCacheGridFeatures(),
  });
}

function refreshCacheGridForViewport() {
  refreshCacheSelectOverlays();
}

function clearCacheGridLayers() {
  if (!map || !cacheGridReady) {
    return;
  }
  if (map.getLayer("cache-grid-line")) {
    map.removeLayer("cache-grid-line");
  }
  if (map.getLayer("cache-grid-fill")) {
    map.removeLayer("cache-grid-fill");
  }
  if (map.getSource("cache-grid")) {
    map.removeSource("cache-grid");
  }
  cacheGridReady = false;
}

function setOverlaysHiddenForCacheSelect(hidden) {
  if (!map) {
    return;
  }

  if (hidden) {
    overlayVisibilityBeforeCache = new Map();
    for (const layerId of CACHE_HIDDEN_LAYER_IDS) {
      if (!map.getLayer(layerId)) {
        continue;
      }
      overlayVisibilityBeforeCache.set(
        layerId,
        map.getLayoutProperty(layerId, "visibility") ?? "visible"
      );
      map.setLayoutProperty(layerId, "visibility", "none");
    }
    clearCellInspect();
    info.classList.remove("visible");
    return;
  }

  if (overlayVisibilityBeforeCache) {
    for (const [layerId, visibility] of overlayVisibilityBeforeCache) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", visibility);
      }
    }
    overlayVisibilityBeforeCache = null;
  }
  syncAirspaceUi();
}

function enterCacheSelectMode() {
  if (cacheSelectMode || computing) {
    return;
  }
  if (manualAirportSelectMode) {
    exitManualAirportSelectMode(false);
  }
  if (airportAreaSelectMode) {
    exitAirportAreaSelectMode(false);
  }

  cancelPendingAutoCompute();
  cacheSelectMode = true;
  selectedCacheCells.clear();
  for (const cellKey of getLastCachedCellKeysForSelection()) {
    selectedCacheCells.add(cellKey);
  }
  paramsShell?.classList.add("cache-select-mode");
  if (paramsPanel) {
    paramsPanel.open = false;
  }
  if (cacheDataPanel) {
    cacheDataPanel.hidden = false;
  }
  if (openCacheDataBtn) {
    openCacheDataBtn.disabled = true;
  }

  setOverlaysHiddenForCacheSelect(true);
  refreshCacheSelectOverlays();
  syncCacheDownloadButton();
  setStatus(
    selectedCacheCells.size === 0
      ? "Click 1° cells to select areas to cache"
      : `${selectedCacheCells.size} cell${selectedCacheCells.size === 1 ? "" : "s"} selected — click Cache to verify or add cells`
  );
}

function exitCacheSelectMode() {
  if (!cacheSelectMode) {
    return;
  }

  cacheSelectMode = false;
  selectedCacheCells.clear();
  paramsShell?.classList.remove("cache-select-mode");
  if (cacheDataPanel) {
    cacheDataPanel.hidden = true;
  }
  if (openCacheDataBtn) {
    openCacheDataBtn.disabled = false;
  }

  clearCacheGridLayers();
  clearCacheAirportLayers();
  setOverlaysHiddenForCacheSelect(false);
  syncCacheDownloadButton();
  setStatus("Cache selection closed");
}

function toggleCacheCellSelection(lng, lat) {
  const key = cacheCellKey(lng, lat);
  if (selectedCacheCells.has(key)) {
    selectedCacheCells.delete(key);
  } else {
    selectedCacheCells.add(key);
  }
  updateCacheGridData();
  syncCacheDownloadButton();
  setStatus(
    selectedCacheCells.size === 0
      ? "Click 1° cells to select areas to cache"
      : `${selectedCacheCells.size} cell${selectedCacheCells.size === 1 ? "" : "s"} selected`
  );
}

async function runCacheDownload() {
  if (!cacheSelectMode || selectedCacheCells.size === 0 || cacheDownloadInProgress) {
    return;
  }

  cacheDownloadInProgress = true;
  syncCacheDownloadButton();
  try {
    await buildCacheBundle([...selectedCacheCells], openAipConfig, setStatus);
    refreshCacheSelectOverlays();
    refreshCachedAirportMapLayer();
    refreshRestAirspaceLayerData({ allCells: cacheSelectMode });
  } catch (error) {
    setStatus(`Cache error: ${error.message}`);
    console.error(error);
  } finally {
    cacheDownloadInProgress = false;
    syncCacheDownloadButton();
  }
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
      "line-color": "#000000",
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
      "symbol-sort-key": 100,
      "text-optional": true,
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
  const km = (distanceM / 1000).toFixed(1);
  return `<span class="tooltip-num">${km} km</span>`;
}

function tooltipNum(value, { warn = false, unit = "m" } = {}) {
  const classes = warn ? "tooltip-num tooltip-num-warn" : "tooltip-num";
  return `<span class="${classes}">${value}${unit ? ` ${unit}` : ""}</span>`;
}

function formatHoverTip(cell) {
  const minAltVal = cell.alt;
  const groundClearance = coneState?.groundClearance ?? 100;
  const minAlt = minAltVal !== null ? tooltipNum(Math.round(minAltVal)) : "—";
  const groundElev = tooltipNum(Math.round(cell.groundElev));

  let aboveGroundLine = "—";
  if (minAltVal !== null) {
    const aboveGround = Math.round(minAltVal - cell.groundElev);
    const warn = aboveGround < 1.2 * groundClearance;
    aboveGroundLine = tooltipNum(aboveGround, { warn });
  }

  const metrics = seedPathMetrics(cell);
  const pathLengthLine =
    metrics !== null ? formatDistanceKm(metrics.distanceM) : "—";
  const requiredLine =
    metrics !== null ? tooltipNum(Math.round(metrics.requiredAlt)) : "—";

  let deltaLine = "—";
  if (minAltVal !== null && metrics !== null) {
    const delta = Math.round(minAltVal - metrics.requiredAlt);
    const sign = delta > 0 ? "+" : "";
    const cls = delta >= 0 ? "delta-pos" : "delta-neg";
    deltaLine = `<span class="${cls} tooltip-num">${sign}${delta} m</span>`;
  }

  let text =
    `minimum alt: ${minAlt}\n` +
    `ground elevation: ${groundElev}\n` +
    `above ground: ${aboveGroundLine}`;

  if (isDebugMode()) {
    text +=
      `\n\n<span class="path-info-heading">comparison with measured path length (haversine):</span>\n` +
      `path length: ${pathLengthLine}\n` +
      `required alt: ${requiredLine}\n` +
      `delta: ${deltaLine}\n` +
      `<span class="path-info-note">delta heavily positive might mean path went over a saddle, or starts from a mountain well above glide, no issue in that case. use this on flatland at your latitude to check for unacceptable errors</span>`;
  }

  return text;
}

function updateGlidePath(pathData) {
  setPathSourceData("glide-path", pathData);
}

function clearGlidePath() {
  clearAllGlidePaths();
}

function makeComputeProgressHandler(dem, glideParams) {
  return ({ imageData, iteration, elapsedMs }) => {
    if ((glideParams.raw || !glideParams.contours) && imageData) {
      updateOverlay(imageData, dem);
    }
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
  syncBaseMapTerrainMaxZoom();
  ensurePathLayer();
  map.on("moveend", () => {
    updateTerrainResolutionHint();
    onAutoModeMapMoveEnd();
    refreshCacheGridForViewport();
    refreshCachedAirportMapLayer();
    if (isIncludeAirspaceEnabled() && !cacheSelectMode) {
      refreshRestAirspaceLayerData();
    }
  });
  map.on("resize", syncContourLabelSpacing);
  window.addEventListener("resize", syncContourLabelSpacing);

  try {
    openAipConfig = await loadOpenAipConfig();
    if (openAipConfigured(openAipConfig)) {
      console.info("OpenAIP REST caching enabled");
      ensureCachedAirportMapLayers();
      refreshCachedAirportMapLayer();
      syncAirspaceUi();
      raisePathLayer();
      updateSeedMarkers();
      if (isAutoParamsMode()) {
        scheduleAutoCompute({ refreshAirports: true });
      }
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
    setStatus("WebGPU ready — add airports, then Run");
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

  if (manualAirportSelectMode) {
    return;
  }

  if (!interaction.hoverPath) {
    return;
  }

  const { clientX, clientY } = event.originalEvent;
  if (isPointerOverParams(clientX, clientY)) {
    return;
  }

  const cell = sampleDemCell(event.lngLat.lng, event.lngLat.lat);
  if (cell === null) {
    if (!isDebugMode()) {
      clearCellInspect();
    }
    return;
  }

  showCellInspect(cell, event.point);
});

function syncPathsOnMapMove() {
  if (isGeoTrackingOn()) {
    updateGeoLocationPath();
  }
  syncInspectOnMapMove();
}

map.on("move", syncPathsOnMapMove);
map.on("zoom", syncPathsOnMapMove);

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
  if (manualAirportSelectMode && !computing && event.points.length === 1) {
    manualTouchStart = event.point;
  }
});

map.on("touchmove", (event) => {
  updateAirspaceInfo(event.lngLat.lng, event.lngLat.lat);

  if (airportAreaSelectMode && airportRectInteraction) {
    updateAirportAreaInteraction(event.lngLat);
    return;
  }

  if (manualTouchStart) {
    const dx = event.point.x - manualTouchStart.x;
    const dy = event.point.y - manualTouchStart.y;
    if (dx * dx + dy * dy > 100) {
      manualTouchStart = null;
    }
  }
});

map.on("touchend", (event) => {
  updateAirspaceInfo(event.lngLat.lng, event.lngLat.lat);

  if (airportAreaSelectMode && airportRectInteraction) {
    finishAirportAreaInteraction(event.lngLat);
    markTouchHandled();
    return;
  }

  if (manualAirportSelectMode && !computing) {
    if (manualTouchStart) {
      const dx = event.point.x - manualTouchStart.x;
      const dy = event.point.y - manualTouchStart.y;
      if (dx * dx + dy * dy > 100) {
        manualTouchStart = null;
        return;
      }
      manualTouchStart = null;
    }
    markTouchHandled();
    setPendingManualAirport(event.lngLat.lng, event.lngLat.lat);
    return;
  }
});

map.on("touchcancel", () => {
  manualTouchStart = null;
  if (airportRectInteraction) {
    cancelAirportRectInteraction();
    syncAirportAreaSelectUi();
  }
});

map.on("click", (event) => {
  if (cacheSelectMode) {
    const features = map.queryRenderedFeatures(event.point, { layers: ["cache-grid-fill"] });
    if (features.length > 0) {
      toggleCacheCellSelection(event.lngLat.lng, event.lngLat.lat);
    }
    return;
  }

  if (
    computing ||
    touchHandledRecently ||
    airportAreaSelectMode ||
    airportRectInteraction
  ) {
    return;
  }

  if (manualAirportSelectMode) {
    setPendingManualAirport(event.lngLat.lng, event.lngLat.lat);
    return;
  }

  if (!interaction.tapPath || !coneState) {
    return;
  }

  const { clientX, clientY } = event.originalEvent;
  if (isPointerOverParams(clientX, clientY)) {
    return;
  }

  const cell = sampleDemCell(event.lngLat.lng, event.lngLat.lat);
  if (cell?.isReachable) {
    showCellInspect(cell, event.point, { temporary: true });
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
    setStatus(formatComputeDone(result), { clearAfterMs: COMPUTE_DONE_STATUS_CLEAR_MS });
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  } finally {
    endComputeSession();
    compareLosBtn.disabled = false;
  }
}

async function runComputation(seedsOverride = null, { gridBounds = null } = {}) {
  if (computing) {
    return;
  }

  const seeds =
    seedsOverride ?? pendingSeeds.map((seed) => ({ lng: seed.lng, lat: seed.lat }));

  if (seeds.length < MIN_SEEDS) {
    setStatus(`Place at least ${MIN_SEEDS} airport on the map before running`);
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
    const dem = await buildDemGrid(seeds, {
      ...glideParams,
      openAipConfig,
      onStatus: setStatus,
      gridBounds,
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
    updateConeVisualization(result, dem, glideParams);
    ensurePathLayer();
    syncCompareLosButton();
    setDownloadContoursVisible(glideParams.contours);

    setStatus(
      formatComputeDone(
        result,
        ` — z${dem.zoom}, ${dem.width}×${dem.height}, ${seeds.length} airports`
      ),
      { clearAfterMs: COMPUTE_DONE_STATUS_CLEAR_MS }
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

openCacheDataBtn?.addEventListener("click", () => {
  if (computing) {
    return;
  }
  enterCacheSelectMode();
});

runCacheDownloadBtn?.addEventListener("click", () => {
  void runCacheDownload();
});

finishCacheSelectBtn?.addEventListener("click", () => {
  exitCacheSelectMode();
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

toggleManualAirportSelectBtn?.addEventListener("click", () => {
  if (computing) {
    return;
  }
  enterManualAirportSelectMode();
});

addManualAirportBtn?.addEventListener("click", () => {
  if (computing) {
    return;
  }
  commitPendingManualAirport();
});

clearManualAirportBtn?.addEventListener("click", () => {
  if (computing) {
    return;
  }
  if (manualAirportNameInput) {
    manualAirportNameInput.value = "";
  }
  clearPendingManualAirport();
  setStatus("Click the map to place an airport.");
});

finishManualAirportBtn?.addEventListener("click", () => {
  if (computing) {
    return;
  }
  finishManualAirportSelection();
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
  addAirportsFromSelectAreas().catch((error) => {
    setStatus(`Airport error: ${error.message}`);
    console.error(error);
  });
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
  if (paramsPanel.open && manualAirportSelectMode) {
    exitManualAirportSelectMode(false);
  }
});
