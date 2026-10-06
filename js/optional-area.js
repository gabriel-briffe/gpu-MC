import { gridBoundsLngLat } from "./geo.js";
import { getOptionalOverlayOpacity, isDebugMode } from "./params/panel.js";
import { dom } from "./dom.js";
import { raisePathLayer } from "./map/layers.js";
import { buildOptionalMask } from "./optional-area-mask.js";
import { ridgeEscapeSeed } from "./ridge-escape.js";
import { initIgcReplay, syncIgcReplayBar } from "./igc-replay-ui.js";
import { cellMarginT, marginHex, marginRgb } from "./glidecone/margin-color.js";
import { requiredAltitudeAt } from "./glidecone/route-style.js";
import { gridCellToLngLat, gridIndexFromLngLat } from "./geo.js";
import { bindLongPress } from "./ui/long-press.js";
import { isGlideConesEnabled } from "./app-menu.js";

const SOURCE_ID = "glide-optional";
const LAYER_ID = "glide-optional";
const PROBE_DEBOUNCE_MS = 400;

let hooks;
let app;
let shaderRequestId = 0;
let optionalKey = "";
let seenCone = null;
let coneSerial = 0;
let probeTimer = 0;
let probeToken = 0;

export function downwardMethod() {
  return app?.downwardMethod === "shader" ? "shader" : "dijkstra";
}

function syncFlightShaderButton() {
  const button = dom.flightShaderBtn;
  if (!button) {
    return;
  }
  const show = !isDebugMode() && isGlideConesEnabled() && app?.computeHardwareSupported !== false && !app?.cacheSelectMode;
  button.hidden = !show;
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

/** Green where descending arrival is still strictly above the upward cone. */
function maskFromArrivals(arrivals, altitudes, maxAltitude) {
  const mask = new Uint8Array(arrivals.length);
  for (let i = 0; i < arrivals.length; i += 1) {
    const cone = altitudes[i];
    if (!Number.isFinite(cone) || cone >= maxAltitude) {
      continue;
    }
    const arrival = arrivals[i];
    if (Number.isFinite(arrival) && arrival > cone) {
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

export function writeSimAltitudeM(meters) {
  if (!Number.isFinite(meters)) {
    return;
  }
  writeEmulatedAltitude(String(Math.round(meters)));
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
  if (!hooks.isGeoTrackingOn?.()) {
    hooks.updateGeoLocationPath?.();
  }
}

function paintOptionalImage(mask, arrivals, altitudes, maxAltitude, width, height) {
  let maxMargin = 0;
  const margins = new Float32Array(mask.length);
  if (arrivals && altitudes) {
    for (let i = 0; i < mask.length; i += 1) {
      if (mask[i] !== 1) {
        continue;
      }
      const cone = altitudes[i];
      const arrival = arrivals[i];
      if (!Number.isFinite(cone) || cone >= maxAltitude || !Number.isFinite(arrival)) {
        continue;
      }
      const margin = arrival - cone;
      margins[i] = margin;
      if (margin > maxMargin) {
        maxMargin = margin;
      }
    }
  }
  const image = new ImageData(width, height);
  const data = image.data;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] !== 1) {
      continue;
    }
    const t = maxMargin > 0 ? Math.max(0, Math.min(1, margins[i] / maxMargin)) : 0;
    const [r, g, b] = marginRgb(t);
    const p = i * 4;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = 255;
  }
  return { image, maxMargin };
}

const OPTIONAL_VIZ_HINTS = {
  margin: "Largest margin above the cone is green, zero is red.",
  degraded: "Still reachable at 20% less L/D is green. Lost only at 20% less is yellow. Lost at 10% less is red.",
};

export function optionalVizMode() {
  return dom.optionalVizSelect?.value === "degraded" ? "degraded" : "margin";
}

function syncOptionalVizHint() {
  if (dom.optionalVizHintEl) {
    dom.optionalVizHintEl.textContent = OPTIONAL_VIZ_HINTS[optionalVizMode()];
  }
}

function fieldMaxMargin(mask, arrivals, altitudes, maxAltitude) {
  let maxMargin = 0;
  if (!mask || !arrivals || !altitudes) {
    return maxMargin;
  }
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] !== 1) {
      continue;
    }
    const cone = altitudes[i];
    const arrival = arrivals[i];
    if (!Number.isFinite(cone) || cone >= maxAltitude || !Number.isFinite(arrival)) {
      continue;
    }
    const margin = arrival - cone;
    if (margin > maxMargin) {
      maxMargin = margin;
    }
  }
  return maxMargin;
}

