import { openAipAirportKey } from "../openaip-tiles.js";

export const MANUAL_AIRPORT_ID_PREFIX = "manual:";

/** Stable OpenAIP id: source_id, ICAO, or name@coords fallback. */
export function airportIdFromOpenAip(properties, lng, lat) {
  return openAipAirportKey(properties, lng, lat);
}

/** Id for map-placed airports with no OpenAIP record. */
export function airportIdFromManualPlacement(lng, lat) {
  return `${MANUAL_AIRPORT_ID_PREFIX}${lng.toFixed(5)},${lat.toFixed(5)}`;
}

export function airportIdFromComputeAirport(airport) {
  if (airport.id) {
    return String(airport.id);
  }
  if (airport.properties) {
    return airportIdFromOpenAip(airport.properties, airport.lng, airport.lat);
  }
  return airportIdFromManualPlacement(airport.lng, airport.lat);
}

export function airportIdFromFeature(feature) {
  const props = feature.properties ?? {};
  if (props.airport_id) {
    return String(props.airport_id);
  }
  const [lng, lat] = feature.geometry.coordinates;
  return airportIdFromOpenAip(props, lng, lat);
}

/** Id for a cached or manual airport record. */
export function airportIdFromStoredAirport(airport) {
  const props = airport.properties ?? {};
  if (props.airport_id) {
    return String(props.airport_id);
  }
  if (props.source === "manual") {
    return airportIdFromManualPlacement(airport.lng, airport.lat);
  }
  return airportIdFromOpenAip(props, airport.lng, airport.lat);
}

export function airportPropertiesWithId(properties, lng, lat) {
  if (properties?.source === "manual" && properties.airport_id) {
    return { ...properties, airport_id: String(properties.airport_id) };
  }
  return {
    ...properties,
    airport_id: airportIdFromOpenAip(properties, lng, lat),
  };
}

export function computeAirportFromOpenAip(airport, { label, source = "airport" } = {}) {
  const { lng, lat, properties = {} } = airport;
  const id = airportIdFromOpenAip(properties, lng, lat);
  const entry = { id, lng, lat, source };
  if (label) {
    entry.label = label;
  }
  return entry;
}
