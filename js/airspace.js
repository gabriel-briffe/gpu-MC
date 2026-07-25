import { globalPixelToLngLat } from "./geo.js";
import {
  openAipAirspacesUrl,
  openAipConfigured,
  setOpenAipTypeFilter,
} from "./openaip-client.js";
import { cacheCellBounds } from "./cache/cell-geometry.js";
import {
  getCachedAirspacesForCell,
  putCachedAirspacesForCell,
} from "./cache/openaip-cell-cache.js";

export const AIRSPACE_TYPE_PROHIBITED = 3;
export const AIRSPACE_TYPE_ADVISORY = 29;

export const OVERLAY_AIRSPACE_TYPES = new Set([
  AIRSPACE_TYPE_PROHIBITED,
  AIRSPACE_TYPE_ADVISORY,
]);

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

/** Normalize longitude to [-180, 180). */
export function normalizeLongitude(lng) {
  if (!Number.isFinite(lng)) {
    return lng;
  }
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  return wrapped === 180 ? -180 : wrapped;
}

/**
 * Bounding box for polygon rings. Longitudes are normalized to [-180, 180).
 * When the shape crosses the antimeridian, `wrapsAntimeridian` is true and the
 * lon interval is the short arc: [minLng → 180] ∪ [-180 → maxLng] (with minLng > maxLng).
 */
export function ringsBBox(rings) {
  const lons = [];
  const lats = [];
  for (const ring of rings) {
    for (const point of ring) {
      const lng = normalizeLongitude(point[0]);
      const lat = point[1];
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        continue;
      }
      lons.push(lng);
      lats.push(lat);
    }
  }
  if (!lons.length) {
    return {
      minLng: Infinity,
      maxLng: -Infinity,
      minLat: Infinity,
      maxLat: -Infinity,
      wrapsAntimeridian: false,
    };
  }

  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const sorted = [...lons].sort((a, b) => a - b);
  const minLng = sorted[0];
  const maxLng = sorted[sorted.length - 1];

  if (maxLng - minLng <= 180) {
    return { minLng, maxLng, minLat, maxLat, wrapsAntimeridian: false };
  }

  let maxGap = minLng + 360 - maxLng;
  let gapAfterIdx = sorted.length - 1;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const gap = sorted[i + 1] - sorted[i];
    if (gap > maxGap) {
      maxGap = gap;
      gapAfterIdx = i;
    }
  }

  return {
    minLng: sorted[(gapAfterIdx + 1) % sorted.length],
    maxLng: sorted[gapAfterIdx],
    minLat,
    maxLat,
    wrapsAntimeridian: true,
  };
}

/** True if a lon range [west, east] (west ≤ east, no wrap) overlaps an airspace bbox. */
function lonRangeOverlapsBBox(west, east, bbox) {
  if (!bbox.wrapsAntimeridian) {
    return !(bbox.maxLng < west || bbox.minLng > east);
  }
  // Wrapped airspace: [minLng, 180] ∪ [-180, maxLng]
  return east >= bbox.minLng || west <= bbox.maxLng;
}

/**
 * Discard test for one airspace vs one axis-aligned cell (west&lt;east, no wrap).
 * Matches: maxLat &lt; south, minLat &gt; north, or lon outside left/right.
 */
export function airspaceBBoxIntersectsCell(bbox, cell) {
  if (
    !Number.isFinite(bbox.minLat) ||
    !Number.isFinite(bbox.maxLat) ||
    !Number.isFinite(bbox.minLng) ||
    !Number.isFinite(bbox.maxLng)
  ) {
    return false;
  }
  if (bbox.maxLat < cell.south || bbox.minLat > cell.north) {
    return false;
  }
  return lonRangeOverlapsBBox(cell.west, cell.east, bbox);
}

export function airspaceBBoxIntersectsAnyCell(bbox, cells) {
  return cells.some((cell) => airspaceBBoxIntersectsCell(bbox, cell));
}

