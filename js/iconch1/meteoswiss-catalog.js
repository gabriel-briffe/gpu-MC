export const METEOSWISS_STAC = "https://data.geo.admin.ch/api/stac/v1";

/** STAC catalog responses are reused for this long before refetching. */
export const METEOSWISS_CATALOG_CACHE_TTL_MS = 3 * 60 * 60 * 1000;

const METEOSWISS_CACHE_STORAGE_PREFIX = "meteoswiss-stac:";
const memoryCatalogCache = new Map();

export const METEOSWISS_RUN_HOURS = {
  "icon-ch1": ["00", "03", "06", "09", "12", "15", "18", "21"],
  "icon-ch2": ["00", "06", "12", "18"],
};

export const METEOSWISS_MAX_STEP_HOURS = {
  "icon-ch1": 33,
  "icon-ch2": 120,
};

export function isMeteoSwissModel(modelId) {
  return modelId === "icon-ch1" || modelId === "icon-ch2";
}

export function refDateStamp(referenceDatetime) {
  const date = new Date(referenceDatetime);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  return `${y}${m}${d}${h}`;
}

export function parseHorizonHours(horizon) {
  if (!horizon) return 0;
  const match =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/i.exec(horizon);
  if (!match) return 0;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  return days * 24 + hours;
}

export function horizonFromStepHours(hours) {
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return `P${days}DT${String(rem).padStart(2, "0")}H00M00S`;
}

export function formatHorizonStep(hours) {
  return `+${hours}h`;
}

export function generateRunCandidates(modelId, now = new Date()) {
  const runHours = (METEOSWISS_RUN_HOURS[modelId] ?? [])
    .map(Number)
    .sort((a, b) => a - b);
  const candidates = [];
  const seen = new Set();

  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const day = new Date(now);
    day.setUTCDate(day.getUTCDate() - dayOffset);
    day.setUTCMinutes(0, 0, 0);

    for (let i = runHours.length - 1; i >= 0; i -= 1) {
      const runTime = new Date(day);
      runTime.setUTCHours(runHours[i], 0, 0, 0);
      if (runTime.getTime() > now.getTime()) continue;

      const iso = runTime.toISOString().replace(".000Z", "Z");
      if (seen.has(iso)) continue;
      seen.add(iso);
      candidates.push({ iso, runTime });
    }
  }

  candidates.sort((a, b) => b.runTime.getTime() - a.runTime.getTime());
  return candidates;
}

export function itemCreatedIso(item) {
  if (!item) return null;
  const props = item.properties ?? {};
  const asset = Object.values(item.assets ?? {}).find((entry) => entry.roles?.includes("data"));
  return props.created ?? asset?.created ?? null;
}

/** Step 0 exists and was published on the same UTC day as the model run. */
export function isRunPublished(item, runTime, now = new Date()) {
  const createdIso = itemCreatedIso(item);
  if (!createdIso) return false;

  const created = new Date(createdIso);
  if (Number.isNaN(created.getTime())) return false;
  if (created.getTime() <= runTime.getTime()) return false;
  if (created.getTime() > now.getTime()) return false;

  return (
    created.getUTCFullYear() === runTime.getUTCFullYear() &&
    created.getUTCMonth() === runTime.getUTCMonth() &&
    created.getUTCDate() === runTime.getUTCDate()
  );
}

export function splitGribMessages(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const messages = [];
  let offset = 0;

  while (offset + 16 <= view.length) {
    if (view[offset] !== 0x47 || view[offset + 1] !== 0x52 || view[offset + 2] !== 0x49 || view[offset + 3] !== 0x42) {
      break;
    }
    const dataView = new DataView(view.buffer, view.byteOffset, view.byteLength);
    const length = Number(dataView.getBigUint64(offset + 8, false));
    if (length < 16 || offset + length > view.length) break;
    messages.push(view.subarray(offset, offset + length));
    offset += length;
  }

  return messages;
}

