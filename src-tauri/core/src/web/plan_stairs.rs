//! Bindung des Treppen-Symbols im Grundriss (`crate::plan_stairs`). Ausgabe-Layout s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Treppen-Parameter (16 Zahlen), Gesamt-Steighöhe, Schnitthöhe über der UK, Strichstärke (mm),
/// gefüllter Pfeil (0/1) → Primitivliste; Unsinn → leer.
#[wasm_bindgen]
pub fn plan_stair_flat(params: &[f64], total_rise: f64, cut_rise: f64, lw_mm: f64, filled_arrow: f64) -> Vec<f64> {
    crate::plan_stairs::plan_stair(params, total_rise, cut_rise, lw_mm, filled_arrow != 0.0)
}