export function airspaceBBoxIntersectsBounds(bbox, west, south, east, north) {
  if (east < west) {
    // Query bounds wrap — split at antimeridian.
    return (
      airspaceBBoxIntersectsBounds(bbox, west, south, 180, north) ||
      airspaceBBoxIntersectsBounds(bbox, -180, south, east, north)
    );
  }
  return airspaceBBoxIntersectsCell(bbox, { west, south, east, north });
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

export function normalizeAirspace(item) {
  const rings = ringsFromGeometry(item.geometry);
  if (!rings.length) {
    return null;
  }
  return {
    id: item._id ?? item.id,
    name: item.name ?? "—",
    type: item.type,
    country: item.country ?? null,
    lowerLimit: item.lowerLimit,
    upperLimit: item.upperLimit,
    rings,
    bbox: ringsBBox(rings),
  };
}

export function airspaceKey(airspace) {
  return airspace.id ?? `${airspace.name}@${airspace.type}`;
}

export function dedupeAirspaces(airspaces) {
  const seen = new Set();
  const merged = [];
  for (const airspace of airspaces) {
    const key = airspaceKey(airspace);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(airspace);
  }
  return merged;
}

export function airspaceToGeoJsonFeature(airspace) {
  return {
    type: "Feature",
    properties: {
      id: airspace.id,
      name: airspace.name,
      type: airspace.type,
    },
    geometry: {
      type: "Polygon",
      coordinates: airspace.rings,
    },
  };
}

export function airspacesToGeoJsonFeatures(airspaces) {
  return airspaces.map(airspaceToGeoJsonFeature);
}

export function airspaceContainsPoint(airspace, lng, lat) {
  const { bbox } = airspace;
  const lon = normalizeLongitude(lng);
  if (lat < bbox.minLat || lat > bbox.maxLat) {
    return false;
  }
  if (!lonRangeOverlapsBBox(lon, lon, bbox)) {
    return false;
  }
  return pointInPolygonRings(lon, lat, airspace.rings);
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

async function fetchOverlayAirspacesForBbox(bbox, config) {
  const { west, south, east, north } = bbox;
  const query = new URLSearchParams({
    bbox: `${west},${south},${east},${north}`,
    limit: "500",
  });
  setOpenAipTypeFilter(query, OVERLAY_AIRSPACE_TYPES);

  const items = [];
  let page = 1;
  let totalPages = 1;
  let fetchCount = 0;
  const proxy = {
    hits: 0,
    missesOk: 0,
    misses429: 0,
    missesOther: 0,
  };

  while (page <= totalPages) {
    query.set("page", String(page));
    const url = openAipAirspacesUrl(config, query);
    if (!url) {
      return { airspaces: [], fetchCount, proxy };
    }
    // no-store: avoid replaying a browser-HTTP-cached MISS (X-GPU-MC-Cache frozen).
    const response = await fetch(url, { cache: "no-store" });
    fetchCount += 1;
    const cacheHeader = (response.headers.get("X-GPU-MC-Cache") || "").toUpperCase();
    const fromProxyCache = cacheHeader === "HIT";

    if (!response.ok) {
      if (fromProxyCache) {
        proxy.hits += 1;
      } else if (response.status === 429) {
        proxy.misses429 += 1;
      } else {
        proxy.missesOther += 1;
      }
      const error = new Error(`OpenAIP airspaces ${response.status}`);
      error.status = response.status;
      error.proxy = { ...proxy };
      throw error;
    }

    if (fromProxyCache) {
      proxy.hits += 1;
    } else {
      proxy.missesOk += 1;
    }

    const json = await response.json();
    totalPages = json.totalPages ?? 1;
    for (const item of json.items ?? []) {
      const normalized = normalizeAirspace(item);
      if (normalized && OVERLAY_AIRSPACE_TYPES.has(normalized.type)) {
        items.push(normalized);
      }
    }
    page += 1;
  }

  return { airspaces: items, fetchCount, proxy };
}

/**
 * Load prohibited/advisory airspaces for the given 3° cells via OpenAIP Core API.
 * Successful cells are cached for 1 week; on recache those are reused (no network).
 * Per-cell failures (429, 5xx, network) are skipped so the rest can still cache.
 */
export async function fetchAirspacesForCellKeys(
  cellKeys,
  config,
  { onStatus, onWarning } = {}
) {
  if (!openAipConfigured(config)) {
    return {
      airspaces: [],
      fetchCount: 0,
      countries: [],
      cellsFailed: 0,
      cellsFromCache: 0,
      cellsFetched: 0,
    };
  }

  if (!cellKeys?.length) {
    return {
      airspaces: [],
      fetchCount: 0,
      countries: [],
      cellsFailed: 0,
      cellsFromCache: 0,
      cellsFetched: 0,
    };
  }

  let fetchCount = 0;
  let cellsFailed = 0;
  let cellsFromCache = 0;
  let cellsFetched = 0;
  const proxy = {
    hits: 0,
    missesOk: 0,
    misses429: 0,
    missesOther: 0,
  };
  const collected = [];
  const countries = new Set();

  const addProxyStats = (part) => {
    if (!part) {
      return;
    }
    proxy.hits += part.hits ?? 0;
    proxy.missesOk += part.missesOk ?? 0;
    proxy.misses429 += part.misses429 ?? 0;
    proxy.missesOther += part.missesOther ?? 0;
  };

  const addAirspaces = (airspaces) => {
    for (const airspace of airspaces) {
      collected.push(airspace);
      if (airspace.country) {
        countries.add(String(airspace.country).toUpperCase());
      }
    }
  };

  for (let index = 0; index < cellKeys.length; index += 1) {
    const cellKey = cellKeys[index];
    const cell = cacheCellBounds(cellKey);

    const cached = await getCachedAirspacesForCell(cellKey);
    if (cached) {
      cellsFromCache += 1;
      onStatus?.(
        `Airspaces ${index + 1}/${cellKeys.length}: cached (${cached.airspaces.length})`
      );
      addAirspaces(cached.airspaces);
      continue;
    }

    onStatus?.(
      `Fetching airspaces ${index + 1}/${cellKeys.length} (OpenAIP API)…`
    );
    try {
      const {
        airspaces,
        fetchCount: cellFetches,
        proxy: cellProxy,
      } = await fetchOverlayAirspacesForBbox(cell, config);
      fetchCount += cellFetches;
      cellsFetched += 1;
      addProxyStats(cellProxy);
      // Store volumes for this cell bbox (dedupe later across cells).
      const forCell = airspaces.filter((airspace) =>
        airspaceBBoxIntersectsAnyCell(airspace.bbox, [cell])
      );
      await putCachedAirspacesForCell(cellKey, forCell);
      addAirspaces(forCell);
    } catch (error) {
      cellsFailed += 1;
      addProxyStats(error?.proxy);
      const status = error?.status;
      const detail =
        status === 429
          ? "rate limited (429)"
          : error?.message || "request failed";
      onWarning?.(
        `Airspaces cell ${index + 1}/${cellKeys.length}: ${detail} — skipped`
      );
      onStatus?.(
        `Airspaces ${index + 1}/${cellKeys.length} skipped (${detail})`
      );
      if (status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  console.log("[openaip-proxy airspaces]", {
    proxyCacheHits: proxy.hits,
    proxyCacheMissesFetched: proxy.missesOk,
    proxyCacheMisses429: proxy.misses429,
    proxyCacheMissesOther: proxy.missesOther,
    browserCellCacheHits: cellsFromCache,
    cellsFetched,
    cellsFailed,
  });

  return {
    airspaces: dedupeAirspaces(collected),
    fetchCount,
    countries: [...countries].sort(),
    cellsFailed,
    cellsFromCache,
    cellsFetched,
    proxy,
  };
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
