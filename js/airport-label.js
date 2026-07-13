import { getCachedAirportsInBounds } from "./cache-area.js";
import { airportIdFromOpenAip, airportIdFromManualPlacement } from "./airports/airport-id.js";

export function formatAirportLabel(airport) {
  const props = airport.properties ?? {};
  if (props.source === "manual" && props.name) {
    return props.name;
  }
  if (airport.label) {
    return airport.label;
  }
  const name = props.name;
  const icao = props.icao_code ?? props.icaoCode;
  return name ?? icao ?? `${airport.lat.toFixed(4)}°, ${airport.lng.toFixed(4)}°`;
}

export function airportIcaoCode(airport) {
  if (airport.icao) {
    return airport.icao;
  }
  const props = airport.properties ?? {};
  return props.icao_code ?? props.icaoCode ?? props.icao ?? null;
}

export function airportDisplayName(airport) {
  if (airport.name) {
    return airport.name;
  }
  const props = airport.properties ?? {};
  if (props.name) {
    return props.name;
  }
  if (airport.label) {
    return airport.label;
  }
  return formatAirportLabel(airport);
}

export function normalizeComputeAirport(airport) {
  const props = airport.properties ?? {};
  const lng = airport.lng;
  const lat = airport.lat;
  const id =
    airport.id ??
    (props.airport_id ? String(props.airport_id) : null) ??
    (Object.keys(props).length > 0
      ? airportIdFromOpenAip(props, lng, lat)
      : airportIdFromManualPlacement(lng, lat));
  const icao = airportIcaoCode(airport);
  const name = airport.name ?? props.name ?? null;
  const source = airport.source ?? props.source ?? "airport";
  return {
    id,
    lng,
    lat,
    icao,
    name,
    label: airport.label ?? formatAirportLabel({ lng, lat, properties: props, name }),
    source,
  };
}

/** Match compute airports onto DEM seed cells once per run. */
export function attachSeedAirportMeta(dem, airports) {
  if (!dem?.seeds?.length || !Array.isArray(airports)) {
    return;
  }
  for (let i = 0; i < dem.seeds.length; i += 1) {
    const seed = dem.seeds[i];
    let airport = null;
    if (i < airports.length) {
      const candidate = airports[i];
      if (
        candidate &&
        Math.abs(candidate.lng - seed.lng) < 1e-4 &&
        Math.abs(candidate.lat - seed.lat) < 1e-4
      ) {
        airport = candidate;
      }
    }
    if (!airport) {
      airport = airports.find(
        (entry) =>
          Math.abs(entry.lng - seed.lng) < 1e-5 && Math.abs(entry.lat - seed.lat) < 1e-5
      );
    }
    if (!airport) {
      const pad = 0.001;
      const nearby = getCachedAirportsInBounds(
        seed.lng - pad,
        seed.lat - pad,
        seed.lng + pad,
        seed.lat + pad
      );
      airport = nearby
        .map((entry) => normalizeComputeAirport(entry))
        .sort(
          (a, b) =>
            (a.lng - seed.lng) ** 2 +
            (a.lat - seed.lat) ** 2 -
            ((b.lng - seed.lng) ** 2 + (b.lat - seed.lat) ** 2)
        )[0];
    }
    if (!airport) {
      continue;
    }
    if (!airport.icao || !airport.name) {
      airport = normalizeComputeAirport(airport);
    }
    seed.icao = airport.icao ?? airportIcaoCode(airport);
    seed.name = airport.name ?? airport.properties?.name ?? null;
    seed.label = airport.label ?? formatAirportLabel(airport);
  }
}

export function seedAtGridCell(dem, x, y) {
  return dem.seeds?.find((seed) => seed.x === x && seed.y === y) ?? null;
}

export function seedDisplayLabel(seed) {
  if (seed.label) {
    return seed.label;
  }
  return `${seed.lat.toFixed(4)}°, ${seed.lng.toFixed(4)}°`;
}
