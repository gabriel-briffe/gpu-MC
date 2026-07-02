export const SECTOR_ORIGIN_RESOLVE_PASSES = 16;
export const PROPAGATE_ALT_EPSILON = 0.001;
export const FLAG_GROUND = 1;
export const FLAG_CHANGED = 2;

export const PROPAGATE_SHADER = /* wgsl */ `
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
@group(0) @binding(2) var<storage, read> altIn: array<f32>;
@group(0) @binding(3) var<storage, read_write> altOut: array<f32>;
@group(0) @binding(4) var<storage, read> originIn: array<vec2<i32>>;
@group(0) @binding(5) var<storage, read_write> originOut: array<vec2<i32>>;
@group(0) @binding(6) var<storage, read> flagsIn: array<u32>;
@group(0) @binding(7) var<storage, read_write> flagsOut: array<u32>;

const FLAG_GROUND: u32 = 1u;
const FLAG_CHANGED: u32 = 2u;

fn idx(x: i32, y: i32) -> u32 {
  return u32(y) * params.width + u32(x);
}

fn inBounds(x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < i32(params.width) && y < i32(params.height);
}

fn originValid(ox: i32, oy: i32) -> bool {
  return inBounds(ox, oy);
}

fn hasStoredOrigin(ox: i32, oy: i32) -> bool {
  return originValid(ox, oy) && !(ox == -1 && oy == -1);
}

fn isGroundAt(x: i32, y: i32) -> bool {
  if (!inBounds(x, y)) {
    return false;
  }
  return (flagsIn[idx(x, y)] & FLAG_GROUND) != 0u;
}

fn isGroundCell(flags: u32) -> bool {
  return (flags & FLAG_GROUND) != 0u;
}

fn wasModified(flags: u32) -> bool {
  return (flags & FLAG_CHANGED) != 0u;
}

fn packFlags(ground: bool, changed: bool) -> u32 {
  var f = 0u;
  if (ground) {
    f = f | FLAG_GROUND;
  }
  if (changed) {
    f = f | FLAG_CHANGED;
  }
  return f;
}

// Full Bresenham LOS (C++ Cell::isInView).
fn isInViewToOrigin(x0: i32, y0: i32, targetOx: i32, targetOy: i32) -> bool {
  if (!originValid(targetOx, targetOy)) {
    return false;
  }
  if (x0 == targetOx && y0 == targetOy) {
    return true;
  }
  let adx = abs(targetOx - x0);
  let ady = abs(targetOy - y0);
  if ((adx == 1 && ady == 0) || (adx == 0 && ady == 1)) {
    return true;
  }

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
          if (isGroundAt(x1, y1 - ystep)) {
            return false;
          }
        } else if (error + errorprev > ddx) {
          if (isGroundAt(x1 - xstep, y1)) {
            return false;
          }
        }
      }
      if (!(x1 == targetOx && y1 == targetOy) && isGroundAt(x1, y1)) {
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
          if (isGroundAt(x1 - xstep, y1)) {
            return false;
          }
        } else if (error + errorprev > ddy) {
          if (isGroundAt(x1, y1 - ystep)) {
            return false;
          }
        }
      }
      if (!(x1 == targetOx && y1 == targetOy) && isGroundAt(x1, y1)) {
        return false;
      }
      errorprev = error;
    }
  }

  return true;
}

fn coneAlt(ox: i32, oy: i32, x: i32, y: i32) -> f32 {
  let oi = idx(ox, oy);
  let dx = f32(x - ox);
  let dy = f32(y - oy);
  return altIn[oi] + sqrt(dx * dx + dy * dy) * params.cellSizeM / params.glideRatio;
}

fn electedFromNeighbor(x: i32, y: i32, px: i32, py: i32) -> vec2<i32> {
  let parentOrigin = originIn[idx(px, py)];
  if (isInViewToOrigin(x, y, parentOrigin.x, parentOrigin.y)) {
    return vec2<i32>(parentOrigin.x, parentOrigin.y);
  }
  return vec2<i32>(px, py);
}

fn neighborIsModifiedAndDifferentOrigin(
  nx: i32,
  ny: i32,
  myOx: i32,
  myOy: i32
) -> bool {
  if (!inBounds(nx, ny)) {
    return false;
  }
  let ni = idx(nx, ny);
  if (!wasModified(flagsIn[ni])) {
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
    if (neighborIsModifiedAndDifferentOrigin(x + off.x, y + off.y, myOx, myOy)) {
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
  bestReq: f32,
  bestOx: i32,
  bestOy: i32
) -> vec3<f32> {
  if (!neighborIsModifiedAndDifferentOrigin(nx, ny, myOx, myOy)) {
    return vec3<f32>(bestReq, f32(bestOx), f32(bestOy));
  }
  let elected = electedFromNeighbor(x, y, nx, ny);
  if (!originValid(elected.x, elected.y)) {
    return vec3<f32>(bestReq, f32(bestOx), f32(bestOy));
  }
  let req = coneAlt(elected.x, elected.y, x, y);
  if (req < bestReq) {
    return vec3<f32>(req, f32(elected.x), f32(elected.y));
  }
  return vec3<f32>(bestReq, f32(bestOx), f32(bestOy));
}

fn passthrough(i: u32, curO: vec2<i32>, curAlt: f32, curFlags: u32) {
  altOut[i] = curAlt;
  originOut[i] = curO;
  flagsOut[i] = curFlags & FLAG_GROUND;
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

  if (isGroundCell(curFlags)) {
    passthrough(i, curO, curAlt, curFlags);
    flagsOut[i] = FLAG_GROUND;
    return;
  }

  if (!hasActiveNeighbor(x, y, myOx, myOy)) {
    passthrough(i, curO, curAlt, curFlags);
    return;
  }

  var bestReq = curAlt;
  var bestOx = myOx;
  var bestOy = myOy;

  for (var k = 0; k < 8; k = k + 1) {
    let off = NEIGHBOR_OFFSETS[k];
    let pick = tryModifiedNeighbor(
      x + off.x,
      y + off.y,
      x,
      y,
      myOx,
      myOy,
      bestReq,
      bestOx,
      bestOy
    );
    bestReq = pick.x;
    bestOx = i32(pick.y);
    bestOy = i32(pick.z);
  }

  if (hasStoredOrigin(myOx, myOy) && bestReq >= curAlt) {
    passthrough(i, curO, curAlt, curFlags);
    return;
  }

  if (bestReq >= params.maxAlt) {
    passthrough(i, curO, curAlt, curFlags);
    return;
  }

  var newAlt = curAlt;
  var newOx = myOx;
  var newOy = myOy;
  var newGround = isGroundCell(curFlags);

  if (bestReq <= elev[i]) {
    newAlt = elev[i];
    newOx = bestOx;
    newOy = bestOy;
    newGround = true;
  } else {
    newAlt = bestReq;
    newOx = bestOx;
    newOy = bestOy;
  }

  altOut[i] = newAlt;
  originOut[i] = vec2<i32>(newOx, newOy);

  let changed = newOx != myOx
    || newOy != myOy
    || abs(newAlt - curAlt) > ${PROPAGATE_ALT_EPSILON}
    || newGround != isGroundCell(curFlags);
  flagsOut[i] = packFlags(newGround, changed);
}
`;

