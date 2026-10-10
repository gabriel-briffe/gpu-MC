import { buildDemGrid } from "../dem.js";
import { MIN_SEEDS, COMPUTE_DONE_STATUS_CLEAR_MS, MISSING_TERRAIN_CACHE_MSG, isMissingCachedCoverageError } from "../constants.js";
import { formatComputeDone } from "./format.js";
import { getGlideParams } from "./params.js";
import { updateConeVisualization, updateOverlay } from "./visualization.js";
import { logOriginPathValidation } from "../debug/origin-path-validate.js";
import { computeUpwardConeCpu } from "../upward-cone-mask.js";
import { dom } from "../dom.js";

let hooks;

export function initComputeSession(h) {
  hooks = h;
  hooks.syncConeEngineButton = syncConeEngineButton;
  hooks.coneUseCpu = coneUseCpu;

  dom.coneEngineBtn?.addEventListener("click", () => {
    setConeUseCpu(!coneUseCpu());
  });
  dom.coneCpuInput?.addEventListener("change", () => {
    syncConeEngineButton();
    hooks.schedulePersistParamsState?.();
    recomputeConeAfterEngineChange();
  });
  syncConeEngineButton();
}

export function coneUseCpu() {
  return dom.coneCpuInput?.checked === true;
}

function syncConeEngineButton() {
  const button = dom.coneEngineBtn;
  if (!button) {
    return;
  }
  const hide = Boolean(hooks?.app?.cacheSelectMode);
  button.hidden = hide;
  if (hide) {
    return;
  }
  const cpu = coneUseCpu();
  button.innerHTML =
    `<span class="engine-btn-kind">cone</span>` +
    `<span class="engine-btn-eng">${cpu ? "CPU" : "GPU"}</span>`;
  button.setAttribute("aria-pressed", cpu ? "true" : "false");
  button.setAttribute(
    "aria-label",
    cpu ? "Cone engine: CPU (tap for GPU)" : "Cone engine: GPU (tap for CPU)"
  );
}

function setConeUseCpu(cpu) {
  if (dom.coneCpuInput) {
    dom.coneCpuInput.checked = Boolean(cpu);
  }
  syncConeEngineButton();
  hooks.schedulePersistParamsState?.();
  recomputeConeAfterEngineChange();
}

function recomputeConeAfterEngineChange() {
  if (!hooks?.isGlideConesEnabled?.()) {
    return;
  }
  // Prefer schedule* so pending is set; if a run is in flight it requests stop
  // and endComputeSession flushes the pending recompute with the new engine.
  if (hooks.isAutoParamsMode?.()) {
    hooks.scheduleAutoCompute?.({ debounce: false });
    return;
  }
  if (hooks.isSingleParamsMode?.()) {
    hooks.scheduleSingleAirportCompute?.(undefined, { debounce: false });
    return;
  }
  if (hooks.isComputing?.()) {
    hooks.setComputeShouldStop?.(true);
    return;
  }
  void runComputation();
}

export function startComputeSession() {
  hooks.setComputeShouldStop(false);
  hooks.setComputing(true);
  hooks.clearComputeStopBarMessage?.();
  hooks.stopComputeBtn.hidden = false;
  hooks.stopComputeBtn.disabled = false;
  hooks.syncComputeStopBar?.();
  if (hooks.getManualAirportSelectMode()) {
    hooks.exitManualAirportSelectMode(false);
  }
}

export function endComputeSession() {
  hooks.setComputing(false);
  hooks.setComputeShouldStop(false);
  hooks.stopComputeBtn.hidden = true;
  hooks.stopComputeBtn.disabled = false;
  hooks.syncComputeStopBar?.();
  hooks.schedulePersistParamsState?.();
  if (hooks.isAutoParamsMode() && hooks.getAutoComputePending()) {
    void hooks.flushAutoCompute();
  } else if (hooks.isSingleParamsMode?.() && hooks.getSingleComputePending?.()) {
    void hooks.flushSingleAirportCompute();
  } else {
    hooks.resumeIgcAfterConeRecompute?.();
  }
}