/** Full cone, then the part lost at 10% less L/D, then the part lost at 20% less. */
function paintDegradedImage(fullMask, mask10, mask20, width, height) {
  const image = new ImageData(width, height);
  const data = image.data;
  const red = marginRgb(0);
  const yellow = marginRgb(0.5);
  const green = marginRgb(1);
  for (let i = 0; i < fullMask.length; i += 1) {
    if (fullMask[i] !== 1) {
      continue;
    }
    let rgb = green;
    if (mask20?.[i] === 1) {
      rgb = green;
    } else if (mask10?.[i] === 1) {
      rgb = yellow;
    } else {
      rgb = red;
    }
    const p = i * 4;
    data[p] = rgb[0];
    data[p + 1] = rgb[1];
    data[p + 2] = rgb[2];
    data[p + 3] = 255;
  }
  return image;
}

export function optionAreaCellColor(idx) {
  const field = app?.optionalField;
  const cone = hooks?.getConeState?.();
  if (!field || !cone || !Number.isInteger(idx) || field.mask?.[idx] !== 1) {
    return null;
  }
  if (optionalVizMode() === "degraded") {
    if (field.mask20?.[idx] === 1) {
      return marginHex(1);
    }
    if (field.mask10?.[idx] === 1) {
      return marginHex(0.5);
    }
    return marginHex(0);
  }
  if (!(field.maxMargin > 0)) {
    return null;
  }
  const t = cellMarginT(field.arrivals?.[idx], cone.altitudes?.[idx], cone.maxAltitude, field.maxMargin);
  return marginHex(t);
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
  shaderRequestId += 1;
  optionalKey = "";
  if (app) {
    app.optionalField = null;
  }
  clearProbeArrival();
  hooks?.clearArrivalPaths?.();
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

  const opacity = getOptionalOverlayOpacity();
  if (map.getSource(SOURCE_ID)) {
    map.getSource(SOURCE_ID).updateImage({ url, coordinates });
    if (map.getLayer(LAYER_ID)) {
      map.setPaintProperty(LAYER_ID, "raster-opacity", opacity);
    }
    raisePathLayer();
    return;
  }

  map.addSource(SOURCE_ID, { type: "image", url, coordinates });
  map.addLayer({
    id: LAYER_ID,
    type: "raster",
    source: SOURCE_ID,
    paint: { "raster-opacity": opacity },
  });
  raisePathLayer();
}

function setSimManualOpen(open) {
  const manual = dom.simManualEl;
  const button = dom.simHelpBtn;
  if (!manual) {
    return;
  }
  manual.hidden = !open;
  button?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    dom.simManualCloseBtn?.focus();
  }
}

export function syncEmulatedAltitudeBox() {
  const box = dom.emulatedAltBoxEl;
  if (!box) {
    return;
  }
  const cache = Boolean(app?.cacheSelectMode);
  const sim = !cache && !hooks.isGeoTrackingOn?.();
  const show = !cache && (isDebugMode() || sim);
  box.hidden = !show;
  document.body.classList.toggle("sim-mode", Boolean(sim && show));
  if (dom.simHelpBtn) {
    dom.simHelpBtn.hidden = !sim;
  }
  syncIgcReplayBar(sim);
  if (!sim) {
    setSimManualOpen(false);
  }
}

function preferShader() {
  if (isDebugMode()) {
    return downwardMethod() === "shader";
  }
  return app?.computeHardwareSupported !== false && Boolean(app?.engine?.computeDownward);
}

function gridIndexLngLat(gi, gj, dem) {
  return gridCellToLngLat(gi, gj, dem);
}

function optionsSeed(cell, startAlt, coneState, glideRatio = coneState.glideRatio) {
  const decision = ridgeEscapeSeed({
    dem: coneState.dem,
    altitudes: coneState.altitudes,
    originX: coneState.originX,
    originY: coneState.originY,
    ground: coneState.ground,
    maxAltitude: coneState.maxAltitude,
    gi: cell.gi,
    gj: cell.gj,
    startAlt,
    glideRatio,
  });
  if (decision.kind === "none") {
    return null;
  }
  if (decision.kind === "escape") {
    return {
      cell: { gi: decision.gi, gj: decision.gj },
      startAlt: decision.arrival,
      escape: decision,
    };
  }
  return { cell, startAlt, escape: null };
}

