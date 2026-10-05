import {
  PROPAGATE_SHADER,
  CHANGED_SUM_SHADER,
  MODIFIED_CELLS_SHADER,
  ORIGIN_PATH_VALIDATE_SHADER,
  FLAG_CHANGED,
  COLOR_SHADER,
  COLOR_SHADER_RAW,
  COLOR_SHADER_SECTORS,
  RESOLVE_ORIGIN_SHADER,
} from "./shaders.js";
import { DOWNWARD_PROPAGATE_SHADER } from "./downward-shader.js";
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
  packSeedPairs,
  renderModifiedCellsFrame,
} from "./render.js";
import {
  packOriginPathValidateParams,
  runOriginPathValidation,
  emptyCountersBuffer,
} from "../debug/origin-path-validate.js";

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
      modifiedCells: await createPipeline(this.device, MODIFIED_CELLS_SHADER, [
        "uniform",
        "read-only-storage",
        "storage",
      ]),
      originPathValidate: await createPipeline(this.device, ORIGIN_PATH_VALIDATE_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
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
      colorRaw: await createPipeline(this.device, COLOR_SHADER_RAW, [
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
      downward: await createPipeline(this.device, DOWNWARD_PROPAGATE_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
        "read-only-storage",
        "storage",
        "read-only-storage",
        "storage",
      ]),
    };
  }

  async computeDownward(dem, { glideRatio, maxAltitude, gi, gj, startAlt, coneAltitudes }) {
    const { device, pipelines } = this;
    if (!device || !pipelines?.downward) {
      throw new Error("WebGPU downward pipeline is not ready.");
    }
    const { width, height, cellSizeM, elevation } = dem;
    const count = width * height;
    const startIdx = gj * width + gi;
    const alt = new Float32Array(count).fill(-1);
    const originX = new Int32Array(count).fill(-1);
    const originY = new Int32Array(count).fill(-1);
    const flags = new Uint32Array(count);
    originX[startIdx] = gi;
    originY[startIdx] = gj;
    const startCone = coneAltitudes[startIdx];
    // Already at/below the upward cone: seed as GC (no wavefront).
    if (Number.isFinite(startCone) && startCone < maxAltitude && startAlt < startCone) {
      alt[startIdx] = startCone;
      flags[startIdx] = 1; // FLAG_GROUND
    } else {
      alt[startIdx] = startAlt;
      flags[startIdx] = 2; // FLAG_CHANGED
    }
    const originPairs = new Int32Array(count * 2);
    for (let i = 0; i < count; i += 1) {
      originPairs[i * 2] = originX[i];
      originPairs[i * 2 + 1] = originY[i];
    }
    const params = packParams(width, height, gi, gj, cellSizeM, glideRatio, maxAltitude, startAlt);
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const uniform = createBuffer(device, new Uint8Array(params), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const elevBuffer = createBuffer(device, new Uint8Array(elevation.buffer), storage);
    const coneBuffer = createBuffer(device, new Uint8Array(coneAltitudes.buffer), storage);
    let altRead = createBuffer(device, new Uint8Array(alt.buffer), storage);
    let altWrite = createBuffer(device, new Uint8Array(alt.buffer), storage);
    let originRead = createBuffer(device, new Uint8Array(originPairs.buffer), storage);
    let originWrite = createBuffer(device, new Uint8Array(originPairs.buffer), storage);
    let flagsPrev = createBuffer(device, new Uint8Array(flags.buffer), storage);
    let flagsCurr = createBuffer(device, new Uint8Array(count * 4), storage);
    const changeCountBuffer = createBuffer(device, new Uint32Array([0]), storage);
    const changeReadBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const sumUniform = new ArrayBuffer(8);
    new DataView(sumUniform).setUint32(0, width, true);
    new DataView(sumUniform).setUint32(4, height, true);
    const sumUniformBuffer = createBuffer(device, new Uint8Array(sumUniform), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const wgX = Math.ceil(width / 8);
    const wgY = Math.ceil(height / 8);
    const maxIterations = width + height;
    let iterations = 0;
    for (let iter = 0; iter < maxIterations; iter += 1) {
      iterations = iter + 1;
      const encoder = device.createCommandEncoder();
      const propagateBind = device.createBindGroup({
        layout: pipelines.downward.layout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: elevBuffer } },
          { binding: 2, resource: { buffer: coneBuffer } },
          { binding: 3, resource: { buffer: altRead } },
          { binding: 4, resource: { buffer: altWrite } },
          { binding: 5, resource: { buffer: originRead } },
          { binding: 6, resource: { buffer: originWrite } },
          { binding: 7, resource: { buffer: flagsPrev } },
          { binding: 8, resource: { buffer: flagsCurr } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipelines.downward.pipeline);
      pass.setBindGroup(0, propagateBind);
      pass.dispatchWorkgroups(wgX, wgY);
      pass.end();
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
    }
    const altReadBuffer = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const originBytes = count * 8;
    const originReadBuffer = device.createBuffer({
      size: originBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const copy = device.createCommandEncoder();
    copy.copyBufferToBuffer(altRead, 0, altReadBuffer, 0, count * 4);
    copy.copyBufferToBuffer(originRead, 0, originReadBuffer, 0, originBytes);
    device.queue.submit([copy.finish()]);
    await altReadBuffer.mapAsync(GPUMapMode.READ);
    const arrivals = new Float32Array(altReadBuffer.getMappedRange().slice(0));
    altReadBuffer.unmap();
    altReadBuffer.destroy();
    await originReadBuffer.mapAsync(GPUMapMode.READ);
    const packedOrigins = new Int32Array(originReadBuffer.getMappedRange().slice(0));
    originReadBuffer.unmap();
    originReadBuffer.destroy();
    const outOriginX = new Int32Array(count);
    const outOriginY = new Int32Array(count);
    for (let i = 0; i < count; i += 1) {
      outOriginX[i] = packedOrigins[i * 2];
      outOriginY[i] = packedOrigins[i * 2 + 1];
    }
    return { arrivals, originX: outOriginX, originY: outOriginY, iterations };
  }

  async compute(dem, params, options = {}) {
    const {
      imageOnly = false,
      raw: rawOverride,
      onProgress = null,
      shouldStop = null,
      maxIterations = null,
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
      showModifiedCells = false,
      validateOriginPaths = false,
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

    const seedPairs = packSeedPairs(seeds);
    const seedBuffer = createBuffer(device, new Uint8Array(seedPairs.buffer), storageUsage);

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

    const validateUniformBuffer = validateOriginPaths
      ? createBuffer(
          device,
          new Uint8Array(
            packOriginPathValidateParams(
              width,
              height,
              maxAltitude,
              seeds.length,
              (width + height) * 2,
              cellSizeM
            )
          ),
          uniformUsage
        )
      : null;
    const countersBuffer = validateOriginPaths
      ? createBuffer(device, new Uint8Array(emptyCountersBuffer()), storageUsage)
      : null;
    const pathMaxLdBuffer = validateOriginPaths
      ? createBuffer(device, new Float32Array(count), storageUsage)
      : null;
    const countersReadBuffer = validateOriginPaths
      ? device.createBuffer({
          size: 28,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
      : null;

    const wgX = Math.ceil(width / 8);
    const wgY = Math.ceil(height / 8);
    const t0 = performance.now();
    let actualIterations = 0;
    let stopReason = "converged";
    const CONVERGENCE_CHECK_EVERY = 300;

    const colorUniform = createBuffer(device, new Uint8Array(uniformParams), uniformUsage);
    const { pipeline: colorPipeline, layout: colorLayout } = pickColorPipeline(
      pipelines,
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

    const renderModifiedFrame = () =>
      renderModifiedCellsFrame(device, {
        modifiedPipeline: pipelines.modifiedCells.pipeline,
        modifiedLayout: pipelines.modifiedCells.layout,
        sumUniformBuffer,
        flagsRead: flagsPrev,
        rgbaBuffer,
        readBuffer,
        wgX,
        wgY,
        width,
        height,
        count,
      });

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

      const checkConvergence = actualIterations % CONVERGENCE_CHECK_EVERY === 0;
      if (checkConvergence) {
        // Reading this buffer every iteration is expensive (GPU->CPU mapAsync).
        // We only do it periodically for convergence detection.
        encoder.copyBufferToBuffer(changeCountBuffer, 0, changeReadBuffer, 0, 4);
      }
      device.queue.submit([encoder.finish()]);

      if (checkConvergence) {
        await changeReadBuffer.mapAsync(GPUMapMode.READ);
        const changes = new Uint32Array(changeReadBuffer.getMappedRange().slice(0))[0];
        changeReadBuffer.unmap();

        if (changes === 0) {
          break;
        }
      }

      if (shouldStop?.()) {
        stopReason = "stopped";
        break;
      }

      if (Number.isFinite(maxIterations) && maxIterations > 0 && actualIterations >= maxIterations) {
        stopReason = "max_iterations";
        break;
      }

      frameArgs.altRead = altRead;
      frameArgs.originRead = originRead;
      frameArgs.groundRead = flagsPrev;
      await maybeEmitProgress();
    }

    let originPathValidation = null;
    if (validateOriginPaths) {
      originPathValidation = await runOriginPathValidation(device, pipelines.originPathValidate, {
        validateUniformBuffer,
        altRead,
        originRead,
        seedBuffer,
        countersBuffer,
        pathMaxLdBuffer,
        countersReadBuffer,
        wgX,
        wgY,
      });
    }

    let imageData = null;
    if (showModifiedCells) {
      imageData = await renderModifiedFrame();
    } else if (needsRaster) {
      imageData = await renderRasterFrame();
    }

    const baseResult = {
      imageData,
      width,
      height,
      homeAlt,
      iterations: actualIterations,
      stopReason,
      stopped: stopReason === "stopped" || stopReason === "max_iterations",
      elapsedMs: performance.now() - t0,
      originPathValidation,
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
