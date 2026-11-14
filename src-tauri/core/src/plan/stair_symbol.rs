//! Treppen-Symbol im Grundriss ([K3a]): Tritte, Lauflinie, Pfeil, Podest, SIA-Bruchlinie und
//! Aussenlinie als flache Primitivliste. Port von `src/plan/generatePlan/stairs.ts`; die Geometrie
//! kommt aus `kernel2d` (`stair_geometry`, `stair_outline`), Farbe, Pick-ID und Graustufen setzt der
//! Aufrufer (`plan/stairs.rs`, [K3d]).
//!
//! Eingabe: Treppen-Parameter (22 Zahlen, s. `stair.rs`), Gesamt-Steighöhe, Schnitthöhe über der
//! Treppen-UK, Strichstärke `lw_mm` (Papier-mm), `filled_arrow` (0/1).
//!
//! Ausgabe `[n, Eintrag × n]`, Reihenfolge = Zeichenreihenfolge:
//! ```text
//! 1 polygon  [1, strokeMm, gefüllt (0 = nur Umriss, 1 = Füllung in Strichfarbe), nPts, x, y …]   (strokeMm 0 = unsichtbare Pick-Fläche)
//! 2 line     [2, cls, weightMm, gestrichelt (0|1), ax, ay, bx, by]
//! 3 arc      [3, weightMm, gestrichelt (0|1), cx, cy, fromX, fromY, toX, toY, r]   (cls immer stair-outline)
//! cls        0 stair-outline · 1 stair-tread · 2 stair-break · 3 stair-run · 4 stair-arrow · 5 stair-handrail
//! ```
//! Gestrichelte Linien tragen das Strichmuster `DASH` (verdeckt, Papier-mm, [153]).
//!
//! [155] Jede Kante genau einmal: Aussenlinie (Wange) vor Trittkanten vor Podestkanten, deckungsgleiche
//! Stücke entfallen (keine Tritt-Vielecke mehr unter den Linien). Das erste Element (Tritt oder Podest)
//! über der Schnitthöhe trägt die Bruchlinie (quer, Zickzack in der Mitte); Wange, Kanten und Handlauf
//! sind davor ausgezogen, dahinter gestrichelt. Strichstärken relativ zur Kategorie: Tritte, Podest,
//! Lauflinie, Pfeil × [`TREAD_FACTOR`], Umriss und Bruchlinie × [`OUTLINE_FACTOR`] (Tusche 0.1 / 0.13 @1:100).
//!
//! [151] Handlauf (`railing` 0 keiner, 1 links, 2 rechts, 3 beide): Achse aus [`crate::stair_rail`] (wie im
//! 3D), vor der Bruchlinie ausgezogen, dahinter gestrichelt; `double` (1:50/fein) zeichnet die beiden
//! Rohrkanten statt der Achse. Strichstärke [`HANDRAIL_MM`] (Tusche 0.1 mm).

use crate::jsnum;
use crate::stair::decode_params;
use crate::stair_rail::P;
use kernel2d::{stair_geometry, stair_outline, StairGeometry, StairParams, Vec2};

pub const DASH: [f64; 2] = super::line_pattern::HIDDEN;

const CLS_OUTLINE: f64 = 0.0;
const CLS_TREAD: f64 = 1.0;
const CLS_BREAK: f64 = 2.0;
const CLS_RUN: f64 = 3.0;
const CLS_ARROW: f64 = 4.0;
const CLS_HANDRAIL: f64 = 5.0;
/// Strichstärke des Handlaufs (Papier-mm).
pub const HANDRAIL_MM: f64 = 0.1;
/// [155] Linienhierarchie relativ zur Kategorie-Stärke (Standard Treppen 0.18 @1:100): Tritte, Podestkanten,
/// Lauflinie und Pfeil 0.1, Umriss/Wange und Bruchlinie 0.13.
pub const TREAD_FACTOR: f64 = 0.1 / 0.18;
pub const OUTLINE_FACTOR: f64 = 0.13 / 0.18;
/// Toleranz für „deckungsgleich" (Meter).
const EPS: f64 = 1e-6;

/// Ecken des Säulenkreises im Grundriss.
const COLUMN_SEGMENTS: usize = 48;
/// Bogenauflösung der Wendel-Grundfläche (Pick, Belag) und beschnittener Bögen (Radiant je Stück).
const ARC_STEP: f64 = std::f64::consts::PI / 90.0;

#[derive(Clone, Debug)]
enum Item {
    Polygon { pts: Vec<Vec2>, stroke_mm: f64, filled: bool },
    Line { cls: f64, a: Vec2, b: Vec2, w: f64, dashed: bool },
    Arc { w: f64, c: Vec2, r: f64, a0: f64, a1: f64, dashed: bool },
}

fn v(p: P) -> Vec2 {
    Vec2::new(p[0], p[1])
}
fn p2(a: Vec2) -> P {
    [a.x, a.y]
}
fn sub(a: Vec2, b: Vec2) -> Vec2 {
    Vec2::new(a.x - b.x, a.y - b.y)
}
fn add(a: Vec2, b: Vec2) -> Vec2 {
    Vec2::new(a.x + b.x, a.y + b.y)
}
fn mul(a: Vec2, s: f64) -> Vec2 {
    Vec2::new(a.x * s, a.y * s)
}
fn mid(a: Vec2, b: Vec2) -> Vec2 {
    Vec2::new((a.x + b.x) / 2.0, (a.y + b.y) / 2.0)
}
fn cross(a: Vec2, b: Vec2) -> f64 {
    a.x * b.y - a.y * b.x
}
fn dot(a: Vec2, b: Vec2) -> f64 {
    a.x * b.x + a.y * b.y
}
fn len(a: Vec2) -> f64 {
    crate::jsmath::hypot2(a.x, a.y)
}
fn lerp(a: Vec2, b: Vec2, t: f64) -> Vec2 {
    Vec2::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
}

/// Abstand Punkt–Strecke.
fn dist_seg(m: Vec2, a: Vec2, b: Vec2) -> f64 {
    let d = sub(b, a);
    let l2 = dot(d, d);
    let t = if l2 > 0.0 { (dot(sub(m, a), d) / l2).clamp(0.0, 1.0) } else { 0.0 };
    len(sub(m, lerp(a, b, t)))
}

fn dist_poly(m: Vec2, poly: &[Vec2]) -> f64 {
    (0..poly.len()).map(|i| dist_seg(m, poly[i], poly[(i + 1) % poly.len()])).fold(f64::INFINITY, f64::min)
}

/// Schnittparameter t der Strecke a–b mit der Strecke c–d (beide Parameter in [0, 1]).
fn seg_hit(a: Vec2, b: Vec2, c: Vec2, d: Vec2) -> Option<f64> {
    let (r, s) = (sub(b, a), sub(d, c));
    let den = cross(r, s);
    if den.abs() < 1e-15 {
        return None;
    }
    let t = cross(sub(c, a), s) / den;
    let u = cross(sub(c, a), r) / den;
    ((-1e-9..=1.0 + 1e-9).contains(&t) && (-1e-9..=1.0 + 1e-9).contains(&u)).then_some(t.clamp(0.0, 1.0))
}

/// Ein Element der Treppe im Grundriss: Tritt oder Podest mit Oberkante über der Treppen-UK.
struct El {
    poly: Vec<Vec2>,
    top: f64,
}

/// [155] Bruch: erstes Element über der Schnitthöhe, quer geteilt durch die Bruchlinie `a`–`b`; `up` zeigt
/// auf die obere (gestrichelte) Seite, `depth` = Platz längs für das Zickzack.
struct Break {
    el: usize,
    a: Vec2,
    b: Vec2,
    up: Vec2,
    depth: f64,
}

