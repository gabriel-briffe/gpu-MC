const COUNTERS_BYTE_LENGTH = 28;

export function emptyCountersBuffer() {
  const buf = new ArrayBuffer(COUNTERS_BYTE_LENGTH);
  const view = new DataView(buf);
  view.setInt32(20, -1, true);
  view.setInt32(24, -1, true);
  return buf;
}

export function packOriginPathValidateParams(
  width,
  height,
  maxAlt,
  seedCount,
  maxSteps,
  cellSizeM
) {
  const buf = new ArrayBuffer(24);
  const view = new DataView(buf);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setFloat32(8, maxAlt, true);
  view.setUint32(12, seedCount, true);
  view.setUint32(16, maxSteps, true);
  view.setFloat32(20, cellSizeM, true);
  return buf;
}

function formatMaxSegmentLd(maxSegmentLd, maxLdCellI, maxLdCellJ) {
  if (!Number.isFinite(maxSegmentLd) || maxSegmentLd <= 0) {
    return "no descending path segments";
  }
  const hasCell =
    Number.isInteger(maxLdCellI) &&
    Number.isInteger(maxLdCellJ) &&
    maxLdCellI >= 0 &&
    maxLdCellJ >= 0;
  const cellNote = hasCell ? ` at i=${maxLdCellI}, j=${maxLdCellJ}` : "";
  return `max segment L/D: ${maxSegmentLd.toFixed(2)}${cellNote}`;
}

export function logOriginPathValidation(result) {
  const stats = result?.originPathValidation;
  if (!stats) {
    return;
  }
  const ldNote = formatMaxSegmentLd(stats.maxSegmentLd, stats.maxLdCellI, stats.maxLdCellJ);
  const failed = stats.invalid + stats.stoppedAtMaxSteps;
  if (failed === 0) {
    console.info(`all path lead back to an airport (${ldNote})`);
    return;
  }
  const parts = [];
  if (stats.stoppedAtMaxSteps > 0) {
    const noun = stats.stoppedAtMaxSteps === 1 ? "path stopped" : "paths stopped";
    parts.push(`${stats.stoppedAtMaxSteps} ${noun} at max steps`);
  }
  if (stats.invalid > 0) {
    const noun = stats.invalid === 1 ? "path has" : "paths have";
    parts.push(`${stats.invalid} ${noun} a broken origin chain`);
  }
  const noun = failed === 1 ? "path doesn't" : "paths don't";
  console.info(
    `${failed} ${noun} lead to an airport: ${parts.join(", ")} (${stats.checked} checked, ${ldNote})`
  );
}

export async function runOriginPathValidation(
  device,
  { pipeline, layout },
  {
    validateUniformBuffer,
    altRead,
    originRead,
    seedBuffer,
    countersBuffer,
    pathMaxLdBuffer,
    countersReadBuffer,
    wgX,
    wgY,
  }
) {
  device.queue.writeBuffer(countersBuffer, 0, emptyCountersBuffer());

  const bind = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: validateUniformBuffer } },
      { binding: 1, resource: { buffer: altRead } },
      { binding: 2, resource: { buffer: originRead } },
      { binding: 3, resource: { buffer: seedBuffer } },
      { binding: 4, resource: { buffer: countersBuffer } },
      { binding: 5, resource: { buffer: pathMaxLdBuffer } },
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
    valid: view.getUint32(4, true),
    invalid: view.getUint32(8, true),
    stoppedAtMaxSteps: view.getUint32(12, true),
    maxSegmentLd: view.getFloat32(16, true),
    maxLdCellI: view.getInt32(20, true),
    maxLdCellJ: view.getInt32(24, true),
  };
}
