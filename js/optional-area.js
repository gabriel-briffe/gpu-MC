import { gridBoundsLngLat } from "./geo.js";
import { getOptionalOverlayOpacity, isDebugMode } from "./params/panel.js";
import { dom } from "./dom.js";
import { raisePathLayer } from "./map/layers.js";
import { replaceImageObjectUrl, revokeImageObjectUrl } from "./map/image-data-url.js";
import { buildOptionalMask } from "./optional-area-mask.js";
import { ridgeEscapeSeed } from "./ridge-escape.js";
import { initIgcReplay, isIgcPlaying, isIgcReplayOn } from "./igc-replay-ui.js";
import { cellMarginT, marginHex, marginRgb } from "./glidecone/margin-color.js";
import { requiredAltitudeAt } from "./glidecone/route-style.js";
import { gridCellToLngLat, gridIndexFromLngLat } from "./geo.js";
import { isFlightSession, isSimulatorSession, isViewerSession, sessionHasAircraft } from "./session-mode.js";

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

/** Floors depend on L/D (proof = air + distance / L/D); key by milliratio. */
function optionsFloorsCacheKey(glideRatio) {
  return Math.round(glideRatio * 1000);
}

/**
 * Options floor heights: stored cone on air cells; on ground cells the walked-back
 * proof altitude when it is lower than stored terrain (so a clear ridge can seed).
 * Cached on the cone — rebuilt only when the cone or L/D tier changes.
 */
function optionsConeFloors(coneState, glideRatio) {
  if (!coneState || !(glideRatio > 0)) {
    return coneState?.altitudes ? Float32Array.from(coneState.altitudes) : null;
  }
  if (!coneState.optionsFloorsByLd) {
    coneState.optionsFloorsByLd = new Map();
  }
  const key = optionsFloorsCacheKey(glideRatio);
  const cached = coneState.optionsFloorsByLd.get(key);
  if (cached) {
    return cached;
  }

  const { dem, altitudes, ground, originX, originY, maxAltitude, circuitHeight } = coneState;
  const floors = Float32Array.from(altitudes);
  if (!dem || !ground || !originX || !originY) {
    coneState.optionsFloorsByLd.set(key, floors);
    return floors;
  }
  const ctx = {
    dem,
    altitudes,
    ground,
    originX,
    originY,
    maxAltitude,
    glideRatio,
    circuitHeight,
  };
  const width = dem.width;
  for (let i = 0; i < floors.length; i += 1) {
    if (ground[i] !== 1) {
      continue;
    }
    const stored = altitudes[i];
    if (!Number.isFinite(stored) || stored >= maxAltitude) {
      continue;
    }
    const proof = requiredAltitudeAt(i % width, (i / width) | 0, ctx);
    if (Number.isFinite(proof) && proof < stored) {
      floors[i] = proof;
    }
  }
  coneState.optionsFloorsByLd.set(key, floors);
  return floors;
}

export function readEmulatedAltitudeM() {
  const value = Number.parseFloat(dom.emulatedAltitudeInput?.value ?? "");
  return Number.isFinite(value) ? value : null;
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
}

