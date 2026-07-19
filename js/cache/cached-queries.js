import {
  airspacesToGeoJsonFeatures,
  airspaceBBoxIntersectsBounds,
  dedupeAirspaces,
} from "../airspace.js";
import { dedupeAirports } from "../openaip-airports.js";
import { airportPropertiesWithId } from "../airports/airport-id.js";
import {
  getCachedAirports,
  getCachedAirspaces,
} from "./cell-store.js";
import {
  clipBoundsToDeclaredCells,
  declaredCellsInBbox,
} from "./cell-geometry.js";

export const MISSING_CACHED_AIRSPACE_MSG =
  "No cached airspace for this area — use Cache data or disable include prohibited airspace";

/** Cached airports (single shared list). */
export function mergeCachedAirports(_cellKeys = null) {
  return dedupeAirports(getCachedAirports());
}

/** True when at least one airport is stored. */
export function hasCachedAirports(_cellKeys = null) {
  return mergeCachedAirports().length > 0;
}

/** Cached overlay airspaces (single shared list). */
export function mergeCachedAirspaces(_cellKeys = null) {
  return dedupeAirspaces(getCachedAirspaces());
}

export function mergedCachedAirspacesToGeoJsonFeatures(_cellKeys = null) {
  return airspacesToGeoJsonFeatures(mergeCachedAirspaces());
}

export function cachedAirspacesToGeoJsonFeatures(west, south, east, north) {
  return airspacesToGeoJsonFeatures(
    mergeCachedAirspaces().filter((airspace) =>
      airspaceBBoxIntersectsBounds(airspace.bbox, west, south, east, north)
    )
  );
}

export function getCachedAirportsInBounds(west, south, east, north) {
  return mergeCachedAirports().filter(
    (airport) =>
      airport.lng >= west &&
      airport.lng <= east &&
      airport.lat >= south &&
      airport.lat <= north
  );
}

export function cachedAirportsToGeoJsonFeatures(west, south, east, north) {
  return getCachedAirportsInBounds(west, south, east, north).map((airport) => ({
    type: "Feature",
    properties: airportPropertiesWithId(airport.properties ?? {}, airport.lng, airport.lat),
    geometry: {
      type: "Point",
      coordinates: [airport.lng, airport.lat],
    },
  }));
}

export function mergedCachedAirportsToGeoJsonFeatures(_cellKeys = null) {
  return mergeCachedAirports().map((airport) => ({
    type: "Feature",
    properties: airportPropertiesWithId(airport.properties ?? {}, airport.lng, airport.lat),
    geometry: {
      type: "Point",
      coordinates: [airport.lng, airport.lat],
    },
  }));
}

/** Grid bounds for compute: clip to cached cells only when airspace capping needs cached OpenAIP. */
export function resolveComputeGridBounds(bounds, { requireCachedAirspace = false } = {}) {
  if (!requireCachedAirspace) {
    return bounds;
  }
  return clipBoundsToDeclaredCells(bounds);
}

export function getCachedOverlayAirspaces(west, south, east, north) {
  // Require the query area to overlap declared coverage cells.
  const cellKeys = declaredCellsInBbox(west, south, east, north);
  if (!cellKeys.length) {
    return [];
  }
  return mergeCachedAirspaces().filter((airspace) =>
    airspaceBBoxIntersectsBounds(airspace.bbox, west, south, east, north)
  );
}
