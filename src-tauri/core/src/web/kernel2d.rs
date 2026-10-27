//! Bindungen des 2D-Geometrie-Kerns (Crate `kernel2d`) für `src/geometry/kernel2d.ts`.
//!
//! Flache `f64`-Puffer statt JSON:
//! - Punktliste `pts`: `[x0, y0, x1, y1, …]`
//! - Liste von Punktlisten: `[n, (n_pts, x0, y0, …)…]`
//! - Ketten (Polylinien mit bulge): `[n, (closed, n_pts, x0, y0, …, n_bulge, b0, …)…]`;
//!   `n_bulge = -1` heisst „kein bulge-Array" (nur Eingabe von `k2_join_chains_with_bulge`).
//! - „kein Ergebnis" (TS `null`): leerer Puffer.
//!
//! Kaputte Eingaben (ungerade Längen, falsche Zählungen, ungültige Indizes) ergeben ein
//! leeres Ergebnis statt eines Panics.

use kernel2d::{self as k, BulgeChainInput, BulgePolyline, Polyline, TangentTarget, Vec2};
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
    fn values(&mut self, n: usize) -> Option<Vec<f64>> {
        let end = self.i.checked_add(n)?;
        let slice = self.buf.get(self.i..end)?;
        self.i = end;
        Some(slice.to_vec())
    }
    /// Kette `closed, n_pts, xy…, n_bulge, b…` (`n_bulge = -1` → None).
    fn chain(&mut self) -> Option<(Vec<Vec2>, bool, Option<Vec<f64>>)> {
        let closed = self.f()? != 0.0;
        let n = self.count()?;
        let pts = self.pts(n)?;
        let nb = self.f()?;
        let bulge = if nb == -1.0 { None } else { Some(self.values(count(nb)?)?) };
        Some((pts, closed, bulge))
    }
    fn chains(&mut self) -> Option<Vec<(Vec<Vec2>, bool, Option<Vec<f64>>)>> {
        let n = self.count()?;
        (0..n).map(|_| self.chain()).collect()
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

fn cutters(buf: &[f64]) -> Option<Vec<Polyline>> {
    let list = Reader::new(buf).chains()?;
    Some(list.into_iter().map(|(pts, closed, _)| Polyline { pts, closed }).collect())
}

fn bulge_cutters(buf: &[f64]) -> Option<Vec<BulgePolyline>> {
    let list = Reader::new(buf).chains()?;
    Some(
        list.into_iter()
            .map(|(pts, closed, bulge)| BulgePolyline { pts, closed, bulge: bulge.unwrap_or_default() })
            .collect(),
    )
}

fn pt_lists(buf: &[f64]) -> Option<Vec<Vec<Vec2>>> {
    let mut r = Reader::new(buf);
    let n = r.count()?;
    (0..n).map(|_| r.count().and_then(|m| r.pts(m))).collect()
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

fn enc_pt_lists(lists: &[Vec<Vec2>]) -> Vec<f64> {
    let mut out = vec![lists.len() as f64];
    for l in lists {
        out.push(l.len() as f64);
        push_pts(&mut out, l);
    }
    out
}

fn enc_chains<'a>(chains: impl ExactSizeIterator<Item = (&'a [Vec2], bool, &'a [f64])>) -> Vec<f64> {
    let mut out = vec![chains.len() as f64];
    for (pts, closed, bulge) in chains {
        out.push(if closed { 1.0 } else { 0.0 });
        out.push(pts.len() as f64);
        push_pts(&mut out, pts);
        out.push(bulge.len() as f64);
        out.extend_from_slice(bulge);
    }
    out
}

fn enc_polylines(list: &[Polyline]) -> Vec<f64> {
    enc_chains(list.iter().map(|p| (p.pts.as_slice(), p.closed, &[][..])))
}

fn enc_bulge_polylines(list: &[BulgePolyline]) -> Vec<f64> {
    enc_chains(list.iter().map(|p| (p.pts.as_slice(), p.closed, p.bulge.as_slice())))
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

#[wasm_bindgen]
pub fn k2_offset_polyline(p: &[f64], d: f64, closed: bool) -> Vec<f64> {
    pts(p).map_or_else(Vec::new, |p| enc_pts(&k::offset_polyline(&p, d, closed)))
}

#[wasm_bindgen]
pub fn k2_offset_polyline_with_bulge(p: &[f64], bulge: &[f64], d: f64, closed: bool) -> Vec<f64> {
    let Some(p) = pts(p) else { return enc_pts_bulge(&[], &[]) };
    let (out, b) = k::offset_polyline_with_bulge(&p, bulge, d, closed);
    enc_pts_bulge(&out, &b)
}

// --- Trim / Extend -----------------------------------------------------------

#[wasm_bindgen]
pub fn k2_trim_polyline(p: &[f64], closed: bool, cut: &[f64], px: f64, py: f64) -> Vec<f64> {
    let (Some(p), Some(cut)) = (pts(p), cutters(cut)) else { return EMPTY_LIST.to_vec() };
    enc_polylines(&k::trim_polyline(&p, closed, &cut, Vec2::new(px, py)))
}

#[wasm_bindgen]
pub fn k2_trim_polyline_with_bulge(p: &[f64], bulge: &[f64], closed: bool, cut: &[f64], px: f64, py: f64) -> Vec<f64> {
    let (Some(p), Some(cut)) = (pts(p), bulge_cutters(cut)) else { return EMPTY_LIST.to_vec() };
    enc_bulge_polylines(&k::trim_polyline_with_bulge(&p, bulge, closed, &cut, Vec2::new(px, py)))
}

#[wasm_bindgen]
pub fn k2_extend_segment(a1x: f64, a1y: f64, a2x: f64, a2y: f64, at_end: bool, cut: &[f64]) -> Vec<f64> {
    let Some(cut) = cutters(cut) else { return Vec::new() };
    let end = if at_end { "end" } else { "start" };
    match k::extend_segment(Vec2::new(a1x, a1y), Vec2::new(a2x, a2y), end, &cut) {
        Some((a, b)) => vec![a.x, a.y, b.x, b.y],
        None => Vec::new(),
    }
}

#[wasm_bindgen]
pub fn k2_extend_bulge_segment(ax: f64, ay: f64, bx: f64, by: f64, bulge: f64, at_end: bool, cut: &[f64]) -> Vec<f64> {
    let Some(cut) = cutters(cut) else { return Vec::new() };
    match k::extend_bulge_segment(Vec2::new(ax, ay), Vec2::new(bx, by), bulge, at_end, &cut) {
        Some((p, b)) => vec![p.x, p.y, b],
        None => Vec::new(),
    }
}

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

#[wasm_bindgen]
pub fn k2_chamfer_corner(cx: f64, cy: f64, p1x: f64, p1y: f64, p2x: f64, p2y: f64, distance: f64) -> Vec<f64> {
    match k::chamfer_corner(Vec2::new(cx, cy), Vec2::new(p1x, p1y), Vec2::new(p2x, p2y), distance) {
        Some(c) => vec![c.a.x, c.a.y, c.b.x, c.b.y],
        None => Vec::new(),
    }
}

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

/// `[edgeIndex, t]` oder leer.
#[wasm_bindgen]
pub fn k2_nearest_on_polyline(p: &[f64], closed: bool, px: f64, py: f64) -> Vec<f64> {
    match pts(p).and_then(|p| k::nearest_on_polyline(&p, closed, Vec2::new(px, py))) {
        Some((e, t)) => vec![e as f64, t],
        None => Vec::new(),
    }
}

#[wasm_bindgen]
pub fn k2_break_curve(p: &[f64], e1: f64, t1: f64, e2: f64, t2: f64) -> Vec<f64> {
    let (Some(p), Some(e1), Some(e2)) = (pts(p), count(e1), count(e2)) else { return EMPTY_LIST.to_vec() };
    enc_pt_lists(&k::break_curve(&p, (e1, t1), (e2, t2)))
}

#[wasm_bindgen]
pub fn k2_split_at_intersections(target: &[f64], closed: bool, others: &[f64]) -> Vec<f64> {
    let (Some(target), Some(others)) = (pts(target), pt_lists(others)) else { return EMPTY_LIST.to_vec() };
    enc_pt_lists(&k::split_at_intersections(&target, closed, &others))
}

#[wasm_bindgen]
pub fn k2_join_chains_with_bulge(chains: &[f64]) -> Vec<f64> {
    let Some(list) = Reader::new(chains).chains() else { return EMPTY_LIST.to_vec() };
    let input: Vec<BulgeChainInput> =
        list.into_iter().map(|(pts, closed, bulge)| BulgeChainInput { pts, closed, bulge }).collect();
    enc_bulge_polylines(&k::join_chains_with_bulge(&input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kaputte_puffer_ergeben_leere_ergebnisse() {
        assert!(k2_offset_polyline(&[0.0, 0.0, 1.0], 0.1, false).is_empty());
        assert_eq!(k2_trim_polyline(&[0.0, 0.0, 1.0, 0.0], false, &[1.0, 0.0, 5.0], 0.0, 0.0), vec![0.0]);
        assert_eq!(k2_split_polyline_at_param(&[0.0, 0.0, 1.0, 0.0], false, -1.0, 0.5), vec![0.0]);
        assert_eq!(k2_split_polyline_at_param(&[0.0, 0.0, 1.0, 0.0], true, 7.0, 0.5), vec![1.0, 2.0, 0.0, 0.0, 1.0, 0.0]);
        assert_eq!(k2_join_chains_with_bulge(&[2.0, 0.0, 1.0, 0.0, 0.0, -1.0]), vec![0.0]);
        assert!(k2_tangent_circle_centers(&[3.0], &[0.0, 0.0, 0.0, 1.0, 0.0], 1.0).is_empty());
        assert!(k2_nearest_on_polyline(&[f64::NAN], false, 0.0, 0.0).is_empty());
        assert_eq!(k2_break_curve(&[0.0, 0.0, 1.0, 0.0], 3.0, 0.5, 0.0, 0.5), vec![0.0]);
    }

    #[test]
    fn ketten_hin_und_zurueck() {
        // Zwei offene Ketten, eine ohne bulge (-1) → verbunden, bulge mitgetragen.
        let input = [2.0, 0.0, 2.0, -1.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 2.0, 1.0, 0.0, 3.0, 0.0, -1.0];
        let out = k2_join_chains_with_bulge(&input);
        assert_eq!(out, vec![1.0, 0.0, 3.0, -1.0, 0.0, 1.0, 0.0, 3.0, 0.0, 2.0, 1.0, 0.0]);
    }
}