async function computeField(cell, startAlt, coneState, glideRatio = coneState.glideRatio) {
  const { dem, altitudes, maxAltitude, groundClearance } = coneState;
  if (preferShader()) {
    try {
      const { arrivals, originX, originY, iterations } = await app.engine.computeDownward(dem, {
        glideRatio,
        maxAltitude,
        gi: cell.gi,
        gj: cell.gj,
        startAlt,
        coneAltitudes: altitudes,
      });
      return {
        mask: maskFromArrivals(arrivals, altitudes, maxAltitude),
        arrivals,
        originX,
        originY,
        iterations,
        shader: true,
      };
    } catch (error) {
      if (isDebugMode()) {
        throw error;
      }
    }
  }
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
  return {
    mask,
    arrivals: mask.arrivals,
    originX: mask.originX,
    originY: mask.originY,
    iterations: 0,
    shader: false,
  };
}

const OPTIONS_ENABLED_KEY = "gpu-mc-options-enabled";
let lastOptionsMs = null;
let readoutToken = 0;

function optionsEnabled() {
  return dom.optionsEnabledInput?.checked !== false;
}

function formatMargin(aircraft) {
  if (!aircraft || aircraft.outside || !Number.isFinite(aircraft.alt) || !aircraft.cone) {
    return "—";
  }
  // Same as XCSoar's InfoBox: on ground cells walk back to the first air cell
  // and add distance / L/D, so the ridge does not show a huge negative margin.
  const proof = requiredAltitudeAt(aircraft.gi, aircraft.gj, aircraft.cone);
  if (!Number.isFinite(proof)) {
    return "no cone";
  }
  const margin = Math.round(aircraft.alt - proof);
  return `${margin > 0 ? "+" : ""}${margin} m`;
}

function paintSimReadout(aircraft) {
  const el = dom.simReadoutEl;
  if (!el) {
    return;
  }
  const timing = lastOptionsMs == null ? "—" : `${Math.round(lastOptionsMs)} ms`;
  el.textContent = optionsEnabled()
    ? `Margin ${formatMargin(aircraft)} · Options ${timing}`
    : `Margin ${formatMargin(aircraft)} · Options off`;
}

function finishOptionsTiming(token, startedAt) {
  const apply = () => {
    if (token !== readoutToken) {
      return;
    }
    lastOptionsMs = performance.now() - startedAt;
    paintSimReadout(resolveAircraft());
  };
  apply();
  requestAnimationFrame(() => requestAnimationFrame(apply));
}
function resolveAircraft() {
  const cone = hooks.getConeState?.();
  if (!cone?.dem) {
    return null;
  }
  let lng;
  let lat;
  let alt;
  let source;
  if (hooks.isGeoTrackingOn?.()) {
    const position = hooks.getLastGeoLngLat?.();
    if (!position) {
      return null;
    }
    lng = position.lng;
    lat = position.lat;
    alt = app.lastGeoAltitude;
    source = "gps";
  } else if (app.simGlider) {
    lng = app.simGlider.lng;
    lat = app.simGlider.lat;
    alt = readEmulatedAltitudeM();
    source = "sim";
  } else {
    return null;
  }
  const { gi, gj } = gridIndexFromLngLat(lng, lat, cone.dem);
  if (gi < 0 || gj < 0 || gi >= cone.dem.width || gj >= cone.dem.height) {
    return { outside: true };
  }
  return { gi, gj, lng, lat, alt, source, cone };
}

export function clearProbeArrival() {
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = 0;
  }
  probeToken += 1;
  hooks?.setProbeArrivalPath?.(null);
}

export function scheduleProbeArrival(cell) {
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = 0;
  }
  const token = ++probeToken;
  const coneState = hooks.getConeState?.();
  const field = app.optionalField;
  const dem = coneState?.dem;
  hooks?.setProbeArrivalPath?.(null);
  if (!cell || !field?.mask || !dem) {
    return;
  }
  const idx = cell.gj * dem.width + cell.gi;
  const startAlt = field.arrivals?.[idx];
  if (field.mask[idx] !== 1 || !Number.isFinite(startAlt)) {
    return;
  }
  probeTimer = setTimeout(() => {
    probeTimer = 0;
    void runProbeArrival(token, cell, startAlt, coneState);
  }, PROBE_DEBOUNCE_MS);
}

