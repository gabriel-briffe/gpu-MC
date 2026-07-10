use std::collections::HashMap;

use wasm_bindgen::prelude::*;

const MAX_GRID_CELLS: usize = 450_000;
const IDW_NEIGHBORS: usize = 8;
const IDW_POWER: f64 = 2.0;
const IDW_SEARCH_RADIUS_FACTOR: f64 = 1.75;
const INVALID_INDEX: u32 = 0xffff_ffff;
const SCAN_MODE: u32 = 0x40;

struct Bounds {
    min_lon: f64,
    max_lon: f64,
    min_lat: f64,
    max_lat: f64,
}

struct GridDims {
    ni: usize,
    nj: usize,
    di: f64,
    dj: f64,
}

#[derive(Clone, Copy)]
struct Candidate {
    p: usize,
    dist2: f64,
}

fn compute_bounds(lats: &[f32], lons: &[f32]) -> Result<Bounds, String> {
    let mut min_lon = f64::INFINITY;
    let mut max_lon = f64::NEG_INFINITY;
    let mut min_lat = f64::INFINITY;
    let mut max_lat = f64::NEG_INFINITY;

    for i in 0..lats.len() {
        let lat = f64::from(lats[i]);
        let lon = f64::from(lons[i]);
        if !lat.is_finite() || !lon.is_finite() {
            continue;
        }
        min_lon = min_lon.min(lon);
        max_lon = max_lon.max(lon);
        min_lat = min_lat.min(lat);
        max_lat = max_lat.max(lat);
    }

    if !min_lon.is_finite() {
        return Err("Cannot regrid: no valid source coordinates".into());
    }

    Ok(Bounds {
        min_lon,
        max_lon,
        min_lat,
        max_lat,
    })
}

fn grid_dimensions(bounds: &Bounds, spacing_deg: f64) -> GridDims {
    let mut ni = ((bounds.max_lon - bounds.min_lon) / spacing_deg)
        .round()
        .max(1.0) as usize
        + 1;
    let mut nj = ((bounds.max_lat - bounds.min_lat) / spacing_deg)
        .round()
        .max(1.0) as usize
        + 1;
    ni = ni.max(2);
    nj = nj.max(2);

    if ni * nj > MAX_GRID_CELLS {
        let scale = ((ni * nj) as f64 / MAX_GRID_CELLS as f64).sqrt();
        ni = ((ni as f64 / scale).round() as usize).max(2);
        nj = ((nj as f64 / scale).round() as usize).max(2);
    }

    let di = (bounds.max_lon - bounds.min_lon) / (ni - 1) as f64;
    let dj = (bounds.max_lat - bounds.min_lat) / (nj - 1) as f64;

    GridDims { ni, nj, di, dj }
}

fn build_spatial_index(lats: &[f32], lons: &[f32], bucket_size: f64) -> HashMap<(i32, i32), Vec<usize>> {
    let mut buckets = HashMap::new();

    for p in 0..lats.len() {
        let lat = f64::from(lats[p]);
        let lon = f64::from(lons[p]);
        if !lat.is_finite() || !lon.is_finite() {
            continue;
        }
        let bx = (lon / bucket_size).floor() as i32;
        let by = (lat / bucket_size).floor() as i32;
        buckets.entry((bx, by)).or_insert_with(Vec::new).push(p);
    }

    buckets
}

