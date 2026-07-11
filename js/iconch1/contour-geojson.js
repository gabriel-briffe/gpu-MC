import {
  buildSectorGeoJsonWasm,
  ensureRegridWasm,
  isRegridWasmEnabled,
} from "./regrid.js";

const SECTOR_POSITIVE_MIN = 0.5;
const SECTOR_POSITIVE_MAX = 5.0;
const SECTOR_NEGATIVE_START = -0.5;
const SECTOR_NEGATIVE_END = -5.0;
const SECTOR_STEP = 0.5;

function lerpColor(hexA, hexB, t) {
  const parse = (hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [ar, ag, ab] = parse(hexA);
  const [br, bg, bb] = parse(hexB);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function buildSectorLevelScale(start, end, step, colorStart, colorMid, colorEnd, compare) {
  const count = Math.round(Math.abs(end - start) / step) + 1;
  const direction = end >= start ? 1 : -1;
  const levels = [];

  for (let i = 0; i < count; i += 1) {
    const threshold = Number((start + direction * i * step).toFixed(1));
    const t = count === 1 ? 0 : i / (count - 1);
    const color = colorMid
      ? t <= 0.5
        ? lerpColor(colorStart, colorMid, t / 0.5)
        : lerpColor(colorMid, colorEnd, (t - 0.5) / 0.5)
      : lerpColor(colorStart, colorEnd, t);
    levels.push({ threshold, color, compare });
  }

  return levels;
}

const SECTOR_LEVELS = [
  ...buildSectorLevelScale(
    SECTOR_NEGATIVE_START,
    SECTOR_NEGATIVE_END,
    SECTOR_STEP,
    "#40e0d0",
    null,
    "#0c1844",
    "lt"
  ),
  ...buildSectorLevelScale(
    SECTOR_POSITIVE_MIN,
    SECTOR_POSITIVE_MAX,
    SECTOR_STEP,
    "#f5d000",
    "#ff2a2a",
    "#9b4dca",
    "gt"
  ),
];

function normalizeLon(lon) {
  let out = lon;
  while (out > 180) out -= 360;
  while (out <= -180) out += 360;
  return out;
}

function indexFromIJ(i, j, ni, scanMode) {
  const colMajor = (scanMode & 0x20) !== 0;
  return colMajor ? i * ni + j : j * ni + i;
}

function cellLatLon(i, j, field) {
  const { la1_deg, lo1_deg, di_deg, dj_deg, scan_mode } = field;
  const iDir = (scan_mode & 0x80) === 0 ? 1 : -1;
  const jDir = (scan_mode & 0x40) !== 0 ? 1 : -1;
  return {
    lat: la1_deg + j * dj_deg * jDir,
    lon: normalizeLon(lo1_deg + i * di_deg * iDir),
  };
}

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

function sampleFieldValue(i, j, field, values) {
  const { ni, nj, scan_mode } = field;
  if (i < 0 || j < 0 || i >= ni || j >= nj) return NaN;
  const idx = indexFromIJ(i, j, ni, scan_mode);
  const value = values[idx];
  return Number.isFinite(value) ? value : NaN;
}

function cellCenter(i, j, field) {
  const { lat, lon } = cellLatLon(i, j, field);
  return [lon, lat];
}

function edgePoint(edge, cornerValues, corners, threshold) {
  const [a, b] = EDGE_VERTICES[edge];
  const z1 = cornerValues[a];
  const z2 = cornerValues[b];
  const p1 = corners[a];
  const p2 = corners[b];
  if (!Number.isFinite(z1) || !Number.isFinite(z2) || z1 === z2) return null;
  const t = (threshold - z1) / (z2 - z1);
  if (t < 0 || t > 1) return null;
  return [
    p1[0] + t * (p2[0] - p1[0]),
    p1[1] + t * (p2[1] - p1[1]),
  ];
}

function stitchSegments(segments) {
  if (!segments.length) return [];

  const endpointMap = new Map();
  for (let i = 0; i < segments.length; i += 1) {
    const [a, b] = segments[i];
    const ka = endpointKey(a[0], a[1]);
    const kb = endpointKey(b[0], b[1]);
    if (!endpointMap.has(ka)) endpointMap.set(ka, []);
    if (!endpointMap.has(kb)) endpointMap.set(kb, []);
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
        if (cand.seg === seg || used[cand.seg]) continue;
        next = cand.seg;
        nextEnd = cand.end;
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
    if (deduped.length >= 2) lines.push(deduped);
  };

  for (let i = 0; i < segments.length; i += 1) {
    if (used[i]) continue;
    follow(i, 0);
    if (!used[i]) follow(i, 1);
  }

  return lines;
}

function closeLineRing(line) {
  if (line.length < 3) return null;
  const ring = line.slice();
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (endpointKey(first[0], first[1]) !== endpointKey(last[0], last[1])) {
    ring.push(first);
  }
  return ring.length >= 4 ? ring : null;
}

function ringSignedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return area / 2;
}

function ringCentroid(ring) {
  let sumLon = 0;
  let sumLat = 0;
  const n = ring.length - 1;
  if (n <= 0) return ring[0];
  for (let i = 0; i < n; i += 1) {
    sumLon += ring[i][0];
    sumLat += ring[i][1];
  }
  return [sumLon / n, sumLat / n];
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function linesToMultiPolygon(lines) {
  const rings = lines
    .map((line) => closeLineRing(line))
    .filter(Boolean)
    .map((ring) => (ringSignedArea(ring) < 0 ? ring.slice().reverse() : ring));

  const ranked = rings
    .map((ring) => ({
      ring,
      area: Math.abs(ringSignedArea(ring)),
      centroid: ringCentroid(ring),
    }))
    .sort((a, b) => b.area - a.area);

  const assigned = new Set();
  const polygons = [];

  for (let i = 0; i < ranked.length; i += 1) {
    if (assigned.has(i)) continue;
    const polygon = [ranked[i].ring];
    assigned.add(i);

    for (let j = i + 1; j < ranked.length; j += 1) {
      if (assigned.has(j)) continue;
      const candidate = ranked[j];
      if (!pointInRing(candidate.centroid, ranked[i].ring)) continue;

      let nestedInHole = false;
      for (let holeIdx = 1; holeIdx < polygon.length; holeIdx += 1) {
        if (pointInRing(candidate.centroid, polygon[holeIdx])) {
          nestedInHole = true;
          break;
        }
      }
      if (nestedInHole) continue;

      let holeRing = candidate.ring;
      if (ringSignedArea(holeRing) > 0) {
        holeRing = holeRing.slice().reverse();
      }
      polygon.push(holeRing);
      assigned.add(j);
    }

    polygons.push(polygon);
  }

  return polygons;
}

function contoursForThreshold(field, values, threshold, compare = "gt") {
  const { ni, nj } = field;
  const segments = [];
  const isInside =
    compare === "lt"
      ? (value) => value < threshold
      : (value) => value > threshold;

  for (let j = 0; j < nj - 1; j += 1) {
    for (let i = 0; i < ni - 1; i += 1) {
      const cornerValues = CORNER_OFFSETS.map(([dx, dy]) =>
        sampleFieldValue(i + dx, j + dy, field, values)
      );
      if (cornerValues.some((value) => !Number.isFinite(value))) continue;

      let caseIndex = 0;
      for (let c = 0; c < 4; c += 1) {
        if (isInside(cornerValues[c])) caseIndex |= 1 << c;
      }
      if (caseIndex === 0 || caseIndex === 15) continue;

      const corners = CORNER_OFFSETS.map(([dx, dy]) => cellCenter(i + dx, j + dy, field));
      for (const [e0, e1] of MS_SEGMENTS[caseIndex]) {
        const p0 = edgePoint(e0, cornerValues, corners, threshold);
        const p1 = edgePoint(e1, cornerValues, corners, threshold);
        if (p0 && p1) segments.push([p0, p1]);
      }
    }
  }

  return stitchSegments(segments);
}

function buildSectorGeoJsonJs(field, values) {
  const features = [];

  for (const { threshold, color, compare } of SECTOR_LEVELS) {
    const lines = contoursForThreshold(field, values, threshold, compare);
    const polygons = linesToMultiPolygon(lines);
    if (polygons.length === 0) continue;
    features.push({
      type: "Feature",
      properties: { threshold, color, polygons: polygons.length },
      geometry: {
        type: "MultiPolygon",
        coordinates: polygons,
      },
    });
  }

  return {
    type: "FeatureCollection",
    features,
  };
}

export function buildSectorGeoJson(field, values) {
  if (isRegridWasmEnabled()) {
    return buildSectorGeoJsonWasm(field, values);
  }
  return buildSectorGeoJsonJs(field, values);
}

export async function ensureSectorContourWasm() {
  return ensureRegridWasm();
}
