import { gridCellToLngLat } from "./geo.js";

const CONTOUR_INTERVAL_M = 100;

const MS_SEGMENTS = [
  [],
  [[3, 0]],
  [[0, 1]],
  [[3, 1]],
  [[1, 2]],
  [[3, 0], [1, 2]],
  [[0, 2]],
  [[3, 2]],
  [[2, 3]],
  [[2, 0]],
  [[0, 1], [2, 3]],
  [[2, 1]],
  [[1, 3]],
  [[1, 0]],
  [[0, 3]],
  [],
];

const CORNER_OFFSETS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

const EDGE_VERTICES = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
];

function endpointKey(lng, lat) {
  return `${lng.toFixed(7)},${lat.toFixed(7)}`;
}

function isValidCell(idx, altitudes, ground, originX, maxAltitude) {
  if (ground[idx] === 1) {
    return false;
  }
  if (originX[idx] < 0) {
    return false;
  }
  const alt = altitudes[idx];
  return Number.isFinite(alt) && alt < maxAltitude;
}

function sampleAlt(i, j, width, height, altitudes, ground, originX, maxAltitude) {
  if (i < 0 || j < 0 || i >= width || j >= height) {
    return NaN;
  }
  const idx = j * width + i;
  if (!isValidCell(idx, altitudes, ground, originX, maxAltitude)) {
    return NaN;
  }
  return altitudes[idx];
}

function cellCenter(i, j, dem) {
  const { lng, lat } = gridCellToLngLat(i, j, dem);
  return [lng, lat];
}

function edgePoint(i, j, edge, values, corners, level, dem) {
  const [a, b] = EDGE_VERTICES[edge];
  const z1 = values[a];
  const z2 = values[b];
  const p1 = corners[a];
  const p2 = corners[b];
  if (!Number.isFinite(z1) || !Number.isFinite(z2) || z1 === z2) {
    return null;
  }
  const t = (level - z1) / (z2 - z1);
  if (t < 0 || t > 1) {
    return null;
  }
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

function stitchSegments(segments) {
  if (!segments.length) {
    return [];
  }

  const endpointMap = new Map();
  for (let i = 0; i < segments.length; i += 1) {
    const [a, b] = segments[i];
    const ka = endpointKey(a[0], a[1]);
    const kb = endpointKey(b[0], b[1]);
    if (!endpointMap.has(ka)) {
      endpointMap.set(ka, []);
    }
    if (!endpointMap.has(kb)) {
      endpointMap.set(kb, []);
    }
    endpointMap.get(ka).push({ seg: i, end: 0 });
    endpointMap.get(kb).push({ seg: i, end: 1 });
  }

  const used = new Uint8Array(segments.length);
  const lines = [];

  const follow = (startSeg, startEnd) => {
    const coords = [];
    let seg = startSeg;
    let end = startEnd;

    while (seg >= 0 && !used[seg]) {
      used[seg] = 1;
      const [a, b] = segments[seg];
      if (end === 0) {
        coords.push(a, b);
      } else {
        coords.push(b, a);
      }
      const tip = end === 0 ? b : a;
      const key = endpointKey(tip[0], tip[1]);
      const candidates = endpointMap.get(key) ?? [];
      let next = -1;
      let nextEnd = 0;
      for (const cand of candidates) {
        if (cand.seg === seg || used[cand.seg]) {
          continue;
        }
        next = cand.seg;
        nextEnd = cand.end === 0 ? 1 : 0;
        break;
      }
      seg = next;
      end = nextEnd;
    }

    const deduped = [];
    for (const pt of coords) {
      const last = deduped[deduped.length - 1];
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) {
        deduped.push(pt);
      }
    }
    if (deduped.length >= 2) {
      lines.push(deduped);
    }
  };

  for (let i = 0; i < segments.length; i += 1) {
    if (used[i]) {
      continue;
    }
    follow(i, 0);
    if (!used[i]) {
      follow(i, 1);
    }
  }

  return lines;
}

function contoursForLevel(level, dem, altitudes, ground, originX, maxAltitude) {
  const { width, height } = dem;
  const segments = [];

  for (let j = 0; j < height - 1; j += 1) {
    for (let i = 0; i < width - 1; i += 1) {
      const values = CORNER_OFFSETS.map(([dx, dy]) =>
        sampleAlt(i + dx, j + dy, width, height, altitudes, ground, originX, maxAltitude)
      );

      if (values.some((z) => !Number.isFinite(z))) {
        continue;
      }

      let caseIndex = 0;
      for (let c = 0; c < 4; c += 1) {
        if (values[c] >= level) {
          caseIndex |= 1 << c;
        }
      }
      if (caseIndex === 0 || caseIndex === 15) {
        continue;
      }

      const corners = CORNER_OFFSETS.map(([dx, dy]) => cellCenter(i + dx, j + dy, dem));
      for (const [e0, e1] of MS_SEGMENTS[caseIndex]) {
        const p0 = edgePoint(i, j, e0, values, corners, level, dem);
        const p1 = edgePoint(i, j, e1, values, corners, level, dem);
        if (p0 && p1) {
          segments.push([p0, p1]);
        }
      }
    }
  }

  return stitchSegments(segments);
}

/**
 * Build a GeoJSON FeatureCollection of 100 m altitude contours (non-ground cells only).
 */
export function buildAltitudeContours(dem, altitudes, ground, originX, maxAltitude, intervalM = CONTOUR_INTERVAL_M) {
  const { width, height } = dem;
  let maxReachable = 0;

  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const idx = j * width + i;
      if (!isValidCell(idx, altitudes, ground, originX, maxAltitude)) {
        continue;
      }
      maxReachable = Math.max(maxReachable, altitudes[idx]);
    }
  }

  const maxLevel = Math.floor(maxReachable / intervalM) * intervalM;
  const features = [];

  for (let level = intervalM; level <= maxLevel; level += intervalM) {
    const lines = contoursForLevel(level, dem, altitudes, ground, originX, maxAltitude);
    for (const coordinates of lines) {
      if (coordinates.length < 2) {
        continue;
      }
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates,
        },
        properties: {
          altitude: level,
          label: `${level} m`,
        },
      });
    }
  }

  return {
    type: "FeatureCollection",
    features,
  };
}
