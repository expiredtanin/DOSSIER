//! Gewichteter Straight Skeleton eines Polygons mit Löchern: jede Kante läuft mit eigener
//! Geschwindigkeit nach innen (Dach: Neigung je Kante; Geschwindigkeit 0 = senkrechte
//! Giebelkante). Ergebnis je Kante die Fläche, die sie überstreicht, mit der Zeit (= Höhe bei
//! gleicher Steiggeschwindigkeit) an jedem Eckpunkt.
//!
//! Wellenfront in der Zeit: jede Ecke läuft so, dass sie auf ihren beiden Kanten bleibt.
//! Kanten-Ereignis = eine Kante schrumpft zwischen ihren Ecken weg; Split-Ereignis = eine
//! einspringende Ecke läuft in eine fremde Kante und teilt die Wellenfront (bzw. vereinigt sie
//! mit einem Loch); mehrere Ereignisse am selben Ort/zur selben Zeit (Vertex-Ereignis) werden
//! in [`Wavefront::meet`] gemeinsam aufgelöst (ein- und auslaufende Kanten paarweise verbunden).
//!
//! Herkunft: übernommen aus BIMCraft, https://github.com/IPedrax/BIMCraft,
//! Commit f3bbb33f3b8b6cc6f80b3bd6611e33c330cb448f, Datei `crates/core/src/skeleton.rs`
//! (Lizenz MIT OR Apache-2.0, © IPedrax und BIMCraft-Mitwirkende; s. `NOTICE`).
//! Geändert für Dossier: Meter statt Millimeter (Toleranzen ×1e-3), Rust 2021, eigener
//! Vektortyp statt `geom::P2`, Arbeitsbudget als Parameter, Fehler als [`SkeletonError`],
//! Eingabeprüfung (NaN/∞), kein Indexzugriff über ungültige Verkettungen (nie Panic im WASM),
//! deutsche Kommentare.
//!
//! Lizenzhinweis des Originals (MIT, hier gewählt):
//! Copyright (c) 2026 IPedrax and the BIMCraft contributors. Permission is hereby granted, free
//! of charge, to any person obtaining a copy of this software and associated documentation files
//! (the "Software"), to deal in the Software without restriction, including without limitation
//! the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
//! the Software, and to permit persons to whom the Software is furnished to do so, subject to the
//! following conditions: The above copyright notice and this permission notice shall be included
//! in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
//! WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
//! OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//! AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
//! ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//! OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::ops::{Add, Mul, Sub};

/// Grundriss-Punkt (x, y) in Metern.
pub type P2 = [f64; 2];

/// Wie nah zwei Punkte entlang einer Kante beieinander liegen müssen, um gleich zu sein (Meter).
const EPS: f64 = 1e-9;
/// Ungültiger Index (Ecke noch nicht verkettet).
const NONE: usize = usize::MAX;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct V(f64, f64);

impl Add for V {
    type Output = V;
    fn add(self, o: V) -> V {
        V(self.0 + o.0, self.1 + o.1)
    }
}
impl Sub for V {
    type Output = V;
    fn sub(self, o: V) -> V {
        V(self.0 - o.0, self.1 - o.1)
    }
}
impl Mul<f64> for V {
    type Output = V;
    fn mul(self, k: f64) -> V {
        V(self.0 * k, self.1 * k)
    }
}

impl V {
    fn of(p: P2) -> V {
        V(p[0], p[1])
    }
    fn arr(self) -> P2 {
        [self.0, self.1]
    }
    fn dot(self, o: V) -> f64 {
        self.0 * o.0 + self.1 * o.1
    }
    fn cross(self, o: V) -> f64 {
        self.0 * o.1 - self.1 * o.0
    }
    fn length(self) -> f64 {
        self.0.hypot(self.1)
    }
    fn dist(self, o: V) -> f64 {
        (self - o).length()
    }
    fn unit(self) -> V {
        let l = self.length();
        if l > 0.0 {
            self * (1.0 / l)
        } else {
            V(0.0, 0.0)
        }
    }
    /// Um 90° gegen den Uhrzeigersinn gedreht.
    fn perp(self) -> V {
        V(-self.1, self.0)
    }
    fn is_finite(self) -> bool {
        self.0.is_finite() && self.1.is_finite()
    }
}

fn ring_area(ring: &[V]) -> f64 {
    let n = ring.len();
    (0..n).map(|i| ring[i].cross(ring[(i + 1) % n])).sum::<f64>() / 2.0
}

fn dist_to_segment(p: V, a: V, b: V) -> f64 {
    let d = b - a;
    let len2 = d.dot(d);
    let t = if len2 > 0.0 { ((p - a).dot(d) / len2).clamp(0.0, 1.0) } else { 0.0 };
    p.dist(a + d * t)
}

