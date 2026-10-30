//! Bogenwände ([T2]): Achse als Kreisbogen von `start` nach `end` mit `Wall.bulge` (Modell-Konvention
//! wie bei Polylinien: `bulge = tan(Öffnungswinkel/4)`, positiv = Scheitel LINKS der Sehne, also
//! Uhrzeigersinn; = −DXF-Bulge). Jede Schicht ist ein Kreisringsektor (konzentrische Versätze).
//!
//! Wandlokale Koordinaten wie bei der geraden Wand: `s` = Bogenlänge auf der Achse ab `start`,
//! `n` = Querversatz entlang der LINKEN Normalen der Laufrichtung. Auf dem Versatz `n` liegt der
//! Punkt auf dem Radius `r − σ·n` (σ = +1 Gegenuhrzeigersinn, −1 Uhrzeigersinn).
//!
//! Die Ableitungen nutzen zwei Wege:
//! - **Abwickeln/Biegen** (Grundriss): die gerade Pipeline rechnet auf der abgewickelten Wand
//!   (`start` = (0,0), `end` = (L,0)), die Ausgabe wird mit [`WallArc::point`] gebogen; Kanten mit
//!   konstantem `n` werden Bögen, Punkte auf Schnittlinien rastet [`Unroll::map`] exakt ein.
//! - **Sehnen-Zerlegung** (3D, Schnitt, Ansicht, Exporte): [`WallArc::stations`] liefert Teilstellen,
//!   zwischen denen gerade Teilwände mit radialen Gehrungs-Schnitten liegen; die Versätze eines
//!   Sehnenpolygons sind wieder Sehnenpolygone, die Teilkörper schliessen also lückenlos.

use crate::joins::Line;
use kernel2d::{add, dot, scale, sub, Vec2};
use std::f64::consts::PI;

/// Bulge unterhalb dieser Grösse gilt als gerade (wie `kernel2d::bulge_arc`).
pub const BULGE_EPS: f64 = 1e-9;
/// Sehnen-Toleranz (Pfeilhöhe) der Zerlegung, Meter.
pub const CHORD_TOL: f64 = 1e-3;
/// Grösster Winkelschritt der Zerlegung (7.5°), damit auch kleine Radien glatt bleiben.
pub const MAX_STEP: f64 = PI / 24.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WallArc {
    pub center: Vec2,
    /// Achsradius.
    pub r: f64,
    /// Winkel des Startpunkts (Bogenmass).
    pub a0: f64,
    /// Vorzeichenbehafteter Öffnungswinkel (+ = Gegenuhrzeigersinn).
    pub sweep: f64,
}

/// Ist das ein echter Bogen (endlich, nicht ~0)?
pub fn is_arc_bulge(b: Option<f64>) -> bool {
    b.is_some_and(|b| b.is_finite() && b.abs() > BULGE_EPS)
}

fn wrap_pi(a: f64) -> f64 {
    let mut x = a % (2.0 * PI);
    if x > PI {
        x -= 2.0 * PI;
    } else if x <= -PI {
        x += 2.0 * PI;
    }
    x
}

impl WallArc {
    /// Bogen aus Achse und Modell-Bulge; `None` = gerade (oder entartet).
    pub fn of(start: Vec2, end: Vec2, bulge: Option<f64>) -> Option<WallArc> {
        let b = bulge.filter(|b| b.is_finite() && b.abs() > BULGE_EPS)?;
        if ![start.x, start.y, end.x, end.y].iter().all(|v| v.is_finite()) {
            return None;
        }
        // Öffnungswinkel begrenzen: |bulge| ≤ 1e3 (fast Vollkreis), sonst entartet.
        let b = b.clamp(-1e3, 1e3);
        let a = kernel2d::bulge_arc(start, end, b)?;
        if !(a.r.is_finite() && a.r > 1e-9 && a.sweep.is_finite()) {
            return None;
        }
        Some(WallArc { center: a.center, r: a.r, a0: a.a0, sweep: a.sweep })
    }

    /// Aus dem Modell (Achse + `bulge`).
    pub fn of_wall(w: &crate::model::Wall) -> Option<WallArc> {
        WallArc::of(Vec2::new(w.start.x, w.start.y), Vec2::new(w.end.x, w.end.y), w.bulge)
    }

    pub fn sigma(&self) -> f64 {
        if self.sweep >= 0.0 {
            1.0
        } else {
            -1.0
        }
    }

