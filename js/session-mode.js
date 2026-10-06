/** Explicit session modes: flight (GPS), viewer (cone only), simulator (place / IGC). */

import { dom } from "./dom.js";

export const SESSION_FLIGHT = "flight";
export const SESSION_VIEWER = "viewer";
export const SESSION_SIMULATOR = "simulator";

const MODES = new Set([SESSION_FLIGHT, SESSION_VIEWER, SESSION_SIMULATOR]);

let app;
let hooks;

export function initSessionMode(h) {
  hooks = h;
  app = h.app;
  if (!MODES.has(app.sessionMode)) {
    app.sessionMode = SESSION_SIMULATOR;
  }
  for (const btn of sessionModeButtons()) {
    btn.addEventListener("click", () => {
      void setSessionMode(btn.dataset.sessionMode);
    });
  }
  syncSessionModeUi();
}

function sessionModeButtons() {
  return [
    dom.sessionModeFlightBtn,
    dom.sessionModeViewerBtn,
    dom.sessionModeSimulatorBtn,
  ].filter(Boolean);
}

export function getSessionMode() {
  return MODES.has(app?.sessionMode) ? app.sessionMode : SESSION_SIMULATOR;
}

export function isFlightSession() {
  return getSessionMode() === SESSION_FLIGHT;
}

export function isViewerSession() {
  return getSessionMode() === SESSION_VIEWER;
}

export function isSimulatorSession() {
  return getSessionMode() === SESSION_SIMULATOR;
}

/** True when a glider (GPS or placed/IGC) drives navboxes and options. */
export function sessionHasAircraft() {
  return isFlightSession() || isSimulatorSession();
}

export async function setSessionMode(mode) {
  if (!MODES.has(mode) || !app) {
    return;
  }
  const prev = getSessionMode();
  if (prev === mode) {
    syncSessionModeUi();
    return;
  }
  app.sessionMode = mode;

  if (prev === SESSION_SIMULATOR && mode !== SESSION_SIMULATOR) {
    clearSimulatorAircraft();
  }
  if (mode === SESSION_VIEWER) {
    app.simGlider = null;
    hooks.clearOptionalArea?.();
    hooks.clearAllGlidePaths?.();
    hooks.clearCellInspect?.();
  }
  if (mode === SESSION_FLIGHT) {
    app.simGlider = null;
    hooks.clearAllGlidePaths?.();
    await hooks.startGeoTracking?.();
  } else if (prev === SESSION_FLIGHT) {
    await hooks.stopGeoTracking?.();
  }

  syncSessionModeUi();
  hooks.updateGeoLocationPath?.();
  hooks.syncComputeContextBar?.();
  if (mode !== SESSION_VIEWER) {
    void hooks.refreshOptionalArea?.({ force: true });
  }
}

function clearSimulatorAircraft() {
  app.simGlider = null;
  hooks.stopIgcReplay?.();
  hooks.clearAllGlidePaths?.();
}

export function syncSessionModeUi() {
  if (!app) {
    return;
  }
  const mode = getSessionMode();
  const cache = Boolean(app.cacheSelectMode);
  const glideOn = Boolean(hooks.isGlideConesEnabled?.());

  document.body.classList.toggle("session-flight", mode === SESSION_FLIGHT && !cache);
  document.body.classList.toggle("session-viewer", mode === SESSION_VIEWER && !cache);
  document.body.classList.toggle("session-simulator", mode === SESSION_SIMULATOR && !cache);
  document.body.classList.toggle("flight-mode", mode === SESSION_FLIGHT && !cache);
  document.body.classList.toggle("sim-mode", mode === SESSION_SIMULATOR && !cache);

  for (const btn of sessionModeButtons()) {
    const active = btn.dataset.sessionMode === mode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }

  const showChrome = !cache && glideOn;
  if (dom.simHelpBtn) {
    dom.simHelpBtn.hidden = !showChrome;
  }
  if (dom.emulatedAltBoxEl) {
    dom.emulatedAltBoxEl.hidden = !(showChrome && mode === SESSION_SIMULATOR);
  }
  hooks.syncIgcReplayBar?.(showChrome && mode === SESSION_SIMULATOR);
  if (mode !== SESSION_SIMULATOR) {
    hooks.setSimManualOpen?.(false);
  }
  hooks.syncOptionalVizHint?.();
}
