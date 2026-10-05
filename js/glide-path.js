import { distanceMetres, gridCellDistanceM, gridCellToLngLat } from "./geo.js";
import { seedAtGridCell } from "./airport-label.js";
import { ensurePathLayer, raisePathLayer } from "./map/layers.js";
import { styleUpwardRoute } from "./glidecone/route-style.js";
import { clearProbeArrival, optionAreaCellColor, scheduleProbeArrival } from "./optional-area.js";

const PATH_SOURCE_ID = "glide-path";
const PROBE_SEPARATION_M = 50;

let hooks;
let app;
let aircraftLines = [];
let aircraftArrival = [];
let probeLines = [];
let panPink = [];
let probeArrival = [];
let discsGeo = [];
let discsProbe = [];

function isPathLayerReady() {
  return app.pathLayerReady;
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function cellIndex(x, y, dem) {
  return y * dem.width + x;
}

function pushPathPoint(coordinates, x, y, dem) {
  const pt = gridCellToLngLat(x, y, dem);
  const last = coordinates[coordinates.length - 1];
  if (last && last[0] === pt.lng && last[1] === pt.lat) {
    return;
  }
  coordinates.push([pt.lng, pt.lat]);
}

function isSeedCell(x, y, dem) {
  if (dem.seeds?.length) {
    return dem.seeds.some((seed) => seed.x === x && seed.y === y);
  }
  return x === dem.homeX && y === dem.homeY;
}

function gliderFeatures() {
  if (!app?.simGlider || hooks.isGeoTrackingOn?.()) {
    return [];
  }
  const { lng, lat } = app.simGlider;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return [];
  }
  return [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: { kind: "glider" },
    },
  ];
}

function syncPathSource() {
  if (
    gliderFeatures().length ||
    aircraftLines.length ||
    probeLines.length ||
    panPink.length ||
    aircraftArrival.length ||
    probeArrival.length ||
    discsGeo.length ||
    discsProbe.length
  ) {
    ensurePathLayer();
  }
  const map = hooks.getMap();
  if (!isPathLayerReady() || !map?.getSource(PATH_SOURCE_ID)) {
    return;
  }
  map.getSource(PATH_SOURCE_ID).setData({
    type: "FeatureCollection",
    features: [
      ...aircraftLines,
      ...aircraftArrival,
      ...probeLines,
      ...panPink,
      ...probeArrival,
      ...discsGeo,
      ...discsProbe,
      ...gliderFeatures(),
    ],
  });
  raisePathLayer();
}

function lineFeature(role, segment, coordinates, color) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties: color ? { role, segment, color } : { role, segment },
  };
}

function optionCellColor(idx) {
  return optionAreaCellColor(idx);
}

function originPolyline(originX, originY, dem, startX, startY, startLngLat, endX, endY, endLngLat) {
  if (!originX || !originY || !startLngLat || !endLngLat) {
    return null;
  }
  const cells = [];
  let x = endX;
  let y = endY;
  const seen = new Set();
  const maxSteps = (dem.width + dem.height) * 2;
  for (let step = 0; step < maxSteps; step += 1) {
    const key = `${x},${y}`;
    if (seen.has(key)) {
      return null;
    }
    seen.add(key);
    cells.push({ x, y });
    if (x === startX && y === startY) {
      break;
    }
    const idx = cellIndex(x, y, dem);
    const px = originX[idx];
    const py = originY[idx];
    if (px < 0 || py < 0 || (px === x && py === y)) {
      return null;
    }
    x = px;
    y = py;
  }
  const last = cells[cells.length - 1];
  if (!last || last.x !== startX || last.y !== startY) {
    return null;
  }
  cells.reverse();
  const coordinates = [[startLngLat.lng, startLngLat.lat]];
  for (let i = 1; i < cells.length - 1; i += 1) {
    const pt = gridCellToLngLat(cells[i].x, cells[i].y, dem);
    coordinates.push([pt.lng, pt.lat]);
  }
  coordinates.push([endLngLat.lng, endLngLat.lat]);
  if (coordinates.length < 2) {
    return null;
  }
  const a = coordinates[0];
  const b = coordinates[coordinates.length - 1];
  if (a[0] === b[0] && a[1] === b[1] && coordinates.length === 2) {
    return null;
  }
  return coordinates;
}

