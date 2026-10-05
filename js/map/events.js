import { parseVizMode, syncParamVisibility, isAutoParamsMode, isSingleParamsMode, isDebugMode, applySectorsOverlayOpacity } from "../params/panel.js";
import {
  clearRasterOverlay,
  clearContourOverlay,
  clearSectorBorderOverlay,
} from "../compute/visualization.js";
import { requestStopCompute } from "../compute/session.js";

const TAP_MOVE_TOLERANCE_SQ = 100;
const MAP_LONG_PRESS_MS = 500;

function clearMapLongPress(app) {
  if (app.mapLongPressTimer) {
    clearTimeout(app.mapLongPressTimer);
    app.mapLongPressTimer = null;
  }
}

function rememberMapLongPress(app, event) {
  app.mapLongPressPoint = {
    lng: event.lngLat.lng,
    lat: event.lngLat.lat,
    x: event.point.x,
    y: event.point.y,
  };
}

function canPlaceGliderFromTouch(hooks) {
  return (
    !hooks.isGeoTrackingOn() &&
    !hooks.isComputing() &&
    !hooks.getCacheSelectMode() &&
    !hooks.getManualAirportSelectMode()
  );
}

function fireMapLongPress(app, hooks) {
  const point = app.mapLongPressPoint;
  if (!point || app.mapLongPressFired || !canPlaceGliderFromTouch(hooks)) {
    return;
  }
  app.mapLongPressFired = true;
  app.suppressNextMapClick = true;
  clearMapLongPress(app);
  clearMapTap(app);
  markTouchHandled(app);
  hooks.placeSimGlider(point.lng, point.lat, point);
}

function markTouchHandled(app) {
  app.touchHandledRecently = true;
  window.setTimeout(() => {
    app.touchHandledRecently = false;
  }, 400);
}

function clearMapTap(app) {
  app.mapTapStart = null;
}

function pointMoved(start, point) {
  if (!start || !point) {
    return false;
  }
  const dx = point.x - start.x;
  const dy = point.y - start.y;
  return dx * dx + dy * dy > TAP_MOVE_TOLERANCE_SQ;
}

function mapTapMoved(app, point) {
  return pointMoved(app.mapTapStart, point);
}

function maybeUpdateAirspaceInfo(hooks, lng, lat) {
  if (!isDebugMode() || !hooks.isOpenAipVectorEnabled?.()) {
    return;
  }
  hooks.updateAirspaceInfo(lng, lat);
}

export function bindMapEvents(app, hooks) {
  const map = hooks.getMap();

  map.on("mousemove", (event) => {
    maybeUpdateAirspaceInfo(hooks, event.lngLat.lng, event.lngLat.lat);

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
    if (app.mapTapStart || app.mapLongPressPoint) {
      app.touchGestureWasPan = true;
    }
    if (app.mapTapStart) {
      clearMapTap(app);
    }
  });

  map.on("mouseleave", () => {
    if (!app.interaction.hoverPath) {
      return;
    }
    hooks.onMapMouseLeave();
  });

  map.on("touchstart", (event) => {
    clearMapLongPress(app);
    app.mapLongPressFired = false;
    app.mapLongPressPoint = null;
    if (event.points.length !== 1) {
      return;
    }
    if (hooks.getManualAirportSelectMode() && !hooks.isComputing()) {
      app.manualTouchStart = event.point;
      return;
    }
    if (hooks.isAirportPickMode?.() && !hooks.isComputing()) {
      app.touchGestureWasPan = false;
      app.mapTapStart = { x: event.point.x, y: event.point.y };
    }
    if (!canPlaceGliderFromTouch(hooks)) {
      return;
    }
    rememberMapLongPress(app, event);
    app.mapLongPressTimer = window.setTimeout(() => {
      app.mapLongPressTimer = null;
      fireMapLongPress(app, hooks);
    }, MAP_LONG_PRESS_MS);
  });

  map.on("touchmove", (event) => {
    maybeUpdateAirspaceInfo(hooks, event.lngLat.lng, event.lngLat.lat);

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
    if (app.mapLongPressPoint && (event.points.length !== 1 || pointMoved(app.mapLongPressPoint, event.point))) {
      clearMapLongPress(app);
      app.mapLongPressPoint = null;
      app.touchGestureWasPan = true;
    }
  });

  map.on("touchend", (event) => {
    clearMapLongPress(app);
    maybeUpdateAirspaceInfo(hooks, event.lngLat.lng, event.lngLat.lat);

    if (app.mapLongPressFired) {
      app.mapLongPressFired = false;
      app.mapLongPressPoint = null;
      app.touchGestureWasPan = false;
      clearMapTap(app);
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
      if (picked && hooks.toggleComputeAirportAt?.(picked)) {
        markTouchHandled(app);
        return;
      }
    }

    if (canPlaceGliderFromTouch(hooks) && app.interaction.tapPath) {
      markTouchHandled(app);
      hooks.inspectMapPoint(event.lngLat.lng, event.lngLat.lat, event.point);
    }
  });

  map.on("touchcancel", () => {
    clearMapLongPress(app);
    app.manualTouchStart = null;
    clearMapTap(app);
    app.mapLongPressPoint = null;
    app.touchGestureWasPan = false;
  });

  map.getCanvas().addEventListener("contextmenu", (event) => {
    if (!app.interaction.tapPath || hooks.isGeoTrackingOn()) {
      return;
    }
    event.preventDefault();
    fireMapLongPress(app, hooks);
  });

  map.on("click", (event) => {
    if (hooks.getCacheSelectMode()) {
      const features = map.queryRenderedFeatures(event.point, { layers: ["cache-grid-fill"] });
      if (features.length > 0) {
        hooks.toggleCacheCellSelection(event.lngLat.lng, event.lngLat.lat);
      }
      return;
    }

    if (app.suppressNextMapClick) {
      app.suppressNextMapClick = false;
      return;
    }

    if (
      app.touchHandledRecently ||
      app.touchGestureWasPan
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
      if (picked && hooks.toggleComputeAirportAt?.(picked)) {
        return;
      }
    }

    if (hooks.isComputing()) {
      return;
    }

    if (hooks.isGeoTrackingOn() && !app.interaction.tapPath && !isDebugMode()) {
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
}