/// Warum kein Skelett entstand. Aufrufer fallen dann auf ein einfacheres Verfahren zurück.
#[derive(Clone, Debug, PartialEq)]
pub enum SkeletonError {
    /// Eingabe unbrauchbar (zu wenige Punkte, falscher Umlaufsinn, doppelte Punkte, NaN …).
    Input(&'static str),
    /// Keine Kante läuft (alle Geschwindigkeiten ≤ 0).
    NoSlope,
    /// Senkrechte Kanten umschliessen einen Bereich, den keine geneigte Fläche erreicht.
    Fenced,
    /// Arbeitsbudget (Anzahl Ereignisse) aufgebraucht.
    Budget,
    /// Ereignisse liessen sich nicht auflösen (verhedderte Wellenfront, offene Flächen).
    Degenerate,
}

struct Edge {
    a: V,
    d: V,
    /// Innen-Normale: Aussenring CCW → Inneres links der Kanten.
    n: V,
    speed: f64,
}

#[derive(Clone)]
struct Corner {
    p: V,
    t: f64,
    v: V,
    /// Kante davor und danach (im Umlauf).
    left: usize,
    right: usize,
    prev: usize,
    next: usize,
    node: usize,
    alive: bool,
    /// Zwischen parallelen Kanten: kein Punkt bleibt auf beiden, eine der beiden fällt weg.
    stuck: bool,
}

impl Corner {
    fn at(&self, t: f64) -> V {
        self.p + self.v * (t - self.t)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    /// Die Kante zwischen zwei Ecken schrumpft weg.
    Shrink(usize, usize),
    /// Eine einspringende Ecke läuft in eine Kante.
    Split(usize, usize),
}

#[derive(Clone, Copy, PartialEq)]
struct Event {
    t: f64,
    kind: Kind,
}

impl Eq for Event {}

impl Ord for Event {
    // Früheste zuerst; bei gleicher Zeit Kanten- vor Split-Ereignissen.
    fn cmp(&self, other: &Event) -> Ordering {
        let rank = |k: &Kind| matches!(k, Kind::Split(..)) as u8;
        other.t.total_cmp(&self.t).then(rank(&other.kind).cmp(&rank(&self.kind)))
    }
}

impl PartialOrd for Event {
    fn partial_cmp(&self, other: &Event) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

struct Wavefront {
    edges: Vec<Edge>,
    corners: Vec<Corner>,
    /// Wo Ecken beginnen und sich treffen: Punkt und Zeit.
    nodes: Vec<(V, f64)>,
    /// Was Ecken hinterlassen: von Knoten zu Knoten, zwischen den Flächen zweier Kanten.
    arcs: Vec<(usize, usize, usize, usize)>,
    queue: BinaryHeap<Event>,
    /// Wie nah Punkte beieinander liegen müssen, um einer zu sein: 1e-7 der Umrissgrösse.
    eps: f64,
    /// Kanten, die sich an einem Punkt treffen, gehen nicht paarweise auf: Wellenfront verheddert.
    broken: bool,
}

impl Wavefront {
    /// Ecke zwischen den Kanten `left` und `right`, bei `p` zur Zeit `t`, ab Knoten `node`.
    fn corner(&mut self, p: V, t: f64, left: usize, right: usize, node: usize) -> usize {
        let (l, r) = (&self.edges[left], &self.edges[right]);
        let det = l.n.cross(r.n);
        // Sie bleibt auf beiden Kanten: v · n = speed, für jede.
        let (v, stuck) = if det.abs() > 1e-9 {
            (V((l.speed * r.n.1 - l.n.1 * r.speed) / det, (l.n.0 * r.speed - l.speed * r.n.0) / det), false)
        } else if l.n.dot(r.n) > 0.0 && (l.speed - r.speed).abs() < 1e-12 {
            (l.n * l.speed, false)
        } else {
            (V(0.0, 0.0), true)
        };
        self.corners.push(Corner { p, t, v, left, right, prev: NONE, next: NONE, node, alive: true, stuck });
        self.corners.len() - 1
    }

    /// Position der Ecke `c` zur Zeit `t` (`None` bei ungültigem Index).
    fn pos(&self, c: usize, t: f64) -> Option<V> {
        self.corners.get(c).map(|k| k.at(t))
    }

    /// Wann die Kante zwischen den Ecken `a` und `b` ab `now` wegschrumpft: jetzt, wenn sie
    /// beisammen sind und bleiben.
    fn shrink(&mut self, a: usize, b: usize, now: f64) {
        let (Some(ca), Some(cb)) = (self.corners.get(a), self.corners.get(b)) else {
            self.broken = true;
            return;
        };
        let d = self.edges[ca.right].d;
        // Abstand entlang der Kante: c + t · k.
        let c = (cb.p - cb.v * cb.t - (ca.p - ca.v * ca.t)).dot(d);
        let k = (cb.v - ca.v).dot(d);
        let together = (c + k * now).abs() <= self.eps && k < 1e-9;
        let t = if together { now } else { (-c / k).max(now) };
        if (together || k < -1e-12) && t.is_finite() {
            self.queue.push(Event { t, kind: Kind::Shrink(a, b) });
        }
    }

    /// Wann die einspringende Ecke `c` ab `now` in jede fremde Kante läuft.
    fn splits(&mut self, c: usize, now: f64) {
        let corner = &self.corners[c];
        let (dl, dr) = (self.edges[corner.left].d, self.edges[corner.right].d);
        if corner.stuck || dl.cross(dr) >= -1e-12 {
            return;
        }
        let p0 = corner.p - corner.v * corner.t;
        let found: Vec<Event> = self
            .edges
            .iter()
            .enumerate()
            .filter(|(f, _)| *f != corner.left && *f != corner.right)
            .filter_map(|(f, e)| {
                let k = corner.v.dot(e.n) - e.speed;
                let t = -(p0 - e.a).dot(e.n) / k;
                (k < -1e-12 && t.is_finite() && t >= now - EPS).then(|| Event { t: t.max(now), kind: Kind::Split(c, f) })
            })
            .collect();
        self.queue.extend(found);
    }

    /// Ecke `c` zwischen `prev` und `next` einhängen.
    fn link(&mut self, prev: usize, c: usize, next: usize) {
        if prev >= self.corners.len() || next >= self.corners.len() {
            self.broken = true;
            return;
        }
        self.corners[prev].next = c;
        self.corners[c].prev = prev;
        self.corners[c].next = next;
        self.corners[next].prev = c;
    }

