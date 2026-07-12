import { airspacesToGeoJsonFeatures, dedupeAirspaces } from "../airspace.js";
import { dedupeAirports } from "../openaip-airports.js";
import { airportPropertiesWithId } from "../airports/airport-id.js";
import {
  getCachedCellKeys,
  getCellEntry,
} from "./cell-store.js";
import {
  cellKeysInBbox,
  clipBoundsToCachedCells,
  getFreshCachedCellKeysInBbox,
} from "./cell-geometry.js";

export const MISSING_CACHED_AIRSPACE_MSG =
  "No cached airspace for this area — use Cache data or disable include prohibited airspace";

function airportsFromCellKeys(cellKeys) {
  const all = [];
  for (const cellKey of cellKeys) {
    const entry = getCellEntry(cellKey);
    if (entry?.airports?.length) {
      all.push(...entry.airports);
    }
  }
  return all;
}

function airspacesFromCellKeys(cellKeys) {
  const all = [];
  for (const cellKey of cellKeys) {
    const entry = getCellEntry(cellKey);
    if (entry?.airspaces?.length) {
      all.push(...entry.airspaces);
    }
  }
  return all;
}

/** Merge cached per-cell airport lists for display (deduped at read time). */
export function mergeCachedAirports(cellKeys = null) {
  const keys = cellKeys ?? getCachedCellKeys();
  return dedupeAirports(airportsFromCellKeys(keys));
}

/** True when at least one airport is stored for the given cells (or any cached cell). */
export function hasCachedAirports(cellKeys = null) {
  return mergeCachedAirports(cellKeys).length > 0;
}

/** Merge cached per-cell REST airspace lists for display (deduped at read time). */
export function mergeCachedAirspaces(cellKeys = null) {
  const keys = cellKeys ?? getCachedCellKeys();
  return dedupeAirspaces(airspacesFromCellKeys(keys));
}

export function mergedCachedAirspacesToGeoJsonFeatures(cellKeys = null) {
  return airspacesToGeoJsonFeatures(mergeCachedAirspaces(cellKeys));
}

export function cachedAirspacesToGeoJsonFeatures(west, south, east, north) {
  const cellKeys = cellKeysInBbox(west, south, east, north);
  return airspacesToGeoJsonFeatures(
    mergeCachedAirspaces(cellKeys).filter(
      (airspace) =>
        airspace.bbox.maxLng >= west &&
        airspace.bbox.minLng <= east &&
        airspace.bbox.maxLat >= south &&
        airspace.bbox.minLat <= north
    )
  );
}

export function getCachedAirportsInBounds(west, south, east, north) {
  const cellKeys = cellKeysInBbox(west, south, east, north);
  return mergeCachedAirports(cellKeys).filter(
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

export function mergedCachedAirportsToGeoJsonFeatures(cellKeys = null) {
  return mergeCachedAirports(cellKeys).map((airport) => ({
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
  return clipBoundsToCachedCells(bounds);
}

export function getCachedOverlayAirspaces(west, south, east, north) {
  const cellKeys = getFreshCachedCellKeysInBbox(west, south, east, north);
  return mergeCachedAirspaces(cellKeys).filter(
    (airspace) =>
      airspace.bbox.maxLng >= west &&
      airspace.bbox.minLng <= east &&
      airspace.bbox.maxLat >= south &&
      airspace.bbox.minLat <= north
  );
}