import {
  buildCacheBundle,
  cacheCellKey,
  clearAllCellCache,
  getLastCachedCellKeysForSelection,
  hasCachedAirports,
} from "../cache-area.js";
import { CACHE_SELECT_FOOTER_HINT, CACHE_SELECT_ZOOM } from "../constants.js";
import { clearTerrainTileCache } from "../terrain-tiles.js";

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

  hooks.clearCacheDataBtn?.addEventListener("click", () => {
    void runClearCache();
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
  if (hooks.clearCacheDataBtn) {
    hooks.clearCacheDataBtn.disabled =
      !app.cacheSelectMode || app.cacheDownloadInProgress || app.cacheClearInProgress;
  }
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

function syncMapDoubleTapZoom() {
  const map = hooks.getMap?.();
  if (!map?.doubleClickZoom) {
    return;
  }
  if (app.cacheSelectMode) {
    map.doubleClickZoom.disable();
  } else {
    map.doubleClickZoom.enable();
  }
}

function syncCacheSelectBar() {
  if (hooks.cacheSelectBar) {
    hooks.cacheSelectBar.hidden = !app.cacheSelectMode;
  }
  document.body.classList.toggle("cache-select-mode", app.cacheSelectMode);
  syncMapDoubleTapZoom();
  hooks.updateParamsFooter?.();
  hooks.syncComputeContextBar?.();
}

export function enterCacheSelectMode({ focusMap = false } = {}) {
  if (app.cacheSelectMode || hooks.isComputing()) {
    return;
  }
  if (hooks.getManualAirportSelectMode?.()) {
    hooks.exitManualAirportSelectMode(false);
  }

  hooks.cancelPendingAutoCompute?.();
  app.cacheSelectMode = true;
  hooks.getSelectedCacheCells().clear();
  for (const cellKey of getLastCachedCellKeysForSelection()) {
    hooks.getSelectedCacheCells().add(cellKey);
  }
  hooks.closeAppMenu?.();
  if (hooks.openCacheDataBtn) {
    hooks.openCacheDataBtn.disabled = true;
  }

  hooks.setOverlaysHiddenForCacheSelect(true);
  hooks.refreshCacheSelectOverlays();
  syncCacheSelectBar();
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
  if (hooks.openCacheDataBtn) {
    hooks.openCacheDataBtn.disabled = false;
  }

  hooks.clearCacheGridLayers();
  hooks.clearCacheAirportLayers();
  hooks.setOverlaysHiddenForCacheSelect(false);
  hooks.refreshCachedAirportMapLayer?.();
  hooks.updateSeedMarkers?.();
  hooks.setStatus("");
  syncCacheSelectBar();
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

async function runClearCache() {
  if (!app.cacheSelectMode || app.cacheDownloadInProgress || app.cacheClearInProgress) {
    return;
  }

  app.cacheClearInProgress = true;
  syncCacheSelectButtons();
  try {
    clearAllCellCache();
    await clearTerrainTileCache();
    hooks.getSelectedCacheCells().clear();
    hooks.clearCacheDataWarnings?.();
    hooks.reloadHillshadeSource?.();
    hooks.refreshCacheSelectOverlays();
    hooks.refreshCachedAirportMapLayer?.();
    hooks.refreshRestAirspaceLayerData?.({ allCells: app.cacheSelectMode });
    hooks.setStatus("Cache cleared — select areas and hit Cache");
  } catch (error) {
    hooks.setStatus(`Clear cache error: ${error.message}`);
    console.error(error);
  } finally {
    app.cacheClearInProgress = false;
    syncCacheSelectButtons();
  }
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
