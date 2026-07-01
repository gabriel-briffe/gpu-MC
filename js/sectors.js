import { globalPixelToLngLat } from "./geo.js";

export const SECTOR_ORIGIN_RESOLVE_PASSES = 16;

function isAirSectorCell(idx, ground, originX, altitudes, maxAltitude) {
  if (ground[idx] === 1) {
    return false;
  }
  if (originX[idx] < 0) {
    return false;
  }
  const alt = altitudes[idx];
  return Number.isFinite(alt) && alt < maxAltitude;
}

export function resolveDeepOriginsCpu(originX, originY, ground, width, height) {
  const rx = new Int32Array(originX);
  const ry = new Int32Array(originY);

  for (let pass = 0; pass < SECTOR_ORIGIN_RESOLVE_PASSES; pass += 1) {
    const nx = new Int32Array(rx);
    const ny = new Int32Array(ry);
    for (let j = 0; j < height; j += 1) {
      for (let i = 0; i < width; i += 1) {
        const idx = j * width + i;
        if (ground[idx] === 1 || rx[idx] < 0 || ry[idx] < 0) {
          continue;
        }
        const tx = rx[idx];
        const ty = ry[idx];
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) {
          continue;
        }
        const ti = ty * width + tx;
        nx[idx] = rx[ti];
        ny[idx] = ry[ti];
      }
    }
    rx.set(nx);
    ry.set(ny);
  }

  return { originX: rx, originY: ry };
}

function rootKey(idx, originX, originY) {
  return `${originX[idx]},${originY[idx]}`;
}

function edgeVerticalLngLat(i, j, dem) {
  const { gx0, gy0, zoom } = dem;
  const gx = gx0 + i + 1;
  const p0 = globalPixelToLngLat(gx, gy0 + j, zoom);
  const p1 = globalPixelToLngLat(gx, gy0 + j + 1, zoom);
  return [
    [p0.lng, p0.lat],
    [p1.lng, p1.lat],
  ];
}

function edgeHorizontalLngLat(i, j, dem) {
  const { gx0, gy0, zoom } = dem;
  const gy = gy0 + j + 1;
  const p0 = globalPixelToLngLat(gx0 + i, gy, zoom);
  const p1 = globalPixelToLngLat(gx0 + i + 1, gy, zoom);
  return [
    [p0.lng, p0.lat],
    [p1.lng, p1.lat],
  ];
}

/**
 * GeoJSON LineStrings along air/air sector boundaries (not grid edge, not ground).
 */
export function buildSectorBorderGeojson(
  dem,
  altitudes,
  ground,
  originX,
  originY,
  maxAltitude
) {
  const { width, height } = dem;
  const { originX: rx, originY: ry } = resolveDeepOriginsCpu(
    originX,
    originY,
    ground,
    width,
    height
  );

  const airRoot = (i, j) => {
    const idx = j * width + i;
    if (!isAirSectorCell(idx, ground, rx, altitudes, maxAltitude)) {
      return null;
    }
    return rootKey(idx, rx, ry);
  };

  const features = [];

  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width - 1; i += 1) {
      const left = airRoot(i, j);
      const right = airRoot(i + 1, j);
      if (left === null || right === null || left === right) {
        continue;
      }
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: edgeVerticalLngLat(i, j, dem),
        },
        properties: {},
      });
    }
  }

  for (let j = 0; j < height - 1; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const below = airRoot(i, j);
      const above = airRoot(i, j + 1);
      if (below === null || above === null || below === above) {
        continue;
      }
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: edgeHorizontalLngLat(i, j, dem),
        },
        properties: {},
      });
    }
  }

  return {
    type: "FeatureCollection",
    features,
  };
}
