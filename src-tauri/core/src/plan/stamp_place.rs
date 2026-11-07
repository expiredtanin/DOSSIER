//! [140] Hindernisse für Raumstempel: anderer Planinhalt im Raum (Treppen, Türschwenk-Bögen, Bemassung,
//! Koten, Texte, Symbole, Höhenlinien-Beschriftungen), dem ein Stempel ohne eigenen Anker ausweicht.
//! Hindernisse sind Strecken und Flächen (Türschwenk als Kreissektor, Text als gedrehtes Rechteck); die
//! Lage eines Stempel-Rechtecks wird nach seinem Abstand zum nächsten Hindernis bewertet (0 = überlappt).

use super::prim::Primitive;
use crate::jsmath::hypot2;
use crate::jsnum;
use crate::model::Vec2;

type P = [f64; 2];

/// Gewicht einer überdeckten Fläche (Text, Türschwenk) gegenüber einer gekreuzten Strecke ([`Obstacles::overlap`]):
/// ein überdeckter Text ist schlimmer als ein paar gekreuzte Treppenstufen.
pub const AREA_WEIGHT: f64 = 8.0;

/// Hindernisse eines Geschosses in Modell-Metern.
#[derive(Default, Debug, Clone)]
pub struct Obstacles {
    segs: Vec<[P; 2]>,
    /// Geschlossene Flächen (Ringe, ohne Wiederholung des ersten Punkts).
    areas: Vec<Vec<P>>,
}

/// Strecken eines Bogens (CCW von `a0` um `sweep`) als Punktfolge.
fn arc_pts(c: Vec2, r: f64, a0: f64, sweep: f64) -> Vec<P> {
    let n = ((sweep.abs() / (std::f64::consts::PI / 16.0)).ceil() as usize).clamp(2, 64);
    (0..=n)
        .map(|i| {
            let a = a0 + sweep * i as f64 / n as f64;
            [c.x + r * jsnum::cos(a), c.y + r * jsnum::sin(a)]
        })
        .collect()
}

fn finite(p: &P) -> bool {
    p[0].is_finite() && p[1].is_finite()
}

