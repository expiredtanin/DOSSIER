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

/// `[x, y]` auf dem Bogen bei t∈[0,1].
#[wasm_bindgen]
pub fn bulge_point_at(ax: f64, ay: f64, bx: f64, by: f64, bulge: f64, t: f64) -> Vec<f64> {
    b::point_at(ax, ay, bx, by, bulge, t)
}

/// [T2] Band einer Bogenwand (Dicke `t` mittig) für Vorschauen: `[nBand, x, y…(Band), x, y…(Achse)]`;
/// leer = gerade oder entartet.
#[wasm_bindgen]
pub fn wall_arc_band(ax: f64, ay: f64, bx: f64, by: f64, bulge: f64, t: f64) -> Vec<f64> {
    if !t.is_finite() || t < 0.0 {
        return Vec::new();
    }
    let Some((band, axis)) = crate::wall_arc::band_preview((ax, ay), (bx, by), Some(bulge), t) else { return Vec::new() };
    let mut out = vec![band.len() as f64];
    out.extend(band.iter().chain(&axis).flat_map(|q| [q.0, q.1]));
    out
}
