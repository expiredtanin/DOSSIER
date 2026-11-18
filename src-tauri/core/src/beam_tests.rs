//! [280] Träger/Unterzug: Höhenlage, Grundriss (gestrichelt mit Achse), Schnitt (quer und längs), 3D, Objekt-Info,
//! Befehl und Griffe. Wie eine Stütze ausgewertet (`Beam::as_column`), liegt aber in `Project.beams`.

use crate::model::*;
use crate::plan::domains::{plan_domains, PlanArgs};
use crate::plan::prim::Primitive;
use crate::plan::section::{compute_section, Kind, LevelSpec};
use serde_json::{json, Value};

/// Geschoss EG 0 … 2.6 m, Decke (25 cm, UK 2.35) 0..6 × 0..4, Träger 25 × 40 cm auf der Achse (1, 2) → (5, 2).
fn project(beam_extra: Value) -> Project {
    let mut beam = json!({"id": "T1", "type": "beam", "floorId": "eg", "categoryCode": "50", "start": {"x": 1, "y": 2}, "end": {"x": 5, "y": 2}, "width": 0.25, "height": 0.4});
    beam.as_object_mut().unwrap().extend(beam_extra.as_object().unwrap().clone());
    serde_json::from_value(json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [{"id": "wt", "name": "WT", "layers": []}], "layers": [], "openings": [], "walls": [], "drawings2d": [],
        "drawingLevels": [{"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 2.6, "baseElevation": 0.0}],
        "ceilings": [{"id": "D1", "type": "ceiling", "floorId": "eg", "categoryCode": "30", "wallTypeId": "wt", "thickness": 0.25,
                      "outline": [{"x": 0, "y": 0}, {"x": 6, "y": 0}, {"x": 6, "y": 4}, {"x": 0, "y": 4}]}],
        "beams": [beam]
    }))
    .unwrap()
}

fn plan(p: &Project) -> crate::plan::domains::DomainPrims {
    let t = json!({"floor": "eg", "show": ["30", "50"], "grey": [], "scale": 50, "global": true, "mono": true}).to_string();
    plan_domains(p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap()
}

#[test]
fn oberkante_buendig_an_deckenunterkante() {
    let p = project(json!({}));
    let b = &p.beams.as_ref().unwrap()[0];
    let (zb, zt) = p.beam_vertical_extent(b);
    assert!((zt - 2.35).abs() < 1e-9 && (zb - 1.95).abs() < 1e-9, "{zb} {zt}");
    // Versatz nach oben in die Decke, ohne Decke darüber: Geschoss-Oberkante.
    let p2 = project(json!({"topOffset": 0.1}));
    let (_, zt) = p2.beam_vertical_extent(&p2.beams.as_ref().unwrap()[0]);
    assert!((zt - 2.45).abs() < 1e-9);
    let mut p3 = project(json!({}));
    p3.ceilings = None;
    let (zb, zt) = p3.beam_vertical_extent(&p3.beams.as_ref().unwrap()[0]);
    assert!((zt - 2.6).abs() < 1e-9 && (zb - 2.2).abs() < 1e-9);
    // Achsmitte ausserhalb der Decke: nicht darunter.
    let p4 = project(json!({"start": {"x": 8, "y": 2}, "end": {"x": 12, "y": 2}}));
    assert!((p4.beam_vertical_extent(&p4.beams.as_ref().unwrap()[0]).1 - 2.6).abs() < 1e-9);
}

#[test]
fn grundriss_gestrichelt_mit_achse() {
    let p = project(json!({}));
    let d = plan(&p);
    // Schnitthöhe 1.0 liegt unter dem Träger (1.95 … 2.35): „über Schnitt“ → Pick-Fläche ohne Füllung, Kanten gestrichelt.
    let pick = d.columns.iter().filter(|q| matches!(q, Primitive::Polygon { column_id: Some(id), .. } if id == "T1")).count();
    assert_eq!(pick, 1);
    assert!(d.columns.iter().all(|q| !matches!(q, Primitive::Polygon { column_id: Some(_), fill, .. } if fill != "none")));
    let dashed = d.columns.iter().filter(|q| matches!(q, Primitive::Line { cls, dash: Some(Some(_)), .. } if cls == "column-view")).count();
    assert_eq!(dashed, 4, "vier gestrichelte Kanten");
    let axis: Vec<_> = d.columns.iter().filter_map(|q| match q { Primitive::Line { cls, a, b, dash: Some(Some(_)), .. } if cls == "beam-axis" => Some((a, b)), _ => None }).collect();
    assert_eq!(axis.len(), 1, "eine Achse");
    let (a, b) = axis[0];
    assert!((a.x - 1.0).abs() < 1e-9 && (b.x - 5.0).abs() < 1e-9 && (a.y - 2.0).abs() < 1e-9 && (b.y - 2.0).abs() < 1e-9);
    // Klasse aus: nichts.
    let t = json!({"floor": "eg", "show": ["30"], "grey": [], "scale": 50, "global": true, "mono": true}).to_string();
    let none = plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
    assert!(none.columns.is_empty());
}

fn section(p: &Project, line: [(f64, f64); 2]) -> crate::plan::section::Output {
    let lv = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: line[0].0, y: line[0].1 }, Vec2 { x: line[1].0, y: line[1].1 }]), direction_sign: Some(1.0), ..Default::default() };
    compute_section(p, &lv, &[]).unwrap().unwrap()
}

