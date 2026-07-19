const HAS_LONGPRESSED_GLIDE_SETTINGS_KEY = "gpu-mc-has-longpressed-glide-settings-v1";

let hasLongPressedGlideSettings = false;

function loadHasLongPressedGlideSettings() {
  if (typeof localStorage === "undefined") {
    return false;
  }
  try {
    return localStorage.getItem(HAS_LONGPRESSED_GLIDE_SETTINGS_KEY) === "1";
  } catch {
    return false;
  }
}

function persistHasLongPressedGlideSettings() {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(HAS_LONGPRESSED_GLIDE_SETTINGS_KEY, "1");
  } catch (error) {
    console.warn("Failed to persist glide-settings long-press tip", error);
  }
}

export function getHasLongPressedGlideSettings() {
  return hasLongPressedGlideSettings;
}

/** Mark tip complete after a long-press (or context-menu) on the glide mode button. */
export function noteGlideSettingsLongPress() {
  if (hasLongPressedGlideSettings) {
    return;
  }
  hasLongPressedGlideSettings = true;
  persistHasLongPressedGlideSettings();
}

hasLongPressedGlideSettings = loadHasLongPressedGlideSettings();
