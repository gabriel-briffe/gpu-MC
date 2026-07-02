import { buildDemGrid } from "../dem.js";
import { MIN_SEEDS, COMPUTE_DONE_STATUS_CLEAR_MS } from "../constants.js";
import { formatComputeDone } from "./format.js";
import { getGlideParams } from "./params.js";
import { updateConeVisualization, updateOverlay } from "./visualization.js";

let hooks;

export function initComputeSession(h) {
  hooks = h;
}

export function startComputeSession() {
  hooks.setComputeShouldStop(false);
  hooks.setComputing(true);
  hooks.stopComputeBtn.hidden = false;
  hooks.stopComputeBtn.disabled = false;
  if (hooks.runComputeBtn) {
    hooks.runComputeBtn.disabled = true;
  }
  if (hooks.getAirportAreaSelectMode()) {
    hooks.exitAirportAreaSelectMode(false);
  }
  if (hooks.getManualAirportSelectMode()) {
    hooks.exitManualAirportSelectMode(false);
  }
  hooks.exitMatrixExtractMode?.();
  hooks.syncCompareLosButton();
  hooks.syncExtractMatrixButton?.();
}

export function endComputeSession() {
  hooks.setComputing(false);
  hooks.setComputeShouldStop(false);
  hooks.stopComputeBtn.hidden = true;
  hooks.stopComputeBtn.disabled = false;
  hooks.updateSeedMarkers();
  hooks.syncCompareLosButton();
  hooks.syncExtractMatrixButton?.();
  if (hooks.isAutoParamsMode() && hooks.getAutoComputePending()) {
    void hooks.flushAutoCompute();
  } else if (hooks.isSingleParamsMode?.() && hooks.getSingleComputePending?.()) {
    void hooks.flushSingleAirportCompute();
  }
}

export function requestStopCompute() {
  hooks.setComputeShouldStop(true);
  hooks.stopComputeBtn.disabled = true;
  hooks.setStatus("Stopping after current GPU step…");
}

function makeComputeOptions(dem, glideParams) {
  return {
    onProgress: makeComputeProgressHandler(dem, glideParams),
    shouldStop: () => hooks.getComputeShouldStop(),
    maxIterations: hooks.getMaxComputeIterations?.() ?? null,
  };
}

function makeComputeProgressHandler(dem, glideParams) {
  return ({ imageData, iteration, elapsedMs }) => {
    if (
      !glideParams.pathOnly &&
      (glideParams.raw || !glideParams.contours) &&
      imageData
    ) {
      updateOverlay(imageData, dem);
    }
    hooks.setStatus(`Computing… iter ${iteration}, ${elapsedMs.toFixed(0)} ms GPU`);
  };
}

export async function runFullBresenhamCompare() {
  const coneState = hooks.getConeState();
  if (!coneState || hooks.isComputing()) {
    return;
  }

  startComputeSession();
  hooks.compareLosBtn.disabled = true;
  hooks.setStatus("Running full Bresenham on current grid…");

  try {
    const gpu = await hooks.ensureEngine();
    const result = await gpu.compute(coneState.dem, getGlideParams(), {
      fullBresenham: true,
      overlayColor: "red",
      imageOnly: true,
      raw: false,
      shouldStop: () => hooks.getComputeShouldStop(),
    });
    hooks.updateCompareOverlay(result.imageData, coneState.dem);
    hooks.setStatus(formatComputeDone(result), { clearAfterMs: COMPUTE_DONE_STATUS_CLEAR_MS });
  } catch (error) {
    hooks.setStatus(`Error: ${error.message}`);
    console.error(error);
  } finally {
    endComputeSession();
    hooks.compareLosBtn.disabled = false;
  }
}

export async function runComputation(seedsOverride = null, { gridBounds = null } = {}) {
  if (hooks.isComputing()) {
    return;
  }

  const pendingSeeds = hooks.getPendingSeeds();
  const seeds =
    seedsOverride ?? pendingSeeds.map((seed) => ({ lng: seed.lng, lat: seed.lat }));

  if (seeds.length < MIN_SEEDS) {
    hooks.setStatus(`Place at least ${MIN_SEEDS} airport on the map before running`);
    return;
  }
  const glideParams = getGlideParams();
  hooks.clearCellInspect();
  hooks.clearGlidePath();
  hooks.clearCompareOverlay();
  hooks.setCompareButtonVisible(false);
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
      hooks.setStatus("Stopped before GPU compute");
      return;
    }

    const airspaceNote =
      dem.airspaces.length > 0
        ? `, ${dem.airspaces.length} airspace volumes (${dem.airspaceAffectedCells} cells capped)`
        : "";

    hooks.setStatus(
      `Computing ${dem.width}×${dem.height} grid (${dem.tileCount} tiles) on GPU${airspaceNote}…`
    );
    const gpu = await hooks.ensureEngine();
    const result = await gpu.compute(dem, glideParams, makeComputeOptions(dem, glideParams));

    hooks.setConeState(dem, result, glideParams);
    updateConeVisualization(result, dem, glideParams);
    hooks.ensurePathLayer();
    hooks.syncCompareLosButton();
    hooks.setDownloadContoursVisible(glideParams.contours);

    hooks.setStatus(
      formatComputeDone(
        result,
        ` — z${dem.zoom}, ${dem.width}×${dem.height}, ${seeds.length} airports`
      ),
      { clearAfterMs: COMPUTE_DONE_STATUS_CLEAR_MS }
    );
  } catch (error) {
    hooks.setStatus(`Error: ${error.message}`);
    console.error(error);
  } finally {
    endComputeSession();
  }
}
