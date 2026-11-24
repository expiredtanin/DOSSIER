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
    /// [327] Hüllrechteck je Fläche (gleiche Reihenfolge wie `areas`), für den schnellen Ausschluss.
    boxes: Vec<[f64; 4]>,
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

    /// [327] Wie [`Self::sig`], aber nur über die Strecken und Flächen, deren Hüllrechteck `keep` behält.
    pub fn sig_where(&self, keep: &dyn Fn([f64; 4]) -> bool) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for s in self.segs.iter().filter(|s| keep(ring_bbox(&s[..]))) {
            for q in s {
                (q[0].to_bits(), q[1].to_bits()).hash(&mut h);
            }
        }
        for (a, _) in self.areas.iter().zip(&self.boxes).filter(|(_, b)| keep(**b)) {
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
        self.boxes.extend_from_slice(&o.boxes);
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
            self.boxes.push(ring_bbox(&ring));
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

    /// [327] Suchraster über die Rechtecke der Flächen (für [`Self::cut_out_near`]).
    pub fn area_grid(&self) -> BoxGrid {
        BoxGrid::new(&self.areas.iter().map(|r| ring_bbox(r)).collect::<Vec<_>>())
    }

    /// [327] Wie [`Self::cut_out`], prüft aber nur die Flächen, die das Suchraster `grid` ([`Self::area_grid`]) nahe der
    /// Strecke meldet — dasselbe Ergebnis (jede Fläche, deren Rechteck die aufgeweitete Strecke berührt, ist dabei).
    pub fn cut_out_near(&self, a: P, b: P, pad: f64, grid: &BoxGrid, scratch: &mut Vec<u32>) -> Vec<[P; 2]> {
        grid.query([a[0].min(b[0]) - pad, a[1].min(b[1]) - pad, a[0].max(b[0]) + pad, a[1].max(b[1]) + pad], scratch);
        if scratch.is_empty() {
            return vec![[a, b]];
        }
        self.cut_out_of(a, b, pad, scratch.iter().map(|i| *i as usize))
    }

    /// [256] Die Strecke a–b ohne die Teile in den (konvexen) Flächen, je um `pad` aufgeweitet — Linien setzen vor
    /// Masszahlen und Texten aus (Baulinie durch „2.69“). Liegt nichts darin: die Strecke selbst. Stücke kürzer als 1e-9 entfallen.
    pub fn cut_out(&self, a: P, b: P, pad: f64) -> Vec<[P; 2]> {
        self.cut_out_of(a, b, pad, 0..self.areas.len())
    }

    /// [`Self::cut_out`] über die Flächen `which` (Indizes, aufsteigend).
    fn cut_out_of(&self, a: P, b: P, pad: f64, which: impl Iterator<Item = usize>) -> Vec<[P; 2]> {
        let d = [b[0] - a[0], b[1] - a[1]];
        let mut cuts: Vec<(f64, f64)> = Vec::new();
        let (sx0, sx1, sy0, sy1) = (a[0].min(b[0]) - pad, a[0].max(b[0]) + pad, a[1].min(b[1]) - pad, a[1].max(b[1]) + pad);
        for ring in which.filter_map(|i| self.areas.get(i)) {
            let n = ring.len();
            let bb = ring_bbox(ring);
            if n < 3 || bb[2] < sx0 || bb[0] > sx1 || bb[3] < sy0 || bb[1] > sy1 {
                continue;
            }
            let area2: f64 = (0..n).map(|i| ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1]).sum();
            if !(area2.abs() > 1e-12) {
                continue;
            }
            let sign = area2.signum();
            // Nur konvexe Flächen (Text, Blase): alle Ecken drehen gleich.
            let convex = (0..n).all(|i| {
                let (p, q, r) = (ring[i], ring[(i + 1) % n], ring[(i + 2) % n]);
                ((q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0])) * sign >= -1e-12
            });
            if !convex {
                continue;
            }
            // Cyrus–Beck: Parameter t in [0, 1], an dem die Strecke im aufgeweiteten Polygon liegt.
            let (mut t0, mut t1) = (0.0f64, 1.0f64);
            let mut inside = true;
            for i in 0..n {
                let (p, q) = (ring[i], ring[(i + 1) % n]);
                let l = hypot2(q[0] - p[0], q[1] - p[1]);
                if !(l > 1e-12) {
                    continue;
                }
                // Äussere Normale (Ring CCW: rechts der Kante).
                let nn = [(q[1] - p[1]) / l * sign, -(q[0] - p[0]) / l * sign];
                let num = pad - (nn[0] * (a[0] - p[0]) + nn[1] * (a[1] - p[1]));
                let den = nn[0] * d[0] + nn[1] * d[1];
                if den.abs() < 1e-12 {
                    if num < 0.0 {
                        inside = false;
                        break;
                    }
                } else if den > 0.0 {
                    t1 = t1.min(num / den);
                } else {
                    t0 = t0.max(num / den);
                }
            }
            if inside && t0 < t1 {
                cuts.push((t0, t1));
            }
        }
        if cuts.is_empty() {
            return vec![[a, b]];
        }
        cuts.sort_by(|x, y| x.0.total_cmp(&y.0));
        let len = hypot2(d[0], d[1]);
        let at = |t: f64| [a[0] + d[0] * t, a[1] + d[1] * t];
        let mut out = Vec::new();
        let mut from = 0.0;
        for (c0, c1) in cuts {
            if c0 > from && (c0 - from) * len > 1e-9 {
                out.push([at(from), at(c0)]);
            }
            from = from.max(c1);
        }
        if from < 1.0 && (1.0 - from) * len > 1e-9 {
            out.push([at(from), at(1.0)]);
        }
        out
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
        let areas: Vec<Vec<P>> = self.areas.iter().filter(|a| hit(a)).cloned().collect();
        let boxes = areas.iter().map(|a| ring_bbox(a)).collect();
        Obstacles { segs: self.segs.iter().filter(|s| hit(&s[..])).copied().collect(), areas, boxes }
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
        for (a, bb) in self.areas.iter().zip(&self.boxes) {
            // [327] Hüllrechteck der Fläche weiter weg als der bisherige Abstand: weder liegt die Mitte darin, noch
            // unterbietet eine ihrer Kanten das Minimum.
            if d > 0.0 && (r[0] - bb[2]).max(bb[0] - r[2]).max(r[1] - bb[3]).max(bb[1] - r[3]) >= d {
                continue;
            }
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
/// [327] Gleichmässiges Suchraster über achsparallele Rechtecke `[x0, y0, x1, y1]`: [`BoxGrid::query`] liefert die Indizes
/// aller Rechtecke, deren Zellen ein Suchrechteck berühren (Obermenge der wirklich berührenden; aufsteigend, ohne
/// Doppelte). Rechtecke mit nicht endlichen Werten gelten als überall nah.
pub struct BoxGrid {
    x0: f64,
    y0: f64,
    cell: f64,
    nx: usize,
    ny: usize,
    cells: Vec<Vec<u32>>,
    always: Vec<u32>,
}

impl BoxGrid {
    pub fn new(boxes: &[[f64; 4]]) -> BoxGrid {
        let ok = |b: &[f64; 4]| b.iter().all(|v| v.is_finite()) && b[2] >= b[0] && b[3] >= b[1];
        let mut bb = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for b in boxes.iter().filter(|b| ok(b)) {
            bb = [bb[0].min(b[0]), bb[1].min(b[1]), bb[2].max(b[2]), bb[3].max(b[3])];
        }
        let n = boxes.iter().filter(|b| ok(b)).count();
        let always: Vec<u32> = boxes.iter().enumerate().filter(|(_, b)| !ok(b)).map(|(i, _)| i as u32).collect();
        if n == 0 {
            return BoxGrid { x0: 0.0, y0: 0.0, cell: 1.0, nx: 0, ny: 0, cells: Vec::new(), always };
        }
        let (w, h) = ((bb[2] - bb[0]).max(1e-9), (bb[3] - bb[1]).max(1e-9));
        // Etwa zwei Rechtecke je Zelle, höchstens 256 Zellen je Achse.
        let cell = (w * h / (n as f64 / 2.0).max(1.0)).sqrt().max(w.max(h) / 256.0).max(1e-9);
        let (nx, ny) = (((w / cell).floor() as usize + 1).min(257), ((h / cell).floor() as usize + 1).min(257));
        let mut g = BoxGrid { x0: bb[0], y0: bb[1], cell, nx, ny, cells: vec![Vec::new(); nx * ny], always };
        for (i, b) in boxes.iter().enumerate().filter(|(_, b)| ok(b)) {
            let (i0, j0, i1, j1) = g.span(*b);
            for j in j0..=j1 {
                for k in i0..=i1 {
                    g.cells[j * nx + k].push(i as u32);
                }
            }
        }
        g
    }

    /// Zellbereich eines Rechtecks, auf das Raster geklemmt.
    fn span(&self, b: [f64; 4]) -> (usize, usize, usize, usize) {
        let ix = |x: f64| (((x - self.x0) / self.cell).floor().max(0.0) as usize).min(self.nx.saturating_sub(1));
        let iy = |y: f64| (((y - self.y0) / self.cell).floor().max(0.0) as usize).min(self.ny.saturating_sub(1));
        (ix(b[0]), iy(b[1]), ix(b[2]), iy(b[3]))
    }

    /// Kandidaten für das Suchrechteck `b` nach `out` (geleert, aufsteigend, ohne Doppelte).
    pub fn query(&self, b: [f64; 4], out: &mut Vec<u32>) {
        out.clear();
        out.extend_from_slice(&self.always);
        if self.nx == 0 || !b.iter().all(|v| v.is_finite()) {
            if self.nx != 0 {
                // Unsinniges Suchrechteck: alles prüfen lassen.
                out.extend(self.cells.iter().flatten().copied());
                out.sort_unstable();
                out.dedup();
            }
            return;
        }
        let (gx1, gy1) = (self.x0 + self.cell * self.nx as f64, self.y0 + self.cell * self.ny as f64);
        if b[2] < self.x0 || b[0] > gx1 || b[3] < self.y0 || b[1] > gy1 {
            return;
        }
        let (i0, j0, i1, j1) = self.span(b);
        for j in j0..=j1 {
            for k in i0..=i1 {
                out.extend_from_slice(&self.cells[j * self.nx + k]);
            }
        }
        if out.len() > 1 {
            out.sort_unstable();
            out.dedup();
        }
    }
}

pub fn ring_bbox(pts: &[P]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for q in pts {
        b = [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])];
    }
    b
}

