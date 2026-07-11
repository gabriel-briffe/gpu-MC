use bzip2_rs::DecoderReader;
use rust_aec::{flags_from_grib2_ccsds_flags, AecParams};
use serde::Serialize;
use std::io::Read;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct GribInfo {
    edition: u8,
    total_length: u64,
    discipline: u8,
    discipline_name: String,
    product_category: Option<u8>,
    product_number: Option<u8>,
    parameter_name: String,
    grid_template: Option<u16>,
    grid_name: Option<String>,
    ni: Option<u32>,
    nj: Option<u32>,
    resolution_deg_x: Option<f64>,
    resolution_deg_y: Option<f64>,
}

#[derive(Serialize)]
struct IconGridCorners {
    top_left_lat: f64,
    top_left_lon: f64,
    bottom_right_lat: f64,
    bottom_right_lon: f64,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    points: usize,
}

#[derive(Serialize)]
struct IconCell {
    index: usize,
    lat: f64,
    lon: f64,
    value: f64,
}

#[derive(Serialize)]
struct IconMatrixSummary {
    grid_kind: String,
    points: usize,
    matrix_rows: usize,
    matrix_cols: usize,
    top_left_cell: IconCell,
    bottom_right_cell: IconCell,
}

#[derive(Serialize)]
struct RegularLatLonFieldData {
    ni: usize,
    nj: usize,
    la1_deg: f64,
    lo1_deg: f64,
    la2_deg: f64,
    lo2_deg: f64,
    di_deg: f64,
    dj_deg: f64,
    scan_mode: u8,
    values: Vec<f64>,
}

#[derive(Serialize)]
struct RegularGridMeta {
    ni: u32,
    nj: u32,
    la1_deg: f64,
    lo1_deg: f64,
    di_deg: f64,
    dj_deg: f64,
    scan_mode: u8,
}

#[wasm_bindgen]
pub fn parse_grib2_bz2(bytes: &[u8]) -> Result<JsValue, JsValue> {
    let grib = decompress_if_needed(bytes)?;
    let info = parse_grib2(&grib)?;
    serde_wasm_bindgen::to_value(&info)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize metadata: {e}")))
}

#[wasm_bindgen]
pub fn parse_grib2_raw(bytes: &[u8]) -> Result<JsValue, JsValue> {
    let info = parse_grib2(bytes)?;
    serde_wasm_bindgen::to_value(&info)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize metadata: {e}")))
}

#[wasm_bindgen]
pub fn icon_corners_from_clat_clon(clat_grib: &[u8], clon_grib: &[u8]) -> Result<JsValue, JsValue> {
    let clat_values = decode_grib2_values(clat_grib)?;
    let clon_values = decode_grib2_values(clon_grib)?;

    if clat_values.len() != clon_values.len() {
        return Err(JsValue::from_str("CLAT/CLON point count mismatch"));
    }
    if clat_values.is_empty() {
        return Err(JsValue::from_str("CLAT/CLON arrays are empty"));
    }

    let mut min_lat = f64::INFINITY;
    let mut max_lat = f64::NEG_INFINITY;
    let mut min_lon = f64::INFINITY;
    let mut max_lon = f64::NEG_INFINITY;

    for (&lat, &lon) in clat_values.iter().zip(clon_values.iter()) {
        min_lat = min_lat.min(lat);
        max_lat = max_lat.max(lat);
        min_lon = min_lon.min(lon);
        max_lon = max_lon.max(lon);
    }

    let corners = IconGridCorners {
        top_left_lat: max_lat,
        top_left_lon: min_lon,
        bottom_right_lat: min_lat,
        bottom_right_lon: max_lon,
        min_lat,
        max_lat,
        min_lon,
        max_lon,
        points: clat_values.len(),
    };

    serde_wasm_bindgen::to_value(&corners)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize corners: {e}")))
}

