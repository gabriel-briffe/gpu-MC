import { dom } from "./dom.js";
import { isDebugMode } from "./params/panel.js";
import { sampleDemCell } from "./inspect/cell.js";
import {
  resetUserLocationTrack,
  setUserLocationMarkerVisible,
  updateUserLocationFromPosition,
} from "./map/location-track.js";

export function isLocalhostDev() {
  const hostname = globalThis.location?.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function isFakeGeoActive(app) {
  return Boolean(app.fakeGeoActive);
}

function defaultFakeAltitude(lng, lat) {
  const cell = sampleDemCell(lng, lat);
  if (cell?.alt !== null) {
    return Math.round(cell.alt + 200);
  }
  return 2000;
}

function readAltitudeInput() {
  const value = Number.parseFloat(dom.fakeGeoAltitudeInput?.value ?? "");
  return Number.isFinite(value) ? value : null;
}

function syncFakeGeoMenuFields(active) {
  if (dom.fakeGeoSectionEl) {
    dom.fakeGeoSectionEl.classList.toggle("fake-geo-active", active);
  }
  if (dom.fakeGeoAltFieldEl) {
    dom.fakeGeoAltFieldEl.hidden = !active;
  }
}

export function initFakeGeo(app, hooks) {
  if (!isLocalhostDev()) {
    return;
  }

  const map = hooks.getMap();
  if (!map) {
    return;
  }

  if (dom.fakeGeoDividerEl) {
    dom.fakeGeoDividerEl.hidden = false;
  }
  if (dom.fakeGeoSectionEl) {
    dom.fakeGeoSectionEl.hidden = false;
  }

  function readMaxComputeIterations() {
    if (!isDebugMode()) {
      return null;
    }
    const value = Number.parseInt(dom.maxComputeIterInput?.value ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function applyFakeGeo(lng, lat, altitude) {
    app.lastGeoLngLat = { lng, lat };
    app.lastGeoAltitude = Number.isFinite(altitude) ? altitude : null;
    setUserLocationMarkerVisible(map, true);
    updateUserLocationFromPosition(map, lng, lat);
    hooks.updateGeoLocationPath?.();
    hooks.syncComputeContextBar?.();
  }

  function syncFakeGeoFromCamera() {
    if (!app.fakeGeoActive) {
      return;
    }
    const center = map.getCenter();
    let altitude = readAltitudeInput();
    if (altitude === null) {
      altitude = defaultFakeAltitude(center.lng, center.lat);
      if (dom.fakeGeoAltitudeInput) {
        dom.fakeGeoAltitudeInput.value = String(altitude);
      }
    }
    applyFakeGeo(center.lng, center.lat, altitude);
  }

  function setFakeGeoEnabled(enabled) {
    app.fakeGeoActive = enabled;
    syncFakeGeoMenuFields(enabled);

    if (!enabled) {
      app.lastGeoLngLat = null;
      app.lastGeoAltitude = null;
      if (!hooks.isGeolocateControlTracking?.()) {
        setUserLocationMarkerVisible(map, false);
        resetUserLocationTrack();
      }
      hooks.clearGeoPath?.();
      hooks.syncComputeContextBar?.();
      return;
    }

    resetUserLocationTrack();
    syncFakeGeoFromCamera();
  }

  dom.fakeGeoEnableInput?.addEventListener("change", () => {
    setFakeGeoEnabled(Boolean(dom.fakeGeoEnableInput.checked));
  });

  dom.fakeGeoAltitudeInput?.addEventListener("input", () => {
    if (!app.fakeGeoActive) {
      return;
    }
    syncFakeGeoFromCamera();
  });

  dom.maxComputeIterInput?.addEventListener("change", () => {
    document.getElementById("params-mode-single")?.click();
  });

  hooks.syncFakeGeoFromCamera = syncFakeGeoFromCamera;
  hooks.isFakeGeoActive = () => isFakeGeoActive(app);
  hooks.getMaxComputeIterations = readMaxComputeIterations;
}
