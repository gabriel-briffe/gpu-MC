import {
  formatCoord,
  gridBoundsLngLat,
  gridCellToLngLat,
  gridIndexFromLngLat,
  pickTerrainZoom,
  metersPerPixel,
} from "./geo.js";
import { buildDemGrid, sampleElevationAt } from "./dem.js";
import { GlideConeEngine } from "./glidecone.js";

const MAX_ALTITUDE = 4200;
const DEFAULT_GRID_MAX = 512;
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

let engine = null;
let computing = false;
let overlayCanvas = null;
let compareOverlayCanvas = null;
let coneState = null;
let pathLayerReady = false;
let lastHoverCell = null;

function getGlideParams() {
  const glideRatio = Number.parseFloat(document.getElementById("ld").value);
  const circuitHeight = Number.parseFloat(document.getElementById("circuit").value);
  const groundClearance = Number.parseFloat(document.getElementById("clearance").value);
  const originRunN = Number.parseInt(document.getElementById("los-run").value, 10);
  const maxGridDim = Number.parseInt(document.getElementById("grid-max").value, 10);
  const raw = document.getElementById("raw").checked;

  return {
    glideRatio: Number.isFinite(glideRatio) && glideRatio > 0 ? glideRatio : 20,
    circuitHeight: Number.isFinite(circuitHeight) && circuitHeight >= 0 ? circuitHeight : 250,
    groundClearance:
      Number.isFinite(groundClearance) && groundClearance >= 0 ? groundClearance : 100,
    originRunN:
      Number.isFinite(originRunN) && originRunN === 0
        ? 0
        : Number.isFinite(originRunN) && originRunN >= 1
          ? originRunN
          : 0,
    maxGridDim:
      Number.isFinite(maxGridDim) && maxGridDim >= 64 ? maxGridDim : DEFAULT_GRID_MAX,
    maxAltitude: MAX_ALTITUDE,
    raw,
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
    maxAltitude: MAX_ALTITUDE,
    raw: glideParams?.raw ?? true,
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

function formatHoverTip(cell) {
  const elev = `${Math.round(cell.groundElev)} m ground`;
  if (cell.alt !== null) {
    const kind = cell.isGround ? "ground" : "air";
    return `${Math.round(cell.alt)} m alt · ${kind} · ${elev}`;
  }
  return elev;
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
  hoverTip.textContent = formatHoverTip(cell);

  if (coneState.raw ? cell.isReachable : cell.isCone) {
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

async function recomputeFromConeState() {
  if (!coneState || computing) {
    return;
  }

  computing = true;
  clearGlidePath();
  setStatus("Recomputing overlay…");

  try {
    const glideParams = getGlideParams();
    const gpu = await ensureEngine();
    const result = await gpu.compute(coneState.dem, glideParams);
    setConeState(coneState.dem, result, glideParams);
    updateOverlay(result.imageData, coneState.dem);
    setStatus(
      `Done — ${result.iterations} iters, ${result.elapsedMs.toFixed(0)} ms GPU` +
        (glideParams.raw ? " (raw)" : "")
    );
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  } finally {
    computing = false;
  }
}

compareLosBtn.addEventListener("click", () => {
  runFullBresenhamCompare();
});

async function runFullBresenhamCompare() {
  if (!coneState || computing) {
    return;
  }

  computing = true;
  compareLosBtn.disabled = true;
  setStatus("Running full Bresenham on current grid…");

  try {
    const gpu = await ensureEngine();
    const result = await gpu.compute(coneState.dem, getGlideParams(), {
      fullBresenham: true,
      overlayColor: "red",
      imageOnly: true,
      raw: false,
    });
    updateCompareOverlay(result.imageData, coneState.dem);
    setStatus(
      `Full Bresenham overlay — ${result.iterations} iters, ${result.elapsedMs.toFixed(0)} ms GPU`
    );
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  } finally {
    computing = false;
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

  computing = true;

  try {
    const terrainZ = pickTerrainZoom(lat);
    const cellSizeM = metersPerPixel(lat, terrainZ);
    const pointElev = await sampleElevationAt(lng, lat);
    elevationEl.textContent = `${Math.round(pointElev)} m`;

    setStatus(
      `Fetching DEM z${terrainZ} (~${Math.round(cellSizeM)} m) — L/D ${glideParams.glideRatio}, circuit ${glideParams.circuitHeight} m, ground ${glideParams.groundClearance} m, grid max ${glideParams.maxGridDim} px…`
    );
    const dem = await buildDemGrid(lng, lat, glideParams);

    setStatus(
      `Computing ${dem.width}×${dem.height} grid (${dem.tileCount} tiles) on GPU…`
    );
    const gpu = await ensureEngine();
    const result = await gpu.compute(dem, glideParams);

    setConeState(dem, result, glideParams);
    setTerrainTileMaxZoom(dem.zoom);
    updateOverlay(result.imageData, dem);
    ensurePathLayer();
    setCompareButtonVisible(true);

    setStatus(
      `Done — z${dem.zoom}, ${Math.round(dem.cellSizeM)} m, ${result.iterations} iters, ${result.elapsedMs.toFixed(0)} ms GPU` +
        (dem.capped ? ` (grid capped at ${dem.width}px)` : "")
    );
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  } finally {
    computing = false;
  }
}

map.on("click", (event) => {
  runComputation(event.lngLat.lng, event.lngLat.lat);
});
