//! Polygon-Booleans (Vereinigung, Differenz, Schnitt) über `i_overlay` — ersetzt die JS-Bibliothek
//! `polygon-clipping` im TS-Kern (Schatten, Baurecht, Bemassung, Dächer, Aussparungen, 2D-Booleans).
//!
//! Semantik wie `polygon-clipping`: Mehrere Eingabepolygone werden unabhängig von ihrem
//! Umlaufsinn vereinigt. Dazu wird jedes Polygon ausgerichtet (Aussenring gegen, Löcher im
//! Uhrzeigersinn) und mit der Non-Zero-Regel gerechnet. Ergebnis: Aussenring gegen den
//! Uhrzeigersinn, Löcher im Uhrzeigersinn, Ringe offen; ungültige Punkte (NaN/∞) und
//! entartete Ringe (< 3 Punkte, Fläche 0) werden vorher verworfen.

use crate::flat::{Polygon, Ring};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

fn signed_area(r: &Ring) -> f64 {
    let n = r.len();
    let mut a = 0.0;
    for i in 0..n {
        let p = r[i];
        let q = r[(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
    }
    a / 2.0
}

/// Ring säubern: nur endliche Punkte, doppelten Schlusspunkt weg; `None` bei Entartung.
fn clean_ring(r: &Ring) -> Option<Ring> {
    let mut out: Ring = r.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
    while out.len() > 1 && out.first() == out.last() {
        out.pop();
    }
    if out.len() < 3 || signed_area(&out).abs() < 1e-18 {
        return None;
    }
    Some(out)
}

/// Polygon ausrichten: Aussenring CCW, Löcher CW. Ohne gültigen Aussenring `None`.
fn orient(p: &Polygon) -> Option<Polygon> {
    let mut rings = p.iter();
    let mut outer = clean_ring(rings.next()?)?;
    if signed_area(&outer) < 0.0 {
        outer.reverse();
    }
    let mut out = vec![outer];
    for r in rings {
        if let Some(mut h) = clean_ring(r) {
            if signed_area(&h) > 0.0 {
                h.reverse();
            }
            out.push(h);
        }
    }
    Some(out)
}

fn prepare(polys: &[Polygon]) -> Vec<Polygon> {
    polys.iter().filter_map(orient).collect()
}

fn run(subj: &[Polygon], clip: &[Polygon], rule: OverlayRule) -> Vec<Polygon> {
    let s = prepare(subj);
    let c = prepare(clip);
    if s.is_empty() && !matches!(rule, OverlayRule::Union) {
        return vec![];
    }
    if s.is_empty() && c.is_empty() {
        return vec![];
    }
    s.overlay(&c, rule, FillRule::NonZero)
}

/// Vereinigung aller Polygone.
pub fn union(polys: &[Polygon]) -> Vec<Polygon> {
    run(polys, &[], OverlayRule::Union)
}

/// `a` minus Vereinigung von `b`.
pub fn difference(a: &[Polygon], b: &[Polygon]) -> Vec<Polygon> {
    if b.is_empty() {
        return union(a);
    }
    run(a, b, OverlayRule::Difference)
}

/// Schnitt von `a` und `b`.
pub fn intersection(a: &[Polygon], b: &[Polygon]) -> Vec<Polygon> {
    run(a, b, OverlayRule::Intersect)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Polygon {
        vec![vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]
    }
    fn area(polys: &[Polygon]) -> f64 {
        polys.iter().map(|p| p.iter().map(signed_area).sum::<f64>()).sum()
    }

    #[test]
    fn vereinigung_ueberlappend_und_gemischter_umlaufsinn() {
        let mut b = rect(1.0, 0.0, 3.0, 1.0);
        b[0].reverse(); // im Uhrzeigersinn
        let u = union(&[rect(0.0, 0.0, 2.0, 1.0), b]);
        assert_eq!(u.len(), 1);
        assert!((area(&u) - 3.0).abs() < 1e-9);
        assert!(signed_area(&u[0][0]) > 0.0);
    }

    #[test]
    fn differenz_erzeugt_loch() {
        let d = difference(&[rect(0.0, 0.0, 4.0, 4.0)], &[rect(1.0, 1.0, 2.0, 2.0)]);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].len(), 2);
        assert!(signed_area(&d[0][1]) < 0.0);
        assert!((area(&d) - 15.0).abs() < 1e-9);
    }

    #[test]
    fn schnitt_und_leer() {
        let i = intersection(&[rect(0.0, 0.0, 2.0, 2.0)], &[rect(1.0, 1.0, 3.0, 3.0)]);
        assert!((area(&i) - 1.0).abs() < 1e-9);
        assert!(intersection(&[rect(0.0, 0.0, 1.0, 1.0)], &[rect(2.0, 2.0, 3.0, 3.0)]).is_empty());
        assert!(difference(&[], &[rect(0.0, 0.0, 1.0, 1.0)]).is_empty());
        assert!(union(&[]).is_empty());
    }

    #[test]
    fn unsinn_wird_verworfen() {
        let bad = vec![vec![[f64::NAN, 0.0], [1.0, 0.0]]];
        assert!(union(&[bad]).is_empty());
        let degenerate = vec![vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]]];
        assert!(union(&[degenerate]).is_empty());
        // Doppelter Schlusspunkt wie in polygon-clipping-Eingaben.
        let closed = vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]];
        assert!((area(&union(&[closed])) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn buendige_kanten() {
        // Zwei Rechtecke mit gemeinsamer Kante → ein Polygon ohne Naht.
        let u = union(&[rect(0.0, 0.0, 1.0, 1.0), rect(1.0, 0.0, 2.0, 1.0)]);
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].len(), 1);
        assert!((area(&u) - 2.0).abs() < 1e-9);
    }
}
