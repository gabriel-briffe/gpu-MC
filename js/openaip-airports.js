import {
  openAipAirportsUrl,
  openAipConfigured,
  openAipCountryAirportGeoJsonUrl,
  setOpenAipTypeFilter,
} from "./openaip-client.js";
import {
  OPENAIP_INCLUDED_AIRPORT_TYPE_CODES,
  isIncludedOpenAipAirportType,
} from "./openaip-airport-types.js";
import { openAipAirportKey } from "./openaip-tiles.js";
import { countriesForCellKeys } from "./openaip-cell-countries.js";
import { cacheCellBounds } from "./cache/cell-geometry.js";
import { fetchCountryExportJson } from "./cache/openaip-export-cache.js";

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
  };

  return { lng, lat, properties };
}

function airportFromGeoJsonFeature(feature) {
  if (!feature?.geometry) {
    return null;
  }
  const airport = normalizeCoreAirport({
    ...(feature.properties ?? {}),
    geometry: feature.geometry,
  });
  if (!airport) {
    return null;
  }
  if (!isIncludedOpenAipAirportType(airport.properties.type)) {
    return null;
  }
  return airport;
}

function airportInBounds(airport, { west, south, east, north }) {
  return (
    airport.lng >= west &&
    airport.lng <= east &&
    airport.lat >= south &&
    airport.lat <= north
  );
}

function airportInAnyCell(airport, cells) {
  return cells.some((cell) => airportInBounds(airport, cell));
}

export async function fetchAirportsInBbox(bbox, config) {
  if (!openAipConfigured(config)) {
    return { airports: [], fetchCount: 0 };
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

  while (page <= totalPages) {
    query.set("page", String(page));
    const url = openAipAirportsUrl(config, query);
    if (!url) {
      return { airports: [], fetchCount: 0 };
    }
    const response = await fetch(url);
    fetchCount += 1;
    if (!response.ok) {
      throw new Error(`OpenAIP airports ${response.status}`);
    }
    const json = await response.json();
    totalPages = json.totalPages ?? 1;
    for (const item of json.items ?? []) {
      const airport = normalizeCoreAirport(item);
      if (airport) {
        items.push(airport);
      }
    }
    page += 1;
  }

  return { airports: items, fetchCount };
}

/**
 * Load country airport GeoJSON exports for the given 3° cells, clip to those cells,
 * and return one deduped airport list (shared cache, not per-cell).
 */
export async function fetchAirportsForCellKeys(cellKeys, config, { onStatus } = {}) {
  if (!openAipConfigured(config)) {
    return { airports: [], fetchCount: 0, countries: [] };
  }

  const countries = countriesForCellKeys(cellKeys);
  if (!countries.length) {
    return { airports: [], fetchCount: 0, countries };
  }

  const cells = cellKeys.map((cellKey) => cacheCellBounds(cellKey));
  let fetchCount = 0;
  const collected = [];

  for (let index = 0; index < countries.length; index += 1) {
    const cc = countries[index];
    onStatus?.(
      `Fetching airports export ${index + 1}/${countries.length} (${cc})…`
    );
    const url = openAipCountryAirportGeoJsonUrl(config, cc);
    if (!url) {
      continue;
    }
    const { json: geojson, fromNetwork, status } = await fetchCountryExportJson(url);
    if (fromNetwork) {
      fetchCount += 1;
    }
    if (status === 404 || !geojson) {
      if (status === 404) {
        onStatus?.(`No airport export for ${cc} — skipping`);
        continue;
      }
      if (status) {
        throw new Error(`OpenAIP airport export ${cc} ${status}`);
      }
      continue;
    }
    for (const feature of geojson.features ?? []) {
      const airport = airportFromGeoJsonFeature(feature);
      if (!airport) {
        continue;
      }
      if (!airportInAnyCell(airport, cells)) {
        continue;
      }
      collected.push(airport);
    }
  }

  return {
    airports: dedupeAirports(collected),
    fetchCount,
    countries,
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
