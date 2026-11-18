//! [279] Geländer in allen Ableitungen: 3D-Netze und Platten, Schnitt, Ansicht, 3D-Dokument, IFC, Umbaufilter, Varianten,
//! Befehl „railing", Verschieben, Gruppen und Verweise.

use crate::model::*;
use crate::plan::domains::{plan_domains, PlanArgs};
use crate::plan::prim::Primitive;
use serde_json::{json, Value};

/// Projekt mit einem Geländer `g` (offen, 4 m entlang x bei y = 0, Höhe 1 m) auf dem EG (Sockel 3.0 m), dazu Schnitt und Ansicht.
fn project(kind: &str, extra: Value) -> Project {
    let mut r = json!({"id": "g", "type": "railing", "floorId": "eg", "categoryCode": "41", "points": [{"x": 0, "y": 0}, {"x": 4, "y": 0}], "height": 1.0, "kind": kind});
    for (k, v) in extra.as_object().unwrap() {
        r[k] = v.clone();
    }
    serde_json::from_value(json!({
        "id": "p", "name": "P", "lineStyles": [], "hatches": [], "components": [{"id": "c", "name": "Beton", "color": "#b0b0b0", "hatchId": ""}], "wallTypes": [],
        "layers": [{"code": "41", "name": "Geländer", "color": "#102030", "lw": 0.25, "visible": true, "locked": false}],
        "drawingLevels": [
            {"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "cutHeight": 1.0, "baseElevation": 3.0},
            {"id": "ans", "name": "Ansicht Süd", "kind": "elevation", "visible": true, "locked": false, "linePoints": [{"x": -5, "y": -5}, {"x": 10, "y": -5}], "directionSign": 1},
            {"id": "sc", "name": "Schnitt", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": 1.5, "y": -5}, {"x": 1.5, "y": 5}], "directionSign": 1}
        ],
        "walls": [], "openings": [], "drawings2d": [], "railings": [r]
    }))
    .unwrap()
}

fn level(p: &Project, id: &str) -> crate::plan::section::LevelSpec {
    let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
    crate::plan::section::LevelSpec::from_json(&serde_json::to_value(l).unwrap())
}

fn hide41() -> crate::plan::section::Visibility {
    crate::plan::section::Visibility { has_vis: true, invisible: ["41".to_string()].into_iter().collect(), ..Default::default() }
}

fn picks(prims: &[Primitive]) -> usize {
    prims.iter().filter(|q| matches!(q, Primitive::Polygon { context_object_id: Some(id), .. } if id == "@railing:g")).count()
}

fn plan(p: &Project, extra: Value) -> Vec<Primitive> {
    let mut t = json!({"floor": "eg", "show": ["41"], "scale": 50, "global": true});
    for (k, x) in extra.as_object().unwrap() {
        t[k] = x.clone();
    }
    plan_domains(p, &PlanArgs::parse_in(p, 1.0, &t.to_string()).unwrap()).unwrap().columns
}

#[test]
fn netze_platten_und_pick() {
    // Stäbe: nur das Gestänge; Glas: Tafel und Gestänge (Handlauf).
    let bars = project("bars", json!({}));
    let m = crate::model3d::emit_railings(&bars);
    assert_eq!(m.len(), 1);
    assert!(matches!(m[0].owner, crate::model3d::Owner::Railing(0)));
    // Höhen im Netz: Fuss 3.0, Oberkante 4.0.
    let zs: Vec<f64> = m[0].positions.chunks_exact(3).map(|c| c[2]).collect();
    assert!((zs.iter().cloned().fold(f64::MAX, f64::min) - 3.0).abs() < 1e-9 && (zs.iter().cloned().fold(f64::MIN, f64::max) - 4.0).abs() < 1e-9);
    let glass = project("glass", json!({}));
    assert_eq!(crate::model3d::emit_railings(&glass).len(), 2);
    let slabs = crate::model3d::railing_slabs(&glass);
    assert!(!slabs.is_empty() && slabs.iter().all(|s| s.ceiling_id == "g" && matches!(s.source, crate::model3d::SlabSource::Railing { index: 0, .. })));
    // Pick-Geometrie: ein Eintrag mit Dreiecken.
    let pk = crate::model3d::pick_railings(&glass);
    assert_eq!(pk.len(), 1);
    assert!(!pk[0].tris.is_empty() && pk[0].railing_id == "g");
    // Das 3D-Modell trägt das Geländer bei den Stützen; ausgeblendete Klasse „41" entfernt es.
    let parts = crate::model3d::parts(&glass, true, 1.0, false).unwrap();
    assert!(parts.column_meshes.iter().any(|m| matches!(m.owner, crate::model3d::Owner::Railing(_))));
    let f = crate::model3d::ClassFilter::from_text(&glass, r#"{"hide":["41"]}"#);
    let hidden = crate::model3d::parts_filtered(&glass, true, 1.0, false, &f).unwrap();
    assert!(!hidden.column_meshes.iter().any(|m| matches!(m.owner, crate::model3d::Owner::Railing(_))));
}

#[test]
fn schnitt_durch_gelaender() {
    let p = project("bars", json!({}));
    let out = crate::plan::section::compute_section(&p, &level(&p, "sc"), &[]).unwrap().unwrap();
    // Geschnitten: Handlauf und Fussschiene (Gestänge) mit Herkunft und Klasse; schwarz gefüllt.
    let cuts: Vec<_> = out.cuts.iter().filter(|c| c.railing_id.as_deref() == Some("g")).collect();
    assert!(cuts.len() >= 2, "{} Bänder", out.cuts.len());
    assert!(cuts.iter().all(|c| c.category.as_deref() == Some("41") && c.source_id.as_deref() == Some("g")));
    // In der Projektion stehen die Pfosten/Stäbe als Kanten (Schnitt an x = 1.5: Stäbe dahinter bei x > 1.5).
    assert!(!out.visible.is_empty());
    // Ausgeblendete Klasse: nichts mehr.
    let vis = hide41();
    let o2 = crate::plan::section::compute_section_vis(&p, &level(&p, "sc"), &[], &vis).unwrap().unwrap();
    assert!(!o2.cuts.iter().any(|c| c.railing_id.is_some()));
    // Glas: eine dünne Tafel (2 cm) wird quer geschnitten.
    let g = project("glass", json!({}));
    let og = crate::plan::section::compute_section(&g, &level(&g, "sc"), &[]).unwrap().unwrap();
    let panel = og.cuts.iter().find(|c| c.railing_id.is_some() && c.fill.as_deref() == Some("#cfe3ee")).expect("Glasband");
    let xs: Vec<f64> = panel.pts.iter().map(|q| q[0]).collect();
    assert!((xs.iter().cloned().fold(f64::MIN, f64::max) - xs.iter().cloned().fold(f64::MAX, f64::min) - 0.02).abs() < 1e-3, "{xs:?}");
}

#[test]
fn ansicht_zeigt_gelaender_anwaehlbar() {
    for kind in ["bars", "glass", "solid", "perforated"] {
        let p = project(kind, json!({}));
        let (prims, _) = crate::plan::elevation::elevation_primitives(&p, &level(&p, "ans"), false, false, &crate::plan::section::Visibility::default(), 50.0).unwrap().unwrap();
        assert!(picks(&prims) > 0, "{kind}: keine anwählbare Fläche in der Ansicht");
    }
    // Brüstung: ein gefüllter Streifen über 4 m Länge (x) und 1 m Höhe.
    let p = project("solid", json!({"thickness": 0.2}));
    let (prims, _) = crate::plan::elevation::elevation_primitives(&p, &level(&p, "ans"), false, false, &crate::plan::section::Visibility::default(), 50.0).unwrap().unwrap();
    let w: f64 = prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Polygon { pts, context_object_id: Some(id), .. } if id == "@railing:g" => Some(pts.iter().map(|v| v.x).fold(f64::MIN, f64::max) - pts.iter().map(|v| v.x).fold(f64::MAX, f64::min)),
            _ => None,
        })
        .fold(0.0, f64::max);
    assert!((w - 4.0).abs() < 1e-6, "{w}");
    // Ausgeblendete Klasse: keine Fläche.
    let vis = hide41();
    let hidden = crate::plan::elevation::elevation_primitives(&p, &level(&p, "ans"), false, false, &vis, 50.0).unwrap().map(|r| r.0).unwrap_or_default();
    assert_eq!(picks(&hidden), 0);
}

/// Fläche (m²) aller Polygone mit Pick-Id `@railing:<id>` (Betrag je Ring, Löcher kommen als Schlüsselloch-Ringe).
fn pick_area(prims: &[Primitive], id: &str) -> f64 {
    let want = format!("@railing:{id}");
    prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Polygon { pts, context_object_id: Some(c), .. } if *c == want => Some((0..pts.len()).map(|i| pts[i].x * pts[(i + 1) % pts.len()].y - pts[(i + 1) % pts.len()].x * pts[i].y).sum::<f64>().abs() / 2.0),
            _ => None,
        })
        .sum()
}