function bestSeedIndex(field, dem) {
  const seeds = dem.seeds?.length ? dem.seeds : [{ x: dem.homeX, y: dem.homeY }];
  let bestI = -1;
  let bestA = Number.NEGATIVE_INFINITY;
  for (const seed of seeds) {
    if (seed.x < 0 || seed.y < 0 || seed.x >= dem.width || seed.y >= dem.height) {
      continue;
    }
    const idx = seed.y * dem.width + seed.x;
    if (field.mask?.[idx] !== 1) {
      continue;
    }
    const arrival = field.arrivals?.[idx];
    if (!Number.isFinite(arrival) || arrival < 0) {
      continue;
    }
    if (arrival > bestA) {
      bestA = arrival;
      bestI = idx;
    }
  }
  return bestI;
}

function arrivalFeatures(field, role) {
  const coneState = hooks.getConeState();
  const dem = coneState?.dem;
  if (!field?.originX || !dem || !Number.isFinite(field.startLng)) {
    return [];
  }
  const best = bestSeedIndex(field, dem);
  const startIdx = field.startGj * dem.width + field.startGi;
  if (best < 0 || best === startIdx) {
    return [];
  }
  const endX = best % dem.width;
  const endY = (best / dem.width) | 0;
  const endPt = gridCellToLngLat(endX, endY, dem);
  const coordinates = originPolyline(
    field.originX,
    field.originY,
    dem,
    field.startGi,
    field.startGj,
    { lng: field.startLng, lat: field.startLat },
    endX,
    endY,
    endPt
  );
  const color = optionCellColor(startIdx);
  return coordinates ? [lineFeature(role, "arrival", coordinates, color)] : [];
}

function panPinkFeatures(cell) {
  const field = app.optionalField;
  const coneState = hooks.getConeState();
  const dem = coneState?.dem;
  const end = app.lastInspectLngLat;
  if (!field?.originX || !field?.mask || !dem || !cell || !end || !Number.isFinite(field.startLng)) {
    return [];
  }
  if (distanceMetres(field.startLat, field.startLng, end.lat, end.lng) < PROBE_SEPARATION_M) {
    return [];
  }
  const idx = cell.gj * dem.width + cell.gi;
  if (field.mask[idx] !== 1) {
    return [];
  }
  const coordinates = originPolyline(
    field.originX,
    field.originY,
    dem,
    field.startGi,
    field.startGj,
    { lng: field.startLng, lat: field.startLat },
    cell.gi,
    cell.gj,
    end
  );
  return coordinates ? [lineFeature("inspect", "default", coordinates, optionCellColor(idx))] : [];
}

function aircraftLngLat() {
  if (hooks.isGeoTrackingOn?.()) {
    return hooks.getLastGeoLngLat?.() ?? null;
  }
  return app.simGlider ?? null;
}

function isNearAircraft(lngLat) {
  const aircraft = aircraftLngLat();
  if (!aircraft || !lngLat) {
    return false;
  }
  return distanceMetres(aircraft.lat, aircraft.lng, lngLat.lat, lngLat.lng) < PROBE_SEPARATION_M;
}

