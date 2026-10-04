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

fn wasModified(flags: u32) -> bool {
  return (flags & FLAG_CHANGED) != 0u;
}

fn isGroundAt(x: i32, y: i32) -> bool {
  if (!inBounds(x, y)) {
    return false;
  }
  // Ridges above the emulated altitude block a straight relay, matching the
  // cone shader's ground-cell line-of-sight test.
  return elev[idx(x, y)] > params.homeAlt;
}

fn isInViewToOrigin(x0: i32, y0: i32, targetOx: i32, targetOy: i32) -> bool {
  if (!originValid(targetOx, targetOy)) {
    return false;
  }
  if (x0 == targetOx && y0 == targetOy) {
    return true;
  }
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

fn arrivalFrom(ox: i32, oy: i32, x: i32, y: i32) -> f32 {
  let oi = idx(ox, oy);
  let dx = f32(x - ox);
  let dy = f32(y - oy);
  return altIn[oi] - sqrt(dx * dx + dy * dy) * params.cellSizeM / params.glideRatio;
}

fn electedFromNeighbor(x: i32, y: i32, px: i32, py: i32) -> vec2<i32> {
  if (isGroundAt(px, py)) {
    return vec2<i32>(px, py);
  }
  let parentOrigin = originIn[idx(px, py)];
  if (isInViewToOrigin(x, y, parentOrigin.x, parentOrigin.y)) {
    return vec2<i32>(parentOrigin.x, parentOrigin.y);
  }
  return vec2<i32>(px, py);
}

const NEIGHBOR_OFFSETS = array<vec2<i32>, 8>(
  vec2<i32>(-1, -1), vec2<i32>(0, -1), vec2<i32>(1, -1),
  vec2<i32>(-1, 0), vec2<i32>(1, 0),
  vec2<i32>(-1, 1), vec2<i32>(0, 1), vec2<i32>(1, 1)
);

fn clearsFloor(x: i32, y: i32, arrival: f32) -> bool {
  // Ridge height is already in the airport cone. A cell is an option when
  // the arrival is strictly above that cone altitude.
  let cone = coneAlt[idx(x, y)];
  if (cone >= params.maxAlt) {
    return false;
  }
  return arrival > cone;
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

  var bestArrival = curAlt;
  var bestOx = curO.x;
  var bestOy = curO.y;
  var sawOffer = originValid(curO.x, curO.y);

  for (var k = 0; k < 8; k = k + 1) {
    let off = NEIGHBOR_OFFSETS[k];
    let nx = x + off.x;
    let ny = y + off.y;
    if (!inBounds(nx, ny)) {
      continue;
    }
    let ni = idx(nx, ny);
    if (!wasModified(flagsIn[ni])) {
      continue;
    }
    let norigin = originIn[ni];
    if (norigin.x == curO.x && norigin.y == curO.y && originValid(curO.x, curO.y)) {
      continue;
    }
    let elected = electedFromNeighbor(x, y, nx, ny);
    if (!originValid(elected.x, elected.y)) {
      continue;
    }
    let arrival = arrivalFrom(elected.x, elected.y, x, y);
    if (!clearsFloor(x, y, arrival)) {
      continue;
    }
    if (!sawOffer || arrival > bestArrival) {
      sawOffer = true;
      bestArrival = arrival;
      bestOx = elected.x;
      bestOy = elected.y;
    }
  }

  if (!sawOffer || bestArrival >= params.maxAlt) {
    altOut[i] = curAlt;
    originOut[i] = curO;
    flagsOut[i] = 0u;
    return;
  }

  let changed = bestOx != curO.x || bestOy != curO.y || abs(bestArrival - curAlt) > 0.001;
  altOut[i] = bestArrival;
  originOut[i] = vec2<i32>(bestOx, bestOy);
  flagsOut[i] = select(0u, FLAG_CHANGED, changed);
}
`;
