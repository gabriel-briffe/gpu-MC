import { clearAllOverlays } from "./compute/visualization.js";
import {
  isAutoParamsMode,
  isSingleParamsMode,
  getParamsMode,
  setParamsMode,
} from "./params/panel.js";
import { initParamSteppers } from "./params/steppers.js";
import { setGradientAltitudes } from "./map/terrain-gradient.js";
import { loadGradientState, saveGradientSettings } from "./map/gradient-persist.js";
import {
  nextBasemapCycleMode,
  syncBasemapCycleButton,
} from "./map/basemap-preview-icons.js";
import { assetUrl } from "./asset-url.js";
import { bindLongPress } from "./ui/long-press.js";
import {
  getHasLongPressedGlideSettings,
  noteGlideSettingsLongPress,
} from "./ui/glide-settings-longpress-tip.js";
import {
  getHasLongPressedGradientSettings,
  noteGradientSettingsLongPress,
} from "./ui/gradient-settings-longpress-tip.js";
import { getHasCycledAirport } from "./airports/auto-disable-tip.js";

const GLIDE_MODE_CYCLE = ["none", "single", "auto"];
const GLIDE_MODE_ICONS = {
  none: "icons/mode-none.svg",
  single: "icons/mode-single.svg",
  auto: "icons/mode-auto.svg",
};
const GLIDE_MODE_LABELS = {
  none: "No glide cones",
  single: "Single airport",
  auto: "Auto",
};

let hooks;
let app;
let dom;

export function initAppMenu(h, domRefs) {
  hooks = h;
  app = h.app;
  dom = domRefs;

  restoreGradientState(loadGradientState());
  syncGradientAltitudeInputs();

  hooks.syncGlideSettingsLongpressHint = syncGlideSettingsLongpressHint;
  hooks.syncGradientSettingsLongpressHint = syncGradientSettingsLongpressHint;

  dom.appMenuBtn?.addEventListener("click", () => {
    if (app.appMenuOpen) {
      closeAppMenu();
    } else {
      openAppMenu();
    }
  });

  dom.appMenuBackdrop?.addEventListener("click", closeAppMenu);

  dom.basemapHillshadeBtn?.addEventListener("click", () => {
    setBaseMapRaster("hillshade");
  });

  dom.basemapOsmBtn?.addEventListener("click", () => {
    setBaseMapRaster("osm");
  });

  dom.basemapSatelliteBtn?.addEventListener("click", () => {
    setBaseMapRaster("satellite");
  });

  dom.basemapGradientBtn?.addEventListener("click", () => {
    setBaseMapRaster("gradient");
  });

  bindLongPress(dom.basemapCycleBtn, {
    onShort: () => {
      setBaseMapRaster(nextBasemapCycleMode(app.baseMapRaster));
    },
    onLong: () => {
      noteGradientSettingsLongPress();
      syncGradientSettingsLongpressHint();
      openGradientSettings();
    },
  });

  bindLongPress(dom.glideModeCycleBtn, {
    onShort: () => {
      cycleGlideMode();
    },
    onLong: () => {
      noteGlideSettingsLongPress();
      syncGlideSettingsLongpressHint();
      openGlideSettings({ scrollToOverlay: true });
    },
  });

  window.addEventListener("resize", () => {
    syncGlideSettingsLongpressHint();
    syncGradientSettingsLongpressHint();
  });

  dom.basemapGradientSettingsBtn?.addEventListener("click", () => {
    const open = !app.gradientSettingsOpen;
    if (open) {
      app.glideSettingsOpen = false;
      app.iconChSettingsOpen = false;
    }
    setGradientSettingsOpen(open);
  });

  dom.gradientMaxAltInput?.addEventListener("input", () => {
    updateGradientAltitudesFromInputs();
  });

  dom.gradientMinAltInput?.addEventListener("input", () => {
    updateGradientAltitudesFromInputs();
  });

  initParamSteppers(dom.basemapGradientSettings);

  dom.airspaceOpenAipBtn?.addEventListener("click", () => {
    if (!hooks.areOpenAipAirportsAvailable?.()) {
      return;
    }
    setOpenAipVectorEnabled(!app.openAipVectorEnabled);
  });

  dom.glideConesEnableBtn?.addEventListener("click", () => {
    setGlideConesEnabled(!app.glideConesEnabled);
  });

  dom.iconCh1EnableBtn?.addEventListener("click", () => {
    const next = app.iconChActiveModel === "icon-ch1" ? null : "icon-ch1";
    setIconChActiveModel(next);
  });

  dom.iconCh2EnableBtn?.addEventListener("click", () => {
    const next = app.iconChActiveModel === "icon-ch2" ? null : "icon-ch2";
    setIconChActiveModel(next);
  });

  dom.glideConesSettingsBtn?.addEventListener("click", () => {
    const open = !app.glideSettingsOpen;
    if (open) {
      app.iconChSettingsOpen = false;
      app.gradientSettingsOpen = false;
    }
    setGlideSettingsOpen(open);
  });

  dom.iconChSettingsBtn?.addEventListener("click", () => {
    const open = !app.iconChSettingsOpen;
    if (open) {
      app.glideSettingsOpen = false;
      app.gradientSettingsOpen = false;
      hooks.refreshIconCh1Settings?.();
    }
    setIconChSettingsOpen(open);
  });

  syncAppMenuUi();
}

