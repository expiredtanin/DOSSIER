//! Fälle der früheren TS-Tests (`toSection.boolean/monolith/termination/depth/roof/layerOverride/
//! orientation`, `generateSectionPlan.category/select`), jetzt gegen die Kern-Fassung.

use super::*;

fn band(u0: f64, u1: f64, v0: f64, v1: f64, jp: Option<f64>, tag: &str) -> Cut {
    let mut c = Cut::new(Kind::Wall, 0, vec![[u0, v1], [u1, v1], [u1, v0], [u0, v0]]);
    c.fill = Some(tag.into());
    c.join_priority = jp;
    c
}

fn ring_area(pts: &[[f64; 2]]) -> f64 {
    pts.iter().enumerate().map(|(i, a)| { let c = pts[(i + 1) % pts.len()]; a[0] * c[1] - c[0] * a[1] }).sum::<f64>().abs() / 2.0
}

/// [G6] Schräges Band hoher Priorität (Parallelogramm) schneidet nur, wo es wirklich überlappt — nicht
/// sein umgebendes Rechteck.
#[test]
fn schraeges_band_schneidet_nur_seine_flaeche() {
    let mut roof = Cut::new(Kind::Roof, 1, vec![[0.0, 2.0], [4.0, 4.0], [4.0, 4.5], [0.0, 2.5]]);
    roof.join_priority = Some(100.0);
    roof.fill = Some("beton".into());
    // Putzband unten links: berührt das Dach-Rechteck (bbox v 2..4.5), nicht aber das Dach selbst.
    let out = subtract_dominant_bands(vec![band(3.0, 4.0, 0.0, 2.9, Some(10.0), "putz"), roof]);
    let putz: Vec<&Cut> = out.iter().filter(|c| c.fill.as_deref() == Some("putz")).collect();
    assert_eq!(putz.len(), 1);
    assert!((ring_area(&putz[0].pts) - 2.9).abs() < 1e-6, "{:?}", putz[0].pts);
}

/// [G6] Schräges Band niedriger Priorität behält beim Beschneiden seine Schräge (kein Rechteck-Ersatz).
#[test]
fn schraeges_band_behaelt_schraege() {
    let mut roof = Cut::new(Kind::Roof, 1, vec![[0.0, 2.0], [4.0, 4.0], [4.0, 4.5], [0.0, 2.5]]);
    roof.join_priority = Some(10.0);
    roof.fill = Some("daemmung".into());
    let out = subtract_dominant_bands(vec![roof, band(1.0, 2.0, 0.0, 5.0, Some(100.0), "beton")]);
    let d: Vec<&Cut> = out.iter().filter(|c| c.fill.as_deref() == Some("daemmung")).collect();
    assert_eq!(d.len(), 2, "links und rechts der Stütze");
    // Fläche: Parallelogramm 4 × 0.5 = 2.0, minus der Streifen 1..2 (0.5) = 1.5; Stücke nicht rechteckig.
    assert!((d.iter().map(|c| ring_area(&c.pts)).sum::<f64>() - 1.5).abs() < 1e-6);
    assert!(d.iter().all(|c| !is_axis_rect(&c.pts)));
}

fn cband(u0: f64, u1: f64, v0: f64, v1: f64, jp: f64, comp: &str, tag: &str) -> Cut {
    Cut { component_id: Some(comp.into()), ..band(u0, u1, v0, v1, Some(jp), tag) }
}

fn area(items: &[&Cut]) -> f64 {
    items.iter().map(|c| {
        let b = bbox(&c.pts);
        (b[1] - b[0]) * (b[3] - b[2])
    }).sum()
}

fn by<'a>(out: &'a [Cut], tag: &str) -> Vec<&'a Cut> {
    out.iter().filter(|c| c.fill.as_deref() == Some(tag)).collect()
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn dominanz_stärkere_schicht_schneidet_schwächere() {
    let out = subtract_dominant_bands(vec![band(0.0, 2.0, 0.0, 3.0, Some(10.0), "putz"), band(0.0, 2.0, 2.0, 4.0, Some(100.0), "beton")]);
    assert_eq!(bbox(&by(&out, "beton")[0].pts), [0.0, 2.0, 2.0, 4.0]);
    let putz = by(&out, "putz");
    assert_eq!(putz.len(), 1);
    assert_eq!(bbox(&putz[0].pts), [0.0, 2.0, 0.0, 2.0]);
}

