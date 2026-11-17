//! [271] Tests des Umbaufilters: Vorgaben, Etappen, Öffnungen in Bestandswänden, Robustheit.

use super::*;
use serde_json::{json, Value};

/// Musterhaus (Fixture) mit Umbau-Angaben: W2 Abbruch, W9 Neu (Etappe 2), O1 neue Öffnung in Bestandswand W1,
/// O2 zugemauert (Abbruch) in W3, Decke C1 Bestand; Etappen e1, e2.
pub(crate) fn umbau_fixture() -> Value {
    let mut v: Value = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
    let set = |v: &mut Value, coll: &str, id: &str, r: Value| {
        for x in v[coll].as_array_mut().unwrap() {
            if x["id"] == id {
                x["renovation"] = r.clone();
            }
        }
    };
    set(&mut v, "walls", "W2", json!({"status": "demolish"}));
    set(&mut v, "walls", "W9", json!({"status": "new", "phase": "e2"}));
    set(&mut v, "openings", "O1", json!({"status": "new"}));
    set(&mut v, "openings", "O2", json!({"status": "demolish"}));
    v["renovation"] = json!({"phases": [{"id": "e1", "name": "Etappe 1"}, {"id": "e2", "name": "Etappe 2"}]});
    v
}

pub(crate) fn project(v: &Value) -> Project {
    serde_json::from_value(v.clone()).unwrap()
}

fn st(s: &str) -> Option<Renovation> {
    Some(Renovation { status: serde_json::from_value(json!(s)).unwrap(), ..Default::default() })
}

#[test]
fn vorgaben_je_status() {
    let p = project(&umbau_fixture());
    let t = |f: &str, s: &str| View::new(&p, Some(f), None).unwrap().treat(st(s).as_ref());
    let ex = |s| Treat::Style(default_style(s));
    // Bestand: alles, was heute steht.
    assert_eq!(t("bestand", "existing"), Treat::Show);
    assert_eq!(t("bestand", "demolish"), Treat::Show);
    assert_eq!(t("bestand", "new"), Treat::Hide);
    // Abbruch: Abbruch gelb, Neues fehlt.
    assert_eq!(t("abbruch", "demolish"), ex(RenovationStatus::Demolish));
    assert_eq!(t("abbruch", "new"), Treat::Hide);
    // Neubau: Neu rot, Abbruch weg.
    assert_eq!(t("neubau", "new"), ex(RenovationStatus::New));
    assert_eq!(t("neubau", "demolish"), Treat::Hide);
    assert_eq!(t("neubau", "existing"), Treat::Show);
    // Umbauplan: alle drei farbig.
    assert_eq!(t("umbauplan", "existing"), ex(RenovationStatus::Existing));
    assert_eq!(t("umbauplan", "demolish"), ex(RenovationStatus::Demolish));
    assert_eq!(t("umbauplan", "new"), ex(RenovationStatus::New));
    // Endzustand: ohne Farbe, Abbruch weg.
    assert_eq!(t("endzustand", "new"), Treat::Show);
    assert_eq!(t("endzustand", "demolish"), Treat::Hide);
    // Fehlender Status = Bestand.
    assert_eq!(View::new(&p, Some("umbauplan"), None).unwrap().treat(None), ex(RenovationStatus::Existing));
    // SIA: Abbruch gelb gestrichelt, Neu rot.
    assert!(default_style(RenovationStatus::Demolish).dashed);
    assert_eq!(default_style(RenovationStatus::New).fill, NEW_FILL);
}

#[test]
fn kein_filter_ohne_gueltige_id() {
    let p = project(&umbau_fixture());
    assert!(View::new(&p, None, None).is_none());
    assert!(View::new(&p, Some(""), None).is_none());
    assert!(View::new(&p, Some("gibts-nicht"), None).is_none());
    // Name ohne Gross-/Kleinschreibung (CLI).
    assert_eq!(View::new(&p, Some("Umbauplan"), None).unwrap().filter.unwrap().id, "umbauplan");
}

