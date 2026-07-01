import { gridCellToLngLat, gridIndexFromLngLat } from "../geo.js";
import { MANUAL_INSPECT_MS } from "../constants.js";
import { formatHoverTip as formatHoverTipCore } from "../compute/format.js";
import { isDebugMode } from "../params/panel.js";
import {
  refreshGeoPath,
  refreshInspectPath,
  clearInspectPath,
  clearGeoPath,
  clearAllGlidePaths,
  seedPathMetrics,
} from "../glide-path.js";

let hooks;

let footerCellHtml = null;
let lastInspectAnchor = null;
let lastInspectLngLat = null;
let lastPathScreenBounds = null;
let lastInspectCell = null;
let manualInspectTimeout = null;

export function initCellInspect(h) {
  hooks = h;
}

export function getLastInspectCell() {
  return lastInspectCell;
}

export function getLastPathScreenBounds() {
  return lastPathScreenBounds;
}

export function setLastPathScreenBounds(bounds) {
  lastPathScreenBounds = bounds;
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
  if (!lastPathScreenBounds) {
    return false;
  }
  const { minX, minY, maxX, maxY } = lastPathScreenBounds;
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

export function positionCellTooltip() {
  const cellTooltipEl = hooks.cellTooltipEl;
  if (!cellTooltipEl || cellTooltipEl.hidden || !lastInspectAnchor) {
    return;
  }

  const { x, y } = lastInspectAnchor;
  const gap = 16;
  const width = cellTooltipEl.offsetWidth;
  const height = cellTooltipEl.offsetHeight;
  const { left: minLeft, top: minTop, right: maxRight, bottom: maxBottom } = viewportInsets();

  const placements = [
    { left: x + gap, top: y + gap },
    { left: x - gap - width, top: y + gap },
    { left: x + gap, top: y - gap - height },
    { left: x - gap - width, top: y - gap - height },
  ];

  let chosen = placements.find(
    (place) =>
      place.left >= minLeft &&
      place.top >= minTop &&
      place.left + width <= maxRight &&
      place.top + height <= maxBottom &&
      !tooltipOverlapsPath(place.left, place.top, width, height)
  );

  if (!chosen && lastPathScreenBounds) {
    const pcx = (lastPathScreenBounds.minX + lastPathScreenBounds.maxX) / 2;
    const pcy = (lastPathScreenBounds.minY + lastPathScreenBounds.maxY) / 2;
    const dx = x - pcx;
    const dy = y - pcy;
    const len = Math.hypot(dx, dy) || 1;
    const push = Math.max(width, height) / 2 + gap + 24;
    chosen = {
      left: x + (dx / len) * push - width / 2,
      top: y + (dy / len) * push - height / 2,
    };
  }

  chosen ??= placements[0];

  chosen.left = Math.max(minLeft, Math.min(chosen.left, maxRight - width));
  chosen.top = Math.max(minTop, Math.min(chosen.top, maxBottom - height));

  cellTooltipEl.style.left = `${chosen.left}px`;
  cellTooltipEl.style.top = `${chosen.top}px`;
}

export function updateCellTooltip() {
  const cellTooltipEl = hooks.cellTooltipEl;
  if (!cellTooltipEl) {
    return;
  }
  if (!footerCellHtml) {
    cellTooltipEl.hidden = true;
    cellTooltipEl.innerHTML = "";
    return;
  }

  cellTooltipEl.innerHTML = footerCellHtml;
  cellTooltipEl.hidden = false;
  positionCellTooltip();
}

function clearManualInspectTimer() {
  if (manualInspectTimeout !== null) {
    clearTimeout(manualInspectTimeout);
    manualInspectTimeout = null;
  }
}

function scheduleManualInspectClear() {
  clearManualInspectTimer();
  manualInspectTimeout = window.setTimeout(() => {
    manualInspectTimeout = null;
    clearCellInspect();
  }, MANUAL_INSPECT_MS);
}

function formatHoverTip(cell) {
  const coneState = hooks.getConeState();
  return formatHoverTipCore(cell, {
    groundClearance: coneState?.groundClearance ?? 100,
    debugMode: isDebugMode(),
    metrics: seedPathMetrics(cell),
  });
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
    groundElev,
    alt: isReachable ? alt : null,
    isReachable,
    isGround: isGroundCell,
    isCone: isReachable && !isGroundCell,
  };
}

