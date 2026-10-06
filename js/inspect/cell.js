import { gridCellToLngLat, gridIndexFromLngLat } from "../geo.js";
import { MANUAL_INSPECT_MS } from "../constants.js";
import {
  formatGroundElevationTip,
  formatHoverTip as formatHoverTipCore,
  formatPlaceGliderTip,
} from "../compute/format.js";
import { sampleTerrainElevationAtLngLat } from "../terrain-tiles.js";
import { isDebugMode } from "../params/panel.js";
import {
  refreshGeoPath,
  refreshInspectPath,
  clearInspectPath,
  clearGeoPath,
  clearAllGlidePaths,
  seedPathMetrics,
  optionViaPathMetrics,
  isOptionAreaCell,
} from "../glide-path.js";
import { readEmulatedAltitudeM, refreshOptionalArea, writeSimAltitudeM } from "../optional-area.js";
import { requiredAltitudeAt } from "../glidecone/route-style.js";
import { dom } from "../dom.js";
import { isIgcPlaying } from "../igc-replay-ui.js";
import { isFlightSession, isSimulatorSession, isViewerSession } from "../session-mode.js";

let hooks;
let app;
let terrainInspectRequestId = 0;

export function initCellInspect(h) {
  hooks = h;
  app = h.app;
  hooks.refreshInspectTooltip = refreshInspectTooltip;
}

export function getLastInspectCell() {
  return app.lastInspectCell;
}

export function setLastPathScreenBounds(bounds) {
  app.lastPathScreenBounds = bounds;
}

export function pathScreenBounds(coordinates) {
  const map = hooks.getMap();
  if (!coordinates?.length || !map) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [lng, lat] of coordinates) {
    const pt = map.project([lng, lat]);
    minX = Math.min(minX, pt.x);
    minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x);
    maxY = Math.max(maxY, pt.y);
  }

  const pad = 14;
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

function tooltipOverlapsPath(left, top, width, height) {
  if (!app.lastPathScreenBounds) {
    return false;
  }
  const { minX, minY, maxX, maxY } = app.lastPathScreenBounds;
  return left < maxX && left + width > minX && top < maxY && top + height > minY;
}

function viewportInsets() {
  const pad = 10;
  const bottomPad =
    pad +
    (document.body.classList.contains("has-compute-context")
      ? hooks.computeContextBarEl?.offsetHeight ?? 48
      : 0);
  return {
    left: pad,
    top: pad,
    right: window.innerWidth - pad,
    bottom: window.innerHeight - bottomPad,
  };
}

function positionParkedCellTooltip(cellTooltipEl) {
  // Flex layout in #sim-top-cluster places it left of the legend.
  cellTooltipEl.style.left = "";
  cellTooltipEl.style.top = "";
}

export function positionCellTooltip() {
  const cellTooltipEl = hooks.cellTooltipEl;
  if (!cellTooltipEl || cellTooltipEl.hidden) {
    return;
  }
  positionParkedCellTooltip(cellTooltipEl);
}

export function updateCellTooltip() {
  const cellTooltipEl = hooks.cellTooltipEl;
  if (!cellTooltipEl) {
    return;
  }
  if (!app.footerCellHtml) {
    cellTooltipEl.hidden = true;
    cellTooltipEl.innerHTML = "";
    cellTooltipEl.classList.remove("cell-tooltip--parked");
    cellTooltipEl.style.left = "";
    cellTooltipEl.style.top = "";
    return;
  }

  cellTooltipEl.innerHTML = app.footerCellHtml;
  cellTooltipEl.hidden = false;
  cellTooltipEl.classList.add("cell-tooltip--parked");
  positionCellTooltip();
}

function clearManualInspectTimer() {
  if (app.manualInspectTimeout !== null) {
    clearTimeout(app.manualInspectTimeout);
    app.manualInspectTimeout = null;
  }
}

function scheduleManualInspectClear() {
  clearManualInspectTimer();
  app.manualInspectTimeout = window.setTimeout(() => {
    app.manualInspectTimeout = null;
    clearCellInspect();
  }, MANUAL_INSPECT_MS);
}

function formatHoverTip(cell) {
  const coneState = hooks.getConeState();
  const proofAlt =
    cell?.isReachable && coneState
      ? requiredAltitudeAt(cell.gi, cell.gj, coneState)
      : null;
  const showOptionVia =
    isSimulatorSession() &&
    Boolean(app.simGlider) &&
    isOptionAreaCell(cell) &&
    !isIgcPlaying();
  return formatHoverTipCore(cell, {
    groundClearance: coneState?.groundClearance ?? 100,
    debugMode: isDebugMode(),
    metrics: seedPathMetrics(cell),
    glideRatio: coneState?.glideRatio ?? 20,
    proofAlt,
    showOptionVia,
    optionVia: showOptionVia ? optionViaPathMetrics(cell) : null,
    userAlt: showOptionVia ? readEmulatedAltitudeM() : null,
  });
}

