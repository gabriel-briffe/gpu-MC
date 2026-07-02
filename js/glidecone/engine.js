import {
  ORIGIN_SHADER,
  ALT_SHADER,
  GROUND_ORIGIN_SHADER,
  CHANGE_SHADER,
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
  packSeedPairs,
  createBuffer,
  packXY,
  unpackXY,
  createPipeline,
} from "./render.js";
import {
  packPeekParams,
  peekLogBufferSize,
  formatPeekLosTrace,
  resolvePeekLosIndices,
  isPeekLosInBounds,
  capturePeekLosIteration,
  createPeekCellReaders,
  peekCellGridIndex,
  diffPeekCellState,
  readPeekCellStateOnly,
} from "../debug/peek-los.js";
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
        "storage",
        "storage",
        "uniform",
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
      groundOrigin: await createPipeline(this.device, GROUND_ORIGIN_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "storage",
        "read-only-storage",
      ]),
      change: await createPipeline(this.device, CHANGE_SHADER, [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
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
      fullBresenham = false,
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
      originRunN = 0,
      raw: rawParam = true,
      contours: contoursParam = false,
      pathOnly: pathOnlyParam = false,
      sectors: sectorsParam = false,
      disableGroundOrigin: disableGroundOriginParam = false,
      peekLos = false,
      updateMapMs = 100,
    } = params;
    const raw = rawOverride !== undefined ? rawOverride : rawParam;
    const contours = contoursParam;
    const pathOnly = pathOnlyParam;
    const sectors = sectorsParam;
    const disableGroundOrigin = disableGroundOriginParam;
    const peekIndices = resolvePeekLosIndices(params, dem);
    const { peekLosI, peekLosJ, peekLosOi, peekLosOj } = peekIndices;
    const peekLosEnabled = peekLos && isPeekLosInBounds(peekIndices, dem);
    const needsRaster = imageOnly || raw || sectors || (!contours && !pathOnly);
    const useFullBresenham = fullBresenham || originRunN === 0;
    const losShortcut = useFullBresenham ? 0 : 1;
    const shaderOriginRunN = originRunN === 0 ? 1 : originRunN;
    const count = width * height;

    const alt = new Float32Array(count).fill(maxAltitude);
    const originX = new Int32Array(count).fill(-1);
    const originY = new Int32Array(count).fill(-1);
    const ground = new Uint32Array(count);

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
      if (homeAlt === maxAltitude || seedAlt < homeAlt) {
        homeAlt = seedAlt;
      }
    }

    const originPairs = packXY(originX, originY);
    const seedPairs = packSeedPairs(seeds);

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
      shaderOriginRunN,
      seeds.length
    );

    const uniformBuffer = createBuffer(device, new Uint8Array(uniformParams), uniformUsage);
    const elevBuffer = createBuffer(device, new Uint8Array(elevation.buffer), storageUsage);
    const seedBuffer = createBuffer(device, new Uint8Array(seedPairs.buffer), storageUsage);

    let altRead = createBuffer(device, new Uint8Array(alt.buffer), storageUsage);
    let altWrite = createBuffer(device, new Uint8Array(alt.buffer), storageUsage);
    let originRead = createBuffer(device, new Uint8Array(originPairs.buffer), storageUsage);
    let originWrite = createBuffer(device, new Uint8Array(originPairs.buffer), storageUsage);
    let groundRead = createBuffer(device, new Uint8Array(ground.buffer), storageUsage);
    let groundWrite = createBuffer(device, new Uint8Array(ground.buffer), storageUsage);
    const rgbaBuffer = createBuffer(device, new Uint8Array(count * 4), storageUsage);

    const pairBytes = count * 8;
    const originSnap = createBuffer(device, new Uint8Array(pairBytes), storageUsage);
    const groundSnap = createBuffer(device, new Uint8Array(count * 4), storageUsage);
    const altSnap = createBuffer(device, new Uint8Array(count * 4), storageUsage);
    const changeCountBuffer = createBuffer(device, new Uint32Array([0]), storageUsage);
    const changeReadBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const peekLogBytes = peekLogBufferSize();
    const peekParamsBuffer = createBuffer(
      device,
      new Uint8Array(
        packPeekParams({
          enabled: peekLosEnabled,
          peekI: peekLosEnabled ? Math.floor(peekLosI) : -1,
          peekJ: peekLosEnabled ? Math.floor(peekLosJ) : -1,
          peekOi: peekLosEnabled ? Math.floor(peekLosOi) : -1,
          peekOj: peekLosEnabled ? Math.floor(peekLosOj) : -1,
          groundClearance,
        })
      ),
      uniformUsage
    );
    const peekLogBuffer = createBuffer(
      device,
      new Uint8Array(peekLogBytes),
      storageUsage
    );
    const peekLogReadBuffer = device.createBuffer({
      size: peekLogBytes,
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
    const peekLosIterations = [];
    const peekCellChanges = [];
    const peekCellReaders = peekLosEnabled ? createPeekCellReaders(device) : null;
    const peekCellIdx = peekLosEnabled ? peekCellGridIndex(peekLosI, peekLosJ, width) : -1;
    let prevPeekCellState = null;
    if (peekLosEnabled) {
      prevPeekCellState = await readPeekCellStateOnly(
        device,
        originRead,
        altRead,
        peekCellIdx,
        peekCellReaders
      );
    }

    const frameArgs = {
      colorPipeline,
      colorLayout,
      colorUniform,
      altRead,
      originRead,
      groundRead,
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
      if (sectors) {
        colorOriginRead = resolveDeepOriginsGpu(device, pipelines, {
          uniformBuffer,
          originRead,
          groundRead,
          resolveRead: resolveOriginRead,
          resolveWrite: resolveOriginWrite,
          pairBytes,
          wgX,
          wgY,
        });
      }
      return renderColorFrame(
        device,
        { ...frameArgs, originRead: colorOriginRead },
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
      if (peekLosEnabled) {
        device.queue.writeBuffer(peekLogBuffer, 0, new Uint8Array(peekLogBytes));
      }
      const encoder = device.createCommandEncoder();

      encoder.copyBufferToBuffer(originRead, 0, originSnap, 0, pairBytes);
      encoder.copyBufferToBuffer(groundRead, 0, groundSnap, 0, count * 4);
      encoder.copyBufferToBuffer(altRead, 0, altSnap, 0, count * 4);

      const originBind = device.createBindGroup({
        layout: pipelines.origin.layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: elevBuffer } },
          { binding: 2, resource: { buffer: altRead } },
          { binding: 3, resource: { buffer: originRead } },
          { binding: 4, resource: { buffer: groundRead } },
          { binding: 5, resource: { buffer: originWrite } },
          { binding: 6, resource: { buffer: groundWrite } },
          { binding: 7, resource: { buffer: peekParamsBuffer } },
          { binding: 8, resource: { buffer: peekLogBuffer } },
        ],
      });
      const passOrigin = encoder.beginComputePass();
      passOrigin.setPipeline(pipelines.origin.pipeline);
      passOrigin.setBindGroup(0, originBind);
      passOrigin.dispatchWorkgroups(wgX, wgY);
      passOrigin.end();

      [originRead, originWrite] = [originWrite, originRead];
      [groundRead, groundWrite] = [groundWrite, groundRead];

      const altBind = device.createBindGroup({
        layout: pipelines.alt.layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: elevBuffer } },
          { binding: 2, resource: { buffer: originRead } },
          { binding: 3, resource: { buffer: altRead } },
          { binding: 4, resource: { buffer: groundRead } },
          { binding: 5, resource: { buffer: altWrite } },
        ],
      });
      const passAlt = encoder.beginComputePass();
      passAlt.setPipeline(pipelines.alt.pipeline);
      passAlt.setBindGroup(0, altBind);
      passAlt.dispatchWorkgroups(wgX, wgY);
      passAlt.end();

      [altRead, altWrite] = [altWrite, altRead];

      device.queue.writeBuffer(changeCountBuffer, 0, new Uint32Array([0]));

      const changeBind = device.createBindGroup({
        layout: pipelines.change.layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: originRead } },
          { binding: 2, resource: { buffer: originSnap } },
          { binding: 3, resource: { buffer: groundRead } },
          { binding: 4, resource: { buffer: groundSnap } },
          { binding: 5, resource: { buffer: altRead } },
          { binding: 6, resource: { buffer: altSnap } },
          { binding: 7, resource: { buffer: changeCountBuffer } },
        ],
      });
      const passChange = encoder.beginComputePass();
      passChange.setPipeline(pipelines.change.pipeline);
      passChange.setBindGroup(0, changeBind);
      passChange.dispatchWorkgroups(wgX, wgY);
      passChange.end();

      encoder.copyBufferToBuffer(changeCountBuffer, 0, changeReadBuffer, 0, 4);
      device.queue.submit([encoder.finish()]);

      await changeReadBuffer.mapAsync(GPUMapMode.READ);
      const changes = new Uint32Array(changeReadBuffer.getMappedRange().slice(0))[0];
      changeReadBuffer.unmap();

      if (peekLosEnabled) {
        const snap = await capturePeekLosIteration(device, actualIterations, {
          peekLogBuffer,
          peekLogReadBuffer,
          peekLogBytes,
          originRead,
          altRead,
          cellIdx: peekCellIdx,
          cellReaders: peekCellReaders,
          prevCellState: prevPeekCellState,
          i: Math.floor(peekLosI),
          j: Math.floor(peekLosJ),
        });
        peekCellChanges.push(...snap.cellChanges);
        prevPeekCellState = snap.cellState;
        peekLosIterations.push(snap);
      }

      if (changes === 0) {
        break;
      }

      if (shouldStop?.()) {
        stopReason = "stopped";
        break;
      }

      await maybeEmitProgress();
    }

    if (!raw && !disableGroundOrigin) {
      const groundOriginBind = device.createBindGroup({
        layout: pipelines.groundOrigin.layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: altRead } },
          { binding: 2, resource: { buffer: groundRead } },
          { binding: 3, resource: { buffer: originRead } },
          { binding: 4, resource: { buffer: seedBuffer } },
        ],
      });
      const groundOriginEncoder = device.createCommandEncoder();
      const passGroundOrigin = groundOriginEncoder.beginComputePass();
      passGroundOrigin.setPipeline(pipelines.groundOrigin.pipeline);
      passGroundOrigin.setBindGroup(0, groundOriginBind);
      passGroundOrigin.dispatchWorkgroups(wgX, wgY);
      passGroundOrigin.end();
      device.queue.submit([groundOriginEncoder.finish()]);

      if (peekLosEnabled) {
        const cellState = await readPeekCellStateOnly(
          device,
          originRead,
          altRead,
          peekCellIdx,
          peekCellReaders
        );
        const groundChanges = diffPeekCellState(
          actualIterations,
          Math.floor(peekLosI),
          Math.floor(peekLosJ),
          prevPeekCellState,
          cellState
        ).map((change) => ({ ...change, phase: "ground_origin" }));
        peekCellChanges.push(...groundChanges);
        prevPeekCellState = cellState;
      }
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

    let peekLosTrace = null;
    if (peekLosEnabled) {
      const lastCells = peekLosIterations.at(-1)?.cells ?? [];
      peekLosTrace = formatPeekLosTrace({
        from: { i: Math.floor(peekLosI), j: Math.floor(peekLosJ) },
        to: { oi: Math.floor(peekLosOi), oj: Math.floor(peekLosOj) },
        cells: lastCells,
        iterations: peekLosIterations,
        cellChanges: peekCellChanges,
      });
    }

    return {
      ...baseResult,
      altitudes,
      originX: originXOut,
      originY: originYOut,
      ground: groundOut,
      peekLosTrace,
    };
  }
}
