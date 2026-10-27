//! Bindungen von Öffnungs-Symbol und Fenster-Symbol (`crate::plan_openings`). Layout s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Tür-/Fenster-Symbol einer Öffnung im Grundriss; Unsinn → leer.
#[wasm_bindgen]
pub fn plan_opening_flat(buf: &[f64]) -> Vec<f64> {
    crate::plan_openings::plan_opening(buf)
}

/// Fenster-Symbol (Rahmen, Glas, Flügel, Stulp) einer Öffnung; Unsinn/entartet → leer.
#[wasm_bindgen]
pub fn window_symbol_flat(buf: &[f64]) -> Vec<f64> {
    crate::plan_openings::window_symbol_flat(buf)
}