function syncGradientAltitudeInputs() {
  if (dom.gradientMinAltInput) {
    dom.gradientMinAltInput.max = String(app.gradientMaxAltitude);
    dom.gradientMinAltInput.value = String(app.gradientMinAltitude);
  }
  if (dom.gradientMaxAltInput) {
    dom.gradientMaxAltInput.value = String(app.gradientMaxAltitude);
  }
}

function updateGradientAltitudesFromInputs() {
  const { minAlt, maxAlt } = setGradientAltitudes({
    minAlt: dom.gradientMinAltInput?.value,
    maxAlt: dom.gradientMaxAltInput?.value,
  });
  const changed =
    app.gradientMinAltitude !== minAlt || app.gradientMaxAltitude !== maxAlt;
  app.gradientMinAltitude = minAlt;
  app.gradientMaxAltitude = maxAlt;
  syncGradientAltitudeInputs();
  if (!changed) {
    return;
  }
  saveGradientSettings({
    gradientMinAltitude: minAlt,
    gradientMaxAltitude: maxAlt,
  });
  hooks.reloadGradientBasemap?.();
}

export function restoreGradientState(saved) {
  if (!saved) {
    return;
  }
  const { minAlt, maxAlt } = setGradientAltitudes({
    minAlt: saved.gradientMinAltitude,
    maxAlt: saved.gradientMaxAltitude,
  });
  app.gradientMinAltitude = minAlt;
  app.gradientMaxAltitude = maxAlt;
  syncGradientAltitudeInputs();
}

export function isGlideConesEnabled() {
  return app.glideConesEnabled;
}

function getGlideChromeMode() {
  if (!app.glideConesEnabled) {
    return "none";
  }
  const mode = getParamsMode();
  return mode === "single" || mode === "auto" ? mode : "auto";
}

function nextGlideChromeMode(mode) {
  const index = GLIDE_MODE_CYCLE.indexOf(mode);
  const from = index < 0 ? 0 : index;
  return GLIDE_MODE_CYCLE[(from + 1) % GLIDE_MODE_CYCLE.length];
}

export function syncGlideModeCycleButton() {
  const btn = dom.glideModeCycleBtn;
  const img = dom.glideModeCycleIcon;
  if (!btn || !img) {
    return;
  }
  const hide = Boolean(app.cacheSelectMode);
  btn.hidden = hide;
  if (hide) {
    syncGlideSettingsLongpressHint();
    return;
  }
  const mode = getGlideChromeMode();
  img.src = assetUrl(GLIDE_MODE_ICONS[mode]);
  btn.setAttribute(
    "aria-label",
    `${GLIDE_MODE_LABELS[mode]} (tap to cycle, long-press for settings)`
  );
  syncGlideSettingsLongpressHint();
}

function isModeAirportHintVisible() {
  if (
    !app.glideConesEnabled ||
    app.cacheSelectMode ||
    hooks.getManualAirportSelectMode?.() ||
    app.appMenuOpen
  ) {
    return false;
  }
  if (isSingleParamsMode() && !app.singleLastPick?.id) {
    return true;
  }
  if (isAutoParamsMode() && !getHasCycledAirport()) {
    return true;
  }
  return false;
}

function positionChromeLongpressHint(hint, btn) {
  const rect = btn.getBoundingClientRect();
  hint.style.top = `${rect.top + rect.height / 2}px`;
  hint.style.left = `${rect.right + 8}px`;
  hint.hidden = false;
}

function syncGradientSettingsLongpressHint() {
  const hint = dom.gradientSettingsLongpressHintEl;
  const btn = dom.basemapCycleBtn;
  if (!hint) {
    return;
  }
  const show =
    !getHasLongPressedGradientSettings() &&
    app.baseMapRaster === "gradient" &&
    !app.cacheSelectMode &&
    !app.appMenuOpen &&
    Boolean(btn) &&
    !btn.hidden;
  if (!show) {
    hint.hidden = true;
    return;
  }
  positionChromeLongpressHint(hint, btn);
}

