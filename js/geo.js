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