/// Projekt mit Glas `g` (y = 0) vorne und einer massiven Brüstung `h` (y = 2) dahinter; `glass` = ohne das Glas.
fn glas_vor_bruestung(glass: bool) -> Project {
    let mut p = project("glass", json!({"handrail": false}));
    let mut h = p.railings.as_ref().unwrap()[0].clone();
    h.id = "h".into();
    h.kind = RailingKind::Solid;
    h.handrail = Some(false);
    h.points = vec![Vec2 { x: 0.0, y: 2.0 }, Vec2 { x: 4.0, y: 2.0 }];
    p.railings = Some(if glass { vec![p.railings.as_ref().unwrap()[0].clone(), h] } else { vec![h] });
    p
}

fn glass_opacity(prims: &[Primitive]) -> Option<f64> {
    prims.iter().find_map(|q| match q {
        Primitive::Polygon { opacity, context_object_id: Some(c), .. } if c == "@railing:g" && opacity.is_some() => *opacity,
        _ => None,
    })
}

#[test]
fn glas_in_der_ansicht_durchscheinend() {
    let vis = crate::plan::section::Visibility::default();
    let el = |p: &Project| crate::plan::elevation::elevation_primitives(p, &level(p, "ans"), false, false, &vis, 50.0).unwrap().unwrap().0;
    let (mit, ohne) = (el(&glas_vor_bruestung(true)), el(&glas_vor_bruestung(false)));
    // Die Brüstung hinter dem Glas bleibt ganz sichtbar (Glas verdeckt nicht), das Glas selbst ist teiltransparent.
    assert!((pick_area(&ohne, "h") - 4.0).abs() < 1e-6, "{}", pick_area(&ohne, "h"));
    assert!((pick_area(&mit, "h") - 4.0).abs() < 1e-6, "Brüstung hinter Glas: {}", pick_area(&mit, "h"));
    let o = glass_opacity(&mit).expect("Glasfläche mit Deckkraft");
    assert!(o > 0.0 && o < 1.0, "{o}");
    assert!(pick_area(&mit, "g") > 3.0, "Glasfläche fehlt");
    // Stäbe, Lochblech und Brüstung bleiben deckend.
    for kind in ["bars", "perforated", "solid"] {
        let p = project(kind, json!({}));
        assert!(glass_opacity(&el(&p)).is_none(), "{kind}");
    }
}

