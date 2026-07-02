export function formatComputeDone(result, extra = "") {
  let suffix = "";
  if (result.stopReason === "max_iterations") {
    suffix = ` (stopped at iter ${result.iterations})`;
  } else if (result.stopped) {
    suffix = " (stopped)";
  }
  return `Done — ${result.iterations} iters, ${result.elapsedMs.toFixed(0)} ms GPU${suffix}${extra}`;
}

export function formatDistanceKm(distanceM) {
  const km = (distanceM / 1000).toFixed(1);
  return `<span class="tooltip-num">${km} km</span>`;
}

export function tooltipNum(value, { warn = false, unit = "m" } = {}) {
  const classes = warn ? "tooltip-num tooltip-num-warn" : "tooltip-num";
  return `<span class="${classes}">${value}${unit ? ` ${unit}` : ""}</span>`;
}

export function formatHoverTip(cell, { groundClearance, debugMode, metrics, glideRatio = 20 }) {
  const minAltVal = cell.alt;
  const minAlt = minAltVal !== null ? tooltipNum(Math.round(minAltVal)) : "—";
  const groundElev = tooltipNum(Math.round(cell.groundElev));

  let aboveGroundLine = "—";
  if (minAltVal !== null) {
    const aboveGround = Math.round(minAltVal - cell.groundElev);
    const warn = aboveGround < 1.2 * groundClearance;
    aboveGroundLine = tooltipNum(aboveGround, { warn });
  }

  const pathLengthLine =
    metrics !== null ? formatDistanceKm(metrics.distanceM) : "—";
  const requiredLine =
    metrics !== null ? tooltipNum(Math.round(metrics.requiredAlt)) : "—";

  let deltaLine = "—";
  if (minAltVal !== null && metrics !== null) {
    const delta = Math.round(minAltVal - metrics.requiredAlt);
    const sign = delta > 0 ? "+" : "";
    const cls = delta >= 0 ? "delta-pos" : "delta-neg";
    deltaLine = `<span class="${cls} tooltip-num">${sign}${delta} m</span>`;
  }

  const maxSegmentLdVal = metrics?.maxSegmentLd;
  const maxSegmentLdLine =
    maxSegmentLdVal != null && (maxSegmentLdVal > 0 || maxSegmentLdVal === -99)
      ? (() => {
          const flooredLd =
            maxSegmentLdVal === -99
              ? -99
              : Math.floor(maxSegmentLdVal * 10) / 10;
          const warn = flooredLd === -99 || flooredLd > glideRatio;
          const cls = warn ? "delta-neg tooltip-num" : "tooltip-num";
          const text = flooredLd === -99 ? "-99" : flooredLd.toFixed(1);
          return `<span class="${cls}">${text}</span>`;
        })()
      : "—";

  let text =
    `minimum alt: ${minAlt}\n` +
    `ground elevation: ${groundElev}\n` +
    `above ground: ${aboveGroundLine}`;

  if (debugMode) {
    const cellIj =
      cell.gi != null && cell.gj != null ? `${cell.gi}, ${cell.gj}` : "—";
    const originIj =
      cell.originGi != null && cell.originGj != null
        ? `${cell.originGi}, ${cell.originGj}`
        : "—";
    text +=
      `\n\ncell i, j: ${cellIj}\n` +
      `origin i, j: ${originIj}\n` +
      // `\n<span class="path-info-heading">comparison with measured path length (haversine):</span>\n` +
      `path length: ${pathLengthLine}\n` +
      `required alt: ${requiredLine}\n` +
      `delta: ${deltaLine}\n` +
      `max segment L/D: ${maxSegmentLdLine}\n` ;
      // `<span class="path-info-note">delta heavily positive might mean path went over a saddle, or starts from a mountain well above glide, no issue in that case. use this on flatland at your latitude to check for unacceptable errors</span>`;
  }

  return text;
}
