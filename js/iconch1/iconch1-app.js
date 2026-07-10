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
import { regridIdw } from "./regrid.js";
import { buildSectorGeoJson } from "./contour-geojson.js";
import { readProxiedFile, toRawGribBytes, formatError } from "./grib-io.js";
import {
  CH_CONTOUR_TARGET_HEIGHTS_M,
  CH_CONTOUR_UTC_HOUR_END,
  buildChContourCacheKey,
  deleteChContourCacheForDay,
  estimateJsonByteSize,
  formatByteSize,
  formatValidTimeLabel,
  getChContourCacheStats,
  getFreshChContourCacheEntry,
  hourlyUtcSlotsForDay,
  listFreshChContourCacheEntries,
  pickLevelsNearTargets,
  putChContourCacheEntry,
  snapToNearestTime,
  stepUtcHour,
  utcTodayKey,
  validTimeIso,
} from "./ch-contour-cache.js";
import { assetUrl } from "../asset-url.js";

const MODEL_ID = "icon-ch1";
export const ICONCH1_SECTOR_SOURCE_ID = "ch1-sectors";
export const ICONCH1_SECTOR_LAYER_ID = "ch1-sectors-layer";
const STORAGE = {
  defaultAlt: "ch1-default-alt-target",
};

const model = GRIB_MODELS[MODEL_ID];
const DEBUG_PREFIX = "[IconCH1]";

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
  navMinHour: 0,
  navMaxHour: 23,
  loadGeneration: 0,
  cacheRunning: false,
  started: false,
};

let wasmReady = null;
let mapLayersReady = null;
let gridCache = null;
const wCache = new Map();

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
  const value = Number(localStorage.getItem(STORAGE.defaultAlt));
  return CH_CONTOUR_TARGET_HEIGHTS_M.includes(value) ? value : 3000;
}

async function refreshCacheRecords() {
  state.cacheRecords = (await listFreshChContourCacheEntries(MODEL_ID)).filter((record) =>
    record.validTimeIso.startsWith(state.todayKey)
  );
  rebuildLevelAltitudeMap();
  debugLog("cache records refreshed", {
    todayKey: state.todayKey,
    count: state.cacheRecords.length,
  });
}

