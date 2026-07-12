import { OPENAIP_AIRPORT_CIRCLE_RADIUS } from "../openaip-tiles.js";
import { seedDisplayLabel } from "../airport-label.js";
import { airportIdFromManualPlacement } from "./airport-id.js";
import {
  manualAirportAlreadyStored,
  manualAirportToSeed,
} from "./manual-airports.js";
import { isAutoParamsMode, isSingleParamsMode } from "../params/panel.js";

let hooks;
let app;

export function initManualSelect(h) {
  hooks = h;
  app = h.app;
  hooks.getManualAirportSelectMode = () => app.manualAirportSelectMode;
  hooks.getPendingManualAirportLayerReady = () => app.pendingManualAirportLayerReady;
  hooks.exitManualAirportSelectMode = exitManualAirportSelectMode;
  hooks.setPendingManualAirport = setPendingManualAirport;
  hooks.clearPendingManualAirport = clearPendingManualAirport;
  hooks.syncManualAirportSelectUi = syncManualAirportSelectUi;

  hooks.addManualAirportsBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    enterManualAirportSelectMode();
  });

  hooks.addManualAirportBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    commitPendingManualAirport();
  });

  hooks.clearManualAirportBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    if (hooks.manualAirportNameInput) {
      hooks.manualAirportNameInput.value = "";
    }
    clearPendingManualAirport();
    hooks.setStatus("Click the map to place an airport.");
  });

  hooks.finishManualAirportBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    finishManualAirportSelection();
  });

  hooks.cancelManualAirportSelectBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    exitManualAirportSelectMode(true);
  });
}

export function getManualAirportSelectMode() {
  return app.manualAirportSelectMode;
}

function ensurePendingManualAirportLayer() {
  const map = hooks.getMap();
  if (app.pendingManualAirportLayerReady) {
    return;
  }

  map.addSource("pending-manual-airport", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "pending-manual-airport-circle",
    type: "circle",
    source: "pending-manual-airport",
    paint: {
      "circle-radius": OPENAIP_AIRPORT_CIRCLE_RADIUS,
      "circle-color": "#2d8a4e",
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff",
      "circle-opacity": 0.9,
    },
  });

  app.pendingManualAirportLayerReady = true;
  hooks.raisePathLayer?.();
}

function updatePendingManualAirportLayer() {
  const map = hooks.getMap();
  if (!app.pendingManualAirportLayerReady) {
    return;
  }

  const features = app.pendingManualAirport
    ? [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [app.pendingManualAirport.lng, app.pendingManualAirport.lat],
          },
          properties: {},
        },
      ]
    : [];

  map.getSource("pending-manual-airport").setData({
    type: "FeatureCollection",
    features,
  });
}

export function syncManualAirportSelectUi() {
  const {
    manualAirportSelectBar,
    addManualAirportBtn,
    clearManualAirportBtn,
    finishManualAirportBtn,
    manualAirportNameInput,
  } = hooks;

  if (manualAirportSelectBar) {
    manualAirportSelectBar.hidden = !app.manualAirportSelectMode;
  }
  document.body.classList.toggle("manual-airport-select-mode", app.manualAirportSelectMode);
  hooks.updateParamsFooter?.();
  const hasPending = app.pendingManualAirport !== null;
  if (addManualAirportBtn) {
    addManualAirportBtn.disabled =
      hooks.isComputing() || !app.manualAirportSelectMode || !hasPending;
  }
  if (clearManualAirportBtn) {
    clearManualAirportBtn.disabled =
      hooks.isComputing() || !app.manualAirportSelectMode || !hasPending;
  }
  if (finishManualAirportBtn) {
    finishManualAirportBtn.hidden = !app.manualAirportSelectMode;
    finishManualAirportBtn.disabled = hooks.isComputing();
  }
  if (manualAirportNameInput) {
    manualAirportNameInput.disabled = hooks.isComputing() || !app.manualAirportSelectMode;
  }
}

export function clearPendingManualAirport() {
  app.pendingManualAirport = null;
  updatePendingManualAirportLayer();
  syncManualAirportSelectUi();
}

export function setPendingManualAirport(lng, lat) {
  app.pendingManualAirport = { lng, lat };
  ensurePendingManualAirportLayer();
  updatePendingManualAirportLayer();
  hooks.updateAirspaceInfo?.(lng, lat);
  syncManualAirportSelectUi();
  hooks.setStatus("Enter a name (optional), then Add airport.");
  if (hooks.manualAirportNameInput) {
    hooks.manualAirportNameInput.focus();
  }
}

