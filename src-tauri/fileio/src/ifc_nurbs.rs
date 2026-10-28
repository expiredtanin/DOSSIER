// IFC-Import ([B3]/[25]): B-Spline-Kurven und -Flächen (auch rational) und gekrümmte Flächen getrimmter
// Brep-Seiten (IfcAdvancedFace, IfcFaceSurface) als Dreiecke. Eigener Code.
//
// Auswertung: Basisfunktionen nach Cox-de Boor (Piegl/Tiller, „The NURBS Book", Alg. A2.1/A2.2), rational
// über homogene Koordinaten. Kurven werden je Knotenintervall so fein zerlegt, bis der Sehnenfehler unter
// `CHORD_TOL` liegt.
//
// Getrimmte Flächen über den Parameterraum (Verfahren wie truck-meshalgo `triangulation.rs`,
// github.com/ricosjp/truck, Apache-2.0 — nur das Vorgehen, kein Code übernommen):
//   1. Die Randschleifen (3D-Punktfolgen der Kanten) werden auf die Fläche projiziert (analytisch für
//      Zylinder/Kegel/Kugel/Torus, sonst Gauss-Newton ab Startwert aus einem Raster) und bei periodischen
//      Richtungen stetig abgewickelt. Schleifen, die einmal ganz herumlaufen (Zylinder zwischen zwei
//      Kreisen, Kugelkappe), werden über die Naht bzw. den Rand des Bereichs geschlossen.
//   2. Randpunkte (als Zwangskanten) und innere Rasterpunkte (Abstand nach Krümmung) gehen in eine
//      eingeschränkte Delaunay-Triangulierung (crate spade); Dreiecke mit Schwerpunkt ausserhalb der
//      Schleifen (gerade/ungerade) fallen weg.
//   3. Randpunkte behalten ihre 3D-Lage (dicht mit der Nachbarfläche, die dieselbe Kante teilt), innere
//      Punkte werden auf der Fläche ausgewertet.
// Gelingt das nicht (Projektion zu ungenau, Naht nicht schliessbar), gibt `tessellate_face` `None`; der
// Aufrufer zerlegt dann die 3D-Schleifen eben.

use crate::ifc_import::{arc_segments, Mesh, Xf, V3};

/// Sehnenfehler beim Zerlegen (m), wie für Kreise in `ifc_import`.
const CHORD_TOL: f64 = 0.002;
/// Höchstzahl Punkte einer zerlegten Kurve.
const MAX_CURVE_POINTS: usize = 100_000;
/// Höchstzahl Rasterlinien je Richtung einer Fläche.
const MAX_LINES: usize = 256;
/// Höchstgrad (Unsinn-Schutz).
const MAX_DEGREE: usize = 25;
/// Höchstzahl Kontrollpunkte einer Fläche.
const MAX_CTRL: usize = 250_000;

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn dist(a: V3, b: V3) -> f64 {
    let d = sub(a, b);
    dot(d, d).sqrt()
}
fn finite(p: V3) -> bool {
    p.iter().all(|v| v.is_finite())
}

/// Knotenvektor aus Vielfachheiten und Werten (IFC-Schreibweise); `None` bei Unsinn.
pub(crate) fn expand_knots(mults: &[i64], knots: &[f64]) -> Option<Vec<f64>> {
    if mults.len() != knots.len() || knots.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for (m, k) in mults.iter().zip(knots) {
        if *m < 1 || *m > 64 || !k.is_finite() {
            return None;
        }
        if out.last().is_some_and(|l: &f64| *k < *l) {
            return None;
        }
        out.extend(std::iter::repeat(*k).take(*m as usize));
        if out.len() > 1_000_000 {
            return None;
        }
    }
    Some(out)
}