impl Obstacles {
    /// [156] Alle Punkte der Strecken und Flächen (für eine Hülle).
    pub fn points(&self) -> Vec<P> {
        self.segs.iter().flat_map(|s| s.iter().copied()).chain(self.areas.iter().flatten().copied()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.segs.is_empty() && self.areas.is_empty()
    }

    pub fn seg(&mut self, a: P, b: P) {
        if finite(&a) && finite(&b) {
            self.segs.push([a, b]);
        }
    }

    pub fn area(&mut self, ring: Vec<P>) {
        if ring.len() >= 3 && ring.iter().all(finite) {
            self.areas.push(ring);
        }
    }

    fn polyline(&mut self, pts: &[P]) {
        for w in pts.windows(2) {
            self.seg(w[0], w[1]);
        }
    }

    /// Text als Rechteck: Grundlinie links am Anker, Breite aus der Schriftmetrik (Inter), Höhe von
    /// 0.25 Schriftgrösse unter bis 0.95 über der Grundlinie, gedreht um `angle` (Bogenmass, CCW).
    pub fn text(&mut self, at: Vec2, text: &str, height: f64, angle: f64) {
        if !(height > 0.0) || text.trim().is_empty() {
            return;
        }
        let w = crate::text_layout::text_width_em(text, false) * height;
        let (c, s) = (jsnum::cos(angle), jsnum::sin(angle));
        let ring = [[0.0, -0.25 * height], [w, -0.25 * height], [w, 0.95 * height], [0.0, 0.95 * height]]
            .iter()
            .map(|q| [at.x + q[0] * c - q[1] * s, at.y + q[0] * s + q[1] * c])
            .collect();
        self.area(ring);
    }

    /// Ein Primitiv als Hindernis übernehmen: Linien/Bögen/Kreise als Strecken, Polygone als Kanten,
    /// Bögen mit Öffnung (Türschwenk) als Kreissektor, Texte als Rechteck. Raumstempel nicht.
    pub fn add_prim(&mut self, q: &Primitive) {
        match q {
            Primitive::Line { a, b, .. } => self.seg([a.x, a.y], [b.x, b.y]),
            Primitive::Polygon { pts, .. } => {
                let ring: Vec<P> = pts.iter().map(|v| [v.x, v.y]).collect();
                if ring.len() >= 2 {
                    self.polyline(&ring);
                    self.seg(ring[ring.len() - 1], ring[0]);
                }
            }
            Primitive::Arc { center, from, to, r, opening_id, .. } => {
                let a0 = jsnum::atan2(from.y - center.y, from.x - center.x);
                let mut sweep = jsnum::atan2(to.y - center.y, to.x - center.x) - a0;
                while sweep < 0.0 && sweep.is_finite() {
                    sweep += 2.0 * std::f64::consts::PI;
                }
                if !sweep.is_finite() || !(*r > 0.0) {
                    return;
                }
                let pts = arc_pts(*center, *r, a0, sweep);
                if opening_id.is_some() {
                    // Türschwenk: die überstrichene Fläche bleibt frei.
                    let mut ring = vec![[center.x, center.y]];
                    ring.extend(pts);
                    self.area(ring);
                } else {
                    self.polyline(&pts);
                }
            }
            Primitive::DrawingArc { center, r, a0, a1, .. } => {
                let mut sweep = a1 - a0;
                while sweep < 0.0 && sweep.is_finite() {
                    sweep += 2.0 * std::f64::consts::PI;
                }
                if sweep.is_finite() && *r > 0.0 {
                    self.polyline(&arc_pts(*center, *r, *a0, sweep));
                }
            }
            Primitive::DrawingCircle { center, r, .. } => {
                if *r > 0.0 {
                    let mut ring = arc_pts(*center, *r, 0.0, 2.0 * std::f64::consts::PI);
                    ring.pop();
                    self.area(ring);
                }
            }
            Primitive::DrawingText { at, text, height_m, angle, .. } => self.text(*at, text, *height_m, *angle),
            Primitive::Text { .. } | Primitive::DrawingTextPath { .. } | Primitive::DrawingImage { .. } => {}
        }
    }

    /// Nur die Hindernisse, die das Rechteck `[x0, y0, x1, y1]` berühren (je Raum vorab gefiltert).
    pub fn within(&self, b: [f64; 4]) -> Obstacles {
        let hit = |pts: &[P]| {
            let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            for q in pts {
                x0 = x0.min(q[0]);
                y0 = y0.min(q[1]);
                x1 = x1.max(q[0]);
                y1 = y1.max(q[1]);
            }
            x1 >= b[0] && x0 <= b[2] && y1 >= b[1] && y0 <= b[3]
        };
        Obstacles { segs: self.segs.iter().filter(|s| hit(&s[..])).copied().collect(), areas: self.areas.iter().filter(|a| hit(a)).cloned().collect() }
    }

    /// Wie stark überdeckt das Rechteck (Mitte `c`, halbe Breite/Höhe) Hindernisse? Jede geschnittene Strecke
    /// zählt 1, jede berührte Fläche (Text, Türschwenk) [`AREA_WEIGHT`] — für die Wahl, wenn keine Lage frei ist.
    pub fn overlap(&self, c: Vec2, hw: f64, hh: f64) -> f64 {
        let r = [c.x - hw, c.y - hh, c.x + hw, c.y + hh];
        let segs = self.segs.iter().filter(|s| seg_hits_rect(s[0], s[1], r)).count() as f64;
        let areas = self.areas.iter().filter(|a| point_in_ring(a, [c.x, c.y]) || (0..a.len()).any(|i| seg_hits_rect(a[i], a[(i + 1) % a.len()], r))).count() as f64;
        segs + AREA_WEIGHT * areas
    }

    /// Abstand des achsparallelen Rechtecks (Mitte `c`, halbe Breite/Höhe) zum nächsten Hindernis;
    /// 0, wenn es eines schneidet oder enthält bzw. in einer Fläche liegt. Ohne Hindernisse: unendlich.
    pub fn clearance(&self, c: Vec2, hw: f64, hh: f64) -> f64 {
        let r = [c.x - hw, c.y - hh, c.x + hw, c.y + hh];
        let mut d = f64::INFINITY;
        for s in &self.segs {
            d = d.min(seg_rect_dist(s[0], s[1], r));
            if d <= 0.0 {
                return 0.0;
            }
        }
        for a in &self.areas {
            if point_in_ring(a, [c.x, c.y]) {
                return 0.0;
            }
            for i in 0..a.len() {
                d = d.min(seg_rect_dist(a[i], a[(i + 1) % a.len()], r));
                if d <= 0.0 {
                    return 0.0;
                }
            }
        }
        d
    }
}

impl Obstacles {
    /// [150] Berührt der (einfache) Ring `ring` — z. B. ein gedrehtes Beschriftungs-Rechteck — ein Hindernis
    /// (Strecke schneidet oder liegt darin; Fläche überlappt)?
    pub fn hits_convex(&self, ring: &[P]) -> bool {
        let b = ring_bbox(ring);
        let near = |pts: &[P]| {
            let q = ring_bbox(pts);
            q[2] >= b[0] && q[0] <= b[2] && q[3] >= b[1] && q[1] <= b[3]
        };
        self.segs.iter().any(|s| near(&s[..]) && seg_hits_ring(s[0], s[1], ring)) || self.areas.iter().any(|a| near(a) && convex_overlap(a, ring))
    }
}

/// Achsparalleles Rechteck `[x0, y0, x1, y1]` um die Punkte.
pub fn ring_bbox(pts: &[P]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for q in pts {
        b = [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])];
    }
    b
}

