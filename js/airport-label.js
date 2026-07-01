export function formatAirportLabel(airport) {
  const props = airport.properties ?? {};
  const name = props.name;
  const icao = props.icao_code ?? props.icaoCode;
  return name ?? icao ?? `${airport.lat.toFixed(4)}°, ${airport.lng.toFixed(4)}°`;
}

export function seedDisplayLabel(seed) {
  if (seed.label) {
    return seed.label;
  }
  return `${seed.lat.toFixed(4)}°, ${seed.lng.toFixed(4)}°`;
}
