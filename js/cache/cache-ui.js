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
import { clearAllOpenAipCellCaches } from "./openaip-cell-cache.js";
import {
  OPENAIP_COUNTRY_CODES,
  fetchAndParseOpenAipCountry,
} from "./import-airports.js";
import { setOpenAipCache, getCachedAirspaces, getCachedAirports } from "./cell-store.js";

const selectedAirportCountries = new Set();

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
    openCacheDownloadDialog();
  });

  hooks.cacheDownloadCancelBtn?.addEventListener("click", closeCacheDownloadDialog);
  hooks.cacheDownloadDialogBackdrop?.addEventListener("click", closeCacheDownloadDialog);
  hooks.cacheDownloadConfirmBtn?.addEventListener("click", () => {
    void confirmCacheDownload();
  });
  hooks.cacheDownloadTilesInput?.addEventListener("change", syncCacheDownloadConfirmButton);

  hooks.importAirportsBtn?.addEventListener("click", openImportAirportsDialog);
  hooks.importAirportsCancelBtn?.addEventListener("click", closeImportAirportsDialog);
  hooks.importAirportsDialogBackdrop?.addEventListener("click", closeImportAirportsDialog);
  hooks.importAirportsSearch?.addEventListener("input", renderImportAirportsList);
  hooks.importAirportsConfirmBtn?.addEventListener("click", () => void importSelectedAirports());

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
  if (selected.length === 0) {
    return false;
  }
  // After clearing OpenAIP, allow leaving cache mode; otherwise require airports.
  return !hasOpenAipCacheData() || hasCachedAirports(selected);
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
  hooks.syncEmulatedAltitudeBox?.();
  syncMapDoubleTapZoom();
  hooks.updateParamsFooter?.();
  hooks.syncComputeContextBar?.();
  hooks.syncGlideModeCycleButton?.();
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

  closeCacheDownloadDialog();
  closeCacheClearDialog();
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
  if (hooks.isAutoParamsMode?.() && hooks.isGlideConesEnabled?.()) {
    hooks.scheduleAutoCompute?.({ refreshAirports: true });
  }
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
  let openAipBytes = 0;
  try {
    openAipBytes = estimateOpenAipCacheBytes();
  } catch (error) {
    console.warn("Failed to estimate OpenAIP cache size", error);
  }
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

function readCacheDownloadOptions() {
  return {
    tiles: true,
    airports: false,
    airspace: false,
  };
}

function syncCacheDownloadConfirmButton() {
  if (!hooks.cacheDownloadConfirmBtn) {
    return;
  }
  const { tiles } = readCacheDownloadOptions();
  hooks.cacheDownloadConfirmBtn.disabled = !tiles;
}

function resetCacheDownloadDialogDefaults() {
  if (hooks.cacheDownloadTilesInput) {
    hooks.cacheDownloadTilesInput.checked = true;
  }
  syncCacheDownloadConfirmButton();
}

function closeCacheDownloadDialog() {
  if (hooks.cacheDownloadDialog) {
    hooks.cacheDownloadDialog.hidden = true;
  }
}

function openCacheDownloadDialog() {
  if (
    !app.cacheSelectMode ||
    hooks.getSelectedCacheCells().size === 0 ||
    app.cacheDownloadInProgress ||
    app.cacheClearInProgress
  ) {
    return;
  }
  closeCacheClearDialog();
  resetCacheDownloadDialogDefaults();
  if (hooks.cacheDownloadDialog) {
    hooks.cacheDownloadDialog.hidden = false;
  }
}

async function confirmCacheDownload() {
  const options = readCacheDownloadOptions();
  if (!options.tiles && !options.airports && !options.airspace) {
    return;
  }
  closeCacheDownloadDialog();
  await runCacheDownload(options);
}

async function openCacheClearDialog() {
  if (!app.cacheSelectMode || app.cacheDownloadInProgress || app.cacheClearInProgress) {
    return;
  }
  closeCacheDownloadDialog();
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
    await clearAllOpenAipCellCaches();
    hooks.clearComputeAirports?.();
    hooks.clearComputeResults?.();
    closeCacheClearDialog();
    await refreshAfterCacheMutation(
      "Airports cleared"
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
    hooks.clearComputeAirports?.();
    hooks.clearComputeResults?.();
    closeCacheClearDialog();
    await refreshAfterCacheMutation(
      selected.length === 1
        ? "Cleared 1 selected cell — select areas and hit Cache"
        : `Cleared ${selected.length} selected cells — select areas and hit Cache`
    );
  });
}

