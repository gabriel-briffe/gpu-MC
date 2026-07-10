import {
  clampTerrainZoom,
  metersPerPixel,
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
import { assetUrl } from "./asset-url.js";
import { dom } from "./dom.js";
import {
  DEFAULT_MAX_ALTITUDE,
  MAP_CENTER,
  MAP_INITIAL_ZOOM,
  MAP_MAX_ZOOM,
  CACHE_SELECT_FOOTER_HINT,
} from "./constants.js";
import { createApp } from "./app-state.js";
import {
  initComputeVisualization,
  clearComputeResults,
} from "./compute/visualization.js";
import {
  initComputeSession,
  runComputation,
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
  clearGeoPath,
  refreshInspectPath,
  seedPathMetrics,
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
  syncDebugUi,
  isDebugMode,
  isAutoParamsMode,
  isManualParamsMode,
  isSingleParamsMode,
  getParamsMode,
  setParamsMode,
} from "./params/panel.js";
import {
  initSeeds,
  updateSeedMarkers,
  syncSeedLayerVisibility,
} from "./airports/seeds.js";
import { initDisabledAirports } from "./airports/disabled.js";
import {
  initManualSelect,
  exitManualAirportSelectMode,
  getManualAirportSelectMode,
} from "./airports/manual-select.js";
import {
  initAreaSelect,
  exitAirportAreaSelectMode,
  getAirportAreaSelectMode,
} from "./airports/area-select.js";
import { initAutoCompute, scheduleAutoCompute, clearAutoComputeScheduling, onAutoModeMapMoveEnd, syncAutoWindowSizeUi } from "./auto/auto-compute.js";
import { initSingleCompute, clearSingleComputeScheduling, flushSingleAirportCompute, getSingleComputePending, scheduleSingleAirportCompute } from "./single/single-compute.js";
import { initCacheUi, getCacheSelectMode } from "./cache/cache-ui.js";
import {
  initAppMenu,
  isGlideConesEnabled,
  isIconCh1Enabled,
  openAppMenu,
  openGlideSettings,
  closeAppMenu,
} from "./app-menu.js";
import { initIconCh1 } from "./iconch1/iconch1-app.js";
import { raiseIconCh1Layer } from "./map/layers.js";
import { needsStartupCacheMode } from "./cache-area.js";
import { bindMapEvents, bindUiEvents } from "./map/events.js";
import { initFakeGeo, isFakeGeoActive } from "./dev-fake-geo.js";
import { initWakeLock } from "./wake-lock.js";

const app = createApp();

const {
  info,
  airspaceInfoEl,
  statusEl,
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
  computeContextBarEl,
  computeContextGeoStatsEl,
  computeContextMinAltReadingEl,
  computeContextDeltaReadingEl,
  computeContextReqLdReadingEl,
  computeContextParamsEl,
  seedListEl,
  paramsFooterEl,
  paramsFooterInfoEl,
  paramsShell,
  paramsModeSingleBtn,
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
  cacheSelectBar,
  cacheSelectStatusEl,
  runCacheDownloadBtn,
  clearCacheDataBtn,
  finishCacheSelectBtn,
} = dom;

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

function getParamsFooterHint() {
  if (getCacheSelectMode()) {
    const selected = app.selectedCacheCells.size;
    if (selected === 0) {
      return CACHE_SELECT_FOOTER_HINT;
    }
    return `${selected} cell${selected === 1 ? "" : "s"} selected`;
  }

  switch (getParamsMode()) {
    case "single":
      if (app.singleLastPick?.id) {
        return "click an airport or change params to recompute";
      }
      return "click an airport to compute";
    case "auto":
    case "manual":
    default:
      return "click airport to enable/disable";
  }
}

function updateParamsFooter() {
  const text = app.footerStatusText || getParamsFooterHint();
  if (getCacheSelectMode() && dom.cacheSelectStatusEl) {
    dom.cacheSelectStatusEl.textContent = text;
    return;
  }
  if (!statusEl) {
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = text;
}

function isGeoTrackingOn() {
  if (isFakeGeoActive(app)) {
    return true;
  }
  if (!app.geolocateControl) {
    return false;
  }
  const state = app.geolocateControl._watchState;
  return state === "ACTIVE_LOCK" || state === "BACKGROUND" || state === "WAITING_ACTIVE";
}

function areOpenAipAirportsAvailable() {
  return openAipConfigured(app.openAipConfig);
}

function syncOpenAipVectorTiles() {
  if (!app.map) {
    return;
  }
  if (!isDebugMode()) {
    removeOpenAipVectorTiles(app.map);
    return;
  }
  const wantTiles = isIncludeAirspaceEnabled() && areOpenAipAirportsAvailable();
  if (wantTiles) {
    if (initOpenAipAirspaceTiles(app.map, app.openAipConfig)) {
      setOpenAipAirspaceVisible(app.map, true);
    }
    return;
  }
  removeOpenAipVectorTiles(app.map);
}

function isIncludeAirspaceEnabled() {
  return includeAirspaceInput?.checked ?? true;
}

function syncAirspaceUi() {
  if (getCacheSelectMode()) {
    return;
  }
  const enabled = isIncludeAirspaceEnabled() && areOpenAipAirportsAvailable();
  syncOpenAipVectorTiles();
  if (enabled) {
    ensureRestAirspaceLayers();
    refreshRestAirspaceLayerData();
    setRestAirspaceFillVisible(true);
    setRestAirspaceLineVisible(false);
    if (isDebugMode()) {
      info.classList.add("visible");
    } else {
      info.classList.remove("visible");
      if (airspaceInfoEl) {
        airspaceInfoEl.textContent = "—";
      }
    }
  } else {
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
  return app.map?.getCenter?.().lat ?? MAP_CENTER.lat;
}

function updateTerrainResolutionHint() {
  if (!terrainResolutionHintEl) {
    return;
  }
  const zoom = clampTerrainZoom(Number.parseInt(terrainZoomInput?.value ?? "", 10));
  const cellSizeM = metersPerPixel(getMapCenterLat(), zoom);
  terrainResolutionHintEl.textContent = `Resolution: ~${Math.round(cellSizeM)} m`;
}

function getHillshadeTileMaxZoom() {
  if (!isDebugMode()) {
    return BASE_MAP_TERRAIN_MAX_ZOOM;
  }
  return clampTerrainZoom(Number.parseInt(terrainZoomInput?.value ?? "", 10));
}

function syncBaseMapTerrainMaxZoom() {
  if (!app.map?.getStyle?.()?.sources?.hillshadeSource) {
    return;
  }
  setTerrainTileMaxZoom(getHillshadeTileMaxZoom());
}

function onTerrainZoomChange() {
  updateTerrainResolutionHint();
  syncBaseMapTerrainMaxZoom();
  if (isAutoParamsMode()) {
    scheduleAutoCompute({ debounce: true });
  } else if (isSingleParamsMode()) {
    scheduleSingleAirportCompute(undefined, { debounce: true });
  }
}

const sharedHooks = {
  app,
  getMap: () => app.map,
  getConeState: () => app.coneState,
  setConeState,
  clearConeState,
  clearComputeResults,
  isComputing: () => app.computing,
  setComputing: (value) => {
    app.computing = value;
  },
  getComputeShouldStop: () => app.computeShouldStop,
  setComputeShouldStop: (value) => {
    app.computeShouldStop = value;
  },
  getOpenAipConfig: () => app.openAipConfig,
  getSelectedCacheCells: () => app.selectedCacheCells,
  getLastGeoLngLat: () => app.lastGeoLngLat,
  getInteraction: () => app.interaction,
  runComputation,
  ensureEngine,
  isAutoParamsMode,
  isManualParamsMode,
  isSingleParamsMode,
  isGeoTrackingOn,
  areOpenAipAirportsAvailable,
  setStatus,
  stopComputeBtn,
  runComputeBtn,
  downloadContoursBtn,
  clearOverlayBtn,
  vizModeSelect,
  paramsForm,
  infoEl: info,
  cellTooltipEl,
  paramsShell,
  openAppMenu,
  openGlideSettings,
  closeAppMenu,
  isGlideConesEnabled,
  isIconCh1Enabled,
  raiseIconCh1Layer,
  computeContextBarEl,
  clearCellInspect,
  clearGlidePath,
  setDownloadContoursVisible,
  downloadContourGeojson,
  ensurePathLayer,
  raisePathLayer,
  syncAirspaceUi,
  setCacheDataWarnings,
  clearCacheDataWarnings,
  updateAirspaceInfo,
  isIncludeAirspaceEnabled,
  refreshCachedAirportMapLayer,
  refreshRestAirspaceLayerData,
  clearAllGlidePaths,
  pathScreenBounds,
  setLastPathScreenBounds,
  updateCellTooltip,
  updateParamsFooter,
  onMapMouseMove,
  onMapMouseLeave,
  onMapClickInspect,
  syncPathsOnMapMove,
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
  autoWindowSizeInput,
  autoWindowFromGlideInput,
  autoWindowSizeFieldEl,
  autoWindowGlideHintEl,
  openCacheDataBtn,
  cacheSelectBar,
  cacheSelectStatusEl,
  runCacheDownloadBtn,
  clearCacheDataBtn,
  finishCacheSelectBtn,
  setOverlaysHiddenForCacheSelect,
  refreshCacheSelectOverlays,
  reloadHillshadeSource,
  clearCacheGridLayers,
  clearCacheAirportLayers,
  updateCacheGridData,
  syncComputeContextBar,
};

initDisabledAirports(sharedHooks);
initSeeds(sharedHooks);
initManualSelect(sharedHooks);
initAreaSelect(sharedHooks);
initCacheUi(sharedHooks);
initAppMenu(sharedHooks, dom);
initIconCh1(sharedHooks, dom);
initAutoCompute(sharedHooks);
initSingleCompute(sharedHooks);
initMapLayers(sharedHooks);
initGlidePath(sharedHooks);
initCellInspect(sharedHooks);
initComputeVisualization(sharedHooks);
initComputeSession(sharedHooks);

app.hooks = {
  getMap: () => app.map,
  getConeState: () => app.coneState,
  isComputing: () => app.computing,
  getLastInspectCell,
  getManualAirportSelectMode,
  getAirportAreaSelectMode,
  clearAutoComputeScheduling,
  clearSingleComputeScheduling,
  flushSingleAirportCompute,
  getSingleComputePending,
  getSingleLastPick: () => app.singleLastPick,
  exitManualAirportSelectMode,
  exitAirportAreaSelectMode,
  scheduleAutoCompute,
  scheduleSingleAirportCompute,
  getParamsMode,
  syncSeedLayerVisibility,
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
  syncBaseMapTerrainMaxZoom,
  updateGridRadiusHint,
  updateTerrainResolutionHint,
  syncAutoWindowSizeUi,
  updateInteractionHints,
  isIncludeAirspaceEnabled,
  isDebugMode,
  clearComputeResults,
  setComputeShouldStop: (value) => {
    app.computeShouldStop = value;
  },
  syncComputeContextBar,
  openAppMenu,
  openGlideSettings,
  closeAppMenu,
  isGlideConesEnabled,
  isIconCh1Enabled,
  clearPendingSeedsSelection: () => sharedHooks.clearPendingSeedsSelection?.(),
};
initParamsPanel(app, dom);
sharedHooks.schedulePersistParamsState = () => app.hooks.schedulePersistParamsState?.();

if (typeof maplibregl !== "undefined") {
  maplibregl.setWorkerUrl(assetUrl("vendor/maplibre-gl/maplibre-gl-csp-worker.js"));
}

registerTerrainTileProtocol();

app.map = new maplibregl.Map({
  container: "map",
  hash: "map",
  zoom: MAP_INITIAL_ZOOM,
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

app.mapReady = new Promise((resolve) => {
  if (app.map.loaded()) {
    resolve(app.map);
    return;
  }
  app.map.once("load", () => resolve(app.map));
});
sharedHooks.waitForMapReady = () => app.mapReady;
app.hooks.waitForMapReady = () => app.mapReady;

function lockGeolocatePanZoom() {
  if (!app.map || !app.geolocateControl) {
    return;
  }
  app.geoTrackPanZoom = app.map.getZoom();
  app.geoTrackInitialPanPending = true;
  app.geolocateControl.options.fitBoundsOptions = {
    maxZoom: app.geoTrackPanZoom,
    minZoom: app.geoTrackPanZoom,
    linear: true,
  };
}

function panGeolocateToPosition(coords) {
  if (app.geoTrackPanZoom === null) {
    return;
  }
  app.map.easeTo(
    {
      center: [coords.longitude, coords.latitude],
      zoom: app.geoTrackPanZoom,
      bearing: app.map.getBearing(),
      duration: 500,
    },
    { geolocateSource: true }
  );
  app.geoTrackInitialPanPending = false;
}

app.map.addControl(new maplibregl.NavigationControl(), "top-right");
app.geolocateControl = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showUserHeading: true,
});
app.map.addControl(app.geolocateControl, "top-right");
app.geolocateControl._container?.addEventListener("click", lockGeolocatePanZoom, true);

app.geolocateControl.on("geolocate", (event) => {
  app.lastGeoLngLat = {
    lng: event.coords.longitude,
    lat: event.coords.latitude,
  };
  app.lastGeoAltitude = Number.isFinite(event.coords.altitude) ? event.coords.altitude : null;
  if (app.geoTrackInitialPanPending) {
    panGeolocateToPosition(event.coords);
  }
  updateGeoLocationPath();
  syncComputeContextBar();
});

app.geolocateControl.on("trackuserlocationstart", () => {
  lockGeolocatePanZoom();
  updateGeoLocationPath();
  syncComputeContextBar();
});

app.geolocateControl.on("trackuserlocationend", () => {
  app.geoTrackInitialPanPending = false;
  if (!isGeoTrackingOn()) {
    app.lastGeoLngLat = null;
    app.lastGeoAltitude = null;
    clearGeoPath();
    syncComputeContextBar();
  }
});

function setCacheDataWarnings(messages) {
  if (!airspaceInfoEl || !info) {
    return;
  }
  app.cacheDataWarnings = [...messages];
  if (!messages.length) {
    airspaceInfoEl.textContent = "—";
    if (!getCacheSelectMode()) {
      syncAirspaceUi();
    }
    return;
  }

  info.classList.add("visible");
  airspaceInfoEl.replaceChildren();
  const maxShown = 12;
  for (const message of messages.slice(0, maxShown)) {
    const warning = document.createElement("div");
    warning.className = "cache-data-warning";
    warning.textContent = message;
    airspaceInfoEl.append(warning);
  }
  if (messages.length > maxShown) {
    const more = document.createElement("div");
    more.className = "cache-data-warning";
    more.textContent = `…and ${messages.length - maxShown} more`;
    airspaceInfoEl.append(more);
  }
}

function clearCacheDataWarnings() {
  app.cacheDataWarnings = [];
  if (!airspaceInfoEl) {
    return;
  }
  airspaceInfoEl.replaceChildren();
  airspaceInfoEl.textContent = "—";
  if (!getCacheSelectMode()) {
    syncAirspaceUi();
  }
}

function updateAirspaceInfo(lng, lat) {
  if (app.cacheDataWarnings.length || getCacheSelectMode()) {
    return;
  }
  if (!isIncludeAirspaceEnabled() || !isDebugMode() || !app.map?.getSource("openaip")) {
    return;
  }

  const openKeys = new Set();
  for (const el of airspaceInfoEl.querySelectorAll("details[open]")) {
    if (el.dataset.key) {
      openKeys.add(el.dataset.key);
    }
  }

  const features = queryOpenAipAirspacesAt(app.map, lng, lat);
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
  if (app.statusClearTimer !== null) {
    window.clearTimeout(app.statusClearTimer);
    app.statusClearTimer = null;
  }
  app.footerStatusText = text;
  updateParamsFooter();
  if (clearAfterMs) {
    const snapshot = text;
    app.statusClearTimer = window.setTimeout(() => {
      app.statusClearTimer = null;
      if (app.footerStatusText === snapshot) {
        app.footerStatusText = "";
        updateParamsFooter();
      }
    }, clearAfterMs);
  }
}

function reloadHillshadeSource() {
  app.map?.style?.sourceCaches?.hillshadeSource?.reload?.();
}

function setTerrainTileMaxZoom(zoom) {
  const style = app.map.getStyle();
  if (!style?.sources?.hillshadeSource) {
    return;
  }

  style.sources.hillshadeSource.maxzoom = zoom;

  const cache = app.map.style?.sourceCaches?.hillshadeSource;
  if (cache?._source) {
    cache._source.maxzoom = zoom;
    cache.reload();
  }
}


function setConeState(dem, result, glideParams) {
  app.coneState = {
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
  app.coneState = null;
  syncComputeContextBar();
  updateGeoLocationPath();
}

function computeReqGlideRatio(metrics, userAlt) {
  const heightAboveSeed = userAlt - metrics.seedAlt;
  if (!Number.isFinite(userAlt) || heightAboveSeed <= 0) {
    return null;
  }
  return metrics.distanceM / heightAboveSeed;
}

function geoContextBarTone({ userAlt, geoCell, metrics, glideRatio }) {
  if (!geoCell?.isReachable || !metrics) {
    return null;
  }
  if (!Number.isFinite(userAlt)) {
    return "red";
  }
  if (geoCell.alt !== null && userAlt < geoCell.alt) {
    return "red";
  }
  const reqLd = computeReqGlideRatio(metrics, userAlt);
  if (reqLd === null) {
    return "red";
  }
  if (reqLd > glideRatio) {
    return "red";
  }
  if (reqLd > glideRatio * 0.9) {
    return "orange";
  }
  return "green";
}

function clearGeoContextReadings() {
  if (computeContextMinAltReadingEl) {
    computeContextMinAltReadingEl.textContent = "";
  }
  if (computeContextDeltaReadingEl) {
    computeContextDeltaReadingEl.textContent = "";
  }
  if (computeContextReqLdReadingEl) {
    computeContextReqLdReadingEl.textContent = "";
  }
}

function formatReqLdDisplay(reqLd) {
  if (reqLd === null) {
    return "—";
  }
  if (reqLd > 100) {
    return "100+";
  }
  return reqLd.toFixed(1);
}

function setGeoContextReadings({ minAlt, userAlt, reqLd }) {
  if (computeContextMinAltReadingEl) {
    computeContextMinAltReadingEl.textContent =
      minAlt !== null ? `${Math.round(minAlt)} m` : "—";
  }
  if (computeContextDeltaReadingEl) {
    if (Number.isFinite(userAlt) && minAlt !== null) {
      const delta = Math.round(userAlt - minAlt);
      const sign = delta > 0 ? "+" : "";
      computeContextDeltaReadingEl.textContent = `${sign}${delta} m`;
    } else {
      computeContextDeltaReadingEl.textContent = "—";
    }
  }
  if (computeContextReqLdReadingEl) {
    computeContextReqLdReadingEl.textContent = formatReqLdDisplay(reqLd);
  }
}

function setComputeContextBarTone(tone) {
  if (!computeContextBarEl) {
    return;
  }
  for (const name of ["green", "orange", "red"]) {
    computeContextBarEl.classList.toggle(`compute-context-bar--${name}`, tone === name);
  }
}

function updateComputeContextBarInset() {
  if (
    !computeContextBarEl ||
    computeContextBarEl.hidden ||
    !document.body.classList.contains("has-compute-context")
  ) {
    document.body.style.removeProperty("--compute-context-bar-height");
    return;
  }
  document.body.style.setProperty(
    "--compute-context-bar-height",
    `${computeContextBarEl.offsetHeight}px`
  );
}

function syncComputeContextBar() {
  if (!computeContextBarEl) {
    return;
  }
  if (!isGlideConesEnabled()) {
    computeContextBarEl.hidden = true;
    document.body.classList.remove("has-compute-context");
    updateComputeContextBarInset();
    return;
  }
  if (getCacheSelectMode()) {
    computeContextBarEl.hidden = true;
    document.body.classList.remove("has-compute-context");
    updateComputeContextBarInset();
    return;
  }
  if (!app.coneState) {
    computeContextBarEl.hidden = true;
    if (computeContextGeoStatsEl) {
      computeContextGeoStatsEl.hidden = true;
    }
    clearGeoContextReadings();
    if (computeContextParamsEl) {
      computeContextParamsEl.textContent = "";
    }
    setComputeContextBarTone(null);
    document.body.classList.remove("has-compute-context");
    updateComputeContextBarInset();
    return;
  }

  const { glideRatio, groundClearance, circuitHeight } = app.coneState;
  const geoTracking = isGeoTrackingOn();
  const geoCell = geoTracking ? getGeoSampleCell() : null;
  const metrics = geoCell?.isReachable ? seedPathMetrics(geoCell) : null;

  if (computeContextGeoStatsEl) {
    if (geoTracking && geoCell?.isReachable && geoCell.alt !== null) {
      const minAlt = geoCell.alt;
      const userAlt = app.lastGeoAltitude;
      const reqLd = metrics ? computeReqGlideRatio(metrics, userAlt) : null;

      setGeoContextReadings({ minAlt, userAlt, reqLd });
      computeContextGeoStatsEl.hidden = false;
      setComputeContextBarTone(
        geoContextBarTone({ userAlt, geoCell, metrics, glideRatio })
      );
    } else {
      computeContextGeoStatsEl.hidden = true;
      clearGeoContextReadings();
      setComputeContextBarTone(null);
    }
  }

  if (computeContextParamsEl) {
    computeContextParamsEl.textContent = `L/D : ${glideRatio} - Ground : ${groundClearance} m - Circuit : ${circuitHeight} m`;
  }

  computeContextBarEl.hidden = false;
  document.body.classList.add("has-compute-context");
  window.requestAnimationFrame(() => {
    updateComputeContextBarInset();
    if (hasActiveInspectTooltip()) {
      positionCellTooltip();
    }
  });
}

window.addEventListener("resize", () => {
  updateComputeContextBarInset();
});

function syncDownloadContoursButton() {
  if (!downloadContoursBtn) {
    return;
  }
  const hasContours = Boolean(app.coneState?.contourGeojson);
  const visible = isDebugMode() && hasContours;
  downloadContoursBtn.hidden = !visible;
  downloadContoursBtn.disabled = !visible;
}

function setDownloadContoursVisible(_visible) {
  syncDownloadContoursButton();
}

function downloadContourGeojson() {
  if (!isDebugMode() || !app.coneState?.contourGeojson) {
    return;
  }
  const dem = app.coneState.dem;
  const blob = new Blob([JSON.stringify(app.coneState.contourGeojson, null, 2)], {
    type: "application/geo+json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `glide-contours-z${dem.zoom}.geojson`;
  link.click();
  URL.revokeObjectURL(url);
}

async function ensureEngine() {
  if (!app.engine) {
    app.engine = new GlideConeEngine();
    await app.engine.init();
  }
  return app.engine;
}

function syncOfflineBanner() {
  if (navigator.onLine || app.computing || app.cacheDownloadInProgress) {
    return;
  }
  setStatus("Offline — using cached terrain and aeronautical data");
}

app.map.on("load", async () => {
  syncBaseMapTerrainMaxZoom();
  ensurePathLayer();
  initFakeGeo(app, sharedHooks);
  app.map.on("moveend", () => {
    updateTerrainResolutionHint();
    if (isAutoParamsMode()) {
      onAutoModeMapMoveEnd();
    }
    refreshCacheGridForViewport();
    refreshCachedAirportMapLayer();
    if (isIncludeAirspaceEnabled() && !getCacheSelectMode()) {
      refreshRestAirspaceLayerData();
    }
    sharedHooks.syncFakeGeoFromCamera?.();
  });
  app.map.on("resize", syncContourLabelSpacing);
  window.addEventListener("resize", syncContourLabelSpacing);
  window.addEventListener("online", () => {
    if (!app.computing && !app.cacheDownloadInProgress && !getCacheSelectMode()) {
      setStatus("");
    }
  });
  window.addEventListener("offline", syncOfflineBanner);
  syncOfflineBanner();

  try {
    app.openAipConfig = await loadOpenAipConfig();
    if (openAipConfigured(app.openAipConfig)) {
      console.info("OpenAIP REST caching enabled");
      ensureCachedAirportMapLayers();
      refreshCachedAirportMapLayer();
      syncAirspaceUi();
      raisePathLayer();
      updateSeedMarkers();
    }
  } catch (error) {
    console.warn(
      "OpenAIP disabled — check OPENAIP_PROXY_BASE in js/openaip-config.public.js",
      error
    );
  }

  if (needsStartupCacheMode()) {
    setParamsMode("single", { initial: true });
    sharedHooks.enterCacheSelectMode?.();
  } else if (openAipConfigured(app.openAipConfig) && isAutoParamsMode() && isGlideConesEnabled()) {
    scheduleAutoCompute({ refreshAirports: true });
  }

  ensureSeedLayers();
  updateSeedMarkers();
  try {
    await ensureEngine();
    if (!getCacheSelectMode()) {
      setStatus("");
    }
  } catch (error) {
    setStatus(error.message);
    console.error(error);
  }
});

bindMapEvents(app, sharedHooks);
bindUiEvents(app, sharedHooks);
initWakeLock();
