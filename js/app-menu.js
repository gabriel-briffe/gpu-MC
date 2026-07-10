import { clearAllOverlays } from "./compute/visualization.js";
import {
  isAutoParamsMode,
  isSingleParamsMode,
} from "./params/panel.js";

let hooks;
let app;
let dom;

export function initAppMenu(h, domRefs) {
  hooks = h;
  app = h.app;
  dom = domRefs;

  dom.appMenuBtn?.addEventListener("click", () => {
    if (app.appMenuOpen) {
      closeAppMenu();
    } else {
      openAppMenu();
    }
  });

  dom.appMenuBackdrop?.addEventListener("click", closeAppMenu);

  dom.glideConesEnableBtn?.addEventListener("click", () => {
    setGlideConesEnabled(!app.glideConesEnabled);
  });

  dom.iconCh1EnableBtn?.addEventListener("click", () => {
    setIconCh1Enabled(!app.iconCh1Enabled);
  });

  dom.glideConesSettingsBtn?.addEventListener("click", () => {
    setGlideSettingsOpen(!app.glideSettingsOpen);
  });

  dom.iconCh1SettingsBtn?.addEventListener("click", () => {
    setIconCh1SettingsOpen(!app.iconCh1SettingsOpen);
  });

  syncAppMenuUi();
}

export function isAppMenuOpen() {
  return app.appMenuOpen;
}

export function isGlideConesEnabled() {
  return app.glideConesEnabled;
}

export function isIconCh1Enabled() {
  return app.iconCh1Enabled;
}

export function openAppMenu() {
  if (hooks.getAirportAreaSelectMode?.()) {
    hooks.exitAirportAreaSelectMode(false);
  }
  if (hooks.getManualAirportSelectMode?.()) {
    hooks.exitManualAirportSelectMode(false);
  }
  app.appMenuOpen = true;
  syncAppMenuUi();
}

export function closeAppMenu() {
  app.appMenuOpen = false;
  syncAppMenuUi();
}

export function openGlideSettings() {
  app.glideSettingsOpen = true;
  openAppMenu();
  syncAppMenuUi();
}

export function setGlideSettingsOpen(open) {
  app.glideSettingsOpen = open;
  syncAppMenuUi();
}

export function setIconCh1SettingsOpen(open) {
  app.iconCh1SettingsOpen = open;
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
    hooks.syncSeedLayerVisibility?.();
  } else if (isAutoParamsMode()) {
    hooks.scheduleAutoCompute?.({ refreshAirports: true });
  } else if (isSingleParamsMode() && app.singleLastPick?.id) {
    hooks.scheduleSingleAirportCompute?.(undefined, { debounce: false });
  }
  syncAppMenuUi();
}

export function setIconCh1Enabled(enabled) {
  app.iconCh1Enabled = enabled;
  syncAppMenuUi();
}

function syncAppMenuUi() {
  document.body.classList.toggle("app-menu-open", app.appMenuOpen);
  document.body.classList.toggle("glidecones-disabled", !app.glideConesEnabled);
  document.body.classList.toggle("iconch1-enabled", app.iconCh1Enabled);

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

  dom.iconCh1EnableBtn?.classList.toggle("is-active", app.iconCh1Enabled);
  dom.iconCh1EnableBtn?.setAttribute("aria-pressed", String(app.iconCh1Enabled));

  dom.glideconesSection?.classList.toggle("glide-settings-open", app.glideSettingsOpen);
  if (dom.glideConesSettings) {
    dom.glideConesSettings.hidden = !app.glideSettingsOpen;
  }
  dom.glideConesSettingsBtn?.setAttribute("aria-expanded", String(app.glideSettingsOpen));

  if (dom.iconCh1Settings) {
    dom.iconCh1Settings.hidden = !app.iconCh1SettingsOpen;
  }
  dom.iconCh1SettingsBtn?.setAttribute("aria-expanded", String(app.iconCh1SettingsOpen));

  if (dom.iconCh1Chrome) {
    dom.iconCh1Chrome.hidden = !app.iconCh1Enabled;
  }
}
