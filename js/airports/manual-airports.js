import { airportIdFromManualPlacement } from "./airport-id.js";

const MANUAL_AIRPORTS_STORAGE_KEY = "gpu-mc-manual-airports-v1";

/** @type {{ id: string, lng: number, lat: number, label: string, properties: object }[]} */
let manualAirports = [];

function persistManualAirports() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(
      MANUAL_AIRPORTS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        airports: manualAirports,
      })
    );
  } catch (error) {
    console.warn("Failed to persist manual airports", error);
  }
}

function loadManualAirportsFromStorage() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const raw = localStorage.getItem(MANUAL_AIRPORTS_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw);
    manualAirports = (data.airports ?? [])
      .filter((entry) => Number.isFinite(entry.lng) && Number.isFinite(entry.lat))
      .map((entry) => normalizeManualAirportEntry(entry));
  } catch (error) {
    console.warn("Failed to load manual airports", error);
  }
}

function normalizeManualAirportEntry(entry) {
  const id = entry.id ?? airportIdFromManualPlacement(entry.lng, entry.lat);
  const label = entry.label ?? entry.properties?.name ?? "";
  return {
    id,
    lng: entry.lng,
    lat: entry.lat,
    label,
    properties: {
      source: "manual",
      name: label || null,
      airport_id: id,
    },
  };
}

export function getManualAirportCount() {
  return manualAirports.length;
}

export function getManualAirports() {
  return manualAirports.map((entry) => ({ ...entry, properties: { ...entry.properties } }));
}

export function getManualAirportsInBounds(west, south, east, north) {
  return manualAirports.filter(
    (airport) =>
      airport.lng >= west &&
      airport.lng <= east &&
      airport.lat >= south &&
      airport.lat <= north
  );
}

export function manualAirportAlreadyStored(id) {
  return manualAirports.some((airport) => airport.id === id);
}

export function addManualAirportsToStore(seeds) {
  let added = 0;
  const existing = new Set(manualAirports.map((airport) => airport.id));
  for (const seed of seeds) {
    const id = seed.id ?? airportIdFromManualPlacement(seed.lng, seed.lat);
    if (existing.has(id)) {
      continue;
    }
    existing.add(id);
    const label = seed.label?.trim() ?? "";
    manualAirports.push(
      normalizeManualAirportEntry({
        id,
        lng: seed.lng,
        lat: seed.lat,
        label,
      })
    );
    added += 1;
  }
  if (added > 0) {
    persistManualAirports();
  }
  return added;
}

export function removeManualAirportFromStore(id) {
  const normalizedId = String(id);
  const before = manualAirports.length;
  manualAirports = manualAirports.filter((airport) => airport.id !== normalizedId);
  if (manualAirports.length === before) {
    return false;
  }
  persistManualAirports();
  return true;
}

export function manualAirportToSeed(entry) {
  return {
    id: entry.id,
    lng: entry.lng,
    lat: entry.lat,
    label: entry.label,
    source: "manual",
  };
}

export function manualAirportsToGeoJsonFeatures(west, south, east, north) {
  return getManualAirportsInBounds(west, south, east, north).map((airport) => ({
    type: "Feature",
    properties: {
      ...airport.properties,
      manual: true,
    },
    geometry: {
      type: "Point",
      coordinates: [airport.lng, airport.lat],
    },
  }));
}

loadManualAirportsFromStorage();