    /// Frisch entstandene Ecke: eine Wellenfront aus zwei Ecken schliesst sich zum First, sonst
    /// ihre Ereignisse. Eine Ecke zwischen parallelen, jetzt deckungsgleichen Kanten kann nicht
    /// laufen: die langsamere zweier gleichgerichteter bzw. die kürzere zweier gegenläufiger
    /// fällt sofort weg und hinterlässt eine waagrechte Linie.
    fn settle(&mut self, c: usize, now: f64) {
        let (prev, next) = (self.corners[c].prev, self.corners[c].next);
        if prev >= self.corners.len() || next >= self.corners.len() {
            self.broken = true;
            self.corners[c].alive = false;
            return;
        }
        if next == c {
            self.corners[c].alive = false;
        } else if next == prev {
            let (a, b) = (&self.corners[c], &self.corners[next]);
            self.arcs.push((a.node, b.node, a.left, a.right));
            self.corners[c].alive = false;
            self.corners[next].alive = false;
        } else if self.corners[c].stuck {
            let k = &self.corners[c];
            let (l, r) = (&self.edges[k.left], &self.edges[k.right]);
            let (back, on) = (self.corners[prev].at(now), self.corners[next].at(now));
            let behind = if l.n.dot(r.n) > 0.0 { l.speed < r.speed } else { k.p.dist(back) <= k.p.dist(on) };
            if behind {
                self.merge(prev, c, back, now)
            } else {
                self.merge(c, next, on, now)
            }
        } else {
            self.shrink(prev, c, now);
            self.shrink(c, next, now);
            self.splits(c, now);
        }
    }

    /// Die benachbarten Ecken `a` und `b` treffen sich bei `p` zur Zeit `t`: die Kante zwischen
    /// ihnen ist weg, eine Ecke zwischen den Kanten beidseits läuft von dort weiter.
    fn merge(&mut self, a: usize, b: usize, p: V, t: f64) {
        let (prev, next) = (self.corners[a].prev, self.corners[b].next);
        if prev >= self.corners.len() || next >= self.corners.len() {
            self.broken = true;
            return;
        }
        // Noch drei Ecken: sie treffen sich in einem Punkt.
        if prev == next {
            let peak = self.node(p, t);
            for c in [a, b, next] {
                self.arc(c, peak);
            }
            return;
        }
        let n = self.node(p, t);
        let (left, right) = (self.corners[a].left, self.corners[b].right);
        self.arc(a, n);
        self.arc(b, n);
        let c = self.corner(p, t, left, right, n);
        self.link(prev, c, next);
        if !self.broken {
            self.settle(c, t);
        }
    }

    fn node(&mut self, p: V, t: f64) -> usize {
        self.nodes.push((p, t));
        self.nodes.len() - 1
    }

    /// Die Linie, die Ecke `c` hinterlässt, bis sie `node` erreicht.
    fn arc(&mut self, c: usize, node: usize) {
        let k = &self.corners[c];
        self.arcs.push((k.node, node, k.left, k.right));
        self.corners[c].alive = false;
    }

    fn step(&mut self, e: Event) {
        match e.kind {
            Kind::Shrink(a, b) => {
                let (ca, cb) = (&self.corners[a], &self.corners[b]);
                if ca.alive && cb.alive && ca.next == b {
                    let p = ca.at(e.t);
                    self.meet(p, e.t, &[a, b]);
                }
            }
            Kind::Split(v, f) => {
                if !self.corners[v].alive {
                    return;
                }
                let p = self.corners[v].at(e.t);
                // Nur wenn sie in ein noch vorhandenes Stück der Kante `f` läuft.
                let hit = self.corners.iter().filter(|x| x.alive && x.right == f).any(|x| match self.pos(x.next, e.t) {
                    Some(q) => dist_to_segment(p, x.at(e.t), q) < self.eps,
                    None => false,
                });
                if hit {
                    self.meet(p, e.t, &[v]);
                }
            }
        }
    }

