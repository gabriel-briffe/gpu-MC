import { parseVizMode, syncParamVisibility, isAutoParamsMode, isSingleParamsMode, isDebugMode, applySectorsOverlayOpacity } from "../params/panel.js";
import {
  clearRasterOverlay,
  clearContourOverlay,
  clearSectorBorderOverlay,
  clearAllOverlays,
} from "../compute/visualization.js";
import {
  runFullBresenhamCompare,
  requestStopCompute,
  runComputation,
} from "../compute/session.js";

function markTouchHandled(app) {
  app.touchHandledRecently = true;
  window.setTimeout(() => {
    app.touchHandledRecently = false;
  }, 400);
}

function maybeUpdateAirspaceInfo(hooks, lng, lat) {
  if (!isDebugMode() || !hooks.isIncludeAirspaceEnabled?.()) {
    return;
  }
  hooks.updateAirspaceInfo(lng, lat);
}

export function bindMapEvents(app, hooks) {
  const map = hooks.getMap();

  map.on("mousemove", (event) => {
    maybeUpdateAirspaceInfo(hooks, event.lngLat.lng, event.lngLat.lat);

    if (hooks.getAirportAreaSelectMode()) {
      if (hooks.hasAirportRectInteraction()) {
        hooks.updateAirportAreaInteraction(event.lngLat);
      } else {
        hooks.syncAreaSelectCursor(event.point);
      }
      return;
    }

    if (hooks.getManualAirportSelectMode()) {
      return;
    }

    if (hooks.isAirportPickMode?.()) {
      const map = hooks.getMap();
      const pickable = hooks.pickAirportAtMapPoint?.(event.point);
      if (map) {
        map.getCanvas().style.cursor = pickable ? "pointer" : "";
      }
      if (pickable) {
        hooks.onMapMouseLeave?.();
        return;
      }
    }

    if (hooks.getCacheSelectMode()) {
      return;
    }

    hooks.onMapMouseMove(event);
  });

  map.on("move", () => {
    if (!hooks.getCacheSelectMode()) {
      hooks.syncPathsOnMapMove();
    }
  });
  map.on("zoom", () => {
    if (!hooks.getCacheSelectMode()) {
      hooks.syncPathsOnMapMove();
    }
  });

  map.on("mousedown", (event) => {
    if (event.originalEvent.button !== 0 || !hooks.getAirportAreaSelectMode()) {
      return;
    }
    hooks.beginAirportAreaInteraction(event.lngLat, event.point);
  });

  map.on("mouseup", (event) => {
    hooks.finishAirportAreaInteraction(event.lngLat);
  });

  map.on("mouseleave", () => {
    if (hooks.hasAirportRectInteraction()) {
      hooks.cancelAirportRectInteraction();
      hooks.syncAirportAreaSelectUi();
    }
    if (!app.interaction.hoverPath) {
      return;
    }
    hooks.onMapMouseLeave();
  });

  map.on("touchstart", (event) => {
    if (hooks.getAirportAreaSelectMode() && !hooks.isComputing() && event.points.length === 1) {
      hooks.beginAirportAreaInteraction(event.lngLat, event.point);
      return;
    }
    if (hooks.getManualAirportSelectMode() && !hooks.isComputing() && event.points.length === 1) {
      app.manualTouchStart = event.point;
    }
  });

  map.on("touchmove", (event) => {
    maybeUpdateAirspaceInfo(hooks, event.lngLat.lng, event.lngLat.lat);

    if (hooks.getAirportAreaSelectMode() && hooks.hasAirportRectInteraction()) {
      hooks.updateAirportAreaInteraction(event.lngLat);
      return;
    }

    if (app.manualTouchStart) {
      const dx = event.point.x - app.manualTouchStart.x;
      const dy = event.point.y - app.manualTouchStart.y;
      if (dx * dx + dy * dy > 100) {
        app.manualTouchStart = null;
      }
    }
  });

  map.on("touchend", (event) => {
    maybeUpdateAirspaceInfo(hooks, event.lngLat.lng, event.lngLat.lat);

    if (hooks.getAirportAreaSelectMode() && hooks.hasAirportRectInteraction()) {
      hooks.finishAirportAreaInteraction(event.lngLat);
      markTouchHandled(app);
      return;
    }

    if (hooks.getManualAirportSelectMode() && !hooks.isComputing()) {
      if (app.manualTouchStart) {
        const dx = event.point.x - app.manualTouchStart.x;
        const dy = event.point.y - app.manualTouchStart.y;
        if (dx * dx + dy * dy > 100) {
          app.manualTouchStart = null;
          return;
        }
        app.manualTouchStart = null;
      }
      markTouchHandled(app);
      hooks.setPendingManualAirport(event.lngLat.lng, event.lngLat.lat);
      return;
    }

    if (hooks.isAirportPickMode?.()) {
      const picked = hooks.pickAirportAtMapPoint?.(event.point);
      if (picked && hooks.togglePendingSeedAt?.(picked)) {
        markTouchHandled(app);
      }
    }
  });

  map.on("touchcancel", () => {
    app.manualTouchStart = null;
    if (hooks.hasAirportRectInteraction()) {
      hooks.cancelAirportRectInteraction();
      hooks.syncAirportAreaSelectUi();
    }
  });

  map.on("click", (event) => {
    if (hooks.getCacheSelectMode()) {
      const features = map.queryRenderedFeatures(event.point, { layers: ["cache-grid-fill"] });
      if (features.length > 0) {
        hooks.toggleCacheCellSelection(event.lngLat.lng, event.lngLat.lat);
      }
      return;
    }

    if (
      app.touchHandledRecently ||
      hooks.getAirportAreaSelectMode() ||
      hooks.hasAirportRectInteraction()
    ) {
      return;
    }

    if (hooks.getManualAirportSelectMode()) {
      if (hooks.isComputing()) {
        return;
      }
      hooks.setPendingManualAirport(event.lngLat.lng, event.lngLat.lat);
      return;
    }

    if (hooks.isAirportPickMode?.()) {
      const picked = hooks.pickAirportAtMapPoint?.(event.point);
      if (picked && hooks.togglePendingSeedAt?.(picked)) {
        return;
      }
    }

    if (hooks.isComputing()) {
      return;
    }

    if (!app.interaction.tapPath || !hooks.getConeState()) {
      return;
    }

    hooks.onMapClickInspect(event);
  });
}

