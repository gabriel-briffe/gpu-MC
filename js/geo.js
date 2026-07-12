export const TILE_SIZE = 512;
export const MIN_CELL_M = 100;
export const MAX_MAPTERHORN_Z = 12;
export const TERRAIN_ZOOM_MIN = 7;
export const TERRAIN_ZOOM_MAX = 10;
export const EARTH_CIRCUMFERENCE = 40_075_017;

/** Ground meters per pixel at latitude for 512px Mapterhorn tiles. */
export function metersPerPixel(lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  return (Math.cos(latRad) * EARTH_CIRCUMFERENCE) / (TILE_SIZE * 2 ** zoom);
}

/** Finest zoom where native tile step is still >= minCellM. */
export function pickTerrainZoom(lat, minCellM = MIN_CELL_M, maxZ = MAX_MAPTERHORN_Z) {
  const latRad = (lat * Math.PI) / 180;
  const raw = Math.log2((Math.cos(latRad) * EARTH_CIRCUMFERENCE) / (TILE_SIZE * minCellM));
  return Math.max(0, Math.min(maxZ, Math.floor(raw)));
}

export function clampTerrainZoom(z) {
  if (!Number.isFinite(z)) {
    return TERRAIN_ZOOM_MAX;
  }
  return Math.max(TERRAIN_ZOOM_MIN, Math.min(TERRAIN_ZOOM_MAX, Math.floor(z)));
}

export function lngLatToGlobalPixel(lng, lat, zoom) {
  const scale = 2 ** zoom;
  const latRad = (lat * Math.PI) / 180;
  const gx = ((lng + 180) / 360) * scale * TILE_SIZE;
  const gy =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    scale *
    TILE_SIZE;
  return { gx, gy };
}

export function globalPixelToLngLat(gx, gy, zoom) {
  const scale = 2 ** zoom;
  const lng = (gx / (TILE_SIZE * scale)) * 360 - 180;
  const n = Math.PI * (1 - (2 * gy) / (TILE_SIZE * scale));
  const lat = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  return { lng, lat };
}

export function gridCellToLngLat(gi, gj, dem) {
  const { gx0, gy0, zoom } = dem;
  return globalPixelToLngLat(gx0 + gi + 0.5, gy0 + gj + 0.5, zoom);
}

export function gridIndexFromLngLat(lng, lat, dem) {
  const { gx, gy } = lngLatToGlobalPixel(lng, lat, dem.zoom);
  const gi = Math.floor(gx) - dem.gx0;
  const gj = Math.floor(gy) - dem.gy0;
  return { gi, gj };
}

export function gridBoundsLngLat(gx0, gy0, width, height, zoom) {
  const nw = globalPixelToLngLat(gx0, gy0, zoom);
  const ne = globalPixelToLngLat(gx0 + width, gy0, zoom);
  const se = globalPixelToLngLat(gx0 + width, gy0 + height, zoom);
  const sw = globalPixelToLngLat(gx0, gy0 + height, zoom);
  return [nw, ne, se, sw];
}

export function terrariumElevation(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

export function distanceMetres(lat1, lng1, lat2, lng2) {
  const latMidRad = (((lat1 + lat2) / 2) * Math.PI) / 180;
  const dLatM = (((lat2 - lat1) * Math.PI) / 180) * 6_371_000;
  const dLngM = (((lng2 - lng1) * Math.PI) / 180) * 6_371_000 * Math.cos(latMidRad);
  return Math.hypot(dLatM, dLngM);
}

/** Axis-aligned box with ±radiusKm from centre (total width/height = 2 × radiusKm). */
export function kmBoxAroundLngLat(lng, lat, radiusKm) {
  const latRad = (lat * Math.PI) / 180;
  const latDelta = ((radiusKm * 1000) / 6_371_000) * (180 / Math.PI);
  const cosLat = Math.cos(latRad);
  const lngDelta = cosLat > 1e-6 ? latDelta / cosLat : latDelta;
  return {
    west: lng - lngDelta,
    east: lng + lngDelta,
    south: lat - latDelta,
    north: lat + latDelta,
  };
}

/** True when lng/lat is within maxOffsetFromCenterFraction of half-span from box centre. */
export function isInsideKmBoxInnerZone(lng, lat, box, maxOffsetFromCenterFraction = 0.25) {
  const centerLng = (box.west + box.east) / 2;
  const centerLat = (box.south + box.north) / 2;
  const halfLng = (box.east - box.west) / 2;
  const halfLat = (box.north - box.south) / 2;
  return (
    Math.abs(lng - centerLng) <= halfLng * maxOffsetFromCenterFraction &&
    Math.abs(lat - centerLat) <= halfLat * maxOffsetFromCenterFraction
  );
}

export function gridCellDistanceM(gi, gj, gi2, gj2, dem) {
  const p1 = gridCellToLngLat(gi, gj, dem);
  const p2 = gridCellToLngLat(gi2, gj2, dem);
  return distanceMetres(p1.lat, p1.lng, p2.lat, p2.lng);
}