#[test]
fn eigene_farben_und_filter() {
    let mut v = umbau_fixture();
    v["renovation"]["styles"] = json!({"new": {"fill": "#00ff00", "line": ""}, "demolish": {"dashed": false}});
    v["renovation"]["filters"] = json!([{"id": "f1", "name": "Nur Neu", "existing": "hide", "demolish": "hide", "new": "override"}]);
    let p = project(&v);
    let s = style(&p, RenovationStatus::New);
    assert_eq!(s.fill, "#00ff00");
    assert_eq!(s.line, None);
    assert!(!style(&p, RenovationStatus::Demolish).dashed);
    let f = View::new(&p, Some("Nur Neu"), None).unwrap();
    assert_eq!(f.treat(None), Treat::Hide);
    assert_eq!(f.treat(st("new").as_ref()), Treat::Style(s));
    assert_eq!(filter_list(&p).len(), 6);
}

#[test]
fn etappen() {
    let p = project(&umbau_fixture());
    let e = |s: &str, ph: Option<&str>| Some(Renovation { status: serde_json::from_value(json!(s)).unwrap(), phase: ph.map(String::from), ..Default::default() });
    let v1 = View::new(&p, Some("umbauplan"), Some("e1")).unwrap();
    let v2 = View::new(&p, Some("umbauplan"), Some("Etappe 2")).unwrap();
    assert_eq!(v2.upto, Some(1));
    // Neu in Etappe 2: in Etappe 1 noch nicht da, in Etappe 2 neu.
    assert_eq!(v1.state(e("new", Some("e2")).as_ref()), None);
    assert_eq!(v2.state(e("new", Some("e2")).as_ref()), Some(RenovationStatus::New));
    // Neu in Etappe 1 (auch ohne Etappe = erste): in Etappe 2 Bestand.
    assert_eq!(v2.state(e("new", None).as_ref()), Some(RenovationStatus::Existing));
    // Abbruch in Etappe 2: in Etappe 1 noch Bestand; Abbruch in Etappe 1: in Etappe 2 schon weg.
    assert_eq!(v1.state(e("demolish", Some("e2")).as_ref()), Some(RenovationStatus::Existing));
    assert_eq!(v2.state(e("demolish", Some("e1")).as_ref()), None);
    assert_eq!(v2.treat(e("demolish", Some("e1")).as_ref()), Treat::Hide);
    // Ohne Etappe im Filter: Status unverändert.
    let all = View::new(&p, Some("umbauplan"), None).unwrap();
    assert_eq!(all.state(e("new", Some("e2")).as_ref()), Some(RenovationStatus::New));
    // Unbekannte Etappe im Filter = alle; unbekannte Etappe am Element = erste.
    assert_eq!(View::new(&p, Some("umbauplan"), Some("x")).unwrap().upto, None);
    assert_eq!(v2.state(e("new", Some("x")).as_ref()), Some(RenovationStatus::Existing));
}

#[test]
fn aufloesen_mit_oeffnungen_in_bestandswand() {
    let p = project(&umbau_fixture());
    // Bestand: neue Wand W9 und neue Öffnung O1 fehlen (O1 schliesst die Wand), kein Ersatzstück.
    let r = View::new(&p, Some("bestand"), None).unwrap().resolve(&p);
    assert!(r.hidden.contains("W9") && r.hidden.contains("O1") && !r.hidden.contains("W2") && !r.hidden.contains("O2"));
    assert!(r.styled.is_empty() && r.patches.is_empty());
    // Abbruch: W2 und O2 gelb; O1 fehlt, an ihrer Stelle das gelbe Abbruch-Stück über der geschlossenen Wand.
    let r = View::new(&p, Some("abbruch"), None).unwrap().resolve(&p);
    assert!(r.styled.contains_key("W2") && r.styled.contains_key("O2"));
    assert_eq!(r.patches.len(), 1);
    assert_eq!((r.patches[0].opening_id.as_str(), r.patches[0].status, r.patches[0].closed), ("O1", RenovationStatus::Demolish, true));
    // Neubau: W2 weg, O2 zugemauert (ausgeblendet, rote Ausfachung), O1 rot, ohne Abbruch-Stück.
    let r = View::new(&p, Some("neubau"), None).unwrap().resolve(&p);
    assert!(r.hidden.contains("W2") && r.hidden.contains("O2") && !r.hidden.contains("O1"));
    assert!(r.styled.contains_key("O1") && r.styled.contains_key("W9") && !r.styled.contains_key("W1"));
    assert_eq!(r.patches.iter().map(|x| (x.opening_id.as_str(), x.status, x.closed)).collect::<Vec<_>>(), vec![("O2", RenovationStatus::New, true)]);
    // Umbauplan: beide Ersatzstücke in der offenen Öffnung, Bestand grau.
    let r = View::new(&p, Some("umbauplan"), None).unwrap().resolve(&p);
    assert_eq!(r.patches.len(), 2);
    assert!(r.patches.iter().all(|x| !x.closed));
    assert_eq!(r.styled["W1"], default_style(RenovationStatus::Existing));
    // Die Tür D1 ohne eigenen Status folgt ihrer Bestandswand.
    assert_eq!(r.styled["D1"], default_style(RenovationStatus::Existing));
    // Endzustand: wie Neubau ohne Farbe.
    let r = View::new(&p, Some("endzustand"), None).unwrap().resolve(&p);
    assert!(r.hidden.contains("W2") && r.hidden.contains("O2") && r.styled.is_empty() && r.patches.is_empty());
}

