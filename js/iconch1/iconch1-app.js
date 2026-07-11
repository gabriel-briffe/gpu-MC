import initGrib, {
  decode_template42_values_f32,
  grib2_message_level,
  parse_grib2_raw,
} from "./pkg/gribinfo.js";
import {
  GRIB_MODELS,
  buildLevelAltitudeMap,
  formatAltitudeLabel,
  formatDateStamp,
  nearestDisplayAltitudeM,
} from "./grib-catalog.js";
import {
  catalogEntriesFromItems,
  fetchForecastItemsForRun,
  getCollectionAssetUrl,
  pickLatestMeteoSwissRun,
  splitGribMessages,
} from "./meteoswiss-catalog.js";
import { applyIdwWeightTable, buildIdwWeightTable, buildSectorGeoJsonFromFieldGrib, clearIdwPipeline, ensureRegridWasm, invalidateIdwWeightTable, isIdwPipelineInstalled, isRegridWasmEnabled } from "./regrid.js";
import { buildSectorGeoJson } from "./contour-geojson.js";
import { readProxiedFile, toRawGribBytes, formatError } from "./grib-io.js";
import {
  CH_CONTOUR_TARGET_HEIGHTS_M,
  buildChContourCacheKey,
  defaultCacheFromIso,
  defaultCacheToIso,
  findValidTimeIso,
  deleteAllChContourCacheForModel,
  estimateJsonByteSize,
  formatByteSize,
  formatValidTimeLabel,
  getChContourCacheStats,
  getFreshChContourCacheEntry,
  listFreshChContourCacheEntries,
  pickLevelsNearTargets,
  putChContourCacheEntry,
  snapToNearestTime,
  utcTodayKey,
  validTimeIso,
  validTimesInRange,
} from "./ch-contour-cache.js";
import { assetUrl } from "../asset-url.js";
import { toggleIconChActiveModel } from "../app-menu.js";

const ICON_CH_MODELS = ["icon-ch1", "icon-ch2"];
const DEFAULT_ALT_TARGET_M = 4000;
export const ICONCH1_SECTOR_SOURCE_ID = "ch1-sectors";
export const ICONCH1_SECTOR_LAYER_ID = "ch1-sectors-layer";
const DEBUG_PREFIX = "[IconCH]";

function getModel(modelId = state.modelId) {
  return GRIB_MODELS[modelId];
}

function debugLog(step, detail) {
  if (detail === undefined) {
    console.log(`${DEBUG_PREFIX} ${step}`);
    return;
  }
  console.log(`${DEBUG_PREFIX} ${step}`, detail);
}

let hooks;
let ui;
let eventsBound = false;

const state = {
  modelId: "icon-ch1",
  todayKey: utcTodayKey(),
  dateStamp: "",
  runHour: "",
  entries: [],
  levelHeights: new Map(),
  levelAltitudeMap: new Map(),
  cacheRecords: [],
  validTimes: [],
  levels: [],
  validTimeIso: "",
  forecastHour: "",
  level: "",
  heightM: null,
  displayM: null,
  pendingSwitchPreserve: null,
  loadGeneration: 0,
  cacheRunning: false,
  started: false,
};

let wasmReady = null;
let mapLayersReady = null;
let gridCache = null;
let regridWeightPromise = null;
const wCache = new Map();
const modelWorkspaces = new Map();
const cachePanels = {
  "icon-ch1": { validTimes: [], fromIso: "", toIso: "", rangeCustomized: false },
  "icon-ch2": { validTimes: [], fromIso: "", toIso: "", rangeCustomized: false },
};
let cacheSettingsModelId = "icon-ch1";
const ONE_HOUR_FORECAST_MB = {
  "icon-ch1": 177,
  "icon-ch2": 44,
};

function getCacheSettingsModel() {
  return cacheSettingsModelId;
}

function cacheSettingsModelFromSliderValue(value) {
  return Number(value) === 1 ? "icon-ch2" : "icon-ch1";
}

function cacheSettingsModelShort(modelId = cacheSettingsModelId) {
  return modelId === "icon-ch2" ? "CH2" : "CH1";
}

function snapshotWorkspace(modelId) {
  modelWorkspaces.set(modelId, {
    dateStamp: state.dateStamp,
    runHour: state.runHour,
    entries: state.entries,
    levelHeights: state.levelHeights,
    levelAltitudeMap: state.levelAltitudeMap,
    cacheRecords: state.cacheRecords,
    validTimes: state.validTimes,
    levels: state.levels,
    validTimeIso: state.validTimeIso,
    forecastHour: state.forecastHour,
    level: state.level,
    heightM: state.heightM,
    displayM: state.displayM,
    started: state.started,
    gridCache,
    cacheFromIso: ui.cacheFrom?.value ?? "",
    cacheToIso: ui.cacheTo?.value ?? "",
  });
}

function restoreWorkspace(modelId) {
  const workspace = modelWorkspaces.get(modelId);
  if (!workspace) {
    return false;
  }
  state.dateStamp = workspace.dateStamp;
  state.runHour = workspace.runHour;
  state.entries = workspace.entries;
  state.levelHeights = workspace.levelHeights;
  state.levelAltitudeMap = workspace.levelAltitudeMap;
  state.cacheRecords = workspace.cacheRecords;
  state.validTimes = workspace.validTimes;
  state.levels = workspace.levels;
  state.validTimeIso = workspace.validTimeIso;
  state.forecastHour = workspace.forecastHour;
  state.level = workspace.level;
  state.heightM = workspace.heightM;
  state.displayM = workspace.displayM;
  state.started = workspace.started;
  gridCache = workspace.gridCache;
  if (workspace.cacheFromIso) {
    cachePanels[modelId].fromIso = workspace.cacheFromIso;
  }
  if (workspace.cacheToIso) {
    cachePanels[modelId].toIso = workspace.cacheToIso;
  }
  return true;
}

function resetModelState(modelId) {
  state.dateStamp = "";
  state.runHour = "";
  state.entries = [];
  state.levelHeights = new Map();
  state.levelAltitudeMap = new Map();
  state.cacheRecords = [];
  state.validTimes = [];
  state.levels = [];
  state.validTimeIso = "";
  state.forecastHour = "";
  state.level = "";
  state.heightM = null;
  state.displayM = null;
  state.started = false;
  gridCache = null;
  cachePanels[modelId].validTimes = [];
}

function resetIdwState() {
  clearIdwPipeline();
  regridWeightPromise = null;
  invalidateIdwWeightTable(gridCache);
  for (const workspace of modelWorkspaces.values()) {
    invalidateIdwWeightTable(workspace.gridCache);
  }
}

