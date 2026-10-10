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

function destroyGpuBuffers(buffers) {
  for (const buffer of buffers) {
    if (!buffer) {
      continue;
    }
    try {
      buffer.destroy();
    } catch {
      // Already destroyed or device lost.
    }
  }
}

function writeGpuBuffer(device, buffer, data) {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  device.queue.writeBuffer(buffer, 0, bytes);
}

/**
 * First options convergence check (XCSoar Reach-based): longest no-terrain
 * reach from the glider in cells = (path + ½·margin·L/D) / cellSize, capped
 * by half the grid.
 */
export function optionsFirstCheckAt(width, height, cellSizeM, pathDistanceM, marginM, glideRatio) {
  const halfGrid = (Math.max(width, height) >> 1) + 1;
  const cell = cellSizeM > 0 ? cellSizeM : 0;
  const halfLdM = 0.5 * Math.max(0, marginM) * Math.max(glideRatio, 1);
  const reachM = Math.max(0, pathDistanceM) + halfLdM;
  let reachCells = 0;
  if (cell > 0 && reachM > 0) {
    reachCells = Math.ceil(reachM / cell);
  }
  let first = reachCells > 0 ? reachCells : halfGrid;
  if (first < 1) {
    first = 1;
  }
  if (first > halfGrid) {
    first = halfGrid;
  }
  return first;
}