    /// Die Ecken `must` und alle anderen dort treffen sich bei `p` zur Zeit `t`, evtl. mitten auf
    /// einer Kante, in die sie laufen. Die ein- und auslaufenden Kanten paaren sich zu neuen
    /// Ecken: jede auslaufende mit der gegen den Uhrzeigersinn nächsten einlaufenden, die
    /// Wellenfront dazwischen; zwei auf derselben Geraden schliessen zuerst, was zwischen ihnen
    /// übrig ist.
    fn meet(&mut self, p: V, t: f64, must: &[usize]) {
        let here: Vec<usize> = (0..self.corners.len())
            .filter(|&i| self.corners[i].alive && (must.contains(&i) || self.corners[i].at(t).dist(p) < self.eps))
            .collect();
        // Je Strahl: Richtung ab `p`, Kante, Ecke am anderen Ende, einlaufend?
        let mut rays: Vec<(f64, usize, usize, bool)> = Vec::new();
        let angle = |d: V| d.1.atan2(d.0);
        for &i in &here {
            let c = &self.corners[i];
            if !here.contains(&c.prev) {
                rays.push((angle(self.edges[c.left].d * -1.0), c.left, c.prev, true));
            }
            if !here.contains(&c.next) {
                rays.push((angle(self.edges[c.right].d), c.right, c.next, false));
            }
        }
        for (x, c) in self.corners.iter().enumerate() {
            if !c.alive || here.contains(&x) || here.contains(&c.next) {
                continue;
            }
            let Some(q) = self.pos(c.next, t) else { continue };
            if dist_to_segment(p, c.at(t), q) < self.eps {
                let d = self.edges[c.right].d;
                rays.extend([(angle(d * -1.0), c.right, x, true), (angle(d), c.right, c.next, false)]);
            }
        }
        let node = self.node(p, t);
        for &i in &here {
            self.arc(i, node);
        }
        let (outs, ins): (Vec<_>, Vec<_>) = rays.into_iter().partition(|r| !r.3);
        let mut pairs: Vec<(f64, usize, usize)> = Vec::new();
        for (i, o) in outs.iter().enumerate() {
            for (j, c) in ins.iter().enumerate() {
                let turn = (c.0 - o.0).rem_euclid(std::f64::consts::TAU);
                pairs.push((if turn > std::f64::consts::TAU - 1e-9 { 0.0 } else { turn }, i, j));
            }
        }
        pairs.sort_by(|a, b| a.0.total_cmp(&b.0));
        let (mut used_out, mut used_in) = (vec![false; outs.len()], vec![false; ins.len()]);
        let mut made = Vec::new();
        for (_, i, j) in pairs {
            if used_out[i] || used_in[j] {
                continue;
            }
            used_out[i] = true;
            used_in[j] = true;
            let c = self.corner(p, t, ins[j].1, outs[i].1, node);
            self.link(ins[j].2, c, outs[i].2);
            made.push(c);
        }
        if outs.len() != ins.len() || self.broken {
            self.broken = true;
            return;
        }
        for c in made {
            if self.corners[c].alive {
                self.settle(c, t);
            }
        }
    }
}

/// Umlauf um eine Fläche: Eckpunkte, je mit der Zeit, zu der die Wellenfront sie erreicht.
pub type Face = Vec<(P2, f64)>;

/// Standard-Arbeitsbudget (Ereignisse) für `n` Kanten.
pub fn default_budget(n: usize) -> usize {
    100usize.saturating_mul(n).saturating_mul(n).saturating_add(1000)
}

/// Die Flächen, die die Kanten von `rings` mit Geschwindigkeit `speeds` überstreichen: Aussenring
/// (CCW, einfach) und Löcher darin (je CW, innen, disjunkt); Kanten Ring für Ring nummeriert,
/// Kante i von Punkt i zum nächsten. Je laufende Kante die Umläufe ihrer Fläche: zuerst der
/// Aussenumlauf (CCW, ab ihrem Anfang entlang der Kante, dann durch das Skelett zurück), danach
/// Löcher darin (CW); für stehende Kanten (Geschwindigkeit ≤ 0) keine.
///
/// `budget`: höchstens so viele Ereignisse (`None` = [`default_budget`]). Nie Panic: unbrauchbare
/// Eingaben, Budget und Degeneration ergeben einen [`SkeletonError`].
pub fn faces(rings: &[Vec<P2>], speeds: &[f64], budget: Option<usize>) -> Result<Vec<Vec<Face>>, SkeletonError> {
    let rings: Vec<Vec<V>> = rings.iter().map(|r| r.iter().map(|&p| V::of(p)).collect()).collect();
    let outline: &[V] = rings.first().map(|r| r.as_slice()).unwrap_or(&[]);
    // Jeder Punkt und sein Nachfolger im Ring.
    let (mut points, mut next) = (Vec::new(), Vec::new());
    for r in &rings {
        next.extend((0..r.len()).map(|i| points.len() + (i + 1) % r.len()));
        points.extend_from_slice(r);
    }
    let n = points.len();
    if points.iter().any(|p| !p.is_finite()) || speeds.iter().any(|s| !s.is_finite()) {
        return Err(SkeletonError::Input("Punkte und Geschwindigkeiten müssen endlich sein"));
    }
    if outline.len() < 3 || speeds.len() != n || ring_area(outline) <= 0.0 {
        return Err(SkeletonError::Input("Aussenring: mindestens drei Punkte, gegen den Uhrzeigersinn"));
    }
    if rings.iter().skip(1).any(|h| h.len() < 3 || ring_area(h) >= 0.0) {
        return Err(SkeletonError::Input("Loch: mindestens drei Punkte, im Uhrzeigersinn"));
    }
    if speeds.iter().all(|s| *s <= 0.0) {
        return Err(SkeletonError::NoSlope);
    }
    let mut prev = vec![0; n];
    for (i, &j) in next.iter().enumerate() {
        prev[j] = i;
    }
    let edges: Vec<Edge> = (0..n)
        .map(|i| {
            let (a, b) = (points[i], points[next[i]]);
            let d = (b - a).unit();
            Edge { a, d, n: d.perp(), speed: speeds[i].max(0.0) }
        })
        .collect();
    if edges.iter().any(|e| !e.d.is_finite() || e.d.length() < 0.5) {
        return Err(SkeletonError::Input("zwei Punkte fallen zusammen"));
    }
    let size = outline.iter().fold(0.0f64, |m, p| m.max(p.dist(outline[0])));
    let mut w = Wavefront {
        edges,
        corners: Vec::new(),
        nodes: points.iter().map(|p| (*p, 0.0)).collect(),
        arcs: Vec::new(),
        queue: BinaryHeap::new(),
        eps: size * 1e-7,
        broken: false,
    };
    for (i, p) in points.iter().enumerate() {
        w.corner(*p, 0.0, prev[i], i, i);
    }
    for i in 0..n {
        w.link(prev[i], i, next[i]);
    }
    for i in 0..n {
        if w.corners.get(i).is_some_and(|c| c.alive) {
            w.settle(i, 0.0);
        }
    }
    let mut budget = budget.unwrap_or_else(|| default_budget(n));
    while let Some(e) = w.queue.pop() {
        if w.broken {
            break;
        }
        budget = budget.checked_sub(1).ok_or(SkeletonError::Budget)?;
        w.step(e);
    }
    let left: Vec<&Corner> = w.corners.iter().filter(|c| c.alive).collect();
    if !w.broken && !left.is_empty() && left.iter().all(|c| w.edges[c.left].speed <= 0.0 && w.edges[c.right].speed <= 0.0) {
        return Err(SkeletonError::Fenced);
    }
    if w.broken || !left.is_empty() {
        return Err(SkeletonError::Degenerate);
    }
    // Fläche je Kante: entlang der Kante, dann von ihrem Ende über die angrenzenden Linien zurück
    // zum Anfang; danach übrige Schleifen = Löcher (eine Fläche schliesst sich um einen Hof).
    // Eine Linie mit der Fläche auf beiden Seiten (zwei Stücke derselben Kante) zählt nicht.
    (0..n)
        .map(|i| {
            if speeds[i] <= 0.0 {
                return Ok(Vec::new());
            }
            let mut arcs: Vec<(usize, usize)> = w.arcs.iter().filter(|a| (a.2 == i) != (a.3 == i)).map(|a| (a.0, a.1)).collect();
            // Vom letzten Knoten von `path` über die Linien zurück zum ersten.
            let walk = |arcs: &mut Vec<(usize, usize)>, mut path: Vec<usize>| -> Result<Vec<(V, f64)>, SkeletonError> {
                let (Some(&start), Some(&last)) = (path.first(), path.last()) else { return Err(SkeletonError::Degenerate) };
                let mut at = last;
                while at != start {
                    let k = arcs.iter().position(|(a, b)| *a == at || *b == at).ok_or(SkeletonError::Degenerate)?;
                    let (a, b) = arcs.swap_remove(k);
                    at = if a == at { b } else { a };
                    if at != start {
                        path.push(at);
                    }
                }
                let mut face: Vec<(V, f64)> = path.into_iter().filter_map(|k| w.nodes.get(k).copied()).collect();
                face.dedup_by(|b, a| a.0.dist(b.0) < EPS);
                if face.len() > 2 && face.first().zip(face.last()).is_some_and(|(a, b)| a.0.dist(b.0) < EPS) {
                    face.pop();
                }
                Ok(face)
            };
            let mut loops = pinched(walk(&mut arcs, vec![i, next[i]])?);
            while let Some((a, b)) = arcs.pop() {
                loops.extend(pinched(walk(&mut arcs, vec![a, b])?));
            }
            // Aussenumlauf, dann die Löcher darin im Uhrzeigersinn.
            let mut holes = loops.split_off(1.min(loops.len()));
            holes.retain(|h| h.len() >= 3);
            for h in &mut holes {
                if ring_area(&h.iter().map(|(p, _)| *p).collect::<Vec<_>>()) > 0.0 {
                    h.reverse();
                }
            }
            loops.extend(holes);
            Ok(loops.into_iter().map(|l| l.into_iter().map(|(p, t)| (p.arr(), t)).collect()).collect())
        })
        .collect()
}

/// `ring` überall dort aufgeschnitten, wo er an einen schon passierten Punkt zurückkehrt: der
/// Rest, dann jede Schleife dazwischen (ein Loch, das ihn dort berührt — eine Fläche, die sich
/// um einen Hof schliesst, trifft sich selbst an dessen stehender Ecke).
fn pinched(mut ring: Vec<(V, f64)>) -> Vec<Vec<(V, f64)>> {
    let same = |a: &(V, f64), b: &(V, f64)| a.0.dist(b.0) < EPS;
    let mut loops = Vec::new();
    loop {
        // Zurück am Anfang: was folgt, ist eine Schleife dorthin; sonst das Stück dazwischen.
        if let Some(j) = (2..ring.len()).find(|&j| same(&ring[j], &ring[0])) {
            loops.push(ring.split_off(j));
        } else if let Some((i, j)) = (2..ring.len()).find_map(|j| (1..j).find(|&i| same(&ring[i], &ring[j])).map(|i| (i, j))) {
            loops.push(ring.drain(i..j).collect());
        } else {
            break;
        }
    }
    loops.insert(0, ring);
    loops
}

// ── Flache Kodierung für die WASM-Grenze ─────────────────────────────────────
//
// Eingabe: Ringe `[nRinge, (nPkt, x, y, …)…]` (Ring 0 aussen CCW, weitere Löcher CW),
//          Geschwindigkeiten je Kante (Ring für Ring), Budget (≤ 0/NaN = Standard).
// Ausgabe: `[status, nKanten, (nUmläufe, (nPkt, (x, y, t)…)…)…]`; status 0 = ok, sonst
//          1 Eingabe, 2 keine Neigung, 3 eingezäunt, 4 Budget, 5 Degeneration (dann nur [status]).

/// Status-Code eines Fehlers (s. Kodierung oben).
pub fn error_code(e: &SkeletonError) -> f64 {
    match e {
        SkeletonError::Input(_) => 1.0,
        SkeletonError::NoSlope => 2.0,
        SkeletonError::Fenced => 3.0,
        SkeletonError::Budget => 4.0,
        SkeletonError::Degenerate => 5.0,
    }
}

/// [`faces`] über flache Puffer; nie Panic (kaputte Puffer → Status 1).
pub fn faces_flat(rings: &[f64], speeds: &[f64], budget: f64) -> Vec<f64> {
    let mut r = crate::flat_read::Reader::new(rings);
    let Some(n) = r.count() else { return vec![1.0] };
    let mut rs = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let Some(ring) = r.ring() else { return vec![1.0] };
        rs.push(ring);
    }
    let budget = (budget.is_finite() && budget >= 1.0).then(|| budget.min(1e12) as usize);
    match faces(&rs, speeds, budget) {
        Err(e) => vec![error_code(&e)],
        Ok(fs) => {
            let mut out = vec![0.0, fs.len() as f64];
            for loops in &fs {
                out.push(loops.len() as f64);
                for l in loops {
                    out.push(l.len() as f64);
                    for (p, t) in l {
                        out.extend_from_slice(&[p[0], p[1], *t]);
                    }
                }
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    //! Tests aus BIMCraft (mm → m: Massstab 1/1000 bei den Zufalls-Grundrissen), ergänzt um
    //! Dossier-Fälle (Budget, Unsinn).
    use super::*;

    fn area(face: &[(P2, f64)]) -> f64 {
        let r: Vec<V> = face.iter().map(|(p, _)| V::of(*p)).collect();
        ring_area(&r)
    }

    fn rarea(ring: &[P2]) -> f64 {
        ring_area(&ring.iter().map(|&p| V::of(p)).collect::<Vec<_>>())
    }

    fn highest(faces: &[Vec<Face>]) -> f64 {
        faces.iter().flatten().flatten().map(|(_, t)| *t).fold(0.0, f64::max)
    }

    fn dist(a: P2, b: P2) -> f64 {
        (a[0] - b[0]).hypot(a[1] - b[1])
    }

    fn sk(rings: &[Vec<P2>], speeds: &[f64]) -> Result<Vec<Vec<Face>>, SkeletonError> {
        faces(rings, speeds, None)
    }

    #[test]
    fn rechteck_walm_und_giebel_und_pult() {
        let ring = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 4.0], [0.0, 4.0]];
        let f = sk(&[ring.clone()], &[1.0; 4]).unwrap();
        assert_eq!(f.iter().flatten().map(Vec::len).collect::<Vec<_>>(), [4, 3, 4, 3]);
        assert!((highest(&f) - 2.0).abs() < 1e-9);
        let total: f64 = f.iter().flatten().map(|x| area(x)).sum();
        assert!((total - 40.0).abs() < 1e-9, "{total}");
        let g = sk(&[ring.clone()], &[1.0, 0.0, 1.0, 0.0]).unwrap();
        assert!(g[1].is_empty() && g[3].is_empty());
        assert!((g[0].iter().map(|x| area(x)).sum::<f64>() - 20.0).abs() < 1e-9, "{:?}", g[0]);
        let shed = sk(&[ring.clone()], &[1.0, 0.0, 0.0, 0.0]).unwrap();
        assert!((shed[0].iter().map(|x| area(x)).sum::<f64>() - 40.0).abs() < 1e-9 && (highest(&shed) - 4.0).abs() < 1e-9);
        assert_eq!(sk(&[ring], &[0.0; 4]).unwrap_err(), SkeletonError::NoSlope);
    }

    #[test]
    fn l_mit_kehle_an_der_innenecke() {
        let ring = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 4.0], [4.0, 4.0], [4.0, 10.0], [0.0, 10.0]];
        let f = sk(&[ring], &[1.0; 6]).unwrap();
        let total: f64 = f.iter().flatten().map(|x| area(x)).sum();
        assert!((total - 64.0).abs() < 1e-9, "{total}");
        assert!((highest(&f) - 2.0).abs() < 1e-9);
        let valley = |x: &Face| x.iter().any(|(p, t)| dist(*p, [2.0, 2.0]) < 1e-9 && (t - 2.0).abs() < 1e-9);
        assert!(f[2].iter().any(valley) && f[3].iter().any(valley), "{f:?}");
    }

