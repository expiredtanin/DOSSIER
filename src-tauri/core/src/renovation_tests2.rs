//! [271] Rest des Umbaufilters: Ersatzstücke in Schnitt und Ansicht, Projektionslinien, Möbel/2D-Elemente und Bäume.

use super::tests::{project, section_prims, umbau_fixture};
use super::*;
use crate::plan::domains::{plan_domains, PlanArgs};
use serde_json::{json, Value};

/// Umbau-Fixture mit Schnitt Q (Nord–Süd bei x = 3.5: trifft O1 in W1 und O2 in W3), Ansicht Nord, Möbeln (Sofa neu, Tisch
/// Abbruch, Sofa ohne Angabe), Linien (eine ohne Angabe, eine „neu“) und drei Bäumen (bestehend, zu fällen, neu).
fn fixture() -> Value {
    let mut v = umbau_fixture();
    v["drawingLevels"].as_array_mut().unwrap().extend([
        json!({"id": "schnitt-q", "name": "Schnitt Q", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": 3.5, "y": -1}, {"x": 3.5, "y": 5}], "directionSign": -1}),
        json!({"id": "ansicht-nord", "name": "Ansicht Nord", "kind": "elevation", "visible": true, "locked": false, "linePoints": [{"x": 6, "y": 6}, {"x": -1, "y": 6}], "directionSign": 1}),
    ]);
    let lib = |id: &str, lib: &str, x: f64, y: f64, r: Option<Value>| {
        let mut d = json!({"id": id, "type": "drawing2d", "levelId": "eg", "categoryCode": "22", "geom": {"shape": "libobj", "libId": lib, "at": {"x": x, "y": y}, "rotation": 0}});
        if let Some(r) = r {
            d["renovation"] = r;
        }
        d
    };
    let line = |id: &str, y: f64, r: Option<Value>| {
        let mut d = json!({"id": id, "type": "drawing2d", "levelId": "eg", "categoryCode": "22", "geom": {"shape": "line", "a": {"x": 0.5, "y": y}, "b": {"x": 1.5, "y": y}}});
        if let Some(r) = r {
            d["renovation"] = r;
        }
        d
    };
    let tree = |id: &str, x: f64, st: &str| {
        json!({"id": id, "type": "tree", "floorId": "eg", "categoryCode": "13", "position": {"x": x, "y": 2}, "trunkDiameter": 0.3, "crownDiameter": 3, "crownBase": 2, "height": 8, "shape": "round", "status": st, "foliage": "deciduous"})
    };
    v["drawings2d"].as_array_mut().unwrap().extend([
        lib("M1", "lib:sofa-2", 1.0, 1.0, Some(json!({"status": "new"}))),
        lib("M2", "lib:tisch-80x140", 3.0, 1.0, Some(json!({"status": "demolish"}))),
        lib("M3", "lib:sofa-2", 1.0, 3.0, None),
        line("L0", 3.6, None),
        line("L1", 3.8, Some(json!({"status": "new"}))),
    ]);
    v["trees"] = json!([tree("T1", 8.0, "existing"), tree("T2", 12.0, "remove"), tree("T3", 16.0, "new")]);
    let layers = v["layers"].as_array_mut().unwrap();
    if !layers.iter().any(|l| l["code"] == "22") {
        layers.push(json!({"code": "22", "name": "Möbel", "color": "#4a4a4a", "lw": 0.13, "visible": true, "locked": false}));
    }
    v
}

fn plan_args(extra: &Value) -> String {
    let codes: Vec<String> = (0..100).map(|k| format!("{k:02}")).collect();
    let mut t = json!({"floor": "eg", "show": codes, "scale": 100});
    for (k, x) in extra.as_object().unwrap() {
        t[k] = x.clone();
    }
    t.to_string()
}

fn drawings_with(p: &Project, extra: Value) -> Vec<Primitive> {
    plan_domains(p, &PlanArgs::parse_in(p, 1.0, &plan_args(&extra)).unwrap()).unwrap().drawings.prims
}

fn trees_with(p: &Project, extra: Value) -> Vec<Primitive> {
    plan_domains(p, &PlanArgs::parse_in(p, 1.0, &plan_args(&extra)).unwrap()).unwrap().columns
}

/// Linien einer Zeichnung: (Farbe, gestrichelt).
fn drawing_lines(prims: &[Primitive], id: &str) -> Vec<(String, bool)> {
    prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Line { drawing_id: Some(d), color, dash, .. } if d == id => Some((color.as_ref().map(|c| c.to_string()).unwrap_or_default(), matches!(dash, Some(Some(_))))),
            _ => None,
        })
        .collect()
}

