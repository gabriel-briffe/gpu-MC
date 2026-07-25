import {
  openAipAirportsUrl,
  openAipConfigured,
  setOpenAipTypeFilter,
} from "./openaip-client.js";
import {
  OPENAIP_INCLUDED_AIRPORT_TYPE_CODES,
  isIncludedOpenAipAirportType,
} from "./openaip-airport-types.js";
import { openAipAirportKey } from "./openaip-tiles.js";
import { cacheCellBounds } from "./cache/cell-geometry.js";
import {
  getCachedAirportsForCell,
  putCachedAirportsForCell,
} from "./cache/airport-cell-cache.js";

function normalizeCoreAirport(item) {
  let lng;
  let lat;
  const geometry = item.geometry ?? item.location;
  if (geometry?.coordinates?.length >= 2) {
    [lng, lat] = geometry.coordinates;
  } else if (Number.isFinite(item.lon) && Number.isFinite(item.lat)) {
    lng = item.lon;
    lat = item.lat;
  } else if (Number.isFinite(item.longitude) && Number.isFinite(item.latitude)) {
    lng = item.longitude;
    lat = item.latitude;
  } else {
    return null;
  }

  const type = item.type ?? item.airportType;

  const properties = {
    ...item,
    icao_code: item.icaoCode ?? item.icao_code ?? item.icao,
    name: item.name,
    type,
    source_id: item._id ?? item.id ?? item.sourceId,
    country: item.country ?? item.isoCountry ?? item.iso_country,
  };

  return { lng, lat, properties };
}

function airportInBounds(airport, { west, south, east, north }) {
  return (
    airport.lng >= west &&
    airport.lng <= east &&
    airport.lat >= south &&
    airport.lat <= north
  );
}

function airportCountryCode(airport) {
  const raw =
    airport?.properties?.country ??
    airport?.properties?.iso_country ??
    airport?.properties?.isoCountry;
  if (!raw) {
    return null;
  }
  const code = String(raw).trim().toUpperCase();
  return code.length === 2 ? code : null;
}

/**
 * OpenAIP Core REST airports for one bbox (paginated).
 * Uses cache: "no-store" so browser HTTP cache cannot freeze proxy MISS headers.
 */
export async function fetchAirportsInBbox(bbox, config) {
  if (!openAipConfigured(config)) {
    return {
      airports: [],
      fetchCount: 0,
      proxy: { hits: 0, missesOk: 0, misses429: 0, missesOther: 0 },
    };
  }

  const { west, south, east, north } = bbox;
  const query = new URLSearchParams({
    bbox: `${west},${south},${east},${north}`,
    limit: "1000",
  });
  setOpenAipTypeFilter(query, OPENAIP_INCLUDED_AIRPORT_TYPE_CODES);

  const items = [];
  let page = 1;
  let totalPages = 1;
  let fetchCount = 0;
  const proxy = {
    hits: 0,
    missesOk: 0,
    misses429: 0,
    missesOther: 0,
  };

  while (page <= totalPages) {
    query.set("page", String(page));
    const url = openAipAirportsUrl(config, query);
    if (!url) {
      return { airports: [], fetchCount: 0, proxy };
    }
    const response = await fetch(url, { cache: "no-store" });
    fetchCount += 1;
    const cacheHeader = (response.headers.get("X-GPU-MC-Cache") || "").toUpperCase();
    const fromProxyCache = cacheHeader === "HIT";

    if (!response.ok) {
      if (fromProxyCache) {
        proxy.hits += 1;
      } else if (response.status === 429) {
        proxy.misses429 += 1;
      } else {
        proxy.missesOther += 1;
      }
      const error = new Error(`OpenAIP airports ${response.status}`);
      error.status = response.status;
      error.proxy = { ...proxy };
      throw error;
    }

    if (fromProxyCache) {
      proxy.hits += 1;
    } else {
      proxy.missesOk += 1;
    }

    const json = await response.json();
    totalPages = json.totalPages ?? 1;
    for (const item of json.items ?? []) {
      const airport = normalizeCoreAirport(item);
      if (airport && isIncludedOpenAipAirportType(airport.properties.type)) {
        items.push(airport);
      }
    }
    page += 1;
  }

  return { airports: items, fetchCount, proxy };
}

