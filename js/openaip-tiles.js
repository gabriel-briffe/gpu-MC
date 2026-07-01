import { pointInGeoJson } from "./airspace.js";
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
export const OPENAIP_AIRSPACE_LAYER = "openaip-airspaces-line";
export const OPENAIP_AIRSPACE_LAYERS = [OPENAIP_AIRSPACE_LAYER];

/** Cached / map airport dots (px) — size ramp delayed one zoom vs label appearance. */
export const OPENAIP_AIRPORT_CIRCLE_RADIUS = [
  "interpolate",
  ["linear"],
  ["zoom"],
  5,
  3,
  7,
  5,
  8,
  6.5,
  10,
  7.5,
  13,
  8.5,
  15,
  10,
];

/** Selected seed markers — slightly larger than cached airports. */
export const OPENAIP_SEED_CIRCLE_RADIUS = [
  "interpolate",
  ["linear"],
  ["zoom"],
  5,
  4,
  7,
  6,
  8,
  7.5,
  10,
  8.5,
  13,
  9.5,
  15,
  11,
];

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

  try {
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
  } catch (error) {
    console.warn("OpenAIP vector query skipped", error);
    return [];
  }
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

  addOpenAipAirspaceLineLayer(map, "openaip", OPENAIP_AIRSPACE_LAYER);

  return true;
}

/** @deprecated Use initOpenAipAirspaceTiles */
export function initOpenAipTiles(map, config) {
  return initOpenAipAirspaceTiles(map, config);
}

let removeOpenAipVectorTilesFrame = null;

export function removeOpenAipVectorTiles(map) {
  if (!map?.getSource("openaip")) {
    return;
  }

  for (const layerId of OPENAIP_AIRSPACE_LAYERS) {
    if (map.getLayer(layerId)) {
      try {
        map.setLayoutProperty(layerId, "visibility", "none");
      } catch {
        // Style may be mid-update while toggling debug mode.
      }
    }
  }

  if (removeOpenAipVectorTilesFrame !== null) {
    cancelAnimationFrame(removeOpenAipVectorTilesFrame);
  }

  removeOpenAipVectorTilesFrame = requestAnimationFrame(() => {
    removeOpenAipVectorTilesFrame = null;
    if (!map?.getSource("openaip")) {
      return;
    }
    for (const layerId of OPENAIP_AIRSPACE_LAYERS) {
      if (map.getLayer(layerId)) {
        try {
          map.removeLayer(layerId);
        } catch {
          // Ignore teardown races with in-flight vector tiles.
        }
      }
    }
    try {
      map.removeSource("openaip");
    } catch {
      // Ignore teardown races with in-flight vector tiles.
    }
  });
}

export function setOpenAipAirspaceVisible(map, visible) {
  const visibility = visible ? "visible" : "none";
  for (const layerId of OPENAIP_AIRSPACE_LAYERS) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
  }
}

function addOpenAipAirspaceLineLayer(map, sourceId, lineLayerId, { minzoom = 6, visible = false } = {}) {
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
