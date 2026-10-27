//! Bindung der Decken im 3D (`crate::ceilings3d`). Kodierung s. dort.

use crate::ceilings3d as c;
use wasm_bindgen::prelude::wasm_bindgen;

/// Deckenumrisse (mit eingefügten Aussparungen) und Schicht-z-Spannen; Unsinn → leer.
#[wasm_bindgen]
pub fn ceilings3d_flat(ceilings: &[f64]) -> Vec<f64> {
    c::encode(&c::ceilings(ceilings))
}
