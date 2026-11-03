//! Bindung der Kollisions-Vorstufe (`crate::clash_broad`): Hüllquader-Paare als flache Puffer.

use wasm_bindgen::prelude::wasm_bindgen;

/// Kandidaten-Paare `[i0, j0, …]` aus Bauteil-Hüllen (`[frei, Gruppe, min3, max3]` je Bauteil, s. `clash_broad.rs`).
#[wasm_bindgen]
pub fn clash_candidate_pairs(items: &[f64]) -> Vec<f64> {
    crate::clash_broad::candidate_pairs(items)
}