    /// Bogenlänge der Achse.
    pub fn length(&self) -> f64 {
        self.r * self.sweep.abs()
    }

    /// Radius der Versatzlinie `n` (links der Laufrichtung positiv).
    pub fn radius_at(&self, n: f64) -> f64 {
        self.r - self.sigma() * n
    }

    pub fn angle_at(&self, s: f64) -> f64 {
        self.a0 + self.sigma() * s / self.r
    }

    /// Weltpunkt zu (s, n).
    pub fn point(&self, s: f64, n: f64) -> Vec2 {
        let a = self.angle_at(s);
        let rr = self.radius_at(n);
        Vec2::new(self.center.x + rr * a.cos(), self.center.y + rr * a.sin())
    }

    /// Einheits-Tangente (Laufrichtung) bei `s`.
    pub fn tangent(&self, s: f64) -> Vec2 {
        let a = self.angle_at(s);
        Vec2::new(-self.sigma() * a.sin(), self.sigma() * a.cos())
    }

    /// Linke Normale der Laufrichtung bei `s`.
    pub fn normal(&self, s: f64) -> Vec2 {
        let t = self.tangent(s);
        Vec2::new(-t.y, t.x)
    }

    /// Wandlokale Koordinaten (s, n) eines Weltpunkts; `s` läuft über das Bogenende hinaus
    /// (negativ vor dem Start), gewählt nächst der Bogenmitte.
    pub fn local(&self, p: Vec2) -> (f64, f64) {
        let d = sub(p, self.center);
        let dist = d.x.hypot(d.y);
        let ang = d.y.atan2(d.x);
        let mid = self.a0 + self.sweep / 2.0;
        let rel = self.sigma() * wrap_pi(ang - mid) + self.sweep.abs() / 2.0;
        (rel * self.r, self.sigma() * (self.r - dist))
    }

    /// Winkelschritt-Anzahl für die Zerlegung bei grösstem Radius `r_max` (Toleranz [`CHORD_TOL`]).
    pub fn segments(&self, r_max: f64) -> usize {
        let rm = r_max.max(self.r).max(1e-6);
        let c = (1.0 - CHORD_TOL / rm).clamp(-1.0, 1.0);
        let step = (2.0 * c.acos()).clamp(1e-3, MAX_STEP);
        ((self.sweep.abs() / step).ceil() as usize).clamp(1, 512)
    }

    /// Bogenlängen gleichmässiger Teilstellen auf [a, b] (mit beiden Enden).
    pub fn stations(&self, a: f64, b: f64, r_max: f64) -> Vec<f64> {
        let total = self.length().max(1e-12);
        let n = ((self.segments(r_max) as f64 * (b - a).abs() / total).ceil() as usize).max(1);
        (0..=n).map(|i| a + (b - a) * i as f64 / n as f64).collect()
    }

    /// Bogenlängen, an denen der Versatzkreis `n` die Gerade `l` trifft (beide Lösungen, `s`
    /// unbeschnitten, s. [`WallArc::local`]).
    pub fn line_hits(&self, n: f64, l: &Line) -> Vec<f64> {
        circle_line(self.center, self.radius_at(n), l).into_iter().map(|p| self.local(p).0).collect()
    }

    /// Welt-Treffer des Versatzkreises `n` mit der Geraden, nächst `near`.
    pub fn line_hit_near(&self, n: f64, l: &Line, near: Vec2) -> Option<Vec2> {
        nearest(circle_line(self.center, self.radius_at(n), l), near)
    }

    /// Grösster Radius über den Querbereich [lo, hi].
    pub fn r_max(&self, lo: f64, hi: f64) -> f64 {
        self.radius_at(lo).abs().max(self.radius_at(hi).abs())
    }
}

/// Schnittpunkte Kreis (c, r) × Gerade.
pub fn circle_line(c: Vec2, r: f64, l: &Line) -> Vec<Vec2> {
    let dl = l.dir.x.hypot(l.dir.y);
    if !(dl > 1e-15) || !(r > 0.0) {
        return vec![];
    }
    let u = Vec2::new(l.dir.x / dl, l.dir.y / dl);
    let f = sub(l.point, c);
    let b = dot(f, u);
    let cc = dot(f, f) - r * r;
    let disc = b * b - cc;
    if disc < -1e-12 {
        return vec![];
    }
    let sq = disc.max(0.0).sqrt();
    vec![add(l.point, scale(u, -b - sq)), add(l.point, scale(u, -b + sq))]
}

