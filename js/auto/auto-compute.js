import { kmBoxAroundLngLat, isInsideKmBoxInnerZone } from "../geo.js";
import {
  MIN_SEEDS,
  AUTO_WINDOW_SIZE_DEFAULT_KM,
  AUTO_WINDOW_GLIDE_FACTOR,
  AUTO_MAX_OFFSET_FROM_CENTER,
  AUTO_COMPUTE_DEBOUNCE_MS,
} from "../constants.js";
import {
  getCachedAirportsInBounds,
  MISSING_CACHED_AIRSPACE_MSG,
  resolveComputeGridBounds,
} from "../cache-area.js";
import { getManualAirportsInBounds } from "../airports/manual-airports.js";
import { airportIdFromStoredAirport } from "../airports/airport-id.js";
import { formatAirportLabel } from "../airport-label.js";
import { isAutoParamsMode } from "../params/panel.js";

let hooks;
let app;

export function initAutoCompute(h) {
  hooks = h;
  app = h.app;
  hooks.scheduleAutoCompute = scheduleAutoCompute;
  hooks.flushAutoCompute = flushAutoCompute;
  hooks.cancelPendingAutoCompute = cancelPendingAutoCompute;
  hooks.onAutoModeMapMoveEnd = onAutoModeMapMoveEnd;
  hooks.syncAutoWindowSizeUi = syncAutoWindowSizeUi;
  hooks.getAutoComputePending = () => app.autoComputePending;
  hooks.clearAutoComputeScheduling = clearAutoComputeScheduling;
}

export function clearAutoComputeScheduling() {
  clearTimeout(app.autoComputeDebounceTimer);
  app.autoComputeDebounceTimer = null;
  app.autoComputePending = false;
  app.autoComputeNeedsAirportRefresh = false;
  app.autoComputeRegion = null;
}

function computeAutoWindowSizeFromGlideKm() {
  const glideRatio = Number.parseFloat(document.getElementById("ld")?.value ?? "");
  const maxAltitude = Number.parseFloat(document.getElementById("max-alt")?.value ?? "");
  if (
    !Number.isFinite(glideRatio) ||
    glideRatio <= 0 ||
    !Number.isFinite(maxAltitude) ||
    maxAltitude <= 0
  ) {
    return AUTO_WINDOW_SIZE_DEFAULT_KM;
  }
  return (AUTO_WINDOW_GLIDE_FACTOR * maxAltitude * glideRatio) / 1000;
}

function isAutoWindowFromGlideEnabled() {
  return hooks.autoWindowFromGlideInput?.checked ?? false;
}

export function getAutoWindowSizeKm() {
  if (isAutoWindowFromGlideEnabled()) {
    return computeAutoWindowSizeFromGlideKm();
  }
  const value = Number.parseFloat(hooks.autoWindowSizeInput?.value ?? "");
  return Number.isFinite(value) && value > 0 ? value : AUTO_WINDOW_SIZE_DEFAULT_KM;
}

export function syncAutoWindowSizeUi() {
  const fromGlide = isAutoWindowFromGlideEnabled();
  if (hooks.autoWindowSizeFieldEl) {
    hooks.autoWindowSizeFieldEl.hidden = fromGlide;
    hooks.autoWindowSizeFieldEl.classList.toggle("auto-window-size-hidden", fromGlide);
  }
  if (hooks.autoWindowGlideHintEl) {
    if (fromGlide) {
      const km = computeAutoWindowSizeFromGlideKm();
      hooks.autoWindowGlideHintEl.textContent = `${Math.round(km)} km half-width — ${Math.round(km * 2)} km total span`;
      hooks.autoWindowGlideHintEl.hidden = false;
    } else {
      hooks.autoWindowGlideHintEl.hidden = true;
      hooks.autoWindowGlideHintEl.textContent = "";
    }
  }
}

function collectAirportsInWindow(bounds) {
  if (hooks.isDisableImportedAirportsEnabled?.()) {
    if (!hooks.isIncludeManualAirportsEnabled?.()) {
      return [];
    }
    return getManualAirportsInBounds(
      bounds.west,
      bounds.south,
      bounds.east,
      bounds.north
    );
  }

  const airports = getCachedAirportsInBounds(
    bounds.west,
    bounds.south,
    bounds.east,
    bounds.north
  );
  if (!hooks.isIncludeManualAirportsEnabled?.()) {
    return airports;
  }
  const byId = new Map(airports.map((airport) => [airportIdFromStoredAirport(airport), airport]));
  for (const manual of getManualAirportsInBounds(
    bounds.west,
    bounds.south,
    bounds.east,
    bounds.north
  )) {
    const id = airportIdFromStoredAirport(manual);
    if (!byId.has(id)) {
      byId.set(id, manual);
    }
  }
  return [...byId.values()];
}