/// Knotenintervall `k` mit knots[k] ≤ t < knots[k+1], k ∈ [p, n−1] (n = Zahl Kontrollpunkte).
fn find_span(knots: &[f64], p: usize, n: usize, t: f64) -> usize {
    if t >= knots[n] {
        // Ende: letztes nicht leeres Intervall.
        let mut k = n - 1;
        while k > p && knots[k] >= knots[n] {
            k -= 1;
        }
        return k;
    }
    if t <= knots[p] {
        let mut k = p;
        while k < n - 1 && knots[k + 1] <= knots[p] {
            k += 1;
        }
        return k;
    }
    let (mut lo, mut hi) = (p, n);
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if t < knots[mid] {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    lo
}

/// Nicht verschwindende Basisfunktionen N_{span−p..span, p}(t) (Piegl/Tiller A2.2).
fn basis(knots: &[f64], p: usize, span: usize, t: f64, out: &mut Vec<f64>) {
    out.clear();
    out.resize(p + 1, 0.0);
    out[0] = 1.0;
    let mut left = vec![0.0; p + 1];
    let mut right = vec![0.0; p + 1];
    for j in 1..=p {
        left[j] = t - knots[span + 1 - j];
        right[j] = knots[span + j] - t;
        let mut saved = 0.0;
        for r in 0..j {
            let den = right[r + 1] + left[j - r];
            let tmp = if den != 0.0 { out[r] / den } else { 0.0 };
            out[r] = saved + right[r + 1] * tmp;
            saved = left[j - r] * tmp;
        }
        out[j] = saved;
    }
}

/// B-Spline-Kurve (rational, wenn `weights`), Kontrollpunkte in m.
#[derive(Clone, Debug)]
pub(crate) struct BSplineCurve {
    p: usize,
    ctrl: Vec<V3>,
    weights: Option<Vec<f64>>,
    knots: Vec<f64>,
}

impl BSplineCurve {
    /// Prüft Grad, Anzahl Knoten (= Punkte + Grad + 1), Gewichte (> 0) und Endlichkeit.
    pub(crate) fn new(p: usize, ctrl: Vec<V3>, weights: Option<Vec<f64>>, knots: Vec<f64>) -> Option<Self> {
        let n = ctrl.len();
        if p < 1 || p > MAX_DEGREE || n < p + 1 || knots.len() != n + p + 1 || !ctrl.iter().all(|c| finite(*c)) {
            return None;
        }
        if let Some(w) = &weights {
            if w.len() != n || !w.iter().all(|x| x.is_finite() && *x > 0.0) {
                return None;
            }
        }
        if knots.windows(2).any(|k| k[1] < k[0]) || knots[n] <= knots[p] {
            return None;
        }
        Some(BSplineCurve { p, ctrl, weights, knots })
    }

    /// Parameterbereich [t_p, t_n].
    pub(crate) fn domain(&self) -> (f64, f64) {
        (self.knots[self.p], self.knots[self.ctrl.len()])
    }

    pub(crate) fn eval(&self, t: f64) -> V3 {
        let (a, b) = self.domain();
        let t = t.clamp(a, b);
        let n = self.ctrl.len();
        let span = find_span(&self.knots, self.p, n, t);
        let mut nb = Vec::new();
        basis(&self.knots, self.p, span, t, &mut nb);
        let mut acc = [0.0; 3];
        let mut wsum = 0.0;
        for (j, b) in nb.iter().enumerate() {
            let i = span - self.p + j;
            let w = self.weights.as_ref().map_or(1.0, |w| w[i]);
            acc = add(acc, scale(self.ctrl[i], b * w));
            wsum += b * w;
        }
        if wsum.abs() > 1e-300 { scale(acc, 1.0 / wsum) } else { acc }
    }

    /// Zerlegt [t0, t1] (t0 < t1) adaptiv: Parameter und Punkte.
    pub(crate) fn sample(&self, t0: f64, t1: f64) -> Vec<(f64, V3)> {
        let (a, b) = self.domain();
        let (t0, t1) = (t0.max(a), t1.min(b));
        if !(t0 < t1) {
            return Vec::new();
        }
        // Knoten im Bereich teilen die Intervalle.
        let mut cuts = vec![t0];
        for k in &self.knots {
            if *k > t0 && *k < t1 && cuts.last().is_some_and(|l| k - l > 1e-12 * (t1 - t0)) {
                cuts.push(*k);
            }
        }
        cuts.push(t1);
        let start = if self.p == 1 { 1 } else { 4 };
        let mut out = vec![(t0, self.eval(t0))];
        for w in cuts.windows(2) {
            for i in 0..start {
                let s0 = w[0] + (w[1] - w[0]) * i as f64 / start as f64;
                let s1 = w[0] + (w[1] - w[0]) * (i + 1) as f64 / start as f64;
                self.refine(s0, s1, out.last().map(|x| x.1).unwrap_or([0.0; 3]), 0, &mut out);
                if out.len() > MAX_CURVE_POINTS {
                    return Vec::new();
                }
            }
        }
        out
    }

    fn refine(&self, s0: f64, s1: f64, p0: V3, depth: usize, out: &mut Vec<(f64, V3)>) {
        let p1 = self.eval(s1);
        if self.p > 1 && depth < 10 && out.len() < MAX_CURVE_POINTS {
            let sm = 0.5 * (s0 + s1);
            let pm = self.eval(sm);
            if dist(pm, scale(add(p0, p1), 0.5)) > CHORD_TOL {
                self.refine(s0, sm, p0, depth + 1, out);
                self.refine(sm, s1, pm, depth + 1, out);
                return;
            }
        }
        out.push((s1, p1));
    }
}

/// B-Spline-Fläche (rational, wenn `weights`): Kontrollnetz zeilenweise nu × nv (u = erste Liste).
#[derive(Clone, Debug)]
pub(crate) struct BSplineSurface {
    pu: usize,
    pv: usize,
    nu: usize,
    nv: usize,
    ctrl: Vec<V3>,
    weights: Option<Vec<f64>>,
    uk: Vec<f64>,
    vk: Vec<f64>,
}

impl BSplineSurface {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(pu: usize, pv: usize, rows: Vec<Vec<V3>>, weights: Option<Vec<Vec<f64>>>, uk: Vec<f64>, vk: Vec<f64>) -> Option<Self> {
        let nu = rows.len();
        let nv = rows.first()?.len();
        if pu < 1 || pv < 1 || pu > MAX_DEGREE || pv > MAX_DEGREE || nu < pu + 1 || nv < pv + 1 || nu.saturating_mul(nv) > MAX_CTRL {
            return None;
        }
        if rows.iter().any(|r| r.len() != nv || !r.iter().all(|c| finite(*c))) {
            return None;
        }
        if uk.len() != nu + pu + 1 || vk.len() != nv + pv + 1 {
            return None;
        }
        for k in [&uk, &vk] {
            if k.windows(2).any(|w| w[1] < w[0]) {
                return None;
            }
        }
        if uk[nu] <= uk[pu] || vk[nv] <= vk[pv] {
            return None;
        }
        let weights = match weights {
            Some(w) => {
                if w.len() != nu || w.iter().any(|r| r.len() != nv || !r.iter().all(|x| x.is_finite() && *x > 0.0)) {
                    return None;
                }
                Some(w.into_iter().flatten().collect())
            }
            None => None,
        };
        Some(BSplineSurface { pu, pv, nu, nv, ctrl: rows.into_iter().flatten().collect(), weights, uk, vk })
    }

    fn domain(&self) -> ([f64; 2], [f64; 2]) {
        ([self.uk[self.pu], self.uk[self.nu]], [self.vk[self.pv], self.vk[self.nv]])
    }

    fn eval(&self, u: f64, v: f64) -> V3 {
        let (du, dv) = self.domain();
        let (u, v) = (u.clamp(du[0], du[1]), v.clamp(dv[0], dv[1]));
        let su = find_span(&self.uk, self.pu, self.nu, u);
        let sv = find_span(&self.vk, self.pv, self.nv, v);
        let (mut nu_b, mut nv_b) = (Vec::new(), Vec::new());
        basis(&self.uk, self.pu, su, u, &mut nu_b);
        basis(&self.vk, self.pv, sv, v, &mut nv_b);
        let mut acc = [0.0; 3];
        let mut wsum = 0.0;
        for (a, bu) in nu_b.iter().enumerate() {
            let i = su - self.pu + a;
            for (b, bv) in nv_b.iter().enumerate() {
                let j = sv - self.pv + b;
                let k = i * self.nv + j;
                let w = self.weights.as_ref().map_or(1.0, |w| w[k]) * bu * bv;
                acc = add(acc, scale(self.ctrl[k], w));
                wsum += w;
            }
        }
        if wsum.abs() > 1e-300 { scale(acc, 1.0 / wsum) } else { acc }
    }
}

/// Trägerfläche einer Brep-Seite.
#[derive(Clone, Debug)]
pub(crate) enum Surface {
    /// (Lage, Radius): (r cos u, r sin u, v).
    Cylinder(Xf, f64),
    /// (Lage, Radius bei v = 0, Halbwinkel rad): ((r + v tan a) cos u, …, v).
    Cone(Xf, f64, f64),
    /// (Lage, Radius): (r cos v cos u, r cos v sin u, r sin v).
    Sphere(Xf, f64),
    /// (Lage, R, r): ((R + r cos v) cos u, (R + r cos v) sin u, r sin v).
    Torus(Xf, f64, f64),
    BSpline(BSplineSurface),
}

const TAU: f64 = std::f64::consts::TAU;

impl Surface {
    fn eval(&self, u: f64, v: f64) -> V3 {
        match self {
            Surface::Cylinder(x, r) => x.apply([r * u.cos(), r * u.sin(), v]),
            Surface::Cone(x, r, a) => {
                let rr = r + v * a.tan();
                x.apply([rr * u.cos(), rr * u.sin(), v])
            }
            Surface::Sphere(x, r) => x.apply([r * v.cos() * u.cos(), r * v.cos() * u.sin(), r * v.sin()]),
            Surface::Torus(x, big, r) => {
                let rr = big + r * v.cos();
                x.apply([rr * u.cos(), rr * u.sin(), r * v.sin()])
            }
            Surface::BSpline(s) => s.eval(u, v),
        }
    }

    /// Perioden (u, v); `None` = nicht periodisch.
    fn periods(&self, numeric: (bool, bool)) -> (Option<f64>, Option<f64>) {
        match self {
            Surface::Cylinder(..) | Surface::Cone(..) | Surface::Sphere(..) => (Some(TAU), None),
            Surface::Torus(..) => (Some(TAU), Some(TAU)),
            Surface::BSpline(s) => {
                let (du, dv) = s.domain();
                (numeric.0.then_some(du[1] - du[0]), numeric.1.then_some(dv[1] - dv[0]))
            }
        }
    }

    /// Begrenzung des Parameterbereichs (u, v); unbeschränkt = ±∞.
    fn bounds(&self) -> ([f64; 2], [f64; 2]) {
        let inf = [f64::NEG_INFINITY, f64::INFINITY];
        let half = std::f64::consts::FRAC_PI_2;
        match self {
            Surface::Cylinder(..) | Surface::Cone(..) => (inf, inf),
            Surface::Sphere(..) => (inf, [-half, half]),
            Surface::Torus(..) => (inf, inf),
            Surface::BSpline(s) => s.domain(),
        }
    }

    /// Analytische Projektion (u, v) eines Punkts; `hint_u` für Pole (u dort beliebig).
    fn project_analytic(&self, p: V3, hint_u: Option<f64>) -> Option<(f64, f64)> {
        let (x, l) = match self {
            Surface::Cylinder(x, _) | Surface::Cone(x, _, _) | Surface::Sphere(x, _) | Surface::Torus(x, _, _) => (x, x.inverse()?.apply(p)),
            Surface::BSpline(_) => return None,
        };
        let _ = x;
        let rho = (l[0] * l[0] + l[1] * l[1]).sqrt();
        let pole = |r_ref: f64| rho <= 1e-9 * r_ref.max(1.0);
        let u_of = |r_ref: f64| if pole(r_ref) { hint_u.unwrap_or(0.0) } else { l[1].atan2(l[0]) };
        Some(match self {
            Surface::Cylinder(_, r) => (u_of(*r), l[2]),
            Surface::Cone(_, r, _) => (u_of(*r), l[2]),
            Surface::Sphere(_, r) => {
                let d = (rho * rho + l[2] * l[2]).sqrt();
                let v = if d > 0.0 { (l[2] / d).clamp(-1.0, 1.0).asin() } else { 0.0 };
                (u_of(*r), v)
            }
            Surface::Torus(_, big, r) => {
                let u = u_of(*big + *r);
                (u, l[2].atan2(rho - big))
            }
            Surface::BSpline(_) => return None,
        })
    }
}

/// Rasterlinien (Parameterwerte) einer Richtung im Bereich [a, b]: Knoten, dazu je Intervall so viele
/// gleichmässige Teilungen, bis der Sehnenfehler entlang `iso(t, s)` (s = Werte der anderen Richtung)
/// unter `CHORD_TOL` liegt.
fn lines_for(breaks: &[f64], a: f64, b: f64, cross: &[f64], iso: &dyn Fn(f64, f64) -> V3, linear: bool) -> Vec<f64> {
    let mut cuts: Vec<f64> = vec![a];
    for k in breaks {
        if *k > a && *k < b && cuts.last().is_some_and(|l| k - l > 1e-12 * (b - a).abs().max(1e-300)) {
            cuts.push(*k);
        }
    }
    cuts.push(b);
    let mut out = vec![a];
    for w in cuts.windows(2) {
        let mut n = 1usize;
        if !linear {
            n = 2;
            while n < 64 {
                let mut worst = 0.0f64;
                for &s in cross {
                    for i in 0..n {
                        let t0 = w[0] + (w[1] - w[0]) * i as f64 / n as f64;
                        let t1 = w[0] + (w[1] - w[0]) * (i + 1) as f64 / n as f64;
                        let m = iso(0.5 * (t0 + t1), s);
                        worst = worst.max(dist(m, scale(add(iso(t0, s), iso(t1, s)), 0.5)));
                    }
                }
                if worst <= CHORD_TOL {
                    break;
                }
                n *= 2;
            }
        }
        for i in 1..=n {
            out.push(w[0] + (w[1] - w[0]) * i as f64 / n as f64);
        }
        if out.len() > MAX_LINES {
            break;
        }
    }
    if out.len() > MAX_LINES {
        // Zu fein: gleichmässig ausdünnen.
        let step = out.len() as f64 / MAX_LINES as f64;
        out = (0..MAX_LINES).map(|i| out[((i as f64 * step) as usize).min(out.len() - 1)]).collect();
        if out.last() != Some(&b) {
            out.push(b);
        }
    }
    out
}

/// Arbeitsdaten einer Fläche: Rasterlinien, Projektions-Raster, Perioden, Massstab.
struct Prepared<'a> {
    s: &'a Surface,
    /// Rasterlinien über den ganzen Bereich (nur B-Spline; analytisch nach Bedarf).
    lines: (Vec<f64>, Vec<f64>),
    /// Projektions-Raster (Parameter, Punkt), nur B-Spline.
    grid: Vec<((f64, f64), V3)>,
    periods: (Option<f64>, Option<f64>),
    /// Ausdehnung (m) für Toleranzen.
    size: f64,
}