#[test]
fn dominanz_gestaffelte_kette() {
    let out = subtract_dominant_bands(vec![
        band(0.0, 1.0, 3.0, 4.0, Some(100.0), "beton"),
        band(0.0, 1.0, 2.5, 3.5, Some(50.0), "backstein"),
        band(0.0, 1.0, 2.0, 3.0, Some(20.0), "daemmung"),
        band(0.0, 1.0, 0.0, 3.2, Some(10.0), "putz"),
    ]);
    assert!(close(area(&by(&out, "beton")), 1.0));
    assert!(close(area(&by(&out, "backstein")), 0.5));
    assert!(close(area(&by(&out, "daemmung")), 0.5));
    assert!(close(area(&by(&out, "putz")), 2.0));
}

#[test]
fn dominanz_gleiche_prioritaet_und_ohne_prioritaet_koexistieren() {
    let out = subtract_dominant_bands(vec![band(0.0, 1.0, 0.0, 3.0, Some(100.0), "wand"), band(0.0, 1.0, 2.0, 4.0, Some(100.0), "decke")]);
    assert!(close(area(&by(&out, "wand")), 3.0) && close(area(&by(&out, "decke")), 2.0));
    let out = subtract_dominant_bands(vec![band(0.0, 2.0, 0.0, 2.0, Some(100.0), "stark"), band(0.0, 2.0, 0.0, 2.0, None, "ohne")]);
    assert!(close(area(&by(&out, "stark")), 4.0) && close(area(&by(&out, "ohne")), 4.0));
    let out = subtract_dominant_bands(vec![band(0.0, 3.0, 0.0, 3.0, Some(100.0), "stark"), band(1.0, 2.0, 1.0, 2.0, Some(10.0), "schwach")]);
    assert!(by(&out, "schwach").is_empty());
}

#[test]
fn verschmelzen_gleicher_komponente() {
    let out = subtract_dominant_bands(vec![cband(0.0, 1.0, 0.0, 3.0, 100.0, "beton", "wand"), cband(0.0, 1.0, 2.0, 4.0, 100.0, "beton", "decke")]);
    assert_eq!(out.len(), 1);
    assert_eq!(bbox(&out[0].pts), [0.0, 1.0, 0.0, 4.0]);
    let out = subtract_dominant_bands(vec![cband(0.0, 1.0, 0.0, 3.0, 100.0, "b", "u"), cband(0.0, 1.0, 3.0, 5.0, 100.0, "b", "o")]);
    assert_eq!(out.len(), 1);
    let out = subtract_dominant_bands(vec![cband(0.0, 1.0, 0.0, 3.0, 100.0, "w", "wand"), cband(0.0, 1.0, 2.0, 4.0, 100.0, "d", "decke")]);
    assert_eq!(out.len(), 2);
    let out = subtract_dominant_bands(vec![cband(0.0, 1.0, 0.0, 2.0, 10.0, "putz", "pu"), cband(0.0, 1.0, 2.0, 4.0, 10.0, "putz", "po"), cband(0.0, 1.0, 3.0, 5.0, 100.0, "beton", "beton")]);
    let putz: Vec<&Cut> = out.iter().filter(|c| c.component_id.as_deref() == Some("putz")).collect();
    assert_eq!(putz.len(), 1);
    assert_eq!(bbox(&putz[0].pts), [0.0, 1.0, 0.0, 3.0]);
    let out = subtract_dominant_bands(vec![cband(0.0, 2.0, 0.0, 2.0, 100.0, "x", "a"), cband(1.0, 3.0, 1.0, 3.0, 100.0, "x", "b")]);
    assert_eq!(out.len(), 2, "Eck-Überlapp verschmilzt nicht");
}

