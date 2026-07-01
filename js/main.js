import {
  gridBoundsLngLat,
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
import { dom } from "./dom.js";
import {
  DEFAULT_MAX_ALTITUDE,
  MAP_CENTER,
  INITIAL_TERRAIN_Z,
  MAP_MAX_ZOOM,
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
} from "./params/panel.js";
import {
  initSeeds,
  updateSeedMarkers,
  syncSeedLayerVisibility,
} from "./airports/seeds.js";
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
import { initCacheUi, getCacheSelectMode } from "./cache/cache-ui.js";
import { bindMapEvents, bindUiEvents } from "./map/events.js";

const app = createApp();

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

function updateParamsFooter() {
  if (!statusEl) {
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = app.footerStatusText;
}

function isGeoTrackingOn() {
  if (!app.geolocateControl) {
    return false;
  }
  const state = app.geolocateControl._watchState;
  return state === "ACTIVE_LOCK" || state === "BACKGROUND" || state === "WAITING_ACTIVE";
}

function isHighlightDownhillGroundPathEnabled() {
  return highlightDownhillGroundPathInput?.checked ?? false;
}

function areOpenAipAirportsAvailable() {
  return openAipConfigured(app.openAipConfig);
}

function syncOpenAipVectorTiles() {
  if (!app.map) {
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
  return includeAirspaceInput?.checked ?? false;
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
    if (app.map?.getSource("openaip")) {
      setOpenAipAirspaceVisible(app.map, true);
    }
    info.classList.add("visible");
  } else {
    if (app.map?.getSource("openaip")) {
      setOpenAipAirspaceVisible(app.map, false);
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

function syncBaseMapTerrainMaxZoom() {
  if (!app.map?.getStyle?.()?.sources?.hillshadeSource) {
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
  isGeoTrackingOn,
  isHighlightDownhillGroundPathEnabled,
  areOpenAipAirportsAvailable,
  setStatus,
  stopComputeBtn,
  runComputeBtn,
  compareLosBtn,
  downloadContoursBtn,
  clearOverlayBtn,
  vizModeSelect,
  paramsForm,
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
  downloadContourGeojson,
  syncCompareLosButton,
  ensurePathLayer,
  raisePathLayer,
  syncAirspaceUi,
  updateAirspaceInfo,
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
  cacheDataPanel,
  runCacheDownloadBtn,
  finishCacheSelectBtn,
  setOverlaysHiddenForCacheSelect,
  refreshCacheSelectOverlays,
  clearCacheGridLayers,
  clearCacheAirportLayers,
  updateCacheGridData,
};

initSeeds(sharedHooks);
initManualSelect(sharedHooks);
initAreaSelect(sharedHooks);
initCacheUi(sharedHooks);
initAutoCompute(sharedHooks);
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

app.map = new maplibregl.Map({
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
});
app.map.addControl(app.geolocateControl, "top-right");
app.geolocateControl._container?.addEventListener("click", lockGeolocatePanZoom, true);

app.geolocateControl.on("geolocate", (event) => {
  app.lastGeoLngLat = {
    lng: event.coords.longitude,
    lat: event.coords.latitude,
  };
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
    clearGeoPath();
    syncComputeContextBar();
  }
});

function updateAirspaceInfo(lng, lat) {
  if (!isIncludeAirspaceEnabled() || !app.map?.getSource("openaip")) {
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

function syncComputeContextBar() {
  if (!computeContextBarEl) {
    return;
  }
  if (!app.coneState) {
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

  const { glideRatio, groundClearance, circuitHeight } = app.coneState;
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
  const show = isDebugMode() && app.coneState && !app.computing;
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
  const hasContours = Boolean(app.coneState?.contourGeojson);
  downloadContoursBtn.hidden = !hasContours;
  downloadContoursBtn.disabled = !hasContours;
}

function setDownloadContoursVisible(_visible) {
  syncDownloadContoursButton();
}

function downloadContourGeojson() {
  if (!app.coneState?.contourGeojson) {
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

function clearCompareOverlay() {
  if (app.map.getLayer("glide-cone-full")) {
    app.map.removeLayer("glide-cone-full");
  }
  if (app.map.getSource("glide-cone-full")) {
    app.map.removeSource("glide-cone-full");
  }
}

function updateCompareOverlay(imageData, dem) {
  if (!app.compareOverlayCanvas) {
    app.compareOverlayCanvas = document.createElement("canvas");
  }
  app.compareOverlayCanvas.width = imageData.width;
  app.compareOverlayCanvas.height = imageData.height;
  app.compareOverlayCanvas.getContext("2d").putImageData(imageData, 0, 0);

  const coords = gridBoundsLngLat(dem.gx0, dem.gy0, dem.width, dem.height, dem.zoom);
  const coordinates = [
    [coords[0].lng, coords[0].lat],
    [coords[1].lng, coords[1].lat],
    [coords[2].lng, coords[2].lat],
    [coords[3].lng, coords[3].lat],
  ];

  if (app.map.getSource("glide-cone-full")) {
    app.map.getSource("glide-cone-full").updateImage({
      url: app.compareOverlayCanvas.toDataURL(),
      coordinates,
    });
    raisePathLayer();
    return;
  }

  app.map.addSource("glide-cone-full", {
    type: "image",
    url: app.compareOverlayCanvas.toDataURL(),
    coordinates,
  });

  app.map.addLayer({
    id: "glide-cone-full",
    type: "raster",
    source: "glide-cone-full",
    paint: {
      "raster-opacity": 1,
    },
  });
  raisePathLayer();
}


async function ensureEngine() {
  if (!app.engine) {
    app.engine = new GlideConeEngine();
    await app.engine.init();
  }
  return app.engine;
}

app.map.on("load", async () => {
  syncBaseMapTerrainMaxZoom();
  ensurePathLayer();
  app.map.on("moveend", () => {
    updateTerrainResolutionHint();
    onAutoModeMapMoveEnd();
    refreshCacheGridForViewport();
    refreshCachedAirportMapLayer();
    if (isIncludeAirspaceEnabled() && !getCacheSelectMode()) {
      refreshRestAirspaceLayerData();
    }
  });
  app.map.on("resize", syncContourLabelSpacing);
  window.addEventListener("resize", syncContourLabelSpacing);

  try {
    app.openAipConfig = await loadOpenAipConfig();
    if (openAipConfigured(app.openAipConfig)) {
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

bindMapEvents(app, sharedHooks);
bindUiEvents(app, sharedHooks);