/// Schnittpunkte zweier Kreise.
pub fn circle_circle(c1: Vec2, r1: f64, c2: Vec2, r2: f64) -> Vec<Vec2> {
    let d = sub(c2, c1);
    let dd = d.x.hypot(d.y);
    if !(dd > 1e-12) || dd > r1 + r2 + 1e-9 || dd < (r1 - r2).abs() - 1e-9 {
        return vec![];
    }
    let a = (r1 * r1 - r2 * r2 + dd * dd) / (2.0 * dd);
    let h = (r1 * r1 - a * a).max(0.0).sqrt();
    let m = add(c1, scale(d, a / dd));
    let o = Vec2::new(-d.y / dd * h, d.x / dd * h);
    vec![add(m, o), sub(m, o)]
}

pub fn nearest(pts: Vec<Vec2>, near: Vec2) -> Option<Vec2> {
    pts.into_iter().filter(|p| p.x.is_finite() && p.y.is_finite()).min_by(|a, b| {
        let da = sub(*a, near);
        let db = sub(*b, near);
        (da.x * da.x + da.y * da.y).partial_cmp(&(db.x * db.x + db.y * db.y)).unwrap_or(std::cmp::Ordering::Equal)
    })
}

/// Versatzkurve einer Wand: Gerade oder Kreis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Curve {
    Line(Line),
    Circle(Vec2, f64),
}

/// Alle Schnittpunkte zweier Versatzkurven.
pub fn curve_hits(a: &Curve, b: &Curve) -> Vec<Vec2> {
    match (a, b) {
        (Curve::Line(l1), Curve::Line(l2)) => kernel2d::line_intersect(l1.point, l1.dir, l2.point, l2.dir).into_iter().collect(),
        (Curve::Line(l), Curve::Circle(c, r)) | (Curve::Circle(c, r), Curve::Line(l)) => circle_line(*c, *r, l),
        (Curve::Circle(c1, r1), Curve::Circle(c2, r2)) => circle_circle(*c1, *r1, *c2, *r2),
    }
}

/// Abwicklung einer Bogenwand: Schnittlinien (Welt) als Geraden im abgewickelten Rahmen, damit die
/// gerade Pipeline sie benutzen kann, und die Rück-Abbildung mit exaktem Einrasten auf ihnen.
#[derive(Clone, Debug)]
pub struct Unroll {
    pub arc: WallArc,
    /// (abgewickelte Gerade, Weltgerade).
    pairs: Vec<(Line, Line)>,
}

impl Unroll {
    pub fn new(arc: WallArc) -> Unroll {
        Unroll { arc, pairs: Vec::new() }
    }

    /// Weltgerade → abgewickelte Gerade durch ihre Treffer mit den Flächen `n_lo`/`n_hi`
    /// (jeweils nächst `s_near`). `None`, wenn sie eine Fläche nicht trifft.
    pub fn unroll_line(&mut self, l: &Line, n_lo: f64, n_hi: f64, s_near: f64) -> Option<Line> {
        let near_lo = self.arc.point(s_near, n_lo);
        let near_hi = self.arc.point(s_near, n_hi);
        let p_lo = self.arc.line_hit_near(n_lo, l, near_lo)?;
        let p_hi = self.arc.line_hit_near(n_hi, l, near_hi)?;
        let (s_lo, _) = self.arc.local(p_lo);
        let (s_hi, _) = self.arc.local(p_hi);
        let (a, b) = (Vec2::new(s_lo, n_lo), Vec2::new(s_hi, n_hi));
        let d = sub(b, a);
        if d.x.hypot(d.y) < 1e-12 {
            return None;
        }
        let u = Line { point: a, dir: d };
        self.pairs.push((u, *l));
        Some(u)
    }

    /// Registriert ein Paar direkt (z. B. radiale Stossfuge).
    pub fn pair(&mut self, unrolled: Line, world: Line) {
        self.pairs.push((unrolled, world));
    }