#[test]
fn moebel_und_linienwerk_je_filter() {
    let p = project(&fixture());
    let new_c = default_style(RenovationStatus::New).line.unwrap();
    let dem_c = default_style(RenovationStatus::Demolish).fill;
    let ex_c = default_style(RenovationStatus::Existing).fill;
    // Ohne Filter: alles da, keine Umbau-Farbe.
    let all = drawings_with(&p, json!({}));
    for id in ["M1", "M2", "M3", "L0", "L1"] {
        let l = drawing_lines(&all, id);
        assert!(!l.is_empty(), "{id}");
        assert!(l.iter().all(|(c, d)| *c != new_c && *c != dem_c && *c != ex_c && !d), "{id}: {l:?}");
    }
    // Bestand: Neues fehlt (Sofa M1, Linie L1), der Abbruch-Tisch steht noch.
    let b = drawings_with(&p, json!({"renovation": "bestand"}));
    assert!(drawing_lines(&b, "M1").is_empty() && drawing_lines(&b, "L1").is_empty());
    assert!(!drawing_lines(&b, "M2").is_empty() && !drawing_lines(&b, "M3").is_empty() && !drawing_lines(&b, "L0").is_empty());
    // Endzustand: ohne Abbruch-Möbel, Neues da, ohne Farbe.
    let e = drawings_with(&p, json!({"renovation": "endzustand"}));
    assert!(drawing_lines(&e, "M2").is_empty(), "Abbruch-Tisch fehlt im Endzustand");
    assert!(!drawing_lines(&e, "M1").is_empty() && !drawing_lines(&e, "M3").is_empty() && !drawing_lines(&e, "L1").is_empty());
    assert!(drawing_lines(&e, "M1").iter().all(|(c, _)| *c != new_c));
    // Umbauplan: Bestand grau, Abbruch gelb gestrichelt, Neu rot; eine Linie ohne Angabe bleibt unverändert.
    let u = drawings_with(&p, json!({"renovation": "umbauplan"}));
    assert!(drawing_lines(&u, "M3").iter().all(|(c, d)| *c == ex_c && !d), "{:?}", drawing_lines(&u, "M3"));
    assert!(drawing_lines(&u, "M2").iter().all(|(c, d)| *c == dem_c && *d), "{:?}", drawing_lines(&u, "M2"));
    assert!(drawing_lines(&u, "M1").iter().all(|(c, d)| *c == new_c && !d), "{:?}", drawing_lines(&u, "M1"));
    assert!(drawing_lines(&u, "L1").iter().all(|(c, _)| *c == new_c));
    assert!(drawing_lines(&u, "L0").iter().all(|(c, d)| *c != ex_c && !d), "ohne Angabe nicht grau: {:?}", drawing_lines(&u, "L0"));
    // Neubau: Abbruch weg, Neu rot, Bestand ohne Farbe.
    let n = drawings_with(&p, json!({"renovation": "neubau"}));
    assert!(drawing_lines(&n, "M2").is_empty() && drawing_lines(&n, "M1").iter().all(|(c, _)| *c == new_c));
    assert!(drawing_lines(&n, "M3").iter().all(|(c, _)| *c != ex_c));
    // Der Filter der Ebene wirkt ebenso (ohne Argument).
    let mut v = fixture();
    for l in v["drawingLevels"].as_array_mut().unwrap() {
        if l["id"] == "eg" {
            l["renovationFilter"] = json!("endzustand");
        }
    }
    assert!(drawing_lines(&drawings_with(&project(&v), json!({})), "M2").is_empty());
}

