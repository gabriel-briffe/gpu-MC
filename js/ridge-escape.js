/**
 * Ridge-soaring escape along the upward cone path.
 *
 * Above the cone, options start at the glider. Below it, options exist only
 * when the cone path still has a ground run and a pure glide arrives above
 * the cone at the last ground cell before the first air cell. That cell is
 * the options seed. A below-cone glider whose next cone cell is already air
 * has no options.
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
    seen.add(key);
    if (!isGround(ground, ny * width + nx)) {
      break;
    }
    cells.push({ x: nx, y: ny });
    x = nx;
    y = ny;
  }

  let distanceM = 0;
  for (let i = 1; i < cells.length; i += 1) {
    distanceM += hopDistanceM(cells[i - 1].x, cells[i - 1].y, cells[i].x, cells[i].y, dem.cellSizeM);
  }
  const last = cells[cells.length - 1];
  const lastIdx = last.y * width + last.x;
  const arrival = startAlt - distanceM / glideRatio;
  if (!(arrival > coneAt(altitudes, maxAltitude, lastIdx))) {
    return none;
  }
  return {
    kind: "escape",
    gi: last.x,
    gj: last.y,
    arrival,
    cells,
  };
}