    #[test]
    fn konvex_zur_spitze_oder_zum_first() {
        let tri = vec![[0.0, 0.0], [6.0, 0.0], [3.0, 5.196152422706632]];
        let f = sk(&[tri], &[1.0; 3]).unwrap();
        assert!((highest(&f) - 3.0f64.sqrt()).abs() < 1e-9);
        for ring in [vec![[0.0, 0.0], [9.0, 1.0], [8.0, 6.0], [1.0, 4.0]], vec![[0.0, 0.0], [6.0, 0.0], [8.0, 4.0], [3.0, 7.0], [-2.0, 4.0]]] {
            let f = sk(&[ring.clone()], &vec![1.0; ring.len()]).unwrap();
            let total: f64 = f.iter().flatten().map(|x| area(x)).sum();
            assert!((total - rarea(&ring)).abs() < 1e-6, "{ring:?}: {total}");
        }
    }

    /// Jede Fläche eben: jeder Eckpunkt so weit von seiner Kante, wie die Kante gelaufen ist.
    fn flat(rings: &[Vec<P2>], speeds: &[f64], f: &[Vec<Face>]) -> bool {
        let edges: Vec<(P2, P2)> = rings.iter().flat_map(|r| (0..r.len()).map(move |i| (r[i], r[(i + 1) % r.len()]))).collect();
        f.iter().zip(edges.iter().zip(speeds)).all(|(face, ((a, b), s))| {
            let n = (V::of(*b) - V::of(*a)).unit().perp();
            face.iter().flatten().all(|(p, t)| ((V::of(*p) - V::of(*a)).dot(n) - t * s).abs() < 1e-6)
        })
    }

