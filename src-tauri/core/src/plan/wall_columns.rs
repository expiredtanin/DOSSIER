//! [141] Wand endet an einer Stütze (Grundriss): je nach Material dominiert die Stütze (die Wand endet
//! an der Stützenkontur, ihr Ende ohne Umriss), die Wand (die Stütze wird an der Wand beschnitten) oder
//! beide verschmelzen (gleiches Bauteil: die Stützenkontur fehlt über den gleichen Schichten). Die Wand-
//! Seite rechnet `plan/walls.rs` (Schnittlinie), die Stützen-Seite `plan/domains.rs`. Nur geschnittene,
//! gerade Wände und geschnittene Stützen desselben Geschosses.

use crate::joins::{self, Line, WallCuts};
use crate::model::*;

/// Wer im Schnitt dominiert.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Rel {
    /// Stütze prioritärer: die Wand endet an der Kontur.
    Column,
    /// Gleiches Bauteil wie Schichten der Wand (Querversatz `lo..hi`): Wand endet an der Kontur, die
    /// Kontur fehlt über diesen Schichten.
    Merge(f64, f64),
    /// Wand prioritärer: die Stütze wird an der Wand beschnitten.
    Wall,
}

fn inside(poly: &[Vec2], p: Vec2) -> bool {
    let n = poly.len();
    let mut c = false;
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        if (a.y > p.y) != (b.y > p.y) && p.x < a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x) {
            c = !c;
        }
    }
    c
}

fn dist_seg(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let l2 = dx * dx + dy * dy;
    let t = if l2 < 1e-24 { 0.0 } else { (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0) };
    (p.x - a.x - t * dx).hypot(p.y - a.y - t * dy)
}

fn near_or_inside(poly: &[Vec2], p: Vec2) -> bool {
    inside(poly, p) || (0..poly.len()).any(|i| dist_seg(p, poly[i], poly[(i + 1) % poly.len()]) <= joins::JOIN_SNAP)
}

/// Endet die Wand (mit genau einem Ende) in der Stütze: `Some(true)` = Ende, `Some(false)` = Anfang.
pub(super) fn end_in_column(w: &Wall, fp: &[Vec2]) -> Option<bool> {
    if w.bulge.is_some_and(|b| b.abs() > 1e-9) || fp.len() < 3 {
        return None;
    }
    match (near_or_inside(fp, w.start), near_or_inside(fp, w.end)) {
        (false, true) => Some(true),
        (true, false) => Some(false),
        _ => None,
    }
}

/// Rangfolge Wand–Stütze: Stütze ohne Bauteil dominiert; sonst `joinPriority` der Stütze gegen die
/// höchste Schicht der Wand (Gleichstand: Stütze), gleiches Bauteil verschmilzt.
pub(super) fn relation(p: &Project, w: &Wall, col: &Column) -> Rel {
    let wt = p.wall_type_or_fallback(w);
    let comp = col.component_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.component(id));
    let Some(comp) = comp else { return Rel::Column };
    let wall_prio = wt.layers.iter().map(|l| p.component_or_fallback(&l.component_id).join_priority).fold(f64::NEG_INFINITY, f64::max);
    if comp.join_priority < wall_prio {
        return Rel::Wall;
    }
    let total = wt.layers.iter().fold(0.0, |s, l| s + l.thickness);
    let mut off = joins::reference_offset(crate::model3d::wall_reference(w), total) - total / 2.0;
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for l in &wt.layers {
        if p.component_or_fallback(&l.component_id).id == comp.id {
            lo = lo.min(off);
            hi = hi.max(off + l.thickness);
        }
        off += l.thickness;
    }
    if hi > lo {
        Rel::Merge(lo, hi)
    } else {
        Rel::Column
    }
}

