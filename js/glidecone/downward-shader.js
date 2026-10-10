/**
 * Downward optional-area propagate.
 *
 * Cells that stay above the cone floor are Options. The wavefront grows only
 * through Option neighbours — no GC freeze. Arrivals that would fall at/below
 * the floor are not written, so a better path can still fill that cell later.
 *
 * FLAG_OPTION (bit 0): cell is in the optional area.
 * FLAG_CHANGED (bit 1): cell updated this iteration.
 */
export const DOWNWARD_PROPAGATE_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  homeX: i32,
  homeY: i32,
  cellSizeM: f32,
  glideRatio: f32,
  maxAlt: f32,
  homeAlt: f32,
  _pad1: u32,
  _pad2: u32,
  _pad3: u32,
  _pad4: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> elev: array<f32>;
@group(0) @binding(2) var<storage, read> coneAlt: array<f32>;
@group(0) @binding(3) var<storage, read> altIn: array<f32>;
@group(0) @binding(4) var<storage, read_write> altOut: array<f32>;
@group(0) @binding(5) var<storage, read> originIn: array<vec2<i32>>;
@group(0) @binding(6) var<storage, read_write> originOut: array<vec2<i32>>;
@group(0) @binding(7) var<storage, read> flagsIn: array<u32>;
@group(0) @binding(8) var<storage, read_write> flagsOut: array<u32>;

const FLAG_OPTION: u32 = 1u;
const FLAG_CHANGED: u32 = 2u;

fn idx(x: i32, y: i32) -> u32 {
  return u32(y) * params.width + u32(x);
}

fn inBounds(x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < i32(params.width) && y < i32(params.height);
}

fn originValid(ox: i32, oy: i32) -> bool {
  return inBounds(ox, oy) && !(ox == -1 && oy == -1);
}

fn hasStoredOrigin(ox: i32, oy: i32) -> bool {
  return originValid(ox, oy);
}

fn isOptionAt(x: i32, y: i32) -> bool {
  if (!inBounds(x, y)) {
    return false;
  }
  return (flagsIn[idx(x, y)] & FLAG_OPTION) != 0u;
}

fn isOptionCell(flags: u32) -> bool {
  return (flags & FLAG_OPTION) != 0u;
}

fn wasModified(flags: u32) -> bool {
  return (flags & FLAG_CHANGED) != 0u;
}

fn packFlags(option: bool, changed: bool) -> u32 {
  var f = 0u;
  if (option) {
    f = f | FLAG_OPTION;
  }
  if (changed) {
    f = f | FLAG_CHANGED;
  }
  return f;
}

/** Real upward-cone floor (ignore unreachable / maxAlt sentinels). */
fn hasConeFloor(i: u32) -> bool {
  let gc = coneAlt[i];
  return gc < params.maxAlt;
}

// True if the upward cone sticks through the descending L/D slope from origin.
// Option flags alone do not block.
fn cellBlocksRay(cx: i32, cy: i32, ox: i32, oy: i32, originAlt: f32) -> bool {
  if (!inBounds(cx, cy)) {
    return true;
  }
  if (cx == ox && cy == oy) {
    return false;
  }
  let i = idx(cx, cy);
  if (!hasConeFloor(i)) {
    return false;
  }
  let dx = f32(cx - ox);
  let dy = f32(cy - oy);
  let descentAlt = originAlt - sqrt(dx * dx + dy * dy) * params.cellSizeM / params.glideRatio;
  return coneAlt[i] >= descentAlt;
}

// Extended Bresenham LOS to the elected origin (diagonal corner samples).
fn isInViewToOrigin(x0: i32, y0: i32, targetOx: i32, targetOy: i32) -> bool {
  if (!originValid(targetOx, targetOy)) {
    return false;
  }
  if (x0 == targetOx && y0 == targetOy) {
    return true;
  }
  let originAlt = altIn[idx(targetOx, targetOy)];
  let adx = abs(targetOx - x0);
  let ady = abs(targetOy - y0);
  var x1 = x0;
  var y1 = y0;
  let xstep = select(-1, 1, targetOx > x1);
  let ystep = select(-1, 1, targetOy > y1);
  let dx = adx;
  let dy = ady;
  let ddy = dy * 2;
  let ddx = dx * 2;
  var error = dx;
  var errorprev = error;

  if (dx >= dy) {
    for (var step = 0; step < dx; step = step + 1) {
      x1 = x1 + xstep;
      error = error + ddy;
      if (error > ddx) {
        y1 = y1 + ystep;
        error = error - ddx;
        if (error + errorprev < ddx) {
          if (cellBlocksRay(x1, y1 - ystep, targetOx, targetOy, originAlt)) {
            return false;
          }
        } else if (error + errorprev > ddx) {
          if (cellBlocksRay(x1 - xstep, y1, targetOx, targetOy, originAlt)) {
            return false;
          }
        }
      }
      if (cellBlocksRay(x1, y1, targetOx, targetOy, originAlt)) {
        return false;
      }
      errorprev = error;
    }
  } else {
    for (var step = 0; step < dy; step = step + 1) {
      y1 = y1 + ystep;
      error = error + ddx;
      if (error > ddy) {
        x1 = x1 + xstep;
        error = error - ddy;
        if (error + errorprev < ddy) {
          if (cellBlocksRay(x1 - xstep, y1, targetOx, targetOy, originAlt)) {
            return false;
          }
        } else if (error + errorprev > ddy) {
          if (cellBlocksRay(x1, y1 - ystep, targetOx, targetOy, originAlt)) {
            return false;
          }
        }
      }
      if (cellBlocksRay(x1, y1, targetOx, targetOy, originAlt)) {
        return false;
      }
      errorprev = error;
    }
  }
  return true;
}

