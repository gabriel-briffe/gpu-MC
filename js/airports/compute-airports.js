import { formatAirportLabel, normalizeComputeAirport } from "../airport-label.js";
import { isAutoParamsMode, isSingleParamsMode } from "../params/panel.js";
import {
  airportIdFromComputeAirport,
  airportIdFromFeature,
} from "./airport-id.js";

const AIRPORT_PICK_LAYERS = ["airports-cached-hit"];

let hooks;
let app;

export function initComputeAirports(h) {
  hooks = h;
  app = h.app;
  hooks.getComputeAirports = getComputeAirports;
  hooks.setComputeAirports = setComputeAirports;
  hooks.clearComputeAirports = clearComputeAirports;
  hooks.airportIdFromComputeAirport = airportIdFromComputeAirport;
  hooks.pickAirportAtMapPoint = pickAirportAtMapPoint;
  hooks.toggleComputeAirportAt = toggleComputeAirportAt;
  hooks.isAirportPickMode = isAirportPickMode;
}

function getComputeAirports() {
  return app.computeAirports;
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
  return normalizeComputeAirport({
    id,
    lng,
    lat,
    label,
    icao: props.icao_code ?? props.icaoCode ?? null,
    name: props.name ?? null,
    properties: props,
    source: props.source === "manual" ? "manual" : "airport",
  });
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

export function toggleComputeAirportAt(pick) {
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

function setComputeAirports(airports) {
  app.computeAirports = airports.map((airport) => normalizeComputeAirport(airport));
  hooks.schedulePersistParamsState?.();
}

function clearComputeAirports() {
  app.computeAirports = [];
  hooks.schedulePersistParamsState?.();
}