#[test]
fn moebel_filter_unsinn_bleibt_ruhig() {
    // Unbekannter Status und Etappe, unbekanntes Objekt, absurde Lage: kein Panic, alles endlich.
    let mut v = fixture();
    for d in v["drawings2d"].as_array_mut().unwrap() {
        if d["id"] == "M1" {
            d["renovation"] = json!({"status": "kaputt", "phase": "gibts-nicht"});
        }
        if d["id"] == "M3" {
            d["geom"]["libId"] = json!("lib:zukunft");
            d["geom"]["at"] = json!({"x": 1e300, "y": -1e300});
        }
    }
    let p = project(&v);
    for f in ["bestand", "abbruch", "neubau", "umbauplan", "endzustand", "", "gibts-nicht"] {
        let prims = drawings_with(&p, json!({"renovation": f, "renovationPhase": "etappe-x"}));
        assert!(prims.iter().all(|q| !matches!(q, Primitive::Line { a, .. } if a.x.is_nan() || a.y.is_nan())), "{f}");
    }
    // Ein unbekannter Status gilt als Bestand: im Bestandsplan steht M1.
    assert!(!drawing_lines(&drawings_with(&p, json!({"renovation": "bestand"})), "M1").is_empty());
}

fn tree_lines_at(prims: &[Primitive], x: f64) -> Vec<(String, bool)> {
    prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Line { a, cls, color, dash, .. } if &**cls == "tree-crown" && (a.x - x).abs() < 1.6 && (a.y - 2.0).abs() < 1.6 => {
                Some((color.as_ref().map(|c| c.to_string()).unwrap_or_default(), matches!(dash, Some(Some(_)))))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn baeume_folgen_dem_umbau_status() {
    let p = project(&fixture());
    // Der Bestand des Baums ([149]) IST der Umbau-Status: bestehend = Bestand, zu fällen = Abbruch, neu = Neu.
    let t = |s: &str| tree_renovation(&Tree { status: serde_json::from_value(json!(s)).unwrap(), ..Default::default() }).status;
    assert_eq!((t("existing"), t("remove"), t("new"), t("unbekannt")), (RenovationStatus::Existing, RenovationStatus::Demolish, RenovationStatus::New, RenovationStatus::Existing));
    let trees = |extra: Value| {
        let d = trees_with(&p, extra);
        [8.0, 12.0, 16.0].map(|x| tree_lines_at(&d, x))
    };
    // Ohne Filter: alle drei.
    assert!(trees(json!({})).iter().all(|l| !l.is_empty()));
    // Bestand: der neue Baum fehlt, der zu fällende steht noch. Endzustand: der zu fällende fehlt.
    let b = trees(json!({"renovation": "bestand"}));
    assert!(!b[0].is_empty() && !b[1].is_empty() && b[2].is_empty(), "{:?}", b.iter().map(|l| l.len()).collect::<Vec<_>>());
    let e = trees(json!({"renovation": "endzustand"}));
    assert!(!e[0].is_empty() && e[1].is_empty() && !e[2].is_empty());
    // Umbauplan: grau / gelb gestrichelt / rot.
    let u = trees(json!({"renovation": "umbauplan"}));
    assert!(u[0].iter().all(|(c, d)| *c == default_style(RenovationStatus::Existing).fill && !d), "{:?}", u[0]);
    assert!(u[1].iter().any(|(_, d)| *d) && u[1].iter().any(|(c, _)| *c == default_style(RenovationStatus::Demolish).fill), "{:?}", u[1]);
    assert!(u[2].iter().all(|(c, _)| *c == default_style(RenovationStatus::New).line.unwrap()), "{:?}", u[2]);
    // Projekt im Zustand: der zu fällende Baum fehlt im Endzustand (Schnitt, Ansicht, 3D), der neue im Bestand.
    let ids = |q: &Project| q.trees.iter().flatten().map(|t| t.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&project_in_state(&p, Some("endzustand"), None)), vec!["T1", "T3"]);
    assert_eq!(ids(&project_in_state(&p, Some("bestand"), None)), vec!["T1", "T2"]);
}

fn section_q(p: &Project, extra: Value) -> Vec<Primitive> {
    let level = p.drawing_levels.iter().find(|l| l.id == "schnitt-q").unwrap();
    let mut v = json!({"level": level, "scale": 50, "detail": "mittel"});
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    let buf = crate::queries::run_bin(p, "sectionPlan", &[0.0, 1.0, 0.0], &v.to_string()).unwrap();
    crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default()
}

fn elevation_of(p: &Project, level: &str, extra: Value) -> Vec<Primitive> {
    let level = p.drawing_levels.iter().find(|l| l.id == level).unwrap();
    let mut v = json!({"level": level});
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    let buf = crate::queries::run_bin(p, "elevationPlan", &[0.0, 0.0, 100.0], &v.to_string()).unwrap();
    crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default()
}

/// Flächen eines Ersatzstücks: Polygone der Öffnung `id` mit dieser Füllung.
fn patch_polys<'a>(prims: &'a [Primitive], id: &str, fill: &str) -> Vec<&'a Vec<Vec2>> {
    prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Polygon { pts, fill: f, opening_id: Some(o), .. } if o == id && f == fill => Some(pts),
            _ => None,
        })
        .collect()
}

