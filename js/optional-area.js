import { gridBoundsLngLat } from "./geo.js";
import { isDebugMode } from "./params/panel.js";
import { dom } from "./dom.js";
import { raisePathLayer } from "./map/layers.js";
import { buildOptionalMask } from "./optional-area-mask.js";

const SOURCE_ID = "glide-optional";
const LAYER_ID = "glide-optional";
const OPTIONAL_GREEN = [46, 204, 113, 128];

let hooks;
let app;
let shaderRequestId = 0;

export function downwardMethod() {
  return app?.downwardMethod === "shader" ? "shader" : "dijkstra";
}

function syncDownwardMethodButton() {
  const button = dom.downwardMethodBtn;
  if (!button) {
    return;
  }
  const show = isDebugMode();
  button.hidden = !show;
  const shader = downwardMethod() === "shader";
  button.textContent = shader ? "S" : "D";
  button.setAttribute("aria-pressed", shader ? "true" : "false");
  button.setAttribute(
    "aria-label",
    shader ? "Downward cone method: shader" : "Downward cone method: Dijkstra"
  );
}

function maskFromArrivals(arrivals) {
  const mask = new Uint8Array(arrivals.length);
  for (let i = 0; i < arrivals.length; i += 1) {
    if (arrivals[i] >= 0) {
      mask[i] = 1;
    }
  }
  return mask;
}

export function readEmulatedAltitudeM() {
  const primary = Number.parseFloat(dom.emulatedAltitudeInput?.value ?? "");
  if (Number.isFinite(primary)) {
    return primary;
  }
  const menu = Number.parseFloat(dom.emulatedAltitudeMenuInput?.value ?? "");
  if (Number.isFinite(menu)) {
    return menu;
  }
  const fallback = Number.parseFloat(dom.fakeGeoAltitudeInput?.value ?? "");
  return Number.isFinite(fallback) ? fallback : null;
}

function writeEmulatedAltitude(value) {
  if (dom.emulatedAltitudeInput && dom.emulatedAltitudeInput.value !== value) {
    dom.emulatedAltitudeInput.value = value;
  }
  if (dom.emulatedAltitudeMenuInput && dom.emulatedAltitudeMenuInput.value !== value) {
    dom.emulatedAltitudeMenuInput.value = value;
  }
  if (dom.fakeGeoAltitudeInput && value !== "" && dom.fakeGeoAltitudeInput.value !== value) {
    dom.fakeGeoAltitudeInput.value = value;
  }
}

function onEmulatedAltitudeEdited(source) {
  writeEmulatedAltitude(source.value);
  const cell = app.lastInspectCell;
  if (cell && isDebugMode()) {
    refreshOptionalArea(cell);
  }
}

function maskToImageData(mask, width, height) {
  const image = new ImageData(width, height);
  const data = image.data;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] !== 1) {
      continue;
    }
    const p = i * 4;
    data[p] = OPTIONAL_GREEN[0];
    data[p + 1] = OPTIONAL_GREEN[1];
    data[p + 2] = OPTIONAL_GREEN[2];
    data[p + 3] = OPTIONAL_GREEN[3];
  }
  return image;
}

function overlayCoordinates(dem) {
  const coords = gridBoundsLngLat(dem.gx0, dem.gy0, dem.width, dem.height, dem.zoom);
  return [
    [coords[0].lng, coords[0].lat],
    [coords[1].lng, coords[1].lat],
    [coords[2].lng, coords[2].lat],
    [coords[3].lng, coords[3].lat],
  ];
}

export function clearOptionalArea() {
  const map = hooks?.getMap?.();
  if (!map) {
    return;
  }
  if (map.getLayer(LAYER_ID)) {
    map.removeLayer(LAYER_ID);
  }
  if (map.getSource(SOURCE_ID)) {
    map.removeSource(SOURCE_ID);
  }
}

function showOptionalImage(imageData, dem) {
  const map = hooks.getMap();
  if (!map) {
    return;
  }
  if (!app.optionalOverlayCanvas) {
    app.optionalOverlayCanvas = document.createElement("canvas");
  }
  app.optionalOverlayCanvas.width = imageData.width;
  app.optionalOverlayCanvas.height = imageData.height;
  app.optionalOverlayCanvas.getContext("2d").putImageData(imageData, 0, 0);
  const url = app.optionalOverlayCanvas.toDataURL();
  const coordinates = overlayCoordinates(dem);

  if (map.getSource(SOURCE_ID)) {
    map.getSource(SOURCE_ID).updateImage({ url, coordinates });
    raisePathLayer();
    return;
  }

  map.addSource(SOURCE_ID, { type: "image", url, coordinates });
  map.addLayer({
    id: LAYER_ID,
    type: "raster",
    source: SOURCE_ID,
    paint: { "raster-opacity": 1 },
  });
  raisePathLayer();
}