/// Treppe als Elemente mit Schnitt-Zuordnung: unter der Schnitthöhe ausgezogen, darüber gestrichelt,
/// das erste Element darüber durch die Bruchlinie geteilt.
struct Layout {
    els: Vec<El>,
    cut: f64,
    brk: Option<Break>,
}

impl Layout {
    fn new(p: &StairParams, geo: &StairGeometry, cut: f64, spiral_center: Option<Vec2>) -> Layout {
        let mut els: Vec<El> = geo.treads.iter().filter(|t| t.pts.len() >= 4).map(|t| El { poly: t.pts.clone(), top: t.top_rise }).collect();
        let n_treads = els.len();
        let spiral = p.shape == "spiral";
        if !spiral {
            for (poly, top) in crate::stair_rail::landings_of(geo) {
                els.push(El { poly: poly.into_iter().map(v).collect(), top });
            }
        }
        let first = (0..els.len()).filter(|&i| els[i].top > cut + 1e-6).min_by(|&i, &j| els[i].top.total_cmp(&els[j].top));
        let brk = first.and_then(|i| {
            if i < n_treads {
                let q = &els[i].poly;
                // Gerade Läufe: Ecken 0 links vorn, 1 links hinten, 2 rechts hinten, 3 rechts vorn;
                // Wendel: 0 innen / 1 aussen am Anfang, 3 innen / 2 aussen am Ende.
                let (front, back) = if spiral { (mid(q[0], q[1]), mid(q[3], q[2])) } else { (mid(q[0], q[3]), mid(q[1], q[2])) };
                let (a, b) = match (spiral, spiral_center) {
                    (true, Some(c)) => {
                        // radial auf der Winkelmitte des Tritts
                        let ang = |x: Vec2| jsnum::atan2(x.y - c.y, x.x - c.x);
                        let (t0, t1) = (ang(q[0]), ang(q[3]));
                        let mut dt = t1 - t0;
                        while dt > std::f64::consts::PI {
                            dt -= std::f64::consts::TAU;
                        }
                        while dt < -std::f64::consts::PI {
                            dt += std::f64::consts::TAU;
                        }
                        let tm = t0 + dt / 2.0;
                        let (ri, ro) = (len(sub(q[0], c)), len(sub(q[1], c)));
                        let at = |r: f64| Vec2::new(c.x + r * jsnum::cos(tm), c.y + r * jsnum::sin(tm));
                        (at(ri), at(ro))
                    }
                    _ => (mid(q[0], q[1]), mid(q[3], q[2])),
                };
                let d = sub(back, front);
                let l = len(d);
                (l > 1e-9).then(|| Break { el: i, a, b, up: mul(d, 1.0 / l), depth: l / 2.0 })
            } else {
                // Podest über der Schnitthöhe: Bruch parallel zum Austritt des Laufs davor, einen halben
                // Auftritt aufs Podest.
                let prev = (0..n_treads).filter(|&k| els[k].top <= els[i].top).max_by(|&x, &y| els[x].top.total_cmp(&els[y].top))?;
                let q = &els[prev].poly;
                let d = sub(mid(q[1], q[2]), mid(q[0], q[3]));
                let l = len(d);
                if !(l > 1e-9) {
                    return None;
                }
                let up = mul(d, 1.0 / l);
                let depth = geo.tread_depth.min(l) / 2.0;
                let off = mul(up, depth);
                Some(Break { el: i, a: add(q[1], off), b: add(q[2], off), up, depth })
            }
        });
        Layout { els, cut, brk }
    }

    /// Element, auf dessen Fläche oder Rand `m` liegt (sonst das nächste).
    fn element_at(&self, m: Vec2) -> Option<usize> {
        let mut best: Option<(usize, f64)> = None;
        for (i, e) in self.els.iter().enumerate() {
            let d = if kernel2d::point_in_polygon(m, &e.poly) { 0.0 } else { dist_poly(m, &e.poly) };
            if best.map_or(true, |(_, bd)| d < bd - 1e-12) {
                best = Some((i, d));
            }
        }
        best.map(|b| b.0)
    }

    /// Gestrichelt (über der Schnitthöhe) an der Stelle `m`.
    fn dashed_at(&self, m: Vec2) -> bool {
        let Some(i) = self.element_at(m) else { return false };
        match &self.brk {
            Some(b) if b.el == i => dot(sub(m, b.a), b.up) > 0.0,
            _ => self.els[i].top > self.cut + 1e-6,
        }
    }

    /// Strecke a–b an der Bruchlinie (und den Parametern `extra`) teilen, je Stück nach `dashed_at`
    /// einordnen; gleiche Nachbarn zusammengefasst.
    fn split(&self, a: Vec2, b: Vec2, extra: &[f64]) -> Vec<(Vec2, Vec2, bool)> {
        let mut ts = vec![0.0, 1.0];
        ts.extend_from_slice(extra);
        if let Some(br) = &self.brk {
            if let Some(t) = seg_hit(a, b, br.a, br.b) {
                ts.push(t);
            }
        }
        ts.sort_by(|x, y| x.total_cmp(y));
        ts.dedup_by(|x, y| (*x - *y).abs() < 1e-9);
        let mut out: Vec<(Vec2, Vec2, bool)> = Vec::new();
        for w in ts.windows(2) {
            let (p, q) = (lerp(a, b, w[0]), lerp(a, b, w[1]));
            if len(sub(q, p)) < EPS {
                continue;
            }
            let d = self.dashed_at(mid(p, q));
            match out.last_mut() {
                Some(last) if last.2 == d => last.1 = q,
                _ => out.push((p, q, d)),
            }
        }
        out
    }
}

/// Schon gezeichnete Kanten: neue Kanten nur, wo keine deckungsgleiche (auf derselben Geraden) liegt.
#[derive(Default)]
struct Drawn(Vec<(Vec2, Vec2)>);

impl Drawn {
    fn free(&self, a: Vec2, b: Vec2) -> Vec<(Vec2, Vec2)> {
        let d = sub(b, a);
        let l = len(d);
        if !(l > EPS) {
            return Vec::new();
        }
        let u = mul(d, 1.0 / l);
        let mut cover: Vec<(f64, f64)> = self
            .0
            .iter()
            .filter(|(c, e)| cross(u, sub(*c, a)).abs() < EPS && cross(u, sub(*e, a)).abs() < EPS)
            .map(|(c, e)| {
                let (t0, t1) = (dot(sub(*c, a), u) / l, dot(sub(*e, a), u) / l);
                (t0.min(t1), t0.max(t1))
            })
            .filter(|(t0, t1)| *t1 > 1e-9 && *t0 < 1.0 - 1e-9)
            .collect();
        cover.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut out = Vec::new();
        let mut t = 0.0;
        for (t0, t1) in cover {
            if t0 > t {
                out.push((t, t0.min(1.0)));
            }
            t = f64::max(t, t1);
        }
        if t < 1.0 {
            out.push((t, 1.0));
        }
        out.into_iter().filter(|(t0, t1)| (t1 - t0) * l > EPS).map(|(t0, t1)| (lerp(a, b, t0), lerp(a, b, t1))).collect()
    }
}

#[derive(Default)]
struct Out {
    items: Vec<Item>,
    drawn: Drawn,
}

