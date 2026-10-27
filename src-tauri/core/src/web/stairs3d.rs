//! Bindungen der Treppen im 3D (`crate::stairs3d`). Kodierung s. dort.

use crate::mesh3d::encode_meshes;
use crate::stairs3d as s;
use wasm_bindgen::prelude::wasm_bindgen;

/// Tritt-Prismen und Podeste aller Treppen als Slabs; `for_section`: auch gerade Betontreppen.
#[wasm_bindgen]
pub fn stairs3d_slabs_flat(stairs: &[f64], for_section: bool) -> Vec<f64> {
    s::encode_slabs(&s::slabs(stairs, for_section))
}

/// Glatte Laufplatte gerader Betontreppen als Meshes.
#[wasm_bindgen]
pub fn stairs3d_meshes_flat(stairs: &[f64]) -> Vec<f64> {
    encode_meshes(&s::slab_meshes(stairs))
}

/// Handlauf und Pfosten gerader Treppen als Quader-Meshes.
#[wasm_bindgen]
pub fn stairs3d_railings_flat(stairs: &[f64]) -> Vec<f64> {
    encode_meshes(&s::railings(stairs))
}
