import {
  AIRPORT_RECT_MIN_DEG,
  AIRPORT_HANDLE_HIT_PX,
  AIRPORT_HANDLE_CURSORS,
} from "../constants.js";
import {
  getCachedAirportsInBounds,
} from "../cache-area.js";
import { formatAirportLabel } from "../airport-label.js";
import { seedFromOpenAipAirport } from "./airport-id.js";

let hooks;
let app;

export function initAreaSelect(h) {
  hooks = h;
  app = h.app;
  hooks.getAirportAreaSelectMode = () => app.airportAreaSelectMode;
  hooks.exitAirportAreaSelectMode = exitAirportAreaSelectMode;
  hooks.syncAirportAreaSelectUi = syncAirportAreaSelectUi;
  hooks.syncAreaSelectCursor = syncAreaSelectCursor;
  hooks.beginAirportAreaInteraction = beginAirportAreaInteraction;
  hooks.updateAirportAreaInteraction = updateAirportAreaInteraction;
  hooks.finishAirportAreaInteraction = finishAirportAreaInteraction;
  hooks.cancelAirportRectInteraction = cancelAirportRectInteraction;
  hooks.hasAirportRectInteraction = hasAirportRectInteraction;

  hooks.toggleAirportAreaSelectBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    enterAirportAreaSelectMode();
  });

  hooks.addAirportAreaBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    startAddAirportArea();
  });

  hooks.addAirportsFromAreasBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    addAirportsFromSelectAreas().catch((error) => {
      hooks.setStatus(`Airport error: ${error.message}`);
      console.error(error);
    });
  });

  hooks.clearAirportAreasBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      return;
    }
    clearAirportSelectAreas();
    hooks.setStatus("Airport selection areas cleared");
  });
}

export function hasAirportRectInteraction() {
  return Boolean(app.airportRectInteraction);
}

export function getAirportAreaSelectMode() {
  return app.airportAreaSelectMode;
}

function normalizeAirportSelectRect(a, b) {
  return {
    west: Math.min(a.lng, b.lng),
    east: Math.max(a.lng, b.lng),
    south: Math.min(a.lat, b.lat),
    north: Math.max(a.lat, b.lat),
  };
}

function airportSelectRectRing(rect) {
  const { west, south, east, north } = rect;
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

function airportSelectRectCorners(rect) {
  return [
    { handle: "nw", lng: rect.west, lat: rect.north },
    { handle: "ne", lng: rect.east, lat: rect.north },
    { handle: "se", lng: rect.east, lat: rect.south },
    { handle: "sw", lng: rect.west, lat: rect.south },
  ];
}

function resizeAnchorForHandle(rect, handle) {
  switch (handle) {
    case "nw":
      return { lng: rect.east, lat: rect.south };
    case "ne":
      return { lng: rect.west, lat: rect.south };
    case "se":
      return { lng: rect.west, lat: rect.north };
    case "sw":
      return { lng: rect.east, lat: rect.north };
    default:
      return { lng: rect.east, lat: rect.south };
  }
}

function hitTestRectHandle(point) {
  const map = hooks.getMap();
  for (let index = app.airportSelectRects.length - 1; index >= 0; index -= 1) {
    const rect = app.airportSelectRects[index];
    for (const corner of airportSelectRectCorners(rect)) {
      const projected = map.project([corner.lng, corner.lat]);
      if (Math.hypot(point.x - projected.x, point.y - projected.y) <= AIRPORT_HANDLE_HIT_PX) {
        return { rectIndex: index, handle: corner.handle };
      }
    }
  }
  return null;
}

export function syncAreaSelectCursor(point) {
  const map = hooks.getMap();
  if (!app.airportAreaSelectMode || !map?.getCanvas() || app.airportRectInteraction) {
    return;
  }
  const hit = hitTestRectHandle(point);
  if (hit) {
    map.getCanvas().style.cursor = AIRPORT_HANDLE_CURSORS[hit.handle];
    return;
  }
  map.getCanvas().style.cursor = app.airportAreaDrawMode ? "crosshair" : "";
}

function ensureAirportSelectLayers() {
  const map = hooks.getMap();
  if (app.airportSelectLayersReady) {
    return;
  }

  map.addSource("airport-select-areas", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "airport-select-areas-fill",
    type: "fill",
    source: "airport-select-areas",
    filter: ["!=", ["get", "handle"], true],
    paint: {
      "fill-color": "#5a9fd4",
      "fill-opacity": ["case", ["get", "preview"], 0.12, 0.22],
    },
  });

  map.addLayer({
    id: "airport-select-areas-line",
    type: "line",
    source: "airport-select-areas",
    filter: ["!=", ["get", "handle"], true],
    paint: {
      "line-color": "#5a9fd4",
      "line-width": 2,
    },
  });

  map.addLayer({
    id: "airport-select-handles",
    type: "circle",
    source: "airport-select-areas",
    filter: ["==", ["get", "handle"], true],
    paint: {
      "circle-radius": 5,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#5a9fd4",
      "circle-stroke-width": 2,
    },
  });

  app.airportSelectLayersReady = true;
}