/// Schneiden (oder berühren) sich die Strecken a–b und c–d?
pub fn segs_cross(a: P, b: P, c: P, d: P) -> bool {
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

pub fn point_in_ring(ring: &[P], p: P) -> bool {
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

    /// [327] Suchraster: jede Fläche, deren Rechteck das Suchrechteck berührt, wird gemeldet; `cut_out_near` = `cut_out`.
    #[test]
    fn box_grid_und_cut_out_near() {
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut o = Obstacles::default();
        for _ in 0..300 {
            let (x, y, w, h) = (40.0 * rnd(), 30.0 * rnd(), 0.1 + 2.0 * rnd(), 0.1 + rnd());
            o.area(vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
        }
        o.area(vec![[1.0, 1.0], [2.0, 1.0]]); // entartet
        let boxes: Vec<[f64; 4]> = o.areas.iter().map(|r| ring_bbox(r)).collect();
        let grid = o.area_grid();
        let mut near = Vec::new();
        for _ in 0..5000 {
            let a = [-5.0 + 50.0 * rnd(), -5.0 + 40.0 * rnd()];
            let b = [a[0] + 6.0 * (rnd() - 0.5), a[1] + 6.0 * (rnd() - 0.5)];
            let q = [a[0].min(b[0]), a[1].min(b[1]), a[0].max(b[0]), a[1].max(b[1])];
            grid.query(q, &mut near);
            for (i, bx) in boxes.iter().enumerate() {
                if bx[2] >= q[0] && bx[0] <= q[2] && bx[3] >= q[1] && bx[1] <= q[3] {
                    assert!(near.contains(&(i as u32)), "Fläche {i} fehlt für {q:?}");
                }
            }
            assert!(near.windows(2).all(|w| w[0] < w[1]), "aufsteigend, ohne Doppelte");
            assert_eq!(o.cut_out(a, b, 0.05), o.cut_out_near(a, b, 0.05, &grid, &mut near));
        }
        // Leeres Raster meldet nichts.
        let empty = Obstacles::default().area_grid();
        empty.query([0.0, 0.0, 1.0, 1.0], &mut near);
        assert!(near.is_empty());
    }

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
