//! Bindungen von Wand-Poché und Decken-Umriss im Grundriss (`crate::plan_walls`). Layout s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Wand-Poché-Geometrie einer Wand; Unsinn → leer.
#[wasm_bindgen]
pub fn plan_wall_poche_flat(buf: &[f64]) -> Vec<f64> {
    crate::plan_walls::wall_poche(buf)
}

/// Freie Teilstücke eines Decken-Umrisses gegen Wand-Footprints; Unsinn → leer.
#[wasm_bindgen]
pub fn plan_ceiling_outline_flat(buf: &[f64]) -> Vec<f64> {
    crate::plan_walls::ceiling_outline(buf)
}
