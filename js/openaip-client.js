const TILES_DIRECT = "https://api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.pbf";
const CORE_AIRSPACES_DIRECT = "https://api.core.openaip.net/api/airspaces";

export const DEFAULT_OPENAIP_PROXY_BASE = "https://openaip-proxy.gabriel-briffe.workers.dev";

/** When true, all OpenAIP traffic uses the Cloudflare worker proxy. */
export const USE_OPENAIP_PROXY = true;

export function normalizeOpenAipConfig(config) {
  if (typeof config === "string") {
    return {
      apiKey: config,
      proxyBase: DEFAULT_OPENAIP_PROXY_BASE,
      useProxy: USE_OPENAIP_PROXY,
    };
  }
  return {
    apiKey: config?.apiKey ?? config?.OPENAIP_API_KEY ?? "",
    proxyBase:
      config?.proxyBase ?? config?.OPENAIP_PROXY_BASE ?? DEFAULT_OPENAIP_PROXY_BASE,
    useProxy: config?.USE_OPENAIP_PROXY ?? USE_OPENAIP_PROXY,
  };
}

function resolveOpenAipConfig(config) {
  const { apiKey, proxyBase, useProxy } = normalizeOpenAipConfig(config);
  const base = (proxyBase || DEFAULT_OPENAIP_PROXY_BASE).replace(/\/$/, "");

  if (useProxy) {
    return { apiKey: "", proxyBase: base, useProxy: true };
  }

  return { apiKey, proxyBase: "", useProxy: false };
}

/** OpenAIP Core API accepts comma-separated integer codes for array `type` query params. */
export function setOpenAipTypeFilter(query, types) {
  const codes = [...types].map(String);
  if (codes.length) {
    query.set("type", codes.join(","));
  }
}

export function openAipConfigured(config) {
  const resolved = resolveOpenAipConfig(config);
  if (resolved.useProxy) {
    return Boolean(resolved.proxyBase);
  }
  return Boolean(resolved.apiKey);
}

export function openAipTileUrls(config) {
  const { apiKey, proxyBase, useProxy } = resolveOpenAipConfig(config);

  if (useProxy) {
    return [`${proxyBase}/tiles/{z}/{x}/{y}.pbf`];
  }

  if (apiKey) {
    return [`${TILES_DIRECT}?apiKey=${encodeURIComponent(apiKey)}`];
  }

  return [];
}

export function openAipAirspacesUrl(config, searchParams) {
  const { apiKey, proxyBase, useProxy } = resolveOpenAipConfig(config);
  const query = new URLSearchParams(searchParams);

  if (useProxy) {
    query.delete("apiKey");
    return `${proxyBase}/core/airspaces?${query}`;
  }

  if (apiKey) {
    query.set("apiKey", apiKey);
    return `${CORE_AIRSPACES_DIRECT}?${query}`;
  }

  return null;
}

const CORE_AIRPORTS_DIRECT = "https://api.core.openaip.net/api/airports";

export function openAipAirportsUrl(config, searchParams) {
  const { apiKey, proxyBase, useProxy } = resolveOpenAipConfig(config);
  const query = new URLSearchParams(searchParams);

  if (useProxy) {
    query.delete("apiKey");
    return `${proxyBase}/core/airports?${query}`;
  }

  if (apiKey) {
    query.set("apiKey", apiKey);
    return `${CORE_AIRPORTS_DIRECT}?${query}`;
  }

  return null;
}

export async function loadOpenAipConfig() {
  try {
    return await import("./openaip-config.js");
  } catch {
    return await import("./openaip-config.public.js");
  }
}
