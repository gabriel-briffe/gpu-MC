import { gridCellDistanceM, gridCellToLngLat } from "./geo.js";
import { ensurePathLayer, raisePathLayer, getPathLayerReady } from "./map/layers.js";

let hooks;

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

function terrainMslAtCell(x, y, dem) {
  const idx = cellIndex(x, y, dem);
  return dem.terrainMsl
    ? dem.terrainMsl[idx]
    : dem.elevation[idx] - dem.groundClearance;
}

function isDownhillGroundSegment(from, to, ground, dem) {
  const fromIdx = cellIndex(from.x, from.y, dem);
  if (ground[fromIdx] !== 1) {
    return false;
  }
  return terrainMslAtCell(to.x, to.y, dem) < terrainMslAtCell(from.x, from.y, dem);
}

function cellToLngLatCoord(x, y, dem) {
  const pt = gridCellToLngLat(x, y, dem);
  return [pt.lng, pt.lat];
}

function isSeedCell(x, y, dem) {
  if (dem.seeds?.length) {
    return dem.seeds.some((seed) => seed.x === x && seed.y === y);
  }
  return x === dem.homeX && y === dem.homeY;
}

function buildPathGeoJson(cells, dem, ground, coordinates) {
  if (cells.length < 2) {
    return {
      type: "FeatureCollection",
      features:
        coordinates.length >= 2
          ? [
              {
                type: "Feature",
                geometry: { type: "LineString", coordinates },
                properties: {},
              },
            ]
          : [],
    };
  }

  const features = [];
  let segmentCoords = [];
  let segmentKind = null;

  for (let i = 1; i < cells.length; i += 1) {
    const from = cells[i - 1];
    const to = cells[i];
    const kind = isDownhillGroundSegment(from, to, ground, dem)
      ? "downhill-ground"
      : "default";
    const fromCoord = cellToLngLatCoord(from.x, from.y, dem);
    const toCoord = cellToLngLatCoord(to.x, to.y, dem);

    if (segmentKind === kind && segmentCoords.length > 0) {
      segmentCoords.push(toCoord);
    } else {
      if (segmentCoords.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: segmentCoords },
          properties: { segment: segmentKind },
        });
      }
      segmentKind = kind;
      segmentCoords = [fromCoord, toCoord];
    }
  }

  if (segmentCoords.length >= 2) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: segmentCoords },
      properties: { segment: segmentKind },
    });
  }

  return { type: "FeatureCollection", features };
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

  return {
    distanceM: path.distanceM,
    requiredAlt,
    seedAlt,
    isGroundSeed: ground[seedIdx] === 1,
    complete: path.complete,
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
}

function setPathSourceData(sourceId, pathData) {
  const map = hooks.getMap();
  ensurePathLayer();
  const coordinates = pathData.coordinates ?? pathData;
  const cells = pathData.cells ?? [];
  const coneState = hooks.getConeState();
  const { dem, ground } = coneState ?? {};

  map.getSource(sourceId).setData(
    dem && ground
      ? buildPathGeoJson(cells, dem, ground, coordinates)
      : {
          type: "FeatureCollection",
          features:
            coordinates.length >= 2
              ? [
                  {
                    type: "Feature",
                    geometry: { type: "LineString", coordinates },
                    properties: {},
                  },
                ]
              : [],
        }
  );
  raisePathLayer();
}

export function refreshGeoPath(cell) {
  const path = traceGlidePath(cell.gi, cell.gj);
  if (path.coordinates.length >= 2) {
    setPathSourceData("glide-path-geo", path);
  } else if (path.coordinates.length === 1) {
    const pt = path.coordinates[0];
    setPathSourceData("glide-path-geo", { coordinates: [pt, pt], cells: path.cells });
  } else {
    clearGeoPath();
  }
}

export function refreshInspectPath(cell) {
  const path = traceGlidePath(cell.gi, cell.gj);
  if (path.coordinates.length >= 2) {
    setPathSourceData("glide-path", path);
    hooks.setLastPathScreenBounds(hooks.pathScreenBounds(path.coordinates));
  } else if (path.coordinates.length === 1) {
    const pt = path.coordinates[0];
    setPathSourceData("glide-path", { coordinates: [pt, pt], cells: path.cells });
    hooks.setLastPathScreenBounds(hooks.pathScreenBounds([pt, pt]));
  } else {
    clearInspectPath();
    hooks.setLastPathScreenBounds(null);
  }
  hooks.updateCellTooltip();
}

export function clearGeoPath() {
  const map = hooks.getMap();
  if (!getPathLayerReady() || !map?.getSource("glide-path-geo")) {
    return;
  }
  map.getSource("glide-path-geo").setData({
    type: "FeatureCollection",
    features: [],
  });
}

export function clearInspectPath() {
  const map = hooks.getMap();
  if (!getPathLayerReady() || !map?.getSource("glide-path")) {
    return;
  }
  map.getSource("glide-path").setData({
    type: "FeatureCollection",
    features: [],
  });
}

export function clearAllGlidePaths() {
  clearGeoPath();
  clearInspectPath();
}

export function updateGlidePath(pathData) {
  setPathSourceData("glide-path", pathData);
}

export function clearGlidePath() {
  clearAllGlidePaths();
}
