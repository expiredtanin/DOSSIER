//! Bindung der Stützen im 3D (`crate::columns3d`). Kodierung s. dort.

use crate::columns3d as c;
use crate::mesh3d::encode_meshes;
use wasm_bindgen::prelude::wasm_bindgen;

/// Prisma-Meshes aller Stützen aus Querschnitt und Höhen; Unsinn → leer.
#[wasm_bindgen]
pub fn columns3d_flat(columns: &[f64]) -> Vec<f64> {
    encode_meshes(&c::columns(columns))
}
