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

export function airportIdFromSeed(seed) {
  if (seed.id) {
    return String(seed.id);
  }
  if (seed.properties) {
    return airportIdFromOpenAip(seed.properties, seed.lng, seed.lat);
  }
  return airportIdFromManualPlacement(seed.lng, seed.lat);
}

export function airportIdFromFeature(feature) {
  const props = feature.properties ?? {};
  if (props.airport_id) {
    return String(props.airport_id);
  }
  const [lng, lat] = feature.geometry.coordinates;
  return airportIdFromOpenAip(props, lng, lat);
}

export function airportPropertiesWithId(properties, lng, lat) {
  return {
    ...properties,
    airport_id: airportIdFromOpenAip(properties, lng, lat),
  };
}

export function seedFromOpenAipAirport(airport, { label, source = "airport" } = {}) {
  const { lng, lat, properties = {} } = airport;
  const id = airportIdFromOpenAip(properties, lng, lat);
  const seed = { id, lng, lat, source };
  if (label) {
    seed.label = label;
  }
  return seed;
}
