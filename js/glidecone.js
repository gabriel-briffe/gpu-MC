const ORIGIN_SHADER = /* wgsl */ `
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
@group(0) @binding(3) var<storage, read> originXIn: array<i32>;
@group(0) @binding(4) var<storage, read> originYIn: array<i32>;
@group(0) @binding(5) var<storage, read> groundIn: array<u32>;
@group(0) @binding(6) var<storage, read_write> originXOut: array<i32>;
@group(0) @binding(7) var<storage, read_write> originYOut: array<i32>;

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
  let ci = idx(x, y);
  return originXIn[ci] == targetOx && originYIn[ci] == targetOy;
}

// Bresenham toward origin cell; stop early on ground (blocked) or same-origin frontier (clear).
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
      if (hasSameOrigin(x1, y1, targetOx, targetOy)) {
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
      if (hasSameOrigin(x1, y1, targetOx, targetOy)) {
        return true;
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

fn tryOrigin(ox: i32, oy: i32, x: i32, y: i32, bestReq: f32, bestOx: i32, bestOy: i32) -> vec3<f32> {
  if (ox < 0 || oy < 0 || !inBounds(ox, oy)) {
    return vec3<f32>(bestReq, f32(bestOx), f32(bestOy));
  }
  let req = coneAlt(ox, oy, x, y);
  if (req < bestReq) {
    return vec3<f32>(req, f32(ox), f32(oy));
  }
  return vec3<f32>(bestReq, f32(bestOx), f32(bestOy));
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

fn tryNeighbor(nx: i32, ny: i32, x: i32, y: i32, bestReq: f32, bestOx: i32, bestOy: i32) -> vec3<f32> {
  if (!inBounds(nx, ny)) {
    return vec3<f32>(bestReq, f32(bestOx), f32(bestOy));
  }
  let ni = idx(nx, ny);
  let nox = originXIn[ni];
  let noy = originYIn[ni];
  if (nox < 0 || noy < 0) {
    return vec3<f32>(bestReq, f32(bestOx), f32(bestOy));
  }
  let elected = electedOrigin(x, y, nox, noy, nx, ny);
  return tryOrigin(elected.x, elected.y, x, y, bestReq, bestOx, bestOy);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (!inBounds(x, y)) {
    return;
  }

  let i = idx(x, y);
  var bestReq = params.maxAlt;
  var bestOx = originXIn[i];
  var bestOy = originYIn[i];

  if (bestOx >= 0 && bestOy >= 0) {
    let elected = electedOrigin(x, y, bestOx, bestOy, x, y);
    let own = tryOrigin(elected.x, elected.y, x, y, bestReq, bestOx, bestOy);
    bestReq = own.x;
    bestOx = i32(own.y);
    bestOy = i32(own.z);
  }

  var v = tryNeighbor(x, y - 1, x, y, bestReq, bestOx, bestOy);
  bestReq = v.x; bestOx = i32(v.y); bestOy = i32(v.z);
  v = tryNeighbor(x, y + 1, x, y, bestReq, bestOx, bestOy);
  bestReq = v.x; bestOx = i32(v.y); bestOy = i32(v.z);
  v = tryNeighbor(x - 1, y, x, y, bestReq, bestOx, bestOy);
  bestReq = v.x; bestOx = i32(v.y); bestOy = i32(v.z);
  v = tryNeighbor(x + 1, y, x, y, bestReq, bestOx, bestOy);
  bestReq = v.x; bestOx = i32(v.y); bestOy = i32(v.z);

  originXOut[i] = bestOx;
  originYOut[i] = bestOy;
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
@group(0) @binding(2) var<storage, read> originX: array<i32>;
@group(0) @binding(3) var<storage, read> originY: array<i32>;
@group(0) @binding(4) var<storage, read> altIn: array<f32>;
@group(0) @binding(5) var<storage, read_write> altOut: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= i32(params.width) || y >= i32(params.height)) {
    return;
  }

  let i = u32(y) * params.width + u32(x);
  let ox = originX[i];
  let oy = originY[i];
  if (ox < 0 || oy < 0) {
    altOut[i] = params.maxAlt;
    return;
  }

  let oi = u32(oy) * params.width + u32(ox);
  let dx = f32(x - ox);
  let dy = f32(y - oy);
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
@group(0) @binding(4) var<storage, read_write> originX: array<i32>;
@group(0) @binding(5) var<storage, read_write> originY: array<i32>;
@group(0) @binding(6) var<storage, read_write> groundOut: array<u32>;

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
    originX[i] = x;
    originY[i] = y;
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
@group(0) @binding(2) var<storage, read> originX: array<i32>;
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
  let ox = originX[i];
  let a = alt[i];

  if (ox < 0 || a >= params.maxAlt || ground[i] == 1u) {
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

function packParams(width, height, homeX, homeY, cellSizeM, glideRatio, maxAlt, homeAlt = 0) {
  const buf = new ArrayBuffer(32);
  const view = new DataView(buf);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setInt32(8, homeX, true);
  view.setInt32(12, homeY, true);
  view.setFloat32(16, cellSizeM, true);
  view.setFloat32(20, glideRatio, true);
  view.setFloat32(24, maxAlt, true);
  view.setFloat32(28, homeAlt, true);
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
        "storage",
      ]),
      color: await createPipeline(this.device, COLOR_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
      ]),
    };
  }

  async compute(dem, params) {
    const { device, pipelines } = this;
    const { width, height, homeX, homeY, cellSizeM, elevation } = dem;
    const { glideRatio, maxAltitude, circuitHeight } = params;
    const count = width * height;

    const homeIdx = homeY * width + homeX;
    const homeAlt = elevation[homeIdx] + circuitHeight;

    const alt = new Float32Array(count).fill(maxAltitude);
    const originX = new Int32Array(count).fill(-1);
    const originY = new Int32Array(count).fill(-1);
    const ground = new Uint32Array(count);
    alt[homeIdx] = homeAlt;
    originX[homeIdx] = homeX;
    originY[homeIdx] = homeY;

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
      homeAlt
    );

    const uniformBuffer = createBuffer(device, new Uint8Array(uniformParams), uniformUsage);
    const elevBuffer = createBuffer(device, new Uint8Array(elevation.buffer), storageUsage);

    let altRead = createBuffer(device, new Uint8Array(alt.buffer), storageUsage);
    let altWrite = createBuffer(device, new Uint8Array(alt.buffer), storageUsage);
    let originXRead = createBuffer(device, new Uint8Array(originX.buffer), storageUsage);
    let originYRead = createBuffer(device, new Uint8Array(originY.buffer), storageUsage);
    let originXWrite = createBuffer(device, new Uint8Array(originX.buffer), storageUsage);
    let originYWrite = createBuffer(device, new Uint8Array(originY.buffer), storageUsage);
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
          { binding: 3, resource: { buffer: originXRead } },
          { binding: 4, resource: { buffer: originYRead } },
          { binding: 5, resource: { buffer: groundRead } },
          { binding: 6, resource: { buffer: originXWrite } },
          { binding: 7, resource: { buffer: originYWrite } },
        ],
      });
      const passOrigin = encoder.beginComputePass();
      passOrigin.setPipeline(pipelines.origin.pipeline);
      passOrigin.setBindGroup(0, originBind);
      passOrigin.dispatchWorkgroups(wgX, wgY);
      passOrigin.end();

      [originXRead, originXWrite] = [originXWrite, originXRead];
      [originYRead, originYWrite] = [originYWrite, originYRead];

      const altBind = device.createBindGroup({
        layout: pipelines.alt.layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: elevBuffer } },
          { binding: 2, resource: { buffer: originXRead } },
          { binding: 3, resource: { buffer: originYRead } },
          { binding: 4, resource: { buffer: altRead } },
          { binding: 5, resource: { buffer: altWrite } },
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
          { binding: 4, resource: { buffer: originXRead } },
          { binding: 5, resource: { buffer: originYRead } },
          { binding: 6, resource: { buffer: groundWrite } },
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
    const colorBind = device.createBindGroup({
      layout: pipelines.color.layout,
      entries: [
        { binding: 0, resource: { buffer: colorUniform } },
        { binding: 1, resource: { buffer: altRead } },
        { binding: 2, resource: { buffer: originXRead } },
        { binding: 3, resource: { buffer: groundRead } },
        { binding: 4, resource: { buffer: rgbaBuffer } },
      ],
    });

    const colorEncoder = device.createCommandEncoder();
    const colorPass = colorEncoder.beginComputePass();
    colorPass.setPipeline(pipelines.color.pipeline);
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

    const originXBuffer = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const originYBuffer = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const originCopyEncoder = device.createCommandEncoder();
    originCopyEncoder.copyBufferToBuffer(originXRead, 0, originXBuffer, 0, count * 4);
    originCopyEncoder.copyBufferToBuffer(originYRead, 0, originYBuffer, 0, count * 4);
    device.queue.submit([originCopyEncoder.finish()]);
    await originXBuffer.mapAsync(GPUMapMode.READ);
    await originYBuffer.mapAsync(GPUMapMode.READ);
    const originXOut = new Int32Array(originXBuffer.getMappedRange().slice(0));
    const originYOut = new Int32Array(originYBuffer.getMappedRange().slice(0));
    originXBuffer.unmap();
    originYBuffer.unmap();

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

    const imageData = new ImageData(width, height);
    for (let i = 0; i < count; i += 1) {
      const p = packed[i];
      const dst = i * 4;
      imageData.data[dst] = p & 255;
      imageData.data[dst + 1] = (p >> 8) & 255;
      imageData.data[dst + 2] = (p >> 16) & 255;
      imageData.data[dst + 3] = (p >> 24) & 255;
    }

    return {
      imageData,
      altitudes,
      originX: originXOut,
      originY: originYOut,
      ground: groundOut,
      width,
      height,
      homeAlt,
      iterations,
      elapsedMs: performance.now() - t0,
    };
  }
}
