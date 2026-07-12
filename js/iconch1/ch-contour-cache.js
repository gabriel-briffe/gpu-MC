import { forecastDateFromRun } from "./grib-catalog.js";

export const CH_CONTOUR_TARGET_HEIGHTS_M = [1000, 2000, 3000, 4000, 5000, 6000, 7000];
export const CH_CONTOUR_UTC_HOUR_START = 6;
export const CH_CONTOUR_UTC_HOUR_END = 19;
export const CH_CONTOUR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const DB_NAME = "wasm-pmtiles-icon-ch-contours";
const DB_VERSION = 1;
const STORE_NAME = "contours";

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
    });
  }
  return dbPromise;
}

export function buildChContourCacheKey(modelId, validTimeIso, level) {
  return `${modelId}/${validTimeIso}/L${level}`;
}

export function validTimeIso(dateStamp, forecastHour) {
  return forecastDateFromRun(dateStamp, forecastHour).toISOString().replace(".000Z", "Z");
}

export function utcDayStart(now = new Date()) {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

/** Pick the UTC day with the most 06–19 steps, preferring today and future dates. */
export function resolveCacheTargetUtcDay(
  entries,
  dateStamp,
  now = new Date(),
  startHour = CH_CONTOUR_UTC_HOUR_START,
  endHour = CH_CONTOUR_UTC_HOUR_END
) {
  const byDate = new Map();

  for (const entry of entries) {
    if (entry.dateStamp !== dateStamp) continue;
    const valid = forecastDateFromRun(dateStamp, entry.forecastHour);
    const hour = valid.getUTCHours();
    if (hour < startHour || hour > endHour) continue;

    const key = utcDateKey(valid);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(entry);
  }

  if (byDate.size === 0) return null;

  const todayKey = utcDateKey(utcDayStart(now));
  const candidates = [...byDate.entries()]
    .filter(([key]) => key >= todayKey)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  if (candidates.length > 0) {
    return { dayStart: new Date(`${candidates[0][0]}T00:00:00.000Z`), entries: candidates[0][1] };
  }

  const [bestKey, bestEntries] = [...byDate.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return { dayStart: new Date(`${bestKey}T00:00:00.000Z`), entries: bestEntries };
}

export function filterEntriesForValidUtcHours(
  entries,
  dateStamp,
  dayStart,
  startHour = CH_CONTOUR_UTC_HOUR_START,
  endHour = CH_CONTOUR_UTC_HOUR_END
) {
  const dayKey = utcDateKey(dayStart);

  return entries
    .filter((entry) => entry.dateStamp === dateStamp)
    .filter((entry) => {
      const valid = forecastDateFromRun(dateStamp, entry.forecastHour);
      if (utcDateKey(valid) !== dayKey) return false;
      const hour = valid.getUTCHours();
      return hour >= startHour && hour <= endHour;
    })
    .sort((a, b) => Number(a.forecastHour) - Number(b.forecastHour));
}

export function pickLevelsNearTargets(levelHeights, targetsM = CH_CONTOUR_TARGET_HEIGHTS_M) {
  const levels = [...levelHeights.entries()].map(([level, heightM]) => ({ level, heightM }));
  const picked = [];
  const used = new Set();

  for (const targetM of targetsM) {
    let best = null;
    for (const entry of levels) {
      if (used.has(entry.level)) continue;
      const diff = Math.abs(entry.heightM - targetM);
      if (!best || diff < best.diff) {
        best = { ...entry, targetM, diff };
      }
    }
    if (!best) break;
    used.add(best.level);
    picked.push({
      level: best.level,
      heightM: best.heightM,
      targetM: best.targetM,
    });
  }

  return picked;
}

export function estimateJsonByteSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function formatByteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function cacheEntryExpiresAt(cachedAt, ttlMs = CH_CONTOUR_CACHE_TTL_MS) {
  const cachedMs = new Date(cachedAt).getTime();
  if (Number.isNaN(cachedMs)) return 0;
  return cachedMs + ttlMs;
}

export function isChContourCacheEntryFresh(record, now = new Date(), ttlMs = CH_CONTOUR_CACHE_TTL_MS) {
  if (!record?.cachedAt) return false;
  return cacheEntryExpiresAt(record.cachedAt, ttlMs) > now.getTime();
}

export async function getChContourCacheEntry(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB read failed"));
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    request.onsuccess = () => resolve(request.result ?? null);
  });
}