impl<'a> Prepared<'a> {
    fn new(s: &'a Surface) -> Prepared<'a> {
        let Surface::BSpline(b) = s else {
            return Prepared { s, lines: (Vec::new(), Vec::new()), grid: Vec::new(), periods: s.periods((false, false)), size: 0.0 };
        };
        let (du, dv) = b.domain();
        let ucross = sample_cross(&b.vk, dv);
        let vcross = sample_cross(&b.uk, du);
        let mut us = lines_for(&b.uk, du[0], du[1], &ucross, &|t, s| b.eval(t, s), b.pu == 1);
        let mut vs = lines_for(&b.vk, dv[0], dv[1], &vcross, &|t, s| b.eval(s, t), b.pv == 1);
        refine_twist(&mut us, &mut vs, &|u, v| b.eval(u, v));
        // Projektions-Raster: 17…65 Linien je Richtung.
        let pick = |l: &[f64], d: [f64; 2]| -> Vec<f64> {
            if l.len() < 17 {
                return (0..=16).map(|i| d[0] + (d[1] - d[0]) * i as f64 / 16.0).collect();
            }
            let step = (l.len() as f64 / 64.0).max(1.0);
            let mut o: Vec<f64> = (0..64).map(|i| l[((i as f64 * step) as usize).min(l.len() - 1)]).collect();
            o.push(l[l.len() - 1]);
            o.dedup();
            o
        };
        let (gu, gv) = (pick(&us, du), pick(&vs, dv));
        let grid: Vec<((f64, f64), V3)> = gu.iter().flat_map(|u| gv.iter().map(move |v| (*u, *v))).map(|(u, v)| ((u, v), b.eval(u, v))).collect();
        let pts: Vec<V3> = grid.iter().map(|g| g.1).collect();
        let size = bbox_size(&pts);
        // Periodisch, wenn die gegenüberliegenden Ränder zusammenfallen.
        let tol = 1e-6 * size.max(1e-9);
        let closed_u = gv.iter().all(|v| dist(b.eval(du[0], *v), b.eval(du[1], *v)) <= tol);
        let closed_v = gu.iter().all(|u| dist(b.eval(*u, dv[0]), b.eval(*u, dv[1])) <= tol);
        Prepared { s, lines: (us, vs), grid, periods: s.periods((closed_u, closed_v)), size }
    }

    /// Gauss-Newton von (u, v) aus; Ergebnis (u, v, Abstand).
    fn newton(&self, b: &BSplineSurface, p: V3, (mut u, mut v): (f64, f64)) -> (f64, f64, f64) {
        let (du, dv) = b.domain();
        let (ru, rv) = (du[1] - du[0], dv[1] - dv[0]);
        let wrap = |x: f64, d: [f64; 2], per: Option<f64>| match per {
            Some(pp) if pp > 0.0 => d[0] + (x - d[0]).rem_euclid(pp),
            _ => x.clamp(d[0], d[1]),
        };
        for _ in 0..40 {
            let s = b.eval(u, v);
            let r = sub(s, p);
            let (u0, u1) = ((u - 1e-7 * ru).max(du[0]), (u + 1e-7 * ru).min(du[1]));
            let (v0, v1) = ((v - 1e-7 * rv).max(dv[0]), (v + 1e-7 * rv).min(dv[1]));
            let su = scale(sub(b.eval(u1, v), b.eval(u0, v)), 1.0 / (u1 - u0));
            let sv = scale(sub(b.eval(u, v1), b.eval(u, v0)), 1.0 / (v1 - v0));
            let (a, bb, c) = (dot(su, su), dot(su, sv), dot(sv, sv));
            let (g1, g2) = (dot(su, r), dot(sv, r));
            let det = a * c - bb * bb;
            let (mut du_, mut dv_) = if det > 1e-14 * a * c && det > 0.0 {
                (-(c * g1 - bb * g2) / det, -(a * g2 - bb * g1) / det)
            } else if a > 1e-300 {
                (-g1 / a, 0.0)
            } else if c > 1e-300 {
                (0.0, -g2 / c)
            } else {
                break;
            };
            if !(du_.is_finite() && dv_.is_finite()) {
                break;
            }
            du_ = du_.clamp(-0.25 * ru, 0.25 * ru);
            dv_ = dv_.clamp(-0.25 * rv, 0.25 * rv);
            u = wrap(u + du_, du, self.periods.0);
            v = wrap(v + dv_, dv, self.periods.1);
            if du_.abs() <= 1e-12 * ru && dv_.abs() <= 1e-12 * rv {
                break;
            }
        }
        (u, v, dist(b.eval(u, v), p))
    }

    /// Projektion (u, v, Abstand); `hint` = Parameter des vorigen Randpunkts.
    fn project(&self, p: V3, hint: Option<(f64, f64)>) -> Option<(f64, f64, f64)> {
        let Surface::BSpline(b) = self.s else {
            let (u, v) = self.s.project_analytic(p, hint.map(|h| h.0))?;
            return Some((u, v, dist(self.s.eval(u, v), p)));
        };
        let good = 1e-7 + 1e-7 * self.size;
        let mut best: Option<(f64, f64, f64)> = None;
        if let Some(h) = hint {
            let (du, dv) = b.domain();
            // Hinweis kann abgewickelt sein: in den Bereich zurückführen.
            let w = |x: f64, d: [f64; 2], per: Option<f64>| match per {
                Some(pp) if pp > 0.0 => d[0] + (x - d[0]).rem_euclid(pp),
                _ => x.clamp(d[0], d[1]),
            };
            let r = self.newton(b, p, (w(h.0, du, self.periods.0), w(h.1, dv, self.periods.1)));
            if r.2 <= good {
                return Some(r);
            }
            best = Some(r);
        }
        let start = self.grid.iter().min_by(|a, c| dist(a.1, p).total_cmp(&dist(c.1, p)))?.0;
        let r = self.newton(b, p, start);
        if best.is_none_or(|bst| r.2 < bst.2) {
            best = Some(r);
        }
        best
    }

    /// Rasterlinien (u, v) streng innerhalb der Parameter-Box der Schleifen.
    fn lines_in(&self, ub: [f64; 2], vb: [f64; 2]) -> (Vec<f64>, Vec<f64>) {
        let uniform = |b: [f64; 2], step: f64| -> Vec<f64> {
            if !(step > 0.0 && step.is_finite()) || !(b[1] > b[0]) {
                return Vec::new();
            }
            let k0 = (b[0] / step).floor() as i64 + 1;
            let k1 = (b[1] / step).ceil() as i64 - 1;
            if k1 < k0 || (k1 - k0) as usize > MAX_LINES {
                return Vec::new();
            }
            (k0..=k1).map(|k| k as f64 * step).filter(|x| *x > b[0] && *x < b[1]).collect()
        };
        let ang_step = |r: f64| TAU / arc_segments(TAU, r).max(12) as f64;
        match self.s {
            Surface::Cylinder(_, r) => (uniform(ub, ang_step(*r)), Vec::new()),
            Surface::Cone(_, r, a) => {
                let rmax = (r + vb[0] * a.tan()).abs().max((r + vb[1] * a.tan()).abs());
                (uniform(ub, ang_step(rmax)), Vec::new())
            }
            Surface::Sphere(_, r) => (uniform(ub, ang_step(*r)), uniform(vb, ang_step(*r))),
            Surface::Torus(_, big, r) => (uniform(ub, ang_step(big + r)), uniform(vb, ang_step(*r))),
            Surface::BSpline(_) => {
                let shifted = |l: &[f64], b: [f64; 2], per: Option<f64>| -> Vec<f64> {
                    let mut o = Vec::new();
                    for x in l {
                        match per {
                            Some(pp) if pp > 0.0 => {
                                let k0 = ((b[0] - x) / pp).floor() as i64;
                                let k1 = ((b[1] - x) / pp).ceil() as i64;
                                for k in k0..=k1.min(k0 + 4) {
                                    let y = x + k as f64 * pp;
                                    if y > b[0] && y < b[1] {
                                        o.push(y);
                                    }
                                }
                            }
                            _ => {
                                if *x > b[0] && *x < b[1] {
                                    o.push(*x);
                                }
                            }
                        }
                    }
                    o.sort_by(f64::total_cmp);
                    o.dedup_by(|a, c| (*a - *c).abs() < 1e-12);
                    o
                };
                (shifted(&self.lines.0, ub, self.periods.0), shifted(&self.lines.1, vb, self.periods.1))
            }
        }
    }

    /// Massstab (m je Parametereinheit) in u und v um die Box-Mitte.
    fn metric(&self, ub: [f64; 2], vb: [f64; 2]) -> (f64, f64) {
        let vm = 0.5 * (vb[0] + vb[1]);
        let (su, sv) = match self.s {
            Surface::Cylinder(_, r) => (*r, 1.0),
            Surface::Cone(_, r, a) => ((r + vm * a.tan()).abs(), 1.0 / a.cos().abs().max(1e-6)),
            Surface::Sphere(_, r) => (r * vm.cos().abs(), *r),
            Surface::Torus(_, big, r) => (big + r * vm.cos(), *r),
            Surface::BSpline(_) => {
                // Mittlere Länge der Iso-Linien je Parameterspanne.
                let n = 8;
                let (mut lu, mut lv) = (0.0, 0.0);
                let at = |b: [f64; 2], f: f64| b[0] + (b[1] - b[0]) * f;
                for i in 0..=n {
                    let f = i as f64 / n as f64;
                    let (uu, vv) = (at(ub, f), at(vb, f));
                    for j in 0..n {
                        let (g0, g1) = (j as f64 / n as f64, (j + 1) as f64 / n as f64);
                        lu += dist(self.eval(at(ub, g0), vv), self.eval(at(ub, g1), vv));
                        lv += dist(self.eval(uu, at(vb, g0)), self.eval(uu, at(vb, g1)));
                    }
                }
                (lu / (n + 1) as f64 / (ub[1] - ub[0]).max(1e-300), lv / (n + 1) as f64 / (vb[1] - vb[0]).max(1e-300))
            }
        };
        let fix = |x: f64| if x.is_finite() && x > 1e-12 { x } else { 1.0 };
        (fix(su), fix(sv))
    }

    /// Auswertung mit Rückführung periodischer Parameter in den Bereich.
    fn eval(&self, u: f64, v: f64) -> V3 {
        if let Surface::BSpline(b) = self.s {
            let (du, dv) = b.domain();
            let w = |x: f64, d: [f64; 2], per: Option<f64>| match per {
                Some(pp) if pp > 0.0 => d[0] + (x - d[0]).rem_euclid(pp),
                _ => x,
            };
            return b.eval(w(u, du, self.periods.0), w(v, dv, self.periods.1));
        }
        self.s.eval(u, v)
    }
}

/// Randpunkt im Parameterraum mit 3D-Lage (`None` = auf der Fläche auswerten, z. B. an der Naht).
type PPoint = ([f64; 2], Option<V3>);

/// Projiziert und schliesst die Randschleifen; `None`, wenn das nicht gelingt.
fn param_loops(prep: &Prepared, loops: &[Vec<V3>], same_sense: bool) -> Option<Vec<Vec<PPoint>>> {
    let tol = 0.01 + 1e-3 * prep.size;
    let (pu, pv) = prep.periods;
    let unwrap = |x: f64, prev: f64, per: Option<f64>| match per {
        Some(pp) if pp > 0.0 => x + ((prev - x) / pp).round() * pp,
        _ => x,
    };
    let mut closed: Vec<Vec<PPoint>> = Vec::new();
    let mut open_u: Vec<(Vec<PPoint>, f64)> = Vec::new();
    let mut open_v: Vec<(Vec<PPoint>, f64)> = Vec::new();
    for l in loops {
        let mut out: Vec<PPoint> = Vec::with_capacity(l.len() + 1);
        let mut hint: Option<(f64, f64)> = None;
        for p in l {
            let (mut u, mut v, d) = prep.project(*p, hint)?;
            if !(d <= tol && u.is_finite() && v.is_finite()) {
                return None;
            }
            if let Some(h) = hint {
                u = unwrap(u, h.0, pu);
                v = unwrap(v, h.1, pv);
            }
            hint = Some((u, v));
            out.push(([u, v], Some(*p)));
        }
        if out.len() < 2 {
            continue;
        }
        // Schleifen sind ohne doppelten Schlusspunkt; der Rückweg zum Start entscheidet, ob die
        // Schleife im Parameterraum geschlossen ist oder eine Periode weit herumläuft.
        let (f, z) = (out[0].0, out[out.len() - 1].0);
        let back = |x0: f64, x1: f64, per: Option<f64>| per.map(|pp| ((x1 - x0) / pp).round()).unwrap_or(0.0);
        let (gap_u, gap_v) = (back(f[0], unwrap(f[0], z[0], pu), pu), back(f[1], unwrap(f[1], z[1], pv), pv));
        if gap_u == 0.0 && gap_v == 0.0 {
            if out.len() >= 3 {
                closed.push(out);
            }
        } else {
            // Schlusspunkt (= Start eine Periode weiter) anhängen: offener Umlauf.
            let mut end = f;
            end[0] = unwrap(f[0], z[0], pu);
            end[1] = unwrap(f[1], z[1], pv);
            let p0 = out[0].1;
            out.push((end, p0));
            if gap_u.abs() == 1.0 && gap_v == 0.0 {
                open_u.push((out, gap_u));
            } else if gap_v.abs() == 1.0 && gap_u == 0.0 {
                open_v.push((out, gap_v));
            } else {
                return None;
            }
        }
    }
    let (bu, bv) = prep.s.bounds();
    // Künstliche Randstücke (Naht, Pol, Bereichsrand) fein unterteilen, sonst schneidet die Sehne ab.
    let span = |b: [f64; 2], per: Option<f64>| per.unwrap_or(b[1] - b[0]);
    let (ru, rv) = (span(bu, pu), span(bv, pv));
    let bridge = |from: [f64; 2], to: [f64; 2]| -> Vec<PPoint> {
        let f = |d: f64, r: f64| if r.is_finite() && r > 0.0 { d.abs() / r } else { 0.0 };
        let n = ((64.0 * f(to[0] - from[0], ru).max(f(to[1] - from[1], rv))).ceil() as usize).clamp(1, 256);
        (1..n).map(|i| {
            let t = i as f64 / n as f64;
            ([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t], None)
        }).collect()
    };
    for (opens, axis, per) in [(open_u, 0usize, pu), (open_v, 1usize, pv)] {
        if opens.is_empty() {
            continue;
        }
        let per = per?;
        let other = 1 - axis;
        let bounds = if axis == 0 { bv } else { bu };
        match opens.len() {
            2 if opens[0].1 != opens[1].1 => {
                // Zwei gegenläufige Umläufe (Zylinder zwischen zwei Kreisen): über die Naht verbinden.
                let (a, _) = &opens[0];
                let (b, _) = &opens[1];
                let k = ((a[a.len() - 1].0[axis] - b[0].0[axis]) / per).round();
                let b: Vec<PPoint> = b.iter().map(|(q, p3)| {
                    let mut q = *q;
                    q[axis] += k * per;
                    (q, *p3)
                }).collect();
                let mut joined = a.clone();
                joined.extend(bridge(a[a.len() - 1].0, b[0].0));
                joined.extend(b.iter().copied());
                joined.extend(bridge(b[b.len() - 1].0, a[0].0));
                closed.push(joined);
            }
            1 => {
                // Ein Umlauf (Kugelkappe): über den Rand des Bereichs auf der Seite der Fläche schliessen.
                let (a, sign) = &opens[0];
                // Gegen den Uhrzeigersinn um die Flächennormale ⇔ Fläche links (bei v-Umlauf gespiegelt).
                let left = (*sign > 0.0) == same_sense;
                let to_max = if axis == 0 { left } else { !left };
                let edge = if to_max { bounds[1] } else { bounds[0] };
                if !edge.is_finite() {
                    return None;
                }
                let (s0, s1) = (a[0].0, a[a.len() - 1].0);
                let mut joined = a.clone();
                let mut q1 = s1;
                q1[other] = edge;
                let mut q0 = s0;
                q0[other] = edge;
                joined.extend(bridge(s1, q1));
                joined.push((q1, None));
                joined.extend(bridge(q1, q0));
                joined.push((q0, None));
                joined.extend(bridge(q0, s0));
                closed.push(joined);
            }
            _ => return None,
        }
    }
    (!closed.is_empty()).then_some(closed)
}

/// Gerade/ungerade-Test gegen Randsegmente, nach v in Streifen einsortiert.
struct Inside {
    segs: Vec<([f64; 2], [f64; 2])>,
    buckets: Vec<Vec<usize>>,
    v0: f64,
    dv: f64,
}

impl Inside {
    fn new(loops: &[Vec<[f64; 2]>]) -> Inside {
        let mut segs = Vec::new();
        for l in loops {
            for i in 0..l.len() {
                segs.push((l[i], l[(i + 1) % l.len()]));
            }
        }
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for (a, b) in &segs {
            lo = lo.min(a[1]).min(b[1]);
            hi = hi.max(a[1]).max(b[1]);
        }
        let nb = (segs.len() / 8).clamp(1, 256);
        let dv = ((hi - lo) / nb as f64).max(1e-300);
        let mut buckets = vec![Vec::new(); nb];
        for (k, (a, b)) in segs.iter().enumerate() {
            let i0 = (((a[1].min(b[1]) - lo) / dv).floor() as isize).clamp(0, nb as isize - 1) as usize;
            let i1 = (((a[1].max(b[1]) - lo) / dv).floor() as isize).clamp(0, nb as isize - 1) as usize;
            for bk in &mut buckets[i0..=i1] {
                bk.push(k);
            }
        }
        Inside { segs, buckets, v0: lo, dv }
    }

