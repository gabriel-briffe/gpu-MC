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

function formatMaxSegmentLd(maxSegmentLd) {
  if (!Number.isFinite(maxSegmentLd) || maxSegmentLd <= 0) {
    return "no descending path segments";
  }
  return `max segment L/D: ${maxSegmentLd.toFixed(2)}`;
}

export function logOriginPathValidation(result) {
  const stats = result?.originPathValidation;
  if (!stats) {
    return;
  }
  const ldNote = formatMaxSegmentLd(stats.maxSegmentLd);
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
  device.queue.writeBuffer(countersBuffer, 0, new Uint32Array([0, 0, 0, 0, 0]));

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
  encoder.copyBufferToBuffer(countersBuffer, 0, countersReadBuffer, 0, 20);
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
  };
}
