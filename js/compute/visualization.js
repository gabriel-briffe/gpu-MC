import { gridBoundsLngLat } from "../geo.js";
import { buildAltitudeContours } from "../contours.js";
import { buildSectorBorderGeojson } from "../sectors.js";
import {
  parseVizMode,
  applySectorsOverlayOpacity,
  getSectorsOverlayOpacity,
} from "../params/panel.js";
import {
  ensureContourLayers,
  ensureSectorBorderLayers,
  syncContourLabelSpacing,
  raisePathLayer,
} from "../map/layers.js";

let hooks;
let app;

export function initComputeVisualization(h) {
  hooks = h;
  app = h.app;
}

export function clearRasterOverlay() {
  const map = hooks.getMap();
  if (!map) {
    return;
  }
  if (map.getLayer("glide-cone")) {
    map.removeLayer("glide-cone");
  }
  if (map.getSource("glide-cone")) {
    map.removeSource("glide-cone");
  }
}

export function clearContourOverlay() {
  const map = hooks.getMap();
  if (!map?.getSource("glide-contours")) {
    return;
  }
  map.getSource("glide-contours").setData({
    type: "FeatureCollection",
    features: [],
  });
}

export function clearSectorBorderOverlay() {
  const map = hooks.getMap();
  if (!map?.getSource("glide-sectors")) {
    return;
  }
  map.getSource("glide-sectors").setData({
    type: "FeatureCollection",
    features: [],
  });
}

export function clearComputeResults() {
  hooks.clearConeState();
  clearRasterOverlay();
  clearContourOverlay();
  clearSectorBorderOverlay();
  hooks.clearCompareOverlay();
  hooks.clearCellInspect();
  hooks.clearAllGlidePaths();
  hooks.setDownloadContoursVisible(false);
  hooks.syncCompareLosButton();
}

export function clearAllOverlays() {
  clearComputeResults();
  hooks.setStatus("Overlay cleared");
}

function updateSectorBorderOverlay(geojson) {
  const map = hooks.getMap();
  ensureSectorBorderLayers();
  map.getSource("glide-sectors").setData(geojson);
  applySectorsOverlayOpacity();
  raisePathLayer();
}

function updateContourOverlay(geojson) {
  const map = hooks.getMap();
  ensureContourLayers();
  syncContourLabelSpacing();
  map.getSource("glide-contours").setData(geojson);
  raisePathLayer();
}

export function updateOverlay(imageData, dem) {
  const map = hooks.getMap();
  if (!map) {
    return;
  }

  if (!app.overlayCanvas) {
    app.overlayCanvas = document.createElement("canvas");
  }
  app.overlayCanvas.width = imageData.width;
  app.overlayCanvas.height = imageData.height;
  app.overlayCanvas.getContext("2d").putImageData(imageData, 0, 0);

  const coords = gridBoundsLngLat(dem.gx0, dem.gy0, dem.width, dem.height, dem.zoom);
  const coordinates = [
    [coords[0].lng, coords[0].lat],
    [coords[1].lng, coords[1].lat],
    [coords[2].lng, coords[2].lat],
    [coords[3].lng, coords[3].lat],
  ];

  if (map.getSource("glide-cone")) {
    map.getSource("glide-cone").updateImage({
      url: app.overlayCanvas.toDataURL(),
      coordinates,
    });
    raisePathLayer();
    if (parseVizMode().sectors) {
      applySectorsOverlayOpacity();
    }
    return;
  }

  map.addSource("glide-cone", {
    type: "image",
    url: app.overlayCanvas.toDataURL(),
    coordinates,
  });

  map.addLayer({
    id: "glide-cone",
    type: "raster",
    source: "glide-cone",
    paint: {
      "raster-opacity": parseVizMode().sectors ? getSectorsOverlayOpacity() : 1,
    },
  });
  raisePathLayer();
  if (parseVizMode().sectors) {
    applySectorsOverlayOpacity();
  }
}

export function updateConeVisualization(result, dem, glideParams) {
  const coneState = hooks.getConeState();
  if (!coneState) {
    return;
  }

  if (glideParams.pathOnly) {
    coneState.contourGeojson = null;
    coneState.sectorBorderGeojson = null;
    hooks.setDownloadContoursVisible(false);
    clearRasterOverlay();
    clearContourOverlay();
    clearSectorBorderOverlay();
    return;
  }

  if (glideParams.raw) {
    coneState.contourGeojson = null;
    coneState.sectorBorderGeojson = null;
    hooks.setDownloadContoursVisible(false);
    clearContourOverlay();
    clearSectorBorderOverlay();
    if (result.imageData) {
      updateOverlay(result.imageData, dem);
    }
    return;
  }

  if (glideParams.contours) {
    coneState.sectorBorderGeojson = null;
    clearSectorBorderOverlay();
    clearRasterOverlay();
    const geojson = buildAltitudeContours(
      dem,
      result.altitudes,
      result.ground,
      result.originX,
      glideParams.maxAltitude
    );
    coneState.contourGeojson = geojson;
    updateContourOverlay(geojson);
    hooks.setDownloadContoursVisible(true);
    return;
  }

  if (glideParams.sectors) {
    coneState.contourGeojson = null;
    hooks.setDownloadContoursVisible(false);
    clearContourOverlay();
    if (result.imageData) {
      updateOverlay(result.imageData, dem);
    }
    const borderGeojson = buildSectorBorderGeojson(
      dem,
      result.altitudes,
      result.ground,
      result.originX,
      result.originY,
      glideParams.maxAltitude
    );
    coneState.sectorBorderGeojson = borderGeojson;
    updateSectorBorderOverlay(borderGeojson);
    return;
  }

  coneState.contourGeojson = null;
  coneState.sectorBorderGeojson = null;
  hooks.setDownloadContoursVisible(false);
  clearContourOverlay();
  clearSectorBorderOverlay();
  if (result.imageData) {
    updateOverlay(result.imageData, dem);
  }
}