export function requestStopCompute() {
  hooks.setComputeShouldStop(true);
  hooks.stopComputeBtn.disabled = true;
  hooks.setStatus(
    coneUseCpu() ? "Stopping after current CPU step…" : "Stopping after current GPU step…"
  );
}

function makeComputeOptions(dem, glideParams) {
  return {
    onProgress: makeComputeProgressHandler(dem, glideParams),
    shouldStop: () => hooks.getComputeShouldStop(),
    maxIterations: hooks.getMaxComputeIterations?.() ?? null,
  };
}

function makeComputeProgressHandler(dem, glideParams) {
  const engineLabel = coneUseCpu() ? "CPU" : "GPU";
  return ({ imageData, iteration, elapsedMs }) => {
    if (
      !glideParams.pathOnly &&
      (glideParams.raw || glideParams.sectors || !glideParams.contours) &&
      imageData
    ) {
      updateOverlay(imageData, dem);
    }
    hooks.setStatus(`Computing… iter ${iteration}, ${elapsedMs.toFixed(0)} ms ${engineLabel}`);
  };
}

export async function runComputation(seedsOverride = null, { gridBounds = null } = {}) {
  const useCpu = coneUseCpu();
  if (
    hooks.isComputing() ||
    !hooks.isGlideConesEnabled?.() ||
    (!useCpu && hooks.isComputeHardwareSupported?.() === false)
  ) {
    return;
  }

  const computeAirports = hooks.getComputeAirports();
  const seeds =
    seedsOverride ?? computeAirports.map((airport) => ({ lng: airport.lng, lat: airport.lat }));

  if (seeds.length < MIN_SEEDS) {
    hooks.setStatus(`Place at least ${MIN_SEEDS} airport on the map before running`);
    return;
  }
  const glideParams = getGlideParams();
  hooks.clearCellInspect();
  hooks.clearGlidePath();
  hooks.setDownloadContoursVisible(false);

  startComputeSession();

  try {
    const dem = await buildDemGrid(seeds, {
      ...glideParams,
      openAipConfig: hooks.getOpenAipConfig(),
      onStatus: hooks.setStatus,
      gridBounds,
    });

    if (hooks.getComputeShouldStop()) {
      hooks.setStatus(useCpu ? "Stopped before CPU compute" : "Stopped before GPU compute");
      return;
    }

    const airspaceNote =
      dem.airspaces.length > 0
        ? `, ${dem.airspaces.length} airspace volumes (${dem.airspaceAffectedCells} cells capped)`
        : "";

    const engineLabel = useCpu ? "CPU" : "GPU";
    hooks.setStatus(
      `Computing ${dem.width}×${dem.height} grid (${dem.tileCount} tiles) on ${engineLabel}${airspaceNote}…`
    );

    const computeOptions = makeComputeOptions(dem, glideParams);
    let result;
    if (useCpu) {
      result = await computeUpwardConeCpu(dem, glideParams, computeOptions);
    } else {
      const gpu = await hooks.ensureEngine();
      result = await gpu.compute(dem, glideParams, computeOptions);
      if (result && !result.engine) {
        result.engine = "gpu";
      }
    }

    hooks.setConeState(dem, result, glideParams);
    updateConeVisualization(result, dem, glideParams);
    logOriginPathValidation(result);
    hooks.ensurePathLayer();
    hooks.setDownloadContoursVisible(glideParams.contours);

    hooks.setStatus(
      formatComputeDone(
        result,
        ` — z${dem.zoom}, ${dem.width}×${dem.height}, ${seeds.length} airports`
      ),
      { clearAfterMs: COMPUTE_DONE_STATUS_CLEAR_MS }
    );
  } catch (error) {
    const message = error?.message ?? String(error);
    if (isMissingCachedCoverageError(message)) {
      hooks.showComputeStopBarMessage?.(MISSING_TERRAIN_CACHE_MSG);
      hooks.setStatus("");
    } else {
      hooks.setStatus(`Error: ${message}`);
      console.error(error);
    }
  } finally {
    endComputeSession();
  }
}