/** Rebuild parked tip HTML (e.g. when option→airport probe finishes). */
export function refreshInspectTooltip() {
  if (!app.lastInspectCell || app.airportHoverTipActive) {
    return;
  }
  app.footerCellHtml = formatHoverTip(app.lastInspectCell);
  updateCellTooltip();
}

export function sampleDemCell(lng, lat) {
  const coneState = hooks.getConeState();
  if (!coneState) {
    return null;
  }

  const { dem, altitudes, ground, maxAltitude, originX, originY } = coneState;
  const { gi, gj } = gridIndexFromLngLat(lng, lat, dem);

  if (gi < 0 || gj < 0 || gi >= dem.width || gj >= dem.height) {
    return null;
  }

  const idx = gj * dem.width + gi;
  const groundElev = dem.terrainMsl
    ? dem.terrainMsl[idx]
    : dem.elevation[idx] - dem.groundClearance;
  const alt = altitudes[idx];
  const hasOrigin = originX[idx] >= 0 && originY[idx] >= 0;
  const isGroundCell = ground[idx] === 1;
  const isReachable = Number.isFinite(alt) && alt < maxAltitude && hasOrigin;

  return {
    gi,
    gj,
    idx,
    originGi: hasOrigin ? originX[idx] : null,
    originGj: hasOrigin ? originY[idx] : null,
    groundElev,
    alt: isReachable ? alt : null,
    isReachable,
    isGround: isGroundCell,
    isCone: isReachable && !isGroundCell,
  };
}

function cancelTerrainElevationInspect() {
  terrainInspectRequestId += 1;
}

function shouldShowPlaceGliderTip() {
  return (
    isSimulatorSession() &&
    !app.simGlider &&
    !isCacheSelectMode() &&
    !hooks.getManualAirportSelectMode?.()
  );
}

/** Parked tip: place the glider (Simulator, no glider yet). */
export function syncPlaceGliderTip() {
  if (app.airportHoverTipActive) {
    return;
  }
  if (!shouldShowPlaceGliderTip()) {
    return;
  }
  cancelTerrainElevationInspect();
  clearManualInspectTimer();
  app.lastInspectCell = null;
  app.lastInspectLngLat = null;
  app.lastInspectAnchor = null;
  app.lastPathScreenBounds = null;
  clearInspectPath();
  app.inspectPinned = false;
  const touch = Boolean(hooks.getInteraction?.()?.tapPath);
  app.footerCellHtml = formatPlaceGliderTip({ touch });
  updateCellTooltip();
}

export function clearCellInspect() {
  cancelTerrainElevationInspect();
  clearManualInspectTimer();
  app.airportHoverTipActive = false;
  app.footerCellHtml = null;
  app.lastInspectAnchor = null;
  app.lastInspectLngLat = null;
  app.lastInspectCell = null;
  app.lastPathScreenBounds = null;
  clearInspectPath();
  app.inspectPinned = false;
  if (shouldShowPlaceGliderTip()) {
    syncPlaceGliderTip();
  } else {
    updateCellTooltip();
  }
  hooks.updateParamsFooter();
}

/** Parked tip while hovering an airport marker. */
export function showAirportHoverTip(airport) {
  if (!airport) {
    clearAirportHoverTip();
    return;
  }
  cancelTerrainElevationInspect();
  clearManualInspectTimer();
  app.lastInspectCell = null;
  app.lastInspectLngLat = null;
  app.lastInspectAnchor = null;
  app.lastPathScreenBounds = null;
  clearInspectPath();
  app.inspectPinned = false;
  const html = hooks.airportActionTipHtml?.(airport);
  if (!html) {
    clearAirportHoverTip();
    return;
  }
  app.airportHoverTipActive = true;
  app.footerCellHtml = html;
  updateCellTooltip();
}

export function clearAirportHoverTip() {
  if (!app.airportHoverTipActive) {
    return;
  }
  app.airportHoverTipActive = false;
  if (shouldShowPlaceGliderTip()) {
    syncPlaceGliderTip();
    return;
  }
  app.footerCellHtml = null;
  updateCellTooltip();
}

function isPointerOverParams(clientX, clientY) {
  const paramsShell = hooks.paramsShell;
  if (!paramsShell) {
    return false;
  }
  const target = document.elementFromPoint(clientX, clientY);
  return Boolean(target && paramsShell.contains(target));
}

function isCacheSelectMode() {
  return hooks.getCacheSelectMode?.() ?? false;
}

