import { PARAM_HELP, VIZ_HINTS } from "../constants.js";
import { parseVizMode as parseVizModeCore } from "./viz-mode.js";

let app;
let dom;

function isDebugMode() {
  return dom.debugModeInput?.checked ?? false;
}

export function parseVizMode() {
  return parseVizModeCore(dom.vizModeSelect?.value ?? "contours", isDebugMode());
}

function isAutoParamsMode() {
  return dom.paramsShell?.classList.contains("auto-mode") ?? false;
}

function getParamHelpText(key) {
  let text = PARAM_HELP[key];
  if (!text) {
    return null;
  }
  if (key === "los-run" && isDebugMode()) {
    text +=
      "\n\nFull Bresenham comparison and path-length diagnostics are available in Debug mode.";
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

export { getSectorsOverlayOpacity };

export function syncParamVisibility() {
  const { mode } = parseVizMode();
  if (dom.previewFieldEl) {
    dom.previewFieldEl.hidden = mode === "contours" || mode === "path-only";
  }
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
  if (!debug && (mode === "stripes" || mode === "raw")) {
    dom.vizModeSelect.value = "contours";
    syncParamVisibility();
    if (app.hooks.getConeState() && !app.hooks.isComputing()) {
      app.hooks.setStatus("Overlay type changed — click Run to refresh");
    }
  }
}

export function setParamsMode(mode) {
  const auto = mode === "auto";
  dom.paramsShell?.classList.toggle("auto-mode", auto);
  dom.paramsModeAutoBtn?.setAttribute("aria-pressed", String(auto));
  dom.paramsModeManualBtn?.setAttribute("aria-pressed", String(!auto));
  if (auto) {
    if (app.hooks.getManualAirportSelectMode()) {
      app.hooks.exitManualAirportSelectMode(true);
    }
    if (app.hooks.getAirportAreaSelectMode()) {
      app.hooks.exitAirportAreaSelectMode(true);
    }
    if (app.openParamHelpButton?.dataset.help) {
      const manualOnlyHelp = new Set([
        "preview",
        "compare-los",
        "los-run",
      ]);
      if (manualOnlyHelp.has(app.openParamHelpButton.dataset.help)) {
        closeParamHelp();
      }
    }
    app.hooks.scheduleAutoCompute({ refreshAirports: true });
  } else {
    app.hooks.clearAutoComputeScheduling();
  }
  app.hooks.syncSeedLayerVisibility();
}

export function syncDebugUi() {
  const debug = isDebugMode();
  dom.paramsShell?.classList.toggle("debug-mode", debug);
  if (!debug && dom.losRunInput) {
    dom.losRunInput.value = "0";
  }
  if (!debug && app.openParamHelpButton?.dataset.help === "los-run") {
    closeParamHelp();
  }
  if (app.openParamHelpButton?.dataset.help === "los-run" && dom.paramHelpPopover) {
    const text = getParamHelpText("los-run");
    if (text) {
      dom.paramHelpPopover.textContent = text;
    }
  }
  app.hooks.syncCompareLosButton();
  app.hooks.syncDownloadContoursButton();
  syncVizModeDebugOptions();
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

  syncParamVisibility();
  setParamsMode("auto");
  app.hooks.updateGridRadiusHint();
  app.hooks.updateTerrainResolutionHint();
  app.hooks.syncAutoWindowSizeUi();

  dom.paramsModeAutoBtn?.addEventListener("click", () => setParamsMode("auto"));
  dom.paramsModeManualBtn?.addEventListener("click", () => setParamsMode("manual"));

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
      if (isAutoParamsMode()) {
        app.hooks.scheduleAutoCompute({ debounce: true });
      }
    });
  }

  for (const id of ["circuit", "clearance"]) {
    document.getElementById(id)?.addEventListener("input", () => {
      if (isAutoParamsMode()) {
        app.hooks.scheduleAutoCompute({ debounce: true });
      }
    });
  }

  dom.autoWindowSizeInput?.addEventListener("input", () => {
    if (isAutoParamsMode()) {
      app.hooks.scheduleAutoCompute({ debounce: true, refreshAirports: true });
    }
  });

  dom.autoWindowFromGlideInput?.addEventListener("change", () => {
    app.hooks.syncAutoWindowSizeUi();
    if (isAutoParamsMode()) {
      app.hooks.scheduleAutoCompute({ debounce: true, refreshAirports: true });
    }
  });

  dom.terrainZoomInput?.addEventListener("input", app.hooks.onTerrainZoomChange);

  dom.includeAirspaceInput?.addEventListener("change", () => {
    app.hooks.syncAirspaceUi();
    if (app.hooks.isIncludeAirspaceEnabled() && app.hooks.getMap()?.getSource("openaip")) {
      const center = app.hooks.getMap().getCenter();
      app.hooks.updateAirspaceInfo(center.lng, center.lat);
    }
    if (isAutoParamsMode()) {
      app.hooks.scheduleAutoCompute({ debounce: true });
    }
  });

  dom.debugModeInput?.addEventListener("change", syncDebugUi);

  dom.sectorsOpacityInput?.addEventListener("input", () => {
    syncSectorsOpacityUi();
    applySectorsOverlayOpacity();
  });

  dom.highlightDownhillGroundPathInput?.addEventListener("change", () => {
    const lastInspectCell = app.hooks.getLastInspectCell();
    if (lastInspectCell) {
      app.hooks.refreshInspectPath(lastInspectCell);
    }
    if (app.hooks.isGeoTrackingOn()) {
      app.hooks.updateGeoLocationPath();
    }
  });

  document.getElementById("los-run")?.addEventListener("input", app.hooks.syncCompareLosButton);
  app.hooks.detectInteractionMode();
  for (const query of ["(pointer: coarse)", "(pointer: fine)", "(hover: hover)"]) {
    window.matchMedia(query).addEventListener("change", app.hooks.detectInteractionMode);
  }
  app.hooks.syncCompareLosButton();
  syncDebugUi();
  app.hooks.updateParamsFooter();

  dom.paramsShell?.addEventListener("pointerenter", app.hooks.clearCellInspect);
  dom.paramsShell?.addEventListener("touchstart", app.hooks.clearCellInspect, { passive: true });
}

export { isDebugMode, isAutoParamsMode };
