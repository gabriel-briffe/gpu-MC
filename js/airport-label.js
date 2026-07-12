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

export function seedDisplayLabel(seed) {
  if (seed.label) {
    return seed.label;
  }
  return `${seed.lat.toFixed(4)}°, ${seed.lng.toFixed(4)}°`;
}
