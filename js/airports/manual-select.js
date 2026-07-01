import { OPENAIP_AIRPORT_MIN_ZOOM } from "../openaip-tiles.js";
import { seedDisplayLabel } from "../airport-label.js";

let hooks;
let app;

export function initManualSelect(h) {
  hooks = h;
  app = h.app;
  hooks.getManualAirportSelectMode = () => app.manualAirportSelectMode;
  hooks.getManualStagingAirports = () => app.manualStagingAirports;
  hooks.getPendingManualAirportLayerReady = () => app.pendingManualAirportLayerReady;
  hooks.exitManualAirportSelectMode = exitManualAirportSelectMode;
  hooks.setPendingManualAirport = setPendingManualAirport;
  hooks.clearPendingManualAirport = clearPendingManualAirport;
  hooks.syncManualAirportSelectUi = syncManualAirportSelectUi;

  hooks.toggleManualAirportSelectBtn?.addEventListener("click", () => {
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
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        OPENAIP_AIRPORT_MIN_ZOOM,
        4,
        14,
        10,
      ],
      "circle-color": "#ffcc00",
      "circle-stroke-width": 3,
      "circle-stroke-color": "#4da3ff",
      "circle-opacity": 0.85,
    },
  });

  app.pendingManualAirportLayerReady = true;
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
    manualAirportSelectPanel,
    addManualAirportBtn,
    clearManualAirportBtn,
    finishManualAirportBtn,
    manualAirportNameInput,
  } = hooks;

  if (manualAirportSelectPanel) {
    manualAirportSelectPanel.hidden = !app.manualAirportSelectMode;
  }
  const hasPending = app.pendingManualAirport !== null;
  const hasStaging = app.manualStagingAirports.length > 0;
  if (addManualAirportBtn) {
    addManualAirportBtn.disabled =
      hooks.isComputing() || !app.manualAirportSelectMode || !hasPending;
  }
  if (clearManualAirportBtn) {
    clearManualAirportBtn.disabled =
      hooks.isComputing() || !app.manualAirportSelectMode || !hasPending;
  }
  if (finishManualAirportBtn) {
    finishManualAirportBtn.hidden = !app.manualAirportSelectMode || !hasStaging;
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
  if (hooks.getAirportAreaSelectMode?.()) {
    hooks.exitAirportAreaSelectMode(false);
  }
  app.manualAirportSelectMode = true;
  app.manualStagingAirports = [];
  updateManualStagingList();
  if (hooks.paramsPanel) {
    hooks.paramsPanel.open = false;
  }
  ensurePendingManualAirportLayer();
  hooks.updateSeedMarkers();
  syncManualAirportSelectUi();
  hooks.setStatus("Click the map to place an airport.");
}

export function exitManualAirportSelectMode(reopenParams = false) {
  app.manualAirportSelectMode = false;
  app.manualStagingAirports = [];
  clearPendingManualAirport();
  updateManualStagingList();
  hooks.updateSeedMarkers();
  syncManualAirportSelectUi();
  if (reopenParams && hooks.paramsPanel) {
    hooks.paramsPanel.open = true;
    window.requestAnimationFrame(() => hooks.scrollToSeedsSection());
  }
  const map = hooks.getMap();
  if (map?.getCanvas()) {
    map.getCanvas().style.cursor = "";
  }
}

function sortedManualStagingEntries() {
  return app.manualStagingAirports
    .map((seed, index) => ({ seed, index }))
    .sort((a, b) =>
      seedDisplayLabel(a.seed).localeCompare(seedDisplayLabel(b.seed), undefined, {
        sensitivity: "base",
      })
    );
}

function updateManualStagingList() {
  const { manualAirportListEl } = hooks;
  if (!manualAirportListEl) {
    return;
  }
  manualAirportListEl.replaceChildren();

  if (app.manualStagingAirports.length === 0) {
    manualAirportListEl.hidden = true;
    return;
  }

  manualAirportListEl.hidden = false;
  for (const { seed, index } of sortedManualStagingEntries()) {
    const row = document.createElement("div");
    row.className = "seed-list-item";

    const label = document.createElement("span");
    label.className = "seed-list-label";
    label.textContent = seedDisplayLabel(seed);
    label.title = seedDisplayLabel(seed);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "seed-list-delete";
    del.setAttribute("aria-label", `Remove ${seedDisplayLabel(seed)}`);
    del.textContent = "×";
    del.addEventListener("click", () => removeManualStagingAirport(index));

    row.append(label, del);
    manualAirportListEl.append(row);
  }
}

function removeManualStagingAirport(index) {
  if (hooks.isComputing() || index < 0 || index >= app.manualStagingAirports.length) {
    return;
  }
  app.manualStagingAirports.splice(index, 1);
  updateManualStagingList();
  hooks.updateSeedMarkers();
  syncManualAirportSelectUi();
  if (app.manualStagingAirports.length === 0) {
    hooks.setStatus("Click the map to place an airport.");
  } else {
    hooks.setStatus(
      `${app.manualStagingAirports.length} airport${app.manualStagingAirports.length === 1 ? "" : "s"} picked — click Finished when done`
    );
  }
}

function commitPendingManualAirport() {
  if (!app.pendingManualAirport) {
    return;
  }

  const { lng, lat } = app.pendingManualAirport;
  const name = hooks.manualAirportNameInput?.value.trim() ?? "";
  const key = hooks.seedKey({ lng, lat });
  const pendingSeeds = hooks.getPendingSeeds();
  if (
    pendingSeeds.some((seed) => hooks.seedKey(seed) === key) ||
    app.manualStagingAirports.some((seed) => hooks.seedKey(seed) === key)
  ) {
    hooks.setStatus("Airport already in list");
    return;
  }

  const seed = { lng, lat, source: "map" };
  if (name) {
    seed.label = name;
  }
  app.manualStagingAirports.push(seed);

  if (hooks.manualAirportNameInput) {
    hooks.manualAirportNameInput.value = "";
  }
  clearPendingManualAirport();
  updateManualStagingList();
  hooks.updateSeedMarkers();
  syncManualAirportSelectUi();
  hooks.setStatus(
    `${app.manualStagingAirports.length} airport${app.manualStagingAirports.length === 1 ? "" : "s"} picked — click Finished when done`
  );
}

function finishManualAirportSelection() {
  if (app.manualStagingAirports.length === 0 || hooks.isComputing()) {
    return;
  }

  const pendingSeeds = hooks.getPendingSeeds();
  const existing = new Set(pendingSeeds.map((seed) => hooks.seedKey(seed)));
  let added = 0;
  for (const seed of app.manualStagingAirports) {
    const key = hooks.seedKey(seed);
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    pendingSeeds.push({ ...seed });
    added += 1;
  }

  const pickedCount = app.manualStagingAirports.length;
  app.manualStagingAirports = [];
  updateManualStagingList();
  hooks.updateSeedMarkers();
  exitManualAirportSelectMode(true);

  if (added === 0) {
    hooks.setStatus("All picked airports are already in the list");
  } else if (added < pickedCount) {
    hooks.setStatus(
      `Added ${added} airport${added === 1 ? "" : "s"} — ${hooks.airportCountTotal(pendingSeeds.length)}`
    );
  } else {
    hooks.setStatus(
      `Added ${added} airport${added === 1 ? "" : "s"} — ${hooks.airportCountTotal(pendingSeeds.length)}`
    );
  }
}
