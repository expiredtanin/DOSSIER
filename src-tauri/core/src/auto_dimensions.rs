//! Automatische Aussenbemassung ([81]); aus `geometry/autoDimensions.ts`. Je Gebäudeseite (Süd,
//! Ost, Nord, West) bis zu drei Massketten ausserhalb des Grundrisses, von innen nach aussen:
//!   1. Öffnungen — Gebäudeecken der Seite plus Leibungen der Fenster/Türen in Wänden dieser Seite,
//!   2. Vor-/Rücksprünge — die Ecken der nach dieser Seite schauenden Aussenkanten (nur bei Stufung),
//!   3. Gesamtmass.
//! Grundlage ist die vereinigte Grundfläche der Wände des Geschosses (an verbundenen Enden um die
//! halbe Dicke verlängert, schiefe Eckstösse auf Gehrung). Achsparallele Kanten gehören zu den vier Seiten;
//! schiefe Fassaden bekommen eigene Ketten (`oblique_chains`). Bogenwände ([T2]) gehen mit ihrem Kreisring in die Grundfläche
//! ein; liegt ihre gewölbte Seite aussen, bekommen sie eine eigene Bogenmass-Kette (Ecken und
//! Leibungen auf dieser Fläche, gemessen entlang des Bogens). TS liefert Wände (Achse + Dicke) und Öffnungs-Leibungen,
//! baut aus den Ketten die Bemassungs-Objekte.

use crate::flat::{Polygon, Ring};
use crate::flat_read::signed_area;
use crate::polygon_bool;

pub type Vec2 = [f64; 2];

/// Wand des Geschosses: Achse und Dicke.
#[derive(Clone, Copy, Debug)]
pub struct WallIn {
    pub start: Vec2,
    pub end: Vec2,
    pub thickness: f64,
    /// Versatz der Wandmitte von der Achse (links der Laufrichtung positiv): Wände mit Referenzlinie
    /// links/rechts oder -versatz liegen nicht mittig auf ihrer Achse.
    pub shift: f64,
    /// Modell-Bulge der Achse (0 = gerade, [T2]).
    pub bulge: f64,
}

impl WallIn {
    pub fn arc(&self) -> Option<crate::wall_arc::WallArc> {
        crate::wall_arc::WallArc::of(kernel2d::Vec2::new(self.start[0], self.start[1]), kernel2d::Vec2::new(self.end[0], self.end[1]), Some(self.bulge))
    }
}

/// Öffnung: Index der Wirtswand in der Wandliste, Leibungspunkte auf der Achse (Bogenwand: auf dem
/// Achsbogen).
#[derive(Clone, Copy, Debug)]
pub struct OpeningIn {
    pub wall: usize,
    pub jamb_start: Vec2,
    pub jamb_end: Vec2,
}

/// Seiten in fester Reihenfolge (Index = Seite): Süd, Ost, Nord, West — Aussennormalen.
pub const SIDES: [Vec2; 4] = [[0.0, -1.0], [1.0, 0.0], [0.0, 1.0], [-1.0, 0.0]];

/// Ketten (Index = Kette): Öffnungen, Vor-/Rücksprünge, Gesamt.
pub const CHAIN_OPENINGS: usize = 0;
pub const CHAIN_STEPS: usize = 1;
pub const CHAIN_TOTAL: usize = 2;
/// Abstand der Ketten von der äussersten Kante in Papier-mm (1:100 → 1.0 / 1.7 / 2.4 m).
const CHAIN_MM: [f64; 3] = [10.0, 17.0, 24.0];

/// Eine Masskette.
#[derive(Clone, Debug, PartialEq)]
pub struct DimChain {
    pub side: usize,
    pub chain: usize,
    pub pts: Vec<Vec2>,
    /// Abstand der Masslinie (Modell-Meter, positiv = aussen).
    pub offset: f64,
    /// Je Punkt das Merkmal, aus dem er stammt (Grundriss-Ecke bzw. Leibung auf der Aussenfläche;
    /// das äusserste bei gleicher Lage) — für die assoziative Bemassung ([38]).
    pub src: Vec<Vec2>,
    /// [T2] Bogenmass-Kette einer Bogenwand: (Bogenmitte, Wand-Index); `side` ist dann ohne Bedeutung.
    pub arc: Option<(Vec2, usize)>,
}

const EPS: f64 = 1e-6;
fn dot(a: Vec2, b: Vec2) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn finite2(p: Vec2) -> bool {
    p[0].is_finite() && p[1].is_finite()
}

