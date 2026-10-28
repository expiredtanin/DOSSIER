//! Bindungen der Schnitt-Bänder (`crate::plan_section`). Layouts s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Dominanz-Subtraktion und Verschmelzung der Schnitt-Rechtecke; Unsinn → leer.
#[wasm_bindgen]
pub fn section_dominant_bands_flat(input: &[f64]) -> Vec<f64> {
    crate::plan_section::dominant_bands(input)
}

/// Aussenringe der Vereinigung achsparalleler Rechtecke; Unsinn → leer.
#[wasm_bindgen]
pub fn section_union_outlines_flat(input: &[f64]) -> Vec<f64> {
    crate::plan_section::union_outlines(input)
}
