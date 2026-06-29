import {
  formatCoord,
  gridBoundsLngLat,
  gridCellDistanceM,
  gridCellToLngLat,
  gridIndexFromLngLat,
  pickTerrainZoom,
  metersPerPixel,
} from "./geo.js";
import { buildDemGrid, sampleElevationAt } from "./dem.js";
import { GlideConeEngine } from "./glidecone.js";

const DEFAULT_MAX_ALTITUDE = 4050;
const MAP_CENTER = { lng: 9.0788, lat: 47.1194 };
const INITIAL_TERRAIN_Z = pickTerrainZoom(MAP_CENTER.lat);
const MAP_MAX_ZOOM = 22;

const EMPTY_PATH = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: [] },
  properties: {},
};

const info = document.getElementById("info");
const latEl = document.getElementById("lat");
const lngEl = document.getElementById("lng");
const elevationEl = document.getElementById("elevation");
const statusEl = document.getElementById("status");
const pathMetaEl = document.getElementById("path-meta");
const pathCellEl = document.getElementById("path-cell");
const pathOriginEl = document.getElementById("path-origin");
const pathStopEl = document.getElementById("path-stop");
const hoverTip = document.getElementById("hover-tip");
const paramsForm = document.getElementById("params");
const compareLosBtn = document.getElementById("compare-los");
const stopComputeBtn = document.getElementById("stop-compute");

let engine = null;
let computing = false;
let computeShouldStop = false;
let overlayCanvas = null;
let compareOverlayCanvas = null;
let coneState = null;
let pathLayerReady = false;
let lastHoverCell = null;

function startComputeSession() {
  computeShouldStop = false;
  computing = true;
  stopComputeBtn.hidden = false;
  stopComputeBtn.disabled = false;
}

function endComputeSession() {
  computing = false;
  computeShouldStop = false;
  stopComputeBtn.hidden = true;
  stopComputeBtn.disabled = false;
}

function requestStopCompute() {
  computeShouldStop = true;
  stopComputeBtn.disabled = true;
  setStatus("Stopping after current GPU step…");
}

function formatComputeDone(result, extra = "") {
  const suffix = result.stopped ? " (stopped)" : "";
  return `Done — ${result.iterations} iters, ${result.elapsedMs.toFixed(0)} ms GPU${suffix}${extra}`;
}

function makeComputeOptions(dem) {
  return {
    onProgress: makeComputeProgressHandler(dem),
    shouldStop: () => computeShouldStop,
  };
}

function getGlideParams() {
  const glideRatio = Number.parseFloat(document.getElementById("ld").value);
  const circuitHeight = Number.parseFloat(document.getElementById("circuit").value);
  const groundClearance = Number.parseFloat(document.getElementById("clearance").value);
  const maxAltitude = Number.parseFloat(document.getElementById("max-alt").value);
  const originRunN = Number.parseInt(document.getElementById("los-run").value, 10);
  const updateMapMs = Number.parseInt(document.getElementById("update-map").value, 10);
  const raw = document.getElementById("raw").checked;

  return {
    glideRatio: Number.isFinite(glideRatio) && glideRatio > 0 ? glideRatio : 20,
    circuitHeight: Number.isFinite(circuitHeight) && circuitHeight >= 0 ? circuitHeight : 250,
    groundClearance:
      Number.isFinite(groundClearance) && groundClearance >= 0 ? groundClearance : 100,
    maxAltitude:
      Number.isFinite(maxAltitude) && maxAltitude > 0 ? maxAltitude : DEFAULT_MAX_ALTITUDE,
    originRunN:
      Number.isFinite(originRunN) && originRunN === 0
        ? 0
        : Number.isFinite(originRunN) && originRunN >= 1
          ? originRunN
          : 0,
    raw,
    updateMapMs:
      Number.isFinite(updateMapMs) && updateMapMs >= 0 ? updateMapMs : 100,
  };
}

