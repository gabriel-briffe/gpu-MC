export function parseVizMode(vizModeValue, debugMode) {
  let mode = vizModeValue ?? "contours";
  if (!debugMode && (mode === "stripes" || mode === "raw" || mode === "modified-cells")) {
    mode = "contours";
  }
  return {
    mode,
    pathOnly: mode === "path-only",
    sectors: mode === "sectors",
    raw: mode === "raw",
    contours: mode === "contours",
    showModifiedCells: mode === "modified-cells",
  };
}
