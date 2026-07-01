import {
  gridBoundsLngLat,
  gridCellToLngLat,
  gridIndexFromLngLat,
  pickTerrainZoom,
  clampTerrainZoom,
  metersPerPixel,
  kmBoxAroundLngLat,
  isInsideKmBoxInnerZone,
} from "./geo.js";
import { GlideConeEngine } from "./glidecone.js";
import {
  initOpenAipAirspaceTiles,
  removeOpenAipVectorTiles,
  queryOpenAipAirspacesAt,
  airspaceFeatureKey,
  setOpenAipAirspaceVisible,
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
  ensureAirportCellsCachedForBbox,
  getCachedAirportsInBounds,
  getLastCachedCellKeysForSelection,
} from "./cache-area.js";
import { dom } from "./dom.js";
import {
  DEFAULT_MAX_ALTITUDE,
  MIN_SEEDS,
  AUTO_WINDOW_SIZE_DEFAULT_KM,
  AUTO_WINDOW_GLIDE_FACTOR,
  AUTO_MAX_OFFSET_FROM_CENTER,
  AUTO_COMPUTE_DEBOUNCE_MS,
  MAP_CENTER,
  INITIAL_TERRAIN_Z,
  MAP_MAX_ZOOM,
  COMPUTE_DONE_STATUS_CLEAR_MS,
} from "./constants.js";
import { createApp } from "./app-state.js";
import { formatAirportLabel } from "./airport-label.js";
import {
  initComputeVisualization,
  clearRasterOverlay,
  clearContourOverlay,
  clearSectorBorderOverlay,
  clearComputeResults,
  clearAllOverlays,
} from "./compute/visualization.js";
import {
  initComputeSession,
  runComputation,
  runFullBresenhamCompare,
  requestStopCompute,
} from "./compute/session.js";
import {
  initMapLayers,
  ensurePathLayer,
  ensureSeedLayers,
  raisePathLayer,
  ensureCachedAirportMapLayers,
  refreshCachedAirportMapLayer,
  ensureRestAirspaceLayers,
  refreshRestAirspaceLayerData,
  setRestAirspaceFillVisible,
  setRestAirspaceLineVisible,
  refreshCacheGridForViewport,
  refreshCacheSelectOverlays,
  clearCacheGridLayers,
  clearCacheAirportLayers,
  setOverlaysHiddenForCacheSelect,
  syncContourLabelSpacing,
  updateCacheGridData,
} from "./map/layers.js";
import {
  initGlidePath,
  clearAllGlidePaths,
  clearGlidePath,
  refreshInspectPath,
} from "./glide-path.js";
import {
  initCellInspect,
  showCellInspect,
  clearCellInspect,
  getLastInspectCell,
  getGeoSampleCell,
  positionCellTooltip,
  updateCellTooltip,
  pathScreenBounds,
  setLastPathScreenBounds,
  onMapMouseMove,
  onMapMouseLeave,
  onMapClickInspect,
  syncPathsOnMapMove,
  hasActiveInspectTooltip,
  updateGeoLocationPath,
} from "./inspect/cell.js";
import {
  initParamsPanel,
  parseVizMode,
  syncParamVisibility,
  syncSectorsOpacityUi,
  applySectorsOverlayOpacity,
  syncDebugUi,
  isDebugMode,
  isAutoParamsMode,
} from "./params/panel.js";
import {
  initSeeds,
  getPendingSeeds,
  updateSeedMarkers,
  syncSeedLayerVisibility,
  setPendingSeedsFromAirports,
} from "./airports/seeds.js";
import {
  initManualSelect,
  exitManualAirportSelectMode,
  getManualAirportSelectMode,
  setPendingManualAirport,
} from "./airports/manual-select.js";
import {
  initAreaSelect,
  exitAirportAreaSelectMode,
  getAirportAreaSelectMode,
  syncAreaSelectCursor,
  beginAirportAreaInteraction,
  updateAirportAreaInteraction,
  finishAirportAreaInteraction,
  cancelAirportRectInteraction,
  syncAirportAreaSelectUi,
  hasAirportRectInteraction,
} from "./airports/area-select.js";

const app = createApp();

let map;