    #[test]
    fn hof_steigt_zu_einem_firstring() {
        let rings = [vec![[0.0, 0.0], [12.0, 0.0], [12.0, 12.0], [0.0, 12.0]], vec![[4.0, 4.0], [4.0, 8.0], [8.0, 8.0], [8.0, 4.0]]];
        let f = sk(&rings, &[1.0; 8]).unwrap();
        assert_eq!(f.iter().flatten().map(Vec::len).collect::<Vec<_>>(), [4; 8], "{f:?}");
        let total: f64 = f.iter().flatten().map(|x| area(x)).sum();
        assert!((total - 128.0).abs() < 1e-9, "{total}");
        assert!(flat(&rings, &[1.0; 8], &f));
        for (p, t) in f.iter().flatten().flatten() {
            let ring = (p[0] - 6.0).abs().max((p[1] - 6.0).abs());
            assert!(*t == 0.0 || ((t - 2.0).abs() < 1e-9 && (ring - 4.0).abs() < 1e-9), "{p:?} at {t}");
        }
        // Nordkante des Hofs als Giebel: die Nordfläche des Aussenrings steigt bis zu ihm.
        let speeds = [1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0];
        let g = sk(&rings, &speeds).unwrap();
        assert!(g[5].is_empty());
        let total: f64 = g.iter().flatten().map(|x| area(x)).sum();
        assert!((total - 128.0).abs() < 1e-9 && flat(&rings, &speeds, &g), "{total}: {g:?}");
        assert!((highest(&g) - 4.0).abs() < 1e-9);
        let off = [vec![[0.0, 0.0], [12.0, 0.0], [12.0, 10.0], [0.0, 10.0]], vec![[3.0, 3.0], [3.0, 7.0], [7.0, 7.0], [7.0, 3.0]]];
        let f = sk(&off, &[1.0; 8]).unwrap();
        let total: f64 = f.iter().flatten().map(|x| area(x)).sum();
        assert!((total - 104.0).abs() < 1e-9 && flat(&off, &[1.0; 8], &f), "{total}: {f:?}");
        assert!((highest(&f) - 2.5).abs() < 1e-9);
        assert!(matches!(sk(&[off[0].clone(), off[0].clone()], &[1.0; 8]), Err(SkeletonError::Input(_))));
    }

