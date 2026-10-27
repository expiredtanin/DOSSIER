//! Bindungen des Wand-Loch-Mesh (`crate::wall_mesh_cut`). Kodierung s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Viele Wandbänder flach → je Band die Weltpunkte der Dreiecke; nie ein Panic.
#[wasm_bindgen]
pub fn wall_cut_meshes_flat(buf: &[f64]) -> Vec<f64> {
    crate::wall_mesh_cut::wall_cut_meshes_flat(buf)
}

/// Rechteck minus Löcher als Teilrechtecke (`[u0, u1, z0, z1, …]`).
#[wasm_bindgen]
pub fn solid_subrects_flat(u_lo: f64, u_hi: f64, z_lo: f64, z_hi: f64, holes: &[f64]) -> Vec<f64> {
    crate::wall_mesh_cut::solid_subrects_flat(u_lo, u_hi, z_lo, z_hi, holes)
}

/// Geschlossenes, nach aussen gewundenes Mesh? (Gauss-Kriterium.)
#[wasm_bindgen]
pub fn is_watertight_flat(positions: &[f64], indices: &[u32], eps: f64) -> bool {
    crate::wall_mesh_cut::is_watertight(positions, indices, eps)
}