fn idw_neighbors_at(
    lon: f64,
    lat: f64,
    lats: &[f32],
    lons: &[f32],
    buckets: &HashMap<(i32, i32), Vec<usize>>,
    bucket_size: f64,
    max_dist_deg: f64,
) -> Vec<Candidate> {
    let max_dist2 = max_dist_deg * max_dist_deg;
    let bx = (lon / bucket_size).floor() as i32;
    let by = (lat / bucket_size).floor() as i32;
    let mut candidates = Vec::new();

    for dy in -2..=2 {
        for dx in -2..=2 {
            let Some(bucket) = buckets.get(&(bx + dx, by + dy)) else {
                continue;
            };
            for &p in bucket {
                let d_lon = f64::from(lons[p]) - lon;
                let d_lat = f64::from(lats[p]) - lat;
                let dist2 = d_lon * d_lon + d_lat * d_lat;
                if dist2 > max_dist2 {
                    continue;
                }
                candidates.push(Candidate { p, dist2 });
            }
        }
    }

    if candidates.is_empty() {
        return candidates;
    }

    candidates.sort_by(|a, b| {
        a.dist2
            .partial_cmp(&b.dist2)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.truncate(IDW_NEIGHBORS);
    candidates
}

fn store_cell_weights(
    indices: &mut [u32],
    weights: &mut [f32],
    cell_offset: usize,
    neighbors: &[Candidate],
) {
    for slot in 0..IDW_NEIGHBORS {
        indices[cell_offset + slot] = INVALID_INDEX;
        weights[cell_offset + slot] = 0.0;
    }

    if neighbors.is_empty() {
        return;
    }

    if neighbors[0].dist2 < 1e-14 {
        indices[cell_offset] = neighbors[0].p as u32;
        weights[cell_offset] = 1.0;
        return;
    }

    let mut weight_sum = 0.0;
    for (n, neighbor) in neighbors.iter().enumerate() {
        let weight = 1.0 / neighbor.dist2.sqrt().powf(IDW_POWER);
        indices[cell_offset + n] = neighbor.p as u32;
        weights[cell_offset + n] = weight as f32;
        weight_sum += weight;
    }

    if weight_sum <= 0.0 {
        return;
    }

    for n in 0..neighbors.len() {
        weights[cell_offset + n] = (f64::from(weights[cell_offset + n]) / weight_sum) as f32;
    }
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

#[wasm_bindgen]
pub fn build_idw_weight_table(
    lats: &[f32],
    lons: &[f32],
    spacing_deg: f32,
) -> Result<IdwWeightTableResult, JsValue> {
    if lats.len() != lons.len() {
        return Err(JsValue::from_str("lats and lons must have the same length"));
    }

    let bounds = compute_bounds(lats, lons).map_err(|e| JsValue::from_str(&e))?;
    let spacing = f64::from(spacing_deg);
    let GridDims { ni, nj, di, dj } = grid_dimensions(&bounds, spacing);
    let bucket_size = di.max(dj);
    let max_dist_deg = bucket_size * IDW_SEARCH_RADIUS_FACTOR;
    let buckets = build_spatial_index(lats, lons, bucket_size);
    let cell_count = ni * nj;
    let mut indices = vec![INVALID_INDEX; cell_count * IDW_NEIGHBORS];
    let mut weights = vec![0.0f32; cell_count * IDW_NEIGHBORS];

    for j in 0..nj {
        let lat = bounds.min_lat + j as f64 * dj;
        for i in 0..ni {
            let lon = bounds.min_lon + i as f64 * di;
            let cell_offset = (j * ni + i) * IDW_NEIGHBORS;
            let neighbors = idw_neighbors_at(lon, lat, lats, lons, &buckets, bucket_size, max_dist_deg);
            store_cell_weights(&mut indices, &mut weights, cell_offset, &neighbors);
        }
    }

    Ok(IdwWeightTableResult {
        ni: ni as u32,
        nj: nj as u32,
        cell_count: cell_count as u32,
        neighbor_count: IDW_NEIGHBORS as u32,
        la1_deg: bounds.min_lat,
        lo1_deg: bounds.min_lon,
        la2_deg: bounds.max_lat,
        lo2_deg: bounds.max_lon,
        di_deg: di,
        dj_deg: dj,
        scan_mode: SCAN_MODE,
        indices,
        weights,
    })
}

#[wasm_bindgen]
pub fn apply_idw_weight_table(
    indices: &[u32],
    weights: &[f32],
    values: &[f32],
    neighbor_count: u32,
) -> Result<Vec<f32>, JsValue> {
    let neighbor_count = neighbor_count as usize;
    if neighbor_count == 0 {
        return Err(JsValue::from_str("neighbor_count must be > 0"));
    }
    if indices.len() % neighbor_count != 0 {
        return Err(JsValue::from_str("indices length must be a multiple of neighbor_count"));
    }
    if weights.len() != indices.len() {
        return Err(JsValue::from_str("weights length must match indices"));
    }

    let cell_count = indices.len() / neighbor_count;
    let mut out = vec![f32::NAN; cell_count];

    for k in 0..cell_count {
        let base = k * neighbor_count;
        let mut value_sum = 0.0f64;
        let mut weight_sum = 0.0f64;

        for n in 0..neighbor_count {
            let p = indices[base + n];
            if p == INVALID_INDEX {
                continue;
            }
            let weight = f64::from(weights[base + n]);
            if weight <= 0.0 {
                continue;
            }
            let p = p as usize;
            if p >= values.len() {
                continue;
            }
            let value = f64::from(values[p]);
            if !value.is_finite() {
                continue;
            }
            value_sum += weight * value;
            weight_sum += weight;
        }

        if weight_sum > 0.0 {
            out[k] = (value_sum / weight_sum) as f32;
        }
    }

    Ok(out)
}