async function stacPost(body) {
  const response = await fetch(`${METEOSWISS_STAC}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`MeteoSwiss STAC search failed (${response.status})`);
  }
  return response.json();
}

function catalogCacheKey(...parts) {
  return parts.join(":");
}

function readCatalogCache(key) {
  const memoryEntry = memoryCatalogCache.get(key);
  if (memoryEntry) {
    if (memoryEntry.expiresAt > Date.now()) return memoryEntry.value;
    memoryCatalogCache.delete(key);
  }

  try {
    const raw = localStorage.getItem(`${METEOSWISS_CACHE_STORAGE_PREFIX}${key}`);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed?.expiresAt || Date.now() > parsed.expiresAt) {
      localStorage.removeItem(`${METEOSWISS_CACHE_STORAGE_PREFIX}${key}`);
      return null;
    }

    memoryCatalogCache.set(key, { expiresAt: parsed.expiresAt, value: parsed.value });
    return parsed.value;
  } catch {
    return null;
  }
}

function writeCatalogCache(key, value) {
  const expiresAt = Date.now() + METEOSWISS_CATALOG_CACHE_TTL_MS;
  memoryCatalogCache.set(key, { expiresAt, value });

  try {
    localStorage.setItem(
      `${METEOSWISS_CACHE_STORAGE_PREFIX}${key}`,
      JSON.stringify({ expiresAt, value })
    );
  } catch {
    // Ignore quota errors; in-memory cache still helps this session.
  }
}

function serializeRun(run) {
  return {
    ...run,
    runTime: run.runTime.toISOString(),
  };
}

function deserializeRun(run) {
  return {
    ...run,
    runTime: new Date(run.runTime),
  };
}

export async function fetchStacStepItem(collectionId, referenceIso, stepHours = 0) {
  const payload = await stacPost({
    collections: [collectionId],
    "forecast:variable": "W",
    "forecast:perturbed": false,
    "forecast:reference_datetime": referenceIso,
    "forecast:horizon": horizonFromStepHours(stepHours),
    limit: 1,
  });
  return payload.features?.[0] ?? null;
}

export async function fetchForecastItemsForRun(collectionId, referenceIso, variable = "W") {
  const cacheKey = catalogCacheKey("items", collectionId, referenceIso, variable);
  const cached = readCatalogCache(cacheKey);
  if (cached) return cached;

  const items = [];
  let body = {
    collections: [collectionId],
    "forecast:variable": variable,
    "forecast:perturbed": false,
    "forecast:reference_datetime": referenceIso,
    limit: 100,
  };

  while (true) {
    const payload = await stacPost(body);
    items.push(...(payload.features ?? []));
    const next = payload.links?.find((link) => link.rel === "next");
    if (!next?.body) break;
    body = { ...body, ...next.body };
  }

  writeCatalogCache(cacheKey, items);
  return items;
}

export async function pickLatestMeteoSwissRun(collectionId, modelId, now = new Date()) {
  const cacheKey = catalogCacheKey("run", collectionId, modelId);
  const cached = readCatalogCache(cacheKey);
  if (cached) return deserializeRun(cached);

  const candidates = generateRunCandidates(modelId, now);

  for (const { iso, runTime } of candidates) {
    const step0 = await fetchStacStepItem(collectionId, iso, 0);
    if (!isRunPublished(step0, runTime, now)) continue;

    const dateStamp = refDateStamp(iso);
    const run = {
      dateStamp,
      runHour: dateStamp.slice(8, 10),
      runTime,
      referenceIso: iso,
    };
    writeCatalogCache(cacheKey, serializeRun(run));
    return run;
  }

  return null;
}

export function catalogEntriesFromItems(items) {
  const entries = [];
  const seen = new Set();

  for (const item of items) {
    const props = item.properties ?? {};
    const referenceDatetime = props["forecast:reference_datetime"];
    const horizon = props["forecast:horizon"];
    if (!referenceDatetime || !horizon) continue;

    const dateStamp = refDateStamp(referenceDatetime);
    const stepHours = parseHorizonHours(horizon);
    const forecastHour = String(stepHours);
    const key = `${dateStamp}_${forecastHour}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const asset = Object.values(item.assets ?? {}).find((entry) => entry.roles?.includes("data"));
    if (!asset?.href) continue;

    let filename = asset.title ?? item.id ?? `w-${dateStamp}-${forecastHour}.grib2`;
    if (filename === "Forecast Model Data" && asset.href) {
      try {
        filename = new URL(asset.href).pathname.split("/").pop() ?? filename;
      } catch {
        // keep fallback title
      }
    }

    entries.push({
      dateStamp,
      forecastHour,
      horizon,
      filename,
      url: asset.href,
    });
  }

  entries.sort((a, b) => {
    if (a.dateStamp !== b.dateStamp) return b.dateStamp.localeCompare(a.dateStamp);
    return Number(a.forecastHour) - Number(b.forecastHour);
  });

  return entries;
}

export async function getCollectionAssetUrl(collectionId, assetId) {
  const cacheKey = catalogCacheKey("asset", collectionId, assetId);
  const cached = readCatalogCache(cacheKey);
  if (cached) return cached;

  const response = await fetch(`${METEOSWISS_STAC}/collections/${collectionId}`);
  if (!response.ok) {
    throw new Error(`MeteoSwiss collection request failed (${response.status})`);
  }
  const payload = await response.json();
  const asset = payload.assets?.[assetId];
  if (!asset?.href) {
    throw new Error(`Missing collection asset: ${assetId}`);
  }

  writeCatalogCache(cacheKey, asset.href);
  return asset.href;
}
