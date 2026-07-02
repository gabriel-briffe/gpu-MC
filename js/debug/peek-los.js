import { gridCellToLngLat, gridIndexFromLngLat } from "../geo.js";

export const MAX_PEEK_LOS_ENTRIES = 1024;
const PEEK_ENTRY_STRIDE = 24;

let peekLosGeoAnchor = null;

export function setPeekLosGeoAnchor(anchor) {
  peekLosGeoAnchor = anchor;
}

export function getPeekLosGeoAnchor() {
  return peekLosGeoAnchor;
}

export function clearPeekLosGeoAnchor() {
  peekLosGeoAnchor = null;
}

export function buildPeekLosGeoAnchor(cell, dem) {
  if (!cell || !dem) {
    return null;
  }
  const { lng: cellLng, lat: cellLat } = gridCellToLngLat(cell.gi, cell.gj, dem);
  if (cell.originGi == null || cell.originGj == null) {
    return { cellLng, cellLat, originLng: null, originLat: null };
  }
  const { lng: originLng, lat: originLat } = gridCellToLngLat(
    cell.originGi,
    cell.originGj,
    dem
  );
  return { cellLng, cellLat, originLng, originLat };
}

export function resolvePeekLosIndices(params, dem) {
  let peekLosI = params.peekLosI;
  let peekLosJ = params.peekLosJ;
  let peekLosOi = params.peekLosOi;
  let peekLosOj = params.peekLosOj;
  const anchor = params.peekLosGeoAnchor ?? peekLosGeoAnchor;
  if (params.peekLos && anchor?.cellLng != null && anchor?.cellLat != null && dem) {
    const cell = gridIndexFromLngLat(anchor.cellLng, anchor.cellLat, dem);
    peekLosI = cell.gi;
    peekLosJ = cell.gj;
    if (anchor.originLng != null && anchor.originLat != null) {
      const origin = gridIndexFromLngLat(anchor.originLng, anchor.originLat, dem);
      peekLosOi = origin.gi;
      peekLosOj = origin.gj;
    }
  }
  return { peekLosI, peekLosJ, peekLosOi, peekLosOj };
}

export function isPeekLosInBounds(indices, dem) {
  const { peekLosI, peekLosJ, peekLosOi, peekLosOj } = indices;
  return (
    Number.isFinite(peekLosI) &&
    Number.isFinite(peekLosJ) &&
    Number.isFinite(peekLosOi) &&
    Number.isFinite(peekLosOj) &&
    peekLosI >= 0 &&
    peekLosJ >= 0 &&
    peekLosOi >= 0 &&
    peekLosOj >= 0 &&
    peekLosI < dem.width &&
    peekLosJ < dem.height &&
    peekLosOi < dem.width &&
    peekLosOj < dem.height
  );
}

export function syncPeekLosFormFields({ peekLosI, peekLosJ, peekLosOi, peekLosOj }, dom) {
  if (dom.peekLosIInput) {
    dom.peekLosIInput.value = String(peekLosI);
  }
  if (dom.peekLosJInput) {
    dom.peekLosJInput.value = String(peekLosJ);
  }
  if (dom.peekLosOiInput) {
    dom.peekLosOiInput.value = String(peekLosOi);
  }
  if (dom.peekLosOjInput) {
    dom.peekLosOjInput.value = String(peekLosOj);
  }
}

export function packPeekParams({ enabled, peekI, peekJ, peekOi, peekOj, groundClearance }) {
  const buf = new ArrayBuffer(32);
  const view = new DataView(buf);
  view.setUint32(0, enabled ? 1 : 0, true);
  view.setInt32(4, peekI, true);
  view.setInt32(8, peekJ, true);
  view.setInt32(12, peekOi, true);
  view.setInt32(16, peekOj, true);
  view.setFloat32(20, groundClearance, true);
  return buf;
}

export function peekLogBufferSize() {
  return 4 + MAX_PEEK_LOS_ENTRIES * PEEK_ENTRY_STRIDE;
}

export function readPeekLosLog(buffer) {
  const view = new DataView(buffer);
  const count = Math.min(view.getUint32(0, true), MAX_PEEK_LOS_ENTRIES);
  const visits = [];
  for (let n = 0; n < count; n += 1) {
    const base = 4 + n * PEEK_ENTRY_STRIDE;
    visits.push({
      i: view.getInt32(base, true),
      j: view.getInt32(base + 4, true),
      ground: view.getUint32(base + 8, true) === 1,
      alt: view.getFloat32(base + 16, true),
      groundElev: view.getFloat32(base + 20, true),
    });
  }
  return visits;
}

export const PEEK_CELL_ALT_EPSILON = 0.001;

export function formatPeekLosTrace({ from, to, cells, iterations = null, cellChanges = null }) {
  return { from, to, cells, iterations, cellChanges };
}

export function createPeekCellReaders(device) {
  return {
    originRead: device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
    altRead: device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
  };
}

export function peekCellGridIndex(i, j, width) {
  return j * width + i;
}

async function readPeekCellState(device, originBuffer, altBuffer, cellIdx, readers) {
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(originBuffer, cellIdx * 8, readers.originRead, 0, 8);
  encoder.copyBufferToBuffer(altBuffer, cellIdx * 4, readers.altRead, 0, 4);
  device.queue.submit([encoder.finish()]);
  await Promise.all([
    readers.originRead.mapAsync(GPUMapMode.READ),
    readers.altRead.mapAsync(GPUMapMode.READ),
  ]);
  const originPairs = new Int32Array(readers.originRead.getMappedRange().slice(0));
  readers.originRead.unmap();
  const altView = new Float32Array(readers.altRead.getMappedRange().slice(0));
  readers.altRead.unmap();
  return { oi: originPairs[0], oj: originPairs[1], alt: altView[0] };
}