#[test]
fn glas_im_3d_dokument_durchscheinend() {
    let ax = |p: &Project| {
        let a = crate::plan::axo::AxoArgs::parse(p, &json!({"view": "southeast", "scale": 100})).unwrap();
        crate::plan::axo::axo_primitives(p, &a, false).unwrap().expect("Bild").0
    };
    let (mit, ohne) = (ax(&glas_vor_bruestung(true)), ax(&glas_vor_bruestung(false)));
    assert!(pick_area(&ohne, "h") > 1.0);
    assert!((pick_area(&mit, "h") - pick_area(&ohne, "h")).abs() < 1e-6, "{} / {}", pick_area(&mit, "h"), pick_area(&ohne, "h"));
    let o = glass_opacity(&mit).expect("Glasfläche mit Deckkraft");
    assert!(o > 0.0 && o < 1.0, "{o}");
}

/// Schraffurmuster der Flächen mit Pick-Id `@railing:g`.
fn rail_hatches(prims: &[Primitive]) -> Vec<crate::model::HatchPattern> {
    prims.iter().filter_map(|q| match q {
        Primitive::Polygon { hatch, context_object_id: Some(c), fill, .. } if c == "@railing:g" && fill != "none" => Some(hatch.pattern),
        _ => None,
    }).collect()
}

