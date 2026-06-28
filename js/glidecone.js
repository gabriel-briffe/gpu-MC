const ORIGIN_SHADER = /* wgsl */ `
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
@group(0) @binding(4) var<storage, read> parentIn: array<vec2<i32>>;
@group(0) @binding(5) var<storage, read> groundIn: array<u32>;
@group(0) @binding(6) var<storage, read_write> originOut: array<vec2<i32>>;
@group(0) @binding(7) var<storage, read_write> parentOut: array<vec2<i32>>;

struct Pick {
  req: f32,
  ox: i32,
  oy: i32,
  px: i32,
  py: i32,
};

fn makePick(req: f32, ox: i32, oy: i32, px: i32, py: i32) -> Pick {
  var p: Pick;
  p.req = req;
  p.ox = ox;
  p.oy = oy;
  p.px = px;
  p.py = py;
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
  if (adx <= 1 && ady <= 1) {
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
      if (isGround(x1, y1)) {
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
      if (isGround(x1, y1)) {
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

fn tryOriginPick(ox: i32, oy: i32, x: i32, y: i32, best: Pick) -> Pick {
  if (ox < 0 || oy < 0 || !inBounds(ox, oy)) {
    return best;
  }
  let req = coneAlt(ox, oy, x, y);
  if (req < best.req) {
    return makePick(req, ox, oy, best.px, best.py);
  }
  return best;
}

fn tryNeighborPick(nx: i32, ny: i32, x: i32, y: i32, best: Pick) -> Pick {
  if (!inBounds(nx, ny)) {
    return best;
  }
  let ni = idx(nx, ny);
  let norigin = originIn[ni];
  if (norigin.x < 0 || norigin.y < 0) {
    return best;
  }
  let elected = electedOrigin(x, y, norigin.x, norigin.y, nx, ny);
  let req = coneAlt(elected.x, elected.y, x, y);
  if (req < best.req) {
    return makePick(req, elected.x, elected.y, nx, ny);
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
  var best = makePick(params.maxAlt, -1, -1, -1, -1);

  let curOrigin = originIn[i];
  if (curOrigin.x >= 0 && curOrigin.y >= 0) {
    let elected = electedOrigin(x, y, curOrigin.x, curOrigin.y, x, y);
    let curParent = parentIn[i];
    best = tryOriginPick(
      elected.x,
      elected.y,
      x,
      y,
      makePick(params.maxAlt, curOrigin.x, curOrigin.y, curParent.x, curParent.y)
    );
  }

  best = tryNeighborPick(x, y - 1, x, y, best);
  best = tryNeighborPick(x, y + 1, x, y, best);
  best = tryNeighborPick(x - 1, y, x, y, best);
  best = tryNeighborPick(x + 1, y, x, y, best);

  originOut[i] = vec2<i32>(best.ox, best.oy);
  parentOut[i] = vec2<i32>(best.px, best.py);
}
`;

