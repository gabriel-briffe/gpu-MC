import { assetUrl } from "./asset-url.js";
import initGrib from "./iconch1/pkg/gribinfo.js";
import { ensureRegridWasm } from "./iconch1/regrid.js";

export const COMPUTE_HARDWARE_UNAVAILABLE_MESSAGE =
  "Your device doesn't have the necessary hardware to compute glide cones and iconCH wave forecasts";

/** @type {boolean|null} null until probed */
let computeHardwareSupported = null;

export function isComputeHardwareSupported() {
  return computeHardwareSupported !== false;
}

export function getComputeHardwareSupported() {
  return computeHardwareSupported;
}

export function markComputeHardwareUnsupported() {
  computeHardwareSupported = false;
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

/**
 * Probe WebGPU (adapter + device) and both WASM modules.
 * If either fails, compute features should stay disabled.
 */
export async function probeComputeHardware() {
  const [webgpu, wasm] = await Promise.all([probeWebGpu(), probeWasm()]);
  computeHardwareSupported = webgpu && wasm;
  return {
    supported: computeHardwareSupported,
    webgpu,
    wasm,
  };
}
