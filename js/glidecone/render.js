import { SECTOR_ORIGIN_RESOLVE_PASSES } from "./shaders.js";

export function pickColorPipeline(pipelines, overlayColor, { raw = false, sectors = false } = {}) {
  if (overlayColor === "red") {
    return { pipeline: pipelines.colorRed.pipeline, layout: pipelines.colorRed.layout };
  }
  if (raw) {
    return { pipeline: pipelines.colorRaw.pipeline, layout: pipelines.colorRaw.layout };
  }
  if (sectors) {
    return { pipeline: pipelines.colorSectors.pipeline, layout: pipelines.colorSectors.layout };
  }
  return { pipeline: pipelines.color.pipeline, layout: pipelines.color.layout };
}

export function packedRgbaToImageData(packed, width, height) {
  const imageData = new ImageData(width, height);
  for (let i = 0; i < packed.length; i += 1) {
    const p = packed[i];
    const dst = i * 4;
    imageData.data[dst] = p & 255;
    imageData.data[dst + 1] = (p >> 8) & 255;
    imageData.data[dst + 2] = (p >> 16) & 255;
    imageData.data[dst + 3] = (p >> 24) & 255;
  }
  return imageData;
}

export async function renderColorFrame(
  device,
  {
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
  },
  { sectors = false } = {}
) {
  const entries = [
    { binding: 0, resource: { buffer: colorUniform } },
    { binding: 1, resource: { buffer: altRead } },
    { binding: 2, resource: { buffer: originRead } },
    { binding: 3, resource: { buffer: groundRead } },
    { binding: 4, resource: { buffer: rgbaBuffer } },
  ];
  if (sectors) {
    entries.push({ binding: 5, resource: { buffer: seedPaletteBuffer } });
  }

  const colorBind = device.createBindGroup({
    layout: colorLayout,
    entries,
  });

  const colorEncoder = device.createCommandEncoder();
  const colorPass = colorEncoder.beginComputePass();
  colorPass.setPipeline(colorPipeline);
  colorPass.setBindGroup(0, colorBind);
  colorPass.dispatchWorkgroups(wgX, wgY);
  colorPass.end();

  const copyEncoder = device.createCommandEncoder();
  copyEncoder.copyBufferToBuffer(rgbaBuffer, 0, readBuffer, 0, count * 4);
  device.queue.submit([colorEncoder.finish(), copyEncoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const packed = new Uint32Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  return packedRgbaToImageData(packed, width, height);
}

export async function renderModifiedCellsFrame(
  device,
  { modifiedPipeline, modifiedLayout, sumUniformBuffer, flagsRead, rgbaBuffer, readBuffer, wgX, wgY, width, height, count }
) {
  const bind = device.createBindGroup({
    layout: modifiedLayout,
    entries: [
      { binding: 0, resource: { buffer: sumUniformBuffer } },
      { binding: 1, resource: { buffer: flagsRead } },
      { binding: 2, resource: { buffer: rgbaBuffer } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(modifiedPipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(wgX, wgY);
  pass.end();

  const copyEncoder = device.createCommandEncoder();
  copyEncoder.copyBufferToBuffer(rgbaBuffer, 0, readBuffer, 0, count * 4);
  device.queue.submit([encoder.finish(), copyEncoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const packed = new Uint32Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  return packedRgbaToImageData(packed, width, height);
}

export function resolveDeepOriginsGpu(
  device,
  pipelines,
  {
    uniformBuffer,
    originRead,
    groundRead,
    resolveRead,
    resolveWrite,
    pairBytes,
    wgX,
    wgY,
  }
) {
  const copyEncoder = device.createCommandEncoder();
  copyEncoder.copyBufferToBuffer(originRead, 0, resolveRead, 0, pairBytes);
  device.queue.submit([copyEncoder.finish()]);

  let readBuf = resolveRead;
  let writeBuf = resolveWrite;

  for (let pass = 0; pass < SECTOR_ORIGIN_RESOLVE_PASSES; pass += 1) {
    const bind = device.createBindGroup({
      layout: pipelines.resolveOrigin.layout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: readBuf } },
        { binding: 2, resource: { buffer: groundRead } },
        { binding: 3, resource: { buffer: writeBuf } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const passEnc = encoder.beginComputePass();
    passEnc.setPipeline(pipelines.resolveOrigin.pipeline);
    passEnc.setBindGroup(0, bind);
    passEnc.dispatchWorkgroups(wgX, wgY);
    passEnc.end();
    device.queue.submit([encoder.finish()]);
    [readBuf, writeBuf] = [writeBuf, readBuf];
  }

  return readBuf;
}

export function packParams(
  width,
  height,
  homeX,
  homeY,
  cellSizeM,
  glideRatio,
  maxAlt,
  homeAlt = 0,
  losShortcut = 1,
  originRunN = 0,
  seedCount = 1
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
  view.setUint32(40, seedCount, true);
  return buf;
}

export function packSeedPairs(seeds) {
  const pairs = new Int32Array(seeds.length * 2);
  for (let i = 0; i < seeds.length; i += 1) {
    pairs[i * 2] = seeds[i].x;
    pairs[i * 2 + 1] = seeds[i].y;
  }
  return pairs;
}

export function createBuffer(device, bytes, usage) {
  const buffer = device.createBuffer({
    size: Math.max(bytes.byteLength, 4),
    usage,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange()).set(bytes);
  buffer.unmap();
  return buffer;
}

export function packXY(xArr, yArr) {
  const pairs = new Int32Array(xArr.length * 2);
  for (let i = 0; i < xArr.length; i += 1) {
    pairs[i * 2] = xArr[i];
    pairs[i * 2 + 1] = yArr[i];
  }
  return pairs;
}

export function unpackXY(pairs) {
  const count = pairs.length / 2;
  const xArr = new Int32Array(count);
  const yArr = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    xArr[i] = pairs[i * 2];
    yArr[i] = pairs[i * 2 + 1];
  }
  return { xArr, yArr };
}

export async function createPipeline(device, code, bindings) {
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