    /// Abgewickelter Punkt → Welt; Punkte auf einer registrierten Schnittlinie landen exakt auf
    /// deren Weltgerade (Schnitt mit dem Versatzkreis).
    pub fn map(&self, p: Vec2) -> Vec2 {
        let base = self.arc.point(p.x, p.y);
        for (u, w) in &self.pairs {
            let dl = u.dir.x.hypot(u.dir.y);
            let dist = kernel2d::cross(u.dir, sub(p, u.point)).abs() / dl;
            if dist < 1e-7 {
                if let Some(q) = self.arc.line_hit_near(p.y, w, base) {
                    let e = sub(q, base);
                    // Nur nahe Treffer (Schutz gegen die zweite Kreislösung).
                    if e.x.hypot(e.y) < 0.5 {
                        return q;
                    }
                }
            }
        }
        base
    }

    /// Ist die Kante a→b eine Bogenkante (konstantes n, verschiedenes s, nicht auf einer Schnittlinie)?
    pub fn is_arc_edge(&self, a: Vec2, b: Vec2) -> bool {
        (a.y - b.y).abs() < 1e-9 && (a.x - b.x).abs() > 1e-9
    }

    /// Kante a→b gebogen als Punktfolge (ohne `a`, mit `b`).
    pub fn edge(&self, a: Vec2, b: Vec2) -> Vec<Vec2> {
        if !self.is_arc_edge(a, b) {
            return vec![self.map(b)];
        }
        let rm = self.arc.radius_at(a.y).abs();
        let total = self.arc.length().max(1e-12);
        let k = ((self.arc.segments(rm) as f64 * (b.x - a.x).abs() / total).ceil() as usize).clamp(1, 512);
        (1..=k).map(|i| if i == k { self.map(b) } else { self.arc.point(a.x + (b.x - a.x) * i as f64 / k as f64, a.y) }).collect()
    }

    /// Polygon biegen; `no_stroke` (Kantenindizes) wird auf die neuen Kanten umgerechnet.
    pub fn polygon(&self, pts: &[Vec2], no_stroke: &[f64]) -> (Vec<Vec2>, Vec<f64>) {
        let n = pts.len();
        let mut out = Vec::with_capacity(n * 4);
        let mut ns = Vec::new();
        if n == 0 {
            return (out, ns);
        }
        out.push(self.map(pts[0]));
        for i in 0..n {
            let a = pts[i];
            let b = pts[(i + 1) % n];
            let seg = self.edge(a, b);
            let first_edge = out.len() - 1;
            let last = i + 1 == n;
            let k = seg.len();
            if last {
                // Schlusskante: der letzte Punkt ist der Startpunkt selbst.
                out.extend_from_slice(&seg[..k - 1]);
            } else {
                out.extend(seg);
            }
            if no_stroke.iter().any(|&e| e as usize == i) {
                for j in 0..k {
                    ns.push((first_edge + j) as f64);
                }
            }
        }
        (out, ns)
    }
}

/// Bulge eines Bogens aus Start-/Endwinkel um `c` (Modell-Konvention): für Bogen-Primitive.
pub fn arc_angles(c: Vec2, a: Vec2, b: Vec2) -> (f64, f64) {
    ((a.y - c.y).atan2(a.x - c.x), (b.y - c.y).atan2(b.x - c.x))
}

/// Band (Umriss, Dicke `t` mittig) und Achse einer Bogenwand als Punktzüge — für Vorschauen
/// (Wand-Befehl, Transformieren, Griffe). `None` = gerade.
pub fn band_preview(start: (f64, f64), end: (f64, f64), bulge: Option<f64>, t: f64) -> Option<(Vec<(f64, f64)>, Vec<(f64, f64)>)> {
    let arc = WallArc::of(Vec2::new(start.0, start.1), Vec2::new(end.0, end.1), bulge)?;
    let st = arc.stations(0.0, arc.length(), arc.r + t / 2.0);
    let at = |s: f64, n: f64| {
        let q = arc.point(s, n);
        (q.x, q.y)
    };
    let mut band: Vec<(f64, f64)> = st.iter().map(|&s| at(s, t / 2.0)).collect();
    band.extend(st.iter().rev().map(|&s| at(s, -t / 2.0)));
    let axis = st.iter().map(|&s| at(s, 0.0)).collect();
    Some((band, axis))
}

