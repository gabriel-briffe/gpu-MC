import { openAipAirportsUrl, openAipConfigured, setOpenAipTypeFilter } from "./openaip-client.js";
import { OPENAIP_INCLUDED_AIRPORT_TYPE_CODES } from "./openaip-airport-types.js";
import { openAipAirportKey } from "./openaip-tiles.js";

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
