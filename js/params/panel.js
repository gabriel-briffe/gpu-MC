import { PARAM_HELP, VIZ_HINTS } from "../constants.js";
import { parseVizMode as parseVizModeCore } from "./viz-mode.js";
import {
  initParamsPersistence,
  loadParamsState,
  restoreParamsState,
} from "./persist.js";
import { initParamSteppers } from "./steppers.js";

let app;
let dom;
let paramsMode = "auto";

export function getParamsMode() {
  return paramsMode;
}

function isAutoParamsMode() {
  return paramsMode === "auto";
}

function isSingleParamsMode() {
  return paramsMode === "single";
}

function isDebugMode() {
  return dom.debugModeInput?.checked ?? false;
}

export function parseVizMode() {
  return parseVizModeCore(dom.vizModeSelect?.value ?? "contours", isDebugMode());
}

function scheduleParamsRecompute({ debounce = false, refreshAirports = false } = {}) {
  if (isAutoParamsMode()) {
    app.hooks.scheduleAutoCompute({ debounce, refreshAirports });
  } else if (isSingleParamsMode()) {
    app.hooks.scheduleSingleAirportCompute?.(undefined, { debounce });
  }
}

function getParamHelpText(key) {
  let text = PARAM_HELP[key];
  if (!text) {
    return null;
  }
  return text;
}

function getSectorsOverlayOpacity() {
  const value = Number.parseInt(dom.sectorsOpacityInput?.value ?? "50", 10);
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(100, value)) / 100;
}

function getWeatherOverlayOpacity() {
  const value = Number.parseInt(dom.weatherOpacityInput?.value ?? "70", 10);
  if (!Number.isFinite(value)) {
    return 0.7;
  }
  return Math.max(50, Math.min(100, value)) / 100;
}

export { getSectorsOverlayOpacity, getWeatherOverlayOpacity };

export function syncParamVisibility() {
  const { mode } = parseVizMode();
  if (dom.vizHintEl) {
    dom.vizHintEl.textContent = VIZ_HINTS[mode] ?? "";
  }
  syncSectorsOpacityUi();
  app.hooks.updateInteractionHints();
}

export function syncSectorsOpacityUi() {
  const show = parseVizMode().sectors;
  if (dom.sectorsOpacityFieldEl) {
    dom.sectorsOpacityFieldEl.hidden = !show;
  }
  if (dom.sectorsOpacityHintEl && dom.sectorsOpacityInput) {
    dom.sectorsOpacityHintEl.textContent = `${dom.sectorsOpacityInput.value}%`;
  }
}

export function syncWeatherOpacityUi() {
  if (dom.weatherOpacityInput) {
    const value = Number.parseInt(dom.weatherOpacityInput.value, 10);
    if (Number.isFinite(value) && value < 50) {
      dom.weatherOpacityInput.value = "50";
    }
  }
  if (dom.weatherOpacityHintEl && dom.weatherOpacityInput) {
    dom.weatherOpacityHintEl.textContent = `${dom.weatherOpacityInput.value}%`;
  }
}

export function applySectorsOverlayOpacity() {
  const map = app.hooks.getMap();
  if (!parseVizMode().sectors || !map) {
    return;
  }
  const opacity = getSectorsOverlayOpacity();
  if (map.getLayer("glide-cone")) {
    map.setPaintProperty("glide-cone", "raster-opacity", opacity);
  }
  if (map.getLayer("glide-sectors-line")) {
    map.setPaintProperty("glide-sectors-line", "line-opacity", opacity);
  }
}

export function applyWeatherOverlayOpacity() {
  const map = app.hooks.getMap();
  if (!map?.getLayer("ch1-sectors-layer")) {
    return;
  }
  map.setPaintProperty("ch1-sectors-layer", "fill-opacity", getWeatherOverlayOpacity());
}

