//! Bindungen der Kurven-Tessellierung (`crate::curves`). Punkte flach `[x0, y0, …]`.

use wasm_bindgen::prelude::wasm_bindgen;

/// Punkte einer (gedrehten) Ellipse, `n` gleichverteilte Parameterschritte.
#[wasm_bindgen]
pub fn curves_ellipse_flat(cx: f64, cy: f64, rx: f64, ry: f64, rotation: f64, n: f64) -> Vec<f64> {
    crate::curves::ellipse(cx, cy, rx, ry, rotation, n)
}

/// Kubische Bezier-Kette (Anker·Griff·Griff·Anker …); unter 4 Punkten unverändert.
#[wasm_bindgen]
pub fn curves_bezier_chain_flat(pts: &[f64], segs_per_curve: f64) -> Vec<f64> {
    crate::curves::bezier_chain(pts, segs_per_curve)
}

/// Catmull-Rom-Spline durch die Punkte; unter 3 Punkten unverändert.
#[wasm_bindgen]
pub fn curves_catmull_rom_flat(pts: &[f64], closed: bool, segs_per_span: f64) -> Vec<f64> {
    crate::curves::catmull_rom(pts, closed, segs_per_span)
}

/// Uniformer kubischer B-Spline über Kontrollpunkten; unter 3 Punkten unverändert.
#[wasm_bindgen]
pub fn curves_uniform_bspline_flat(pts: &[f64], closed: bool, segs_per_span: f64) -> Vec<f64> {
    crate::curves::uniform_bspline(pts, closed, segs_per_span)
}