#[wasm_bindgen]
pub fn regular_latlon_matrix_summary(field_grib: &[u8]) -> Result<JsValue, JsValue> {
    let grid = parse_latlon_grid(field_grib)?;
    let field_values = decode_grib2_values(field_grib)?;

    let ni = grid.ni as usize;
    let nj = grid.nj as usize;
    let n = ni
        .checked_mul(nj)
        .ok_or_else(|| JsValue::from_str("Grid dimensions overflow"))?;
    if field_values.len() != n {
        return Err(JsValue::from_str(&format!(
            "Decoded field length {} does not match Ni*Nj={}",
            field_values.len(),
            n
        )));
    }

    let top_idx;
    let bottom_idx;
    {
        let (nw, se) = geographic_nw_se_indices(&grid);
        top_idx = nw;
        bottom_idx = se;
    }
    let (top_lat, top_lon) = cell_latlon(top_idx, &grid);
    let (bottom_lat, bottom_lon) = cell_latlon(bottom_idx, &grid);

    let summary = IconMatrixSummary {
        grid_kind: "Regular lat/lon grid (template 3.0, north-up: row 0 is south)".to_string(),
        points: n,
        matrix_rows: nj,
        matrix_cols: ni,
        top_left_cell: IconCell {
            index: top_idx,
            lat: top_lat,
            lon: top_lon,
            value: field_values[top_idx],
        },
        bottom_right_cell: IconCell {
            index: bottom_idx,
            lat: bottom_lat,
            lon: bottom_lon,
            value: field_values[bottom_idx],
        },
    };

    serde_wasm_bindgen::to_value(&summary)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize matrix summary: {e}")))
}

#[wasm_bindgen]
pub fn regular_latlon_field_data(field_grib: &[u8]) -> Result<JsValue, JsValue> {
    let grid = parse_latlon_grid(field_grib)?;
    let values = decode_grib2_values(field_grib)?;
    let ni = grid.ni as usize;
    let nj = grid.nj as usize;
    let n = ni
        .checked_mul(nj)
        .ok_or_else(|| JsValue::from_str("Grid dimensions overflow"))?;
    if values.len() != n {
        return Err(JsValue::from_str(&format!(
            "Decoded field length {} does not match Ni*Nj={}",
            values.len(),
            n
        )));
    }

    let payload = RegularLatLonFieldData {
        ni,
        nj,
        la1_deg: grid.la1_deg,
        lo1_deg: normalize_lon_deg(grid.lo1_deg),
        la2_deg: grid.la2_deg,
        lo2_deg: normalize_lon_deg(grid.lo2_deg),
        di_deg: grid.di_deg,
        dj_deg: grid.dj_deg,
        scan_mode: grid.scan_mode,
        values,
    };

    serde_wasm_bindgen::to_value(&payload)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize field payload: {e}")))
}

#[wasm_bindgen]
pub fn regular_latlon_grid_meta(field_grib: &[u8]) -> Result<JsValue, JsValue> {
    let grid = parse_latlon_grid(field_grib)?;
    let meta = RegularGridMeta {
        ni: grid.ni,
        nj: grid.nj,
        la1_deg: grid.la1_deg,
        lo1_deg: grid.lo1_deg,
        di_deg: grid.di_deg,
        dj_deg: grid.dj_deg,
        scan_mode: grid.scan_mode,
    };
    serde_wasm_bindgen::to_value(&meta)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize grid meta: {e}")))
}

pub fn decode_field_values_f32(field_grib: &[u8]) -> Result<Vec<f32>, String> {
    decode_grib2_values(field_grib)
        .map_err(|error| {
            error
                .as_string()
                .unwrap_or_else(|| "GRIB decode failed".to_string())
        })
        .map(|values| values.into_iter().map(|value| value as f32).collect())
}

#[wasm_bindgen]
pub fn decode_template42_values_f32(field_grib: &[u8]) -> Result<Vec<f32>, JsValue> {
    let values = decode_grib2_values(field_grib)?;
    Ok(values.into_iter().map(|v| v as f32).collect())
}

#[wasm_bindgen]
pub fn grib2_message_level(msg: &[u8]) -> Result<u16, JsValue> {
    let section = grib2_section(msg, 4)?;
    if section.len() <= 27 {
        return Err(JsValue::from_str("Section 4 too short for level"));
    }
    Ok(u16::from(section[27]))
}

