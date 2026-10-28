//! Bindung des Fenster-Symbols (`crate::plan_openings`, für Schnitt/Ansicht). Layout s. dort. Das
//! Öffnungs-Symbol im Grundriss ruft die Plan-Erzeugung im Kern direkt (`plan/walls.rs`).

use wasm_bindgen::prelude::wasm_bindgen;

/// Fenster-Symbol (Rahmen, Glas, Flügel, Stulp) einer Öffnung; Unsinn/entartet → leer.
#[wasm_bindgen]
pub fn window_symbol_flat(buf: &[f64]) -> Vec<f64> {
    crate::plan_openings::window_symbol_flat(buf)
}