    fn turn(rings: &[Vec<P2>], a: f64) -> Vec<Vec<P2>> {
        let (s, c) = a.sin_cos();
        rings.iter().map(|r| r.iter().map(|p| [p[0] * c - p[1] * s, p[0] * s + p[1] * c]).collect()).collect()
    }

    #[test]
    fn flaeche_schliesst_sich_um_hof_mit_giebel() {
        let rings = vec![
            vec![[90.0, 0.0], [90.0, 10.0], [70.0, 10.0], [70.0, 30.0], [-30.0, 30.0], [-30.0, 10.0], [-80.0, 10.0], [-80.0, 0.0]],
            vec![[-5.0, 2.0], [-5.0, 8.0], [5.0, 8.0], [5.0, 2.0]],
        ];
        let speeds = [1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0];
        for rings in [rings.clone(), turn(&rings, 0.3468)] {
            let f = sk(&rings, &speeds).unwrap();
            let total: f64 = f.iter().flatten().map(|x| area(x)).sum();
            assert!((total - 3640.0).abs() < 1e-6 && flat(&rings, &speeds, &f), "{total}: {f:?}");
            let island = 60.0 + [8, 10, 11].iter().flat_map(|i| &f[*i]).map(|x| area(x)).sum::<f64>();
            assert!(f[7].len() == 2 && (area(&f[7][1]) + island).abs() < 1e-6, "{:?}", f[7]);
        }
    }

    #[test]
    fn flaeche_beruehrt_sich_wo_zwei_giebel_sich_treffen() {
        let rings = vec![
            vec![[-30.0, 0.0], [80.0, 0.0], [80.0, 70.0], [-30.0, 70.0]],
            vec![[-9.0, 2.0], [-9.0, 8.0], [-4.0, 8.0], [-4.0, 2.0]],
            vec![[4.0, 2.0], [4.0, 8.0], [9.0, 8.0], [9.0, 2.0]],
        ];
        let mut speeds = [1.0; 12];
        speeds[8] = 0.0;
        speeds[9] = 0.0;
        for rings in [rings.clone(), turn(&rings, 0.3468)] {
            let f = sk(&rings, &speeds).unwrap();
            let total: f64 = f.iter().flatten().map(|x| area(x)).sum();
            assert!((total - 7640.0).abs() < 1e-6 && flat(&rings, &speeds, &f), "{total}: {:?}", f[0]);
            assert!(f[0].len() == 2 && area(&f[0][1]) < 0.0, "{:?}", f[0]);
        }
    }

    /// Zufällige Grundrisse (in Metern): Sterne (viele einspringende Ecken, Splits überall) und
    /// Treppen-Umrisse (rechte Winkel, gleichzeitige Ereignisse), teils mit stehenden Kanten,
    /// teils mit einem oder zwei Höfen, beliebig gedreht.
    #[test]
    fn zufalls_grundrisse_schliessen_sich() {
        let mut seed = 12345u64;
        let mut rand = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as f64 / (1u64 << 31) as f64
        };
        for round in 0..2000 {
            let n = 5 + (rand() * 12.0) as usize;
            let court = round % 4 >= 2;
            let rings: Vec<Vec<P2>> = if round % 2 == 0 {
                let star: Vec<P2> = (0..n)
                    .map(|i| {
                        let a = (i as f64 + rand() * 0.8) / n as f64 * std::f64::consts::TAU;
                        let r = 3.0 + rand() * 7.0;
                        [r * a.cos(), r * a.sin()]
                    })
                    .collect();
                let k = 3 + (rand() * 6.0) as usize;
                let mut hole: Vec<P2> = (0..k)
                    .rev()
                    .map(|i| {
                        let a = (i as f64 + rand() * 0.8) / k as f64 * std::f64::consts::TAU;
                        let r = 0.3 + rand() * 0.9;
                        [r * a.cos(), r * a.sin()]
                    })
                    .collect();
                if rarea(&hole) > 0.0 {
                    hole.reverse();
                }
                if court {
                    vec![star, hole]
                } else {
                    vec![star]
                }
            } else {
                let steps = 1 + (rand() * 4.0) as usize;
                let mut right: Vec<P2> = vec![];
                let mut left: Vec<P2> = vec![];
                let mut y = 0.0;
                for _ in 0..steps {
                    let (xr, xl, h) = (2.0 + (rand() * 8.0).floor(), -2.0 - (rand() * 8.0).floor(), 1.0 + (rand() * 5.0).floor());
                    right.extend([[xr, y], [xr, y + h]]);
                    left.splice(0..0, [[xl, y + h], [xl, y]]);
                    y += h;
                }
                let first = right.get(1).map_or(1.0, |p| p[1]);
                let mut ring: Vec<P2> = right;
                ring.extend(left);
                ring.dedup_by(|b, a| dist(*a, *b) < 1e-12);
                let (w, y0, g) = (0.5 + (rand() * 3.0).floor() * 0.5, 0.2 + (rand() * 3.0).floor() * 0.1, 0.2 + (rand() * 3.0).floor() * 0.1);
                let hole = |a: f64, b: f64| vec![[a, y0], [a, first - y0], [b, first - y0], [b, y0]];
                let holes = if round % 8 == 7 { vec![hole(-w - g, -g), hole(g, w + g)] } else { vec![hole(-w, w)] };
                let mut rings = vec![ring];
                if court {
                    rings.extend(holes);
                }
                turn(&rings, rand() * 7.0)
            };
            let count = rings.iter().map(Vec::len).sum();
            let mut speeds: Vec<f64> = (0..count).map(|_| if rand() < 0.15 { 0.0 } else { 1.0 }).collect();
            speeds[0] = 1.0;
            let whole: f64 = rings.iter().map(|r| rarea(r)).sum();
            for speeds in [vec![1.0; count], speeds] {
                let f = match sk(&rings, &speeds) {
                    Ok(f) => f,
                    Err(SkeletonError::Fenced) if speeds.contains(&0.0) => continue,
                    Err(e) => panic!("{e:?}: {rings:?} {speeds:?}"),
                };
                let total: f64 = f.iter().flatten().map(|x| area(x)).sum();
                assert!((total - whole).abs() < 1e-3 * whole, "{rings:?} {speeds:?}: {total} vs {whole}");
                assert!(flat(&rings, &speeds, &f), "{rings:?} {speeds:?}: {f:?}");
            }
        }
    }

