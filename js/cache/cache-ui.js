import {
  buildCacheBundle,
  cacheCellKey,
  getLastCachedCellKeysForSelection,
  hasCachedAirports,
} from "../cache-area.js";
import { CACHE_SELECT_FOOTER_HINT, CACHE_SELECT_ZOOM } from "../constants.js";

let hooks;
let app;

export function initCacheUi(h) {
  hooks = h;
  app = h.app;
  hooks.getCacheSelectMode = () => app.cacheSelectMode;
  hooks.enterCacheSelectMode = enterCacheSelectMode;
  hooks.exitCacheSelectMode = exitCacheSelectMode;
  hooks.toggleCacheCellSelection = toggleCacheCellSelection;

  hooks.openCacheDataBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    enterCacheSelectMode({ focusMap: true });
  });

  hooks.runCacheDownloadBtn?.addEventListener("click", () => {
    void runCacheDownload();
  });

  hooks.finishCacheSelectBtn?.addEventListener("click", () => {
    exitCacheSelectMode();
  });
}

export function getCacheSelectMode() {
  return app.cacheSelectMode;
}

function canFinishCacheSelect() {
  if (!app.cacheSelectMode || app.cacheDownloadInProgress) {
    return false;
  }
  const selected = [...hooks.getSelectedCacheCells()];
  return selected.length > 0 && hasCachedAirports(selected);
}

function syncCacheSelectButtons() {
  syncCacheDownloadButton();
  if (!hooks.finishCacheSelectBtn) {
    return;
  }
  hooks.finishCacheSelectBtn.disabled = !canFinishCacheSelect();
}

function syncCacheDownloadButton() {
  if (!hooks.runCacheDownloadBtn) {
    return;
  }
  hooks.runCacheDownloadBtn.disabled =
    !app.cacheSelectMode ||
    hooks.getSelectedCacheCells().size === 0 ||
    app.cacheDownloadInProgress;
}

function focusMapForCacheSelect() {
  const map = hooks.getMap?.();
  if (!map) {
    return;
  }
  map.once("moveend", () => {
    hooks.refreshCacheSelectOverlays?.();
  });
  map.easeTo({
    zoom: CACHE_SELECT_ZOOM,
    center: map.getCenter(),
    duration: 400,
  });
}

export function enterCacheSelectMode({ focusMap = false } = {}) {
  if (app.cacheSelectMode || hooks.isComputing()) {
    return;
  }
  if (hooks.getManualAirportSelectMode?.()) {
    hooks.exitManualAirportSelectMode(false);
  }
  if (hooks.getAirportAreaSelectMode?.()) {
    hooks.exitAirportAreaSelectMode(false);
  }

  hooks.cancelPendingAutoCompute?.();
  app.cacheSelectMode = true;
  hooks.getSelectedCacheCells().clear();
  for (const cellKey of getLastCachedCellKeysForSelection()) {
    hooks.getSelectedCacheCells().add(cellKey);
  }
  hooks.paramsShell?.classList.add("cache-select-mode");
  if (hooks.paramsPanel) {
    hooks.paramsPanel.open = false;
  }
  if (hooks.cacheDataPanel) {
    hooks.cacheDataPanel.hidden = false;
  }
  if (hooks.openCacheDataBtn) {
    hooks.openCacheDataBtn.disabled = true;
  }

  hooks.setOverlaysHiddenForCacheSelect(true);
  hooks.refreshCacheSelectOverlays();
  syncCacheSelectButtons();
  const count = hooks.getSelectedCacheCells().size;
  hooks.setStatus(
    count === 0
      ? CACHE_SELECT_FOOTER_HINT
      : `${count} cell${count === 1 ? "" : "s"} selected — click Cache to verify or add cells`
  );
  if (focusMap) {
    focusMapForCacheSelect();
  }
}

export function exitCacheSelectMode() {
  if (!app.cacheSelectMode || !canFinishCacheSelect()) {
    return;
  }

  app.cacheSelectMode = false;
  hooks.getSelectedCacheCells().clear();
  hooks.paramsShell?.classList.remove("cache-select-mode");
  if (hooks.cacheDataPanel) {
    hooks.cacheDataPanel.hidden = true;
  }
  if (hooks.openCacheDataBtn) {
    hooks.openCacheDataBtn.disabled = false;
  }

  hooks.clearCacheGridLayers();
  hooks.clearCacheAirportLayers();
  hooks.setOverlaysHiddenForCacheSelect(false);
  hooks.refreshCachedAirportMapLayer?.();
  hooks.updateSeedMarkers?.();
  hooks.setStatus("");
  hooks.syncComputeContextBar?.();
  syncCacheSelectButtons();
}

export function toggleCacheCellSelection(lng, lat) {
  const selected = hooks.getSelectedCacheCells();
  const key = cacheCellKey(lng, lat);
  if (selected.has(key)) {
    selected.delete(key);
  } else {
    selected.add(key);
  }
  hooks.updateCacheGridData();
  syncCacheSelectButtons();
  hooks.setStatus(
    selected.size === 0
      ? CACHE_SELECT_FOOTER_HINT
      : `${selected.size} cell${selected.size === 1 ? "" : "s"} selected`
  );
}

async function runCacheDownload() {
  if (!app.cacheSelectMode || hooks.getSelectedCacheCells().size === 0 || app.cacheDownloadInProgress) {
    return;
  }

  app.cacheDownloadInProgress = true;
  syncCacheSelectButtons();
  const warnings = [];
  hooks.clearCacheDataWarnings?.();
  try {
    await buildCacheBundle(
      [...hooks.getSelectedCacheCells()],
      hooks.getOpenAipConfig(),
      hooks.setStatus,
      (message) => {
        warnings.push(message);
        hooks.setCacheDataWarnings?.(warnings);
      }
    );
    hooks.refreshCacheSelectOverlays();
    hooks.refreshCachedAirportMapLayer?.();
    hooks.refreshRestAirspaceLayerData?.({ allCells: app.cacheSelectMode });
  } catch (error) {
    hooks.setStatus(`Cache error: ${error.message}`);
    console.error(error);
  } finally {
    app.cacheDownloadInProgress = false;
    syncCacheSelectButtons();
  }
}