#[test]
fn oeffnung_folgt_abgebrochener_wand() {
    let mut v = umbau_fixture();
    for w in v["walls"].as_array_mut().unwrap() {
        if w["id"] == "W1" {
            w["renovation"] = json!({"status": "demolish"});
        }
    }
    let p = project(&v);
    let r = View::new(&p, Some("neubau"), None).unwrap().resolve(&p);
    // Ausgeblendete Wand nimmt ihre Öffnungen mit, auch die „neue“ O1.
    assert!(r.hidden.contains("W1") && r.hidden.contains("D1") && r.hidden.contains("O1"));
    let r = View::new(&p, Some("abbruch"), None).unwrap().resolve(&p);
    assert!(r.styled.contains_key("D1"));
    // Kein Ersatzstück in einer Abbruch-Wand.
    assert!(r.patches.iter().all(|x| x.wall_id != "W1"));
}

#[test]
fn robust_bei_unbekannten_werten() {
    let mut v = umbau_fixture();
    for w in v["walls"].as_array_mut().unwrap() {
        if w["id"] == "W3" {
            w["renovation"] = json!({"status": "abgerissen", "phase": "nirgends"});
        }
        if w["id"] == "W4" {
            w["renovation"] = json!({});
        }
    }
    let p = project(&v);
    assert_eq!(status_of(p.walls.iter().find(|w| w.id == "W3").unwrap().renovation.as_ref()), RenovationStatus::Existing);
    assert_eq!(status_of(p.walls.iter().find(|w| w.id == "W4").unwrap().renovation.as_ref()), RenovationStatus::Existing);
    let r = View::new(&p, Some("umbauplan"), Some("e2")).unwrap().resolve(&p);
    assert!(r.styled.contains_key("W3") && r.styled.contains_key("W4"));
    // Rundreise: unbekannter Status bleibt nicht als Text erhalten, das Feld aber lädt.
    assert!(serde_json::to_value(&p).is_ok());
}

#[test]
fn projekt_im_zustand() {
    let p = project(&umbau_fixture());
    let b = project_in_state(&p, Some("bestand"), None);
    assert!(b.walls.iter().all(|w| w.id != "W9"));
    assert!(b.openings.iter().flatten().all(|o| o.id != "O1"));
    let e = project_in_state(&p, Some("endzustand"), None);
    assert!(e.walls.iter().all(|w| w.id != "W2"));
    assert!(e.walls.iter().any(|w| w.id == "W9"));
    // Ohne Filter unverändert (geliehen).
    assert!(matches!(project_in_state(&p, None, None), std::borrow::Cow::Borrowed(_)));
}