const {
  info,
  airspaceInfoEl,
  statusEl,
  cellInfoEl,
  cellTooltipEl,
  paramsForm,
  vizModeSelect,
  sectorsOpacityFieldEl,
  sectorsOpacityInput,
  sectorsOpacityHintEl,
  previewFieldEl,
  vizHintEl,
  gridRadiusHintEl,
  terrainZoomInput,
  terrainResolutionHintEl,
  autoWindowSizeInput,
  autoWindowFromGlideInput,
  autoWindowSizeFieldEl,
  autoWindowGlideHintEl,
  includeAirspaceInput,
  paramHelpPopover,
  compareLosBtn,
  compareLosRow,
  downloadContoursBtn,
  stopComputeBtn,
  runComputeBtn,
  toggleAirportAreaSelectBtn,
  toggleManualAirportSelectBtn,
  addAirportAreaBtn,
  addAirportsFromAreasBtn,
  clearAirportAreasBtn,
  addManualAirportBtn,
  clearManualAirportBtn,
  finishManualAirportBtn,
  manualAirportNameInput,
  manualAirportListEl,
  debugModeInput,
  highlightDownhillGroundPathInput,
  losRunInput,
  computeContextBarEl,
  computeContextMinAltEl,
  computeContextMinAltValueEl,
  computeContextParamsEl,
  seedListEl,
  paramsPanel,
  paramsShell,
  paramsModeAutoBtn,
  paramsModeManualBtn,
  paramsScrollEl,
  seedsSectionEl,
  airportAreaSelectPanel,
  manualAirportSelectPanel,
  clearOverlayBtn,
  clearAllSeedsBtn,
  pathInputHintEl,
  openCacheDataBtn,
  cacheDataPanel,
  runCacheDownloadBtn,
  finishCacheSelectBtn,
} = dom;

let engine = null;
let computing = false;
let computeShouldStop = false;
let compareOverlayCanvas = null;
let coneState = null;
let openAipConfig = null;
let touchHandledRecently = false;
let footerStatusText = "Loading WebGPU…";
let autoComputePending = false;
let autoComputeDebounceTimer = null;
let autoComputeNeedsAirportRefresh = false;
let autoComputeRegion = null;
let statusClearTimer = null;

let lastGeoLngLat = null;
let geolocateControl = null;
let geoTrackPanZoom = null;
let geoTrackInitialPanPending = false;
let manualTouchStart = null;
let cacheSelectMode = false;
let cacheDownloadInProgress = false;

function detectInteractionMode() {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const fine = window.matchMedia("(pointer: fine)").matches;
  const hover = window.matchMedia("(hover: hover)").matches;

  app.interaction.hoverPath = hover && fine;
  app.interaction.tapPath = coarse;

  updateInteractionHints();
}

