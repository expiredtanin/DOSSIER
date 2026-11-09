//! [169] Bögen in Linienzügen erkennen: Die Plan-Erzeugung rechnet mit Vielecken (runde Stütze, Bogenwand,
//! Bogen-Umrisse von Decken/Dächern, Booleans); die Ausgaben (Plan-SVG, Druck-SVG/PDF, DXF/DWG, Bildschirm)
//! sollen echte Kreise und Bögen zeigen. [`fit`] zerlegt einen offenen oder geschlossenen Zug in Strecken
//! und Bögen: mindestens vier aufeinanderfolgende Punkte auf einem Kreis (Abstand ≤ `tol`), gleicher
//! Drehsinn, Winkelschritt je Kante ≤ [`MAX_STEP`] — Rechtecke, Achtecke und schwach geknickte Züge
//! bleiben Strecken. [`refine`] tesselliert erkannte Bögen fein nach (Bildschirm), [`svg_d`] schreibt
//! SVG-Pfade (`A`), [`bulges`] die Bulges einer LWPOLYLINE (DXF).

use crate::hatch::V2;
use crate::jsnum;
use std::f64::consts::PI;

/// Grösster Winkelschritt (25°) einer Kante, die noch als Teil eines Bogens gilt. Bogenwände zerlegen
/// mit höchstens 7.5° (`wall_arc::MAX_STEP`), Stützen mit höchstens 7.5°; ein regelmässiges 14-Eck nicht.
pub const MAX_STEP: f64 = 25.0 * PI / 180.0;
/// Standard-Toleranz in Modell-Metern (i_overlay rastert auf ≈ Ausdehnung/2³⁰).
pub const TOL: f64 = 1e-5;
/// Kleinster/grösster Radius eines erkannten Bogens als Vielfaches der Toleranz (bei [`TOL`]: 0.1 mm … 1 km).
const R_MIN_TOL: f64 = 10.0;
const R_MAX_TOL: f64 = 1e8;
/// Kleinste Pfeilhöhe eines erkannten Bogens als Vielfaches der Toleranz (bei [`TOL`]: 0.5 mm): fast gerade,
/// leicht verrauschte Züge (Geländelinie in der Ansicht) bleiben Strecken.
const SAGITTA_TOL: f64 = 50.0;

/// Ein Stück ab dem Ende des vorigen (bzw. ab `start`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Seg {
    Line { b: V2 },
    /// Kreisbogen bis `b` um `c`, Radius `r`, Drehwinkel `sweep` (positiv = gegen den Uhrzeiger, Y nach oben),
    /// |sweep| ≤ π (längere Bögen sind geteilt).
    Arc { b: V2, c: V2, r: f64, sweep: f64 },
}

impl Seg {
    pub fn end(&self) -> V2 {
        match *self {
            Seg::Line { b } | Seg::Arc { b, .. } => b,
        }
    }
}

/// Ergebnis von [`fit`].
#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    /// Ganzer Kreis (geschlossener Zug); `a0` = Winkel des ersten Punkts.
    Circle { c: V2, r: f64, a0: f64 },
    /// Zug ab `start`; geschlossen endet das letzte Stück wieder in `start`.
    Path { start: V2, segs: Vec<Seg>, closed: bool },
}

fn dist(a: V2, b: V2) -> f64 {
    crate::jsmath::hypot2(b.x - a.x, b.y - a.y)
}

