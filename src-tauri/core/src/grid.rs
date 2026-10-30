//! Achsraster ([112]): Geometrie der Rasterachsen, Achsblasen, Fangpunkte und Schnitt-/Ansichtslinien.
//!
//! Das Raster ist eine 2D-Zeichnung (`Drawing2DGeom::Grid`, Auswahl/Verschieben/Kopieren/Ebenen wie
//! jede Zeichnung). Rechtwinklig: `a` = Achsen parallel zur lokalen Y-Achse (X = `pos`), `b` = Achsen
//! parallel zur lokalen X-Achse (Y = `pos`). Radial: `a` = Strahlen (`pos` = Grad gegen `angle`),
//! `b` = Ringe (`pos` = Radius). Die Achsen tragen fortlaufende Indizes: erst `a`, dann `b`.

use crate::model::{Drawing2D, Drawing2DGeom, GridAxis, GridBubbles};

pub type P = (f64, f64);

/// Überstand der Achsen über die äusserste Querachse (Meter).
pub const DEFAULT_EXTEND: f64 = 1.5;
/// Blasen-Durchmesser (Papier-mm).
pub const DEFAULT_BUBBLE_MM: f64 = 8.0;

/// Verlauf einer Achse: Strecke oder Kreisbogen (gegen den Uhrzeigersinn von `a0` nach `a1`).
#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    Line { a: P, b: P },
    Arc { c: P, r: f64, a0: f64, a1: f64 },
}

/// Eine Rasterachse.
#[derive(Clone, Debug, PartialEq)]
pub struct Axis {
    pub index: u32,
    pub label: String,
    pub shape: Shape,
    /// Blasen an Anfang/Ende: Endpunkt der Achse und Richtung nach aussen.
    pub bubbles: [Option<(P, P)>; 2],
}

/// Parameter eines Rasters.
pub struct Spec<'a> {
    pub origin: P,
    pub angle: f64,
    pub radial: bool,
    pub a: &'a [GridAxis],
    pub b: &'a [GridAxis],
    pub extend: f64,
    pub bubbles: GridBubbles,
}