/**
 * Load airports for the given 3° cells via OpenAIP Core REST (bbox per cell).
 * Successful cells are cached for 1 week; on recache those are reused (no network).
 * Per-cell failures (429, 5xx, network) are skipped so the rest can still cache.
 */
export async function fetchAirportsForCellKeys(
  cellKeys,
  config,
  { onStatus, onWarning } = {}
) {
  if (!openAipConfigured(config)) {
    return {
      airports: [],
      fetchCount: 0,
      countries: [],
      cellsFailed: 0,
      cellsFromCache: 0,
      cellsFetched: 0,
    };
  }

  if (!cellKeys?.length) {
    return {
      airports: [],
      fetchCount: 0,
      countries: [],
      cellsFailed: 0,
      cellsFromCache: 0,
      cellsFetched: 0,
    };
  }

  let fetchCount = 0;
  let cellsFailed = 0;
  let cellsFromCache = 0;
  let cellsFetched = 0;
  const proxy = {
    hits: 0,
    missesOk: 0,
    misses429: 0,
    missesOther: 0,
  };
  const collected = [];
  const countries = new Set();

  const addProxyStats = (part) => {
    if (!part) {
      return;
    }
    proxy.hits += part.hits ?? 0;
    proxy.missesOk += part.missesOk ?? 0;
    proxy.misses429 += part.misses429 ?? 0;
    proxy.missesOther += part.missesOther ?? 0;
  };

  const addAirports = (airports) => {
    for (const airport of airports) {
      collected.push(airport);
      const cc = airportCountryCode(airport);
      if (cc) {
        countries.add(cc);
      }
    }
  };

  for (let index = 0; index < cellKeys.length; index += 1) {
    const cellKey = cellKeys[index];
    const cell = cacheCellBounds(cellKey);

    const cached = await getCachedAirportsForCell(cellKey);
    if (cached) {
      cellsFromCache += 1;
      onStatus?.(
        `Airports ${index + 1}/${cellKeys.length}: cached (${cached.airports.length})`
      );
      addAirports(cached.airports);
      continue;
    }

    onStatus?.(
      `Fetching airports ${index + 1}/${cellKeys.length} (OpenAIP API)…`
    );
    try {
      const {
        airports,
        fetchCount: cellFetches,
        proxy: cellProxy,
      } = await fetchAirportsInBbox(cell, config);
      fetchCount += cellFetches;
      cellsFetched += 1;
      addProxyStats(cellProxy);
      const forCell = airports.filter((airport) => airportInBounds(airport, cell));
      await putCachedAirportsForCell(cellKey, forCell);
      addAirports(forCell);
    } catch (error) {
      cellsFailed += 1;
      addProxyStats(error?.proxy);
      const status = error?.status;
      const detail =
        status === 429
          ? "rate limited (429)"
          : error?.message || "request failed";
      onWarning?.(
        `Airports cell ${index + 1}/${cellKeys.length}: ${detail} — skipped`
      );
      onStatus?.(
        `Airports ${index + 1}/${cellKeys.length} skipped (${detail})`
      );
      if (status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  console.log("[openaip-proxy airports]", {
    proxyCacheHits: proxy.hits,
    proxyCacheMissesFetched: proxy.missesOk,
    proxyCacheMisses429: proxy.misses429,
    proxyCacheMissesOther: proxy.missesOther,
    browserCellCacheHits: cellsFromCache,
    cellsFetched,
    cellsFailed,
  });

  return {
    airports: dedupeAirports(collected),
    fetchCount,
    countries: [...countries].sort(),
    cellsFailed,
    cellsFromCache,
    cellsFetched,
    proxy,
  };
}

export function dedupeAirports(airports) {
  const seen = new Set();
  const merged = [];
  for (const airport of airports) {
    const key = openAipAirportKey(airport.properties, airport.lng, airport.lat);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(airport);
  }
  return merged;
}
