import { distanceMetres, gridCellToLngLat } from "../geo.js";

function cellIndex(x, y, dem) {
  return y * dem.width + x;
}

function terrainMsl(x, y, dem) {
  const idx = cellIndex(x, y, dem);
  return dem.terrainMsl ? dem.terrainMsl[idx] : dem.elevation[idx] - dem.groundClearance;
}

function storedAltitude(altitudes, maxAltitude, idx) {
  const alt = altitudes[idx];
  if (!Number.isFinite(alt) || alt >= maxAltitude) {
    return null;
  }
  return alt;
}

function seedArrivalAltitude(dem, x, y, circuitHeight) {
  return terrainMsl(x, y, dem) + circuitHeight;
}

/** Required height: stored altitude in the air, walked back to air when already on the ground. */
function proofAltitudeAt(x, y, ctx) {
  const { dem, altitudes, ground, originX, originY, maxAltitude, glideRatio, circuitHeight } = ctx;
  const startAlt = storedAltitude(altitudes, maxAltitude, cellIndex(x, y, dem));
  if (startAlt == null || !(glideRatio > 0)) {
    return null;
  }
  if (ground[cellIndex(x, y, dem)] !== 1 || !originX || !originY) {
    return ground[cellIndex(x, y, dem)] === 1
      ? seedArrivalAltitude(dem, x, y, circuitHeight)
      : startAlt;
  }

  let distanceM = 0;
  let cx = x;
  let cy = y;
  const seen = new Set();
  const maxSteps = (dem.width + dem.height) * 2;
  for (let step = 0; step < maxSteps; step += 1) {
    const key = `${cx},${cy}`;
    if (seen.has(key)) {
      return null;
    }
    seen.add(key);
    const idx = cellIndex(cx, cy, dem);
    if (ground[idx] !== 1) {
      const air = storedAltitude(altitudes, maxAltitude, idx);
      return air == null ? null : air + distanceM / glideRatio;
    }
    const nx = originX[idx];
    const ny = originY[idx];
    if (nx < 0 || ny < 0 || (nx === cx && ny === cy)) {
      return seedArrivalAltitude(dem, cx, cy, circuitHeight) + distanceM / glideRatio;
    }
    distanceM += dem.cellSizeM * Math.hypot(nx - cx, ny - cy);
    cx = nx;
    cy = ny;
  }
  return null;
}

/** Minimum altitude that still reaches the airport: cone height in the air, walked back from the ground. */
export function requiredAltitudeAt(x, y, ctx) {
  return proofAltitudeAt(x, y, ctx);
}

function isDownhillGround(from, to, ground, dem) {
  const fromIdx = cellIndex(from.x, from.y, dem);
  if (ground[fromIdx] !== 1) {
    return false;
  }
  return terrainMsl(to.x, to.y, dem) < terrainMsl(from.x, from.y, dem);
}

function pushDisc(discs, lngLat, role) {
  const key = `${lngLat.lng.toFixed(5)},${lngLat.lat.toFixed(5)}`;
  if (discs.some((disc) => disc.properties.key === key)) {
    return;
  }
  discs.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lngLat.lng, lngLat.lat] },
    properties: { kind: "disc", role, key },
  });
}

/**
 * Upward relay styled like XCSoar: pink, black dashed downhill-ground,
 * red prefix when already below the cone and steeper than 80% L/D,
 * red discs where an 80% pretend altitude meets the ground.
 * panPath uses the pan rules (first ground contact, no red prefix).
 */
