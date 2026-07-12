import {
  REST_AIRSPACE_SOURCE,
  REST_AIRSPACE_FILL_LAYER,
  REST_AIRSPACE_LINE_LAYER,
  GLIDE_PATH_PAINT,
  GLIDE_PATH_GROUND_PAINT,
  GLIDE_PATH_GROUND_LAYOUT,
  glidePathLayerFilter,
  CACHE_HIDDEN_LAYER_IDS,
  MANUAL_AIRPORT_SELECT_HIDDEN_LAYER_IDS,
  AIRPORT_PICK_HIT_PX,
} from "../constants.js";
import {
  OPENAIP_AIRPORT_MIN_ZOOM,
  OPENAIP_AIRPORT_LABEL_MIN_ZOOM,
  OPENAIP_AIRPORT_CIRCLE_RADIUS,
  OPENAIP_VECTOR_LAYER_IDS,
} from "../openaip-tiles.js";
import {
  AIRSPACE_TYPE_ADVISORY,
  AIRSPACE_TYPE_PROHIBITED,
} from "../airspace.js";
import {
  cachedAirportsToGeoJsonFeatures,
  cachedAirspacesToGeoJsonFeatures,
  mergedCachedAirportsToGeoJsonFeatures,
  mergedCachedAirspacesToGeoJsonFeatures,
} from "../cache-area.js";
import { manualAirportsToGeoJsonFeatures } from "../airports/manual-airports.js";
import { isAutoParamsMode, isSingleParamsMode } from "../params/panel.js";

let hooks;
let app;

export function initMapLayers(h) {
  hooks = h;
  app = h.app;
}

/** Bottom-to-top overlay stack (OSM + hillshade basemap stay below). Labels sit above their layer. */
const MAP_LAYER_ORDER = [
  "glide-cone",
  "glide-sectors-line",
  REST_AIRSPACE_FILL_LAYER,
  "ch1-sectors-layer",
  "airports-cached",
  "airports-cached-labels",
  "airports-cached-hit",
  "pending-manual-airport-circle",
  "glide-contours-line",
  "glide-contours-label",
  REST_AIRSPACE_LINE_LAYER,
  ...OPENAIP_VECTOR_LAYER_IDS,
  "fake-geo-position",
  "glide-path-geo",
  "glide-path-geo-ground",
  "glide-path",
  "glide-path-ground",
  "cache-grid-fill",
  "cache-grid-line",
];

export function syncMapLayerOrder() {
  const map = hooks.getMap();
  if (!map) {
    return;
  }
  for (const layerId of MAP_LAYER_ORDER) {
    if (map.getLayer(layerId)) {
      map.moveLayer(layerId);
    }
  }
}

export function raisePathLayer() {
  syncMapLayerOrder();
}

export function raiseIconCh1Layer() {
  syncMapLayerOrder();
}

