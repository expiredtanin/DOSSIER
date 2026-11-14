//! [198] Gleiche Schichten benachbarter Bauteile verschmelzen: eine Linie, die zwei Flächen gleichen
//! Stils (gleiche Füllung und Schraffur) verschiedener Bauteile trennt, entfällt — Innenputz an Innenputz
//! beim T-Stoss, Mauerwerk an Mauerwerk. Linien bleiben nur am Materialwechsel (und am Rand der Masse).
//!
//! Linien ([`fuse_wall_plan`] im Grundriss, [`fuse_section`] im Schnitt): entfernt werden Strecken, deren
//! beide Seiten (Probe in 0.2 mm Abstand; oberste, zuletzt gezeichnete Fläche) gleichen Stil zeigen und die
//! entweder auf dem Rand zweier Flächen verschiedener Besitzer liegen (Stoss) oder quer durch eine Fläche
//! laufen (Überlappung durchlaufender, nicht verbundener Wände). Teilstücke einer Polygonkante werden zu
//! eigenen Linien der Klasse `piece_cls`. Gleicher Besitzer (eigene Schichten einer Wand) behält seine Fugen.
//!
//! Flächen ([`union_bands`], nur Grundriss, nach Abzugskörpern und Stützen-Aussparung): die Schichtbänder
//! gleichen Stoffs verschiedener Wände werden per Boolean (i_overlay, [`crate::polygon_bool::union`]) zu EINER
//! Fläche vereinigt — eine Füllung, eine durchgehende Schraffur mit Lage und Ursprung der Hauptwand (grösster
//! Anteil), Löcher über Brücken im Ring. Die Bänder bleiben als unsichtbare Pick-Flächen (Wand-Id, ohne
//! Füllung) für Auswahl, Rahmen-Auswahl und Hervorhebung.
//!
//! Grundriss: `walls.rs` (Bänder, Umriss, Fugen), `domains.rs` (Vereinigung). Schnitt: `section/primitives.rs`.

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
    /// Zeichenreihenfolge (Index im Primitiv-Strom): die oberste Fläche an einem Punkt ist die sichtbare.
    z: usize,
    /// Sehnen-Näherung einer Bogenwand: eine Linie im Innern der Fläche kann der gezeichnete Bogen-Umriss einer
    /// Nachbarwand sein (Sehnenpfeil) — sie entfällt nur am Stoss zweier Flächen.
    curved: bool,
    bbox: [f64; 4],
}

impl Region {
    pub fn new(pts: Vec<Vec2>, key: String, owner: String) -> Region {
        Region::at(pts, key, owner, 0)
    }

