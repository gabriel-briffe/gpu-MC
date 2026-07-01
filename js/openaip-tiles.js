import { OVERLAY_AIRSPACE_TILE_TYPES, pointInGeoJson } from "./airspace.js";
import { openAipConfigured, openAipTileUrls } from "./openaip-client.js";
import { isIncludedOpenAipAirportType } from "./openaip-airport-types.js";

export { OPENAIP_AIRPORT_FILTER } from "./openaip-airport-types.js";

const AIRSPACE_TYPE_COLOR = [
  "match",
  ["get", "type"],
  "prohibited",
  "#9a0e0e",
  "restricted",
  "#c62828",
  "danger",
  "#e65100",
  "tfr",
  "#9a0e0e",
  "tsa",
  "#c62828",
  "tra",
  "#d84315",
  "ctr",
  "#1565c0",
  "tma",
  "#1565c0",
  "cta",
  "#1565c0",
  "tmz",
  "#1976d2",
  "fir",
  "#558b2f",
  "awy",
  "#616161",
  "#2e7d32",
];

export const OPENAIP_AIRPORT_MIN_ZOOM = 5;
export const OPENAIP_AIRPORT_LABEL_MIN_ZOOM = 7;
export const OPENAIP_AIRPORT_LAYERS = ["openaip-airports", "openaip-airport-labels"];
export const OPENAIP_AIRSPACE_FILL_LAYER = "openaip-airspaces-fill";
export const OPENAIP_AIRSPACE_LAYER = "openaip-airspaces-line";
export const OPENAIP_AIRSPACE_LAYERS = [OPENAIP_AIRSPACE_FILL_LAYER, OPENAIP_AIRSPACE_LAYER];

export function isIncludedAirportType(type) {
  return isIncludedOpenAipAirportType(type);
}

export function openAipAirportKey(properties, lng, lat) {
  const { source_id: sourceId, icao_code: icaoCode, name } = properties ?? {};
  return sourceId ?? icaoCode ?? `${name}@${lng.toFixed(5)},${lat.toFixed(5)}`;
}

export function airspaceFeatureKey(feature) {
  const props = feature.properties ?? {};
  return (
    props.source_id ??
    props.id ??
    props.icaoCode ??
    props.icao_code ??
    `${props.name ?? "?"}@${props.type ?? "?"}`
  );
}

/** All OpenAIP airspace vector features whose polygon contains lng/lat. */
export function queryOpenAipAirspacesAt(map, lng, lat) {
  if (!map.getSource("openaip")) {
    return [];
  }

  const features = map.querySourceFeatures("openaip", {
    sourceLayer: "airspaces",
  });

  const seen = new Set();
  const matches = [];

  for (const feature of features) {
    if (!pointInGeoJson(lng, lat, feature.geometry)) {
      continue;
    }
    const key = airspaceFeatureKey(feature);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    matches.push(feature);
  }

  return matches;
}

export function initOpenAipAirspaceTiles(map, config) {
  if (!openAipConfigured(config)) {
    return false;
  }

  if (map.getSource("openaip")) {
    return true;
  }

  const tiles = openAipTileUrls(config);
  if (!tiles.length) {
    return false;
  }

  map.addSource("openaip", {
    type: "vector",
    tiles,
    minzoom: 3,
    maxzoom: 14,
    attribution:
      '<a href="https://www.openaip.net" target="_blank" rel="noopener">OpenAIP</a>',
  });

  addOpenAipAirspaceLayers(map, "openaip", OPENAIP_AIRSPACE_FILL_LAYER, OPENAIP_AIRSPACE_LAYER);

  return true;
}

/** @deprecated Use initOpenAipAirspaceTiles */
export function initOpenAipTiles(map, config) {
  return initOpenAipAirspaceTiles(map, config);
}

export function removeOpenAipVectorTiles(map) {
  if (!map?.getSource("openaip")) {
    return;
  }
  for (const layerId of OPENAIP_AIRSPACE_LAYERS) {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
  }
  map.removeSource("openaip");
}

export function setOpenAipAirspaceVisible(map, visible) {
  const visibility = visible ? "visible" : "none";
  for (const layerId of OPENAIP_AIRSPACE_LAYERS) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
  }
}

function addOpenAipAirspaceLayers(map, sourceId, fillLayerId, lineLayerId, { minzoom = 6, visible = false } = {}) {
  map.addLayer({
    id: fillLayerId,
    type: "fill",
    source: sourceId,
    "source-layer": "airspaces",
    minzoom,
    layout: { visibility: visible ? "visible" : "none" },
    filter: ["in", ["get", "type"], ["literal", OVERLAY_AIRSPACE_TILE_TYPES]],
    paint: {
      "fill-color": "#c62828",
      "fill-opacity": 0.28,
    },
  });

  map.addLayer({
    id: lineLayerId,
    type: "line",
    source: sourceId,
    "source-layer": "airspaces",
    minzoom,
    layout: { visibility: visible ? "visible" : "none" },
    paint: {
      "line-color": AIRSPACE_TYPE_COLOR,
      "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 12, 2],
      "line-opacity": 0.85,
    },
  });
}
