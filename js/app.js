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
const MAX_GRID_DIM = 1024;

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
const hoverTip = document.getElementById("hover-tip");
const paramsForm = document.getElementById("params");

let engine = null;
let computing = false;
let overlayCanvas = null;
let coneState = null;
let pathLayerReady = false;

function getGlideParams() {
  const glideRatio = Number.parseFloat(document.getElementById("ld").value);
  const circuitHeight = Number.parseFloat(document.getElementById("circuit").value);
  const groundClearance = Number.parseFloat(document.getElementById("clearance").value);

  return {
    glideRatio: Number.isFinite(glideRatio) && glideRatio > 0 ? glideRatio : 20,
    circuitHeight: Number.isFinite(circuitHeight) && circuitHeight >= 0 ? circuitHeight : 250,
    groundClearance:
      Number.isFinite(groundClearance) && groundClearance >= 0 ? groundClearance : 100,
    maxAltitude: MAX_ALTITUDE,
    maxGridDim: MAX_GRID_DIM,
  };
}

const map = new maplibregl.Map({
  container: "map",
  hash: "map",
  zoom: 10.5,
  center: [9.0788, 47.1194],
  style: {
    version: 8,
    sources: {
      hillshadeSource: {
        type: "raster-dem",
        url: "https://tiles.mapterhorn.com/tilejson.json",
        encoding: "terrarium",
        tileSize: 512,
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

function setConeState(dem, result) {
  coneState = {
    dem,
    altitudes: result.altitudes,
    originX: result.originX,
    originY: result.originY,
    ground: result.ground,
    imageData: result.imageData,
    maxAltitude: MAX_ALTITUDE,
  };
}

const NEIGHBORS_8 = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

function cellKey(x, y) {
  return `${x},${y}`;
}

function inGrid(x, y, dem) {
  return x >= 0 && y >= 0 && x < dem.width && y < dem.height;
}

function cellIndex(x, y, dem) {
  return y * dem.width + x;
}

function distToHomeSq(x, y, dem) {
  const dx = x - dem.homeX;
  const dy = y - dem.homeY;
  return dx * dx + dy * dy;
}

function isAtHome(x, y, dem) {
  return x === dem.homeX && y === dem.homeY;
}

function pushPathPoint(coordinates, x, y, dem) {
  const pt = gridCellToLngLat(x, y, dem);
  const last = coordinates[coordinates.length - 1];
  if (last && last[0] === pt.lng && last[1] === pt.lat) {
    return;
  }
  coordinates.push([pt.lng, pt.lat]);
}

function getCellState(x, y) {
  const { dem, altitudes, ground, originX, originY, maxAltitude } = coneState;
  if (!inGrid(x, y, dem)) {
    return null;
  }

  const idx = cellIndex(x, y, dem);
  const alt = altitudes[idx];
  const unreachable = !Number.isFinite(alt) || alt >= maxAltitude;
  const isGroundCell = ground[idx] === 1;
  const ox = originX[idx];
  const oy = originY[idx];
  const hasOrigin = ox >= 0 && oy >= 0;

  return {
    x,
    y,
    idx,
    elev: dem.elevation[idx],
    isGround: isGroundCell,
    isCone: !unreachable && !isGroundCell && hasOrigin,
    unreachable,
    ox,
    oy,
    selfOrigin: hasOrigin && ox === x && oy === y,
  };
}

function pickLowestNeighbor(x, y, currentElev) {
  const { dem } = coneState;
  const candidates = [];

  for (const [dx, dy] of NEIGHBORS_8) {
    const nx = x + dx;
    const ny = y + dy;
    const neighbor = getCellState(nx, ny);
    if (!neighbor || neighbor.unreachable) {
      continue;
    }
    if (!neighbor.isGround && !neighbor.isCone) {
      continue;
    }
    candidates.push(neighbor);
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    if (a.elev !== b.elev) {
      return a.elev - b.elev;
    }
    if (a.isCone !== b.isCone) {
      return a.isCone ? -1 : 1;
    }
    return distToHomeSq(a.x, a.y, dem) - distToHomeSq(b.x, b.y, dem);
  });

  const lowest = candidates[0];
  if (lowest.elev > currentElev + 0.01) {
    return null;
  }

  return lowest;
}

function traceOriginPath(gi, gj) {
  const { dem } = coneState;
  const coordinates = [];
  const visited = new Set();
  let x = gi;
  let y = gj;
  let mode = "ORIGIN_CHAIN";
  const maxSteps = (dem.width + dem.height) * 4;

  for (let step = 0; step < maxSteps; step += 1) {
    const key = cellKey(x, y);
    if (visited.has(key)) {
      break;
    }
    visited.add(key);

    pushPathPoint(coordinates, x, y, dem);

    if (isAtHome(x, y, dem)) {
      break;
    }

    const state = getCellState(x, y);
    if (!state || state.unreachable) {
      break;
    }

    if (mode === "ORIGIN_CHAIN") {
      if (!state.isGround && !state.selfOrigin) {
        const { ox, oy } = state;
        if (ox < 0 || oy < 0) {
          break;
        }

        if (isAtHome(ox, oy, dem)) {
          pushPathPoint(coordinates, dem.homeX, dem.homeY, dem);
          break;
        }

        x = ox;
        y = oy;
        continue;
      }

      mode = "GROUND_DESCENT";
    }

    const next = pickLowestNeighbor(x, y, state.elev);
    if (!next) {
      break;
    }

    x = next.x;
    y = next.y;
    mode = next.isCone ? "ORIGIN_CHAIN" : "GROUND_DESCENT";
  }

  return coordinates;
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

function sampleConeCell(lng, lat) {
  if (!coneState) {
    return null;
  }

  const { dem, altitudes, ground, maxAltitude } = coneState;
  const { gi, gj } = gridIndexFromLngLat(lng, lat, dem);

  if (gi < 0 || gj < 0 || gi >= dem.width || gj >= dem.height) {
    return null;
  }

  const idx = gj * dem.width + gi;
  const alt = altitudes[idx];
  if (!Number.isFinite(alt) || alt >= maxAltitude || ground[idx] === 1) {
    return null;
  }

  return { gi, gj, alt, idx };
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

function clearGlidePath() {
  if (!pathLayerReady) {
    return;
  }
  map.getSource("glide-path").setData(EMPTY_PATH);
}

async function ensureEngine() {
  if (!engine) {
    engine = new GlideConeEngine();
    await engine.init();
  }
  return engine;
}

map.on("load", async () => {
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
  const cell = sampleConeCell(event.lngLat.lng, event.lngLat.lat);
  if (cell === null) {
    hoverTip.style.display = "none";
    clearGlidePath();
    return;
  }

  hoverTip.style.display = "block";
  hoverTip.style.left = `${event.point.x + 14}px`;
  hoverTip.style.top = `${event.point.y + 14}px`;
  hoverTip.textContent = `${Math.round(cell.alt)} m`;

  const path = traceOriginPath(cell.gi, cell.gj);
  if (path.length >= 2) {
    updateGlidePath(path);
  } else {
    clearGlidePath();
  }
});

map.on("mouseleave", () => {
  hoverTip.style.display = "none";
  clearGlidePath();
});

paramsForm.addEventListener("submit", (event) => {
  event.preventDefault();
});

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

  computing = true;

  try {
    const terrainZ = pickTerrainZoom(lat);
    const cellSizeM = metersPerPixel(lat, terrainZ);
    const pointElev = await sampleElevationAt(lng, lat);
    elevationEl.textContent = `${Math.round(pointElev)} m`;

    setStatus(
      `Fetching DEM z${terrainZ} (~${Math.round(cellSizeM)} m) — L/D ${glideParams.glideRatio}, circuit ${glideParams.circuitHeight} m, ground ${glideParams.groundClearance} m…`
    );
    const dem = await buildDemGrid(lng, lat, glideParams);

    setStatus(
      `Computing ${dem.width}×${dem.height} grid (${dem.tileCount} tiles) on GPU…`
    );
    const gpu = await ensureEngine();
    const result = await gpu.compute(dem, glideParams);

    setConeState(dem, result);
    updateOverlay(result.imageData, dem);
    ensurePathLayer();

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