export async function getFreshChContourCacheEntry(key, now = new Date()) {
  const record = await getChContourCacheEntry(key);
  if (!record || !isChContourCacheEntryFresh(record, now)) return null;
  return record;
}

export async function pruneExpiredChContourCache(now = new Date()) {
  const db = await openDb();
  const records = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB read failed"));
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    request.onsuccess = () => resolve(request.result ?? []);
  });

  const expiredKeys = records
    .filter((record) => !isChContourCacheEntryFresh(record, now))
    .map((record) => record.key);

  if (expiredKeys.length === 0) return 0;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB prune failed"));
    tx.oncomplete = () => resolve();
    const store = tx.objectStore(STORE_NAME);
    for (const key of expiredKeys) store.delete(key);
  });

  return expiredKeys.length;
}

export async function putChContourCacheEntry(record, now = new Date()) {
  const cachedAt = record.cachedAt ?? now.toISOString();
  const payload = {
    ...record,
    cachedAt,
    expiresAt: new Date(cacheEntryExpiresAt(cachedAt)).toISOString(),
  };
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.oncomplete = () => resolve(payload);
    tx.objectStore(STORE_NAME).put(payload);
  });
}

export async function listFreshChContourCacheEntries(modelId, now = new Date()) {
  await pruneExpiredChContourCache(now);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB read failed"));
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    request.onsuccess = () => {
      const records = request.result ?? [];
      resolve(
        records.filter(
          (record) => record.modelId === modelId && isChContourCacheEntryFresh(record, now)
        )
      );
    };
  });
}

