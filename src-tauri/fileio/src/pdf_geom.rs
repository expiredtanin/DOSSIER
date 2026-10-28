// Geometrie-Helfer des Vektor-PDF-Lesers ([76]): Kreise/Bögen aus Bézier-Folgen erkennen und
// Clip-Pfade (W/W*, Form-BBox) auf Linien und Flächen anwenden. Nur lokale 2D-Rechnung in pt,
// bewusst ohne i_overlay/`dossier-core` (fileio bleibt ein eigenständiges Paket).
//
// Kreise/Bögen: eine Folge von Kubiken wird nur dann zum Kreis/Bogen, wenn alle Stützpunkte auf
// einem gemeinsamen Kreis liegen (Toleranz relativ zum Radius, [`FIT_REL_TOL`]), der Umlaufsinn
// einheitlich ist und die Gesamtdrehung ≥ [`MIN_SWEEP`] beträgt. Alles andere bleibt Vieleck.
//
// Clips: achsenparalleles Rechteck (Normalfall: Ansichtsfenster/Seite/Form-BBox) wird exakt mit
// Liang-Barsky bzw. Sutherland-Hodgman beschnitten; ein allgemeines Polygon beschneidet Linien exakt
// (Schnittparameter mit allen Kanten, Mittelpunktstest je Teilstück). Gefüllte Flächen werden bei
// konvexem Clip exakt beschnitten, sonst nur an seiner Hüllbox (Näherung).

use std::f64::consts::{PI, TAU};

/// Zulässige Abweichung der Stützpunkte vom Kreis, relativ zum Radius.
pub const FIT_REL_TOL: f64 = 0.004;
/// … plus absolut (pt), damit winzige Kreise nicht an Rundung scheitern.
const FIT_ABS_TOL: f64 = 0.01;
/// Kleinste Gesamtdrehung (rad) eines Bogens; flachere Kurven bleiben Linienzug.
pub const MIN_SWEEP: f64 = 0.05;
/// Höchstzahl Eckpunkte eines Clip-Polygons; mehr → nur Hüllbox.
const MAX_CLIP_VERTS: usize = 5000;
const EPS: f64 = 1e-7;

type P = [f64; 2];

/// Kreis oder Kreisbogen (Winkel in Radiant, gegen den Uhrzeigersinn von `a0` nach `a1`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PdfCurve {
    pub circle: bool,
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
    pub a0: f64,
    pub a1: f64,
}

/// Eine kubische Bézier-Kurve (Start, zwei Stützpunkte, Ende).
pub type Cubic = [P; 4];

fn bez(c: &Cubic, t: f64) -> P {
    let u = 1.0 - t;
    let (a, b, d, e) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]]
}

fn wrap_pi(mut d: f64) -> f64 {
    while d > PI {
        d -= TAU;
    }
    while d <= -PI {
        d += TAU;
    }
    d
}

