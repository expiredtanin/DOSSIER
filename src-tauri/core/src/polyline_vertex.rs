//! Punkttypen einer Polylinie ([K4] S3, vorher `src/geometry/polylineVertexType.ts`; ArchiCAD/
//! Vectorworks-artig): Eckpunkt, Bogenpunkt, Splinepunkt. Rein als Umrechnung der Segment-Bögen
//! (`bulge`) der beiden am Punkt anliegenden Segmente — alle Renderer/Exporte verstehen Bulges
//! bereits, es gibt also kein neues Geometrie-Feld.
//!
//!  - Eckpunkt:   beide Segmente gerade (bulge 0).
//!  - Bogenpunkt: EIN Kreisbogen durch Vorgänger, Punkt und Nachfolger.
//!  - Splinepunkt: tangential glatter Übergang — die Tangente im Punkt ist parallel zur Verbindung
//!    Vorgänger→Nachfolger (wie bei einer Catmull-Rom-Kurve), beide Segmente werden zu Bögen, die
//!    diese Tangente teilen.
//!
//! Die Bögen werden über ihren SCHEITELPUNKT bestimmt und mit `bulge::from_sagitta_point` in einen
//! Bulge übersetzt — so bleibt die Vorzeichen-Konvention an EINER Stelle. Rechenreihenfolge und
//! Zahlsemantik wie in der früheren TS-Fassung (`Math.hypot`/`sin`/`cos`/`atan2`/`tan` über
//! `jsmath`/`jsnum`), Ergebnis bitgleich.

use crate::jsmath::hypot2;
use crate::jsnum;

type P = (f64, f64);

const EPS: f64 = 1e-9;

/// Punkttyp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VertexType {
    Corner,
    Arc,
    Spline,
}

impl VertexType {
    pub fn parse(s: &str) -> Option<VertexType> {
        match s {
            "corner" => Some(VertexType::Corner),
            "arc" => Some(VertexType::Arc),
            "spline" => Some(VertexType::Spline),
            _ => None,
        }
    }

    /// Kennzahl für die flache Grenze (0 Ecke, 1 Bogen, 2 Spline).
    pub fn code(self) -> f64 {
        match self {
            VertexType::Corner => 0.0,
            VertexType::Arc => 1.0,
            VertexType::Spline => 2.0,
        }
    }
}

/// Polylinie: Punkte, geschlossen, Bulge je Segment (fehlend = 0).
pub struct Poly<'a> {
    pub pts: &'a [P],
    pub closed: bool,
    pub bulge: &'a [f64],
}

impl Poly<'_> {
    fn b(&self, k: Option<usize>) -> f64 {
        k.and_then(|k| self.bulge.get(k).copied()).unwrap_or(0.0)
    }

    /// Indizes des ein- und ausgehenden Segments von Punkt `i` (None = keins).
    fn adjacent(&self, i: usize) -> (Option<usize>, Option<usize>) {
        let n = self.pts.len();
        let in_seg = if i > 0 { Some(i - 1) } else if self.closed { Some(n - 1) } else { None };
        let out_seg = if i + 1 < n { Some(i) } else if self.closed { Some(n - 1) } else { None };
        (in_seg, out_seg)
    }

    /// Nachbarpunkte von `i` (None an offenen Enden).
    fn neighbors(&self, i: usize) -> (Option<P>, Option<P>) {
        let n = self.pts.len();
        let prev = if i > 0 { Some(self.pts[i - 1]) } else if self.closed { Some(self.pts[n - 1]) } else { None };
        let next = if i + 1 < n { Some(self.pts[i + 1]) } else if self.closed { Some(self.pts[0]) } else { None };
        (prev, next)
    }
}

/// Punkt-Index aus einer JS-Zahl: nur ganze Zahlen im Bereich (sonst kein Punkt).
pub fn index_of(i: f64, n: usize) -> Option<usize> {
    (i.fract() == 0.0 && i >= 0.0 && i < n as f64).then_some(i as usize)
}

fn sub(a: P, b: P) -> P {
    (a.0 - b.0, a.1 - b.1)
}

