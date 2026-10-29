//! Bindungen der Treppen-Geometrie (`crate::stair`). Kodierung s. dort.

use crate::stair as s;
use wasm_bindgen::prelude::wasm_bindgen;

/// Plan-Aussenlinie: `[0, n, x, y …]` (Polygon) oder `[1, …]` (Wendel).
#[wasm_bindgen]
pub fn stair_outline_flat(params: &[f64]) -> Vec<f64> {
    s::outline(params)
}