impl Out {
    fn line(&mut self, cls: f64, a: Vec2, b: Vec2, w: f64, dashed: bool) {
        self.items.push(Item::Line { cls, a, b, w, dashed });
    }
    /// Kante nur, wo noch keine deckungsgleiche liegt (Umriss vor Trittkanten vor Podestkanten).
    fn edge(&mut self, cls: f64, a: Vec2, b: Vec2, w: f64, dashed: bool) {
        for (p, q) in self.drawn.free(a, b) {
            self.drawn.0.push((p, q));
            self.line(cls, p, q, w, dashed);
        }
    }
}

/// [155] Grundfläche der Treppe (Pick, Belags-Aussparung): Aussenlinie bzw. Wendel-Ringstück.
pub fn footprint(p: &StairParams) -> Vec<Vec<P>> {
    let outline = stair_outline(p);
    if let Some(poly) = outline.polygon.filter(|q| q.len() >= 3) {
        return vec![poly.iter().map(|q| p2(*q)).collect()];
    }
    let Some(s) = outline.spiral else { return Vec::new() };
    let ((c, r_in, a0, a1), (_, r_out, _, _)) = (s.arcs[0], s.arcs[1]);
    let n = (((a1 - a0).abs() / ARC_STEP).ceil() as usize).clamp(2, 720);
    let at = |r: f64, t: f64| [c.x + r * jsnum::cos(t), c.y + r * jsnum::sin(t)];
    let mut ring: Vec<P> = (0..=n).map(|k| at(r_out, a0 + (a1 - a0) * k as f64 / n as f64)).collect();
    ring.extend((0..=n).rev().map(|k| at(r_in, a0 + (a1 - a0) * k as f64 / n as f64)));
    if ring.iter().all(|q| q[0].is_finite() && q[1].is_finite()) {
        vec![ring]
    } else {
        Vec::new()
    }
}

#[allow(clippy::too_many_arguments)]
pub fn plan_stair(params: &[f64], total_rise: f64, cut_rise: f64, lw_mm: f64, filled_arrow: bool, column_r: f64, railing: u8, double: bool) -> Vec<f64> {
    plan_stair_clipped(params, total_rise, cut_rise, lw_mm, filled_arrow, column_r, railing, double, &[])
}

/// [173] Lauflinie: Versatz an Anfang und Ende (Meter, entlang der Linie) und Antrittspunkt (Halbmesser in
/// Metern; `None` = ohne). Vorgabe: die Linie läuft von der Antritts- bis zur Austrittskante.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RunOpts {
    pub start: f64,
    pub end: f64,
    pub start_mark: Option<f64>,
    /// [T3] Halbe Handlaufbreite (Meter) für die Doppellinie; 0 = Standard ([`crate::stair_rail::RAIL_THICK`] / 2).
    pub rail_half: f64,
    /// [G1] Untersicht: ohne Bruchlinie, alles über der Schnitthöhe gestrichelt (Schnitthöhe unter dem Treppenfuss).
    pub no_break: bool,
    /// [256] Meter je Papier-mm (Massstab/1000) für das Zickzack der Bruchlinie (2 mm breit, 1.5 mm hoch); 0 = feste
    /// Modellgrösse (≤ 8 × 6 cm), bei 1:100 kaum sichtbar.
    pub break_mm: f64,
}

/// [173] Schnittparameter des Strahls `a + t·d` mit der Geraden durch `c`–`e` (`None` = parallel).
fn ray_line(a: Vec2, d: Vec2, c: Vec2, e: Vec2) -> Option<f64> {
    let s = sub(e, c);
    let den = cross(d, s);
    if den.abs() < 1e-12 {
        return None;
    }
    Some(cross(sub(c, a), s) / den)
}

/// [173] Lauflinie von der Antrittskante (Vorderkante der ersten Stufe) bis zur Austrittskante (Hinterkante
/// der letzten): die Geometrie (`kernel2d::stair_geometry`) rückt sie um eine halbe Stufe bzw. 15 % der letzten
/// Stufe ein; hier auf die Kanten verlängert, dann um `run.start`/`run.end` gekürzt und der Pfeil neu gesetzt.
fn run_line_to_edges(geo: &mut StairGeometry, spiral: bool, run: &RunOpts) {
    let n = geo.run_line.len();
    if n < 2 || geo.treads.is_empty() {
        return;
    }
    let (first_rl, last_rl) = (geo.run_line[0], geo.run_line[n - 1]);
    let up = len(sub(geo.arrow.head.1, last_rl)) <= len(sub(geo.arrow.head.1, first_rl));
    let first = geo.treads.iter().filter(|t| t.pts.len() >= 4).min_by_key(|t| t.index);
    let last = geo.treads.iter().filter(|t| t.pts.len() >= 4).max_by_key(|t| t.index);
    let (Some(first), Some(last)) = (first, last) else { return };
    let front = |q: &[Vec2]| if spiral { (q[0], q[1]) } else { (q[3], q[0]) };
    let back = |q: &[Vec2]| if spiral { (q[3], q[2]) } else { (q[1], q[2]) };
    let extend = |p: Vec2, from: Vec2, edge: (Vec2, Vec2)| -> Vec2 {
        let d = sub(p, from);
        let l = len(d);
        if !(l > 1e-9) {
            return p;
        }
        let d = mul(d, 1.0 / l);
        match ray_line(p, d, edge.0, edge.1) {
            // Nur nach vorn und höchstens eine Stufe weit (sonst stimmt die Kante nicht).
            Some(t) if t.is_finite() && t >= -1e-9 && t < 1.0 => add(p, mul(d, t.max(0.0))),
            _ => p,
        }
    };
    let mut rl = geo.run_line.clone();
    rl[0] = extend(rl[0], rl[1], front(&first.pts));
    rl[n - 1] = extend(rl[n - 1], rl[n - 2], back(&last.pts));
    // Versatz: von beiden Enden entlang der Linie kürzen (nur wenn genug Länge bleibt).
    let total: f64 = rl.windows(2).map(|w| len(sub(w[1], w[0]))).sum();
    let (s0, s1) = (run.start.max(0.0), run.end.max(0.0));
    if s0 + s1 > 0.0 && s0 + s1 < total - 1e-3 {
        rl = trim_start(&rl, s0);
        rl.reverse();
        rl = trim_start(&rl, s1);
        rl.reverse();
    }
    let m = rl.len();
    let tip = if up { rl[m - 1] } else { rl[0] };
    let from = if up { rl[m - 2] } else { rl[1] };
    let d = sub(tip, from);
    let l = len(d);
    if l > 1e-9 {
        let dir = mul(d, 1.0 / l);
        let nn = Vec2::new(-dir.y, dir.x);
        let s = 0.22_f64;
        let back_pt = add(tip, mul(dir, -s));
        geo.arrow.head = (add(back_pt, mul(nn, s * 0.55)), tip, add(back_pt, mul(nn, -s * 0.55)));
        geo.arrow.shaft = (rl[0], rl[m - 1]);
    }
    geo.run_line = rl;
}

/// Linienzug ab der Länge `s` (vom Anfang her gekürzt).
fn trim_start(pts: &[Vec2], s: f64) -> Vec<Vec2> {
    let mut rest = s;
    for i in 0..pts.len() - 1 {
        let l = len(sub(pts[i + 1], pts[i]));
        if rest < l - 1e-12 {
            let mut out = vec![lerp(pts[i], pts[i + 1], rest / l)];
            out.extend_from_slice(&pts[i + 1..]);
            return out;
        }
        rest -= l;
    }
    pts[pts.len() - 2..].to_vec()
}