fn bbox(pts: &[Vec2]) -> [f64; 4] {
    pts.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q.x), b[1].min(q.y), b[2].max(q.x), b[3].max(q.y)])
}

#[test]
fn schnitt_zeigt_abbruch_stueck_und_ausfachung() {
    let p = project(&fixture());
    let (yellow, red) = (default_style(RenovationStatus::Demolish).fill, default_style(RenovationStatus::New).fill);
    // Umbauplan: neue Öffnung O1 in Bestandswand W1 = gelbes Abbruch-Stück, zugemauerte O2 in W3 = rote Ausfachung.
    let u = section_q(&p, json!({"renovation": "umbauplan"}));
    let o1 = patch_polys(&u, "O1", &yellow);
    let o2 = patch_polys(&u, "O2", &red);
    assert_eq!((o1.len(), o2.len()), (1, 1));
    // Lage: Brüstung 0.9 bis Sturz 2.1 (O1) bzw. 2.2 (O2), Breite = Wanddicke 0.345.
    let b1 = bbox(o1[0]);
    assert!((b1[1] - 0.9).abs() < 1e-6 && (b1[3] - 2.1).abs() < 1e-6, "{b1:?}");
    assert!((b1[2] - b1[0] - 0.345).abs() < 1e-3, "{b1:?}");
    let b2 = bbox(o2[0]);
    assert!((b2[1] - 0.9).abs() < 1e-6 && (b2[3] - 2.2).abs() < 1e-6, "{b2:?}");
    // Abbruch gestrichelt umrandet, Ausfachung nicht.
    assert!(u.iter().any(|q| matches!(q, Primitive::Line { dash: Some(Some(_)), opening_id: Some(o), .. } if o == "O1")));
    assert!(!u.iter().any(|q| matches!(q, Primitive::Line { dash: Some(Some(_)), opening_id: Some(o), .. } if o == "O2")));
    // Abbruchplan: O1 fehlt (Wand zu), das gelbe Stück liegt über der Wand; O2 steht.
    let a = section_q(&p, json!({"renovation": "abbruch"}));
    assert_eq!(patch_polys(&a, "O1", &yellow).len(), 1);
    assert!(patch_polys(&a, "O2", &red).is_empty());
    // Neubauplan: O2 zugemauert, rote Ausfachung über der geschlossenen Wand; kein Abbruch-Stück.
    let n = section_q(&p, json!({"renovation": "neubau"}));
    assert_eq!(patch_polys(&n, "O2", &red).len(), 1);
    assert!(patch_polys(&n, "O1", &yellow).is_empty());
    // Bestand, Endzustand und ohne Filter: keine Ersatzstücke.
    for f in [json!({"renovation": "bestand"}), json!({"renovation": "endzustand"}), json!({})] {
        let q = section_q(&p, f.clone());
        assert!(patch_polys(&q, "O1", &yellow).is_empty() && patch_polys(&q, "O2", &red).is_empty(), "{f}");
    }
    // Der Filter der Ebene wirkt ohne Argument.
    let mut v = fixture();
    for l in v["drawingLevels"].as_array_mut().unwrap() {
        if l["id"] == "schnitt-q" {
            l["renovationFilter"] = json!("umbauplan");
        }
    }
    assert_eq!(patch_polys(&section_q(&project(&v), json!({})), "O1", &yellow).len(), 1);
}

