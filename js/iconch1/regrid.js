const MAX_GRID_CELLS = 450_000;
const IDW_NEIGHBORS = 8;
const IDW_POWER = 2;
const IDW_SEARCH_RADIUS_FACTOR = 1.75;

function computeBounds(lats, lons) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  for (let i = 0; i < lats.length; i += 1) {
    const lat = lats[i];
    const lon = lons[i];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  if (!Number.isFinite(minLon)) {
    throw new Error("Cannot regrid: no valid source coordinates");
  }

  return { minLon, maxLon, minLat, maxLat };
}

function gridDimensions(bounds, spacingDeg) {
  let ni = Math.max(2, Math.round((bounds.maxLon - bounds.minLon) / spacingDeg) + 1);
  let nj = Math.max(2, Math.round((bounds.maxLat - bounds.minLat) / spacingDeg) + 1);

  if (ni * nj > MAX_GRID_CELLS) {
    const scale = Math.sqrt((ni * nj) / MAX_GRID_CELLS);
    ni = Math.max(2, Math.round(ni / scale));
    nj = Math.max(2, Math.round(nj / scale));
  }

  const di = (bounds.maxLon - bounds.minLon) / (ni - 1);
  const dj = (bounds.maxLat - bounds.minLat) / (nj - 1);
  return { ni, nj, di, dj };
}

function buildSpatialIndex(lats, lons, bucketSize) {
  const buckets = new Map();

  for (let p = 0; p < lats.length; p += 1) {
    const lat = lats[p];
    const lon = lons[p];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const bx = Math.floor(lon / bucketSize);
    const by = Math.floor(lat / bucketSize);
    const key = `${bx},${by}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(p);
  }

  return buckets;
}

function idwAt(lon, lat, lats, lons, values, buckets, bucketSize, maxDistDeg) {
  const maxDist2 = maxDistDeg * maxDistDeg;
  const bx = Math.floor(lon / bucketSize);
  const by = Math.floor(lat / bucketSize);
  const candidates = [];

  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const bucket = buckets.get(`${bx + dx},${by + dy}`);
      if (!bucket) continue;
      for (const p of bucket) {
        const value = values[p];
        if (!Number.isFinite(value)) continue;
        const dLon = lons[p] - lon;
        const dLat = lats[p] - lat;
        const dist2 = dLon * dLon + dLat * dLat;
        if (dist2 > maxDist2) continue;
        candidates.push({ p, dist2 });
      }
    }
  }

  if (candidates.length === 0) return NaN;

  candidates.sort((a, b) => a.dist2 - b.dist2);
  const nearest = candidates.slice(0, IDW_NEIGHBORS);

  if (nearest[0].dist2 < 1e-14) {
    return values[nearest[0].p];
  }

  let weightSum = 0;
  let valueSum = 0;
  for (const { p, dist2 } of nearest) {
    const weight = 1 / Math.pow(Math.sqrt(dist2), IDW_POWER);
    weightSum += weight;
    valueSum += weight * values[p];
  }

  return valueSum / weightSum;
}

export async function regridIdw(lats, lons, values, spacingDeg) {
  const bounds = computeBounds(lats, lons);
  const { ni, nj, di, dj } = gridDimensions(bounds, spacingDeg);
  const bucketSize = Math.max(di, dj);
  const maxDistDeg = bucketSize * IDW_SEARCH_RADIUS_FACTOR;
  const buckets = buildSpatialIndex(lats, lons, bucketSize);
  const out = new Float32Array(ni * nj);
  const yieldEvery = Math.max(1, Math.floor(nj / 20));

  for (let j = 0; j < nj; j += 1) {
    const lat = bounds.minLat + j * dj;
    for (let i = 0; i < ni; i += 1) {
      const lon = bounds.minLon + i * di;
      out[j * ni + i] = idwAt(lon, lat, lats, lons, values, buckets, bucketSize, maxDistDeg);
    }
    if (j > 0 && j % yieldEvery === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    ni,
    nj,
    la1_deg: bounds.minLat,
    lo1_deg: bounds.minLon,
    la2_deg: bounds.maxLat,
    lo2_deg: bounds.maxLon,
    di_deg: di,
    dj_deg: dj,
    // Bit 0x40: j index increases northward (row 0 = south), matching our south→north storage.
    scan_mode: 0x40,
    values: out,
  };
}