async function runInModelContext(modelId, fn) {
  const activeModelId = hooks.getIconChActiveModel?.() ?? state.modelId;
  const switched = state.modelId !== modelId;

  if (switched) {
    snapshotWorkspace(state.modelId);
    resetIdwState();
    wCache.clear();
    state.modelId = modelId;
    if (!restoreWorkspace(modelId)) {
      resetModelState(modelId);
    }
  }

  try {
    return await fn();
  } finally {
    if (switched) {
      snapshotWorkspace(modelId);
      resetIdwState();
      wCache.clear();
      state.modelId = activeModelId;
      if (!restoreWorkspace(activeModelId)) {
        resetModelState(activeModelId);
      }
      if (hooks.isIconCh1Enabled?.() && activeModelId) {
        rebuildViewOptions();
        updateSelectors();
      }
    }
  }
}

function getMap() {
  return hooks.getMap?.();
}

function rebuildLevelAltitudeMap() {
  state.levelAltitudeMap = buildLevelAltitudeMap(state.levelHeights);
  for (const record of state.cacheRecords) {
    if (state.levelAltitudeMap.has(record.level)) {
      continue;
    }
    state.levelAltitudeMap.set(record.level, {
      heightM: record.heightM,
      displayM: nearestDisplayAltitudeM(record.heightM),
    });
  }
}

function levelAltitudeEntry(level, heightM = null, displayM = null) {
  const mapped = state.levelAltitudeMap.get(level);
  const resolvedHeightM = heightM ?? mapped?.heightM ?? null;
  const resolvedDisplayM =
    displayM ?? mapped?.displayM ?? nearestDisplayAltitudeM(resolvedHeightM);
  return {
    level,
    heightM: resolvedHeightM,
    displayM: resolvedDisplayM,
  };
}

function sortLevelsByDisplay(levels) {
  return [...levels].sort((a, b) => (a.displayM ?? 0) - (b.displayM ?? 0));
}

function ensureWasm() {
  if (!wasmReady) {
    const wasmUrl = assetUrl("vendor/gribinfo/gribinfo_bg.wasm");
    debugLog("wasm init start", { url: wasmUrl });
    wasmReady = initGrib({
      module_or_path: wasmUrl,
    }).then(() => {
      debugLog("wasm init done");
    }).catch((error) => {
      debugLog("wasm init failed", { error: formatError(error) });
      wasmReady = null;
      throw error;
    });
  }
  return wasmReady;
}

function isMapUsable(map) {
  return Boolean(
    map.loaded?.() ||
    map.isStyleLoaded?.() ||
    map.getLayer("hillshade")
  );
}

