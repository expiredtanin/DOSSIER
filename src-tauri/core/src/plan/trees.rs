//! [149] Bäume im Grundriss (Situation) und in Schnitt/Ansicht. Geometrie aus `crate::tree`.
//!
//! Grundriss (Tusche, übliche Plankonvention): Kronenumriss als Planzeichen — Laubbaum mit Wellenkranz,
//! Nadelbaum mit Zackenkranz —, Stamm als Kreis in Stammdicke. **Bestehend**: Strich in der Ebenenfarbe
//! (sonst Tusche), Stamm gefüllt. **Neu**: rot (Planungsfarbe), Stamm offen. **Zu fällen**: gelb, Krone
//! gestrichelt und durchgekreuzt (das Kreuz trägt die Aussage auch im Schwarz-Weiss-Druck). Eine eigene
//! Farbe (`color`) übersteuert. Pick: unsichtbare Kronenfläche mit `contextObjectId = "@tree:<id>"`.
//!
//! Schnitt/Ansicht: vereinfachte Silhouette nach Form (Kronenprofil gespiegelt) und Stamm.

use super::domains::Ctx;
use super::prim::Primitive;
use super::section::{LevelSpec, Visibility};
use super::style::{no_hatch, MONO_INK};
use crate::model::*;
use crate::tree::{TreeGeom, TREE_PICK_PREFIX};

/// Planungsfarbe „neu" und Abbruchfarbe „zu fällen".
pub const NEW_COLOR: &str = "#c8102e";
pub const REMOVE_COLOR: &str = "#d4a017";
const CROWN_MM: f64 = 0.18;
const TRUNK_MM: f64 = 0.25;
const REMOVE_DASH: [f64; 2] = [1.5, 1.0];
/// Strich der Silhouette in Schnitt/Ansicht.
const VIEW_INK: &str = "#2b3039";
const VIEW_CROWN_MM: f64 = 0.18;
const VIEW_TRUNK_MM: f64 = 0.13;
/// Füllung der Krone in der farbigen Ansicht (Tusche: weiss).
const VIEW_CROWN_FILL: &str = "#e3ead9";
/// Strichstärke der Schnittflächen (Krone, Stamm) im Schnitt und deren Füllung (farbig).
const VIEW_CUT_MM: f64 = 0.35;
const VIEW_CROWN_CUT_FILL: &str = "#c4d2b0";
const VIEW_TRUNK_CUT_FILL: &str = "#b8a78f";
/// Füllung des Stamms in der farbigen Ansicht.
const VIEW_TRUNK_FILL: &str = "#d8cbb8";

