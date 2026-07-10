export const GRIB_PROXY_BASE = "https://icon.gabriel-briffe.workers.dev";

let bunzipModuleReady = null;

export function proxyUrl(targetUrl) {
  const proxy = new URL(GRIB_PROXY_BASE);
  proxy.searchParams.set("url", targetUrl);
  return proxy.toString();
}

export function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error?.message) {
    return String(error.message);
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function classifyBytes(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x52 && bytes[2] === 0x49 && bytes[3] === 0x42) {
    return "raw GRIB";
  }
  if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    return "bzip2";
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return "gzip";
  }
  if (bytes.length >= 1 && bytes[0] === 0x3c) {
    return "likely HTML/XML";
  }
  return "unknown";
}

export function isBzip2(bytes) {
  return bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68;
}

async function decompressBzip2(bytes) {
  if (!bunzipModuleReady) {
    bunzipModuleReady = import("https://cdn.jsdelivr.net/npm/seek-bzip@1.0.6/+esm");
  }
  const mod = await bunzipModuleReady;
  const decompressed = mod.default.decode(bytes);
  return decompressed instanceof Uint8Array ? decompressed : new Uint8Array(decompressed);
}

export async function readProxiedFile(url) {
  const response = await fetch(proxyUrl(url));
  const contentType = response.headers.get("content-type") ?? "";
  const contentLength = response.headers.get("content-length") ?? "unknown";

  if (!response.ok) {
    if (contentType.includes("application/json")) {
      const body = await response.json();
      throw new Error(body.error ?? body.detail ?? JSON.stringify(body));
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  if (contentType.includes("application/json")) {
    const body = await response.json();
    throw new Error(body.error ?? body.detail ?? JSON.stringify(body));
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) {
    throw new Error("Proxy returned an empty response body");
  }

  const kind = classifyBytes(bytes);
  if (kind === "likely HTML/XML") {
    throw new Error(
      `Proxy returned HTML instead of GRIB data (content-type: ${contentType || "unknown"}, content-length: ${contentLength})`
    );
  }

  return buffer;
}

export function toRawGribBytes(buffer) {
  const inputBytes = new Uint8Array(buffer);
  return isBzip2(inputBytes) ? decompressBzip2(inputBytes) : Promise.resolve(inputBytes);
}