#[test]
fn lochblech_mit_lochmuster_in_ansicht_und_3d_dokument() {
    use crate::model::HatchPattern::{Dots, None as NoHatch};
    let vis = crate::plan::section::Visibility::default();
    let el = |p: &Project| crate::plan::elevation::elevation_primitives(p, &level(p, "ans"), false, false, &vis, 50.0).unwrap().unwrap().0;
    let ax = |p: &Project| {
        let a = crate::plan::axo::AxoArgs::parse(p, &json!({"view": "southeast", "scale": 100})).unwrap();
        crate::plan::axo::axo_primitives(p, &a, false).unwrap().expect("Bild").0
    };
    let perf = project("perforated", json!({"handrail": false}));
    for (name, h) in [("Ansicht", rail_hatches(&el(&perf))), ("3D-Dokument", rail_hatches(&ax(&perf)))] {
        assert!(!h.is_empty() && h.iter().all(|p| *p == Dots), "{name}: Lochmuster fehlt: {h:?}");
    }
    // Glas und Brüstung bleiben ohne Muster.
    for kind in ["glass", "solid"] {
        let p = project(kind, json!({"handrail": false}));
        assert!(rail_hatches(&el(&p)).iter().chain(rail_hatches(&ax(&p)).iter()).all(|p| *p == NoHatch), "{kind}");
    }
}

#[test]
fn dokument_3d_axo() {
    let p = project("glass", json!({}));
    let a = crate::plan::axo::AxoArgs::parse(&p, &json!({"view": "southeast", "scale": 100})).unwrap();
    let (prims, _) = crate::plan::axo::axo_primitives(&p, &a, false).unwrap().expect("Bild");
    assert!(picks(&prims) > 0, "Fläche mit Pick-Id fehlt");
    assert!(prims.iter().any(|q| matches!(q, Primitive::Line { cls, .. } if cls == "axo-edge" || cls == "axo-outline")));
}

#[test]
fn ifc_datensatz_ifcrailing() {
    let p = project("bars", json!({}));
    let f = crate::ifc_data::ifc_export_data(&p, &Default::default()).unwrap();
    let strings: Vec<String> = f.strings.iter().cloned().collect();
    assert!(strings.iter().any(|s| s == "g") && strings.iter().any(|s| s == "GUARDRAIL") && strings.iter().any(|s| s == "Dossier_Qto_Railing"), "{strings:?}");
    assert!(f.nums.contains(&26.0), "Datensatz RAILING");
    // Unsinn: kein Datensatz.
    let bad = project("bars", json!({"height": 0}));
    let f = crate::ifc_data::ifc_export_data(&bad, &Default::default()).unwrap();
    assert!(!f.nums.contains(&26.0));
}

#[test]
fn umbau_und_varianten_blenden_aus() {
    let mut p = project("glass", json!({"renovation": {"status": "demolish"}}));
    // Neubauplan: Abbruch weg; Bestandsplan: Abbruch steht (gestrichelt in Umbau-Farbe im Abbruchplan).
    assert_eq!(picks(&plan(&p, json!({"renovation": "neubau"}))), 0);
    assert!(picks(&plan(&p, json!({"renovation": "bestand"}))) > 0);
    let ab = plan(&p, json!({"renovation": "abbruch"}));
    assert!(ab.iter().any(|q| matches!(q, Primitive::Line { cls, dash: Some(Some(_)), .. } if cls == "railing-glass")), "Abbruch gestrichelt");
    // 3D und Schnitt folgen dem Filter über das Projekt ohne Ausgeblendetes.
    let q = crate::renovation::project_in_state(&p, Some("neubau"), None);
    assert!(q.railings.as_deref().unwrap_or(&[]).is_empty());
    // Varianten: ein Geländer in Variante B fehlt in A.
    p.renovation = None;
    p.railings.as_mut().unwrap()[0].renovation = None;
    p.railings.as_mut().unwrap()[0].design_option = Some(DesignOptionRef { set: "s".into(), option: "b".into(), ..Default::default() });
    p.design_option_sets = Some(vec![serde_json::from_value(json!({"id": "s", "name": "Brüstung", "options": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}], "primary": "a"})).unwrap()]);
    assert_eq!(picks(&plan(&p, json!({}))), 0);
    assert!(picks(&plan(&p, json!({"designOptions": "Brüstung=B"}))) > 0);
    assert!(crate::design_options::active(&p));
}

