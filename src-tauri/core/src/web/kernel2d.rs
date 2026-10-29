//! Bindungen des 2D-Geometrie-Kerns (Crate `kernel2d`) für `src/geometry/kernel2d.ts`.
//!
//! Flache `f64`-Puffer statt JSON:
//! - Punktliste `pts`: `[x0, y0, x1, y1, …]`
//! - „kein Ergebnis" (TS `null`): leerer Puffer.
//!
//! Kaputte Eingaben (ungerade Längen) ergeben ein leeres Ergebnis statt eines Panics.
//! (Split/Segment löschen rechnen im Kern selbst: `cmd_split.rs`.)

use kernel2d::{self as k, TangentTarget, Vec2};
use wasm_bindgen::prelude::wasm_bindgen;

// --- Lesen -------------------------------------------------------------------

fn pts(buf: &[f64]) -> Option<Vec<Vec2>> {
    if buf.len() % 2 != 0 {
        return None;
    }
    Some(buf.chunks_exact(2).map(|c| Vec2::new(c[0], c[1])).collect())
}

fn tangent_target(buf: &[f64]) -> Option<TangentTarget> {
    match *buf {
        [kind, ax, ay, bx, by] if kind == 0.0 => {
            Some(TangentTarget::Line { a: Vec2::new(ax, ay), b: Vec2::new(bx, by) })
        }
        [kind, cx, cy, r, _] if kind == 1.0 => Some(TangentTarget::Circle { center: Vec2::new(cx, cy), r }),
        _ => None,
    }
}

// --- Schreiben ---------------------------------------------------------------

fn push_pts(out: &mut Vec<f64>, pts: &[Vec2]) {
    for p in pts {
        out.push(p.x);
        out.push(p.y);
    }
}

fn enc_pts(pts: &[Vec2]) -> Vec<f64> {
    let mut out = Vec::with_capacity(pts.len() * 2);
    push_pts(&mut out, pts);
    out
}

// --- Punkt/Strecke, Fläche, Kreise ---------------------------------------------

#[wasm_bindgen]
pub fn k2_point_segment_distance(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    k::point_segment_distance(Vec2::new(px, py), Vec2::new(ax, ay), Vec2::new(bx, by))
}

#[wasm_bindgen]
pub fn k2_signed_area(p: &[f64]) -> f64 {
    pts(p).map_or(0.0, |p| k::signed_area(&p))
}

#[wasm_bindgen]
pub fn k2_is_ccw(p: &[f64]) -> bool {
    pts(p).is_some_and(|p| k::is_ccw(&p))
}

#[wasm_bindgen]
pub fn k2_circle_circle_intersect(c1x: f64, c1y: f64, r1: f64, c2x: f64, c2y: f64, r2: f64) -> Vec<f64> {
    enc_pts(&k::circle_circle_intersect(Vec2::new(c1x, c1y), r1, Vec2::new(c2x, c2y), r2))
}

#[wasm_bindgen]
pub fn k2_tangent_circle_centers(t1: &[f64], t2: &[f64], r: f64) -> Vec<f64> {
    let (Some(t1), Some(t2)) = (tangent_target(t1), tangent_target(t2)) else { return Vec::new() };
    enc_pts(&k::tangent_circle_centers(t1, t2, r))
}

// --- Offset ------------------------------------------------------------------

#[wasm_bindgen]
pub fn k2_offset_segment(ax: f64, ay: f64, bx: f64, by: f64, d: f64) -> Vec<f64> {
    let (a, b) = k::offset_segment(Vec2::new(ax, ay), Vec2::new(bx, by), d);
    vec![a.x, a.y, b.x, b.y]
}



// --- Trim / Extend -----------------------------------------------------------





// --- Ecken -------------------------------------------------------------------

/// `[cx, cy, radius, tAx, tAy, tBx, tBy, startAngle, endAngle]` oder leer.
#[wasm_bindgen]
pub fn k2_fillet_corner(cx: f64, cy: f64, p1x: f64, p1y: f64, p2x: f64, p2y: f64, r: f64) -> Vec<f64> {
    match k::fillet_corner(Vec2::new(cx, cy), Vec2::new(p1x, p1y), Vec2::new(p2x, p2y), r) {
        Some(f) => vec![
            f.center.x,
            f.center.y,
            f.radius,
            f.tangent_a.x,
            f.tangent_a.y,
            f.tangent_b.x,
            f.tangent_b.y,
            f.start_angle,
            f.end_angle,
        ],
        None => Vec::new(),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kaputte_puffer_ergeben_leere_ergebnisse() {
        assert!(k2_tangent_circle_centers(&[3.0], &[0.0, 0.0, 0.0, 1.0, 0.0], 1.0).is_empty());
    }
}