#[wasm_bindgen]
pub fn icon_matrix_summary(
    field_grib: &[u8],
    clat_grib: &[u8],
    clon_grib: &[u8],
) -> Result<JsValue, JsValue> {
    let field_values = decode_grib2_values(field_grib)?;
    let clat_values = decode_grib2_values(clat_grib)?;
    let clon_values = decode_grib2_values(clon_grib)?;

    let n = field_values.len();
    if n == 0 {
        return Err(JsValue::from_str("Decoded field has zero points"));
    }
    if clat_values.len() != n || clon_values.len() != n {
        return Err(JsValue::from_str("Field/CLAT/CLON point count mismatch"));
    }

    let mut nw_idx = 0usize;
    let mut se_idx = 0usize;
    for i in 1..n {
        let lat = clat_values[i];
        let lon = clon_values[i];

        let nw_lat = clat_values[nw_idx];
        let nw_lon = clon_values[nw_idx];
        if lat > nw_lat || (lat == nw_lat && lon < nw_lon) {
            nw_idx = i;
        }

        let se_lat = clat_values[se_idx];
        let se_lon = clon_values[se_idx];
        if lat < se_lat || (lat == se_lat && lon > se_lon) {
            se_idx = i;
        }
    }

    let summary = IconMatrixSummary {
        grid_kind: "ICON unstructured grid (template 3.101)".to_string(),
        points: n,
        matrix_rows: n,
        matrix_cols: 1,
        top_left_cell: IconCell {
            index: nw_idx,
            lat: clat_values[nw_idx],
            lon: clon_values[nw_idx],
            value: field_values[nw_idx],
        },
        bottom_right_cell: IconCell {
            index: se_idx,
            lat: clat_values[se_idx],
            lon: clon_values[se_idx],
            value: field_values[se_idx],
        },
    };

    serde_wasm_bindgen::to_value(&summary)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize matrix summary: {e}")))
}

fn decompress_if_needed(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    if bytes.len() >= 4 && &bytes[0..4] == b"GRIB" {
        return Ok(bytes.to_vec());
    }

    if bytes.len() >= 3 && &bytes[0..3] == b"BZh" {
        let mut decoder = DecoderReader::new(bytes);
        let mut grib = Vec::new();
        decoder
            .read_to_end(&mut grib)
            .map_err(|e| JsValue::from_str(&format!("Failed to decompress bz2: {e}")))?;
        if grib.len() >= 4 && &grib[0..4] == b"GRIB" {
            return Ok(grib);
        }
        return Err(JsValue::from_str(
            "Decompressed bz2 data does not contain a GRIB header",
        ));
    }

    Err(JsValue::from_str(
        "Unsupported file: expected GRIB2 data or bzip2-compressed .grib2.bz2 (BZh header)",
    ))
}

struct LatLonGrid {
    ni: u32,
    nj: u32,
    la1_deg: f64,
    lo1_deg: f64,
    la2_deg: f64,
    lo2_deg: f64,
    di_deg: f64,
    dj_deg: f64,
    scan_mode: u8,
}

fn parse_latlon_grid(bytes: &[u8]) -> Result<LatLonGrid, JsValue> {
    if bytes.len() < 20 || &bytes[0..4] != b"GRIB" || bytes[7] != 2 {
        return Err(JsValue::from_str("Expected a raw GRIB2 message"));
    }

    let mut pos = 16usize;
    while pos + 5 <= bytes.len() {
        if pos + 4 <= bytes.len() && &bytes[pos..pos + 4] == b"7777" {
            break;
        }
        let section_len = be_u32(bytes, pos)? as usize;
        if section_len < 5 || pos + section_len > bytes.len() {
            return Err(JsValue::from_str("Invalid GRIB section length"));
        }
        let section_num = bytes[pos + 4];
        let section = &bytes[pos..pos + section_len];

        if section_num == 3 {
            if section.len() < 72 {
                return Err(JsValue::from_str("Section 3 too short for template 3.0"));
            }
            let tmpl = be_u16(section, 12)?;
            if tmpl != 0 {
                return Err(JsValue::from_str(&format!(
                    "Unsupported grid template: {tmpl} (expected 0)"
                )));
            }

            let scale = latlon_scale(section);
            return Ok(LatLonGrid {
                ni: be_u32(section, 30)?,
                nj: be_u32(section, 34)?,
                la1_deg: f64::from(be_i32(section, 46)?) * scale,
                lo1_deg: f64::from(be_i32(section, 50)?) * scale,
                la2_deg: f64::from(be_i32(section, 55)?) * scale,
                lo2_deg: f64::from(be_i32(section, 59)?) * scale,
                di_deg: f64::from(be_u32(section, 63)?) * scale,
                dj_deg: f64::from(be_u32(section, 67)?) * scale,
                scan_mode: section[71],
            });
        }

        pos += section_len;
    }

    Err(JsValue::from_str("Missing Section 3 grid definition"))
}