export function syncEmulatedAltitudeBox() {
  const box = dom.emulatedAltBoxEl;
  if (!box) {
    return;
  }
  const show = isDebugMode();
  box.hidden = !show;
  if (!show) {
    clearOptionalArea();
  }
}

function showDijkstraMask(cell, coneState, startAlt) {
  const { dem, altitudes, maxAltitude, glideRatio, groundClearance } = coneState;
  const mask = buildOptionalMask({
    dem,
    altitudes,
    maxAltitude,
    gi: cell.gi,
    gj: cell.gj,
    startAlt,
    glideRatio,
    groundClearance,
  });
  showOptionalImage(maskToImageData(mask, dem.width, dem.height), dem);
}

async function showShaderMask(cell, coneState, startAlt, requestId) {
  const engine = app.engine;
  if (!engine?.computeDownward) {
    hooks.setStatus?.("Shader optional area needs WebGPU");
    clearOptionalArea();
    return;
  }
  const { dem, altitudes, maxAltitude, glideRatio } = coneState;
  hooks.setStatus?.("Shader optional area…");
  try {
    const { arrivals, iterations } = await engine.computeDownward(dem, {
      glideRatio,
      maxAltitude,
      gi: cell.gi,
      gj: cell.gj,
      startAlt,
      coneAltitudes: altitudes,
    });
    if (requestId !== shaderRequestId) {
      return;
    }
    showOptionalImage(maskToImageData(maskFromArrivals(arrivals), dem.width, dem.height), dem);
    hooks.setStatus?.(`Shader optional area, ${iterations} iterations`);
  } catch (error) {
    if (requestId !== shaderRequestId) {
      return;
    }
    clearOptionalArea();
    hooks.setStatus?.(error?.message ?? "Shader optional area failed");
  }
}

export function refreshOptionalArea(cell) {
  shaderRequestId += 1;
  const requestId = shaderRequestId;
  if (!isDebugMode() || !cell) {
    clearOptionalArea();
    return;
  }
  const coneState = hooks.getConeState?.();
  const startAlt = readEmulatedAltitudeM();
  if (!coneState?.dem || !Number.isFinite(startAlt)) {
    clearOptionalArea();
    return;
  }
  if (downwardMethod() === "shader") {
    void showShaderMask(cell, coneState, startAlt, requestId);
    return;
  }
  showDijkstraMask(cell, coneState, startAlt);
}

export function initOptionalArea(h) {
  hooks = h;
  app = h.app;
  hooks.syncEmulatedAltitudeBox = syncEmulatedAltitudeBox;
  hooks.syncDownwardMethodButton = syncDownwardMethodButton;
  hooks.clearOptionalArea = clearOptionalArea;
  hooks.refreshOptionalArea = refreshOptionalArea;
  app.downwardMethod = app.downwardMethod === "shader" ? "shader" : "dijkstra";

  dom.downwardMethodBtn?.addEventListener("click", () => {
    app.downwardMethod = downwardMethod() === "shader" ? "dijkstra" : "shader";
    syncDownwardMethodButton();
    if (app.lastInspectCell) {
      refreshOptionalArea(app.lastInspectCell);
    }
  });

  dom.emulatedAltitudeInput?.addEventListener("input", () => {
    onEmulatedAltitudeEdited(dom.emulatedAltitudeInput);
  });
  dom.emulatedAltitudeMenuInput?.addEventListener("input", () => {
    onEmulatedAltitudeEdited(dom.emulatedAltitudeMenuInput);
  });

  dom.fakeGeoAltitudeInput?.addEventListener("input", () => {
    if (document.activeElement === dom.emulatedAltitudeInput || document.activeElement === dom.emulatedAltitudeMenuInput) {
      return;
    }
    writeEmulatedAltitude(dom.fakeGeoAltitudeInput.value);
  });

  syncEmulatedAltitudeBox();
  syncDownwardMethodButton();
}