#[test]
fn schnitt_ersatzstueck_ohne_treffer_und_unsinn() {
    let yellow = default_style(RenovationStatus::Demolish).fill;
    // Schnitt A (y = 2) trifft O1/O2 nicht: kein Stück, kein Fehler.
    let p = project(&fixture());
    assert!(patch_polys(&section_prims(&p, json!({"renovation": "umbauplan"})), "O1", &yellow).is_empty());
    // Schnittlinie entartet (beide Punkte gleich) bzw. parallel zur Wand: nichts, kein Panic.
    for pts in [json!([{"x": 3.5, "y": 1}, {"x": 3.5, "y": 1}]), json!([{"x": 0, "y": 0.001}, {"x": 5, "y": 0.001}])] {
        let mut v = fixture();
        for l in v["drawingLevels"].as_array_mut().unwrap() {
            if l["id"] == "schnitt-q" {
                l["linePoints"] = pts.clone();
            }
        }
        let q = section_q(&project(&v), json!({"renovation": "umbauplan"}));
        assert!(patch_polys(&q, "O1", &yellow).is_empty());
    }
    // Öffnung ohne Breite: kein Stück.
    let mut v = fixture();
    for o in v["openings"].as_array_mut().unwrap() {
        if o["id"] == "O1" {
            o["width"] = json!(0);
        }
    }
    assert!(patch_polys(&section_q(&project(&v), json!({"renovation": "umbauplan"})), "O1", &yellow).is_empty());
}

#[test]
fn schnitt_projektionslinien_in_umbau_farbe() {
    let p = project(&fixture());
    let red = default_style(RenovationStatus::New).line.unwrap();
    // Linien hinter der Schnittebene: W9 (neu, x = 2.4) bzw. W2 (Abbruch, x = 5), je nach Blickrichtung.
    let count = |v: &[Primitive]| {
        let vis = |q: &&Primitive| matches!(q, Primitive::Line { cls, .. } if &**cls == "section-visible");
        let red_n = v.iter().filter(vis).filter(|q| matches!(q, Primitive::Line { color: Some(c), .. } if **c == *red)).count();
        let dash_n = v.iter().filter(vis).filter(|q| matches!(q, Primitive::Line { dash: Some(Some(_)), .. })).count();
        (red_n, dash_n)
    };
    assert_eq!(count(&section_q(&p, json!({}))), (0, 0), "ohne Filter keine Umbau-Linien");
    let u = count(&section_q(&p, json!({"renovation": "umbauplan"})));
    assert!(u.0 + u.1 > 0, "Projektion in Umbau-Farbe: {u:?}");
    // Im Endzustand ohne Farbe.
    assert_eq!(count(&section_q(&p, json!({"renovation": "endzustand"}))), (0, 0));
}