/// Schneiden (oder berühren) sich die Strecken a–b und c–d?
fn segs_cross(a: P, b: P, c: P, d: P) -> bool {
    let o = |p: P, q: P, r: P| (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    let (d1, d2, d3, d4) = (o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d));
    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0)) {
        return true;
    }
    let on = |p: P, q: P, r: P| r[0] >= p[0].min(q[0]) && r[0] <= p[0].max(q[0]) && r[1] >= p[1].min(q[1]) && r[1] <= p[1].max(q[1]);
    (d1 == 0.0 && on(c, d, a)) || (d2 == 0.0 && on(c, d, b)) || (d3 == 0.0 && on(a, b, c)) || (d4 == 0.0 && on(a, b, d))
}

/// [150] Schneidet die Strecke a–b den einfachen Ring oder liegt sie darin?
pub fn seg_hits_ring(a: P, b: P, ring: &[P]) -> bool {
    let n = ring.len();
    n >= 3 && (point_in_ring(ring, a) || (0..n).any(|i| segs_cross(a, b, ring[i], ring[(i + 1) % n])))
}

/// [150] Überlappen (oder berühren) sich zwei einfache Ringe?
pub fn convex_overlap(a: &[P], b: &[P]) -> bool {
    if a.len() < 3 || b.len() < 3 {
        return false;
    }
    point_in_ring(b, a[0]) || point_in_ring(a, b[0]) || (0..a.len()).any(|i| (0..b.len()).any(|j| segs_cross(a[i], a[(i + 1) % a.len()], b[j], b[(j + 1) % b.len()])))
}