fn v(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Pick-Id eines Baums (Feld `contextObjectId`).
pub fn pick_id(id: &str) -> String {
    format!("{TREE_PICK_PREFIX}{id}")
}

pub(super) fn poly(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, pick: Option<String>, greyed: Option<bool>) -> Primitive {
    Primitive::Polygon {
        pts,
        fill: fill.into(),
        stroke: stroke.into(),
        stroke_width_mm: w,
        hatch: Box::new(no_hatch()),
        greyed,
        opacity: None,
        no_stroke_edges: None,
        wall_id: None,
        drawing_id: None,
        ceiling_id: None,
        opening_id: None,
        stair_id: None,
        room_id: None,
        extruded_solid_id: None,
        context_object_id: pick,
        column_id: None,
        roof_id: None,
        section_line_id: None,
    }
}

pub(super) fn line(a: Vec2, b: Vec2, cls: &str, w: f64, color: &str, dash: Option<&[f64]>, greyed: Option<bool>) -> Primitive {
    Primitive::Line {
        a,
        b,
        cls: cls.into(),
        weight_mm: w,
        dash: dash.map(|d| Some(d.to_vec())),
        zigzag: None,
        motif: None,
        color: Some(color.into()),
        drawing_id: None,
        opening_id: None,
        stair_id: None,
        greyed,
        opacity: None,
    }
}

/// Kronenumriss im Grundriss: Wellenkranz (Laub) bzw. Zackenkranz (Nadel) um `c` mit Radius `r`.
pub fn crown_outline(c: [f64; 2], r: f64, foliage: TreeFoliage) -> Vec<[f64; 2]> {
    // Etwa ein Bogen je 0.9 m Umfang, 7 bis 28.
    let n = ((std::f64::consts::TAU * r / 0.9).round() as usize).clamp(7, 28);
    let tau = std::f64::consts::TAU;
    let at = |t: f64, rr: f64| [c[0] + rr * crate::jsnum::cos(t), c[1] + rr * crate::jsnum::sin(t)];
    if foliage == TreeFoliage::Conifer {
        (0..2 * n).map(|i| at(i as f64 / (2 * n) as f64 * tau, if i % 2 == 0 { r } else { 0.8 * r })).collect()
    } else {
        let k = 6;
        (0..n * k)
            .map(|i| {
                let t = i as f64 / (n * k) as f64 * tau;
                let s = crate::jsnum::sin(t * n as f64 / 2.0).abs();
                at(t, r * (0.88 + 0.12 * s))
            })
            .collect()
    }
}

/// Strichfarbe eines Baums im Grundriss.
fn ink(t: &Tree, cat: Option<&LayerCategory>) -> String {
    if let Some(c) = t.color.as_deref().filter(|c| !c.is_empty()) {
        return c.to_string();
    }
    match t.status {
        TreeStatus::New => NEW_COLOR.into(),
        TreeStatus::Remove => REMOVE_COLOR.into(),
        _ => cat.map(|k| k.color.as_str()).filter(|c| !c.is_empty()).unwrap_or(MONO_INK).to_string(),
    }
}

/// Baum-Symbole des Grundrisses (Bäume dieses Geschosses mit sichtbarer Ebene).
pub(super) fn plan_trees(c: &Ctx, out: &mut Vec<Primitive>) {
    let p = c.p;
    let Some(trees) = p.trees.as_deref() else { return };
    if trees.iter().all(|t| t.floor_id != c.a.floor) {
        return;
    }
    for (i, g) in crate::tree::geoms(p) {
        let t = &trees[i];
        if t.floor_id != c.a.floor || !c.vis(&t.category_code, &t.id) {
            continue;
        }
        let greyed = Some(c.greyed(&t.category_code));
        let from = out.len();
        out.extend(tree_symbol(t, &g, c.cat(&t.category_code), greyed));
        // [271] Umbaufilter: der Baum in der Farbe seines Status (Bestand grau, Fällen gelb gestrichelt, Neu rot).
        if let Some(st) = c.renovation().and_then(|r| r.styled.get(&t.id)) {
            crate::renovation::restyle_linework(out, from, st, true);
        }
    }
}

/// [149] Ist `q` ein Planzeichen eines Baums (Kronenlinien, Kreuz, Pick-Fläche)? Der Stamm-Kreis zählt nicht dazu.
pub(super) fn is_symbol_part(q: &Primitive) -> bool {
    match q {
        Primitive::Line { cls, .. } => cls == "tree-crown" || cls == "tree-remove",
        Primitive::Polygon { context_object_id: Some(id), .. } => id.starts_with(TREE_PICK_PREFIX),
        _ => false,
    }
}

/// [149] Art-Beschriftungen der Bäume dieses Geschosses (`showLabel`), nach allem anderen Planinhalt gesetzt: Sie
/// weichen `obst` (Masse, Stempel, Höhenlinien-Beschriftungen, Wände, Stützen, Treppen …, ohne Baum-Planzeichen),
/// den Kronen anderer Bäume und den schon gesetzten Beschriftungen aus. Reihenfolge der Lagen: rechts neben dem
/// Stamm (wie bisher), dann rechts, links, über und unter der Krone; die erste mit Luft (0.5 mm Papier) gewinnt,
/// sonst die freieste. Mit Griff verschobene Beschriftungen (`labelOffset`) bleiben, wo der Mensch sie hingelegt hat.
pub(super) fn plan_tree_labels(c: &Ctx, obst: &super::stamp_place::Obstacles, out: &mut Vec<Primitive>) {
    use super::stamp_place::Obstacles;
    let p = c.p;
    let Some(trees) = p.trees.as_deref() else { return };
    let scale = c.a.scale;
    if !(scale > 0.0) || !scale.is_finite() || trees.iter().all(|t| t.floor_id != c.a.floor || t.show_label != Some(true)) {
        return;
    }
    // Sichtbare Bäume dieses Geschosses mit Kronenring (Hindernis für die Beschriftungen anderer Bäume).
    let items: Vec<(&Tree, TreeGeom, Obstacles)> = crate::tree::geoms(p)
        .into_iter()
        .filter_map(|(i, g)| {
            let t = &trees[i];
            if t.floor_id != c.a.floor || !c.vis(&t.category_code, &t.id) {
                return None;
            }
            let mut o = Obstacles::default();
            let ring = crown_outline(g.c, g.crown_r, t.foliage);
            for k in 0..ring.len() {
                o.seg(ring[k], ring[(k + 1) % ring.len()]);
            }
            Some((t, g, o))
        })
        .collect();
    let mm = scale / 1000.0;
    let (gap, clear_min) = (1.0 * mm, 0.5 * mm);
    let mut placed = Obstacles::default();
    for (n, (t, g, _)) in items.iter().enumerate() {
        let greyed = Some(c.greyed(&t.category_code));
        let Some(label) = tree_label(t, g, scale, greyed) else { continue };
        let Primitive::Text { at, doc, .. } = &label else { continue };
        let (w, h) = crate::text_layout::stamp_block_size(doc, &[], label_pt(scale), crate::text_layout::PT_TO_MM * mm);
        let (hw, hh) = (w / 2.0 + 0.3 * mm, h / 2.0 + 0.3 * mm);
        let mut spot = *at;
        if t.label_offset.is_none() {
            let (cx, cy, r) = (g.c[0], g.c[1], g.crown_r);
            let cands = [*at, v(cx + r + gap + hw, cy), v(cx - r - gap - hw, cy), v(cx, cy + r + gap + hh), v(cx, cy - r - gap - hh)];
            // Nur Kronen naher Bäume zählen.
            let reach = r + w + h;
            let near: Vec<&Obstacles> = items.iter().enumerate().filter(|(m, (_, o, _))| *m != n && (o.c[0] - cx).hypot(o.c[1] - cy) < reach + o.crown_r).map(|(_, (_, _, k))| k).collect();
            let free = |q: Vec2| -> f64 {
                let mut d = obst.clearance(q, hw, hh).min(placed.clearance(q, hw, hh));
                for k in &near {
                    d = d.min(k.clearance(q, hw, hh));
                }
                d
            };
            let mut best: Option<(f64, Vec2)> = None;
            for q in cands {
                let d = free(q);
                if d >= clear_min {
                    best = Some((d, q));
                    break;
                }
                if best.is_none_or(|(b, _)| d > b) {
                    best = Some((d, q));
                }
            }
            if let Some((_, q)) = best {
                spot = q;
            }
        }
        placed.area(vec![[spot.x - hw, spot.y - hh], [spot.x + hw, spot.y - hh], [spot.x + hw, spot.y + hh], [spot.x - hw, spot.y + hh]]);
        let mut label = label;
        if let Primitive::Text { at, .. } = &mut label {
            *at = spot;
        }
        out.push(label);
    }
}

/// [149] Schrift der Baum-Beschriftung (pt): wie die Zusatzzeile des Raumstempels (0.8 × Stempelschrift,
/// ab 1:200 die kleine Stempelschrift).
pub fn label_pt(scale: f64) -> f64 {
    let base = if scale >= super::domains::ROOM_STAMP_SMALL_FROM { super::domains::ROOM_STAMP_SMALL_PT } else { super::domains::ROOM_STAMP_PT };
    0.8 * base
}

/// [149] Beschriftung mit dem Art-Namen (`showLabel` und `species` gesetzt): Tusche, rechts neben dem Stamm
/// (linker Rand 1 mm Papier neben dem Stamm, auf Stammhöhe zentriert).
pub fn tree_label(t: &Tree, g: &TreeGeom, scale: f64, greyed: Option<bool>) -> Option<Primitive> {
    let name = t.species.as_deref().map(str::trim).filter(|s| !s.is_empty())?;
    if t.show_label != Some(true) || !(scale > 0.0) || !scale.is_finite() {
        return None;
    }
    let doc = super::domains::doc_from_text(name);
    let pt = label_pt(scale);
    let (w, _) = crate::text_layout::stamp_block_size(&doc, &[], pt, crate::text_layout::PT_TO_MM * scale / 1000.0);
    // Linker Rand der Zeile: mit Griff verschoben (`labelOffset` ab Stammmitte), sonst 1 mm Papier rechts neben dem Stamm.
    let left = match t.label_offset.filter(|o| o.x.is_finite() && o.y.is_finite()) {
        Some(o) => [g.c[0] + o.x, g.c[1] + o.y],
        None => [g.c[0] + g.trunk_r + 1.0 * scale / 1000.0, g.c[1]],
    };
    let at = v(left[0] + w / 2.0, left[1]);
    Some(Primitive::Text { at, doc, extra_lines: vec![], base_pt: pt, color: MONO_INK.into(), room_id: None, greyed, opacity: None })
}

/// Planzeichen eines Baums (Grundriss): Pick-Fläche, Kronenumriss, Stamm, ggf. Kreuz.
pub fn tree_symbol(t: &Tree, g: &TreeGeom, cat: Option<&LayerCategory>, greyed: Option<bool>) -> Vec<Primitive> {
    let color = ink(t, cat);
    let ring = crown_outline(g.c, g.crown_r, t.foliage);
    let pts: Vec<Vec2> = ring.iter().map(|q| v(q[0], q[1])).collect();
    let mut out = vec![poly(pts.clone(), "none", "none", 0.0, Some(pick_id(&t.id)), greyed)];
    let remove = t.status == TreeStatus::Remove;
    let dash = remove.then_some(&REMOVE_DASH[..]);
    for k in 0..pts.len() {
        out.push(line(pts[k], pts[(k + 1) % pts.len()], "tree-crown", CROWN_MM, &color, dash, greyed));
    }
    let trunk: Vec<Vec2> = crate::tree::circle(g.c, g.trunk_r, 16).into_iter().map(|q| v(q[0], q[1])).collect();
    let fill = if t.status == TreeStatus::New { "#ffffff".to_string() } else { color.clone() };
    out.push(poly(trunk, &fill, &color, TRUNK_MM, None, greyed));
    if remove {
        let d = g.crown_r * 0.9 * std::f64::consts::FRAC_1_SQRT_2;
        let (x, y) = (g.c[0], g.c[1]);
        out.push(line(v(x - d, y - d), v(x + d, y + d), "tree-remove", CROWN_MM, &color, None, greyed));
        out.push(line(v(x - d, y + d), v(x + d, y - d), "tree-remove", CROWN_MM, &color, None, greyed));
    }
    out
}

/// Bäume in Schnitt/Ansicht: je Baum (Tiefe der Stammmitte, Silhouette: Krone + Stamm). Nur Bäume vor der
/// Blickrichtung (Mitte höchstens einen Kronenradius vor der Ebene) und innerhalb der Ansichtstiefe.
/// `fill`: Kronenfüllung (`None` = transparent). `cut`: Schnitt (`Some(mono)`) statt Ansicht — Bäume, die die
/// Ebene trifft, erscheinen geschnitten: Kronen- und Stammquerschnitt mit Schnittstärke, davor liegende Teile
/// entfallen (Mitte vor der Ebene: nur der Querschnitt als Umriss des Teils dahinter), Teile dahinter bleiben als
/// Silhouette.
pub fn view_trees(p: &Project, level: &LevelSpec, vis: &Visibility, fill: Option<&str>, cut: Option<bool>, ren: Option<&crate::renovation::Resolved>) -> Vec<(f64, Vec<Primitive>)> {
    view_trees_in_front(p, level, vis, fill, cut, ren, None)
}

/// Wie [`view_trees`]; `in_front(Tiefe der Stammmitte, [u0, v0, u1, v1] der Krone)`: liegt der Baum vor Bauteilen, die
/// er überdeckt (Ansicht), bleibt die Krone ohne Füllung — die Fassade dahinter bleibt sichtbar, der Baum zeichnet als
/// Umriss darüber (Planpraxis); der Stamm behält seine Füllung.
pub fn view_trees_in_front(p: &Project, level: &LevelSpec, vis: &Visibility, fill: Option<&str>, cut: Option<bool>, ren: Option<&crate::renovation::Resolved>, in_front: Option<&dyn Fn(f64, [f64; 4]) -> bool>) -> Vec<(f64, Vec<Primitive>)> {
    let Some(trees) = p.trees.as_deref().filter(|t| !t.is_empty()) else { return vec![] };
    let Some(plane) = level.plane() else { return vec![] };
    let [nx, _, nz] = plane.normal;
    let nl = nx.hypot(nz);
    if !(nl > 0.0) {
        return vec![];
    }
    // Welt (x, Höhe, y): Ebene durch (p0.x, ·, p0.y); u = Blick-Rechts wie `elevation::frame_of`.
    let (nx, nz) = (nx / nl, nz / nl);
    let (ux, uz) = (nz, -nx);
    let (px, pz) = (plane.point[0], plane.point[2]);
    let mut out = Vec::new();
    for (i, g) in crate::tree::geoms(p) {
        let t = &trees[i];
        if vis.has_vis && !vis.visible(&t.category_code) || vis.has_display && !vis.render(&t.category_code) {
            continue;
        }
        let (rx, rz) = (g.c[0] - px, g.c[1] - pz);
        let depth = rx * nx + rz * nz;
        if depth < -g.crown_r || level.depth.is_some_and(|d| d > 0.0 && depth - g.crown_r > d) {
            continue;
        }
        let s = rx * ux + rz * uz;
        let (crown, trunk) = g.silhouette(s, 24);
        let greyed = Some(vis.has_display && vis.greyed(&t.category_code));
        let pick = Some(pick_id(&t.id));
        let to = |r: &[[f64; 2]]| r.iter().map(|q| v(q[0], q[1])).collect::<Vec<Vec2>>();
        let stroke = t.color.as_deref().filter(|c| !c.is_empty()).unwrap_or(VIEW_INK);
        let trunk_fill = fill.map(|f| if f == "#ffffff" { f } else { VIEW_TRUNK_FILL });
        let crown_bb = crown.iter().filter(|q| q[0].is_finite() && q[1].is_finite()).fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])]);
        let fill = if in_front.is_some_and(|f| f(depth, crown_bb)) { None } else { fill };
        let mut prims = Vec::new();
        // Stamm und Krone hinter der Ebene (Mitte hinter bzw. auf der Ebene) als ganze Silhouette; im Schnitt
        // entfällt, was vor der Ebene liegt.
        if cut.is_none() || depth >= 0.0 {
            prims.push(poly(to(&trunk), trunk_fill.unwrap_or("none"), stroke, VIEW_TRUNK_MM, pick.clone(), greyed));
        }
        if cut.is_none() || depth >= 0.0 {
            prims.push(poly(to(&crown), fill.unwrap_or("none"), stroke, VIEW_CROWN_MM, pick.clone(), greyed));
        }
        if let Some(mono) = cut {
            let (cc, ct) = g.cut_silhouette(s, depth, 24);
            if let Some(t) = ct {
                prims.push(poly(to(&t), if mono { "none" } else { VIEW_TRUNK_CUT_FILL }, stroke, VIEW_CUT_MM, pick.clone(), greyed));
            }
            if let Some(c) = cc {
                prims.push(poly(to(&c), if mono { "none" } else { VIEW_CROWN_CUT_FILL }, stroke, VIEW_CUT_MM, pick, greyed));
            }
        }
        // [271] Umbaufilter: Silhouette in der Linienfarbe des Status (Bestand grau, Fällen gelb gestrichelt, Neu rot).
        if let Some(st) = ren.and_then(|r| r.styled.get(&t.id)) {
            crate::renovation::restyle_linework(&mut prims, 0, st, false);
        }
        out.push((depth, prims));
    }
    out
}

