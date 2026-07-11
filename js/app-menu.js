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
    }
    setGlideSettingsOpen(open);
  });

  dom.iconChSettingsBtn?.addEventListener("click", () => {
    const open = !app.iconChSettingsOpen;
    if (open) {
      app.glideSettingsOpen = false;
      hooks.refreshIconCh1Settings?.();
    }
    setIconChSettingsOpen(open);
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
  return Boolean(app.iconChActiveModel);
}

export function getIconChActiveModel() {
  return app.iconChActiveModel;
}

export function openAppMenu() {
  if (hooks.getAirportAreaSelectMode?.()) {
    hooks.exitAirportAreaSelectMode(false);
  }
  if (hooks.getManualAirportSelectMode?.()) {
    hooks.exitManualAirportSelectMode(false);
  }
  app.glideSettingsOpen = false;
  app.iconChSettingsOpen = false;
  app.appMenuOpen = true;
  syncAppMenuUi();
}

export function closeAppMenu() {
  app.appMenuOpen = false;
  syncAppMenuUi();
}

export function openGlideSettings() {
  app.iconChSettingsOpen = false;
  app.glideSettingsOpen = true;
  openAppMenu();
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

function syncAppMenuUi() {
  document.body.classList.toggle("app-menu-open", app.appMenuOpen);
  document.body.classList.toggle("glidecones-disabled", !app.glideConesEnabled);
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

  dom.iconCh1EnableBtn?.classList.toggle("is-active", app.iconChActiveModel === "icon-ch1");
  dom.iconCh1EnableBtn?.setAttribute("aria-pressed", String(app.iconChActiveModel === "icon-ch1"));
  dom.iconCh2EnableBtn?.classList.toggle("is-active", app.iconChActiveModel === "icon-ch2");
  dom.iconCh2EnableBtn?.setAttribute("aria-pressed", String(app.iconChActiveModel === "icon-ch2"));

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
