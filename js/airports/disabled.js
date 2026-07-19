import { isAutoParamsMode } from "../params/panel.js";
import {
  airportIdFromManualPlacement,
  airportIdFromStoredAirport,
} from "./airport-id.js";
import {
  noteAirportDisabledForTip,
  noteAirportEnabledForTip,
} from "./auto-disable-tip.js";

const DISABLED_AIRPORTS_STORAGE_KEY = "gpu-mc-disabled-airports-v2";

/** @type {Map<string, { id: string, lng: number, lat: number, label?: string }>} */
const disabledAirports = new Map();

let hooks;

function persistDisabledAirports() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(
      DISABLED_AIRPORTS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        airports: [...disabledAirports.values()],
      })
    );
  } catch (error) {
    console.warn("Failed to persist disabled airports", error);
  }
}

function registerDisabledAirport(entry) {
  if (!entry?.id) {
    return;
  }
  disabledAirports.set(String(entry.id), entry);
}

function loadDisabledAirportsFromStorage() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const raw = localStorage.getItem(DISABLED_AIRPORTS_STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      for (const entry of data.airports ?? []) {
        if (entry.id) {
          registerDisabledAirport(entry);
          continue;
        }
        if (Number.isFinite(entry.lng) && Number.isFinite(entry.lat)) {
          registerDisabledAirport({
            id: airportIdFromManualPlacement(entry.lng, entry.lat),
            lng: entry.lng,
            lat: entry.lat,
            label: entry.label,
          });
        }
      }
      return;
    }
  } catch (error) {
    console.warn("Failed to load disabled airports", error);
  }
}

export function initDisabledAirports(h) {
  hooks = h;
  hooks.isAirportDisabledById = isAirportDisabledById;
  hooks.filterDisabledAirports = filterDisabledAirports;
  hooks.toggleDisabledAirportAt = toggleDisabledAirportAt;
  hooks.getDisabledAirportCount = () => disabledAirports.size;
}

export function isAirportDisabledById(id) {
  return id ? disabledAirports.has(String(id)) : false;
}

export function filterDisabledAirports(airports) {
  return airports.filter((airport) => !isAirportDisabledById(airportIdFromStoredAirport(airport)));
}

export function toggleDisabledAirportAt({ id, lng, lat, label } = {}) {
  if (!isAutoParamsMode() || hooks.getCacheSelectMode?.() || !id) {
    return false;
  }

  if (disabledAirports.has(id)) {
    disabledAirports.delete(id);
    persistDisabledAirports();
    noteAirportEnabledForTip(id);
    hooks.refreshCachedAirportMapLayer?.();
    hooks.setStatus(label ? `Enabled ${label}` : "Airport enabled");
    hooks.scheduleAutoCompute?.({ debounce: false });
    hooks.syncModeAirportHint?.();
    return true;
  }

  disabledAirports.set(id, { id, lng, lat, label });
  persistDisabledAirports();
  noteAirportDisabledForTip(id);
  hooks.refreshCachedAirportMapLayer?.();
  hooks.setStatus(label ? `Disabled ${label}` : "Airport disabled");
  hooks.scheduleAutoCompute?.({ debounce: false });
  hooks.syncModeAirportHint?.();
  return true;
}

loadDisabledAirportsFromStorage();
