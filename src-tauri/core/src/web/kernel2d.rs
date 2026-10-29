//! Bindungen des 2D-Geometrie-Kerns (Crate `kernel2d`) für `src/geometry/kernel2d.ts`.
//!
//! Flache `f64`-Puffer statt JSON:
//! - Punktliste `pts`: `[x0, y0, x1, y1, …]`
//! - Liste von Punktlisten: `[n, (n_pts, x0, y0, …)…]`
//! - „kein Ergebnis" (TS `null`): leerer Puffer.
//!
//! Kaputte Eingaben (ungerade Längen, falsche Zählungen, ungültige Indizes) ergeben ein
//! leeres Ergebnis statt eines Panics.

use kernel2d::{self as k, Vec2};
use wasm_bindgen::prelude::wasm_bindgen;

// --- Lesen -------------------------------------------------------------------

/// Sequentieller Leser mit Zählungs-Prüfung.
struct Reader<'a> {
    buf: &'a [f64],
    i: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [f64]) -> Self {
        Reader { buf, i: 0 }
    }
    fn f(&mut self) -> Option<f64> {
        let v = *self.buf.get(self.i)?;
        self.i += 1;
        Some(v)
    }
    fn count(&mut self) -> Option<usize> {
        count(self.f()?)
    }
    fn pts(&mut self, n: usize) -> Option<Vec<Vec2>> {
        let end = self.i.checked_add(n.checked_mul(2)?)?;
        let slice = self.buf.get(self.i..end)?;
        self.i = end;
        Some(slice.chunks_exact(2).map(|c| Vec2::new(c[0], c[1])).collect())
    }
}

/// Nicht-negative ganze Zahl (Zählung/Index) oder None.
fn count(v: f64) -> Option<usize> {
    if v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v < 1e9 {
        Some(v as usize)
    } else {
        None
    }
}

fn pts(buf: &[f64]) -> Option<Vec<Vec2>> {
    if buf.len() % 2 != 0 {
        return None;
    }
    Some(buf.chunks_exact(2).map(|c| Vec2::new(c[0], c[1])).collect())
}

fn pt_lists(buf: &[f64]) -> Option<Vec<Vec<Vec2>>> {
    let mut r = Reader::new(buf);
    let n = r.count()?;
    (0..n).map(|_| r.count().and_then(|m| r.pts(m))).collect()
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

fn enc_pt_lists(lists: &[Vec<Vec2>]) -> Vec<f64> {
    let mut out = vec![lists.len() as f64];
    for l in lists {
        out.push(l.len() as f64);
        push_pts(&mut out, l);
    }
    out
}

/// `[n_pts, xy…, bulge…]` (bulge-Anzahl = Rest des Puffers).
fn enc_pts_bulge(pts: &[Vec2], bulge: &[f64]) -> Vec<f64> {
    let mut out = vec![pts.len() as f64];
    push_pts(&mut out, pts);
    out.extend_from_slice(bulge);
    out
}

const EMPTY_LIST: [f64; 1] = [0.0];

// --- Punkt/Strecke, Fläche, Kreise ---------------------------------------------

#[wasm_bindgen]
pub fn k2_circle_circle_intersect(c1x: f64, c1y: f64, r1: f64, c2x: f64, c2y: f64, r2: f64) -> Vec<f64> {
    enc_pts(&k::circle_circle_intersect(Vec2::new(c1x, c1y), r1, Vec2::new(c2x, c2y), r2))
}

// --- Offset ------------------------------------------------------------------



// --- Trim / Extend -----------------------------------------------------------





// --- Ecken -------------------------------------------------------------------


// --- Split / Join / Segment löschen / Bruch ----------------------------------------

#[wasm_bindgen]
pub fn k2_split_polyline_at_param(p: &[f64], closed: bool, edge_index: f64, t: f64) -> Vec<f64> {
    let (Some(p), Some(e)) = (pts(p), count(edge_index)) else { return EMPTY_LIST.to_vec() };
    enc_pt_lists(&k::split_polyline_at_param(&p, closed, e, t))
}

/// Zwei Ringe oder leere Liste (TS `null`).
#[wasm_bindgen]
pub fn k2_split_closed_by_chord(p: &[f64], i: f64, ti: f64, j: f64, tj: f64) -> Vec<f64> {
    let (Some(p), Some(i), Some(j)) = (pts(p), count(i), count(j)) else { return EMPTY_LIST.to_vec() };
    match k::split_closed_by_chord(&p, i, ti, j, tj) {
        Some((a, b)) => enc_pt_lists(&[a, b]),
        None => EMPTY_LIST.to_vec(),
    }
}

#[wasm_bindgen]
pub fn k2_remove_segment(p: &[f64], closed: bool, edge_index: f64) -> Vec<f64> {
    let (Some(p), Some(e)) = (pts(p), count(edge_index)) else { return Vec::new() };
    enc_pts(&k::remove_segment(&p, closed, e).pts)
}

#[wasm_bindgen]
pub fn k2_remove_segment_with_bulge(p: &[f64], bulge: &[f64], closed: bool, edge_index: f64) -> Vec<f64> {
    let (Some(p), Some(e)) = (pts(p), count(edge_index)) else { return enc_pts_bulge(&[], &[]) };
    let r = k::remove_segment_with_bulge(&p, bulge, closed, e);
    enc_pts_bulge(&r.pts, &r.bulge)
}



#[wasm_bindgen]
pub fn k2_split_at_intersections(target: &[f64], closed: bool, others: &[f64]) -> Vec<f64> {
    let (Some(target), Some(others)) = (pts(target), pt_lists(others)) else { return EMPTY_LIST.to_vec() };
    enc_pt_lists(&k::split_at_intersections(&target, closed, &others))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kaputte_puffer_ergeben_leere_ergebnisse() {
        assert_eq!(k2_split_polyline_at_param(&[0.0, 0.0, 1.0, 0.0], false, -1.0, 0.5), vec![0.0]);
        assert_eq!(k2_split_polyline_at_param(&[0.0, 0.0, 1.0, 0.0], true, 7.0, 0.5), vec![1.0, 2.0, 0.0, 0.0, 1.0, 0.0]);
        assert!(k2_tangent_circle_centers(&[3.0], &[0.0, 0.0, 0.0, 1.0, 0.0], 1.0).is_empty());
    }
}