#[test]
fn befehl_railing_baut_ops() {
    let p = project("bars", json!({}));
    let root: serde_json::Map<String, Value> = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
    let req = |v: Value| {
        let mut base = json!({"cmd": "railing", "ctx": {"level": "eg", "floorHeight": 3.0, "cat": "20", "wallType": "t"}, "stamp": "s"});
        for (k, x) in v.as_object().unwrap() {
            base[k] = x.clone();
        }
        base
    };
    let add = |ops: Vec<crate::ops::Op>| -> (String, Value) {
        match ops.into_iter().next() {
            Some(crate::ops::Op::Add { collection, items, .. }) => (collection, items[0].clone()),
            other => panic!("erwartet Add, war {other:?}"),
        }
    };
    let (coll, it) = add(crate::cmd_create::ops(&root, &p, &req(json!({"pts": [[0, 0], [2, 0], [2, 2]], "kind": "glass", "height": 1.1, "closed": true, "handrail": false}))).unwrap());
    assert_eq!((coll.as_str(), it["type"].as_str(), it["floorId"].as_str(), it["categoryCode"].as_str(), it["kind"].as_str()), ("railings", Some("railing"), Some("eg"), Some("41"), Some("glass")));
    assert_eq!((it["height"].as_f64(), it["closed"].as_bool(), it["handrail"].as_bool(), it["points"].as_array().map(|a| a.len())), (Some(1.1), Some(true), Some(false), Some(3)));
    // Vorgaben bei Unsinn; ein einzelner Punkt oder doppelte Punkte ergeben nichts.
    let (_, it) = add(crate::cmd_create::ops(&root, &p, &req(json!({"pts": [[0, 0], [2, 0]], "kind": "foo", "height": -3}))).unwrap());
    assert_eq!((it["kind"].as_str(), it["height"].as_f64()), (Some("bars"), Some(1.0)));
    assert!(crate::cmd_create::ops(&root, &p, &req(json!({"pts": [[0, 0], [0, 0]]}))).unwrap().is_empty());
}

#[test]
fn verschieben_und_gruppen() {
    let p = project("bars", json!({}));
    let root: serde_json::Map<String, Value> = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
    let req: crate::cmd_transform::TransformReq = serde_json::from_value(json!({"sel": {"wallIds": [], "railingIds": ["g"]}, "op": "move", "pts": [[0, 0], [3, 1]], "mode": "move", "count": 1, "stamp": "s"})).unwrap();
    let ops = crate::cmd_transform::transform_ops(&root, &p, &req);
    let Some(crate::ops::Op::Replace { collection, entity }) = ops.first() else { panic!("erwartet Replace: {ops:?}") };
    assert_eq!(collection, "railings");
    let pts = entity["points"].as_array().unwrap();
    assert_eq!((pts[0]["x"].as_f64(), pts[0]["y"].as_f64(), pts[1]["x"].as_f64()), (Some(3.0), Some(1.0), Some(7.0)));
    // Gruppen: die Mitgliedschaft kennt Geländer; Verweisprüfung bemerkt ein fehlendes Mitglied.
    let mut q = p.clone();
    q.groups = Some(vec![Group { id: "gr".into(), railing_ids: Some(vec!["g".into(), "weg".into()]), ..Default::default() }]);
    assert_eq!(crate::groups::transitive_membership(&q, "gr").railing_ids, ["g", "weg"]);
    assert!(crate::project_refs::dangling_refs(&q).iter().any(|m| m.contains("weg")));
}

#[test]
fn projektdatei_und_georef() {
    // Das Feld ist bekannt: kein Hinweis „unbekanntes Feld".
    let p = project("bars", json!({}));
    let text = serde_json::to_string(&p).unwrap();
    let parsed = crate::project_format::parse_project_file(&text, 0.0);
    match parsed {
        crate::project_format::Parsed::Ok { warnings, project, .. } => {
            assert!(!warnings.iter().any(|w| w.contains("railings")), "{warnings:?}");
            assert!(project.contains_key("railings"));
        }
        crate::project_format::Parsed::Err(e) => panic!("{e}"),
    }
}
