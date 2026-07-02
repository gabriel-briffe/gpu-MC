import { dom } from "../dom.js";
import { sampleDemCell } from "../inspect/cell.js";
import { isDebugMode, isSingleParamsMode, syncPeekLosUi } from "../params/panel.js";
import { buildPeekLosGeoAnchor, setPeekLosGeoAnchor } from "./peek-los.js";

const LONG_PRESS_MS = 600;
const MOVE_CANCEL_PX = 12;

function canDebugLongPress(hooks) {
  return (
    isDebugMode() &&
    isSingleParamsMode() &&
    !hooks.getCacheSelectMode?.() &&
    !hooks.getMatrixExtractMode?.() &&
    !hooks.hasMatrixExtractInteraction?.() &&
    !hooks.getAirportAreaSelectMode?.() &&
    !hooks.hasAirportRectInteraction?.() &&
    !hooks.getManualAirportSelectMode?.() &&
    !hooks.isComputing?.()
  );
}

function cancelDebugLongPress(app) {
  if (app.debugLongPressTimer != null) {
    clearTimeout(app.debugLongPressTimer);
    app.debugLongPressTimer = null;
  }
  app.debugLongPressPoint = null;
}

function movedTooFar(app, point) {
  if (!app.debugLongPressPoint) {
    return false;
  }
  const dx = point.x - app.debugLongPressPoint.x;
  const dy = point.y - app.debugLongPressPoint.y;
  return dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX;
}

function markDebugLongPressHandled(app) {
  app.debugLongPressHandledRecently = true;
  window.setTimeout(() => {
    app.debugLongPressHandledRecently = false;
  }, 400);
}

function autofillPeekLosFromCell(cell) {
  if (dom.peekLosInput) {
    dom.peekLosInput.checked = true;
  }
  if (dom.peekLosIInput) {
    dom.peekLosIInput.value = String(cell.gi);
  }
  if (dom.peekLosJInput) {
    dom.peekLosJInput.value = String(cell.gj);
  }
  if (cell.originGi != null && cell.originGj != null) {
    if (dom.peekLosOiInput) {
      dom.peekLosOiInput.value = String(cell.originGi);
    }
    if (dom.peekLosOjInput) {
      dom.peekLosOjInput.value = String(cell.originGj);
    }
  } else {
    if (dom.peekLosOiInput) {
      dom.peekLosOiInput.value = "";
    }
    if (dom.peekLosOjInput) {
      dom.peekLosOjInput.value = "";
    }
  }
  syncPeekLosUi();
}

function fireDebugLongPress(app, hooks, lng, lat) {
  if (!canDebugLongPress(hooks)) {
    return;
  }

  const pick = hooks.getSingleLastPick?.();
  if (!pick?.id) {
    hooks.setStatus("Select an airport first");
    return;
  }

  const cell = sampleDemCell(lng, lat);
  if (cell) {
    autofillPeekLosFromCell(cell);
    const dem = hooks.getConeState?.()?.dem;
    setPeekLosGeoAnchor(buildPeekLosGeoAnchor(cell, dem));
    hooks.schedulePersistParamsState?.();
    const originText =
      cell.originGi != null && cell.originGj != null
        ? ` (${cell.gi},${cell.gj})→(${cell.originGi},${cell.originGj})`
        : ` (${cell.gi},${cell.gj})`;
    hooks.setStatus(`Peek LOS${originText} — recomputing ${pick.label ?? "airport"}…`);
  } else {
    hooks.setStatus(`Recomputing ${pick.label ?? "airport"}…`);
  }

  markDebugLongPressHandled(app);
  hooks.scheduleSingleAirportCompute?.(undefined, { debounce: false });
}

function startDebugLongPress(app, hooks, event) {
  cancelDebugLongPress(app);
  if (!canDebugLongPress(hooks)) {
    return;
  }
  app.debugLongPressPoint = {
    x: event.point.x,
    y: event.point.y,
    lng: event.lngLat.lng,
    lat: event.lngLat.lat,
  };
  app.debugLongPressTimer = window.setTimeout(() => {
    app.debugLongPressTimer = null;
    const point = app.debugLongPressPoint;
    app.debugLongPressPoint = null;
    if (!point) {
      return;
    }
    fireDebugLongPress(app, hooks, point.lng, point.lat);
  }, LONG_PRESS_MS);
}

export function bindDebugMapLongPress(app, hooks) {
  const map = hooks.getMap();
  if (!map) {
    return;
  }

  map.on("touchstart", (event) => {
    if (event.points.length !== 1) {
      cancelDebugLongPress(app);
      return;
    }
    startDebugLongPress(app, hooks, event);
  });

  map.on("touchmove", (event) => {
    if (movedTooFar(app, event.point)) {
      cancelDebugLongPress(app);
    }
  });

  map.on("touchend", () => {
    cancelDebugLongPress(app);
  });

  map.on("touchcancel", () => {
    cancelDebugLongPress(app);
  });

  map.on("mousedown", (event) => {
    if (event.originalEvent.button !== 0) {
      return;
    }
    startDebugLongPress(app, hooks, event);
  });

  map.on("mousemove", (event) => {
    if (app.debugLongPressTimer != null && movedTooFar(app, event.point)) {
      cancelDebugLongPress(app);
    }
  });

  map.on("mouseup", () => {
    cancelDebugLongPress(app);
  });

  map.on("mouseleave", () => {
    cancelDebugLongPress(app);
  });
}

export function wasDebugLongPressHandled(app) {
  return Boolean(app.debugLongPressHandledRecently);
}