    fn contains(&self, p: [f64; 2]) -> bool {
        let nb = self.buckets.len() as isize;
        let i = ((p[1] - self.v0) / self.dv).floor() as isize;
        if !(p[0].is_finite() && p[1].is_finite()) || i < 0 || i >= nb {
            return false;
        }
        let mut inside = false;
        for &k in &self.buckets[i as usize] {
            let (a, b) = self.segs[k];
            if (a[1] > p[1]) != (b[1] > p[1]) {
                let x = a[0] + (p[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
                if p[0] < x {
                    inside = !inside;
                }
            }
        }
        inside
    }
}

/// Getrimmte Fläche → Dreiecke. `loops`: Randschleifen in 3D ohne doppelten Schlusspunkt (aussen gegen
/// den Uhrzeigersinn um die Seiten-Normale), `same_sense`: Seiten-Normale = Flächen-Normale.
/// `None` → der Aufrufer zerlegt eben.
pub(crate) fn tessellate_face(s: &Surface, loops: &[Vec<V3>], same_sense: bool) -> Option<Mesh> {
    use spade::{ConstrainedDelaunayTriangulation, Point2, Triangulation};
    type Cdt = ConstrainedDelaunayTriangulation<Point2<f64>>;
    let prep = Prepared::new(s);
    let ploops = param_loops(&prep, loops, same_sense)?;
    let (mut ub, mut vb) = ([f64::INFINITY, f64::NEG_INFINITY], [f64::INFINITY, f64::NEG_INFINITY]);
    for l in &ploops {
        for (q, _) in l {
            ub = [ub[0].min(q[0]), ub[1].max(q[0])];
            vb = [vb[0].min(q[1]), vb[1].max(q[1])];
        }
    }
    if !(ub[0].is_finite() && ub[1].is_finite() && vb[0].is_finite() && vb[1].is_finite()) {
        return None;
    }
    let (su, sv) = prep.metric(ub, vb);
    let to2 = |q: [f64; 2]| [q[0] * su, q[1] * sv];
    let (lu, lv) = prep.lines_in(ub, vb);
    // In beiden Richtungen gekrümmt oder verdrillt: lange Randstücke (gerade Kanten) so fein teilen wie
    // das Raster, sonst reichen Randdreiecke weit von der Fläche weg. Zwischenpunkte linear in 3D (auf
    // der Kante der Nachbarseite) und im Parameterraum.
    let ploops = if lu.len() >= 1 && lv.len() >= 1 {
        let gap = |l: &[f64], s: f64| l.windows(2).map(|w| (w[1] - w[0]) * s).fold(f64::INFINITY, f64::min);
        let h = gap(&lu, su).min(gap(&lv, sv)).max(1e-9);
        ploops
            .into_iter()
            .map(|l| {
                let mut out: Vec<PPoint> = Vec::with_capacity(l.len());
                for i in 0..l.len() {
                    let (a, b) = (l[i], l[(i + 1) % l.len()]);
                    out.push(a);
                    let (sa, sb) = (to2(a.0), to2(b.0));
                    let d = ((sb[0] - sa[0]).powi(2) + (sb[1] - sa[1]).powi(2)).sqrt();
                    // Nur deutlich längere Stücke als das Raster (Kurvenstücke sind schon fein).
                    let n = if d > 2.0 * h { ((d / h).ceil() as usize).min(256) } else { 1 };
                    for k in 1..n {
                        let t = k as f64 / n as f64;
                        let q = [a.0[0] + (b.0[0] - a.0[0]) * t, a.0[1] + (b.0[1] - a.0[1]) * t];
                        let p3 = match (a.1, b.1) {
                            (Some(x), Some(y)) => Some(add(x, scale(sub(y, x), t))),
                            _ => None,
                        };
                        out.push((q, p3));
                    }
                }
                out
            })
            .collect()
    } else {
        ploops
    };
    let scaled: Vec<Vec<[f64; 2]>> = ploops.iter().map(|l| l.iter().map(|(q, _)| to2(*q)).collect()).collect();
    let inside = Inside::new(&scaled);

    let mut cdt = Cdt::new();
    // Vertex-Index → (Parameter, 3D-Lage falls vom Rand).
    let mut verts: Vec<PPoint> = Vec::new();
    let insert = |cdt: &mut Cdt, q: [f64; 2], p3: Option<V3>, verts: &mut Vec<PPoint>| {
        let s2 = to2(q);
        if !(s2[0].is_finite() && s2[1].is_finite()) {
            return None;
        }
        let h = cdt.insert(Point2::new(s2[0], s2[1])).ok()?;
        let i = h.index();
        if i >= verts.len() {
            verts.resize(i + 1, ([0.0; 2], None));
            verts[i] = (q, p3);
        }
        Some(h)
    };
    for l in &ploops {
        let hs: Vec<_> = l.iter().map(|(q, p3)| insert(&mut cdt, *q, *p3, &mut verts)).collect();
        for i in 0..hs.len() {
            if let (Some(a), Some(b)) = (hs[i], hs[(i + 1) % hs.len()]) {
                if a != b {
                    cdt.try_add_constraint(a, b);
                }
            }
        }
    }
    // Innere Rasterpunkte.
    for v in &lv {
        for u in &lu {
            let q = [*u, *v];
            if inside.contains(to2(q)) {
                insert(&mut cdt, q, None, &mut verts);
            }
        }
    }
    // Nachverfeinern: Dreiecke, deren Mitte mehr als den Sehnenfehler (plus die Abweichung ihrer
    // Randpunkte von der Fläche) neben der Fläche liegt, bekommen dort einen Punkt (z. B. Löcher im
    // Zylinder, wo Dreiecke sonst weit über den Umfang reichen).
    // Je Vertex: 3D-Lage und Abstand der Randlage von der Fläche.
    let mut pos: Vec<(V3, f64)> = Vec::new();
    let mut added = 0usize;
    for _ in 0..8 {
        while pos.len() < verts.len() {
            let (q, p3) = verts[pos.len()];
            let on = prep.eval(q[0], q[1]);
            pos.push(match p3 {
                Some(p) => (p, dist(p, on)),
                None => (on, 0.0),
            });
        }
        let mut more: Vec<[f64; 2]> = Vec::new();
        for f in cdt.inner_faces() {
            let vs = f.vertices();
            let ids = vs.map(|v| v.fix().index());
            let c2 = vs.iter().fold([0.0; 2], |a, v| [a[0] + v.position().x / 3.0, a[1] + v.position().y / 3.0]);
            if ids.iter().any(|i| *i >= pos.len()) || !inside.contains(c2) {
                continue;
            }
            let qc = ids.iter().fold([0.0; 2], |a, i| [a[0] + verts[*i].0[0] / 3.0, a[1] + verts[*i].0[1] / 3.0]);
            let mid = ids.iter().fold([0.0; 3], |a, i| add(a, scale(pos[*i].0, 1.0 / 3.0)));
            let slack = ids.iter().map(|i| pos[*i].1).fold(0.0, f64::max);
            if dist(prep.eval(qc[0], qc[1]), mid) > CHORD_TOL + slack {
                more.push(qc);
            }
        }
        if more.is_empty() || added > 50_000 {
            break;
        }
        added += more.len();
        for q in more {
            insert(&mut cdt, q, None, &mut verts);
        }
    }
    let mut mesh = Mesh::default();
    for (q, p3) in &verts {
        mesh.push_v(p3.unwrap_or_else(|| prep.eval(q[0], q[1])));
    }
    if !mesh.positions.iter().all(|x| x.is_finite()) {
        return None;
    }
    for f in cdt.inner_faces() {
        let [a, b, c] = f.vertices();
        let (pa, pb, pc) = (a.position(), b.position(), c.position());
        let centroid = [(pa.x + pb.x + pc.x) / 3.0, (pa.y + pb.y + pc.y) / 3.0];
        if !inside.contains(centroid) {
            continue;
        }
        let (ia, ib, ic) = (a.fix().index() as u32, b.fix().index() as u32, c.fix().index() as u32);
        if same_sense {
            mesh.tri(ia, ib, ic);
        } else {
            mesh.tri(ia, ic, ib);
        }
    }
    (!mesh.is_empty()).then_some(mesh)
}

/// Verdrillung: auch wo beide Iso-Richtungen gerade sind (bilineares Flächenstück), weicht die Fläche
/// von zwei Dreiecken um |P00 + P11 − P10 − P01| / 4 ab. Zellen darüber werden in beiden Richtungen
/// geteilt.
fn refine_twist(us: &mut Vec<f64>, vs: &mut Vec<f64>, eval: &dyn Fn(f64, f64) -> V3) {
    for _ in 0..8 {
        if us.len() < 2 || vs.len() < 2 {
            return;
        }
        let mut split_u = vec![false; us.len() - 1];
        let mut split_v = vec![false; vs.len() - 1];
        let pts: Vec<Vec<V3>> = us.iter().map(|u| vs.iter().map(|v| eval(*u, *v)).collect()).collect();
        for i in 0..us.len() - 1 {
            for j in 0..vs.len() - 1 {
                let t = sub(add(pts[i][j], pts[i + 1][j + 1]), add(pts[i + 1][j], pts[i][j + 1]));
                if dot(t, t).sqrt() / 4.0 > CHORD_TOL {
                    split_u[i] = true;
                    split_v[j] = true;
                }
            }
        }
        let grow = |l: &mut Vec<f64>, s: &[bool]| {
            let mut o = Vec::with_capacity(l.len() * 2);
            for i in 0..l.len() - 1 {
                o.push(l[i]);
                if s[i] {
                    o.push(0.5 * (l[i] + l[i + 1]));
                }
            }
            o.push(l[l.len() - 1]);
            *l = o;
        };
        if !split_u.iter().any(|x| *x) || us.len() * 2 > MAX_LINES || vs.len() * 2 > MAX_LINES {
            return;
        }
        grow(us, &split_u);
        grow(vs, &split_v);
    }
}

fn sample_cross(knots: &[f64], d: [f64; 2]) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for k in knots {
        if *k >= d[0] && *k <= d[1] && !out.last().is_some_and(|l| (k - l).abs() < 1e-12) {
            out.push(*k);
        }
    }
    let mids: Vec<f64> = out.windows(2).map(|w| 0.5 * (w[0] + w[1])).collect();
    out.extend(mids);
    if out.len() > 16 {
        let step = out.len() as f64 / 16.0;
        out = (0..16).map(|i| out[(i as f64 * step) as usize]).collect();
    }
    out
}

fn bbox_size(pts: &[V3]) -> f64 {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in pts {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    if lo[0] > hi[0] { 0.0 } else { dist(lo, hi) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: f64 = std::f64::consts::FRAC_1_SQRT_2;

    /// Rationaler Vollkreis (Grad 2, 9 Punkte) mit Radius `r` in Höhe `z`.
    fn circle(r: f64, z: f64) -> BSplineCurve {
        let c = [(1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (-1.0, 1.0), (-1.0, 0.0), (-1.0, -1.0), (0.0, -1.0), (1.0, -1.0), (1.0, 0.0)];
        let pts = c.iter().map(|(a, b)| [r * a, r * b, z]).collect();
        let w = vec![1.0, W, 1.0, W, 1.0, W, 1.0, W, 1.0];
        let k = expand_knots(&[3, 2, 2, 2, 3], &[0.0, 0.25, 0.5, 0.75, 1.0]).unwrap();
        BSplineCurve::new(2, pts, Some(w), k).unwrap()
    }

    fn area(m: &Mesh) -> f64 {
        let p = |i: u32| {
            let k = i as usize * 3;
            [m.positions[k], m.positions[k + 1], m.positions[k + 2]]
        };
        m.indices.chunks_exact(3).map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            let (u, v) = (sub(b, a), sub(c, a));
            let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            0.5 * dot(n, n).sqrt()
        }).sum()
    }

    /// Mittlere Flächennormale · `dir` > 0 (Orientierung).
    fn facing(m: &Mesh, at: impl Fn(V3) -> V3) -> f64 {
        let p = |i: u32| {
            let k = i as usize * 3;
            [m.positions[k], m.positions[k + 1], m.positions[k + 2]]
        };
        m.indices.chunks_exact(3).map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            let (u, v) = (sub(b, a), sub(c, a));
            let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            dot(n, at(scale(add(add(a, b), c), 1.0 / 3.0)))
        }).sum()
    }

