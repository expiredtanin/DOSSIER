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
/// Füllung des Stamms in der farbigen Ansicht.
const VIEW_TRUNK_FILL: &str = "#d8cbb8";

fn v(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Pick-Id eines Baums (Feld `contextObjectId`).
pub fn pick_id(id: &str) -> String {
    format!("{TREE_PICK_PREFIX}{id}")
}

fn poly(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, pick: Option<String>, greyed: Option<bool>) -> Primitive {
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

fn line(a: Vec2, b: Vec2, cls: &str, w: f64, color: &str, dash: Option<&[f64]>, greyed: Option<bool>) -> Primitive {
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
        out.extend(tree_symbol(t, &g, c.cat(&t.category_code), greyed));
        if let Some(l) = tree_label(t, &g, c.a.scale, greyed) {
            out.push(l);
        }
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
/// `fill`: Kronenfüllung (`None` = transparent).
pub fn view_trees(p: &Project, level: &LevelSpec, vis: &Visibility, fill: Option<&str>) -> Vec<(f64, Vec<Primitive>)> {
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
        let prims = vec![
            poly(to(&trunk), trunk_fill.unwrap_or("none"), stroke, VIEW_TRUNK_MM, pick.clone(), greyed),
            poly(to(&crown), fill.unwrap_or("none"), stroke, VIEW_CROWN_MM, pick, greyed),
        ];
        out.push((depth, prims));
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
                {"id": "an", "name": "Ansicht Süd", "kind": "elevation", "visible": true, "locked": false, "floorHeight": 3.0, "linePoints": [{"x": -20, "y": -10}, {"x": 20, "y": -10}]}
            ],
            "layers": [{"code": "13", "name": "Bäume", "color": "#000000", "lw": 0.13, "visible": true, "locked": false}],
            "walls": [], "openings": [], "drawings2d": [], "trees": trees
        }))
        .unwrap()
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
        assert!(texts(&project(serde_json::json!([t.clone()]))).is_empty(), "ohne showLabel keine Beschriftung");
        t["showLabel"] = serde_json::json!(true);
        let got = texts(&project(serde_json::json!([t.clone()])));
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
        let got = texts(&project(serde_json::json!([t.clone()])));
        let Primitive::Text { at: moved, .. } = &got[0] else { unreachable!() };
        assert!((moved.y - 3.0).abs() < 1e-9 && (moved.x - (-2.0 + half_w)).abs() < 1e-9, "{moved:?}");
        t.as_object_mut().unwrap().remove("labelOffset");
        t["species"] = serde_json::json!("  ");
        assert!(texts(&project(serde_json::json!([t]))).is_empty(), "ohne Art keine Beschriftung");
    }

    #[test]
    fn planzeichen_nach_bestand_und_laub() {
        let p = project(serde_json::json!([tree("a", 0.0, "existing", "deciduous"), tree("b", 10.0, "new", "conifer"), tree("c", 20.0, "remove", "deciduous")]));
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
}
