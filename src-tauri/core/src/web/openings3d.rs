//! Bindungen der Öffnungs-Einbauteile in 3D (`crate::openings3d`). Kodierung s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Wände mit Öffnungen (+ Detailgrad) flach → Quader (Bauteil-Klasse, 8 Ecken) flach; nie ein Panic.
#[wasm_bindgen]
pub fn opening_meshes_flat(buf: &[f64]) -> Vec<f64> {
    crate::openings3d::opening_meshes_flat(buf)
}

/// Rahmen-Ring als Vierecke (u, h) flach: `[n, (u, h) × 4 …]`.
#[wasm_bindgen]
pub fn frame_ring_quads_flat(from: f64, to: f64, z_b: f64, z_t: f64, w: f64, join: f64, bottom: bool) -> Vec<f64> {
    crate::openings3d::frame_ring_quads_flat(from, to, z_b, z_t, w, join, bottom)
}
