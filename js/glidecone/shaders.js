export const SECTOR_ORIGIN_RESOLVE_PASSES = 16;
export const MAX_PEEK_LOS_ENTRIES_WGSL = 1024;
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

struct PeekParams {
  enabled: u32,
  peekX: i32,
  peekY: i32,
  peekOx: i32,
  peekOy: i32,
  groundClearance: f32,
  _pad: f32,
};

struct PeekEntry {
  x: i32,
  y: i32,
  ground: u32,
  _pad: u32,
  alt: f32,
  groundElev: f32,
};

struct PeekLog {
  count: atomic<u32>,
  entries: array<PeekEntry, ${MAX_PEEK_LOS_ENTRIES_WGSL}>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> elev: array<f32>;
@group(0) @binding(2) var<storage, read> altIn: array<f32>;
@group(0) @binding(3) var<storage, read> originIn: array<vec2<i32>>;
@group(0) @binding(4) var<storage, read> groundIn: array<u32>;
@group(0) @binding(5) var<storage, read_write> originOut: array<vec2<i32>>;
@group(0) @binding(6) var<storage, read_write> groundOut: array<u32>;
@group(0) @binding(7) var<uniform> peekParams: PeekParams;
@group(0) @binding(8) var<storage, read_write> peekLog: PeekLog;

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

fn recordPeekVisit(x: i32, y: i32) {
  if (peekParams.enabled == 0u || !inBounds(x, y)) {
    return;
  }
  let slot = atomicAdd(&peekLog.count, 1u);
  if (slot >= ${MAX_PEEK_LOS_ENTRIES_WGSL}u) {
    return;
  }
  let i = idx(x, y);
  peekLog.entries[slot].x = x;
  peekLog.entries[slot].y = y;
  peekLog.entries[slot].ground = groundIn[i];
  peekLog.entries[slot].alt = altIn[i];
  peekLog.entries[slot].groundElev = elev[i] - peekParams.groundClearance;
}

// Bresenham toward origin cell; stop early on ground (blocked) or N-cell same-origin run (clear).
fn isInViewToOrigin(x0: i32, y0: i32, targetOx: i32, targetOy: i32) -> bool {
  let tracing = peekParams.enabled != 0u
    && x0 == peekParams.peekX
    && y0 == peekParams.peekY
    && targetOx == peekParams.peekOx
    && targetOy == peekParams.peekOy;
  if (tracing) {
    recordPeekVisit(x0, y0);
  }
  if (targetOx < 0 || targetOy < 0 || !inBounds(targetOx, targetOy)) {
    return false;
  }
  if (x0 == targetOx && y0 == targetOy) {
    return true;
  }
  let adx = abs(targetOx - x0);
  let ady = abs(targetOy - y0);
  if ((adx == 1 && ady == 0) || (adx == 0 && ady == 1)) {
    if (tracing) {
      recordPeekVisit(targetOx, targetOy);
    }
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
        if (tracing) {
          recordPeekVisit(x1, y1);
        }
        return false;
      }
      if (tracing) {
        recordPeekVisit(x1, y1);
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
        if (tracing) {
          recordPeekVisit(x1, y1);
        }
        return false;
      }
      if (tracing) {
        recordPeekVisit(x1, y1);
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

  if (peekParams.enabled != 0u && x == peekParams.peekX && y == peekParams.peekY) {
    let _probe = isInViewToOrigin(x, y, peekParams.peekOx, peekParams.peekOy);
  }

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
  if (ground[i] == 1u) {
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

  if (ground[i] == 1u) {
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

  if (ground[i] == 1u || o.x < 0 || o.y < 0) {
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

  if (ground[i] == 1u) {
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
