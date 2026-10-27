//! Bindungen der Wand-Verschneidung (`crate::joins`). Kodierung s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Wände flach → `[0, (Cuts je Wand)…]`; `[1, wandIndex]` = Wandtyp/Bauteil unbekannt;
/// kaputte Eingabe → leer.
#[wasm_bindgen]
pub fn compute_joins_flat(walls: &[f64]) -> Vec<f64> {
    crate::joins::compute_joins_flat(walls)
}

/// Verschneidungs-Entscheidung: 0 merge, 1 trim-a, 2 trim-b, 3 coexist.
#[wasm_bindgen]
pub fn join_priority_resolution(prio_a: f64, prio_b: f64, same_component: bool) -> u8 {
    use crate::joins::JoinResolution::*;
    match crate::joins::resolve_join_priority(prio_a, prio_b, same_component) {
        Merge => 0,
        TrimA => 1,
        TrimB => 2,
        Coexist => 3,
    }
}