export class GlideConeEngine {
  constructor() {
    this.device = null;
    this.pipelines = null;
    /** Reused across sequential options/downward runs (same grid size). */
    this._downwardPool = null;
    this._downwardBusy = false;
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

  _downwardPoolBuffers(pool) {
    return [
      pool.uniform,
      pool.elevBuffer,
      pool.coneBuffer,
      pool.altA,
      pool.altB,
      pool.originA,
      pool.originB,
      pool.flagsA,
      pool.flagsB,
      pool.changeCountBuffer,
      pool.changeReadBuffer,
      pool.sumUniformBuffer,
      pool.altMapRead,
      pool.originMapRead,
    ];
  }

  _destroyDownwardPool() {
    if (!this._downwardPool) {
      return;
    }
    destroyGpuBuffers(this._downwardPoolBuffers(this._downwardPool));
    this._downwardPool = null;
  }

  _createDownwardPool(count) {
    const { device } = this;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const uniformUsage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    const mapRead = GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ;
    const floatBytes = count * 4;
    const originBytes = count * 8;
    return {
      count,
      // packParams is a 48-byte uniform block.
      uniform: device.createBuffer({ size: 48, usage: uniformUsage }),
      elevBuffer: device.createBuffer({ size: floatBytes, usage: storage }),
      coneBuffer: device.createBuffer({ size: floatBytes, usage: storage }),
      altA: device.createBuffer({ size: floatBytes, usage: storage }),
      altB: device.createBuffer({ size: floatBytes, usage: storage }),
      originA: device.createBuffer({ size: originBytes, usage: storage }),
      originB: device.createBuffer({ size: originBytes, usage: storage }),
      flagsA: device.createBuffer({ size: floatBytes, usage: storage }),
      flagsB: device.createBuffer({ size: floatBytes, usage: storage }),
      changeCountBuffer: device.createBuffer({ size: 4, usage: storage }),
      changeReadBuffer: device.createBuffer({ size: 4, usage: mapRead }),
      sumUniformBuffer: device.createBuffer({ size: 8, usage: uniformUsage }),
      altMapRead: device.createBuffer({ size: floatBytes, usage: mapRead }),
      originMapRead: device.createBuffer({ size: originBytes, usage: mapRead }),
    };
  }

  /**
   * Reuse shared pool when idle and size matches; otherwise allocate.
   * Concurrent calls get ephemeral buffers so the shared pool is never raced.
   */
  _acquireDownwardBuffers(count) {
    if (!this._downwardBusy && this._downwardPool?.count === count) {
      this._downwardBusy = true;
      return { pool: this._downwardPool, owned: false };
    }
    if (!this._downwardBusy) {
      if (this._downwardPool?.count !== count) {
        this._destroyDownwardPool();
      }
      if (!this._downwardPool) {
        this._downwardPool = this._createDownwardPool(count);
      }
      this._downwardBusy = true;
      return { pool: this._downwardPool, owned: false };
    }
    return { pool: this._createDownwardPool(count), owned: true };
  }

  _releaseDownwardBuffers(owned, pool) {
    if (owned) {
      destroyGpuBuffers(this._downwardPoolBuffers(pool));
      return;
    }
    this._downwardBusy = false;
  }

  async computeDownward(
    dem,
    {
      glideRatio,
      maxAltitude,
      gi,
      gj,
      startAlt,
      coneAltitudes,
      /** Stored cone altitudes for LOS (defaults to coneAltitudes). */
      losAltitudes,
      pathDistanceM = 0,
      marginM = 0,
      iterationCap = 2000,
    }
  ) {
    const { device, pipelines } = this;
    if (!device || !pipelines?.downward) {
      throw new Error("WebGPU downward pipeline is not ready.");
    }
    const { width, height, cellSizeM } = dem;
    const count = width * height;
    const startIdx = gj * width + gi;
    const alt = new Float32Array(count).fill(-1);
    const originX = new Int32Array(count).fill(-1);
    const originY = new Int32Array(count).fill(-1);
    const flags = new Uint32Array(count);
    const startCone = coneAltitudes[startIdx];
    const hasFloor = Number.isFinite(startCone) && startCone < maxAltitude;
    // Seed is an Option only when arrival clears the cone floor (no GC freeze).
    if (!hasFloor || startAlt > startCone) {
      alt[startIdx] = startAlt;
      originX[startIdx] = gi;
      originY[startIdx] = gj;
      flags[startIdx] = 1 | 2; // FLAG_OPTION | FLAG_CHANGED
    }
    const originPairs = new Int32Array(count * 2);
    for (let i = 0; i < count; i += 1) {
      originPairs[i * 2] = originX[i];
      originPairs[i * 2 + 1] = originY[i];
    }
    const params = packParams(width, height, gi, gj, cellSizeM, glideRatio, maxAltitude, startAlt);
    const sumUniform = new ArrayBuffer(8);
    new DataView(sumUniform).setUint32(0, width, true);
    new DataView(sumUniform).setUint32(4, height, true);
    const los = losAltitudes ?? coneAltitudes;

    const { pool, owned } = this._acquireDownwardBuffers(count);
    try {
      writeGpuBuffer(device, pool.uniform, params);
      // elev binding carries LOS blockers (stored terrain/cone), not DEM.
      writeGpuBuffer(device, pool.elevBuffer, los);
      writeGpuBuffer(device, pool.coneBuffer, coneAltitudes);
      writeGpuBuffer(device, pool.altA, alt);
      writeGpuBuffer(device, pool.altB, alt);
      writeGpuBuffer(device, pool.originA, originPairs);
      writeGpuBuffer(device, pool.originB, originPairs);
      writeGpuBuffer(device, pool.flagsA, flags);
      writeGpuBuffer(device, pool.flagsB, new Uint32Array(count));
      writeGpuBuffer(device, pool.sumUniformBuffer, sumUniform);

      let altRead = pool.altA;
      let altWrite = pool.altB;
      let originRead = pool.originA;
      let originWrite = pool.originB;
      let flagsPrev = pool.flagsA;
      let flagsCurr = pool.flagsB;
      const {
        uniform,
        elevBuffer,
        coneBuffer,
        changeCountBuffer,
        changeReadBuffer,
        sumUniformBuffer,
        altMapRead,
        originMapRead,
      } = pool;

      const wgX = Math.ceil(width / 8);
      const wgY = Math.ceil(height / 8);
      const maxIterations =
        Number.isFinite(iterationCap) && iterationCap > 0 ? Math.floor(iterationCap) : 2000;
      let firstCheckAt = optionsFirstCheckAt(
        width,
        height,
        cellSizeM,
        pathDistanceM,
        marginM,
        glideRatio
      );
      if (firstCheckAt > maxIterations) {
        firstCheckAt = maxIterations;
      }
      // If still noisy after the first check, wait half that reach again.
      const checkStep = Math.max(1, (firstCheckAt / 2) | 0);
      let iterations = 0;
      let converged = false;
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

        const checkConvergence =
          iterations >= firstCheckAt &&
          ((iterations - firstCheckAt) % checkStep === 0 || iterations === maxIterations);
        if (checkConvergence) {
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
        }
        device.queue.submit([encoder.finish()]);

        if (checkConvergence) {
          await changeReadBuffer.mapAsync(GPUMapMode.READ);
          const changes = new Uint32Array(changeReadBuffer.getMappedRange().slice(0))[0];
          changeReadBuffer.unmap();
          if (changes === 0) {
            converged = true;
            break;
          }
        }
      }
      const originBytes = count * 8;
      const copy = device.createCommandEncoder();
      copy.copyBufferToBuffer(altRead, 0, altMapRead, 0, count * 4);
      copy.copyBufferToBuffer(originRead, 0, originMapRead, 0, originBytes);
      device.queue.submit([copy.finish()]);
      await altMapRead.mapAsync(GPUMapMode.READ);
      const arrivals = new Float32Array(altMapRead.getMappedRange().slice(0));
      altMapRead.unmap();
      await originMapRead.mapAsync(GPUMapMode.READ);
      const packedOrigins = new Int32Array(originMapRead.getMappedRange().slice(0));
      originMapRead.unmap();
      const outOriginX = new Int32Array(count);
      const outOriginY = new Int32Array(count);
      for (let i = 0; i < count; i += 1) {
        outOriginX[i] = packedOrigins[i * 2];
        outOriginY[i] = packedOrigins[i * 2 + 1];
      }
      return {
        arrivals,
        originX: outOriginX,
        originY: outOriginY,
        iterations,
        hitIterationCap: !converged,
      };
    } finally {
      this._releaseDownwardBuffers(owned, pool);
    }
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

    // Drop stale options pool when the grid size changes.
    if (this._downwardPool && this._downwardPool.count !== count && !this._downwardBusy) {
      this._destroyDownwardPool();
    }

    const gpuTemps = [];
    const track = (buffer) => {
      if (buffer) {
        gpuTemps.push(buffer);
      }
      return buffer;
    };

    try {
      const seedPairs = packSeedPairs(seeds);
      const seedBuffer = track(createBuffer(device, new Uint8Array(seedPairs.buffer), storageUsage));

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

      const uniformBuffer = track(createBuffer(device, new Uint8Array(uniformParams), uniformUsage));
      const sumUniformBuffer = track(
        createBuffer(device, new Uint8Array(sumUniformParams), uniformUsage)
      );
      const elevBuffer = track(createBuffer(device, new Uint8Array(elevation.buffer), storageUsage));

      let altRead = track(createBuffer(device, new Uint8Array(alt.buffer), storageUsage));
      let altWrite = track(createBuffer(device, new Uint8Array(alt.buffer), storageUsage));
      let originRead = track(createBuffer(device, new Uint8Array(originPairs.buffer), storageUsage));
      let originWrite = track(createBuffer(device, new Uint8Array(originPairs.buffer), storageUsage));
      let flagsPrev = track(createBuffer(device, new Uint8Array(flagsInit.buffer), storageUsage));
      let flagsCurr = track(createBuffer(device, new Uint8Array(count * 4), storageUsage));
      const rgbaBuffer = track(createBuffer(device, new Uint8Array(count * 4), storageUsage));

      const pairBytes = count * 8;
      const changeCountBuffer = track(createBuffer(device, new Uint32Array([0]), storageUsage));
      const changeReadBuffer = track(
        device.createBuffer({
          size: 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
      );

      const seedPaletteBuffer = sectors
        ? track(
            createBuffer(
              device,
              new Uint8Array(buildSeedPaletteGrid(width, height, seeds).buffer),
              storageUsage
            )
          )
        : null;
      const resolveOriginRead = sectors
        ? track(device.createBuffer({ size: pairBytes, usage: storageUsage }))
        : null;
      const resolveOriginWrite = sectors
        ? track(device.createBuffer({ size: pairBytes, usage: storageUsage }))
        : null;

      const validateUniformBuffer = validateOriginPaths
        ? track(
            createBuffer(
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
          )
        : null;
      const countersBuffer = validateOriginPaths
        ? track(createBuffer(device, new Uint8Array(emptyCountersBuffer()), storageUsage))
        : null;
      const pathMaxLdBuffer = validateOriginPaths
        ? track(createBuffer(device, new Float32Array(count), storageUsage))
        : null;
      const countersReadBuffer = validateOriginPaths
        ? track(
            device.createBuffer({
              size: 28,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
          )
        : null;

      const wgX = Math.ceil(width / 8);
      const wgY = Math.ceil(height / 8);
      const t0 = performance.now();
      let actualIterations = 0;
      let stopReason = "converged";
      const CONVERGENCE_CHECK_EVERY = 300;

      const colorUniform = track(createBuffer(device, new Uint8Array(uniformParams), uniformUsage));
      const { pipeline: colorPipeline, layout: colorLayout } = pickColorPipeline(
        pipelines,
        { raw, sectors }
      );
      const readBuffer = track(
        device.createBuffer({
          size: count * 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
      );
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

      const maybeEmitProgress = async () => {
        if (!livePreview) {
          return;
        }
        const now = performance.now();
        if (now - lastMapUpdate < updateMapMs) {
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

      const altReadBuffer = track(
        device.createBuffer({
          size: count * 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
      );
      const altCopyEncoder = device.createCommandEncoder();
      altCopyEncoder.copyBufferToBuffer(altRead, 0, altReadBuffer, 0, count * 4);
      device.queue.submit([altCopyEncoder.finish()]);
      await altReadBuffer.mapAsync(GPUMapMode.READ);
      const altitudes = new Float32Array(altReadBuffer.getMappedRange().slice(0));
      altReadBuffer.unmap();

      const originBuffer = track(
        device.createBuffer({
          size: pairBytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
      );
      const originCopyEncoder = device.createCommandEncoder();
      originCopyEncoder.copyBufferToBuffer(originRead, 0, originBuffer, 0, pairBytes);
      device.queue.submit([originCopyEncoder.finish()]);
      await originBuffer.mapAsync(GPUMapMode.READ);
      const originPairsOut = new Int32Array(originBuffer.getMappedRange().slice(0));
      originBuffer.unmap();
      const { xArr: originXOut, yArr: originYOut } = unpackXY(originPairsOut);

      const flagsReadBuffer = track(
        device.createBuffer({
          size: count * 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
      );
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
    } finally {
      destroyGpuBuffers(gpuTemps);
    }
  }
}
