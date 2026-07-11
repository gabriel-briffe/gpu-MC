use gribinfo::decode_field_values_f32;

use crate::contours;
use crate::idw::{apply_weight_table, build_weight_table};
use crate::state::{install_weight_table, with_installed_table};

pub fn install_idw_grid(lats: &[f32], lons: &[f32], spacing_deg: f32) -> Result<(), String> {
    let table = build_weight_table(lats, lons, spacing_deg)?;
    install_weight_table(table);
    Ok(())
}

pub fn build_sector_geojson_from_values(values: &[f32]) -> Result<String, String> {
    with_installed_table(|table| {
        let regridded = apply_weight_table(table, values)?;
        contours::build_sector_geojson_json(
            table.ni,
            table.nj,
            table.la1_deg,
            table.lo1_deg,
            table.la2_deg,
            table.lo2_deg,
            table.di_deg,
            table.dj_deg,
            table.scan_mode,
            &regridded,
        )
    })
}

pub fn build_sector_geojson_from_field_grib(field_grib: &[u8]) -> Result<String, String> {
    let values = decode_field_values_f32(field_grib)?;
    build_sector_geojson_from_values(&values)
}
