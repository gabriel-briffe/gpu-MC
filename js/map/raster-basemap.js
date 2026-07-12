const OSM_SOURCE_ID = "osm-raster";
const OSM_LAYER_ID = "osm-raster-layer";
const SATELLITE_SOURCE_ID = "satellite-raster";
const SATELLITE_LAYER_ID = "satellite-raster-layer";
const HILLSHADE_LAYER_ID = "hillshade";

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const SATELLITE_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

function insertBeforeHillshade(map, layer) {
  const beforeId = map.getLayer(HILLSHADE_LAYER_ID) ? HILLSHADE_LAYER_ID : undefined;
  map.addLayer(layer, beforeId);
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

export function ensureRasterBasemapLayers(map) {
  if (!map) {
    return;
  }
  ensureSatelliteBasemapLayer(map);
  ensureOsmBasemapLayer(map);
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
}