export const CHANGED_SUM_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
};

const FLAG_CHANGED: u32 = 2u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read_write> changeCount: array<atomic<u32>>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= i32(params.width) || y >= i32(params.height)) {
    return;
  }
  let i = u32(y) * params.width + u32(x);
  if ((flags[i] & FLAG_CHANGED) != 0u) {
    atomicAdd(&changeCount[0], 1u);
  }
}
`;

export const MODIFIED_CELLS_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
};

const FLAG_CHANGED: u32 = 2u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read_write> rgba: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= i32(params.width) || y >= i32(params.height)) {
    return;
  }
  let i = u32(y) * params.width + u32(x);
  if ((flags[i] & FLAG_CHANGED) != 0u) {
    rgba[i] = 255u << 24u;
  } else {
    rgba[i] = 0u;
  }
}
`;

export const ORIGIN_PATH_VALIDATE_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  maxAlt: f32,
  seedCount: u32,
  maxSteps: u32,
  cellSizeM: f32,
};

struct Counters {
  checked: atomic<u32>,
  valid: atomic<u32>,
  invalid: atomic<u32>,
  stoppedAtMaxSteps: atomic<u32>,
  maxSegmentLdBits: atomic<u32>,
};

struct PathAnalysis {
  result: u32,
  pathMaxLd: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> altIn: array<f32>;
@group(0) @binding(2) var<storage, read> originIn: array<vec2<i32>>;
@group(0) @binding(3) var<storage, read> seeds: array<vec2<i32>>;
@group(0) @binding(4) var<storage, read_write> counters: Counters;
@group(0) @binding(5) var<storage, read_write> pathMaxLdOut: array<f32>;

fn idx(x: i32, y: i32) -> u32 {
  return u32(y) * params.width + u32(x);
}

fn inBounds(x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < i32(params.width) && y < i32(params.height);
}

fn originValid(ox: i32, oy: i32) -> bool {
  return inBounds(ox, oy) && !(ox == -1 && oy == -1);
}

fn isSeedCell(x: i32, y: i32) -> bool {
  for (var s = 0u; s < params.seedCount; s = s + 1u) {
    let p = seeds[s];
    if (p.x == x && p.y == y) {
      return true;
    }
  }
  return false;
}

fn hasValidComputedAlt(i: u32) -> bool {
  if (altIn[i] >= params.maxAlt) {
    return false;
  }
  let o = originIn[i];
  return originValid(o.x, o.y);
}

fn atomicMaxF32(ptr: ptr<storage, atomic<u32>, read_write>, value: f32) {
  if (value <= 0.0) {
    return;
  }
  var oldBits = atomicLoad(ptr);
  loop {
    let old = bitcast<f32>(oldBits);
    if (value <= old) {
      return;
    }
    let exchange = atomicCompareExchangeWeak(ptr, oldBits, bitcast<u32>(value));
    if (exchange.exchanged) {
      return;
    }
    oldBits = exchange.old_value;
  }
}

fn analyzePath(startX: i32, startY: i32) -> PathAnalysis {
  var cx = startX;
  var cy = startY;
  var pathMaxLd = 0.0;
  for (var step = 0u; step < params.maxSteps; step = step + 1u) {
    if (isSeedCell(cx, cy)) {
      return PathAnalysis(0u, pathMaxLd);
    }
    let ci = idx(cx, cy);
    let o = originIn[ci];
    if (!originValid(o.x, o.y) || (o.x == cx && o.y == cy)) {
      return PathAnalysis(1u, pathMaxLd);
    }
    let altA = altIn[ci];
    let parentIdx = idx(o.x, o.y);
    let altB = altIn[parentIdx];
    let di = o.x - cx;
    let dj = o.y - cy;
    let horiz = params.cellSizeM * sqrt(f32(di * di + dj * dj));
    let vertDrop = altA - altB;
    var segLd = 99.0;
    if (vertDrop > 0.0) {
      segLd = horiz / vertDrop;
    }
    pathMaxLd = max(pathMaxLd, segLd);
    cx = o.x;
    cy = o.y;
  }
  return PathAnalysis(2u, pathMaxLd);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (!inBounds(x, y)) {
    return;
  }

  let i = idx(x, y);
  if (!hasValidComputedAlt(i)) {
    return;
  }

  atomicAdd(&counters.checked, 1u);
  let analysis = analyzePath(x, y);
  pathMaxLdOut[i] = analysis.pathMaxLd;
  atomicMaxF32(&counters.maxSegmentLdBits, analysis.pathMaxLd);
  if (analysis.result == 0u) {
    atomicAdd(&counters.valid, 1u);
  } else if (analysis.result == 2u) {
    atomicAdd(&counters.stoppedAtMaxSteps, 1u);
  } else {
    atomicAdd(&counters.invalid, 1u);
  }
}
`;

// Legacy full-grid shaders kept for reference; no longer used by the main compute loop.
export const ORIGIN_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  homeX: i32,
  homeY: i32,
  cellSizeM: f32,
  glideRatio: f32,
  maxAlt: f32,
  homeAlt: f32,
  losShortcut: u32,
  originRunN: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> elev: array<f32>;
@group(0) @binding(2) var<storage, read> altIn: array<f32>;
@group(0) @binding(3) var<storage, read> originIn: array<vec2<i32>>;
@group(0) @binding(4) var<storage, read> groundIn: array<u32>;
@group(0) @binding(5) var<storage, read_write> originOut: array<vec2<i32>>;
@group(0) @binding(6) var<storage, read_write> groundOut: array<u32>;

struct Pick {
  req: f32,
  ox: i32,
  oy: i32,
};

fn makePick(req: f32, ox: i32, oy: i32) -> Pick {
  var p: Pick;
  p.req = req;
  p.ox = ox;
  p.oy = oy;
  return p;
}

fn idx(x: i32, y: i32) -> u32 {
  return u32(y) * params.width + u32(x);
}

fn inBounds(x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < i32(params.width) && y < i32(params.height);
}

fn isGround(x: i32, y: i32) -> bool {
  if (!inBounds(x, y)) {
    return false;
  }
  return groundIn[idx(x, y)] == 1u;
}

fn hasSameOrigin(x: i32, y: i32, targetOx: i32, targetOy: i32) -> bool {
  let o = originIn[idx(x, y)];
  return o.x == targetOx && o.y == targetOy;
}

fn bumpSameOriginRun(x: i32, y: i32, targetOx: i32, targetOy: i32, run: u32) -> u32 {
  if (hasSameOrigin(x, y, targetOx, targetOy)) {
    return run + 1u;
  }
  return 0u;
}

fn sameOriginRunIsClear(run: u32) -> bool {
  return params.losShortcut != 0u && run >= params.originRunN;
}

// Bresenham toward origin cell; stop early on ground (blocked) or N-cell same-origin run (clear).
fn isInViewToOrigin(x0: i32, y0: i32, targetOx: i32, targetOy: i32) -> bool {
  if (targetOx < 0 || targetOy < 0 || !inBounds(targetOx, targetOy)) {
    return false;
  }
  if (x0 == targetOx && y0 == targetOy) {
    return true;
  }
  let adx = abs(targetOx - x0);
  let ady = abs(targetOy - y0);
  if ((adx == 1 && ady == 0) || (adx == 0 && ady == 1)) {
    return true;
  }

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
  var sameOriginRun = 0u;

  if (dx >= dy) {
    for (var step = 0; step < dx; step = step + 1) {
      x1 = x1 + xstep;
      error = error + ddy;
      if (error > ddx) {
        y1 = y1 + ystep;
        error = error - ddx;
        if (error + errorprev < ddx) {
          if (isGround(x1, y1 - ystep)) {
            return false;
          }
        } else if (error + errorprev > ddx) {
          if (isGround(x1 - xstep, y1)) {
            return false;
          }
        }
      }
      if (!(x1 == targetOx && y1 == targetOy) && isGround(x1, y1)) {
        return false;
      }
      sameOriginRun = bumpSameOriginRun(x1, y1, targetOx, targetOy, sameOriginRun);
      if (sameOriginRunIsClear(sameOriginRun)) {
        return true;
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
          if (isGround(x1 - xstep, y1)) {
            return false;
          }
        } else if (error + errorprev > ddy) {
          if (isGround(x1, y1 - ystep)) {
            return false;
          }
        }
      }
      if (!(x1 == targetOx && y1 == targetOy) && isGround(x1, y1)) {
        return false;
      }
      sameOriginRun = bumpSameOriginRun(x1, y1, targetOx, targetOy, sameOriginRun);
      if (sameOriginRunIsClear(sameOriginRun)) {
        return true;
      }
      errorprev = error;
    }
  }

  return true;
}

fn electedOrigin(x: i32, y: i32, ox: i32, oy: i32, rx: i32, ry: i32) -> vec2<i32> {
  if (ox < 0 || oy < 0) {
    return vec2<i32>(-1, -1);
  }
  if (isInViewToOrigin(x, y, ox, oy)) {
    return vec2<i32>(ox, oy);
  }
  return vec2<i32>(rx, ry);
}

fn coneAlt(ox: i32, oy: i32, x: i32, y: i32) -> f32 {
  let oi = idx(ox, oy);
  let dx = f32(x - ox);
  let dy = f32(y - oy);
  return altIn[oi] + sqrt(dx * dx + dy * dy) * params.cellSizeM / params.glideRatio;
}

fn tryNeighborPick(nx: i32, ny: i32, x: i32, y: i32, best: Pick, curOx: i32, curOy: i32) -> Pick {
  if (!inBounds(nx, ny)) {
    return best;
  }
  let ni = idx(nx, ny);
  let norigin = originIn[ni];
  if (norigin.x < 0 || norigin.y < 0) {
    return best;
  }
  if (norigin.x == curOx && norigin.y == curOy) {
    return best;
  }
  let elected = electedOrigin(x, y, norigin.x, norigin.y, nx, ny);
  let req = coneAlt(elected.x, elected.y, x, y);
  if (req < best.req) {
    return makePick(req, elected.x, elected.y);
  }
  return best;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (!inBounds(x, y)) {
    return;
  }

  let i = idx(x, y);

  if (groundIn[i] == 1u) {
    originOut[i] = originIn[i];
    groundOut[i] = 1u;
    return;
  }

  var best = makePick(params.maxAlt, -1, -1);

  let curOrigin = originIn[i];
  if (curOrigin.x >= 0 && curOrigin.y >= 0) {
    best = makePick(coneAlt(curOrigin.x, curOrigin.y, x, y), curOrigin.x, curOrigin.y);
  }

  best = tryNeighborPick(x, y - 1, x, y, best, curOrigin.x, curOrigin.y);
  best = tryNeighborPick(x, y + 1, x, y, best, curOrigin.x, curOrigin.y);
  best = tryNeighborPick(x - 1, y, x, y, best, curOrigin.x, curOrigin.y);
  best = tryNeighborPick(x + 1, y, x, y, best, curOrigin.x, curOrigin.y);

  originOut[i] = vec2<i32>(best.ox, best.oy);
  if (best.ox >= 0 && best.req <= elev[i]) {
    groundOut[i] = 1u;
  } else {
    groundOut[i] = groundIn[i];
  }
}
`;

export const ALT_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  homeX: i32,
  homeY: i32,
  cellSizeM: f32,
  glideRatio: f32,
  maxAlt: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> elev: array<f32>;
@group(0) @binding(2) var<storage, read> origin: array<vec2<i32>>;
@group(0) @binding(3) var<storage, read> altIn: array<f32>;
@group(0) @binding(4) var<storage, read> ground: array<u32>;
@group(0) @binding(5) var<storage, read_write> altOut: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= i32(params.width) || y >= i32(params.height)) {
    return;
  }

  let i = u32(y) * params.width + u32(x);
  if ((ground[i] & 1u) != 0u) {
    altOut[i] = elev[i];
    return;
  }

  let o = origin[i];
  if (o.x < 0 || o.y < 0) {
    altOut[i] = params.maxAlt;
    return;
  }

  let oi = u32(o.y) * params.width + u32(o.x);
  let dx = f32(x - o.x);
  let dy = f32(y - o.y);
  let req = altIn[oi] + sqrt(dx * dx + dy * dy) * params.cellSizeM / params.glideRatio;
  let v = max(elev[i], req);
  altOut[i] = select(v, params.maxAlt, v >= params.maxAlt);
}
`;

export const GROUND_ORIGIN_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  homeX: i32,
  homeY: i32,
  cellSizeM: f32,
  glideRatio: f32,
  maxAlt: f32,
  homeAlt: f32,
  losShortcut: u32,
  originRunN: u32,
  seedCount: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> alt: array<f32>;
@group(0) @binding(2) var<storage, read> ground: array<u32>;
@group(0) @binding(3) var<storage, read_write> origin: array<vec2<i32>>;
@group(0) @binding(4) var<storage, read> seeds: array<vec2<i32>>;

fn idx(x: i32, y: i32) -> u32 {
  return u32(y) * params.width + u32(x);
}

fn inBounds(x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < i32(params.width) && y < i32(params.height);
}

fn isSeedCell(x: i32, y: i32) -> bool {
  for (var s = 0u; s < params.seedCount; s = s + 1u) {
    let p = seeds[s];
    if (p.x == x && p.y == y) {
      return true;
    }
  }
  return false;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (!inBounds(x, y)) {
    return;
  }
  if (isSeedCell(x, y)) {
    return;
  }

  let i = idx(x, y);
  if (ground[i] != 1u) {
    return;
  }

  var bestAlt = params.maxAlt;
  var bestOx = x;
  var bestOy = y;

  let offsets = array<vec2<i32>, 8>(
    vec2<i32>(-1, -1), vec2<i32>(0, -1), vec2<i32>(1, -1),
    vec2<i32>(-1, 0), vec2<i32>(1, 0),
    vec2<i32>(-1, 1), vec2<i32>(0, 1), vec2<i32>(1, 1)
  );

  for (var k = 0; k < 8; k = k + 1) {
    let nx = x + offsets[k].x;
    let ny = y + offsets[k].y;
    if (!inBounds(nx, ny)) {
      continue;
    }
    let na = alt[idx(nx, ny)];
    if (na < bestAlt) {
      bestAlt = na;
      bestOx = nx;
      bestOy = ny;
    }
  }

  origin[i] = vec2<i32>(bestOx, bestOy);
}
`;

