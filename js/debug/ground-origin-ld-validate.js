const COUNTERS_BYTE_LENGTH = 16;

export function emptyGroundOriginLdCountersBuffer() {
  const buf = new ArrayBuffer(COUNTERS_BYTE_LENGTH);
  const view = new DataView(buf);
  view.setInt32(8, -1, true);
  view.setInt32(12, -1, true);
  return buf;
}

export function packGroundOriginLdParams(width, height, maxAlt, seedCount, cellSizeM) {
  const buf = new ArrayBuffer(24);
  const view = new DataView(buf);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setFloat32(8, maxAlt, true);
  view.setUint32(12, seedCount, true);
  view.setFloat32(16, cellSizeM, true);
  return buf;
}

function formatGroundOriginMaxLd(maxSegmentLd, maxLdCellI, maxLdCellJ) {
  if (!Number.isFinite(maxSegmentLd) || maxSegmentLd <= 0) {
    return "no descending ground-origin segments";
  }
  const hasCell =
    Number.isInteger(maxLdCellI) &&
    Number.isInteger(maxLdCellJ) &&
    maxLdCellI >= 0 &&
    maxLdCellJ >= 0;
  const cellNote = hasCell ? ` at i=${maxLdCellI}, j=${maxLdCellJ}` : "";
  return `ground-origin max segment L/D: ${maxSegmentLd.toFixed(2)}${cellNote}`;
}

export function logGroundOriginLdValidation(result) {
  const stats = result?.groundOriginLdValidation;
  if (!stats) {
    return;
  }
  const ldNote = formatGroundOriginMaxLd(stats.maxSegmentLd, stats.maxLdCellI, stats.maxLdCellJ);
  console.info(`${ldNote} (${stats.checked} ground cells)`);
}

export async function runGroundOriginLdValidation(
  device,
  { pipeline, layout },
  {
    uniformBuffer,
    altRead,
    flagsRead,
    seedBuffer,
    countersBuffer,
    countersReadBuffer,
    wgX,
    wgY,
  }
) {
  device.queue.writeBuffer(countersBuffer, 0, emptyGroundOriginLdCountersBuffer());

  const bind = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: altRead } },
      { binding: 2, resource: { buffer: flagsRead } },
      { binding: 3, resource: { buffer: seedBuffer } },
      { binding: 4, resource: { buffer: countersBuffer } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(wgX, wgY);
  pass.end();
  encoder.copyBufferToBuffer(countersBuffer, 0, countersReadBuffer, 0, COUNTERS_BYTE_LENGTH);
  device.queue.submit([encoder.finish()]);

  await countersReadBuffer.mapAsync(GPUMapMode.READ);
  const bytes = countersReadBuffer.getMappedRange().slice(0);
  countersReadBuffer.unmap();
  const view = new DataView(bytes);

  return {
    checked: view.getUint32(0, true),
    maxSegmentLd: view.getFloat32(4, true),
    maxLdCellI: view.getInt32(8, true),
    maxLdCellJ: view.getInt32(12, true),
  };
}