async function showTerrainElevationInspect(
  lng,
  lat,
  anchorPoint = null,
  { temporary = false } = {}
) {
  const requestId = ++terrainInspectRequestId;
  app.lastInspectCell = null;
  app.lastPathScreenBounds = null;
  app.lastInspectLngLat = { lng, lat };
  clearInspectPath();

  const map = hooks.getMap();
  if (anchorPoint) {
    app.lastInspectAnchor = { x: anchorPoint.x, y: anchorPoint.y };
  } else if (map) {
    const projected = map.project([lng, lat]);
    app.lastInspectAnchor = { x: projected.x, y: projected.y };
  }

  const z = hooks.getDisplayedTerrainZoom?.();
  if (!Number.isFinite(z)) {
    return;
  }

  try {
    const groundElev = await sampleTerrainElevationAtLngLat(lng, lat, z);
    if (requestId !== terrainInspectRequestId) {
      return;
    }
    if (groundElev === null) {
      clearCellInspect();
      return;
    }
    app.airportHoverTipActive = false;
    app.footerCellHtml = formatGroundElevationTip(groundElev);
    updateCellTooltip();
    if (temporary) {
      scheduleManualInspectClear();
    }
    hooks.updateParamsFooter();
  } catch {
    if (requestId !== terrainInspectRequestId) {
      return;
    }
    clearCellInspect();
  }
}

export function showCellInspect(cell, anchorPoint = null, { temporary = false, lngLat = null } = {}) {
  cancelTerrainElevationInspect();
  if (isCacheSelectMode()) {
    clearCellInspect();
    return;
  }
  if (!cell) {
    clearCellInspect();
    return;
  }

  app.airportHoverTipActive = false;
  app.footerCellHtml = formatHoverTip(cell);

  const coneState = hooks.getConeState();
  if (lngLat) {
    app.lastInspectLngLat = { lng: lngLat.lng, lat: lngLat.lat };
  } else if (coneState?.dem) {
    const pt = gridCellToLngLat(cell.gi, cell.gj, coneState.dem);
    app.lastInspectLngLat = { lng: pt.lng, lat: pt.lat };
  }

  const map = hooks.getMap();
  if (anchorPoint) {
    app.lastInspectAnchor = { x: anchorPoint.x, y: anchorPoint.y };
  } else if (app.lastInspectLngLat && map) {
    const projected = map.project([app.lastInspectLngLat.lng, app.lastInspectLngLat.lat]);
    app.lastInspectAnchor = { x: projected.x, y: projected.y };
  }

  if (cell.isReachable) {
    app.lastInspectCell = cell;
    refreshInspectPath(cell);
  } else {
    app.lastInspectCell = null;
    app.lastPathScreenBounds = null;
    clearInspectPath();
    updateCellTooltip();
  }

  if (temporary) {
    scheduleManualInspectClear();
  }

  hooks.updateParamsFooter();
}

export function syncInspectOnMapMove() {
  const map = hooks.getMap();
  if (!app.lastInspectLngLat || !app.footerCellHtml || !map) {
    return;
  }
  const projected = map.project([app.lastInspectLngLat.lng, app.lastInspectLngLat.lat]);
  app.lastInspectAnchor = { x: projected.x, y: projected.y };
  if (app.lastInspectCell) {
    refreshInspectPath(app.lastInspectCell);
  } else {
    positionCellTooltip();
  }
}

export function getGeoSampleCell() {
  const lastGeoLngLat = hooks.getLastGeoLngLat();
  if (!lastGeoLngLat || !hooks.getConeState()) {
    return null;
  }
  return sampleDemCell(lastGeoLngLat.lng, lastGeoLngLat.lat);
}

/** First place often happens before a cone exists; fill altitude once the cone is ready. */
function ensureSimAltitudeFromCone(coneState) {
  if (!isSimulatorSession() || !app.simGlider || !coneState) {
    return readEmulatedAltitudeM();
  }
  const existing = readEmulatedAltitudeM();
  if (Number.isFinite(existing)) {
    return existing;
  }
  const cell = sampleDemCell(app.simGlider.lng, app.simGlider.lat);
  if (!cell) {
    return existing;
  }
  const required = requiredAltitudeAt(cell.gi, cell.gj, coneState);
  if (!Number.isFinite(required)) {
    return existing;
  }
  const alt = required + 200;
  writeSimAltitudeM(alt);
  return alt;
}