function applyCacheMetadata() {
  if (!state.cacheRecords.length) throw new Error("No cached contours for today");
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

function buildForecastAttribution() {
  if (!state.dateStamp || !state.validTimeIso || state.level === "") {
    return "ICON CH1";
  }
  const run = formatDateStamp(state.dateStamp);
  const valid = formatValidTimeLabel(state.validTimeIso);
  const step = state.forecastHour !== "" ? `+${state.forecastHour}h` : "—";
  return `Forecast ${valid} · Run ${run} · Step ${step} · L${state.level}`;
}

function updateMapAttribution(clear = false) {
  const map = getMap();
  if (!map) return;
  const inner = map.getContainer().querySelector(".maplibregl-ctrl-attrib-inner");
  if (!inner) return;

  let node = inner.querySelector(".ch1-forecast-attrib");
  if (clear) {
    node?.remove();
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

  const hour = state.validTimeIso ? new Date(state.validTimeIso).getUTCHours() : null;
  ui.timePrev.disabled = hour == null || hour <= state.navMinHour;
  ui.timeNext.disabled = hour == null || hour >= state.navMaxHour;

  const levelIdx = levels.findIndex((entry) => entry.level === state.level);
  ui.altUp.disabled = levelIdx < 0 || levelIdx >= levels.length - 1;
  ui.altDown.disabled = levelIdx <= 0;

  updateMapAttribution();
}

function formatUtcHour(iso) {
  return `${String(new Date(iso).getUTCHours()).padStart(2, "0")}Z`;
}

function todayValidTimesFromEntries() {
  return state.entries
    .map((entry) => validTimeIso(state.dateStamp, entry.forecastHour))
    .filter((iso) => iso.startsWith(state.todayKey))
    .sort();
}

function rebuildViewOptions() {
  rebuildLevelAltitudeMap();

  if (state.entries.length) {
    state.validTimes = todayValidTimesFromEntries();
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
    const times = [...new Set(state.cacheRecords.map((record) => record.validTimeIso))].sort();
    state.validTimes = times.filter((iso) => iso.startsWith(state.todayKey));
    const levelMap = new Map();
    for (const record of state.cacheRecords) {
      if (!state.validTimes.includes(record.validTimeIso)) continue;
      levelMap.set(record.level, record.heightM);
    }
    state.levels = sortLevelsByDisplay(
      [...levelMap.entries()].map(([level, heightM]) => levelAltitudeEntry(level, heightM))
    );
  }

  if (state.validTimes.length > 0) {
    state.navMinHour = new Date(state.validTimes[0]).getUTCHours();
    state.navMaxHour = new Date(state.validTimes[state.validTimes.length - 1]).getUTCHours();
  }
}

function pickDefaultSelection() {
  const now = new Date();
  const nowHour = now.getUTCHours();
  const targetAlt = defaultAltTarget();

  if (!state.validTimes.length) return;

  const futureTimes = state.validTimes.filter(
    (iso) => new Date(iso).getTime() >= now.getTime() - 30 * 60 * 1000
  );
  state.validTimeIso = futureTimes[0] ?? state.validTimes[0];

  const nearNow = hourlyUtcSlotsForDay(state.todayKey, nowHour, CH_CONTOUR_UTC_HOUR_END)
    .map((date) => date.toISOString().replace(".000Z", "Z"))
    .find((iso) => state.validTimes.includes(iso));
  if (nearNow) state.validTimeIso = nearNow;

  const levelsForTime = levelsAtTime(state.validTimeIso);
  let best = levelsForTime[0];
  let bestDiff = Infinity;
  for (const entry of levelsForTime) {
    const diff = Math.abs(entry.displayM - targetAlt);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = entry;
    }
  }
  if (best) {
    state.level = best.level;
    state.heightM = best.heightM;
    state.displayM = best.displayM;
    state.forecastHour = resolveForecastHour(state.validTimeIso, state.level);
  }
  updateSelectors();
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

function stepTime(deltaHours) {
  if (!hooks.isIconCh1Enabled?.() || !state.validTimeIso) return;
  const stepped = stepUtcHour(state.validTimeIso, deltaHours, state.navMinHour, state.navMaxHour, state.todayKey);
  const snapped = snapToNearestTime(new Date(stepped).getTime(), state.validTimes);
  if (!snapped) return;
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
    return gridCache;
  }
  setCh1Status("Fetching grid constants…");
  debugLog("loadGrid start");
  await ensureWasm();
  const [horizontalUrl, verticalUrl] = await Promise.all([
    getCollectionAssetUrl(model.collection, model.staticAssets.horizontal),
    getCollectionAssetUrl(model.collection, model.staticAssets.vertical),
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
  return gridCache;
}

async function loadWMessage(url) {
  let cached = wCache.get(url);
  if (!cached) {
    setCh1Status("Fetching forecast GRIB…");
    debugLog("loadWMessage fetch", { url, level: state.level });
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
  const message = cached.byLevel.get(state.level) ?? cached.byLevel.get(Number(state.level));
  if (!message) {
    debugLog("loadWMessage level missing", {
      requestedLevel: state.level,
      availableLevels: [...cached.byLevel.keys()].sort((a, b) => a - b),
    });
  }
  return message;
}

async function buildLiveGeoJson() {
  debugLog("buildLiveGeoJson start", {
    validTimeIso: state.validTimeIso,
    level: state.level,
    heightM: state.heightM,
  });
  const entry = state.entries.find(
    (item) => validTimeIso(state.dateStamp, item.forecastHour) === state.validTimeIso
  );
  if (!entry) throw new Error("Forecast step not found in catalog");

  const grid = await loadGrid();
  const message = await loadWMessage(entry.url);
  if (!message) throw new Error(`Level ${state.level} not found in forecast file`);

  const values = decode_template42_values_f32(message);
  const spacing = model.regridSpacingDeg ?? 0.01;
  setCh1Status("Regridding field…");
  debugLog("buildLiveGeoJson regrid", {
    valueCount: values.length,
    spacingDeg: spacing,
    forecastHour: entry.forecastHour,
  });
  const field = await regridIdw(grid.clat, grid.clon, values, spacing);
  setCh1Status("Extracting contours…");
  const geojson = buildSectorGeoJson(field, new Float32Array(field.values));
  debugLog("buildLiveGeoJson done", {
    featureCount: geojson.features?.length ?? 0,
    gridWidth: field.width,
    gridHeight: field.height,
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
      modelId: MODEL_ID,
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
    const key = buildChContourCacheKey(MODEL_ID, state.validTimeIso, state.level);
    const cached = await getFreshChContourCacheEntry(key);
    if (cached?.geojson) {
      geojson = cached.geojson;
      source = "indexeddb";
      setCh1Status("Loading cached contours…");
      debugLog("displayCurrent cache hit", { key, featureCount: geojson.features?.length ?? 0 });
    } else if (state.entries.length && navigator.onLine) {
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

async function loadLiveCatalog() {
  setCh1Status("Fetching catalog…");
  debugLog("loadLiveCatalog start");
  const run = await pickLatestMeteoSwissRun(model.collection, MODEL_ID);
  if (!run) throw new Error("No recent ICON CH1 run found.");
  debugLog("loadLiveCatalog run picked", run);

  const items = await fetchForecastItemsForRun(model.collection, run.referenceIso);
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
  pickDefaultSelection();
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

async function loadCachedCatalog() {
  await refreshCacheRecords();
  applyCacheMetadata();
  rebuildViewOptions();
  pickDefaultSelection();
}

function initSettingsPanel() {
  if (!ui.settingsDefaultAlt) return;
  ui.settingsDefaultAlt.innerHTML = "";
  for (const targetM of CH_CONTOUR_TARGET_HEIGHTS_M) {
    const option = document.createElement("option");
    option.value = String(targetM);
    option.textContent = `${targetM} m`;
    ui.settingsDefaultAlt.appendChild(option);
  }
  ui.settingsDefaultAlt.value = String(defaultAltTarget());
}

function fillUtcHourOptions(select, selectedHour) {
  if (!select) return;
  select.innerHTML = "";
  for (let hour = 0; hour <= 23; hour += 1) {
    const option = document.createElement("option");
    option.value = String(hour);
    option.textContent = `${String(hour).padStart(2, "0")}Z`;
    if (hour === selectedHour) option.selected = true;
    select.appendChild(option);
  }
}

function initCachePanel() {
  if (!ui.cacheTo) return;
  const nowHour = new Date().getUTCHours();
  fillUtcHourOptions(ui.cacheFrom, nowHour);
  fillUtcHourOptions(ui.cacheTo, 23);

  if (ui.cacheAltitudes) {
    ui.cacheAltitudes.innerHTML = "";
    for (const targetM of CH_CONTOUR_TARGET_HEIGHTS_M) {
      const id = `ch1-alt-${targetM}`;
      const label = document.createElement("label");
      label.htmlFor = id;
      const labelText = targetM >= 1000 ? `${targetM / 1000}k` : `${targetM}m`;
      label.innerHTML = `<input type="checkbox" id="${id}" value="${targetM}" checked /> ${labelText}`;
      ui.cacheAltitudes.appendChild(label);
    }
  }

  updateCacheEstimate();
}

function selectedCacheTargets() {
  if (!ui.cacheAltitudes) return [];
  return [...ui.cacheAltitudes.querySelectorAll("input:checked")].map((input) => Number(input.value));
}

function updateCacheEstimate() {
  if (!ui.cacheEstimate || !ui.cacheTo || !ui.cacheFrom) return;
  const fromHour = Number(ui.cacheFrom.value);
  const toHour = Number(ui.cacheTo.value);
  const hours = Number.isFinite(fromHour) && Number.isFinite(toHour) && fromHour <= toHour
    ? toHour - fromHour + 1
    : 0;
  const targets = selectedCacheTargets();
  const count = hours * targets.length;
  ui.cacheEstimate.textContent =
    count > 0 ? `~${count} map${count === 1 ? "" : "s"} · est. ${formatByteSize(count * 350000)}` : "—";
}

async function updateStoredPackSummary() {
  if (!ui.storedPack) return;
  const records = (await listFreshChContourCacheEntries(MODEL_ID)).filter((record) =>
    record.validTimeIso.startsWith(state.todayKey)
  );
  if (!records.length) {
    ui.storedPack.textContent = "No pack for today";
    return;
  }
  const times = new Set(records.map((record) => record.validTimeIso));
  const levels = new Set(records.map((record) => record.level));
  let bytes = 0;
  for (const record of records) bytes += record.byteSize ?? estimateJsonByteSize(record.geojson);
  ui.storedPack.textContent = `Today · ${times.size} time(s) · ${levels.size} level(s) · ${formatByteSize(bytes)}`;
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

  ui.settingsDefaultAlt?.addEventListener("change", () => {
    localStorage.setItem(STORAGE.defaultAlt, ui.settingsDefaultAlt.value);
  });

  ui.clearTodayCache?.addEventListener("click", () => {
    void (async () => {
      await deleteChContourCacheForDay(MODEL_ID, state.todayKey);
      state.cacheRecords = [];
      updateStoredPackSummary();
      if (navigator.onLine) {
        await loadLiveCatalog();
      } else {
        return;
      }
      updateSelectors();
      await displayCurrent();
    })();
  });

  ui.cacheFrom?.addEventListener("change", updateCacheEstimate);
  ui.cacheTo?.addEventListener("change", updateCacheEstimate);
  ui.cacheAltitudes?.addEventListener("change", updateCacheEstimate);
  ui.cacheRun?.addEventListener("click", () => void runCacheFlight());

  window.addEventListener("keydown", (event) => {
    if (!hooks.isIconCh1Enabled?.()) return;
    if (event.target.closest("#params-shell") || event.target.closest("dialog")) return;
    if (event.target.matches("select, input, textarea")) return;
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
    }
  });

  window.addEventListener("offline", () => {
    if (!hooks.isIconCh1Enabled?.()) return;
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

async function runCacheFlight() {
  if (state.cacheRunning) return;
  state.cacheRunning = true;
  if (ui.cacheRun) ui.cacheRun.disabled = true;
  if (ui.cacheProgress) ui.cacheProgress.hidden = false;

  try {
    if (!state.entries.length) await loadLiveCatalog();

    const fromHour = Number(ui.cacheFrom?.value ?? "");
    const toHour = Number(ui.cacheTo.value);
    if (!Number.isFinite(fromHour) || !Number.isFinite(toHour) || fromHour > toHour) {
      throw new Error("Invalid cache hour range");
    }
    const targets = selectedCacheTargets();
    const levels = pickLevelsNearTargets(state.levelHeights, targets);
    const hourSlots = hourlyUtcSlotsForDay(state.todayKey, fromHour, toHour);

    const jobs = [];
    for (const slot of hourSlots) {
      const iso = slot.toISOString().replace(".000Z", "Z");
      const entry =
        state.entries.find((item) => validTimeIso(state.dateStamp, item.forecastHour) === iso) ??
        state.entries
          .map((item) => ({ item, iso: validTimeIso(state.dateStamp, item.forecastHour) }))
          .filter(({ iso: candidate }) => candidate.startsWith(state.todayKey))
          .sort(
            (a, b) =>
              Math.abs(new Date(a.iso).getTime() - slot.getTime()) -
              Math.abs(new Date(b.iso).getTime() - slot.getTime())
          )[0]?.item;
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
    let stored = 0;
    let skipped = 0;

    for (const job of jobs) {
      const key = buildChContourCacheKey(MODEL_ID, job.validIso, job.levelInfo.level);
      const existing = await getFreshChContourCacheEntry(key);
      if (existing) {
        skipped += 1;
        done += 1;
        if (ui.cacheProgress) ui.cacheProgress.value = done;
        continue;
      }

      state.level = job.levelInfo.level;
      const geojson = await buildLiveGeoJson();
      const byteSize = estimateJsonByteSize(geojson);
      await putChContourCacheEntry({
        key,
        modelId: MODEL_ID,
        runDateStamp: state.dateStamp,
        forecastHour: job.entry.forecastHour,
        validTimeIso: job.validIso,
        level: job.levelInfo.level,
        heightM: job.levelInfo.heightM,
        targetM: job.levelInfo.targetM,
        geojson,
        byteSize,
      });
      stored += 1;
      done += 1;
      if (ui.cacheProgress) ui.cacheProgress.value = done;
    }

    await getChContourCacheStats();
    await refreshCacheRecords();
    if (!state.entries.length) applyCacheMetadata();
    rebuildViewOptions();
    updateStoredPackSummary();
    updateSelectors();
    await displayCurrent();
  } catch (error) {
    console.warn("IconCH1 cache:", formatError(error));
  } finally {
    state.cacheRunning = false;
    if (ui.cacheRun) ui.cacheRun.disabled = false;
    if (ui.cacheProgress) ui.cacheProgress.hidden = true;
  }
}

async function bootstrapCatalog() {
  setCh1Status("Starting…");
  debugLog("bootstrapCatalog start", { online: navigator.onLine });
  state.todayKey = utcTodayKey();
  await refreshCacheRecords();

  if (navigator.onLine) {
    try {
      await loadLiveCatalog();
    } catch (error) {
      debugLog("loadLiveCatalog failed", { error: formatError(error), cacheRecords: state.cacheRecords.length });
      if (!state.cacheRecords.length) throw error;
      applyCacheMetadata();
      rebuildViewOptions();
      pickDefaultSelection();
      debugLog("bootstrapCatalog fell back to cache metadata");
    }
  } else if (state.cacheRecords.length) {
    await loadCachedCatalog();
    debugLog("bootstrapCatalog used offline cache");
  } else {
    throw new Error("Offline with no cached data for today");
  }

  updateSelectors();
  updateStoredPackSummary();
  debugLog("bootstrapCatalog done");
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
    cacheAltitudes: domRefs.iconCh1CacheAltitudes,
    cacheEstimate: domRefs.iconCh1CacheEstimate,
    cacheRun: domRefs.iconCh1CacheRun,
    cacheProgress: domRefs.iconCh1CacheProgress,
    settingsDefaultAlt: domRefs.iconCh1SettingsDefaultAlt,
    storedPack: domRefs.iconCh1StoredPack,
    clearTodayCache: domRefs.iconCh1ClearTodayCache,
  };

  initSettingsPanel();
  initCachePanel();
  bindEvents();

  hooks.startIconCh1 = startIconCh1;
  hooks.stopIconCh1 = stopIconCh1;
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
  initCachePanel();
  void updateStoredPackSummary();
}