fn wall_rect(w: &WallIn, t: f64, ext_start: f64, ext_end: f64) -> Ring {
    let (dx, dy) = (w.end[0] - w.start[0], w.end[1] - w.start[1]);
    let len = dx.hypot(dy);
    let (ux, uy) = (dx / len, dy / len);
    let (nx, ny) = (-uy * (t / 2.0), ux * (t / 2.0));
    let sh = if w.shift.is_finite() { w.shift } else { 0.0 };
    let a = [w.start[0] - ux * ext_start - uy * sh, w.start[1] - uy * ext_start + ux * sh];
    let b = [w.end[0] + ux * ext_end - uy * sh, w.end[1] + uy * ext_end + ux * sh];
    vec![[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]
}

/// Liegt `p` auf einer anderen Wandachse (Ende oder dazwischen)? Dann ist das Wandende verbunden.
fn connected(p: Vec2, self_idx: usize, walls: &[WallIn]) -> bool {
    for (i, o) in walls.iter().enumerate() {
        if i == self_idx {
            continue;
        }
        let (dx, dy) = (o.end[0] - o.start[0], o.end[1] - o.start[1]);
        let l2 = dx * dx + dy * dy;
        if !(l2 >= EPS) {
            continue;
        }
        let t = (((p[0] - o.start[0]) * dx + (p[1] - o.start[1]) * dy) / l2).clamp(0.0, 1.0);
        if (o.start[0] + t * dx - p[0]).hypot(o.start[1] + t * dy - p[1]) < 1e-3 {
            return true;
        }
    }
    false
}

fn thick(w: &WallIn) -> f64 {
    if w.thickness.is_finite() && w.thickness > 0.0 {
        w.thickness
    } else {
        0.3
    }
}

/// Seitenflächen einer geraden Wand: (Punkt links, Punkt rechts, Richtung).
fn face_lines(w: &WallIn) -> Option<(Vec2, Vec2, Vec2)> {
    let (dx, dy) = (w.end[0] - w.start[0], w.end[1] - w.start[1]);
    let len = dx.hypot(dy);
    if !(len >= EPS) || w.arc().is_some() {
        return None;
    }
    let u = [dx / len, dy / len];
    let sh = if w.shift.is_finite() { w.shift } else { 0.0 };
    let h = thick(w) / 2.0;
    let at = |k: f64| [w.start[0] - u[1] * k, w.start[1] + u[0] * k];
    Some((at(sh + h), at(sh - h), u))
}

fn line_x(p: Vec2, u: Vec2, q: Vec2, v: Vec2) -> Option<Vec2> {
    let den = u[0] * v[1] - u[1] * v[0];
    if den.abs() < 1e-9 {
        return None;
    }
    let k = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / den;
    Some([p[0] + u[0] * k, p[1] + u[1] * k])
}

/// [81] Gehrung am Ende (`at_end`) der Wand `i`, wenn dort genau eine andere gerade Wand mit ihrem Ende
/// schief (weder rechtwinklig noch gleichlaufend) anschliesst: (Ecke links, Ecke rechts) als Schnitt der
/// gleichseitigen Wandflächen. Rechtwinklige Stösse bleiben bei der t/2-Verlängerung (unverändert).
fn mitre_end(walls: &[WallIn], i: usize, at_end: bool) -> Option<(Vec2, Vec2)> {
    let w = &walls[i];
    let p = if at_end { w.end } else { w.start };
    let near = |q: Vec2| (q[0] - p[0]).hypot(q[1] - p[1]) < 1e-3;
    let mut hits = walls.iter().enumerate().filter(|(j, o)| *j != i && (near(o.start) || near(o.end)));
    let (_, o) = hits.next()?;
    if hits.next().is_some() {
        return None;
    }
    let (wl, wr, wu) = face_lines(w)?;
    let (ol, or, ou) = face_lines(o)?;
    if dot(wu, ou).abs() <= 1e-6 {
        return None;
    }
    // Laufen beide in derselben Richtung durch den Stoss weiter, liegen links und links aneinander.
    let cont = if at_end { near(o.start) } else { near(o.end) };
    let (l, r) = if cont { (line_x(wl, wu, ol, ou)?, line_x(wr, wu, or, ou)?) } else { (line_x(wl, wu, or, ou)?, line_x(wr, wu, ol, ou)?) };
    let reach = 4.0 * thick(w).max(thick(o));
    if !finite2(l) || !finite2(r) || (l[0] - p[0]).hypot(l[1] - p[1]) > reach || (r[0] - p[0]).hypot(r[1] - p[1]) > reach {
        return None;
    }
    Some((l, r))
}

/// Aussenringe der vereinigten Wand-Grundfläche (gegen den Uhrzeigersinn).
fn outer_rings(walls: &[WallIn]) -> Vec<Ring> {
    let mut parts: Vec<Polygon> = vec![];
    for (i, w) in walls.iter().enumerate() {
        if !finite2(w.start) || !finite2(w.end) || !((w.end[0] - w.start[0]).hypot(w.end[1] - w.start[1]) >= EPS) {
            continue;
        }
        let t = if w.thickness.is_finite() && w.thickness > 0.0 { w.thickness } else { 0.3 };
        let es = if connected(w.start, i, walls) { t / 2.0 } else { 0.0 };
        let ee = if connected(w.end, i, walls) { t / 2.0 } else { 0.0 };
        // Bogenwand: Kreisring-Sektor (Enden um die halbe Dicke entlang des Bogens verlängert).
        if let Some(a) = w.arc() {
            let st = a.stations(-es, a.length() + ee, a.r_max(-t / 2.0, t / 2.0));
            let mut ring: Ring = st.iter().map(|&s| a.point(s, t / 2.0)).map(|q| [q.x, q.y]).collect();
            ring.extend(st.iter().rev().map(|&s| a.point(s, -t / 2.0)).map(|q| [q.x, q.y]));
            parts.push(vec![ring]);
            continue;
        }
        // [81] Schiefer Eckstoss: Ende auf die Gehrung schneiden (sonst stünde die t/2-Verlängerung als Spitze vor).
        let (ms, me) = (if es > 0.0 { mitre_end(walls, i, false) } else { None }, if ee > 0.0 { mitre_end(walls, i, true) } else { None });
        if ms.is_some() || me.is_some() {
            let r = wall_rect(w, t, es, ee);
            let (sl, sr) = ms.unwrap_or((r[0], r[3]));
            let (el, er) = me.unwrap_or((r[1], r[2]));
            parts.push(vec![vec![sl, el, er, sr]]);
            continue;
        }
        parts.push(vec![wall_rect(w, t, es, ee)]);
    }
    if parts.is_empty() {
        return vec![];
    }
    polygon_bool::union(&parts)
        .into_iter()
        .filter_map(|p| p.into_iter().next())
        .map(|mut r| {
            if signed_area(&r) < 0.0 {
                r.reverse();
            }
            r
        })
        .collect()
}

/// Werte zusammenfassen, die näher als 1 mm beieinander liegen (sortiert).
fn unique_sorted(vals: &[f64]) -> Vec<f64> {
    let mut s: Vec<f64> = vals.iter().copied().filter(|v| v.is_finite()).collect();
    s.sort_by(f64::total_cmp);
    let mut out: Vec<f64> = vec![];
    for v in s {
        if out.last().map_or(true, |l| v - l > 1e-3) {
            out.push(v);
        }
    }
    out
}

/// Kleinste Messstrecke auf dem Papier (mm): kürzere Teilstrecken (Bogen-Facetten, Mauerversprünge) würden
/// sich als Kleinmasse drängen und werden mit dem Nachbarpunkt zusammengefasst.
const MIN_SEGMENT_MM: f64 = 1.5;

/// Punkte (sortiert) ausdünnen: Abstände unter `min` entfallen; Anfang und Ende der Kette bleiben.
fn thin(ts: Vec<f64>, min: f64) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::with_capacity(ts.len());
    for (i, &t) in ts.iter().enumerate() {
        let last = i + 1 == ts.len();
        match out.last() {
            Some(&l) if t - l < min => {
                if last && out.len() > 1 {
                    out.pop();
                    out.push(t);
                } else if last {
                    out.push(t);
                }
            }
            _ => out.push(t),
        }
    }
    out
}

