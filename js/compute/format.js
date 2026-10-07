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

export function formatGroundElevationTip(groundElevM) {
  return `<div class="tooltip-line">ground elevation: ${tooltipNum(Math.round(groundElevM))}</div>`;
}

/** Parked tip in Simulator when no glider is placed yet. */
export function formatPlaceGliderTip({ touch = false } = {}) {
  const action = touch ? "long press" : "click";
  return `<div class="tooltip-line">${action} to place glider</div>`;
}

/** Hover tip when the pointer is over an airport marker. */
export function formatAirportActionTip({
  mode,
  disabled = false,
  combinedIconUrl,
  singleIconUrl,
} = {}) {
  if (mode === "single") {
    return `<div class="tooltip-line">click to compute</div>`;
  }
  if (mode === "auto") {
    return `<div class="tooltip-line">${disabled ? "click to enable" : "click to disable"}</div>`;
  }
  const combinedIcon = combinedIconUrl
    ? `<img class="tooltip-mode-icon" src="${combinedIconUrl}" alt="" />`
    : "";
  const singleIcon = singleIconUrl
    ? `<img class="tooltip-mode-icon" src="${singleIconUrl}" alt="" />`
    : "";
  return `<div class="tooltip-line">select combined ${combinedIcon} or single ${singleIcon} mode</div>`;
}

/** Navbox / tip label for cone height. Ground cells use proof altitude (same as airborne). */
export function formatMinimumAltLabel({ minAlt, proofAlt, onGround }) {
  if (onGround && Number.isFinite(proofAlt)) {
    return `${Math.round(proofAlt)} m`;
  }
  if (minAlt !== null && Number.isFinite(minAlt)) {
    return `${Math.round(minAlt)} m`;
  }
  return "—";
}

export function formatHoverTip(
  cell,
  {
    groundClearance,
    debugMode,
    metrics,
    glideRatio = 20,
    proofAlt = null,
  } = {}
) {
  const minAltVal = cell.alt;
  const onGround = Boolean(cell.isGround && Number.isFinite(proofAlt));
  const displayMinAlt = onGround ? proofAlt : minAltVal;
  const minAlt =
    displayMinAlt !== null && Number.isFinite(displayMinAlt)
      ? tooltipNum(Math.round(displayMinAlt))
      : "—";
  const groundElev = tooltipNum(Math.round(cell.groundElev));

  let aboveGroundLine = "—";
  const heightRef = onGround ? proofAlt : minAltVal;
  if (Number.isFinite(heightRef)) {
    const aboveGround = Math.round(heightRef - cell.groundElev);
    const warn = aboveGround < 1.2 * groundClearance;
    aboveGroundLine = tooltipNum(aboveGround, { warn });
  }

  const pathLengthLine =
    metrics !== null ? formatDistanceKm(metrics.distanceM) : "—";
  const requiredLine =
    metrics !== null ? tooltipNum(Math.round(metrics.requiredAlt)) : "—";

  let deltaLine = "—";
  if (Number.isFinite(heightRef) && metrics !== null) {
    const delta = Math.round(heightRef - metrics.requiredAlt);
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

  const lines = [
    `minimum alt: ${minAlt}`,
    `ground elevation: ${groundElev}`,
    `above ground: ${aboveGroundLine}`,
  ];

  if (debugMode) {
    const cellIj =
      cell.gi != null && cell.gj != null ? `${cell.gi}, ${cell.gj}` : "—";
    const originIj =
      cell.originGi != null && cell.originGj != null
        ? `${cell.originGi}, ${cell.originGj}`
        : "—";
    lines.push(
      "",
      `cell i, j: ${cellIj}`,
      `origin i, j: ${originIj}`,
      `path length: ${pathLengthLine}`,
      `required alt: ${requiredLine}`,
      `delta: ${deltaLine}`,
      `max segment L/D: ${maxSegmentLdLine}`
    );
  }

  return lines
    .map((line) =>
      line === ""
        ? `<div class="tooltip-line tooltip-line--gap" aria-hidden="true"></div>`
        : `<div class="tooltip-line">${line}</div>`
    )
    .join("");
}