function syncGlideSettingsLongpressHint() {
  const hint = dom.glideSettingsLongpressHintEl;
  const btn = dom.glideModeCycleBtn;
  if (!hint) {
    return;
  }
  const inSingleOrAuto =
    app.glideConesEnabled && (isSingleParamsMode() || isAutoParamsMode());
  const show =
    !getHasLongPressedGlideSettings() &&
    inSingleOrAuto &&
    !isModeAirportHintVisible() &&
    !app.cacheSelectMode &&
    !app.appMenuOpen &&
    Boolean(btn) &&
    !btn.hidden;
  if (!show) {
    hint.hidden = true;
    return;
  }
  positionChromeLongpressHint(hint, btn);
}

function cycleGlideMode() {
  const next = nextGlideChromeMode(getGlideChromeMode());
  if (next === "none") {
    setGlideConesEnabled(false);
    return;
  }
  if (!app.glideConesEnabled) {
    app.glideConesEnabled = true;
  }
  setParamsMode(next);
  syncAppMenuUi();
}

export function setBaseMapRaster(mode) {
  if (app.baseMapRaster === mode) {
    return;
  }
  app.baseMapRaster = mode;
  hooks.setBaseMapRasterMode?.(mode);
  hooks.syncAirspaceUi?.();
  syncAppMenuUi();
}

export function isOpenAipVectorEnabled() {
  return app.openAipVectorEnabled;
}

export function setOpenAipVectorEnabled(enabled) {
  if (app.openAipVectorEnabled === enabled) {
    return;
  }
  app.openAipVectorEnabled = enabled;
  hooks.syncAirspaceUi?.();
  syncAppMenuUi();
}

export function isIconCh1Enabled() {
  return Boolean(app.iconChActiveModel);
}

export function getIconChActiveModel() {
  return app.iconChActiveModel;
}

export function openAppMenu() {
  app.glideSettingsOpen = false;
  app.iconChSettingsOpen = false;
  app.gradientSettingsOpen = false;
  app.appMenuOpen = true;
  syncAppMenuUi();
}

export function closeAppMenu() {
  app.appMenuOpen = false;
  syncAppMenuUi();
}

function scrollGlideSettingsToOverlay() {
  const target = dom.paramsOverlayField ?? dom.vizModeSelect;
  if (!target) {
    return;
  }
  // Wait for menu + expanded subsection to layout before scrolling.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  });
}

export function openGlideSettings({ scrollToOverlay = false } = {}) {
  app.iconChSettingsOpen = false;
  app.gradientSettingsOpen = false;
  app.appMenuOpen = true;
  app.glideSettingsOpen = true;
  syncAppMenuUi();
  if (scrollToOverlay) {
    scrollGlideSettingsToOverlay();
  }
}

export function openGradientSettings() {
  app.glideSettingsOpen = false;
  app.iconChSettingsOpen = false;
  app.appMenuOpen = true;
  app.gradientSettingsOpen = true;
  syncAppMenuUi();
}

export function setGlideSettingsOpen(open) {
  app.glideSettingsOpen = open;
  syncAppMenuUi();
}

export function setIconChSettingsOpen(open) {
  app.iconChSettingsOpen = open;
  syncAppMenuUi();
}

export function setGradientSettingsOpen(open) {
  app.gradientSettingsOpen = open;
  syncAppMenuUi();
}

export function setGlideConesEnabled(enabled) {
  if (app.glideConesEnabled === enabled) {
    return;
  }
  app.glideConesEnabled = enabled;
  if (!enabled) {
    hooks.clearAutoComputeScheduling?.();
    hooks.clearSingleComputeScheduling?.();
    if (hooks.isComputing()) {
      hooks.setComputeShouldStop(true);
    }
    clearAllOverlays();
    hooks.syncComputeContextBar?.();
  } else if (isAutoParamsMode()) {
    hooks.scheduleAutoCompute?.({ refreshAirports: true });
  } else if (isSingleParamsMode() && app.singleLastPick?.id) {
    hooks.scheduleSingleAirportCompute?.(undefined, { debounce: false });
  }
  syncAppMenuUi();
  hooks.syncModeAirportHint?.();
}

export function toggleIconChActiveModel() {
  if (!app.iconChActiveModel) {
    return;
  }
  const next = app.iconChActiveModel === "icon-ch1" ? "icon-ch2" : "icon-ch1";
  setIconChActiveModel(next);
}

