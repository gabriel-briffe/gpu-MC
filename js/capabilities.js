import { assetUrl } from "./asset-url.js";
import initGrib from "./iconch1/pkg/gribinfo.js";
import { ensureRegridWasm } from "./iconch1/regrid.js";

/** @type {boolean|null} null until probed */
let webGpuSupported = null;
/** @type {boolean|null} null until probed */
let wasmSupported = null;

/** WebGPU available for GPU cone/options (CPU path works without it). */
export function isWebGpuSupported() {
  return webGpuSupported !== false;
}

/** WASM available for IconCH grib/regrid. */
export function isWasmSupported() {
  return wasmSupported !== false;
}

export function getWebGpuSupported() {
  return webGpuSupported;
}

export function getWasmSupported() {
  return wasmSupported;
}

export function markWebGpuUnsupported() {
  webGpuSupported = false;
}

export function markWasmUnsupported() {
  wasmSupported = false;
}

async function probeWebGpu() {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    return false;
  }
  let device = null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return false;
    }
    device = await adapter.requestDevice();
    return Boolean(device);
  } catch {
    return false;
  } finally {
    try {
      device?.destroy?.();
    } catch {
      // ignore
    }
  }
}

async function probeWasm() {
  if (typeof WebAssembly === "undefined") {
    return false;
  }
  try {
    await initGrib({
      module_or_path: assetUrl("vendor/gribinfo/gribinfo_bg.wasm"),
    });
    await ensureRegridWasm();
    return true;
  } catch (error) {
    console.warn("WASM capability probe failed", error);
    return false;
  }
}

/** Probe WebGPU and WASM independently. */
export async function probeComputeHardware() {
  const [webgpu, wasm] = await Promise.all([probeWebGpu(), probeWasm()]);
  webGpuSupported = webgpu;
  wasmSupported = wasm;
  return { webgpu, wasm };
}
