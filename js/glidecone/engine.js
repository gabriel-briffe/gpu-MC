import {
  PROPAGATE_SHADER,
  CHANGED_SUM_SHADER,
  FLAG_CHANGED,
  COLOR_SHADER,
  COLOR_SHADER_RAW,
  COLOR_SHADER_RED,
  COLOR_SHADER_SECTORS,
  RESOLVE_ORIGIN_SHADER,
} from "./shaders.js";
import { buildSeedPaletteGrid } from "./sectors-color.js";
import {
  pickColorPipeline,
  renderColorFrame,
  resolveDeepOriginsGpu,
  packParams,
  createBuffer,
  packXY,
  unpackXY,
  createPipeline,
} from "./render.js";

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
      propagate: await createPipeline(this.device, PROPAGATE_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "storage",
        "read-only-storage",
        "storage",
        "read-only-storage",
        "storage",
      ]),
      changedSum: await createPipeline(this.device, CHANGED_SUM_SHADER, [
        "uniform",
        "read-only-storage",
        "storage",
      ]),
      color: await createPipeline(this.device, COLOR_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
      ]),
      colorRaw: await createPipeline(this.device, COLOR_SHADER_RAW, [
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
      colorSectors: await createPipeline(this.device, COLOR_SHADER_SECTORS, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
        "read-only-storage",
      ]),
      resolveOrigin: await createPipeline(this.device, RESOLVE_ORIGIN_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "storage",
      ]),
    };
  }

  async compute(dem, params, options = {}) {
    const {
      overlayColor = "blue",
      imageOnly = false,
      raw: rawOverride,
      onProgress = null,
      shouldStop = null,
    } = options;
    const { device, pipelines } = this;
    const { width, height, homeX, homeY, cellSizeM, elevation, terrainMsl, groundClearance, seeds: demSeeds } =
      dem;
    const seeds =
      demSeeds?.length > 0 ? demSeeds : [{ x: homeX, y: homeY }];
    const {
      glideRatio,
      maxAltitude,
      circuitHeight,
      raw: rawParam = true,
      contours: contoursParam = false,
      pathOnly: pathOnlyParam = false,
      sectors: sectorsParam = false,
      updateMapMs = 100,
    } = params;
    const raw = rawOverride !== undefined ? rawOverride : rawParam;
    const contours = contoursParam;
    const pathOnly = pathOnlyParam;
    const sectors = sectorsParam;
    const needsRaster = imageOnly || raw || sectors || (!contours && !pathOnly);
    const count = width * height;

    const alt = new Float32Array(count).fill(maxAltitude);
    const originX = new Int32Array(count).fill(-1);
    const originY = new Int32Array(count).fill(-1);
    const flagsInit = new Uint32Array(count);

    let homeAlt = maxAltitude;
    for (const seed of seeds) {
      const seedIdx = seed.y * width + seed.x;
      const terrain = terrainMsl
        ? terrainMsl[seedIdx]
        : elevation[seedIdx] - groundClearance;
      const seedAlt = terrain + circuitHeight;
      alt[seedIdx] = seedAlt;
      originX[seedIdx] = seed.x;
      originY[seedIdx] = seed.y;
      flagsInit[seedIdx] = FLAG_CHANGED;
      if (homeAlt === maxAltitude || seedAlt < homeAlt) {
        homeAlt = seedAlt;
      }
    }

    const originPairs = packXY(originX, originY);

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
    const sumUniformParams = (() => {
      const buf = new ArrayBuffer(8);
      const view = new DataView(buf);
      view.setUint32(0, width, true);
      view.setUint32(4, height, true);
      return buf;
    })();

    const uniformBuffer = createBuffer(device, new Uint8Array(uniformParams), uniformUsage);
    const sumUniformBuffer = createBuffer(device, new Uint8Array(sumUniformParams), uniformUsage);
    const elevBuffer = createBuffer(device, new Uint8Array(elevation.buffer), storageUsage);

    let altRead = createBuffer(device, new Uint8Array(alt.buffer), storageUsage);
    let altWrite = createBuffer(device, new Uint8Array(alt.buffer), storageUsage);
    let originRead = createBuffer(device, new Uint8Array(originPairs.buffer), storageUsage);
    let originWrite = createBuffer(device, new Uint8Array(originPairs.buffer), storageUsage);
    let flagsPrev = createBuffer(device, new Uint8Array(flagsInit.buffer), storageUsage);
    let flagsCurr = createBuffer(device, new Uint8Array(count * 4), storageUsage);
    const rgbaBuffer = createBuffer(device, new Uint8Array(count * 4), storageUsage);

    const pairBytes = count * 8;
    const changeCountBuffer = createBuffer(device, new Uint32Array([0]), storageUsage);
    const changeReadBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const seedPaletteBuffer = sectors
      ? createBuffer(
          device,
          new Uint8Array(buildSeedPaletteGrid(width, height, seeds).buffer),
          storageUsage
        )
      : null;
    const resolveOriginRead = sectors
      ? device.createBuffer({ size: pairBytes, usage: storageUsage })
      : null;
    const resolveOriginWrite = sectors
      ? device.createBuffer({ size: pairBytes, usage: storageUsage })
      : null;

    const wgX = Math.ceil(width / 8);
    const wgY = Math.ceil(height / 8);
    const t0 = performance.now();
    let actualIterations = 0;
    let stopReason = "converged";

    const colorUniform = createBuffer(device, new Uint8Array(uniformParams), uniformUsage);
    const { pipeline: colorPipeline, layout: colorLayout } = pickColorPipeline(
      pipelines,
      overlayColor,
      { raw, sectors }
    );
    const readBuffer = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const livePreview =
      needsRaster &&
      !sectors &&
      !imageOnly &&
      onProgress &&
      Number.isFinite(updateMapMs) &&
      updateMapMs > 0;
    let lastMapUpdate = 0;

    const frameArgs = {
      colorPipeline,
      colorLayout,
      colorUniform,
      altRead,
      originRead,
      groundRead: flagsPrev,
      rgbaBuffer,
      readBuffer,
      seedPaletteBuffer,
      wgX,
      wgY,
      width,
      height,
      count,
    };

    const renderRasterFrame = () => {
      let colorOriginRead = originRead;
      let colorFlagsRead = flagsPrev;
      if (sectors) {
        colorOriginRead = resolveDeepOriginsGpu(device, pipelines, {
          uniformBuffer,
          originRead,
          groundRead: flagsPrev,
          resolveRead: resolveOriginRead,
          resolveWrite: resolveOriginWrite,
          pairBytes,
          wgX,
          wgY,
        });
      }
      return renderColorFrame(
        device,
        { ...frameArgs, originRead: colorOriginRead, groundRead: colorFlagsRead },
        { sectors }
      );
    };

    const maybeEmitProgress = async (force = false) => {
      if (!livePreview) {
        return;
      }
      const now = performance.now();
      if (!force && now - lastMapUpdate < updateMapMs) {
        return;
      }
      lastMapUpdate = now;
      const imageData = await renderRasterFrame();
      onProgress({
        imageData,
        iteration: actualIterations,
        elapsedMs: now - t0,
        stopReason,
      });
    };

    for (;;) {
      if (shouldStop?.()) {
        stopReason = "stopped";
        break;
      }

      actualIterations += 1;

      const encoder = device.createCommandEncoder();

      const propagateBind = device.createBindGroup({
        layout: pipelines.propagate.layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: elevBuffer } },
          { binding: 2, resource: { buffer: altRead } },
          { binding: 3, resource: { buffer: altWrite } },
          { binding: 4, resource: { buffer: originRead } },
          { binding: 5, resource: { buffer: originWrite } },
          { binding: 6, resource: { buffer: flagsPrev } },
          { binding: 7, resource: { buffer: flagsCurr } },
        ],
      });
      const passPropagate = encoder.beginComputePass();
      passPropagate.setPipeline(pipelines.propagate.pipeline);
      passPropagate.setBindGroup(0, propagateBind);
      passPropagate.dispatchWorkgroups(wgX, wgY);
      passPropagate.end();

      [altRead, altWrite] = [altWrite, altRead];
      [originRead, originWrite] = [originWrite, originRead];
      [flagsPrev, flagsCurr] = [flagsCurr, flagsPrev];

      device.queue.writeBuffer(changeCountBuffer, 0, new Uint32Array([0]));

      const sumBind = device.createBindGroup({
        layout: pipelines.changedSum.layout,
        entries: [
          { binding: 0, resource: { buffer: sumUniformBuffer } },
          { binding: 1, resource: { buffer: flagsPrev } },
          { binding: 2, resource: { buffer: changeCountBuffer } },
        ],
      });
      const passSum = encoder.beginComputePass();
      passSum.setPipeline(pipelines.changedSum.pipeline);
      passSum.setBindGroup(0, sumBind);
      passSum.dispatchWorkgroups(wgX, wgY);
      passSum.end();

      encoder.copyBufferToBuffer(changeCountBuffer, 0, changeReadBuffer, 0, 4);
      device.queue.submit([encoder.finish()]);

      await changeReadBuffer.mapAsync(GPUMapMode.READ);
      const changes = new Uint32Array(changeReadBuffer.getMappedRange().slice(0))[0];
      changeReadBuffer.unmap();

      if (changes === 0) {
        break;
      }

      if (shouldStop?.()) {
        stopReason = "stopped";
        break;
      }

      frameArgs.altRead = altRead;
      frameArgs.originRead = originRead;
      frameArgs.groundRead = flagsPrev;
      await maybeEmitProgress();
    }

    let imageData = null;
    if (needsRaster) {
      imageData = await renderRasterFrame();
    }

    const baseResult = {
      imageData,
      width,
      height,
      homeAlt,
      iterations: actualIterations,
      stopReason,
      stopped: stopReason === "stopped",
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

    const originBuffer = device.createBuffer({
      size: pairBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const originCopyEncoder = device.createCommandEncoder();
    originCopyEncoder.copyBufferToBuffer(originRead, 0, originBuffer, 0, pairBytes);
    device.queue.submit([originCopyEncoder.finish()]);
    await originBuffer.mapAsync(GPUMapMode.READ);
    const originPairsOut = new Int32Array(originBuffer.getMappedRange().slice(0));
    originBuffer.unmap();
    const { xArr: originXOut, yArr: originYOut } = unpackXY(originPairsOut);

    const flagsReadBuffer = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const flagsCopyEncoder = device.createCommandEncoder();
    flagsCopyEncoder.copyBufferToBuffer(flagsPrev, 0, flagsReadBuffer, 0, count * 4);
    device.queue.submit([flagsCopyEncoder.finish()]);
    await flagsReadBuffer.mapAsync(GPUMapMode.READ);
    const flagsPacked = new Uint32Array(flagsReadBuffer.getMappedRange().slice(0));
    flagsReadBuffer.unmap();
    const groundOut = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) {
      groundOut[i] = flagsPacked[i] & 1;
    }

    return {
      ...baseResult,
      altitudes,
      originX: originXOut,
      originY: originYOut,
      ground: groundOut,
    };
  }
}
