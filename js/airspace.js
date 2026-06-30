import { globalPixelToLngLat } from "./geo.js";
import { openAipAirspacesUrl, openAipConfigured } from "./openaip-client.js";

export const AIRSPACE_TYPE_PROHIBITED = 3;
export const AIRSPACE_TYPE_ADVISORY = 29;

export const OVERLAY_AIRSPACE_TYPES = new Set([
  AIRSPACE_TYPE_PROHIBITED,
  AIRSPACE_TYPE_ADVISORY,
]);

/** Vector-tile `type` strings for {@link OVERLAY_AIRSPACE_TYPES} (3 prohibited, 29 advisory). */
export const OVERLAY_AIRSPACE_TILE_TYPES = ["prohibited", "overflight_restriction"];

const TYPE_PREFIX = {
  [AIRSPACE_TYPE_PROHIBITED]: "P",
  [AIRSPACE_TYPE_ADVISORY]: "A",
};


const FT_TO_M = 0.3048;
const FL_TO_M = 30.48;

/** Core API + vector tile (`upper_limit_*`) limit shapes. */
export function normalizeLimit(source, prefix = null) {
  if (!source) {
    return null;
  }

  if (prefix != null) {
    const value = source[`${prefix}_limit_value`];
    if (value == null) {
      return null;
    }
    return {
      value,
      unit: source[`${prefix}_limit_unit`],
      referenceDatum: source[`${prefix}_limit_reference_datum`],
    };
  }

  if (source.value != null) {
    return {
      value: source.value,
      unit: source.unit,
      referenceDatum: source.referenceDatum,
    };
  }

  if (source.upper_limit_value != null) {
    return normalizeLimit(source, "upper");
  }

  if (source.lower_limit_value != null) {
    return normalizeLimit(source, "lower");
  }

  return null;
}

function isFlightLevelUnit(unit) {
  return unit === 6 || unit === "FL" || unit === "fl";
}

function isFeetUnit(unit) {
  return unit === 1 || unit === "FT" || unit === "ft" || unit === "F";
}

function isMetersUnit(unit) {
  return unit === 0 || unit === "M" || unit === "m" || unit === "MTR";
}

function isGndDatum(datum) {
  return datum === 0 || datum === "GND" || datum === "gnd";
}

function limitValueM(limit) {
  const parsed = normalizeLimit(limit);
  if (!parsed || parsed.value == null) {
    return null;
  }

  const { value, unit } = parsed;
  if (isFlightLevelUnit(unit)) {
    return value * FL_TO_M;
  }
  if (isFeetUnit(unit)) {
    return value * FT_TO_M;
  }
  if (isMetersUnit(unit)) {
    return value;
  }
  return value;
}

/**
 * Prohibited/advisory volumes start at ground. Returns an MSL cap for the DEM, or null if
 * the airspace does not raise above terrain + groundClearance.
 */
export function airspaceUpperCapMsl(upperLimit, terrainMsl, groundClearance) {
  const parsed = normalizeLimit(upperLimit);
  const valueM = limitValueM(parsed);
  if (valueM === null || !parsed) {
    return null;
  }

  const baseElev = terrainMsl + groundClearance;

  if (isGndDatum(parsed.referenceDatum)) {
    if (valueM <= groundClearance) {
      return null;
    }
    return terrainMsl + valueM;
  }

  if (valueM <= baseElev) {
    return null;
  }
  return valueM;
}

/** Convert an OpenAIP limit to metres MSL using terrain at the point for GND/AGL. */
export function limitToMsl(limit, terrainMsl) {
  const parsed = normalizeLimit(limit);
  const valueM = limitValueM(parsed);
  if (valueM === null || !parsed) {
    return null;
  }
  if (isGndDatum(parsed.referenceDatum)) {
    return terrainMsl + valueM;
  }
  return valueM;
}

function ringsFromGeometry(geometry) {
  if (!geometry) {
    return [];
  }
  if (geometry.type === "Polygon") {
    return geometry.coordinates;
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flat();
  }
  return [];
}