/// [149] Bäume im Schnitt hinter der Ebene werden von allem verdeckt, was vor ihnen liegt: geschnittene Bauteile
/// (Tiefe 0) und Projektionsflächen (Wände, Decken, Dach, Körper), die ganz vor der senkrechten Ebene durch die
/// Stammmitte des Baums liegen — dieselben Verdecker wie die Projektionskanten (`hlr`, `Output::occluders`).
/// Die Silhouette bleibt, wo nichts davor liegt (Gelände und Raum dahinter verdecken nicht, die Krone steht
/// frei); der Schnitt des Baums selbst (Schnittstärke) liegt in der Ebene und wird nicht verdeckt. Umrisse, die
/// teilweise verdeckt sind, werden zu Linien der sichtbaren Teile; die Pick-Fläche bleibt (`stroke: none`).
/// Unsinn (nicht endliche Punkte) lässt die Gruppe unverändert. `groups`: (Tiefe der Stammmitte, Primitive).
pub fn occlude_in_section(groups: Vec<(f64, Vec<Primitive>)>, occ: &[super::section::Occluder]) -> Vec<Primitive> {
    if occ.is_empty() {
        return groups.into_iter().flat_map(|(_, g)| g).collect();
    }
    // Alle Strecken der Gruppen in einem Aufruf; `owner` = Index in `slots`.
    let mut segs = vec![0.0];
    let mut slots: Vec<(usize, usize)> = Vec::new(); // (Gruppe, Primitiv)
    let mut ranges: Vec<std::ops::Range<usize>> = Vec::new(); // Strecken je Slot
    let mut count = 0usize;
    for (gi, (d, g)) in groups.iter().enumerate() {
        for (pi, q) in g.iter().enumerate() {
            let (pts, closed, w): (Vec<Vec2>, bool, f64) = match q {
                Primitive::Polygon { pts, fill, stroke, stroke_width_mm, .. } if fill == "none" && stroke != "none" && pts.len() >= 3 => (pts.clone(), true, *stroke_width_mm),
                Primitive::Line { a, b, weight_mm, .. } => (vec![*a, *b], false, *weight_mm),
                _ => continue,
            };
            if !pts.iter().all(|q| q.x.is_finite() && q.y.is_finite()) || !d.is_finite() {
                continue;
            }
            // Der Schnitt liegt in der Ebene (Tiefe 0), der Rest in der Tiefe der Stammmitte.
            let depth = if (w - VIEW_CUT_MM).abs() < 1e-9 { 0.0 } else { *d };
            let n = if closed { pts.len() } else { 1 };
            let from = count;
            for i in 0..n {
                let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                segs.extend([a.x, a.y, b.x, b.y, depth]);
                count += 1;
            }
            slots.push((gi, pi));
            ranges.push(from..count);
        }
    }
    // [327] Nichts zu verdecken (kein Baum, keine Entourage im Schnitt): die Verdecker gar nicht erst aufbereiten.
    if count == 0 {
        return groups.into_iter().flat_map(|(_, g)| g).collect();
    }
    segs[0] = count as f64;
    let mut flat = vec![occ.len() as f64];
    for o in occ {
        flat.extend([o.depth, o.pts.len() as f64]);
        for q in &o.pts {
            flat.extend(q);
        }
    }
    let res = super::elevation_geom::clip_segments(&flat, &segs);
    // Ergebnis je Strecke: [c, (ax, ay, bx, by) × c]; leer = Eingabe unbrauchbar, nichts verdecken.
    let mut parts: Vec<Vec<(Vec2, Vec2)>> = Vec::new();
    if res.len() > 1 && res[0] as usize == count {
        let mut i = 1;
        for _ in 0..count {
            let c = res[i] as usize;
            i += 1;
            parts.push((0..c).map(|k| (v(res[i + 4 * k], res[i + 4 * k + 1]), v(res[i + 4 * k + 2], res[i + 4 * k + 3]))).collect());
            i += 4 * c;
        }
    }
    let mut out = Vec::new();
    let mut slot = 0usize;
    for (gi, (_, g)) in groups.into_iter().enumerate() {
        for (pi, q) in g.into_iter().enumerate() {
            if slots.get(slot) != Some(&(gi, pi)) || parts.is_empty() {
                out.push(q);
                continue;
            }
            let r = ranges[slot].clone();
            slot += 1;
            let whole = r.clone().all(|k| parts[k].len() == 1 && {
                let (s, e) = (segs[1 + 5 * k..3 + 5 * k].to_vec(), segs[3 + 5 * k..5 + 5 * k].to_vec());
                let (a, b) = parts[k][0];
                (a.x - s[0]).abs() + (a.y - s[1]).abs() + (b.x - e[0]).abs() + (b.y - e[1]).abs() < 1e-9
            });
            if whole {
                out.push(q);
                continue;
            }
            match q {
                Primitive::Polygon { pts, stroke, stroke_width_mm, greyed, context_object_id, drawing_id, .. } => {
                    // [253] Entourage trägt die Id ihrer Zeichnung (Pick), der Baum die seine über `context_object_id`.
                    let mut pick = poly(pts, "none", "none", 0.0, context_object_id, greyed);
                    if let Primitive::Polygon { drawing_id: d, .. } = &mut pick {
                        d.clone_from(&drawing_id);
                    }
                    out.push(pick);
                    for k in r {
                        for (a, b) in &parts[k] {
                            let mut l = line(*a, *b, "tree-view", stroke_width_mm, &stroke, None, greyed);
                            if let Primitive::Line { drawing_id: d, .. } = &mut l {
                                d.clone_from(&drawing_id);
                            }
                            out.push(l);
                        }
                    }
                }
                Primitive::Line { cls, weight_mm, dash, color, greyed, .. } => {
                    for (a, b) in &parts[r.start] {
                        let mut l = line(*a, *b, &cls, weight_mm, color.as_deref().unwrap_or(VIEW_INK), None, greyed);
                        if let Primitive::Line { dash: d, .. } = &mut l {
                            d.clone_from(&dash);
                        }
                        out.push(l);
                    }
                }
                other => out.push(other),
            }
        }
    }
    out
}

