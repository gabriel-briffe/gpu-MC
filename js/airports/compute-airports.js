import { formatAirportLabel, normalizeComputeAirport } from "../airport-label.js";
import { assetUrl } from "../asset-url.js";
import { formatAirportActionTip } from "../compute/format.js";
import { isAutoParamsMode, isSingleParamsMode } from "../params/panel.js";
import {
  airportIdFromComputeAirport,
  airportIdFromFeature,
} from "./airport-id.js";

const AIRPORT_PICK_LAYERS = ["airports-cached-hit", "airports-cached"];
/** Screen-space pad so hover tips match the visible airport dots. */
const AIRPORT_HOVER_HIT_PAD_PX = 16;

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
  hooks.peekAirportAtMapPoint = peekAirportAtMapPoint;
  hooks.toggleComputeAirportAt = toggleComputeAirportAt;
  hooks.isAirportPickMode = isAirportPickMode;
  hooks.airportActionTipHtml = airportActionTipHtml;
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

function queryAirportFeatureAtPoint(point) {
  const map = hooks.getMap();
  if (
    !map ||
    !point ||
    hooks.getManualAirportSelectMode?.() ||
    hooks.getCacheSelectMode?.()
  ) {
    return null;
  }

  const layers = AIRPORT_PICK_LAYERS.filter((layerId) => map.getLayer(layerId));
  if (!layers.length) {
    return null;
  }

  // Prefer a padded box + the visible circle layer: opacity-0 hit circles are
  // often omitted by queryRenderedFeatures.
  const pad = AIRPORT_HOVER_HIT_PAD_PX;
  const box = [
    [point.x - pad, point.y - pad],
    [point.x + pad, point.y + pad],
  ];
  const features = map.queryRenderedFeatures(box, { layers });
  if (!features.length) {
    return null;
  }

  const ranked = features
    .map((feature) => ({
      feature,
      distanceSq: featurePickDistanceSq(map, point, feature),
    }))
    .sort((a, b) => a.distanceSq - b.distanceSq);

  return ranked[0].feature;
}

/** Airport under the pointer for hover tips (works in none / combined / single). */
export function peekAirportAtMapPoint(point) {
  const feature = queryAirportFeatureAtPoint(point);
  if (!feature) {
    return null;
  }
  const pick = pickFromFeature(feature);
  return {
    ...pick,
    disabled: Boolean(feature.properties?.disabled),
  };
}

export function pickAirportAtMapPoint(point) {
  if (!isAirportPickMode()) {
    return null;
  }
  const feature = queryAirportFeatureAtPoint(point);
  return feature ? pickFromFeature(feature) : null;
}

function airportChromeMode() {
  if (!hooks.isGlideConesEnabled?.()) {
    return "none";
  }
  if (isSingleParamsMode()) {
    return "single";
  }
  if (isAutoParamsMode()) {
    return "auto";
  }
  return "none";
}

export function airportActionTipHtml(airport) {
  return formatAirportActionTip({
    mode: airportChromeMode(),
    disabled: Boolean(airport?.disabled),
    combinedIconUrl: assetUrl("icons/mode-auto.svg"),
    singleIconUrl: assetUrl("icons/mode-single.svg"),
  });
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