const map = new maplibregl.Map({
  container: "map",
  hash: "map",
  zoom: INITIAL_TERRAIN_Z,
  maxZoom: MAP_MAX_ZOOM,
  center: [MAP_CENTER.lng, MAP_CENTER.lat],
  style: {
    version: 8,
    sources: {
      hillshadeSource: {
        type: "raster-dem",
        url: "https://tiles.mapterhorn.com/tilejson.json",
        encoding: "terrarium",
        tileSize: 512,
        maxzoom: INITIAL_TERRAIN_Z,
      },
    },
    layers: [
      {
        id: "hillshade",
        type: "hillshade",
        source: "hillshadeSource",
        paint: {
          "hillshade-shadow-color": "#473b24",
          "hillshade-highlight-color": "#ffffff",
          "hillshade-accent-color": "#5c4a2f",
          "hillshade-exaggeration": 0.5,
        },
      },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl(), "top-right");

function setStatus(text) {
  statusEl.textContent = text;
}

function setTerrainTileMaxZoom(zoom) {
  const style = map.getStyle();
  if (!style?.sources?.hillshadeSource) {
    return;
  }

  style.sources.hillshadeSource.maxzoom = zoom;

  const cache = map.style?.sourceCaches?.hillshadeSource;
  if (cache?._source) {
    cache._source.maxzoom = zoom;
    cache.reload();
  }
}

function raisePathLayer() {
  if (pathLayerReady && map.getLayer("glide-path")) {
    map.moveLayer("glide-path");
  }
}

function ensurePathLayer() {
  if (pathLayerReady) {
    return;
  }
  map.addSource("glide-path", {
    type: "geojson",
    data: EMPTY_PATH,
  });
  map.addLayer({
    id: "glide-path",
    type: "line",
    source: "glide-path",
    paint: {
      "line-color": "#ffcc00",
      "line-width": 3,
      "line-opacity": 0.95,
    },
  });
  pathLayerReady = true;
  raisePathLayer();
}

function setConeState(dem, result, glideParams) {
  coneState = {
    dem,
    altitudes: result.altitudes,
    originX: result.originX,
    originY: result.originY,
    ground: result.ground,
    imageData: result.imageData,
    maxAltitude: glideParams?.maxAltitude ?? DEFAULT_MAX_ALTITUDE,
    raw: glideParams?.raw ?? true,
    glideRatio: glideParams?.glideRatio ?? 20,
    circuitHeight: glideParams?.circuitHeight ?? 250,
  };
}

function traceOriginRelayPath(x, y, dem, originX, originY) {
  let totalDistM = 0;
  let cx = x;
  let cy = y;
  const visited = new Set();
  const maxSteps = dem.width + dem.height;

  for (let step = 0; step < maxSteps; step += 1) {
    const key = cellKey(cx, cy);
    if (visited.has(key)) {
      return { distanceM: totalDistM, seedX: cx, seedY: cy, complete: false };
    }
    visited.add(key);

    const idx = cellIndex(cx, cy, dem);
    const ox = originX[idx];
    const oy = originY[idx];
    if (ox < 0 || oy < 0) {
      return null;
    }

    totalDistM += gridCellDistanceM(cx, cy, ox, oy, dem);

    if (ox === cx && oy === cy) {
      return { distanceM: totalDistM, seedX: cx, seedY: cy, complete: true };
    }

    cx = ox;
    cy = oy;
  }

  return { distanceM: totalDistM, seedX: cx, seedY: cy, complete: false };
}

function seedAltitudeAt(dem, seedIdx, circuitHeight) {
  return dem.elevation[seedIdx] - dem.groundClearance + circuitHeight;
}

function seedPathMetrics(cell) {
  const { dem, originX, originY, ground, glideRatio, circuitHeight } = coneState;
  const path = traceOriginRelayPath(cell.gi, cell.gj, dem, originX, originY);
  if (!path) {
    return null;
  }

  const seedIdx = cellIndex(path.seedX, path.seedY, dem);
  const seedAlt = seedAltitudeAt(dem, seedIdx, circuitHeight);
  const requiredAlt = seedAlt + path.distanceM / glideRatio;

  return {
    distanceM: path.distanceM,
    requiredAlt,
    seedAlt,
    isGroundSeed: ground[seedIdx] === 1,
    complete: path.complete,
  };
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function cellIndex(x, y, dem) {
  return y * dem.width + x;
}

function pushPathPoint(coordinates, x, y, dem) {
  const pt = gridCellToLngLat(x, y, dem);
  const last = coordinates[coordinates.length - 1];
  if (last && last[0] === pt.lng && last[1] === pt.lat) {
    return;
  }
  coordinates.push([pt.lng, pt.lat]);
}

function formatCellPair(x, y) {
  if (x < 0 || y < 0) {
    return "—";
  }
  return `${x}, ${y}`;
}

function traceGlidePath(gi, gj) {
  const { dem, originX, originY } = coneState;
  const coordinates = [];
  const visited = new Set();
  let x = gi;
  let y = gj;
  let stopReason = null;
  const maxSteps = (dem.width + dem.height) * 2;

  for (let step = 0; step < maxSteps; step += 1) {
    const key = cellKey(x, y);
    if (visited.has(key)) {
      stopReason = "loop";
      break;
    }
    visited.add(key);

    pushPathPoint(coordinates, x, y, dem);

    if (x === dem.homeX && y === dem.homeY) {
      stopReason = "home";
      break;
    }

    const idx = cellIndex(x, y, dem);
    const nx = originX[idx];
    const ny = originY[idx];
    if (nx < 0 || ny < 0 || (nx === x && ny === y)) {
      stopReason = "stalled";
      break;
    }

    x = nx;
    y = ny;
  }

  if (stopReason === null) {
    stopReason = "maxSteps";
  }

  const lastIdx = cellIndex(x, y, dem);
  return {
    coordinates,
    stopReason,
    lastCell: {
      x,
      y,
      ox: originX[lastIdx],
      oy: originY[lastIdx],
    },
  };
}

function refreshHoverPath(cell) {
  const { coordinates, lastCell, stopReason } = traceGlidePath(cell.gi, cell.gj);
  if (coordinates.length >= 2) {
    updateGlidePath(coordinates);
    updatePathMeta(lastCell, stopReason);
  } else if (coordinates.length === 1) {
    const pt = coordinates[0];
    updateGlidePath([pt, pt]);
    updatePathMeta(lastCell, stopReason);
  } else {
    clearGlidePath();
  }
}

function setCompareButtonVisible(visible) {
  compareLosBtn.hidden = !visible;
}

function clearCompareOverlay() {
  if (map.getLayer("glide-cone-full")) {
    map.removeLayer("glide-cone-full");
  }
  if (map.getSource("glide-cone-full")) {
    map.removeSource("glide-cone-full");
  }
}

function updateCompareOverlay(imageData, dem) {
  if (!compareOverlayCanvas) {
    compareOverlayCanvas = document.createElement("canvas");
  }
  compareOverlayCanvas.width = imageData.width;
  compareOverlayCanvas.height = imageData.height;
  compareOverlayCanvas.getContext("2d").putImageData(imageData, 0, 0);

  const coords = gridBoundsLngLat(dem.gx0, dem.gy0, dem.width, dem.height, dem.zoom);
  const coordinates = [
    [coords[0].lng, coords[0].lat],
    [coords[1].lng, coords[1].lat],
    [coords[2].lng, coords[2].lat],
    [coords[3].lng, coords[3].lat],
  ];

  if (map.getSource("glide-cone-full")) {
    map.getSource("glide-cone-full").updateImage({
      url: compareOverlayCanvas.toDataURL(),
      coordinates,
    });
    raisePathLayer();
    return;
  }

  map.addSource("glide-cone-full", {
    type: "image",
    url: compareOverlayCanvas.toDataURL(),
    coordinates,
  });

  map.addLayer({
    id: "glide-cone-full",
    type: "raster",
    source: "glide-cone-full",
    paint: {
      "raster-opacity": 1,
    },
  });
  raisePathLayer();
}

function updateOverlay(imageData, dem) {
  if (!overlayCanvas) {
    overlayCanvas = document.createElement("canvas");
  }
  overlayCanvas.width = imageData.width;
  overlayCanvas.height = imageData.height;
  overlayCanvas.getContext("2d").putImageData(imageData, 0, 0);

  const coords = gridBoundsLngLat(dem.gx0, dem.gy0, dem.width, dem.height, dem.zoom);
  const coordinates = [
    [coords[0].lng, coords[0].lat],
    [coords[1].lng, coords[1].lat],
    [coords[2].lng, coords[2].lat],
    [coords[3].lng, coords[3].lat],
  ];

  if (map.getSource("glide-cone")) {
    map.getSource("glide-cone").updateImage({
      url: overlayCanvas.toDataURL(),
      coordinates,
    });
    raisePathLayer();
    return;
  }

  map.addSource("glide-cone", {
    type: "image",
    url: overlayCanvas.toDataURL(),
    coordinates,
  });

  map.addLayer({
    id: "glide-cone",
    type: "raster",
    source: "glide-cone",
    paint: {
      "raster-opacity": 1,
    },
  });
  raisePathLayer();
}

function sampleDemCell(lng, lat) {
  if (!coneState) {
    return null;
  }

  const { dem, altitudes, ground, maxAltitude, originX, originY } = coneState;
  const { gi, gj } = gridIndexFromLngLat(lng, lat, dem);

  if (gi < 0 || gj < 0 || gi >= dem.width || gj >= dem.height) {
    return null;
  }

  const idx = gj * dem.width + gi;
  const groundElev = dem.elevation[idx] - dem.groundClearance;
  const alt = altitudes[idx];
  const hasOrigin = originX[idx] >= 0 && originY[idx] >= 0;
  const isGroundCell = ground[idx] === 1;
  const isReachable = Number.isFinite(alt) && alt < maxAltitude && hasOrigin;

  return {
    gi,
    gj,
    idx,
    groundElev,
    alt: isReachable ? alt : null,
    isReachable,
    isGround: isGroundCell,
    isCone: isReachable && !isGroundCell,
  };
}

function formatDistanceKm(distanceM) {
  return `${(distanceM / 1000).toFixed(1)} km`;
}

function formatHoverTip(cell) {
  const minAltVal = cell.alt;
  const minAlt = minAltVal !== null ? `${Math.round(minAltVal)} m` : "—";
  const groundElev = `${Math.round(cell.groundElev)} m`;
  const metrics = seedPathMetrics(cell);
  const distanceLine =
    metrics !== null ? formatDistanceKm(metrics.distanceM) : "—";
  const requiredLine =
    metrics !== null ? `${Math.round(metrics.requiredAlt)} m` : "—";

  let deltaLine = "—";
  if (minAltVal !== null && metrics !== null) {
    const delta = Math.round(minAltVal - metrics.requiredAlt);
    const sign = delta > 0 ? "+" : "";
    const cls = delta >= 0 ? "delta-pos" : "delta-neg";
    deltaLine = `<span class="${cls}">${sign}${delta} m</span>`;
  }

  return (
    `minimum alt: ${minAlt}\n` +
    `ground elevation: ${groundElev}\n` +
    `distance to seed: ${distanceLine}\n` +
    `required alt: ${requiredLine}\n` +
    `delta: ${deltaLine}`
  );
}

function updateGlidePath(coordinates) {
  ensurePathLayer();
  map.getSource("glide-path").setData({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates,
    },
    properties: {},
  });
  raisePathLayer();
}

function clearPathMeta() {
  pathMetaEl.hidden = true;
  pathCellEl.textContent = "—";
  pathOriginEl.textContent = "—";
  pathStopEl.hidden = true;
  pathStopEl.textContent = "";
}

function updatePathMeta(lastCell, stopReason) {
  pathMetaEl.hidden = false;
  pathCellEl.textContent = formatCellPair(lastCell.x, lastCell.y);
  pathOriginEl.textContent = formatCellPair(lastCell.ox, lastCell.oy);
  const stopMessages = {
    loop: "stopped: loop",
    stalled: "stopped: stalled",
    maxSteps: "stopped: max steps",
  };
  if (stopMessages[stopReason]) {
    pathStopEl.hidden = false;
    pathStopEl.textContent = stopMessages[stopReason];
  } else {
    pathStopEl.hidden = true;
    pathStopEl.textContent = "";
  }
}

function clearGlidePath() {
  if (!pathLayerReady) {
    return;
  }
  map.getSource("glide-path").setData(EMPTY_PATH);
  clearPathMeta();
}

function makeComputeProgressHandler(dem) {
  return ({ imageData, iteration, elapsedMs }) => {
    updateOverlay(imageData, dem);
    setTerrainTileMaxZoom(dem.zoom);
    setStatus(`Computing… iter ${iteration}, ${elapsedMs.toFixed(0)} ms GPU`);
  };
}

async function ensureEngine() {
  if (!engine) {
    engine = new GlideConeEngine();
    await engine.init();
  }
  return engine;
}

map.on("load", async () => {
  setTerrainTileMaxZoom(INITIAL_TERRAIN_Z);
  info.classList.add("visible");
  ensurePathLayer();
  try {
    await ensureEngine();
    setStatus("WebGPU ready — click the map to compute a glide cone");
  } catch (error) {
    setStatus(error.message);
    console.error(error);
  }
});

map.on("mousemove", (event) => {
  const cell = sampleDemCell(event.lngLat.lng, event.lngLat.lat);
  if (cell === null) {
    hoverTip.style.display = "none";
    lastHoverCell = null;
    clearGlidePath();
    return;
  }

  hoverTip.style.display = "block";
  hoverTip.style.left = `${event.point.x + 14}px`;
  hoverTip.style.top = `${event.point.y + 14}px`;
  hoverTip.innerHTML = formatHoverTip(cell);

  if (cell.isReachable) {
    lastHoverCell = cell;
    refreshHoverPath(cell);
  } else {
    lastHoverCell = null;
    clearGlidePath();
  }
});

map.on("mouseleave", () => {
  hoverTip.style.display = "none";
  lastHoverCell = null;
  clearGlidePath();
});

paramsForm.addEventListener("submit", (event) => {
  event.preventDefault();
});

document.getElementById("raw").addEventListener("change", () => {
  if (coneState && !computing) {
    recomputeFromConeState();
  }
});

stopComputeBtn.addEventListener("click", () => {
  if (computing) {
    requestStopCompute();
  }
});

async function recomputeFromConeState() {
  if (!coneState || computing) {
    return;
  }

  startComputeSession();
  clearGlidePath();
  setStatus("Recomputing overlay…");

  try {
    const glideParams = getGlideParams();
    const gpu = await ensureEngine();
    const result = await gpu.compute(coneState.dem, glideParams, makeComputeOptions(coneState.dem));
    setConeState(coneState.dem, result, glideParams);
    updateOverlay(result.imageData, coneState.dem);
    setStatus(
      formatComputeDone(result, glideParams.raw ? " (raw)" : "")
    );
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  } finally {
    endComputeSession();
  }
}

compareLosBtn.addEventListener("click", () => {
  runFullBresenhamCompare();
});

async function runFullBresenhamCompare() {
  if (!coneState || computing) {
    return;
  }

  startComputeSession();
  compareLosBtn.disabled = true;
  setStatus("Running full Bresenham on current grid…");

  try {
    const gpu = await ensureEngine();
    const result = await gpu.compute(coneState.dem, getGlideParams(), {
      fullBresenham: true,
      overlayColor: "red",
      imageOnly: true,
      raw: false,
      shouldStop: () => computeShouldStop,
    });
    updateCompareOverlay(result.imageData, coneState.dem);
    setStatus(formatComputeDone(result));
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  } finally {
    endComputeSession();
    compareLosBtn.disabled = false;
  }
}

async function runComputation(lng, lat) {
  if (computing) {
    return;
  }

  const glideParams = getGlideParams();
  info.classList.add("visible");
  latEl.textContent = formatCoord(lat, true);
  lngEl.textContent = formatCoord(lng, false);
  elevationEl.textContent = "…";
  setStatus("Sampling terrain…");
  hoverTip.style.display = "none";
  clearGlidePath();
  clearCompareOverlay();
  setCompareButtonVisible(false);

  startComputeSession();

  try {
    const terrainZ = pickTerrainZoom(lat);
    const cellSizeM = metersPerPixel(lat, terrainZ);
    const pointElev = await sampleElevationAt(lng, lat);
    elevationEl.textContent = `${Math.round(pointElev)} m`;

    setStatus(
      `Fetching DEM z${terrainZ} (~${Math.round(cellSizeM)} m) — L/D ${glideParams.glideRatio}, circuit ${glideParams.circuitHeight} m, ground ${glideParams.groundClearance} m, max alt ${glideParams.maxAltitude} m…`
    );
    const dem = await buildDemGrid(lng, lat, glideParams);

    if (computeShouldStop) {
      setStatus("Stopped before GPU compute");
      return;
    }

    setStatus(
      `Computing ${dem.width}×${dem.height} grid (${dem.tileCount} tiles) on GPU…`
    );
    const gpu = await ensureEngine();
    const result = await gpu.compute(dem, glideParams, makeComputeOptions(dem));

    setConeState(dem, result, glideParams);
    setTerrainTileMaxZoom(dem.zoom);
    updateOverlay(result.imageData, dem);
    ensurePathLayer();
    setCompareButtonVisible(true);

    setStatus(
      formatComputeDone(
        result,
        ` — z${dem.zoom}, ${Math.round(dem.cellSizeM)} m`
      )
    );
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  } finally {
    endComputeSession();
  }
}

map.on("click", (event) => {
  runComputation(event.lngLat.lng, event.lngLat.lat);
});