export function bindUiEvents(app, hooks) {
  hooks.paramsForm?.addEventListener("submit", (event) => {
    event.preventDefault();
  });

  hooks.vizModeSelect?.addEventListener("change", () => {
    syncParamVisibility();
    const mode = parseVizMode();
    const coneState = hooks.getConeState();
    if (mode.pathOnly && coneState && !hooks.isComputing()) {
      clearRasterOverlay();
      clearContourOverlay();
      clearSectorBorderOverlay();
      coneState.contourGeojson = null;
      coneState.sectorBorderGeojson = null;
      hooks.setDownloadContoursVisible(false);
    } else if (!mode.sectors && coneState && !hooks.isComputing()) {
      clearSectorBorderOverlay();
      coneState.sectorBorderGeojson = null;
    } else if (mode.sectors) {
      applySectorsOverlayOpacity();
    }
    if (isAutoParamsMode()) {
      hooks.scheduleAutoCompute({ debounce: false });
      return;
    }
    if (isSingleParamsMode()) {
      hooks.scheduleSingleAirportCompute?.(undefined, { debounce: false });
      return;
    }
    if (coneState && !hooks.isComputing()) {
      hooks.setStatus("Overlay type changed — click Run to refresh");
    }
  });

  hooks.stopComputeBtn?.addEventListener("click", () => {
    if (hooks.isComputing()) {
      requestStopCompute();
    }
  });

  hooks.compareLosBtn?.addEventListener("click", () => {
    runFullBresenhamCompare();
  });

  hooks.downloadContoursBtn?.addEventListener("click", () => {
    hooks.downloadContourGeojson();
  });

  hooks.clearOverlayBtn?.addEventListener("click", () => {
    clearAllOverlays();
  });

  hooks.runComputeBtn?.addEventListener("click", () => {
    if (hooks.paramsPanel) {
      hooks.paramsPanel.open = false;
    }
    runComputation();
  });

  hooks.paramsPanel?.addEventListener("toggle", () => {
    if (hooks.paramsPanel.open && hooks.getAirportAreaSelectMode()) {
      hooks.exitAirportAreaSelectMode(false);
    }
    if (hooks.paramsPanel.open && hooks.getManualAirportSelectMode()) {
      hooks.exitManualAirportSelectMode(false);
    }
  });
}