export function ensurePathLayer() {
  const map = hooks.getMap();
  if (app.pathLayerReady || !map) {
    return;
  }

  map.addSource("glide-path", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  const pathLayers = [
    { id: "glide-path", role: "inspect", ground: false },
    { id: "glide-path-ground", role: "inspect", ground: true },
    { id: "glide-path-geo", role: "geo", ground: false },
    { id: "glide-path-geo-ground", role: "geo", ground: true },
  ];

  for (const { id, role, ground } of pathLayers) {
    map.addLayer({
      id,
      type: "line",
      source: "glide-path",
      filter: glidePathLayerFilter(role, ground),
      paint: ground ? GLIDE_PATH_GROUND_PAINT : GLIDE_PATH_PAINT,
      ...(ground ? { layout: GLIDE_PATH_GROUND_LAYOUT } : {}),
    });
  }

  app.pathLayerReady = true;
  raisePathLayer();
}

function contourLabelSymbolSpacing() {
  return Math.min(window.innerWidth, window.innerHeight) / 3;
}

export function syncContourLabelSpacing() {
  const map = hooks.getMap();
  if (!app.contourLayersReady || !map?.getLayer("glide-contours-label")) {
    return;
  }
  map.setLayoutProperty(
    "glide-contours-label",
    "symbol-spacing",
    contourLabelSymbolSpacing()
  );
}

export function ensureContourLayers() {
  const map = hooks.getMap();
  if (app.contourLayersReady || !map) {
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

  app.contourLayersReady = true;
  syncContourLabelSpacing();
  raisePathLayer();
}

export function ensureSectorBorderLayers() {
  const map = hooks.getMap();
  if (app.sectorBorderLayersReady || !map) {
    return;
  }

  map.addSource("glide-sectors", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "glide-sectors-line",
    type: "line",
    source: "glide-sectors",
    paint: {
      "line-color": "#5c6573",
      "line-width": 1.5,
      "line-opacity": 0.9,
    },
  });

  app.sectorBorderLayersReady = true;
  raisePathLayer();
}

function buildCacheGridFeatures() {
  const map = hooks.getMap();
  if (!map) {
    return [];
  }

  const bounds = map.getBounds();
  const west = Math.floor(bounds.getWest());
  const east = Math.ceil(bounds.getEast());
  const south = Math.max(-85, Math.floor(bounds.getSouth()));
  const north = Math.min(85, Math.ceil(bounds.getNorth()));
  const features = [];
  const selectedCacheCells = hooks.getSelectedCacheCells();

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

export function ensureCacheGridLayers() {
  const map = hooks.getMap();
  if (!map || app.cacheGridReady) {
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

  app.cacheGridReady = true;
  raisePathLayer();
}

export function ensureCachedAirportMapLayers() {
  const map = hooks.getMap();
  if (!map || app.cachedAirportMapReady) {
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
      "circle-radius": OPENAIP_AIRPORT_CIRCLE_RADIUS,
      "circle-color": [
        "case",
        ["boolean", ["get", "disabled"], false],
        "#5a5a5a",
        ["boolean", ["get", "manual"], false],
        "#2d8a4e",
        "#bf2d2d",
      ],
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff",
      "circle-opacity": [
        "case",
        ["boolean", ["get", "disabled"], false],
        0.55,
        1,
      ],
    },
  });

  map.addLayer({
    id: "airports-cached-labels",
    type: "symbol",
    source: "airports-cached",
    minzoom: OPENAIP_AIRPORT_LABEL_MIN_ZOOM,
    filter: ["!", ["boolean", ["get", "disabled"], false]],
    layout: {
      "text-field": ["coalesce", ["get", "name"], ["get", "icao_code"], ["get", "icaoCode"]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 10,
      "text-offset": [0, -1.2],
      "text-anchor": "bottom",
      "text-max-width": 14,
      "symbol-sort-key": 0,
      "text-optional": false,
    },
    paint: {
      "text-color": "#f5f7fa",
      "text-halo-color": "rgba(18, 22, 28, 0.92)",
      "text-halo-width": 2,
    },
  });

  map.addLayer({
    id: "airports-cached-hit",
    type: "circle",
    source: "airports-cached",
    minzoom: OPENAIP_AIRPORT_MIN_ZOOM,
    paint: {
      "circle-radius": AIRPORT_PICK_HIT_PX,
      "circle-opacity": 0,
      "circle-stroke-width": 0,
    },
  });

  app.cachedAirportMapReady = true;
  raisePathLayer();
}

function shouldIncludeManualAirportsOnMap() {
  if (hooks.getManualAirportSelectMode?.()) {
    return true;
  }
  return (
    hooks.isIncludeManualAirportsEnabled?.() &&
    (isAutoParamsMode() || isSingleParamsMode())
  );
}

function shouldHideImportedAirportsOnMap() {
  if (hooks.getManualAirportSelectMode?.() || hooks.getCacheSelectMode?.()) {
    return false;
  }
  return hooks.isDisableImportedAirportsEnabled?.() ?? false;
}

function mergeAirportFeaturesForMap(west, south, east, north, { allManual = false } = {}) {
  const byId = new Map();
  if (!shouldHideImportedAirportsOnMap()) {
    for (const feature of cachedAirportsToGeoJsonFeatures(west, south, east, north)) {
      const id = feature.properties?.airport_id;
      if (id) {
        byId.set(String(id), feature);
      }
    }
  }
  if (shouldIncludeManualAirportsOnMap()) {
    const manualWest = allManual ? -180 : west;
    const manualSouth = allManual ? -85 : south;
    const manualEast = allManual ? 180 : east;
    const manualNorth = allManual ? 85 : north;
    for (const feature of manualAirportsToGeoJsonFeatures(
      manualWest,
      manualSouth,
      manualEast,
      manualNorth
    )) {
      const id = feature.properties?.airport_id;
      if (id && !byId.has(String(id))) {
        byId.set(String(id), feature);
      }
    }
  }
  const applyDisabled = !hooks.getManualAirportSelectMode?.();
  return [...byId.values()].map((feature) => {
    const props = feature.properties ?? {};
    const disabled = applyDisabled
      ? (hooks.isAirportDisabledById?.(props.airport_id) ?? false)
      : false;
    return {
      ...feature,
      properties: {
        ...props,
        disabled,
      },
    };
  });
}

function syncAirportPickLayerVisibility() {
  const map = hooks.getMap();
  if (!map?.getLayer("airports-cached-hit")) {
    return;
  }
  const pickVisible =
    !hooks.getCacheSelectMode() && !hooks.getManualAirportSelectMode?.();
  map.setLayoutProperty(
    "airports-cached-hit",
    "visibility",
    pickVisible ? "visible" : "none"
  );
}

export function refreshCachedAirportMapLayer() {
  const map = hooks.getMap();
  if (!app.cachedAirportMapReady || !map?.getSource("airports-cached")) {
    return;
  }

  let features;
  if (hooks.getCacheSelectMode()) {
    features = mergedCachedAirportsToGeoJsonFeatures();
  } else if (hooks.getManualAirportSelectMode?.()) {
    const bounds = map.getBounds();
    features = mergeAirportFeaturesForMap(
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
      { allManual: true }
    );
  } else {
    const bounds = map.getBounds();
    features = mergeAirportFeaturesForMap(
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth()
    );
  }

  map.getSource("airports-cached").setData({
    type: "FeatureCollection",
    features,
  });
  syncAirportPickLayerVisibility();
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

export function ensureRestAirspaceLayers() {
  const map = hooks.getMap();
  if (!map || app.restAirspaceLayersReady) {
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

  app.restAirspaceLayersReady = true;
  raisePathLayer();
}

export function refreshRestAirspaceLayerData({ allCells = false } = {}) {
  const map = hooks.getMap();
  if (!app.restAirspaceLayersReady || !map?.getSource(REST_AIRSPACE_SOURCE)) {
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

export function setRestAirspaceFillVisible(visible) {
  const map = hooks.getMap();
  if (!map?.getLayer(REST_AIRSPACE_FILL_LAYER)) {
    return;
  }
  map.setLayoutProperty(REST_AIRSPACE_FILL_LAYER, "visibility", visible ? "visible" : "none");
}

export function setRestAirspaceLineVisible(visible) {
  const map = hooks.getMap();
  if (!map?.getLayer(REST_AIRSPACE_LINE_LAYER)) {
    return;
  }
  map.setLayoutProperty(REST_AIRSPACE_LINE_LAYER, "visibility", visible ? "visible" : "none");
}

export function updateCacheGridData() {
  const map = hooks.getMap();
  if (!app.cacheGridReady || !map.getSource("cache-grid")) {
    return;
  }
  map.getSource("cache-grid").setData({
    type: "FeatureCollection",
    features: buildCacheGridFeatures(),
  });
}

export function clearCacheGridLayers() {
  const map = hooks.getMap();
  if (!map || !app.cacheGridReady) {
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
  app.cacheGridReady = false;
}

export function refreshCacheSelectOverlays() {
  if (!hooks.getCacheSelectMode()) {
    return;
  }
  ensureCacheGridLayers();
  updateCacheGridData();
  ensureRestAirspaceLayers();
  refreshRestAirspaceLayerData({ allCells: true });
  setRestAirspaceFillVisible(true);
  setRestAirspaceLineVisible(true);
  ensureCachedAirportMapLayers();
  refreshCachedAirportMapLayer();
  raisePathLayer();
}

export function refreshCacheGridForViewport() {
  refreshCacheSelectOverlays();
}

export function setOverlaysHiddenForCacheSelect(hidden) {
  const map = hooks.getMap();
  if (!map) {
    return;
  }

  if (hidden) {
    app.overlayVisibilityBeforeCache = new Map();
    for (const layerId of CACHE_HIDDEN_LAYER_IDS) {
      if (!map.getLayer(layerId)) {
        continue;
      }
      app.overlayVisibilityBeforeCache.set(
        layerId,
        map.getLayoutProperty(layerId, "visibility") ?? "visible"
      );
      map.setLayoutProperty(layerId, "visibility", "none");
    }
    hooks.clearCellInspect();
    hooks.clearAllGlidePaths?.();
    hooks.infoEl?.classList.remove("visible");
    if (hooks.computeContextBarEl) {
      hooks.computeContextBarEl.hidden = true;
    }
    document.body.classList.remove("has-compute-context");
    return;
  }

  if (app.overlayVisibilityBeforeCache) {
    for (const [layerId, visibility] of app.overlayVisibilityBeforeCache) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", visibility);
      }
    }
    app.overlayVisibilityBeforeCache = null;
  }
  hooks.syncAirspaceUi();
}

export function setOverlaysHiddenForManualAirportSelect(hidden) {
  const map = hooks.getMap();
  if (!map) {
    return;
  }

  if (hidden) {
    app.overlayVisibilityBeforeManualAirport = new Map();
    for (const layerId of MANUAL_AIRPORT_SELECT_HIDDEN_LAYER_IDS) {
      if (!map.getLayer(layerId)) {
        continue;
      }
      app.overlayVisibilityBeforeManualAirport.set(
        layerId,
        map.getLayoutProperty(layerId, "visibility") ?? "visible"
      );
      map.setLayoutProperty(layerId, "visibility", "none");
    }
    hooks.clearCellInspect();
    hooks.clearAllGlidePaths?.();
    if (hooks.computeContextBarEl) {
      hooks.computeContextBarEl.hidden = true;
    }
    document.body.classList.remove("has-compute-context");
    syncAirportPickLayerVisibility();
    return;
  }

  if (app.overlayVisibilityBeforeManualAirport) {
    for (const [layerId, visibility] of app.overlayVisibilityBeforeManualAirport) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", visibility);
      }
    }
    app.overlayVisibilityBeforeManualAirport = null;
  }
  hooks.syncComputeContextBar?.();
  syncAirportPickLayerVisibility();
}