/// Wie [`plan_stair`]; `clip` nicht leer: nur die Teile innerhalb dieser Ringe (Treppe des unteren
/// Geschosses durch das Deckenloch gesehen, [155]), ohne Pick-Fläche und Säule.
#[allow(clippy::too_many_arguments)]
pub fn plan_stair_clipped(params: &[f64], total_rise: f64, cut_rise: f64, lw_mm: f64, filled_arrow: bool, column_r: f64, railing: u8, double: bool, clip: &[Vec<P>]) -> Vec<f64> {
    plan_stair_run(params, total_rise, cut_rise, lw_mm, filled_arrow, column_r, railing, double, clip, &RunOpts::default())
}

/// [`plan_stair_clipped`] mit Lauflinien-Optionen ([173] Modelldarstellung: Versatz, Antrittspunkt).
#[allow(clippy::too_many_arguments)]
pub fn plan_stair_run(params: &[f64], total_rise: f64, cut_rise: f64, lw_mm: f64, filled_arrow: bool, column_r: f64, railing: u8, double: bool, clip: &[Vec<P>], run: &RunOpts) -> Vec<f64> {
    let Some(p) = decode_params(params) else { return Vec::new() };
    if !(total_rise.is_finite() && cut_rise.is_finite() && lw_mm.is_finite()) {
        return Vec::new();
    }
    let mut geo = stair_geometry(&p, total_rise);
    let outline = stair_outline(&p);
    let spiral = p.shape == "spiral";
    let center = outline.spiral.as_ref().map(|s| s.arcs[0].0);
    let mut lay = Layout::new(&p, &geo, cut_rise, center);
    if run.no_break {
        lay.brk = None;
    }
    let (w_tread, w_outline) = (lw_mm * TREAD_FACTOR, lw_mm * OUTLINE_FACTOR);
    let mut o = Out::default();

    // Pick-Fläche (unsichtbar): Treppe auch zwischen den Linien anwählbar.
    if clip.is_empty() {
        for ring in footprint(&p) {
            o.items.push(Item::Polygon { pts: ring.into_iter().map(v).collect(), stroke_mm: 0.0, filled: false });
        }
    }

    // 1. Aussenlinie (Wange), an den Elementgrenzen und der Bruchlinie geteilt.
    if let Some(poly) = outline.polygon.as_ref().filter(|q| q.len() >= 3) {
        let corners: Vec<Vec2> = lay.els.iter().flat_map(|e| e.poly.iter().copied()).collect();
        for i in 0..poly.len() {
            let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
            let d = sub(b, a);
            let l2 = dot(d, d);
            if !(l2 > EPS * EPS) {
                continue;
            }
            let ts: Vec<f64> = corners.iter().filter(|q| dist_seg(**q, a, b) < EPS).map(|q| dot(sub(*q, a), d) / l2).filter(|t| *t > 1e-9 && *t < 1.0 - 1e-9).collect();
            for (p0, p1, dashed) in lay.split(a, b, &ts) {
                o.edge(CLS_OUTLINE, p0, p1, w_outline, dashed);
            }
        }
    }
    if let Some(s) = &outline.spiral {
        // Bögen am Winkel der Bruchlinie geteilt.
        let all_above = lay.els.iter().all(|e| e.top > cut_rise + 1e-6);
        let t_break = lay.brk.as_ref().zip(center).map(|(b, c)| jsnum::atan2(b.a.y - c.y, b.a.x - c.x));
        for (c, r, a0, a1) in s.arcs {
            let (lo, hi) = (a0.min(a1), a0.max(a1));
            let pieces = match t_break {
                Some(tb) => {
                    let mut t = tb;
                    while t < lo - 1e-12 {
                        t += std::f64::consts::TAU;
                    }
                    while t > hi + 1e-12 {
                        t -= std::f64::consts::TAU;
                    }
                    if t > lo && t < hi {
                        vec![(a0, t, false), (t, a1, true)]
                    } else {
                        vec![(a0, a1, all_above)]
                    }
                }
                None => vec![(a0, a1, all_above)],
            };
            for (t0, t1, dashed) in pieces {
                o.items.push(Item::Arc { w: w_outline, c, r, a0: t0, a1: t1, dashed });
            }
        }
        for (a, b) in s.lines {
            for (p0, p1, dashed) in lay.split(a, b, &[]) {
                o.edge(CLS_OUTLINE, p0, p1, w_outline, dashed);
            }
        }
    }

    // 2. Trittkanten (Vorderkante = Austritt des Tritts davor): ausgezogen bis zur Schnitthöhe.
    for t in geo.treads.iter().filter(|t| t.pts.len() >= 4) {
        let q = &t.pts;
        let (front, back) = if spiral { ((q[0], q[1]), (q[3], q[2])) } else { ((q[3], q[0]), (q[1], q[2])) };
        o.edge(CLS_TREAD, front.0, front.1, w_tread, t.base_rise > cut_rise + 1e-6);
        o.edge(CLS_TREAD, back.0, back.1, w_tread, t.top_rise > cut_rise + 1e-6);
    }
    // 3. Podestkanten, soweit nicht schon Umriss oder Trittkante.
    for e in lay.els.iter().skip(geo.treads.len()) {
        for i in 0..e.poly.len() {
            let (a, b) = (e.poly[i], e.poly[(i + 1) % e.poly.len()]);
            for (p0, p1, dashed) in lay.split(a, b, &[]) {
                o.edge(CLS_TREAD, p0, p1, w_tread, dashed);
            }
        }
    }

    // 4. Bruchlinie quer über den Lauf, Zickzack in der Mitte.
    if let Some(b) = &lay.brk {
        let d = sub(b.b, b.a);
        let w = len(d);
        if w > 1e-6 {
            let c = mul(d, 1.0 / w);
            let m = mid(b.a, b.b);
            let (z, h) = if run.break_mm > 0.0 && run.break_mm.is_finite() {
                ((2.0 * run.break_mm).min(w * 0.25), (1.5 * run.break_mm).min(b.depth * 1.6))
            } else {
                (0.08_f64.min(w * 0.15), 0.06_f64.min(b.depth * 0.8))
            };
            let pts = [b.a, sub(m, mul(c, z)), add(sub(m, mul(c, z / 3.0)), mul(b.up, h)), sub(add(m, mul(c, z / 3.0)), mul(b.up, h)), add(m, mul(c, z)), b.b];
            for k in 0..pts.len() - 1 {
                o.line(CLS_BREAK, pts[k], pts[k + 1], w_outline, false);
            }
        }
    }

    // 5. Lauflinie und Pfeil (Flügel als ein Zug über die Spitze: die Ecke schliesst spitz).
    // [173] Von der Antritts- bis zur Austrittskante, Versatz und Antrittspunkt nach der Modelldarstellung.
    run_line_to_edges(&mut geo, spiral, run);
    if let (Some(r), Some(a)) = (run.start_mark.filter(|r| *r > 0.0 && r.is_finite()), geo.run_line.first().copied()) {
        let pts: Vec<Vec2> = (0..16).map(|k| { let t = std::f64::consts::TAU * k as f64 / 16.0; Vec2::new(a.x + r * jsnum::cos(t), a.y + r * jsnum::sin(t)) }).collect();
        o.items.push(Item::Polygon { pts, stroke_mm: w_tread, filled: true });
    }
    // [155] Lauflinie wie die Tritte: vor der Bruchlinie ausgezogen, dahinter gestrichelt; der Pfeil bleibt ausgezogen.
    for w in geo.run_line.windows(2) {
        for (a, b, dashed) in lay.split(w[0], w[1], &[]) {
            o.line(CLS_RUN, a, b, w_tread, dashed);
        }
    }
    let (h1, tip, h2) = geo.arrow.head;
    if filled_arrow {
        o.items.push(Item::Polygon { pts: vec![h1, tip, h2], stroke_mm: w_tread, filled: true });
    } else {
        o.line(CLS_ARROW, h1, tip, w_tread, false);
        o.line(CLS_ARROW, tip, h2, w_tread, false);
    }

    // Mittelsäule (Spindel) der Wendel: reicht über die ganze Steighöhe, also geschnitten, sobald die
    // Schnittebene innerhalb der Treppe liegt.
    if let (true, Some(c)) = (clip.is_empty() && spiral && column_r.is_finite() && column_r > 0.0, center.or(p.center)) {
        let r = column_r.min(5.0);
        let pts: Vec<Vec2> = (0..COLUMN_SEGMENTS)
            .map(|k| {
                let a = std::f64::consts::TAU * k as f64 / COLUMN_SEGMENTS as f64;
                Vec2::new(c.x + r * jsnum::cos(a), c.y + r * jsnum::sin(a))
            })
            .collect();
        let cut = cut_rise > 0.0 && cut_rise < total_rise;
        o.items.push(Item::Polygon { pts, stroke_mm: lw_mm, filled: cut });
    }

    // [151] Handlauf: über der Bruchlinie gestrichelt (dieselbe Teilung wie Tritte und Wange).
    let r = if run.rail_half.is_finite() && run.rail_half > 0.0 { run.rail_half } else { crate::stair_rail::RAIL_THICK / 2.0 };
    for rail in crate::stair_rail::rails(&p, &geo, railing) {
        let path = crate::stair_rail::plan_path(&rail);
        let mut pieces: Vec<(Vec<P>, bool)> = Vec::new();
        for w in path.windows(2) {
            for (a, b, dashed) in lay.split(v(w[0]), v(w[1]), &[]) {
                match pieces.last_mut() {
                    Some((pts, d)) if *d == dashed && pts.last().is_some_and(|l| len(sub(v(*l), a)) < EPS) => pts.push(p2(b)),
                    _ => pieces.push((vec![p2(a), p2(b)], dashed)),
                }
            }
        }
        for (pts, dashed) in pieces {
            let lines: Vec<Vec<P>> = if double { vec![crate::stair_rail::offset_polyline(&pts, r), crate::stair_rail::offset_polyline(&pts, -r)] } else { vec![pts] };
            for l in lines {
                for w in l.windows(2) {
                    o.line(CLS_HANDRAIL, v(w[0]), v(w[1]), HANDRAIL_MM, dashed);
                }
            }
        }
    }

    let items = if clip.is_empty() { o.items } else { clip_items(o.items, clip) };
    encode(&items)
}

