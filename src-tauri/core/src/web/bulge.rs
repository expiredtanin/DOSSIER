//! Bindungen der Bogen-Formeln (`crate::bulge`) für `src/geometry/bulge.ts`. Skalare Argumente
//! (kein Puffer) für Einzelaufrufe; Polylinien als flache `Float64Array`s.

use crate::bulge as b;
use wasm_bindgen::prelude::wasm_bindgen;

/// `[cx, cy, r, a0, a1, sweep]`; leer = Gerade/entartet.
#[wasm_bindgen]
pub fn bulge_arc(ax: f64, ay: f64, bx: f64, by: f64, bulge: f64) -> Vec<f64> {
    b::arc(ax, ay, bx, by, bulge)
}

/// Tessellierte Bogenpunkte `[x0, y0, …]` (Gerade: nur a, b).
#[wasm_bindgen]
pub fn bulge_arc_points(ax: f64, ay: f64, bx: f64, by: f64, bulge: f64) -> Vec<f64> {
    b::arc_points(ax, ay, bx, by, bulge)
}

/// Ganze Polylinie tessellieren: Punkte `[x0, y0, …]`, bulge je Kante, geschlossen ja/nein.
#[wasm_bindgen]
pub fn bulge_polyline_points(pts: &[f64], bulge: &[f64], closed: bool) -> Vec<f64> {
    b::polyline_points(pts, bulge, closed)
}

#[wasm_bindgen]
pub fn bulge_from_sagitta_point(ax: f64, ay: f64, bx: f64, by: f64, px: f64, py: f64) -> f64 {
    b::from_sagitta_point(ax, ay, bx, by, px, py)
}

#[wasm_bindgen]
pub fn bulge_between_angles(cx: f64, cy: f64, r: f64, a_from: f64, a_to: f64, sweep_sign: f64) -> f64 {
    b::between_angles(cx, cy, r, a_from, a_to, sweep_sign)
}

/// `[x, y]` auf dem Bogen bei t∈[0,1].
#[wasm_bindgen]
pub fn bulge_point_at(ax: f64, ay: f64, bx: f64, by: f64, bulge: f64, t: f64) -> Vec<f64> {
    b::point_at(ax, ay, bx, by, bulge, t)
}

#[wasm_bindgen]
pub fn bulge_through_point(ax: f64, ay: f64, tx: f64, ty: f64, bx: f64, by: f64) -> f64 {
    b::through_point(ax, ay, tx, ty, bx, by)
}

/// `[cx, cy, r, a0, a1]` (CCW) oder leer.
#[wasm_bindgen]
pub fn arc_through_points(ax: f64, ay: f64, tx: f64, ty: f64, bx: f64, by: f64) -> Vec<f64> {
    b::arc_through_points(ax, ay, tx, ty, bx, by)
}

#[wasm_bindgen]
pub fn arc_from_start_end_radius(ax: f64, ay: f64, bx: f64, by: f64, r: f64, nx: f64, ny: f64) -> Vec<f64> {
    b::arc_from_start_end_radius(ax, ay, bx, by, r, nx, ny)
}

#[wasm_bindgen]
pub fn arc_from_start_end_direction(ax: f64, ay: f64, bx: f64, by: f64, dx: f64, dy: f64) -> Vec<f64> {
    b::arc_from_start_end_direction(ax, ay, bx, by, dx, dy)
}
