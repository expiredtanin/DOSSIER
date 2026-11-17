//! [272] Tests der Varianten: Sichtbarkeit je Kombination (auch mit Umbaufilter), Kennzahlen-Vergleich, Übernehmen,
//! Löschen, Zuweisen/Kopieren, Robustheit.

use super::*;
use crate::plan::domains::{plan_domains, PlanArgs};
use crate::plan::prim::Primitive;
use serde_json::{json, Value};

/// Musterhaus mit Satz „Dachform“ (A Flachdach = Haupt, B Satteldach): W2 und Raum R1 in A; W9, Dach RF1, Öffnung O2 und
/// eine Linie im EG in B. Dazu die Umbau-Angaben der [271]-Fixture (W2 Abbruch, W9 Neu Etappe 2).
fn fixture() -> Value {
    let mut v = crate::renovation::tests::umbau_fixture();
    v["designOptionSets"] = json!([{"id": "dach", "name": "Dachform", "options": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}], "primary": "a"}]);
    let tag = |v: &mut Value, coll: &str, id: &str, opt: &str| {
        for x in v[coll].as_array_mut().unwrap() {
            if x["id"] == id {
                x["designOption"] = json!({"set": "dach", "option": opt});
            }
        }
    };
    tag(&mut v, "walls", "W2", "a");
    tag(&mut v, "rooms", "R1", "a");
    tag(&mut v, "walls", "W9", "b");
    tag(&mut v, "roofs", "RF1", "b");
    tag(&mut v, "openings", "O2", "b");
    v["drawings2d"].as_array_mut().unwrap().push(json!({"id": "L-b", "type": "line", "levelId": "eg", "categoryCode": "00", "geom": {"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 3, "y": 3}}, "designOption": {"set": "dach", "option": "b"}}));
    v
}

fn project(v: &Value) -> Project {
    serde_json::from_value(v.clone()).unwrap()
}

fn plan_with(p: &Project, extra: Value) -> Vec<Primitive> {
    let codes: Vec<String> = (0..100).map(|k| format!("{k:02}")).collect();
    let mut t = json!({"floor": "eg", "show": codes, "scale": 100});
    for (k, x) in extra.as_object().unwrap() {
        t[k] = x.clone();
    }
    let d = plan_domains(p, &PlanArgs::parse_in(p, 1.0, &t.to_string()).unwrap()).unwrap();
    [d.walls, d.ceilings, d.roofs, d.stairs, d.columns, d.solids, d.rooms, d.drawings.prims].concat()
}

fn has_wall(prims: &[Primitive], id: &str) -> bool {
    prims.iter().any(|q| matches!(q, Primitive::Polygon { wall_id: Some(w), .. } if w == id))
}

fn has_opening(prims: &[Primitive], id: &str) -> bool {
    prims.iter().any(|q| match q {
        Primitive::Polygon { opening_id: Some(o), .. } | Primitive::Line { opening_id: Some(o), .. } | Primitive::Arc { opening_id: Some(o), .. } => o == id,
        _ => false,
    })
}

fn has_drawing(prims: &[Primitive], id: &str) -> bool {
    prims.iter().any(|q| match q {
        Primitive::Line { drawing_id: Some(d), .. } | Primitive::Polygon { drawing_id: Some(d), .. } => d == id,
        _ => false,
    })
}

#[test]
fn kombination_lesen_und_aufloesen() {
    let p = project(&fixture());
    assert!(active(&p));
    let prim = Combination::primary(&p);
    assert_eq!(prim.choice.get("dach").map(String::as_str), Some("a"));
    assert!(prim.shows(None));
    assert!(prim.shows(Some(&DesignOptionRef { set: "dach".into(), option: "a".into(), ..Default::default() })));
    assert!(!prim.shows(Some(&DesignOptionRef { set: "dach".into(), option: "b".into(), ..Default::default() })));
    // Unbekannter Satz: Hauptmodell (sichtbar).
    assert!(prim.shows(Some(&DesignOptionRef { set: "weg".into(), option: "x".into(), ..Default::default() })));
    // Anfrage nach Namen (Gross-/Kleinschreibung egal), Text oder Objekt.
    assert_eq!(parse_text("Dachform=B, Fassade = A"), vec![("Dachform".to_string(), "B".to_string()), ("Fassade".to_string(), "A".to_string())]);
    let c = Combination::resolve(&p, &[], &parse_text("dachform=b"));
    assert_eq!(c.choice["dach"], "b");
    assert_eq!(c.label(&p), "Dachform B");
    assert!(!c.is_primary(&p));
    let c2 = Combination::resolve(&p, &[], &parse_request(Some(&json!({"Dachform": "B"}))));
    assert_eq!(c, c2);
    // Gespeicherte Wahl unter der Anfrage.
    let stored: BTreeMap<String, String> = [("dach".to_string(), "b".to_string())].into();
    assert_eq!(Combination::resolve(&p, &[&stored], &[]).choice["dach"], "b");
    assert_eq!(Combination::resolve(&p, &[&stored], &parse_text("Dachform=A")).choice["dach"], "a");
    // Unbekanntes wird übergangen.
    assert_eq!(Combination::resolve(&p, &[], &parse_text("Dachform=Z,Fassade=A,=,kaputt")).choice["dach"], "a");
    // Ausgeblendet: W2/R1 in B, W9/RF1/O2/L-b in A.
    let h = prim.hidden(&p);
    for id in ["W9", "RF1", "O2", "L-b"] {
        assert!(h.contains(id), "{id}");
    }
    assert!(!h.contains("W2") && !h.contains("O1"));
    let hb = c.hidden(&p);
    assert!(hb.contains("W2") && hb.contains("R1") && !hb.contains("W9"));
    // Alle Kombinationen: Hauptkombination zuerst.
    let all = Combination::all(&p);
    assert_eq!(all.len(), 2);
    assert_eq!(all[0], prim);
}

#[test]
fn grundriss_je_kombination() {
    let p = project(&fixture());
    let a = plan_with(&p, json!({}));
    assert!(has_wall(&a, "W2") && !has_wall(&a, "W9"));
    assert!(!has_opening(&a, "O2") && has_opening(&a, "O1"));
    assert!(!has_drawing(&a, "L-b"));
    let b = plan_with(&p, json!({"designOptions": "Dachform=B"}));
    assert!(!has_wall(&b, "W2") && has_wall(&b, "W9"));
    assert!(has_opening(&b, "O2"));
    assert!(has_drawing(&b, "L-b"));
    // Kombination der Ebene.
    let mut v = fixture();
    for l in v["drawingLevels"].as_array_mut().unwrap() {
        if l["id"] == "eg" {
            l["designOptions"] = json!({"dach": "b"});
        }
    }
    let q = project(&v);
    let b2 = plan_with(&q, json!({}));
    assert!(has_wall(&b2, "W9") && !has_wall(&b2, "W2"));
    // Die Anfrage geht vor.
    let a2 = plan_with(&q, json!({"designOptions": {"dach": "a"}}));
    assert!(has_wall(&a2, "W2") && !has_wall(&a2, "W9"));
}

#[test]
fn ohne_varianten_unveraendert() {
    // Projekt ohne Sätze: keine View, der Plan ist derselbe wie vorher.
    let v = crate::renovation::tests::umbau_fixture();
    let p = project(&v);
    assert!(!active(&p));
    assert!(crate::renovation::View::new(&p, None, None).is_none());
    // Sätze ohne Elemente: wirkungslos.
    let mut v2 = v.clone();
    v2["designOptionSets"] = json!([{"id": "s", "name": "S", "options": [{"id": "x", "name": "X"}]}]);
    let p2 = project(&v2);
    assert!(!active(&p2));
    assert_eq!(format!("{:?}", plan_with(&p, json!({}))), format!("{:?}", plan_with(&p2, json!({"designOptions": "S=X"}))));
}

#[test]
fn umbaufilter_und_kombination() {
    let p = project(&fixture());
    // Neubau: Abbruch (W2) weg, W9 neu (Etappe 2) — aber W9 nur in B.
    let a = plan_with(&p, json!({"renovation": "neubau"}));
    assert!(!has_wall(&a, "W2") && !has_wall(&a, "W9"));
    let b = plan_with(&p, json!({"renovation": "neubau", "designOptions": "Dachform=B"}));
    assert!(has_wall(&b, "W9") && !has_wall(&b, "W2"));
    // Bestand in B: W9 (neu) fehlt, W2 ist in A — beides fehlt.
    let bb = plan_with(&p, json!({"renovation": "bestand", "designOptions": "Dachform=B"}));
    assert!(!has_wall(&bb, "W9") && !has_wall(&bb, "W2") && has_wall(&bb, "W1"));
    // Bestand in A: W2 steht noch.
    let ba = plan_with(&p, json!({"renovation": "bestand"}));
    assert!(has_wall(&ba, "W2"));
    // View: Schlüssel unterscheidet die Kombinationen.
    let k = |r: &[(String, String)]| crate::renovation::View::with(&p, Some("umbauplan"), None, &[], r).unwrap().key();
    assert_ne!(k(&[]), k(&parse_text("Dachform=B")));
}

fn section_prims(p: &Project, extra: Value) -> Vec<Primitive> {
    let level = p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap();
    let mut v = json!({"level": level, "scale": 50, "detail": "mittel"});
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    let buf = crate::queries::run_bin(p, "sectionPlan", &[0.0, 1.0, 0.0], &v.to_string()).unwrap();
    crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default()
}

fn elevation_prims(p: &Project, extra: Value) -> Vec<Primitive> {
    let level = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let mut v = json!({"level": level});
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    let buf = crate::queries::run_bin(p, "elevationPlan", &[0.0, 0.0, 100.0], &v.to_string()).unwrap();
    crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default()
}

fn ids_in(prims: &[Primitive]) -> HashSet<String> {
    prims.iter().filter_map(|q| crate::renovation::prim_element(q).map(String::from)).collect()
}

#[test]
fn schnitt_und_ansicht_je_kombination() {
    let p = project(&fixture());
    let a = ids_in(&section_prims(&p, json!({})));
    let b = ids_in(&section_prims(&p, json!({"designOptions": "Dachform=B"})));
    assert!(!a.contains("RF1") && b.contains("RF1"), "{a:?} / {b:?}");
    // Kombination der Ebene (Schnitt-Ebene).
    let mut v = fixture();
    for l in v["drawingLevels"].as_array_mut().unwrap() {
        if l["id"] == "schnitt-a" || l["id"] == "ansicht-sued" {
            l["designOptions"] = json!({"dach": "b"});
        }
    }
    let q = project(&v);
    assert!(ids_in(&section_prims(&q, json!({}))).contains("RF1"));
    // Ansicht: das Dach erscheint nur in B (andere Bilder).
    let ea = elevation_prims(&p, json!({}));
    let eb = elevation_prims(&p, json!({"designOptions": "Dachform=B"}));
    assert_ne!(format!("{ea:?}"), format!("{eb:?}"));
    assert_eq!(format!("{eb:?}"), format!("{:?}", elevation_prims(&q, json!({}))));
}

#[test]
fn drei_d_axo_und_exporte_je_kombination() {
    let p = project(&fixture());
    let parts = |t: &str| -> Value { serde_json::from_str(&crate::queries::run(&p, "model3dParts", &[1.0, 1.0, 0.0], t).unwrap()).unwrap() };
    let ids = |v: &Value| v["walls"].as_array().unwrap().iter().map(|w| w["wallId"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let a = parts("");
    let b = parts(r#"{"designOptions": "Dachform=B"}"#);
    assert!(ids(&a).contains(&"W2".to_string()) && !ids(&a).contains(&"W9".to_string()));
    assert!(ids(&b).contains(&"W9".to_string()) && !ids(&b).contains(&"W2".to_string()));
    // Mit Umbaufilter und Kombination zusammen.
    let nb = parts(r#"{"renovation": "neubau", "designOptions": "Dachform=B"}"#);
    assert!(ids(&nb).contains(&"W9".to_string()));
    // Picken trifft keine Elemente anderer Varianten.
    let pick = crate::queries::run(&p, "pickGeometry", &[], "").unwrap();
    assert!(!pick.contains("\"W9\"") && pick.contains("\"W2\""));
    // Dokument (Cache-Weg) wie ohne Cache.
    let mut d = crate::document::Document::from_json(&fixture().to_string()).unwrap();
    let doc = crate::queries::run_doc(&mut d, "model3dParts", &[1.0, 1.0, 0.0, 0.0], "").unwrap();
    assert!(!doc.contains("\"W9\"") && doc.contains("\"W2\""));
    // IFC: Hauptkombination bzw. die angefragte.
    let ifc = |t: &str| crate::queries::run_bin(&p, "ifcExportData", &[0.0, 0.0, 0.0, 0.0], t).unwrap();
    let names = |b: &[u8]| String::from_utf8_lossy(b).to_string();
    let ia = names(&ifc("2026-11-17T00:00:00Z"));
    let ib = names(&ifc(r#"{"iso": "2026-11-17T00:00:00Z", "designOptions": "Dachform=B"}"#));
    assert!(ia.contains("W2") && !ia.contains("W9"), "IFC A");
    assert!(ib.contains("W9") && !ib.contains("W2"), "IFC B");
    // Axo (3D-Dokument): andere Bilder je Kombination.
    let axo = |t: Value| crate::queries::run_bin(&p, "axoPlan", &[0.0, 100.0], &t.to_string()).unwrap();
    assert_ne!(axo(json!({})), axo(json!({"designOptions": "Dachform=B"})));
}

#[test]
fn kennzahlen_und_kosten_je_variante() {
    let p = project(&fixture());
    let ka = crate::queries::run(&p, "kennzahlen", &[], "").unwrap();
    let kb = crate::queries::run(&p, "kennzahlen", &[], r#"{"designOptions": "Dachform=B"}"#).unwrap();
    assert_ne!(ka, kb, "R1 zählt nur in A");
    let rows = compare(&p, None, None);
    assert_eq!(rows.len(), 2);
    assert!(rows[0].primary && !rows[1].primary);
    assert_eq!(rows[0].label, "Dachform A");
    assert!(rows[0].hnf > rows[1].hnf, "{} / {}", rows[0].hnf, rows[1].hnf);
    assert!(rows.iter().all(|r| r.gf.is_finite() && r.cost.is_finite()));
    // Mit Umbaufilter.
    let rb = compare(&p, Some("bestand"), None);
    assert_eq!(rb.len(), 2);
    // Abfrage und CSV.
    let q: Value = serde_json::from_str(&crate::queries::run(&p, "designOptionCompare", &[], "").unwrap()).unwrap();
    assert_eq!(q.as_array().unwrap().len(), 2);
    let csv: String = serde_json::from_str(&crate::queries::run(&p, "designOptionCompare", &[], r#"{"head": ["Variante","GF","HNF","GV","Fussabdruck","AZ","ÜZ","Kosten"]}"#).unwrap()).unwrap();
    assert!(csv.starts_with("Variante;GF;"));
    assert_eq!(csv.lines().count(), 3);
    // Info: Zahl der Elemente je Variante.
    let info: Value = serde_json::from_str(&crate::queries::run(&p, "designOptionInfo", &[], "").unwrap()).unwrap();
    assert_eq!(info[0]["options"][1]["count"], 4);
    assert_eq!(info[0]["primary"], "a");
}

fn doc() -> crate::document::Document {
    crate::document::Document::from_json(&fixture().to_string()).unwrap()
}

fn apply(d: &mut crate::document::Document, ops: &[Value]) {
    let ops: Vec<crate::ops::Op> = ops.iter().map(|o| crate::ops::Op::from_json(o).unwrap()).collect();
    d.commit(ops, None, 0.0, false).unwrap();
}

fn root_ops(d: &crate::document::Document, name: &str, text: Value) -> Vec<Value> {
    serde_json::from_str(&crate::queries::run_root(&d.lookup(), name, &text.to_string()).unwrap()).unwrap()
}

#[test]
fn variante_uebernehmen_und_rueckgaengig() {
    let mut d = doc();
    // Gespeicherte Wahl an einer Ebene wird mit aufgeräumt.
    apply(&mut d, &[json!({"kind": "replace", "collection": "drawingLevels", "entity": {"id": "eg", "name": "EG", "kind": "floor", "designOptions": {"dach": "b"}}})]);
    let before = d.to_json();
    let ops = root_ops(&d, "designOptionAcceptOps", json!({"set": "dach", "option": "b"}));
    apply(&mut d, &ops);
    let p = d.project().unwrap().clone();
    assert!(p.design_option_sets.as_deref().unwrap_or(&[]).is_empty());
    let w9 = p.walls.iter().find(|w| w.id == "W9").unwrap();
    assert!(w9.design_option.is_none());
    assert!(p.walls.iter().all(|w| w.id != "W2"), "Variante A gelöscht");
    assert!(p.rooms.iter().flatten().all(|r| r.id != "R1"));
    assert!(p.openings.iter().flatten().any(|o| o.id == "O2" && o.design_option.is_none()));
    assert!(p.drawing_levels.iter().all(|l| l.design_options.is_none()));
    // Öffnungen der gelöschten Wand W2 (keine) — die übrigen bleiben.
    assert!(p.openings.iter().flatten().any(|o| o.id == "O1"));
    // Ein Undo-Schritt stellt alles wieder her.
    d.undo().unwrap();
    assert_eq!(d.to_json(), before);
    // Unbekannt: keine Ops.
    assert!(root_ops(&d, "designOptionAcceptOps", json!({"set": "dach", "option": "z"})).is_empty());
    assert!(root_ops(&d, "designOptionAcceptOps", json!({"set": "weg", "option": "a"})).is_empty());
}

#[test]
fn satz_und_variante_loeschen() {
    let mut d = doc();
    let ops = root_ops(&d, "designOptionDeleteOps", json!({"set": "dach"}));
    apply(&mut d, &ops);
    let p = d.project().unwrap().clone();
    assert!(p.design_option_sets.as_deref().unwrap_or(&[]).is_empty());
    for id in ["W2", "W9"] {
        assert!(p.walls.iter().all(|w| w.id != id), "{id}");
    }
    assert!(p.roofs.iter().flatten().all(|r| r.id != "RF1"));
    assert!(p.drawings2d.iter().all(|x| x.id != "L-b"));
    // Variante löschen: Hauptvariante A weg ⇒ B wird Haupt.
    let mut d = doc();
    let ops = root_ops(&d, "designOptionDeleteOps", json!({"set": "dach", "option": "a"}));
    apply(&mut d, &ops);
    let p = d.project().unwrap().clone();
    let s = &p.design_option_sets.as_ref().unwrap()[0];
    assert_eq!(s.options.len(), 1);
    assert_eq!(s.primary.as_deref(), Some("b"));
    assert!(p.walls.iter().all(|w| w.id != "W2") && p.walls.iter().any(|w| w.id == "W9"));
    // Jetzt zeigt die Hauptkombination B.
    assert!(!Combination::primary(&p).hidden(&p).contains("W9"));
}

#[test]
fn zuweisen_und_kopieren() {
    let mut d = doc();
    let sel = json!({"walls": ["W1", "W9"], "rooms": ["R1"]});
    let ops = root_ops(&d, "designOptionAssignOps", json!({"set": "dach", "option": "b", "sel": sel}));
    // W9 ist schon in B: nur W1 und R1.
    assert_eq!(ops.len(), 2);
    apply(&mut d, &ops);
    let p = d.project().unwrap().clone();
    assert_eq!(p.walls.iter().find(|w| w.id == "W1").unwrap().design_option.as_ref().unwrap().option, "b");
    // Zurück ins Hauptmodell.
    let ops = root_ops(&d, "designOptionAssignOps", json!({"sel": {"walls": ["W1"]}}));
    apply(&mut d, &ops);
    assert!(d.project().unwrap().walls.iter().find(|w| w.id == "W1").unwrap().design_option.is_none());
    // Unbekannte Variante: nichts.
    assert!(root_ops(&d, "designOptionAssignOps", json!({"set": "dach", "option": "q", "sel": {"walls": ["W1"]}})).is_empty());
    // Kopieren: W1 samt Öffnungen D1/O1 in Variante A, neue Ids, Öffnungen auf der Kopie.
    let ops = root_ops(&d, "designOptionCopyOps", json!({"set": "dach", "option": "a", "sel": {"walls": ["W1"]}, "stamp": "k"}));
    apply(&mut d, &ops);
    let p = d.project().unwrap().clone();
    let copy = p.walls.iter().find(|w| w.id.starts_with("k-")).unwrap();
    assert_eq!(copy.design_option.as_ref().unwrap().option, "a");
    let kids: Vec<_> = p.openings.iter().flatten().filter(|o| o.host_wall_id == copy.id).collect();
    assert_eq!(kids.len(), 2);
    assert!(kids.iter().all(|o| o.design_option.as_ref().is_some_and(|r| r.option == "a")));
}

#[test]
fn neue_elemente_tragen_die_zeichen_variante() {
    use crate::ops::Op;
    let add = |c: &str| Op::Add { collection: c.into(), items: vec![json!({"id": "x"}), json!({"id": "y", "designOption": {"set": "s", "option": "o"}})], at: None };
    let out = stamp_ops(vec![add("walls"), add("drawings2d"), add("layers")], Some(&json!({"set": "dach", "option": "b"})));
    match &out[0] {
        Op::Add { items, .. } => {
            assert_eq!(items[0]["designOption"], json!({"set": "dach", "option": "b"}));
            assert_eq!(items[1]["designOption"]["set"], "s");
        }
        _ => panic!(),
    }
    assert!(matches!(&out[1], Op::Add { items, .. } if items[0]["designOption"]["option"] == "b"));
    assert!(matches!(&out[2], Op::Add { items, .. } if items[0].get("designOption").is_none()));
    for r in [json!({"set": "", "option": "b"}), json!({"set": 3}), json!(42), json!(null)] {
        let o = stamp_ops(vec![add("walls")], Some(&r));
        assert!(matches!(&o[0], Op::Add { items, .. } if items[0].get("designOption").is_none()), "{r}");
    }
    // Über den Befehl: `designOption` der Anfrage.
    let p = project(&fixture());
    let root = serde_json::to_value(&p).unwrap();
    let cmd = json!({"cmd": "wall", "levelId": "eg", "points": [{"x": 0, "y": 10}, {"x": 4, "y": 10}], "designOption": {"set": "dach", "option": "b"}});
    if let Ok(ops) = crate::commands::ops(root.as_object().unwrap(), &p, &cmd.to_string()) {
        for op in ops {
            if let Op::Add { collection, items, .. } = op {
                if collection == "walls" {
                    assert!(items.iter().all(|i| i["designOption"]["option"] == "b"));
                }
            }
        }
    }
}

#[test]
fn blatt_viewport_mit_eigener_kombination() {
    let p = project(&fixture());
    let snap: ViewSnapshot = serde_json::from_value(json!({"id": "s", "name": "EG", "activeLevelId": "eg", "viewType": "grundriss", "scaleDenominator": 100, "detail": "mittel", "layerVisibility": {}, "drawingVisibility": {}})).unwrap_or_default();
    let mut vp = LayoutViewport::default();
    vp.design_options = Some([("dach".to_string(), "b".to_string())].into());
    let s2 = crate::sheet_viewports::viewport_snapshot(&snap, &vp);
    assert_eq!(s2.design_options.as_ref().unwrap()["dach"], "b");
    let q = crate::sheet_viewports::snapshot_project(&p, &s2);
    let l = q.drawing_levels.iter().find(|l| l.id == "eg").unwrap();
    assert_eq!(l.design_options.as_ref().unwrap()["dach"], "b");
    // Ohne eigene Wahl unverändert (geliehen).
    assert!(matches!(crate::sheet_viewports::viewport_snapshot(&snap, &LayoutViewport::default()), std::borrow::Cow::Borrowed(_)));
}

#[test]
fn robust_bei_unsinn() {
    // Fehlende Felder, leere Sätze, Sätze ohne Varianten, unbekannte Ids, Unsinn in Anfragen.
    let mut v = fixture();
    v["designOptionSets"].as_array_mut().unwrap().push(json!({"id": "leer", "name": "", "options": []}));
    v["designOptionSets"].as_array_mut().unwrap().push(json!({}));
    v["walls"][0]["designOption"] = json!({});
    v["walls"][1]["designOption"] = json!({"set": "dach"});
    let p = project(&v);
    let c = Combination::primary(&p);
    assert!(!c.choice.contains_key("leer"));
    assert!(c.shows(p.walls[0].design_option.as_ref()), "leere Angabe = Hauptmodell");
    for t in ["", "{", "{}", "nan", r#"{"designOptions": 42}"#, r#"{"designOptions": [1, 2]}"#, r#"{"designOptions": {"dach": null}}"#, r#"{"renovation": 5}"#] {
        assert!(crate::queries::run(&p, "kennzahlen", &[], t).is_ok(), "{t}");
        assert!(crate::queries::run(&p, "designOptionCompare", &[], t).is_ok(), "{t}");
        assert!(crate::queries::run(&p, "model3dParts", &[1.0, f64::NAN, 0.0], t).is_ok(), "{t}");
    }
    let _ = plan_with(&p, json!({"designOptions": 42}));
    let _ = plan_with(&p, json!({"designOptions": {"dach": [1]}}));
    // Ops-Abfragen mit Unsinn: keine Ops bzw. Fehler, nie Panic.
    let d = crate::document::Document::from_json(&v.to_string()).unwrap();
    for t in ["{}", r#"{"set": 1}"#, r#"{"sel": 5}"#, r#"{"set": "dach", "option": "b", "sel": {"walls": [1]}}"#] {
        for n in ["designOptionAcceptOps", "designOptionDeleteOps", "designOptionAssignOps", "designOptionCopyOps"] {
            let _ = crate::queries::run_root(&d.lookup(), n, t);
        }
    }
    assert!(crate::queries::run_root(&d.lookup(), "designOptionAcceptOps", "kaputt").is_err());
    // Vergleich über viele Sätze bleibt beschränkt.
    let mut many = fixture();
    let sets: Vec<Value> = (0..8).map(|i| json!({"id": format!("s{i}"), "name": format!("S{i}"), "options": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}, {"id": "c", "name": "C"}]})).collect();
    many["designOptionSets"] = Value::Array(sets);
    many["walls"][0]["designOption"] = json!({"set": "s0", "option": "b"});
    let pm = project(&many);
    assert!(Combination::all(&pm).len() <= MAX_COMPARE);
}
