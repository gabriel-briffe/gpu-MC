/** OurAirports public CSV — free replacement for OpenAIP country airport exports. */

export const OURAIRPORTS_CSV_URL =
  "https://davidmegginson.github.io/ourairports-data/airports.csv";
export const OURAIRPORTS_RUNWAYS_CSV_URL =
  "https://davidmegginson.github.io/ourairports-data/runways.csv";

const EXPORT_CACHE_NAME = "gpu-mc-ourairports-csv-v1";
export const OURAIRPORTS_CSV_TTL_MS = 24 * 60 * 60 * 1000;
const CACHED_AT_HEADER = "x-gpu-mc-cached-at";

/** Keep airports with at least one open runway longer than this (feet). */
export const MIN_RUNWAY_LENGTH_FT = 1500;

/** Types kept for glide compute / map (exclude heliports, closed, seaplanes, balloons). */
export const OURAIRPORTS_INCLUDED_TYPES = new Set([
  "large_airport",
  "medium_airport",
  "small_airport",
]);

/** Case-insensitive substrings — drop if present in the airport name. */
const EXCLUDED_NAME_SUBSTRINGS = ["paraglider", "altiport", "altisurface"];

export function isExcludedOurAirportsName(name) {
  const lower = String(name ?? "").toLowerCase();
  return EXCLUDED_NAME_SUBSTRINGS.some((token) => lower.includes(token));
}

/** ICAO-style code: exactly four letters. */
export function isIcaoStyleIdent(ident) {
  return /^[A-Za-z]{4}$/.test(String(ident ?? "").trim());
}

export function nameContainsGlider(name) {
  return String(name ?? "")
    .toLowerCase()
    .includes("glider");
}

/**
 * Keep if any of ident / icao_code / gps_code is 4 letters,
 * or name contains "glider",
 * or airport has a runway longer than MIN_RUNWAY_LENGTH_FT.
 */
export function shouldKeepOurAirportsAirport({
  ident,
  name,
  icaoCode = "",
  gpsCode = "",
  airportId = "",
  longRunwayAirportIds = null,
}) {
  if (
    isIcaoStyleIdent(ident) ||
    isIcaoStyleIdent(icaoCode) ||
    isIcaoStyleIdent(gpsCode)
  ) {
    return true;
  }
  if (nameContainsGlider(name)) {
    return true;
  }
  if (longRunwayAirportIds?.has(String(airportId))) {
    return true;
  }
  return false;
}

/** @deprecated use shouldKeepOurAirportsAirport */
export function shouldKeepOurAirportsIdent(ident, name, icaoCode = "", gpsCode = "") {
  return shouldKeepOurAirportsAirport({ ident, name, icaoCode, gpsCode });
}

/** @type {{ airports: object[], fetchedAt: number } | null} */
let sessionAirports = null;

function cachesAvailable() {
  return typeof caches !== "undefined" && typeof caches.open === "function";
}

