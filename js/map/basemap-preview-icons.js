import { assetUrl } from "../asset-url.js";

/** Bump when replacing committed basemap thumbnail bytes (shell precache). */
const BASEMAP_ICON_ASSETS_VERSION = 2;

const MODES = ["hillshade", "osm", "satellite", "gradient"];

const MODE_LABELS = {
  hillshade: "Hillshade",
  osm: "OSM",
  satellite: "Satellite",
  gradient: "Gradient",
};

/** Floating chrome cycle order (and menu default path). */
export const BASEMAP_CYCLE_ORDER = ["osm", "satellite", "gradient", "hillshade"];

/** @type {Record<string, string>|null} */
let previewIconUrls = null;

export function nextBasemapCycleMode(mode) {
  const index = BASEMAP_CYCLE_ORDER.indexOf(mode);
  const from = index < 0 ? 0 : index;
  return BASEMAP_CYCLE_ORDER[(from + 1) % BASEMAP_CYCLE_ORDER.length];
}

export function getBasemapPreviewIconUrls() {
  return previewIconUrls;
}

export function hasBasemapPreviewIcons() {
  return allIconsPresent(previewIconUrls);
}

export function syncBasemapCycleButton(btn, img, mode) {
  if (!btn) {
    return;
  }
  if (!hasBasemapPreviewIcons()) {
    btn.hidden = true;
    return;
  }
  const url = previewIconUrls[mode] ?? previewIconUrls.osm;
  if (!url) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  if (img) {
    img.src = url;
  }
  btn.setAttribute("aria-label", `Base map: ${MODE_LABELS[mode] ?? mode} (cycle)`);
}

function staticIconUrls() {
  const icons = {};
  for (const mode of MODES) {
    icons[mode] = assetUrl(`icons/basemap/${mode}.png?v=${BASEMAP_ICON_ASSETS_VERSION}`);
  }
  return icons;
}

function allIconsPresent(icons) {
  return MODES.every((mode) => Boolean(icons?.[mode]));
}

function applyIconsToButtons(buttons, icons) {
  for (const mode of MODES) {
    const btn = buttons?.[mode];
    const url = icons[mode];
    if (!btn || !url) {
      continue;
    }
    btn.classList.add("basemap-preview-ready");
    btn.setAttribute("aria-label", MODE_LABELS[mode]);
    btn.replaceChildren();
    const img = document.createElement("img");
    img.className = "basemap-preview-icon";
    img.src = url;
    img.alt = "";
    img.draggable = false;
    btn.appendChild(img);
  }
}

/**
 * Apply Matterhorn basemap thumbnails (hillshade / OSM / satellite / gradient)
 * from static assets under icons/basemap/.
 */
export async function ensureBasemapPreviewIcons(buttons) {
  if (
    !buttons?.hillshade ||
    !buttons?.osm ||
    !buttons?.satellite ||
    !buttons?.gradient
  ) {
    return false;
  }

  const icons = staticIconUrls();
  applyIconsToButtons(buttons, icons);
  previewIconUrls = icons;
  return true;
}
