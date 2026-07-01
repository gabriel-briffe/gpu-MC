import { gridCellToLngLat } from "../geo.js";
import { isDebugMode } from "../params/panel.js";

const MIN_RECT_DEG = 1e-5;

let hooks;
let app;

function normalizeRect(a, b) {
  return {
    west: Math.min(a.lng, b.lng),
    east: Math.max(a.lng, b.lng),
    south: Math.min(a.lat, b.lat),
    north: Math.max(a.lat, b.lat),
  };
}

function rectRing(rect) {
  const { west, south, east, north } = rect;
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

function cellInRect(gi, gj, rect, dem) {
  const { lng, lat } = gridCellToLngLat(gi, gj, dem);
  return lng >= rect.west && lng <= rect.east && lat >= rect.south && lat <= rect.north;
}

function groundElevationAtCell(idx, dem) {
  const elev = dem.terrainMsl
    ? dem.terrainMsl[idx]
    : dem.elevation[idx] - dem.groundClearance;
  return Number.isFinite(elev) ? Math.round(elev) : null;
}

function buildMatricesForRect(rect) {
  const coneState = hooks.getConeState();
  if (!coneState) {
    return null;
  }

  const { dem, altitudes, originX, originY, maxAltitude } = coneState;
  let giMin = dem.width;
  let giMax = -1;
  let gjMin = dem.height;
  let gjMax = -1;

  for (let gj = 0; gj < dem.height; gj += 1) {
    for (let gi = 0; gi < dem.width; gi += 1) {
      if (!cellInRect(gi, gj, rect, dem)) {
        continue;
      }
      giMin = Math.min(giMin, gi);
      giMax = Math.max(giMax, gi);
      gjMin = Math.min(gjMin, gj);
      gjMax = Math.max(gjMax, gj);
    }
  }

  if (giMax < giMin || gjMax < gjMin) {
    return null;
  }

  const minAltitude = [];
  const origin = [];
  const groundElevation = [];

  for (let gj = gjMin; gj <= gjMax; gj += 1) {
    const altRow = [];
    const originRow = [];
    const groundRow = [];
    for (let gi = giMin; gi <= giMax; gi += 1) {
      if (!cellInRect(gi, gj, rect, dem)) {
        altRow.push(null);
        originRow.push(null);
        groundRow.push(null);
        continue;
      }
      const idx = gj * dem.width + gi;
      const ox = originX[idx];
      const oy = originY[idx];
      const alt = altitudes[idx];
      const reachable = ox >= 0 && oy >= 0 && Number.isFinite(alt) && alt < maxAltitude;
      altRow.push(reachable ? Math.round(alt) : null);
      originRow.push(reachable ? [ox, oy] : null);
      groundRow.push(groundElevationAtCell(idx, dem));
    }
    minAltitude.push(altRow);
    origin.push(originRow);
    groundElevation.push(groundRow);
  }

  return {
    cellRange: { giMin, giMax, gjMin, gjMax },
    rows: gjMax - gjMin + 1,
    cols: giMax - giMin + 1,
    minAltitude,
    origin,
    groundElevation,
  };
}

async function copyMatricesToClipboard(payload) {
  const text = JSON.stringify(payload, null, 2);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function ensureMatrixExtractLayers() {
  const map = hooks.getMap();
  if (!map || app.matrixExtractLayersReady) {
    return;
  }

  map.addSource("matrix-extract-area", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "matrix-extract-area-fill",
    type: "fill",
    source: "matrix-extract-area",
    paint: {
      "fill-color": "#e6a817",
      "fill-opacity": 0.18,
    },
  });

  map.addLayer({
    id: "matrix-extract-area-line",
    type: "line",
    source: "matrix-extract-area",
    paint: {
      "line-color": "#e6a817",
      "line-width": 2,
      "line-dasharray": [2, 2],
    },
  });

  app.matrixExtractLayersReady = true;
}

function updateMatrixExtractLayer() {
  const map = hooks.getMap();
  if (!app.matrixExtractLayersReady || !map?.getSource("matrix-extract-area")) {
    return;
  }

  const features = [];
  const interaction = app.matrixExtractInteraction;
  if (interaction?.kind === "draw") {
    const rect = normalizeRect(interaction.start, interaction.current);
    features.push({
      type: "Feature",
      properties: { preview: true },
      geometry: { type: "Polygon", coordinates: [rectRing(rect)] },
    });
  }

  map.getSource("matrix-extract-area").setData({
    type: "FeatureCollection",
    features,
  });
}

function clearMatrixExtractLayer() {
  const map = hooks.getMap();
  if (!app.matrixExtractLayersReady || !map?.getSource("matrix-extract-area")) {
    return;
  }
  map.getSource("matrix-extract-area").setData({
    type: "FeatureCollection",
    features: [],
  });
}

function syncMatrixExtractCursor() {
  const map = hooks.getMap();
  if (!map?.getCanvas()) {
    return;
  }
  if (app.matrixExtractMode && !app.matrixExtractInteraction) {
    map.getCanvas().style.cursor = "crosshair";
  } else if (!hooks.getAirportAreaSelectMode?.() && !hooks.getManualAirportSelectMode?.()) {
    map.getCanvas().style.cursor = "";
  }
}

export function getMatrixExtractMode() {
  return app.matrixExtractMode;
}

export function hasMatrixExtractInteraction() {
  return Boolean(app.matrixExtractInteraction);
}

export function exitMatrixExtractMode() {
  if (!app.matrixExtractMode) {
    return;
  }
  app.matrixExtractMode = false;
  app.matrixExtractInteraction = null;
  const map = hooks.getMap();
  if (map?.dragPan?.isEnabled() === false) {
    map.dragPan.enable();
  }
  clearMatrixExtractLayer();
  syncMatrixExtractCursor();
  hooks.syncExtractMatrixButton?.();
}

export function enterMatrixExtractMode() {
  if (!isDebugMode() || !hooks.getConeState() || hooks.isComputing()) {
    return;
  }
  if (hooks.getManualAirportSelectMode?.()) {
    hooks.exitManualAirportSelectMode(false);
  }
  if (hooks.getAirportAreaSelectMode?.()) {
    hooks.exitAirportAreaSelectMode(false);
  }
  app.matrixExtractMode = true;
  app.matrixExtractInteraction = null;
  ensureMatrixExtractLayers();
  clearMatrixExtractLayer();
  syncMatrixExtractCursor();
  hooks.syncExtractMatrixButton?.();
  hooks.setStatus("Draw a rectangle on the map to extract min altitude, origin, and ground elevation matrices");
}

async function commitMatrixExtractRect(lngLat) {
  const interaction = app.matrixExtractInteraction;
  if (!interaction || interaction.kind !== "draw") {
    return false;
  }

  const rect = normalizeRect(interaction.start, lngLat);
  if (rect.east - rect.west < MIN_RECT_DEG || rect.north - rect.south < MIN_RECT_DEG) {
    hooks.setStatus("Draw a larger area");
    return false;
  }

  const payload = buildMatricesForRect(rect);
  if (!payload) {
    hooks.setStatus("No grid cells in the selected area");
    return false;
  }

  try {
    await copyMatricesToClipboard(payload);
    hooks.setStatus(
      `Copied ${payload.cols}×${payload.rows} matrices (min altitude, origin, ground elevation) to clipboard`
    );
  } catch (error) {
    hooks.setStatus(`Clipboard copy failed: ${error.message}`);
    console.error(error);
    return false;
  }

  exitMatrixExtractMode();
  return true;
}

export function beginMatrixExtractInteraction(lngLat) {
  if (!app.matrixExtractMode || hooks.isComputing()) {
    return false;
  }
  const map = hooks.getMap();
  app.matrixExtractInteraction = {
    kind: "draw",
    start: lngLat,
    current: lngLat,
  };
  map.dragPan.disable();
  updateMatrixExtractLayer();
  return true;
}

export function updateMatrixExtractInteraction(lngLat) {
  if (!app.matrixExtractInteraction) {
    return;
  }
  app.matrixExtractInteraction.current = lngLat;
  updateMatrixExtractLayer();
}

export function finishMatrixExtractInteraction(lngLat) {
  if (!app.matrixExtractInteraction) {
    return false;
  }
  void commitMatrixExtractRect(lngLat);
  app.matrixExtractInteraction = null;
  const map = hooks.getMap();
  map.dragPan.enable();
  updateMatrixExtractLayer();
  syncMatrixExtractCursor();
  return true;
}

export function cancelMatrixExtractInteraction() {
  if (!app.matrixExtractInteraction) {
    return;
  }
  app.matrixExtractInteraction = null;
  const map = hooks.getMap();
  if (map?.dragPan?.isEnabled() === false) {
    map.dragPan.enable();
  }
  clearMatrixExtractLayer();
  syncMatrixExtractCursor();
}

export function initMatrixExtract(h) {
  hooks = h;
  app = h.app;
  hooks.getMatrixExtractMode = getMatrixExtractMode;
  hooks.exitMatrixExtractMode = exitMatrixExtractMode;
  hooks.hasMatrixExtractInteraction = hasMatrixExtractInteraction;
  hooks.beginMatrixExtractInteraction = beginMatrixExtractInteraction;
  hooks.updateMatrixExtractInteraction = updateMatrixExtractInteraction;
  hooks.finishMatrixExtractInteraction = finishMatrixExtractInteraction;
  hooks.cancelMatrixExtractInteraction = cancelMatrixExtractInteraction;

  hooks.extractMatrixBtn?.addEventListener("click", () => {
    if (app.matrixExtractMode) {
      exitMatrixExtractMode();
      hooks.setStatus("");
      return;
    }
    enterMatrixExtractMode();
  });
}
