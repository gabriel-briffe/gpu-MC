/**
 * CPU upward glide-cone (Dijkstra). Same rules as PROPAGATE_SHADER:
 * extended Bresenham LOS, ground freeze at elev, origin election.
 */
import { buildSeedPaletteGrid } from "./glidecone/sectors-color.js";
import { resolveDeepOriginsCpu } from "./sectors.js";

const FLAG_GROUND = 1;
const YIELD_EVERY = 8192;

class MinReqHeap {
  constructor() {
    this.idx = [];
    this.req = [];
  }

  get size() {
    return this.idx.length;
  }

  push(index, req) {
    this.idx.push(index);
    this.req.push(req);
    this.#up(this.idx.length - 1);
  }

  pop() {
    const index = this.idx[0];
    const req = this.req[0];
    const last = this.idx.length - 1;
    if (last > 0) {
      this.idx[0] = this.idx[last];
      this.req[0] = this.req[last];
    }
    this.idx.pop();
    this.req.pop();
    if (this.idx.length > 0) {
      this.#down(0);
    }
    return { index, req };
  }

  #up(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.req[parent] <= this.req[i]) {
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
      if (left < n && this.req[left] < this.req[best]) {
        best = left;
      }
      if (right < n && this.req[right] < this.req[best]) {
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
    const req = this.req[a];
    this.req[a] = this.req[b];
    this.req[b] = req;
  }
}

/** f32 add/mul/div like WGSL f32 ops used in PROPAGATE_SHADER. */
function f32(x) {
  return Math.fround(x);
}

function coneDelta(dx, dy, cellSizeM, glideRatio) {
  const dist = f32(Math.sqrt(f32(f32(dx) * f32(dx) + f32(dy) * f32(dy))));
  return f32(f32(dist * f32(cellSizeM)) / f32(glideRatio));
}

function cellBlocksRay(elev, best, width, height, cx, cy, ox, oy, cellSizeM, glideRatio) {
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) {
    return true;
  }
  if (cx === ox && cy === oy) {
    return false;
  }
  const originAlt = best[oy * width + ox];
  const glideAlt = f32(originAlt + coneDelta(cx - ox, cy - oy, cellSizeM, glideRatio));
  return elev[cy * width + cx] >= glideAlt;
}

/** Extended Bresenham LOS matching PROPAGATE_SHADER. */
function inView(elev, best, width, height, x0, y0, ox, oy, cellSizeM, glideRatio) {
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
            cellBlocksRay(elev, best, width, height, x1, y1 - ystep, ox, oy, cellSizeM, glideRatio)
          ) {
            return false;
          }
        } else if (error + errorprev > ddx) {
          if (
            cellBlocksRay(elev, best, width, height, x1 - xstep, y1, ox, oy, cellSizeM, glideRatio)
          ) {
            return false;
          }
        }
      }
      if (cellBlocksRay(elev, best, width, height, x1, y1, ox, oy, cellSizeM, glideRatio)) {
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
            cellBlocksRay(elev, best, width, height, x1 - xstep, y1, ox, oy, cellSizeM, glideRatio)
          ) {
            return false;
          }
        } else if (error + errorprev > ddy) {
          if (
            cellBlocksRay(elev, best, width, height, x1, y1 - ystep, ox, oy, cellSizeM, glideRatio)
          ) {
            return false;
          }
        }
      }
      if (cellBlocksRay(elev, best, width, height, x1, y1, ox, oy, cellSizeM, glideRatio)) {
        return false;
      }
      errorprev = error;
    }
  }
  return true;
}

function coneReq(best, width, ox, oy, x, y, cellSizeM, glideRatio) {
  return f32(best[oy * width + ox] + coneDelta(x - ox, y - oy, cellSizeM, glideRatio));
}

function packRgba(r, g, b, a) {
  return (a << 24) | (b << 16) | (g << 8) | r;
}

const SECTOR_RGBA = [
  packRgba(128, 128, 128, 170),
  packRgba(40, 120, 255, 170),
  packRgba(48, 200, 72, 170),
  packRgba(230, 140, 40, 170),
  packRgba(200, 80, 200, 170),
  packRgba(40, 190, 210, 170),
  packRgba(230, 210, 60, 170),
  packRgba(220, 80, 90, 170),
  packRgba(130, 100, 220, 170),
];

