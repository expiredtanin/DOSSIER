//! Bindungen der 2D-Zeichnungen im 3D (`crate::drawing2d_3d`). Kodierung s. dort.

use crate::drawing2d_3d as d;
use wasm_bindgen::prelude::wasm_bindgen;

/// LineList-Vertices `[px, höhe, py, r, g, b]` (zwei je Segment) einer Charge.
#[wasm_bindgen]
pub fn drawing3d_line_verts(drawings: &[f64]) -> Vec<f32> {
    d::line_verts(drawings)
}

/// Pick-Strecken `[ax, ay, bx, by, baseElevation, zeichnung]` einer Charge.
#[wasm_bindgen]
pub fn drawing3d_pick_segs(drawings: &[f64], tolerance: f64) -> Vec<f64> {
    d::pick_segs(drawings, tolerance)
}