/// Erster Eintritt des Strahls `o + s·d` (s > 0) in die Kontur.
fn entry(fp: &[Vec2], o: Vec2, d: Vec2) -> Option<Vec2> {
    let mut best: Option<f64> = None;
    for i in 0..fp.len() {
        let (a, b) = (fp[i], fp[(i + 1) % fp.len()]);
        let e = Vec2 { x: b.x - a.x, y: b.y - a.y };
        let den = d.x * e.y - d.y * e.x;
        if den.abs() < 1e-12 {
            continue;
        }
        let (rx, ry) = (a.x - o.x, a.y - o.y);
        let s = (rx * e.y - ry * e.x) / den;
        let t = (rx * d.y - ry * d.x) / den;
        if s > 1e-9 && (-1e-9..=1.0 + 1e-9).contains(&t) && best.map_or(true, |q| s < q) {
            best = Some(s);
        }
    }
    best.map(|s| Vec2 { x: o.x + d.x * s, y: o.y + d.y * s })
}

/// Schnittlinie der Wand an der Stützenkontur: Gerade durch die Eintrittspunkte beider Wandflächen
/// (Rechteckstütze: die Stützenkante). `None`, wenn eine Fläche die Stütze verfehlt (Wand breiter).
pub(super) fn contour_cut(p: &Project, w: &Wall, fp: &[Vec2], at_end: bool) -> Option<Line> {
    let total = p.wall_thickness(w, 0.2);
    let ref_off = joins::reference_offset(crate::model3d::wall_reference(w), total);
    let (from, to) = if at_end { (w.start, w.end) } else { (w.end, w.start) };
    let (dx, dy) = (to.x - from.x, to.y - from.y);
    let l = dx.hypot(dy);
    if !(l > 1e-9) {
        return None;
    }
    let d = Vec2 { x: dx / l, y: dy / l };
    // Links-Normale im Wandrahmen (Anfang → Ende).
    let (ux, uy) = ((w.end.x - w.start.x) / l, (w.end.y - w.start.y) / l);
    let n = Vec2 { x: -uy, y: ux };
    let face = |off: f64| entry(fp, Vec2 { x: from.x + n.x * off, y: from.y + n.y * off }, d);
    let (a, b) = (face(ref_off - total / 2.0)?, face(ref_off + total / 2.0)?);
    let dir = joins::Line { point: kernel2d::Vec2::new(a.x, a.y), dir: kernel2d::Vec2::new(b.x - a.x, b.y - a.y) };
    (dir.dir.x.hypot(dir.dir.y) > 1e-9).then_some(dir)
}

/// Wand-Enden in dominanten bzw. gleichen Stützen an der Kontur stutzen (überschreibt Gehrung/Stoss
/// dieses Endes; Schicht-Schnitte des Endes folgen der Kontur).
pub(super) fn trim_walls_at_columns(p: &Project, walls: &[&Wall], cut_cols: &[(&Column, Vec<Vec2>)], cuts: &mut [WallCuts]) {
    for (wi, w) in walls.iter().enumerate() {
        for (col, fp) in cut_cols {
            let Some(at_end) = end_in_column(w, fp) else { continue };
            if relation(p, w, col) == Rel::Wall {
                continue;
            }
            let Some(cut) = contour_cut(p, w, fp, at_end) else { continue };
            let c = &mut cuts[wi];
            if at_end {
                c.end_cut = Some(cut);
                c.end_cut2 = None;
            } else {
                c.start_cut = Some(cut);
                c.start_cut2 = None;
            }
            if let Some(lc) = c.layer_cuts.as_mut() {
                let (face, side) = if at_end { (&mut lc.end, &mut lc.end_side) } else { (&mut lc.start, &mut lc.start_side) };
                face.iter_mut().for_each(|f| *f = Some(cut));
                side.iter_mut().for_each(|f| *f = None);
            }
        }
    }
}

/// Rechteck des Wandbands im Querversatz `lo..hi` über die ganze Achse (für die Stützen-Seite).
pub(super) fn band_rect(w: &Wall, lo: f64, hi: f64) -> Vec<Vec2> {
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let l = dx.hypot(dy).max(1e-30);
    let n = Vec2 { x: -dy / l, y: dx / l };
    let at = |q: Vec2, o: f64| Vec2 { x: q.x + n.x * o, y: q.y + n.y * o };
    vec![at(w.start, lo), at(w.end, lo), at(w.end, hi), at(w.start, hi)]
}