/**
 * @returns {Promise<{
 *   altitudes: Float32Array,
 *   originX: Int32Array,
 *   originY: Int32Array,
 *   ground: Uint32Array,
 *   homeAlt: number,
 *   iterations: number,
 *   stopReason: string,
 *   stopped: boolean,
 *   elapsedMs: number,
 *   imageData: ImageData | null,
 *   engine: "cpu",
 * }>}
 */
export async function computeUpwardConeCpu(dem, params, options = {}) {
  const t0 = performance.now();
  const { shouldStop = null, onProgress = null } = options;
  const {
    width,
    height,
    cellSizeM,
    elevation,
    terrainMsl,
    groundClearance,
    seeds: demSeeds,
    homeX,
    homeY,
  } = dem;
  const seeds = demSeeds?.length > 0 ? demSeeds : [{ x: homeX, y: homeY }];
  const {
    glideRatio,
    maxAltitude,
    circuitHeight,
    raw = false,
    contours = false,
    pathOnly = false,
    sectors = false,
    updateMapMs = 100,
  } = params;

  const count = width * height;
  const elev = elevation;
  // Float32 throughout — same storage width as the GPU alt buffers.
  const best = new Float32Array(count).fill(f32(maxAltitude));
  const originX = new Int32Array(count).fill(-1);
  const originY = new Int32Array(count).fill(-1);
  const flags = new Uint8Array(count);
  const heap = new MinReqHeap();

  let homeAlt = f32(maxAltitude);
  for (const seed of seeds) {
    const sx = seed.x | 0;
    const sy = seed.y | 0;
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
      continue;
    }
    const seedIdx = sy * width + sx;
    const terrain = terrainMsl
      ? terrainMsl[seedIdx]
      : f32(elev[seedIdx] - f32(groundClearance));
    const seedAlt = f32(terrain + f32(circuitHeight));
    best[seedIdx] = seedAlt;
    originX[seedIdx] = sx;
    originY[seedIdx] = sy;
    flags[seedIdx] = 0;
    heap.push(seedIdx, seedAlt);
    if (homeAlt === f32(maxAltitude) || seedAlt < homeAlt) {
      homeAlt = seedAlt;
    }
  }

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

  let iterations = 0;
  let stopReason = "converged";
  let lastMapUpdate = 0;
  const needsRaster = raw || sectors || (!contours && !pathOnly);
  const livePreview =
    needsRaster && !sectors && onProgress && Number.isFinite(updateMapMs) && updateMapMs > 0;

  const emitProgress = () => {
    if (!livePreview) {
      return;
    }
    const now = performance.now();
    if (now - lastMapUpdate < updateMapMs) {
      return;
    }
    lastMapUpdate = now;
    const imageData = colorUpwardConeImage({
      altitudes: best,
      originX,
      originY,
      ground: flags,
      width,
      height,
      homeAlt,
      maxAltitude,
      raw,
      sectors: false,
      seeds,
    });
    onProgress({
      imageData,
      iteration: iterations,
      elapsedMs: now - t0,
      stopReason,
    });
  };

  while (heap.size > 0) {
    if (shouldStop?.()) {
      stopReason = "stopped";
      break;
    }

    const { index, req } = heap.pop();
    iterations += 1;
    if (iterations % YIELD_EVERY === 0) {
      emitProgress();
      await Promise.resolve();
      if (shouldStop?.()) {
        stopReason = "stopped";
        break;
      }
    }

    if (req > best[index]) {
      continue;
    }

    const x = index % width;
    const y = (index / width) | 0;
    const fromOx = originX[index];
    const fromOy = originY[index];
    const fromGround = (flags[index] & FLAG_GROUND) !== 0;

    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
        continue;
      }
      const nIdx = ny * width + nx;

      let electedOx;
      let electedOy;
      if (fromGround) {
        electedOx = x;
        electedOy = y;
      } else if (
        fromOx >= 0 &&
        fromOy >= 0 &&
        inView(elev, best, width, height, nx, ny, fromOx, fromOy, cellSizeM, glideRatio)
      ) {
        electedOx = fromOx;
        electedOy = fromOy;
      } else {
        electedOx = x;
        electedOy = y;
      }

      const next = coneReq(best, width, electedOx, electedOy, nx, ny, cellSizeM, glideRatio);
      if (!(next < maxAltitude)) {
        continue;
      }

      const nGround = (flags[nIdx] & FLAG_GROUND) !== 0;
      if (nGround) {
        const curOx = originX[nIdx];
        const curOy = originY[nIdx];
        let currentReq = maxAltitude;
        if (curOx >= 0 && curOy >= 0) {
          currentReq = coneReq(best, width, curOx, curOy, nx, ny, cellSizeM, glideRatio);
        }
        if (next < currentReq) {
          originX[nIdx] = electedOx;
          originY[nIdx] = electedOy;
          // Silent origin update — no wavefront (matches GPU FLAG_GROUND-only write).
        }
        continue;
      }

      if (!(next < best[nIdx])) {
        continue;
      }

      const surface = elev[nIdx];
      if (next <= surface) {
        const landed = f32(surface);
        best[nIdx] = landed;
        originX[nIdx] = electedOx;
        originY[nIdx] = electedOy;
        flags[nIdx] = FLAG_GROUND;
        heap.push(nIdx, landed);
      } else {
        best[nIdx] = next;
        originX[nIdx] = electedOx;
        originY[nIdx] = electedOy;
        flags[nIdx] = 0;
        heap.push(nIdx, next);
      }
    }
  }

  const altitudes = best;
  const ground = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    ground[i] = flags[i] & FLAG_GROUND ? 1 : 0;
  }

  let imageData = null;
  if (needsRaster) {
    imageData = colorUpwardConeImage({
      altitudes,
      originX,
      originY,
      ground,
      width,
      height,
      homeAlt,
      maxAltitude,
      raw,
      sectors,
      seeds,
    });
  }

  return {
    altitudes,
    originX,
    originY,
    ground,
    homeAlt,
    iterations,
    stopReason,
    stopped: stopReason === "stopped",
    elapsedMs: performance.now() - t0,
    imageData,
    engine: "cpu",
    width,
    height,
  };
}