#[test]
fn monolith_tritte_zu_einem_saegezahn() {
    let rings = union_rect_outlines(&[[0.0, 1.0, 0.0, 0.2], [0.3, 1.0, 0.0, 0.4], [0.6, 1.0, 0.0, 0.6]]);
    assert_eq!(rings.len(), 1);
    assert!(rings[0].len() >= 8);
    assert_eq!(union_rect_outlines(&[[0.0, 1.0, 0.0, 1.0], [2.0, 3.0, 0.0, 1.0]]).len(), 2);
    let slab = |m: Option<&str>| RSlab { outline: vec![], z_bottom: 0.0, z_top: 1.0, color: [0.0; 3], ceiling_id: String::new(), hatch: None, cut: None, monolith: m.map(String::from), source: SlabSource::None };
    let slabs = vec![slab(None), slab(Some("ST1")), slab(Some("ST1"))];
    let mk = |i: usize, u0: f64| Cut::new(Kind::Slab, i, vec![[u0, 0.0], [u0 + 1.0, 0.0], [u0 + 1.0, 1.0], [u0, 1.0]]);
    let out = merge_monolith_cuts(vec![mk(0, 0.0), mk(1, 0.0), mk(2, 0.5)], &slabs, &HashMap::new());
    assert_eq!(out.len(), 2, "nur Bänder derselben Gruppe werden vereint");
}

fn wall(term: Option<SliceTermination>) -> Wall {
    Wall { id: "W".into(), slice_termination: term, ..Default::default() }
}

fn slab_band(u0: f64, u1: f64, v0: f64, v1: f64, jp: f64) -> Cut {
    Cut { kind: Kind::Slab, ..band(u0, u1, v0, v1, Some(jp), "decke") }
}

#[test]
fn terminierung_unter_und_ueber_der_decke() {
    let below = wall(Some(SliceTermination::Below));
    let above = wall(Some(SliceTermination::Above));
    let both = wall(None);
    let run = |w: &Wall, wb: Cut, sb: Cut| apply_wall_termination(vec![wb, sb], &[Some(w)]);
    let out = run(&below, band(0.0, 0.3, 0.0, 3.0, Some(10.0), "w"), slab_band(-1.0, 4.0, 2.6, 2.9, 100.0));
    assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.0, 2.6]);
    let out = run(&above, band(0.0, 0.3, 0.0, 3.0, Some(10.0), "w"), slab_band(-1.0, 4.0, 0.0, 0.3, 100.0));
    assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.3, 3.0]);
    let out = run(&both, band(0.0, 0.3, 0.0, 3.0, Some(10.0), "w"), slab_band(-1.0, 4.0, 2.6, 2.9, 100.0));
    assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.0, 3.0]);
    // nur strikt dominante Decken; ohne u-Überlapp (über 5 cm Anschluss hinaus) keine Terminierung
    let out = run(&below, band(0.0, 0.3, 0.0, 3.0, Some(10.0), "w"), slab_band(-1.0, 4.0, 2.6, 2.9, 10.0));
    assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.0, 3.0]);
    let out = run(&below, band(0.0, 0.3, 0.0, 3.0, Some(10.0), "w"), slab_band(1.0, 4.0, 2.6, 2.9, 100.0));
    assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.0, 3.0]);
    // ohne joinPriority unangetastet
    let out = run(&below, band(0.0, 0.3, 0.0, 3.0, None, "w"), slab_band(-1.0, 4.0, 2.6, 2.9, 100.0));
    assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.0, 3.0]);
}

/// [36] Ansichtsbereich im Schnitt: Bauteile ganz hinter der Tiefe entfallen in der Projektion, der
/// Schnitt selbst bleibt; ohne Tiefe unverändert.
#[test]
fn tiefe_blendet_ferne_bauteile_aus() {
    let wall = |id: &str, a: (f64, f64), b: (f64, f64), h: f64| Wall {
        id: id.into(),
        start: Vec2 { x: a.0, y: a.1 },
        end: Vec2 { x: b.0, y: b.1 },
        height: h,
        ..Default::default()
    };
    let mut p = Project::default();
    // quer: von der Ebene geschnitten und weit nach hinten; nah: 3 m, fern: 10 m hinter der Ebene (höher).
    p.walls = vec![wall("quer", (0.0, -1.0), (0.0, 12.0), 2.5), wall("nah", (2.0, 3.0), (6.0, 3.0), 2.5), wall("fern", (2.0, 10.0), (6.0, 10.0), 4.0)];
    let lv = |depth: Option<f64>| LevelSpec { model_view: None, bends: Vec::new(), sketch: false, cut_hatch: false, kind: "section".into(), line: Some([Vec2 { x: -1.0, y: 0.0 }, Vec2 { x: 8.0, y: 0.0 }]), direction_sign: Some(1.0), depth, shadows: false, hidden_lines: false };
    let top = |o: &Output| o.visible.iter().map(|e| e.a[1].max(e.b[1])).fold(f64::NEG_INFINITY, f64::max);
    let all = compute_section(&p, &lv(None), &[]).unwrap().unwrap();
    assert!(top(&all) > 3.9, "ohne Tiefe ist die ferne Wand sichtbar: {}", top(&all));
    let near = compute_section(&p, &lv(Some(5.0)), &[]).unwrap().unwrap();
    assert!(top(&near) < 2.5 + 1e-6, "ferne Wand hinter der Tiefe: {}", top(&near));
    assert!(!near.visible.is_empty(), "nahe Wand bleibt");
    assert_eq!(near.cuts.len(), all.cuts.len(), "Schnitt bleibt");
    // Tiefe 0 ist kein Filter.
    let zero = compute_section(&p, &lv(Some(0.0)), &[]).unwrap().unwrap();
    assert_eq!(zero.visible.len(), all.visible.len());
}