export function styleUpwardRoute({
  cells,
  dem,
  ground,
  altitudes,
  originX,
  originY,
  maxAltitude,
  glideRatio,
  circuitHeight,
  startLngLat,
  startAlt,
  panPath,
  role,
}) {
  if (!cells || cells.length < 2 || !dem || !ground || !altitudes) {
    return { lines: [], discs: [] };
  }

  const ctx = {
    dem,
    altitudes,
    ground,
    originX,
    originY,
    maxAltitude,
    glideRatio,
    circuitHeight,
  };
  const safetyLd = glideRatio * 0.8;
  const proof = proofAltitudeAt(cells[0].x, cells[0].y, ctx);
  const belowCone =
    !panPath &&
    Number.isFinite(startAlt) &&
    proof != null &&
    startAlt < proof &&
    safetyLd > 0;

  let belowCritSeg = 0;
  if (belowCone) {
    for (let i = 1; i < cells.length; i += 1) {
      const from = cells[i - 1];
      const to = cells[i];
      const geoFrom = i === 1 && startLngLat ? startLngLat : gridCellToLngLat(from.x, from.y, dem);
      const geoTo = gridCellToLngLat(to.x, to.y, dem);
      const hFrom = storedAltitude(altitudes, maxAltitude, cellIndex(from.x, from.y, dem));
      const hTo = storedAltitude(altitudes, maxAltitude, cellIndex(to.x, to.y, dem));
      if (hFrom == null || hTo == null || hFrom <= hTo) {
        continue;
      }
      const dist = distanceMetres(geoFrom.lat, geoFrom.lng, geoTo.lat, geoTo.lng);
      if (dist <= 0) {
        continue;
      }
      if (dist / (hFrom - hTo) < safetyLd) {
        belowCritSeg = i;
        break;
      }
    }
  }

  let altitude = 0;
  let trackAlt = false;
  let awaitFirst = false;
  const discs = [];

  if (belowCritSeg > 0) {
    const critCell = cells[belowCritSeg - 1];
    const stored = storedAltitude(altitudes, maxAltitude, cellIndex(critCell.x, critCell.y, dem));
    if (stored != null && safetyLd > 0) {
      altitude = stored;
      trackAlt = true;
    }
    if (belowCritSeg > 1) {
      pushDisc(discs, gridCellToLngLat(critCell.x, critCell.y, dem), role);
    }
  } else if (panPath && ground[cellIndex(cells[0].x, cells[0].y, dem)] === 1) {
    const stored = storedAltitude(altitudes, maxAltitude, cellIndex(cells[0].x, cells[0].y, dem));
    if (stored != null && safetyLd > 0) {
      altitude = stored;
      trackAlt = true;
    }
  } else if (panPath) {
    awaitFirst = true;
  } else if (Number.isFinite(startAlt) && safetyLd > 0) {
    altitude = startAlt;
    trackAlt = true;
  }

  const lines = [];
  let segment = null;
  let coordinates = [];
  const flush = () => {
    if (coordinates.length >= 2) {
      lines.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: { role, segment },
      });
    }
    coordinates = [];
    segment = null;
  };

  for (let i = 1; i < cells.length; i += 1) {
    const from = cells[i - 1];
    const to = cells[i];
    const geoFrom = i === 1 && startLngLat ? startLngLat : gridCellToLngLat(from.x, from.y, dem);
    const geoTo = gridCellToLngLat(to.x, to.y, dem);
    const inBelow = belowCritSeg > 0 && i <= belowCritSeg;
    const pastResume = belowCritSeg === 0 || i >= belowCritSeg;
    const dist = distanceMetres(geoFrom.lat, geoFrom.lng, geoTo.lat, geoTo.lng);
    if (pastResume && trackAlt && safetyLd > 0) {
      altitude -= dist / safetyLd;
    }

    const fromGround = ground[cellIndex(from.x, from.y, dem)] === 1;
    const toGround = ground[cellIndex(to.x, to.y, dem)] === 1;
    const hTo = storedAltitude(altitudes, maxAltitude, cellIndex(to.x, to.y, dem));
    if (pastResume && (trackAlt || awaitFirst) && !fromGround && toGround && hTo != null) {
      if (awaitFirst) {
        pushDisc(discs, geoTo, role);
        altitude = hTo;
        trackAlt = safetyLd > 0;
        awaitFirst = false;
      } else if (altitude < hTo) {
        pushDisc(discs, geoTo, role);
        altitude = hTo;
      }
    }

    const nextSegment = inBelow ? "below-red" : isDownhillGround(from, to, ground, dem) ? "ground" : "default";
    const fromCoord = [geoFrom.lng, geoFrom.lat];
    const toCoord = [geoTo.lng, geoTo.lat];
    if (segment === nextSegment && coordinates.length > 0) {
      coordinates.push(toCoord);
    } else {
      flush();
      segment = nextSegment;
      coordinates = [fromCoord, toCoord];
    }
  }
  flush();
  return { lines, discs };
}