export const CHANGE_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> originCur: array<vec2<i32>>;
@group(0) @binding(2) var<storage, read> originPrev: array<vec2<i32>>;
@group(0) @binding(3) var<storage, read> groundCur: array<u32>;
@group(0) @binding(4) var<storage, read> groundPrev: array<u32>;
@group(0) @binding(5) var<storage, read> altCur: array<f32>;
@group(0) @binding(6) var<storage, read> altPrev: array<f32>;
@group(0) @binding(7) var<storage, read_write> changeCount: array<atomic<u32>>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= i32(params.width) || y >= i32(params.height)) {
    return;
  }

  let i = u32(y) * params.width + u32(x);
  let oc = originCur[i];
  let op = originPrev[i];
  var changed = oc.x != op.x || oc.y != op.y;
  changed = changed || groundCur[i] != groundPrev[i];
  changed = changed || abs(altCur[i] - altPrev[i]) > 0.001;
  if (changed) {
    atomicAdd(&changeCount[0], 1u);
  }
}
`;

export const COLOR_SHADER_RAW = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  homeX: i32,
  homeY: i32,
  cellSizeM: f32,
  glideRatio: f32,
  maxAlt: f32,
  homeAlt: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> alt: array<f32>;
@group(0) @binding(2) var<storage, read> origin: array<vec2<i32>>;
@group(0) @binding(3) var<storage, read> ground: array<u32>;
@group(0) @binding(4) var<storage, read_write> rgba: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= i32(params.width) || y >= i32(params.height)) {
    return;
  }

  let i = u32(y) * params.width + u32(x);
  let o = origin[i];
  let a = alt[i];

  if (o.x < 0 || a >= params.maxAlt) {
    rgba[i] = 0u;
    return;
  }

  let band = i32(floor(a / 10.0));
  let alpha = 170u;
  if (band % 2 == 0) {
    let r = 40u;
    let g = 120u;
    let b = 255u;
    rgba[i] = r | (g << 8u) | (b << 16u) | (alpha << 24u);
  } else {
    let r = 48u;
    let g = 200u;
    let b = 72u;
    rgba[i] = r | (g << 8u) | (b << 16u) | (alpha << 24u);
  }
}
`;