    #[test]
    fn rational_circle_is_exact_and_sampled_within_tolerance() {
        let c = circle(2.0, 0.0);
        for i in 0..=100 {
            let p = c.eval(i as f64 / 100.0);
            assert!((dot(p, p).sqrt() - 2.0).abs() < 1e-12, "{p:?}");
        }
        let s = c.sample(0.0, 1.0);
        assert!(dist(s[0].1, [2.0, 0.0, 0.0]) < 1e-12 && dist(s[s.len() - 1].1, [2.0, 0.0, 0.0]) < 1e-12);
        // Sehnenfehler: Mitte jeder Sehne höchstens CHORD_TOL innerhalb des Kreises.
        for w in s.windows(2) {
            let m = scale(add(w[0].1, w[1].1), 0.5);
            assert!(2.0 - dot(m, m).sqrt() <= CHORD_TOL + 1e-9);
            assert!(w[1].0 > w[0].0);
        }
        // Teilbereich.
        let q = c.sample(0.0, 0.25);
        assert!(dist(q[q.len() - 1].1, [0.0, 2.0, 0.0]) < 1e-12);
    }

    #[test]
    fn nonsense_curves_and_surfaces_are_rejected() {
        let k = |m: &[i64], v: &[f64]| expand_knots(m, v);
        assert!(k(&[2, 2], &[0.0, 1.0]).is_some());
        assert!(k(&[2, 2], &[1.0, 0.0]).is_none());
        assert!(k(&[0, 2], &[0.0, 1.0]).is_none());
        assert!(k(&[2], &[0.0, 1.0]).is_none());
        assert!(k(&[2, 2], &[0.0, f64::NAN]).is_none());
        let line = vec![[0.0; 3], [1.0, 0.0, 0.0]];
        let kn = vec![0.0, 0.0, 1.0, 1.0];
        assert!(BSplineCurve::new(1, line.clone(), None, kn.clone()).is_some());
        assert!(BSplineCurve::new(2, line.clone(), None, kn.clone()).is_none());
        assert!(BSplineCurve::new(1, line.clone(), Some(vec![1.0, -1.0]), kn.clone()).is_none());
        assert!(BSplineCurve::new(1, vec![[0.0; 3], [f64::NAN; 3]], None, kn.clone()).is_none());
        assert!(BSplineCurve::new(1, line.clone(), None, vec![0.0, 0.0, 0.0, 0.0]).is_none());
        assert!(BSplineSurface::new(1, 1, vec![vec![[0.0; 3]; 2]; 2], None, kn.clone(), kn.clone()).is_some());
        assert!(BSplineSurface::new(1, 1, vec![vec![[0.0; 3]; 2], vec![[0.0; 3]; 3]], None, kn.clone(), kn.clone()).is_none());
        assert!(BSplineSurface::new(1, 1, vec![vec![[0.0; 3]; 2]; 2], Some(vec![vec![1.0; 2]; 1]), kn.clone(), kn.clone()).is_none());
        assert!(BSplineSurface::new(30, 1, vec![vec![[0.0; 3]; 2]; 2], None, kn.clone(), kn).is_none());
        // Fläche ohne brauchbare Schleifen: nichts, kein Panic.
        let cyl = Surface::Cylinder(Xf::IDENTITY, 1.0);
        assert!(tessellate_face(&cyl, &[], true).is_none());
        assert!(tessellate_face(&cyl, &[vec![[f64::NAN; 3]; 4]], true).is_none());
        assert!(tessellate_face(&cyl, &[vec![[5.0, 0.0, 0.0], [5.0, 1.0, 0.0], [5.0, 1.0, 1.0]]], true).is_none());
    }