function ringBBox(ring) {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return { minLng, maxLng, minLat, maxLat };
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygonRings(lng, lat, rings) {
  if (!rings.length) {
    return false;
  }
  if (!pointInRing(lng, lat, rings[0])) {
    return false;
  }
  for (let h = 1; h < rings.length; h += 1) {
    if (pointInRing(lng, lat, rings[h])) {
      return false;
    }
  }
  return true;
}

export function pointInGeoJson(lng, lat, geometry) {
  return pointInPolygonRings(lng, lat, ringsFromGeometry(geometry));
}

export function formatAirspaceLimit(limit) {
  const parsed = normalizeLimit(limit);
  if (!parsed) {
    return "—";
  }
  const ref =
    parsed.referenceDatum === 0 || parsed.referenceDatum === "GND"
      ? "GND"
      : parsed.referenceDatum === 1 || parsed.referenceDatum === "MSL"
        ? "MSL"
        : parsed.referenceDatum === 2 || parsed.referenceDatum === "STD"
          ? "STD"
          : String(parsed.referenceDatum);
  if (isFlightLevelUnit(parsed.unit)) {
    return `FL${parsed.value} ${ref}`;
  }
  if (isFeetUnit(parsed.unit)) {
    return `${parsed.value} ft ${ref}`;
  }
  if (isMetersUnit(parsed.unit)) {
    return `${parsed.value} m ${ref}`;
  }
  return `${parsed.value} ${ref}`;
}

function normalizeAirspace(item) {
  const rings = ringsFromGeometry(item.geometry);
  if (!rings.length) {
    return null;
  }
  return {
    id: item._id ?? item.id,
    name: item.name ?? "—",
    type: item.type,
    lowerLimit: item.lowerLimit,
    upperLimit: item.upperLimit,
    rings,
    bbox: ringBBox(rings[0]),
  };
}

export function airspaceContainsPoint(airspace, lng, lat) {
  const { bbox } = airspace;
  if (lng < bbox.minLng || lng > bbox.maxLng || lat < bbox.minLat || lat > bbox.maxLat) {
    return false;
  }
  return pointInPolygonRings(lng, lat, airspace.rings);
}

export function airspacesAtPoint(airspaces, lng, lat, terrainMsl = 0) {
  const matches = [];
  for (const airspace of airspaces) {
    if (!airspaceContainsPoint(airspace, lng, lat)) {
      continue;
    }
    matches.push({
      ...airspace,
      upperMsl: limitToMsl(airspace.upperLimit, terrainMsl),
      lowerMsl: terrainMsl,
    });
  }
  matches.sort((a, b) => {
    const typeOrder = (a.type === AIRSPACE_TYPE_PROHIBITED ? 0 : 1) -
      (b.type === AIRSPACE_TYPE_PROHIBITED ? 0 : 1);
    if (typeOrder !== 0) {
      return typeOrder;
    }
    return a.name.localeCompare(b.name);
  });
  return matches;
}

function formatOverlayAirspaceBand(item) {
  const upper = formatAirspaceLimit(item.upperLimit);
  return `GND → ${upper}`;
}

export function formatAirspaceList(matches) {
  if (!matches.length) {
    return "—";
  }
  return matches
    .map((item) => {
      const prefix = TYPE_PREFIX[item.type] ?? "?";
      const band = formatOverlayAirspaceBand(item);
      return `${prefix} ${item.name}  ${band}`;
    })
    .join("\n");
}

export function formatAirspaceListHtml(matches) {
  if (!matches.length) {
    return "—";
  }
  return matches
    .map((item) => {
      const prefix = TYPE_PREFIX[item.type] ?? "?";
      const cls = item.type === AIRSPACE_TYPE_PROHIBITED ? "airspace-p" : "airspace-a";
      const band = formatOverlayAirspaceBand(item);
      return `<span class="${cls}">${prefix} ${item.name}  ${band}</span>`;
    })
    .join("\n");
}

export function demBbox(dem) {
  const sw = globalPixelToLngLat(dem.gx0, dem.gy0 + dem.height, dem.zoom);
  const ne = globalPixelToLngLat(dem.gx0 + dem.width, dem.gy0, dem.zoom);
  return {
    minLng: sw.lng,
    minLat: sw.lat,
    maxLng: ne.lng,
    maxLat: ne.lat,
  };
}

export async function fetchOverlayAirspaces(bbox, config) {
  if (!openAipConfigured(config)) {
    return [];
  }

  const { minLng, minLat, maxLng, maxLat } = bbox;
  const query = new URLSearchParams({
    bbox: `${minLng},${minLat},${maxLng},${maxLat}`,
    limit: "500",
  });

  const items = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    query.set("page", String(page));
    const url = openAipAirspacesUrl(config, query);
    if (!url) {
      return [];
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`OpenAIP airspaces ${response.status}`);
    }
    const json = await response.json();
    totalPages = json.totalPages ?? 1;
    for (const item of json.items ?? []) {
      if (!OVERLAY_AIRSPACE_TYPES.has(item.type)) {
        continue;
      }
      const normalized = normalizeAirspace(item);
      if (normalized) {
        items.push(normalized);
      }
    }
    page += 1;
  }

  return items;
}

/**
 * Raise DEM cells for prohibited/advisory volumes (floor = ground, ceiling = upper limit).
 * Applied after terrain + groundClearance; no extra clearance on the airspace cap.
 */
export function applyAirspaceToDem(dem, airspaces) {
  if (!airspaces.length) {
    return 0;
  }

  const { width, height, gx0, gy0, zoom, groundClearance } = dem;
  let affected = 0;

  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const idx = j * width + i;
      const { lng, lat } = globalPixelToLngLat(gx0 + i + 0.5, gy0 + j + 0.5, zoom);
      const terrainMsl = dem.terrainMsl[idx];
      let capMsl = null;

      for (const airspace of airspaces) {
        if (!airspaceContainsPoint(airspace, lng, lat)) {
          continue;
        }
        const cap = airspaceUpperCapMsl(airspace.upperLimit, terrainMsl, groundClearance);
        if (cap === null) {
          continue;
        }
        capMsl = capMsl === null ? cap : Math.max(capMsl, cap);
      }

      if (capMsl !== null && capMsl > dem.elevation[idx]) {
        dem.elevation[idx] = capMsl;
        affected += 1;
      }
    }
  }

  dem.airspaces = airspaces;
  dem.airspaceAffectedCells = affected;
  return affected;
}