fn area(pts: &[[f64; 2]]) -> f64 {
    let n = pts.len();
    (0..n).map(|i| pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]).sum::<f64>().abs() / 2.0
}

#[test]
fn schnitt_quer_und_laengs() {
    let p = project(json!({}));
    // Quer: Schnittlinie x = 3 (entlang y) trifft den Träger: Querschnitt 25 × 40 cm.
    let o = section(&p, [(3.0, -2.0), (3.0, 8.0)]);
    let c: Vec<_> = o.cuts.iter().filter(|c| c.source_id.as_deref() == Some("T1")).collect();
    assert_eq!(c.len(), 1, "{:?}", o.cuts.iter().map(|c| &c.source_id).collect::<Vec<_>>());
    assert!((area(&c[0].pts) - 0.25 * 0.4).abs() < 1e-6, "{}", area(&c[0].pts));
    assert_eq!(c[0].kind, Kind::Slab);
    assert_eq!(c[0].category.as_deref(), Some("50"));
    // Längs: Schnittlinie y = 2 durch die Achse: Länge 4 m × 40 cm.
    let o = section(&p, [(-1.0, 2.0), (8.0, 2.0)]);
    let c: Vec<_> = o.cuts.iter().filter(|c| c.source_id.as_deref() == Some("T1")).collect();
    assert_eq!(c.len(), 1);
    assert!((area(&c[0].pts) - 4.0 * 0.4).abs() < 1e-6, "{}", area(&c[0].pts));
    // Daneben vorbei (y = 3.5): nicht geschnitten, aber in der Projektion (Kanten dahinter).
    let o = section(&p, [(-1.0, 3.5), (8.0, 3.5)]);
    assert!(o.cuts.iter().all(|c| c.source_id.as_deref() != Some("T1")));
}