    #[test]
    fn t_und_u_schliessen_sich() {
        let t = vec![[0.0, 0.0], [4.0, 0.0], [4.0, 6.0], [9.0, 6.0], [9.0, 10.0], [-5.0, 10.0], [-5.0, 6.0], [0.0, 6.0]];
        let u = vec![[0.0, 0.0], [12.0, 0.0], [12.0, 9.0], [8.0, 9.0], [8.0, 4.0], [4.0, 4.0], [4.0, 9.0], [0.0, 9.0]];
        for ring in [t, u] {
            let f = sk(&[ring.clone()], &vec![1.0; ring.len()]).unwrap();
            let total: f64 = f.iter().flatten().map(|x| area(x)).sum();
            assert!((total - rarea(&ring)).abs() < 1e-6, "{ring:?}: {total}");
            assert!(f.iter().flatten().all(|x| area(x) > 0.0), "{f:?}");
        }
    }

    #[test]
    fn neigung_je_kante() {
        // Rechteck 10×4, Südseite doppelt so schnell (halbe Neigung): First rückt nach Norden.
        let ring = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 4.0], [0.0, 4.0]];
        let f = sk(&[ring.clone()], &[2.0, 0.0, 1.0, 0.0]).unwrap();
        // Treffen bei 2t + t = 4 → t = 4/3, First bei y = 8/3.
        assert!((highest(&f) - 4.0 / 3.0).abs() < 1e-9);
        assert!(f[0][0].iter().any(|(p, _)| (p[1] - 8.0 / 3.0).abs() < 1e-9));
        assert!(flat(&[ring], &[2.0, 0.0, 1.0, 0.0], &f));
    }

    #[test]
    fn budget_und_unsinn_ohne_panic() {
        let u = vec![[0.0, 0.0], [12.0, 0.0], [12.0, 9.0], [8.0, 9.0], [8.0, 4.0], [4.0, 4.0], [4.0, 9.0], [0.0, 9.0]];
        assert_eq!(faces(&[u.clone()], &[1.0; 8], Some(1)).unwrap_err(), SkeletonError::Budget);
        assert!(faces(&[u.clone()], &[1.0; 8], Some(10_000)).is_ok());
        assert!(matches!(sk(&[], &[]), Err(SkeletonError::Input(_))));
        assert!(matches!(sk(&[vec![[0.0, 0.0], [1.0, 0.0]]], &[1.0; 2]), Err(SkeletonError::Input(_))));
        assert!(matches!(sk(&[u.clone()], &[1.0; 3]), Err(SkeletonError::Input(_))));
        let mut nan = u.clone();
        nan[2][0] = f64::NAN;
        assert!(matches!(sk(&[nan], &[1.0; 8]), Err(SkeletonError::Input(_))));
        assert!(matches!(sk(&[u.clone()], &[f64::INFINITY; 8]), Err(SkeletonError::Input(_))));
        let mut dup = u.clone();
        dup[1] = dup[0];
        assert!(matches!(sk(&[dup], &[1.0; 8]), Err(SkeletonError::Input(_))));
        // CW-Aussenring.
        let mut cw = u.clone();
        cw.reverse();
        assert!(matches!(sk(&[cw], &[1.0; 8]), Err(SkeletonError::Input(_))));
        // Selbstüberschneidung (Achterform, Fläche 0): Fehler statt Panic.
        let _ = sk(&[vec![[0.0, 0.0], [4.0, 4.0], [4.0, 0.0], [0.0, 4.0]]], &[1.0; 4]);
        // Selbstüberschneidend mit positiver Fläche: Ergebnis oder Fehler, nie Panic.
        let _ = sk(&[vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [5.0, -5.0], [0.0, 10.0]]], &[1.0; 5]);
        // Loch ausserhalb / überlappend: kein Panic.
        let _ = sk(&[u.clone(), vec![[20.0, 20.0], [20.0, 25.0], [25.0, 25.0], [25.0, 20.0]]], &[1.0; 12]);
        let _ = sk(&[u, vec![[-1.0, 1.0], [-1.0, 3.0], [13.0, 3.0], [13.0, 1.0]]], &[1.0; 12]);
    }

    #[test]
    fn flache_kodierung() {
        let rings = [1.0, 4.0, 0.0, 0.0, 10.0, 0.0, 10.0, 4.0, 0.0, 4.0];
        let out = faces_flat(&rings, &[1.0; 4], f64::NAN);
        assert_eq!((out[0], out[1]), (0.0, 4.0));
        // Kante 0: ein Umlauf, Trapez (4 Punkte), erster Punkt (0, 0) zur Zeit 0.
        assert_eq!(&out[2..7], &[1.0, 4.0, 0.0, 0.0, 0.0]);
        assert_eq!(faces_flat(&rings, &[1.0; 4], 1.0), vec![4.0]);
        assert_eq!(faces_flat(&rings, &[0.0; 4], 0.0), vec![2.0]);
        assert_eq!(faces_flat(&[], &[], 0.0), vec![1.0]);
        assert_eq!(faces_flat(&[1.0, 5.0, 0.0], &[1.0; 5], 0.0), vec![1.0]);
        assert_eq!(faces_flat(&[f64::NAN], &[], 0.0), vec![1.0]);
        assert_eq!(faces_flat(&[2e9], &[], 0.0), vec![1.0]);
    }
}
