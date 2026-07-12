import {
  GRADIENT_RASTER_OPACITY,
} from "../constants.js";
import {
  TERRAIN_GRADIENT_TILE_URL_TEMPLATE,
  getTerrainGradientMaxZoom,
} from "./terrain-gradient.js";
import { getMapBottomOverlayAnchor } from "./layers.js";

const OSM_SOURCE_ID = "osm-raster";
const OSM_LAYER_ID = "osm-raster-layer";
const SATELLITE_SOURCE_ID = "satellite-raster";
const SATELLITE_LAYER_ID = "satellite-raster-layer";
const GRADIENT_SOURCE_ID = "terrain-gradient-raster";
const GRADIENT_LAYER_ID = "terrain-gradient-raster-layer";
const HILLSHADE_LAYER_ID = "hillshade";

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const SATELLITE_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

function insertBeforeHillshade(map, layer) {
  const beforeId = map.getLayer(HILLSHADE_LAYER_ID) ? HILLSHADE_LAYER_ID : undefined;
  map.addLayer(layer, beforeId);
}

function moveBasemapLayers(map, layerIds, beforeId) {
  if (!beforeId) {
    return;
  }
  for (const layerId of layerIds) {
    if (!map.getLayer(layerId)) {
      continue;
    }
    map.moveLayer(layerId, beforeId);
  }
}

function syncBasemapLayerStack(map, mode) {
  const anchor = getMapBottomOverlayAnchor(map);

  if (mode === "gradient") {
    moveBasemapLayers(map, [HILLSHADE_LAYER_ID, GRADIENT_LAYER_ID], anchor);
    return;
  }

  const baseLayerId =
    mode === "osm" ? OSM_LAYER_ID : mode === "satellite" ? SATELLITE_LAYER_ID : null;
  const stack = baseLayerId ? [baseLayerId, HILLSHADE_LAYER_ID] : [HILLSHADE_LAYER_ID];
  moveBasemapLayers(map, stack, anchor);
}

function ensureOsmBasemapLayer(map) {
  if (!map || map.getSource(OSM_SOURCE_ID)) {
    return;
  }

  map.addSource(OSM_SOURCE_ID, {
    type: "raster",
    tiles: [OSM_TILE_URL],
    tileSize: 256,
    maxzoom: 19,
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });

  insertBeforeHillshade(map, {
    id: OSM_LAYER_ID,
    type: "raster",
    source: OSM_SOURCE_ID,
    layout: { visibility: "none" },
    paint: { "raster-opacity": 1 },
  });
}

function ensureSatelliteBasemapLayer(map) {
  if (!map || map.getSource(SATELLITE_SOURCE_ID)) {
    return;
  }

  map.addSource(SATELLITE_SOURCE_ID, {
    type: "raster",
    tiles: [SATELLITE_TILE_URL],
    tileSize: 256,
    maxzoom: 19,
    attribution:
      'Tiles © <a href="https://www.esri.com/">Esri</a> — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  });

  insertBeforeHillshade(map, {
    id: SATELLITE_LAYER_ID,
    type: "raster",
    source: SATELLITE_SOURCE_ID,
    layout: { visibility: "none" },
    paint: { "raster-opacity": 1 },
  });
}

function ensureGradientBasemapLayer(map) {
  if (!map || map.getSource(GRADIENT_SOURCE_ID)) {
    return;
  }

  map.addSource(GRADIENT_SOURCE_ID, {
    type: "raster",
    tiles: [TERRAIN_GRADIENT_TILE_URL_TEMPLATE],
    tileSize: 512,
    maxzoom: getTerrainGradientMaxZoom(),
    attribution: '<a href="https://mapterhorn.com" target="_blank" rel="noopener">Mapterhorn</a>',
  });

  insertBeforeHillshade(map, {
    id: GRADIENT_LAYER_ID,
    type: "raster",
    source: GRADIENT_SOURCE_ID,
    layout: { visibility: "none" },
    paint: { "raster-opacity": GRADIENT_RASTER_OPACITY },
  });
}

export function ensureRasterBasemapLayers(map) {
  if (!map) {
    return;
  }
  ensureGradientBasemapLayer(map);
  ensureSatelliteBasemapLayer(map);
  ensureOsmBasemapLayer(map);
}

export function reloadGradientBasemap(map) {
  map?.style?.sourceCaches?.[GRADIENT_SOURCE_ID]?.reload?.();
}

export function setBaseMapRasterMode(map, mode) {
  if (!map) {
    return;
  }
  ensureRasterBasemapLayers(map);

  if (map.getLayer(OSM_LAYER_ID)) {
    map.setLayoutProperty(OSM_LAYER_ID, "visibility", mode === "osm" ? "visible" : "none");
  }
  if (map.getLayer(SATELLITE_LAYER_ID)) {
    map.setLayoutProperty(
      SATELLITE_LAYER_ID,
      "visibility",
      mode === "satellite" ? "visible" : "none"
    );
  }
  if (map.getLayer(GRADIENT_LAYER_ID)) {
    map.setLayoutProperty(
      GRADIENT_LAYER_ID,
      "visibility",
      mode === "gradient" ? "visible" : "none"
    );
    map.setPaintProperty(
      GRADIENT_LAYER_ID,
      "raster-opacity",
      mode === "gradient" ? GRADIENT_RASTER_OPACITY : 1
    );
  }
  if (map.getLayer(HILLSHADE_LAYER_ID)) {
    map.setLayoutProperty(HILLSHADE_LAYER_ID, "visibility", "visible");
  }

  syncBasemapLayerStack(map, mode);
}