#[test]
fn dreid_netz_pick_und_klasse() {
    let p = project(json!({}));
    let m = crate::model3d::emit_columns(&p);
    assert_eq!(m.len(), 1);
    assert!(matches!(m[0].owner, crate::model3d::Owner::Beam(0)));
    // Quader 4 × 0.25 × 0.4: z von 1.95 bis 2.35.
    let zs: Vec<f64> = m[0].positions.chunks(3).map(|v| v[2]).collect();
    let (lo, hi) = (zs.iter().cloned().fold(f64::INFINITY, f64::min), zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
    assert!((lo - 1.95).abs() < 1e-9 && (hi - 2.35).abs() < 1e-9, "{lo} {hi}");
    assert_eq!(crate::model3d::Owner::Beam(0).id(&p), Some("T1"));
}

#[test]
fn objekt_info_traeger() {
    let p = project(json!({"profileName": "HEB 200", "topOffset": 0.05}));
    let root = serde_json::to_value(&p).unwrap();
    let root = root.as_object().unwrap();
    let a: crate::selection_info::SelArgs = serde_json::from_value(json!({"columnId": "T1"})).unwrap();
    let s = crate::selection_info::derive(&crate::document::Lookup::plain(root), &a).unwrap().into_string();
    let v: Value = serde_json::from_str(&s).unwrap();
    assert_eq!(v["kind"], "beam");
    assert_eq!(v["beam"]["profileName"], "HEB 200");
    assert!((v["beam"]["zTop"].as_f64().unwrap() - 2.40).abs() < 1e-9, "{v}");
    assert!((v["beam"]["length"].as_f64().unwrap() - 4.0).abs() < 1e-9);
    assert!((v["bbox"]["minX"].as_f64().unwrap() - 1.0).abs() < 1e-9, "{v}");
}

#[test]
fn befehl_traeger_legt_beam_an() {
    let root = serde_json::Map::new();
    let p = Project::default();
    let v = json!({"cmd": "beam", "pts": [[0.0, 0.0], [4.0, 0.0]], "width": 0.2, "height": 0.2, "profileName": "HEB 200", "stamp": "s", "ctx": {"level": "eg", "floorHeight": 2.6, "cat": "10", "wallType": "x"}});
    let ops = crate::cmd_create::ops(&root, &p, &v).unwrap();
    let Some(crate::ops::Op::Add { collection, items, .. }) = ops.first() else { panic!("add erwartet") };
    assert_eq!(collection, "beams");
    let b = &items[0];
    assert_eq!((b["type"].as_str(), b["floorId"].as_str(), b["categoryCode"].as_str()), (Some("beam"), Some("eg"), Some("10")), "ohne Klasse 25/50: die aktive");
    assert_eq!(b["profileName"], "HEB 200");
    assert_eq!(b["end"]["x"], 4.0);
    // Nulllänge: nichts.
    let v0 = json!({"cmd": "beam", "pts": [[1.0, 1.0], [1.0, 1.0]], "stamp": "s", "ctx": {"level": "eg"}});
    assert!(crate::cmd_create::ops(&root, &p, &v0).unwrap().is_empty());
    // Das neue Element liest das Modell.
    let _: Beam = serde_json::from_value(b.clone()).unwrap();
}

#[test]
fn umbaufilter_wie_stuetze() {
    // Träger Neu: im Filter „Bestand“ weg, im „Neubau“ da (Pick-Fläche + Kanten), in „Abbruch“ weg.
    let p = project(json!({"renovation": {"status": "new"}}));
    let with = |f: &str| {
        let t = json!({"floor": "eg", "show": ["30", "50"], "grey": [], "scale": 50, "global": true, "mono": true, "renovation": f}).to_string();
        plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap().columns.len()
    };
    assert_eq!(with("bestand"), 0);
    assert_eq!(with("abbruch"), 0);
    assert!(with("neubau") > 0);
}

#[test]
fn varianten_blenden_traeger_aus() {
    // [284] Träger in Variante B: in der Hauptkombination (A) ausgeblendet, in B sichtbar.
    let mut p = project(json!({"designOption": {"set": "s", "option": "b"}}));
    p.design_option_sets = Some(vec![serde_json::from_value(json!({"id": "s", "name": "Tragwerk", "options": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}], "primary": "a"})).unwrap()]);
    let with = |f: Value| {
        let t = json!({"floor": "eg", "show": ["30", "50"], "grey": [], "scale": 50, "global": true, "mono": true, "designOptions": f}).to_string();
        plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap().columns.len()
    };
    assert_eq!(with(json!({})), 0, "Hauptkombination ohne Träger der Variante B");
    assert!(with(json!("Tragwerk=B")) > 0);
    assert!(crate::design_options::Combination::primary(&p).hidden(&p).contains("T1"));
    // 3D, Schnitt, Kennzahlen und Exporte rechnen auf dem gefilterten Projekt: dort fehlt der Träger.
    assert!(crate::renovation::project_for_text(&p, "{}").beams.as_deref().unwrap_or(&[]).is_empty());
    // Umbau: abgebrochener Träger fehlt im Neubau-Zustand.
    let q = project(json!({"renovation": {"status": "demolish"}}));
    assert!(crate::renovation::project_in_state(&q, Some("neubau"), None).beams.as_deref().unwrap_or(&[]).is_empty());
}