    #[test]
    fn cylinder_between_two_circles_and_with_window() {
        // Mantel r = 1, h = 2 zwischen zwei Kreisen (ohne Naht): Fläche 4π, Normale nach aussen.
        let ring = |z: f64, rev: bool| -> Vec<V3> {
            let n = 64;
            let mut v: Vec<V3> = (0..n).map(|i| {
                let t = TAU * i as f64 / n as f64;
                [t.cos(), t.sin(), z]
            }).collect();
            if rev {
                v.reverse();
            }
            v
        };
        let cyl = Surface::Cylinder(Xf::IDENTITY, 1.0);
        let m = tessellate_face(&cyl, &[ring(0.0, false), ring(2.0, true)], true).unwrap();
        let polygon = 128.0 * (TAU / 128.0).sin() * 2.0; // Umfang des 64-Ecks × Höhe
        assert!((area(&m) - polygon).abs() < 1e-9, "{}", area(&m));
        assert!(facing(&m, |c| [c[0], c[1], 0.0]) > 0.0);
        // Gegensinn: Normale nach innen.
        let m = tessellate_face(&cyl, &[ring(0.0, false), ring(2.0, true)], false).unwrap();
        assert!(facing(&m, |c| [c[0], c[1], 0.0]) < 0.0);
        // Rechteckiges Stück über die Naht (u ∈ [−0.5, 0.5]) mit Loch.
        let arc = |u0: f64, u1: f64, z: f64| -> Vec<V3> {
            (0..=16).map(|i| {
                let t = u0 + (u1 - u0) * i as f64 / 16.0;
                [t.cos(), t.sin(), z]
            }).collect()
        };
        let mut outer = arc(-0.5, 0.5, 0.0);
        outer.extend(arc(0.5, -0.5, 1.0));
        let mut hole = arc(-0.2, 0.2, 0.7);
        hole.extend(arc(0.2, -0.2, 0.3));
        hole.reverse();
        let m = tessellate_face(&cyl, &[outer, hole], true).unwrap();
        let chord = |a: f64| 2.0 * (a / 32.0).sin() * 16.0; // 16 Sehnen über den Winkel a
        let want = chord(1.0) * 1.0 - chord(0.4) * 0.4;
        // Zwischen Loch und Rand nachverfeinert: bis auf den Sehnenfehler.
        assert!((area(&m) - want).abs() / want < 1e-3, "{} ≠ {want}", area(&m));
    }

