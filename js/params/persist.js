const PARAMS_STORAGE_KEY = "gpu-mc-params-v1";
const VALID_MODES = new Set(["single", "auto"]);

let saveTimer = null;

function readCheckbox(el) {
  return el?.checked ?? false;
}

function writeCheckbox(el, value) {
  if (el) {
    el.checked = Boolean(value);
  }
}

function readInput(el) {
  return el?.value ?? "";
}

function writeInput(el, value) {
  if (el != null && value != null) {
    el.value = String(value);
  }
}

function collectFormState(dom) {
  return {
    ld: readInput(document.getElementById("ld")),
    circuit: readInput(document.getElementById("circuit")),
    clearance: readInput(document.getElementById("clearance")),
    maxAlt: readInput(document.getElementById("max-alt")),
    terrainZoom: readInput(document.getElementById("terrain-zoom")),
    autoWindowFromGlide: readCheckbox(dom.autoWindowFromGlideInput),
    autoWindowSize: readInput(dom.autoWindowSizeInput),
    includeAirspace: readCheckbox(dom.includeAirspaceInput),
    includeManualAirports: readCheckbox(dom.includeManualAirportsInput),
    updateMap: readInput(document.getElementById("update-map")),
    vizMode: readInput(dom.vizModeSelect),
    sectorsOpacity: readInput(dom.sectorsOpacityInput),
    weatherOpacity: readInput(dom.weatherOpacityInput),
    debugMode: readCheckbox(dom.debugModeInput),
  };
}

function applyFormState(dom, form) {
  if (!form) {
    return;
  }
  writeInput(document.getElementById("ld"), form.ld);
  writeInput(document.getElementById("circuit"), form.circuit);
  writeInput(document.getElementById("clearance"), form.clearance);
  writeInput(document.getElementById("max-alt"), form.maxAlt);
  writeInput(document.getElementById("terrain-zoom"), form.terrainZoom);
  writeCheckbox(dom.autoWindowFromGlideInput, form.autoWindowFromGlide);
  writeInput(dom.autoWindowSizeInput, form.autoWindowSize);
  writeCheckbox(dom.includeAirspaceInput, form.includeAirspace);
  writeCheckbox(dom.includeManualAirportsInput, form.includeManualAirports);
  writeInput(document.getElementById("update-map"), form.updateMap);
  writeInput(dom.vizModeSelect, form.vizMode);
  writeInput(dom.sectorsOpacityInput, form.sectorsOpacity);
  writeInput(dom.weatherOpacityInput, form.weatherOpacity);
  writeCheckbox(dom.debugModeInput, form.debugMode);
}

export function loadParamsState() {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    const raw = localStorage.getItem(PARAMS_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const data = JSON.parse(raw);
    if (data.version !== 1) {
      return null;
    }
    const mode = VALID_MODES.has(data.mode) ? data.mode : "auto";
    return {
      mode,
      form: data.form ?? null,
    };
  } catch (error) {
    console.warn("Failed to load saved parameters", error);
    return null;
  }
}

export function saveParamsState(dom, mode, app) {
  if (typeof localStorage === "undefined" || !dom) {
    return;
  }
  const resolvedMode = VALID_MODES.has(mode) ? mode : "auto";
  try {
    localStorage.setItem(
      PARAMS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        mode: resolvedMode,
        form: collectFormState(dom),
      })
    );
  } catch (error) {
    console.warn("Failed to persist parameters", error);
  }
}

export function scheduleSaveParamsState(dom, mode, app) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    saveParamsState(dom, mode, app);
  }, 200);
}

export function initParamsPersistence(hooks, dom, app, getMode) {
  hooks.persistParamsState = () => {
    saveParamsState(dom, getMode(), app);
  };
  hooks.schedulePersistParamsState = () => {
    scheduleSaveParamsState(dom, getMode(), app);
  };
}

export function restoreParamsState(dom, app, saved) {
  if (!saved) {
    return;
  }
  if (saved.form) {
    applyFormState(dom, saved.form);
  }
}