async function runProbeArrival(token, cell, startAlt, coneState) {
  if (token !== probeToken) {
    return;
  }
  try {
    const liveCone = hooks.getConeState?.() ?? coneState;
    const field = await computeField(cell, startAlt, liveCone);
    if (token !== probeToken || !field) {
      return;
    }
    const pointer = app.lastInspectLngLat;
    hooks.setProbeArrivalPath?.({
      ...field,
      startGi: cell.gi,
      startGj: cell.gj,
      startLng: pointer?.lng,
      startLat: pointer?.lat,
    });
  } catch {
    if (token === probeToken) {
      hooks.setProbeArrivalPath?.(null);
    }
  }
}

let optionsBusy = false;
let queuedRefresh = null;

function waitForDisplayed() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

export async function refreshOptionalArea({ force = false } = {}) {
  if (optionsBusy) {
    queuedRefresh = { force: Boolean(queuedRefresh?.force || force) };
    return;
  }
  optionsBusy = true;
  let waitForPaint = false;
  try {
    waitForPaint = await runOptionalRefresh({ force });
    if (waitForPaint) {
      await waitForDisplayed();
    }
  } finally {
    optionsBusy = false;
    const next = queuedRefresh;
    queuedRefresh = null;
    if (next) {
      void refreshOptionalArea(next);
    }
  }
}

async function runOptionalRefresh({ force = false } = {}) {
  const aircraft = resolveAircraft();
  paintSimReadout(aircraft);
  if (!optionsEnabled()) {
    if (app?.optionalField || optionalKey) {
      clearOptionalArea();
    }
    return false;
  }
  if (!aircraft || aircraft.outside || !Number.isFinite(aircraft.alt)) {
    if (app?.optionalField || optionalKey) {
      clearOptionalArea();
    }
    return false;
  }
  if (aircraft.cone !== seenCone) {
    seenCone = aircraft.cone;
    coneSerial += 1;
  }
  const method = preferShader() ? "shader" : "dijkstra";
  const viz = optionalVizMode();
  const bucket = aircraft.source === "gps" ? Math.round(aircraft.alt / 30) : Math.round(aircraft.alt);
  const key = `${viz}:${method}:${coneSerial}:${aircraft.gi},${aircraft.gj}:${bucket}`;
  if (!force && key === optionalKey) {
    return false;
  }
  optionalKey = key;
  shaderRequestId += 1;
  const requestId = shaderRequestId;
  const startedAt = performance.now();
  readoutToken += 1;
  const timingToken = readoutToken;
  const { cone } = aircraft;
  try {
    const seed = optionsSeed({ gi: aircraft.gi, gj: aircraft.gj }, aircraft.alt, cone);
    if (!seed) {
      clearOptionalArea();
      finishOptionsTiming(timingToken, startedAt);
      hooks.setStatus?.("Below the cone, no ridge escape");
      return true;
    }
    const field = await computeField(seed.cell, seed.startAlt, cone);
    if (requestId !== shaderRequestId || !field) {
      return true;
    }
    let mask10 = null;
    let mask20 = null;
    let image;
    if (viz === "degraded" && cone.glideRatio > 0) {
      hooks.setStatus?.("Optional area, degraded masks…");
      const seed10 = optionsSeed({ gi: aircraft.gi, gj: aircraft.gj }, aircraft.alt, cone, cone.glideRatio * 0.9);
      const degraded10 = seed10 ? await computeField(seed10.cell, seed10.startAlt, cone, cone.glideRatio * 0.9) : null;
      if (requestId !== shaderRequestId) {
        return true;
      }
      const seed20 = optionsSeed({ gi: aircraft.gi, gj: aircraft.gj }, aircraft.alt, cone, cone.glideRatio * 0.8);
      const degraded20 = seed20 ? await computeField(seed20.cell, seed20.startAlt, cone, cone.glideRatio * 0.8) : null;
      if (requestId !== shaderRequestId) {
        return true;
      }
      mask10 = degraded10.mask;
      mask20 = degraded20.mask;
      image = paintDegradedImage(field.mask, mask10, mask20, cone.dem.width, cone.dem.height);
    } else {
      image = paintOptionalImage(
        field.mask,
        field.arrivals,
        cone.altitudes,
        cone.maxAltitude,
        cone.dem.width,
        cone.dem.height
      ).image;
    }
    const escape = seed.escape;
    const escapePt = escape ? gridIndexLngLat(escape.gi, escape.gj, cone.dem) : null;
    app.optionalField = {
      ...field,
      startGi: escape ? escape.gi : aircraft.gi,
      startGj: escape ? escape.gj : aircraft.gj,
      startLng: escapePt?.lng ?? aircraft.lng,
      startLat: escapePt?.lat ?? aircraft.lat,
      gliderLng: aircraft.lng,
      gliderLat: aircraft.lat,
      escapeCells: escape?.cells ?? null,
      maxMargin: fieldMaxMargin(field.mask, field.arrivals, cone.altitudes, cone.maxAltitude),
      mask10,
      mask20,
    };
    showOptionalImage(image, cone.dem);
    hooks.setAircraftArrivalPath?.(app.optionalField);
    if (field.shader && aircraft.source !== "gps") {
      hooks.setStatus?.(
        viz === "degraded" ? "Optional area, degraded masks" : `Optional area, ${field.iterations} iterations`
      );
    }
    if (app.lastInspectCell) {
      scheduleProbeArrival(app.lastInspectCell);
    }
    finishOptionsTiming(timingToken, startedAt);
    return true;
  } catch (error) {
    if (requestId !== shaderRequestId) {
      return true;
    }
    clearOptionalArea();
    hooks.setStatus?.(error?.message ?? "Optional area failed");
    finishOptionsTiming(timingToken, startedAt);
    return true;
  }
}