export function traceOriginRelayPath(x, y, dem, originX, originY) {
  let totalDistM = 0;
  let cx = x;
  let cy = y;
  const visited = new Set();
  const maxSteps = dem.width + dem.height;

  for (let step = 0; step < maxSteps; step += 1) {
    const key = cellKey(cx, cy);
    if (visited.has(key)) {
      return { distanceM: totalDistM, seedX: cx, seedY: cy, complete: false };
    }
    visited.add(key);

    const idx = cellIndex(cx, cy, dem);
    const ox = originX[idx];
    const oy = originY[idx];
    if (ox < 0 || oy < 0) {
      return null;
    }

    totalDistM += gridCellDistanceM(cx, cy, ox, oy, dem);

    if (ox === cx && oy === cy) {
      return { distanceM: totalDistM, seedX: cx, seedY: cy, complete: true };
    }

    cx = ox;
    cy = oy;
  }

  return { distanceM: totalDistM, seedX: cx, seedY: cy, complete: false };
}

export function pathMaxSegmentLd(gi, gj) {
  const coneState = hooks.getConeState();
  if (!coneState) {
    return null;
  }
  const { dem, originX, originY, altitudes, maxAltitude } = coneState;
  const startIdx = cellIndex(gi, gj, dem);
  const startAlt = altitudes[startIdx];
  if (!Number.isFinite(startAlt) || startAlt >= maxAltitude) {
    return null;
  }
  const startOx = originX[startIdx];
  const startOy = originY[startIdx];
  if (startOx < 0 || startOy < 0) {
    return null;
  }

  let cx = gi;
  let cy = gj;
  let pathMaxLd = Number.NEGATIVE_INFINITY;
  const maxSteps = (dem.width + dem.height) * 2;

  for (let step = 0; step < maxSteps; step += 1) {
    if (isSeedCell(cx, cy, dem)) {
      return pathMaxLd === Number.NEGATIVE_INFINITY ? 0 : pathMaxLd;
    }
    const ci = cellIndex(cx, cy, dem);
    const nx = originX[ci];
    const ny = originY[ci];
    if (nx < 0 || ny < 0 || (nx === cx && ny === cy)) {
      return pathMaxLd === Number.NEGATIVE_INFINITY ? 0 : pathMaxLd;
    }
    const altA = altitudes[ci];
    const altB = altitudes[cellIndex(nx, ny, dem)];
    const di = nx - cx;
    const dj = ny - cy;
    const horiz = dem.cellSizeM * Math.hypot(di, dj);
    const vertDrop = altA - altB;
    const segLd = vertDrop > 0 ? horiz / vertDrop : -99;
    pathMaxLd = Math.max(pathMaxLd, segLd);
    cx = nx;
    cy = ny;
  }

  return pathMaxLd === Number.NEGATIVE_INFINITY ? 0 : pathMaxLd;
}

function seedAltitudeAt(dem, seedIdx, circuitHeight) {
  const terrain = dem.terrainMsl
    ? dem.terrainMsl[seedIdx]
    : dem.elevation[seedIdx] - dem.groundClearance;
  return terrain + circuitHeight;
}

export function seedPathMetrics(cell) {
  const coneState = hooks.getConeState();
  if (!coneState) {
    return null;
  }
  const { dem, originX, originY, ground, glideRatio, circuitHeight } = coneState;
  const path = traceOriginRelayPath(cell.gi, cell.gj, dem, originX, originY);
  if (!path) {
    return null;
  }

  const seedIdx = cellIndex(path.seedX, path.seedY, dem);
  const seedAlt = seedAltitudeAt(dem, seedIdx, circuitHeight);
  const requiredAlt = seedAlt + path.distanceM / glideRatio;
  const seed = seedAtGridCell(dem, path.seedX, path.seedY);

  return {
    distanceM: path.distanceM,
    requiredAlt,
    seedAlt,
    seedIcao: seed?.icao ?? null,
    seedName: seed?.name ?? seed?.label ?? null,
    isGroundSeed: ground[seedIdx] === 1,
    complete: path.complete,
    maxSegmentLd: pathMaxSegmentLd(cell.gi, cell.gj),
  };
}

