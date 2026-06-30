import {
  gridBoundsLngLat,
  gridCellDistanceM,
  gridCellToLngLat,
  gridIndexFromLngLat,
  pickTerrainZoom,
  metersPerPixel,
} from "./geo.js";
import { buildDemGrid } from "./dem.js";
import { buildAltitudeContours } from "./contours.js";
import { GlideConeEngine } from "./glidecone.js";
import { initAirportsPanel } from "./airports.js";
import {
  initOpenAipTiles,
  pickOpenAipAirport,
  getViewportOpenAipAirports,
  queryOpenAipAirspacesAt,
  airspaceFeatureKey,
} from "./openaip-tiles.js";
import { loadOpenAipConfig } from "./openaip-client.js";

const DEFAULT_MAX_ALTITUDE = 3050;
const LONG_PRESS_MS = 550;
const MIN_SEEDS = 1;
const MAP_CENTER = { lng: 9.0788, lat: 47.1194 };
const INITIAL_TERRAIN_Z = pickTerrainZoom(MAP_CENTER.lat);
const MAP_MAX_ZOOM = 22;

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
const paramHelpPopover = document.getElementById("param-help-popover");
const compareLosBtn = document.getElementById("compare-los");
const compareLosRow = document.getElementById("compare-los-row");
const downloadContoursBtn = document.getElementById("download-contours");
const stopComputeBtn = document.getElementById("stop-compute");
const runComputeBtn = document.getElementById("run-compute");
const selectViewportAirportsBtn = document.getElementById("select-viewport-airports");
const seedListEl = document.getElementById("seed-list");
const paramsPanel = document.getElementById("params-panel");
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

function closeParamHelp() {
  if (!paramHelpPopover) {
    return;
  }
  paramHelpPopover.hidden = true;
  openParamHelpButton = null;
}

function openParamHelp(button) {
  const key = button.dataset.help;
  const text = PARAM_HELP[key];
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

  document.getElementById("los-run")?.addEventListener("input", syncCompareLosButton);
  detectInteractionMode();
  for (const query of ["(pointer: coarse)", "(pointer: fine)", "(hover: hover)"]) {
    window.matchMedia(query).addEventListener("change", detectInteractionMode);
  }
  syncCompareLosButton();
  updateParamsFooter();
}

initParamPanel();

function getGlideParams() {
  const glideRatio = Number.parseFloat(document.getElementById("ld").value);
  const circuitHeight = Number.parseFloat(document.getElementById("circuit").value);
  const groundClearance = Number.parseFloat(document.getElementById("clearance").value);
  const maxAltitude = Number.parseFloat(document.getElementById("max-alt").value);
  const originRunN = Number.parseInt(document.getElementById("los-run").value, 10);
  const updateMapMs = Number.parseInt(document.getElementById("update-map").value, 10);
  const { raw, contours } = parseVizMode();

  return {
    glideRatio: Number.isFinite(glideRatio) && glideRatio > 0 ? glideRatio : 20,
    circuitHeight: Number.isFinite(circuitHeight) && circuitHeight >= 0 ? circuitHeight : 250,
    groundClearance:
      Number.isFinite(groundClearance) && groundClearance >= 0 ? groundClearance : 100,
    maxAltitude:
      Number.isFinite(maxAltitude) && maxAltitude > 0 ? maxAltitude : DEFAULT_MAX_ALTITUDE,
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

const map = new maplibregl.Map({
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

initAirportsPanel(map, { onStatus: setStatus });

function updateAirspaceInfo(lng, lat) {
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
    empty.textContent = "Click the map or select viewport airports";
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
    setStatus("No airports in viewport — zoom in until OpenAIP tiles load");
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
  const losRunN = Number.parseInt(document.getElementById("los-run")?.value ?? "0", 10);
  const show = Number.isFinite(losRunN) && losRunN !== 0;
  if (compareLosRow) {
    compareLosRow.hidden = !show;
  }
  if (compareLosBtn) {
    compareLosBtn.disabled = !coneState || computing;
  }
}

function setCompareButtonVisible(_visible) {
  syncCompareLosButton();
}

function setDownloadContoursVisible(visible) {
  downloadContoursBtn.hidden = !visible;
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
      "symbol-spacing": 280,
      "text-keep-upright": true,
    },
    paint: {
      "text-color": "#a8c8ff",
      "text-halo-color": "rgba(18, 22, 28, 0.92)",
      "text-halo-width": 2,
    },
  });

  contourLayersReady = true;
}

function updateContourOverlay(geojson) {
  ensureContourLayers();
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
  const distanceLine =
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

  return (
    `minimum alt: ${minAlt}\n` +
    `ground elevation: ${groundElev}\n` +
    `distance to seed: ${distanceLine}\n` +
    `required alt: ${requiredLine}\n` +
    `delta: ${deltaLine}`
  );
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
  setTerrainTileMaxZoom(INITIAL_TERRAIN_Z);
  info.classList.add("visible");
  ensurePathLayer();

  try {
    openAipConfig = await loadOpenAipConfig();
    if (initOpenAipTiles(map, openAipConfig)) {
      console.info("OpenAIP vector tiles enabled");
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

  if (!interaction.hoverPath) {
    return;
  }

  const cell = sampleDemCell(event.lngLat.lng, event.lngLat.lat);
  if (cell === null) {
    clearCellInspect();
    return;
  }

  showCellInspect(cell);
});

map.on("mouseleave", () => {
  if (!interaction.hoverPath) {
    return;
  }
  clearCellInspect();
});

map.on("touchstart", (event) => {
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
    if (pickOpenAipAirport(map, event.point)) {
      return;
    }
    addPendingSeed(lng, lat);
  }, LONG_PRESS_MS);
});

map.on("touchmove", (event) => {
  updateAirspaceInfo(event.lngLat.lng, event.lngLat.lat);

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
  cancelLongPress();
  longPressDone = false;
  touchStartPoint = null;
});

map.on("click", (event) => {
  if (computing || touchHandledRecently) {
    return;
  }

  const airportFeature = pickOpenAipAirport(map, event.point);
  if (airportFeature) {
    console.log(airportFeature);
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
  info.classList.add("visible");
  setStatus("Sampling terrain…");
  clearCellInspect();
  clearGlidePath();
  clearCompareOverlay();
  setCompareButtonVisible(false);
  setDownloadContoursVisible(false);

  startComputeSession();

  try {
    const centerLat = seeds.reduce((sum, seed) => sum + seed.lat, 0) / seeds.length;
    const terrainZ = pickTerrainZoom(centerLat);
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