export function formatValidTimeLabel(validTimeIso) {
  const date = new Date(validTimeIso);
  if (Number.isNaN(date.getTime())) return validTimeIso;
  const d = String(date.getUTCDate()).padStart(2, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  return `${d}/${m} ${h}Z`;
}

export function validTimesInRange(validTimes, fromIso, toIso) {
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return [];
  const minMs = Math.min(fromMs, toMs);
  const maxMs = Math.max(fromMs, toMs);
  return validTimes.filter((iso) => {
    const ms = new Date(iso).getTime();
    return ms >= minMs && ms <= maxMs;
  });
}

/** Match a valid-time ISO string to a catalog entry (timestamp equality). */
export function findValidTimeIso(validTimes, iso) {
  if (!iso || !validTimes.length) return null;
  const targetMs = new Date(iso).getTime();
  if (Number.isNaN(targetMs)) return null;
  return validTimes.find((candidate) => new Date(candidate).getTime() === targetMs) ?? null;
}

/** Next catalog valid time at or after now (UTC). */
export function defaultCacheFromIso(validTimes, now = new Date()) {
  if (!validTimes.length) return "";
  const nowMs = now.getTime();
  const upcoming = validTimes.find((iso) => new Date(iso).getTime() >= nowMs);
  return upcoming ?? snapToNearestTime(nowMs, validTimes) ?? validTimes[0];
}

/** Next catalog step for the upcoming 19Z UTC window (exact 19Z when available). */
export function defaultCacheToIso(validTimes, now = new Date()) {
  if (!validTimes.length) return "";
  const nowMs = now.getTime();

  const target19 = new Date(now);
  target19.setUTCMilliseconds(0);
  target19.setUTCSeconds(0);
  target19.setUTCMinutes(0);
  target19.setUTCHours(CH_CONTOUR_UTC_HOUR_END);
  if (target19.getTime() < nowMs) {
    target19.setUTCDate(target19.getUTCDate() + 1);
  }
  const target19Ms = target19.getTime();
  const targetDay = target19.toISOString().slice(0, 10);

  for (const iso of validTimes) {
    const date = new Date(iso);
    const ms = date.getTime();
    if (ms >= nowMs && date.getUTCHours() === CH_CONTOUR_UTC_HOUR_END && date.getUTCMinutes() === 0) {
      return iso;
    }
  }

  let bestSameDay = null;
  for (const iso of validTimes) {
    const date = new Date(iso);
    const ms = date.getTime();
    if (ms < nowMs || !iso.startsWith(targetDay) || date.getUTCHours() > CH_CONTOUR_UTC_HOUR_END) {
      continue;
    }
    bestSameDay = iso;
  }
  if (bestSameDay) return bestSameDay;

  let bestBeforeTarget = null;
  for (const iso of validTimes) {
    const ms = new Date(iso).getTime();
    if (ms < nowMs || ms > target19Ms) continue;
    bestBeforeTarget = iso;
  }
  if (bestBeforeTarget) return bestBeforeTarget;

  const upcoming = validTimes.find((iso) => new Date(iso).getTime() >= nowMs);
  return upcoming ?? validTimes[validTimes.length - 1];
}

export function utcTodayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function formatUtcHourLabel(date) {
  return `${String(date.getUTCHours()).padStart(2, "0")}Z`;
}

export function snapToNearestTime(targetMs, candidates) {
  if (!candidates.length) return null;
  let best = candidates[0];
  let bestDiff = Math.abs(new Date(best).getTime() - targetMs);
  for (let i = 1; i < candidates.length; i += 1) {
    const diff = Math.abs(new Date(candidates[i]).getTime() - targetMs);
    if (diff < bestDiff) {
      best = candidates[i];
      bestDiff = diff;
    }
  }
  return best;
}

export function stepUtcHour(currentIso, deltaHours, minHour, maxHour, dayKey) {
  const current = new Date(currentIso);
  const next = new Date(current.getTime() + deltaHours * 60 * 60 * 1000);
  const minMs = new Date(`${dayKey}T${String(minHour).padStart(2, "0")}:00:00.000Z`).getTime();
  const maxMs = new Date(`${dayKey}T${String(maxHour).padStart(2, "0")}:00:00.000Z`).getTime();
  const clampedMs = Math.min(maxMs, Math.max(minMs, next.getTime()));
  return new Date(clampedMs).toISOString().replace(".000Z", "Z");
}

export async function deleteChContourCacheForDay(modelId, dayKey) {
  const records = await listFreshChContourCacheEntries(modelId);
  const keys = records
    .filter((record) => record.validTimeIso.startsWith(dayKey))
    .map((record) => record.key);
  if (keys.length === 0) return 0;

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
    tx.oncomplete = () => resolve();
    const store = tx.objectStore(STORE_NAME);
    for (const key of keys) store.delete(key);
  });
  return keys.length;
}

export async function deleteAllChContourCacheForModel(modelId) {
  const db = await openDb();
  const keys = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB read failed"));
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    request.onsuccess = () => {
      const records = request.result ?? [];
      resolve(records.filter((record) => record.modelId === modelId).map((record) => record.key));
    };
  });
  if (keys.length === 0) return 0;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
    tx.oncomplete = () => resolve();
    const store = tx.objectStore(STORE_NAME);
    for (const key of keys) store.delete(key);
  });
  return keys.length;
}

export async function getChContourCacheStats(now = new Date()) {
  await pruneExpiredChContourCache(now);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB read failed"));
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    request.onsuccess = () => {
      const records = request.result ?? [];
      let totalBytes = 0;
      for (const record of records) {
        totalBytes += record.byteSize ?? estimateJsonByteSize(record.geojson);
      }
      resolve({ count: records.length, totalBytes });
    };
  });
}
