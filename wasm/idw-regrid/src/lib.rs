use wasm_bindgen::prelude::*;

mod contours;
mod idw;
mod pipeline;
mod state;

use idw::{build_weight_table, apply_weight_table, StoredWeightTable};

fn js_err(error: String) -> JsValue {
    JsValue::from_str(&error)
}

#[wasm_bindgen]
pub struct IdwWeightTableResult {
    ni: u32,
    nj: u32,
    cell_count: u32,
    neighbor_count: u32,
    la1_deg: f64,
    lo1_deg: f64,
    la2_deg: f64,
    lo2_deg: f64,
    di_deg: f64,
    dj_deg: f64,
    scan_mode: u32,
    indices: Vec<u32>,
    weights: Vec<f32>,
}

#[wasm_bindgen]
pub struct IdwGridInstallResult {
    spacing_deg: f32,
    ni: u32,
    nj: u32,
    cell_count: u32,
    neighbor_count: u32,
    la1_deg: f64,
    lo1_deg: f64,
    la2_deg: f64,
    lo2_deg: f64,
    di_deg: f64,
    dj_deg: f64,
    scan_mode: u32,
}

#[wasm_bindgen]
impl IdwGridInstallResult {
    #[wasm_bindgen(getter)]
    pub fn spacing_deg(&self) -> f32 {
        self.spacing_deg
    }

    #[wasm_bindgen(getter)]
    pub fn ni(&self) -> u32 {
        self.ni
    }

    #[wasm_bindgen(getter)]
    pub fn nj(&self) -> u32 {
        self.nj
    }

    #[wasm_bindgen(getter)]
    pub fn cell_count(&self) -> u32 {
        self.cell_count
    }

    #[wasm_bindgen(getter)]
    pub fn neighbor_count(&self) -> u32 {
        self.neighbor_count
    }

    #[wasm_bindgen(getter)]
    pub fn la1_deg(&self) -> f64 {
        self.la1_deg
    }

    #[wasm_bindgen(getter)]
    pub fn lo1_deg(&self) -> f64 {
        self.lo1_deg
    }

    #[wasm_bindgen(getter)]
    pub fn la2_deg(&self) -> f64 {
        self.la2_deg
    }

    #[wasm_bindgen(getter)]
    pub fn lo2_deg(&self) -> f64 {
        self.lo2_deg
    }

    #[wasm_bindgen(getter)]
    pub fn di_deg(&self) -> f64 {
        self.di_deg
    }

    #[wasm_bindgen(getter)]
    pub fn dj_deg(&self) -> f64 {
        self.dj_deg
    }

    #[wasm_bindgen(getter)]
    pub fn scan_mode(&self) -> u32 {
        self.scan_mode
    }
}

#[wasm_bindgen]
impl IdwWeightTableResult {
    #[wasm_bindgen(getter)]
    pub fn ni(&self) -> u32 {
        self.ni
    }

    #[wasm_bindgen(getter)]
    pub fn nj(&self) -> u32 {
        self.nj
    }

    #[wasm_bindgen(getter)]
    pub fn cell_count(&self) -> u32 {
        self.cell_count
    }

    #[wasm_bindgen(getter)]
    pub fn neighbor_count(&self) -> u32 {
        self.neighbor_count
    }

    #[wasm_bindgen(getter)]
    pub fn la1_deg(&self) -> f64 {
        self.la1_deg
    }

    #[wasm_bindgen(getter)]
    pub fn lo1_deg(&self) -> f64 {
        self.lo1_deg
    }

    #[wasm_bindgen(getter)]
    pub fn la2_deg(&self) -> f64 {
        self.la2_deg
    }

    #[wasm_bindgen(getter)]
    pub fn lo2_deg(&self) -> f64 {
        self.lo2_deg
    }

    #[wasm_bindgen(getter)]
    pub fn di_deg(&self) -> f64 {
        self.di_deg
    }

    #[wasm_bindgen(getter)]
    pub fn dj_deg(&self) -> f64 {
        self.dj_deg
    }

