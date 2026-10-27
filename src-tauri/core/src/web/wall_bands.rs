//! Bindungen der Wand-Schichtbänder (`crate::wall_bands`). Kodierung s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Wände + Geschosse (Decken, Dächer) flach → Körper je Wand flach; nie ein Panic.
#[wasm_bindgen]
pub fn wall_bands_flat(walls: &[f64], floors: &[f64]) -> Vec<f64> {
    crate::wall_bands::wall_bands_flat(walls, floors)
}
