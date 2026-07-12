import {
  buildCacheBundle,
  cacheCellKey,
  clearAllOpenAipData,
  daysUntilOpenAipExpiry,
  estimateOpenAipCacheBytes,
  getLastCachedCellKeysForSelection,
  hasCachedAirports,
  hasOpenAipCacheData,
  removeCellKeysFromCache,
  unionCellBounds,
} from "../cache-area.js";
import { formatCacheBytes, formatDaysUntilExpiry } from "./cache-stats.js";
import { CACHE_SELECT_FOOTER_HINT, CACHE_SELECT_ZOOM } from "../constants.js";
import {
  clearTerrainTileCache,
  estimateTerrainCacheBytes,
} from "../terrain-tiles.js";
import { initOpenAipExpiryUi } from "./openaip-expiry-ui.js";

let hooks;
let app;

export function initCacheUi(h) {
  hooks = h;
  app = h.app;
  initOpenAipExpiryUi(h);
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
    void openCacheClearDialog();
  });

  hooks.cacheClearCancelBtn?.addEventListener("click", closeCacheClearDialog);
  hooks.cacheClearDialogBackdrop?.addEventListener("click", closeCacheClearDialog);
  hooks.cacheClearOpenAipBtn?.addEventListener("click", () => {
    void runClearOpenAipData();
  });
  hooks.cacheClearTerrainBtn?.addEventListener("click", () => {
    void runClearTerrainTiles();
  });
  hooks.cacheClearCellsBtn?.addEventListener("click", () => {
    void runClearSelectedCells();
  });

  hooks.finishCacheSelectBtn?.addEventListener("click", () => {
    exitCacheSelectMode();
  });
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

  const selected = [...hooks.getSelectedCacheCells()];
  if (selected.length === 0) {
    map.easeTo({
      zoom: CACHE_SELECT_ZOOM,
      center: map.getCenter(),
      duration: 400,
    });
    return;
  }

  const { west, south, east, north } = unionCellBounds(selected);
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    {
      padding: { top: 140, bottom: 48, left: 48, right: 48 },
      maxZoom: 8,
      duration: 500,
    }
  );
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

function enterCacheSelectMode({ focusMap = false } = {}) {
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
  if (focusMap || count > 0) {
    focusMapForCacheSelect();
  }
}

function exitCacheSelectMode() {
  if (!app.cacheSelectMode || !canFinishCacheSelect()) {
    return;
  }

  app.cacheSelectMode = false;
  hooks.getSelectedCacheCells().clear();
  if (hooks.openCacheDataBtn) {
    hooks.openCacheDataBtn.disabled = false;
  }

  hooks.clearCacheGridLayers();
  hooks.setOverlaysHiddenForCacheSelect(false);
  hooks.refreshCachedAirportMapLayer?.();
  hooks.setStatus("");
  syncCacheSelectBar();
  syncCacheSelectButtons();
}

function toggleCacheCellSelection(lng, lat) {
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

async function refreshAfterCacheMutation(message) {
  hooks.refreshCacheSelectOverlays();
  hooks.refreshCachedAirportMapLayer?.();
  hooks.refreshRestAirspaceLayerData?.({ allCells: app.cacheSelectMode });
  hooks.reloadHillshadeSource?.();
  syncCacheSelectButtons();
  hooks.setStatus(message);
}

async function syncCacheClearDialogStats() {
  const openAipBytes = estimateOpenAipCacheBytes();
  const terrainBytes = await estimateTerrainCacheBytes();
  const selectedCount = hooks.getSelectedCacheCells().size;

  if (hooks.cacheClearOpenAipDesc) {
    const expiry = formatDaysUntilExpiry(daysUntilOpenAipExpiry());
    hooks.cacheClearOpenAipDesc.textContent = hasOpenAipCacheData()
      ? `OpenAIP data: ${formatCacheBytes(openAipBytes)}, ${expiry}`
      : "OpenAIP data: none cached";
  }
  if (hooks.cacheClearTerrainDesc) {
    hooks.cacheClearTerrainDesc.textContent =
      terrainBytes > 0
        ? `${formatCacheBytes(terrainBytes)} of Mapterhorn terrain tiles`
        : "No Mapterhorn terrain tiles cached";
  }
  if (hooks.cacheClearCellsDesc) {
    hooks.cacheClearCellsDesc.textContent =
      selectedCount === 0
        ? "No cells selected"
        : `${selectedCount} selected cell${selectedCount === 1 ? "" : "s"}`;
  }
  if (hooks.cacheClearOpenAipBtn) {
    hooks.cacheClearOpenAipBtn.disabled = !hasOpenAipCacheData();
  }
  if (hooks.cacheClearTerrainBtn) {
    hooks.cacheClearTerrainBtn.disabled = terrainBytes <= 0;
  }
  if (hooks.cacheClearCellsBtn) {
    hooks.cacheClearCellsBtn.disabled = selectedCount === 0;
  }
}

function closeCacheClearDialog() {
  if (hooks.cacheClearDialog) {
    hooks.cacheClearDialog.hidden = true;
  }
}

async function openCacheClearDialog() {
  if (!app.cacheSelectMode || app.cacheDownloadInProgress || app.cacheClearInProgress) {
    return;
  }
  if (hooks.cacheClearDialog) {
    hooks.cacheClearDialog.hidden = false;
  }
  await syncCacheClearDialogStats();
}

async function withCacheClearLock(run) {
  if (!app.cacheSelectMode || app.cacheDownloadInProgress || app.cacheClearInProgress) {
    return;
  }
  app.cacheClearInProgress = true;
  syncCacheSelectButtons();
  try {
    await run();
  } catch (error) {
    hooks.setStatus(`Clear cache error: ${error.message}`);
    console.error(error);
  } finally {
    app.cacheClearInProgress = false;
    syncCacheSelectButtons();
  }
}

async function runClearOpenAipData() {
  await withCacheClearLock(async () => {
    clearAllOpenAipData();
    closeCacheClearDialog();
    await refreshAfterCacheMutation(
      "OpenAIP data cleared — hit Cache to refresh airports and airspace"
    );
  });
}

async function runClearTerrainTiles() {
  await withCacheClearLock(async () => {
    await clearTerrainTileCache();
    closeCacheClearDialog();
    await refreshAfterCacheMutation(
      "Terrain tiles cleared — hit Cache to download tiles for selected cells"
    );
  });
}

async function runClearSelectedCells() {
  await withCacheClearLock(async () => {
    const selected = [...hooks.getSelectedCacheCells()];
    if (!selected.length) {
      return;
    }
    removeCellKeysFromCache(selected);
    hooks.getSelectedCacheCells().clear();
    closeCacheClearDialog();
    await refreshAfterCacheMutation(
      selected.length === 1
        ? "Cleared 1 selected cell — select areas and hit Cache"
        : `Cleared ${selected.length} selected cells — select areas and hit Cache`
    );
  });
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