export function syncVizModeDebugOptions() {
  if (!dom.vizModeSelect) {
    return;
  }
  const debug = isDebugMode();
  for (const option of dom.vizModeSelect.querySelectorAll(".viz-mode-debug-only")) {
    option.hidden = !debug;
    option.disabled = !debug;
  }
  const mode = dom.vizModeSelect.value;
  if (!debug && (mode === "stripes" || mode === "raw" || mode === "modified-cells")) {
    dom.vizModeSelect.value = "contours";
    syncParamVisibility();
    if (app.hooks.getConeState() && !app.hooks.isComputing()) {
      if (isAutoParamsMode()) {
        app.hooks.scheduleAutoCompute({ debounce: false });
      } else if (isSingleParamsMode()) {
        app.hooks.scheduleSingleAirportCompute?.(undefined, { debounce: false });
      }
    }
  }
}

export function setParamsMode(mode, { initial = false } = {}) {
  paramsMode = mode;
  for (const name of ["single", "auto"]) {
    dom.paramsShell?.classList.toggle(`params-mode-${name}`, mode === name);
  }
  dom.paramsModeSingleBtn?.setAttribute("aria-pressed", String(mode === "single"));
  dom.paramsModeAutoBtn?.setAttribute("aria-pressed", String(mode === "auto"));

  if (!initial) {
    if (app.hooks.getManualAirportSelectMode()) {
      app.hooks.exitManualAirportSelectMode(false);
    }

    app.hooks.clearAutoComputeScheduling();
    app.hooks.clearSingleComputeScheduling?.();

    if (mode === "single") {
      if (app.hooks.isComputing()) {
        app.hooks.setComputeShouldStop(true);
      }
      app.hooks.clearComputeAirports?.();
      app.hooks.clearComputeResults();
      app.hooks.syncComputeContextBar?.();
      app.hooks.refreshCachedAirportMapLayer?.();
      if (app.singleLastPick?.id) {
        app.hooks.scheduleSingleAirportCompute?.(undefined, { debounce: false });
      } else {
        app.hooks.setStatus("");
      }
    } else if (mode === "auto") {
      app.hooks.refreshCachedAirportMapLayer?.();
      app.hooks.scheduleAutoCompute({ refreshAirports: true });
    }
  }

  app.hooks.persistParamsState?.();
  app.hooks.updateParamsFooter?.();
}

export function syncDebugUi() {
  const debug = isDebugMode();
  dom.paramsShell?.classList.toggle("debug-mode", debug);
  app.hooks.syncDownloadContoursButton();
  app.hooks.syncBaseMapTerrainMaxZoom?.();
  app.hooks.syncFakeGeoDebugFields?.();
  syncVizModeDebugOptions();
  app.hooks.syncAirspaceUi?.();
  const lastInspectCell = app.hooks.getLastInspectCell();
  if (lastInspectCell) {
    app.hooks.showCellInspect(lastInspectCell);
  }
}

export function closeParamHelp() {
  if (!dom.paramHelpPopover) {
    return;
  }
  dom.paramHelpPopover.hidden = true;
  app.openParamHelpButton = null;
}

export function openParamHelp(button) {
  const key = button.dataset.help;
  const text = getParamHelpText(key);
  if (!text || !dom.paramHelpPopover) {
    return;
  }
  if (app.openParamHelpButton === button) {
    closeParamHelp();
    return;
  }
  dom.paramHelpPopover.textContent = text;
  dom.paramHelpPopover.hidden = false;
  const rect = button.getBoundingClientRect();
  dom.paramHelpPopover.style.top = `${rect.bottom + 6}px`;
  dom.paramHelpPopover.style.left = `${Math.min(rect.left, window.innerWidth - 290)}px`;
  app.openParamHelpButton = button;
}