/// Ausmass `bounds` vereinigt mit den Polygon-Ecken von `prims` (Silhouetten in Schnitt/Ansicht).
pub fn union_bounds(bounds: [f64; 4], prims: &[Primitive]) -> [f64; 4] {
    let mut b = bounds;
    for q in prims {
        if let Primitive::Polygon { pts, .. } = q {
            for v in pts.iter().filter(|v| v.x.is_finite() && v.y.is_finite()) {
                b = [b[0].min(v.x), b[1].min(v.y), b[2].max(v.x), b[3].max(v.y)];
            }
        }
    }
    b
}

/// Füllung der Krone in der Ansicht.
pub fn view_crown_fill(mono: bool) -> &'static str {
    if mono {
        "#ffffff"
    } else {
        VIEW_CROWN_FILL
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::domains::{plan_domains, PlanArgs};

    fn project(trees: serde_json::Value) -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "P", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
            "drawingLevels": [
                {"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "cutHeight": 1.0, "baseElevation": 0},
                {"id": "an", "name": "Ansicht Süd", "kind": "elevation", "visible": true, "locked": false, "floorHeight": 3.0, "linePoints": [{"x": -20, "y": -10}, {"x": 20, "y": -10}]},
                {"id": "sc", "name": "Schnitt A", "kind": "section", "visible": true, "locked": false, "floorHeight": 3.0, "linePoints": [{"x": -20, "y": 0}, {"x": 20, "y": 0}]}
            ],
            "layers": [{"code": "13", "name": "Bäume", "color": "#000000", "lw": 0.13, "visible": true, "locked": false}],
            "walls": [], "openings": [], "drawings2d": [], "trees": trees
        }))
        .unwrap()
    }

    /// Ohne den Schnitt A (dessen Linie sonst im Grundriss liegt).
    fn plan_project(trees: serde_json::Value) -> Project {
        let mut p = project(trees);
        p.drawing_levels.retain(|l| l.id != "sc");
        p
    }

    fn tree(id: &str, x: f64, status: &str, foliage: &str) -> serde_json::Value {
        serde_json::json!({"id": id, "type": "tree", "floorId": "eg", "categoryCode": "13", "position": {"x": x, "y": 0},
            "trunkDiameter": 0.4, "crownDiameter": 6, "crownBase": 3, "height": 12, "shape": "round", "status": status, "foliage": foliage})
    }

    fn plan(p: &Project, codes: &[&str]) -> Vec<Primitive> {
        let text = serde_json::json!({"floor": "eg", "show": codes, "global": true}).to_string();
        let a = PlanArgs::parse(1.0, &text).unwrap();
        plan_domains(p, &a).unwrap().columns
    }

    /// [149] Art-Name als Beschriftung: nur mit `showLabel` und Art, Tusche, rechts neben dem Stamm, Schrift wie
    /// die Zusatzzeile des Raumstempels.
    #[test]
    fn beschriftung_mit_art_name() {
        let mut t = tree("a", 0.0, "new", "deciduous");
        t["species"] = serde_json::json!("Quercus robur");
        let texts = |p: &Project| plan(p, &["13"]).into_iter().filter(|q| matches!(q, Primitive::Text { .. })).collect::<Vec<_>>();
        assert!(texts(&plan_project(serde_json::json!([t.clone()]))).is_empty(), "ohne showLabel keine Beschriftung");
        t["showLabel"] = serde_json::json!(true);
        let got = texts(&plan_project(serde_json::json!([t.clone()])));
        assert_eq!(got.len(), 1);
        let Primitive::Text { at, doc, base_pt, color, room_id, .. } = &got[0] else { unreachable!() };
        assert_eq!(crate::text_layout::plain_text(doc), "Quercus robur");
        assert_eq!((color.as_str(), room_id.is_none()), (MONO_INK, true));
        assert!((base_pt - 8.0).abs() < 1e-9, "1:100: 0.8 × 10 pt");
        assert!(at.x > 0.2 && at.x < 3.0 && at.y.abs() < 1e-9, "rechts neben dem Stamm: {at:?}");
        assert!((label_pt(200.0) - 5.6).abs() < 1e-9);
        // Mit Griff verschoben ([149]): linker Rand der Zeile an Stamm + Versatz, Textmitte um die halbe Breite rechts.
        // Standard: linker Rand 0.2 m (Stamm) + 0.1 m (1 mm bei 1:100) rechts der Stammmitte.
        let half_w = at.x - 0.3;
        assert!(half_w > 0.0);
        t["labelOffset"] = serde_json::json!({"x": -2.0, "y": 3.0});
        let got = texts(&plan_project(serde_json::json!([t.clone()])));
        let Primitive::Text { at: moved, .. } = &got[0] else { unreachable!() };
        assert!((moved.y - 3.0).abs() < 1e-9 && (moved.x - (-2.0 + half_w)).abs() < 1e-9, "{moved:?}");
        t.as_object_mut().unwrap().remove("labelOffset");
        t["species"] = serde_json::json!("  ");
        assert!(texts(&plan_project(serde_json::json!([t]))).is_empty(), "ohne Art keine Beschriftung");
    }

    #[test]
    fn planzeichen_nach_bestand_und_laub() {
        let p = plan_project(serde_json::json!([tree("a", 0.0, "existing", "deciduous"), tree("b", 10.0, "new", "conifer"), tree("c", 20.0, "remove", "deciduous")]));
        let prims = plan(&p, &["13"]);
        let pick = |id: &str| prims.iter().filter(|q| matches!(q, Primitive::Polygon { context_object_id: Some(c), .. } if *c == pick_id(id))).count();
        assert_eq!((pick("a"), pick("b"), pick("c")), (1, 1, 1));
        let lines = |color: &str, dashed: bool| prims.iter().filter(|q| matches!(q, Primitive::Line { color: Some(c), dash, .. } if c == color && dash.is_some() == dashed)).count();
        // Bestehend: Tusche, durchgezogen; neu: rot; zu fällen: gelb, gestrichelt + 2 Kreuzlinien.
        assert!(lines("#000000", false) > 20);
        assert!(lines(NEW_COLOR, false) > 10);
        assert!(lines(REMOVE_COLOR, true) > 20 && lines(REMOVE_COLOR, false) == 2);
        // Stamm: gefüllt (bestehend) bzw. weiss (neu).
        let trunk_fill = |color: &str| prims.iter().filter(|q| matches!(q, Primitive::Polygon { fill, stroke, .. } if stroke == color && fill != "none")).map(|q| if let Primitive::Polygon { fill, .. } = q { fill.clone() } else { String::new() }).collect::<Vec<_>>();
        assert_eq!(trunk_fill("#000000"), vec!["#000000".to_string()]);
        assert_eq!(trunk_fill(NEW_COLOR), vec!["#ffffff".to_string()]);
        // Kronenumriss im Kronenradius (Wellenkranz zwischen 0.88 r und r).
        if let Some(Primitive::Polygon { pts, .. }) = prims.iter().find(|q| matches!(q, Primitive::Polygon { context_object_id: Some(c), .. } if *c == pick_id("a"))) {
            let r: Vec<f64> = pts.iter().map(|q| q.x.hypot(q.y)).collect();
            assert!(r.iter().all(|&x| x <= 3.0 + 1e-9 && x >= 0.88 * 3.0 - 1e-9));
        }
        // Ausgeblendete Ebene: nichts.
        assert!(plan(&p, &["20"]).is_empty());
    }

    #[test]
    fn silhouette_in_der_ansicht() {
        let p = project(serde_json::json!([tree("a", 0.0, "existing", "deciduous"), tree("hinten", 5.0, "existing", "deciduous")]));
        let l = p.drawing_levels.iter().find(|l| l.id == "an").unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let (prims, _) = crate::plan::elevation::elevation_primitives(&p, &level, false, true, &Visibility::default(), 100.0).unwrap().unwrap();
        let crowns: Vec<&Primitive> = prims.iter().filter(|q| matches!(q, Primitive::Polygon { context_object_id: Some(c), pts, .. } if *c == pick_id("a") && pts.len() > 4)).collect();
        assert_eq!(crowns.len(), 1);
        if let Primitive::Polygon { pts, .. } = crowns[0] {
            let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
            let (mut zl, mut zh) = (f64::INFINITY, f64::NEG_INFINITY);
            for q in pts {
                lo = lo.min(q.x);
                hi = hi.max(q.x);
                zl = zl.min(q.y);
                zh = zh.max(q.y);
            }
            assert!((hi - lo - 6.0).abs() < 1e-6 && (zl - 3.0).abs() < 1e-9 && (zh - 12.0).abs() < 1e-9, "{lo} {hi} {zl} {zh}");
        }
    }

    fn tree_at(id: &str, x: f64, y: f64) -> serde_json::Value {
        let mut t = tree(id, x, "existing", "deciduous");
        t["position"] = serde_json::json!({"x": x, "y": y});
        t
    }

    /// Polygone mit Pick-Id und Strichstärke aus `view_trees` im Schnitt A (Linie y = 0, Blick nach +y).
    fn section_polys(p: &Project, id: &str) -> Vec<(f64, Vec<Vec2>)> {
        let l = p.drawing_levels.iter().find(|l| l.id == "sc").unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        view_trees(p, &level, &Visibility::default(), None, Some(false), None)
            .into_iter()
            .flat_map(|(_, ps)| ps)
            .filter_map(|q| match q {
                Primitive::Polygon { pts, stroke_width_mm, context_object_id: Some(c), .. } if c == pick_id(id) => Some((stroke_width_mm, pts)),
                _ => None,
            })
            .collect()
    }

    /// [149] Schnitt durch die Krone: trifft die Ebene den Baum, entsteht ein Querschnitt (Sehne) mit Schnittstärke;
    /// vor der Ebene entfällt der Rest, dahinter bleibt die ganze Silhouette.
    #[test]
    fn schnitt_durch_die_krone() {
        let width = |pts: &[Vec2]| pts.iter().map(|q| q.x).fold(f64::NEG_INFINITY, f64::max) - pts.iter().map(|q| q.x).fold(f64::INFINITY, f64::min);
        let p = project(serde_json::json!([tree_at("mitte", 0.0, 0.0), tree_at("vorn", 10.0, -2.0), tree_at("hinten", 20.0, 1.0), tree_at("weit", 30.0, 2.9), tree_at("frei", 40.0, -4.0)]));
        // Mitte auf der Ebene: Sehne = ganze Krone (6 m, Kugel), Stamm 0.4 m; dazu die ganze Silhouette dahinter.
        let m = section_polys(&p, "mitte");
        assert_eq!(m.len(), 4, "Stamm + Krone dahinter, Stamm + Krone geschnitten");
        let cut: Vec<_> = m.iter().filter(|(w, _)| (*w - VIEW_CUT_MM).abs() < 1e-9).collect();
        assert_eq!(cut.len(), 2);
        assert!(cut.iter().any(|(_, pts)| (width(pts) - 6.0).abs() < 1e-6) && cut.iter().any(|(_, pts)| (width(pts) - 0.4).abs() < 1e-6));
        // Mitte 2 m vor der Ebene: nur der Querschnitt (Sehne 2 sqrt(9 - 4)), kein Stamm, keine Silhouette.
        let v = section_polys(&p, "vorn");
        assert_eq!(v.len(), 1);
        assert!((width(&v[0].1) - 2.0 * 5f64.sqrt()).abs() < 0.05, "{}", width(&v[0].1));
        assert!((v[0].0 - VIEW_CUT_MM).abs() < 1e-9);
        // Mitte 1 m hinter der Ebene: Silhouette + Sehne (2 sqrt(9 - 1)), Stamm ganz dahinter, nicht geschnitten.
        let h = section_polys(&p, "hinten");
        assert_eq!(h.len(), 3);
        assert!(h.iter().any(|(w, pts)| (*w - VIEW_CUT_MM).abs() < 1e-9 && (width(pts) - 2.0 * 8f64.sqrt()).abs() < 0.05));
        assert!(h.iter().any(|(w, pts)| (*w - VIEW_CROWN_MM).abs() < 1e-9 && (width(pts) - 6.0).abs() < 1e-6));
        // Krone knapp berührt (Abstand 2.9 < 3): Silhouette, Stamm und kleine Sehne; Baum 4 m vor der Ebene: nichts.
        assert_eq!(section_polys(&p, "weit").len(), 3);
        assert!(section_polys(&p, "frei").is_empty());
        // Ansicht unverändert: ganze Silhouette, keine Schnittstärke.
        let l = p.drawing_levels.iter().find(|l| l.id == "an").unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let ps = view_trees(&p, &level, &Visibility::default(), None, None, None);
        assert!(ps.iter().flat_map(|(_, ps)| ps).all(|q| !matches!(q, Primitive::Polygon { stroke_width_mm, .. } if *stroke_width_mm == VIEW_CUT_MM)));
    }

    /// [149] Art-Beschriftung weicht aus: ohne Hindernis rechts neben dem Stamm (wie bisher); ein Nachbarstamm oder
    /// eine andere Beschriftung schiebt sie an die nächste freie Lage.
    #[test]
    fn beschriftung_weicht_hindernissen_aus() {
        let labelled = |x: f64, y: f64, id: &str, name: &str| {
            let mut t = tree_at(id, x, y);
            t["species"] = serde_json::json!(name);
            t["showLabel"] = serde_json::json!(true);
            t
        };
        let texts = |p: &Project| -> Vec<(Vec2, f64)> {
            plan(p, &["13", "20"])
                .into_iter()
                .filter_map(|q| match q {
                    Primitive::Text { at, doc, base_pt, .. } => Some((at, crate::text_layout::stamp_block_size(&doc, &[], base_pt, crate::text_layout::PT_TO_MM / 1000.0).0)),
                    _ => None,
                })
                .collect()
        };
        let free = texts(&plan_project(serde_json::json!([labelled(0.0, 0.0, "a", "Quercus robur")])));
        assert_eq!(free.len(), 1);
        assert!(free[0].0.x > 0.2 && free[0].0.y.abs() < 1e-9, "{:?}", free[0].0);
        // Zwei beschriftete Bäume nebeneinander: die Beschriftungen überlappen nicht.
        let two = texts(&plan_project(serde_json::json!([labelled(0.0, 0.0, "a", "Quercus robur"), labelled(2.0, 0.0, "b", "Acer platanoides")])));
        assert_eq!(two.len(), 2);
        let ov = |a: &(Vec2, f64), b: &(Vec2, f64)| (a.0.x - b.0.x).abs() < (a.1 + b.1) / 2.0 && (a.0.y - b.0.y).abs() < 0.3;
        assert!(!ov(&two[0], &two[1]), "{two:?}");
        // Nachbarstamm (x = 1.2, r 0.2) rechts neben dem Stamm: die Beschriftung liegt nicht darauf.
        let b = texts(&plan_project(serde_json::json!([labelled(0.0, 0.0, "a", "Quercus robur"), tree_at("n", 1.2, 0.0)])));
        assert_eq!(b.len(), 1);
        let hw = free[0].1 / 2.0;
        assert!(b[0].0.x + hw < 1.0 || b[0].0.x - hw > 1.4 || b[0].0.y.abs() > 0.5, "Label auf dem Nachbarstamm: {:?}", b[0].0);
    }
}

#[cfg(test)]
#[path = "trees_tests.rs"]
mod verdeckung_tests;
