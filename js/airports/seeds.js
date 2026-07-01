import { MIN_SEEDS } from "../constants.js";
import { seedDisplayLabel, formatAirportLabel } from "../airport-label.js";
import { ensureSeedLayers, getSeedLayersReady } from "../map/layers.js";
import { isAutoParamsMode } from "../params/panel.js";
import {
  airportIdFromFeature,
  airportIdFromManualPlacement,
  airportIdFromSeed,
  seedFromOpenAipAirport,
} from "./airport-id.js";

const AIRPORT_PICK_LAYERS = ["seeds-hit", "airports-cached-hit"];

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
  hooks.seedKey = airportIdFromSeed;
  hooks.airportIdFromSeed = airportIdFromSeed;
  hooks.scrollToSeedsSection = scrollToSeedsSection;
  hooks.airportCountStatus = airportCountStatus;
  hooks.airportCountTotal = airportCountTotal;
  hooks.pickAirportAtMapPoint = pickAirportAtMapPoint;
  hooks.togglePendingSeedAt = togglePendingSeedAt;
  hooks.isAirportPickMode = isAirportPickMode;

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

/** @deprecated Use airportIdFromSeed */
export function seedKey(seed) {
  return airportIdFromSeed(seed);
}

export function isAirportPickMode() {
  if (
    hooks.getManualAirportSelectMode?.() ||
    hooks.getAirportAreaSelectMode?.() ||
    hooks.getCacheSelectMode?.()
  ) {
    return false;
  }
  if (isAutoParamsMode()) {
    return hooks.areOpenAipAirportsAvailable?.() ?? false;
  }
  return !hooks.isComputing();
}

function findPendingSeedIndexById(id) {
  if (!id) {
    return -1;
  }
  return app.pendingSeeds.findIndex((seed) => airportIdFromSeed(seed) === id);
}

function pickFromFeature(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const props = feature.properties ?? {};
  const id = airportIdFromFeature(feature);
  const label =
    props.label ??
    formatAirportLabel({
      lng,
      lat,
      properties: props,
    });
  return {
    id,
    lng,
    lat,
    label,
    source: props.source ?? "airport",
    fromSeedLayer: feature.layer.id === "seeds-hit",
  };
}

function featurePickDistanceSq(map, point, feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const projected = map.project([lng, lat]);
  const dx = projected.x - point.x;
  const dy = projected.y - point.y;
  return dx * dx + dy * dy;
}

export function pickAirportAtMapPoint(point) {
  const map = hooks.getMap();
  if (!map || !isAirportPickMode()) {
    return null;
  }

  const layers = AIRPORT_PICK_LAYERS.filter((layerId) => map.getLayer(layerId));
  if (!layers.length) {
    return null;
  }

  const features = map.queryRenderedFeatures(point, { layers });
  if (!features.length) {
    return null;
  }

  const ranked = features
    .map((feature) => ({
      feature,
      distanceSq: featurePickDistanceSq(map, point, feature),
      isSeed: feature.layer.id === "seeds-hit",
    }))
    .sort((a, b) => {
      if (a.isSeed !== b.isSeed) {
        return a.isSeed ? -1 : 1;
      }
      return a.distanceSq - b.distanceSq;
    });

  return pickFromFeature(ranked[0].feature);
}

export function togglePendingSeedAt(pick) {
  if (!isAirportPickMode() || !pick?.id) {
    return false;
  }

  if (isAutoParamsMode()) {
    return hooks.toggleDisabledAirportAt?.(pick) ?? false;
  }

  const index = findPendingSeedIndexById(pick.id);
  if (index >= 0) {
    removePendingSeed(index);
    return true;
  }

  if (pick.fromSeedLayer) {
    return false;
  }

  return addPendingSeed(pick);
}

export function airportCountStatus(count) {
  return `${count} airport${count === 1 ? "" : "s"} selected`;
}

export function airportCountTotal(count) {
  return `${count} airport${count === 1 ? "" : "s"} total`;
}

export function setPendingSeedsFromAirports(airports) {
  app.pendingSeeds = airports.map((airport) => {
    if (airport.id) {
      return {
        id: airport.id,
        lng: airport.lng,
        lat: airport.lat,
        label: airport.label,
        source: airport.source ?? "airport",
      };
    }
    if (airport.properties) {
      return seedFromOpenAipAirport(airport, {
        label: airport.label ?? formatAirportLabel(airport),
        source: airport.source ?? "airport",
      });
    }
    return {
      id: airportIdFromManualPlacement(airport.lng, airport.lat),
      lng: airport.lng,
      lat: airport.lat,
      label: airport.label,
      source: airport.source ?? "airport",
    };
  });
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
    empty.textContent = "Click airports on the map or use Manual selection / Draw airport areas";
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
  for (const layerId of ["seeds-circle", "seeds-label", "seeds-hit"]) {
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
      airport_id: airportIdFromSeed(seed),
      label: seedDisplayLabel(seed),
      source: seed.source ?? "airport",
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

export function addPendingSeed({ id, lng, lat, label, source = "map", quiet = false } = {}) {
  const airportId = id ?? airportIdFromManualPlacement(lng, lat);
  if (app.pendingSeeds.some((seed) => airportIdFromSeed(seed) === airportId)) {
    if (!quiet) {
      hooks.setStatus("Airport already in list");
    }
    return false;
  }
  const seed = { id: airportId, lng, lat, source };
  if (label) {
    seed.label = label;
  }
  app.pendingSeeds.push(seed);
  updateSeedMarkers();
  hooks.updateAirspaceInfo?.(lng, lat);
  if (!quiet) {
    hooks.setStatus(airportCountStatus(app.pendingSeeds.length));
  }
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