export function initParamsPanel(appState, domRefs) {
  app = appState;
  dom = domRefs;

  initParamsPersistence(app.hooks, dom, app, getParamsMode);
  initParamSteppers(dom.paramsForm);
  const saved = loadParamsState();
  restoreParamsState(dom, app, saved);

  syncParamVisibility();
  syncWeatherOpacityUi();
  setParamsMode(saved?.mode ?? "auto", { initial: true });
  app.hooks.syncIncludeManualAirportsUi?.();
  app.hooks.updateGridRadiusHint();
  app.hooks.updateTerrainResolutionHint();
  app.hooks.syncAutoWindowSizeUi();
  app.hooks.syncAirspaceUi?.();
  applyWeatherOverlayOpacity();

  dom.paramsModeSingleBtn?.addEventListener("click", () => setParamsMode("single"));
  dom.paramsModeAutoBtn?.addEventListener("click", () => setParamsMode("auto"));

  const onParamsEdited = () => {
    app.hooks.schedulePersistParamsState?.();
  };
  dom.paramsForm?.addEventListener("input", onParamsEdited);
  dom.paramsForm?.addEventListener("change", onParamsEdited);

  dom.includeManualAirportsInput?.addEventListener("change", () => {
    app.hooks.schedulePersistParamsState?.();
    if (isAutoParamsMode()) {
      app.hooks.scheduleAutoCompute({ debounce: false, refreshAirports: true });
    }
  });

  for (const button of document.querySelectorAll(".param-help")) {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openParamHelp(button);
    });
  }

  document.addEventListener("click", (event) => {
    if (
      app.openParamHelpButton &&
      event.target !== app.openParamHelpButton &&
      event.target !== dom.paramHelpPopover
    ) {
      closeParamHelp();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeParamHelp();
    }
  });

  for (const id of ["ld", "max-alt"]) {
    document.getElementById(id)?.addEventListener("input", () => {
      app.hooks.updateGridRadiusHint();
      app.hooks.syncAutoWindowSizeUi();
      scheduleParamsRecompute({ debounce: true });
    });
  }

  for (const id of ["circuit", "clearance"]) {
    document.getElementById(id)?.addEventListener("input", () => {
      scheduleParamsRecompute({ debounce: true });
    });
  }

  dom.autoWindowSizeInput?.addEventListener("input", () => {
    scheduleParamsRecompute({ debounce: true, refreshAirports: true });
  });

  dom.autoWindowFromGlideInput?.addEventListener("change", () => {
    app.hooks.syncAutoWindowSizeUi();
    scheduleParamsRecompute({ debounce: true, refreshAirports: true });
  });

  dom.terrainZoomInput?.addEventListener("input", app.hooks.onTerrainZoomChange);

  dom.includeAirspaceInput?.addEventListener("change", () => {
    app.hooks.syncAirspaceUi();
    if (
      isDebugMode() &&
      app.hooks.isIncludeAirspaceEnabled() &&
      app.hooks.getMap()?.getSource("openaip")
    ) {
      const center = app.hooks.getMap().getCenter();
      app.hooks.updateAirspaceInfo(center.lng, center.lat);
    }
    scheduleParamsRecompute({ debounce: true });
  });

  dom.debugModeInput?.addEventListener("change", syncDebugUi);

  dom.sectorsOpacityInput?.addEventListener("input", () => {
    syncSectorsOpacityUi();
    applySectorsOverlayOpacity();
  });

  dom.weatherOpacityInput?.addEventListener("input", () => {
    syncWeatherOpacityUi();
    applyWeatherOverlayOpacity();
    app.hooks.schedulePersistParamsState?.();
  });

  app.hooks.detectInteractionMode();
  for (const query of ["(pointer: coarse)", "(pointer: fine)", "(hover: hover)"]) {
    window.matchMedia(query).addEventListener("change", app.hooks.detectInteractionMode);
  }
  syncDebugUi();
  app.hooks.updateParamsFooter();

  dom.paramsShell?.addEventListener("pointerenter", app.hooks.clearCellInspect);
  dom.paramsShell?.addEventListener("touchstart", app.hooks.clearCellInspect, { passive: true });

  dom.paramsFooterEl?.addEventListener("click", () => {
    if (!app.glideSettingsOpen) {
      app.hooks.openGlideSettings?.();
    }
  });
}

export { isDebugMode, isAutoParamsMode, isSingleParamsMode };
