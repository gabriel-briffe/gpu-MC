/** IGC B-record replay for sim mode. Times are seconds from the first fix. */

function parseLat(raw) {
  const deg = Number(raw.slice(0, 2));
  const min = Number(raw.slice(2, 7)) / 1000;
  if (!Number.isFinite(deg) || !Number.isFinite(min)) {
    return null;
  }
  const sign = raw[7] === "S" ? -1 : 1;
  return sign * (deg + min / 60);
}

function parseLon(raw) {
  const deg = Number(raw.slice(0, 3));
  const min = Number(raw.slice(3, 8)) / 1000;
  if (!Number.isFinite(deg) || !Number.isFinite(min)) {
    return null;
  }
  const sign = raw[8] === "W" ? -1 : 1;
  return sign * (deg + min / 60);
}

function clockSeconds(raw) {
  const h = Number(raw.slice(0, 2));
  const m = Number(raw.slice(2, 4));
  const s = Number(raw.slice(4, 6));
  if (![h, m, s].every(Number.isFinite)) {
    return null;
  }
  return h * 3600 + m * 60 + s;
}

export function parseIgc(text) {
  const fixes = [];
  let daySeconds = 0;
  let previous = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith("B") || line.length < 35) {
      continue;
    }
    const clock = clockSeconds(line.slice(1, 7));
    const lat = parseLat(line.slice(7, 15));
    const lng = parseLon(line.slice(15, 24));
    if (clock == null || lat == null || lng == null) {
      continue;
    }
    if (previous != null && clock + daySeconds < previous) {
      daySeconds += 24 * 3600;
    }
    previous = clock + daySeconds;
    const pressure = Number(line.slice(25, 30));
    const gps = Number(line.slice(30, 35));
    const alt = Number.isFinite(gps) && gps !== 0 ? gps : pressure;
    fixes.push({
      t: previous,
      lat,
      lng,
      alt: Number.isFinite(alt) ? alt : null,
    });
  }
  if (fixes.length === 0) {
    return [];
  }
  const origin = fixes[0].t;
  return fixes.map((fix) => ({ ...fix, t: fix.t - origin }));
}

export function fixAt(fixes, seconds) {
  if (!fixes.length) {
    return null;
  }
  if (seconds <= fixes[0].t) {
    return fixes[0];
  }
  const last = fixes[fixes.length - 1];
  if (seconds >= last.t) {
    return last;
  }
  let hi = fixes.length - 1;
  let lo = 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid].t <= seconds) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const a = fixes[lo];
  const b = fixes[hi];
  const span = b.t - a.t;
  const u = span > 0 ? (seconds - a.t) / span : 0;
  return {
    t: seconds,
    lat: a.lat + (b.lat - a.lat) * u,
    lng: a.lng + (b.lng - a.lng) * u,
    alt: Number.isFinite(a.alt) && Number.isFinite(b.alt) ? a.alt + (b.alt - a.alt) * u : a.alt,
  };
}
