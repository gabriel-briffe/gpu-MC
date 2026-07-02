import { clampTerrainZoom } from "../geo.js";
import { DEFAULT_MAX_ALTITUDE } from "../constants.js";
import { dom } from "../dom.js";
import { isDebugMode, parseVizMode } from "../params/panel.js";
import { getPeekLosGeoAnchor } from "../debug/peek-los.js";

export function getGlideParams() {
  const glideRatio = Number.parseFloat(document.getElementById("ld").value);
  const circuitHeight = Number.parseFloat(document.getElementById("circuit").value);
  const groundClearance = Number.parseFloat(document.getElementById("clearance").value);
  const maxAltitude = Number.parseFloat(document.getElementById("max-alt").value);
  const originRunN = isDebugMode()
    ? Number.parseInt(document.getElementById("los-run").value, 10)
    : 0;
  const terrainZoom = clampTerrainZoom(
    Number.parseInt(document.getElementById("terrain-zoom")?.value ?? "", 10)
  );
  const includeAirspace = dom.includeAirspaceInput?.checked ?? false;
  const updateMapMs = Number.parseInt(document.getElementById("update-map").value, 10);
  const disableGroundOrigin =
    isDebugMode() && (dom.disableGroundOriginInput?.checked ?? false);
  const peekLos = isDebugMode() && (dom.peekLosInput?.checked ?? false);
  const peekLosI = Number.parseInt(dom.peekLosIInput?.value ?? "", 10);
  const peekLosJ = Number.parseInt(dom.peekLosJInput?.value ?? "", 10);
  const peekLosOi = Number.parseInt(dom.peekLosOiInput?.value ?? "", 10);
  const peekLosOj = Number.parseInt(dom.peekLosOjInput?.value ?? "", 10);
  const { raw, contours, pathOnly, sectors } = parseVizMode();

  return {
    glideRatio: Number.isFinite(glideRatio) && glideRatio > 0 ? glideRatio : 20,
    circuitHeight: Number.isFinite(circuitHeight) && circuitHeight >= 0 ? circuitHeight : 250,
    groundClearance:
      Number.isFinite(groundClearance) && groundClearance >= 0 ? groundClearance : 100,
    maxAltitude:
      Number.isFinite(maxAltitude) && maxAltitude > 0 ? maxAltitude : DEFAULT_MAX_ALTITUDE,
    terrainZoom,
    includeAirspace,
    originRunN:
      Number.isFinite(originRunN) && originRunN === 0
        ? 0
        : Number.isFinite(originRunN) && originRunN >= 1
          ? originRunN
          : 0,
    raw,
    contours,
    pathOnly,
    sectors,
    disableGroundOrigin,
    peekLos,
    peekLosI: Number.isFinite(peekLosI) ? peekLosI : null,
    peekLosJ: Number.isFinite(peekLosJ) ? peekLosJ : null,
    peekLosOi: Number.isFinite(peekLosOi) ? peekLosOi : null,
    peekLosOj: Number.isFinite(peekLosOj) ? peekLosOj : null,
    peekLosGeoAnchor: getPeekLosGeoAnchor(),
    updateMapMs:
      Number.isFinite(updateMapMs) && updateMapMs >= 0 ? updateMapMs : 100,
  };
}