/// [140] Rangfolge im Schnitt: Umriss der geschnittenen Masse schwer (0.5), Fuge zwischen zwei
/// aneinanderstossenden Bauteilen fein (0.13), Ansichtskanten dazwischen (0.18).
#[test]
fn schnittkante_schwer_fugen_fein() {
    let out = Output { cuts: vec![band(0.0, 1.0, 0.0, 1.0, None, "#fff"), band(1.0, 2.0, 0.0, 1.0, None, "#fff")], ..Default::default() };
    let (prims, _) = section_primitives(&out, false, false, &Visibility::default());
    let joints: Vec<f64> = prims.iter().filter_map(|q| match q { Primitive::Polygon { stroke_width_mm, .. } => Some(*stroke_width_mm), _ => None }).collect();
    assert_eq!(joints, [SECTION_JOINT_MM, SECTION_JOINT_MM]);
    let outline: Vec<(Vec2, Vec2)> = prims.iter().filter_map(|q| match q { Primitive::Line { a, b, cls, weight_mm, .. } if cls == "section-cut-outline" => { assert_eq!(*weight_mm, SECTION_CUT_OUTLINE_MM); Some((*a, *b)) } _ => None }).collect();
    // Umriss = Rechteck 2 × 1 (die Fuge bei x = 1 gehört nicht dazu).
    let len: f64 = outline.iter().map(|(a, b)| (b.x - a.x).hypot(b.y - a.y)).sum();
    assert!((len - 6.0).abs() < 1e-6, "{len}");
    assert!(outline.iter().all(|(a, b)| !((a.x - 1.0).abs() < 1e-6 && (b.x - 1.0).abs() < 1e-6)));
    assert!(SECTION_CUT_OUTLINE_MM > SECTION_VISIBLE_MM && SECTION_VISIBLE_MM > SECTION_JOINT_MM);
}

#[test]
fn primitive_pick_ids_und_kategorien() {
    let mut w = band(0.0, 1.0, 0.0, 1.0, None, "#fff");
    w.source_id = Some("W1".into());
    w.category = Some("20".into());
    let mut s = Cut { kind: Kind::Slab, ..band(0.0, 1.0, 1.0, 2.0, None, "#fff") };
    s.source_id = Some("C1".into());
    let mut st = s.clone();
    st.stair_id = Some("ST1".into());
    let mut r = Cut { kind: Kind::Roof, ..band(0.0, 1.0, 2.0, 3.0, None, "#fff") };
    r.source_id = Some("R1".into());
    r.category = Some("31".into());
    let anon = band(2.0, 3.0, 0.0, 1.0, None, "#fff");
    let out = Output { cuts: vec![w, s, st, r, anon], ..Default::default() };
    let (prims, _) = section_primitives(&out, false, false, &Visibility::default());
    let json = serde_json::to_value(&prims).unwrap();
    assert_eq!(json[0]["wallId"], "W1");
    assert_eq!(json[1]["ceilingId"], "C1");
    assert!(json[2].get("ceilingId").is_none() && json[2]["stairId"] == "ST1");
    assert_eq!(json[3]["roofId"], "R1");
    assert!(json[4].get("wallId").is_none());
    // ausgeblendet, nicht gezeichnet, gedimmt; ohne Kategorie immer sichtbar
    let vis = Visibility { has_vis: true, invisible: ["20".to_string()].into(), norender: ["31".to_string()].into(), ..Default::default() };
    let (prims, _) = section_primitives(&out, false, false, &vis);
    assert_eq!(prims.iter().filter(|p| matches!(p, Primitive::Polygon { .. })).count(), 3);
    let grey = Visibility { grey: ["20".to_string()].into(), ..Default::default() };
    let (prims, _) = section_primitives(&out, false, false, &grey);
    assert!(matches!(&prims[0], Primitive::Polygon { greyed: Some(true), .. }));
    assert!(matches!(&prims[4], Primitive::Polygon { greyed: Some(false), .. }));
}

