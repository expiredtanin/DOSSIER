//! [169] Bögen in Linienzügen erkennen: Die Plan-Erzeugung rechnet mit Vielecken (runde Stütze, Bogenwand,
//! Bogen-Umrisse von Decken/Dächern, Booleans); die Ausgaben (Plan-SVG, Druck-SVG/PDF, DXF/DWG, Bildschirm)
//! sollen echte Kreise und Bögen zeigen. [`fit`] zerlegt einen offenen oder geschlossenen Zug in Strecken
//! und Bögen: mindestens vier aufeinanderfolgende Punkte auf einem Kreis (Abstand ≤ `tol`), gleicher
//! Drehsinn, Winkelschritt je Kante ≤ [`MAX_STEP`] — Rechtecke, Achtecke und schwach geknickte Züge
//! bleiben Strecken. [`refine`] tesselliert erkannte Bögen fein nach (Bildschirm), [`svg_d`] schreibt
//! SVG-Pfade (`A`), [`bulges`] die Bulges einer LWPOLYLINE (DXF).
//!
//! Zwei Erweiterungen (10.11.): **Ellipsenbögen** mit achsparallelen Halbachsen (ein Kreis in einer
//! senkrechten Wand, schräg zur Ansicht projiziert: Rundbogen- und Rundfenster, ovale Rundfenster) —
//! mindestens sechs Punkte auf der Ellipse (± `tol`), Parameterschritt ≤ [`MAX_STEP`]. **Verrauschte
//! Kreise** (Punkte auf mm gerundet, Versatz eines gerundeten Rings, z. B. Erker-Umriss oder Ring um ein
//! Wendeltreppen-Loch): stückweise Ausgleichskreise mit Toleranz [`LOOSE_TOL`] × `tol`, mindestens sechs
//! Punkte mit gleichmässigem Winkelschritt.

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
/// Toleranz der Ausgleichskreise verrauschter Ringe als Vielfaches von `tol` (bei [`TOL`]: 1 mm).
pub const LOOSE_TOL: f64 = 100.0;
/// Mindestzahl der Punkte eines Ausgleichskreises oder Ellipsenbogens.
const MIN_PTS_FREE: usize = 6;
/// Grösstes Verhältnis zweier Winkelschritte eines Ausgleichskreises (gleichmässig zerlegter Ring).
const LOOSE_STEP_RATIO: f64 = 1.5;
/// Kleinster Winkelschritt eines Ausgleichskreises (2°): dicht abgetastete glatte Kurven (Höhenlinien) bleiben
/// Linienzüge; gerundete Ringe sind gröber zerlegt.
const LOOSE_MIN_STEP: f64 = 2.0 * PI / 180.0;
/// Kleinster Drehwinkel eines Ellipsenbogens (45°): Fenster-Bögen sind halbe oder ganze Ellipsen; kurze Stücke
/// dicht abgetasteter Kurven passen auf fast jede Ellipse.
const ELL_MIN_SWEEP: f64 = PI / 4.0;

/// Ein Stück ab dem Ende des vorigen (bzw. ab `start`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Seg {
    Line { b: V2 },
    /// Kreisbogen bis `b` um `c`, Radius `r`, Drehwinkel `sweep` (positiv = gegen den Uhrzeiger, Y nach oben),
    /// |sweep| ≤ π (längere Bögen sind geteilt).
    Arc { b: V2, c: V2, r: f64, sweep: f64 },
    /// Ellipsenbogen bis `b` um `c` mit achsparallelen Halbachsen `rx` (X) und `ry` (Y); `sweep` = Drehwinkel
    /// im Parameter t (Punkt = c + (rx cos t, ry sin t)), Vorzeichen wie bei `Arc`, |sweep| ≤ π.
    Ell { b: V2, c: V2, rx: f64, ry: f64, sweep: f64 },
}

