//! Bindungen des 2D-Geometrie-Kerns (Crate `kernel2d`) für `src/geometry/kernel2d.ts`.
//!
//! Flache `f64`-Puffer statt JSON:
//! - Punktliste `pts`: `[x0, y0, x1, y1, …]`
//! - „kein Ergebnis" (TS `null`): leerer Puffer.
//!
//! Kaputte Eingaben (ungerade Längen) ergeben ein leeres Ergebnis statt eines Panics.
//! (Split/Segment löschen rechnen im Kern selbst: `cmd_split.rs`.)

use kernel2d::{self as k, Vec2};
use wasm_bindgen::prelude::wasm_bindgen;

// --- Lesen -------------------------------------------------------------------

fn pts(buf: &[f64]) -> Option<Vec<Vec2>> {
    if buf.len() % 2 != 0 {
        return None;
    }
    Some(buf.chunks_exact(2).map(|c| Vec2::new(c[0], c[1])).collect())
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
pub fn k2_circle_circle_intersect(c1x: f64, c1y: f64, r1: f64, c2x: f64, c2y: f64, r2: f64) -> Vec<f64> {
    enc_pts(&k::circle_circle_intersect(Vec2::new(c1x, c1y), r1, Vec2::new(c2x, c2y), r2))
}

// --- Offset ------------------------------------------------------------------



// --- Trim / Extend -----------------------------------------------------------





// --- Ecken -------------------------------------------------------------------


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kaputte_puffer_ergeben_leere_ergebnisse() {
        assert!(k2_tangent_circle_centers(&[3.0], &[0.0, 0.0, 0.0, 1.0, 0.0], 1.0).is_empty());
    }
}
