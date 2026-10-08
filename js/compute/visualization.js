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
import { replaceImageObjectUrl, revokeImageObjectUrl } from "../map/image-data-url.js";

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
  revokeImageObjectUrl(app.overlayImageUrl);
  app.overlayImageUrl = null;
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
  hooks.clearCellInspect();
  hooks.clearAllGlidePaths();
  hooks.setDownloadContoursVisible(false);
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

  const coords = gridBoundsLngLat(dem.gx0, dem.gy0, dem.width, dem.height, dem.zoom);
  const coordinates = [
    [coords[0].lng, coords[0].lat],
    [coords[1].lng, coords[1].lat],
    [coords[2].lng, coords[2].lat],
    [coords[3].lng, coords[3].lat],
  ];
  const url = replaceImageObjectUrl(app.overlayImageUrl, imageData);
  app.overlayImageUrl = url;

  if (map.getSource("glide-cone")) {
    map.getSource("glide-cone").updateImage({ url, coordinates });
    raisePathLayer();
    hooks.raiseIconCh1Layer?.();
    if (parseVizMode().sectors) {
      applySectorsOverlayOpacity();
    }
    return;
  }

  map.addSource("glide-cone", {
    type: "image",
    url,
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
  hooks.raiseIconCh1Layer?.();
  if (parseVizMode().sectors) {
    applySectorsOverlayOpacity();
  }
}

export function updateConeVisualization(result, dem, glideParams) {
  const coneState = hooks.getConeState();
  if (!coneState) {
    return;
  }

  if (glideParams.showModifiedCells && result.imageData) {
    coneState.contourGeojson = null;
    coneState.sectorBorderGeojson = null;
    hooks.setDownloadContoursVisible(false);
    clearContourOverlay();
    clearSectorBorderOverlay();
    updateOverlay(result.imageData, dem);
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
  } else {
    coneState.contourGeojson = null;
    clearContourOverlay();
    hooks.setDownloadContoursVisible(false);
  }

  if (glideParams.sectors) {
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
  } else {
    coneState.sectorBorderGeojson = null;
    clearSectorBorderOverlay();
    if (!glideParams.contours && result.imageData) {
      updateOverlay(result.imageData, dem);
    } else {
      clearRasterOverlay();
    }
  }
}