export function enterManualAirportSelectMode() {
  if (hooks.isComputing()) {
    return;
  }
  app.manualAirportSelectMode = true;
  hooks.clearComputeResults?.();
  hooks.setOverlaysHiddenForManualAirportSelect?.(true);
  updateManualAirportList();
  hooks.closeAppMenu?.();
  ensurePendingManualAirportLayer();
  hooks.ensureCachedAirportMapLayers?.();
  hooks.refreshCachedAirportMapLayer?.();
  hooks.syncIncludeManualAirportsUi?.();
  syncManualAirportSelectUi();
  const count = hooks.getManualAirportCount?.() ?? 0;
  hooks.setStatus(
    count > 0
      ? "Click the map to add another airport, or remove saved airports below."
      : "Click the map to place an airport."
  );
}

export function exitManualAirportSelectMode(reopenParams = false) {
  app.manualAirportSelectMode = false;
  clearPendingManualAirport();
  hooks.setOverlaysHiddenForManualAirportSelect?.(false);
  updateManualAirportList();
  hooks.refreshCachedAirportMapLayer?.();
  syncManualAirportSelectUi();
  if (reopenParams) {
    hooks.openGlideSettings?.();
  }
  hooks.setStatus("");
  const map = hooks.getMap();
  if (map?.getCanvas()) {
    map.getCanvas().style.cursor = "";
  }
}

function sortedManualAirportEntries() {
  return (hooks.getManualAirports?.() ?? [])
    .map((entry) => manualAirportToSeed(entry))
    .sort((a, b) =>
      seedDisplayLabel(a).localeCompare(seedDisplayLabel(b), undefined, {
        sensitivity: "base",
      })
    );
}

function updateManualAirportList() {
  const { manualAirportListEl } = hooks;
  if (!manualAirportListEl) {
    return;
  }
  manualAirportListEl.replaceChildren();

  const entries = sortedManualAirportEntries();
  if (entries.length === 0) {
    manualAirportListEl.hidden = true;
    return;
  }

  manualAirportListEl.hidden = false;
  for (const seed of entries) {
    const row = document.createElement("div");
    row.className = "manual-airport-list-item";

    const label = document.createElement("span");
    label.className = "manual-airport-list-label";
    label.textContent = seedDisplayLabel(seed);
    label.title = seedDisplayLabel(seed);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "manual-airport-list-delete";
    del.setAttribute("aria-label", `Remove ${seedDisplayLabel(seed)}`);
    del.textContent = "×";
    del.addEventListener("click", () => removeStoredManualAirport(seed.id));

    row.append(label, del);
    manualAirportListEl.append(row);
  }
}

function refreshManualAirportsOnMap() {
  hooks.syncIncludeManualAirportsUi?.();
  hooks.refreshCachedAirportMapLayer?.();
}

function removeStoredManualAirport(id) {
  if (hooks.isComputing()) {
    return;
  }
  const removed = hooks.removeManualAirportFromStore?.(id) ?? false;
  if (!removed) {
    return;
  }
  updateManualAirportList();
  refreshManualAirportsOnMap();
  const count = hooks.getManualAirportCount?.() ?? 0;
  hooks.setStatus(
    count > 0
      ? `${count} manual airport${count === 1 ? "" : "s"} saved`
      : "All manual airports removed"
  );
}

function commitPendingManualAirport() {
  if (!app.pendingManualAirport) {
    return;
  }

  const { lng, lat } = app.pendingManualAirport;
  const name = hooks.manualAirportNameInput?.value.trim() ?? "";
  const id = airportIdFromManualPlacement(lng, lat);
  if (manualAirportAlreadyStored(id)) {
    hooks.setStatus("Airport already saved");
    return;
  }

  const seed = { id, lng, lat, source: "manual" };
  if (name) {
    seed.label = name;
  }
  const added = hooks.addManualAirportsToStore?.([seed]) ?? 0;
  if (added === 0) {
    hooks.setStatus("Airport already saved");
    return;
  }

  if (hooks.manualAirportNameInput) {
    hooks.manualAirportNameInput.value = "";
  }
  clearPendingManualAirport();
  updateManualAirportList();
  refreshManualAirportsOnMap();
  const count = hooks.getManualAirportCount?.() ?? 0;
  hooks.setStatus(
    `Saved airport — ${count} manual airport${count === 1 ? "" : "s"} total. Click the map to add another, or Done when finished.`
  );
}

function finishManualAirportSelection() {
  if (hooks.isComputing()) {
    return;
  }
  const count = hooks.getManualAirportCount?.() ?? 0;
  exitManualAirportSelectMode(true);
  if (count > 0) {
    hooks.setIncludeManualAirports?.(true);
    hooks.syncIncludeManualAirportsUi?.();
    hooks.refreshCachedAirportMapLayer?.();
  }
  if (isAutoParamsMode()) {
    hooks.scheduleAutoCompute?.({ debounce: false, refreshAirports: true });
  } else if (isSingleParamsMode()) {
    hooks.scheduleSingleAirportCompute?.(undefined, { debounce: false });
  }
}