function updateInteractionHints() {
  const pathParts = [];
  const { pathOnly } = parseVizMode();
  const surface = pathOnly ? "map" : "overlay";

  if (app.interaction.hoverPath) {
    pathParts.push(`Hover over the ${surface} to show the glide path`);
  }
  if (app.interaction.tapPath) {
    pathParts.push(`tap the ${surface} to show the glide path`);
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

function isGeoTrackingOn() {
  if (!geolocateControl) {
    return false;
  }
  const state = geolocateControl._watchState;
  return state === "ACTIVE_LOCK" || state === "BACKGROUND" || state === "WAITING_ACTIVE";
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
  if (!map) {
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

    setPendingSeedsFromAirports(
      airports.map((airport) => ({
        lng: airport.lng,
        lat: airport.lat,
        label: formatAirportLabel(airport),
        source: "airport",
      }))
    );
    setStatus(`Found ${airports.length} airports — fetching terrain…`);
    seedsForCompute = getPendingSeeds().map((seed) => ({ lng: seed.lng, lat: seed.lat }));
  } else if (getPendingSeeds().length >= MIN_SEEDS) {
    setStatus(`Recomputing ${getPendingSeeds().length} airports…`);
    seedsForCompute = getPendingSeeds().map((seed) => ({ lng: seed.lng, lat: seed.lat }));
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
  if (!map) {
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

function isHighlightDownhillGroundPathEnabled() {
  return highlightDownhillGroundPathInput?.checked ?? false;
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

const sharedHooks = {
  getMap: () => map,
  getConeState: () => coneState,
  setConeState,
  clearConeState,
  clearComputeResults,
  isComputing: () => computing,
  setComputing: (value) => {
    computing = value;
  },
  getComputeShouldStop: () => computeShouldStop,
  setComputeShouldStop: (value) => {
    computeShouldStop = value;
  },
  getOpenAipConfig: () => openAipConfig,
  getAutoComputePending: () => autoComputePending,
  getCacheSelectMode: () => cacheSelectMode,
  getSelectedCacheCells: () => app.selectedCacheCells,
  getLastGeoLngLat: () => lastGeoLngLat,
  getInteraction: () => app.interaction,
  ensureEngine,
  flushAutoCompute,
  isAutoParamsMode,
  isGeoTrackingOn,
  isHighlightDownhillGroundPathEnabled,
  areOpenAipAirportsAvailable,
  setStatus,
  stopComputeBtn,
  runComputeBtn,
  compareLosBtn,
  infoEl: info,
  cellTooltipEl,
  paramsShell,
  paramsPanel,
  computeContextBarEl,
  clearCellInspect,
  clearGlidePath,
  clearCompareOverlay,
  updateCompareOverlay,
  setCompareButtonVisible,
  setDownloadContoursVisible,
  syncCompareLosButton,
  ensurePathLayer,
  raisePathLayer,
  syncAirspaceUi,
  updateAirspaceInfo,
  refreshCachedAirportMapLayer,
  clearAllGlidePaths,
  pathScreenBounds,
  setLastPathScreenBounds,
  updateCellTooltip,
  updateParamsFooter,
  seedListEl,
  paramsScrollEl,
  seedsSectionEl,
  clearAllSeedsBtn,
  manualAirportSelectPanel,
  manualAirportListEl,
  manualAirportNameInput,
  addManualAirportBtn,
  clearManualAirportBtn,
  finishManualAirportBtn,
  toggleManualAirportSelectBtn,
  airportAreaSelectPanel,
  toggleAirportAreaSelectBtn,
  addAirportAreaBtn,
  addAirportsFromAreasBtn,
  clearAirportAreasBtn,
};

initSeeds(sharedHooks);
initManualSelect(sharedHooks);
initAreaSelect(sharedHooks);
initMapLayers(sharedHooks);
initGlidePath(sharedHooks);
initCellInspect(sharedHooks);
initComputeVisualization(sharedHooks);
initComputeSession(sharedHooks);

app.hooks = {
  getMap: () => map,
  getConeState: () => coneState,
  isComputing: () => computing,
  getLastInspectCell,
  getManualAirportSelectMode,
  getAirportAreaSelectMode,
  clearAutoComputeScheduling: () => {
    clearTimeout(autoComputeDebounceTimer);
    autoComputeDebounceTimer = null;
    autoComputePending = false;
    autoComputeNeedsAirportRefresh = false;
    autoComputeRegion = null;
  },
  exitManualAirportSelectMode,
  exitAirportAreaSelectMode,
  scheduleAutoCompute,
  syncSeedLayerVisibility,
  syncCompareLosButton,
  syncDownloadContoursButton,
  showCellInspect,
  setStatus,
  syncAirspaceUi,
  updateAirspaceInfo,
  refreshInspectPath,
  updateGeoLocationPath,
  isGeoTrackingOn,
  clearCellInspect,
  updateParamsFooter,
  detectInteractionMode,
  onTerrainZoomChange,
  updateGridRadiusHint,
  updateTerrainResolutionHint,
  syncAutoWindowSizeUi,
  updateInteractionHints,
  isIncludeAirspaceEnabled,
};
initParamsPanel(app, dom);

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
    pathOnly: glideParams?.pathOnly ?? false,
    sectors: glideParams?.sectors ?? false,
    glideRatio: glideParams?.glideRatio ?? 20,
    circuitHeight: glideParams?.circuitHeight ?? 250,
    groundClearance: glideParams?.groundClearance ?? 100,
    contourGeojson: null,
    sectorBorderGeojson: null,
  };
  syncComputeContextBar();
  updateGeoLocationPath();
}

function clearConeState() {
  coneState = null;
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

  if (hasActiveInspectTooltip()) {
    window.requestAnimationFrame(() => positionCellTooltip());
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

function syncCacheDownloadButton() {
  if (!runCacheDownloadBtn) {
    return;
  }
  runCacheDownloadBtn.disabled =
    !cacheSelectMode || app.selectedCacheCells.size === 0 || cacheDownloadInProgress;
}

function enterCacheSelectMode() {
  if (cacheSelectMode || computing) {
    return;
  }
  if (getManualAirportSelectMode()) {
    exitManualAirportSelectMode(false);
  }
  if (getAirportAreaSelectMode()) {
    exitAirportAreaSelectMode(false);
  }

  cancelPendingAutoCompute();
  cacheSelectMode = true;
  app.selectedCacheCells.clear();
  for (const cellKey of getLastCachedCellKeysForSelection()) {
    app.selectedCacheCells.add(cellKey);
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
    app.selectedCacheCells.size === 0
      ? "Click 1° cells to select areas to cache"
      : `${app.selectedCacheCells.size} cell${app.selectedCacheCells.size === 1 ? "" : "s"} selected — click Cache to verify or add cells`
  );
}

function exitCacheSelectMode() {
  if (!cacheSelectMode) {
    return;
  }

  cacheSelectMode = false;
  app.selectedCacheCells.clear();
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
  if (app.selectedCacheCells.has(key)) {
    app.selectedCacheCells.delete(key);
  } else {
    app.selectedCacheCells.add(key);
  }
  updateCacheGridData();
  syncCacheDownloadButton();
  setStatus(
    app.selectedCacheCells.size === 0
      ? "Click 1° cells to select areas to cache"
      : `${app.selectedCacheCells.size} cell${app.selectedCacheCells.size === 1 ? "" : "s"} selected`
  );
}

async function runCacheDownload() {
  if (!cacheSelectMode || app.selectedCacheCells.size === 0 || cacheDownloadInProgress) {
    return;
  }

  cacheDownloadInProgress = true;
  syncCacheDownloadButton();
  try {
    await buildCacheBundle([...app.selectedCacheCells], openAipConfig, setStatus);
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

  if (getAirportAreaSelectMode()) {
    if (hasAirportRectInteraction()) {
      updateAirportAreaInteraction(event.lngLat);
    } else {
      syncAreaSelectCursor(event.point);
    }
    return;
  }

  if (getManualAirportSelectMode()) {
    return;
  }

  onMapMouseMove(event);
});

map.on("move", syncPathsOnMapMove);
map.on("zoom", syncPathsOnMapMove);

map.on("mousedown", (event) => {
  if (event.originalEvent.button !== 0 || !getAirportAreaSelectMode()) {
    return;
  }
  beginAirportAreaInteraction(event.lngLat, event.point);
});

map.on("mouseup", (event) => {
  finishAirportAreaInteraction(event.lngLat);
});

map.on("mouseleave", () => {
  if (hasAirportRectInteraction()) {
    cancelAirportRectInteraction();
    syncAirportAreaSelectUi();
  }
  if (!app.interaction.hoverPath) {
    return;
  }
  onMapMouseLeave();
});

map.on("touchstart", (event) => {
  if (getAirportAreaSelectMode() && !computing && event.points.length === 1) {
    beginAirportAreaInteraction(event.lngLat, event.point);
    return;
  }
  if (getManualAirportSelectMode() && !computing && event.points.length === 1) {
    manualTouchStart = event.point;
  }
});

map.on("touchmove", (event) => {
  updateAirspaceInfo(event.lngLat.lng, event.lngLat.lat);

  if (getAirportAreaSelectMode() && hasAirportRectInteraction()) {
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

  if (getAirportAreaSelectMode() && hasAirportRectInteraction()) {
    finishAirportAreaInteraction(event.lngLat);
    markTouchHandled();
    return;
  }

  if (getManualAirportSelectMode() && !computing) {
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
  if (hasAirportRectInteraction()) {
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
    getAirportAreaSelectMode() ||
    hasAirportRectInteraction()
  ) {
    return;
  }

  if (getManualAirportSelectMode()) {
    setPendingManualAirport(event.lngLat.lng, event.lngLat.lat);
    return;
  }

  if (!app.interaction.tapPath || !coneState) {
    return;
  }

  onMapClickInspect(event);
});

paramsForm.addEventListener("submit", (event) => {
  event.preventDefault();
});

vizModeSelect?.addEventListener("change", () => {
  syncParamVisibility();
  const mode = parseVizMode();
  if (mode.pathOnly && coneState && !computing) {
    clearRasterOverlay();
    clearContourOverlay();
    clearSectorBorderOverlay();
    coneState.contourGeojson = null;
    coneState.sectorBorderGeojson = null;
    setDownloadContoursVisible(false);
  } else if (!mode.sectors && coneState && !computing) {
    clearSectorBorderOverlay();
    coneState.sectorBorderGeojson = null;
  } else if (mode.sectors) {
    applySectorsOverlayOpacity();
  }
  if (isAutoParamsMode()) {
    scheduleAutoCompute({ debounce: false });
    return;
  }
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

runComputeBtn?.addEventListener("click", () => {
  if (paramsPanel) {
    paramsPanel.open = false;
  }
  runComputation();
});

paramsPanel?.addEventListener("toggle", () => {
  if (paramsPanel.open && getAirportAreaSelectMode()) {
    exitAirportAreaSelectMode(false);
  }
  if (paramsPanel.open && getManualAirportSelectMode()) {
    exitManualAirportSelectMode(false);
  }
});
