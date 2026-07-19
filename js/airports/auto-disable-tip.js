const HAS_CYCLED_AIRPORT_KEY = "gpu-mc-has-cycled-airport-v1";

/** Airports disabled this session — re-enabling one completes the tip cycle. */
const disabledThisSession = new Set();

let hasCycledAirport = false;

function loadHasCycledAirport() {
  if (typeof localStorage === "undefined") {
    return false;
  }
  try {
    return localStorage.getItem(HAS_CYCLED_AIRPORT_KEY) === "1";
  } catch {
    return false;
  }
}

function persistHasCycledAirport() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(HAS_CYCLED_AIRPORT_KEY, "1");
  } catch (error) {
    console.warn("Failed to persist has-cycled-airport", error);
  }
}

export function getHasCycledAirport() {
  return hasCycledAirport;
}

/** Call when an airport is disabled in auto mode. */
export function noteAirportDisabledForTip(id) {
  if (!id || hasCycledAirport) {
    return;
  }
  disabledThisSession.add(String(id));
}

/**
 * Call when an airport is re-enabled. If it was disabled earlier this session,
 * mark the tip cycle complete (persisted).
 */
export function noteAirportEnabledForTip(id) {
  if (!id || hasCycledAirport) {
    return;
  }
  if (!disabledThisSession.has(String(id))) {
    return;
  }
  hasCycledAirport = true;
  persistHasCycledAirport();
}

hasCycledAirport = loadHasCycledAirport();
