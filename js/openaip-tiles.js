const TILE_URL =
  "https://api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.pbf";

import { pointInGeoJson } from "./airspace.js";

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

const EXCLUDED_AIRPORT_TYPES = [
  "heli_civil",
  "heli_mil",
  "af_water",
  "ad_closed",
  "light_aircraft",
  "ls_alti",
];

const AIRPORT_FILTER = [
  "!",
  ["in", ["get", "type"], ["literal", EXCLUDED_AIRPORT_TYPES]],
];

export const OPENAIP_AIRPORT_LAYERS = ["openaip-airports", "openaip-airport-labels"];
export const OPENAIP_AIRSPACE_LAYER = "openaip-airspaces-line";

export function isIncludedAirportType(type) {
  return type != null && !EXCLUDED_AIRPORT_TYPES.includes(type);
}

export function getViewportOpenAipAirports(map) {
  if (!map.getSource("openaip")) {
    return [];
  }

  const bounds = map.getBounds();
  const features = map.querySourceFeatures("openaip", {
    sourceLayer: "airports",
  });

  const seen = new Set();
  const airports = [];

  for (const feature of features) {
    const { type, source_id: sourceId, icao_code: icaoCode, name } = feature.properties ?? {};
    if (!isIncludedAirportType(type)) {
      continue;
    }

    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) {
      continue;
    }

    const [lng, lat] = coords;
    if (!bounds.contains([lng, lat])) {
      continue;
    }

    const key = sourceId ?? icaoCode ?? `${name}@${lng.toFixed(5)},${lat.toFixed(5)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    airports.push({ lng, lat, properties: feature.properties });
  }

  return airports;
}

export function pickOpenAipAirport(map, point) {
  if (!map.getLayer("openaip-airports")) {
    return null;
  }

  const features = map.queryRenderedFeatures(point, {
    layers: OPENAIP_AIRPORT_LAYERS,
  });

  return features[0] ?? null;
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

export function initOpenAipTiles(map, apiKey) {
  if (!apiKey) {
    return false;
  }

  if (map.getSource("openaip")) {
    return true;
  }

  const tiles = [`${TILE_URL}?apiKey=${encodeURIComponent(apiKey)}`];

  map.addSource("openaip", {
    type: "vector",
    tiles,
    minzoom: 3,
    maxzoom: 14,
    attribution:
      '<a href="https://www.openaip.net" target="_blank" rel="noopener">OpenAIP</a>',
  });

  map.addLayer({
    id: OPENAIP_AIRSPACE_LAYER,
    type: "line",
    source: "openaip",
    "source-layer": "airspaces",
    minzoom: 6,
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
    minzoom: 8,
    filter: AIRPORT_FILTER,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2, 14, 5],
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
    minzoom: 9,
    filter: AIRPORT_FILTER,
    layout: {
      "text-field": ["coalesce", ["get", "icao_code"], ["get", "icaoCode"], ["get", "name"]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 10,
      "text-offset": [0, -1.2],
      "text-anchor": "bottom",
      "text-max-width": 10,
    },
    paint: {
      "text-color": "#f5f7fa",
      "text-halo-color": "rgba(18, 22, 28, 0.92)",
      "text-halo-width": 2,
    },
  });

  return true;
}