    #[test]
    fn hemisphere_from_equator_closes_at_the_pole() {
        let n = 96;
        let eq: Vec<V3> = (0..n).map(|i| {
            let t = TAU * i as f64 / n as f64;
            [t.cos(), t.sin(), 0.0]
        }).collect();
        let sph = Surface::Sphere(Xf::IDENTITY, 1.0);
        let up = tessellate_face(&sph, &[eq.clone()], true).unwrap();
        assert!((area(&up) - TAU).abs() / TAU < 0.01, "{}", area(&up));
        assert!(up.positions.chunks_exact(3).all(|p| p[2] >= -1e-12));
        assert!(facing(&up, |c| c) > 0.0);
        // Gleiche Schleife rückwärts: untere Halbkugel.
        let mut rev = eq;
        rev.reverse();
        let down = tessellate_face(&sph, &[rev], true).unwrap();
        assert!(down.positions.chunks_exact(3).all(|p| p[2] <= 1e-12));
        assert!(facing(&down, |c| c) > 0.0);
    }

    #[test]
    fn twisted_bilinear_patch_is_refined() {
        // Bilineares Flächenstück mit 90° Verdrillung: zwei Dreiecke wären bis 0.25 m daneben.
        let kn = vec![0.0, 0.0, 1.0, 1.0];
        let rows = vec![vec![[-0.5, -0.5, 0.0], [0.5, -0.5, 1.0]], vec![[0.5, -0.5, 0.0], [0.5, 0.5, 1.0]]];
        let s = Surface::BSpline(BSplineSurface::new(1, 1, rows, None, kn.clone(), kn).unwrap());
        let lp = vec![[-0.5, -0.5, 0.0], [0.5, -0.5, 0.0], [0.5, 0.5, 1.0], [0.5, -0.5, 1.0]];
        let m = tessellate_face(&s, &[lp], true).unwrap();
        assert!(m.triangle_count() > 50);
        // Jede Dreiecksmitte liegt nahe der Fläche: S(u, v) = (1−u)(1−v)P00 + …
        let Surface::BSpline(b) = &s else { unreachable!() };
        let prep = Prepared::new(&s);
        for t in m.indices.chunks_exact(3) {
            let c = (0..3).fold([0.0; 3], |acc, k| {
                let i = t[k] as usize * 3;
                add(acc, scale([m.positions[i], m.positions[i + 1], m.positions[i + 2]], 1.0 / 3.0))
            });
            let (_, _, d) = prep.newton(b, c, (0.5, 0.5));
            assert!(d < 3.0 * CHORD_TOL, "{d}");
        }
    }
}