function onEmulatedAltitudeEdited(source) {
  writeEmulatedAltitude(source.value);
  if (isSimulatorSession()) {
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
  margin:
    "Largest margin above the cone is green, zero is red. On the ground, margin is above proof altitude.",
  degraded: "Still reachable at 20% less L/D is green. Lost only at 20% less is yellow. Lost at 10% less is red.",
};

export function optionalVizMode() {
  return dom.optionalVizSelect?.value === "degraded" ? "degraded" : "margin";
}

function syncOptionalVizHint() {
  if (dom.optionalVizHintEl) {
    dom.optionalVizHintEl.textContent = OPTIONAL_VIZ_HINTS[optionalVizMode()];
  }
  syncDegradedLegend();
}

function formatLdValue(n) {
  if (!Number.isFinite(n) || n <= 0) {
    return "—";
  }
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function syncDegradedLegend() {
  const el = dom.optionsDegradedLegendEl;
  if (!el) {
    return;
  }
  const show =
    sessionHasAircraft() &&
    optionalVizMode() === "degraded" &&
    !app?.cacheSelectMode;
  el.hidden = !show;
  if (!show) {
    return;
  }
  const ld = Number.parseFloat(document.getElementById("ld")?.value ?? "");
  const values = el.querySelectorAll(".options-degraded-legend-value");
  if (values.length < 3) {
    return;
  }
  values[0].textContent = formatLdValue(ld * 0.8);
  values[1].textContent = formatLdValue(ld * 0.9);
  values[2].textContent = formatLdValue(ld);
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
  // Margin vs proof floor on ground (same buffer used for options reachability).
  const floor = field.floors?.[idx] ?? cone.altitudes?.[idx];
  const t = cellMarginT(field.arrivals?.[idx], floor, cone.maxAltitude, field.maxMargin);
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
  paintSimReadout();
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
  revokeImageObjectUrl(app.optionalOverlayImageUrl);
  app.optionalOverlayImageUrl = null;
}

function showOptionalImage(imageData, dem) {
  const map = hooks.getMap();
  if (!map) {
    return;
  }
  const url = replaceImageObjectUrl(app.optionalOverlayImageUrl, imageData);
  app.optionalOverlayImageUrl = url;
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
  hooks.syncSessionModeUi?.();
}

function summarizeEscape(decision) {
  if (!decision || decision.kind !== "escape") {
    return decision ?? null;
  }
  const cells = decision.cells ?? [];
  const maxCells = 48;
  return {
    kind: decision.kind,
    gi: decision.gi,
    gj: decision.gj,
    arrival: decision.arrival,
    cellCount: cells.length,
    cells:
      cells.length <= maxCells
        ? cells
        : [...cells.slice(0, 24), { truncated: cells.length - 48 }, ...cells.slice(-24)],
  };
}

function cellDebugAt(gi, gj, cone) {
  const dem = cone?.dem;
  if (!dem || gi < 0 || gj < 0 || gi >= dem.width || gj >= dem.height) {
    return null;
  }
  const idx = gj * dem.width + gi;
  const stored = cone.altitudes?.[idx];
  const ox = cone.originX?.[idx];
  const oy = cone.originY?.[idx];
  const nextIdx =
    Number.isInteger(ox) && Number.isInteger(oy) && ox >= 0 && oy >= 0
      ? oy * dem.width + ox
      : null;
  return {
    gi,
    gj,
    idx,
    isGround: cone.ground?.[idx] === 1,
    storedAlt: Number.isFinite(stored) && stored < cone.maxAltitude ? stored : null,
    groundElev: dem.terrainMsl
      ? dem.terrainMsl[idx]
      : dem.elevation?.[idx] != null
        ? dem.elevation[idx] - dem.groundClearance
        : null,
    origin: ox >= 0 && oy >= 0 ? { gi: ox, gj: oy } : null,
    nextIsGround: nextIdx == null ? null : cone.ground?.[nextIdx] === 1,
    nextStoredAlt:
      nextIdx == null
        ? null
        : Number.isFinite(cone.altitudes?.[nextIdx]) && cone.altitudes[nextIdx] < cone.maxAltitude
          ? cone.altitudes[nextIdx]
          : null,
  };
}

export function buildSimGliderDebugSnapshot() {
  const aircraft = resolveAircraft();
  const cone = aircraft?.cone ?? hooks.getConeState?.();
  const field = app?.optionalField;
  if (!aircraft || aircraft.outside || !cone?.dem) {
    return {
      kind: "gpu-mc-sim-glider-debug",
      version: 1,
      error: !cone?.dem ? "no-cone" : aircraft?.outside ? "outside-cone-grid" : "no-glider",
      glider: app?.simGlider ?? null,
      altitude: readEmulatedAltitudeM(),
      igcReplay: isIgcReplayOn(),
    };
  }

  const cell = cellDebugAt(aircraft.gi, aircraft.gj, cone);
  const proof = requiredAltitudeAt(aircraft.gi, aircraft.gj, cone);
  const decision = ridgeEscapeSeed({
    dem: cone.dem,
    altitudes: cone.altitudes,
    originX: cone.originX,
    originY: cone.originY,
    ground: cone.ground,
    maxAltitude: cone.maxAltitude,
    gi: aircraft.gi,
    gj: aircraft.gj,
    startAlt: aircraft.alt,
    glideRatio: cone.glideRatio,
    proofAltitude: Number.isFinite(proof) ? proof : null,
  });
  const seed = optionsSeed({ gi: aircraft.gi, gj: aircraft.gj }, aircraft.alt, cone);
  const fieldIdx = field ? aircraft.gj * cone.dem.width + aircraft.gi : null;

  return {
    kind: "gpu-mc-sim-glider-debug",
    version: 1,
    when: new Date().toISOString(),
    mapHash: typeof location !== "undefined" ? location.hash : null,
    igcReplay: isIgcReplayOn(),
    optionsEnabled: optionsEnabled(),
    optionsViz: optionalVizMode(),
    optionsKey: optionalKey || null,
    lastOptionsMs,
    glider: {
      lng: aircraft.lng,
      lat: aircraft.lat,
      alt: aircraft.alt,
      source: aircraft.source,
    },
    cell,
    proofAltitude: Number.isFinite(proof) ? proof : null,
    marginVsProof: Number.isFinite(proof) && Number.isFinite(aircraft.alt) ? aircraft.alt - proof : null,
    marginVsStored:
      cell?.storedAlt != null && Number.isFinite(aircraft.alt) ? aircraft.alt - cell.storedAlt : null,
    ridgeEscape: summarizeEscape(decision),
    optionsSeed: seed
      ? {
          kind: seed.escape ? "escape" : "normal",
          seedGi: seed.cell.gi,
          seedGj: seed.cell.gj,
          startAlt: seed.startAlt,
          escape: summarizeEscape(seed.escape),
        }
      : { kind: "none" },
    optionalArea: field
      ? {
          present: true,
          startGi: field.startGi,
          startGj: field.startGj,
          startLng: field.startLng,
          startLat: field.startLat,
          gliderLng: field.gliderLng,
          gliderLat: field.gliderLat,
          maskAtGlider: fieldIdx != null ? field.mask?.[fieldIdx] === 1 : null,
          arrivalAtGlider: fieldIdx != null ? field.arrivals?.[fieldIdx] ?? null : null,
          escapeCellCount: field.escapeCells?.length ?? 0,
        }
      : { present: false },
    cone: {
      glideRatio: cone.glideRatio,
      maxAltitude: cone.maxAltitude,
      circuitHeight: cone.circuitHeight,
      groundClearance: cone.groundClearance,
      dem: {
        zoom: cone.dem.zoom,
        width: cone.dem.width,
        height: cone.dem.height,
        cellSizeM: cone.dem.cellSizeM,
        gx0: cone.dem.gx0,
        gy0: cone.dem.gy0,
      },
    },
  };
}

const GLIDER_DEBUG_HIT_PX = 28;

/** Computer only: right-click near the glider copies options debug JSON. */
export function copySimGliderDebugAt(domEvent) {
  if (!isSimulatorSession() || !app?.simGlider) {
    return false;
  }
  const map = hooks.getMap?.();
  if (!map) {
    return false;
  }
  const rect = map.getCanvas().getBoundingClientRect();
  const x = domEvent.clientX - rect.left;
  const y = domEvent.clientY - rect.top;
  const glider = map.project([app.simGlider.lng, app.simGlider.lat]);
  const dx = x - glider.x;
  const dy = y - glider.y;
  if (dx * dx + dy * dy > GLIDER_DEBUG_HIT_PX * GLIDER_DEBUG_HIT_PX) {
    return false;
  }

  const snapshot = buildSimGliderDebugSnapshot();
  const text = JSON.stringify(snapshot, null, 2);
  const write = navigator.clipboard?.writeText?.(text);
  if (write && typeof write.then === "function") {
    void write
      .then(() => hooks.setStatus?.("Glider debug copied — paste it in chat"))
      .catch(() => hooks.setStatus?.("Could not copy glider debug"));
  } else {
    hooks.setStatus?.("Clipboard unavailable");
    return false;
  }
  return true;
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
  const proof = requiredAltitudeAt(cell.gi, cell.gj, {
    dem: coneState.dem,
    altitudes: coneState.altitudes,
    ground: coneState.ground,
    originX: coneState.originX,
    originY: coneState.originY,
    maxAltitude: coneState.maxAltitude,
    glideRatio,
    circuitHeight: coneState.circuitHeight,
  });
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
    proofAltitude: Number.isFinite(proof) ? proof : null,
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
  const { dem, maxAltitude, groundClearance } = coneState;
  const floors = optionsConeFloors(coneState, glideRatio);
  if (preferShader()) {
    try {
      const { arrivals, originX, originY, iterations } = await app.engine.computeDownward(dem, {
        glideRatio,
        maxAltitude,
        gi: cell.gi,
        gj: cell.gj,
        startAlt,
        coneAltitudes: floors,
      });
      return {
        mask: maskFromArrivals(arrivals, floors, maxAltitude),
        arrivals,
        originX,
        originY,
        iterations,
        floors,
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
    altitudes: floors,
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
    floors,
    shader: false,
  };
}

const OPTIONS_ENABLED_KEY = "gpu-mc-options-enabled";
const IGC_OPTIONS_MIN_MS = 1000;
let lastOptionsMs = null;
let readoutToken = 0;
let igcOptionsTimer = null;
let igcOptionsLastRunAt = 0;
let igcOptionsPending = null;

function optionsEnabled() {
  return dom.optionsEnabledInput?.checked !== false;
}

function paintSimReadout() {
  const el = dom.simReadoutEl;
  if (!el) {
    return;
  }
  if (!optionsEnabled() || !app?.optionalField) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  const timing = lastOptionsMs == null ? "—" : `${Math.round(lastOptionsMs)} ms`;
  el.hidden = false;
  el.textContent = `Options ${timing}`;
}

function finishOptionsTiming(token, startedAt) {
  const apply = () => {
    if (token !== readoutToken) {
      return;
    }
    lastOptionsMs = performance.now() - startedAt;
    paintSimReadout();
  };
  apply();
  requestAnimationFrame(() => requestAnimationFrame(apply));
}
function resolveAircraft() {
  const cone = hooks.getConeState?.();
  if (!cone?.dem || isViewerSession()) {
    return null;
  }
  let lng;
  let lat;
  let alt;
  let source;
  if (isFlightSession()) {
    const position = hooks.getLastGeoLngLat?.();
    if (!position) {
      return null;
    }
    lng = position.lng;
    lat = position.lat;
    alt = app.lastGeoAltitude;
    source = "gps";
  } else if (isSimulatorSession() && app.simGlider) {
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
  if (isIgcPlaying()) {
    return;
  }
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

function clearIgcOptionsThrottle() {
  if (igcOptionsTimer) {
    clearTimeout(igcOptionsTimer);
    igcOptionsTimer = null;
  }
  igcOptionsPending = null;
}

function scheduleIgcOptionsThrottle(force) {
  igcOptionsPending = {
    force: Boolean(igcOptionsPending?.force || force),
  };
  if (igcOptionsTimer) {
    return;
  }
  const wait = Math.max(0, IGC_OPTIONS_MIN_MS - (performance.now() - igcOptionsLastRunAt));
  igcOptionsTimer = window.setTimeout(() => {
    igcOptionsTimer = null;
    const pending = igcOptionsPending ?? { force: false };
    igcOptionsPending = null;
    void refreshOptionalArea(pending);
  }, wait);
}

export async function refreshOptionalArea({ force = false } = {}) {
  if (isViewerSession()) {
    if (app?.optionalField || optionalKey) {
      clearOptionalArea();
    }
    paintSimReadout();
    return;
  }
  if (force) {
    clearIgcOptionsThrottle();
  } else if (isIgcReplayOn()) {
    const elapsed = performance.now() - igcOptionsLastRunAt;
    if (elapsed < IGC_OPTIONS_MIN_MS) {
      scheduleIgcOptionsThrottle(force);
      return;
    }
  } else {
    clearIgcOptionsThrottle();
  }

  if (optionsBusy) {
    queuedRefresh = { force: Boolean(queuedRefresh?.force || force) };
    return;
  }
  optionsBusy = true;
  igcOptionsLastRunAt = performance.now();
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
  paintSimReadout();
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
      const painted = paintOptionalImage(
        field.mask,
        field.arrivals,
        field.floors ?? cone.altitudes,
        cone.maxAltitude,
        cone.dem.width,
        cone.dem.height
      );
      image = painted.image;
      field.maxMargin = painted.maxMargin;
    }
    const escape = seed.escape;
    const escapePt = escape ? gridIndexLngLat(escape.gi, escape.gj, cone.dem) : null;
    const marginFloors = field.floors ?? cone.altitudes;
    app.optionalField = {
      ...field,
      startGi: escape ? escape.gi : aircraft.gi,
      startGj: escape ? escape.gj : aircraft.gj,
      startLng: escapePt?.lng ?? aircraft.lng,
      startLat: escapePt?.lat ?? aircraft.lat,
      gliderLng: aircraft.lng,
      gliderLat: aircraft.lat,
      escapeCells: escape?.cells ?? null,
      floors: marginFloors,
      maxMargin:
        field.maxMargin ??
        fieldMaxMargin(field.mask, field.arrivals, marginFloors, cone.maxAltitude),
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
    if (app.lastInspectCell && !isIgcPlaying()) {
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
  hooks.clearOptionalArea = clearOptionalArea;
  hooks.refreshOptionalArea = refreshOptionalArea;
  hooks.syncOptionalVizHint = syncOptionalVizHint;
  hooks.setSimManualOpen = setSimManualOpen;
  hooks.copySimGliderDebugAt = copySimGliderDebugAt;
  hooks.buildSimGliderDebugSnapshot = buildSimGliderDebugSnapshot;
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
  document.getElementById("ld")?.addEventListener("change", () => {
    syncDegradedLegend();
  });
  document.getElementById("ld")?.addEventListener("input", () => {
    syncDegradedLegend();
  });

  initIgcReplay(hooks);
  syncEmulatedAltitudeBox();
  syncDownwardMethodButton();
  syncOptionalVizHint();
}