#[test]
fn restyle_flaechen_und_linien() {
    let ring = vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 1.0, y: 0.0 }, Vec2 { x: 1.0, y: 0.2 }, Vec2 { x: 0.0, y: 0.2 }];
    let q = patch_prims(ring, &default_style(RenovationStatus::Demolish), 0.25, "O1");
    // Fläche gelb ohne Strich, vier gestrichelte Umrisslinien an der Öffnung.
    assert_eq!(q.len(), 5);
    match &q[0] {
        Primitive::Polygon { fill, stroke, opening_id, .. } => {
            assert_eq!(fill, DEMOLISH_FILL);
            assert_eq!(stroke, "none");
            assert_eq!(opening_id.as_deref(), Some("O1"));
        }
        _ => panic!(),
    }
    assert!(q[1..].iter().all(|l| matches!(l, Primitive::Line { dash: Some(Some(_)), opening_id: Some(_), .. })));
    // Leere Füllung bleibt leer.
    let mut poly = q[0].clone();
    if let Primitive::Polygon { fill, .. } = &mut poly {
        *fill = "none".into();
    }
    let mut extra = Vec::new();
    restyle(&mut poly, &default_style(RenovationStatus::New), &mut extra);
    assert!(matches!(&poly, Primitive::Polygon { fill, .. } if fill == "none"));
}

// ── Ableitungen ───────────────────────────────────────────────────────────

use crate::plan::domains::{plan_domains, PlanArgs};