export function colorUpwardConeImage({
  altitudes,
  originX,
  originY,
  ground,
  width,
  height,
  homeAlt,
  maxAltitude,
  raw,
  sectors,
  seeds,
}) {
  const count = width * height;
  const pixels = new Uint8ClampedArray(count * 4);

  let colorOx = originX;
  let colorOy = originY;
  let palette = null;
  if (sectors) {
    const ground01 = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) {
      ground01[i] = ground[i] & 1 ? 1 : 0;
    }
    const deep = resolveDeepOriginsCpu(originX, originY, ground01, width, height);
    colorOx = deep.originX;
    colorOy = deep.originY;
    palette = buildSeedPaletteGrid(width, height, seeds);
  }

  const bandM = 100;
  const bandedHome = Math.floor(homeAlt / bandM) * bandM;

  for (let i = 0; i < count; i += 1) {
    const x = i % width;
    const y = (i / width) | 0;
    const a = altitudes[i];
    const ox = colorOx[i];
    const oy = colorOy[i];
    const onGround = (ground[i] & 1) !== 0;

    let r = 0;
    let g = 0;
    let b = 0;
    let alpha = 0;

    if (onGround) {
      if (ox === x && oy === y) {
        r = 255;
        g = 48;
        b = 48;
        alpha = 220;
      }
    } else if (ox >= 0 && Number.isFinite(a) && a < maxAltitude) {
      if (raw) {
        const band = Math.floor(a / 10);
        alpha = 170;
        if (band % 2 === 0) {
          r = 40;
          g = 120;
          b = 255;
        } else {
          r = 48;
          g = 200;
          b = 72;
        }
      } else if (sectors && palette) {
        const rootIdx = oy * width + ox;
        const slot = palette[rootIdx] | 0;
        if (slot > 0) {
          const packed = SECTOR_RGBA[slot] ?? SECTOR_RGBA[0];
          r = packed & 255;
          g = (packed >>> 8) & 255;
          b = (packed >>> 16) & 255;
          alpha = (packed >>> 24) & 255;
        }
      } else {
        const bandedAlt = Math.floor(a / bandM) * bandM;
        const bandsFromHome = Math.floor((bandedAlt - bandedHome) / bandM);
        if (bandsFromHome % 2 !== 0) {
          r = 40;
          g = 120;
          b = 255;
          alpha = 170;
        }
      }
    }

    const p = i * 4;
    pixels[p] = r;
    pixels[p + 1] = g;
    pixels[p + 2] = b;
    pixels[p + 3] = alpha;
  }

  return new ImageData(pixels, width, height);
}
