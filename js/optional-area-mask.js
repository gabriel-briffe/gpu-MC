/** Cell is in the optional area (arrival clears the cone floor). */
const FLAG_OPTION = 1;

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

function hasConeFloor(floors, maxAltitude, idx) {
  const alt = floors[idx];
  return Number.isFinite(alt) && alt < maxAltitude;
}

function cellBlocksRay(best, floors, maxAltitude, width, height, cx, cy, ox, oy, cellSizeM, glideRatio) {
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) {
    return true;
  }
  if (cx === ox && cy === oy) {
    return false;
  }
  const i = cy * width + cx;
  if (!hasConeFloor(floors, maxAltitude, i)) {
    return false;
  }
  const originAlt = best[oy * width + ox];
  const descent =
    originAlt -
    (Math.hypot((cx - ox) * cellSizeM, (cy - oy) * cellSizeM) / glideRatio);
  return floors[i] >= descent;
}

/** Extended Bresenham LOS matching the GPU downward shader. */
function inView(best, floors, maxAltitude, width, height, x0, y0, ox, oy, cellSizeM, glideRatio) {
  if (ox < 0 || oy < 0 || ox >= width || oy >= height) {
    return false;
  }
  if (x0 === ox && y0 === oy) {
    return true;
  }

  const adx = Math.abs(ox - x0);
  const ady = Math.abs(oy - y0);
  let x1 = x0;
  let y1 = y0;
  const xstep = ox > x1 ? 1 : -1;
  const ystep = oy > y1 ? 1 : -1;
  const dx = adx;
  const dy = ady;
  const ddy = dy * 2;
  const ddx = dx * 2;
  let error = dx;
  let errorprev = error;

  if (dx >= dy) {
    for (let s = 0; s < dx; s += 1) {
      x1 += xstep;
      error += ddy;
      if (error > ddx) {
        y1 += ystep;
        error -= ddx;
        if (error + errorprev < ddx) {
          if (
            cellBlocksRay(
              best,
              floors,
              maxAltitude,
              width,
              height,
              x1,
              y1 - ystep,
              ox,
              oy,
              cellSizeM,
              glideRatio
            )
          ) {
            return false;
          }
        } else if (error + errorprev > ddx) {
          if (
            cellBlocksRay(
              best,
              floors,
              maxAltitude,
              width,
              height,
              x1 - xstep,
              y1,
              ox,
              oy,
              cellSizeM,
              glideRatio
            )
          ) {
            return false;
          }
        }
      }
      if (
        cellBlocksRay(best, floors, maxAltitude, width, height, x1, y1, ox, oy, cellSizeM, glideRatio)
      ) {
        return false;
      }
      errorprev = error;
    }
  } else {
    for (let s = 0; s < dy; s += 1) {
      y1 += ystep;
      error += ddx;
      if (error > ddy) {
        x1 += xstep;
        error -= ddy;
        if (error + errorprev < ddy) {
          if (
            cellBlocksRay(
              best,
              floors,
              maxAltitude,
              width,
              height,
              x1 - xstep,
              y1,
              ox,
              oy,
              cellSizeM,
              glideRatio
            )
          ) {
            return false;
          }
        } else if (error + errorprev > ddy) {
          if (
            cellBlocksRay(
              best,
              floors,
              maxAltitude,
              width,
              height,
              x1,
              y1 - ystep,
              ox,
              oy,
              cellSizeM,
              glideRatio
            )
          ) {
            return false;
          }
        }
      }
      if (
        cellBlocksRay(best, floors, maxAltitude, width, height, x1, y1, ox, oy, cellSizeM, glideRatio)
      ) {
        return false;
      }
      errorprev = error;
    }
  }
  return true;
}

/**
 * Downward options wavefront (CPU). Matches the GPU Option-cell growth:
 * only cells above the cone floor are written; LOS uses extended Bresenham.
 */
export function buildOptionalMask({
  dem,
  altitudes,
  maxAltitude,
  gi,
  gj,
  startAlt,
  glideRatio,
}) {
  const width = dem.width;
  const height = dem.height;
  const count = width * height;
  const mask = new Uint8Array(count);
  // Float64 so heap arrivals match stored best under strict inequality
  // (Float32 rounding made pop() treat live entries as stale).
  const best = new Float64Array(count).fill(-1);
  const originX = new Int32Array(count).fill(-1);
  const originY = new Int32Array(count).fill(-1);
  const flags = new Uint8Array(count);
  const finish = () => {
    mask.arrivals = best;
    mask.originX = originX;
    mask.originY = originY;
    return mask;
  };

  if (
    !Number.isFinite(startAlt) ||
    !Number.isFinite(glideRatio) ||
    glideRatio <= 0 ||
    gi < 0 ||
    gj < 0 ||
    gi >= width ||
    gj >= height
  ) {
    return finish();
  }

  const startIdx = gj * width + gi;
  if (!hasConeFloor(altitudes, maxAltitude, startIdx) || !(startAlt > altitudes[startIdx])) {
    return finish();
  }

  best[startIdx] = startAlt;
  originX[startIdx] = gi;
  originY[startIdx] = gj;
  flags[startIdx] = FLAG_OPTION;
  mask[startIdx] = 1;

  const heap = new MaxArrivalHeap();
  heap.push(startIdx, startAlt);
  const cellSizeM = dem.cellSizeM;
  const offsets = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];

  while (heap.size > 0) {
    const { index, arrival } = heap.pop();
    if (!(flags[index] & FLAG_OPTION)) {
      continue;
    }
    if (arrival < best[index]) {
      continue;
    }
    const x = index % width;
    const y = (index / width) | 0;
    const fromOx = originX[index];
    const fromOy = originY[index];
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
        continue;
      }
      const nIdx = ny * width + nx;

      let electedOx = x;
      let electedOy = y;
      if (
        fromOx >= 0 &&
        fromOy >= 0 &&
        inView(best, altitudes, maxAltitude, width, height, nx, ny, fromOx, fromOy, cellSizeM, glideRatio)
      ) {
        electedOx = fromOx;
        electedOy = fromOy;
      }

      const electedIdx = electedOy * width + electedOx;
      if (!(flags[electedIdx] & FLAG_OPTION)) {
        continue;
      }

      const dist = Math.hypot((nx - electedOx) * cellSizeM, (ny - electedOy) * cellSizeM);
      const next = best[electedIdx] - dist / glideRatio;

      // No upward-cone value (capped / unreachable): not an Option cell.
      if (!hasConeFloor(altitudes, maxAltitude, nIdx)) {
        continue;
      }
      if (next <= altitudes[nIdx]) {
        continue;
      }
      if (next <= best[nIdx]) {
        continue;
      }
      best[nIdx] = next;
      originX[nIdx] = electedOx;
      originY[nIdx] = electedOy;
      flags[nIdx] = FLAG_OPTION;
      mask[nIdx] = 1;
      heap.push(nIdx, next);
    }
  }

  return finish();
}
