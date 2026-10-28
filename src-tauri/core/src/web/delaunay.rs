//! Bindung der Delaunay-Triangulierung (`crate::delaunay`).

use wasm_bindgen::prelude::wasm_bindgen;

/// Delaunay-Dreiecke zu `[x0, y0, x1, y1 …]`; Indizes je drei; leer bei < 3 oder kollinearen Punkten.
#[wasm_bindgen]
pub fn delaunay_flat(coords: &[f64]) -> Vec<f64> {
    crate::delaunay::triangulate(coords).into_iter().map(f64::from).collect()
}