    fn at(pts: Vec<Vec2>, key: String, owner: String, z: usize) -> Region {
        let mut bbox = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for p in &pts {
            bbox = [bbox[0].min(p.x), bbox[1].min(p.y), bbox[2].max(p.x), bbox[3].max(p.y)];
        }
        Region { pts, key, owner, z, curved: false, bbox }
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
    if cands.is_empty() {
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
        let probe = |s: f64| Vec2 { x: mid.x + n.x * s * PROBE, y: mid.y + n.y * s * PROBE };
        let (pl, pr) = (probe(1.0), probe(-1.0));
        // Oberste (zuletzt gezeichnete) Fläche je Seite.
        let top = |p: Vec2| cands.iter().filter(|r| r.contains(p)).max_by_key(|r| r.z).copied();
        let fused = match (top(pl), top(pr)) {
            (Some(l), Some(r)) if l.key == r.key => {
                // Linie quer durch eine Fläche (nicht auf ihrem Rand) bzw. Stoss zweier Flächen verschiedener
                // Besitzer: jede liegt mit dem Rand an der Linie oder überdeckt sie ganz (Überlappung).
                let holds = |x: &Region| x.touches(mid) || (!x.curved && x.contains(pl) && x.contains(pr));
                if l.z == r.z {
                    !l.curved && !l.touches(mid)
                } else {
                    l.owner != r.owner && holds(l) && holds(r)
                }
            }
            _ => false,
        };
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
    if regions.is_empty() {
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
    for (z, q) in prims.iter().enumerate() {
        if let Primitive::Polygon { pts, fill, hatch, greyed, wall_id, ceiling_id, roof_id, stair_id, extruded_solid_id, context_object_id, .. } = q {
            let owner = [("w", wall_id), ("c", ceiling_id), ("r", roof_id), ("s", stair_id), ("x", extruded_solid_id), ("o", context_object_id)].into_iter().find_map(|(k, id)| id.as_ref().map(|id| format!("{k}{id}")));
            if let (Some(owner), true, true) = (owner, fill != "none", pts.len() >= 3) {
                regions.push(Region::at(pts.clone(), style_key(fill, *greyed, hatch), owner, z));
            }
        }
    }
    let is_line = |q: &Primitive| matches!(q, Primitive::Line { cls, .. } if &**cls == "section-joint");
    let is_poly = |q: &Primitive| matches!(q, Primitive::Polygon { stroke, stroke_width_mm, .. } if stroke != "none" && *stroke_width_mm > 0.0);
    fuse(prims, &regions, &is_line, &is_poly, "section-joint")
}

/// Grundriss-Wände ([198]): Schichtbänder (und schwarze Sammelflächen) je Wand sind die Flächen; entfallen
/// die Umriss-/Fugenlinien zwischen gleichen Flächen verschiedener Wände (T-Stoss, Kreuzung, Ecke) bzw. quer
/// durch eine gleich gestaltete Fläche (Überlappung). `curved`: Wand-Id einer Bogenwand (Bänder als Sehnenzug).
pub(crate) fn fuse_wall_plan(prims: Vec<Primitive>, curved: &dyn Fn(&str) -> bool) -> Vec<Primitive> {
    #[cfg(test)]
    if OFF.with(|o| o.get()) {
        return prims;
    }
    let mut regions: Vec<Region> = Vec::new();
    for (z, q) in prims.iter().enumerate() {
        if let Primitive::Polygon { pts, fill, stroke, stroke_width_mm, hatch, greyed, wall_id: Some(w), opening_id: None, .. } = q {
            let band = stroke == "none" && fill != "none";
            let grob = fill == super::style::HATCH_INK && stroke != "none" && *stroke_width_mm > 0.0;
            if (band || grob) && pts.len() >= 3 {
                let mut r = Region::at(pts.clone(), style_key(fill, *greyed, hatch), w.clone(), z);
                r.curved = curved(w);
                regions.push(r);
            }
        }
    }
    let is_line = |q: &Primitive| matches!(q, Primitive::Line { cls, opening_id: None, .. } if matches!(&**cls, "wall-outline" | "layer-joint" | "layer-joint-l"));
    let is_poly = |q: &Primitive| matches!(q, Primitive::Polygon { stroke, stroke_width_mm, wall_id: Some(_), opening_id: None, .. } if stroke != "none" && *stroke_width_mm > 0.0);
    fuse(prims, &regions, &is_line, &is_poly, "wall-outline")
}

/// Gerichtete Bandmuster (Dämmschlange, Zickzack, Welle, Holzkreuz): ihre Lage hängt an Wandrichtung und
/// Schichtdicke — nur gleich ausgerichtete Bänder werden vereinigt.
fn directed(p: crate::model::HatchPattern) -> bool {
    use crate::model::HatchPattern as H;
    matches!(p, H::Insulation | H::InsulationHard | H::InsulationWave | H::Timber)
}

/// Schlüssel der Vereinigung: Füllung, Ausgegraut, Deckkraft und Schraffur MIT Richtung (Winkel, polare
/// Bogen-Schraffur) — die Richtung trägt Bedeutung (Dämm-Striche quer zur Wand, [166]); verschieden
/// ausgerichtete Schraffur bleibt getrennt (mit Linie). Der Ursprung zählt nicht: die vereinigte Fläche nimmt
/// den der Hauptwand. Flächige Linienmuster sind um 180° symmetrisch (Winkel modulo 180°), ohne Muster zählt
/// der Winkel nicht. `None`: nicht vereinigen (Bild, Verlauf).
fn merge_key(fill: &str, greyed: Option<bool>, opacity: Option<f64>, h: &super::prim::HatchRender) -> Option<String> {
    use crate::model::{HatchPattern as H, HatchStyleKind as K};
    if h.kind.is_some_and(|k| k != K::Vector) || h.image.is_some() || h.gradient.is_some() {
        return None;
    }
    let angle = match h.pattern {
        H::None | H::Solid => 0.0,
        p if directed(p) => h.angle,
        _ => {
            let a = (h.angle.rem_euclid(180.0) * 1e6).round() / 1e6;
            if a >= 180.0 { 0.0 } else { a }
        }
    };
    let polar = if matches!(h.pattern, H::None | H::Solid) { None } else { h.polar };
    let key = style_key(fill, greyed, &super::prim::HatchRender { angle, polar, ..h.clone() });
    Some(format!("{key}|{opacity:?}"))
}

fn ring_area(r: &[[f64; 2]]) -> f64 {
    let n = r.len();
    (0..n).map(|i| r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1]).sum::<f64>() / 2.0
}

fn in_ring(r: &[[f64; 2]], p: [f64; 2]) -> bool {
    let n = r.len();
    let mut c = false;
    for i in 0..n {
        let (a, b) = (r[i], r[(i + 1) % n]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]) {
            c = !c;
        }
    }
    c
}

/// Ein Punkt sicher im Innern des Rings (knapp innen neben einer der längsten Kanten).
fn interior_point(r: &[[f64; 2]]) -> Option<[f64; 2]> {
    let s = ring_area(r).signum();
    let n = r.len();
    let len = |i: usize| (r[(i + 1) % n][0] - r[i][0]).hypot(r[(i + 1) % n][1] - r[i][1]);
    let mut edges: Vec<usize> = (0..n).collect();
    edges.sort_by(|a, b| len(*b).total_cmp(&len(*a)));
    for i in edges.into_iter().take(8) {
        let (a, b, l) = (r[i], r[(i + 1) % n], len(i));
        if !(l > 1e-6) {
            break;
        }
        let m = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
        // Linke Normale zeigt im Gegenuhrzeigersinn nach innen.
        let nin = [-s * (b[1] - a[1]) / l, s * (b[0] - a[0]) / l];
        for d in [1e-5, 1e-4, 1e-3] {
            let p = [m[0] + nin[0] * d, m[1] + nin[1] * d];
            if in_ring(r, p) {
                return Some(p);
            }
        }
    }
    None
}

/// [198] Schichtbänder gleichen Stoffs verschiedener Wände zu einer Fläche vereinigen (T-Stoss, Ecke, Kreuzung,
/// Überlappung durchlaufender Wände, Bogen an gerader Wand). Die vereinigte Fläche steht an der Stelle des ersten
/// Bandes (später Gezeichnetes bleibt darüber), ohne Wand-Id, mit Füllung/Schraffur des grössten Bandes
/// (Hauptwand: Lage, Ursprung); die Bänder bleiben als unsichtbare Pick-Flächen (Füllung „none", ohne
/// Schraffur). Nur Zusammenhänge aus mindestens zwei Wänden; was i_overlay nicht zusammenbringt, bleibt wie es war.
/// Läuft nach den Abzugskörpern und der Stützen-Aussparung (die nur Flächen mit Wand-Id bearbeiten).
pub(crate) fn union_bands(mut prims: Vec<Primitive>) -> Vec<Primitive> {
    #[cfg(test)]
    if OFF.with(|o| o.get()) {
        return prims;
    }
    use std::collections::BTreeMap;
    // Schlüssel → (Index, Ring, Wand)
    type Band = (usize, Vec<[f64; 2]>, String);
    let mut groups: BTreeMap<String, Vec<Band>> = BTreeMap::new();
    for (i, q) in prims.iter().enumerate() {
        if let Primitive::Polygon { pts, fill, stroke, hatch, greyed, opacity, wall_id: Some(w), opening_id: None, .. } = q {
            if stroke != "none" || fill == "none" || pts.len() < 3 || pts.iter().any(|p| !p.x.is_finite() || !p.y.is_finite()) {
                continue;
            }
            if let Some(k) = merge_key(fill, *greyed, *opacity, hatch) {
                groups.entry(k).or_default().push((i, pts.iter().map(|p| [p.x, p.y]).collect(), w.clone()));
            }
        }
    }
    // (Einfügestelle, neue Fläche, aufgehobene Bänder)
    let mut merged: Vec<(usize, Primitive, Vec<usize>)> = Vec::new();
    for g in groups.into_values() {
        if g.len() < 2 || g.iter().all(|x| x.2 == g[0].2) {
            continue;
        }
        let u = crate::polygon_bool::union(&g.iter().map(|x| vec![x.1.clone()]).collect::<Vec<_>>());
        if u.len() >= g.len() {
            continue;
        }
        let probes: Vec<Option<[f64; 2]>> = g.iter().map(|x| interior_point(&x.1)).collect();
        for pl in &u {
            let members: Vec<usize> = (0..g.len()).filter(|&k| probes[k].is_some_and(|p| in_ring(&pl[0], p) && !pl[1..].iter().any(|h| in_ring(h, p)))).collect();
            if members.len() < 2 || members.iter().all(|&k| g[k].2 == g[members[0]].2) {
                continue;
            }
            // Hauptwand: grösstes Band, gerade Wände vor Bogenwänden (deren polare Schraffur passt nur zum Bogen).
            let polar = |k: usize| matches!(&prims[g[k].0], Primitive::Polygon { hatch, .. } if hatch.polar.is_some());
            let rank = |k: usize| (!polar(k), ring_area(&g[k].1).abs());
            let main = members.iter().copied().max_by(|&a, &b| rank(a).partial_cmp(&rank(b)).unwrap_or(std::cmp::Ordering::Equal)).unwrap_or(members[0]);
            let holes: Vec<Vec<[f64; 2]>> = pl[1..].iter().filter(|h| ring_area(h).abs() > 1e-10).cloned().collect();
            let ring = crate::polygon_holes::merge_holes(&pl[0], &holes, 1e-5).ring;
            if ring.len() < 3 {
                continue;
            }
            let mut poly = prims[g[main].0].clone();
            if let Primitive::Polygon { pts, no_stroke_edges, wall_id, .. } = &mut poly {
                *pts = ring.iter().map(|p| Vec2 { x: p[0], y: p[1] }).collect();
                *no_stroke_edges = None;
                *wall_id = None;
            }
            let first = members.iter().map(|&k| g[k].0).min().unwrap_or(0);
            merged.push((first, poly, members.iter().map(|&k| g[k].0).collect()));
        }
    }
    if merged.is_empty() {
        return prims;
    }
    merged.sort_by_key(|m| m.0);
    for (_, _, gone) in &merged {
        for &i in gone {
            if let Primitive::Polygon { fill, hatch, .. } = &mut prims[i] {
                *fill = "none".into();
                **hatch = super::style::no_hatch();
            }
        }
    }
    let mut out: Vec<Primitive> = Vec::with_capacity(prims.len() + merged.len());
    let mut it = merged.into_iter().peekable();
    for (i, q) in prims.into_iter().enumerate() {
        while let Some(m) = it.next_if(|m| m.0 == i) {
            out.push(m.1);
        }
        out.push(q);
    }
    out
}
