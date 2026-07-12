import { formatAirportLabel } from "../airport-label.js";
import { isAutoParamsMode, isSingleParamsMode } from "../params/panel.js";
import {
  airportIdFromFeature,
  airportIdFromManualPlacement,
  airportIdFromSeed,
  seedFromOpenAipAirport,
} from "./airport-id.js";

const AIRPORT_PICK_LAYERS = ["airports-cached-hit"];

let hooks;
let app;

export function initSeeds(h) {
  hooks = h;
  app = h.app;
  hooks.getPendingSeeds = getPendingSeeds;
  hooks.updateSeedMarkers = updateSeedMarkers;
  hooks.setPendingSeedsFromAirports = setPendingSeedsFromAirports;
  hooks.clearPendingSeedsSelection = clearPendingSeedsSelection;
  hooks.airportIdFromSeed = airportIdFromSeed;
  hooks.pickAirportAtMapPoint = pickAirportAtMapPoint;
  hooks.togglePendingSeedAt = togglePendingSeedAt;
  hooks.isAirportPickMode = isAirportPickMode;
}

export function getPendingSeeds() {
  return app.pendingSeeds;
}

export function isAirportPickMode() {
  if (
    hooks.getManualAirportSelectMode?.() ||
    hooks.getCacheSelectMode?.()
  ) {
    return false;
  }
  if (isAutoParamsMode() || isSingleParamsMode()) {
    return hooks.areOpenAipAirportsAvailable?.() ?? false;
  }
  return false;
}

function pickFromFeature(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const props = feature.properties ?? {};
  const id = airportIdFromFeature(feature);
  const label =
    props.name ??
    props.label ??
    formatAirportLabel({
      lng,
      lat,
      properties: props,
    });
  return {
    id,
    lng,
    lat,
    label,
    source: props.source === "manual" ? "manual" : "airport",
  };
}

function featurePickDistanceSq(map, point, feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const projected = map.project([lng, lat]);
  const dx = projected.x - point.x;
  const dy = projected.y - point.y;
  return dx * dx + dy * dy;
}

export function pickAirportAtMapPoint(point) {
  const map = hooks.getMap();
  if (!map || !isAirportPickMode()) {
    return null;
  }

  const layers = AIRPORT_PICK_LAYERS.filter((layerId) => map.getLayer(layerId));
  if (!layers.length) {
    return null;
  }

  const features = map.queryRenderedFeatures(point, { layers });
  if (!features.length) {
    return null;
  }

  const ranked = features
    .map((feature) => ({
      feature,
      distanceSq: featurePickDistanceSq(map, point, feature),
    }))
    .sort((a, b) => a.distanceSq - b.distanceSq);

  return pickFromFeature(ranked[0].feature);
}

export function togglePendingSeedAt(pick) {
  if (!isAirportPickMode() || !pick?.id) {
    return false;
  }

  if (isAutoParamsMode()) {
    return hooks.toggleDisabledAirportAt?.(pick) ?? false;
  }

  if (isSingleParamsMode()) {
    hooks.scheduleSingleAirportCompute?.(pick);
    return true;
  }

  return false;
}

export function setPendingSeedsFromAirports(airports) {
  app.pendingSeeds = airports.map((airport) => {
    if (airport.id) {
      return {
        id: airport.id,
        lng: airport.lng,
        lat: airport.lat,
        label: airport.label,
        source: airport.source ?? airport.properties?.source ?? "airport",
      };
    }
    if (airport.properties) {
      return seedFromOpenAipAirport(airport, {
        label: airport.label ?? formatAirportLabel(airport),
        source: airport.properties.source === "manual" ? "manual" : "airport",
      });
    }
    return {
      id: airportIdFromManualPlacement(airport.lng, airport.lat),
      lng: airport.lng,
      lat: airport.lat,
      label: airport.label,
      source: airport.source ?? "airport",
    };
  });
  updateSeedMarkers();
}

export function updateSeedMarkers() {
  hooks.schedulePersistParamsState?.();
}

export function clearPendingSeedsSelection() {
  app.pendingSeeds = [];
  updateSeedMarkers();
}
