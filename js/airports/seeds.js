import { MIN_SEEDS } from "../constants.js";
import { seedDisplayLabel } from "../airport-label.js";
import { ensureSeedLayers, getSeedLayersReady } from "../map/layers.js";
import { isAutoParamsMode } from "../params/panel.js";

let hooks;
let app;

export function initSeeds(h) {
  hooks = h;
  app = h.app;
  hooks.getPendingSeeds = getPendingSeeds;
  hooks.updateSeedMarkers = updateSeedMarkers;
  hooks.syncSeedLayerVisibility = syncSeedLayerVisibility;
  hooks.setPendingSeedsFromAirports = setPendingSeedsFromAirports;
  hooks.clearPendingSeeds = clearPendingSeeds;
  hooks.seedKey = seedKey;
  hooks.scrollToSeedsSection = scrollToSeedsSection;
  hooks.airportCountStatus = airportCountStatus;
  hooks.airportCountTotal = airportCountTotal;

  hooks.clearAllSeedsBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    clearPendingSeeds();
  });
}

export function getPendingSeeds() {
  return app.pendingSeeds;
}

export function seedKey(seed) {
  return `${seed.lng.toFixed(5)},${seed.lat.toFixed(5)}`;
}

export function airportCountStatus(count) {
  return `${count} airport${count === 1 ? "" : "s"} selected`;
}

export function airportCountTotal(count) {
  return `${count} airport${count === 1 ? "" : "s"} total`;
}

export function setPendingSeedsFromAirports(airports) {
  app.pendingSeeds = airports.map((airport) => ({
    lng: airport.lng,
    lat: airport.lat,
    label: airport.label,
    source: airport.source ?? "airport",
  }));
  updateSeedMarkers();
}

export function scrollToSeedsSection() {
  const { paramsScrollEl, seedsSectionEl } = hooks;
  if (!paramsScrollEl || !seedsSectionEl) {
    return;
  }
  paramsScrollEl.scrollTo({
    top: Math.max(0, seedsSectionEl.offsetTop - 8),
    behavior: "smooth",
  });
}

function sortedSeedEntries() {
  return app.pendingSeeds
    .map((seed, index) => ({ seed, index }))
    .sort((a, b) =>
      seedDisplayLabel(a.seed).localeCompare(seedDisplayLabel(b.seed), undefined, {
        sensitivity: "base",
      })
    );
}

function updateSeedList() {
  const { seedListEl } = hooks;
  if (!seedListEl) {
    return;
  }
  seedListEl.replaceChildren();

  if (app.pendingSeeds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "seed-list-empty";
    empty.textContent = "Use Manual selection or Draw airport areas";
    seedListEl.append(empty);
    return;
  }

  for (const { seed, index } of sortedSeedEntries()) {
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
    del.addEventListener("click", () => removePendingSeed(index));

    row.append(label, del);
    seedListEl.append(row);
  }
}

export function removePendingSeed(index) {
  if (hooks.isComputing() || index < 0 || index >= app.pendingSeeds.length) {
    return;
  }
  app.pendingSeeds.splice(index, 1);
  updateSeedMarkers();
  updateSeedList();
  if (app.pendingSeeds.length === 0) {
    hooks.setStatus("Airports cleared — add airports, then Run");
  } else {
    hooks.setStatus(airportCountStatus(app.pendingSeeds.length));
  }
}

export function syncSeedLayerVisibility() {
  const map = hooks.getMap();
  if (!getSeedLayersReady() || !map) {
    return;
  }
  const visibility = isAutoParamsMode() ? "none" : "visible";
  for (const layerId of ["seeds-circle", "seeds-label"]) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
  }
}

export function updateSeedMarkers() {
  const map = hooks.getMap();
  ensureSeedLayers();
  const mapAirports = [...app.pendingSeeds];
  if (hooks.getManualAirportSelectMode?.()) {
    mapAirports.push(...(hooks.getManualStagingAirports?.() ?? []));
  }
  const features = mapAirports.map((seed) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [seed.lng, seed.lat],
    },
    properties: {
      label: seedDisplayLabel(seed),
    },
  }));

  map.getSource("seeds").setData({
    type: "FeatureCollection",
    features,
  });

  syncSeedLayerVisibility();
  if (hooks.runComputeBtn) {
    hooks.runComputeBtn.disabled = app.pendingSeeds.length < MIN_SEEDS || hooks.isComputing();
  }
  hooks.syncAirportAreaSelectUi?.();
  updateSeedList();
}

export function addPendingSeed(lng, lat, { label, source = "map" } = {}) {
  const key = seedKey({ lng, lat });
  if (app.pendingSeeds.some((seed) => seedKey(seed) === key)) {
    hooks.setStatus("Airport already in list");
    return false;
  }
  const seed = { lng, lat, source };
  if (label) {
    seed.label = label;
  }
  app.pendingSeeds.push(seed);
  updateSeedMarkers();
  hooks.updateAirspaceInfo?.(lng, lat);
  hooks.setStatus(airportCountStatus(app.pendingSeeds.length));
  return true;
}

export function clearPendingSeeds() {
  if (hooks.getManualAirportSelectMode?.()) {
    hooks.exitManualAirportSelectMode(false);
  }
  app.pendingSeeds = [];
  hooks.clearPendingManualAirport?.();
  hooks.clearComputeResults();
  updateSeedMarkers();
  hooks.setStatus("Airports cleared — add airports, then Run");
}
