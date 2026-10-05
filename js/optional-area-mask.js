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

function coneAltAt(altitudes, maxAltitude, idx) {
  const alt = altitudes[idx];
  if (!Number.isFinite(alt) || alt >= maxAltitude) {
    return Number.POSITIVE_INFINITY;
  }
  return alt;
}

/**
 * Descending glide from a clicked cell. A cell is optional when the arrival
 * altitude (start altitude minus path distance / L/D) is above the airport
 * glide-cone altitude. Ridge height is already included in that cone.
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

  const originX = new Int32Array(count).fill(-1);
  const originY = new Int32Array(count).fill(-1);
  const best = new Float32Array(count);
  best.fill(Number.NEGATIVE_INFINITY);
  const finish = () => {
    mask.arrivals = best;
    mask.originX = originX;
    mask.originY = originY;
    return mask;
  };

  const startIdx = gj * width + gi;
  const startCone = coneAltAt(altitudes, maxAltitude, startIdx);
  if (!(startAlt > startCone)) {
    return finish();
  }

  originX[startIdx] = gi;
  originY[startIdx] = gj;
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
      const cone = coneAltAt(altitudes, maxAltitude, nIdx);
      if (!(nextArrival > cone)) {
        continue;
      }
      if (nextArrival <= best[nIdx]) {
        continue;
      }
      best[nIdx] = nextArrival;
      originX[nIdx] = x;
      originY[nIdx] = y;
      mask[nIdx] = 1;
      heap.push(nIdx, nextArrival);
    }
  }

  return finish();
}

