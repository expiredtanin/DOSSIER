//! Raum-Erkennung aus Wänden (aus `src/geometry/roomBoundary.ts`). Die Rechnung (planarer Graph
//! der Wand-Mittellinien, Face-Extraktion, Innen-Offset) steht in `kernel2d`
//! (`detect_rooms`, `room_from_point_inside`, `room_from_point_inside_faces`); hier nur die flache
//! Kodierung und das Verwerfen von Unsinn (nicht endliche Zahlen → leeres Ergebnis, sonst
//! würden NaN-Winkel die Sortierung der Halbkanten durcheinanderbringen).
//!
//! Wände `[n, (ax, ay, bx, by, dicke)…]`, Wandflächen `[n, (ax, ay, bx, by)…]`.
//! Ergebnis Räume `[n, (nPkt, x, y, …)…]`, ein Umriss `[nPkt, x, y, …]` (leer = keiner).

use crate::flat_read::Reader;
use kernel2d::{WallFace, WallSegment, Vec2};

/// Obergrenze der Wandzahl (Schutz vor quadratischem Aufwand bei Unsinn).
const MAX_WALLS: usize = 20_000;

fn read_n(r: &mut Reader, stride: usize) -> Option<Vec<Vec<f64>>> {
    let n = r.count()?;
    if n > MAX_WALLS {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let mut row = Vec::with_capacity(stride);
        for _ in 0..stride {
            let v = r.num()?;
            if !v.is_finite() {
                return None;
            }
            row.push(v);
        }
        out.push(row);
    }
    Some(out)
}

pub fn decode_walls(buf: &[f64]) -> Option<Vec<WallSegment>> {
    let rows = read_n(&mut Reader::new(buf), 5)?;
    Some(rows.iter().map(|w| WallSegment { a: Vec2::new(w[0], w[1]), b: Vec2::new(w[2], w[3]), thickness: w[4] }).collect())
}

pub fn decode_faces(buf: &[f64]) -> Option<Vec<WallFace>> {
    let rows = read_n(&mut Reader::new(buf), 4)?;
    Some(rows.iter().map(|w| WallFace { a: Vec2::new(w[0], w[1]), b: Vec2::new(w[2], w[3]) }).collect())
}

fn push_ring(out: &mut Vec<f64>, ring: &[Vec2]) {
    out.push(ring.len() as f64);
    for p in ring {
        out.push(p.x);
        out.push(p.y);
    }
}

fn ok(v: f64) -> bool {
    v.is_finite()
}

pub fn detect(walls: &[f64], gap_tol: f64, min_area: f64, offset_to_inner: bool) -> Vec<f64> {
    let Some(w) = decode_walls(walls) else { return vec![] };
    if !ok(gap_tol) || !ok(min_area) {
        return vec![];
    }
    let rooms = kernel2d::detect_rooms(&w, gap_tol, min_area, offset_to_inner);
    let mut out = vec![rooms.len() as f64];
    for r in &rooms {
        push_ring(&mut out, r);
    }
    out
}

pub fn from_point(px: f64, py: f64, walls: &[f64], gap_tol: f64, offset_to_inner: bool) -> Vec<f64> {
    let Some(w) = decode_walls(walls) else { return vec![] };
    if !ok(px) || !ok(py) || !ok(gap_tol) {
        return vec![];
    }
    let mut out = vec![];
    if let Some(r) = kernel2d::room_from_point_inside(Vec2::new(px, py), &w, gap_tol, offset_to_inner) {
        push_ring(&mut out, &r);
    }
    out
}