const ALT_SHADER = /* wgsl */ `
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
@group(0) @binding(4) var<storage, read_write> altOut: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= i32(params.width) || y >= i32(params.height)) {
    return;
  }

  let i = u32(y) * params.width + u32(x);
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

const GROUND_SHADER = /* wgsl */ `
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
@group(0) @binding(2) var<storage, read> altIn: array<f32>;
@group(0) @binding(3) var<storage, read_write> altOut: array<f32>;
@group(0) @binding(4) var<storage, read_write> origin: array<vec2<i32>>;
@group(0) @binding(5) var<storage, read_write> groundOut: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= i32(params.width) || y >= i32(params.height)) {
    return;
  }

  let i = u32(y) * params.width + u32(x);
  if (altIn[i] <= elev[i] + 0.01) {
    groundOut[i] = 1u;
    origin[i] = vec2<i32>(x, y);
    altOut[i] = elev[i];
  } else {
    groundOut[i] = 0u;
    altOut[i] = altIn[i];
  }
}
`;

const COLOR_SHADER = /* wgsl */ `
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

  if (o.x < 0 || a >= params.maxAlt || ground[i] == 1u) {
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

const COLOR_SHADER_RED = COLOR_SHADER.replace(
  "let r = 40u;",
  "let r = 255u;"
).replace("let g = 120u;", "let g = 48u;").replace("let b = 255u;", "let b = 48u;");

function packParams(
  width,
  height,
  homeX,
  homeY,
  cellSizeM,
  glideRatio,
  maxAlt,
  homeAlt = 0,
  losShortcut = 1,
  originRunN = 0
) {
  const buf = new ArrayBuffer(48);
  const view = new DataView(buf);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setInt32(8, homeX, true);
  view.setInt32(12, homeY, true);
  view.setFloat32(16, cellSizeM, true);
  view.setFloat32(20, glideRatio, true);
  view.setFloat32(24, maxAlt, true);
  view.setFloat32(28, homeAlt, true);
  view.setUint32(32, losShortcut, true);
  view.setUint32(36, originRunN, true);
  return buf;
}

function createBuffer(device, bytes, usage) {
  const buffer = device.createBuffer({
    size: Math.max(bytes.byteLength, 4),
    usage,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange()).set(bytes);
  buffer.unmap();
  return buffer;
}

function packXY(xArr, yArr) {
  const pairs = new Int32Array(xArr.length * 2);
  for (let i = 0; i < xArr.length; i += 1) {
    pairs[i * 2] = xArr[i];
    pairs[i * 2 + 1] = yArr[i];
  }
  return pairs;
}

function unpackXY(pairs) {
  const count = pairs.length / 2;
  const xArr = new Int32Array(count);
  const yArr = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    xArr[i] = pairs[i * 2];
    yArr[i] = pairs[i * 2 + 1];
  }
  return { xArr, yArr };
}

async function createPipeline(device, code, bindings) {
  const module = device.createShaderModule({ code });
  const layout = device.createBindGroupLayout({
    entries: bindings.map((type, binding) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type },
    })),
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: "main" },
  });
  return { pipeline, layout };
}

export class GlideConeEngine {
  constructor() {
    this.device = null;
    this.pipelines = null;
  }