#[test]
fn ansicht_ersatzstuecke_und_oeffnungen_in_umbau_farbe() {
    let p = project(&fixture());
    let (yellow, red) = (default_style(RenovationStatus::Demolish).fill, default_style(RenovationStatus::New).fill);
    let red_line = default_style(RenovationStatus::New).line.unwrap();
    // Ansicht Süd, Umbauplan: O1 (neu) als rotes Fenster, darunter das gelbe Abbruch-Stück (gestrichelt umrandet).
    let u = elevation_of(&p, "ansicht-sued", json!({"renovation": "umbauplan"}));
    assert_eq!(patch_polys(&u, "O1", &yellow).len(), 1);
    assert!(u.iter().any(|q| matches!(q, Primitive::Line { dash: Some(Some(_)), opening_id: Some(o), .. } if o == "O1")));
    assert!(u.iter().any(|q| matches!(q, Primitive::Polygon { stroke, opening_id: Some(o), .. } if o == "O1" && *stroke == red_line)), "Fensterlinien rot");
    // Das Stück liegt auf der Öffnung: Breite 1.0, Höhe 1.2.
    let b = bbox(patch_polys(&u, "O1", &yellow)[0]);
    assert!((b[2] - b[0] - 1.0).abs() < 1e-3 && (b[3] - b[1] - 1.2).abs() < 1e-3, "{b:?}");
    // Abbruchplan: die Öffnung fehlt (Wand zu), das gelbe Stück liegt auf der Fassade.
    let a = elevation_of(&p, "ansicht-sued", json!({"renovation": "abbruch"}));
    assert_eq!(patch_polys(&a, "O1", &yellow).len(), 1);
    // Bestand, Endzustand, ohne Filter: kein Ersatzstück.
    for f in [json!({"renovation": "bestand"}), json!({"renovation": "endzustand"}), json!({})] {
        assert!(patch_polys(&elevation_of(&p, "ansicht-sued", f.clone()), "O1", &yellow).is_empty(), "{f}");
    }
    // Ansicht Nord: die zugemauerte O2 in W3 trägt im Neubauplan die rote Ausfachung.
    let n = elevation_of(&p, "ansicht-nord", json!({"renovation": "neubau"}));
    assert_eq!(patch_polys(&n, "O2", &red).len(), 1, "Ausfachung O2");
    // Von Süden liegt W3 hinter W1: kein Stück (verdeckt).
    assert!(patch_polys(&elevation_of(&p, "ansicht-sued", json!({"renovation": "neubau"})), "O2", &red).is_empty());
}

#[test]
fn zeichen_status_fuer_baeume_und_zeichnungen() {
    use crate::ops::Op;
    let line = json!({"id": "l", "geom": {"shape": "line"}});
    let dim = json!({"id": "d", "geom": {"shape": "dimension"}});
    let lib = json!({"id": "m", "geom": {"shape": "libobj"}});
    let tree = json!({"id": "t", "status": "existing"});
    let tree_own = json!({"id": "t2", "status": "remove"});
    let add = |c: &str, items: Vec<Value>| Op::Add { collection: c.into(), items, at: None };
    let out = crate::commands::stamp_renovation(vec![add("drawings2d", vec![line, dim, lib]), add("trees", vec![tree.clone(), tree_own])], Some(&json!({"status": "new"})));
    match &out[0] {
        Op::Add { items, .. } => {
            assert_eq!(items[0]["renovation"], json!({"status": "new"}));
            assert!(items[1].get("renovation").is_none(), "Masse sind keine Bauteile");
            assert_eq!(items[2]["renovation"], json!({"status": "new"}));
        }
        _ => panic!(),
    }
    // Bäume: der Status des Baums ist der Umbau-Status; eine eigene Angabe bleibt.
    match &out[1] {
        Op::Add { items, .. } => assert_eq!((items[0]["status"].as_str(), items[1]["status"].as_str()), (Some("new"), Some("remove"))),
        _ => panic!(),
    }
    let out = crate::commands::stamp_renovation(vec![add("trees", vec![tree])], Some(&json!({"status": "demolish"})));
    assert!(matches!(&out[0], Op::Add { items, .. } if items[0]["status"] == "remove"));
}

