export const TILE_SIZE = 512;
export const MIN_CELL_M = 100;
export const MAX_MAPTERHORN_Z = 12;
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

export function formatCoord(value, isLat) {
  const abs = Math.abs(value).toFixed(5);
  const dir = isLat ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  return `${abs}° ${dir}`;
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

export function gridCellDistanceM(gi, gj, gi2, gj2, dem) {
  const p1 = gridCellToLngLat(gi, gj, dem);
  const p2 = gridCellToLngLat(gi2, gj2, dem);
  return distanceMetres(p1.lat, p1.lng, p2.lat, p2.lng);
}
