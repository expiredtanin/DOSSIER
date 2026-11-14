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

/// [258] Grösste Koordinate (m, Betrag), die in die Booleans geht. i_overlay bricht bei ≥ 2^500 mit Panic ab
/// (`Invalid adapter bounds`), und lange vorher rechnet das Ganzzahlraster (Ausdehnung/2³⁰) nur noch Unsinn;
/// ein Projekt mit 1e300 m Wandlänge darf nicht den ganzen Kern lahmlegen. Weltweit liegt alles unter 1e8 m.
pub const COORD_LIMIT: f64 = 1e9;

/// Ring säubern: nur endliche Punkte, doppelten Schlusspunkt weg; `None` bei Entartung oder Punkten
/// ausserhalb von [`COORD_LIMIT`].
fn clean_ring(r: &Ring) -> Option<Ring> {
    if r.iter().any(|p| p[0].abs() > COORD_LIMIT || p[1].abs() > COORD_LIMIT) {
        return None;
    }
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

/// Gerade/ungerade Verschachtelung ([207], Kataster: Innenhöfe): Liegt ein Ring vollständig in einem anderen
/// (kein Schnitt, die meisten Punkte innen), ist er ein Loch des kleinsten umschliessenden Rings; ein Ring in
/// einem Loch ist wieder eine Fläche usw. (Tiefe gerade = Aussenring, ungerade = Loch). Sich nur überlappende
/// Ringe sind nicht verschachtelt, sie werden vereinigt. Ergebnis wie [`union`] (i_overlay, Aussenring gegen,
/// Löcher im Uhrzeigersinn).
pub fn nest_even_odd(rings: &[Ring]) -> Vec<Polygon> {
    use crate::roof_skeleton::{point_in_ring, rings_cross};
    type Entry = (f64, [f64; 4], Ring);
    let mut rs: Vec<Entry> = rings
        .iter()
        .filter_map(clean_ring)
        .map(|r| {
            let b = r.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, p| [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]);
            (signed_area(&r).abs(), b, r)
        })
        .collect();
    // Grosse zuerst: ein Umschliessender steht immer vor dem Umschlossenen.
    rs.sort_by(|a, b| b.0.total_cmp(&a.0));
    let contains = |o: &Entry, i: &Entry| -> bool {
        o.1[0] <= i.1[0] && o.1[1] <= i.1[1] && o.1[2] >= i.1[2] && o.1[3] >= i.1[3] && {
            let inside = i.2.iter().filter(|p| point_in_ring(**p, &o.2)).count();
            inside * 2 > i.2.len() && !rings_cross(&o.2, &i.2)
        }
    };
    let n = rs.len();
    // Je Ring der engste umschliessende (Index) und die Tiefe.
    let mut parent: Vec<Option<usize>> = vec![None; n];
    let mut depth = vec![0usize; n];
    for i in 0..n {
        // Umschliessende stehen vor i; von hinten (klein) nach vorn: der erste Treffer ist der engste.
        for j in (0..i).rev() {
            if rs[j].0 > rs[i].0 && contains(&rs[j], &rs[i]) {
                parent[i] = Some(j);
                depth[i] = depth[j] + 1;
                break;
            }
        }
    }
    let mut polys: Vec<Polygon> = Vec::new();
    let mut slot: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        if depth[i] % 2 == 0 {
            slot[i] = Some(polys.len());
            polys.push(vec![rs[i].2.clone()]);
        }
    }
    for i in 0..n {
        if depth[i] % 2 == 1 {
            if let Some(k) = parent[i].and_then(|j| slot[j]) {
                polys[k].push(rs[i].2.clone());
            }
        }
    }
    union(&polys)
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

    #[test]
    fn verschachtelung_gerade_ungerade() {
        let sq = |x0: f64, y0: f64, x1: f64, y1: f64| rect(x0, y0, x1, y1).remove(0);
        // Hof im Gebäude, darin ein Pavillon, daneben ein einzelnes Haus.
        let u = nest_even_odd(&[sq(0.0, 0.0, 20.0, 20.0), sq(5.0, 5.0, 15.0, 15.0), sq(8.0, 8.0, 12.0, 12.0), sq(30.0, 0.0, 40.0, 10.0)]);
        assert_eq!(u.len(), 3, "Gebäude mit Hof, Pavillon im Hof, Einzelhaus");
        let with_hole = u.iter().find(|p| p.len() == 2).expect("Hof als Loch");
        assert!((signed_area(&with_hole[0]) - 400.0).abs() < 1e-6 && (signed_area(&with_hole[1]).abs() - 100.0).abs() < 1e-6);
        assert!((area(&u) - (400.0 - 100.0 + 16.0 + 100.0)).abs() < 1e-6);
        // Nur überlappend (nicht verschachtelt): vereinigt, kein Loch.
        let v = nest_even_odd(&[sq(0.0, 0.0, 10.0, 10.0), sq(5.0, 5.0, 15.0, 15.0)]);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].len(), 1);
        assert!((area(&v) - 175.0).abs() < 1e-6);
    }

    /// [258] Koordinaten jenseits des Rechenbereichs (1e300 m) brachten i_overlay zum Panic
    /// (`Invalid adapter bounds`) und damit das WASM-Modul zum Stillstand: der Ring entfällt.
    #[test]
    fn riesige_koordinaten_ohne_panic() {
        let huge: Polygon = vec![vec![[0.0, 0.0], [1e300, 0.0], [1e300, 1e300]]];
        let r = rect(0.0, 0.0, 2.0, 2.0);
        assert!(union(&[huge.clone()]).is_empty());
        assert!(intersection(&[r.clone()], &[huge.clone()]).is_empty());
        assert!((area(&difference(&[r.clone()], &[huge])) - 4.0).abs() < 1e-6);
        // Knapp innerhalb der Grenze rechnet weiter.
        assert!(!union(&[vec![vec![[0.0, 0.0], [1e8, 0.0], [1e8, 1e8]]]]).is_empty());
    }
}
