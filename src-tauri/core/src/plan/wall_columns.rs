//! [141] Wand endet an einer Stütze (Grundriss): je nach Material dominiert die Stütze (die Wand endet
//! an der Stützenkontur, ihr Ende ohne Umriss), die Wand (die Stütze wird an der Wand beschnitten) oder
//! beide verschmelzen (gleiches Bauteil: die Stützenkontur fehlt über den gleichen Schichten). Die Wand-
//! Seite rechnet `plan/walls.rs` (Schnittlinie), die Stützen-Seite `plan/domains.rs`. Nur geschnittene
//! Wände und geschnittene Stützen desselben Geschosses; Bogenwände ([T2], Teil 4) über die Treffer ihrer
//! Flächenkreise mit der Kontur.

use crate::joins::{self, Line, WallCuts};
use crate::model::*;

/// Wer im Schnitt dominiert.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Rel {
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
pub(crate) fn end_in_column(w: &Wall, fp: &[Vec2]) -> Option<bool> {
    if fp.len() < 3 {
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
pub(crate) fn relation(p: &Project, w: &Wall, col: &Column) -> Rel {
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
pub(crate) fn contour_cut(p: &Project, w: &Wall, fp: &[Vec2], at_end: bool) -> Option<Line> {
    let total = p.wall_thickness(w, 0.2);
    let ref_off = joins::reference_offset(crate::model3d::wall_reference(w), total);
    if let Some(arc) = crate::wall_arc::WallArc::of_wall(w) {
        let (a, b) = (arc_entry(&arc, fp, ref_off - total / 2.0, at_end)?, arc_entry(&arc, fp, ref_off + total / 2.0, at_end)?);
        let dir = kernel2d::sub(b, a);
        return (dir.x.hypot(dir.y) > 1e-9).then_some(Line { point: a, dir });
    }
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

/// Bogenwand: erster Eintritt der Fläche `n` (Kreis) in die Kontur, vom anderen Wandende her (Bogenlänge
/// nächst dem Anfang bzw. Ende, über das Wandende hinaus höchstens um die Grösse der Stütze).
fn arc_entry(arc: &crate::wall_arc::WallArc, fp: &[Vec2], n: f64, at_end: bool) -> Option<kernel2d::Vec2> {
    let k = |q: Vec2| kernel2d::Vec2::new(q.x, q.y);
    let (mut x0, mut x1, mut y0, mut y1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for q in fp {
        (x0, x1, y0, y1) = (x0.min(q.x), x1.max(q.x), y0.min(q.y), y1.max(q.y));
    }
    let reach = (x1 - x0).hypot(y1 - y0) + joins::JOIN_SNAP;
    let len = arc.length();
    let mut best: Option<(f64, kernel2d::Vec2)> = None;
    for i in 0..fp.len() {
        let (a, b) = (k(fp[i]), k(fp[(i + 1) % fp.len()]));
        let d = kernel2d::sub(b, a);
        let l2 = d.x * d.x + d.y * d.y;
        if l2 < 1e-24 {
            continue;
        }
        for h in crate::wall_arc::circle_line(arc.center, arc.radius_at(n), &Line { point: a, dir: d }) {
            let t = kernel2d::dot(kernel2d::sub(h, a), d) / l2;
            if !(-1e-9..=1.0 + 1e-9).contains(&t) {
                continue;
            }
            let s = arc.local(h).0;
            // Abstand vom anderen Ende (entlang der Fläche), gültig nur nahe dem Stützenende.
            let (from_far, ok) = if at_end { (s, s >= len / 2.0 && s <= len + reach) } else { (len - s, s <= len / 2.0 && s >= -reach) };
            if ok && best.map_or(true, |(q, _)| from_far < q) {
                best = Some((from_far, h));
            }
        }
    }
    best.map(|b| b.1)
}

/// Wand-Enden in dominanten bzw. gleichen Stützen an der Kontur stutzen (überschreibt Gehrung/Stoss
/// dieses Endes; Schicht-Schnitte des Endes folgen der Kontur).
pub(crate) fn trim_walls_at_columns(p: &Project, walls: &[&Wall], cut_cols: &[(&Column, Vec<Vec2>)], cuts: &mut [WallCuts]) {
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
                c.collinear[1] = false;
                c.at_column[1] = true;
            } else {
                c.start_cut = Some(cut);
                c.start_cut2 = None;
                c.collinear[0] = false;
                c.at_column[0] = true;
            }
            if let Some(lc) = c.layer_cuts.as_mut() {
                let (face, side) = if at_end { (&mut lc.end, &mut lc.end_side) } else { (&mut lc.start, &mut lc.start_side) };
                face.iter_mut().for_each(|f| *f = Some(cut));
                side.iter_mut().for_each(|f| *f = None);
            }
        }
    }
}

/// Wandband im Querversatz `lo..hi` über die ganze Achse (für die Stützen-Seite): gerade Wand ein
/// Rechteck; Bogenwand die Vierecke ihrer Sehnen-Teilwände (Sehne der Achse, Flächen parallel dazu,
/// radiale Teilstellen — wie `wall_arc::chord_walls` die Körper legt).
/// `chord_ends`: freie Enden rechtwinklig zur Sehne (3D-Körper); sonst radial (Grundriss).
pub(crate) fn band_polys(w: &Wall, lo: f64, hi: f64, chord_ends: bool) -> Vec<Vec<Vec2>> {
    let Some(arc) = crate::wall_arc::WallArc::of_wall(w) else { return vec![band_rect(w, lo, hi)] };
    let len = arc.length();
    let st = arc.stations(0.0, len, arc.r_max(lo, hi));
    let mv = |q: kernel2d::Vec2| Vec2 { x: q.x, y: q.y };
    let mut out = Vec::new();
    let k = st.len().saturating_sub(1);
    for (i, s) in st.windows(2).enumerate() {
        let (pa, pb) = (arc.point(s[0], 0.0), arc.point(s[1], 0.0));
        let d = kernel2d::sub(pb, pa);
        let l = d.x.hypot(d.y);
        if l < 1e-12 {
            continue;
        }
        let nrm = kernel2d::Vec2::new(-d.y / l, d.x / l);
        // Innere Teilstellen radial, Wandanfang/-ende rechtwinklig zur Sehne (freies Ende).
        let corner = |at: kernel2d::Vec2, off: f64, end: bool| {
            if end {
                return Some(mv(kernel2d::add(at, kernel2d::scale(nrm, off))));
            }
            let q = kernel2d::add(pa, kernel2d::scale(nrm, off));
            kernel2d::line_intersect(q, d, at, kernel2d::sub(at, arc.center)).map(mv)
        };
        let (e0, e1) = (chord_ends && i == 0, chord_ends && i + 1 == k);
        if let (Some(a), Some(b), Some(c), Some(e)) = (corner(pa, lo, e0), corner(pb, lo, e1), corner(pb, hi, e1), corner(pa, hi, e0)) {
            out.push(vec![a, b, c, e]);
        }
    }
    out
}

/// Rechteck des Wandbands im Querversatz `lo..hi` über die ganze Achse (gerade Wand).
pub(crate) fn band_rect(w: &Wall, lo: f64, hi: f64) -> Vec<Vec2> {
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let l = dx.hypot(dy).max(1e-30);
    let n = Vec2 { x: -dy / l, y: dx / l };
    let at = |q: Vec2, o: f64| Vec2 { x: q.x + n.x * o, y: q.y + n.y * o };
    vec![at(w.start, lo), at(w.end, lo), at(w.end, hi), at(w.start, hi)]
}

/// [141] Bogenwand gleichen Bauteils in der Stütze (`Rel::Merge`): Footprint als schmaler Streifen um das
/// Stück der Schnittlinie (Stützenkontur) zwischen den Schichtgrenzen `lo..hi` — dort fehlt die Kontur.
pub(crate) fn arc_merge_footprint(p: &Project, w: &Wall, fp: &[Vec2], lo: f64, hi: f64) -> Option<crate::plan::wall_poche::WallFootprint> {
    let arc = crate::wall_arc::WallArc::of_wall(w)?;
    let at_end = end_in_column(w, fp)?;
    let cut = contour_cut(p, w, fp, at_end)?;
    let near = cut.point;
    let (a, b) = (arc.line_hit_near(lo, &cut, near)?, arc.line_hit_near(hi, &cut, near)?);
    let d = kernel2d::sub(b, a);
    let l = d.x.hypot(d.y);
    if !(l > 1e-3) {
        return None;
    }
    // Rahmen: `u` entlang der Linie (Reichweite len ± half), `m` quer dazu (± half um die Linie).
    const H: f64 = 1e-4;
    let u = [d.x / l, d.y / l];
    let a0 = [a.x + u[0] * (H + 1e-6), a.y + u[1] * (H + 1e-6)];
    Some(crate::plan::wall_poche::WallFootprint { a: a0, u, m: [-u[1], u[0]], len: l - 2.0 * (H + 1e-6), half: H, ref_off: 0.0 })
}