export function updateGeoLocationPath() {
  hooks.syncEmulatedAltitudeBox?.();
  if (isCacheSelectMode() || isViewerSession()) {
    clearGeoPath();
    if (isViewerSession()) {
      void refreshOptionalArea();
    }
    updateCellTooltip();
    hooks.syncComputeContextBar?.();
    return;
  }

  const coneState = hooks.getConeState();
  if (isFlightSession() && coneState && hooks.getLastGeoLngLat()) {
    const position = hooks.getLastGeoLngLat();
    const cell = getGeoSampleCell();
    if (!cell?.isReachable) {
      clearGeoPath();
    } else {
      refreshGeoPath(cell, position, app.lastGeoAltitude);
    }
    void refreshOptionalArea();
    updateCellTooltip();
    hooks.syncComputeContextBar?.();
    return;
  }

  if (isSimulatorSession() && app.simGlider && coneState) {
    const { lng, lat } = app.simGlider;
    const hadAltitude = Number.isFinite(readEmulatedAltitudeM());
    const alt = ensureSimAltitudeFromCone(coneState);
    const cell = sampleDemCell(lng, lat);
    if (!cell?.isReachable) {
      clearGeoPath();
    } else {
      refreshGeoPath(cell, { lng, lat }, alt);
    }
    // First place often lands before altitude exists; force options once it's filled.
    void refreshOptionalArea({ force: !hadAltitude && Number.isFinite(alt) });
    updateCellTooltip();
    hooks.syncComputeContextBar?.();
    return;
  }

  clearGeoPath();
  void refreshOptionalArea();
  if (shouldShowPlaceGliderTip()) {
    syncPlaceGliderTip();
    hooks.syncComputeContextBar?.();
    return;
  }
  updateCellTooltip();
  hooks.syncComputeContextBar?.();
}

export function onMapMouseMove(event) {
  if (isCacheSelectMode()) {
    return;
  }
  if (shouldShowPlaceGliderTip()) {
    syncPlaceGliderTip();
    return;
  }
  if (!hooks.getInteraction().hoverPath) {
    return;
  }

  const { clientX, clientY } = event.originalEvent;
  if (isPointerOverParams(clientX, clientY)) {
    return;
  }

  const { lng, lat } = event.lngLat;
  inspectMapPoint(lng, lat, event.point);
}

export function inspectMapPoint(lng, lat, point) {
  const cell = sampleDemCell(lng, lat);
  if (cell !== null) {
    showCellInspect(cell, point, { lngLat: { lng, lat } });
    return;
  }

  showTerrainElevationInspect(lng, lat, point);
}

export function placeSimGlider(lng, lat, point) {
  if (isCacheSelectMode() || !isSimulatorSession() || hooks.isComputing()) {
    return;
  }

  app.simGlider = { lng, lat };
  hooks.onAutoModeAnchorMoved?.(lng, lat);
  const cell = sampleDemCell(lng, lat);
  const cone = hooks.getConeState();
  const required = cell && cone ? requiredAltitudeAt(cell.gi, cell.gj, cone) : null;
  if (Number.isFinite(required)) {
    writeSimAltitudeM(required + 200);
  }
  updateGeoLocationPath();
  if (cell !== null) {
    showCellInspect(cell, point, { lngLat: { lng, lat } });
    return;
  }
  showTerrainElevationInspect(lng, lat, point, { temporary: true });
}

export function onMapMouseLeave() {
  if (isCacheSelectMode()) {
    return;
  }
  if (shouldShowPlaceGliderTip()) {
    syncPlaceGliderTip();
    return;
  }
  if (!hooks.getInteraction().hoverPath) {
    return;
  }
  if (!isDebugMode()) {
    clearCellInspect();
  }
}

export function onMapClickInspect(event) {
  if (isCacheSelectMode()) {
    return;
  }
  // Simulator: click places the glider. Flight / viewer: click inspects.
  // On a phone the tap is handled as inspect, and a long press places the glider (simulator only).
  if (!isSimulatorSession() && !hooks.getInteraction().tapPath && !isDebugMode()) {
    return;
  }

  const { clientX, clientY } = event.originalEvent;
  if (isPointerOverParams(clientX, clientY)) {
    return;
  }

  const { lng, lat } = event.lngLat;
  if (isSimulatorSession()) {
    placeSimGlider(lng, lat, event.point);
    return;
  }

  const cell = sampleDemCell(lng, lat);
  if (cell !== null) {
    const pin = isDebugMode();
    showCellInspect(cell, event.point, { temporary: !pin, lngLat: { lng, lat } });
    app.inspectPinned = pin;
    return;
  }
  app.inspectPinned = false;

  showTerrainElevationInspect(lng, lat, event.point, { temporary: true });
}

export function hasActiveInspectTooltip() {
  return Boolean(app.footerCellHtml);
}

export function syncPathsOnMapMove() {
  if (isCacheSelectMode()) {
    return;
  }
  if (isFlightSession() || isSimulatorSession()) {
    updateGeoLocationPath();
  }
  syncInspectOnMapMove();
}