export function traceGlidePath(gi, gj) {
  const coneState = hooks.getConeState();
  const { dem, originX, originY } = coneState;
  const coordinates = [];
  const cells = [];
  const visited = new Set();
  let x = gi;
  let y = gj;
  const maxSteps = (dem.width + dem.height) * 2;

  for (let step = 0; step < maxSteps; step += 1) {
    const key = cellKey(x, y);
    if (visited.has(key)) {
      break;
    }
    visited.add(key);

    cells.push({ x, y });
    pushPathPoint(coordinates, x, y, dem);

    if (isSeedCell(x, y, dem)) {
      break;
    }

    const idx = cellIndex(x, y, dem);
    const nx = originX[idx];
    const ny = originY[idx];
    if (nx < 0 || ny < 0 || (nx === x && ny === y)) {
      break;
    }

    x = nx;
    y = ny;
  }

  return { coordinates, cells };
}

export function initGlidePath(h) {
  hooks = h;
  app = h.app;
  hooks.setAircraftArrivalPath = (field) => {
    aircraftArrival = arrivalFeatures(field, "geo");
    if (app.lastInspectCell) {
      panPink = panPinkFeatures(app.lastInspectCell);
    }
    syncPathSource();
  };
  hooks.setProbeArrivalPath = (field) => {
    probeArrival = field ? arrivalFeatures(field, "inspect") : [];
    syncPathSource();
  };
  hooks.clearArrivalPaths = () => {
    aircraftArrival = [];
    probeArrival = [];
    panPink = [];
    syncPathSource();
  };
}

function styledRoute(cell, role, startLngLat, startAlt, panPath) {
  const coneState = hooks.getConeState();
  if (!coneState?.dem || !cell) {
    return { lines: [], discs: [] };
  }
  const path = traceGlidePath(cell.gi, cell.gj);
  return styleUpwardRoute({
    cells: path.cells,
    dem: coneState.dem,
    ground: coneState.ground,
    altitudes: coneState.altitudes,
    originX: coneState.originX,
    originY: coneState.originY,
    maxAltitude: coneState.maxAltitude,
    glideRatio: coneState.glideRatio,
    circuitHeight: coneState.circuitHeight,
    startLngLat,
    startAlt,
    panPath,
    role,
  });
}

export function refreshGeoPath(cell, startLngLat, startAlt) {
  const styled = styledRoute(cell, "geo", startLngLat, startAlt, false);
  aircraftLines = styled.lines;
  discsGeo = styled.discs;
  syncPathSource();
}

export function refreshInspectPath(cell) {
  const startLngLat = app.lastInspectLngLat;
  if (isNearAircraft(startLngLat)) {
    probeLines = [];
    discsProbe = [];
    panPink = [];
    probeArrival = [];
    clearProbeArrival();
    syncPathSource();
    hooks.setLastPathScreenBounds(null);
    hooks.updateCellTooltip();
    return;
  }
  const styled = styledRoute(cell, "inspect", startLngLat, null, true);
  probeLines = styled.lines;
  discsProbe = styled.discs;
  panPink = panPinkFeatures(cell);
  const coordinates = styled.lines.flatMap((feature) => feature.geometry.coordinates);
  if (coordinates.length >= 2) {
    hooks.setLastPathScreenBounds(hooks.pathScreenBounds(coordinates));
  } else {
    hooks.setLastPathScreenBounds(null);
  }
  syncPathSource();
  scheduleProbeArrival(cell);
  hooks.updateCellTooltip();
}

export function clearGeoPath() {
  aircraftLines = [];
  aircraftArrival = [];
  discsGeo = [];
  syncPathSource();
}

export function clearInspectPath() {
  probeLines = [];
  discsProbe = [];
  panPink = [];
  probeArrival = [];
  clearProbeArrival();
  syncPathSource();
}

export function clearAllGlidePaths() {
  clearGeoPath();
  clearInspectPath();
  hooks.clearOptionalArea?.();
}

export function clearGlidePath() {
  clearAllGlidePaths();
}