/// Achse als Punktzug (Sehnen; gerade Wand: Anfang und Ende) mit Querversatz `n`.
pub fn axis_polyline(start: (f64, f64), end: (f64, f64), bulge: Option<f64>, n: f64, t: f64) -> Vec<(f64, f64)> {
    match WallArc::of(Vec2::new(start.0, start.1), Vec2::new(end.0, end.1), bulge) {
        Some(a) => a
            .stations(0.0, a.length(), a.r + t / 2.0)
            .into_iter()
            .map(|s| {
                let q = a.point(s, n);
                (q.x, q.y)
            })
            .collect(),
        None => {
            let (dx, dy) = (end.0 - start.0, end.1 - start.1);
            let l = dx.hypot(dy);
            let (nx, ny) = if l > 0.0 { (-dy / l * n, dx / l * n) } else { (0.0, 0.0) };
            vec![(start.0 + nx, start.1 + ny), (end.0 + nx, end.1 + ny)]
        }
    }
}

/// Grundriss einer Bogenwand (Kreisringsektor, Dicke mittig auf der Achse) als Polygon; `None` = gerade.
pub fn arc_footprint(w: &crate::model::Wall, thickness: f64) -> Option<Vec<[f64; 2]>> {
    WallArc::of_wall(w)?;
    let (s, e) = ((w.start.x, w.start.y), (w.end.x, w.end.y));
    let h = thickness / 2.0;
    let mut out: Vec<[f64; 2]> = axis_polyline(s, e, w.bulge, h, thickness).into_iter().map(|q| [q.0, q.1]).collect();
    out.extend(axis_polyline(s, e, w.bulge, -h, thickness).into_iter().rev().map(|q| [q.0, q.1]));
    Some(out)
}

/// Achslänge einer Wand (Bogenlänge bei Bogenwänden).
pub fn axis_length(w: &crate::model::Wall) -> f64 {
    match WallArc::of_wall(w) {
        Some(a) => a.length(),
        None => (w.end.x - w.start.x).hypot(w.end.y - w.start.y),
    }
}

/// Abgewickelte gerade Ersatzwand (`start` = (0,0), `end` = (L,0), ohne Bulge) einer Bogenwand.
pub fn unrolled_wall(w: &crate::model::Wall) -> Option<(WallArc, crate::model::Wall)> {
    let a = WallArc::of_wall(w)?;
    let mut v = w.clone();
    v.start = crate::model::Vec2 { x: 0.0, y: 0.0 };
    v.end = crate::model::Vec2 { x: a.length(), y: 0.0 };
    v.bulge = None;
    Some((a, v))
}

/// Querbereich (lo, hi) der Wand aus den Bändern.
fn band_extent(w: &crate::wall_bands::WallIn) -> (f64, f64) {
    let total = if w.stacked { w.bands.iter().fold(0.0, |s, b| s + b.thickness) } else { w.bands.iter().fold(0.0f64, |m, b| m.max(b.thickness)) };
    let off = crate::joins::reference_offset(w.reference, total);
    (off - total / 2.0, off + total / 2.0)
}

/// Zuschlag beidseits der Öffnung (über den grössten Rücksprung hinaus) für die Sehne einer Öffnung
/// mit Schichteinzug ([106]).
pub const REVEAL_MARGIN: f64 = 0.05;

/// [106] Öffnung mit Schichteinzug in der Bogenwand: Bereich `[lo, hi]` (Bogenlänge) EINER geraden
/// Sehnen-Teilwand über die Öffnung samt Rücksprung; Loch, Zusatzstücke und Einbauteile liegen gerade
/// auf dieser Sehne (Entscheid: die Leibungen stehen dort senkrecht zur Sehne statt radial).
pub fn reveal_zone(from: f64, to: f64, max_shift: f64, len: f64) -> (f64, f64) {
    let m = max_shift.max(0.0) + REVEAL_MARGIN;
    ((from - m).max(0.0), (to + m).min(len))
}

/// Gerade Sehne der Achse über `[sa, sb]`: Anfang, Einheitsrichtung, Länge. Bogenlänge `s` liegt auf
/// der Sehne bei `(s − sa)·Länge/(sb − sa)`.
pub fn chord_of(arc: &WallArc, sa: f64, sb: f64) -> (Vec2, Vec2, f64) {
    let (pa, pb) = (arc.point(sa, 0.0), arc.point(sb, 0.0));
    let l = (pb.x - pa.x).hypot(pb.y - pa.y);
    let u = if l > 1e-12 { Vec2::new((pb.x - pa.x) / l, (pb.y - pa.y) / l) } else { arc.tangent(sa) };
    (pa, u, l)
}