/// Passt Kreis/Bogen an eine zusammenhängende Kubikfolge an. `closed` = Teilpfad ist mit `h`
/// geschlossen (dann nur ein voller Kreis zulässig). `None` = kein Kreis/Bogen.
pub fn fit_curve(cubics: &[Cubic], closed: bool) -> Option<PdfCurve> {
    if cubics.is_empty() || cubics.len() > 64 {
        return None;
    }
    let mut s: Vec<P> = Vec::with_capacity(cubics.len() * 4 + 1);
    for c in cubics {
        if c.iter().any(|p| !(p[0].is_finite() && p[1].is_finite())) {
            return None;
        }
        for k in 0..4 {
            s.push(bez(c, k as f64 / 4.0));
        }
    }
    s.push(cubics[cubics.len() - 1][3]);
    let n = s.len() as f64;
    let (mx, my) = (s.iter().map(|p| p[0]).sum::<f64>() / n, s.iter().map(|p| p[1]).sum::<f64>() / n);
    let (mut suu, mut suv, mut svv, mut suuu, mut svvv, mut suvv, mut svuu) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for p in &s {
        let (u, v) = (p[0] - mx, p[1] - my);
        suu += u * u;
        suv += u * v;
        svv += v * v;
        suuu += u * u * u;
        svvv += v * v * v;
        suvv += u * v * v;
        svuu += v * u * u;
    }
    let det = suu * svv - suv * suv;
    if !(det.abs() > 1e-9 * (suu + svv) * (suu + svv)) {
        return None; // (fast) auf einer Geraden
    }
    let (b1, b2) = ((suuu + suvv) / 2.0, (svvv + svuu) / 2.0);
    let uc = (b1 * svv - b2 * suv) / det;
    let vc = (suu * b2 - suv * b1) / det;
    let (mut cx, mut cy) = (mx + uc, my + vc);
    let mut r = (uc * uc + vc * vc + (suu + svv) / n).sqrt();
    // Geometrische Nachbesserung (Kåsa verschiebt den Mittelpunkt bei kurzen Bögen leicht).
    for _ in 0..12 {
        let (mut sx, mut sy, mut sd) = (0.0, 0.0, 0.0);
        for p in &s {
            let d = ((p[0] - cx).powi(2) + (p[1] - cy).powi(2)).sqrt().max(1e-12);
            sd += d;
        }
        let rr = sd / n;
        for p in &s {
            let d = ((p[0] - cx).powi(2) + (p[1] - cy).powi(2)).sqrt().max(1e-12);
            sx += p[0] - rr * (p[0] - cx) / d;
            sy += p[1] - rr * (p[1] - cy) / d;
        }
        cx = sx / n;
        cy = sy / n;
        r = rr;
    }
    if !(r.is_finite() && r > 1e-3 && r < 1e7) {
        return None;
    }
    let tol = FIT_REL_TOL * r + FIT_ABS_TOL;
    for p in &s {
        if (((p[0] - cx).powi(2) + (p[1] - cy).powi(2)).sqrt() - r).abs() > tol {
            return None;
        }
    }
    // Feinschliff: Kubik-Näherungen eines Kreises treffen Anfangs-/Endpunkte und Tangenten exakt, den
    // Rest nur auf ≈ 0.03 % genau. Mittelpunkt = Schnitt der Normalen in den Endpunkten (je Kubik),
    // Radius = mittlerer Abstand der Endpunkte. Nur übernehmen, wenn es innerhalb der Toleranz bleibt.
    let mut cs: Vec<P> = Vec::new();
    for c in cubics {
        let (t0, t1) = ([c[1][0] - c[0][0], c[1][1] - c[0][1]], [c[3][0] - c[2][0], c[3][1] - c[2][1]]);
        // Normalen: Punkt + λ·n mit n ⟂ Tangente.
        let (n0, n1) = ([-t0[1], t0[0]], [-t1[1], t1[0]]);
        let den = n0[0] * n1[1] - n0[1] * n1[0];
        if den.abs() < 1e-6 * (n0[0].hypot(n0[1]) * n1[0].hypot(n1[1])) {
            continue;
        }
        let g = [c[3][0] - c[0][0], c[3][1] - c[0][1]];
        let lam = (g[0] * n1[1] - g[1] * n1[0]) / den;
        cs.push([c[0][0] + lam * n0[0], c[0][1] + lam * n0[1]]);
    }
    if !cs.is_empty() {
        let k = cs.len() as f64;
        let (rx, ry) = (cs.iter().map(|p| p[0]).sum::<f64>() / k, cs.iter().map(|p| p[1]).sum::<f64>() / k);
        let ends: Vec<P> = cubics.iter().map(|c| c[0]).chain(std::iter::once(cubics[cubics.len() - 1][3])).collect();
        let rr = ends.iter().map(|p| ((p[0] - rx).powi(2) + (p[1] - ry).powi(2)).sqrt()).sum::<f64>() / ends.len() as f64;
        if (rx - cx).hypot(ry - cy) <= tol && (rr - r).abs() <= tol {
            cx = rx;
            cy = ry;
            r = rr;
        }
    }
    // Umlaufsinn und Gesamtdrehung.
    let ang: Vec<f64> = s.iter().map(|p| (p[1] - cy).atan2(p[0] - cx)).collect();
    let mut sweep = 0.0;
    let mut sign = 0.0f64;
    for w in ang.windows(2) {
        let d = wrap_pi(w[1] - w[0]);
        if d.abs() > 2.0 {
            return None; // Sprung: kein gleichmässiger Bogen
        }
        if d.abs() > 1e-9 {
            if sign != 0.0 && d.signum() != sign {
                return None;
            }
            sign = d.signum();
        }
        sweep += d;
    }
    if sweep.abs() < MIN_SWEEP || sweep.abs() > TAU + 0.05 {
        return None;
    }
    let (first, last) = (s[0], s[s.len() - 1]);
    let ends_meet = ((first[0] - last[0]).powi(2) + (first[1] - last[1]).powi(2)).sqrt() <= tol;
    if sweep.abs() >= TAU - 0.05 && ends_meet {
        return Some(PdfCurve { circle: true, cx, cy, r, a0: 0.0, a1: TAU });
    }
    if closed {
        return None; // geschlossener Teilpfad, aber kein voller Kreis (Segment/Sektor)
    }
    let (start, end) = if sweep > 0.0 { (ang[0], ang[0] + sweep) } else { (ang[ang.len() - 1], ang[ang.len() - 1] - sweep) };
    // Winkel nahe 2π auf 0 einrasten (sonst 6.2831 statt 0).
    let norm = |a: f64| {
        let v = a.rem_euclid(TAU);
        if TAU - v < 2e-3 {
            0.0
        } else {
            v
        }
    };
    Some(PdfCurve { circle: false, cx, cy, r, a0: norm(start), a1: norm(end) })
}