/// Bäume (Pick-Id `tree:<id>`) in einer Schnitt-/Ansichts-Ausgabe.
fn trees_in(prims: &[Primitive]) -> std::collections::BTreeSet<String> {
    prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Polygon { context_object_id: Some(c), .. } => c.strip_prefix(crate::tree::TREE_PICK_PREFIX).map(String::from),
            _ => None,
        })
        .collect()
}

#[test]
fn baeume_in_schnitt_und_ansicht_folgen_dem_filter() {
    let p = project(&fixture());
    let set = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<std::collections::BTreeSet<_>>();
    // Schnitt Q blickt nach Osten (x = 3.5, Richtung −1): alle drei Bäume stehen dahinter; Ansicht Süd blickt nach Norden.
    let all = trees_in(&section_q(&p, json!({})));
    assert_eq!(all, set(&["T1", "T2", "T3"]), "ohne Filter alle");
    assert_eq!(trees_in(&section_q(&p, json!({"renovation": "bestand"}))), set(&["T1", "T2"]));
    assert_eq!(trees_in(&section_q(&p, json!({"renovation": "abbruch"}))), set(&["T1", "T2"]));
    assert_eq!(trees_in(&section_q(&p, json!({"renovation": "endzustand"}))), set(&["T1", "T3"]));
    assert_eq!(trees_in(&section_q(&p, json!({"renovation": "neubau"}))), set(&["T1", "T3"]));
    let south = |f: Value| trees_in(&elevation_of(&p, "ansicht-sued", f));
    assert_eq!(south(json!({"renovation": "bestand"})), set(&["T1", "T2"]));
    assert_eq!(south(json!({"renovation": "endzustand"})), set(&["T1", "T3"]));
    // Umbauplan: der zu fällende Baum gelb gestrichelt, der neue rot (Linienfarbe), der bestehende grau.
    let u = section_q(&p, json!({"renovation": "umbauplan"}));
    let stroke_of = |id: &str| -> Vec<String> {
        u.iter()
            .filter_map(|q| match q {
                Primitive::Polygon { stroke, context_object_id: Some(c), .. } if c.strip_prefix(crate::tree::TREE_PICK_PREFIX) == Some(id) && stroke != "none" => Some(stroke.clone()),
                _ => None,
            })
            .collect()
    };
    // Teilweise verdeckte Bäume ([149]) zeichnen ihre sichtbaren Teile als Linien (`tree-view`, ohne Pick-Id): dann zählen die
    // Linienfarben aller Bäume mit.
    let line_colors: Vec<String> = u.iter().filter_map(|q| match q { Primitive::Line { cls, color: Some(c), .. } if &**cls == "tree-view" => Some(c.to_string()), _ => None }).collect();
    let new = default_style(RenovationStatus::New).line.unwrap();
    assert!(stroke_of("T3").iter().chain(&line_colors).any(|c| *c == new), "T3 rot: {:?} {:?}", stroke_of("T3"), line_colors);
    assert!(stroke_of("T3").iter().all(|c| *c == new), "{:?}", stroke_of("T3"));
    assert!(stroke_of("T1").iter().all(|c| *c == default_style(RenovationStatus::Existing).fill), "{:?}", stroke_of("T1"));
}

