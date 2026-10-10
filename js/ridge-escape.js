/**
 * Options seed along the upward cone (worst-case) path.
 *
 * Compare the glider to the *stored* glide cone only (no walked-back proof).
 * Above the cone → seed at the glider. Below it → fly L/D along the first
 * ground-only origin run and seed at the first ground cell where arrival is
 * above the stored cone. If the last ground cell before air is still below
 * the cone → no options.
 */

function coneAt(altitudes, maxAltitude, idx) {
  const alt = altitudes?.[idx];
  if (!Number.isFinite(alt) || alt >= maxAltitude) {
    return Number.POSITIVE_INFINITY;
  }
  return alt;
}

function isGround(ground, idx) {
  return ground?.[idx] === 1;
}

function hopDistanceM(ax, ay, bx, by, cellSizeM) {
  return cellSizeM * Math.hypot(bx - ax, by - ay);
}

export function ridgeEscapeSeed({
  dem,
  altitudes,
  originX,
  originY,
  ground,
  maxAltitude,
  gi,
  gj,
  startAlt,
  glideRatio,
}) {
  const none = { kind: "none" };
  const width = dem?.width ?? 0;
  const height = dem?.height ?? 0;
  if (
    !dem ||
    !altitudes ||
    !originX ||
    !originY ||
    !ground ||
    !Number.isFinite(startAlt) ||
    !Number.isFinite(glideRatio) ||
    glideRatio <= 0 ||
    gi < 0 ||
    gj < 0 ||
    gi >= width ||
    gj >= height
  ) {
    return none;
  }

  const startIdx = gj * width + gi;
  if (startAlt > coneAt(altitudes, maxAltitude, startIdx)) {
    return { kind: "normal" };
  }

  const ox = originX[startIdx];
  const oy = originY[startIdx];
  if (
    ox < 0 ||
    oy < 0 ||
    ox >= width ||
    oy >= height ||
    (ox === gi && oy === gj) ||
    !isGround(ground, oy * width + ox)
  ) {
    return none;
  }

  const cells = [{ x: gi, y: gj }];
  const seen = new Set([`${gi},${gj}`]);
  let x = gi;
  let y = gj;
  let distanceM = 0;
  const maxSteps = width + height;
  for (let step = 0; step < maxSteps; step += 1) {
    const idx = y * width + x;
    const nx = originX[idx];
    const ny = originY[idx];
    if (nx < 0 || ny < 0 || nx >= width || ny >= height || (nx === x && ny === y)) {
      return none;
    }
    const key = `${nx},${ny}`;
    if (seen.has(key)) {
      return none;
    }
    // Last ground before air still below the stored cone → no options.
    if (!isGround(ground, ny * width + nx)) {
      return none;
    }
    seen.add(key);
    distanceM += hopDistanceM(x, y, nx, ny, dem.cellSizeM);
    const arrival = startAlt - distanceM / glideRatio;
    cells.push({ x: nx, y: ny });
    if (arrival > coneAt(altitudes, maxAltitude, ny * width + nx)) {
      return {
        kind: "escape",
        gi: nx,
        gj: ny,
        arrival,
        cells,
      };
    }
    x = nx;
    y = ny;
  }
  return none;
}