/// Umkreis dreier Punkte; `None` bei (fast) kollinearen.
fn circ(a: V2, b: V2, c: V2, tol: f64) -> Option<(V2, f64)> {
    let (bx, by, cx, cy) = (b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
    let d = 2.0 * (bx * cy - by * cx);
    let s = (bx * bx + by * by).max(cx * cx + cy * cy);
    if !(d.abs() > 1e-12 * s) || !d.is_finite() {
        return None;
    }
    let (b2, c2) = (bx * bx + by * by, cx * cx + cy * cy);
    let ux = (cy * b2 - by * c2) / d;
    let uy = (bx * c2 - cx * b2) / d;
    let r = crate::jsmath::hypot2(ux, uy);
    (r.is_finite() && (R_MIN_TOL * tol..=R_MAX_TOL * tol).contains(&r)).then_some((V2 { x: a.x + ux, y: a.y + uy }, r))
}

/// Vorzeichenbehafteter Winkel von `p` nach `q` um `c`, in (−π, π].
fn step(c: V2, p: V2, q: V2) -> f64 {
    let a = jsnum::atan2(p.y - c.y, p.x - c.x);
    let b = jsnum::atan2(q.y - c.y, q.x - c.x);
    let mut d = b - a;
    while d > PI {
        d -= 2.0 * PI;
    }
    while d <= -PI {
        d += 2.0 * PI;
    }
    d
}

fn step_ok(s: f64, sign: f64) -> bool {
    s.abs() > 1e-9 && s.abs() <= MAX_STEP && s * sign > 0.0
}

/// Längster Bogen ab `q[i]`: `(j, Mitte, Radius, Drehwinkel)` mit `j ≥ i + 3`.
fn try_arc(q: &[V2], i: usize, tol: f64) -> Option<(usize, V2, f64, f64)> {
    let m = q.len() - 1;
    if i + 3 > m {
        return None;
    }
    let (c, r) = circ(q[i], q[i + 1], q[i + 2], tol)?;
    let s1 = step(c, q[i], q[i + 1]);
    let sign = s1.signum();
    let s2 = step(c, q[i + 1], q[i + 2]);
    if !step_ok(s1, sign) || !step_ok(s2, sign) {
        return None;
    }
    let mut sweep = s1 + s2;
    let mut j = i + 2;
    while j < m {
        let p = q[j + 1];
        let s = step(c, q[j], p);
        if (dist(c, p) - r).abs() > tol || !step_ok(s, sign) || (sweep + s).abs() >= 2.0 * PI - 1e-6 {
            break;
        }
        sweep += s;
        j += 1;
    }
    if j < i + 3 {
        return None;
    }
    // Genauerer Kreis aus Anfang, Mitte und Ende, falls er alle Punkte hält.
    let (mut c, mut r) = (c, r);
    if let Some((c2, r2)) = circ(q[i], q[(i + j) / 2], q[j], tol) {
        if q[i..=j].iter().all(|p| (dist(c2, *p) - r2).abs() <= tol) {
            c = c2;
            r = r2;
            sweep = (i..j).map(|k| step(c, q[k], q[k + 1])).sum();
        }
    }
    // Fast gerade (Pfeilhöhe kaum über der Toleranz): Strecken.
    if r * (1.0 - jsnum::cos(sweep.abs().min(PI) / 2.0)) <= SAGITTA_TOL * tol {
        return None;
    }
    Some((j, c, r, sweep))
}

/// Offener Zug → Stücke (mit mindestens einem Bogen, sonst `None`).
fn fit_open(q: &[V2], tol: f64) -> Option<Vec<Seg>> {
    let m = q.len().checked_sub(1)?;
    let mut segs = Vec::with_capacity(m);
    let mut any = false;
    let mut i = 0;
    while i < m {
        if let Some((j, c, r, sweep)) = try_arc(q, i, tol) {
            any = true;
            if sweep.abs() > PI {
                // In zwei Bögen teilen (SVG/DXF rechnen mit höchstens einem Halbkreis stabil).
                let mut acc = 0.0;
                let mut k = i;
                while k < j - 1 && (acc + step(c, q[k], q[k + 1])).abs() <= sweep.abs() / 2.0 {
                    acc += step(c, q[k], q[k + 1]);
                    k += 1;
                }
                let k = k.max(i + 1);
                let s1 = (i..k).map(|t| step(c, q[t], q[t + 1])).sum();
                segs.push(Seg::Arc { b: q[k], c, r, sweep: s1 });
                segs.push(Seg::Arc { b: q[j], c, r, sweep: sweep - s1 });
            } else {
                segs.push(Seg::Arc { b: q[j], c, r, sweep });
            }
            i = j;
        } else {
            segs.push(Seg::Line { b: q[i + 1] });
            i += 1;
        }
    }
    any.then_some(segs)
}

/// Ganzer Kreis? Alle Punkte auf einem Kreis, gleicher Drehsinn, Schritte ≤ [`MAX_STEP`], einmal herum.
fn full_circle(p: &[V2], tol: f64) -> Option<(V2, f64)> {
    let n = p.len();
    if n < 8 {
        return None;
    }
    let (c, r) = circ(p[0], p[n / 3], p[2 * n / 3], tol)?;
    if p.iter().any(|q| (dist(c, *q) - r).abs() > tol) {
        return None;
    }
    let sign = step(c, p[0], p[1]).signum();
    let mut total = 0.0;
    for k in 0..n {
        let s = step(c, p[k], p[(k + 1) % n]);
        if !step_ok(s, sign) {
            return None;
        }
        total += s;
    }
    ((total.abs() - 2.0 * PI).abs() < 1e-6).then_some((c, r))
}

/// Zerlegt `pts` in Strecken und Bögen; `None`, wenn kein Bogen erkannt wurde (dann bleibt der Zug wie er ist).
/// Geschlossen: `pts` ohne wiederholten Anfangspunkt.
pub fn fit(pts: &[V2], closed: bool, tol: f64) -> Option<Shape> {
    if pts.len() < 4 || !pts.iter().all(|p| p.x.is_finite() && p.y.is_finite()) {
        return None;
    }
    if !closed {
        let segs = fit_open(pts, tol)?;
        return Some(Shape::Path { start: pts[0], segs, closed: false });
    }
    let mut pts = pts.to_vec();
    if pts.len() > 1 && dist(pts[0], pts[pts.len() - 1]) <= 1e-12 {
        pts.pop();
    }
    let n = pts.len();
    if n < 4 {
        return None;
    }
    if let Some((c, r)) = full_circle(&pts, tol) {
        return Some(Shape::Circle { c, r, a0: jsnum::atan2(pts[0].y - c.y, pts[0].x - c.x) });
    }
    // Anfang an der schärfsten Ecke (ein Bogen läuft dort nicht durch).
    let turn = |k: usize| {
        let (a, b, c) = (pts[(k + n - 1) % n], pts[k], pts[(k + 1) % n]);
        let (ux, uy, vx, vy) = (b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y);
        jsnum::atan2(ux * vy - uy * vx, ux * vx + uy * vy).abs()
    };
    let s = (0..n).fold(0, |best, k| if turn(k) > turn(best) + 1e-12 { k } else { best });
    let q: Vec<V2> = (0..=n).map(|k| pts[(s + k) % n]).collect();
    let segs = fit_open(&q, tol)?;
    let start = q[0];
    Some(Shape::Path { start, segs, closed: true })
}

/// Länge eines Zugs mit Bögen.
pub fn length(s: &Shape) -> f64 {
    match s {
        Shape::Circle { r, .. } => 2.0 * PI * r,
        Shape::Path { start, segs, .. } => {
            let mut at = *start;
            let mut l = 0.0;
            for g in segs {
                l += match *g {
                    Seg::Line { b } => dist(at, b),
                    Seg::Arc { r, sweep, .. } => r * sweep.abs(),
                };
                at = g.end();
            }
            l
        }
    }
}

/// Segmentzahl für den Bildschirm ohne Zoom-Kenntnis: Schritt ≤ 2° und Pfeilhöhe ≤ 0.05 mm (höchstens 1024).
pub fn fine_segments(r: f64, sweep_abs: f64) -> usize {
    let c = (1.0 - 5e-5 / r.max(1e-6)).clamp(-1.0, 1.0);
    let step = (2.0 * jsnum::acos(c)).clamp(1e-4, PI / 90.0);
    ((sweep_abs / step).ceil() as usize).clamp(1, 1024)
}

/// Punkte eines Bogens ab `a` (ohne `a`, mit `b` exakt am Ende).
fn arc_points(a: V2, b: V2, c: V2, r: f64, sweep: f64, n: usize, out: &mut Vec<V2>) {
    let a0 = jsnum::atan2(a.y - c.y, a.x - c.x);
    for k in 1..n {
        let t = a0 + sweep * k as f64 / n as f64;
        out.push(V2 { x: c.x + r * jsnum::cos(t), y: c.y + r * jsnum::sin(t) });
    }
    out.push(b);
}

/// Erkannte Bögen fein nachtesselliert (`segments(r, |sweep|)` je Bogen); `None` = nichts erkannt.
/// Geschlossen ohne wiederholten Anfangspunkt (wie die Eingabe).
pub fn refine(pts: &[V2], closed: bool, tol: f64, segments: &dyn Fn(f64, f64) -> usize) -> Option<Vec<V2>> {
    let shape = fit(pts, closed, tol)?;
    let mut out = Vec::new();
    match shape {
        Shape::Circle { c, r, a0 } => {
            let n = segments(r, 2.0 * PI).max(8);
            for k in 0..n {
                let t = a0 + 2.0 * PI * k as f64 / n as f64;
                out.push(V2 { x: c.x + r * jsnum::cos(t), y: c.y + r * jsnum::sin(t) });
            }
        }
        Shape::Path { start, segs, closed } => {
            out.push(start);
            let mut at = start;
            for g in &segs {
                match *g {
                    Seg::Line { b } => out.push(b),
                    Seg::Arc { b, c, r, sweep } => arc_points(at, b, c, r, sweep, segments(r, sweep.abs()).max(1), &mut out),
                }
                at = g.end();
            }
            if closed {
                out.pop();
            }
        }
    }
    Some(out)
}

/// SVG-Pfad (`d`) eines Zugs mit Bögen aus Modellpunkten (Y nach oben). `map` bildet sie auf die Ausgabe ab
/// (Y gespiegelt: ein Bogen gegen den Uhrzeiger im Modell ist im SVG `sweep-flag` 0), `k` = Ausgabe-Einheiten
/// je Meter (Radius), `fmt` formatiert Zahlen.
pub fn svg_d(s: &Shape, map: &dyn Fn(V2) -> V2, k: f64, fmt: &dyn Fn(f64) -> String) -> String {
    svg_d_with(s, map, k, fmt, false)
}

/// Wie [`svg_d`], `y_down` = die Punkte liegen schon im SVG-Raum (Y nach unten, z. B. Papier-mm).
pub fn svg_d_with(s: &Shape, map: &dyn Fn(V2) -> V2, k: f64, fmt: &dyn Fn(f64) -> String, y_down: bool) -> String {
    let ccw_flag = if y_down { 1 } else { 0 };
    let mut d = String::new();
    let pt = |d: &mut String, p: V2| {
        let q = map(p);
        d.push_str(&fmt(q.x));
        d.push(' ');
        d.push_str(&fmt(q.y));
    };
    match s {
        Shape::Circle { c, r, .. } => {
            // Zwei Halbkreise (ein einzelner `A` mit gleichem Anfang und Ende zeichnet nichts).
            let a = V2 { x: c.x + r, y: c.y };
            let b = V2 { x: c.x - r, y: c.y };
            let rr = fmt(r * k);
            d.push('M');
            d.push(' ');
            pt(&mut d, a);
            for e in [b, a] {
                d.push_str(&format!(" A {rr} {rr} 0 0 {ccw_flag} "));
                pt(&mut d, e);
            }
            d.push_str(" Z");
        }
        Shape::Path { start, segs, closed } => {
            d.push_str("M ");
            pt(&mut d, *start);
            let n = segs.len();
            for (i, g) in segs.iter().enumerate() {
                match *g {
                    Seg::Line { b } => {
                        if *closed && i + 1 == n {
                            break;
                        }
                        d.push_str(" L ");
                        pt(&mut d, b);
                    }
                    Seg::Arc { b, r, sweep, .. } => {
                        let rr = fmt(r * k);
                        let large = if sweep.abs() > PI { 1 } else { 0 };
                        let flag = if sweep > 0.0 { ccw_flag } else { 1 - ccw_flag };
                        d.push_str(&format!(" A {rr} {rr} 0 {large} {flag} "));
                        pt(&mut d, b);
                    }
                }
            }
            if *closed {
                d.push_str(" Z");
            }
        }
    }
    d
}

/// LWPOLYLINE-Ecken und Bulges (tan(Drehwinkel/4), positiv gegen den Uhrzeiger); geschlossen ohne
/// wiederholten Anfangspunkt (der letzte Bulge gilt der Schlusskante). Kreise → `None` (CIRCLE).
pub fn bulges(s: &Shape) -> Option<(Vec<V2>, Vec<f64>)> {
    let Shape::Path { start, segs, closed } = s else { return None };
    let mut v = vec![*start];
    let mut b = Vec::with_capacity(segs.len() + 1);
    for g in segs {
        v.push(g.end());
        b.push(match *g {
            Seg::Line { .. } => 0.0,
            Seg::Arc { sweep, .. } => jsnum::tan(sweep / 4.0),
        });
    }
    if *closed {
        v.pop();
    } else {
        b.push(0.0);
    }
    Some((v, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(c: V2, r: f64, n: usize) -> Vec<V2> {
        (0..n).map(|i| {
            let t = 2.0 * PI * i as f64 / n as f64;
            V2 { x: c.x + r * t.cos(), y: c.y + r * t.sin() }
        }).collect()
    }

    #[test]
    fn stuetze_32_eck_ist_kreis() {
        let p = ring(V2 { x: 3.0, y: -2.0 }, 0.15, 32);
        match fit(&p, true, TOL) {
            Some(Shape::Circle { c, r, .. }) => {
                assert!((c.x - 3.0).abs() < 1e-9 && (c.y + 2.0).abs() < 1e-9 && (r - 0.15).abs() < 1e-9);
            }
            o => panic!("{o:?}"),
        }
        // Offen (Dreiviertelkreis) Bögen.
        let open: Vec<V2> = p[..25].to_vec();
        let Some(Shape::Path { segs, .. }) = fit(&open, false, TOL) else { panic!() };
        assert!(segs.iter().all(|s| matches!(s, Seg::Arc { .. })), "{segs:?}");
        assert!((length(&Shape::Path { start: open[0], segs, closed: false }) - 1.5 * PI * 0.15).abs() < 1e-9);
    }

    #[test]
    fn rechteck_achteck_und_gerade_bleiben_strecken() {
        let sq = vec![V2 { x: 0.0, y: 0.0 }, V2 { x: 1.0, y: 0.0 }, V2 { x: 1.0, y: 1.0 }, V2 { x: 0.0, y: 1.0 }];
        assert!(fit(&sq, true, TOL).is_none());
        assert!(fit(&ring(V2 { x: 0.0, y: 0.0 }, 1.0, 8), true, TOL).is_none());
        let line: Vec<V2> = (0..6).map(|i| V2 { x: i as f64, y: 0.0 }).collect();
        assert!(fit(&line, false, TOL).is_none());
        // Leicht geknickter Zug (nicht auf einem Kreis).
        let z = vec![V2 { x: 0.0, y: 0.0 }, V2 { x: 1.0, y: 0.1 }, V2 { x: 2.0, y: 0.1 }, V2 { x: 3.0, y: 0.25 }, V2 { x: 4.0, y: 0.2 }];
        assert!(fit(&z, false, TOL).is_none());
        // Fast gerade Geländelinie (Ansicht): vier Punkte zufällig auf einem Kreis r ≈ 274 m, Pfeilhöhe 45 µm.
        let (c, r) = (V2 { x: 0.0, y: -274.0 }, 274.0f64);
        let flat: Vec<V2> = [-0.16, -0.05, 0.05, 0.16].iter().map(|x: &f64| V2 { x: c.x + x, y: c.y + (r * r - x * x).sqrt() }).collect();
        assert!(fit(&flat, false, TOL).is_none());
    }

    /// Bogenwand-Band: äusserer Bogen, Stirn, innerer Bogen zurück, Stirn.
    fn band() -> Vec<V2> {
        let (r0, r1, n) = (5.0, 4.7, 12);
        let mut p: Vec<V2> = (0..=n).map(|i| {
            let t = PI / 2.0 * i as f64 / n as f64;
            V2 { x: r0 * t.cos(), y: r0 * t.sin() }
        }).collect();
        p.extend((0..=n).rev().map(|i| {
            let t = PI / 2.0 * i as f64 / n as f64;
            V2 { x: r1 * t.cos(), y: r1 * t.sin() }
        }));
        p
    }

    #[test]
    fn bogenwand_band_zwei_boegen_zwei_stirnen() {
        let Some(s @ Shape::Path { .. }) = fit(&band(), true, TOL) else { panic!() };
        let Shape::Path { segs, closed, .. } = &s else { unreachable!() };
        assert!(*closed);
        let arcs: Vec<(f64, f64)> = segs.iter().filter_map(|g| if let Seg::Arc { r, sweep, .. } = g { Some((*r, *sweep)) } else { None }).collect();
        let lines = segs.iter().filter(|g| matches!(g, Seg::Line { .. })).count();
        assert_eq!(lines, 2, "{segs:?}");
        assert_eq!(arcs.len(), 2, "{segs:?}");
        assert!(arcs.iter().any(|(r, s)| (r - 5.0).abs() < 1e-9 && (s - PI / 2.0).abs() < 1e-9));
        assert!(arcs.iter().any(|(r, s)| (r - 4.7).abs() < 1e-9 && (s + PI / 2.0).abs() < 1e-9));
        // SVG: zwei A-Befehle, Drehsinn gespiegelt (Y nach unten).
        let d = svg_d(&s, &|p| V2 { x: p.x, y: -p.y }, 1.0, &|v| format!("{}", (v * 1e5).round() / 1e5));
        assert_eq!(d.matches(" A ").count(), 2, "{d}");
        assert!(d.contains("A 5 5 0 0 0 ") && d.contains("A 4.7 4.7 0 0 1 ") && d.ends_with(" Z"), "{d}");
        // DXF-Bulges: tan(±π/8) an den Bogen-Ecken.
        let (v, b) = bulges(&s).unwrap();
        assert_eq!(v.len(), 4);
        assert_eq!(b.iter().filter(|x| (x.abs() - (PI / 8.0).tan()).abs() < 1e-9).count(), 2, "{b:?}");
    }

    #[test]
    fn verfeinern_haelt_ecken_und_kreis() {
        let p = band();
        let f = refine(&p, true, TOL, &fine_segments).unwrap();
        assert!(f.len() > 2 * p.len(), "{}", f.len());
        for q in &p {
            assert!(f.iter().any(|x| dist(*x, *q) < 1e-12) || {
                let r = crate::jsmath::hypot2(q.x, q.y);
                (r - 5.0).abs() < 1e-9 || (r - 4.7).abs() < 1e-9
            });
        }
        // Alle neuen Punkte auf einem der Kreise oder Ecken des Originals.
        assert!(f.iter().all(|x| {
            let r = crate::jsmath::hypot2(x.x, x.y);
            (r - 5.0).abs() < 1e-9 || (r - 4.7).abs() < 1e-9
        }));
        let c = refine(&ring(V2 { x: 0.0, y: 0.0 }, 0.15, 32), true, TOL, &fine_segments).unwrap();
        assert!(c.len() >= 180, "{}", c.len());
        assert!(refine(&[V2 { x: 0.0, y: 0.0 }, V2 { x: 1.0, y: 0.0 }, V2 { x: 1.0, y: 1.0 }], true, TOL, &fine_segments).is_none());
    }

    #[test]
    fn langer_bogen_wird_geteilt() {
        let p: Vec<V2> = (0..=40).map(|i| {
            let t = 1.6 * PI * i as f64 / 40.0;
            V2 { x: t.cos(), y: t.sin() }
        }).collect();
        let Some(Shape::Path { segs, .. }) = fit(&p, false, TOL) else { panic!() };
        assert_eq!(segs.len(), 2);
        let tot: f64 = segs.iter().map(|g| if let Seg::Arc { sweep, .. } = g { *sweep } else { 0.0 }).sum();
        assert!((tot - 1.6 * PI).abs() < 1e-9);
        assert!(segs.iter().all(|g| matches!(g, Seg::Arc { sweep, .. } if sweep.abs() <= PI + 1e-9)));
    }

    #[test]
    fn unsinn_ergibt_nichts() {
        let nan = vec![V2 { x: f64::NAN, y: 0.0 }; 6];
        assert!(fit(&nan, true, TOL).is_none());
        assert!(fit(&[], false, TOL).is_none());
    }
}