async function runAutoComputation({ refreshAirports = false } = {}) {
  if (!isAutoParamsMode() || hooks.getCacheSelectMode() || !hooks.areOpenAipAirportsAvailable()) {
    if (isAutoParamsMode()) {
      hooks.setStatus("Auto mode needs OpenAIP — check configuration");
    }
    return;
  }
  const map = hooks.getMap();
  if (!map) {
    return;
  }

  const windowSizeKm = getAutoWindowSizeKm();
  const center = map.getCenter();
  const requestedBounds = kmBoxAroundLngLat(center.lng, center.lat, windowSizeKm);
  app.autoComputeRegion = { ...requestedBounds, windowSizeKm };

  const requireCachedAirspace = hooks.isIncludeAirspaceEnabled?.() ?? false;
  const gridBounds = resolveComputeGridBounds(requestedBounds, { requireCachedAirspace });
  if (!gridBounds) {
    hooks.clearComputeResults?.();
    hooks.setStatus(MISSING_CACHED_AIRSPACE_MSG);
    return;
  }

  if (refreshAirports) {
    hooks.refreshCachedAirportMapLayer?.();
    if (requireCachedAirspace) {
      hooks.refreshRestAirspaceLayerData?.();
    }
  }

  hooks.setStatus(`Finding airports in ${windowSizeKm * 2} km window…`);
  const airportsInWindow = collectAirportsInWindow(gridBounds);
  const enabledAirports = hooks.filterDisabledAirports(airportsInWindow);

  hooks.setComputeAirports(
    enabledAirports.map((airport) => ({
      ...airport,
      label: airport.label || formatAirportLabel(airport),
      source: airport.properties?.source === "manual" ? "manual" : "airport",
    }))
  );

  if (airportsInWindow.length === 0) {
    hooks.clearComputeResults?.();
    hooks.setStatus(
      `Auto: no airports in ${windowSizeKm * 2} km window — pan map or cache cells first`
    );
    return;
  }

  if (enabledAirports.length < MIN_SEEDS) {
    hooks.clearComputeResults?.();
    const disabledCount = airportsInWindow.length - enabledAirports.length;
    if (disabledCount > 0) {
      hooks.setStatus(
        `Auto: all airports in window disabled — click one on the map to enable`
      );
    } else {
      hooks.setStatus(
        `Auto: no airports in ${windowSizeKm * 2} km window — pan map or cache cells first`
      );
    }
    return;
  }

  const disabledCount = airportsInWindow.length - enabledAirports.length;
  const disabledSuffix =
    disabledCount > 0
      ? ` (${disabledCount} disabled)`
      : "";
  hooks.setStatus(
    `Computing ${enabledAirports.length} airport${enabledAirports.length === 1 ? "" : "s"}${disabledSuffix}…`
  );
  const seedsForCompute = enabledAirports.map((airport) => ({
    lng: airport.lng,
    lat: airport.lat,
  }));
  await hooks.runComputation(seedsForCompute, { gridBounds });
}

export function cancelPendingAutoCompute() {
  clearTimeout(app.autoComputeDebounceTimer);
  app.autoComputeDebounceTimer = null;
  app.autoComputePending = false;
  app.autoComputeNeedsAirportRefresh = false;
}

export function scheduleAutoCompute({ debounce = false, refreshAirports = false } = {}) {
  if (!isAutoParamsMode() || hooks.getCacheSelectMode() || !hooks.isGlideConesEnabled?.()) {
    return;
  }
  app.autoComputePending = true;
  if (refreshAirports) {
    app.autoComputeNeedsAirportRefresh = true;
  }
  if (hooks.isComputing()) {
    hooks.setComputeShouldStop(true);
    return;
  }
  clearTimeout(app.autoComputeDebounceTimer);
  if (debounce) {
    app.autoComputeDebounceTimer = window.setTimeout(() => {
      app.autoComputeDebounceTimer = null;
      void flushAutoCompute();
    }, AUTO_COMPUTE_DEBOUNCE_MS);
    return;
  }
  void flushAutoCompute();
}

export async function flushAutoCompute() {
  if (
    !app.autoComputePending ||
    !isAutoParamsMode() ||
    hooks.getCacheSelectMode() ||
    hooks.isComputing() ||
    !hooks.isGlideConesEnabled?.()
  ) {
    return;
  }
  if (!hooks.getMap()) {
    return;
  }
  app.autoComputePending = false;
  const refreshAirports = app.autoComputeNeedsAirportRefresh;
  app.autoComputeNeedsAirportRefresh = false;
  await runAutoComputation({ refreshAirports });
}

export function onAutoModeMapMoveEnd() {
  if (
    !isAutoParamsMode() ||
    hooks.getCacheSelectMode() ||
    !app.autoComputeRegion ||
    hooks.isComputing() ||
    !hooks.isGlideConesEnabled?.()
  ) {
    return;
  }
  const map = hooks.getMap();
  const center = map.getCenter();
  if (
    isInsideKmBoxInnerZone(
      center.lng,
      center.lat,
      app.autoComputeRegion,
      AUTO_MAX_OFFSET_FROM_CENTER
    )
  ) {
    return;
  }
  scheduleAutoCompute({ debounce: true, refreshAirports: true });
}