async function openCsvCache() {
  if (!cachesAvailable()) {
    return null;
  }
  return caches.open(EXPORT_CACHE_NAME);
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Airport refs (OurAirports `id`) that have at least one non-closed runway > minLengthFt.
 * @param {string} csvText
 * @returns {Set<string>}
 */
export function parseLongRunwayAirportIds(
  csvText,
  minLengthFt = MIN_RUNWAY_LENGTH_FT
) {
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) {
    return new Set();
  }

  const header = parseCsvLine(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  if (index.airport_ref == null || index.length_ft == null) {
    throw new Error("OurAirports runways CSV missing airport_ref or length_ft");
  }

  const ids = new Set();
  for (let row = 1; row < lines.length; row += 1) {
    const line = lines[row];
    if (!line) {
      continue;
    }
    const cols = parseCsvLine(line);
    if (index.closed != null && String(cols[index.closed]).trim() === "1") {
      continue;
    }
    const lengthFt = Number.parseFloat(cols[index.length_ft]);
    if (!Number.isFinite(lengthFt) || lengthFt <= minLengthFt) {
      continue;
    }
    const ref = String(cols[index.airport_ref] ?? "").trim();
    if (ref) {
      ids.add(ref);
    }
  }
  return ids;
}

/**
 * @param {string} csvText
 * @param {{ longRunwayAirportIds?: Set<string> }} [options]
 * @returns {object[]} airports as { lng, lat, properties }
 */
export function parseOurAirportsCsv(csvText, { longRunwayAirportIds = null } = {}) {
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) {
    return [];
  }

  const header = parseCsvLine(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const required = ["id", "type", "name", "latitude_deg", "longitude_deg"];
  for (const key of required) {
    if (index[key] == null) {
      throw new Error(`OurAirports CSV missing column: ${key}`);
    }
  }

  const airports = [];
  for (let row = 1; row < lines.length; row += 1) {
    const line = lines[row];
    if (!line) {
      continue;
    }
    const cols = parseCsvLine(line);
    const type = cols[index.type] ?? "";
    if (!OURAIRPORTS_INCLUDED_TYPES.has(type)) {
      continue;
    }

    const lat = Number.parseFloat(cols[index.latitude_deg]);
    const lng = Number.parseFloat(cols[index.longitude_deg]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }

    const id = cols[index.id] ?? "";
    const ident = cols[index.ident] ?? "";
    const name = cols[index.name] ?? ident ?? "Airport";
    if (isExcludedOurAirportsName(name)) {
      continue;
    }
    const icaoCol = (cols[index.icao_code] || "").trim();
    const gpsCol = (cols[index.gps_code] || "").trim();
    if (
      !shouldKeepOurAirportsAirport({
        ident,
        name,
        icaoCode: icaoCol,
        gpsCode: gpsCol,
        airportId: id,
        longRunwayAirportIds,
      })
    ) {
      continue;
    }
    const icao = icaoCol || gpsCol || ident || null;
    const elevFtRaw = cols[index.elevation_ft];
    const elevFt = elevFtRaw === "" || elevFtRaw == null ? null : Number.parseFloat(elevFtRaw);
    const elevM = Number.isFinite(elevFt) ? elevFt * 0.3048 : null;

    airports.push({
      lng,
      lat,
      properties: {
        source_id: `ourairports:${id}`,
        icao_code: icao,
        name,
        type,
        ident: ident || null,
        gps_code: gpsCol || null,
        iso_country: cols[index.iso_country] || null,
        elevation_ft: Number.isFinite(elevFt) ? elevFt : null,
        elevation_m: elevM,
        source: "ourairports",
      },
    });
  }

  return airports;
}

async function fetchCsvText(url) {
  const cache = await openCsvCache();
  if (cache) {
    try {
      const cached = await cache.match(url);
      if (cached) {
        const cachedAt = Number(cached.headers.get(CACHED_AT_HEADER));
        if (Number.isFinite(cachedAt) && Date.now() - cachedAt < OURAIRPORTS_CSV_TTL_MS) {
          if (cached.ok) {
            return { text: await cached.text(), fromNetwork: false, status: cached.status };
          }
        }
        await cache.delete(url);
      }
    } catch (error) {
      console.warn("OurAirports CSV cache read failed", error);
    }
  }

  const response = await fetch(url);
  const status = response.status;
  if (!response.ok) {
    throw new Error(`OurAirports CSV ${status} (${url})`);
  }
  const text = await response.text();

  if (cache) {
    try {
      const headers = new Headers({
        "Content-Type": "text/csv; charset=utf-8",
        [CACHED_AT_HEADER]: String(Date.now()),
      });
      await cache.put(url, new Response(text, { status: 200, statusText: "OK", headers }));
    } catch (error) {
      console.warn("OurAirports CSV cache write failed", error);
    }
  }

  return { text, fromNetwork: true, status };
}

/**
 * Load (and session-cache) the full filtered OurAirports list.
 * @returns {{ airports: object[], fetchCount: number }}
 */
export async function loadOurAirportsDataset({ onStatus } = {}) {
  if (
    sessionAirports &&
    Date.now() - sessionAirports.fetchedAt < OURAIRPORTS_CSV_TTL_MS
  ) {
    return { airports: sessionAirports.airports, fetchCount: 0 };
  }

  onStatus?.("Fetching OurAirports airports + runways…");
  const [airportsResult, runwaysResult] = await Promise.all([
    fetchCsvText(OURAIRPORTS_CSV_URL),
    fetchCsvText(OURAIRPORTS_RUNWAYS_CSV_URL),
  ]);
  onStatus?.("Parsing OurAirports runways…");
  const longRunwayAirportIds = parseLongRunwayAirportIds(runwaysResult.text);
  onStatus?.("Parsing OurAirports airports…");
  const airports = parseOurAirportsCsv(airportsResult.text, { longRunwayAirportIds });
  sessionAirports = { airports, fetchedAt: Date.now() };
  const fetchCount =
    (airportsResult.fromNetwork ? 1 : 0) + (runwaysResult.fromNetwork ? 1 : 0);
  return { airports, fetchCount };
}

export async function clearOurAirportsCsvCache() {
  sessionAirports = null;
  if (!cachesAvailable()) {
    return;
  }
  try {
    await caches.delete(EXPORT_CACHE_NAME);
  } catch (error) {
    console.warn("Failed to clear OurAirports CSV cache", error);
  }
}
