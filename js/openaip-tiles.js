import { OVERLAY_AIRSPACE_TILE_TYPES, pointInGeoJson } from "./airspace.js";
import { openAipConfigured, openAipTileUrls } from "./openaip-client.js";
import {
  OPENAIP_EXCLUDED_AIRPORT_TYPE_CODES,
  OPENAIP_EXCLUDED_AIRPORT_TYPE_TILE_SLUGS,
  isIncludedOpenAipAirportType,
} from "./openaip-airport-types.js";

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

export const OPENAIP_AIRPORT_FILTER = [
  "all",
  ["!", ["in", ["get", "type"], ["literal", OPENAIP_EXCLUDED_AIRPORT_TYPE_TILE_SLUGS]]],
  ["!", ["in", ["get", "type"], ["literal", OPENAIP_EXCLUDED_AIRPORT_TYPE_CODES]]],
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

export function getOpenAipAirportsInBounds(map, west, south, east, north) {
  if (!map.getSource("openaip")) {
    return [];
  }

  const features = map.querySourceFeatures("openaip", {
    sourceLayer: "airports",
  });

  const seen = new Set();
  const airports = [];

  for (const feature of features) {
    const { type } = feature.properties ?? {};
    if (!isIncludedAirportType(type)) {
      continue;
    }

    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) {
      continue;
    }

    const [lng, lat] = coords;
    if (lng < west || lng > east || lat < south || lat > north) {
      continue;
    }

    const key = openAipAirportKey(feature.properties, lng, lat);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    airports.push({ lng, lat, properties: feature.properties });
  }

  return airports;
}

export function getViewportOpenAipAirports(map) {
  const bounds = map.getBounds();
  return getOpenAipAirportsInBounds(
    map,
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth()
  );
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

export function initOpenAipTiles(map, config) {
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

  map.addLayer({
    id: OPENAIP_AIRSPACE_FILL_LAYER,
    type: "fill",
    source: "openaip",
    "source-layer": "airspaces",
    minzoom: 6,
    layout: { visibility: "none" },
    filter: ["in", ["get", "type"], ["literal", OVERLAY_AIRSPACE_TILE_TYPES]],
    paint: {
      "fill-color": "#c62828",
      "fill-opacity": 0.28,
    },
  });

  map.addLayer({
    id: OPENAIP_AIRSPACE_LAYER,
    type: "line",
    source: "openaip",
    "source-layer": "airspaces",
    minzoom: 6,
    layout: { visibility: "none" },
    paint: {
      "line-color": AIRSPACE_TYPE_COLOR,
      "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 12, 2],
      "line-opacity": 0.85,
    },
  });

  map.addLayer({
    id: "openaip-airports",
    type: "circle",
    source: "openaip",
    "source-layer": "airports",
    minzoom: OPENAIP_AIRPORT_MIN_ZOOM,
    filter: OPENAIP_AIRPORT_FILTER,
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
    id: "openaip-airport-labels",
    type: "symbol",
    source: "openaip",
    "source-layer": "airports",
    minzoom: OPENAIP_AIRPORT_LABEL_MIN_ZOOM,
    filter: OPENAIP_AIRPORT_FILTER,
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

  return true;
}

export function setOpenAipAirspaceVisible(map, visible) {
  const visibility = visible ? "visible" : "none";
  for (const layerId of OPENAIP_AIRSPACE_LAYERS) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
  }
}