async function waitForMapStyle() {
  const map = getMap();
  if (!map) {
    throw new Error("Map not ready");
  }

  debugLog("waitForMapStyle", {
    loaded: map.loaded?.(),
    isStyleLoaded: map.isStyleLoaded?.(),
    hasHillshade: Boolean(map.getLayer("hillshade")),
    usable: isMapUsable(map),
  });

  if (isMapUsable(map)) {
    debugLog("waitForMapStyle already usable");
    return;
  }

  if (hooks.waitForMapReady) {
    debugLog("waitForMapStyle awaiting app.mapReady");
    await hooks.waitForMapReady();
    debugLog("waitForMapStyle app.mapReady resolved", {
      loaded: map.loaded?.(),
      hasHillshade: Boolean(map.getLayer("hillshade")),
    });
    if (isMapUsable(map)) {
      return;
    }
  }

  debugLog("waitForMapStyle polling fallback");
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const timeoutMs = 30_000;
    const tick = () => {
      if (isMapUsable(map)) {
        debugLog("waitForMapStyle poll success");
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Map never became usable after ${timeoutMs / 1000}s`));
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function setCh1Status(text, { error = false } = {}) {
  if (!ui.statusEl) {
    return;
  }
  const message = text?.trim() ?? "";
  ui.statusEl.textContent = message;
  ui.statusEl.hidden = !message;
  ui.statusEl.classList.toggle("is-error", Boolean(error && message));
  document.body.classList.toggle("iconch1-status-visible", Boolean(message));
}

function clearCh1Status() {
  setCh1Status("");
}

function showLoadError(error) {
  const message = formatError(error);
  console.error("IconCH1:", message);
  setCh1Status(message, { error: true });
}

function clearLoadError() {
  clearCh1Status();
}

function defaultAltTarget() {
  return DEFAULT_ALT_TARGET_M;
}

async function refreshCacheRecords(modelId = state.modelId) {
  state.cacheRecords = await listFreshChContourCacheEntries(modelId);
  rebuildLevelAltitudeMap();
  debugLog("cache records refreshed", {
    todayKey: state.todayKey,
    count: state.cacheRecords.length,
  });
}

function applyCacheMetadata() {
  if (!state.cacheRecords.length) throw new Error("No cached contours");
  const sample = state.cacheRecords[0];
  state.dateStamp = sample.runDateStamp;
  state.runHour = sample.runDateStamp.slice(8, 10);
}

function openSelectPicker(select) {
  if (typeof select.showPicker === "function") {
    try {
      select.showPicker();
      return;
    } catch {
      // Fall through.
    }
  }
  select.focus({ preventScroll: true });
  select.click();
}

function bindLongPress(element, { onShort, onLong, thresholdMs = 500 }) {
  let timer = null;
  let longPressed = false;
  let startX = 0;
  let startY = 0;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    longPressed = false;
    startX = event.clientX;
    startY = event.clientY;
    clearTimer();
    timer = setTimeout(() => {
      longPressed = true;
      onLong();
    }, thresholdMs);
  });

  element.addEventListener("pointermove", (event) => {
    if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) {
      clearTimer();
    }
  });

  element.addEventListener("pointerup", () => {
    clearTimer();
    if (!longPressed) onShort();
  });

  element.addEventListener("pointercancel", clearTimer);
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    clearTimer();
    onLong();
  });
}

function resolveForecastHour(validIso, level) {
  const entry = state.entries.find(
    (item) => validTimeIso(state.dateStamp, item.forecastHour) === validIso
  );
  if (entry) return entry.forecastHour;
  const cached = state.cacheRecords.find(
    (record) => record.validTimeIso === validIso && record.level === level
  );
  return cached?.forecastHour ?? "";
}

function modelAttributionLabel(modelId = state.modelId) {
  return modelId === "icon-ch2" ? "IconCH2" : "IconCH1";
}

function buildForecastAttribution() {
  if (!state.dateStamp || state.level === "") {
    return modelAttributionLabel();
  }
  const run = formatDateStamp(state.dateStamp);
  const step = state.forecastHour !== "" ? `+${state.forecastHour}h` : "—";
  return `${modelAttributionLabel()} · Run ${run} · Step ${step} · L${state.level}`;
}

function updateMapAttribution(clear = false) {
  const map = getMap();
  if (!map) return;
  const inner = map.getContainer().querySelector(".maplibregl-ctrl-attrib-inner");
  if (!inner) return;

  let node = inner.querySelector(".ch1-forecast-attrib");
  let meteoNode = inner.querySelector(".meteosuisse-attrib");
  if (clear) {
    node?.remove();
    meteoNode?.remove();
    return;
  }

  const text = buildForecastAttribution();
  if (!node) {
    node = document.createElement("span");
    node.className = "ch1-forecast-attrib";
    inner.insertBefore(node, inner.firstChild);
    if (inner.childNodes.length > 1) {
      inner.insertBefore(document.createTextNode(" | "), inner.childNodes[1]);
    }
  }
  node.textContent = text;

  if (!meteoNode) {
    meteoNode = document.createElement("span");
    meteoNode.className = "meteosuisse-attrib";
    meteoNode.innerHTML =
      ' | <a href="https://www.meteoswiss.admin.ch" target="_blank" rel="noopener">Meteosuisse</a>';
    inner.appendChild(meteoNode);
  }
}

function pickNearestTimeToNow() {
  if (!state.validTimes.length) return null;
  return snapToNearestTime(Date.now(), state.validTimes);
}

async function jumpToNearestNow() {
  const validIso = pickNearestTimeToNow();
  if (!validIso) return;

  const levels = levelsAtTime(validIso);
  const level = levels.some((entry) => entry.level === state.level)
    ? state.level
    : levels[0]?.level;
  if (level == null) return;

  applySelection(validIso, level);
  await displayCurrent();
}

function jumpToUserAltitude() {
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const altM = position.coords.altitude;
      if (!Number.isFinite(altM)) return;

      const levels = levelsAtTime(state.validTimeIso);
      if (!levels.length) return;

      let best = levels[0];
      let bestDiff = Math.abs(best.heightM - altM);
      for (let i = 1; i < levels.length; i += 1) {
        const diff = Math.abs(levels[i].heightM - altM);
        if (diff < bestDiff) {
          best = levels[i];
          bestDiff = diff;
        }
      }

      applySelection(state.validTimeIso, best.level);
      void displayCurrent();
    },
    () => {},
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

function updateSelectors() {
  if (!ui) return;

  ui.timeSelect.innerHTML = "";
  for (const iso of state.validTimes) {
    const option = document.createElement("option");
    option.value = iso;
    option.textContent = formatValidTimeLabel(iso);
    if (iso === state.validTimeIso) option.selected = true;
    ui.timeSelect.appendChild(option);
  }

  ui.timeValue.textContent = state.validTimeIso ? formatValidTimeLabel(state.validTimeIso) : "—";
  if (state.validTimeIso) ui.timeSelect.value = state.validTimeIso;

  const levels = sortLevelsByDisplay(levelsAtTime(state.validTimeIso));
  ui.altSelect.innerHTML = "";
  for (const entry of levels) {
    const option = document.createElement("option");
    const label = formatAltitudeLabel(entry.displayM);
    option.value = String(entry.level);
    option.textContent = label;
    option.label = label;
    if (entry.level === state.level) option.selected = true;
    ui.altSelect.appendChild(option);
  }

  ui.altValue.textContent = formatAltitudeLabel(state.displayM);
  if (state.level != null) {
    ui.altSelect.value = String(state.level);
  }

  const timeIdx = state.validTimeIso ? state.validTimes.indexOf(state.validTimeIso) : -1;
  ui.timePrev.disabled = timeIdx <= 0;
  ui.timeNext.disabled = timeIdx < 0 || timeIdx >= state.validTimes.length - 1;

  const levelIdx = levels.findIndex((entry) => entry.level === state.level);
  ui.altUp.disabled = levelIdx < 0 || levelIdx >= levels.length - 1;
  ui.altDown.disabled = levelIdx <= 0;

  updateMapAttribution();
}

function catalogValidTimesFromEntries() {
  const seen = new Set();
  const times = [];
  for (const entry of state.entries) {
    const iso = validTimeIso(state.dateStamp, entry.forecastHour);
    if (seen.has(iso)) continue;
    seen.add(iso);
    times.push(iso);
  }
  return times.sort();
}

function rebuildViewOptions() {
  rebuildLevelAltitudeMap();

  if (state.entries.length) {
    state.validTimes = catalogValidTimesFromEntries();
    state.levels = sortLevelsByDisplay(
      pickLevelsNearTargets(state.levelHeights, CH_CONTOUR_TARGET_HEIGHTS_M).map((entry) =>
        levelAltitudeEntry(entry.level, entry.heightM, entry.targetM)
      )
    );
    if (state.levels.length === 0) {
      state.levels = sortLevelsByDisplay(
        [...state.levelHeights.entries()].map(([level, heightM]) => levelAltitudeEntry(level, heightM))
      );
    }
  } else {
    state.validTimes = [...new Set(state.cacheRecords.map((record) => record.validTimeIso))].sort();
    const levelMap = new Map();
    for (const record of state.cacheRecords) {
      levelMap.set(record.level, record.heightM);
    }
    state.levels = sortLevelsByDisplay(
      [...levelMap.entries()].map(([level, heightM]) => levelAltitudeEntry(level, heightM))
    );
  }

  cachePanels[state.modelId].validTimes = [...state.validTimes];
  if (state.modelId === cacheSettingsModelId && cachePanels[cacheSettingsModelId].rangeCustomized) {
    syncCachePanelTimes(cacheSettingsModelId);
  }
}

function pickDefaultLevelForTime(validIso) {
  const levelsForTime = levelsAtTime(validIso);
  if (!levelsForTime.length) return null;
  const targetAlt = defaultAltTarget();
  let best = levelsForTime[0];
  let bestDiff = Infinity;
  for (const entry of levelsForTime) {
    const diff = Math.abs(entry.displayM - targetAlt);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = entry;
    }
  }
  return best?.level ?? null;
}

function applySelectionWithPreferredLevel(validIso, preferredLevel) {
  const levelsForTime = levelsAtTime(validIso);
  if (!levelsForTime.length) return;
  const level =
    preferredLevel != null &&
    preferredLevel !== "" &&
    levelsForTime.some((entry) => entry.level === preferredLevel)
      ? preferredLevel
      : pickDefaultLevelForTime(validIso);
  if (level == null) return;
  applySelection(validIso, level);
}

function pickSelectionAfterCatalogLoad() {
  if (!state.validTimes.length) return;

  const preferred = state.pendingSwitchPreserve;
  state.pendingSwitchPreserve = null;

  const preferredIso = preferred?.validIso
    ? findValidTimeIso(state.validTimes, preferred.validIso)
    : null;
  if (preferredIso) {
    applySelectionWithPreferredLevel(preferredIso, preferred?.level);
    return;
  }

  const currentIso = state.validTimeIso
    ? findValidTimeIso(state.validTimes, state.validTimeIso)
    : null;
  if (currentIso) {
    applySelectionWithPreferredLevel(currentIso, state.level);
    return;
  }

  pickDefaultSelection();
}

function pickDefaultSelection() {
  const now = new Date();

  if (!state.validTimes.length) return;

  const futureTimes = state.validTimes.filter(
    (iso) => new Date(iso).getTime() >= now.getTime() - 30 * 60 * 1000
  );
  const candidates = futureTimes.length ? futureTimes : state.validTimes;
  const validIso = snapToNearestTime(now.getTime(), candidates) ?? candidates[0];
  const level = pickDefaultLevelForTime(validIso);
  if (level == null) return;
  applySelection(validIso, level);
}

function levelsAtTime(validIso) {
  if (state.entries.length) return state.levels;
  return sortLevelsByDisplay(
    state.cacheRecords
      .filter((record) => record.validTimeIso === validIso)
      .map((record) => levelAltitudeEntry(record.level, record.heightM))
  );
}

function applySelection(validIso, level) {
  state.validTimeIso = validIso;
  state.level = level;
  const levelEntry = levelsAtTime(validIso).find((entry) => entry.level === level);
  const fallbackHeightM = state.levelHeights.get(level) ?? null;
  state.heightM = levelEntry?.heightM ?? fallbackHeightM;
  state.displayM =
    levelEntry?.displayM ?? state.levelAltitudeMap.get(level)?.displayM ?? nearestDisplayAltitudeM(fallbackHeightM);
  state.forecastHour = resolveForecastHour(validIso, level);
  updateSelectors();
}

function stepTime(deltaSteps) {
  if (!hooks.isIconCh1Enabled?.() || !state.validTimeIso || !state.validTimes.length) return;
  const idx = state.validTimes.indexOf(state.validTimeIso);
  if (idx < 0) return;
  const nextIdx = idx + deltaSteps;
  if (nextIdx < 0 || nextIdx >= state.validTimes.length) return;
  const snapped = state.validTimes[nextIdx];
  const levels = levelsAtTime(snapped);
  const level = levels.some((entry) => entry.level === state.level)
    ? state.level
    : levels[0]?.level;
  if (level == null) return;
  applySelection(snapped, level);
  void displayCurrent();
}

function stepAltitude(delta) {
  if (!hooks.isIconCh1Enabled?.()) return;
  const levels = levelsAtTime(state.validTimeIso);
  const idx = levels.findIndex((entry) => entry.level === state.level);
  const next = levels[idx + delta];
  if (!next) return;
  applySelection(state.validTimeIso, next.level);
  void displayCurrent();
}

async function ensureMapLayers() {
  if (mapLayersReady) return mapLayersReady;
  mapLayersReady = (async () => {
    debugLog("ensureMapLayers start");
    const map = getMap();
    if (!map) {
      debugLog("ensureMapLayers skipped — no map");
      return;
    }
    await waitForMapStyle();
    const hadSource = Boolean(map.getSource(ICONCH1_SECTOR_SOURCE_ID));
    const hadLayer = Boolean(map.getLayer(ICONCH1_SECTOR_LAYER_ID));
    if (!hadSource) {
      map.addSource(ICONCH1_SECTOR_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      debugLog("source added", { id: ICONCH1_SECTOR_SOURCE_ID });
    }
    if (!hadLayer) {
      map.addLayer({
        id: ICONCH1_SECTOR_LAYER_ID,
        type: "fill",
        source: ICONCH1_SECTOR_SOURCE_ID,
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": 0.45,
          "fill-outline-color": ["get", "color"],
        },
      });
      debugLog("layer added", { id: ICONCH1_SECTOR_LAYER_ID });
    }
    hooks.raiseIconCh1Layer?.();
    debugLog("ensureMapLayers done", {
      hadSource,
      hadLayer,
      layerVisibility: map.getLayoutProperty(ICONCH1_SECTOR_LAYER_ID, "visibility"),
    });
  })();
  return mapLayersReady;
}

async function loadGrid() {
  if (gridCache) {
    debugLog("loadGrid cache hit", { levels: gridCache.levelHeights?.size ?? state.levelHeights.size });
    const spacing = getModel().regridSpacingDeg ?? 0.01;
    await ensureRegridWasm();
    await ensureRegridWeightTable(gridCache, spacing);
    return gridCache;
  }
  setCh1Status("Fetching grid constants…");
  debugLog("loadGrid start");
  await ensureWasm();
  const [horizontalUrl, verticalUrl] = await Promise.all([
    getCollectionAssetUrl(getModel().collection, getModel().staticAssets.horizontal),
    getCollectionAssetUrl(getModel().collection, getModel().staticAssets.vertical),
  ]);
  debugLog("loadGrid fetching constants", { horizontalUrl, verticalUrl });
  const [horizontalBuffer, verticalBuffer] = await Promise.all([
    readProxiedFile(horizontalUrl),
    readProxiedFile(verticalUrl),
  ]);
  const horizontalRaw = await toRawGribBytes(horizontalBuffer);
  const verticalRaw = await toRawGribBytes(verticalBuffer);
  debugLog("loadGrid grib downloaded", {
    horizontalBytes: horizontalBuffer.byteLength,
    verticalBytes: verticalBuffer.byteLength,
  });

  let clat = null;
  let clon = null;
  for (const message of splitGribMessages(horizontalRaw)) {
    const meta = parse_grib2_raw(message);
    const values = decode_template42_values_f32(message);
    if (meta.product_category === 191 && meta.product_number === 1) clat = values;
    if (meta.product_category === 191 && meta.product_number === 2) clon = values;
  }
  const levelHeights = new Map();
  for (const message of splitGribMessages(verticalRaw)) {
    const level = grib2_message_level(message);
    const values = decode_template42_values_f32(message);
    let sum = 0;
    let count = 0;
    for (const value of values) {
      if (!Number.isFinite(value)) continue;
      sum += value;
      count += 1;
    }
    if (count > 0) levelHeights.set(level, sum / count);
  }
  gridCache = { clat, clon, levelHeights };
  state.levelHeights = levelHeights;
  rebuildLevelAltitudeMap();
  debugLog("loadGrid done", {
    clatPoints: clat?.length ?? 0,
    clonPoints: clon?.length ?? 0,
    levelCount: levelHeights.size,
  });
  const spacing = getModel().regridSpacingDeg ?? 0.01;
  await ensureRegridWasm();
  await ensureRegridWeightTable(gridCache, spacing);
  return gridCache;
}

async function ensureRegridWeightTable(grid, spacingDeg) {
  const cached = grid.idwWeightTable;
  if (cached?.spacingDeg === spacingDeg) {
    const table = cached.table ?? cached.meta;
    if (table?.pipeline && !isIdwPipelineInstalled()) {
      invalidateIdwWeightTable(grid);
    } else {
      return table;
    }
  }

  if (regridWeightPromise?.spacingDeg === spacingDeg) {
    return regridWeightPromise.promise;
  }

  setCh1Status("Preparing regrid…");
  debugLog("buildIdwWeightTable start", { spacingDeg });
  const promise = buildIdwWeightTable(grid.clat, grid.clon, spacingDeg).then((table) => {
    grid.idwWeightTable = { spacingDeg, table, meta: table.pipeline ? table : null };
    regridWeightPromise = null;
    debugLog("buildIdwWeightTable done", {
      spacingDeg,
      cellCount: table.cellCount,
      ni: table.ni,
      nj: table.nj,
      wasm: isRegridWasmEnabled(),
      pipeline: isIdwPipelineInstalled(),
    });
    return table;
  });
  regridWeightPromise = { spacingDeg, promise };
  return promise;
}

async function loadWMessage(url, level = state.level) {
  let cached = wCache.get(url);
  if (!cached) {
    setCh1Status("Fetching forecast GRIB…");
    debugLog("loadWMessage fetch", { url, level });
    const buffer = await readProxiedFile(url);
    const raw = await toRawGribBytes(buffer);
    const byLevel = new Map();
    for (const message of splitGribMessages(raw)) {
      byLevel.set(grib2_message_level(message), message);
    }
    cached = { byLevel };
    wCache.set(url, cached);
    debugLog("loadWMessage parsed", {
      url,
      levels: [...byLevel.keys()].sort((a, b) => a - b),
      bytes: buffer.byteLength,
    });
  }
  const message = cached.byLevel.get(level) ?? cached.byLevel.get(Number(level));
  if (!message) {
    debugLog("loadWMessage level missing", {
      requestedLevel: level,
      availableLevels: [...cached.byLevel.keys()].sort((a, b) => a - b),
    });
  }
  return message;
}

async function buildLiveGeoJson({
  validTimeIso: validIso = state.validTimeIso,
  level = state.level,
  entry: entryOverride = null,
} = {}) {
  debugLog("buildLiveGeoJson start", {
    validTimeIso: validIso,
    level,
    heightM: state.heightM,
  });
  const entry =
    entryOverride ??
    state.entries.find((item) => validTimeIso(state.dateStamp, item.forecastHour) === validIso);
  if (!entry) throw new Error("Forecast step not found in catalog");

  const grid = await loadGrid();
  const message = await loadWMessage(entry.url, level);
  if (!message) throw new Error(`Level ${level} not found in forecast file`);

  const spacing = getModel().regridSpacingDeg ?? 0.01;
  await ensureRegridWeightTable(grid, spacing);
  await ensureRegridWasm();

  if (isIdwPipelineInstalled()) {
    setCh1Status("Extracting contours…");
    debugLog("buildLiveGeoJson pipeline", {
      spacingDeg: spacing,
      forecastHour: entry.forecastHour,
      pipeline: true,
    });
    const geojson = buildSectorGeoJsonFromFieldGrib(message);
    debugLog("buildLiveGeoJson done", {
      featureCount: geojson.features?.length ?? 0,
      pipeline: true,
      contourWasm: true,
    });
    return geojson;
  }

  const values = decode_template42_values_f32(message);
  setCh1Status("Regridding field…");
  debugLog("buildLiveGeoJson regrid", {
    valueCount: values.length,
    spacingDeg: spacing,
    forecastHour: entry.forecastHour,
    precomputedWeights: true,
    regridWasm: isRegridWasmEnabled(),
    pipeline: false,
  });
  const weightTable = grid.idwWeightTable?.table ?? (await ensureRegridWeightTable(grid, spacing));
  const field = applyIdwWeightTable(weightTable, values);
  setCh1Status("Extracting contours…");
  const geojson = buildSectorGeoJson(field, field.values);
  debugLog("buildLiveGeoJson done", {
    featureCount: geojson.features?.length ?? 0,
    gridWidth: field.ni,
    gridHeight: field.nj,
    contourWasm: isRegridWasmEnabled(),
    pipeline: false,
  });
  return geojson;
}

function nearestTargetM(heightM) {
  let best = CH_CONTOUR_TARGET_HEIGHTS_M[0];
  let bestDiff = Math.abs(best - heightM);
  for (const targetM of CH_CONTOUR_TARGET_HEIGHTS_M) {
    const diff = Math.abs(targetM - heightM);
    if (diff < bestDiff) {
      best = targetM;
      bestDiff = diff;
    }
  }
  return best;
}

async function storeBuiltContour(geojson, key) {
  try {
    const byteSize = estimateJsonByteSize(geojson);
    const record = await putChContourCacheEntry({
      key,
      modelId: state.modelId,
      runDateStamp: state.dateStamp,
      forecastHour: state.forecastHour,
      validTimeIso: state.validTimeIso,
      level: state.level,
      heightM: state.heightM,
      targetM: nearestTargetM(state.heightM ?? 0),
      geojson,
      byteSize,
    });
    const existingIdx = state.cacheRecords.findIndex((entry) => entry.key === key);
    if (existingIdx >= 0) {
      state.cacheRecords[existingIdx] = record;
    } else {
      state.cacheRecords.push(record);
    }
  } catch {
    // Display still works if cache write fails.
  }
}

async function displayCurrent() {
  if (!hooks.isIconCh1Enabled?.()) return;

  const generation = ++state.loadGeneration;
  debugLog("displayCurrent start", {
    generation,
    validTimeIso: state.validTimeIso,
    level: state.level,
    heightM: state.heightM,
  });

  try {
    let geojson;
    let source = "unknown";
    const key = buildChContourCacheKey(state.modelId, state.validTimeIso, state.level);
    const cached = await getFreshChContourCacheEntry(key);
    if (cached?.geojson) {
      geojson = cached.geojson;
      source = "indexeddb";
      setCh1Status("Loading cached contours…");
      debugLog("displayCurrent cache hit", { key, featureCount: geojson.features?.length ?? 0 });
    } else if (navigator.onLine) {
      await ensureLiveCatalog();
      if (!state.entries.length) {
        throw new Error("Not cached — go online or download this time/altitude");
      }
      source = "live";
      setCh1Status("Building contours…");
      debugLog("displayCurrent cache miss — building live", { key, entryCount: state.entries.length });
      geojson = await buildLiveGeoJson();
      if (generation !== state.loadGeneration) {
        debugLog("displayCurrent aborted — stale generation", { generation, current: state.loadGeneration });
        return;
      }
      void storeBuiltContour(geojson, key);
    } else {
      throw new Error("Not cached — go online or download this time/altitude");
    }

    if (generation !== state.loadGeneration) {
      debugLog("displayCurrent aborted — stale generation", { generation, current: state.loadGeneration });
      return;
    }
    await ensureMapLayers();
    setCh1Status("Updating map…");
    const map = getMap();
    map.setLayoutProperty(ICONCH1_SECTOR_LAYER_ID, "visibility", "visible");
    map.getSource(ICONCH1_SECTOR_SOURCE_ID).setData(geojson);
    hooks.raiseIconCh1Layer?.();
    clearLoadError();
    updateSelectors();
    debugLog("displayCurrent done", {
      source,
      featureCount: geojson.features?.length ?? 0,
      layerVisibility: map.getLayoutProperty(ICONCH1_SECTOR_LAYER_ID, "visibility"),
      mapCenter: map.getCenter(),
      mapZoom: map.getZoom(),
    });
  } catch (error) {
    if (generation !== state.loadGeneration) return;
    showLoadError(error);
  }
}

async function loadLiveCatalog({ updateSelection = true } = {}) {
  setCh1Status("Fetching catalog…");
  debugLog("loadLiveCatalog start");
  const run = await pickLatestMeteoSwissRun(getModel().collection, state.modelId);
  if (!run) throw new Error(`No recent ${getModel().label} run found.`);
  debugLog("loadLiveCatalog run picked", run);

  const items = await fetchForecastItemsForRun(getModel().collection, run.referenceIso);
  const entries = catalogEntriesFromItems(items);
  if (!entries.length) throw new Error("No forecast steps found.");
  debugLog("loadLiveCatalog items fetched", {
    itemCount: items.length,
    entryCount: entries.length,
    sampleHours: entries.slice(0, 5).map((entry) => entry.forecastHour),
  });

  state.dateStamp = run.dateStamp;
  state.runHour = run.runHour;
  state.entries = entries;
  await loadGrid();
  rebuildViewOptions();
  if (updateSelection) {
    pickSelectionAfterCatalogLoad();
  }
  debugLog("loadLiveCatalog done", {
    dateStamp: state.dateStamp,
    validTimes: state.validTimes.length,
    levels: state.levels.length,
    selection: {
      validTimeIso: state.validTimeIso,
      level: state.level,
      heightM: state.heightM,
      forecastHour: state.forecastHour,
    },
  });
}

async function checkCacheAvailableTimesForModel(modelId) {
  if (!navigator.onLine) {
    throw new Error("Offline — connect to check available times");
  }
  syncCacheActionButtons();
  try {
    await runInModelContext(modelId, async () => {
      cachePanels[modelId].fromIso = "";
      cachePanels[modelId].toIso = "";
      cachePanels[modelId].rangeCustomized = false;
      await loadLiveCatalog({ updateSelection: false });
      cachePanels[modelId].validTimes = [...state.validTimes];
      if (modelId === cacheSettingsModelId) {
        syncCachePanelTimes(modelId);
      }
      if (modelId === hooks.getIconChActiveModel?.()) {
        updateSelectors();
      }
      clearCh1Status();
    });
  } finally {
    syncCacheActionButtons();
  }
}

function syncCacheActionButtons() {
  const disabled = !navigator.onLine || state.cacheRunning;
  if (ui.cacheCheckTimes) ui.cacheCheckTimes.disabled = disabled;
  if (ui.cacheRun) ui.cacheRun.disabled = disabled;
}

function setCacheSettingsModel(modelId) {
  if (!ICON_CH_MODELS.includes(modelId)) {
    return;
  }
  cacheSettingsModelId = modelId;
  if (ui.cacheSettingsModel) {
    ui.cacheSettingsModel.value = modelId === "icon-ch2" ? "1" : "0";
  }
  syncCacheSettingsModelUi();
}

function syncCacheSettingsModelUi() {
  const short = cacheSettingsModelShort();
  if (ui.cacheCheckTimes) {
    ui.cacheCheckTimes.textContent = `Check times ${short}`;
  }
  if (ui.cacheRun) {
    ui.cacheRun.textContent = `Cache ${short}`;
  }
  if (ui.cacheEstimate) {
    const mb = ONE_HOUR_FORECAST_MB[cacheSettingsModelId];
    ui.cacheEstimate.textContent = `One hour forecast for ${short}: ${mb}MB`;
  }
  if (ui.cacheSettingsCh1) {
    ui.cacheSettingsCh1.classList.toggle("is-selected", cacheSettingsModelId === "icon-ch1");
  }
  if (ui.cacheSettingsCh2) {
    ui.cacheSettingsCh2.classList.toggle("is-selected", cacheSettingsModelId === "icon-ch2");
  }
  if (ui.cacheSettingsModel) {
    ui.cacheSettingsModel.value = cacheSettingsModelId === "icon-ch2" ? "1" : "0";
  }
  syncCachePanelTimes(cacheSettingsModelId);
}

async function loadCachedCatalog() {
  await refreshCacheRecords();
  if (!state.cacheRecords.length) {
    throw new Error("No cached contours");
  }
  applyCacheMetadata();
  rebuildViewOptions();
  pickSelectionAfterCatalogLoad();
}

async function ensureLiveCatalog() {
  if (state.entries.length || !navigator.onLine) {
    return;
  }
  await loadLiveCatalog();
}

function fillValidTimeOptions(select, validTimes, selectedIso) {
  if (!select) return;
  const resolved = findValidTimeIso(validTimes, selectedIso) ?? validTimes[0] ?? "";
  select.innerHTML = "";
  for (const iso of validTimes) {
    const option = document.createElement("option");
    option.value = iso;
    option.textContent = formatValidTimeLabel(iso);
    if (iso === resolved) option.selected = true;
    select.appendChild(option);
  }
  if (resolved) {
    select.value = resolved;
  }
}

function captureCachePanelSelection(modelId) {
  const panel = cachePanels[modelId];
  if (modelId === cacheSettingsModelId && ui.cacheFrom?.value && ui.cacheTo?.value) {
    panel.fromIso = ui.cacheFrom.value;
    panel.toIso = ui.cacheTo.value;
  }
  return {
    fromIso: panel.fromIso,
    toIso: panel.toIso,
    validTimes: panel.validTimes,
  };
}

function syncCachePanelTimes(modelId = cacheSettingsModelId) {
  if (!ui.cacheTo || !ui.cacheFrom) return;

  const panel = cachePanels[modelId];
  const times = panel.validTimes;
  if (!times.length) {
    ui.cacheFrom.innerHTML = "";
    ui.cacheTo.innerHTML = "";
    syncCacheActionButtons();
    return;
  }

  const storedFrom = findValidTimeIso(times, panel.fromIso);
  const storedTo = findValidTimeIso(times, panel.toIso);
  const useStored = panel.rangeCustomized && storedFrom && storedTo;
  const fromIso = useStored ? storedFrom : defaultCacheFromIso(times);
  let toIso = useStored ? storedTo : defaultCacheToIso(times);
  if (new Date(toIso).getTime() < new Date(fromIso).getTime()) {
    toIso = fromIso;
  }

  panel.fromIso = fromIso;
  panel.toIso = toIso;
  fillValidTimeOptions(ui.cacheFrom, times, fromIso);
  fillValidTimeOptions(ui.cacheTo, times, toIso);
  syncCacheActionButtons();
}

function initCachePanel() {
  if (!ui.cacheTo) return;
  syncCacheSettingsModelUi();
}

function selectedCacheTargets() {
  return [...CH_CONTOUR_TARGET_HEIGHTS_M];
}

async function cachedModelByteSize(modelId) {
  const records = await listFreshChContourCacheEntries(modelId);
  let bytes = 0;
  for (const record of records) {
    bytes += record.byteSize ?? estimateJsonByteSize(record.geojson);
  }
  return bytes;
}

async function updateStoredPackSummary() {
  if (ui.storedCh1) {
    const bytes = await cachedModelByteSize("icon-ch1");
    ui.storedCh1.textContent = `IconCH1 : ${bytes > 0 ? formatByteSize(bytes) : "—"}`;
  }
  if (ui.storedCh2) {
    const bytes = await cachedModelByteSize("icon-ch2");
    ui.storedCh2.textContent = `IconCH2 : ${bytes > 0 ? formatByteSize(bytes) : "—"}`;
  }
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;

  ui.timePrev?.addEventListener("click", () => stepTime(-1));
  ui.timeNext?.addEventListener("click", () => stepTime(1));
  ui.timeSelect?.addEventListener("change", () => {
    const validIso = ui.timeSelect.value;
    const levels = levelsAtTime(validIso);
    const level = levels.some((entry) => entry.level === state.level)
      ? state.level
      : levels[0]?.level;
    if (!validIso || level == null) return;
    applySelection(validIso, level);
    void displayCurrent();
  });

  if (ui.timeValue) {
    bindLongPress(ui.timeValue, {
      onShort: () => {
        void jumpToNearestNow();
      },
      onLong: () => {
        openSelectPicker(ui.timeSelect);
      },
    });
  }

  ui.altUp?.addEventListener("click", () => stepAltitude(1));
  ui.altDown?.addEventListener("click", () => stepAltitude(-1));
  ui.altSelect?.addEventListener("change", () => {
    const level = Number(ui.altSelect.value);
    if (!state.validTimeIso || !level) return;
    applySelection(state.validTimeIso, level);
    void displayCurrent();
  });

  if (ui.altValue) {
    bindLongPress(ui.altValue, {
      onShort: () => {
        jumpToUserAltitude();
      },
      onLong: () => {
        updateSelectors();
        openSelectPicker(ui.altSelect);
      },
    });
  }

  ui.clearTodayCache?.addEventListener("click", () => {
    void (async () => {
      for (const modelId of ICON_CH_MODELS) {
        await deleteAllChContourCacheForModel(modelId);
        const workspace = modelWorkspaces.get(modelId);
        if (workspace) {
          workspace.cacheRecords = [];
          workspace.entries = [];
          workspace.validTimes = [];
        }
        cachePanels[modelId].validTimes = [];
        cachePanels[modelId].fromIso = "";
        cachePanels[modelId].toIso = "";
        cachePanels[modelId].rangeCustomized = false;
      }
      state.cacheRecords = [];
      state.entries = [];
      state.validTimes = [];
      state.started = false;
      updateStoredPackSummary();
      syncCacheSettingsModelUi();
      if (!navigator.onLine) {
        clearCh1Status();
        const map = getMap();
        if (map?.getLayer(ICONCH1_SECTOR_LAYER_ID)) {
          map.setLayoutProperty(ICONCH1_SECTOR_LAYER_ID, "visibility", "none");
        }
        if (map?.getSource(ICONCH1_SECTOR_SOURCE_ID)) {
          map.getSource(ICONCH1_SECTOR_SOURCE_ID).setData({
            type: "FeatureCollection",
            features: [],
          });
        }
        updateSelectors();
        return;
      }
      await bootstrapCatalog();
      state.started = true;
      updateSelectors();
      await displayCurrent();
    })();
  });

  ui.cacheFrom?.addEventListener("change", () => {
    const panel = cachePanels[cacheSettingsModelId];
    panel.fromIso = ui.cacheFrom.value;
    panel.rangeCustomized = true;
    const fromIso = panel.fromIso;
    const toIso = ui.cacheTo?.value ?? "";
    const times = panel.validTimes;
    if (fromIso && toIso && new Date(toIso).getTime() < new Date(fromIso).getTime() && ui.cacheTo) {
      panel.toIso = fromIso;
      fillValidTimeOptions(ui.cacheTo, times, fromIso);
    }
  });

  ui.cacheCheckTimes?.addEventListener("click", () => {
    void (async () => {
      try {
        await checkCacheAvailableTimesForModel(cacheSettingsModelId);
      } catch (error) {
        showLoadError(error);
        console.warn(`${getModel(cacheSettingsModelId).label} cache times:`, formatError(error));
      }
    })();
  });

  ui.cacheTo?.addEventListener("change", () => {
    const panel = cachePanels[cacheSettingsModelId];
    panel.toIso = ui.cacheTo?.value ?? "";
    panel.rangeCustomized = true;
  });

  ui.cacheRun?.addEventListener("click", () => void runCacheFlightForModel(cacheSettingsModelId));

  ui.cacheSettingsModel?.addEventListener("input", () => {
    setCacheSettingsModel(cacheSettingsModelFromSliderValue(ui.cacheSettingsModel.value));
  });

  ui.cacheSettingsCh1?.addEventListener("click", () => {
    setCacheSettingsModel("icon-ch1");
  });

  ui.cacheSettingsCh2?.addEventListener("click", () => {
    setCacheSettingsModel("icon-ch2");
  });

function iconChShortcutsAllowed() {
  if (!hooks.isIconCh1Enabled?.()) return false;
  const active = document.activeElement;
  if (active?.closest?.("#params-shell") || active?.closest?.("dialog")) {
    return false;
  }
  if (active?.matches?.("select, input, textarea, [contenteditable='true']")) {
    return false;
  }
  return true;
}

  window.addEventListener(
    "keydown",
    (event) => {
      if (!iconChShortcutsAllowed()) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepTime(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepTime(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        stepAltitude(1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        stepAltitude(-1);
      } else if (
        event.code === "KeyT" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        toggleIconChActiveModel();
      }
    },
    true
  );

  window.addEventListener("offline", () => {
    if (!hooks.isIconCh1Enabled?.()) return;
    syncCacheActionButtons();
    if (!state.entries.length && state.cacheRecords.length) {
      void (async () => {
        try {
          await loadCachedCatalog();
          updateSelectors();
          await displayCurrent();
        } catch (error) {
          console.warn("IconCH1 offline:", formatError(error));
        }
      })();
    }
  });
}

async function runCacheFlightForModel(modelId) {
  if (state.cacheRunning) return;
  state.cacheRunning = true;
  syncCacheActionButtons();
  if (ui.cacheProgress) ui.cacheProgress.hidden = false;

  try {
    await runInModelContext(modelId, async () => {
      const panel = cachePanels[modelId];
      if (!state.entries.length) await loadLiveCatalog();
      panel.validTimes = [...state.validTimes];

      const { fromIso, toIso, validTimes } = captureCachePanelSelection(modelId);
      if (!fromIso || !toIso || !validTimes.length) {
        throw new Error("Check available times before caching");
      }
      if (new Date(toIso).getTime() < new Date(fromIso).getTime()) {
        throw new Error("Invalid cache time range");
      }
      const targets = selectedCacheTargets();
      const levels = pickLevelsNearTargets(state.levelHeights, targets);
      const hourSlots = validTimesInRange(validTimes, fromIso, toIso);
      debugLog("runCacheFlightForModel range", {
        modelId,
        fromIso,
        toIso,
        slotCount: hourSlots.length,
        catalogCount: validTimes.length,
      });

      const jobs = [];
      for (const iso of hourSlots) {
        const entry = state.entries.find(
          (item) => validTimeIso(state.dateStamp, item.forecastHour) === iso
        );
        if (!entry) continue;
        const validIso = validTimeIso(state.dateStamp, entry.forecastHour);
        for (const levelInfo of levels) {
          jobs.push({ entry, validIso, levelInfo });
        }
      }

      if (ui.cacheProgress) {
        ui.cacheProgress.max = jobs.length;
        ui.cacheProgress.value = 0;
      }
      let done = 0;

      for (const job of jobs) {
        const key = buildChContourCacheKey(modelId, job.validIso, job.levelInfo.level);
        const existing = await getFreshChContourCacheEntry(key);
        if (existing) {
          done += 1;
          if (ui.cacheProgress) ui.cacheProgress.value = done;
          continue;
        }

        const geojson = await buildLiveGeoJson({
          validTimeIso: job.validIso,
          level: job.levelInfo.level,
          entry: job.entry,
        });
        const byteSize = estimateJsonByteSize(geojson);
        await putChContourCacheEntry({
          key,
          modelId,
          runDateStamp: state.dateStamp,
          forecastHour: job.entry.forecastHour,
          validTimeIso: job.validIso,
          level: job.levelInfo.level,
          heightM: job.levelInfo.heightM,
          targetM: job.levelInfo.targetM,
          geojson,
          byteSize,
        });
        done += 1;
        if (ui.cacheProgress) ui.cacheProgress.value = done;
      }

      await getChContourCacheStats();
      await refreshCacheRecords(modelId);
      if (!state.entries.length) applyCacheMetadata();
      rebuildViewOptions();
      if (modelId === hooks.getIconChActiveModel?.()) {
        updateSelectors();
        await displayCurrent();
      }
    });
    updateStoredPackSummary();
  } catch (error) {
    console.warn(`${getModel(modelId).label} cache:`, formatError(error));
  } finally {
    state.cacheRunning = false;
    syncCacheActionButtons();
    if (ui.cacheProgress) ui.cacheProgress.hidden = true;
  }
}

async function bootstrapCatalog() {
  setCh1Status("Starting…");
  debugLog("bootstrapCatalog start", { online: navigator.onLine });
  state.todayKey = utcTodayKey();
  await refreshCacheRecords();

  if (state.cacheRecords.length) {
    setCh1Status("Loading cached catalog…");
    await loadCachedCatalog();
    debugLog("bootstrapCatalog built from cache", { count: state.cacheRecords.length });
  } else if (navigator.onLine) {
    await loadLiveCatalog();
  } else {
    throw new Error("Offline with no cached data");
  }

  updateSelectors();
  updateStoredPackSummary();
  debugLog("bootstrapCatalog done");
}

export function setActiveIconChModel(modelId) {
  if (state.modelId === modelId) {
    return;
  }
  if (state.validTimeIso) {
    state.pendingSwitchPreserve = {
      validIso: state.validTimeIso,
      level: state.level,
    };
  }
  snapshotWorkspace(state.modelId);
  resetIdwState();
  wCache.clear();
  state.modelId = modelId;
  state.loadGeneration += 1;
  if (!restoreWorkspace(modelId)) {
    resetModelState(modelId);
  }
  state.started = false;
}

export function initIconCh1(h, domRefs) {
  hooks = h;
  ui = {
    timePrev: domRefs.iconCh1TimePrev,
    timeNext: domRefs.iconCh1TimeNext,
    timeSelect: domRefs.iconCh1TimeSelect,
    timeValue: domRefs.iconCh1TimeValue,
    statusEl: domRefs.iconCh1StatusEl,
    altUp: domRefs.iconCh1AltUp,
    altDown: domRefs.iconCh1AltDown,
    altSelect: domRefs.iconCh1AltSelect,
    altValue: domRefs.iconCh1AltValue,
    cacheFrom: domRefs.iconCh1CacheFrom,
    cacheTo: domRefs.iconCh1CacheTo,
    cacheSettingsModel: domRefs.iconChCacheSettingsModel,
    cacheSettingsCh1: domRefs.iconChCacheSettingsCh1,
    cacheSettingsCh2: domRefs.iconChCacheSettingsCh2,
    cacheCheckTimes: domRefs.iconChCacheCheckTimes,
    cacheEstimate: domRefs.iconCh1CacheEstimate,
    cacheRun: domRefs.iconChCacheRun,
    cacheProgress: domRefs.iconCh1CacheProgress,
    storedCh1: domRefs.iconChStoredCh1,
    storedCh2: domRefs.iconChStoredCh2,
    clearTodayCache: domRefs.iconCh1ClearTodayCache,
  };

  initCachePanel();
  bindEvents();

  hooks.startIconCh1 = startIconCh1;
  hooks.stopIconCh1 = stopIconCh1;
  hooks.setActiveIconChModel = setActiveIconChModel;
  hooks.refreshIconCh1Settings = refreshIconCh1Settings;
}

export async function startIconCh1() {
  if (!hooks.isIconCh1Enabled?.()) {
    debugLog("startIconCh1 skipped — disabled");
    return;
  }

  debugLog("startIconCh1", { started: state.started });
  try {
    await waitForMapStyle();
    debugLog("map style ready");
    if (!state.started) {
      await bootstrapCatalog();
      state.started = true;
    }
    await displayCurrent();
  } catch (error) {
    showLoadError(error);
  }
}

export function stopIconCh1() {
  debugLog("stopIconCh1");
  clearCh1Status();
  state.loadGeneration += 1;
  const map = getMap();
  if (map?.getLayer(ICONCH1_SECTOR_LAYER_ID)) {
    map.setLayoutProperty(ICONCH1_SECTOR_LAYER_ID, "visibility", "none");
  }
  if (map?.getSource(ICONCH1_SECTOR_SOURCE_ID)) {
    map.getSource(ICONCH1_SECTOR_SOURCE_ID).setData({
      type: "FeatureCollection",
      features: [],
    });
  }
  updateMapAttribution(true);
}

export function refreshIconCh1Settings() {
  syncCacheSettingsModelUi();
  void updateStoredPackSummary();
}
