export const DWD_BASE = "https://opendata.dwd.de/weather/nwp";
export const RUN_MIN_AGE_HOURS = 3;

export const RUN_HOURS = ["00", "03", "06", "09", "12", "15", "18", "21"];

export const GRIB_MODELS = {
  "icon-d2": {
    label: "ICON D2",
    provider: "dwd",
    domain: "germany",
    suffix: "w",
    mapCenter: [10.5, 51.0],
    mapZoom: 6.2,
    defaultLevel: 30,
    runHours: RUN_HOURS,
  },
  "icon-eu": {
    label: "ICON EU",
    provider: "dwd",
    domain: "europe",
    suffix: "W",
    mapCenter: [10.13, 45.77],
    mapZoom: 5.69,
    defaultLevel: 58,
    runHours: RUN_HOURS,
  },
  "icon-ch1": {
    label: "ICON CH1",
    provider: "meteoswiss",
    collection: "ch.meteoschweiz.ogd-forecasting-icon-ch1",
    staticAssets: {
      horizontal: "horizontal_constants_icon-ch1-eps.grib2",
      vertical: "vertical_constants_icon-ch1-eps.grib2",
    },
    mapCenter: [8.23, 46.82],
    mapZoom: 7.2,
    defaultLevel: 40,
    runHours: ["00", "03", "06", "09", "12", "15", "18", "21"],
    regridSpacingDeg: 0.01,
  },
  "icon-ch2": {
    label: "ICON CH2",
    provider: "meteoswiss",
    collection: "ch.meteoschweiz.ogd-forecasting-icon-ch2",
    staticAssets: {
      horizontal: "horizontal_constants_icon-ch2-eps.grib2",
      vertical: "vertical_constants_icon-ch2-eps.grib2",
    },
    mapCenter: [8.23, 46.82],
    mapZoom: 7.2,
    defaultLevel: 40,
    runHours: ["00", "06", "12", "18"],
    regridSpacingDeg: 0.02,
  },
};

const FILE_RE = {
  "icon-d2":
    /icon-d2_germany_regular-lat-lon_model-level_(\d{10})_(\d{3})_(\d+)_w\.grib2\.bz2/,
  "icon-eu":
    /icon-eu_europe_regular-lat-lon_model-level_(\d{10})_(\d{3})_(\d+)_W\.grib2\.bz2/,
};

export function dateStampFromRunTime(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  return `${y}${m}${d}${h}`;
}

export function formatDateStamp(dateStamp) {
  const y = dateStamp.slice(0, 4);
  const m = dateStamp.slice(4, 6);
  const d = dateStamp.slice(6, 8);
  const h = dateStamp.slice(8, 10);
  return `${y}-${m}-${d} ${h}Z`;
}

export function forecastDateFromRun(dateStamp, forecastHour) {
  const y = Number(dateStamp.slice(0, 4));
  const m = Number(dateStamp.slice(4, 6)) - 1;
  const d = Number(dateStamp.slice(6, 8));
  const h = Number(dateStamp.slice(8, 10));
  return new Date(Date.UTC(y, m, d, h + Number(forecastHour), 0, 0));
}

export function pickLatestRunCandidates(modelId = "icon-d2", now = new Date()) {
  const model = GRIB_MODELS[modelId];
  const runHours = model?.runHours ?? RUN_HOURS;
  const thresholdMs = now.getTime() - RUN_MIN_AGE_HOURS * 60 * 60 * 1000;
  const candidates = [];

  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const day = new Date(now);
    day.setUTCDate(day.getUTCDate() - dayOffset);

    for (const runHour of runHours) {
      const hour = Number(runHour);
      const runTime = new Date(
        Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0, 0)
      );
      if (runTime.getTime() >= thresholdMs) continue;

      candidates.push({
        runHour,
        dateStamp: dateStampFromRunTime(runTime),
        runTime,
      });
    }
  }

  candidates.sort((a, b) => b.runTime.getTime() - a.runTime.getTime());
  return candidates;
}