export function diffPeekCellState(iteration, i, j, prev, next) {
  if (!prev || !next) {
    return [];
  }
  const changes = [];
  if (prev.oi !== next.oi || prev.oj !== next.oj) {
    changes.push({
      iteration,
      kind: "origin",
      i,
      j,
      oi: next.oi,
      oj: next.oj,
      prevOi: prev.oi,
      prevOj: prev.oj,
    });
  }
  if (Math.abs(prev.alt - next.alt) > PEEK_CELL_ALT_EPSILON) {
    changes.push({
      iteration,
      kind: "altitude",
      i,
      j,
      alt: next.alt,
      prevAlt: prev.alt,
    });
  }
  return changes;
}

function formatPeekCellChange(change) {
  if (change.kind === "origin") {
    const iterNote = change.phase ? ` (${change.phase})` : change.iteration ? ` (iter ${change.iteration})` : "";
    return `origin of ${change.i}, ${change.j} changed to ${change.oi}, ${change.oj}${iterNote}`;
  }
  const iterNote = change.phase ? ` (${change.phase})` : change.iteration ? ` (iter ${change.iteration})` : "";
  const alt = Number.isFinite(change.alt) ? change.alt.toFixed(1) : String(change.alt);
  return `cell ${change.i}, ${change.j} altitude changed to ${alt}${iterNote}`;
}

export function logPeekCellChanges(changes) {
  for (const change of changes ?? []) {
    console.info(formatPeekCellChange(change));
  }
}

async function readPeekLosBuffer(device, peekLogBuffer, peekLogReadBuffer, peekLogBytes) {
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(peekLogBuffer, 0, peekLogReadBuffer, 0, peekLogBytes);
  device.queue.submit([encoder.finish()]);
  await peekLogReadBuffer.mapAsync(GPUMapMode.READ);
  const cells = readPeekLosLog(peekLogReadBuffer.getMappedRange().slice(0));
  peekLogReadBuffer.unmap();
  return cells;
}

export async function capturePeekLosIteration(
  device,
  iteration,
  {
    peekLogBuffer,
    peekLogReadBuffer,
    peekLogBytes,
    originRead,
    altRead,
    cellIdx,
    cellReaders,
    prevCellState,
    i,
    j,
  }
) {
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(peekLogBuffer, 0, peekLogReadBuffer, 0, peekLogBytes);
  if (cellReaders && originRead && altRead && Number.isFinite(cellIdx)) {
    encoder.copyBufferToBuffer(originRead, cellIdx * 8, cellReaders.originRead, 0, 8);
    encoder.copyBufferToBuffer(altRead, cellIdx * 4, cellReaders.altRead, 0, 4);
  }
  device.queue.submit([encoder.finish()]);

  const maps = [peekLogReadBuffer.mapAsync(GPUMapMode.READ)];
  if (cellReaders) {
    maps.push(cellReaders.originRead.mapAsync(GPUMapMode.READ));
    maps.push(cellReaders.altRead.mapAsync(GPUMapMode.READ));
  }
  await Promise.all(maps);

  const cells = readPeekLosLog(peekLogReadBuffer.getMappedRange().slice(0));
  peekLogReadBuffer.unmap();

  let cellState = null;
  let cellChanges = [];
  if (cellReaders) {
    const originPairs = new Int32Array(cellReaders.originRead.getMappedRange().slice(0));
    cellReaders.originRead.unmap();
    const altView = new Float32Array(cellReaders.altRead.getMappedRange().slice(0));
    cellReaders.altRead.unmap();
    cellState = { oi: originPairs[0], oj: originPairs[1], alt: altView[0] };
    cellChanges = diffPeekCellState(iteration, i, j, prevCellState, cellState);
  }

  return { iteration, cells, cellState, cellChanges };
}

export async function readPeekCellStateOnly(device, originRead, altRead, cellIdx, cellReaders) {
  return readPeekCellState(device, originRead, altRead, cellIdx, cellReaders);
}

export function formatPeekLosSummary(trace) {
  const lastCells = trace?.iterations?.at(-1)?.cells ?? trace?.cells;
  if (!lastCells?.length) {
    return "Peek LOS: no visits recorded";
  }
  const truncated =
    lastCells.length >= MAX_PEEK_LOS_ENTRIES ? " (buffer full)" : "";
  const { i, j } = trace.from;
  const { oi, oj } = trace.to;
  const iterNote = trace.iterations?.length ? `, ${trace.iterations.length} iters logged` : "";
  const changeNote = trace.cellChanges?.length ? `, ${trace.cellChanges.length} cell updates` : "";
  return `Peek LOS (${i},${j})→(${oi},${oj}): ${lastCells.length} cells${truncated}${iterNote}${changeNote}`;
}

export function logPeekLosTrace(trace) {
  logPeekCellChanges(trace?.cellChanges);

  if (trace?.iterations?.length) {
    const { i, j } = trace.from;
    const { oi, oj } = trace.to;
    for (const snap of trace.iterations) {
      console.info(`Peek LOS iter ${snap.iteration} (${i},${j}) → (${oi},${oj})`);
      if (!snap.cells.length) {
        console.info("  (no visits recorded)");
        continue;
      }
      snap.cells.forEach((cell, index) => {
        console.info(`  ${index + 1}.`, cell);
      });
    }
    return;
  }

  if (!trace?.cells?.length) {
    console.info("Peek LOS: no visits recorded for this pair");
    return;
  }
  const { i, j } = trace.from;
  const { oi, oj } = trace.to;
  console.info(`Peek LOS (${i},${j}) → (${oi},${oj})`);
  trace.cells.forEach((cell, index) => {
    console.info(`  ${index + 1}.`, cell);
  });
}