/// Linien und Bögen auf die Ringe `clip` beschnitten (Bögen als Sehnenzug); Flächen nur ganz innen.
fn clip_items(items: Vec<Item>, clip: &[Vec<P>]) -> Vec<Item> {
    let inside = |q: Vec2| clip.iter().any(|r| crate::surface_pattern::point_in(p2(q), r));
    let clip_line = |out: &mut Vec<Item>, cls: f64, a: Vec2, b: Vec2, w: f64, dashed: bool| {
        let mut segs = Vec::new();
        for r in clip {
            crate::surface_pattern::clip_to_poly(p2(a), p2(b), r, &mut segs);
        }
        for (p, q) in segs {
            out.push(Item::Line { cls, a: v(p), b: v(q), w, dashed });
        }
    };
    let mut out = Vec::new();
    for it in items {
        match it {
            Item::Line { cls, a, b, w, dashed } => clip_line(&mut out, cls, a, b, w, dashed),
            Item::Arc { w, c, r, a0, a1, dashed } => {
                let n = (((a1 - a0).abs() / ARC_STEP).ceil() as usize).clamp(1, 720);
                let at = |k: usize| {
                    let t = a0 + (a1 - a0) * k as f64 / n as f64;
                    Vec2::new(c.x + r * jsnum::cos(t), c.y + r * jsnum::sin(t))
                };
                for k in 0..n {
                    clip_line(&mut out, CLS_OUTLINE, at(k), at(k + 1), w, dashed);
                }
            }
            Item::Polygon { pts, stroke_mm, filled } => {
                if stroke_mm > 0.0 && pts.iter().all(|q| inside(*q)) {
                    out.push(Item::Polygon { pts, stroke_mm, filled });
                }
            }
        }
    }
    out
}

