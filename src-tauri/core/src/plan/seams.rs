//! [198] Gleiche Schichten benachbarter Bauteile verschmelzen: eine Linie, die zwei Flächen gleichen
//! Stils (gleiche Füllung und Schraffur) verschiedener Bauteile trennt, entfällt — Innenputz an Innenputz
//! beim T-Stoss, Mauerwerk an Mauerwerk. Linien bleiben nur am Materialwechsel (und am Rand der Masse).
//!
//! Die Flächen selbst bleiben einzeln (kein Boolean, die Löcher einer Vereinigung hätten im Polygon
//! keinen Platz); sie stossen ohne Fuge aneinander. Entfernt werden nur Strecken, deren beide Seiten
//! (Probe in 0.2 mm Abstand) in Flächen gleichen Stils mit verschiedenem Besitzer liegen. Teilstücke einer
//! Polygonkante werden zu eigenen Linien der Klasse `piece_cls`. Gleicher Besitzer (eigene Schichten einer
//! Wand) behält seine Fugen.
//!
//! Grundriss: `walls.rs` (Bänder, Umriss, Fugen). Schnitt: `section/primitives.rs` (feine Fugen).

use super::prim::{Primitive, Sstr};
use crate::model::Vec2;

#[cfg(test)]
thread_local! {
    /// Nur Tests: Verschmelzung im Grundriss aus (Gegenprobe, dass die Tests die Trennlinie finden).
    pub(crate) static OFF: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Probe-Abstand quer zur Linie (m).
const PROBE: f64 = 2e-4;
const EPS: f64 = 1e-9;
/// Die Linie muss auf dem Rand beider Flächen liegen (Abstand höchstens 0.02 mm): schmale Risse zwischen
/// Sehnen-Näherungen von Bogenwänden sind kein Stoss.
const TOUCH: f64 = 2e-5;

/// Fläche mit Stil-Schlüssel und Besitzer.
pub(crate) struct Region {
    pub pts: Vec<Vec2>,
    pub key: String,
    pub owner: String,
    bbox: [f64; 4],
}

impl Region {
    pub fn new(pts: Vec<Vec2>, key: String, owner: String) -> Region {
        let mut bbox = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for p in &pts {
            bbox = [bbox[0].min(p.x), bbox[1].min(p.y), bbox[2].max(p.x), bbox[3].max(p.y)];
        }
        Region { pts, key, owner, bbox }
    }

    /// Liegt `p` höchstens [`TOUCH`] vom Rand der Fläche entfernt?
    fn touches(&self, p: Vec2) -> bool {
        let n = self.pts.len();
        (0..n).any(|i| {
            let (a, b) = (self.pts[i], self.pts[(i + 1) % n]);
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let l2 = dx * dx + dy * dy;
            let t = if l2 > 0.0 { (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
            (p.x - (a.x + dx * t)).hypot(p.y - (a.y + dy * t)) <= TOUCH
        })
    }

    pub(crate) fn contains(&self, p: Vec2) -> bool {
        if p.x < self.bbox[0] || p.x > self.bbox[2] || p.y < self.bbox[1] || p.y > self.bbox[3] {
            return false;
        }
        let n = self.pts.len();
        let mut inside = false;
        let mut j = n - 1;
        for i in 0..n {
            let (a, b) = (self.pts[i], self.pts[j]);
            if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
                inside = !inside;
            }
            j = i;
        }
        inside
    }
}

/// Teilstücke `(t0, t1)` (Länge ab `a`) der Strecke `a→b`, die bleiben; `None` = unverändert.
fn kept(a: Vec2, b: Vec2, regions: &[Region]) -> Option<Vec<(f64, f64)>> {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let len = dx.hypot(dy);
    if !(len > EPS) || !len.is_finite() {
        return None;
    }
    let (u, n) = (Vec2 { x: dx / len, y: dy / len }, Vec2 { x: -dy / len, y: dx / len });
    let m = 2.0 * PROBE;
    let bb = [a.x.min(b.x) - m, a.y.min(b.y) - m, a.x.max(b.x) + m, a.y.max(b.y) + m];
    let cands: Vec<&Region> = regions.iter().filter(|r| r.bbox[0] <= bb[2] && r.bbox[2] >= bb[0] && r.bbox[1] <= bb[3] && r.bbox[3] >= bb[1]).collect();
    if cands.len() < 2 {
        return None;
    }
    let mut ts = vec![0.0, len];
    for r in &cands {
        let k = r.pts.len();
        for i in 0..k {
            let (p, q) = (r.pts[i], r.pts[(i + 1) % k]);
            for off in [-PROBE, 0.0, PROBE] {
                let dp = (p.x - a.x) * n.x + (p.y - a.y) * n.y - off;
                let dq = (q.x - a.x) * n.x + (q.y - a.y) * n.y - off;
                if dp * dq <= 0.0 && (dp - dq).abs() > 1e-15 {
                    let f = dp / (dp - dq);
                    let (x, y) = (p.x + (q.x - p.x) * f, p.y + (q.y - p.y) * f);
                    let t = (x - a.x) * u.x + (y - a.y) * u.y;
                    if t > 0.0 && t < len {
                        ts.push(t);
                    }
                }
            }
        }
    }
    ts.sort_by(|x, y| x.total_cmp(y));
    ts.dedup_by(|x, y| (*x - *y).abs() < 1e-7);
    // (t0, t1, entfällt)
    let mut parts: Vec<(f64, f64, bool)> = Vec::new();
    for w in ts.windows(2) {
        let t = (w[0] + w[1]) / 2.0;
        let mid = Vec2 { x: a.x + u.x * t, y: a.y + u.y * t };
        let side = |s: f64| -> Vec<&Region> { cands.iter().filter(|r| r.contains(Vec2 { x: mid.x + n.x * s * PROBE, y: mid.y + n.y * s * PROBE }) && r.touches(mid)).copied().collect() };
        let (l, r) = (side(1.0), side(-1.0));
        let fused = l.iter().any(|x| r.iter().any(|y| x.key == y.key && x.owner != y.owner));
        parts.push((w[0], w[1], fused));
    }
    // Schmale Reste neben einem entfallenden Stück (schräge Kanten: Probe-Versatz) entfallen mit.
    for i in 0..parts.len() {
        if !parts[i].2 && parts[i].1 - parts[i].0 < 8.0 * PROBE && (i > 0 && parts[i - 1].2 || i + 1 < parts.len() && parts[i + 1].2) {
            parts[i].2 = true;
        }
    }
    if !parts.iter().any(|p| p.2) {
        return None;
    }
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (t0, t1, drop) in parts {
        if drop {
            continue;
        }
        match out.last_mut() {
            Some(l) if (l.1 - t0).abs() < 1e-7 => l.1 = t1,
            _ => out.push((t0, t1)),
        }
    }
    Some(out)
}

fn lerp(a: Vec2, b: Vec2, t: f64) -> Vec2 {
    let len = (b.x - a.x).hypot(b.y - a.y);
    Vec2 { x: a.x + (b.x - a.x) * t / len, y: a.y + (b.y - a.y) * t / len }
}

/// Fugenlinien und Polygonkanten zwischen gleich gestalteten Flächen verschiedener Besitzer streichen.
/// `is_line`: Linien, die betroffen sein dürfen; `is_poly`: gestrichene Polygone (Kanten ausser
/// `no_stroke_edges`); `piece_cls`: Klasse der Linien, in die eine nur teilweise entfallende Polygonkante zerfällt.
pub(crate) fn fuse(prims: Vec<Primitive>, regions: &[Region], is_line: &dyn Fn(&Primitive) -> bool, is_poly: &dyn Fn(&Primitive) -> bool, piece_cls: &str) -> Vec<Primitive> {
    if regions.len() < 2 {
        return prims;
    }
    let mut out: Vec<Primitive> = Vec::with_capacity(prims.len());
    for pr in prims {
        match &pr {
            Primitive::Line { a, b, .. } if is_line(&pr) => match kept(*a, *b, regions) {
                None => out.push(pr),
                Some(ks) => {
                    for (t0, t1) in ks {
                        if let Primitive::Line { a: la, b: lb, .. } = &pr {
                            let mut piece = pr.clone();
                            if let Primitive::Line { a: pa, b: pb, .. } = &mut piece {
                                *pa = lerp(*la, *lb, t0);
                                *pb = lerp(*la, *lb, t1);
                            }
                            out.push(piece);
                        }
                    }
                }
            },
            Primitive::Polygon { pts, stroke, stroke_width_mm, no_stroke_edges, greyed, .. } if is_poly(&pr) && pts.len() >= 3 => {
                let skip: Vec<f64> = no_stroke_edges.clone().unwrap_or_default();
                let n = pts.len();
                let mut new_skip = skip.clone();
                let mut pieces: Vec<Primitive> = Vec::new();
                for i in 0..n {
                    if skip.contains(&(i as f64)) {
                        continue;
                    }
                    let (a, b) = (pts[i], pts[(i + 1) % n]);
                    let Some(ks) = kept(a, b, regions) else { continue };
                    new_skip.push(i as f64);
                    for (t0, t1) in ks {
                        pieces.push(Primitive::Line { a: lerp(a, b, t0), b: lerp(a, b, t1), cls: piece_cls.into(), weight_mm: *stroke_width_mm, dash: None, zigzag: None, motif: None, color: Some(Sstr::from(stroke.as_str())), drawing_id: None, opening_id: None, stair_id: None, greyed: *greyed, opacity: None });
                    }
                }
                if new_skip.len() == skip.len() {
                    out.push(pr);
                } else {
                    let mut pr = pr;
                    if let Primitive::Polygon { no_stroke_edges, .. } = &mut pr {
                        *no_stroke_edges = Some(new_skip);
                    }
                    out.push(pr);
                    out.extend(pieces);
                }
            }
            _ => out.push(pr),
        }
    }
    out
}

/// Stil-Schlüssel einer Fläche: Füllung, Ausgegraut und Schraffur ohne Ursprung (die Phase gehört zur Wand).
pub(crate) fn style_key(fill: &str, greyed: Option<bool>, hatch: &super::prim::HatchRender) -> String {
    let h = if hatch.pattern == crate::model::HatchPattern::None {
        String::new()
    } else {
        serde_json::to_string(&super::prim::HatchRender { origin: None, ..hatch.clone() }).unwrap_or_default()
    };
    format!("{fill}|{}|{h}", greyed.unwrap_or(false))
}

/// Schnitt ([198]): feine Fugen der Schnittflächen (Polygonkanten, Fugenlinien) zwischen gleich gestalteten
/// Flächen verschiedener Bauteile (Wand an Wand, Wand an Decke) entfallen; die schwere Schnittkante
/// (`section-cut-outline`, Vereinigung aller Flächen) bleibt unberührt.
pub(crate) fn fuse_section(prims: Vec<Primitive>) -> Vec<Primitive> {
    let mut regions: Vec<Region> = Vec::new();
    for q in &prims {
        if let Primitive::Polygon { pts, fill, hatch, greyed, wall_id, ceiling_id, roof_id, stair_id, extruded_solid_id, context_object_id, .. } = q {
            let owner = [("w", wall_id), ("c", ceiling_id), ("r", roof_id), ("s", stair_id), ("x", extruded_solid_id), ("o", context_object_id)].into_iter().find_map(|(k, id)| id.as_ref().map(|id| format!("{k}{id}")));
            if let (Some(owner), true, true) = (owner, fill != "none", pts.len() >= 3) {
                regions.push(Region::new(pts.clone(), style_key(fill, *greyed, hatch), owner));
            }
        }
    }
    let is_line = |q: &Primitive| matches!(q, Primitive::Line { cls, .. } if &**cls == "section-joint");
    let is_poly = |q: &Primitive| matches!(q, Primitive::Polygon { stroke, stroke_width_mm, .. } if stroke != "none" && *stroke_width_mm > 0.0);
    fuse(prims, &regions, &is_line, &is_poly, "section-joint")
}

/// Grundriss-Wände ([198]): Schichtbänder (und schwarze Sammelflächen) je Wand sind die Flächen; entfallen
/// die Umriss-/Fugenlinien zwischen gleichen Flächen verschiedener Wände (T-Stoss, Kreuzung, Ecke).
pub(crate) fn fuse_wall_plan(prims: Vec<Primitive>) -> Vec<Primitive> {
    #[cfg(test)]
    if OFF.with(|o| o.get()) {
        return prims;
    }
    let mut regions: Vec<Region> = Vec::new();
    for q in &prims {
        if let Primitive::Polygon { pts, fill, stroke, stroke_width_mm, hatch, greyed, wall_id: Some(w), opening_id: None, .. } = q {
            let band = stroke == "none" && fill != "none";
            let grob = fill == super::style::HATCH_INK && stroke != "none" && *stroke_width_mm > 0.0;
            if (band || grob) && pts.len() >= 3 {
                regions.push(Region::new(pts.clone(), style_key(fill, *greyed, hatch), w.clone()));
            }
        }
    }
    let is_line = |q: &Primitive| matches!(q, Primitive::Line { cls, opening_id: None, .. } if matches!(&**cls, "wall-outline" | "layer-joint" | "layer-joint-l"));
    let is_poly = |q: &Primitive| matches!(q, Primitive::Polygon { stroke, stroke_width_mm, wall_id: Some(_), opening_id: None, .. } if stroke != "none" && *stroke_width_mm > 0.0);
    fuse(prims, &regions, &is_line, &is_poly, "wall-outline")
}