fn cross(a: P, b: P) -> f64 {
    a.0 * b.1 - a.1 * b.0
}

/// `Math.sign`.
fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// `x || 1` für Zahlen (0, −0, NaN → 1).
fn or_one(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() {
        1.0
    } else {
        x
    }
}

/// Bogen-Parameter `[cx, cy, r, a0, a1, sweep]` (wie `bulgeArc` in TS), None = gerade/entartet.
fn bulge_arc(a: P, b: P, bulge: f64) -> Option<[f64; 6]> {
    if !(bulge.abs() >= EPS) {
        return None;
    }
    let r = crate::bulge::arc(a.0, a.1, b.0, b.1, bulge);
    (r.len() >= 6).then(|| [r[0], r[1], r[2], r[3], r[4], r[5]])
}

fn from_sagitta(a: P, b: P, p: P) -> f64 {
    crate::bulge::from_sagitta_point(a.0, a.1, b.0, b.1, p.0, p.1)
}

/// Umkreismittelpunkt von a, b, c (None bei kollinearen Punkten).
fn circumcenter(a: P, b: P, c: P) -> Option<P> {
    let d = 2.0 * (a.0 * (b.1 - c.1) + b.0 * (c.1 - a.1) + c.0 * (a.1 - b.1));
    if d.abs() < EPS {
        return None;
    }
    let (a2, b2, c2) = (a.0 * a.0 + a.1 * a.1, b.0 * b.0 + b.1 * b.1, c.0 * c.0 + c.1 * c.1);
    Some((
        (a2 * (b.1 - c.1) + b2 * (c.1 - a.1) + c2 * (a.1 - b.1)) / d,
        (a2 * (c.0 - b.0) + b2 * (a.0 - c.0) + c2 * (b.0 - a.0)) / d,
    ))
}

/// Bulge des Kreisbogens a→b auf dem Kreis um `c`, und zwar des Bogens, der NICHT durch `other`
/// läuft (Scheitel auf der anderen Seite der Sehne als `other`).
fn bulge_on_circle(a: P, b: P, c: P, other: P) -> f64 {
    let r = hypot2(a.0 - c.0, a.1 - c.1);
    let mid = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
    let mut u = sub(mid, c);
    let mut len = hypot2(u.0, u.1);
    if len < EPS {
        let d = sub(b, a);
        u = (-d.1, d.0);
        len = hypot2(u.0, u.1);
    }
    u = (u.0 / len, u.1 / len);
    let side = |p: P| sign(cross(sub(b, a), sub(p, a)));
    let cand1 = (c.0 + u.0 * r, c.1 + u.1 * r);
    let cand2 = (c.0 - u.0 * r, c.1 - u.1 * r);
    let apex = if side(cand1) != side(other) { cand1 } else { cand2 };
    from_sagitta(a, b, apex)
}

/// Tangente (Fahrtrichtung a→b) des Bulge-Bogens am Anfang bzw. Ende.
fn arc_tangent(a: P, b: P, bulge: f64, at_end: bool) -> P {
    let Some(arc) = bulge_arc(a, b, bulge) else {
        let d = sub(b, a);
        let l = or_one(hypot2(d.0, d.1));
        return (d.0 / l, d.1 / l);
    };
    let ang = if at_end { arc[3] + arc[5] } else { arc[3] };
    let s = or_one(sign(arc[5]));
    (-jsnum::sin(ang) * s, jsnum::cos(ang) * s)
}

/// Bulge des Bogens a→b mit gegebener Tangente `t` am Ende (`at_end`) bzw. Anfang. Betrag aus dem
/// Winkel Sehne↔Tangente, Vorzeichen NUMERISCH gewählt (die Variante, deren tatsächliche Tangente zu
/// `t` passt).
fn bulge_with_tangent(a: P, b: P, t: P, at_end: bool) -> f64 {
    let c = sub(b, a);
    let ang = jsnum::atan2(cross(c, t), c.0 * t.0 + c.1 * t.1).abs();
    let mag = bulge_from_apex_angle(a, b, ang).abs();
    if mag < 1e-9 {
        return 0.0;
    }
    let dot = |v: P| v.0 * t.0 + v.1 * t.1;
    if dot(arc_tangent(a, b, mag, at_end)) >= dot(arc_tangent(a, b, -mag, at_end)) {
        mag
    } else {
        -mag
    }
}