/// Kodierung s. Modulkopf.
fn encode(items: &[Item]) -> Vec<f64> {
    let mut buf = vec![items.len() as f64];
    for it in items {
        match it {
            Item::Polygon { pts, stroke_mm, filled } => {
                buf.extend([1.0, *stroke_mm, if *filled { 1.0 } else { 0.0 }, pts.len() as f64]);
                for q in pts {
                    buf.extend([q.x, q.y]);
                }
            }
            Item::Line { cls, a, b, w, dashed } => buf.extend([2.0, *cls, *w, if *dashed { 1.0 } else { 0.0 }, a.x, a.y, b.x, b.y]),
            Item::Arc { w, c, r, a0, a1, dashed } => {
                let from = Vec2::new(c.x + r * jsnum::cos(*a0), c.y + r * jsnum::sin(*a0));
                let to = Vec2::new(c.x + r * jsnum::cos(*a1), c.y + r * jsnum::sin(*a1));
                buf.extend([3.0, *w, if *dashed { 1.0 } else { 0.0 }, c.x, c.y, from.x, from.y, to.x, to.y, *r]);
            }
        }
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAN: f64 = f64::NAN;

    fn straight() -> Vec<f64> {
        vec![0.0, 0.0, 0.0, 1.0, 0.0, 3.0, NAN, NAN, NAN, NAN, NAN, NAN, 1.2, 16.0, NAN, 0.0]
    }

    /// Zählt Einträge je Tag und prüft, dass der Puffer genau aufgeht.
    fn tags(buf: &[f64]) -> Vec<f64> {
        let n = buf[0] as usize;
        let mut i = 1;
        let mut t = Vec::new();
        for _ in 0..n {
            t.push(buf[i]);
            i += match buf[i] as i64 {
                1 => 4 + 2 * buf[i + 3] as usize,
                2 => 8,
                3 => 10,
                _ => panic!("unbekannter Tag"),
            };
        }
        assert_eq!(i, buf.len());
        t
    }

    #[test]
    fn gerade_treppe_hat_tritte_lauflinie_pfeil_und_aussenlinie() {
        let b = plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 0, false);
        let t = tags(&b);
        // [155] nur die unsichtbare Pick-Fläche als Polygon, keine Tritt-Vielecke
        assert_eq!(t.iter().filter(|x| **x == 1.0).count(), 1);
        assert_eq!(&b[1..4], &[1.0, 0.0, 0.0]);
        let l = lines(&b);
        let n = |cls: f64| l.iter().filter(|x| x.0 == cls).count();
        // 15 Kanten zwischen 16 Tritten (Antritt und Austritt sind Umriss); Umriss: Antritt, Austritt,
        // zwei Wangen je ausgezogen + gestrichelt; Bruchlinie mit Zickzack (5 Striche); Lauflinie; 2 Pfeilflügel
        assert_eq!(n(CLS_TREAD), 15);
        assert_eq!(n(CLS_OUTLINE), 6);
        assert_eq!(n(CLS_BREAK), 5);
        // Schnitthöhe 1.0 m liegt in der Treppe: Lauflinie vor der Bruchlinie ausgezogen, dahinter gestrichelt
        assert_eq!((n(CLS_RUN), n(CLS_ARROW)), (2, 2));
    }

    /// Alle Linien (cls, gestrichelt, a, b, Stärke).
    fn lines_w(buf: &[f64]) -> Vec<(f64, bool, [f64; 2], [f64; 2], f64)> {
        let n = buf[0] as usize;
        let mut i = 1;
        let mut out = Vec::new();
        for _ in 0..n {
            match buf[i] as i64 {
                1 => i += 4 + 2 * buf[i + 3] as usize,
                2 => {
                    out.push((buf[i + 1], buf[i + 3] != 0.0, [buf[i + 4], buf[i + 5]], [buf[i + 6], buf[i + 7]], buf[i + 2]));
                    i += 8;
                }
                _ => i += 10,
            }
        }
        out
    }

    /// Bögen (gestrichelt, Radius).
    fn arcs(buf: &[f64]) -> Vec<(bool, f64)> {
        let n = buf[0] as usize;
        let mut i = 1;
        let mut out = Vec::new();
        for _ in 0..n {
            match buf[i] as i64 {
                1 => i += 4 + 2 * buf[i + 3] as usize,
                2 => i += 8,
                _ => {
                    out.push((buf[i + 2] != 0.0, buf[i + 9]));
                    i += 10;
                }
            }
        }
        out
    }

    /// Überlappungslänge zweier Strecken auf derselben Geraden (0 = nicht deckungsgleich).
    fn overlap(a: ([f64; 2], [f64; 2]), b: ([f64; 2], [f64; 2])) -> f64 {
        let d = [a.1[0] - a.0[0], a.1[1] - a.0[1]];
        let l = d[0].hypot(d[1]);
        if l < 1e-12 {
            return 0.0;
        }
        let u = [d[0] / l, d[1] / l];
        let off = |q: [f64; 2]| (q[0] - a.0[0]) * u[1] - (q[1] - a.0[1]) * u[0];
        if off(b.0).abs() > 1e-7 || off(b.1).abs() > 1e-7 {
            return 0.0;
        }
        let t = |q: [f64; 2]| (q[0] - a.0[0]) * u[0] + (q[1] - a.0[1]) * u[1];
        let (b0, b1) = (t(b.0).min(t(b.1)), t(b.0).max(t(b.1)));
        (b1.min(l) - b0.max(0.0)).max(0.0)
    }

    /// [155] Keine Linie liegt deckungsgleich auf einer anderen (auch nicht voll unter gestrichelt) — alle
    /// Formen, Schnitthöhen unter, in und über der Treppe, mit und ohne Handlauf.
    #[test]
    fn keine_deckungsgleichen_linien() {
        for (name, p) in forms() {
            for cut in [-0.5, 0.3, 1.0, 1.45, 1.6, 2.0, 2.5, 3.5] {
                for railing in [0, 3] {
                    let b = plan_stair(&p, 2.8, cut, 0.25, false, 0.0, railing, true);
                    let mut l = lines_w(&b);
                    // sichtbare Vieleck-Kanten zählen mit (früher lagen Tritt-Vielecke unter den Trittkanten)
                    let n = b[0] as usize;
                    let mut i = 1;
                    for _ in 0..n {
                        match b[i] as i64 {
                            1 => {
                                let k = b[i + 3] as usize;
                                let q: Vec<[f64; 2]> = (0..k).map(|j| [b[i + 4 + 2 * j], b[i + 5 + 2 * j]]).collect();
                                if b[i + 1] > 0.0 {
                                    for j in 0..k {
                                        l.push((-1.0, false, q[j], q[(j + 1) % k], b[i + 1]));
                                    }
                                }
                                i += 4 + 2 * k;
                            }
                            2 => i += 8,
                            _ => i += 10,
                        }
                    }
                    for i in 0..l.len() {
                        for j in i + 1..l.len() {
                            let ov = overlap((l[i].2, l[i].3), (l[j].2, l[j].3));
                            assert!(ov < 1e-6, "{name} Schnitt {cut}: {:?} deckt {:?} ({ov})", l[i], l[j]);
                        }
                    }
                }
            }
        }
    }

    /// [155] Vor der Bruchlinie ausgezogen, dahinter gestrichelt (Wange, Trittkanten, Handlauf); die
    /// Bruchlinie liegt in der Mitte des ersten Tritts über der Schnitthöhe, mit Zickzack.
    #[test]
    fn vor_der_bruchlinie_voll_dahinter_gestrichelt() {
        let x_break = 5.5 * 3.0 / 16.0;
        let b = plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 3, false);
        for (cls, dashed, a, e, _) in lines_w(&b) {
            if cls == CLS_ARROW || cls == CLS_BREAK {
                assert!(!dashed);
                continue;
            }
            let m = (a[0] + e[0]) / 2.0;
            assert_eq!(dashed, m > x_break, "cls {cls}: {a:?}–{e:?}");
        }
        let brk: Vec<_> = lines_w(&b).into_iter().filter(|l| l.0 == CLS_BREAK).collect();
        assert!((brk[0].2[0] - x_break).abs() < 1e-9 && (brk[4].3[0] - x_break).abs() < 1e-9);
        assert!(brk.iter().any(|l| (l.2[0] - x_break).abs() > 0.01), "Zickzack");
        // Schnitt über der Treppe: alles ausgezogen, keine Bruchlinie
        let all = lines_w(&plan_stair(&straight(), 2.8, 3.5, 0.25, false, 0.0, 3, false));
        assert!(all.iter().all(|l| !l.1) && all.iter().all(|l| l.0 != CLS_BREAK));
    }

    /// [256] Zickzack der Bruchlinie in Papiergrösse (`RunOpts::break_mm`): bei 1:100 gut 1 mm hoch, sonst liest sich die
    /// Bruchlinie quer über den Lauf wie eine weitere Trittkante; ohne Massstab wie bisher (≤ 6 cm).
    #[test]
    fn bruchlinie_zickzack_in_papiergroesse() {
        let x_break = 5.5 * 3.0 / 16.0;
        let height = |run: &RunOpts| {
            let b = plan_stair_run(&straight(), 2.8, 1.0, 0.25, false, 0.0, 3, false, &[], run);
            lines_w(&b).into_iter().filter(|l| l.0 == CLS_BREAK).flat_map(|l| [l.2[0], l.3[0]]).map(|x| (x - x_break).abs()).fold(0.0, f64::max)
        };
        assert!(height(&RunOpts::default()) <= 0.06 + 1e-9);
        let h = height(&RunOpts { break_mm: 0.1, ..Default::default() });
        assert!(h >= 0.1 - 1e-9, "1:100: Zickzack {h} m");
    }

    /// [155] Podest über der Schnitthöhe als erstes Element: Bruchlinie auf dem Podest, Lauf 1 ganz ausgezogen.
    #[test]
    fn bruch_auf_dem_podest() {
        let l = forms().into_iter().find(|f| f.0 == "L").unwrap().1;
        // L: 16 Steigungen à 0.175, Lauf 1 hat 10 (Podest = 11. Steigung, OK 1.925)
        let geo = stair_geometry(&decode_params(&l).unwrap(), 2.8);
        let gap = geo.treads.windows(2).position(|w| w[1].index != w[0].index + 1).unwrap();
        let run1_top = geo.treads[gap].top_rise;
        let cut = run1_top + 0.05;
        let b = plan_stair(&l, 2.8, cut, 0.25, false, 0.0, 0, false);
        let ls = lines_w(&b);
        let brk: Vec<_> = ls.iter().filter(|x| x.0 == CLS_BREAK).collect();
        assert_eq!(brk.len(), 5);
        let land = geo.landing.as_ref().unwrap();
        let inside = |q: [f64; 2]| kernel2d::point_in_polygon(Vec2::new(q[0], q[1]), land) || dist_poly(Vec2::new(q[0], q[1]), land) < 1e-9;
        assert!(brk.iter().all(|x| inside(x.2) && inside(x.3)), "Bruchlinie auf dem Podest");
        // alle Trittkanten von Lauf 1 ausgezogen
        let n1 = geo.treads.iter().filter(|t| t.top_rise <= cut).count();
        assert!(n1 > 0);
        for t in geo.treads.iter().filter(|t| t.top_rise <= cut) {
            let back = ([t.pts[1].x, t.pts[1].y], [t.pts[2].x, t.pts[2].y]);
            assert!(ls.iter().filter(|x| overlap((x.2, x.3), back) > 1e-6).all(|x| !x.1));
        }
    }

    /// [155] Linienhierarchie: Tritte/Lauflinie/Pfeil 0.1, Umriss und Bruchlinie 0.13 bei Kategorie 0.18.
    #[test]
    fn strichstaerken_tritte_fein_umriss_mittel() {
        for (name, p) in forms() {
            for (cls, _, _, _, w) in lines_w(&plan_stair(&p, 2.8, 1.0, 0.18, false, 0.0, 1, false)) {
                let want = match cls {
                    c if c == CLS_TREAD || c == CLS_RUN || c == CLS_ARROW || c == CLS_HANDRAIL => 0.1,
                    _ => 0.13,
                };
                assert!((w - want).abs() < 1e-12, "{name} cls {cls}: {w}");
            }
        }
    }

    /// [155] Pfeilflügel als ein Zug über die Spitze; die Lauflinie endet in der Spitze.
    #[test]
    fn pfeil_schliesst_an_der_spitze() {
        let l = lines_w(&plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 0, false));
        let a: Vec<_> = l.iter().filter(|x| x.0 == CLS_ARROW).collect();
        let run = l.iter().filter(|x| x.0 == CLS_RUN).last().unwrap();
        assert_eq!(a[0].3, a[1].2);
        assert_eq!(run.3, a[0].3);
    }

    /// [155] Wendel: Trittkanten radial (keine Sehnen auf dem Aussenbogen), Bögen an der Bruchlinie geteilt.
    #[test]
    fn wendel_radiale_trittkanten_und_geteilte_boegen() {
        let p = vec![2.0, 0.0, 0.0, 1.0, 0.0, 3.0, NAN, NAN, 0.0, 0.0, 1.5, 270.0, 1.0, 14.0, NAN, 0.0];
        let b = plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 0, false);
        let r = |q: [f64; 2]| q[0].hypot(q[1]);
        for (_, _, a, e, _) in lines_w(&b).into_iter().filter(|x| x.0 == CLS_TREAD) {
            assert!((r(a) - 1.0).abs() < 1e-9 && (r(e) - 2.0).abs() < 1e-9, "{a:?} {e:?}");
        }
        let ar = arcs(&b);
        assert_eq!(ar.len(), 4);
        for rad in [1.0, 2.0] {
            let at: Vec<bool> = ar.iter().filter(|x| (x.1 - rad).abs() < 1e-9).map(|x| x.0).collect();
            assert_eq!(at, vec![false, true]);
        }
    }

    /// [155] Treppe durch das Deckenloch: nur Teile im Loch, ohne Pick-Fläche.
    #[test]
    fn beschnitten_auf_das_loch() {
        let hole = vec![vec![[1.5, -1.0], [4.0, -1.0], [4.0, 1.0], [1.5, 1.0]]];
        let b = plan_stair_clipped(&straight(), 2.8, 3.8, 0.25, false, 0.0, 3, false, &hole);
        let t = tags(&b);
        assert!(t.iter().all(|x| *x == 2.0));
        let l = lines_w(&b);
        assert!(!l.is_empty() && l.iter().all(|x| x.2[0] >= 1.5 - 1e-9 && x.3[0] >= 1.5 - 1e-9 && !x.1));
    }

    #[test]
    fn gefuellter_pfeil_ist_ein_dreieck() {
        let offen = tags(&plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 0, false));
        let voll = tags(&plan_stair(&straight(), 2.8, 1.0, 0.25, true, 0.0, 0, false));
        assert_eq!(voll.len() + 1, offen.len());
    }

    #[test]
    fn wendel_liefert_boegen() {
        let p = vec![2.0, 0.0, 0.0, 1.0, 0.0, 3.0, NAN, NAN, 0.0, 0.0, 1.5, 270.0, 1.0, 14.0, NAN, 0.0];
        let t = tags(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 0, false));
        assert_eq!(t.iter().filter(|x| **x == 3.0).count(), 4, "Innen- und Aussenbogen je vor und hinter der Bruchlinie");
    }

    /// Letztes Polygon im Puffer: (gefüllt, Punkte).
    fn last_polygon(buf: &[f64]) -> Option<(bool, Vec<[f64; 2]>)> {
        let n = buf[0] as usize;
        let mut i = 1;
        let mut last = None;
        for _ in 0..n {
            match buf[i] as i64 {
                1 => {
                    let k = buf[i + 3] as usize;
                    last = Some((buf[i + 2] != 0.0, (0..k).map(|j| [buf[i + 4 + 2 * j], buf[i + 5 + 2 * j]]).collect()));
                    i += 4 + 2 * k;
                }
                2 => i += 8,
                _ => i += 10,
            }
        }
        last
    }

    #[test]
    fn wendel_saeule_geschnitten_gefuellt_sonst_umriss() {
        let p = vec![2.0, 0.0, 0.0, 1.0, 0.0, 3.0, NAN, NAN, 0.0, 0.0, 1.5, 270.0, 1.0, 14.0, NAN, 0.0];
        let ohne = tags(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 0, false));
        let mit = plan_stair(&p, 2.8, 1.0, 0.25, false, 0.15, 0, false);
        assert_eq!(tags(&mit).len(), ohne.len() + 1);
        let (filled, pts) = last_polygon(&mit).unwrap();
        assert!(filled, "Schnitthöhe in der Treppe: Säule geschnitten (Poché)");
        assert_eq!(pts.len(), COLUMN_SEGMENTS);
        assert!(pts.iter().all(|q| (q[0].hypot(q[1]) - 0.15).abs() < 1e-12), "Kreis um das Zentrum");
        // Schnittebene über der Treppe: nur Umriss.
        let (filled, _) = last_polygon(&plan_stair(&p, 2.8, 3.5, 0.25, false, 0.15, 0, false)).unwrap();
        assert!(!filled);
        // Gerade Treppe: keine Säule.
        assert_eq!(tags(&plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.15, 0, false)).len(), tags(&plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 0, false)).len());
        // Unsinn-Radius: keine Säule, kein Panic.
        assert_eq!(tags(&plan_stair(&p, 2.8, 1.0, 0.25, false, NAN, 0, false)).len(), ohne.len());
    }

    /// Linien je Klasse: (cls, gestrichelt, a, b).
    fn lines(buf: &[f64]) -> Vec<(f64, bool, [f64; 2], [f64; 2])> {
        let n = buf[0] as usize;
        let mut i = 1;
        let mut out = Vec::new();
        for _ in 0..n {
            match buf[i] as i64 {
                1 => i += 4 + 2 * buf[i + 3] as usize,
                2 => {
                    out.push((buf[i + 1], buf[i + 3] != 0.0, [buf[i + 4], buf[i + 5]], [buf[i + 6], buf[i + 7]]));
                    i += 8;
                }
                _ => i += 10,
            }
        }
        out
    }

    fn handrail(buf: &[f64]) -> Vec<(bool, [f64; 2], [f64; 2])> {
        lines(buf).into_iter().filter(|l| l.0 == CLS_HANDRAIL).map(|l| (l.1, l.2, l.3)).collect()
    }

    /// [151] Formen mit Geländer: gerade, L, U, U mit Mittellauf, gerade mit Podest, Wendel (21er-Puffer).
    /// [173] Lauflinie von der Antritts- bis zur Austrittskante in allen Formen; Versatz kürzt sie entlang der
    /// Linie, der Pfeil sitzt am neuen Ende; Antrittspunkt als gefüllter Kreis.
    #[test]
    fn lauflinie_von_kante_zu_kante_mit_versatz() {
        for (name, p) in forms() {
            let sp = decode_params(&p).unwrap();
            let spiral = sp.shape == "spiral";
            let raw = stair_geometry(&sp, 2.8);
            let mut g = stair_geometry(&sp, 2.8);
            run_line_to_edges(&mut g, spiral, &RunOpts::default());
            let first = g.treads.iter().min_by_key(|t| t.index).unwrap();
            let last = g.treads.iter().max_by_key(|t| t.index).unwrap();
            let (fe, be) = if spiral { ((first.pts[0], first.pts[1]), (last.pts[3], last.pts[2])) } else { ((first.pts[3], first.pts[0]), (last.pts[1], last.pts[2])) };
            let n = g.run_line.len();
            assert!(dist_seg(g.run_line[0], fe.0, fe.1) < 1e-6, "{name}: Anfang auf der Antrittskante");
            assert!(dist_seg(g.run_line[n - 1], be.0, be.1) < 1e-6, "{name}: Ende auf der Austrittskante");
            let l = |rl: &[Vec2]| rl.windows(2).map(|w| len(sub(w[1], w[0]))).sum::<f64>();
            assert!(l(&g.run_line) >= l(&raw.run_line) - 1e-9, "{name}: nicht kürzer als vorher");
            assert!(len(sub(g.arrow.head.1, g.run_line[n - 1])) < 1e-9, "{name}: Pfeil am Ende");
            let mut h = stair_geometry(&sp, 2.8);
            run_line_to_edges(&mut h, spiral, &RunOpts { start: 0.1, end: 0.2, start_mark: None, rail_half: 0.0, no_break: false, break_mm: 0.0 });
            assert!((l(&g.run_line) - l(&h.run_line) - 0.3).abs() < 1e-6, "{name}: Versatz 0.1 + 0.2");
            assert!(len(sub(h.arrow.head.1, h.run_line[h.run_line.len() - 1])) < 1e-9);
        }
        let with = plan_stair_run(&straight(), 2.8, 1.0, 0.25, false, 0.0, 0, false, &[], &RunOpts { start_mark: Some(0.04), ..Default::default() });
        let without = plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 0, false);
        assert_eq!(tags(&with).iter().filter(|x| **x == 1.0).count(), tags(&without).iter().filter(|x| **x == 1.0).count() + 1, "Antrittspunkt");
    }

    fn forms() -> Vec<(&'static str, Vec<f64>)> {
        let mut v = vec![("gerade", straight())];
        let l = vec![1.0, 0.0, 0.0, 1.0, 0.0, 2.0, 1.5, 1.0, NAN, NAN, NAN, NAN, 1.0, 16.0, NAN, 0.0];
        v.push(("L", l));
        let u = vec![3.0, 0.0, 0.0, 1.0, 0.0, 2.5, 2.5, 1.0, NAN, NAN, NAN, NAN, 1.0, 17.0, NAN, 0.0, 0.2, NAN, NAN, NAN, NAN];
        let mut um = u.clone();
        um[19] = 2.0;
        v.push(("U", u));
        v.push(("U Mittellauf", um));
        v.push(("gerade mit Podest", vec![4.0, 0.0, 0.0, 1.0, 0.0, 2.0, 2.0, NAN, NAN, NAN, NAN, NAN, 1.0, 16.0, NAN, 0.0, NAN, 1.2, 8.0, NAN, NAN]));
        v.push(("Wendel", vec![2.0, 0.0, 0.0, 1.0, 0.0, 3.0, NAN, NAN, 0.0, 0.0, 1.5, 270.0, 1.0, 14.0, NAN, 0.0]));
        v
    }

    #[test]
    fn handlauf_je_form_unten_ausgezogen_oben_gestrichelt() {
        for (name, p) in forms() {
            assert!(handrail(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 0, false)).is_empty(), "{name}: ohne Geländer");
            let one = handrail(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 1, false));
            let both = handrail(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 3, false));
            assert!(!one.is_empty() && both.len() > one.len(), "{name}");
            // Schnitt bei 1 m: unten ausgezogen, darüber gestrichelt
            assert!(one.iter().any(|l| !l.0) && one.iter().any(|l| l.0), "{name}: {one:?}");
            // Schnitt über der Treppe: alles ausgezogen
            assert!(handrail(&plan_stair(&p, 2.8, 3.5, 0.25, false, 0.0, 3, false)).iter().all(|l| !l.0), "{name}");
            // fein (1:50): Doppellinie im Abstand des Rohrdurchmessers
            let fine = handrail(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 1, true));
            assert_eq!(fine.len(), 2 * one.len(), "{name}");
        }
        // Tusche: dünn (0.1 mm)
        let b = plan_stair(&forms()[0].1, 2.8, 1.0, 0.25, false, 0.0, 1, false);
        let n = b[0] as usize;
        let mut i = 1;
        for _ in 0..n {
            match b[i] as i64 {
                1 => i += 4 + 2 * b[i + 3] as usize,
                2 => {
                    if b[i + 1] == CLS_HANDRAIL {
                        assert_eq!(b[i + 2], HANDRAIL_MM);
                    }
                    i += 8;
                }
                _ => i += 10,
            }
        }
    }

    #[test]
    fn handlauf_gerade_lage_und_bruch() {
        // gerade Treppe 3 m nach +x, 1 m breit, 16 Steigungen à 0.175: Bruch-Tritt = erster über 1 m
        // (Index 5, Oberkante 1.05), Mitte bei x = 5.5 · 3/16
        let one = handrail(&plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 1, false));
        assert_eq!(one.len(), 2);
        let y = 0.6 - crate::stair_rail::RAIL_INSET;
        assert!(one.iter().all(|l| (l.1[1] - y).abs() < 1e-9 && (l.2[1] - y).abs() < 1e-9));
        let x_break = 5.5 * 3.0 / 16.0;
        assert!(!one[0].0 && (one[0].2[0] - x_break).abs() < 1e-9 && one[1].0);
        // Doppellinie ± Rohrradius
        let fine = handrail(&plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 1, true));
        let ys: Vec<f64> = fine.iter().map(|l| l.1[1]).collect();
        let r = crate::stair_rail::RAIL_THICK / 2.0;
        assert!(ys.iter().any(|v| (v - y - r).abs() < 1e-9) && ys.iter().any(|v| (v - y + r).abs() < 1e-9));
    }

    #[test]
    fn unsinn_ergibt_leeres_ergebnis() {
        assert!(plan_stair(&[1.0, 2.0], 2.8, 1.0, 0.25, false, 0.1, 0, false).is_empty());
        assert!(plan_stair(&straight(), NAN, 1.0, 0.25, false, 0.0, 0, false).is_empty());
        let mut kaputt = straight();
        kaputt[1] = NAN;
        assert!(plan_stair(&kaputt, 2.8, 1.0, 0.25, false, 0.0, 0, false).is_empty());
    }
}