export function clearCellInspect() {
  clearManualInspectTimer();
  footerCellHtml = null;
  lastInspectAnchor = null;
  lastInspectLngLat = null;
  lastInspectCell = null;
  lastPathScreenBounds = null;
  clearInspectPath();
  updateCellTooltip();
  hooks.updateParamsFooter();
}

function isPointerOverParams(clientX, clientY) {
  const paramsShell = hooks.paramsShell;
  if (!paramsShell) {
    return false;
  }
  const target = document.elementFromPoint(clientX, clientY);
  return Boolean(target && paramsShell.contains(target));
}

export function showCellInspect(cell, anchorPoint = null, { temporary = false } = {}) {
  if (!cell) {
    clearCellInspect();
    return;
  }

  footerCellHtml = formatHoverTip(cell);

  const coneState = hooks.getConeState();
  if (coneState?.dem) {
    const pt = gridCellToLngLat(cell.gi, cell.gj, coneState.dem);
    lastInspectLngLat = { lng: pt.lng, lat: pt.lat };
  }

  const map = hooks.getMap();
  if (anchorPoint) {
    lastInspectAnchor = { x: anchorPoint.x, y: anchorPoint.y };
  } else if (lastInspectLngLat && map) {
    const projected = map.project([lastInspectLngLat.lng, lastInspectLngLat.lat]);
    lastInspectAnchor = { x: projected.x, y: projected.y };
  }

  if (cell.isReachable) {
    lastInspectCell = cell;
    refreshInspectPath(cell);
  } else {
    lastInspectCell = null;
    lastPathScreenBounds = null;
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
  if (!lastInspectCell || !lastInspectLngLat || !footerCellHtml || !map) {
    return;
  }
  const projected = map.project([lastInspectLngLat.lng, lastInspectLngLat.lat]);
  lastInspectAnchor = { x: projected.x, y: projected.y };
  refreshInspectPath(lastInspectCell);
}

export function getGeoSampleCell() {
  const lastGeoLngLat = hooks.getLastGeoLngLat();
  if (!lastGeoLngLat || !hooks.getConeState()) {
    return null;
  }
  return sampleDemCell(lastGeoLngLat.lng, lastGeoLngLat.lat);
}

export function updateGeoLocationPath() {
  if (!hooks.isGeoTrackingOn() || !hooks.getConeState() || !hooks.getLastGeoLngLat()) {
    clearGeoPath();
    return;
  }

  const cell = getGeoSampleCell();
  if (!cell?.isReachable) {
    clearGeoPath();
    return;
  }

  refreshGeoPath(cell);
}

export function onMapMouseMove(event) {
  if (!hooks.getInteraction().hoverPath) {
    return;
  }

  const { clientX, clientY } = event.originalEvent;
  if (isPointerOverParams(clientX, clientY)) {
    return;
  }

  const cell = sampleDemCell(event.lngLat.lng, event.lngLat.lat);
  if (cell === null) {
    if (!isDebugMode()) {
      clearCellInspect();
    }
    return;
  }

  showCellInspect(cell, event.point);
}

export function onMapMouseLeave() {
  if (!hooks.getInteraction().hoverPath) {
    return;
  }
  if (!isDebugMode()) {
    clearCellInspect();
  }
}

export function onMapClickInspect(event) {
  if (!hooks.getInteraction().tapPath || !hooks.getConeState()) {
    return;
  }

  const { clientX, clientY } = event.originalEvent;
  if (isPointerOverParams(clientX, clientY)) {
    return;
  }

  const cell = sampleDemCell(event.lngLat.lng, event.lngLat.lat);
  if (cell?.isReachable) {
    showCellInspect(cell, event.point, { temporary: true });
  }
}

export function hasActiveInspectTooltip() {
  return Boolean(getLastInspectCell() && footerCellHtml);
}

export function syncPathsOnMapMove() {
  if (hooks.isGeoTrackingOn()) {
    updateGeoLocationPath();
  }
  syncInspectOnMapMove();
}