/// Bogen über der Sehne a→b mit halbem Öffnungswinkel |half| (Sehne↔Tangente); Vorzeichen: >0 Scheitel
/// links der Sehne, <0 rechts. Über den Scheitelpunkt in einen Bulge übersetzt.
fn bulge_from_apex_angle(a: P, b: P, half: f64) -> f64 {
    if half.abs() < 1e-6 {
        return 0.0;
    }
    // Begrenzen: knapp unter einem Halbkreis je Segment (sonst kippt der Bogen).
    let h2 = jsnum::max(-std::f64::consts::PI / 2.0 + 0.01, jsnum::min(std::f64::consts::PI / 2.0 - 0.01, half));
    let d = sub(b, a);
    let chord = hypot2(d.0, d.1);
    if chord < EPS {
        return 0.0;
    }
    let left = (-d.1 / chord, d.0 / chord);
    let s = (chord / 2.0) * jsnum::tan(h2 / 2.0); // Pfeilhöhe
    let apex = ((a.0 + b.0) / 2.0 + left.0 * s, (a.1 + b.1) / 2.0 + left.1 * s);
    from_sagitta(a, b, apex)
}

/// Ist Punkttyp `t` am Punkt `i` möglich? (Bogen/Spline brauchen beide Nachbarn.)
pub fn can_set(g: &Poly, i: usize, t: VertexType) -> bool {
    if i >= g.pts.len() {
        return false;
    }
    if t == VertexType::Corner {
        return true;
    }
    let (prev, next) = g.neighbors(i);
    prev.is_some() && next.is_some()
}

/// Aktueller Typ (Heuristik): beide Nachbarsegmente gerade → Eckpunkt, sonst None (gemischt).
pub fn type_of(g: &Poly, i: usize) -> Option<VertexType> {
    if i >= g.pts.len() {
        return None;
    }
    let (in_seg, out_seg) = g.adjacent(i);
    if g.b(in_seg).abs() < 1e-9 && g.b(out_seg).abs() < 1e-9 {
        return Some(VertexType::Corner);
    }
    let (prev, next) = g.neighbors(i);
    let (Some(prev), Some(next), Some(_), Some(_)) = (prev, next, in_seg, out_seg) else { return None };
    let a1 = bulge_arc(prev, g.pts[i], g.b(in_seg));
    let a2 = bulge_arc(g.pts[i], next, g.b(out_seg));
    match (a1, a2) {
        (Some(a1), Some(a2)) if hypot2(a1[0] - a2[0], a1[1] - a2[1]) < 1e-6 * (1.0 + a1[2]) => Some(VertexType::Arc),
        _ => Some(VertexType::Spline),
    }
}

