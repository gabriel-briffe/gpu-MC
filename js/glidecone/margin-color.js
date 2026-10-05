/** Green at the largest margin, yellow halfway, red at zero. */
const GREEN = [0, 192, 0];
const YELLOW = [255, 214, 0];
const RED = [255, 0, 0];

function mix(a, b, u) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

export function marginRgb(t) {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped >= 0.5) {
    return mix(YELLOW, GREEN, (clamped - 0.5) * 2);
  }
  return mix(RED, YELLOW, clamped * 2);
}

export function marginHex(t) {
  const [r, g, b] = marginRgb(t);
  const hex = (n) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Share of the field's largest margin. Zero when the cone or the scale is missing. */
export function cellMarginT(arrival, cone, maxAltitude, maxMargin) {
  if (!Number.isFinite(arrival) || !Number.isFinite(cone) || cone >= maxAltitude || !(maxMargin > 0)) {
    return 0;
  }
  return Math.max(0, Math.min(1, (arrival - cone) / maxMargin));
}