fn latlon_scale(section: &[u8]) -> f64 {
    let basic_angle = be_u32(section, 38).unwrap_or(0);
    let subdivisions = be_u32(section, 42).unwrap_or(0);
    if basic_angle == 0 || subdivisions == 0 {
        1e-6
    } else {
        f64::from(basic_angle) / f64::from(subdivisions)
    }
}

fn normalize_lon_deg(mut lon: f64) -> f64 {
    while lon > 180.0 {
        lon -= 360.0;
    }
    while lon <= -180.0 {
        lon += 360.0;
    }
    lon
}

fn grid_index(i: usize, j: usize, ni: usize, scan_mode: u8) -> usize {
    if (scan_mode & 0x20) != 0 {
        i * ni + j
    } else {
        j * ni + i
    }
}

fn cell_latlon_at_ij(i: usize, j: usize, grid: &LatLonGrid) -> (f64, f64) {
    let i_dir = if grid.scan_mode & 0x80 == 0 { 1.0 } else { -1.0 };
    let j_dir = if grid.scan_mode & 0x40 != 0 { 1.0 } else { -1.0 };
    let lat = grid.la1_deg + j as f64 * grid.dj_deg * j_dir;
    let lon = normalize_lon_deg(grid.lo1_deg + i as f64 * grid.di_deg * i_dir);
    (lat, lon)
}

fn cell_latlon(index: usize, grid: &LatLonGrid) -> (f64, f64) {
    let ni = grid.ni as usize;
    let nj = grid.nj as usize;
    let i = index % ni;
    let j = index / ni;
    if j >= nj {
        return (grid.la1_deg, normalize_lon_deg(grid.lo1_deg));
    }
    cell_latlon_at_ij(i, j, grid)
}

fn geographic_nw_se_indices(grid: &LatLonGrid) -> (usize, usize) {
    let ni = grid.ni as usize;
    let nj = grid.nj as usize;
    let corners = [(0, 0), (ni - 1, 0), (0, nj - 1), (ni - 1, nj - 1)];

    let mut nw_idx = grid_index(0, 0, ni, grid.scan_mode);
    let mut se_idx = nw_idx;
    let (mut nw_lat, mut nw_lon) = cell_latlon_at_ij(0, 0, grid);
    let (mut se_lat, mut se_lon) = (nw_lat, nw_lon);

    for &(i, j) in &corners[1..] {
        let idx = grid_index(i, j, ni, grid.scan_mode);
        let (lat, lon) = cell_latlon_at_ij(i, j, grid);
        if lat > nw_lat || (lat == nw_lat && lon < nw_lon) {
            nw_idx = idx;
            nw_lat = lat;
            nw_lon = lon;
        }
        if lat < se_lat || (lat == se_lat && lon > se_lon) {
            se_idx = idx;
            se_lat = lat;
            se_lon = lon;
        }
    }

    (nw_idx, se_idx)
}