/// Neue Bulge-Liste (je Segment) mit Punkttyp `t` an Punkt `i`.
pub fn with_type(g: &Poly, i: usize, t: VertexType) -> Vec<f64> {
    let n = g.pts.len();
    let seg_count = if g.closed { n } else { n.saturating_sub(1) };
    let mut bulge: Vec<f64> = (0..seg_count).map(|k| g.b(Some(k))).collect();
    if !can_set(g, i, t) {
        return bulge;
    }
    let (in_seg, out_seg) = g.adjacent(i);
    let q = g.pts[i];
    let (prev, next) = g.neighbors(i);
    let mut put = |k: Option<usize>, v: f64| {
        if let Some(x) = k.and_then(|k| bulge.get_mut(k)) {
            *x = v;
        }
    };
    let (Some(p), Some(r)) = (prev, next) else {
        // Eckpunkt an einem offenen Ende.
        put(in_seg, 0.0);
        put(out_seg, 0.0);
        return bulge;
    };
    match t {
        VertexType::Corner => {
            put(in_seg, 0.0);
            put(out_seg, 0.0);
        }
        VertexType::Arc => match circumcenter(p, q, r) {
            None => {
                put(in_seg, 0.0);
                put(out_seg, 0.0);
            }
            Some(c) => {
                put(in_seg, bulge_on_circle(p, q, c, r));
                put(out_seg, bulge_on_circle(q, r, c, p));
            }
        },
        VertexType::Spline => {
            // Tangente parallel zu prev→next.
            let tv = sub(r, p);
            let tl = hypot2(tv.0, tv.1);
            if tl < EPS {
                return bulge;
            }
            let tu = (tv.0 / tl, tv.1 / tl);
            put(in_seg, bulge_with_tangent(p, q, tu, true));
            put(out_seg, bulge_with_tangent(q, r, tu, false));
        }
    }
    bulge
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: [P; 4] = [(0.0, 0.0), (2.0, 1.0), (4.0, 0.0), (6.0, 1.0)];

    fn poly<'a>(pts: &'a [P], closed: bool, bulge: &'a [f64]) -> Poly<'a> {
        Poly { pts, closed, bulge }
    }

    fn tangent(a: P, b: P, bulge: f64, at_end: bool) -> f64 {
        let arc = bulge_arc(a, b, bulge).unwrap();
        let ang = if at_end { arc[3] + arc[5] } else { arc[3] };
        let sg = sign(arc[5]);
        (ang.cos() * sg).atan2(-ang.sin() * sg)
    }

    #[test]
    fn eckpunkt_setzt_beide_nachbarsegmente_gerade() {
        assert_eq!(with_type(&poly(&G, false, &[0.3, -0.2, 0.1]), 1, VertexType::Corner), vec![0.0, 0.0, 0.1]);
    }

    #[test]
    fn bogenpunkt_beide_segmente_auf_einem_kreis() {
        let g = poly(&G, false, &[]);
        let b = with_type(&g, 1, VertexType::Arc);
        let a1 = bulge_arc(G[0], G[1], b[0]).unwrap();
        let a2 = bulge_arc(G[1], G[2], b[1]).unwrap();
        assert!(hypot2(a1[0] - a2[0], a1[1] - a2[1]) < 1e-6);
        assert!((a1[2] - a2[2]).abs() < 1e-6);
        assert_eq!(type_of(&poly(&G, false, &b), 1), Some(VertexType::Arc));
        // Der Bogen baucht NACH OBEN aus (Punkt 1 liegt oben): Scheitel über der Sehne.
        let pts = crate::bulge::arc_points(G[0].0, G[0].1, G[1].0, G[1].1, b[0]);
        let k = pts.len() / 4;
        assert!(pts[2 * k + 1] > 0.5);
    }

    #[test]
    fn splinepunkt_tangenten_stimmen_ueberein() {
        let pts = [(0.0, 0.0), (2.0, 1.0), (5.0, 0.2)];
        let b = with_type(&poly(&pts, false, &[]), 1, VertexType::Spline);
        let t1 = tangent(pts[0], pts[1], b[0], true);
        let t2 = tangent(pts[1], pts[2], b[1], false);
        assert!((t1 - t2).abs() < 1e-6);
        assert!((t2 - 0.2f64.atan2(5.0)).abs() < 1e-6);
        assert_eq!(type_of(&poly(&pts, false, &b), 1), Some(VertexType::Spline));
    }

    #[test]
    fn offene_enden_und_geschlossene_polylinie() {
        let g = poly(&G, false, &[]);
        assert!(!can_set(&g, 0, VertexType::Arc));
        assert!(!can_set(&g, 3, VertexType::Spline));
        assert!(can_set(&g, 0, VertexType::Corner));
        assert!(!can_set(&g, 4, VertexType::Corner));
        let sq = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
        let b = with_type(&poly(&sq, true, &[]), 0, VertexType::Arc);
        assert_eq!(b.len(), 4);
        assert!(b[3] != 0.0 && b[0] != 0.0);
        assert_eq!(b[1], 0.0);
        // Kollinear: kein Kreis → gerade.
        let line = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)];
        assert_eq!(with_type(&poly(&line, false, &[0.2, 0.3]), 1, VertexType::Arc), vec![0.0, 0.0]);
        assert_eq!(index_of(1.5, 4), None);
        assert_eq!(index_of(3.0, 4), Some(3));
    }
}
