export function parseVizMode(vizModeValue, debugMode) {
  let mode = vizModeValue ?? "contours";
  if (!debugMode && (mode === "stripes" || mode === "raw" || mode === "modified-cells")) {
    mode = "contours";
  }
  return {
    mode,
    pathOnly: mode === "path-only",
    sectors: mode === "sectors" || mode === "contours-sectors",
    raw: mode === "raw",
    contours: mode === "contours" || mode === "contours-sectors",
    showModifiedCells: mode === "modified-cells",
  };
}