function updateAirportSelectLayer() {
  const map = hooks.getMap();
  if (!app.airportSelectLayersReady) {
    return;
  }

  const features = app.airportSelectRects.flatMap((rect, index) => {
    const polygon = {
      type: "Feature",
      properties: { index, preview: false, handle: false },
      geometry: {
        type: "Polygon",
        coordinates: [airportSelectRectRing(rect)],
      },
    };
    const handles = airportSelectRectCorners(rect).map((corner) => ({
      type: "Feature",
      properties: { index, handle: true, corner: corner.handle },
      geometry: {
        type: "Point",
        coordinates: [corner.lng, corner.lat],
      },
    }));
    return [polygon, ...handles];
  });

  if (app.airportRectInteraction?.kind === "draw") {
    features.push({
      type: "Feature",
      properties: { preview: true, handle: false },
      geometry: {
        type: "Polygon",
        coordinates: [
          airportSelectRectRing(
            normalizeAirportSelectRect(app.airportRectInteraction.start, app.airportRectInteraction.current)
          ),
        ],
      },
    });
  }

  map.getSource("airport-select-areas").setData({
    type: "FeatureCollection",
    features,
  });
}

export function syncAirportAreaSelectUi() {
  const {
    toggleAirportAreaSelectBtn,
    toggleManualAirportSelectBtn,
    addAirportsFromAreasBtn,
    clearAirportAreasBtn,
    addAirportAreaBtn,
    airportAreaSelectPanel,
  } = hooks;

  if (toggleAirportAreaSelectBtn) {
    toggleAirportAreaSelectBtn.disabled =
      hooks.isComputing() || !hooks.areOpenAipAirportsAvailable();
  }
  if (toggleManualAirportSelectBtn) {
    toggleManualAirportSelectBtn.disabled = hooks.isComputing();
  }
  if (addAirportsFromAreasBtn) {
    addAirportsFromAreasBtn.disabled =
      hooks.isComputing() ||
      app.airportSelectRects.length === 0 ||
      !hooks.areOpenAipAirportsAvailable();
  }
  if (clearAirportAreasBtn) {
    clearAirportAreasBtn.disabled = hooks.isComputing() || app.airportSelectRects.length === 0;
  }
  if (addAirportAreaBtn) {
    addAirportAreaBtn.disabled =
      hooks.isComputing() ||
      !app.airportAreaSelectMode ||
      app.airportAreaDrawMode ||
      app.airportRectInteraction;
  }
  if (airportAreaSelectPanel) {
    airportAreaSelectPanel.hidden = !app.airportAreaSelectMode;
  }
  hooks.syncManualAirportSelectUi?.();
  const map = hooks.getMap();
  if (map?.getCanvas() && !app.airportAreaSelectMode && !hooks.getManualAirportSelectMode?.()) {
    map.getCanvas().style.cursor = "";
  }
}

export function cancelAirportRectInteraction() {
  const map = hooks.getMap();
  if (app.airportRectInteraction) {
    map.dragPan.enable();
  }
  app.airportRectInteraction = null;
  updateAirportSelectLayer();
}

export function enterAirportAreaSelectMode() {
  if (hooks.isComputing() || !hooks.areOpenAipAirportsAvailable()) {
    return;
  }
  if (hooks.getManualAirportSelectMode?.()) {
    hooks.exitManualAirportSelectMode(false);
  }
  app.airportAreaSelectMode = true;
  app.airportAreaDrawMode = app.airportSelectRects.length === 0;
  hooks.closeAppMenu?.();
  ensureAirportSelectLayers();
  syncAirportAreaSelectUi();
  hooks.setStatus(
    app.airportAreaDrawMode
      ? "Drag on the map to draw an area."
      : "Pan and zoom freely, or use Add new area to draw another."
  );
}

function startAddAirportArea() {
  if (!app.airportAreaSelectMode || hooks.isComputing()) {
    return;
  }
  app.airportAreaDrawMode = true;
  syncAirportAreaSelectUi();
  hooks.setStatus("Drag on the map to draw a new area.");
}