/// Massketten eines Geschosses. `scale_denominator` bestimmt den Abstand der Ketten
/// (Papier-mm → Modell-Meter).
pub fn auto_exterior_dimensions(walls: &[WallIn], openings: &[OpeningIn], scale_denominator: f64) -> Vec<DimChain> {
    let rings = outer_rings(walls);
    if rings.is_empty() {
        return vec![];
    }
    let scale = if scale_denominator.is_finite() && scale_denominator > 0.0 { scale_denominator } else { 100.0 };
    let mut out = vec![];
    for (side, &n) in SIDES.iter().enumerate() {
        // Laufrichtung so, dass die linke Normale = Aussennormale ist (positiver Abstand = aussen).
        let u = [n[1], -n[0]];
        let (mut s_max, mut t_min, mut t_max) = (f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        let mut corners = vec![];
        // Merkmale (Lage entlang u, Punkt, Tiefe entlang n) für `src`.
        let mut feats: Vec<(f64, Vec2, f64)> = vec![];
        // Kanten, die nach `n` schauen: Aussennormale (rechte Normale eines CCW-Rings) ≈ n.
        let mut faces: Vec<(f64, f64, f64)> = vec![];
        for ring in &rings {
            for &p in ring {
                feats.push((dot(p, u), p, dot(p, n)));
                s_max = s_max.max(dot(p, n));
                t_min = t_min.min(dot(p, u));
                t_max = t_max.max(dot(p, u));
            }
            for i in 0..ring.len() {
                let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
                let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                let len = dx.hypot(dy);
                if len < EPS {
                    continue;
                }
                if dot([dy / len, -dx / len], n) < 1.0 - 1e-6 {
                    continue; // nur achsparallele, nach n schauende Kanten
                }
                let (ta, tb) = (dot(a, u), dot(b, u));
                faces.push((dot(a, n), ta.min(tb), ta.max(tb)));
                corners.push(ta);
                corners.push(tb);
            }
        }
        if faces.is_empty() {
            continue;
        }

        // Öffnungen in Wänden, deren Aussenseite auf einer dieser Kanten liegt.
        let mut jambs = vec![];
        for o in openings {
            let Some(outer_s) = walls.get(o.wall).and_then(|w| outer_face_s(w, n)) else { continue };
            let (ja, jb) = (dot(o.jamb_start, u), dot(o.jamb_end, u));
            if !ja.is_finite() || !jb.is_finite() {
                continue;
            }
            let on_face = faces
                .iter()
                .any(|&(s, t0, t1)| (s - outer_s).abs() < 1e-3 && ja.min(jb) >= t0 - 1e-3 && ja.max(jb) <= t1 + 1e-3);
            if on_face {
                jambs.push(ja);
                jambs.push(jb);
                for j in [o.jamb_start, o.jamb_end] {
                    let k = outer_s - dot(j, n);
                    feats.push((dot(j, u), [j[0] + n[0] * k, j[1] + n[1] * k], outer_s + 1.0));
                }
            }
        }

        emit_chains(&mut out, side, n, s_max, (t_min, t_max), &corners, jambs, &feats, scale);
    }
    out.extend(arc_chains(walls, openings, &rings, scale));
    out.extend(oblique_chains(walls, openings, &rings, scale));
    out
}

/// Ketten einer Seite (Aussennormale `n`, Masslinie bei `s_line` entlang `n`): Öffnungen (Ecken +
/// Leibungen), Vor-/Rücksprünge (nur bei mehr als zwei Ecken), Gesamt `t_range`.
#[allow(clippy::too_many_arguments)]
fn emit_chains(out: &mut Vec<DimChain>, side: usize, n: Vec2, s_line: f64, t_range: (f64, f64), corners: &[f64], jambs: Vec<f64>, feats: &[(f64, Vec2, f64)], scale: f64) {
    let u = [n[1], -n[0]];
    let min_gap = MIN_SEGMENT_MM / 1000.0 * scale;
    let steps = thin(unique_sorted(corners), min_gap);
    let mut chains: Vec<(usize, Vec<f64>)> = vec![];
    if !jambs.is_empty() {
        let mut all = steps.clone();
        all.extend(jambs);
        chains.push((CHAIN_OPENINGS, thin(unique_sorted(&all), min_gap)));
    }
    if steps.len() > 2 {
        chains.push((CHAIN_STEPS, steps));
    }
    chains.push((CHAIN_TOTAL, vec![t_range.0, t_range.1]));

    for (chain, ts) in chains {
        if ts.len() < 2 {
            continue;
        }
        let pts: Vec<Vec2> = ts.iter().map(|&t| [u[0] * t + n[0] * s_line, u[1] * t + n[1] * s_line]).collect();
        // Leibungen vor Ecken (Tiefe + 1), sonst die äusserste Ecke gleicher Lage.
        let src = ts
            .iter()
            .zip(&pts)
            .map(|(&t, &p)| feats.iter().filter(|f| (f.0 - t).abs() <= 1e-3).max_by(|a, b| a.2.total_cmp(&b.2)).map_or(p, |f| f.1))
            .collect();
        out.push(DimChain { side, chain, pts, offset: CHAIN_MM[chain] / 1000.0 * scale, src, arc: None });
    }
}

/// Gerade Wand parallel zur Fläche mit Normale `n`: Lage ihrer nach `n` schauenden Fläche entlang `n`.
fn outer_face_s(w: &WallIn, n: Vec2) -> Option<f64> {
    if w.arc().is_some() {
        return None;
    }
    let (dx, dy) = (w.end[0] - w.start[0], w.end[1] - w.start[1]);
    let len = dx.hypot(dy);
    if !(len >= EPS) || dot([dx / len, dy / len], n).abs() > 1e-6 {
        return None; // Wand quer zu n
    }
    let left = [-dy / len, dx / len];
    Some(dot(w.start, n) + (if w.shift.is_finite() { w.shift } else { 0.0 }) * dot(left, n) + thick(w) / 2.0)
}

/// [81] Ketten schiefer Fassaden: Umriss-Kanten, die keiner Hauptseite angehören, nach Richtung der
/// Aussennormale gruppiert (kollineare und parallele Teilstücke in eine Gruppe). Je Gruppe die üblichen
/// drei Ketten parallel zur Fassade; die Masslinie liegt vor der äussersten Fläche der Gruppe (nicht vor
/// dem ganzen Gebäude: eine schiefe Fläche in einer Einbuchtung bleibt bei sich). `side` = 4 + Gruppe.
/// Kanten kürzer als die dickste Wand (Stirnseiten, Gehrungsreste) fallen weg. Bogenwände: Facetten und
/// Stirnseiten fallen weg; die Sehne zwischen den Ecken der gewölbten Aussenfläche gilt als
/// Fassadenstück, wenn sie schief liegt (achsparallel deckt sie schon die Seitenkette).
fn oblique_chains(walls: &[WallIn], openings: &[OpeningIn], rings: &[Ring], scale: f64) -> Vec<DimChain> {
    let min_gap = MIN_SEGMENT_MM / 1000.0 * scale;
    let min_len = (walls.iter().map(thick).fold(0.0, f64::max) + 1e-3).max(min_gap);
    let circles: Vec<(Vec2, f64, f64)> = walls
        .iter()
        .filter_map(|w| {
            let a = w.arc()?;
            let h = thick(w) / 2.0;
            Some(([a.center.x, a.center.y], a.radius_at(-h), a.radius_at(h)))
        })
        .collect();
    let on_arc = |a: Vec2, b: Vec2| {
        circles.iter().any(|&(c, r0, r1)| {
            let on = |q: Vec2| {
                let d = (q[0] - c[0]).hypot(q[1] - c[1]);
                (d - r0).abs() < 1e-4 || (d - r1).abs() < 1e-4
            };
            on(a) && on(b)
        })
    };
    // Fassadenstücke (a, b): Aussennormale rechts der Laufrichtung (CCW-Ring).
    let mut edges: Vec<(Vec2, Vec2, Vec2)> = vec![];
    for ring in rings {
        // Gerade durchlaufende Zwischenpunkte (Stösse der Wandflächen) weglassen.
        let k = ring.len();
        let unit = |a: Vec2, b: Vec2| {
            let l = (b[0] - a[0]).hypot(b[1] - a[1]);
            [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
        };
        let ring: Vec<Vec2> = (0..k)
            .filter(|&i| {
                let (p, q, r) = (ring[(i + k - 1) % k], ring[i], ring[(i + 1) % k]);
                let (d0, d1) = (unit(p, q), unit(q, r));
                !(dot(d0, d1) > 0.0 && (d0[0] * d1[1] - d0[1] * d1[0]).abs() < 1e-7)
            })
            .map(|i| ring[i])
            .collect();
        for i in 0..ring.len() {
            let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
            if (b[0] - a[0]).hypot(b[1] - a[1]) >= min_len && !on_arc(a, b) {
                edges.push((a, b, a));
            }
        }
    }
    for w in walls {
        let Some((arc, n_out, lo, hi)) = arc_outer(w, rings) else { continue };
        let (p, q, m) = (arc.point(lo, n_out), arc.point(hi, n_out), arc.point((lo + hi) / 2.0, n_out));
        let (a, b) = ([p.x, p.y], [q.x, q.y]);
        // Laufrichtung so, dass die Wölbung rechts (aussen) liegt.
        let right = [b[1] - a[1], a[0] - b[0]];
        edges.push(if dot(right, [m.x - a[0], m.y - a[1]]) >= 0.0 { (a, b, [m.x, m.y]) } else { (b, a, [m.x, m.y]) });
    }
    let mut groups: Vec<(Vec2, Vec<(Vec2, Vec2, Vec2)>)> = vec![];
    for (a, b, apex) in edges {
        let len = (b[0] - a[0]).hypot(b[1] - a[1]);
        if !(len >= EPS) {
            continue;
        }
        let n = [(b[1] - a[1]) / len, (a[0] - b[0]) / len];
        if SIDES.iter().any(|&s| dot(n, s) >= 1.0 - 1e-6) {
            continue; // achsparallel: Sache der vier Seiten
        }
        match groups.iter_mut().find(|g| dot(g.0, n) >= 1.0 - 1e-6) {
            Some(g) => g.1.push((a, b, apex)),
            None => groups.push((n, vec![(a, b, apex)])),
        }
    }
    // Freistehende schiefe Wand (Stützmauer): ihre beiden Flächen liegen eine Wanddicke auseinander und
    // gegenüber. Nur die vom Gebäude abgewandte bekommt Ketten (die andere läge im Gebäude bzw. im Hof).
    let pts: Vec<Vec2> = rings.iter().flatten().copied().collect();
    let centroid = [pts.iter().map(|p| p[0]).sum::<f64>() / pts.len() as f64, pts.iter().map(|p| p[1]).sum::<f64>() / pts.len() as f64];
    let summary = |g: &(Vec2, Vec<(Vec2, Vec2, Vec2)>)| {
        let (n, u) = (g.0, [g.0[1], -g.0[0]]);
        let s = g.1.iter().map(|f| dot(f.0, n)).fold(f64::NEG_INFINITY, f64::max);
        let ts = g.1.iter().flat_map(|f| [dot(f.0, u), dot(f.1, u)]);
        let (t0, t1) = ts.fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), t| (l.min(t), h.max(t)));
        let mid = g.1.iter().map(|f| dot([(f.0[0] + f.1[0]) / 2.0 - centroid[0], (f.0[1] + f.1[1]) / 2.0 - centroid[1]], n)).fold(f64::NEG_INFINITY, f64::max);
        (s, t0, t1, mid)
    };
    let sums: Vec<(f64, f64, f64, f64)> = groups.iter().map(summary).collect();
    let inner = |i: usize| {
        let (si, t0, t1, mi) = sums[i];
        groups.iter().enumerate().any(|(j, h)| {
            let (sj, u0, u1, mj) = sums[j];
            // Gegenüber: n_j = −n_i, also t_j = −t_i; Abstand der Flächen si + sj.
            j != i && dot(groups[i].0, h.0) <= -1.0 + 1e-6 && si + sj > 0.0 && si + sj <= min_len && -u1 < t1 && -u0 > t0 && (mi < mj || (mi == mj && i > j))
        })
    };
    let keep: Vec<bool> = (0..groups.len()).map(|i| !inner(i)).collect();
    let mut out = vec![];
    let mut side = SIDES.len();
    for (gi, (n, faces)) in groups.into_iter().enumerate() {
        if !keep[gi] {
            continue;
        }
        let u = [n[1], -n[0]];
        let (mut s_line, mut t_min, mut t_max) = (f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        let (mut corners, mut feats, mut spans) = (vec![], vec![], vec![]);
        for &(a, b, apex) in &faces {
            let (ta, tb) = (dot(a, u), dot(b, u));
            s_line = s_line.max(dot(a, n)).max(dot(b, n)).max(dot(apex, n));
            t_min = t_min.min(ta).min(tb);
            t_max = t_max.max(ta).max(tb);
            corners.extend([ta, tb]);
            feats.extend([(ta, a, dot(a, n)), (tb, b, dot(b, n))]);
            spans.push((dot(a, n), ta.min(tb), ta.max(tb)));
        }
        if !(t_max - t_min >= min_gap) {
            continue;
        }
        let mut jambs = vec![];
        for o in openings {
            let Some(outer_s) = walls.get(o.wall).and_then(|w| outer_face_s(w, n)) else { continue };
            let (ja, jb) = (dot(o.jamb_start, u), dot(o.jamb_end, u));
            if !ja.is_finite() || !jb.is_finite() {
                continue;
            }
            if spans.iter().any(|&(s, t0, t1)| (s - outer_s).abs() < 1e-3 && ja.min(jb) >= t0 - 1e-3 && ja.max(jb) <= t1 + 1e-3) {
                jambs.extend([ja, jb]);
                for j in [o.jamb_start, o.jamb_end] {
                    let k = outer_s - dot(j, n);
                    feats.push((dot(j, u), [j[0] + n[0] * k, j[1] + n[1] * k], outer_s + 1.0));
                }
            }
        }
        emit_chains(&mut out, side, n, s_line, (t_min, t_max), &corners, jambs, &feats, scale);
        side += 1;
    }
    out
}

/// Bogenwand, deren gewölbte (äussere) Fläche auf dem Umriss liegt: (Bogen, Seitenlage der gewölbten
/// Fläche, erste/letzte Bogenlänge der Umriss-Punkte auf diesem Kreis).
fn arc_outer(w: &WallIn, rings: &[Ring]) -> Option<(crate::wall_arc::WallArc, f64, f64, f64)> {
    let a = w.arc()?;
    let t = thick(w);
    // Gewölbte Seite = grösserer Radius.
    let n_out = if a.radius_at(t / 2.0) > a.radius_at(-t / 2.0) { t / 2.0 } else { -t / 2.0 };
    let r_out = a.radius_at(n_out);
    let len = a.length();
    let on_circle = |q: &Vec2| ((q[0] - a.center.x).hypot(q[1] - a.center.y) - r_out).abs() < 1e-4;
    // Liegt die gewölbte Fläche auf dem Umriss (Ring-Punkte auf dem Kreis auch im mittleren Teil)?
    let ss: Vec<f64> = rings.iter().flatten().filter(|q| on_circle(q)).map(|q| a.local(kernel2d::Vec2::new(q[0], q[1])).0).filter(|s| *s > -t && *s < len + t).collect();
    let (lo, hi) = ss.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), &s| (l.min(s), h.max(s)));
    if !ss.iter().any(|s| *s > len / 4.0 && *s < 3.0 * len / 4.0) {
        return None;
    }
    Some((a, n_out, lo, hi))
}

