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

function readAltitudeInput(input) {
  const value = Number.parseFloat(input?.value ?? "");
  return Number.isFinite(value) ? value : null;
}

export function initFakeGeo(app, hooks) {
  if (!isLocalhostDev()) {
    return;
  }

  const map = hooks.getMap();
  if (!map) {
    return;
  }

  const panel = document.createElement("div");
  panel.id = "fake-geo-panel";
  panel.innerHTML = `
    <label class="fake-geo-toggle" for="fake-geo-enable">
      <input id="fake-geo-enable" type="checkbox" />
      <span>Fake GPS (localhost)</span>
    </label>
    <label class="fake-geo-alt" for="fake-geo-altitude">
      <span>Altitude (m)</span>
      <input id="fake-geo-altitude" type="number" step="10" />
    </label>
    <label class="fake-geo-max-iter fake-geo-debug-only" for="fake-geo-max-iter" hidden>
      <span>Stop at iter</span>
      <input id="fake-geo-max-iter" type="number" min="1" step="1" placeholder="∞" />
    </label>
    <p class="fake-geo-hint">Uses map centre as fake position; wedge shows movement direction.</p>
  `;
  document.body.appendChild(panel);

  const enableInput = panel.querySelector("#fake-geo-enable");
  const altitudeInput = panel.querySelector("#fake-geo-altitude");
  const maxIterInput = panel.querySelector("#fake-geo-max-iter");
  const maxIterField = panel.querySelector(".fake-geo-debug-only");

  function isDebugMode() {
    return document.getElementById("debug-mode")?.checked ?? false;
  }

  function syncFakeGeoDebugFields() {
    const debug = isDebugMode();
    if (maxIterField) {
      maxIterField.hidden = !debug;
    }
  }

  function readMaxComputeIterations() {
    if (!isDebugMode()) {
      return null;
    }
    const value = Number.parseInt(maxIterInput?.value ?? "", 10);
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
    let altitude = readAltitudeInput(altitudeInput);
    if (altitude === null) {
      altitude = defaultFakeAltitude(center.lng, center.lat);
      altitudeInput.value = String(altitude);
    }
    applyFakeGeo(center.lng, center.lat, altitude);
  }

  function setFakeGeoEnabled(enabled) {
    app.fakeGeoActive = enabled;
    panel.classList.toggle("fake-geo-active", enabled);

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

  enableInput?.addEventListener("change", () => {
    setFakeGeoEnabled(Boolean(enableInput.checked));
  });

  altitudeInput?.addEventListener("input", () => {
    if (!app.fakeGeoActive) {
      return;
    }
    syncFakeGeoFromCamera();
  });

  maxIterInput?.addEventListener("change", () => {
    document.getElementById("params-mode-single")?.click();
  });

  hooks.syncFakeGeoFromCamera = syncFakeGeoFromCamera;
  hooks.isFakeGeoActive = () => isFakeGeoActive(app);
  hooks.getMaxComputeIterations = readMaxComputeIterations;
  hooks.syncFakeGeoDebugFields = syncFakeGeoDebugFields;
  syncFakeGeoDebugFields();
}
