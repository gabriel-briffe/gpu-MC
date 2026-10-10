/**
 * Options seed along the upward cone (worst-case) path.
 *
 * Compare the glider to the *stored* glide cone only (no walked-back proof).
 * Above the cone → seed at the glider. Below it → fly L/D along the origin
 * path and seed at the first cell (ground or air) where arrival is above the
 * stored cone. Typically that is the first air cell after a ground run.
 *
 * Every decision includes `path`: the cells followed (with L/D arrival), and
 * `stopReason` for debugging.
 */

function coneAt(altitudes, maxAltitude, idx) {
  const alt = altitudes?.[idx];
  if (!Number.isFinite(alt) || alt >= maxAltitude) {
    return null;
  }
  return alt;
}

function isGround(ground, idx) {
  return ground?.[idx] === 1;
}

function hopDistanceM(ax, ay, bx, by, cellSizeM) {
  return cellSizeM * Math.hypot(bx - ax, by - ay);
}

function pathStep({ gi, gj, isGround, storedAlt, distanceM, arrival, aboveStored }) {
  return {
    gi,
    gj,
    isGround,
    storedAlt,
    distanceM,
    arrival,
    aboveStored,
    marginVsStored:
      storedAlt != null && Number.isFinite(arrival) ? arrival - storedAlt : null,
  };
}

function escapeResult(gi, gj, arrival, path, stopReason) {
  return {
    kind: "escape",
    gi,
    gj,
    arrival,
    path,
    stopReason,
    cells: path.map((c) => ({ x: c.gi, y: c.gj })),
  };
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
  const none = (path, stopReason, extra = {}) => ({
    kind: "none",
    path,
    stopReason,
    ...extra,
  });
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
    return none([], "invalid-input");
  }

  const startIdx = gj * width + gi;
  const startStored = coneAt(altitudes, maxAltitude, startIdx);
  const startAbove = Number.isFinite(startAlt) && startStored != null && startAlt > startStored;
  const path = [
    pathStep({
      gi,
      gj,
      isGround: isGround(ground, startIdx),
      storedAlt: startStored,
      distanceM: 0,
      arrival: startAlt,
      aboveStored: startAbove,
    }),
  ];

  if (startAbove) {
    return { kind: "normal", path, stopReason: "above-stored-at-start" };
  }

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
      return none(path, "origin-end");
    }
    const key = `${nx},${ny}`;
    if (seen.has(key)) {
      return none(path, "origin-loop");
    }
    const nIdx = ny * width + nx;
    distanceM += hopDistanceM(x, y, nx, ny, dem.cellSizeM);
    const arrival = startAlt - distanceM / glideRatio;
    const stored = coneAt(altitudes, maxAltitude, nIdx);
    const groundCell = isGround(ground, nIdx);
    const aboveStored = stored != null && arrival > stored;
    path.push(
      pathStep({
        gi: nx,
        gj: ny,
        isGround: groundCell,
        storedAlt: stored,
        distanceM,
        arrival,
        aboveStored,
      })
    );
    seen.add(key);

    if (aboveStored) {
      return escapeResult(
        nx,
        ny,
        arrival,
        path,
        groundCell ? "cleared-stored-ground" : "cleared-stored-first-air"
      );
    }
    // Still below stored: only continue through ground. First air below → none.
    if (!groundCell) {
      return none(path, "first-air-below-stored");
    }
    x = nx;
    y = ny;
  }
  return none(path, "max-steps");
}