impl Seg {
    pub fn end(&self) -> V2 {
        match *self {
            Seg::Line { b } | Seg::Arc { b, .. } | Seg::Ell { b, .. } => b,
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

// ── Ellipsen (achsparallel) ──────────────────────────────────────────────────

/// Parameter t eines Punkts auf der Ellipse um `c` (Halbachsen `rx`, `ry`).
fn ell_t(c: V2, rx: f64, ry: f64, p: V2) -> f64 {
    jsnum::atan2((p.y - c.y) / ry, (p.x - c.x) / rx)
}

/// Vorzeichenbehafteter Parameterschritt von `p` nach `q`, in (−π, π].
fn ell_step(c: V2, rx: f64, ry: f64, p: V2, q: V2) -> f64 {
    let mut d = ell_t(c, rx, ry, q) - ell_t(c, rx, ry, p);
    while d > PI {
        d -= 2.0 * PI;
    }
    while d <= -PI {
        d += 2.0 * PI;
    }
    d
}

/// Abstand eines Punkts von der Ellipse (erste Näherung |F| / |∇F|).
fn ell_dist(c: V2, rx: f64, ry: f64, p: V2) -> f64 {
    let (u, v) = ((p.x - c.x) / rx, (p.y - c.y) / ry);
    let f = u * u + v * v - 1.0;
    let g = 2.0 * crate::jsmath::hypot2(u / rx, v / ry);
    if g > 1e-300 {
        (f / g).abs()
    } else {
        f64::INFINITY
    }
}

/// Lineares Gleichungssystem (n ≤ 4) mit Spaltenpivot; `None` bei (fast) singulärer Matrix.
fn solve<const N: usize>(mut a: [[f64; N]; N], mut b: [f64; N]) -> Option<[f64; N]> {
    let scale = a.iter().flatten().fold(0.0f64, |m, v| m.max(v.abs()));
    if !(scale > 0.0) || !scale.is_finite() {
        return None;
    }
    for k in 0..N {
        let piv = (k..N).max_by(|&i, &j| a[i][k].abs().total_cmp(&a[j][k].abs()))?;
        if !(a[piv][k].abs() > 1e-13 * scale) {
            return None;
        }
        a.swap(k, piv);
        b.swap(k, piv);
        for i in k + 1..N {
            let f = a[i][k] / a[k][k];
            for j in k..N {
                a[i][j] -= f * a[k][j];
            }
            b[i] -= f * b[k];
        }
    }
    let mut x = [0.0; N];
    for k in (0..N).rev() {
        let s: f64 = (k + 1..N).map(|j| a[k][j] * x[j]).sum();
        x[k] = (b[k] - s) / a[k][k];
    }
    x.iter().all(|v| v.is_finite()).then_some(x)
}

/// Achsparallele Ellipse durch vier Punkte: `A X² + B Y² + C X + D Y = 1` um den Schwerpunkt (liegt bei
/// einem Bogen im Inneren). `None`, wenn keine Ellipse (Hyperbel, Gerade) oder Radien ausserhalb.
fn ell4(p: [V2; 4], tol: f64) -> Option<(V2, f64, f64)> {
    let m = V2 { x: p.iter().map(|q| q.x).sum::<f64>() / 4.0, y: p.iter().map(|q| q.y).sum::<f64>() / 4.0 };
    let s = p.iter().fold(0.0f64, |s, q| s.max((q.x - m.x).abs()).max((q.y - m.y).abs()));
    if !(s > 0.0) {
        return None;
    }
    let mut a = [[0.0; 4]; 4];
    for (row, q) in a.iter_mut().zip(&p) {
        let (x, y) = ((q.x - m.x) / s, (q.y - m.y) / s);
        *row = [x * x, y * y, x, y];
    }
    let [aa, bb, cc, dd] = solve(a, [1.0; 4])?;
    if !(aa > 0.0 && bb > 0.0) {
        return None;
    }
    let k = 1.0 + cc * cc / (4.0 * aa) + dd * dd / (4.0 * bb);
    if !(k > 0.0) {
        return None;
    }
    let (rx, ry) = (s * (k / aa).sqrt(), s * (k / bb).sqrt());
    let c = V2 { x: m.x - s * cc / (2.0 * aa), y: m.y - s * dd / (2.0 * bb) };
    let ok = |r: f64| r.is_finite() && (R_MIN_TOL * tol..=R_MAX_TOL * tol).contains(&r);
    // Fast ein Kreis: das erledigt die Kreiserkennung (bzw. der Ausgleichskreis).
    (ok(rx) && ok(ry) && (rx - ry).abs() > tol && rx.max(ry) <= 1e3 * rx.min(ry) && c.x.is_finite() && c.y.is_finite()).then_some((c, rx, ry))
}

/// Ellipse aus vier über den Zug verteilten Punkten, die alle Punkte bis `tol` hält. Mehrere Auswahlen:
/// zwei Paare spiegelbildlich zur selben Achse bestimmen keine achsparallele Ellipse.
fn ell_spread(p: &[V2], closed: bool, tol: f64) -> Option<(V2, f64, f64)> {
    let n = if closed { p.len() } else { p.len() - 1 };
    const PICKS: [[usize; 4]; 4] = [[0, 4, 6, 12], [0, 3, 8, 12], [0, 5, 7, 12], [0, 2, 9, 12]];
    PICKS.iter().find_map(|k| {
        let at = |f: usize| p[(n * f / 12).min(p.len() - 1)];
        let pk = if closed { [at(k[0]), at(k[1]), at(k[2]), at(10)] } else { [at(k[0]), at(k[1]), at(k[2]), at(k[3])] };
        let (c, rx, ry) = ell4(pk, tol)?;
        p.iter().all(|q| ell_dist(c, rx, ry, *q) <= tol).then_some((c, rx, ry))
    })
}

/// Ellipse aus vier über `q[i..=j]` verteilten Punkten, wenn sie alle Punkte hält (Schritte gleichsinnig).
fn ell_over(q: &[V2], i: usize, j: usize, tol: f64) -> Option<(V2, f64, f64, f64)> {
    let (c, rx, ry) = ell_spread(&q[i..=j], false, tol)?;
    let sign = ell_step(c, rx, ry, q[i], q[i + 1]).signum();
    let mut sweep = 0.0;
    for k in i..j {
        let s = ell_step(c, rx, ry, q[k], q[k + 1]);
        if !step_ok(s, sign) {
            return None;
        }
        sweep += s;
    }
    (sweep.abs() < 2.0 * PI - 1e-6).then_some((c, rx, ry, sweep))
}

/// Grösster Abstand der Punkte `q[i..=j]` von der Sehne `q[i]`–`q[j]` (Pfeilhöhe des Zugs).
fn chord_sagitta(q: &[V2], i: usize, j: usize) -> f64 {
    let (a, b) = (q[i], q[j]);
    let l = dist(a, b);
    q[i..=j].iter().map(|p| if l > 1e-300 { ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)).abs() / l } else { dist(a, *p) }).fold(0.0, f64::max)
}

/// Längster Ellipsenbogen ab `q[i]` (mindestens [`MIN_PTS_FREE`] Punkte): `(j, Mitte, rx, ry, Drehwinkel)`.
fn try_ell(q: &[V2], i: usize, tol: f64) -> Option<(usize, V2, f64, f64, f64)> {
    let m = q.len() - 1;
    let need = i + MIN_PTS_FREE - 1;
    if need > m {
        return None;
    }
    // Vorschlag aus den ersten Punkten, grosszügig fortgesetzt; dann aus verteilten Punkten nachgerechnet
    // und von hinten gekürzt, bis die Ellipse alle Punkte hält.
    let (c, rx, ry) = ell4([q[i], q[i + 1], q[i + 2], q[i + 3]], tol)?;
    let sign = ell_step(c, rx, ry, q[i], q[i + 1]).signum();
    let mut sweep = 0.0;
    let mut j = i;
    while j < m {
        let s = ell_step(c, rx, ry, q[j], q[j + 1]);
        if ell_dist(c, rx, ry, q[j + 1]) > 10.0 * tol || !step_ok(s, sign) || (sweep + s).abs() >= 2.0 * PI - 1e-6 {
            break;
        }
        sweep += s;
        j += 1;
    }
    let mut found = None;
    while j >= need {
        if let Some(e) = ell_over(q, i, j, tol) {
            found = Some((j, e));
            break;
        }
        j -= 1;
    }
    // Mit der besseren Ellipse weiter, solange die nächsten Punkte passen (der Vorschlag aus vier nahen
    // Punkten streut am fernen Ende).
    let (mut j, mut e) = found?;
    while j < m {
        let (c, rx, ry, _) = e;
        let mut k = j;
        while k < m && ell_dist(c, rx, ry, q[k + 1]) <= tol {
            k += 1;
        }
        match (k > j).then(|| ell_over(q, i, k, tol)).flatten() {
            Some(e2) => {
                j = k;
                e = e2;
            }
            None => break,
        }
    }
    let (c, rx, ry, sweep) = e;
    (sweep.abs() >= ELL_MIN_SWEEP && chord_sagitta(q, i, j) > SAGITTA_TOL * tol).then_some((j, c, rx, ry, sweep))
}

/// Ganze Ellipse? Alle Punkte auf einer achsparallelen Ellipse, gleichsinnig, einmal herum.
fn full_ellipse(p: &[V2], tol: f64) -> Option<(V2, f64, f64)> {
    let n = p.len();
    if n < 8 {
        return None;
    }
    let (c, rx, ry) = ell_spread(p, true, tol)?;
    let sign = ell_step(c, rx, ry, p[0], p[1]).signum();
    let mut total = 0.0;
    for k in 0..n {
        let s = ell_step(c, rx, ry, p[k], p[(k + 1) % n]);
        if !step_ok(s, sign) {
            return None;
        }
        total += s;
    }
    ((total.abs() - 2.0 * PI).abs() < 1e-6).then_some((c, rx, ry))
}

// ── Ausgleichskreise (verrauschte Ringe) ─────────────────────────────────────

/// Ausgleichskreis (algebraisch, Kåsa) durch die Punkte; `None` bei (fast) kollinearen.
fn lsq_circle(p: &[V2], tol: f64) -> Option<(V2, f64)> {
    let n = p.len() as f64;
    let m = V2 { x: p.iter().map(|q| q.x).sum::<f64>() / n, y: p.iter().map(|q| q.y).sum::<f64>() / n };
    let (mut sxx, mut syy, mut sxy, mut sxz, mut syz, mut sz) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for q in p {
        let (x, y) = (q.x - m.x, q.y - m.y);
        let z = x * x + y * y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
        sxz += x * z;
        syz += y * z;
        sz += z;
    }
    // x² + y² + D x + E y + F = 0 mit Σx = Σy = 0.
    let [d, e] = solve([[sxx, sxy], [sxy, syy]], [-sxz, -syz])?;
    let f = -sz / n;
    let r2 = d * d / 4.0 + e * e / 4.0 - f;
    if !(r2 > 0.0) {
        return None;
    }
    let r = r2.sqrt();
    (r.is_finite() && (R_MIN_TOL * tol..=R_MAX_TOL * tol).contains(&r)).then_some((V2 { x: m.x - d / 2.0, y: m.y - e / 2.0 }, r))
}

/// Ausgleichskreis über `q[i..=j]`, wenn er alle Punkte bis `ltol` hält und die Winkelschritte gleichsinnig
/// und gleichmässig sind: `(Mitte, Radius, Drehwinkel)`.
fn loose_over(q: &[V2], i: usize, j: usize, tol: f64, ltol: f64) -> Option<(V2, f64, f64)> {
    let (c, r) = lsq_circle(&q[i..=j], tol)?;
    if q[i..=j].iter().any(|p| (dist(c, *p) - r).abs() > ltol) {
        return None;
    }
    let sign = step(c, q[i], q[i + 1]).signum();
    let (mut lo, mut hi, mut sweep) = (f64::INFINITY, 0.0f64, 0.0);
    for k in i..j {
        let s = step(c, q[k], q[k + 1]);
        if !step_ok(s, sign) {
            return None;
        }
        lo = lo.min(s.abs());
        hi = hi.max(s.abs());
        sweep += s;
    }
    (lo >= LOOSE_MIN_STEP && hi <= LOOSE_STEP_RATIO * lo && sweep.abs() < 2.0 * PI - 1e-6).then_some((c, r, sweep))
}

/// Längster Ausgleichskreis-Bogen ab `q[i]` (mindestens [`MIN_PTS_FREE`] Punkte, Pfeilhöhe ≥ 5 × `ltol`).
fn try_loose(q: &[V2], i: usize, tol: f64) -> Option<(usize, V2, f64, f64)> {
    let ltol = LOOSE_TOL * tol;
    let m = q.len() - 1;
    let need = i + MIN_PTS_FREE - 1;
    if need > m {
        return None;
    }
    let mut best = None;
    let mut j = need;
    while j <= m {
        match loose_over(q, i, j, tol, ltol) {
            Some((c, r, sweep)) => best = Some((j, c, r, sweep)),
            None if best.is_some() => break,
            None => return None,
        }
        j += 1;
    }
    let (j, c, r, sweep) = best?;
    (r * (1.0 - jsnum::cos(sweep.abs().min(PI) / 2.0)) > 5.0 * ltol).then_some((j, c, r, sweep))
}

/// Ganzer verrauschter Kreis (Ausgleichskreis über alle Punkte, gleichmässige Schritte, einmal herum).
fn full_loose_circle(p: &[V2], tol: f64) -> Option<(V2, f64)> {
    let n = p.len();
    if n < 8 {
        return None;
    }
    let ltol = LOOSE_TOL * tol;
    let (c, r) = lsq_circle(p, tol)?;
    if p.iter().any(|q| (dist(c, *q) - r).abs() > ltol) || r < 5.0 * ltol {
        return None;
    }
    let sign = step(c, p[0], p[1]).signum();
    let (mut lo, mut hi, mut total) = (f64::INFINITY, 0.0f64, 0.0);
    for k in 0..n {
        let s = step(c, p[k], p[(k + 1) % n]);
        if !step_ok(s, sign) {
            return None;
        }
        lo = lo.min(s.abs());
        hi = hi.max(s.abs());
        total += s;
    }
    (lo >= LOOSE_MIN_STEP && hi <= LOOSE_STEP_RATIO * lo && (total.abs() - 2.0 * PI).abs() < 1e-6).then_some((c, r))
}

/// Erkanntes Stück `q[i..=j]` eines Zugs (vor dem Teilen langer Bögen).
#[derive(Clone, Copy)]
enum Span {
    Line,
    Arc { c: V2, r: f64, sweep: f64 },
    Ell { c: V2, rx: f64, ry: f64, sweep: f64 },
}

/// Offener Zug → Stücke (mit mindestens einem Bogen, sonst `None`). Erst die genauen Bögen: je Anfangspunkt
/// gewinnt der längere von Kreis- und Ellipsenbogen (gleich lang: Kreis). Dann in den übrigen Strecken-Läufen
/// Ausgleichskreise ([`try_loose`]) — so schluckt ein ungenauer Kreis keinen Anfang eines genauen Bogens.
fn fit_open(q: &[V2], tol: f64) -> Option<Vec<Seg>> {
    let m = q.len().checked_sub(1)?;
    let mut spans: Vec<(usize, usize, Span)> = Vec::with_capacity(m);
    let mut i = 0;
    while i < m {
        let arc = try_arc(q, i, tol);
        match try_ell(q, i, tol).filter(|e| arc.is_none_or(|a| e.0 > a.0)) {
            Some((j, c, rx, ry, sweep)) => {
                spans.push((i, j, Span::Ell { c, rx, ry, sweep }));
                i = j;
            }
            None => match arc {
                Some((j, c, r, sweep)) => {
                    spans.push((i, j, Span::Arc { c, r, sweep }));
                    i = j;
                }
                None => {
                    spans.push((i, i + 1, Span::Line));
                    i += 1;
                }
            },
        }
    }
    // Ausgleichskreise in Läufen von Strecken.
    let mut out: Vec<(usize, usize, Span)> = Vec::with_capacity(spans.len());
    let mut k = 0;
    while k < spans.len() {
        if !matches!(spans[k].2, Span::Line) {
            out.push(spans[k]);
            k += 1;
            continue;
        }
        let mut e = k;
        while e < spans.len() && matches!(spans[e].2, Span::Line) {
            e += 1;
        }
        let (a, b) = (spans[k].0, spans[e - 1].1);
        let run = &q[a..=b];
        let mut t = 0;
        while t < run.len() - 1 {
            if let Some((j, c, r, sweep)) = try_loose(run, t, tol) {
                out.push((a + t, a + j, Span::Arc { c, r, sweep }));
                t = j;
            } else {
                out.push((a + t, a + t + 1, Span::Line));
                t += 1;
            }
        }
        k = e;
    }
    if out.iter().all(|s| matches!(s.2, Span::Line)) {
        return None;
    }
    // Bogen in höchstens zwei Teile ≤ π (SVG/DXF rechnen mit höchstens einem Halbkreis stabil).
    let split = |i: usize, j: usize, sweep: f64, st: &dyn Fn(V2, V2) -> f64| -> Option<(usize, f64)> {
        if sweep.abs() <= PI {
            return None;
        }
        let mut acc = 0.0;
        let mut k = i;
        while k < j - 1 && (acc + st(q[k], q[k + 1])).abs() <= sweep.abs() / 2.0 {
            acc += st(q[k], q[k + 1]);
            k += 1;
        }
        let k = k.max(i + 1);
        Some((k, (i..k).map(|t| st(q[t], q[t + 1])).sum()))
    };
    let mut segs = Vec::with_capacity(out.len() + 2);
    for (i, j, sp) in out {
        match sp {
            Span::Line => segs.push(Seg::Line { b: q[j] }),
            Span::Arc { c, r, sweep } => match split(i, j, sweep, &|a, b| step(c, a, b)) {
                Some((k, s1)) => {
                    segs.push(Seg::Arc { b: q[k], c, r, sweep: s1 });
                    segs.push(Seg::Arc { b: q[j], c, r, sweep: sweep - s1 });
                }
                None => segs.push(Seg::Arc { b: q[j], c, r, sweep }),
            },
            Span::Ell { c, rx, ry, sweep } => match split(i, j, sweep, &|a, b| ell_step(c, rx, ry, a, b)) {
                Some((k, s1)) => {
                    segs.push(Seg::Ell { b: q[k], c, rx, ry, sweep: s1 });
                    segs.push(Seg::Ell { b: q[j], c, rx, ry, sweep: sweep - s1 });
                }
                None => segs.push(Seg::Ell { b: q[j], c, rx, ry, sweep }),
            },
        }
    }
    Some(segs)
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
    // Ganze Ellipse (Rundfenster schräg zur Ansicht, ovales Rundfenster): zwei Halbbögen.
    if let Some((c, rx, ry)) = full_ellipse(&pts, tol) {
        let mut acc = 0.0;
        let mut k = 0;
        while k + 1 < n && (acc + ell_step(c, rx, ry, pts[k], pts[k + 1])).abs() <= PI + 1e-9 {
            acc += ell_step(c, rx, ry, pts[k], pts[k + 1]);
            k += 1;
        }
        let rest: f64 = (k..n).map(|t| ell_step(c, rx, ry, pts[t], pts[(t + 1) % n])).sum();
        let segs = vec![Seg::Ell { b: pts[k], c, rx, ry, sweep: acc }, Seg::Ell { b: pts[0], c, rx, ry, sweep: rest }];
        return Some(Shape::Path { start: pts[0], segs, closed: true });
    }
    if let Some((c, r)) = full_loose_circle(&pts, tol) {
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
                    Seg::Ell { c, rx, ry, sweep, .. } => ell_length(at, c, rx, ry, sweep),
                };
                at = g.end();
            }
            l
        }
    }
}