export const COLOR_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  homeX: i32,
  homeY: i32,
  cellSizeM: f32,
  glideRatio: f32,
  maxAlt: f32,
  homeAlt: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> alt: array<f32>;
@group(0) @binding(2) var<storage, read> origin: array<vec2<i32>>;
@group(0) @binding(3) var<storage, read> ground: array<u32>;
@group(0) @binding(4) var<storage, read_write> rgba: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= i32(params.width) || y >= i32(params.height)) {
    return;
  }

  let i = u32(y) * params.width + u32(x);
  let o = origin[i];
  let a = alt[i];

  if ((ground[i] & 1u) != 0u) {
    if (o.x == x && o.y == y) {
      let r = 255u;
      let g = 48u;
      let b = 48u;
      let alpha = 220u;
      rgba[i] = r | (g << 8u) | (b << 16u) | (alpha << 24u);
    } else {
      rgba[i] = 0u;
    }
    return;
  }

  if (o.x < 0 || a >= params.maxAlt) {
    rgba[i] = 0u;
    return;
  }

  let bandM = 100.0;
  let bandedAlt = floor(a / bandM) * bandM;
  let bandedHome = floor(params.homeAlt / bandM) * bandM;
  let bandsFromHome = i32(floor((bandedAlt - bandedHome) / bandM));

  if (bandsFromHome % 2 == 0) {
    rgba[i] = 0u;
    return;
  }

  let r = 40u;
  let g = 120u;
  let b = 255u;
  let alpha = 170u;
  rgba[i] = r | (g << 8u) | (b << 16u) | (alpha << 24u);
}
`;

export const RESOLVE_ORIGIN_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> originIn: array<vec2<i32>>;
@group(0) @binding(2) var<storage, read> ground: array<u32>;
@group(0) @binding(3) var<storage, read_write> originOut: array<vec2<i32>>;

fn idx(x: i32, y: i32) -> u32 {
  return u32(y) * params.width + u32(x);
}

fn inBounds(x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < i32(params.width) && y < i32(params.height);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (!inBounds(x, y)) {
    return;
  }

  let i = idx(x, y);
  let o = originIn[i];

  if ((ground[i] & 1u) != 0u || o.x < 0 || o.y < 0) {
    originOut[i] = o;
    return;
  }

  if (!inBounds(o.x, o.y)) {
    originOut[i] = o;
    return;
  }

  originOut[i] = originIn[idx(o.x, o.y)];
}
`;