    #[wasm_bindgen(getter)]
    pub fn scan_mode(&self) -> u32 {
        self.scan_mode
    }

    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<u32> {
        self.indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn weights(&self) -> Vec<f32> {
        self.weights.clone()
    }
}

fn table_to_result(table: StoredWeightTable) -> IdwWeightTableResult {
    IdwWeightTableResult {
        ni: table.ni,
        nj: table.nj,
        cell_count: table.cell_count,
        neighbor_count: table.neighbor_count,
        la1_deg: table.la1_deg,
        lo1_deg: table.lo1_deg,
        la2_deg: table.la2_deg,
        lo2_deg: table.lo2_deg,
        di_deg: table.di_deg,
        dj_deg: table.dj_deg,
        scan_mode: table.scan_mode,
        indices: table.indices,
        weights: table.weights,
    }
}

fn table_to_install_result(table: &StoredWeightTable) -> IdwGridInstallResult {
    IdwGridInstallResult {
        spacing_deg: table.spacing_deg,
        ni: table.ni,
        nj: table.nj,
        cell_count: table.cell_count,
        neighbor_count: table.neighbor_count,
        la1_deg: table.la1_deg,
        lo1_deg: table.lo1_deg,
        la2_deg: table.la2_deg,
        lo2_deg: table.lo2_deg,
        di_deg: table.di_deg,
        dj_deg: table.dj_deg,
        scan_mode: table.scan_mode,
    }
}

#[wasm_bindgen]
pub fn install_idw_weight_table(
    lats: &[f32],
    lons: &[f32],
    spacing_deg: f32,
) -> Result<IdwGridInstallResult, JsValue> {
    pipeline::install_idw_grid(lats, lons, spacing_deg).map_err(js_err)?;
    state::with_installed_table(|table| Ok(table_to_install_result(table)))
        .map_err(js_err)
}

#[wasm_bindgen]
pub fn build_sector_geojson_from_field_grib(field_grib: &[u8]) -> Result<String, JsValue> {
    pipeline::build_sector_geojson_from_field_grib(field_grib).map_err(js_err)
}

#[wasm_bindgen]
pub fn build_sector_geojson_from_values(values: &[f32]) -> Result<String, JsValue> {
    pipeline::build_sector_geojson_from_values(values).map_err(js_err)
}

#[wasm_bindgen]
pub fn clear_idw_weight_table() {
    state::clear_weight_table();
}

#[wasm_bindgen]
pub fn build_idw_weight_table(
    lats: &[f32],
    lons: &[f32],
    spacing_deg: f32,
) -> Result<IdwWeightTableResult, JsValue> {
    build_weight_table(lats, lons, spacing_deg)
        .map(table_to_result)
        .map_err(js_err)
}

#[wasm_bindgen]
pub fn apply_idw_weight_table(
    indices: &[u32],
    weights: &[f32],
    values: &[f32],
    neighbor_count: u32,
) -> Result<Vec<f32>, JsValue> {
    let table = StoredWeightTable {
        spacing_deg: 0.0,
        ni: 0,
        nj: 0,
        cell_count: (indices.len() / neighbor_count as usize) as u32,
        neighbor_count,
        la1_deg: 0.0,
        lo1_deg: 0.0,
        la2_deg: 0.0,
        lo2_deg: 0.0,
        di_deg: 0.0,
        dj_deg: 0.0,
        scan_mode: idw::SCAN_MODE,
        indices: indices.to_vec(),
        weights: weights.to_vec(),
    };
    apply_weight_table(&table, values).map_err(js_err)
}

#[wasm_bindgen]
pub fn build_sector_geojson_json(
    ni: u32,
    nj: u32,
    la1_deg: f64,
    lo1_deg: f64,
    la2_deg: f64,
    lo2_deg: f64,
    di_deg: f64,
    dj_deg: f64,
    scan_mode: u32,
    values: &[f32],
) -> Result<String, JsValue> {
    contours::build_sector_geojson_json(
        ni,
        nj,
        la1_deg,
        lo1_deg,
        la2_deg,
        lo2_deg,
        di_deg,
        dj_deg,
        scan_mode,
        values,
    )
    .map_err(js_err)
}
