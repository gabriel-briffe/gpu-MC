/**
 * Ridge-soaring escape along the upward cone path.
 *
 * Above the cone, options start at the glider. Below it, options exist only
 * when the next cone cell is still ground. The glider is flown along that
 * first ground-only run, and options start at the first ground cell where the
 * arrival is above the cone. A below-cone glider whose next cone cell is
 * already air has no options.
 *
 * "Above the cone" uses proofAltitude when given (walked-back required height
 * on ground cells). Stored ground cells are terrain, so comparing startAlt to
 * that alone would wrongly treat a clear ridge as below the cone.
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
  proofAltitude = null,
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
  const floor = Number.isFinite(proofAltitude)
    ? proofAltitude
    : coneAt(altitudes, maxAltitude, startIdx);
  if (startAlt > floor) {
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
