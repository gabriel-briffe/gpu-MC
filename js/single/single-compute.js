import { kmBoxAroundLngLat } from "../geo.js";
import {
  MISSING_CACHED_AIRSPACE_MSG,
  resolveComputeGridBounds,
  isLngLatInCachedCell,
} from "../cache-area.js";
import { AUTO_COMPUTE_DEBOUNCE_MS, MISSING_TERRAIN_CACHE_MSG } from "../constants.js";
import { isSingleParamsMode } from "../params/panel.js";
import { getAutoWindowSizeKm } from "../auto/auto-compute.js";
import { MANUAL_AIRPORT_ID_PREFIX } from "../airports/airport-id.js";

let hooks;
let app;

export function initSingleCompute(h) {
  hooks = h;
  app = h.app;
  hooks.scheduleSingleAirportCompute = scheduleSingleAirportCompute;
  hooks.flushSingleAirportCompute = flushSingleAirportCompute;
  hooks.clearSingleComputeScheduling = clearSingleComputeScheduling;
  hooks.getSingleComputePending = () => app.singleComputePending;
  hooks.getSingleLastPick = () => app.singleLastPick;
}

export function clearSingleComputeScheduling() {
  clearTimeout(app.singleComputeDebounceTimer);
  app.singleComputeDebounceTimer = null;
  app.singleComputePending = null;
  hooks.updateParamsFooter?.();
}

export function scheduleSingleAirportCompute(pick, { debounce = false } = {}) {
  if (!isSingleParamsMode() || hooks.getCacheSelectMode?.() || !hooks.isGlideConesEnabled?.()) {
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
  if (pick?.id) {
    hooks.schedulePersistParamsState?.();
  }
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
  if (
    !pick ||
    !isSingleParamsMode() ||
    hooks.getCacheSelectMode?.() ||
    hooks.isComputing() ||
    !hooks.isGlideConesEnabled?.()
  ) {
    return;
  }
  app.singleComputePending = null;
  await runSingleAirportCompute(pick);
}

async function runSingleAirportCompute(pick) {
  const { id, lng, lat, label, source } = pick;
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

  const isManual =
    source === "manual" || String(id ?? "").startsWith(MANUAL_AIRPORT_ID_PREFIX);
  if (hooks.isDisableImportedAirportsEnabled?.() && !isManual) {
    hooks.setStatus("Imported airports disabled — select a manual airport");
    return false;
  }
  if (isManual && !isLngLatInCachedCell(lng, lat)) {
    hooks.showComputeStopBarMessage?.(MISSING_TERRAIN_CACHE_MSG);
    return false;
  }

  hooks.refreshCachedAirportMapLayer?.();
  if (requireCachedAirspace) {
    hooks.refreshRestAirspaceLayerData?.();
  }

  hooks.setComputeAirports([
    {
      id,
      lng,
      lat,
      label,
      source: source ?? "airport",
    },
  ]);

  const name = label ?? "airport";
  hooks.setStatus(`Computing ${name}…`);
  await hooks.runComputation([{ lng, lat }], { gridBounds });
  return true;
}