pub(crate) fn plan_with(p: &Project, extra: Value) -> Vec<Primitive> {
    let codes: Vec<String> = (0..100).map(|k| format!("{k:02}")).collect();
    let mut t = json!({"floor": "eg", "show": codes, "scale": 100});
    for (k, x) in extra.as_object().unwrap() {
        t[k] = x.clone();
    }
    let d = plan_domains(p, &PlanArgs::parse_in(p, 1.0, &t.to_string()).unwrap()).unwrap();
    [d.walls, d.ceilings, d.roofs, d.stairs, d.columns, d.solids].concat()
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

pub(crate) fn fills_of(prims: &[Primitive], id: &str) -> Vec<String> {
    prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Polygon { fill, wall_id, opening_id, .. } if opening_id.as_deref().or(wall_id.as_deref()) == Some(id) => Some(fill.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn grundriss_je_filter() {
    let p = project(&umbau_fixture());
    let red = default_style(RenovationStatus::New).fill;
    let yellow = default_style(RenovationStatus::Demolish).fill;
    // Ohne Filter: alles wie bisher, keine Umbau-Farbe.
    let all = plan_with(&p, json!({}));
    assert!(has_wall(&all, "W2") && has_wall(&all, "W9") && has_opening(&all, "O1"));
    assert!(fills_of(&all, "W9").iter().all(|f| *f != red));
    // Bestand: neue Wand und neue Öffnung fehlen.
    let b = plan_with(&p, json!({"renovation": "bestand"}));
    assert!(has_wall(&b, "W2") && !has_wall(&b, "W9") && !has_opening(&b, "O1") && has_opening(&b, "O2"));
    // Abbruch: W2 gelb mit gestrichelten Umrissen; O1 als gelbes Abbruch-Stück in der geschlossenen Wand.
    let a = plan_with(&p, json!({"renovation": "abbruch"}));
    assert!(fills_of(&a, "W2").iter().any(|f| *f == yellow), "{:?}", fills_of(&a, "W2"));
    assert_eq!(fills_of(&a, "O1"), vec![yellow.clone()]);
    assert!(a.iter().any(|q| matches!(q, Primitive::Line { dash: Some(Some(_)), opening_id: Some(o), .. } if o == "O1")));
    // Neubau: W2 weg, W9 rot, O2 zugemauert mit roter Ausfachung, Fenster O1 in roten Linien.
    let n = plan_with(&p, json!({"renovation": "neubau"}));
    assert!(!has_wall(&n, "W2"));
    assert!(fills_of(&n, "W9").iter().any(|f| *f == red), "{:?}", fills_of(&n, "W9"));
    assert_eq!(fills_of(&n, "O2"), vec![red.clone()]);
    let line = default_style(RenovationStatus::New).line.unwrap();
    assert!(n.iter().any(|q| matches!(q, Primitive::Line { opening_id: Some(o), color: Some(c), .. } if o == "O1" && **c == *line)));
    // Umbauplan: beide Ersatzstücke, Bestand grau.
    let u = plan_with(&p, json!({"renovation": "umbauplan"}));
    assert!(fills_of(&u, "W1").iter().any(|f| *f == default_style(RenovationStatus::Existing).fill));
    assert!(fills_of(&u, "O1").contains(&yellow) && fills_of(&u, "O2").contains(&red));
    // Endzustand: ohne Farbe, W2 und O2 weg.
    let e = plan_with(&p, json!({"renovation": "endzustand"}));
    assert!(!has_wall(&e, "W2") && !has_opening(&e, "O2") && has_wall(&e, "W9"));
    assert!(fills_of(&e, "W9").iter().all(|f| *f != red));
}

#[test]
fn grundriss_filter_der_ebene_und_etappe() {
    let mut v = umbau_fixture();
    for l in v["drawingLevels"].as_array_mut().unwrap() {
        if l["id"] == "eg" {
            l["renovationFilter"] = json!("neubau");
            l["renovationPhase"] = json!("e1");
        }
    }
    let p = project(&v);
    // Filter der Ebene wirkt ohne Argument; W9 (Neu in Etappe 2) fehlt in Etappe 1 noch.
    let q = plan_with(&p, json!({}));
    assert!(!has_wall(&q, "W2") && !has_wall(&q, "W9"));
    // Angefragter Filter geht vor (ohne Etappe: alle).
    let q = plan_with(&p, json!({"renovation": "bestand"}));
    assert!(has_wall(&q, "W2") && !has_wall(&q, "W9"));
    let q = plan_with(&p, json!({"renovation": "neubau", "renovationPhase": "e2"}));
    assert!(has_wall(&q, "W9"));
}

pub(crate) fn section_prims(p: &Project, extra: Value) -> Vec<Primitive> {
    let level = p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap();
    let mut v = json!({"level": level, "scale": 50, "detail": "mittel"});
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    let buf = crate::queries::run_bin(p, "sectionPlan", &[0.0, 1.0, 0.0], &v.to_string()).unwrap();
    crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default()
}

fn cut_fills(prims: &[Primitive], id: &str) -> Vec<String> {
    prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Polygon { fill, wall_id: Some(w), .. } if w == id => Some(fill.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn schnitt_je_filter() {
    let p = project(&umbau_fixture());
    let all = section_prims(&p, json!({}));
    assert!(!cut_fills(&all, "W2").is_empty() && !cut_fills(&all, "W9").is_empty());
    let u = section_prims(&p, json!({"renovation": "umbauplan"}));
    assert!(!cut_fills(&u, "W2").is_empty());
    assert!(cut_fills(&u, "W2").iter().all(|f| *f == default_style(RenovationStatus::Demolish).fill), "{:?}", cut_fills(&u, "W2"));
    assert!(cut_fills(&u, "W9").iter().all(|f| *f == default_style(RenovationStatus::New).fill));
    assert!(cut_fills(&u, "W4").iter().all(|f| *f == default_style(RenovationStatus::Existing).fill));
    let n = section_prims(&p, json!({"renovation": "neubau"}));
    assert!(cut_fills(&n, "W2").is_empty() && !cut_fills(&n, "W9").is_empty());
    // Filter der Ebene.
    let mut v = umbau_fixture();
    for l in v["drawingLevels"].as_array_mut().unwrap() {
        if l["id"] == "schnitt-a" {
            l["renovationFilter"] = json!("bestand");
        }
    }
    let q = project(&v);
    let b = section_prims(&q, json!({}));
    assert!(cut_fills(&b, "W9").is_empty() && !cut_fills(&b, "W2").is_empty());
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

#[test]
fn ansicht_je_filter() {
    let p = project(&umbau_fixture());
    let grey = default_style(RenovationStatus::Existing).fill;
    let all = elevation_prims(&p, json!({}));
    assert!(!all.iter().any(|q| matches!(q, Primitive::Polygon { fill, .. } if *fill == grey)));
    let u = elevation_prims(&p, json!({"renovation": "umbauplan"}));
    assert!(u.iter().any(|q| matches!(q, Primitive::Polygon { fill, .. } if *fill == grey)), "Bestandswand W1 grau");
    // Bestand: die neue Öffnung O1 fehlt (Wand geschlossen) — weniger Linien als im Endzustand.
    let b = elevation_prims(&p, json!({"renovation": "bestand"}));
    let e = elevation_prims(&p, json!({"renovation": "endzustand"}));
    let lines = |v: &[Primitive]| v.iter().filter(|q| matches!(q, Primitive::Line { .. })).count();
    assert!(lines(&b) < lines(&e), "bestand {} endzustand {}", lines(&b), lines(&e));
}

#[test]
fn kennzahlen_bestand_und_endzustand() {
    let mut v = umbau_fixture();
    // Ein neuer Raum (Anbau) zählt nur im Endzustand.
    let mut neu = v["rooms"][0].clone();
    neu["id"] = json!("R-neu");
    neu["name"] = json!("Anbau");
    neu["renovation"] = json!({"status": "new"});
    v["rooms"].as_array_mut().unwrap().push(neu);
    let p = project(&v);
    let b = crate::queries::run(&p, "kennzahlen", &[], "bestand").unwrap();
    let e = crate::queries::run(&p, "kennzahlen", &[], "endzustand").unwrap();
    assert_ne!(b, e);
    // Flächentabelle: Text als JSON oder als Filter-Id gleichwertig; der neue Raum fehlt im Bestand.
    let tb = crate::queries::run(&p, "areaTable", &[], "{\"renovation\": \"bestand\"}").unwrap();
    assert_eq!(tb, crate::queries::run(&p, "areaTable", &[], "bestand").unwrap());
    assert_ne!(tb, crate::queries::run(&p, "areaTable", &[], "endzustand").unwrap());
    assert!(crate::queries::run(&p, "renovationFilters", &[], "").unwrap().contains("umbauplan"));
}

fn dxf_strings(p: &Project) -> Vec<String> {
    let a = PlanArgs::parse(1.0, r#"{"floor":"eg","show":["20","21","22","23","30","31","40"],"scale":100}"#).unwrap();
    let buf = crate::plan::domains::plan_domains_buf(p, &a).unwrap();
    let view = crate::plan::buf::View::parse(&buf).unwrap();
    let len = view.len();
    let mut parts = [crate::plan::parts::Part::new(view, 0, len).unwrap()];
    let o = crate::plan::dxf::DxfOptions { scale: 100.0, include_hatches: true, dim_cm: false, paper_layout: false, bounds: [0.0, 0.0, 10.0, 4.0], default_font: "Arial".into(), floor: "eg".into(), table_labels: String::new() };
    crate::plan::dxf::collect(&mut parts, p, &o).unwrap().strings
}

#[test]
fn dxf_ebenen_je_status() {
    let s = dxf_strings(&project(&umbau_fixture()));
    assert!(s.iter().any(|s| s.ends_with("_Abbruch")), "{:?}", s.iter().take(30).collect::<Vec<_>>());
    assert!(s.iter().any(|s| s.ends_with("_Neu")));
    // Ohne Umbau-Angaben keine Status-Ebenen.
    let q: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
    assert!(!dxf_strings(&q).iter().any(|s| s.ends_with("_Abbruch") || s.ends_with("_Neu")));
}

#[test]
fn ifc_status_und_etappe() {
    let p = project(&umbau_fixture());
    let f = crate::ifc_data::ifc_export_data(&p, &crate::ifc_data::IfcOptions::default()).unwrap();
    let (_, text) = crate::export_flat::from_bytes(&f.to_bytes()).unwrap();
    let s: Vec<&str> = text.split('\0').collect();
    for want in ["Status", "DEMOLISH", "NEW", "Dossier_Umbau", "Etappe 2"] {
        assert!(s.contains(&want), "fehlt: {want}");
    }
    let q: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
    let f = crate::ifc_data::ifc_export_data(&q, &crate::ifc_data::IfcOptions::default()).unwrap();
    let (_, text) = crate::export_flat::from_bytes(&f.to_bytes()).unwrap();
    assert!(!text.split('\0').any(|x| x == "DEMOLISH" || x == "Dossier_Umbau"));
}

#[test]
fn drei_d_ausblenden_und_farbe() {
    let p = project(&umbau_fixture());
    let parts = |t: &str| -> Value { serde_json::from_str(&crate::queries::run(&p, "model3dParts", &[1.0, 1.0, 0.0], t).unwrap()).unwrap() };
    let all = parts("");
    let n = parts(r#"{"renovation":"neubau"}"#);
    let ids = |v: &Value| v["walls"].as_array().unwrap().iter().map(|w| w["wallId"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert!(ids(&all).contains(&"W2".to_string()) && !ids(&n).contains(&"W2".to_string()));
    let w9 = n["walls"].as_array().unwrap().iter().find(|w| w["wallId"] == "W9").unwrap();
    let c = crate::style::hex_to_rgb(&default_style(RenovationStatus::New).fill, [0.0; 3]);
    assert!((w9["color"][0].as_f64().unwrap() - c[0]).abs() < 1e-9);
}

#[test]
fn neue_bauteile_tragen_den_zeichen_status() {
    use crate::ops::Op;
    let add = |c: &str| Op::Add { collection: c.into(), items: vec![json!({"id": "x"}), json!({"id": "y", "renovation": {"status": "existing"}})], at: None };
    let out = crate::commands::stamp_renovation(vec![add("walls"), add("drawings2d")], Some(&json!({"status": "new", "phase": "e2"})));
    match &out[0] {
        Op::Add { items, .. } => {
            assert_eq!(items[0]["renovation"], json!({"status": "new", "phase": "e2"}));
            // Eigene Angabe bleibt.
            assert_eq!(items[1]["renovation"]["status"], "existing");
        }
        _ => panic!(),
    }
    // 2D-Zeichnungen ohne Form (kein Möbel, kein Linienwerk) bekommen keinen Status (Rest: `renovation_tests2.rs`).
    assert!(matches!(&out[1], Op::Add { items, .. } if items[0].get("renovation").is_none()));
    // Bestand ohne Etappe = ohne Feld; Unsinn wird ignoriert.
    for r in [json!({"status": "existing"}), json!({"status": "kaputt"}), json!(42), json!(null)] {
        let o = crate::commands::stamp_renovation(vec![add("walls")], Some(&r));
        assert!(matches!(&o[0], Op::Add { items, .. } if items[0].get("renovation").is_none()), "{}", r);
    }
}

#[test]
fn tusche_behaelt_umbau_farben_und_symbole_ohne_fuellung() {
    let p = project(&umbau_fixture());
    let codes: Vec<String> = (0..100).map(|k| format!("{k:02}")).collect();
    let buf = |ren: &str| {
        let t = json!({"floor": "eg", "show": codes, "scale": 100, "mono": true, "renovation": ren}).to_string();
        let b = crate::plan::domains::plan_domains_buf(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
        crate::plan::buf::View::parse(&b).and_then(|v| v.prims()).unwrap_or_default()
    };
    let fills = |v: &[Primitive]| v.iter().filter_map(|q| if let Primitive::Polygon { fill, .. } = q { Some(fill.clone()) } else { None }).collect::<Vec<_>>();
    // Schwarz-Weiss (Tusche): Rot und Gelb bleiben, sonst wäre der Umbauplan stumm.
    let u = fills(&buf("umbauplan"));
    assert!(u.contains(&default_style(RenovationStatus::New).fill) && u.contains(&default_style(RenovationStatus::Demolish).fill));
    // Ohne Filter keine Umbau-Farbe (und Bunt wird wie bisher Papier).
    assert!(!fills(&buf("")).contains(&default_style(RenovationStatus::New).fill));
    // Flächen der Öffnungssymbole (Rahmen, Glas, Flügel) bleiben ohne Umbau-Füllung — nur die Ersatzstücke sind farbig.
    let n = plan_with(&p, json!({"renovation": "umbauplan"}));
    let o1: Vec<String> = n
        .iter()
        .filter_map(|q| match q {
            Primitive::Polygon { fill, opening_id: Some(o), .. } if o == "D1" => Some(fill.clone()),
            _ => None,
        })
        .collect();
    assert!(o1.iter().all(|f| *f != default_style(RenovationStatus::Existing).fill), "{o1:?}");
}
