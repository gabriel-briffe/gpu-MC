const HAS_LONGPRESSED_GRADIENT_SETTINGS_KEY =
  "gpu-mc-has-longpressed-gradient-settings-v1";

let hasLongPressedGradientSettings = false;

function loadHasLongPressedGradientSettings() {
  if (typeof localStorage === "undefined") {
    return false;
  }
  try {
    return localStorage.getItem(HAS_LONGPRESSED_GRADIENT_SETTINGS_KEY) === "1";
  } catch {
    return false;
  }
}

function persistHasLongPressedGradientSettings() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(HAS_LONGPRESSED_GRADIENT_SETTINGS_KEY, "1");
  } catch (error) {
    console.warn("Failed to persist gradient-settings long-press tip", error);
  }
}

export function getHasLongPressedGradientSettings() {
  return hasLongPressedGradientSettings;
}

/** Mark tip complete after a long-press on the basemap cycle button. */
export function noteGradientSettingsLongPress() {
  if (hasLongPressedGradientSettings) {
    return;
  }
  hasLongPressedGradientSettings = true;
  persistHasLongPressedGradientSettings();
}

hasLongPressedGradientSettings = loadHasLongPressedGradientSettings();