fn point_in_ring(ring: &[P], p: P) -> bool {
    let mut inside = false;
    let n = ring.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn pt_rect_dist(p: P, r: [f64; 4]) -> f64 {
    let dx = (r[0] - p[0]).max(0.0).max(p[0] - r[2]);
    let dy = (r[1] - p[1]).max(0.0).max(p[1] - r[3]);
    hypot2(dx, dy)
}

fn pt_seg_dist(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    hypot2(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/// Schneidet die Strecke das Rechteck (Liang–Barsky)?
fn seg_hits_rect(a: P, b: P, r: [f64; 4]) -> bool {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [(-dx, a[0] - r[0]), (dx, r[2] - a[0]), (-dy, a[1] - r[1]), (dy, r[3] - a[1])] {
        if p == 0.0 {
            if q < 0.0 {
                return false;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
            if t0 > t1 {
                return false;
            }
        }
    }
    true
}

/// Abstand Strecke–Rechteck (0 bei Schnitt).
fn seg_rect_dist(a: P, b: P, r: [f64; 4]) -> f64 {
    if seg_hits_rect(a, b, r) {
        return 0.0;
    }
    let corners = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
    let mut d = pt_rect_dist(a, r).min(pt_rect_dist(b, r));
    for c in corners {
        d = d.min(pt_seg_dist(c, a, b));
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    #[test]
    fn abstand_zu_strecken_und_flaechen() {
        let mut o = Obstacles::default();
        o.seg([0.0, 0.0], [10.0, 0.0]);
        assert_eq!(o.clearance(v(5.0, 2.0), 1.0, 1.0), 1.0);
        assert_eq!(o.clearance(v(5.0, 0.5), 1.0, 1.0), 0.0, "Strecke schneidet das Rechteck");
        let mut a = Obstacles::default();
        a.area(vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]]);
        assert_eq!(a.clearance(v(2.0, 2.0), 0.5, 0.5), 0.0, "Rechteck liegt in der Fläche");
        assert!((a.clearance(v(7.0, 2.0), 1.0, 1.0) - 2.0).abs() < 1e-12);
        assert_eq!(Obstacles::default().clearance(v(0.0, 0.0), 1.0, 1.0), f64::INFINITY);
        // Überdeckung: Strecken zählen 1, Flächen (auch ganz umschlossen) mehr.
        let mut m = Obstacles::default();
        m.seg([0.0, 0.0], [0.0, 10.0]);
        m.seg([1.0, 0.0], [1.0, 10.0]);
        m.area(vec![[5.0, 5.0], [5.2, 5.0], [5.2, 5.2]]);
        assert_eq!(m.overlap(v(0.5, 5.0), 1.0, 0.5), 2.0);
        assert_eq!(m.overlap(v(5.0, 5.0), 1.0, 1.0), AREA_WEIGHT);
        assert_eq!(m.overlap(v(3.0, 2.0), 0.5, 0.5), 0.0);
        // Unsinn wird verworfen.
        let mut n = Obstacles::default();
        n.seg([f64::NAN, 0.0], [1.0, 1.0]);
        n.area(vec![[0.0, 0.0], [1.0, f64::NAN], [1.0, 1.0]]);
        assert!(n.is_empty());
    }

    #[test]
    fn tuerschwenk_als_sektor_text_als_rechteck() {
        let mut o = Obstacles::default();
        let arc = Primitive::Arc {
            center: v(0.0, 0.0),
            from: v(1.0, 0.0),
            to: v(0.0, 1.0),
            r: 1.0,
            cls: "door".into(),
            weight_mm: 0.13,
            dash: None,
            color: None,
            opening_id: Some("o".into()),
            stair_id: None,
            greyed: None,
            opacity: None,
        };
        o.add_prim(&arc);
        assert_eq!(o.clearance(v(0.3, 0.3), 0.05, 0.05), 0.0, "im Schwenkbereich");
        assert!(o.clearance(v(-1.0, -1.0), 0.1, 0.1) > 0.5);
        let mut t = Obstacles::default();
        t.text(v(0.0, 0.0), "±0.00", 0.2, 0.0);
        assert_eq!(t.clearance(v(0.3, 0.05), 0.01, 0.01), 0.0);
        assert!(t.clearance(v(0.3, 1.0), 0.01, 0.01) > 0.5);
    }
}