// ── Clip ──────────────────────────────────────────────────────────────────────

/// Ein Clip-Bereich (in Seitenkoordinaten, pt).
#[derive(Debug)]
pub struct Clip {
    /// Hüllbox `[minx, miny, maxx, maxy]`.
    pub bbox: [f64; 4],
    /// Achsenparalleles Rechteck (dann ist die Hüllbox die Form).
    pub rect: bool,
    polys: Vec<Vec<P>>,
    even_odd: bool,
    /// Einzelnes konvexes Polygon (gegen den Uhrzeigersinn orientiert in `polys[0]`).
    convex: bool,
}

fn poly_bbox(pts: &[P]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in pts {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    b
}

fn signed_area(p: &[P]) -> f64 {
    let mut a = 0.0;
    for i in 0..p.len() {
        let (q, r) = (p[i], p[(i + 1) % p.len()]);
        a += q[0] * r[1] - r[0] * q[1];
    }
    a / 2.0
}

fn is_convex(p: &[P]) -> bool {
    let mut sign = 0.0f64;
    for i in 0..p.len() {
        let (a, b, c) = (p[i], p[(i + 1) % p.len()], p[(i + 2) % p.len()]);
        let cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if cr.abs() > 1e-9 {
            if sign != 0.0 && cr.signum() != sign {
                return false;
            }
            sign = cr.signum();
        }
    }
    true
}

impl Clip {
    /// Rechteck-Clip.
    pub fn from_rect(b: [f64; 4]) -> Clip {
        Clip {
            bbox: b,
            rect: true,
            polys: vec![vec![[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]],
            even_odd: false,
            convex: true,
        }
    }

    /// Clip aus Teilpfaden (Eckpunkte in Seitenkoordinaten). `None` bei leerem/entartetem Pfad.
    pub fn from_polys(polys: Vec<Vec<P>>, even_odd: bool) -> Option<Clip> {
        let mut polys: Vec<Vec<P>> = polys
            .into_iter()
            .map(|mut p| {
                p.retain(|q| q[0].is_finite() && q[1].is_finite());
                if p.len() > 1 && (p[0][0] - p[p.len() - 1][0]).abs() < EPS && (p[0][1] - p[p.len() - 1][1]).abs() < EPS {
                    p.pop();
                }
                p
            })
            .filter(|p| p.len() >= 3)
            .collect();
        if polys.is_empty() {
            return None;
        }
        let all: Vec<P> = polys.iter().flatten().copied().collect();
        let bbox = poly_bbox(&all);
        if all.len() > MAX_CLIP_VERTS {
            return Some(Clip::from_rect(bbox));
        }
        if polys.len() == 1 {
            let p = &polys[0];
            let axis = p.len() == 4 && {
                let t = EPS * (1.0 + bbox[2].abs().max(bbox[3].abs()));
                let h = (p[0][0] - p[1][0]).abs() < t && (p[1][1] - p[2][1]).abs() < t && (p[2][0] - p[3][0]).abs() < t && (p[3][1] - p[0][1]).abs() < t;
                let v = (p[0][1] - p[1][1]).abs() < t && (p[1][0] - p[2][0]).abs() < t && (p[2][1] - p[3][1]).abs() < t && (p[3][0] - p[0][0]).abs() < t;
                h || v
            };
            if axis {
                return Some(Clip::from_rect(bbox));
            }
            if signed_area(p).abs() < 1e-12 {
                return None;
            }
            let convex = is_convex(p);
            if signed_area(p) < 0.0 {
                polys[0].reverse();
            }
            return Some(Clip { bbox, rect: false, polys, even_odd, convex });
        }
        Some(Clip { bbox, rect: false, polys, even_odd, convex: false })
    }

    /// Liegt der Punkt im Clip (Rand zählt dazu)?
    pub fn inside(&self, p: P) -> bool {
        let b = self.bbox;
        if p[0] < b[0] - EPS || p[0] > b[2] + EPS || p[1] < b[1] - EPS || p[1] > b[3] + EPS {
            return false;
        }
        if self.rect {
            return true;
        }
        let mut wind = 0i32;
        let mut cross = 0i32;
        for poly in &self.polys {
            for i in 0..poly.len() {
                let (a, c) = (poly[i], poly[(i + 1) % poly.len()]);
                if on_segment(a, c, p) {
                    return true;
                }
                if (a[1] <= p[1]) != (c[1] <= p[1]) {
                    let x = a[0] + (p[1] - a[1]) / (c[1] - a[1]) * (c[0] - a[0]);
                    if x > p[0] {
                        cross += 1;
                        wind += if c[1] > a[1] { 1 } else { -1 };
                    }
                }
            }
        }
        if self.even_odd {
            cross % 2 == 1
        } else {
            wind != 0
        }
    }

    /// Liegt die ganze Form sicher im Clip (dann ist nichts zu tun)?
    pub fn contains_all(&self, pts: &[P]) -> bool {
        let bb = poly_bbox(pts);
        let b = self.bbox;
        if bb[0] >= b[0] - EPS && bb[1] >= b[1] - EPS && bb[2] <= b[2] + EPS && bb[3] <= b[3] + EPS {
            if self.rect {
                return true;
            }
            if self.convex {
                return pts.iter().all(|&p| self.inside(p));
            }
        }
        false
    }

    /// Liegt die Hüllbox der Form ausserhalb der Hüllbox des Clips?
    pub fn misses(&self, pts: &[P]) -> bool {
        let bb = poly_bbox(pts);
        let b = self.bbox;
        bb[0] > b[2] + EPS || bb[2] < b[0] - EPS || bb[1] > b[3] + EPS || bb[3] < b[1] - EPS
    }

    /// Anteile `[t0, t1]` der Strecke a→b im Clip.
    fn segment_spans(&self, a: P, b: P) -> Vec<(f64, f64)> {
        if self.rect {
            return liang_barsky(a, b, self.bbox).map(|s| vec![s]).unwrap_or_default();
        }
        let mut ts = vec![0.0, 1.0];
        let d = [b[0] - a[0], b[1] - a[1]];
        for poly in &self.polys {
            for i in 0..poly.len() {
                let (c, e) = (poly[i], poly[(i + 1) % poly.len()]);
                let f = [e[0] - c[0], e[1] - c[1]];
                let den = d[0] * f[1] - d[1] * f[0];
                if den.abs() < 1e-14 {
                    continue;
                }
                let g = [c[0] - a[0], c[1] - a[1]];
                let t = (g[0] * f[1] - g[1] * f[0]) / den;
                let u = (g[0] * d[1] - g[1] * d[0]) / den;
                if t > 0.0 && t < 1.0 && (-1e-9..=1.0 + 1e-9).contains(&u) {
                    ts.push(t);
                }
            }
        }
        ts.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
        let mut out: Vec<(f64, f64)> = Vec::new();
        for w in ts.windows(2) {
            if w[1] - w[0] < 1e-12 {
                continue;
            }
            let m = (w[0] + w[1]) / 2.0;
            if self.inside([a[0] + m * d[0], a[1] + m * d[1]]) {
                match out.last_mut() {
                    Some(l) if (l.1 - w[0]).abs() < 1e-12 => l.1 = w[1],
                    _ => out.push((w[0], w[1])),
                }
            }
        }
        out
    }

    /// Linienzug beschneiden → Teil-Linienzüge innerhalb. `closed` schliesst mit Kante letzter→erster.
    pub fn clip_polyline(&self, pts: &[P], closed: bool) -> Vec<Vec<P>> {
        let mut out: Vec<Vec<P>> = Vec::new();
        let n = pts.len();
        let segs = if closed { n } else { n.saturating_sub(1) };
        let mut cur: Vec<P> = Vec::new();
        for i in 0..segs {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            let lerp = |t: f64| [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
            let spans = self.segment_spans(a, b);
            if spans.is_empty() {
                if cur.len() >= 2 {
                    out.push(std::mem::take(&mut cur));
                }
                cur.clear();
                continue;
            }
            for (k, (t0, t1)) in spans.iter().enumerate() {
                let (p0, p1) = (lerp(*t0), lerp(*t1));
                let continues = k == 0 && cur.last().is_some_and(|l| (l[0] - p0[0]).abs() < 1e-7 && (l[1] - p0[1]).abs() < 1e-7);
                if !continues {
                    if cur.len() >= 2 {
                        out.push(std::mem::take(&mut cur));
                    }
                    cur.clear();
                    cur.push(p0);
                }
                cur.push(p1);
                // Endet das Stück vor dem Segmentende, ist der Zug hier zu Ende.
                if *t1 < 1.0 - 1e-12 && k + 1 == spans.len() {
                    out.push(std::mem::take(&mut cur));
                }
            }
        }
        if cur.len() >= 2 {
            out.push(cur);
        }
        out.retain(|p| p.len() >= 2);
        out
    }

    /// Fläche beschneiden. Rechteck/konvexer Clip: exakt (Sutherland-Hodgman); sonst an der Hüllbox.
    pub fn clip_polygon(&self, pts: &[P]) -> Option<Vec<P>> {
        let out = if self.rect || !self.convex {
            sutherland_hodgman_rect(pts, self.bbox)
        } else {
            sutherland_hodgman_convex(pts, &self.polys[0])
        };
        (out.len() >= 3).then_some(out)
    }
}

fn on_segment(a: P, c: P, p: P) -> bool {
    let cr = (c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]);
    let len = ((c[0] - a[0]).powi(2) + (c[1] - a[1]).powi(2)).sqrt();
    if cr.abs() > EPS * (1.0 + len) {
        return false;
    }
    p[0] >= a[0].min(c[0]) - EPS && p[0] <= a[0].max(c[0]) + EPS && p[1] >= a[1].min(c[1]) - EPS && p[1] <= a[1].max(c[1]) + EPS
}

fn liang_barsky(a: P, b: P, r: [f64; 4]) -> Option<(f64, f64)> {
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    let d = [b[0] - a[0], b[1] - a[1]];
    for (p, q) in [(-d[0], a[0] - r[0]), (d[0], r[2] - a[0]), (-d[1], a[1] - r[1]), (d[1], r[3] - a[1])] {
        if p.abs() < 1e-14 {
            if q < -EPS {
                return None;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
        }
    }
    (t0 < t1 - 1e-12 || (t0 <= t1 && d[0].abs() + d[1].abs() < 1e-14)).then_some((t0, t1))
}

fn sutherland_hodgman_rect(pts: &[P], r: [f64; 4]) -> Vec<P> {
    let mut poly = pts.to_vec();
    // (Achse, Grenze, behalte „≥" oder „≤")
    for (axis, lim, keep_ge) in [(0usize, r[0], true), (0, r[2], false), (1, r[1], true), (1, r[3], false)] {
        let inside = |p: P| if keep_ge { p[axis] >= lim - EPS } else { p[axis] <= lim + EPS };
        let mut out = Vec::with_capacity(poly.len() + 4);
        for i in 0..poly.len() {
            let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
            let (ia, ib) = (inside(a), inside(b));
            if ia != ib {
                let t = (lim - a[axis]) / (b[axis] - a[axis]);
                let mut q = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
                q[axis] = lim;
                out.push(q);
            }
            if ib {
                out.push(b);
            }
        }
        poly = out;
        if poly.is_empty() {
            break;
        }
    }
    poly
}

fn sutherland_hodgman_convex(pts: &[P], clip_ccw: &[P]) -> Vec<P> {
    let mut poly = pts.to_vec();
    for i in 0..clip_ccw.len() {
        let (c, e) = (clip_ccw[i], clip_ccw[(i + 1) % clip_ccw.len()]);
        let side = |p: P| (e[0] - c[0]) * (p[1] - c[1]) - (e[1] - c[1]) * (p[0] - c[0]);
        let mut out = Vec::with_capacity(poly.len() + 4);
        for j in 0..poly.len() {
            let (a, b) = (poly[j], poly[(j + 1) % poly.len()]);
            let (sa, sb) = (side(a), side(b));
            let (ia, ib) = (sa >= -EPS, sb >= -EPS);
            if ia != ib {
                let t = sa / (sa - sb);
                out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
            }
            if ib {
                out.push(b);
            }
        }
        poly = out;
        if poly.is_empty() {
            break;
        }
    }
    poly
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: f64 = 0.5522847498;

    /// Kreisbogen 0°→90° als eine Kubik (Mittelpunkt c, Radius r).
    fn quarter(c: P, r: f64, rot: usize) -> Cubic {
        let base: Cubic = [[r, 0.0], [r, K * r], [K * r, r], [0.0, r]];
        let rotp = |p: P| match rot % 4 {
            0 => p,
            1 => [-p[1], p[0]],
            2 => [-p[0], -p[1]],
            _ => [p[1], -p[0]],
        };
        let mut o = base;
        for (i, p) in base.iter().enumerate() {
            let q = rotp(*p);
            o[i] = [c[0] + q[0], c[1] + q[1]];
        }
        o
    }

    #[test]
    fn full_circle_from_four_cubics() {
        let cs: Vec<Cubic> = (0..4).map(|k| quarter([10.0, 20.0], 5.0, k)).collect();
        let c = fit_curve(&cs, true).expect("Kreis");
        assert!(c.circle);
        assert!((c.cx - 10.0).abs() < 1e-3 && (c.cy - 20.0).abs() < 1e-3 && (c.r - 5.0).abs() < 1e-3, "{c:?}");
    }

    #[test]
    fn arc_ccw_and_cw() {
        let two: Vec<Cubic> = (0..2).map(|k| quarter([0.0, 0.0], 100.0, k)).collect();
        let a = fit_curve(&two, false).expect("Bogen");
        assert!(!a.circle);
        assert!(a.a0.abs() < 1e-6 && (a.a1 - PI).abs() < 1e-3, "{a:?}");
        // gleicher Viertelbogen rückwärts durchlaufen
        let q = quarter([0.0, 0.0], 100.0, 0);
        let rev: Cubic = [q[3], q[2], q[1], q[0]];
        let b = fit_curve(&[rev], false).expect("Bogen cw");
        assert!(b.a0.abs() < 1e-6 && (b.a1 - PI / 2.0).abs() < 1e-3, "{b:?}");
        // geschlossener Teilpfad ohne vollen Kreis (Sektor) ist keiner
        assert!(fit_curve(&[q], true).is_none());
    }

    #[test]
    fn ellipse_s_curve_and_line_are_rejected() {
        let mut cs: Vec<Cubic> = (0..4).map(|k| quarter([0.0, 0.0], 100.0, k)).collect();
        for c in &mut cs {
            for p in c.iter_mut() {
                p[1] *= 0.5;
            }
        }
        assert!(fit_curve(&cs, true).is_none(), "Ellipse 2:1");
        let s: Cubic = [[0.0, 0.0], [10.0, 20.0], [20.0, -20.0], [30.0, 0.0]];
        assert!(fit_curve(&[s], false).is_none(), "S-Kurve");
        let l: Cubic = [[0.0, 0.0], [10.0, 0.0], [20.0, 0.0], [30.0, 0.0]];
        assert!(fit_curve(&[l], false).is_none(), "Gerade");
        let nan: Cubic = [[0.0, 0.0], [f64::NAN, 0.0], [1.0, 1.0], [2.0, 0.0]];
        assert!(fit_curve(&[nan], false).is_none());
    }

    #[test]
    fn rect_clip_lines_and_polygons() {
        let c = Clip::from_rect([0.0, 0.0, 10.0, 10.0]);
        let r = c.clip_polyline(&[[-5.0, 5.0], [15.0, 5.0]], false);
        assert_eq!(r, vec![vec![[0.0, 5.0], [10.0, 5.0]]]);
        // Zug verlässt das Rechteck und kommt zurück → zwei Teile
        let r = c.clip_polyline(&[[2.0, 2.0], [2.0, 20.0], [8.0, 20.0], [8.0, 2.0]], false);
        assert_eq!(r.len(), 2, "{r:?}");
        assert!(c.clip_polyline(&[[20.0, 20.0], [30.0, 30.0]], false).is_empty());
        let poly = c.clip_polygon(&[[5.0, 5.0], [15.0, 5.0], [15.0, 15.0], [5.0, 15.0]]).unwrap();
        assert!((signed_area(&poly).abs() - 25.0).abs() < 1e-9, "{poly:?}");
    }

    #[test]
    fn concave_polygon_clip_gives_two_pieces() {
        // L-förmig: Quadrat 0..10 ohne die Ecke (5..10, 5..10)
        let l = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 5.0], [5.0, 5.0], [5.0, 10.0], [0.0, 10.0]];
        let c = Clip::from_polys(vec![l], false).unwrap();
        assert!(!c.rect);
        // Waagrechte Linie y = 7 von x = -2 bis 12: nur das Stück x ∈ [0,5] liegt drin.
        let r = c.clip_polyline(&[[-2.0, 7.0], [12.0, 7.0]], false);
        assert_eq!(r.len(), 1, "{r:?}");
        assert!((r[0][0][0]).abs() < 1e-9 && (r[0][1][0] - 5.0).abs() < 1e-9);
        // Diagonale durch Kerbe: tritt aus und wieder ein → zwei Teile
        let r = c.clip_polyline(&[[0.0, 9.0], [9.0, 0.0]], false);
        assert_eq!(r.len(), 1, "liegt ganz im L: {r:?}");
        let r = c.clip_polyline(&[[1.0, 4.0], [4.0, 9.0], [9.0, 9.0], [9.0, 1.0]], false);
        assert!(r.len() >= 2, "{r:?}");
    }

    #[test]
    fn triangle_clip_is_convex_exact() {
        let c = Clip::from_polys(vec![vec![[0.0, 0.0], [10.0, 0.0], [0.0, 10.0]]], false).unwrap();
        assert!(c.inside([2.0, 2.0]) && !c.inside([8.0, 8.0]));
        let r = c.clip_polyline(&[[0.0, 5.0], [10.0, 5.0]], false);
        assert_eq!(r.len(), 1);
        assert!((r[0][1][0] - 5.0).abs() < 1e-9);
        let poly = c.clip_polygon(&[[-1.0, -1.0], [20.0, -1.0], [20.0, 20.0], [-1.0, 20.0]]).unwrap();
        assert!((signed_area(&poly).abs() - 50.0).abs() < 1e-6, "{poly:?}");
    }

    #[test]
    fn degenerate_clips_are_none() {
        assert!(Clip::from_polys(vec![], false).is_none());
        assert!(Clip::from_polys(vec![vec![[0.0, 0.0], [1.0, 1.0]]], false).is_none());
        assert!(Clip::from_polys(vec![vec![[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]], false).is_none());
    }
}