function countryLabel(code) {
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    return dn.of(code) || code;
  } catch {
    return code;
  }
}

function renderImportAirportsList() {
  const list = hooks.importAirportsList;
  if (!list) return;
  const q = (hooks.importAirportsSearch?.value || "").trim().toLowerCase();
  list.innerHTML = "";
  const items = OPENAIP_COUNTRY_CODES
    .map((code) => ({ code, name: countryLabel(code) }))
    .filter(({ code, name }) => !q || code.toLowerCase().includes(q) || name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const { code, name } of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "action-btn";
    const selected = selectedAirportCountries.has(code);
    btn.style.cssText = `display:block;width:100%;text-align:left;margin:2px 0;${selected ? "background:#2a6;" : ""}`;
    btn.textContent = `${selected ? "✓ " : ""}${code} — ${name}`;
    btn.addEventListener("click", () => {
      if (selectedAirportCountries.has(code)) {
        selectedAirportCountries.delete(code);
      } else {
        selectedAirportCountries.add(code);
      }
      renderImportAirportsList();
      updateImportConfirmButton();
    });
    list.appendChild(btn);
  }
  if (items.length === 0) {
    list.textContent = "No matches";
  }
  updateImportConfirmButton();
}

function updateImportConfirmButton() {
  const btn = hooks.importAirportsConfirmBtn;
  if (!btn) return;
  const n = selectedAirportCountries.size;
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? "Import selected" : `Import selected (${n})`;
}

function openImportAirportsDialog() {
  closeCacheDownloadDialog();
  closeCacheClearDialog();
  const dlg = hooks.importAirportsDialog;
  if (!dlg) {
    console.error("import-airports-dialog element not found");
    alert("Import airports dialog not found in page");
    return;
  }
  dlg.hidden = false;
  dlg.style.zIndex = "40";
  if (hooks.importAirportsSearch) {
    hooks.importAirportsSearch.value = "";
  }
  if (hooks.importAirportsStatus) {
    hooks.importAirportsStatus.textContent = "";
  }
  renderImportAirportsList();
  const list = hooks.importAirportsList;
  if (list && list.children.length === 0) {
    list.textContent = "No countries loaded";
  }
}

function closeImportAirportsDialog() {
  if (hooks.importAirportsDialog) {
    hooks.importAirportsDialog.hidden = true;
  }
}

async function importSelectedAirports() {
  const codes = [...selectedAirportCountries];
  if (codes.length === 0) return;
  if (hooks.importAirportsStatus) {
    hooks.importAirportsStatus.textContent = `Downloading ${codes.length} countries…`;
  }
  if (hooks.importAirportsConfirmBtn) {
    hooks.importAirportsConfirmBtn.disabled = true;
  }
  try {
    const allAirports = [];
    for (const code of codes) {
      const name = countryLabel(code);
      if (hooks.importAirportsStatus) {
        hooks.importAirportsStatus.textContent = `Downloading ${code} — ${name}…`;
      }
      const airports = await fetchAndParseOpenAipCountry(code);
      allAirports.push(...airports);
    }
    const existingAirspaces = getCachedAirspaces();
    setOpenAipCache({
      airports: allAirports,
      airspaces: existingAirspaces,
      airportFetches: codes.length,
      airspaceFetches: 0,
    });
    selectedAirportCountries.clear();
    closeImportAirportsDialog();
    await refreshAfterCacheMutation(
      `Imported ${allAirports.length} airports from ${codes.length} countries`
    );
  } catch (error) {
    if (hooks.importAirportsStatus) {
      hooks.importAirportsStatus.textContent = `Import failed: ${error.message}`;
    }
    console.error(error);
    updateImportConfirmButton();
  }
}

async function runCacheDownload(options) {
  if (!app.cacheSelectMode || hooks.getSelectedCacheCells().size === 0 || app.cacheDownloadInProgress) {
    return;
  }
  if (!options?.tiles && !options?.airports && !options?.airspace) {
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
      },
      options
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
