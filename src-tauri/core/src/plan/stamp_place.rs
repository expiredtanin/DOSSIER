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

    /// [159] Inhalts-Schlüssel (Strecken und Flächen) für Zwischenspeicher.
    pub fn sig(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.segs.len().hash(&mut h);
        for s in &self.segs {
            for q in s {
                (q[0].to_bits(), q[1].to_bits()).hash(&mut h);
            }
        }
        for a in &self.areas {
            a.len().hash(&mut h);
            for q in a {
                (q[0].to_bits(), q[1].to_bits()).hash(&mut h);
            }
        }
        h.finish()
    }

    /// [179] Hindernisse von `o` hinten anhängen (Reihenfolge wie einzelnes `add_prim`).
    pub fn extend(&mut self, o: &Obstacles) {
        self.segs.extend_from_slice(&o.segs);
        self.areas.extend(o.areas.iter().cloned());
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
                // [258] `rem_euclid` statt Schleife (Winkel ±1e300 → Endlosschleife).
                if sweep < 0.0 && sweep.is_finite() {
                    sweep = sweep.rem_euclid(2.0 * std::f64::consts::PI);
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
    /// [179] `clearance(c, hw, hh).min(cap)` für die Lagewahl, schneller: Hindernisse, deren Hüllrechteck weiter als der
    /// bisherige Mindestabstand (anfangs `cap`) vom Rechteck liegt, ändern das Minimum nicht und entfallen; sobald der
    /// Abstand `floor` unterschreitet, kann die Lage keine bessere mehr sein (Aufrufer vergleicht `> floor`), dann
    /// kommt ein Wert `<= floor` zurück. Über `floor` ist das Ergebnis genau `clearance(..).min(cap)`.
    pub fn clearance_capped(&self, c: Vec2, hw: f64, hh: f64, cap: f64, floor: f64) -> f64 {
        let r = [c.x - hw, c.y - hh, c.x + hw, c.y + hh];
        // Untergrenze des Abstands Strecke–Rechteck aus dem Hüllrechteck (Seitenabstände).
        let far = |a: P, b: P, d: f64| {
            let gx = (r[0] - a[0].max(b[0])).max(a[0].min(b[0]) - r[2]);
            let gy = (r[1] - a[1].max(b[1])).max(a[1].min(b[1]) - r[3]);
            gx.max(gy) >= d
        };
        let mut d = cap;
        for s in &self.segs {
            if far(s[0], s[1], d) {
                continue;
            }
            d = d.min(seg_rect_dist(s[0], s[1], r));
            if d <= floor {
                return d;
            }
        }
        for a in &self.areas {
            if point_in_ring(a, [c.x, c.y]) {
                return 0.0;
            }
            for i in 0..a.len() {
                let (p, q) = (a[i], a[(i + 1) % a.len()]);
                if far(p, q, d) {
                    continue;
                }
                d = d.min(seg_rect_dist(p, q, r));
                if d <= floor {
                    return d;
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

/// [159] Raster über die Hindernisse für viele Fragen [`Obstacles::hits_convex`] (Höhenlinien-Beschriftungen):
/// je Zelle die Strecken und Flächen, deren Rechteck sie berührt. Antwort wie ohne Raster.
pub struct ObstacleGrid<'a> {
    o: &'a Obstacles,
    cell: f64,
    map: std::collections::HashMap<(i64, i64), (Vec<u32>, Vec<u32>)>,
    /// Zu gross für das Raster: immer prüfen.
    big: (Vec<u32>, Vec<u32>),
}

impl<'a> ObstacleGrid<'a> {
    pub fn new(o: &'a Obstacles, cell: f64) -> Self {
        let cell = if cell.is_finite() && cell > 0.0 { cell } else { 1.0 };
        let mut g = ObstacleGrid { o, cell, map: Default::default(), big: Default::default() };
        for (i, s) in o.segs.iter().enumerate() {
            g.put(ring_bbox(&s[..]), i as u32, true);
        }
        for (i, a) in o.areas.iter().enumerate() {
            g.put(ring_bbox(a), i as u32, false);
        }
        g
    }

    fn key(&self, x: f64, y: f64) -> (i64, i64) {
        ((x / self.cell).floor() as i64, (y / self.cell).floor() as i64)
    }

    fn put(&mut self, b: [f64; 4], i: u32, seg: bool) {
        let (k0, k1) = (self.key(b[0], b[1]), self.key(b[2], b[3]));
        let n = (k1.0 - k0.0 + 1).saturating_mul(k1.1 - k0.1 + 1);
        if !b.iter().all(|v| v.is_finite()) || !(1..=4096).contains(&n) {
            if seg { self.big.0.push(i) } else { self.big.1.push(i) }
            return;
        }
        for x in k0.0..=k1.0 {
            for y in k0.1..=k1.1 {
                let e = self.map.entry((x, y)).or_default();
                if seg { e.0.push(i) } else { e.1.push(i) }
            }
        }
    }

    /// Wie [`Obstacles::hits_convex`].
    pub fn hits_convex(&self, ring: &[P]) -> bool {
        let b = ring_bbox(ring);
        let near = |pts: &[P]| {
            let q = ring_bbox(pts);
            q[2] >= b[0] && q[0] <= b[2] && q[3] >= b[1] && q[1] <= b[3]
        };
        let seg = |i: &u32| {
            let s = &self.o.segs[*i as usize];
            near(&s[..]) && seg_hits_ring(s[0], s[1], ring)
        };
        let area = |i: &u32| {
            let a = &self.o.areas[*i as usize];
            near(a) && convex_overlap(a, ring)
        };
        if self.big.0.iter().any(seg) || self.big.1.iter().any(area) {
            return true;
        }
        if !b.iter().all(|v| v.is_finite()) {
            return self.o.hits_convex(ring);
        }
        let (k0, k1) = (self.key(b[0], b[1]), self.key(b[2], b[3]));
        if (k1.0 - k0.0 + 1).saturating_mul(k1.1 - k0.1 + 1) > 4096 {
            return self.o.hits_convex(ring);
        }
        for x in k0.0..=k1.0 {
            for y in k0.1..=k1.1 {
                if let Some((ss, aa)) = self.map.get(&(x, y)) {
                    if ss.iter().any(seg) || aa.iter().any(area) {
                        return true;
                    }
                }
            }
        }
        false
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

    /// [179] `clearance_capped` liefert über `floor` genau `clearance(..).min(cap)`, sonst einen Wert `<= floor`.
    #[test]
    fn clearance_capped_wie_clearance() {
        let mut o = Obstacles::default();
        let mut s = 12345u64;
        let mut rnd = || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (s >> 11) as f64 / (1u64 << 53) as f64 * 20.0
        };
        for _ in 0..40 {
            o.seg([rnd(), rnd()], [rnd(), rnd()]);
        }
        for _ in 0..6 {
            let (x, y) = (rnd(), rnd());
            o.area(vec![[x, y], [x + 1.5, y], [x + 1.5, y + 0.6], [x, y + 0.6]]);
        }
        for _ in 0..400 {
            let (c, hw, hh) = (v(rnd(), rnd()), 0.2 + rnd() / 20.0, 0.1 + rnd() / 40.0);
            let cap = 0.05 + rnd() / 10.0;
            let full = o.clearance(c, hw, hh).min(cap);
            assert_eq!(o.clearance_capped(c, hw, hh, cap, 0.0).max(0.0), full);
            let floor = full * 0.5;
            let got = o.clearance_capped(c, hw, hh, cap, floor);
            assert!(if full > floor { got == full } else { got <= floor }, "{got} {full} {floor}");
        }
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

    /// [159] Raster über die Hindernisse antwortet wie die lineare Suche (zufällige Strecken, Flächen, Rechtecke).
    #[test]
    fn raster_wie_ohne() {
        let mut r = crate::plan::cache::tests::Rng(5);
        let mut o = Obstacles::default();
        for _ in 0..300 {
            let (x, y) = (r.next() * 50.0, r.next() * 30.0);
            o.seg([x, y], [x + r.next() * 4.0 - 2.0, y + r.next() * 4.0 - 2.0]);
        }
        o.seg([-10.0, -10.0], [80.0, 50.0]);
        for _ in 0..60 {
            o.text(v(r.next() * 50.0, r.next() * 30.0), "12.5", 0.2 + r.next() * 0.3, r.next() * 6.0);
        }
        for cell in [0.3, 0.8, 5.0] {
            let g = ObstacleGrid::new(&o, cell);
            let mut hits = 0;
            for _ in 0..4000 {
                let (m, a, hu, hv) = ([r.next() * 56.0 - 3.0, r.next() * 36.0 - 3.0], r.next() * 6.3, r.next() * 1.5, r.next() * 0.4);
                let (c, sn) = (a.cos(), a.sin());
                let ring: Vec<P> = [(-hu, -hv), (hu, -hv), (hu, hv), (-hu, hv)].iter().map(|(p, q)| [m[0] + c * p - sn * q, m[1] + sn * p + c * q]).collect();
                let want = o.hits_convex(&ring);
                assert_eq!(g.hits_convex(&ring), want, "{ring:?}");
                hits += want as usize;
            }
            assert!(hits > 100 && hits < 3900, "{hits}");
        }
    }
}
