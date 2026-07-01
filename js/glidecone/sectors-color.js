export const SECTOR_PALETTE_SIZE = 8;

export function hashLatLngToPaletteSlot(lat, lng) {
  const latQ = Math.round(lat * 1e5);
  const lngQ = Math.round(lng * 1e5);
  let hash = 2_166_136_261;
  hash ^= latQ;
  hash = Math.imul(hash, 16_777_619);
  hash ^= lngQ;
  hash = Math.imul(hash, 16_777_619);
  return (hash >>> 0) % SECTOR_PALETTE_SIZE;
}

export function buildSeedPaletteGrid(width, height, seeds) {
  const grid = new Uint32Array(width * height);
  for (const seed of seeds) {
    const idx = seed.y * width + seed.x;
    grid[idx] = hashLatLngToPaletteSlot(seed.lat, seed.lng) + 1;
  }
  return grid;
}
