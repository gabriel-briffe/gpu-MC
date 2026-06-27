import {
  formatCoord,
  gridBoundsLngLat,
  lngLatToGlobalPixel,
  pickTerrainZoom,
  metersPerPixel,
} from "./geo.js";
import { buildDemGrid, sampleElevationAt } from "./dem.js";
import { GlideConeEngine } from "./glidecone.js";

const MAX_ALTITUDE = 4200;
const MAX_GRID_DIM = 1024;

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

function setConeState(dem, result) {
  coneState = {
    dem,
    altitudes: result.altitudes,
    imageData: result.imageData,
    maxAltitude: MAX_ALTITUDE,
  };
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
}

function sampleConeAltitude(lng, lat) {
  if (!coneState) {
    return null;
  }

  const { dem, altitudes, maxAltitude } = coneState;
  const { gx, gy } = lngLatToGlobalPixel(lng, lat, dem.zoom);
  const gi = Math.floor(gx) - dem.gx0;
  const gj = Math.floor(gy) - dem.gy0;

  if (gi < 0 || gj < 0 || gi >= dem.width || gj >= dem.height) {
    return null;
  }

  const idx = gj * dem.width + gi;
  const alt = altitudes[idx];
  if (!Number.isFinite(alt) || alt >= maxAltitude) {
    return null;
  }

  return alt;
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
  try {
    await ensureEngine();
    setStatus("WebGPU ready — click the map to compute a glide cone");
  } catch (error) {
    setStatus(error.message);
    console.error(error);
  }
});

map.on("mousemove", (event) => {
  const alt = sampleConeAltitude(event.lngLat.lng, event.lngLat.lat);
  if (alt === null) {
    hoverTip.style.display = "none";
    return;
  }

  hoverTip.style.display = "block";
  hoverTip.style.left = `${event.point.x + 14}px`;
  hoverTip.style.top = `${event.point.y + 14}px`;
  hoverTip.textContent = `${Math.round(alt)} m`;
});

map.on("mouseleave", () => {
  hoverTip.style.display = "none";
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