fn parse_grib2(bytes: &[u8]) -> Result<GribInfo, JsValue> {
    if bytes.len() < 16 {
        return Err(JsValue::from_str("File too small to be GRIB2"));
    }
    if &bytes[0..4] != b"GRIB" {
        return Err(JsValue::from_str("Missing GRIB header after decompression"));
    }

    let discipline = bytes[6];
    let edition = bytes[7];
    if edition != 2 {
        return Err(JsValue::from_str(&format!(
            "Unsupported GRIB edition: {edition} (expected 2)"
        )));
    }
    let total_length = be_u64(bytes, 8)?;

    let mut pos = 16usize;
    let mut category: Option<u8> = None;
    let mut number: Option<u8> = None;
    let mut grid_template: Option<u16> = None;
    let mut ni: Option<u32> = None;
    let mut nj: Option<u32> = None;
    let mut resolution_deg_x: Option<f64> = None;
    let mut resolution_deg_y: Option<f64> = None;

    while pos + 5 <= bytes.len() {
        if pos + 4 <= bytes.len() && &bytes[pos..pos + 4] == b"7777" {
            break;
        }

        let section_len = be_u32(bytes, pos)? as usize;
        if section_len < 5 || pos + section_len > bytes.len() {
            return Err(JsValue::from_str("Invalid GRIB section length"));
        }

        let section_num = bytes[pos + 4];
        let section = &bytes[pos..pos + section_len];

        match section_num {
            3 => {
                if section.len() >= 71 {
                    let tmpl = be_u16(section, 12)?;
                    grid_template = Some(tmpl);
                    if tmpl == 0 {
                        let ni_val = be_u32(section, 30)?;
                        let nj_val = be_u32(section, 34)?;
                        ni = Some(ni_val);
                        nj = Some(nj_val);

                        let basic_angle = be_u32(section, 38)?;
                        let subdivisions = be_u32(section, 42)?;
                        let scale = if basic_angle == 0 || subdivisions == 0 {
                            1e-6
                        } else {
                            f64::from(basic_angle) / f64::from(subdivisions)
                        };
                        let di = be_u32(section, 63)?;
                        let dj = be_u32(section, 67)?;
                        resolution_deg_x = Some(f64::from(di) * scale);
                        resolution_deg_y = Some(f64::from(dj) * scale);
                    }
                }
            }
            4 => {
                if section.len() >= 11 {
                    category = Some(section[9]);
                    number = Some(section[10]);
                }
            }
            _ => {}
        }

        pos += section_len;
    }

    Ok(GribInfo {
        edition,
        total_length,
        discipline,
        discipline_name: discipline_name(discipline).to_string(),
        product_category: category,
        product_number: number,
        parameter_name: parameter_name(discipline, category, number).to_string(),
        grid_template,
        grid_name: grid_template.map(grid_template_name).map(str::to_string),
        ni,
        nj,
        resolution_deg_x,
        resolution_deg_y,
    })
}

fn grib2_section(bytes: &[u8], wanted: u8) -> Result<&[u8], JsValue> {
    if bytes.len() < 20 || &bytes[0..4] != b"GRIB" || bytes[7] != 2 {
        return Err(JsValue::from_str("Expected a raw GRIB2 message"));
    }

    let mut pos = 16usize;
    while pos + 5 <= bytes.len() {
        if pos + 4 <= bytes.len() && &bytes[pos..pos + 4] == b"7777" {
            break;
        }
        let section_len = be_u32(bytes, pos)? as usize;
        if section_len < 5 || pos + section_len > bytes.len() {
            return Err(JsValue::from_str("Invalid GRIB section length"));
        }
        if bytes[pos + 4] == wanted {
            return Ok(&bytes[pos..pos + section_len]);
        }
        pos += section_len;
    }

    Err(JsValue::from_str(&format!("Missing GRIB section {wanted}")))
}

