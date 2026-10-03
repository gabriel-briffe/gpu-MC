const ALT_EPSILON_M = 0.05;

class MaxArrivalHeap {
  constructor() {
    this.idx = [];
    this.arrival = [];
  }

  get size() {
    return this.idx.length;
  }

  push(index, arrival) {
    this.idx.push(index);
    this.arrival.push(arrival);
    this.#up(this.idx.length - 1);
  }

  pop() {
    const index = this.idx[0];
    const arrival = this.arrival[0];
    const last = this.idx.length - 1;
    if (last > 0) {
      this.idx[0] = this.idx[last];
      this.arrival[0] = this.arrival[last];
    }
    this.idx.pop();
    this.arrival.pop();
    if (this.idx.length > 0) {
      this.#down(0);
    }
    return { index, arrival };
  }

  #up(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.arrival[parent] >= this.arrival[i]) {
        return;
      }
      this.#swap(parent, i);
      i = parent;
    }
  }

  #down(i) {
    const n = this.idx.length;
    while (true) {
      let best = i;
      const left = i * 2 + 1;
      const right = left + 1;
      if (left < n && this.arrival[left] > this.arrival[best]) {
        best = left;
      }
      if (right < n && this.arrival[right] > this.arrival[best]) {
        best = right;
      }
      if (best === i) {
        return;
      }
      this.#swap(i, best);
      i = best;
    }
  }

  #swap(a, b) {
    const idx = this.idx[a];
    this.idx[a] = this.idx[b];
    this.idx[b] = idx;
    const arrival = this.arrival[a];
    this.arrival[a] = this.arrival[b];
    this.arrival[b] = arrival;
  }
}

function terrainMslAt(dem, idx) {
  if (dem.terrainMsl) {
    return dem.terrainMsl[idx];
  }
  return dem.elevation[idx] - dem.groundClearance;
}

function floorAltAt(dem, idx, groundClearance) {
  return terrainMslAt(dem, idx) + groundClearance;
}

function coneAltAt(altitudes, maxAltitude, idx) {
  const alt = altitudes[idx];
  if (!Number.isFinite(alt) || alt >= maxAltitude) {
    return Number.POSITIVE_INFINITY;
  }
  return alt;
}

/**
 * Descending glide from a clicked cell. A cell is optional when the arrival
 * altitude (start altitude minus path distance / L/D) is still at least
 * ground + clearance and at least the airport glide-cone altitude.
 * Distance is the shortest 8-connected path, so the mask can go around a ridge.
 */
export function buildOptionalMask({
  dem,
  altitudes,
  maxAltitude,
  gi,
  gj,
  startAlt,
  glideRatio,
  groundClearance,
}) {
  const width = dem.width;
  const height = dem.height;
  const count = width * height;
  const mask = new Uint8Array(count);
  if (
    !Number.isFinite(startAlt) ||
    !Number.isFinite(glideRatio) ||
    glideRatio <= 0 ||
    gi < 0 ||
    gj < 0 ||
    gi >= width ||
    gj >= height
  ) {
    return mask;
  }

  const startIdx = gj * width + gi;
  const startNeed = Math.max(
    floorAltAt(dem, startIdx, groundClearance),
    coneAltAt(altitudes, maxAltitude, startIdx)
  );
  if (startAlt + ALT_EPSILON_M < startNeed) {
    return mask;
  }

  const best = new Float32Array(count);
  best.fill(Number.NEGATIVE_INFINITY);
  best[startIdx] = startAlt;
  mask[startIdx] = 1;

  const heap = new MaxArrivalHeap();
  heap.push(startIdx, startAlt);
  const cellSizeM = dem.cellSizeM;
  const offsets = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];

  while (heap.size > 0) {
    const { index, arrival } = heap.pop();
    if (arrival < best[index] - ALT_EPSILON_M) {
      continue;
    }
    const x = index % width;
    const y = (index / width) | 0;
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
        continue;
      }
      const nIdx = ny * width + nx;
      const step = cellSizeM * Math.hypot(dx, dy);
      const nextArrival = arrival - step / glideRatio;
      const need = Math.max(
        floorAltAt(dem, nIdx, groundClearance),
        coneAltAt(altitudes, maxAltitude, nIdx)
      );
      if (nextArrival + ALT_EPSILON_M < need) {
        continue;
      }
      if (nextArrival <= best[nIdx]) {
        continue;
      }
      best[nIdx] = nextArrival;
      mask[nIdx] = 1;
      heap.push(nIdx, nextArrival);
    }
  }

  return mask;
}