export function buildGribUrl(modelId, runHour, dateStamp, forecastHour, level) {
  const model = GRIB_MODELS[modelId];
  const fff = String(forecastHour).padStart(3, "0");
  const filename = `${modelId}_${model.domain}_regular-lat-lon_model-level_${dateStamp}_${fff}_${level}_${model.suffix}.grib2.bz2`;
  return `${DWD_BASE}/${modelId}/grib/${runHour}/w/${filename}`;
}

/** Nearest 1000 m for UI (2966 → 3000). */
export function nearestDisplayAltitudeM(heightM) {
  if (!Number.isFinite(heightM)) {
    return null;
  }
  return Math.round(heightM / 1000) * 1000;
}

/** level → { heightM, displayM } from GRIB level heights. */
export function buildLevelAltitudeMap(levelHeights) {
  const map = new Map();
  for (const [level, heightM] of levelHeights) {
    map.set(level, {
      heightM,
      displayM: nearestDisplayAltitudeM(heightM),
    });
  }
  return map;
}

export function formatAltitudeLabel(displayM) {
  return displayM != null ? `${displayM}m` : "—";
}

export function parseCatalogHtml(html, modelId, runHour) {
  const re = FILE_RE[modelId];
  if (!re) return [];

  const entries = [];
  const seen = new Set();
  for (const match of html.matchAll(new RegExp(re.source, "g"))) {
    const [filename, dateStamp, forecastHour, levelStr] = match;
    const key = `${dateStamp}_${forecastHour}_${levelStr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      filename,
      dateStamp,
      forecastHour,
      level: Number(levelStr),
      url: buildGribUrl(modelId, runHour, dateStamp, forecastHour, Number(levelStr)),
    });
  }

  entries.sort((a, b) => {
    if (a.dateStamp !== b.dateStamp) return b.dateStamp.localeCompare(a.dateStamp);
    if (a.forecastHour !== b.forecastHour) {
      return Number(a.forecastHour) - Number(b.forecastHour);
    }
    return a.level - b.level;
  });

  return entries;
}

export function catalogOptions(entries, forecastHour) {
  const forecastHours = [...new Set(entries.map((entry) => entry.forecastHour))].sort(
    (a, b) => Number(a) - Number(b)
  );

  const levelEntries = forecastHour
    ? entries.filter((entry) => entry.forecastHour === forecastHour)
    : entries;

  const levels = [...new Set(levelEntries.map((entry) => entry.level).filter((level) => level !== undefined))].sort(
    (a, b) => a - b
  );

  return { forecastHours, levels };
}

function pickForecastHourClosestToNow(dateStamp, forecastHours, now = new Date()) {
  if (forecastHours.length === 0) return "";
  const nowMs = now.getTime();
  let best = forecastHours[0];
  let bestDiff = Infinity;
  for (const forecastHour of forecastHours) {
    const diff = Math.abs(forecastDateFromRun(dateStamp, forecastHour).getTime() - nowMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = forecastHour;
    }
  }
  return best;
}

export function pickDefaultSelection(modelId, entries, dateStamp, previous = {}, levelsOverride = null) {
  const model = GRIB_MODELS[modelId];
  if (entries.length === 0) {
    return { forecastHour: "", level: "" };
  }

  const { forecastHours } = catalogOptions(entries);

  const forecastHour = forecastHours.includes(previous.forecastHour)
    ? previous.forecastHour
    : pickForecastHourClosestToNow(dateStamp, forecastHours);

  const levelOpts = levelsOverride ?? catalogOptions(entries, forecastHour);
  const level = levelOpts.levels.includes(Number(previous.level))
    ? Number(previous.level)
    : levelOpts.levels.includes(model.defaultLevel)
      ? model.defaultLevel
      : levelOpts.levels[0];

  return { forecastHour, level };
}