pub fn from_point_faces(px: f64, py: f64, faces: &[f64], gap_tol: f64) -> Vec<f64> {
    let Some(f) = decode_faces(faces) else { return vec![] };
    if !ok(px) || !ok(py) || !ok(gap_tol) {
        return vec![];
    }
    let mut out = vec![];
    if let Some(r) = kernel2d::room_from_point_inside_faces(Vec2::new(px, py), &f, gap_tol) {
        push_ring(&mut out, &r);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rechteck als vier Wände (Mittellinien) mit Dicke `t`.
    fn box_walls(x: f64, y: f64, w: f64, h: f64, t: f64) -> Vec<f64> {
        let c = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
        let mut v = vec![4.0];
        for i in 0..4 {
            let (a, b) = (c[i], c[(i + 1) % 4]);
            v.extend([a[0], a[1], b[0], b[1], t]);
        }
        v
    }

    fn rooms(buf: &[f64]) -> Vec<Vec<[f64; 2]>> {
        let mut r = Reader::new(buf);
        let n = r.count().unwrap_or(0);
        (0..n).map(|_| r.ring().unwrap()).collect()
    }

    fn area(r: &[[f64; 2]]) -> f64 {
        crate::flat_read::signed_area(r)
    }

    #[test]
    fn rechteck_ein_raum_lichte_flaeche() {
        let rs = rooms(&detect(&box_walls(0.0, 0.0, 5.0, 4.0, 0.2), 0.05, 0.05, true));
        assert_eq!(rs.len(), 1);
        assert!((area(&rs[0]) - 4.8 * 3.8).abs() < 1e-9); // ccw → positiv
    }

    #[test]
    fn rohe_mittellinien_ohne_offset() {
        let rs = rooms(&detect(&box_walls(0.0, 0.0, 5.0, 4.0, 0.2), 0.05, 0.05, false));
        assert!((area(&rs[0]) - 20.0).abs() < 1e-9);
    }

    #[test]
    fn trennwand_ergibt_zwei_raeume() {
        let mut w = box_walls(0.0, 0.0, 6.0, 4.0, 0.2);
        w[0] = 5.0;
        w.extend([3.0, 0.0, 3.0, 4.0, 0.2]);
        let rs = rooms(&detect(&w, 0.05, 0.05, true));
        assert_eq!(rs.len(), 2);
        for r in &rs {
            assert!((area(r) - 2.8 * 3.8).abs() < 1e-9);
        }
    }

    #[test]
    fn luecke_wird_geschlossen_grosse_nicht() {
        // Rechteck 4×4, letzte Wand endet `gap` vor dem Start: ≤ gapTol → ein Raum, sonst keiner.
        let mk = |gap: f64| {
            vec![4.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0, 0.0, 0.0, 4.0, 0.0, gap, 0.0]
        };
        assert_eq!(rooms(&detect(&mk(0.03), 0.05, 0.05, false)).len(), 1);
        assert_eq!(rooms(&detect(&mk(0.5), 0.05, 0.05, false)).len(), 0);
    }

    #[test]
    fn zu_kleine_flaeche_und_zu_wenige_waende() {
        assert!(rooms(&detect(&box_walls(0.0, 0.0, 0.1, 0.1, 0.0), 0.05, 0.05, false)).is_empty());
        assert_eq!(detect(&[2.0, 0.0, 0.0, 1.0, 0.0, 0.1, 1.0, 0.0, 1.0, 1.0, 0.1], 0.05, 0.05, true), vec![0.0]);
    }

    #[test]
    fn klick_in_raum_kleinste_zelle() {
        let mut w = box_walls(0.0, 0.0, 6.0, 4.0, 0.2);
        w[0] = 5.0;
        w.extend([3.0, 0.0, 3.0, 4.0, 0.2]);
        let r = from_point(1.5, 2.0, &w, 0.05, true);
        let ring = Reader::new(&r).ring().unwrap();
        assert!((area(&ring) - 2.8 * 3.8).abs() < 1e-9);
        assert!(from_point(10.0, 10.0, &w, 0.05, true).is_empty());
    }

    #[test]
    fn klick_auf_wandflaechen() {
        let f = vec![4.0, 0.0, 0.0, 4.0, 0.0, 4.0, 0.0, 4.0, 3.0, 4.0, 3.0, 0.0, 3.0, 0.0, 3.0, 0.0, 0.0];
        let r = from_point_faces(2.0, 1.0, &f, 0.05);
        assert!((area(&Reader::new(&r).ring().unwrap()) - 12.0).abs() < 1e-9);
        assert!(from_point_faces(9.0, 9.0, &f, 0.05).is_empty());
    }

    #[test]
    fn unsinn_ohne_panik() {
        let nan = vec![4.0, f64::NAN, 0.0, 1.0, 0.0, 0.2, 0.0, 0.0, 1.0, 1.0, 0.2, 1.0, 1.0, 0.0, 1.0, 0.2, 0.0, 1.0, 0.0, 0.0, 0.2];
        assert!(detect(&nan, 0.05, 0.05, true).is_empty());
        assert!(detect(&[], 0.05, 0.05, true).is_empty());
        assert!(detect(&[5.0, 1.0], 0.05, 0.05, true).is_empty());
        assert!(detect(&[f64::NAN], 0.05, 0.05, true).is_empty());
        assert!(detect(&[1e300], 0.05, 0.05, true).is_empty());
        let w = box_walls(0.0, 0.0, 5.0, 4.0, 0.2);
        assert!(detect(&w, f64::NAN, 0.05, true).is_empty());
        assert!(from_point(f64::NAN, 0.0, &w, 0.05, true).is_empty());
        assert!(from_point_faces(0.0, 0.0, &[3.0], 0.05).is_empty());
        // Entartet: alle Wände identisch, Nulllänge, negative Dicke
        let _ = detect(&[3.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.0, 0.0, 0.0, 0.0, 0.2, 0.0, 0.0, 0.0, 0.0, 0.2], 0.05, 0.05, true);
        let _ = detect(&box_walls(0.0, 0.0, 5.0, 4.0, -3.0), 0.05, 0.05, true);
        let _ = detect(&box_walls(0.0, 0.0, 5.0, 4.0, 1e9), 0.05, 0.05, true);
    }
}