#[test]
fn bogenwand_traegt_ersatzstueck_in_allen_drei_zeichnungen() {
    // W1 als flacher Bogen (Bulge): O1 (neu) bleibt eine Öffnung in einer Bestandswand.
    let mut v = fixture();
    for w in v["walls"].as_array_mut().unwrap() {
        if w["id"] == "W1" {
            w["bulge"] = json!(0.15);
        }
    }
    let p = project(&v);
    let yellow = default_style(RenovationStatus::Demolish).fill;
    // Grundriss (Abbruchplan: die Öffnung fehlt, das Stück liegt über der Wand): ein endliches Ringstück mit Fläche.
    let walls = plan_domains(&p, &PlanArgs::parse_in(&p, 1.0, &plan_args(&json!({"renovation": "abbruch"}))).unwrap()).unwrap().walls;
    let rings = patch_polys(&walls, "O1", &yellow);
    assert_eq!(rings.len(), 1, "Grundriss");
    let b = bbox(rings[0]);
    assert!(b.iter().all(|x| x.is_finite()) && b[2] - b[0] > 0.5 && b[3] - b[1] > 0.3, "{b:?}");
    // Schnitt und Ansicht: die Sehne der Öffnung wie beim Einbauteil selbst.
    assert_eq!(patch_polys(&section_q(&p, json!({"renovation": "umbauplan"})), "O1", &yellow).len(), 1);
    assert_eq!(patch_polys(&elevation_of(&p, "ansicht-sued", json!({"renovation": "umbauplan"})), "O1", &yellow).len(), 1);
}

/// DXF-Ebenenliste (Strings des Exports) eines Projekts, Grundriss EG mit allen Ebenen.
fn dxf_layer_names(p: &Project) -> Vec<String> {
    let a = PlanArgs::parse(1.0, &plan_args(&json!({}))).unwrap();
    let buf = crate::plan::domains::plan_domains_buf(p, &a).unwrap();
    let view = crate::plan::buf::View::parse(&buf).unwrap();
    let len = view.len();
    let mut parts = [crate::plan::parts::Part::new(view, 0, len).unwrap()];
    let o = crate::plan::dxf::DxfOptions { scale: 100.0, include_hatches: true, dim_cm: false, paper_layout: false, bounds: [0.0, 0.0, 20.0, 6.0], default_font: "Arial".into(), floor: "eg".into(), table_labels: String::new() };
    crate::plan::dxf::collect(&mut parts, p, &o).unwrap().strings
}

#[test]
fn dxf_ebenen_fuer_moebel_und_baeume() {
    let mut v = fixture();
    let s = dxf_layer_names(&project(&v));
    // Möbel (M1 neu, M2 Abbruch) und Bäume (T2 zu fällen, T3 neu) auf Status-Ebenen ihrer Kategorie.
    for n in ["22_Möbel_Abbruch", "22_Möbel_Neu", "13_Bäume_Abbruch", "13_Bäume_Neu"] {
        assert!(s.iter().any(|x| x == n), "{n} fehlt: {:?}", s.iter().filter(|x| x.contains('_')).collect::<Vec<_>>());
    }
    // Bestand (M3, T1) bleibt auf der Kategorie-Ebene.
    assert!(s.iter().any(|x| x == "22_Möbel") && s.iter().any(|x| x == "13_Bäume"));
    // Ohne Umbau-Angaben keine Status-Ebenen für Möbel/Bäume.
    for coll in ["drawings2d", "trees"] {
        for d in v[coll].as_array_mut().unwrap() {
            d.as_object_mut().unwrap().remove("renovation");
            if coll == "trees" {
                d["status"] = json!("existing");
            }
        }
    }
    let s = dxf_layer_names(&project(&v));
    assert!(!s.iter().any(|x| x.starts_with("22_") && (x.ends_with("_Abbruch") || x.ends_with("_Neu"))));
    assert!(!s.iter().any(|x| x.starts_with("13_") && (x.ends_with("_Abbruch") || x.ends_with("_Neu"))));
}
