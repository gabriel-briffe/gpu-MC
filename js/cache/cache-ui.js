import {
  buildCacheBundle,
  cacheCellKey,
  getLastCachedCellKeysForSelection,
} from "../cache-area.js";

let hooks;

let cacheSelectMode = false;
let cacheDownloadInProgress = false;

export function initCacheUi(h) {
  hooks = h;
  hooks.getCacheSelectMode = () => cacheSelectMode;
  hooks.enterCacheSelectMode = enterCacheSelectMode;
  hooks.exitCacheSelectMode = exitCacheSelectMode;
  hooks.toggleCacheCellSelection = toggleCacheCellSelection;

  hooks.openCacheDataBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    enterCacheSelectMode();
  });

  hooks.runCacheDownloadBtn?.addEventListener("click", () => {
    void runCacheDownload();
  });

  hooks.finishCacheSelectBtn?.addEventListener("click", () => {
    exitCacheSelectMode();
  });
}

export function getCacheSelectMode() {
  return cacheSelectMode;
}

function syncCacheDownloadButton() {
  if (!hooks.runCacheDownloadBtn) {
    return;
  }
  hooks.runCacheDownloadBtn.disabled =
    !cacheSelectMode ||
    hooks.getSelectedCacheCells().size === 0 ||
    cacheDownloadInProgress;
}

export function enterCacheSelectMode() {
  if (cacheSelectMode || hooks.isComputing()) {
    return;
  }
  if (hooks.getManualAirportSelectMode?.()) {
    hooks.exitManualAirportSelectMode(false);
  }
  if (hooks.getAirportAreaSelectMode?.()) {
    hooks.exitAirportAreaSelectMode(false);
  }

  hooks.cancelPendingAutoCompute?.();
  cacheSelectMode = true;
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
  syncCacheDownloadButton();
  const count = hooks.getSelectedCacheCells().size;
  hooks.setStatus(
    count === 0
      ? "Click 1° cells to select areas to cache"
      : `${count} cell${count === 1 ? "" : "s"} selected — click Cache to verify or add cells`
  );
}

export function exitCacheSelectMode() {
  if (!cacheSelectMode) {
    return;
  }

  cacheSelectMode = false;
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
  syncCacheDownloadButton();
  hooks.setStatus("Cache selection closed");
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
  syncCacheDownloadButton();
  hooks.setStatus(
    selected.size === 0
      ? "Click 1° cells to select areas to cache"
      : `${selected.size} cell${selected.size === 1 ? "" : "s"} selected`
  );
}

async function runCacheDownload() {
  if (!cacheSelectMode || hooks.getSelectedCacheCells().size === 0 || cacheDownloadInProgress) {
    return;
  }

  cacheDownloadInProgress = true;
  syncCacheDownloadButton();
  try {
    await buildCacheBundle(
      [...hooks.getSelectedCacheCells()],
      hooks.getOpenAipConfig(),
      hooks.setStatus
    );
    hooks.refreshCacheSelectOverlays();
    hooks.refreshCachedAirportMapLayer?.();
    hooks.refreshRestAirspaceLayerData?.({ allCells: cacheSelectMode });
  } catch (error) {
    hooks.setStatus(`Cache error: ${error.message}`);
    console.error(error);
  } finally {
    cacheDownloadInProgress = false;
    syncCacheDownloadButton();
  }
}