export function exitAirportAreaSelectMode(reopenParams = false) {
  app.airportAreaSelectMode = false;
  app.airportAreaDrawMode = false;
  cancelAirportRectInteraction();
  syncAirportAreaSelectUi();
  if (reopenParams) {
    hooks.openGlideSettings?.();
    window.requestAnimationFrame(() => hooks.scrollToSeedsSection());
  }
  const map = hooks.getMap();
  if (map?.getCanvas()) {
    map.getCanvas().style.cursor = "";
  }
}

function commitAirportSelectRect(endLngLat) {
  const { start } = app.airportRectInteraction ?? {};
  if (!start || !endLngLat) {
    return false;
  }

  const rect = normalizeAirportSelectRect(start, endLngLat);
  if (
    rect.east - rect.west < AIRPORT_RECT_MIN_DEG ||
    rect.north - rect.south < AIRPORT_RECT_MIN_DEG
  ) {
    return false;
  }

  app.airportSelectRects.push(rect);
  app.airportAreaDrawMode = false;
  syncAirportAreaSelectUi();
  hooks.setStatus(
    `${app.airportSelectRects.length} area${app.airportSelectRects.length === 1 ? "" : "s"} drawn — pan/zoom freely, or Add new area`
  );
  return true;
}

export function beginAirportAreaInteraction(lngLat, point) {
  const map = hooks.getMap();
  if (!app.airportAreaSelectMode || hooks.isComputing()) {
    return false;
  }

  ensureAirportSelectLayers();

  const hit = hitTestRectHandle(point);
  if (hit) {
    const rect = app.airportSelectRects[hit.rectIndex];
    app.airportRectInteraction = {
      kind: "resize",
      rectIndex: hit.rectIndex,
      handle: hit.handle,
      anchor: resizeAnchorForHandle(rect, hit.handle),
    };
    map.dragPan.disable();
    updateAirportSelectLayer();
    return true;
  }

  if (!app.airportAreaDrawMode) {
    return false;
  }

  app.airportRectInteraction = {
    kind: "draw",
    start: lngLat,
    current: lngLat,
  };
  map.dragPan.disable();
  updateAirportSelectLayer();
  return true;
}

export function updateAirportAreaInteraction(lngLat) {
  if (!app.airportRectInteraction) {
    return;
  }

  if (app.airportRectInteraction.kind === "draw") {
    app.airportRectInteraction.current = lngLat;
  } else if (app.airportRectInteraction.kind === "resize") {
    const { rectIndex, anchor } = app.airportRectInteraction;
    app.airportSelectRects[rectIndex] = normalizeAirportSelectRect(anchor, lngLat);
  }

  updateAirportSelectLayer();
}

export function finishAirportAreaInteraction(lngLat) {
  if (!app.airportRectInteraction) {
    return false;
  }

  if (app.airportRectInteraction.kind === "draw") {
    commitAirportSelectRect(lngLat);
  }

  cancelAirportRectInteraction();
  syncAirportAreaSelectUi();
  return true;
}

async function addAirportsFromSelectAreas() {
  if (app.airportSelectRects.length === 0) {
    hooks.setStatus("Draw one or more areas on the map first");
    return;
  }

  const pendingSeeds = hooks.getPendingSeeds();
  const existing = new Set(pendingSeeds.map((seed) => hooks.airportIdFromSeed(seed)));
  let added = 0;
  for (const rect of app.airportSelectRects) {
    const airports = getCachedAirportsInBounds(
      rect.west,
      rect.south,
      rect.east,
      rect.north
    );
    for (const airport of airports) {
      const seed = seedFromOpenAipAirport(airport, {
        label: formatAirportLabel(airport),
        source: "airport",
      });
      if (existing.has(seed.id)) {
        continue;
      }
      existing.add(seed.id);
      pendingSeeds.push(seed);
      added += 1;
    }
  }

  hooks.updateSeedMarkers();
  hooks.refreshCachedAirportMapLayer?.();
  const areaCount = app.airportSelectRects.length;
  clearAirportSelectAreas();
  exitAirportAreaSelectMode(true);
  if (added === 0) {
    hooks.setStatus(`No new airports in the drawn areas — cache cells or draw a larger area`);
  } else {
    hooks.setStatus(
      `Added ${added} airport${added === 1 ? "" : "s"} from ${areaCount} area${areaCount === 1 ? "" : "s"} — ${hooks.airportCountTotal(pendingSeeds.length)}`
    );
  }
}

function clearAirportSelectAreas() {
  app.airportSelectRects = [];
  app.airportAreaDrawMode = app.airportAreaSelectMode;
  cancelAirportRectInteraction();
  const map = hooks.getMap();
  if (app.airportSelectLayersReady && map.getSource("airport-select-areas")) {
    updateAirportSelectLayer();
  }
  syncAirportAreaSelectUi();
}