/// [T2] Bogenmass-Ketten: je Bogenwand, deren gewölbte (äussere) Fläche auf dem Umriss liegt — Ecken
/// (äusserste Umriss-Punkte auf diesem Kreis) und Leibungen, gemessen entlang des Bogens.
fn arc_chains(walls: &[WallIn], openings: &[OpeningIn], rings: &[Ring], scale: f64) -> Vec<DimChain> {
    let mut out = Vec::new();
    for (wi, w) in walls.iter().enumerate() {
        let Some((a, n_out, lo, hi)) = arc_outer(w, rings) else { continue };
        let mut st = vec![lo, hi];
        for o in openings.iter().filter(|o| o.wall == wi) {
            for j in [o.jamb_start, o.jamb_end] {
                if finite2(j) {
                    let s = a.local(kernel2d::Vec2::new(j[0], j[1])).0;
                    if s > lo && s < hi {
                        st.push(s);
                    }
                }
            }
        }
        let st = thin(unique_sorted(&st), MIN_SEGMENT_MM / 1000.0 * scale);
        if st.len() < 2 {
            continue;
        }
        let pts: Vec<Vec2> = st.iter().map(|&s| a.point(s, n_out)).map(|q| [q.x, q.y]).collect();
        out.push(DimChain { side: 0, chain: CHAIN_OPENINGS, src: pts.clone(), pts, offset: CHAIN_MM[CHAIN_OPENINGS] / 1000.0 * scale, arc: Some(([a.center.x, a.center.y], wi)) });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L-förmiger Grundriss aus 0.3-m-Wänden (Achsen).
    fn l_walls() -> Vec<WallIn> {
        let axis = [[0.0, 0.0], [10.0, 0.0], [10.0, 6.0], [4.0, 6.0], [4.0, 9.0], [0.0, 9.0]];
        (0..axis.len()).map(|i| WallIn { start: axis[i], end: axis[(i + 1) % axis.len()], thickness: 0.3, shift: 0.0, bulge: 0.0 }).collect()
    }
    fn lengths(pts: &[Vec2]) -> Vec<f64> {
        pts.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).collect()
    }
    fn total(d: &DimChain) -> f64 {
        lengths(&d.pts).iter().sum()
    }

    #[test]
    fn gesamtmass_vier_seiten() {
        let dims = auto_exterior_dimensions(&l_walls(), &[], 100.0);
        let totals: Vec<&DimChain> = dims.iter().filter(|d| d.chain == CHAIN_TOTAL).collect();
        assert_eq!(totals.len(), 4);
        for d in totals {
            let want = if d.side % 2 == 0 { 10.3 } else { 9.3 };
            assert!((total(d) - want).abs() < 1e-6, "{d:?}");
            assert!((d.offset - 2.4).abs() < 1e-12);
        }
    }

    #[test]
    fn stufung_nur_nord_und_ost() {
        let dims = auto_exterior_dimensions(&l_walls(), &[], 100.0);
        let steps: Vec<&DimChain> = dims.iter().filter(|d| d.chain == CHAIN_STEPS).collect();
        let mut sides: Vec<usize> = steps.iter().map(|d| d.side).collect();
        sides.sort();
        assert_eq!(sides, vec![1, 2]);
        let north = steps.iter().find(|d| d.side == 2).unwrap();
        let mut l: Vec<f64> = lengths(&north.pts).iter().map(|v| (v * 1000.0).round() / 1000.0).collect();
        l.sort_by(f64::total_cmp);
        assert_eq!(l, vec![4.3, 6.0]);
    }

    #[test]
    fn oeffnungskette() {
        // Fenster 1.5 m breit, Mitte bei 2 m auf der Südwand.
        let o = OpeningIn { wall: 0, jamb_start: [1.25, 0.0], jamb_end: [2.75, 0.0] };
        let dims = auto_exterior_dimensions(&l_walls(), &[o], 100.0);
        let south = dims.iter().find(|d| d.side == 0 && d.chain == CHAIN_OPENINGS).unwrap();
        assert_eq!(lengths(&south.pts).len(), 3);
        assert!((total(south) - 10.3).abs() < 1e-6);
        assert!(south.pts.iter().all(|p| (p[1] + 0.15).abs() < 1e-6));
        assert!((south.offset - 1.0).abs() < 1e-12);
    }

    /// Wand mit Referenzlinie links: die Achse liegt an der Innenkante, die Aussenmasse stimmen trotzdem.
    #[test]
    fn nicht_mittige_wand_misst_die_echte_flaeche() {
        // Achse y = 0, Körper y 0 … 0.3 (shift +0.15), Öffnung 1 … 2 m.
        let w = [WallIn { start: [0.0, 0.0], end: [5.0, 0.0], thickness: 0.3, shift: 0.15, bulge: 0.0 }];
        let o = OpeningIn { wall: 0, jamb_start: [1.0, 0.0], jamb_end: [2.0, 0.0] };
        let dims = auto_exterior_dimensions(&w, &[o], 100.0);
        let south = dims.iter().find(|d| d.side == 0 && d.chain == CHAIN_TOTAL).unwrap();
        let north = dims.iter().find(|d| d.side == 2 && d.chain == CHAIN_TOTAL).unwrap();
        // Masslinie Süd liegt 1.0 m (1:100) vor der Südfläche y = 0; Nord vor y = 0.3.
        let south_y = south.pts[0][1] - south.offset * 1.0 * 0.0;
        assert!((south_y - 0.0).abs() < 1e-6 || (south_y - 0.3).abs() < 1e-6, "{south_y}");
        assert!((north.pts[0][1] - 0.3).abs() < 1e-6, "{:?}", north.pts);
        assert!((south.pts[0][1] - 0.0).abs() < 1e-6, "{:?}", south.pts);
        // Leibungen der Öffnung hängen an der Nordfläche (y = 0.3), nicht an y = 0.15.
        let op = dims.iter().find(|d| d.side == 2 && d.chain == CHAIN_OPENINGS).unwrap();
        assert!(op.src.iter().all(|q| (q[1] - 0.3).abs() < 1e-6), "{:?}", op.src);
    }

    /// [T2] Rechteck mit Bogenwand im Süden (nach aussen gewölbt): Gesamtmass schliesst den Bogen ein,
    /// Bogenmass-Kette auf der Aussenfläche (Ecken + Leibungen) entlang des Bogens.
    #[test]
    fn bogenwand_bogenmass() {
        let mut w = vec![
            WallIn { start: [0.0, 0.0], end: [10.0, 0.0], thickness: 0.3, shift: 0.0, bulge: -0.4 },
            WallIn { start: [10.0, 0.0], end: [10.0, 6.0], thickness: 0.3, shift: 0.0, bulge: 0.0 },
            WallIn { start: [10.0, 6.0], end: [0.0, 6.0], thickness: 0.3, shift: 0.0, bulge: 0.0 },
            WallIn { start: [0.0, 6.0], end: [0.0, 0.0], thickness: 0.3, shift: 0.0, bulge: 0.0 },
        ];
        let a = w[0].arc().unwrap();
        let jamb = |s: f64| {
            let q = a.point(s, 0.0);
            [q.x, q.y]
        };
        let o = OpeningIn { wall: 0, jamb_start: jamb(4.0), jamb_end: jamb(5.5) };
        let dims = auto_exterior_dimensions(&w, &[o], 100.0);
        let arc: Vec<&DimChain> = dims.iter().filter(|d| d.arc.is_some()).collect();
        assert_eq!(arc.len(), 1);
        let d = arc[0];
        let (c, wi) = d.arc.unwrap();
        assert_eq!(wi, 0);
        assert!((c[0] - a.center.x).abs() < 1e-9 && (c[1] - a.center.y).abs() < 1e-9);
        assert_eq!(d.pts.len(), 4, "zwei Ecken, zwei Leibungen");
        let r_out = a.radius_at(if a.radius_at(0.15) > a.radius_at(-0.15) { 0.15 } else { -0.15 });
        assert!(d.pts.iter().all(|q| ((q[0] - c[0]).hypot(q[1] - c[1]) - r_out).abs() < 1e-6));
        // Öffnung entlang der Aussenfläche: 1.5 m Achse · r_out / r.
        let ang = |q: Vec2| (q[1] - c[1]).atan2(q[0] - c[0]);
        let mut da = (ang(d.pts[2]) - ang(d.pts[1])).abs();
        if da > std::f64::consts::PI {
            da = 2.0 * std::f64::consts::PI - da;
        }
        assert!((da * r_out - 1.5 * r_out / a.r).abs() < 1e-6, "{}", da * r_out);
        // Süd-Gesamtmass schliesst den Bogen ein (Scheitel unter y = 0).
        let south = dims.iter().find(|d| d.arc.is_none() && d.side == 0 && d.chain == CHAIN_TOTAL).unwrap();
        assert!(south.pts[0][1] < -1.0, "{:?}", south.pts);
        // Nach innen gewölbt: keine Bogenmass-Kette.
        w[0].bulge = 0.4;
        assert!(auto_exterior_dimensions(&w, &[], 100.0).iter().all(|d| d.arc.is_none()));
    }

    /// Mauerversprung von 0.1 m ergäbe ein Kleinmass: Ketten enthalten keine Teilstrecke unter 1.5 mm Papier.
    #[test]
    fn keine_kleinmasse() {
        let axis = [[0.0, 0.0], [10.0, 0.0], [10.0, 6.0], [4.0, 6.0], [4.0, 6.1], [0.0, 6.1]];
        let w: Vec<WallIn> = (0..axis.len()).map(|i| WallIn { start: axis[i], end: axis[(i + 1) % axis.len()], thickness: 0.3, shift: 0.0, bulge: 0.0 }).collect();
        let dims = auto_exterior_dimensions(&w, &[], 100.0);
        assert!(dims.iter().any(|d| d.chain == CHAIN_STEPS));
        for d in &dims {
            assert!(lengths(&d.pts).iter().all(|l| *l >= 0.15 - 1e-9), "{d:?}");
        }
        // Gesamtmass unverändert.
        let east = dims.iter().find(|d| d.side == 1 && d.chain == CHAIN_TOTAL).unwrap();
        assert!((total(east) - 6.4).abs() < 1e-6 || total(east) > 6.0, "{east:?}");
    }

    /// Rechteck-Wände, um `deg` gedreht (um den Ursprung).
    fn rotated_rect(w: f64, h: f64, deg: f64) -> Vec<WallIn> {
        let (s, c) = deg.to_radians().sin_cos();
        let r = |p: Vec2| [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
        let axis = [[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]].map(r);
        (0..4).map(|i| WallIn { start: axis[i], end: axis[(i + 1) % 4], thickness: 0.3, shift: 0.0, bulge: 0.0 }).collect()
    }
    /// Kettenrichtung (Einheitsvektor erster → letzter Punkt).
    fn dir(d: &DimChain) -> Vec2 {
        let (a, b) = (d.pts[0], d.pts[d.pts.len() - 1]);
        let l = (b[0] - a[0]).hypot(b[1] - a[1]);
        [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
    }
    fn parallel(a: Vec2, b: Vec2) -> bool {
        (a[0] * b[1] - a[1] * b[0]).abs() < 1e-6
    }

    /// Um 30° gedrehtes Rechteck: je Fassade eine Gesamtkette parallel zur Fassade, Länge = Aussenmass,
    /// Masslinie aussen; Öffnungskette auf der Fassade mit der Öffnung.
    #[test]
    fn schiefes_rechteck_30_grad() {
        let walls = rotated_rect(10.0, 6.0, 30.0);
        let a = walls[0].start;
        let u = [(walls[0].end[0] - a[0]) / 10.0, (walls[0].end[1] - a[1]) / 10.0];
        let at = |d: f64| [a[0] + u[0] * d, a[1] + u[1] * d];
        let o = OpeningIn { wall: 0, jamb_start: at(1.25), jamb_end: at(2.75) };
        let dims = auto_exterior_dimensions(&walls, &[o], 100.0);
        assert!(dims.iter().all(|d| d.side >= 4 && d.arc.is_none()), "keine achsparallelen Ketten: {dims:?}");
        let totals: Vec<&DimChain> = dims.iter().filter(|d| d.chain == CHAIN_TOTAL).collect();
        assert_eq!(totals.len(), 4, "{totals:?}");
        let mid = [walls[2].start[0] / 2.0, walls[2].start[1] / 2.0];
        for d in &totals {
            let l = total(d);
            let long = (l - 10.3).abs() < 1e-6;
            assert!(long || (l - 6.3).abs() < 1e-6, "{l}");
            // Parallel zur entsprechenden Wand.
            let wu = if long { u } else { [-u[1], u[0]] };
            assert!(parallel(dir(d), wu), "{d:?}");
            assert!((d.offset - 2.4).abs() < 1e-12);
            // Linke Normale der Kette zeigt nach aussen (weg von der Gebäudemitte), Punkte auf der Aussenfläche.
            let dd = dir(d);
            let n = [-dd[1], dd[0]];
            let s = dot(d.pts[0], n) - dot(mid, n);
            let half = if long { 3.15 } else { 5.15 };
            assert!((s - half).abs() < 1e-6, "{s} {d:?}");
        }
        let op: Vec<&DimChain> = dims.iter().filter(|d| d.chain == CHAIN_OPENINGS).collect();
        assert_eq!(op.len(), 1);
        let mut l: Vec<f64> = lengths(&op[0].pts).iter().map(|v| (v * 1000.0).round() / 1000.0).collect();
        assert!((total(op[0]) - 10.3).abs() < 1e-6);
        l.sort_by(f64::total_cmp);
        assert_eq!(l, vec![1.4, 1.5, 7.4]);
        // Leibungen hängen an der Aussenfläche (0.15 vor der Achse).
        let dd = dir(op[0]);
        let n = [-dd[1], dd[0]];
        assert!(op[0].src.iter().all(|q| (dot(*q, n) - dot(a, n) - 0.15).abs() < 1e-6), "{:?}", op[0].src);
    }

    /// L-Form mit einer schiefen Fassade (Nordost-Ecke abgeschrägt): achsparallele Seiten wie bisher,
    /// dazu eine Kette parallel zur Schräge zwischen den Gehrungsecken.
    #[test]
    fn l_form_mit_schraeger_fassade() {
        let axis = [[0.0, 0.0], [10.0, 0.0], [10.0, 6.0], [4.0, 9.0], [0.0, 9.0]];
        let walls: Vec<WallIn> = (0..axis.len()).map(|i| WallIn { start: axis[i], end: axis[(i + 1) % axis.len()], thickness: 0.3, shift: 0.0, bulge: 0.0 }).collect();
        let dims = auto_exterior_dimensions(&walls, &[], 100.0);
        let obl: Vec<&DimChain> = dims.iter().filter(|d| d.side >= 4).collect();
        assert_eq!(obl.len(), 1, "{obl:?}");
        let d = obl[0];
        assert_eq!(d.chain, CHAIN_TOTAL);
        assert!(parallel(dir(d), [-6.0 / 45f64.sqrt(), 3.0 / 45f64.sqrt()]));
        // Gehrungsecken: Schnitt der Aussenfläche mit x = 10.15 bzw. y = 9.15.
        let c = 22.0 + 0.15 * 5f64.sqrt();
        let (p, q) = ([10.15, (c - 10.15) / 2.0], [c - 18.3, 9.15]);
        let want = (p[0] - q[0]).hypot(p[1] - q[1]);
        assert!((total(d) - want).abs() < 1e-6, "{} != {want}", total(d));
        // Achsparallele Gesamtmasse: Ost bis zur Ecke der Schräge, Nord bis zur Schräge, aussen 10.3 × 9.3.
        let east = dims.iter().find(|d| d.side == 1 && d.chain == CHAIN_TOTAL).unwrap();
        assert!((total(east) - 9.3).abs() < 1e-6, "{east:?}");
        assert!((east.pts[0][0] - 10.15).abs() < 1e-6, "keine Spitze an der Gehrung: {east:?}");
    }

    /// Kollineare schiefe Teilstücke (durch einen Vorsprung getrennt) bilden eine Kette.
    #[test]
    fn kollineare_schiefe_stuecke_eine_kette() {
        // Gedrehtes Rechteck mit Vorbau mitten auf der Südfassade.
        let (s, c) = 30f64.to_radians().sin_cos();
        let r = |p: Vec2| [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
        let axis = [[0.0, 0.0], [3.0, 0.0], [3.0, -2.0], [7.0, -2.0], [7.0, 0.0], [10.0, 0.0], [10.0, 6.0], [0.0, 6.0]].map(r);
        let walls: Vec<WallIn> = (0..axis.len()).map(|i| WallIn { start: axis[i], end: axis[(i + 1) % axis.len()], thickness: 0.3, shift: 0.0, bulge: 0.0 }).collect();
        let dims = auto_exterior_dimensions(&walls, &[], 100.0);
        let su = r([1.0, 0.0]);
        let south: Vec<&DimChain> = dims.iter().filter(|d| d.side >= 4 && parallel(dir(d), su) && dot(d.pts[0], r([0.0, 1.0])) < 0.0).collect();
        // Gesamt + Vor-/Rücksprünge, alle auf derselben Linie (Vorbau-Front).
        assert_eq!(south.iter().filter(|d| d.chain == CHAIN_TOTAL).count(), 1, "{south:?}");
        let steps = south.iter().find(|d| d.chain == CHAIN_STEPS).expect("Stufen-Kette");
        assert_eq!(steps.pts.len(), 4, "{steps:?}");
        assert!((total(steps) - 10.3).abs() < 1e-6);
    }

    /// Bogenwand mit schiefer Sehne: Sehnen-Kette parallel zur Sehne, Masslinie vor dem Bogenscheitel
    /// (nicht vor der Sehne, sonst kreuzte sie die Bogenmass-Kette); keine Ketten auf den Bogen-Facetten.
    #[test]
    fn bogenwand_schief_als_sehne() {
        let mut walls = rotated_rect(10.0, 6.0, 30.0);
        walls[3].bulge = -0.35;
        let a = walls[3].arc().unwrap();
        let dims = auto_exterior_dimensions(&walls, &[], 100.0);
        let cu = { let (p, q) = (walls[3].start, walls[3].end); let l = (q[0] - p[0]).hypot(q[1] - p[1]); [(q[0] - p[0]) / l, (q[1] - p[1]) / l] };
        let chord: Vec<&DimChain> = dims.iter().filter(|d| d.side >= 4 && parallel(dir(d), cu) && d.pts[0][0] < 1.0).collect();
        assert_eq!(chord.len(), 1, "{chord:?}");
        let d = chord[0];
        assert_eq!(d.chain, CHAIN_TOTAL);
        let dd = dir(d);
        let n = [-dd[1], dd[0]];
        let apex = a.point(a.length() / 2.0, if a.radius_at(0.15) > a.radius_at(-0.15) { 0.15 } else { -0.15 });
        assert!((dot(d.pts[0], n) - dot([apex.x, apex.y], n)).abs() < 1e-6, "{d:?}");
        // Sehne kürzer als der Bogen, länger als die Achs-Sehne (6 m).
        assert!(total(d) > 6.0 && total(d) < a.length() + 0.3, "{}", total(d));
        // Vier Fassaden-Richtungen (Sehne ersetzt die Westseite), keine weiteren.
        assert_eq!(dims.iter().filter(|d| d.side >= 4 && d.chain == CHAIN_TOTAL).count(), 4);
    }

    /// Freistehende schiefe Mauer neben dem Gebäude: nur die abgewandte Fläche wird bemasst.
    #[test]
    fn freistehende_schiefe_mauer_einmal() {
        let mut walls = l_walls();
        walls.push(WallIn { start: [-3.0, 2.0], end: [-6.0, 6.0], thickness: 0.3, shift: 0.0, bulge: 0.0 });
        let dims = auto_exterior_dimensions(&walls, &[], 100.0);
        let obl: Vec<&DimChain> = dims.iter().filter(|d| d.side >= 4).collect();
        assert_eq!(obl.len(), 1, "{obl:?}");
        // Abgewandte Seite: Normale zeigt nach Westen/Süden (weg vom Gebäude bei x > 0).
        let dd = dir(obl[0]);
        assert!(-dd[1] < 0.0, "{obl:?}");
        assert!((total(obl[0]) - 5.0).abs() < 1e-6);
    }

    /// Achsparallele Grundrisse: keine schiefen Ketten.
    #[test]
    fn achsparallel_ohne_schiefe_ketten() {
        assert!(auto_exterior_dimensions(&l_walls(), &[], 100.0).iter().all(|d| d.side < 4));
    }

    #[test]
    fn unsinn_ohne_panik() {
        assert!(auto_exterior_dimensions(&[], &[], 100.0).is_empty());
        let bad = [
            WallIn { start: [f64::NAN, 0.0], end: [1.0, 0.0], thickness: 0.3, shift: 0.0, bulge: 0.0 },
            WallIn { start: [0.0, 0.0], end: [0.0, 0.0], thickness: 0.3, shift: 0.0, bulge: 0.0 },
        ];
        let o = OpeningIn { wall: 7, jamb_start: [0.0, 0.0], jamb_end: [1.0, 0.0] };
        assert!(auto_exterior_dimensions(&bad, &[o], f64::NAN).is_empty());
        // Dicke NaN → 0.3; Öffnung mit NaN-Leibung wird übergangen.
        let w = [WallIn { start: [0.0, 0.0], end: [5.0, 0.0], thickness: f64::NAN, shift: 0.0, bulge: 0.0 }];
        let o = OpeningIn { wall: 0, jamb_start: [f64::NAN, 0.0], jamb_end: [1.0, 0.0] };
        let dims = auto_exterior_dimensions(&w, &[o], 0.0);
        assert!(dims.iter().all(|d| d.chain != CHAIN_OPENINGS));
        assert!(dims.iter().any(|d| d.side == 0 && (total(d) - 5.0).abs() < 1e-6));
    }
}
