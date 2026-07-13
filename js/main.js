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
  displayedTerrainZoom,
} from "./terrain-tiles.js";
import { registerTerrainGradientProtocol } from "./map/terrain-gradient.js";
import { assetUrl } from "./asset-url.js";
import { MAP_GLYPHS_URL, MAP_SPRITE_URL } from "./map-fonts.js";
import { dom } from "./dom.js";
import {
  DEFAULT_MAX_ALTITUDE,
  MAP_CENTER,
  MAP_INITIAL_ZOOM,
  MAP_MAX_ZOOM,
  CACHE_SELECT_FOOTER_HINT,
  MANUAL_INSPECT_MS,
  MISSING_TERRAIN_CACHE_MSG,
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
  setOverlaysHiddenForCacheSelect,
  setOverlaysHiddenForManualAirportSelect,
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
  isSingleParamsMode,
  getParamsMode,
  setParamsMode,
  applyWeatherOverlayOpacity,
  getWeatherOverlayOpacity,
} from "./params/panel.js";
import {
  initComputeAirports,
} from "./airports/compute-airports.js";
import { initDisabledAirports } from "./airports/disabled.js";
import {
  addManualAirportsToStore,
  getManualAirportCount,
  getManualAirports,
  removeManualAirportFromStore,
} from "./airports/manual-airports.js";
import {
  initManualSelect,
  exitManualAirportSelectMode,
  getManualAirportSelectMode,
} from "./airports/manual-select.js";
import { initAutoCompute, scheduleAutoCompute, clearAutoComputeScheduling, onAutoModeMapMoveEnd, syncAutoWindowSizeUi } from "./auto/auto-compute.js";
import { initSingleCompute, clearSingleComputeScheduling, flushSingleAirportCompute, scheduleSingleAirportCompute } from "./single/single-compute.js";
import { initCacheUi } from "./cache/cache-ui.js";
import {
  initAppMenu,
  isGlideConesEnabled,
  isIconCh1Enabled,
  getIconChActiveModel,
  toggleIconChActiveModel,
  isOpenAipVectorEnabled,
  setOpenAipVectorEnabled,
  syncAppMenuUi,
  openAppMenu,
  openGlideSettings,
  closeAppMenu,
} from "./app-menu.js";
import { initIconCh1 } from "./iconch1/iconch1-app.js";
import { raiseIconCh1Layer } from "./map/layers.js";
import { ensureRasterBasemapLayers, reloadGradientBasemap, setBaseMapRasterMode } from "./map/raster-basemap.js";
import { setGradientAltitudes } from "./map/terrain-gradient.js";
import { needsStartupCacheMode } from "./cache-area.js";
import { bindMapEvents, bindUiEvents } from "./map/events.js";
import {
  ensureUserLocationLayers,
  resetUserLocationTrack,
  setUserLocationMarkerVisible,
  updateUserLocationFromPosition,
} from "./map/location-track.js";
import { initFakeGeo, isFakeGeoActive, syncFakeGeoMenuVisibility } from "./dev-fake-geo.js";
import { initWakeLock } from "./wake-lock.js";
import { attachSeedAirportMeta } from "./airport-label.js";

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
  vizHintEl,
  gridRadiusHintEl,
  terrainZoomInput,
  terrainResolutionHintEl,
  autoWindowSizeInput,
  autoWindowFromGlideInput,
  autoWindowSizeFieldEl,
  autoWindowGlideHintEl,
  includeAirspaceInput,
  includeManualAirportsInput,
  includeManualAirportsFieldEl,
  disableImportedAirportsInput,
  disableImportedAirportsFieldEl,
  paramHelpPopover,
  downloadContoursBtn,
  stopComputeBtn,
  addManualAirportsBtn,
  addManualAirportBtn,
  clearManualAirportBtn,
  finishManualAirportBtn,
  manualAirportNameInput,
  manualAirportListEl,
  manualAirportSelectBar,
  manualAirportSelectStatusEl,
  cancelManualAirportSelectBtn,
  debugModeInput,
  computeContextBarEl,
  computeContextGeoStatsEl,
  computeContextDestRowEl,
  computeContextDestIcaoEl,
  computeContextDestNameEl,
  computeContextDestZEl,
  computeContextDestPathEl,
  computeContextMinAltReadingEl,
  computeContextDeltaReadingEl,
  computeContextReqLdReadingEl,
  computeContextParamsEl,
  paramsFooterEl,
  paramsShell,
  paramsModeSingleBtn,
  paramsModeAutoBtn,
  paramsScrollEl,
  computeStopBar,
  computeStopMessageEl,
  pathInputHintEl,
  glideSettingsModeHintEl,
  openCacheDataBtn,
  cacheSelectBar,
  cacheSelectStatusEl,
  runCacheDownloadBtn,
  clearCacheDataBtn,
  finishCacheSelectBtn,
  cacheClearDialog,
  cacheClearDialogBackdrop,
  cacheClearOpenAipDesc,
  cacheClearTerrainDesc,
  cacheClearCellsDesc,
  cacheClearOpenAipBtn,
  cacheClearTerrainBtn,
  cacheClearCellsBtn,
  cacheClearCancelBtn,
  openAipExpiryDialog,
  openAipExpiryDialogBackdrop,
  openAipExpiryMessageEl,
  openAipExpiryCellsUpdatedEl,
  openAipExpiryStatusEl,
  openAipExpiryWarningsEl,
  openAipExpiryUpdateBtn,
  openAipExpiryLaterBtn,
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

