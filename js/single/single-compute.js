import { kmBoxAroundLngLat } from "../geo.js";
import {
  MISSING_CACHED_AIRSPACE_MSG,
  resolveComputeGridBounds,
} from "../cache-area.js";
import { AUTO_COMPUTE_DEBOUNCE_MS } from "../constants.js";
import { isSingleParamsMode } from "../params/panel.js";
import { getAutoWindowSizeKm } from "../auto/auto-compute.js";

let hooks;
let app;

export function initSingleCompute(h) {
  hooks = h;
  app = h.app;
  hooks.scheduleSingleAirportCompute = scheduleSingleAirportCompute;
  hooks.flushSingleAirportCompute = flushSingleAirportCompute;
  hooks.clearSingleComputeScheduling = clearSingleComputeScheduling;
  hooks.getSingleComputePending = getSingleComputePending;
  hooks.getSingleLastPick = () => app.singleLastPick;
}

export function clearSingleComputeScheduling() {
  clearTimeout(app.singleComputeDebounceTimer);
  app.singleComputeDebounceTimer = null;
  app.singleComputePending = null;
  app.singleLastPick = null;
  hooks.schedulePersistParamsState?.();
  hooks.updateParamsFooter?.();
}

export function getSingleComputePending() {
  return app.singleComputePending;
}

export function scheduleSingleAirportCompute(pick, { debounce = false } = {}) {
  if (!isSingleParamsMode() || hooks.getCacheSelectMode?.()) {
    return;
  }
  if (pick?.id) {
    app.singleLastPick = pick;
    hooks.updateParamsFooter?.();
  }
  const target = pick?.id ? pick : app.singleLastPick;
  if (!target?.id) {
    return;
  }

  app.singleComputePending = target;
  hooks.schedulePersistParamsState?.();
  if (hooks.isComputing()) {
    hooks.setComputeShouldStop(true);
    return;
  }

  clearTimeout(app.singleComputeDebounceTimer);
  if (debounce) {
    app.singleComputeDebounceTimer = window.setTimeout(() => {
      app.singleComputeDebounceTimer = null;
      void flushSingleAirportCompute();
    }, AUTO_COMPUTE_DEBOUNCE_MS);
    return;
  }
  void flushSingleAirportCompute();
}

export async function flushSingleAirportCompute() {
  const pick = app.singleComputePending;
  if (!pick || !isSingleParamsMode() || hooks.getCacheSelectMode?.() || hooks.isComputing()) {
    return;
  }
  app.singleComputePending = null;
  await runSingleAirportCompute(pick);
}

async function runSingleAirportCompute({ id, lng, lat, label }) {
  if (!hooks.areOpenAipAirportsAvailable()) {
    hooks.setStatus("Single mode needs OpenAIP — check configuration");
    return false;
  }

  const windowSizeKm = getAutoWindowSizeKm();
  const requestedBounds = kmBoxAroundLngLat(lng, lat, windowSizeKm);
  const requireCachedAirspace = hooks.isIncludeAirspaceEnabled?.() ?? false;
  const gridBounds = resolveComputeGridBounds(requestedBounds, { requireCachedAirspace });
  if (!gridBounds) {
    hooks.setStatus(MISSING_CACHED_AIRSPACE_MSG);
    return false;
  }

  hooks.refreshCachedAirportMapLayer?.();
  if (requireCachedAirspace) {
    hooks.refreshRestAirspaceLayerData?.();
  }

  hooks.setPendingSeedsFromAirports([
    {
      id,
      lng,
      lat,
      label,
      source: "airport",
    },
  ]);

  const name = label ?? "airport";
  hooks.setStatus(`Computing ${name}…`);
  await hooks.runComputation([{ lng, lat }], { gridBounds });
  return true;
}