/// Länge eines Ellipsenbogens ab `a` (Sehnenzug mit 1° Schritt, genau auf ≪ 0.1 ‰).
fn ell_length(a: V2, c: V2, rx: f64, ry: f64, sweep: f64) -> f64 {
    let t0 = ell_t(c, rx, ry, a);
    let n = ((sweep.abs() / (PI / 180.0)).ceil() as usize).clamp(4, 720);
    let pt = |k: usize| {
        let t = t0 + sweep * k as f64 / n as f64;
        V2 { x: c.x + rx * jsnum::cos(t), y: c.y + ry * jsnum::sin(t) }
    };
    (0..n).map(|k| dist(pt(k), pt(k + 1))).sum()
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

/// Punkte eines Ellipsenbogens ab `a` (ohne `a`, mit `b` exakt am Ende).
#[allow(clippy::too_many_arguments)]
fn ell_points(a: V2, b: V2, c: V2, rx: f64, ry: f64, sweep: f64, n: usize, out: &mut Vec<V2>) {
    let t0 = ell_t(c, rx, ry, a);
    for k in 1..n {
        let t = t0 + sweep * k as f64 / n as f64;
        out.push(V2 { x: c.x + rx * jsnum::cos(t), y: c.y + ry * jsnum::sin(t) });
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
                    // Feinheit nach dem grösseren Krümmungsradius (rx²/ry bzw. ry²/rx), höchstens 1024.
                    Seg::Ell { b, c, rx, ry, sweep } => {
                        let rk = (rx * rx / ry).max(ry * ry / rx);
                        ell_points(at, b, c, rx, ry, sweep, segments(rk, sweep.abs()).max(1), &mut out)
                    }
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
                    // Achsparallel: `map` spiegelt höchstens Y (die Halbachsen bleiben achsparallel).
                    Seg::Ell { b, rx, ry, sweep, .. } => {
                        let large = if sweep.abs() > PI { 1 } else { 0 };
                        let flag = if sweep > 0.0 { ccw_flag } else { 1 - ccw_flag };
                        d.push_str(&format!(" A {} {} 0 {large} {flag} ", fmt(rx * k), fmt(ry * k)));
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
/// wiederholten Anfangspunkt (der letzte Bulge gilt der Schlusskante). Kreise → `None` (CIRCLE); mit
/// Ellipsenbögen → `None` (s. [`pieces`]).
pub fn bulges(s: &Shape) -> Option<(Vec<V2>, Vec<f64>)> {
    let Shape::Path { start, segs, closed } = s else { return None };
    if segs.iter().any(|g| matches!(g, Seg::Ell { .. })) {
        return None;
    }
    let mut v = vec![*start];
    let mut b = Vec::with_capacity(segs.len() + 1);
    for g in segs {
        v.push(g.end());
        b.push(match *g {
            Seg::Line { .. } => 0.0,
            Seg::Arc { sweep, .. } => jsnum::tan(sweep / 4.0),
            Seg::Ell { .. } => 0.0, // oben ausgeschlossen
        });
    }
    if *closed {
        v.pop();
    } else {
        b.push(0.0);
    }
    Some((v, b))
}

/// Ein DXF-Stück eines Zugs mit Ellipsenbögen ([`pieces`]).
#[derive(Clone, Debug, PartialEq)]
pub enum Piece {
    /// Offene LWPOLYLINE (Ecken, Bulges).
    Poly(Vec<V2>, Vec<f64>),
    /// ELLIPSE: Mitte, Hauptachse (Vektor zum Scheitel), Verhältnis Neben-/Hauptachse, Start-/Endparameter
    /// (gegen den Uhrzeiger, Bogenmass).
    Ellipse { c: V2, major: V2, ratio: f64, t0: f64, t1: f64 },
}

/// Ein Zug mit Ellipsenbögen als DXF-Stücke: Strecken- und Kreisbogen-Läufe als offene LWPOLYLINE mit Bulges,
/// jeder Ellipsenbogen als ELLIPSE. `None` für Kreise und Züge ohne Ellipsenbogen (dann [`bulges`]).
pub fn pieces(s: &Shape) -> Option<Vec<Piece>> {
    let Shape::Path { start, segs, closed } = s else { return None };
    if !segs.iter().any(|g| matches!(g, Seg::Ell { .. })) {
        return None;
    }
    let mut out = Vec::new();
    let mut run: (Vec<V2>, Vec<f64>) = (vec![*start], Vec::new());
    let mut at = *start;
    let flush = |run: &mut (Vec<V2>, Vec<f64>), out: &mut Vec<Piece>, at: V2| {
        if run.0.len() >= 2 {
            let mut b = std::mem::take(&mut run.1);
            b.push(0.0);
            out.push(Piece::Poly(std::mem::take(&mut run.0), b));
        }
        *run = (vec![at], Vec::new());
    };
    for g in segs {
        match *g {
            Seg::Line { b } => {
                run.0.push(b);
                run.1.push(0.0);
            }
            Seg::Arc { b, sweep, .. } => {
                run.0.push(b);
                run.1.push(jsnum::tan(sweep / 4.0));
            }
            Seg::Ell { b, c, rx, ry, sweep } => {
                flush(&mut run, &mut out, at);
                let ta = ell_t(c, rx, ry, at);
                // Parameter gegen den Uhrzeiger; Hauptachse = die längere Halbachse.
                let (t0, t1) = if sweep > 0.0 { (ta, ta + sweep) } else { (ta + sweep, ta) };
                let (major, ratio, off) = if rx >= ry { (V2 { x: rx, y: 0.0 }, ry / rx, 0.0) } else { (V2 { x: 0.0, y: ry }, rx / ry, PI / 2.0) };
                out.push(Piece::Ellipse { c, major, ratio, t0: t0 - off, t1: t1 - off });
                run = (vec![b], Vec::new());
            }
        }
        at = g.end();
    }
    if *closed && dist(at, *start) > 1e-12 {
        run.0.push(*start);
        run.1.push(0.0);
    }
    flush(&mut run, &mut out, at);
    Some(out)
}

/// Rand einer Fläche (geschlossen) als Ecken mit Bulges: Kreis als zwei Halbkreise, sonst [`bulges`].
/// `None` ohne erkannten Bogen oder mit Ellipsenbögen.
pub fn ring_bulges(pts: &[V2], tol: f64) -> Option<(Vec<V2>, Vec<f64>)> {
    match fit(pts, true, tol)? {
        Shape::Circle { c, r, a0 } => {
            let p = |t: f64| V2 { x: c.x + r * jsnum::cos(t), y: c.y + r * jsnum::sin(t) };
            Some((vec![p(a0), p(a0 + PI)], vec![1.0, 1.0]))
        }
        s => bulges(&s),
    }
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

    /// Rundbogenfenster in einer Wand 40° schräg zur Ansicht: Halbkreis r = 0.6 (Schritt 7.5°) mit
    /// Rechteck darunter, waagrecht um cos 40° gestaucht → Ellipsenbogen rx = 0.6 cos 40°, ry = 0.6.
    fn schraeges_rundbogenfenster() -> (Vec<V2>, f64) {
        let k = (40.0f64).to_radians().cos();
        let (w, h, r) = (1.2, 1.6, 0.6);
        let mut p = vec![V2 { x: 3.0, y: 1.0 }, V2 { x: 3.0 + w * k, y: 1.0 }];
        for i in 0..=24 {
            let t = PI * i as f64 / 24.0;
            p.push(V2 { x: 3.0 + (w / 2.0 + r * t.cos()) * k, y: 1.0 + h - r + r * t.sin() });
        }
        (p, r * k)
    }

    #[test]
    fn schraeger_rundbogen_ist_ellipsenbogen() {
        let (p, rx) = schraeges_rundbogenfenster();
        let Some(sh @ Shape::Path { .. }) = fit(&p, true, TOL) else { panic!() };
        let Shape::Path { segs, .. } = &sh else { unreachable!() };
        let ells: Vec<(f64, f64, f64)> = segs.iter().filter_map(|g| if let Seg::Ell { rx, ry, sweep, .. } = g { Some((*rx, *ry, *sweep)) } else { None }).collect();
        assert_eq!(ells.len(), 1, "{segs:?}");
        assert!((ells[0].0 - rx).abs() < 1e-9 && (ells[0].1 - 0.6).abs() < 1e-9 && (ells[0].2 - PI).abs() < 1e-9, "{ells:?}");
        assert_eq!(segs.iter().filter(|g| matches!(g, Seg::Line { .. })).count(), 3);
        // Länge: Ellipsen-Halbumfang (Ramanujan) + drei Strecken.
        let (a, b) = (0.6, rx);
        let hh = ((a - b) / (a + b)).powi(2);
        let half = PI * (a + b) * (1.0 + 3.0 * hh / (10.0 + (4.0 - 3.0 * hh).sqrt())) / 2.0;
        assert!((length(&sh) - (half + 2.0 + 1.2 * (40.0f64).to_radians().cos())).abs() < 1e-4, "{}", length(&sh));
        // SVG: A mit zwei Halbachsen, Drehung 0.
        let d = svg_d(&sh, &|p| V2 { x: p.x, y: -p.y }, 1.0, &|v| format!("{}", (v * 1e5).round() / 1e5));
        assert_eq!(d.matches(" A ").count(), 1, "{d}");
        assert!(d.contains(&format!("A {} 0.6 0 0 0 ", (rx * 1e5).round() / 1e5)), "{d}");
        // DXF: keine Bulges, sondern LWPOLYLINE + ELLIPSE (Hauptachse senkrecht, Verhältnis rx/ry).
        assert!(bulges(&sh).is_none());
        let pc = pieces(&sh).unwrap();
        let el: Vec<&Piece> = pc.iter().filter(|x| matches!(x, Piece::Ellipse { .. })).collect();
        assert_eq!(el.len(), 1, "{pc:?}");
        let Piece::Ellipse { major, ratio, t0, t1, c } = el[0] else { unreachable!() };
        assert!(major.x.abs() < 1e-12 && (major.y - 0.6).abs() < 1e-9 && (ratio - rx / 0.6).abs() < 1e-9);
        // Start rechts (t = 0 → t' = −π/2), Ende links (t = π → t' = π/2); Punkt bei t' prüfen.
        assert!((t0 + PI / 2.0).abs() < 1e-9 && (t1 - PI / 2.0).abs() < 1e-9, "{t0} {t1}");
        let at = |t: f64| V2 { x: c.x + major.x * t.cos() - ratio * major.y * t.sin(), y: c.y + major.y * t.cos() + ratio * major.x * t.sin() };
        assert!(dist(at(*t0), p[2]) < 1e-9 && dist(at(*t1), p[p.len() - 1]) < 1e-9);
        assert_eq!(pc.iter().filter(|x| matches!(x, Piece::Poly(..))).count(), 2, "{pc:?}");
        // Nachtesselliert: feiner als die Eingabe.
        let f = refine(&p, true, TOL, &fine_segments).unwrap();
        assert!(f.len() > p.len());
    }

    #[test]
    fn rundfenster_schraeg_ist_ganze_ellipse() {
        let p: Vec<V2> = (0..48).map(|i| {
            let t = 2.0 * PI * i as f64 / 48.0;
            V2 { x: 2.0 + 0.35 * t.cos(), y: 5.0 + 0.6 * t.sin() }
        }).collect();
        let Some(sh @ Shape::Path { .. }) = fit(&p, true, TOL) else { panic!() };
        let Shape::Path { segs, closed, .. } = &sh else { unreachable!() };
        assert!(*closed && segs.len() == 2 && segs.iter().all(|g| matches!(g, Seg::Ell { .. })), "{segs:?}");
        let tot: f64 = segs.iter().map(|g| if let Seg::Ell { sweep, .. } = g { *sweep } else { 0.0 }).sum();
        assert!((tot - 2.0 * PI).abs() < 1e-9);
        assert!(segs.iter().all(|g| matches!(g, Seg::Ell { sweep, .. } if sweep.abs() <= PI + 1e-9)));
    }

    #[test]
    fn ellipse_nicht_aus_zufall() {
        // Gerade, Zickzack, leicht geknickter Zug: keine Ellipse.
        let line: Vec<V2> = (0..8).map(|i| V2 { x: i as f64, y: 0.0 }).collect();
        assert!(fit(&line, false, TOL).is_none());
        let z: Vec<V2> = (0..8).map(|i| V2 { x: i as f64 * 0.3, y: if i % 2 == 0 { 0.0 } else { 0.2 } }).collect();
        assert!(fit(&z, false, TOL).is_none());
        let z = vec![V2 { x: 0.0, y: 0.0 }, V2 { x: 1.0, y: 0.1 }, V2 { x: 2.0, y: 0.1 }, V2 { x: 3.0, y: 0.25 }, V2 { x: 4.0, y: 0.2 }, V2 { x: 5.0, y: 0.4 }, V2 { x: 6.0, y: 0.3 }];
        assert!(fit(&z, false, TOL).is_none());
        // Dicht abgetastete Spirale (Radius wächst): kurze Stücke passen auf eine Ellipse, bleiben aber Zug.
        let sp: Vec<V2> = (0..12).map(|i| {
            let t = i as f64 * 3f64.to_radians();
            let r = 1.0 + 0.05 * t;
            V2 { x: r * t.cos(), y: r * t.sin() }
        }).collect();
        assert!(!matches!(fit(&sp, false, TOL), Some(Shape::Path { ref segs, .. }) if segs.iter().any(|g| matches!(g, Seg::Ell { .. }))));
    }

    /// Ring auf mm gerundet, Punkte `from..=to` von `n` Teilen.
    fn mm_ring(c: V2, r: f64, n: usize, from: usize, to: usize) -> Vec<V2> {
        (from..=to).map(|i| {
            let t = 2.0 * PI * i as f64 / n as f64;
            V2 { x: ((c.x + r * t.cos()) * 1000.0).round() / 1000.0, y: ((c.y + r * t.sin()) * 1000.0).round() / 1000.0 }
        }).collect()
    }

    #[test]
    fn gerundeter_ring_stueckweise_als_bogen() {
        // Erker-Umriss der Decke (r = 2.195, 32 Teile, auf mm gerundet) mit dem Rechteck dahinter.
        let mut p = mm_ring(V2 { x: 15.0, y: 27.0 }, 2.195, 32, 24, 40);
        p.extend([V2 { x: 15.0, y: 32.195 }, V2 { x: -0.195, y: 32.195 }, V2 { x: -0.195, y: 16.805 }, V2 { x: 15.0, y: 16.805 }]);
        let Some(Shape::Path { segs, .. }) = fit(&p, true, TOL) else { panic!("Erker") };
        let arcs: Vec<Seg> = segs.iter().filter(|g| matches!(g, Seg::Arc { .. })).copied().collect();
        assert!(!arcs.is_empty() && arcs.len() <= 2, "{segs:?}");
        let sweep: f64 = arcs.iter().map(|g| if let Seg::Arc { sweep, .. } = g { *sweep } else { 0.0 }).sum();
        assert!((sweep.abs() - PI).abs() < 1e-3, "{sweep}");
        for g in &arcs {
            let Seg::Arc { c, r, .. } = *g else { unreachable!() };
            assert!((r - 2.195).abs() < 5e-4 && dist(c, V2 { x: 15.0, y: 27.0 }) < 5e-4, "{c:?} {r}");
        }
        // Ganzer gerundeter Ring: Kreis.
        let full = mm_ring(V2 { x: 3.0, y: 2.0 }, 1.0, 24, 0, 23);
        assert!(matches!(fit(&full, true, TOL), Some(Shape::Circle { r, .. }) if (r - 1.0).abs() < 5e-4));
        // Versatz eines gerundeten Rings (Treppenloch + 0.22 m), am Rand abgeschnitten: Bogen dazwischen.
        let base = mm_ring(V2 { x: 0.0, y: 0.0 }, 1.0, 24, 0, 23);
        let off: Vec<V2> = base.iter().map(|q| {
            let l = crate::jsmath::hypot2(q.x, q.y);
            V2 { x: q.x * (l + 0.22) / l, y: q.y * (l + 0.22) / l }
        }).collect();
        let mut open: Vec<V2> = vec![V2 { x: -0.1076, y: 1.206 }];
        open.extend(off[6..=18].iter().copied());
        open.push(V2 { x: -0.1076, y: -1.206 });
        let Some(Shape::Path { segs, .. }) = fit(&open, false, TOL) else { panic!("Versatz-Ring") };
        assert_eq!(segs.iter().filter(|g| matches!(g, Seg::Arc { .. })).count(), 1, "{segs:?}");
        // Ein gerundetes Achteck (Schritt 45°) und ein ungleichmässig geteilter Zug bleiben Vielecke.
        assert!(fit(&mm_ring(V2 { x: 0.0, y: 0.0 }, 1.0, 8, 0, 7), true, TOL).is_none());
        let uneven: Vec<V2> = [0.0f64, 3.0, 4.0, 10.0, 11.0, 18.0, 19.0, 25.0].iter().map(|d| {
            let t = d.to_radians() * 4.0;
            V2 { x: ((1.5 * t.cos()) * 1000.0).round() / 1000.0, y: ((1.5 * t.sin()) * 1000.0).round() / 1000.0 }
        }).collect();
        assert!(fit(&uneven, false, TOL).is_none(), "{:?}", fit(&uneven, false, TOL));
        // Höhenlinie (glatte Kurve, alle 2 m abgetastet, Krümmungsradius ≥ 100 m, auf mm gerundet): bleibt Linienzug.
        let contour: Vec<V2> = (0..25).map(|i| {
            let x = i as f64 * 2.0 - 24.0;
            V2 { x, y: ((0.004 * x * x - 0.00005 * x * x * x) * 1000.0).round() / 1000.0 }
        }).collect();
        assert!(fit(&contour, false, TOL).is_none(), "{:?}", fit(&contour, false, TOL));
        // Geländelinie in der Ansicht (fast gerade, verrauscht): Strecken.
        let terrain: Vec<V2> = (0..10).map(|i| V2 { x: i as f64 * 0.5, y: 0.001 * ((i * 7) % 3) as f64 }).collect();
        assert!(fit(&terrain, false, TOL).is_none());
    }

    #[test]
    fn ring_bulges_kreis_und_band() {
        let (v, b) = ring_bulges(&ring(V2 { x: 1.0, y: 1.0 }, 0.5, 32), TOL).unwrap();
        assert_eq!((v.len(), b), (2, vec![1.0, 1.0]));
        assert!((dist(v[0], v[1]) - 1.0).abs() < 1e-9);
        let (v, b) = ring_bulges(&band(), TOL).unwrap();
        assert_eq!(v.len(), 4);
        assert_eq!(b.iter().filter(|x| x.abs() > 0.1).count(), 2);
        assert!(ring_bulges(&[V2 { x: 0.0, y: 0.0 }, V2 { x: 1.0, y: 0.0 }, V2 { x: 1.0, y: 1.0 }, V2 { x: 0.0, y: 1.0 }], TOL).is_none());
        assert!(ring_bulges(&schraeges_rundbogenfenster().0, TOL).is_none());
    }

    #[test]
    fn unsinn_ergibt_nichts() {
        let nan = vec![V2 { x: f64::NAN, y: 0.0 }; 6];
        assert!(fit(&nan, true, TOL).is_none());
        assert!(fit(&[], false, TOL).is_none());
    }
}