impl<'a> Spec<'a> {
    /// Raster einer Zeichnung (`None`, wenn sie keines ist).
    pub fn of(g: &'a Drawing2DGeom) -> Option<Spec<'a>> {
        let Drawing2DGeom::Grid { origin, angle, radial, a, b, extend, bubbles, .. } = g else { return None };
        Some(Spec {
            origin: (origin.x, origin.y),
            angle: *angle,
            radial: *radial == Some(true),
            a,
            b,
            extend: extend.filter(|e| e.is_finite() && *e >= 0.0).unwrap_or(DEFAULT_EXTEND),
            bubbles: bubbles.unwrap_or(GridBubbles::Both),
        })
    }

    fn world(&self, x: f64, y: f64) -> P {
        let (s, c) = self.angle.sin_cos();
        (self.origin.0 + x * c - y * s, self.origin.1 + x * s + y * c)
    }

    fn dir(&self, x: f64, y: f64) -> P {
        let (s, c) = self.angle.sin_cos();
        (x * c - y * s, x * s + y * c)
    }

    fn span(list: &[GridAxis]) -> (f64, f64) {
        let it = list.iter().map(|g| g.pos).filter(|p| p.is_finite());
        let lo = it.clone().fold(f64::INFINITY, f64::min);
        let hi = it.fold(f64::NEG_INFINITY, f64::max);
        if lo > hi {
            (0.0, 0.0)
        } else {
            (lo, hi)
        }
    }

    fn ray_angle(&self, pos: f64) -> f64 {
        self.angle + pos.to_radians()
    }

    /// Alle Achsen (Index: `a` zuerst, dann `b`).
    pub fn axes(&self) -> Vec<Axis> {
        // Blasenseite: die der Achse, sonst die des Rasters.
        let want = |g: &GridAxis, start: bool| match g.bubble.unwrap_or(self.bubbles) {
            GridBubbles::Both => true,
            GridBubbles::Start => start,
            GridBubbles::End => !start,
        };
        let mut out = Vec::with_capacity(self.a.len() + self.b.len());
        let ext = self.extend;
        if !self.radial {
            let (y0, y1) = Self::span(self.b);
            let (x0, x1) = Self::span(self.a);
            for (i, g) in self.a.iter().enumerate() {
                let (p0, p1) = (self.world(g.pos, y0 - ext), self.world(g.pos, y1 + ext));
                let (d0, d1) = (self.dir(0.0, -1.0), self.dir(0.0, 1.0));
                out.push(Axis {
                    index: i as u32,
                    label: g.label.clone(),
                    shape: Shape::Line { a: p0, b: p1 },
                    bubbles: [want(g, true).then_some((p0, d0)), want(g, false).then_some((p1, d1))],
                });
            }
            for (j, g) in self.b.iter().enumerate() {
                let (p0, p1) = (self.world(x0 - ext, g.pos), self.world(x1 + ext, g.pos));
                let (d0, d1) = (self.dir(-1.0, 0.0), self.dir(1.0, 0.0));
                out.push(Axis {
                    index: (self.a.len() + j) as u32,
                    label: g.label.clone(),
                    shape: Shape::Line { a: p0, b: p1 },
                    bubbles: [want(g, true).then_some((p0, d0)), want(g, false).then_some((p1, d1))],
                });
            }
            return out;
        }
        // Radial: Strahlen vom Mittelpunkt bis zum grössten Ring + Überstand, Ringe zwischen den Strahlen.
        let (_, rmax) = Self::span(self.b);
        for (i, g) in self.a.iter().enumerate() {
            let th = self.ray_angle(g.pos);
            let u = (th.cos(), th.sin());
            let end = (self.origin.0 + u.0 * (rmax + ext), self.origin.1 + u.1 * (rmax + ext));
            out.push(Axis {
                index: i as u32,
                label: g.label.clone(),
                shape: Shape::Line { a: self.origin, b: end },
                bubbles: [None, (g.bubble.unwrap_or(self.bubbles) != GridBubbles::Start).then_some((end, u))],
            });
        }
        let (t0, t1) = Self::span(self.a);
        let (t0, t1) = (self.ray_angle(t0), self.ray_angle(t1));
        for (j, g) in self.b.iter().enumerate() {
            let r = g.pos;
            let full = self.a.len() < 2 || t1 - t0 >= std::f64::consts::TAU - 1e-9 || r <= 1e-9;
            let (a0, a1) = if full {
                (self.angle, self.angle + std::f64::consts::TAU)
            } else {
                let da = (ext / r).min((std::f64::consts::TAU - (t1 - t0)) / 2.0);
                (t0 - da, t1 + da)
            };
            let at = |t: f64| (self.origin.0 + r * t.cos(), self.origin.1 + r * t.sin());
            let tan = |t: f64, s: f64| (-t.sin() * s, t.cos() * s);
            out.push(Axis {
                index: (self.a.len() + j) as u32,
                label: g.label.clone(),
                shape: Shape::Arc { c: self.origin, r, a0, a1 },
                bubbles: [
                    (!full && want(g, true)).then(|| (at(a0), tan(a0, -1.0))),
                    (if full { g.bubble.unwrap_or(self.bubbles) != GridBubbles::Start } else { want(g, false) }).then(|| (at(a1), tan(a1, 1.0))),
                ],
            });
        }
        out
    }

    /// Schnittpunkte der Achsen: rechtwinklig `a` × `b`, radial Strahl × Ring.
    pub fn crossings(&self) -> Vec<P> {
        let mut out = Vec::new();
        for i in 0..self.a.len() {
            for j in 0..self.b.len() {
                if let Some(p) = self.cross(i as u32, (self.a.len() + j) as u32) {
                    out.push(p);
                }
            }
        }
        out
    }

    /// Schnittpunkt zweier Achsen (Reihenfolge egal); gleiche Familie → `None`.
    pub fn cross(&self, i: u32, j: u32) -> Option<P> {
        let na = self.a.len() as u32;
        let (i, j) = if i < na && j >= na { (i, j) } else if j < na && i >= na { (j, i) } else { return None };
        let (ga, gb) = (self.a.get(i as usize)?, self.b.get((j - na) as usize)?);
        let p = if self.radial {
            let th = self.ray_angle(ga.pos);
            (self.origin.0 + gb.pos * th.cos(), self.origin.1 + gb.pos * th.sin())
        } else {
            self.world(ga.pos, gb.pos)
        };
        (p.0.is_finite() && p.1.is_finite()).then_some(p)
    }

    /// Punkt auf Achse `index` beim Anteil `t` (0 = Anfang, 1 = Ende).
    pub fn point_at(&self, index: u32, t: f64) -> Option<P> {
        let ax = self.axes().into_iter().find(|a| a.index == index)?;
        let p = match ax.shape {
            Shape::Line { a, b } => (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t),
            Shape::Arc { c, r, a0, a1 } => {
                let th = a0 + (a1 - a0) * t;
                (c.0 + r * th.cos(), c.1 + r * th.sin())
            }
        };
        (p.0.is_finite() && p.1.is_finite()).then_some(p)
    }

    /// Anteil `t` des Punkts `s` auf der Achse und sein Abstand zu ihr (nächster Punkt der Achse).
    pub fn project(&self, index: u32, s: P) -> Option<(f64, f64)> {
        let ax = self.axes().into_iter().find(|a| a.index == index)?;
        match ax.shape {
            Shape::Line { a, b } => {
                let (dx, dy) = (b.0 - a.0, b.1 - a.1);
                let l2 = dx * dx + dy * dy;
                (l2 > 1e-18).then(|| {
                    let t = ((s.0 - a.0) * dx + (s.1 - a.1) * dy) / l2;
                    let q = (a.0 + dx * t, a.1 + dy * t);
                    (t, (s.0 - q.0).hypot(s.1 - q.1))
                })
            }
            Shape::Arc { c, r, a0, a1 } => {
                let th = (s.1 - c.1).atan2(s.0 - c.0);
                let sweep = a1 - a0;
                let mut rel = (th - a0).rem_euclid(std::f64::consts::TAU);
                if rel > sweep.abs() + 1e-9 {
                    // ausserhalb des Bogens: zum näheren Ende
                    rel = if rel - sweep.abs() < std::f64::consts::TAU - rel { sweep.abs() } else { 0.0 };
                }
                (sweep.abs() > 1e-12).then(|| (rel / sweep.abs(), ((s.0 - c.0).hypot(s.1 - c.1) - r).abs()))
            }
        }
    }
}

/// Feldweiten aus Text: Zahlen, getrennt durch Leerzeichen/`;` (Komma als Dezimalzeichen), `N*W` oder
/// `NxW` = N Felder zu W. Nur endliche Werte > 0, höchstens 200 Felder.
pub fn parse_bays(text: &str) -> Option<Vec<f64>> {
    let mut out = Vec::new();
    for tok in text.split(|c: char| c.is_whitespace() || c == ';').filter(|t| !t.is_empty()) {
        let tok = tok.replace(',', ".");
        let (n, w) = match tok.split_once(['x', 'X', '*']) {
            Some((n, w)) => (n.parse::<usize>().ok()?, w.parse::<f64>().ok()?),
            None => (1, tok.parse::<f64>().ok()?),
        };
        if !(w.is_finite() && w > 0.0) || n == 0 || out.len() + n > 200 {
            return None;
        }
        out.extend(std::iter::repeat(w).take(n));
    }
    (!out.is_empty()).then_some(out)
}

/// Beschriftung `i` (0-basiert) als Buchstaben A … Z, AA, AB … (ohne I und O wie im Hochbau üblich).
pub fn letter_label(mut i: usize) -> String {
    const L: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
    let mut s = Vec::new();
    loop {
        s.push(L[i % L.len()]);
        if i < L.len() {
            break;
        }
        i = i / L.len() - 1;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

/// Achsen aus Feldweiten: rechtwinklig a = 1, 2, 3 … bei 0, Σ…; b = A, B, C … ebenso. Radial: a =
/// Strahlen (Winkel in Grad ab 0), b = Ringe (Radien = laufende Summe, der erste Ring beim ersten Mass).
pub fn axes_from_bays(radial: bool, xs: &[f64], ys: &[f64]) -> (Vec<GridAxis>, Vec<GridAxis>) {
    let cum = |w: &[f64], zero: bool| {
        let mut acc = 0.0;
        let mut out = Vec::new();
        if zero {
            out.push(0.0);
        }
        for v in w {
            acc += v;
            out.push(acc);
        }
        out
    };
    let a = cum(xs, true).iter().enumerate().map(|(i, p)| GridAxis { label: (i + 1).to_string(), pos: *p, ..Default::default() }).collect();
    let b = cum(ys, !radial).iter().enumerate().map(|(i, p)| GridAxis { label: letter_label(i), pos: *p, ..Default::default() }).collect();
    (a, b)
}

/// Achsen als Punktfolgen für die 3D-Spur (Bögen in 7.5°-Schritten).
pub fn polylines_3d(spec: &Spec) -> Vec<Vec<P>> {
    spec.axes()
        .into_iter()
        .map(|ax| match ax.shape {
            Shape::Line { a, b } => vec![a, b],
            Shape::Arc { c, r, a0, a1 } => {
                let n = (((a1 - a0).abs() / (std::f64::consts::PI / 24.0)).ceil() as usize).clamp(2, 400);
                (0..=n).map(|i| a0 + (a1 - a0) * i as f64 / n as f64).map(|t| (c.0 + r * t.cos(), c.1 + r * t.sin())).collect()
            }
        })
        .collect()
}

/// Wird das Raster `d` im Geschoss `level` gezeigt? (`levels` fehlt/leer = in allen Geschossen.)
pub fn visible_on(d: &Drawing2D, level: &str) -> bool {
    match &d.geom {
        Drawing2DGeom::Grid { levels: Some(l), .. } if !l.is_empty() => l.iter().any(|x| x == level),
        Drawing2DGeom::Grid { .. } => true,
        _ => d.level_id == level,
    }
}

/// Bildmass der Blase (Durchmesser, Modell-Meter) aus Papier-mm und Massstab.
pub fn bubble_diameter(mm: Option<f64>, scale: f64) -> f64 {
    mm.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(DEFAULT_BUBBLE_MM) * scale / 1000.0
}

/// Senkrechte Achsen eines Schnitts/einer Ansicht: Raster-Achsen (nur Strecken) als (Beschriftung,
/// Lage entlang der Schnittlinien-Achse u). `origin`/`dir` = Schnittlinie (Einheitsvektor `dir`).
/// Schnitt (`projected` false): die Achse muss die Schnittebene innerhalb ihrer Länge schneiden.
/// Ansicht (`projected` true): Achsen, die (bis 5°) senkrecht auf der Ansichtsebene stehen, erscheinen
/// unabhängig von ihrer Länge an der Stelle, an der ihre Verlängerung die Ebene trifft.
pub fn section_axes(spec: &Spec, origin: P, dir: P, projected: bool) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for ax in spec.axes() {
        let Shape::Line { a, b } = ax.shape else { continue };
        let (rx, ry) = (b.0 - a.0, b.1 - a.1);
        let den = dir.0 * ry - dir.1 * rx;
        let slope = if projected { 0.996 } else { 1e-9 };
        if den.abs() < slope * rx.hypot(ry).max(1e-12) {
            continue;
        }
        // Schnitt Gerade origin+u*dir mit der Achsstrecke a+t*r.
        let (qx, qy) = (a.0 - origin.0, a.1 - origin.1);
        let t = (qx * dir.1 - qy * dir.0) / den;
        if !projected && !(-1e-9..=1.0 + 1e-9).contains(&t) {
            continue;
        }
        let u = (qx * ry - qy * rx) / den;
        out.push((ax.label.clone(), u));
    }
    out
}

/// Verlauf einer Achse als Linienzug (Bögen in Schritten von höchstens 5°), z. B. für den IFC-Export.
pub fn polyline(ax: &Axis) -> Vec<P> {
    match ax.shape {
        Shape::Line { a, b } => vec![a, b],
        Shape::Arc { c, r, a0, a1 } => {
            let n = (((a1 - a0).abs() / 5f64.to_radians()).ceil() as usize).max(2);
            (0..=n).map(|i| {
                let t = a0 + (a1 - a0) * i as f64 / n as f64;
                (c.0 + r * t.cos(), c.1 + r * t.sin())
            }).collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Vec2;

    fn ax(l: &str, p: f64) -> GridAxis {
        GridAxis { label: l.into(), pos: p, ..Default::default() }
    }

    fn ortho() -> Drawing2DGeom {
        Drawing2DGeom::Grid {
            origin: Vec2 { x: 10.0, y: 20.0 },
            angle: 0.0,
            radial: None,
            a: vec![ax("1", 0.0), ax("2", 4.0), ax("3", 10.0)],
            b: vec![ax("A", 0.0), ax("B", 5.0)],
            extend: Some(2.0),
            bubbles: None,
            bubble_mm: None,
            levels: None,
            show_3d: None,
        }
    }

    #[test]
    fn unregelmaessiger_raster_achsen_und_ueberstand() {
        let g = ortho();
        let s = Spec::of(&g).unwrap();
        let axes = s.axes();
        assert_eq!(axes.len(), 5);
        // Achse "2": senkrecht bei x = 14, von y = 18 bis 27.
        assert_eq!(axes[1].shape, Shape::Line { a: (14.0, 18.0), b: (14.0, 27.0) });
        // Achse "B": waagrecht bei y = 25, von x = 8 bis 22.
        assert_eq!(axes[4].shape, Shape::Line { a: (8.0, 25.0), b: (22.0, 25.0) });
        // Blasen an beiden Enden, Richtung nach aussen.
        assert_eq!(axes[1].bubbles[0], Some(((14.0, 18.0), (0.0, -1.0))));
        assert_eq!(axes[1].bubbles[1], Some(((14.0, 27.0), (0.0, 1.0))));
        assert_eq!(s.crossings().len(), 6);
        assert_eq!(s.cross(4, 1), Some((14.0, 25.0)));
        assert_eq!(s.cross(0, 1), None);
    }

    #[test]
    fn gedrehtes_raster_und_blasenseite() {
        let mut g = ortho();
        if let Drawing2DGeom::Grid { angle, bubbles, .. } = &mut g {
            *angle = std::f64::consts::FRAC_PI_2;
            *bubbles = Some(GridBubbles::End);
        }
        let s = Spec::of(&g).unwrap();
        let p = s.cross(1, 4).unwrap(); // Achse 2 x B: lokal (4, 5) -> (10 - 5, 20 + 4)
        assert!((p.0 - 5.0).abs() < 1e-12 && (p.1 - 24.0).abs() < 1e-12);
        let a = &s.axes()[0];
        assert!(a.bubbles[0].is_none() && a.bubbles[1].is_some());
    }

    #[test]
    fn blasenseite_je_achse() {
        let mut g = ortho();
        if let Drawing2DGeom::Grid { a, .. } = &mut g {
            a[0].bubble = Some(GridBubbles::Start);
            a[1].bubble = Some(GridBubbles::End);
        }
        let axes = Spec::of(&g).unwrap().axes();
        assert!(axes[0].bubbles[0].is_some() && axes[0].bubbles[1].is_none());
        assert!(axes[1].bubbles[0].is_none() && axes[1].bubbles[1].is_some());
        // Achsen ohne eigene Seite folgen dem Raster (beide Enden).
        assert!(axes[2].bubbles[0].is_some() && axes[2].bubbles[1].is_some());
    }

    #[test]
    fn radial_strahlen_ringe() {
        let g = Drawing2DGeom::Grid {
            origin: Vec2 { x: 0.0, y: 0.0 },
            angle: 0.0,
            radial: Some(true),
            a: vec![ax("1", 0.0), ax("2", 90.0)],
            b: vec![ax("A", 3.0), ax("B", 6.0)],
            extend: Some(1.0),
            bubbles: None,
            bubble_mm: None,
            levels: None,
            show_3d: None,
        };
        let s = Spec::of(&g).unwrap();
        let axes = s.axes();
        assert_eq!(axes.len(), 4);
        match axes[0].shape {
            Shape::Line { b, .. } => assert!((b.0 - 7.0).abs() < 1e-12 && b.1.abs() < 1e-12),
            _ => panic!(),
        }
        let p = s.cross(1, 3).unwrap();
        assert!(p.0.abs() < 1e-12 && (p.1 - 6.0).abs() < 1e-12);
        match axes[2].shape {
            Shape::Arc { a0, a1, r, .. } => {
                assert_eq!(r, 3.0);
                assert!(a0 < 0.0 && a1 > std::f64::consts::FRAC_PI_2);
            }
            _ => panic!(),
        }
        // Projektion auf den Ring.
        let (t, d) = s.project(2, (0.0, 3.5)).unwrap();
        assert!((d - 0.5).abs() < 1e-9 && t > 0.0 && t < 1.0);
    }

    #[test]
    fn feldweiten_und_beschriftung() {
        assert_eq!(parse_bays("5 4,5 3x6"), Some(vec![5.0, 4.5, 6.0, 6.0, 6.0]));
        assert_eq!(parse_bays("2*3.2; 4"), Some(vec![3.2, 3.2, 4.0]));
        assert_eq!(parse_bays(""), None);
        assert_eq!(parse_bays("5 -1"), None);
        assert_eq!(parse_bays("abc"), None);
        assert_eq!(parse_bays("0x5"), None);
        assert_eq!((letter_label(0), letter_label(7), letter_label(8), letter_label(23), letter_label(24)), ("A".into(), "H".into(), "J".into(), "Z".into(), "AA".into()));
        let (a, b) = axes_from_bays(false, &[5.0, 3.0], &[4.0]);
        assert_eq!(a.iter().map(|x| (x.label.as_str(), x.pos)).collect::<Vec<_>>(), [("1", 0.0), ("2", 5.0), ("3", 8.0)]);
        assert_eq!(b.iter().map(|x| (x.label.as_str(), x.pos)).collect::<Vec<_>>(), [("A", 0.0), ("B", 4.0)]);
        // Radial: Ringe ohne Radius 0.
        let (_, rings) = axes_from_bays(true, &[45.0], &[2.0, 3.0]);
        assert_eq!(rings.iter().map(|x| x.pos).collect::<Vec<_>>(), [2.0, 5.0]);
    }

    #[test]
    fn sichtbarkeit_je_geschoss() {
        let mut d = Drawing2D { level_id: "eg".into(), geom: ortho(), ..Default::default() };
        assert!(visible_on(&d, "og") && visible_on(&d, "eg"));
        if let Drawing2DGeom::Grid { levels, .. } = &mut d.geom {
            *levels = Some(vec!["eg".into()]);
        }
        assert!(visible_on(&d, "eg") && !visible_on(&d, "og"));
    }

    #[test]
    fn schnittachsen_quer_zur_schnittlinie() {
        let g = ortho();
        let s = Spec::of(&g).unwrap();
        // Schnitt entlang +x bei y = 22: schneidet die senkrechten Achsen 1, 2, 3 bei u = 0, 4, 10 (ab x = 10).
        let r = section_axes(&s, (10.0, 22.0), (1.0, 0.0), false);
        let us: Vec<f64> = r.iter().map(|x| x.1).collect();
        assert_eq!(r.len(), 3);
        assert!((us[0]).abs() < 1e-9 && (us[1] - 4.0).abs() < 1e-9 && (us[2] - 10.0).abs() < 1e-9);
        // Ausserhalb der Achslänge: nichts.
        assert!(section_axes(&s, (10.0, 40.0), (1.0, 0.0), false).is_empty());
        // Ansicht von aussen (Ebene bei y = 40): die senkrechten Achsen erscheinen trotzdem, die waagrechten nicht.
        let v = section_axes(&s, (10.0, 40.0), (1.0, 0.0), true);
        assert_eq!(v.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["1", "2", "3"]);
    }
}
