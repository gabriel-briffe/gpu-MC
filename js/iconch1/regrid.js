import initIdwRegrid, {
  build_sector_geojson_from_field_grib as wasmBuildSectorGeojsonFromFieldGrib,
  clear_idw_weight_table as wasmClearIdwWeightTable,
  install_idw_weight_table as wasmInstallIdwWeightTable,
} from "./pkg/idw-regrid/idw_regrid.js";
import { assetUrl } from "../asset-url.js";

let wasmInitPromise = null;
let wasmReady = false;
let pipelineInstalled = false;

export function isIdwPipelineInstalled() {
  return pipelineInstalled;
}

export async function ensureRegridWasm() {
  if (!wasmInitPromise) {
    wasmInitPromise = initIdwRegrid({
      module_or_path: assetUrl("vendor/idw-regrid/idw_regrid_bg.wasm"),
    });
  }
  await wasmInitPromise;
  wasmReady = true;
}

export async function buildIdwWeightTable(lats, lons, spacingDeg) {
  await ensureRegridWasm();
  const result = wasmInstallIdwWeightTable(lats, lons, spacingDeg);
  pipelineInstalled = true;
  const meta = {
    ni: result.ni,
    nj: result.nj,
    cellCount: result.cell_count,
    neighborCount: result.neighbor_count,
    la1_deg: result.la1_deg,
    lo1_deg: result.lo1_deg,
    la2_deg: result.la2_deg,
    lo2_deg: result.lo2_deg,
    di_deg: result.di_deg,
    dj_deg: result.dj_deg,
    scan_mode: result.scan_mode,
    spacingDeg: result.spacing_deg,
    pipeline: true,
  };
  result.free();
  return meta;
}

export function buildSectorGeoJsonFromFieldGrib(fieldGrib) {
  return JSON.parse(wasmBuildSectorGeojsonFromFieldGrib(fieldGrib));
}

export function clearIdwPipeline() {
  pipelineInstalled = false;
  if (wasmReady) {
    wasmClearIdwWeightTable();
  }
}

export function invalidateIdwWeightTable(grid) {
  if (grid?.idwWeightTable) {
    delete grid.idwWeightTable;
  }
}
