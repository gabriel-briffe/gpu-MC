import {
  GRADIENT_MAX_ALT_DEFAULT,
  GRADIENT_MAX_ALT_MAX,
  GRADIENT_MAX_ALT_MIN,
  GRADIENT_MAX_ALT_STEP,
  GRADIENT_MIN_ALT_DEFAULT,
} from "../constants.js";

const GRADIENT_STORAGE_KEY = "gpu-mc-gradient-v1";

function stepAltitude(value) {
  return Math.round(value / GRADIENT_MAX_ALT_STEP) * GRADIENT_MAX_ALT_STEP;
}

function clampStoredMaxAltitude(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return GRADIENT_MAX_ALT_DEFAULT;
  }
  return Math.max(GRADIENT_MAX_ALT_MIN, Math.min(GRADIENT_MAX_ALT_MAX, stepAltitude(numeric)));
}

function clampStoredMinAltitude(value, maxAlt) {
  const numeric = Number(value);
  const ceiling = clampStoredMaxAltitude(maxAlt);
  if (!Number.isFinite(numeric)) {
    return GRADIENT_MIN_ALT_DEFAULT;
  }
  return Math.max(0, Math.min(ceiling, stepAltitude(numeric)));
}

export function loadGradientState() {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    const raw = localStorage.getItem(GRADIENT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const data = JSON.parse(raw);
    if (data.version !== 1) {
      return null;
    }
    const gradientMaxAltitude = clampStoredMaxAltitude(data.gradientMaxAltitude);
    const gradientMinAltitude = clampStoredMinAltitude(
      data.gradientMinAltitude ?? GRADIENT_MIN_ALT_DEFAULT,
      gradientMaxAltitude
    );
    return {
      gradientMinAltitude,
      gradientMaxAltitude,
    };
  } catch (error) {
    console.warn("Failed to load saved gradient settings", error);
    return null;
  }
}

export function saveGradientSettings({ gradientMinAltitude, gradientMaxAltitude }) {
  if (typeof localStorage === "undefined") {
    return;
  }
  const maxAlt = clampStoredMaxAltitude(gradientMaxAltitude);
  const minAlt = clampStoredMinAltitude(gradientMinAltitude, maxAlt);
  try {
    localStorage.setItem(
      GRADIENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        gradientMinAltitude: minAlt,
        gradientMaxAltitude: maxAlt,
      })
    );
  } catch (error) {
    console.warn("Failed to persist gradient settings", error);
  }
}