/// Sehnen-Zerlegung einer Bogenwand für die Schichtbänder: `w` trägt Öffnungen und Aussparungen in
/// Bogenlänge, Schnitte in Weltkoordinaten (Start/Ende/Achse werden ignoriert). Ergebnis: gerade
/// Teilwände (Sehnen der Achse) mit radialen Gehrungen dazwischen; Teilstellen auch an den
/// Öffnungskanten (Laibungen radial), keine Teilstelle im Bereich der Anschluss-Schnitte. Teilwände
/// innerhalb einer Öffnung werden zu Brüstung und Sturz (z-Bereich ohne Loch). Öffnungen mit
/// Schichteinzug ([106]) bekommen EINE gerade Teilwand über [`reveal_zone`], die Loch und Einzug trägt.
pub fn chord_walls(w: &crate::wall_bands::WallIn, arc: &WallArc) -> Vec<crate::wall_bands::WallIn> {
    use crate::joins::{LayerCuts, SpanCutout, WallCuts};
    let len = arc.length();
    if !(len > 1e-9) {
        return vec![];
    }
    let (lo, hi) = band_extent(w);
    let r_max = arc.r_max(lo, hi);
    let mut st = arc.stations(0.0, len, r_max);
    // Anschluss-Zonen: keine Teilstelle, wo die Schnittlinien die Wand queren.
    let reach = |lines: Vec<Line>, at_end: bool| -> f64 {
        let mut ext = if at_end { len } else { 0.0 };
        for l in lines {
            for n in [lo, hi] {
                let target = if at_end { len } else { 0.0 };
                let best = arc.line_hits(n, &l).into_iter().filter(|s| s.is_finite()).min_by(|a, b| (a - target).abs().partial_cmp(&(b - target).abs()).unwrap_or(std::cmp::Ordering::Equal));
                if let Some(s) = best {
                    if (s - target).abs() < len / 2.0 {
                        ext = if at_end { ext.min(s) } else { ext.max(s) };
                    }
                }
            }
        }
        ext
    };
    let lc = w.cuts.layer_cuts.as_ref();
    let starts: Vec<Line> = w.cuts.start_cut.into_iter().chain(lc.into_iter().flat_map(|l| l.start.iter().chain(l.start_side.iter()).flatten().copied())).collect();
    let ends: Vec<Line> = w.cuts.end_cut.into_iter().chain(lc.into_iter().flat_map(|l| l.end.iter().chain(l.end_side.iter()).flatten().copied())).collect();
    let z0 = reach(starts, false) + 1e-3;
    let z1 = reach(ends, true) - 1e-3;
    st.retain(|&s| s <= 0.0 || s >= len || (s > z0 && s < z1));
    // [106] Sehnen über Öffnungen mit Schichteinzug: (Bereich, Öffnung, Einzug).
    let zones: Vec<((f64, f64), &crate::wall_bands::OpeningIn, &crate::wall_bands::RevealIn)> = w
        .openings
        .iter()
        .filter_map(|o| {
            let r = w.reveals.iter().find(|r| r.from == o.from && r.to == o.to && r.z_bottom == o.z_bottom && r.z_top == o.z_top)?;
            let ms = r.shifts.iter().flat_map(|s| [s[0], s[1]]).fold(0.0f64, f64::max);
            Some((reveal_zone(o.from, o.to, ms, len), o, r))
        })
        .collect();
    st.retain(|&s| !zones.iter().any(|((a, b), _, _)| s > *a + 1e-6 && s < *b - 1e-6));
    for ((a, b), _, _) in &zones {
        st.extend([*a, *b].into_iter().filter(|s| *s > 1e-6 && *s < len - 1e-6));
    }
    for o in w.openings.iter().filter(|o| !zones.iter().any(|z| std::ptr::eq(z.1, *o))) {
        for s in [o.from, o.to] {
            if s > 1e-6 && s < len - 1e-6 {
                st.push(s);
            }
        }
    }
    st.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    st.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    let k = st.len() - 1;
    let mut out = Vec::new();
    for i in 0..k {
        let (sa, sb) = (st[i], st[i + 1]);
        let (pa, pb) = (arc.point(sa, 0.0), arc.point(sb, 0.0));
        let chord = (pb.x - pa.x).hypot(pb.y - pa.y);
        if chord < 1e-9 {
            continue;
        }
        let map = |s: f64| ((s - sa) / (sb - sa) * chord).clamp(0.0, chord);
        let radial = |s: f64| Line { point: arc.point(s, 0.0), dir: arc.normal(s) };
        let first = i == 0;
        let last = i + 1 == k;
        let layer_cuts = lc.map(|l| {
            let none = vec![None; l.start.len()];
            LayerCuts {
                start: if first { l.start.clone() } else { none.clone() },
                start_side: if first { l.start_side.clone() } else { none.clone() },
                end: if last { l.end.clone() } else { none.clone() },
                end_side: if last { l.end_side.clone() } else { none },
            }
        });
        let span_cutouts: Vec<SpanCutout> = w
            .cuts
            .span_cutouts
            .iter()
            .filter(|c| c.from.min(c.from_b) < sb && c.to.max(c.to_b) > sa)
            .map(|c| SpanCutout { from: map(c.from), to: map(c.to), from_b: map(c.from_b), to_b: map(c.to_b), ..*c })
            .filter(|c| c.to > c.from + 1e-9 || c.to_b > c.from_b + 1e-9)
            .collect();
        let cuts = WallCuts {
            start_cut: if first { w.cuts.start_cut } else { Some(radial(sa)) },
            end_cut: if last { w.cuts.end_cut } else { Some(radial(sb)) },
            layer_cuts,
            span_cutouts,
        };
        // [106] Teilwand über einer Öffnung mit Schichteinzug: Loch und Einzug auf der Sehne.
        if let Some((_, o, r)) = zones.iter().find(|((a, b), _, _)| (a - sa).abs() < 1e-6 && (b - sb).abs() < 1e-6) {
            let m = |s: f64| (s - sa) / (sb - sa) * chord;
            let oi = crate::wall_bands::OpeningIn { from: m(o.from), to: m(o.to), ..**o };
            let ri = crate::wall_bands::RevealIn { from: oi.from, to: oi.to, ..(*r).clone() };
            out.push(crate::wall_bands::WallIn { start: pa, end: pb, openings: vec![oi], cuts, reveals: vec![ri], ..w.clone() });
            continue;
        }
        // z-Bereiche ohne die Öffnungen, die diese Teilwand ganz überdecken.
        let mut zs = vec![[w.z_bottom, w.z_top]];
        for o in w.openings.iter().filter(|o| o.from <= sa + 1e-6 && o.to >= sb - 1e-6) {
            let mut next = Vec::new();
            for [a, b] in zs {
                if o.z_bottom > a + 1e-9 {
                    next.push([a, o.z_bottom.min(b)]);
                }
                if o.z_top < b - 1e-9 {
                    next.push([o.z_top.max(a), b]);
                }
            }
            zs = next.into_iter().filter(|z| z[1] > z[0] + 1e-9).collect();
        }
        for [zb, zt] in zs {
            out.push(crate::wall_bands::WallIn {
                start: pa,
                end: pb,
                z_bottom: zb,
                z_top: zt,
                openings: vec![],
                cuts: cuts.clone(),
                reveals: vec![],
                ..w.clone()
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, e: f64) -> bool {
        (a - b).abs() < e
    }

    #[test]
    fn halbkreis_konvention() {
        // bulge = 1: Halbkreis, Scheitel links der Sehne (0,0)→(10,0), also oben; Uhrzeigersinn.
        let a = WallArc::of(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0), Some(1.0)).unwrap();
        assert!(close(a.r, 5.0, 1e-12) && a.sigma() < 0.0);
        assert!(close(a.length(), 5.0 * PI, 1e-9));
        let mid = a.point(a.length() / 2.0, 0.0);
        assert!(close(mid.x, 5.0, 1e-9) && close(mid.y, 5.0, 1e-9));
        // Linke Normale zeigt im Uhrzeigersinn nach aussen: n = +0.2 → Radius 5.2.
        let p = a.point(a.length() / 2.0, 0.2);
        assert!(close(p.y, 5.2, 1e-9));
        let t = a.tangent(0.0);
        assert!(close(t.x, 0.0, 1e-12) && close(t.y, 1.0, 1e-12));
        let e = a.point(a.length(), 0.0);
        assert!(close(e.x, 10.0, 1e-9) && close(e.y, 0.0, 1e-9));
    }

    #[test]
    fn lokal_ist_umkehrung() {
        for b in [0.3, -0.3, 1.0, -2.0] {
            let a = WallArc::of(Vec2::new(1.0, 2.0), Vec2::new(7.0, -1.0), Some(b)).unwrap();
            for (s, n) in [(0.0, 0.0), (1.3, 0.1), (a.length(), -0.2), (a.length() * 0.5, 0.15)] {
                let (s2, n2) = a.local(a.point(s, n));
                assert!(close(s, s2, 1e-9) && close(n, n2, 1e-9), "{b} {s} {n} → {s2} {n2}");
            }
        }
    }

    #[test]
    fn gerade_und_entartet() {
        assert!(WallArc::of(Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0), Some(0.0)).is_none());
        assert!(WallArc::of(Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0), None).is_none());
        assert!(WallArc::of(Vec2::new(0.0, 0.0), Vec2::new(0.0, 0.0), Some(1.0)).is_none());
        assert!(WallArc::of(Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0), Some(f64::NAN)).is_none());
        assert!(WallArc::of(Vec2::new(f64::NAN, 0.0), Vec2::new(1.0, 0.0), Some(1.0)).is_none());
    }

    #[test]
    fn zerlegung_haelt_toleranz() {
        let a = WallArc::of(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0), Some(1.0)).unwrap();
        let n = a.segments(5.2);
        let step = a.sweep.abs() / n as f64;
        assert!(5.2 * (1.0 - (step / 2.0).cos()) <= CHORD_TOL + 1e-12);
        assert!(step <= MAX_STEP + 1e-12);
    }

    #[test]
    fn schnitte_kreis_gerade_und_kreis_kreis() {
        let l = Line { point: Vec2::new(-10.0, 3.0), dir: Vec2::new(1.0, 0.0) };
        let h = circle_line(Vec2::new(0.0, 0.0), 5.0, &l);
        assert_eq!(h.len(), 2);
        assert!(h.iter().all(|p| close(p.x.abs(), 4.0, 1e-12) && close(p.y, 3.0, 1e-12)));
        let h = circle_circle(Vec2::new(0.0, 0.0), 5.0, Vec2::new(8.0, 0.0), 5.0);
        assert!(h.iter().all(|p| close(p.x, 4.0, 1e-12) && close(p.y.abs(), 3.0, 1e-12)));
    }

    #[test]
    fn abwicklung_rastet_auf_schnittlinie() {
        let a = WallArc::of(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0), Some(1.0)).unwrap();
        let mut u = Unroll::new(a);
        // Schräge Weltgerade nahe dem Start.
        let w = Line { point: Vec2::new(0.0, 0.0), dir: Vec2::new(1.0, 1.0) };
        let ul = u.unroll_line(&w, -0.2, 0.2, 0.0).unwrap();
        // Ein Punkt der abgewickelten Geraden bei n = 0.05 liegt nach dem Biegen auf der Weltgeraden.
        let t = (0.05 - ul.point.y) / ul.dir.y;
        let p = Vec2::new(ul.point.x + ul.dir.x * t, 0.05);
        let q = u.map(p);
        assert!(kernel2d::cross(w.dir, sub(q, w.point)).abs() < 1e-9);
        assert!(close(sub(q, a.center).x.hypot(sub(q, a.center).y), a.radius_at(0.05), 1e-9));
    }

    #[test]
    fn polygon_biegen_kanten_und_ohne_strich() {
        let a = WallArc::of(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0), Some(1.0)).unwrap();
        let u = Unroll::new(a);
        let l = a.length();
        let pts = [Vec2::new(0.0, -0.1), Vec2::new(l, -0.1), Vec2::new(l, 0.1), Vec2::new(0.0, 0.1)];
        let (out, ns) = u.polygon(&pts, &[1.0]);
        assert!(out.len() > 20);
        // Kante 1 (radial am Ende) bleibt eine Kante.
        assert_eq!(ns.len(), 1);
        let e = ns[0] as usize;
        let (p, q) = (out[e], out[(e + 1) % out.len()]);
        assert!(close(p.x, 10.1, 1e-9) || close(q.x, 10.1, 1e-9));
        // Fläche ≈ Ringsektor π/2·(5.1² − 4.9²) = π·2·0.2·5/2
        let mut area = 0.0;
        for i in 0..out.len() {
            let (p, q) = (out[i], out[(i + 1) % out.len()]);
            area += p.x * q.y - q.x * p.y;
        }
        let exact = PI / 2.0 * (5.1f64.powi(2) - 4.9f64.powi(2));
        assert!(close(area.abs() / 2.0, exact, exact * 1e-3), "{} {}", area.abs() / 2.0, exact);
    }
}
