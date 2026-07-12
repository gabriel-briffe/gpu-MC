import {
  GRADIENT_MAX_ALT_DEFAULT,
  GRADIENT_MAX_ALT_MAX,
  GRADIENT_MAX_ALT_MIN,
  GRADIENT_MAX_ALT_STEP,
} from "../constants.js";

const GRADIENT_STORAGE_KEY = "gpu-mc-gradient-v1";

function clampStoredMaxAltitude(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return GRADIENT_MAX_ALT_DEFAULT;
  }
  const stepped =
    Math.round(numeric / GRADIENT_MAX_ALT_STEP) * GRADIENT_MAX_ALT_STEP;
  return Math.max(GRADIENT_MAX_ALT_MIN, Math.min(GRADIENT_MAX_ALT_MAX, stepped));
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
    return {
      gradientMaxAltitude: clampStoredMaxAltitude(data.gradientMaxAltitude),
    };
  } catch (error) {
    console.warn("Failed to load saved gradient settings", error);
    return null;
  }
}

export function saveGradientMaxAltitude(maxAlt) {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(
      GRADIENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        gradientMaxAltitude: clampStoredMaxAltitude(maxAlt),
      })
    );
  } catch (error) {
    console.warn("Failed to persist gradient settings", error);
  }
}