fn decode_grib2_values(bytes: &[u8]) -> Result<Vec<f64>, JsValue> {
    if bytes.len() < 20 || &bytes[0..4] != b"GRIB" || bytes[7] != 2 {
        return Err(JsValue::from_str("Expected a raw GRIB2 message"));
    }

    let mut pos = 16usize;
    let mut total_points: Option<usize> = None;
    let mut encoded_points: Option<usize> = None;
    let mut template_number: Option<u16> = None;
    let mut bits_per_value: Option<u8> = None;
    let mut binary_scale_factor: Option<i32> = None;
    let mut decimal_scale_factor: Option<i32> = None;
    let mut reference_value: Option<f32> = None;
    let mut ccsds_flags: Option<u8> = None;
    let mut ccsds_block_size: Option<u32> = None;
    let mut ccsds_rsi: Option<u32> = None;
    let mut bitmap: Option<Vec<u8>> = None;
    let mut section7_payload: Option<&[u8]> = None;

    while pos + 5 <= bytes.len() {
        if pos + 4 <= bytes.len() && &bytes[pos..pos + 4] == b"7777" {
            break;
        }
        let section_len = be_u32(bytes, pos)? as usize;
        if section_len < 5 || pos + section_len > bytes.len() {
            return Err(JsValue::from_str("Invalid GRIB section length"));
        }
        let section_num = bytes[pos + 4];
        let section = &bytes[pos..pos + section_len];

        if section_num == 3 {
            total_points = Some(be_u32(section, 6)? as usize);
        } else if section_num == 5 {
            if section.len() < 21 {
                return Err(JsValue::from_str("Section 5 too short"));
            }
            let tmpl = be_u16(section, 9)?;
            template_number = Some(tmpl);
            encoded_points = Some(be_u32(section, 5)? as usize);
            reference_value = Some(f32::from_bits(be_u32(section, 11)?));
            binary_scale_factor = Some(read_signed_magnitude_i16(be_u16(section, 15)?));
            decimal_scale_factor = Some(read_signed_magnitude_i16(be_u16(section, 17)?));
            bits_per_value = Some(section[19]);
            if tmpl == 42 {
                if section.len() < 25 {
                    return Err(JsValue::from_str("Section 5 too short for template 5.42"));
                }
                ccsds_flags = Some(section[21]);
                ccsds_block_size = Some(u32::from(section[22]));
                ccsds_rsi = Some(be_u16(section, 23)? as u32);
            }
        } else if section_num == 6 {
            if section.len() < 6 {
                return Err(JsValue::from_str("Section 6 too short"));
            }
            let indicator = section[5];
            if indicator == 0 {
                bitmap = Some(section[6..].to_vec());
            }
        } else if section_num == 7 {
            section7_payload = Some(&section[5..]);
        }

        pos += section_len;
    }

    let total_points = total_points.ok_or_else(|| JsValue::from_str("Missing Section 3 point count"))?;
    let encoded_points = encoded_points.ok_or_else(|| JsValue::from_str("Missing Section 5 encoded point count"))?;
    let template_number = template_number.ok_or_else(|| JsValue::from_str("Missing Section 5 template number"))?;
    let payload = section7_payload.ok_or_else(|| JsValue::from_str("Missing Section 7 payload"))?;
    let bits_per_value = bits_per_value.ok_or_else(|| JsValue::from_str("Missing bitsPerValue"))?;
    let binary_scale_factor =
        binary_scale_factor.ok_or_else(|| JsValue::from_str("Missing binaryScaleFactor"))?;
    let decimal_scale_factor =
        decimal_scale_factor.ok_or_else(|| JsValue::from_str("Missing decimalScaleFactor"))?;
    let reference_value = reference_value.ok_or_else(|| JsValue::from_str("Missing referenceValue"))?;
    let mask: u32 = if bits_per_value >= 32 { u32::MAX } else { (1u32 << bits_per_value) - 1 };
    let bscale = 2f64.powi(binary_scale_factor);
    let dscale = 10f64.powi(-decimal_scale_factor);

    let packed_values: Vec<u32> = if template_number == 42 {
        let ccsds_flags = ccsds_flags.ok_or_else(|| JsValue::from_str("Missing ccsdsFlags"))?;
        let ccsds_block_size = ccsds_block_size.ok_or_else(|| JsValue::from_str("Missing ccsdsBlockSize"))?;
        let ccsds_rsi = ccsds_rsi.ok_or_else(|| JsValue::from_str("Missing ccsdsRsi"))?;
        let flags = flags_from_grib2_ccsds_flags(ccsds_flags);
        let params = AecParams::new(bits_per_value, ccsds_block_size, ccsds_rsi, flags);
        let decoded = rust_aec::decode(payload, params, encoded_points)
            .map_err(|e| JsValue::from_str(&format!("AEC decode failed: {e}")))?;
        let bytes_per_sample = (u32::from(bits_per_value).div_ceil(8)) as usize;
        if decoded.len() < encoded_points.saturating_mul(bytes_per_sample) {
            return Err(JsValue::from_str("Decoded payload shorter than expected sample count"));
        }
        let mut out = Vec::with_capacity(encoded_points);
        for i in 0..encoded_points {
            let start = i * bytes_per_sample;
            let sample_bytes = &decoded[start..start + bytes_per_sample];
            let raw = if flags.contains(rust_aec::AecFlags::MSB) {
                sample_bytes
                    .iter()
                    .fold(0u32, |acc, &b| (acc << 8) | u32::from(b))
            } else {
                sample_bytes
                    .iter()
                    .enumerate()
                    .fold(0u32, |acc, (j, &b)| acc | (u32::from(b) << (j * 8)))
            } & mask;
            out.push(raw);
        }
        out
    } else if template_number == 0 {
        unpack_simple_bits(payload, bits_per_value, encoded_points)?
    } else {
        return Err(JsValue::from_str(&format!(
            "Unsupported data representation template: {template_number}"
        )));
    };

    let mut values = if bitmap.is_some() {
        vec![f64::NAN; total_points]
    } else {
        Vec::with_capacity(encoded_points)
    };

    if let Some(bitmap_bytes) = bitmap {
        let mut data_idx = 0usize;
        for point_idx in 0..total_points {
            if bitmap_bit(&bitmap_bytes, point_idx) {
                if data_idx >= packed_values.len() {
                    return Err(JsValue::from_str("Bitmap expects more values than decoded"));
                }
                let raw = packed_values[data_idx];
                values[point_idx] = (f64::from(reference_value) + f64::from(raw) * bscale) * dscale;
                data_idx += 1;
            }
        }
    } else {
        for raw in packed_values {
            let value = (f64::from(reference_value) + f64::from(raw) * bscale) * dscale;
            values.push(value);
        }
    }

    Ok(values)
}