function updateGlideSettingsModeHint() {
  if (!glideSettingsModeHintEl) {
    return;
  }
  if (app.cacheSelectMode || getManualAirportSelectMode()) {
    glideSettingsModeHintEl.hidden = true;
    return;
  }
  switch (getParamsMode()) {
    case "single":
      glideSettingsModeHintEl.hidden = false;
      glideSettingsModeHintEl.textContent = app.singleLastPick?.id
        ? "In single mode, click an airport or change params to recompute."
        : "In single mode, click an airport to compute.";
      break;
    case "auto":
      glideSettingsModeHintEl.hidden = false;
      glideSettingsModeHintEl.textContent =
        "In auto mode, click an airport to enable or disable it from compute.";
      break;
    default:
      glideSettingsModeHintEl.hidden = true;
  }
}

function getParamsFooterHint() {
  if (app.cacheSelectMode) {
    const selected = app.selectedCacheCells.size;
    if (selected === 0) {
      return CACHE_SELECT_FOOTER_HINT;
    }
    return `${selected} cell${selected === 1 ? "" : "s"} selected`;
  }

  if (getManualAirportSelectMode()) {
    return "Click the map to place an airport.";
  }

  return "";
}

function activeMapSelectStatusEl() {
  if (app.cacheSelectMode) {
    return dom.cacheSelectStatusEl;
  }
  if (getManualAirportSelectMode()) {
    return dom.manualAirportSelectStatusEl;
  }
  return null;
}

function isIncludeManualAirportsEnabled() {
  return includeManualAirportsInput?.checked ?? false;
}

function setIncludeManualAirports(enabled) {
  if (includeManualAirportsInput) {
    includeManualAirportsInput.checked = enabled;
  }
  app.hooks.schedulePersistParamsState?.();
}

function isDisableImportedAirportsEnabled() {
  return disableImportedAirportsInput?.checked ?? false;
}

function syncIncludeManualAirportsUi() {
  const count = getManualAirportCount();
  const hasManualAirports = count > 0;
  if (includeManualAirportsFieldEl) {
    includeManualAirportsFieldEl.hidden = !hasManualAirports;
  }
  if (includeManualAirportsInput) {
    includeManualAirportsInput.disabled = !hasManualAirports;
  }
  if (disableImportedAirportsFieldEl) {
    disableImportedAirportsFieldEl.hidden = !hasManualAirports;
  }
  if (disableImportedAirportsInput) {
    disableImportedAirportsInput.disabled = !hasManualAirports;
    if (!hasManualAirports && disableImportedAirportsInput.checked) {
      disableImportedAirportsInput.checked = false;
      app.hooks.refreshCachedAirportMapLayer?.();
      if (isAutoParamsMode()) {
        app.hooks.scheduleAutoCompute?.({ debounce: false, refreshAirports: true });
      } else if (isSingleParamsMode()) {
        app.hooks.scheduleSingleAirportCompute?.(undefined, { debounce: false });
      }
    }
  }
}

function clearComputeStopBarMessage() {
  if (app.computeStopBarClearTimer !== null) {
    window.clearTimeout(app.computeStopBarClearTimer);
    app.computeStopBarClearTimer = null;
  }
  app.computeStopBarMessage = "";
  if (computeStopMessageEl) {
    computeStopMessageEl.hidden = true;
    computeStopMessageEl.textContent = "";
  }
}