  async init() {
    if (!navigator.gpu) {
      throw new Error("WebGPU is not available in this browser.");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("Could not request a WebGPU adapter.");
    }
    this.device = await adapter.requestDevice();
    this.pipelines = {
      origin: await createPipeline(this.device, ORIGIN_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
        "storage",
      ]),
      alt: await createPipeline(this.device, ALT_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
      ]),
      ground: await createPipeline(this.device, GROUND_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "storage",
        "storage",
        "storage",
      ]),
      color: await createPipeline(this.device, COLOR_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
      ]),
      colorRed: await createPipeline(this.device, COLOR_SHADER_RED, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
      ]),
    };
  }

  async compute(dem, params, options = {}) {
    const { fullBresenham = false, overlayColor = "blue", imageOnly = false } = options;
    const { device, pipelines } = this;
    const { width, height, homeX, homeY, cellSizeM, elevation } = dem;
    const { glideRatio, maxAltitude, circuitHeight, originRunN = 0 } = params;
    const useFullBresenham = fullBresenham || originRunN === 0;
    const losShortcut = useFullBresenham ? 0 : 1;
    const shaderOriginRunN = originRunN === 0 ? 1 : originRunN;
    const count = width * height;

    const homeIdx = homeY * width + homeX;
    const homeAlt = elevation[homeIdx] + circuitHeight;

    const alt = new Float32Array(count).fill(maxAltitude);
    const originX = new Int32Array(count).fill(-1);
    const originY = new Int32Array(count).fill(-1);
    const parentX = new Int32Array(count).fill(-1);
    const parentY = new Int32Array(count).fill(-1);
    const ground = new Uint32Array(count);
    alt[homeIdx] = homeAlt;
    originX[homeIdx] = homeX;
    originY[homeIdx] = homeY;
    parentX[homeIdx] = homeX;
    parentY[homeIdx] = homeY;

    const originPairs = packXY(originX, originY);
    const parentPairs = packXY(parentX, parentY);

    const uniformUsage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    const storageUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

    const uniformParams = packParams(
      width,
      height,
      homeX,
      homeY,
      cellSizeM,
      glideRatio,
      maxAltitude,
      homeAlt,
      losShortcut,
      shaderOriginRunN
    );

    const uniformBuffer = createBuffer(device, new Uint8Array(uniformParams), uniformUsage);
    const elevBuffer = createBuffer(device, new Uint8Array(elevation.buffer), storageUsage);

    let altRead = createBuffer(device, new Uint8Array(alt.buffer), storageUsage);
    let altWrite = createBuffer(device, new Uint8Array(alt.buffer), storageUsage);
    let originRead = createBuffer(device, new Uint8Array(originPairs.buffer), storageUsage);
    let originWrite = createBuffer(device, new Uint8Array(originPairs.buffer), storageUsage);
    let parentRead = createBuffer(device, new Uint8Array(parentPairs.buffer), storageUsage);
    let parentWrite = createBuffer(device, new Uint8Array(parentPairs.buffer), storageUsage);
    let groundRead = createBuffer(device, new Uint8Array(ground.buffer), storageUsage);
    let groundWrite = createBuffer(device, new Uint8Array(ground.buffer), storageUsage);
    const rgbaBuffer = createBuffer(device, new Uint8Array(count * 4), storageUsage);

    const wgX = Math.ceil(width / 8);
    const wgY = Math.ceil(height / 8);
    const iterations = (width + height) * 2;
    const t0 = performance.now();

    for (let iter = 0; iter < iterations; iter += 1) {
      const encoder = device.createCommandEncoder();

      const originBind = device.createBindGroup({
        layout: pipelines.origin.layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: elevBuffer } },
          { binding: 2, resource: { buffer: altRead } },
          { binding: 3, resource: { buffer: originRead } },
          { binding: 4, resource: { buffer: parentRead } },
          { binding: 5, resource: { buffer: groundRead } },
          { binding: 6, resource: { buffer: originWrite } },
          { binding: 7, resource: { buffer: parentWrite } },
        ],
      });
      const passOrigin = encoder.beginComputePass();
      passOrigin.setPipeline(pipelines.origin.pipeline);
      passOrigin.setBindGroup(0, originBind);
      passOrigin.dispatchWorkgroups(wgX, wgY);
      passOrigin.end();

      [originRead, originWrite] = [originWrite, originRead];
      [parentRead, parentWrite] = [parentWrite, parentRead];

      const altBind = device.createBindGroup({
        layout: pipelines.alt.layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: elevBuffer } },
          { binding: 2, resource: { buffer: originRead } },
          { binding: 3, resource: { buffer: altRead } },
          { binding: 4, resource: { buffer: altWrite } },
        ],
      });
      const passAlt = encoder.beginComputePass();
      passAlt.setPipeline(pipelines.alt.pipeline);
      passAlt.setBindGroup(0, altBind);
      passAlt.dispatchWorkgroups(wgX, wgY);
      passAlt.end();

      [altRead, altWrite] = [altWrite, altRead];

      const groundBind = device.createBindGroup({
        layout: pipelines.ground.layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: elevBuffer } },
          { binding: 2, resource: { buffer: altRead } },
          { binding: 3, resource: { buffer: altWrite } },
          { binding: 4, resource: { buffer: originRead } },
          { binding: 5, resource: { buffer: groundWrite } },
        ],
      });
      const passGround = encoder.beginComputePass();
      passGround.setPipeline(pipelines.ground.pipeline);
      passGround.setBindGroup(0, groundBind);
      passGround.dispatchWorkgroups(wgX, wgY);
      passGround.end();

      [altRead, altWrite] = [altWrite, altRead];
      [groundRead, groundWrite] = [groundWrite, groundRead];

      device.queue.submit([encoder.finish()]);
    }

    const colorUniform = createBuffer(device, new Uint8Array(uniformParams), uniformUsage);
    const colorPipeline =
      overlayColor === "red" ? pipelines.colorRed.pipeline : pipelines.color.pipeline;
    const colorLayout =
      overlayColor === "red" ? pipelines.colorRed.layout : pipelines.color.layout;
    const colorBind = device.createBindGroup({
      layout: colorLayout,
      entries: [
        { binding: 0, resource: { buffer: colorUniform } },
        { binding: 1, resource: { buffer: altRead } },
        { binding: 2, resource: { buffer: originRead } },
        { binding: 3, resource: { buffer: groundRead } },
        { binding: 4, resource: { buffer: rgbaBuffer } },
      ],
    });

    const colorEncoder = device.createCommandEncoder();
    const colorPass = colorEncoder.beginComputePass();
    colorPass.setPipeline(colorPipeline);
    colorPass.setBindGroup(0, colorBind);
    colorPass.dispatchWorkgroups(wgX, wgY);
    colorPass.end();
    device.queue.submit([colorEncoder.finish()]);

    const readBuffer = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const copyEncoder = device.createCommandEncoder();
    copyEncoder.copyBufferToBuffer(rgbaBuffer, 0, readBuffer, 0, count * 4);
    device.queue.submit([copyEncoder.finish()]);
    await readBuffer.mapAsync(GPUMapMode.READ);
    const packed = new Uint32Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();

    const imageData = new ImageData(width, height);
    for (let i = 0; i < count; i += 1) {
      const p = packed[i];
      const dst = i * 4;
      imageData.data[dst] = p & 255;
      imageData.data[dst + 1] = (p >> 8) & 255;
      imageData.data[dst + 2] = (p >> 16) & 255;
      imageData.data[dst + 3] = (p >> 24) & 255;
    }

    const baseResult = {
      imageData,
      width,
      height,
      homeAlt,
      iterations,
      elapsedMs: performance.now() - t0,
    };

    if (imageOnly) {
      return baseResult;
    }

    const altReadBuffer = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const altCopyEncoder = device.createCommandEncoder();
    altCopyEncoder.copyBufferToBuffer(altRead, 0, altReadBuffer, 0, count * 4);
    device.queue.submit([altCopyEncoder.finish()]);
    await altReadBuffer.mapAsync(GPUMapMode.READ);
    const altitudes = new Float32Array(altReadBuffer.getMappedRange().slice(0));
    altReadBuffer.unmap();

    const pairBytes = count * 8;
    const originBuffer = device.createBuffer({
      size: pairBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const parentBuffer = device.createBuffer({
      size: pairBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const originCopyEncoder = device.createCommandEncoder();
    originCopyEncoder.copyBufferToBuffer(originRead, 0, originBuffer, 0, pairBytes);
    originCopyEncoder.copyBufferToBuffer(parentRead, 0, parentBuffer, 0, pairBytes);
    device.queue.submit([originCopyEncoder.finish()]);
    await originBuffer.mapAsync(GPUMapMode.READ);
    await parentBuffer.mapAsync(GPUMapMode.READ);
    const originPairsOut = new Int32Array(originBuffer.getMappedRange().slice(0));
    const parentPairsOut = new Int32Array(parentBuffer.getMappedRange().slice(0));
    originBuffer.unmap();
    parentBuffer.unmap();
    const { xArr: originXOut, yArr: originYOut } = unpackXY(originPairsOut);
    const { xArr: parentXOut, yArr: parentYOut } = unpackXY(parentPairsOut);

    const groundReadBuffer = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const groundCopyEncoder = device.createCommandEncoder();
    groundCopyEncoder.copyBufferToBuffer(groundRead, 0, groundReadBuffer, 0, count * 4);
    device.queue.submit([groundCopyEncoder.finish()]);
    await groundReadBuffer.mapAsync(GPUMapMode.READ);
    const groundOut = new Uint32Array(groundReadBuffer.getMappedRange().slice(0));
    groundReadBuffer.unmap();

    return {
      ...baseResult,
      altitudes,
      originX: originXOut,
      originY: originYOut,
      parentX: parentXOut,
      parentY: parentYOut,
      ground: groundOut,
    };
  }
}