fn unpack_simple_bits(payload: &[u8], bits_per_value: u8, count: usize) -> Result<Vec<u32>, JsValue> {
    if bits_per_value == 0 {
        return Ok(vec![0u32; count]);
    }
    let mut out = Vec::with_capacity(count);
    let mut bit_pos = 0usize;
    for _ in 0..count {
        let mut raw = 0u32;
        for _ in 0..bits_per_value {
            let byte_idx = bit_pos / 8;
            if byte_idx >= payload.len() {
                return Err(JsValue::from_str("Section 7 bitstream truncated"));
            }
            let bit_in_byte = 7 - (bit_pos % 8);
            let bit = (payload[byte_idx] >> bit_in_byte) & 1;
            raw = (raw << 1) | u32::from(bit);
            bit_pos += 1;
        }
        out.push(raw);
    }
    Ok(out)
}

fn bitmap_bit(bitmap: &[u8], index: usize) -> bool {
    let byte_idx = index / 8;
    if byte_idx >= bitmap.len() {
        return false;
    }
    let bit_in_byte = 7 - (index % 8);
    ((bitmap[byte_idx] >> bit_in_byte) & 1) == 1
}

fn read_signed_magnitude_i16(v: u16) -> i32 {
    if (v & 0x8000) != 0 {
        -i32::from(v & 0x7fff)
    } else {
        i32::from(v)
    }
}

fn be_i32(bytes: &[u8], offset: usize) -> Result<i32, JsValue> {
    if offset + 4 > bytes.len() {
        return Err(JsValue::from_str("Unexpected end of file while reading i32"));
    }
    Ok(i32::from_be_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ]))
}

fn be_u16(bytes: &[u8], offset: usize) -> Result<u16, JsValue> {
    if offset + 2 > bytes.len() {
        return Err(JsValue::from_str("Unexpected end of file while reading u16"));
    }
    Ok(u16::from_be_bytes([bytes[offset], bytes[offset + 1]]))
}

fn be_u32(bytes: &[u8], offset: usize) -> Result<u32, JsValue> {
    if offset + 4 > bytes.len() {
        return Err(JsValue::from_str("Unexpected end of file while reading u32"));
    }
    Ok(u32::from_be_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ]))
}

fn be_u64(bytes: &[u8], offset: usize) -> Result<u64, JsValue> {
    if offset + 8 > bytes.len() {
        return Err(JsValue::from_str("Unexpected end of file while reading u64"));
    }
    Ok(u64::from_be_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
    ]))
}

fn discipline_name(d: u8) -> &'static str {
    match d {
        0 => "Meteorological products",
        1 => "Hydrological products",
        2 => "Land surface products",
        3 => "Space products",
        10 => "Oceanographic products",
        _ => "Unknown discipline",
    }
}

fn grid_template_name(id: u16) -> &'static str {
    match id {
        0 => "Latitude/Longitude (regular)",
        1 => "Rotated latitude/longitude",
        10 => "Mercator",
        20 => "Polar stereographic",
        30 => "Lambert conformal",
        _ => "Other grid template",
    }
}

fn parameter_name(discipline: u8, category: Option<u8>, number: Option<u8>) -> &'static str {
    match (discipline, category, number) {
        (0, Some(0), Some(0)) => "Temperature",
        (0, Some(0), Some(2)) => "Potential temperature",
        (0, Some(1), Some(1)) => "Relative humidity",
        (0, Some(1), Some(8)) => "Total precipitation rate",
        (0, Some(2), Some(2)) => "U-component of wind",
        (0, Some(2), Some(3)) => "V-component of wind",
        (0, Some(2), Some(9)) => "Vertical velocity (geometric)",
        (0, Some(3), Some(0)) => "Pressure",
        (0, Some(19), Some(1)) => "Total column water",
        _ => "Unknown parameter",
    }
}
