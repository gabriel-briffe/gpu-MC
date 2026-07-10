import { parseVizMode, syncParamVisibility, isAutoParamsMode, isSingleParamsMode, isDebugMode, applySectorsOverlayOpacity } from "../params/panel.js";
import {
  clearRasterOverlay,
  clearContourOverlay,
  clearSectorBorderOverlay,
  clearAllOverlays,
} from "../compute/visualization.js";
import { requestStopCompute, runComputation } from "../compute/session.js";

const TAP_MOVE_TOLERANCE_SQ = 100;

function markTouchHandled(app) {
  app.touchHandledRecently = true;
  window.setTimeout(() => {
    app.touchHandledRecently = false;
  }, 400);
}

function clearMapTap(app) {
  app.mapTapStart = null;
}

function mapTapMoved(app, point) {
  if (!app.mapTapStart) {
    return false;
  }
  const dx = point.x - app.mapTapStart.x;
  const dy = point.y - app.mapTapStart.y;
  return dx * dx + dy * dy > TAP_MOVE_TOLERANCE_SQ;
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
      hooks.syncFakeGeoFromCamera?.();
    }
  });
  map.on("zoom", () => {
    if (!hooks.getCacheSelectMode()) {
      hooks.syncPathsOnMapMove();
    }
  });

  map.on("movestart", () => {
    if (app.mapTapStart) {
      clearMapTap(app);
      app.touchGestureWasPan = true;
    }
  });

  map.on("mousedown", (event) => {
    if (event.originalEvent.button !== 0) {
      return;
    }
    if (!hooks.getAirportAreaSelectMode()) {
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
      return;
    }
    if (hooks.isAirportPickMode?.() && !hooks.isComputing() && event.points.length === 1) {
      app.touchGestureWasPan = false;
      app.mapTapStart = { x: event.point.x, y: event.point.y };
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
      if (dx * dx + dy * dy > TAP_MOVE_TOLERANCE_SQ) {
        app.manualTouchStart = null;
      }
    }

    if (app.mapTapStart && (event.points.length !== 1 || mapTapMoved(app, event.point))) {
      clearMapTap(app);
      app.touchGestureWasPan = true;
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
        if (dx * dx + dy * dy > TAP_MOVE_TOLERANCE_SQ) {
          app.manualTouchStart = null;
          return;
        }
        app.manualTouchStart = null;
      }
      markTouchHandled(app);
      hooks.setPendingManualAirport(event.lngLat.lng, event.lngLat.lat);
      return;
    }

    if (app.touchGestureWasPan) {
      app.touchGestureWasPan = false;
      markTouchHandled(app);
      return;
    }

    if (hooks.isAirportPickMode?.()) {
      if (!app.mapTapStart) {
        markTouchHandled(app);
        return;
      }
      clearMapTap(app);
      const picked = hooks.pickAirportAtMapPoint?.(event.point);
      if (picked && hooks.togglePendingSeedAt?.(picked)) {
        markTouchHandled(app);
      }
    }
  });

  map.on("touchcancel", () => {
    app.manualTouchStart = null;
    clearMapTap(app);
    app.touchGestureWasPan = false;
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
      app.touchGestureWasPan ||
      hooks.getAirportAreaSelectMode() ||
      hooks.hasAirportRectInteraction()
    ) {
      app.touchGestureWasPan = false;
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
      clearRasterOverlay();
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

  hooks.downloadContoursBtn?.addEventListener("click", () => {
    hooks.downloadContourGeojson();
  });

  hooks.clearOverlayBtn?.addEventListener("click", () => {
    clearAllOverlays();
  });

  hooks.runComputeBtn?.addEventListener("click", () => {
    hooks.closeAppMenu?.();
    runComputation();
  });
}