export const COLOR_SHADER_SECTORS = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  homeX: i32,
  homeY: i32,
  cellSizeM: f32,
  glideRatio: f32,
  maxAlt: f32,
  homeAlt: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> alt: array<f32>;
@group(0) @binding(2) var<storage, read> origin: array<vec2<i32>>;
@group(0) @binding(3) var<storage, read> ground: array<u32>;
@group(0) @binding(4) var<storage, read_write> rgba: array<u32>;
@group(0) @binding(5) var<storage, read> seedPalette: array<u32>;

fn packRgba(r: u32, g: u32, b: u32, a: u32) -> u32 {
  return r | (g << 8u) | (b << 16u) | (a << 24u);
}

fn sectorColor(slot: u32) -> u32 {
  switch slot {
    case 1u: { return packRgba(40u, 120u, 255u, 170u); }
    case 2u: { return packRgba(48u, 200u, 72u, 170u); }
    case 3u: { return packRgba(230u, 140u, 40u, 170u); }
    case 4u: { return packRgba(200u, 80u, 200u, 170u); }
    case 5u: { return packRgba(40u, 190u, 210u, 170u); }
    case 6u: { return packRgba(230u, 210u, 60u, 170u); }
    case 7u: { return packRgba(220u, 80u, 90u, 170u); }
    case 8u: { return packRgba(130u, 100u, 220u, 170u); }
    default: { return packRgba(128u, 128u, 128u, 170u); }
  }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= i32(params.width) || y >= i32(params.height)) {
    return;
  }

  let i = u32(y) * params.width + u32(x);
  let o = origin[i];
  let a = alt[i];

  if ((ground[i] & 1u) != 0u) {
    if (o.x == x && o.y == y) {
      rgba[i] = packRgba(255u, 48u, 48u, 220u);
    } else {
      rgba[i] = 0u;
    }
    return;
  }

  if (o.x < 0 || a >= params.maxAlt) {
    rgba[i] = 0u;
    return;
  }

  let rootIdx = u32(o.y) * params.width + u32(o.x);
  let paletteSlot = seedPalette[rootIdx];
  if (paletteSlot == 0u) {
    rgba[i] = 0u;
    return;
  }

  rgba[i] = sectorColor(paletteSlot);
}
`;

export const COLOR_SHADER_RED = COLOR_SHADER.replace(
  "let r = 40u;",
  "let r = 255u;"
).replace("let g = 120u;", "let g = 48u;").replace("let b = 255u;", "let b = 48u;");