function showComputeStopBarMessage(
  text,
  { clearAfterMs = MANUAL_INSPECT_MS } = {}
) {
  clearComputeStopBarMessage();
  app.computeStopBarMessage = text;
  if (computeStopMessageEl) {
    computeStopMessageEl.textContent = text;
    computeStopMessageEl.hidden = false;
  }
  if (stopComputeBtn) {
    stopComputeBtn.hidden = true;
  }
  syncComputeStopBar();
  if (clearAfterMs > 0) {
    const snapshot = text;
    app.computeStopBarClearTimer = window.setTimeout(() => {
      app.computeStopBarClearTimer = null;
      if (app.computeStopBarMessage === snapshot) {
        clearComputeStopBarMessage();
        syncComputeStopBar();
      }
    }, clearAfterMs);
  }
}

function syncComputeStopBar() {
  const computing = app.computing;
  const hasMessage = Boolean(app.computeStopBarMessage);
  if (computeStopBar) {
    computeStopBar.hidden = !computing && !hasMessage;
  }
  if (stopComputeBtn) {
    stopComputeBtn.hidden = !computing || hasMessage;
  }
  if (computeStopMessageEl) {
    computeStopMessageEl.hidden = !hasMessage || computing;
  }
}

function updateParamsFooter() {
  updateGlideSettingsModeHint();
  const text = app.footerStatusText || getParamsFooterHint();
  const mapSelectStatus = activeMapSelectStatusEl();
  if (mapSelectStatus) {
    mapSelectStatus.textContent = text;
    return;
  }
  if (!statusEl) {
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = text;
}

function isGeolocateControlTracking() {
  if (!app.geolocateControl) {
    return false;
  }
  const state = app.geolocateControl._watchState;
  return state === "ACTIVE_LOCK" || state === "BACKGROUND" || state === "WAITING_ACTIVE";
}

function isGeoTrackingOn() {
  if (isFakeGeoActive(app)) {
    return true;
  }
  return isGeolocateControlTracking();
}

function applyGeoPosition(lng, lat, altitude) {
  app.lastGeoLngLat = { lng, lat };
  app.lastGeoAltitude = Number.isFinite(altitude) ? altitude : null;
  if (isGeoTrackingOn()) {
    setUserLocationMarkerVisible(app.map, true);
    updateUserLocationFromPosition(app.map, lng, lat);
  }
  updateGeoLocationPath();
  syncComputeContextBar();
}

function clearGeoTrackingMarker() {
  if (isFakeGeoActive(app) || isGeolocateControlTracking()) {
    return;
  }
  setUserLocationMarkerVisible(app.map, false);
  resetUserLocationTrack();
}

function areOpenAipAirportsAvailable() {
  return openAipConfigured(app.openAipConfig);
}

function isTerrainBasemapMode() {
  return app.baseMapRaster === "gradient";
}

function syncOpenAipVectorTiles() {
  if (!app.map) {
    return;
  }
  const wantTiles = isOpenAipVectorEnabled() && areOpenAipAirportsAvailable();
  if (wantTiles) {
    if (initOpenAipAirspaceTiles(app.map, app.openAipConfig)) {
      setOpenAipAirspaceVisible(app.map, true);
    }
    raisePathLayer();
    return;
  }
  removeOpenAipVectorTiles(app.map);
  raisePathLayer();
}

function syncAirspaceInfoBox() {
  if (!info) {
    return;
  }
  const showInfo =
    isDebugMode() &&
    isOpenAipVectorEnabled() &&
    areOpenAipAirportsAvailable() &&
    !app.cacheSelectMode &&
    app.cacheDataWarnings.length === 0;
  if (showInfo) {
    info.classList.add("visible");
    return;
  }
  info.classList.remove("visible");
  if (airspaceInfoEl && app.cacheDataWarnings.length === 0) {
    airspaceInfoEl.textContent = "—";
  }
}

function isIncludeAirspaceEnabled() {
  return includeAirspaceInput?.checked ?? true;
}

function syncAirspaceUi() {
  if (app.cacheSelectMode) {
    return;
  }

  syncOpenAipVectorTiles();

  const restEnabled =
    isIncludeAirspaceEnabled() &&
    areOpenAipAirportsAvailable() &&
    !isTerrainBasemapMode();
  if (restEnabled) {
    ensureRestAirspaceLayers();
    refreshRestAirspaceLayerData();
    setRestAirspaceFillVisible(true);
    setRestAirspaceLineVisible(false);
  } else {
    setRestAirspaceFillVisible(false);
    setRestAirspaceLineVisible(false);
  }

  syncAirspaceInfoBox();
  raisePathLayer();
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

function getDisplayedTerrainZoom() {
  return displayedTerrainZoom(app.map?.getZoom?.(), getHillshadeTileMaxZoom());
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

app.hooks = {
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
  getLastInspectCell,
  getInteraction: () => app.interaction,
  getDisplayedTerrainZoom,
  isGeolocateControlTracking,
  runComputation,
  ensureEngine,
  isAutoParamsMode,
  isSingleParamsMode,
  getParamsMode,
  isGeoTrackingOn,
  areOpenAipAirportsAvailable,
  isIncludeManualAirportsEnabled,
  isDisableImportedAirportsEnabled,
  setIncludeManualAirports,
  syncIncludeManualAirportsUi,
  addManualAirportsToStore,
  getManualAirportCount,
  getManualAirports,
  removeManualAirportFromStore,
  getManualAirportSelectMode,
  exitManualAirportSelectMode,
  clearAutoComputeScheduling,
  clearSingleComputeScheduling,
  flushSingleAirportCompute,
  getSingleComputePending: () => app.singleComputePending,
  getSingleLastPick: () => app.singleLastPick,
  scheduleAutoCompute,
  scheduleSingleAirportCompute,
  setStatus,
  stopComputeBtn,
  downloadContoursBtn,
  addManualAirportsBtn,
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
  getIconChActiveModel,
  toggleIconChActiveModel,
  isOpenAipVectorEnabled,
  setOpenAipVectorEnabled,
  raiseIconCh1Layer,
  setBaseMapRasterMode: (mode) => {
    setBaseMapRasterMode(app.map, mode);
    raisePathLayer();
  },
  reloadGradientBasemap: () => {
    reloadGradientBasemap(app.map);
  },
  computeContextBarEl,
  clearCellInspect,
  clearGlidePath,
  setDownloadContoursVisible,
  downloadContourGeojson,
  syncDownloadContoursButton,
  ensurePathLayer,
  raisePathLayer,
  syncAirspaceUi,
  applyWeatherOverlayOpacity,
  getWeatherOverlayOpacity,
  setCacheDataWarnings,
  clearCacheDataWarnings,
  updateAirspaceInfo,
  isIncludeAirspaceEnabled,
  refreshCachedAirportMapLayer,
  ensureCachedAirportMapLayers,
  refreshRestAirspaceLayerData,
  clearAllGlidePaths,
  pathScreenBounds,
  setLastPathScreenBounds,
  updateCellTooltip,
  showCellInspect,
  refreshInspectPath,
  updateGeoLocationPath,
  updateParamsFooter,
  syncComputeStopBar,
  showComputeStopBarMessage,
  clearComputeStopBarMessage,
  detectInteractionMode,
  onTerrainZoomChange,
  syncBaseMapTerrainMaxZoom,
  updateGridRadiusHint,
  updateTerrainResolutionHint,
  syncAutoWindowSizeUi,
  updateInteractionHints,
  isDebugMode,
  onMapMouseMove,
  onMapMouseLeave,
  onMapClickInspect,
  syncPathsOnMapMove,
  manualAirportSelectBar,
  manualAirportSelectStatusEl,
  cancelManualAirportSelectBtn,
  manualAirportListEl,
  manualAirportNameInput,
  addManualAirportBtn,
  clearManualAirportBtn,
  finishManualAirportBtn,
  includeManualAirportsInput,
  includeManualAirportsFieldEl,
  disableImportedAirportsInput,
  disableImportedAirportsFieldEl,
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
  cacheClearDialog,
  cacheClearDialogBackdrop,
  cacheClearOpenAipDesc,
  cacheClearTerrainDesc,
  cacheClearCellsDesc,
  cacheClearOpenAipBtn,
  cacheClearTerrainBtn,
  cacheClearCellsBtn,
  cacheClearCancelBtn,
  openAipExpiryDialog,
  openAipExpiryDialogBackdrop,
  openAipExpiryMessageEl,
  openAipExpiryCellsUpdatedEl,
  openAipExpiryStatusEl,
  openAipExpiryWarningsEl,
  openAipExpiryUpdateBtn,
  openAipExpiryLaterBtn,
  setOverlaysHiddenForCacheSelect,
  setOverlaysHiddenForManualAirportSelect,
  refreshCacheSelectOverlays,
  reloadHillshadeSource,
  clearCacheGridLayers,
  updateCacheGridData,
  syncComputeContextBar,
};

initDisabledAirports(app.hooks);
initComputeAirports(app.hooks);
initManualSelect(app.hooks);
initCacheUi(app.hooks);
initAppMenu(app.hooks, dom);
initIconCh1(app.hooks, dom);
initAutoCompute(app.hooks);
initSingleCompute(app.hooks);
initMapLayers(app.hooks);
initGlidePath(app.hooks);
initCellInspect(app.hooks);
initComputeVisualization(app.hooks);
initComputeSession(app.hooks);
initParamsPanel(app, dom);
syncFakeGeoMenuVisibility();

if (typeof maplibregl !== "undefined") {
  maplibregl.setWorkerUrl(assetUrl("vendor/maplibre-gl/maplibre-gl-csp-worker.js"));
}

registerTerrainTileProtocol();
registerTerrainGradientProtocol();

app.map = new maplibregl.Map({
  container: "map",
  hash: "map",
  zoom: MAP_INITIAL_ZOOM,
  maxZoom: MAP_MAX_ZOOM,
  center: [MAP_CENTER.lng, MAP_CENTER.lat],
  style: {
    version: 8,
    glyphs: MAP_GLYPHS_URL,
    sprite: assetUrl(MAP_SPRITE_URL),
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

app.map.keyboard.disable();

app.mapReady = new Promise((resolve) => {
  if (app.map.loaded()) {
    resolve(app.map);
    return;
  }
  app.map.once("load", () => resolve(app.map));
});
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
  showUserLocation: false,
  showUserHeading: false,
  showAccuracyCircle: false,
});
app.map.addControl(app.geolocateControl, "top-right");
app.geolocateControl._container?.addEventListener("click", lockGeolocatePanZoom, true);

app.geolocateControl.on("geolocate", (event) => {
  applyGeoPosition(
    event.coords.longitude,
    event.coords.latitude,
    event.coords.altitude
  );
  if (app.geoTrackInitialPanPending) {
    panGeolocateToPosition(event.coords);
  }
});

app.geolocateControl.on("trackuserlocationstart", () => {
  lockGeolocatePanZoom();
  resetUserLocationTrack();
  setUserLocationMarkerVisible(app.map, true);
  if (app.lastGeoLngLat) {
    updateUserLocationFromPosition(
      app.map,
      app.lastGeoLngLat.lng,
      app.lastGeoLngLat.lat
    );
  }
  updateGeoLocationPath();
  syncComputeContextBar();
});

app.geolocateControl.on("trackuserlocationend", () => {
  app.geoTrackInitialPanPending = false;
  if (!isGeoTrackingOn()) {
    app.lastGeoLngLat = null;
    app.lastGeoAltitude = null;
    clearGeoPath();
    clearGeoTrackingMarker();
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
    if (!app.cacheSelectMode) {
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
  if (!app.cacheSelectMode) {
    syncAirspaceUi();
  }
}

function updateAirspaceInfo(lng, lat) {
  if (app.cacheDataWarnings.length || app.cacheSelectMode) {
    return;
  }
  if (!isDebugMode() || !isOpenAipVectorEnabled() || !app.map?.getSource("openaip")) {
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
  attachSeedAirportMeta(dem, app.computeAirports);
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
  if (computeContextDestRowEl) {
    computeContextDestRowEl.hidden = true;
  }
  if (computeContextDestIcaoEl) {
    computeContextDestIcaoEl.textContent = "";
  }
  if (computeContextDestNameEl) {
    computeContextDestNameEl.textContent = "";
    computeContextDestNameEl.hidden = true;
  }
  if (computeContextDestZEl) {
    computeContextDestZEl.textContent = "";
  }
  if (computeContextDestPathEl) {
    computeContextDestPathEl.textContent = "";
    computeContextDestPathEl.hidden = true;
  }
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

function formatZDistanceDisplay(userAlt, minAlt) {
  if (!Number.isFinite(userAlt) || minAlt === null) {
    return "—";
  }
  const delta = Math.round(userAlt - minAlt);
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta} m`;
}

function formatPathDistanceDisplay(distanceM) {
  if (!Number.isFinite(distanceM)) {
    return "—";
  }
  return `${(distanceM / 1000).toFixed(1)} km`;
}

function setGeoContextReadings({ minAlt, userAlt, reqLd, metrics }) {
  if (metrics) {
    if (computeContextDestRowEl) {
      computeContextDestRowEl.hidden = false;
    }
    if (computeContextDestIcaoEl) {
      const icao = metrics.seedIcao;
      if (icao) {
        computeContextDestIcaoEl.textContent = icao;
        computeContextDestIcaoEl.hidden = false;
      } else {
        computeContextDestIcaoEl.textContent = "";
        computeContextDestIcaoEl.hidden = true;
      }
    }
    if (computeContextDestNameEl) {
      const name = metrics.seedName;
      const icao = metrics.seedIcao;
      if (name && (!icao || name !== icao)) {
        computeContextDestNameEl.textContent = name;
        computeContextDestNameEl.hidden = false;
      } else if (!name && !icao) {
        computeContextDestNameEl.textContent = "—";
        computeContextDestNameEl.hidden = false;
      } else {
        computeContextDestNameEl.textContent = "";
        computeContextDestNameEl.hidden = true;
      }
    }
    if (computeContextDestZEl) {
      computeContextDestZEl.textContent = formatPathDistanceDisplay(metrics.distanceM);
    }
    if (computeContextDestPathEl) {
      computeContextDestPathEl.textContent = "";
      computeContextDestPathEl.hidden = true;
    }
  } else {
    if (computeContextDestRowEl) {
      computeContextDestRowEl.hidden = true;
    }
    if (computeContextDestIcaoEl) {
      computeContextDestIcaoEl.textContent = "";
    }
    if (computeContextDestNameEl) {
      computeContextDestNameEl.textContent = "";
      computeContextDestNameEl.hidden = true;
    }
    if (computeContextDestZEl) {
      computeContextDestZEl.textContent = "";
    }
    if (computeContextDestPathEl) {
      computeContextDestPathEl.textContent = "";
      computeContextDestPathEl.hidden = true;
    }
  }
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

function formatReqLdDisplay(reqLd) {
  if (reqLd === null) {
    return "—";
  }
  if (reqLd > 100) {
    return "100+";
  }
  return reqLd.toFixed(1);
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
  if (app.cacheSelectMode) {
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

      setGeoContextReadings({ minAlt, userAlt, reqLd, metrics });
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
  setGradientAltitudes({
    minAlt: app.gradientMinAltitude,
    maxAlt: app.gradientMaxAltitude,
  });
  ensureRasterBasemapLayers(app.map);
  setBaseMapRasterMode(app.map, app.baseMapRaster);
  ensurePathLayer();
  ensureUserLocationLayers(app.map, () => raisePathLayer());
  initFakeGeo(app, app.hooks);
  app.map.on("moveend", () => {
    updateTerrainResolutionHint();
    if (isAutoParamsMode()) {
      onAutoModeMapMoveEnd();
    }
    refreshCacheGridForViewport();
    refreshCachedAirportMapLayer();
    if (isIncludeAirspaceEnabled() && !app.cacheSelectMode) {
      refreshRestAirspaceLayerData();
    }
    app.hooks.syncFakeGeoFromCamera?.();
  });
  app.map.on("resize", syncContourLabelSpacing);
  window.addEventListener("resize", syncContourLabelSpacing);
  window.addEventListener("online", () => {
    if (!app.computing && !app.cacheDownloadInProgress && !app.cacheSelectMode) {
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
      syncAppMenuUi();
      raisePathLayer();
    }
  } catch (error) {
    console.warn(
      "OpenAIP disabled — check OPENAIP_PROXY_BASE in js/openaip-config.public.js",
      error
    );
  }

  if (needsStartupCacheMode()) {
    setParamsMode("single", { initial: true });
    app.hooks.enterCacheSelectMode?.();
  } else {
    const showedOpenAipExpiryDialog = app.hooks.maybeShowOpenAipExpiryDialog?.() ?? false;
    if (
      !showedOpenAipExpiryDialog &&
      openAipConfigured(app.openAipConfig) &&
      isAutoParamsMode() &&
      isGlideConesEnabled()
    ) {
      scheduleAutoCompute({ refreshAirports: true });
    }
  }

  try {
    await ensureEngine();
    if (!app.cacheSelectMode) {
      setStatus("");
    }
  } catch (error) {
    setStatus(error.message);
    console.error(error);
  }
});

bindMapEvents(app, app.hooks);
bindUiEvents(app, app.hooks);
initWakeLock();