export function initOptionalArea(h) {
  hooks = h;
  app = h.app;
  hooks.syncEmulatedAltitudeBox = syncEmulatedAltitudeBox;
  hooks.syncDownwardMethodButton = syncDownwardMethodButton;
  hooks.syncFlightShaderButton = syncFlightShaderButton;
  hooks.clearOptionalArea = clearOptionalArea;
  hooks.refreshOptionalArea = refreshOptionalArea;
  app.downwardMethod = app.downwardMethod === "shader" ? "shader" : "dijkstra";

  dom.downwardMethodBtn?.addEventListener("click", () => {
    app.downwardMethod = downwardMethod() === "shader" ? "dijkstra" : "shader";
    syncDownwardMethodButton();
    void refreshOptionalArea({ force: true });
  });

  dom.optionsEnabledInput?.addEventListener("change", () => {
    try {
      localStorage.setItem(OPTIONS_ENABLED_KEY, optionsEnabled() ? "1" : "0");
    } catch {
      // Private mode can reject storage; the checkbox still applies.
    }
    void refreshOptionalArea({ force: true });
  });
  try {
    if (localStorage.getItem(OPTIONS_ENABLED_KEY) === "0" && dom.optionsEnabledInput) {
      dom.optionsEnabledInput.checked = false;
    }
  } catch {
    // Ignore storage reads that are blocked.
  }

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

  bindLongPress(dom.flightShaderBtn, {
    onShort: () => {
      void recomputeFlightShaderArea();
    },
    onLong: () => {
      hooks.openGlideSettings?.({ scrollToOptionalViz: true });
    },
  });

  dom.simHelpBtn?.addEventListener("click", () => {
    setSimManualOpen(dom.simManualEl?.hidden !== false);
  });
  dom.simManualBackdropEl?.addEventListener("click", () => {
    setSimManualOpen(false);
  });
  dom.simManualCloseBtn?.addEventListener("click", () => {
    setSimManualOpen(false);
    dom.simHelpBtn?.focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dom.simManualEl && !dom.simManualEl.hidden) {
      setSimManualOpen(false);
      dom.simHelpBtn?.focus();
    }
  });

  dom.optionalVizSelect?.addEventListener("change", () => {
    syncOptionalVizHint();
    void refreshOptionalArea({ force: true });
  });

  initIgcReplay(hooks);
  syncEmulatedAltitudeBox();
  syncDownwardMethodButton();
  syncFlightShaderButton();
  syncOptionalVizHint();
}

async function recomputeFlightShaderArea() {
  if (isDebugMode() || !isGlideConesEnabled()) {
    return;
  }
  const coneState = hooks.getConeState?.();
  if (!coneState?.dem) {
    hooks.setStatus?.("Compute a glide cone first");
    return;
  }
  const tracking = hooks.isGeoTrackingOn?.();
  const alt = tracking ? app.lastGeoAltitude : readEmulatedAltitudeM();
  if (!Number.isFinite(alt) || (tracking ? !hooks.getLastGeoLngLat?.() : !app.simGlider)) {
    hooks.setStatus?.(tracking ? "Need a current altitude" : "Set an altitude, then click the map to place the glider");
    return;
  }
  dom.flightShaderBtn?.classList.add("is-busy");
  await refreshOptionalArea({ force: true });
  dom.flightShaderBtn?.classList.remove("is-busy");
}
