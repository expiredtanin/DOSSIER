//! Bindungen der Dach-Geometrie (`crate::roof`). Kodierung s. dort.

use crate::roof::{decode_params, decode_polys3, encode_geometry, roof_geometry, roof_underside_at as underside};
use wasm_bindgen::prelude::wasm_bindgen;

/// Dachparameter (flach) + Traufhöhe → flache `RoofGeometry`; kaputte Eingaben → leere Geometrie.
#[wasm_bindgen]
pub fn roof_geometry_flat(params: &[f64], eaves_z: f64) -> Vec<f64> {
    let geo = decode_params(params).map(|p| roof_geometry(&p, eaves_z)).unwrap_or_default();
    encode_geometry(&geo)
}

/// Dach-Unterkante an (x, y) über den flachen Dachflächen `[n, (m, (x, y, z)…)…]`; NaN = ausserhalb.
#[wasm_bindgen]
pub fn roof_underside_at(planes: &[f64], total_layer_thickness: f64, x: f64, y: f64) -> f64 {
    decode_polys3(planes).and_then(|pl| underside(&pl, total_layer_thickness, x, y)).unwrap_or(f64::NAN)
}