fn arrivalFrom(ox: i32, oy: i32, x: i32, y: i32) -> f32 {
  let oi = idx(ox, oy);
  let dx = f32(x - ox);
  let dy = f32(y - oy);
  return altIn[oi] - sqrt(dx * dx + dy * dy) * params.cellSizeM / params.glideRatio;
}

fn electedFromNeighbor(x: i32, y: i32, px: i32, py: i32) -> vec2<i32> {
  let parentOrigin = originIn[idx(px, py)];
  if (isInViewToOrigin(x, y, parentOrigin.x, parentOrigin.y)) {
    return vec2<i32>(parentOrigin.x, parentOrigin.y);
  }
  return vec2<i32>(px, py);
}

fn neighborIsActiveOption(nx: i32, ny: i32, myOx: i32, myOy: i32) -> bool {
  if (!inBounds(nx, ny)) {
    return false;
  }
  let ni = idx(nx, ny);
  let nflags = flagsIn[ni];
  if (!isOptionCell(nflags) || !wasModified(nflags)) {
    return false;
  }
  let norigin = originIn[ni];
  return norigin.x != myOx || norigin.y != myOy;
}

const NEIGHBOR_OFFSETS = array<vec2<i32>, 8>(
  vec2<i32>(-1, -1), vec2<i32>(0, -1), vec2<i32>(1, -1),
  vec2<i32>(-1, 0), vec2<i32>(1, 0),
  vec2<i32>(-1, 1), vec2<i32>(0, 1), vec2<i32>(1, 1)
);

fn hasActiveNeighbor(x: i32, y: i32, myOx: i32, myOy: i32) -> bool {
  for (var k = 0; k < 8; k = k + 1) {
    let off = NEIGHBOR_OFFSETS[k];
    if (neighborIsActiveOption(x + off.x, y + off.y, myOx, myOy)) {
      return true;
    }
  }
  return false;
}

fn tryModifiedNeighbor(
  nx: i32,
  ny: i32,
  x: i32,
  y: i32,
  myOx: i32,
  myOy: i32,
  bestArrival: f32,
  bestOx: i32,
  bestOy: i32
) -> vec3<f32> {
  if (!neighborIsActiveOption(nx, ny, myOx, myOy)) {
    return vec3<f32>(bestArrival, f32(bestOx), f32(bestOy));
  }
  let elected = electedFromNeighbor(x, y, nx, ny);
  if (!originValid(elected.x, elected.y)) {
    return vec3<f32>(bestArrival, f32(bestOx), f32(bestOy));
  }
  if (!isOptionAt(elected.x, elected.y)) {
    return vec3<f32>(bestArrival, f32(bestOx), f32(bestOy));
  }
  let arrival = arrivalFrom(elected.x, elected.y, x, y);
  if (arrival > bestArrival) {
    return vec3<f32>(arrival, f32(elected.x), f32(elected.y));
  }
  return vec3<f32>(bestArrival, f32(bestOx), f32(bestOy));
}

fn passthrough(i: u32, curO: vec2<i32>, curAlt: f32, curFlags: u32) {
  altOut[i] = curAlt;
  originOut[i] = curO;
  flagsOut[i] = curFlags & FLAG_OPTION;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (!inBounds(x, y)) {
    return;
  }
  let i = idx(x, y);
  let curO = originIn[i];
  let curAlt = altIn[i];
  let curFlags = flagsIn[i];
  let myOx = curO.x;
  let myOy = curO.y;

  if (!hasActiveNeighbor(x, y, myOx, myOy)) {
    passthrough(i, curO, curAlt, curFlags);
    return;
  }

  var bestArrival = curAlt;
  var bestOx = myOx;
  var bestOy = myOy;
  if (!hasStoredOrigin(myOx, myOy)) {
    bestArrival = -1e30;
  }
  for (var k = 0; k < 8; k = k + 1) {
    let off = NEIGHBOR_OFFSETS[k];
    let pick = tryModifiedNeighbor(x + off.x, y + off.y, x, y, myOx, myOy, bestArrival, bestOx, bestOy);
    bestArrival = pick.x;
    bestOx = i32(pick.y);
    bestOy = i32(pick.z);
  }

  if (hasStoredOrigin(myOx, myOy) && bestArrival <= curAlt) {
    passthrough(i, curO, curAlt, curFlags);
    return;
  }
  if (bestArrival <= -1e20) {
    passthrough(i, curO, curAlt, curFlags);
    return;
  }

  // No upward-cone value (capped / unreachable): not an Option.
  if (!hasConeFloor(i)) {
    passthrough(i, curO, curAlt, curFlags);
    return;
  }
  // Below / on the cone floor: leave empty so a better path can fill.
  if (bestArrival <= coneAlt[i]) {
    passthrough(i, curO, curAlt, curFlags);
    return;
  }

  altOut[i] = bestArrival;
  originOut[i] = vec2<i32>(bestOx, bestOy);
  let changed =
    bestOx != myOx || bestOy != myOy || bestArrival > curAlt || !isOptionCell(curFlags);
  flagsOut[i] = packFlags(true, changed);
}
`;
