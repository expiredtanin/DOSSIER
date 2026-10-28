//! Bindungen des Netz-Ebenenschnitts (`crate::mesh_section`). Layouts s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Schnitt eines Dreiecksnetzes mit einer Ebene; Unsinn → leer.
#[wasm_bindgen]
pub fn mesh_section_cut_flat(positions: &[f64], indices: &[f64], plane: &[f64]) -> Vec<f64> {
    crate::mesh_section::cut(positions, indices, plane)
}

/// Ringe → Flächen mit Löchern; Unsinn → leer.
#[wasm_bindgen]
pub fn mesh_section_polygons_flat(input: &[f64]) -> Vec<f64> {
    crate::mesh_section::rings_to_polygons(input)
}