export function setIconChActiveModel(modelId) {
  if (app.iconChActiveModel === modelId) {
    return;
  }
  const wasEnabled = Boolean(app.iconChActiveModel);
  app.iconChActiveModel = modelId;
  if (modelId) {
    hooks.setActiveIconChModel?.(modelId);
    hooks.startIconCh1?.();
  } else if (wasEnabled) {
    hooks.stopIconCh1?.();
  }
  syncAppMenuUi();
}

export function syncAppMenuUi() {
  document.body.classList.toggle("app-menu-open", app.appMenuOpen);
  document.body.classList.toggle("glidecones-disabled", !app.glideConesEnabled);
  document.body.classList.toggle(
    "basemap-raster-enabled",
    app.baseMapRaster === "osm" ||
      app.baseMapRaster === "satellite" ||
      app.baseMapRaster === "gradient"
  );
  document.body.classList.toggle("iconch1-enabled", Boolean(app.iconChActiveModel));

  if (dom.appMenuBtn) {
    dom.appMenuBtn.setAttribute("aria-expanded", String(app.appMenuOpen));
  }
  if (dom.appMenuBackdrop) {
    dom.appMenuBackdrop.hidden = !app.appMenuOpen;
  }
  if (dom.paramsShell) {
    dom.paramsShell.hidden = !app.appMenuOpen;
  }

  dom.glideConesEnableBtn?.classList.toggle("is-active", app.glideConesEnabled);
  dom.glideConesEnableBtn?.setAttribute("aria-pressed", String(app.glideConesEnabled));

  dom.basemapHillshadeBtn?.classList.toggle("is-active", app.baseMapRaster === "hillshade");
  dom.basemapHillshadeBtn?.setAttribute("aria-pressed", String(app.baseMapRaster === "hillshade"));

  dom.basemapOsmBtn?.classList.toggle("is-active", app.baseMapRaster === "osm");
  dom.basemapOsmBtn?.setAttribute("aria-pressed", String(app.baseMapRaster === "osm"));

  dom.basemapSatelliteBtn?.classList.toggle("is-active", app.baseMapRaster === "satellite");
  dom.basemapSatelliteBtn?.setAttribute("aria-pressed", String(app.baseMapRaster === "satellite"));

  dom.basemapGradientBtn?.classList.toggle("is-active", app.baseMapRaster === "gradient");
  dom.basemapGradientBtn?.setAttribute("aria-pressed", String(app.baseMapRaster === "gradient"));

  syncBasemapCycleButton(dom.basemapCycleBtn, dom.basemapCycleIcon, app.baseMapRaster);
  syncGradientSettingsLongpressHint();
  syncGlideModeCycleButton();
  hooks.syncModeAirportHint?.();

  const openAipAvailable = hooks.areOpenAipAirportsAvailable?.() ?? false;
  if (dom.airspaceOpenAipBtn) {
    dom.airspaceOpenAipBtn.disabled = !openAipAvailable;
    const openAipActive = openAipAvailable && app.openAipVectorEnabled;
    dom.airspaceOpenAipBtn.classList.toggle("is-active", openAipActive);
    dom.airspaceOpenAipBtn.setAttribute("aria-pressed", String(openAipActive));
  }

  dom.iconCh1EnableBtn?.classList.toggle("is-active", app.iconChActiveModel === "icon-ch1");
  dom.iconCh1EnableBtn?.setAttribute("aria-pressed", String(app.iconChActiveModel === "icon-ch1"));
  dom.iconCh2EnableBtn?.classList.toggle("is-active", app.iconChActiveModel === "icon-ch2");
  dom.iconCh2EnableBtn?.setAttribute("aria-pressed", String(app.iconChActiveModel === "icon-ch2"));

  dom.basemapSection?.classList.toggle("gradient-settings-open", app.gradientSettingsOpen);
  if (dom.basemapGradientSettings) {
    dom.basemapGradientSettings.hidden = !app.gradientSettingsOpen;
  }
  dom.basemapGradientSettingsBtn?.setAttribute("aria-expanded", String(app.gradientSettingsOpen));

  dom.glideconesSection?.classList.toggle("glide-settings-open", app.glideSettingsOpen);
  if (dom.glideConesSettings) {
    dom.glideConesSettings.hidden = !app.glideSettingsOpen;
  }
  dom.glideConesSettingsBtn?.setAttribute("aria-expanded", String(app.glideSettingsOpen));

  if (dom.iconChSettings) {
    dom.iconChSettings.hidden = !app.iconChSettingsOpen;
  }
  dom.iconChSettingsBtn?.setAttribute("aria-expanded", String(app.iconChSettingsOpen));

  if (dom.iconCh1Chrome) {
    dom.iconCh1Chrome.hidden = !app.iconChActiveModel;
  }
}
