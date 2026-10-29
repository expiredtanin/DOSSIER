//! Bindungen der Abzugskörper-Geometrie (`crate::voids`). Layouts s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Polygon minus Schneider (mit nicht gestrichenen Kanten); `[-1]` = keine Überschneidung.
#[wasm_bindgen]
pub fn voids_subtract_rings_flat(pts: &[f64], cutters: &[f64], no_stroke: &[f64]) -> Vec<f64> {
    crate::voids::subtract_rings_flat(pts, cutters, no_stroke)
}

/// Teile einer Strecke ausserhalb aller Ringe; Unsinn → leer.
#[wasm_bindgen]
pub fn voids_segment_outside_flat(seg: &[f64], cutters: &[f64]) -> Vec<f64> {
    crate::voids::segment_outside_flat(seg, cutters)
}
