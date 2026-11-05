//! Bindungen des 2D-Geometrie-Kerns (Crate `kernel2d`) für `src/geometry/kernel2d.ts`.
//!
//! Flache `f64`-Puffer statt JSON:
//! - Punktliste `pts`: `[x0, y0, x1, y1, …]`
//! - „kein Ergebnis" (TS `null`): leerer Puffer.
//!
//! (Split/Segment löschen rechnen im Kern selbst: `cmd_split.rs`.)

use kernel2d::{self as k, Vec2};
use wasm_bindgen::prelude::wasm_bindgen;

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
pub fn k2_circle_circle_intersect(c1x: f64, c1y: f64, r1: f64, c2x: f64, c2y: f64, r2: f64) -> Vec<f64> {
    enc_pts(&k::circle_circle_intersect(Vec2::new(c1x, c1y), r1, Vec2::new(c2x, c2y), r2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kreise_schnitt_flach() {
        assert!(k2_circle_circle_intersect(0.0, 0.0, 1.0, 5.0, 0.0, 1.0).is_empty());
        assert_eq!(k2_circle_circle_intersect(0.0, 0.0, 1.0, 1.0, 0.0, 1.0).len(), 4);
    }
}