#[test]
fn dach_schnitt_flach_und_sattel() {
    let mut p: Project = serde_json::from_str(include_str!("../../../tests/fixtures/sample_project.json")).unwrap();
    let roof = p.roofs.as_mut().unwrap().get_mut(0).unwrap();
    roof.shape = RoofShape::Flach;
    roof.overhang = 0.0;
    roof.base_elevation = Some(5.0);
    roof.roof_type_id = None;
    roof.thickness = 0.3;
    let plane = LevelSpec { line: Some([Vec2 { x: -1.0, y: 2.0 }, Vec2 { x: 6.0, y: 2.0 }]), ..Default::default() }.plane().unwrap();
    let mut cuts = Vec::new();
    append_roof_sections(&mut cuts, &p, &plane);
    assert_eq!(cuts.len(), 1);
    let b = bbox(&cuts[0].pts);
    assert!(close(b[3], 5.0) && close(b[3] - b[2], 0.3) && close(b[1] - b[0], 5.0), "{b:?}");
    // Sattel quer zum First: zwei Bänder; Spur ausserhalb: keine
    p.roofs.as_mut().unwrap()[0].shape = RoofShape::Sattel;
    let cross = LevelSpec { line: Some([Vec2 { x: 2.0, y: -1.0 }, Vec2 { x: 2.0, y: 5.0 }]), ..Default::default() }.plane().unwrap();
    let mut cuts = Vec::new();
    append_roof_sections(&mut cuts, &p, &cross);
    assert_eq!(cuts.len(), 2);
    let outside = LevelSpec { line: Some([Vec2 { x: -1.0, y: 9.0 }, Vec2 { x: 6.0, y: 9.0 }]), ..Default::default() }.plane().unwrap();
    let mut cuts = Vec::new();
    append_roof_sections(&mut cuts, &p, &outside);
    assert!(cuts.is_empty());
}

#[test]
fn schichten_aussen_aussen_und_override_auf_allen_schichten() {
    let mut p: Project = serde_json::from_str(include_str!("../../../tests/fixtures/sample_project.json")).unwrap();
    let layers = p.wall_types.iter().find(|t| t.id == "aw").unwrap().layers.clone();
    assert!(layers.len() > 1);
    let cp = Cut::new(Kind::Wall, 0, vec![[0.0, 2.6], [0.345, 2.6], [0.345, 0.0], [0.0, 0.0]]);
    let w2 = p.walls.iter().find(|w| w.id == "W2").unwrap().clone();
    let w4 = p.walls.iter().find(|w| w.id == "W4").unwrap().clone();
    let u = (1.0, 0.0);
    let b2 = split_wall_layers(&cp, &p, &layers, &w2, u, &Plane { point: [0.0; 3], normal: [1.0, 0.0, 0.0] }, &Default::default()).unwrap();
    let b4 = split_wall_layers(&cp, &p, &layers, &w4, u, &Plane { point: [0.0; 3], normal: [1.0, 0.0, 0.0] }, &Default::default()).unwrap();
    // W4 (Aussenseite −x): layers[0] an uMin; W2 gespiegelt: layers[0] an uMax.
    assert_eq!(b4[0].component_id.as_deref(), Some(layers[0].component_id.as_str()));
    assert!(close(bbox(&b4[0].pts)[0], 0.0));
    assert_eq!(b2.last().unwrap().component_id.as_deref(), Some(layers[0].component_id.as_str()));
    // Override der Wand gilt für jede Schicht
    p.walls[1].background = Some("#123456".into());
    let w = p.walls[1].clone();
    let bands = split_wall_layers(&cp, &p, &layers, &w, u, &Plane { point: [0.0; 3], normal: [1.0, 0.0, 0.0] }, &Default::default()).unwrap();
    assert!(bands.iter().all(|b| b.fill.as_deref() == Some("#123456")));
}
