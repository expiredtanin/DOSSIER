//! [274] Tests der Sanierung je Schicht: Zuordnung im Typ-Paar, gezeigter Aufbau je Filter in Grundriss und Schnitt,
//! Kennzahlen je Zustand, Öffnung in sanierter Wand, Robustheit.

use super::build_up::*;
use super::tests::{project, umbau_fixture};
use super::*;
use serde_json::{json, Value};

fn l(c: &str, t: f64) -> Layer {
    Layer { component_id: c.into(), thickness: t, ..Default::default() }
}

/// Beispiel Maintainer 17.11.: Aussenwand Bestand = Aussenputz 2 + Dämmung 10 + Beton 20 (aussen → innen); Sanierung:
/// Beton bleibt, Dämmung und Putz werden abgebrochen, neue Dämmung 20 + neuer Putz.
fn alt() -> Vec<Layer> {
    vec![l("render-ext", 0.02), l("insulation", 0.10), l("concrete", 0.20)]
}
fn neu() -> Vec<Layer> {
    vec![l("render-ext", 0.02), l("insulation", 0.20), l("concrete", 0.20)]
}

use Fate::{Demolish as D, Kept as K, New as N};

#[test]
fn zuordnung_von_der_bezugsseite() {
    let m = match_layers(&alt(), &neu(), RenovationSide::Inside, &[], &[]);
    assert_eq!(m.old, vec![D, D, K]);
    assert_eq!(m.new, vec![N, N, K]);
    // Gleicher Baustoff, andere Dicke: Abbruch und Neu.
    let m = match_layers(&[l("a", 0.1), l("b", 0.2)], &[l("a", 0.12), l("b", 0.2)], RenovationSide::Inside, &[], &[]);
    assert_eq!((m.old.clone(), m.new.clone()), (vec![D, K], vec![N, K]));
    // Reihenfolge vertauscht: gleiche Dicken, aber andere Lage ⇒ alles neu.
    let m = match_layers(&[l("a", 0.1), l("b", 0.1)], &[l("b", 0.1), l("a", 0.1)], RenovationSide::Inside, &[], &[]);
    assert_eq!((m.old.clone(), m.new.clone()), (vec![D, D], vec![N, N]));
    // Bezugsseite aussen (Innendämmung): der Putz aussen bleibt, innen ändert sich alles.
    let m = match_layers(&alt(), &neu(), RenovationSide::Outside, &[], &[]);
    assert_eq!((m.old.clone(), m.new.clone()), (vec![K, D, D], vec![K, N, N]));
    // Manuelle Zuordnung geht vor; das automatisch gepaarte Gegenstück folgt (Beton abgebrochen ⇒ neuer Beton neu).
    let m = match_layers(&alt(), &neu(), RenovationSide::Inside, &[LayerRenovation::Auto, LayerRenovation::Auto, LayerRenovation::Demolish], &[LayerRenovation::Auto, LayerRenovation::Existing]);
    assert_eq!((m.old.clone(), m.new.clone()), (vec![D, D, D], vec![N, K, N]));
    // Unsinn: NaN/negative Dicken zählen 0, kein Panic.
    let m = match_layers(&[l("a", f64::NAN), l("b", 0.2)], &[l("b", 0.2), l("c", -1.0)], RenovationSide::Inside, &[], &[]);
    assert_eq!(m.old.len(), 2);
    assert_eq!(total(&[l("a", f64::NAN), l("b", f64::INFINITY), l("c", 0.1)]), 0.1);
}

#[test]
fn teilschichten_im_umbauplan() {
    let m = match_layers(&alt(), &neu(), RenovationSide::Inside, &[], &[]);
    let q = pieces(&alt(), &neu(), &m, RenovationSide::Inside, Shown::Both);
    let got: Vec<(Kind, f64)> = q.iter().map(|q| (q.kind, (q.layer.thickness * 1000.0).round() / 1000.0)).collect();
    // aussen → innen: Putz neu, Dämmung neu (frei), Dämmung neu über altem Putz, über alter Dämmung, Beton bleibt.
    assert_eq!(got, vec![(Kind::New, 0.02), (Kind::New, 0.08), (Kind::NewOverDemolish, 0.02), (Kind::NewOverDemolish, 0.10), (Kind::Kept, 0.20)]);
    // Neuer Aufbau dünner als der alte: der Rest des alten bleibt als reiner Abbruch.
    let m = match_layers(&neu(), &alt(), RenovationSide::Inside, &[], &[]);
    let q = pieces(&neu(), &alt(), &m, RenovationSide::Inside, Shown::Both);
    assert_eq!(q.first().map(|q| q.kind), Some(Kind::Demolish));
    assert!((q.iter().map(|q| q.layer.thickness).sum::<f64>() - 0.42).abs() < 1e-9);
    // Alt und Neu je für sich.
    assert_eq!(pieces(&alt(), &neu(), &m_of(), RenovationSide::Inside, Shown::Old).len(), 3);
    assert_eq!(pieces(&alt(), &neu(), &m_of(), RenovationSide::Inside, Shown::Kept).len(), 1);
}

fn m_of() -> Matched {
    match_layers(&alt(), &neu(), RenovationSide::Inside, &[], &[])
}

/// Fixture mit Bestandstyp „alt“ (Sanierungstyp „neu“) an W1 und W4, beide saniert.
fn saniert_fixture() -> Value {
    let mut v = umbau_fixture();
    let lay = |ls: Vec<Layer>| serde_json::to_value(ls).unwrap();
    v["wallTypes"].as_array_mut().unwrap().push(json!({"id": "alt", "name": "AW Bestand", "layers": lay(alt()), "renovationTarget": "neu"}));
    v["wallTypes"].as_array_mut().unwrap().push(json!({"id": "neu", "name": "AW saniert", "layers": lay(neu())}));
    for w in v["walls"].as_array_mut().unwrap() {
        if w["id"] == "W1" || w["id"] == "W4" {
            w["wallTypeId"] = json!("alt");
            w["renovation"] = json!({"status": "existing", "renovated": true});
        }
    }
    v
}

fn plan(p: &Project, filter: &str) -> Vec<Primitive> {
    let codes: Vec<String> = (0..100).map(|k| format!("{k:02}")).collect();
    let t = json!({"floor": "eg", "show": codes, "scale": 50, "renovation": filter}).to_string();
    // Ohne Vereinigung gleicher Bänder verschiedener Wände ([198]): so bleibt jede Fläche bei ihrer Wand.
    crate::plan::seams::OFF.with(|o| o.set(true));
    let d = crate::plan::domains::plan_domains(p, &crate::plan::domains::PlanArgs::parse_in(p, 1.0, &t).unwrap()).unwrap();
    crate::plan::seams::OFF.with(|o| o.set(false));
    d.walls
}

/// Flächen im Bereich der Wand W1 zwischen den Öffnungen (x 1.7 … 2.9; nach Vereinigung gleicher Bänder [198] auch ohne
/// Wand-Id): Füllung und y-Ausdehnung.
fn w1_polys(prims: &[Primitive]) -> Vec<(String, f64, f64)> {
    prims.iter().filter_map(|q| match q {
        Primitive::Polygon { pts, fill, opening_id: None, .. } if pts.len() >= 3 => {
            let f = |g: fn(f64, f64) -> f64, k: fn(&Vec2) -> f64, z: f64| pts.iter().map(k).fold(z, g);
            let (x0, x1, y0, y1) = (f(f64::min, |p| p.x, f64::INFINITY), f(f64::max, |p| p.x, f64::NEG_INFINITY), f(f64::min, |p| p.y, f64::INFINITY), f(f64::max, |p| p.y, f64::NEG_INFINITY));
            (x0 < 2.3 && x1 > 2.3 && y0 > -0.35 && y1 < 0.25).then(|| (fill.clone(), y0, y1))
        }
        _ => None,
    }).collect()
}

fn wall_fills(prims: &[Primitive], _id: &str) -> Vec<String> {
    w1_polys(prims).into_iter().map(|x| x.0).filter(|f| f != "none").collect()
}

/// Aussenkante (kleinstes y) bzw. Innenkante (grösstes y) von W1.
fn min_y(prims: &[Primitive], _id: &str) -> f64 {
    w1_polys(prims).iter().map(|x| x.1).fold(f64::INFINITY, f64::min)
}
fn max_y(prims: &[Primitive], _id: &str) -> f64 {
    w1_polys(prims).iter().map(|x| x.2).fold(f64::NEG_INFINITY, f64::max)
}

fn dashed_colors(prims: &[Primitive]) -> Vec<String> {
    prims.iter().filter_map(|q| match q {
        Primitive::Line { dash: Some(Some(_)), color, cls, opening_id: None, .. } if matches!(&**cls, "wall-outline" | "layer-joint" | "layer-joint-l") => Some(color.as_deref().unwrap_or("").to_string()),
        _ => None,
    }).collect()
}

#[test]
fn grundriss_je_filter_je_schicht() {
    let p = project(&saniert_fixture());
    let (grey, yellow, red) = (default_style(RenovationStatus::Existing).fill, default_style(RenovationStatus::Demolish).fill, default_style(RenovationStatus::New).fill);
    // Bestand: alter Aufbau (32 cm, Mitte auf der Achse), ohne Farbe.
    let b = plan(&p, "bestand");
    let f = wall_fills(&b, "W1");
    assert!(!f.iter().any(|f| *f == yellow || *f == red || *f == grey), "{f:?}");
    assert!((min_y(&b, "W1") + 0.16).abs() < 1e-6 && (max_y(&b, "W1") - 0.16).abs() < 1e-6, "{} {}", min_y(&b, "W1"), max_y(&b, "W1"));
    // Abbruch: alter Aufbau, Putz und Dämmung gelb (gestrichelt umrandet), Beton ohne Farbe.
    let a = plan(&p, "abbruch");
    let f = wall_fills(&a, "W1");
    assert_eq!(f.iter().filter(|f| **f == yellow).count(), 2, "{f:?}");
    assert!(!f.contains(&red));
    assert!(!dashed_colors(&a).is_empty());
    assert!((min_y(&a, "W1") + 0.16).abs() < 1e-6);
    // Neubau: neuer Aufbau (42 cm), innen bündig, Aussenseite 10 cm weiter aussen; neue Schichten rot.
    let n = plan(&p, "neubau");
    let f = wall_fills(&n, "W1");
    assert_eq!(f.iter().filter(|f| **f == red).count(), 2, "{f:?}");
    assert!(!f.contains(&yellow) && !f.contains(&grey));
    assert!((max_y(&n, "W1") - 0.16).abs() < 1e-6 && (min_y(&n, "W1") + 0.26).abs() < 1e-6, "{} {}", min_y(&n, "W1"), max_y(&n, "W1"));
    // Umbauplan: Beton grau, neue Schichten rot (auch über dem Abbruch), Abbruch als gelbe gestrichelte Kontur.
    let u = plan(&p, "umbauplan");
    let f = wall_fills(&u, "W1");
    assert!(f.contains(&grey) && f.iter().filter(|f| **f == red).count() >= 3, "{f:?}");
    assert!(!f.contains(&yellow), "Abbruch unter Neu nur als Kontur: {f:?}");
    assert!(dashed_colors(&u).iter().any(|c| *c == yellow), "{:?}", dashed_colors(&u));
    assert!((min_y(&u, "W1") + 0.26).abs() < 1e-6);
    // Endzustand: neuer Aufbau ohne Farbe.
    let e = plan(&p, "endzustand");
    let f = wall_fills(&e, "W1");
    assert!(!f.iter().any(|f| *f == yellow || *f == red || *f == grey), "{f:?}");
    assert!((min_y(&e, "W1") + 0.26).abs() < 1e-6);
    // Ohne Filter: Bestandstyp, wie heute.
    let o = plan(&p, "");
    assert!((min_y(&o, "W1") + 0.16).abs() < 1e-6);
}

fn opening_min_y(prims: &[Primitive], id: &str) -> f64 {
    prims.iter().filter_map(|q| match q {
        Primitive::Polygon { pts, opening_id: Some(o), .. } if o == id => Some(pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min)),
        Primitive::Line { a, b, opening_id: Some(o), .. } if o == id => Some(a.y.min(b.y)),
        _ => None,
    }).fold(f64::INFINITY, f64::min)
}

#[test]
fn oeffnung_in_sanierter_wand() {
    let p = project(&saniert_fixture());
    // O1 (neu) in W1: im Endzustand reicht das Fenster durch den neuen Aufbau (Leibung bis zur neuen Aussenkante).
    let e = opening_min_y(&plan(&p, "endzustand"), "O1");
    assert!(e < -0.2, "Öffnung folgt dem neuen Aufbau: {e}");
    // Abbruchplan: das Abbruch-Stück liegt im alten Aufbau.
    let a = opening_min_y(&plan(&p, "abbruch"), "O1");
    assert!(a > -0.17 && a.is_finite(), "{a}");
}

fn section(p: &Project, filter: &str) -> Vec<Primitive> {
    let level = p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap();
    let v = json!({"level": level, "scale": 50, "detail": "mittel", "renovation": filter});
    let buf = crate::queries::run_bin(p, "sectionPlan", &[0.0, 1.0, 0.0], &v.to_string()).unwrap();
    crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default()
}

/// Kleinstes x der Schnittfläche von W4 (Aussenseite bei −x).
fn sec_min_x(prims: &[Primitive], id: &str) -> f64 {
    prims.iter().filter_map(|q| match q {
        Primitive::Polygon { pts, wall_id: Some(w), .. } if w == id => Some(pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min)),
        _ => None,
    }).fold(f64::INFINITY, f64::min)
}

#[test]
fn schnitt_je_filter_je_schicht() {
    let p = project(&saniert_fixture());
    let (grey, yellow, red) = (default_style(RenovationStatus::Existing).fill, default_style(RenovationStatus::Demolish).fill, default_style(RenovationStatus::New).fill);
    let fills = |v: &[Primitive]| v.iter().filter_map(|q| match q {
        Primitive::Polygon { fill, wall_id: Some(w), .. } if w == "W4" => Some(fill.clone()),
        _ => None,
    }).collect::<Vec<_>>();
    let b = section(&p, "bestand");
    let a = section(&p, "abbruch");
    let n = section(&p, "neubau");
    let u = section(&p, "umbauplan");
    let e = section(&p, "endzustand");
    assert!(!fills(&b).is_empty() && !fills(&b).iter().any(|f| *f == yellow || *f == red));
    assert!(fills(&a).contains(&yellow) && !fills(&a).contains(&red), "{:?}", fills(&a));
    assert!(fills(&n).contains(&red) && !fills(&n).contains(&yellow), "{:?}", fills(&n));
    assert!(fills(&u).contains(&grey) && fills(&u).contains(&red), "{:?}", fills(&u));
    assert!(!fills(&e).iter().any(|f| *f == yellow || *f == red || *f == grey));
    // Umbauplan: die abgebrochenen Schichten unter der neuen Dämmung als gestrichelte Kontur (eigene Schnittflächen).
    let dashed = |v: &[Primitive]| v.iter().filter(|q| matches!(q, Primitive::Line { dash: Some(Some(_)), cls, .. } if &**cls == "section-joint")).count();
    assert!(dashed(&u) > dashed(&e), "{} {}", dashed(&u), dashed(&e));
    // Neuer Aufbau 10 cm dicker nach aussen: die Schnittfläche reicht weiter (Schnitt-Koordinaten: Abstand längs der Linie).
    let (wb, we) = (sec_min_x(&b, "W4"), sec_min_x(&e, "W4"));
    assert!(wb.is_finite() && we.is_finite() && (wb - we).abs() > 0.09, "{wb} {we}");
}

#[test]
fn kennzahlen_je_zustand() {
    let p = project(&saniert_fixture());
    let mut v = saniert_fixture();
    for w in v["walls"].as_array_mut().unwrap() {
        if let Some(r) = w.get_mut("renovation").and_then(|r| r.as_object_mut()) {
            r.remove("renovated");
        }
    }
    let unsaniert = project(&v);
    let gf = |p: &Project, f: &str| crate::flaechen::area_table(&project_for_text(p, f)).total.gf;
    // Bestand: die Sanierung ändert nichts; Endzustand: Aussenkante 10 cm weiter aussen an W1 (5 m) und W4 (4 m).
    assert!((gf(&p, "bestand") - gf(&unsaniert, "bestand")).abs() < 1e-9);
    let (a, b) = (gf(&unsaniert, "endzustand"), gf(&p, "endzustand"));
    assert!(b > a + 0.5, "GF Endzustand unsaniert {a} saniert {b}");
    // Dicke je Zustand.
    let th = |f: &str| {
        let q = project_for_text(&p, f);
        let w1 = q.walls.iter().find(|w| w.id == "W1").unwrap();
        q.wall_thickness(w1, 0.0)
    };
    assert!((th("endzustand") - 0.42).abs() < 1e-9 && (th("bestand") - 0.32).abs() < 1e-9);
}

#[test]
fn ansicht_und_3d_folgen_dem_aufbau() {
    let p = project(&saniert_fixture());
    // 3D (Teile je Schicht): Endzustand mit der Dämmung 20 cm, Bestand mit der alten 10 cm.
    let parts = |t: &str| -> Value { serde_json::from_str(&crate::queries::run(&p, "model3dParts", &[1.0, 1.0, 0.0], t).unwrap()).unwrap() };
    let w1 = |v: &Value| v["walls"].as_array().unwrap().iter().filter(|w| w["wallId"] == "W1").cloned().collect::<Vec<_>>();
    let has = |v: &[Value], t: f64| v.iter().any(|w| (w["thickness"].as_f64().unwrap() - t).abs() < 1e-9);
    let (e, b) = (w1(&parts(r#"{"renovation":"endzustand"}"#)), w1(&parts(r#"{"renovation":"bestand"}"#)));
    assert!(has(&b, 0.1) && !has(&e, 0.1), "alte Dämmung nur im Bestand");
    // Umbauplan: Farbe der äussersten Schicht (neuer Putz = rot).
    let c = crate::style::hex_to_rgb(&default_style(RenovationStatus::New).fill, [0.0; 3]);
    assert!(w1(&parts(r#"{"renovation":"umbauplan"}"#)).iter().all(|w| (w["color"][0].as_f64().unwrap() - c[0]).abs() < 1e-9));
    // Ansicht Süd (Fassade W1) im Umbauplan: rot.
    let level = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let buf = crate::queries::run_bin(&p, "elevationPlan", &[0.0, 0.0, 100.0], &json!({"level": level, "renovation": "umbauplan"}).to_string()).unwrap();
    let prims = crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default();
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { fill, .. } if *fill == default_style(RenovationStatus::New).fill)));
}

#[test]
fn robust_und_ohne_wirkung_wo_nicht_saniert() {
    let mut v = saniert_fixture();
    // Leerer Sanierungstyp, fehlender Typ, NaN-Dicken: wie nicht saniert, kein Panic.
    v["wallTypes"].as_array_mut().unwrap().push(json!({"id": "leer", "name": "leer", "layers": []}));
    v["wallTypes"].as_array_mut().unwrap().push(json!({"id": "nan", "name": "nan", "layers": [{"componentId": "x", "thickness": -1.0}]}));
    let p = project(&v);
    for t in ["leer", "nan", "gibts-nicht", "alt"] {
        let mut q = p.clone();
        for w in q.walls.iter_mut().filter(|w| w.id == "W1") {
            w.renovation.as_mut().unwrap().new_type_id = Some(t.into());
        }
        let w = q.walls.iter().find(|w| w.id == "W1").unwrap();
        assert!(pair(&q, w).is_none(), "{t}");
        let _ = plan(&q, "umbauplan");
    }
    // Status Abbruch: Sanierung wirkt nicht (die ganze Wand fällt).
    let mut q = p.clone();
    for w in q.walls.iter_mut().filter(|w| w.id == "W1") {
        w.renovation.as_mut().unwrap().status = RenovationStatus::Demolish;
    }
    let r = View::new(&q, Some("umbauplan"), None).unwrap().resolve(&q);
    assert!(!r.walls.contains_key("W1") && r.walls.contains_key("W4"));
    // Ohne Markierung keine Wirkung.
    let mut q = p.clone();
    for w in q.walls.iter_mut() {
        if let Some(r) = w.renovation.as_mut() {
            r.renovated = None;
        }
    }
    assert!(!build_up::any(&q));
    assert!(View::new(&q, Some("umbauplan"), None).unwrap().resolve(&q).walls.is_empty());
}

#[test]
fn umgestelltes_projekt_ergibt_dasselbe() {
    let p = project(&saniert_fixture());
    let v = View::new(&p, Some("umbauplan"), None).unwrap();
    let r = v.resolve(&p);
    let q = r.project(&p).unwrap();
    let r2 = v.resolve(&q);
    assert_eq!(r.walls["W1"].type_id, r2.walls["W1"].type_id);
    assert_eq!(r.walls["W1"].pieces, r2.walls["W1"].pieces);
    // Bestand nach Umbauplan: zurück auf den Ursprung.
    let back = View::new(&q, Some("bestand"), None).unwrap().resolve(&q).project(&q).unwrap();
    let w1 = back.walls.iter().find(|w| w.id == "W1").unwrap();
    assert_eq!(w1.wall_type_id, "alt");
    assert_eq!(w1.reference_offset, None);
}

#[test]
fn typ_paar_abfragen() {
    let p = project(&saniert_fixture());
    let v: Value = serde_json::from_str(&crate::queries::run(&p, "renovationPair", &[], r#"{"type":"alt"}"#).unwrap()).unwrap();
    assert_eq!(v["target"], "neu");
    assert_eq!(v["old"].as_array().unwrap().iter().map(|x| x["fate"].as_str().unwrap()).collect::<Vec<_>>(), vec!["demolish", "demolish", "kept"]);
    assert_eq!(v["result"].as_array().unwrap().len(), 5);
    assert_eq!((v["elements"].as_u64(), v["renovated"].as_u64()), (Some(2), Some(2)));
    let all: Value = serde_json::from_str(&crate::queries::run(&p, "renovationPairs", &[], "").unwrap()).unwrap();
    assert_eq!(all["pairs"][0]["type"], "alt");
    assert_eq!(all["renovated"], 2);
    // Unsinn: leer/null.
    assert_eq!(crate::queries::run(&p, "renovationPair", &[], "kaputt").unwrap(), "null");
    assert_eq!(crate::queries::run(&p, "renovationPair", &[], r#"{"type":"iw"}"#).unwrap(), "null");
}


/// [274] Decke C1 (oben → unten: Estrich 6 + Trittschall 2 + Beton 20) saniert zu Belag 1 + Estrich 5 + Trittschall 3 +
/// Beton 20 (Rohdecke bleibt, Oberkante 1 cm höher); Dach RF1 (aussen → innen: Ziegel 4 + Sparren 16 + Verkleidung)
/// saniert mit 12 cm Aufsparrendämmung (Sparren und Verkleidung bleiben, Ziegel neu). Dazu ein Querschnitt bei x = 2.5.
fn decke_dach_fixture(renovated: bool) -> Value {
    let mut v = umbau_fixture();
    let lay = |ls: Vec<Layer>| serde_json::to_value(ls).unwrap();
    let ct = v["ceilingTypes"].as_array_mut().unwrap();
    ct.push(json!({"id": "decke-alt", "name": "Decke Bestand", "layers": lay(vec![l("screed", 0.06), l("insulation", 0.02), l("concrete", 0.2)]), "renovationTarget": "decke-neu"}));
    ct.push(json!({"id": "decke-neu", "name": "Decke saniert", "layers": lay(vec![l("render-int", 0.01), l("screed", 0.05), l("insulation", 0.03), l("concrete", 0.2)])}));
    let rt = v["roofTypes"].as_array_mut().unwrap();
    rt.push(json!({"id": "dach-alt", "name": "Dach Bestand", "layers": lay(vec![l("roof-tiles", 0.04), l("brick", 0.16), l("render-int", 0.0125)]), "renovationTarget": "dach-neu"}));
    rt.push(json!({"id": "dach-neu", "name": "Dach saniert", "layers": lay(vec![l("roof-tiles", 0.04), l("insulation", 0.12), l("brick", 0.16), l("render-int", 0.0125)])}));
    let r = if renovated { json!({"status": "existing", "renovated": true}) } else { json!({"status": "existing"}) };
    v["ceilings"][0]["ceilingTypeId"] = json!("decke-alt");
    v["ceilings"][0]["renovation"] = r.clone();
    v["roofs"][0]["roofTypeId"] = json!("dach-alt");
    v["roofs"][0]["renovation"] = r;
    v["drawingLevels"].as_array_mut().unwrap().push(json!({"id": "schnitt-q", "name": "Schnitt Q", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": 2.5, "y": -1}, {"x": 2.5, "y": 5}], "directionSign": 1}));
    v
}

fn section_at(p: &Project, level: &str, filter: &str) -> Vec<Primitive> {
    let level = p.drawing_levels.iter().find(|l| l.id == level).unwrap();
    let v = json!({"level": level, "scale": 50, "detail": "mittel", "renovation": filter});
    let buf = crate::queries::run_bin(p, "sectionPlan", &[0.0, 1.0, 0.0], &v.to_string()).unwrap();
    crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default()
}

fn u_project(p: &Project, filter: &str) -> Project {
    View::new(p, Some(filter), None).unwrap().resolve(p).project(p).unwrap_or_else(|| p.clone())
}

#[test]
fn decke_und_dach_je_schicht() {
    let p = project(&decke_dach_fixture(true));
    let u = View::new(&p, Some("umbauplan"), None).unwrap().resolve(&p);
    let kinds = |id: &str| u.slabs[id].pieces.iter().map(|q| q.kind).collect::<Vec<_>>();
    // Decke oben → unten: Belag neu, Estrich neu über altem Estrich …, Beton bleibt (Bezugsseite unten).
    let kc = kinds("C1");
    assert_eq!(kc.first(), Some(&Kind::New));
    assert_eq!(kc.last(), Some(&Kind::Kept));
    assert!(kc.contains(&Kind::NewOverDemolish), "{kc:?}");
    // Dach aussen → innen: Ziegel neu, Dämmung neu über alten Ziegeln, Sparren und Verkleidung bleiben.
    let kr = kinds("RF1");
    assert_eq!(kr.first(), Some(&Kind::New));
    assert_eq!(&kr[kr.len() - 2..], &[Kind::Kept, Kind::Kept]);
    // Oberste Schicht für Ansicht/Axo/Grundriss-Linien: rot.
    assert_eq!(u.element_style("C1").map(|s| s.fill.clone()), Some(default_style(RenovationStatus::New).fill));

    // Endzustand: neuer Aufbau, Oberkante 1 cm höher (Rohdecke bleibt), Dachhaut 12 cm / cos 30° höher.
    let e = project_for_text(&p, "endzustand");
    let c1 = e.ceilings.as_ref().unwrap().iter().find(|c| c.id == "C1").unwrap();
    let (uk, ok) = e.ceiling_vertical_extent(c1);
    let (uk0, ok0) = p.ceiling_vertical_extent(&p.ceilings.as_ref().unwrap()[0]);
    assert!((uk - uk0).abs() < 1e-9 && (ok - ok0 - 0.01).abs() < 1e-9, "{uk0} {ok0} → {uk} {ok}");
    let rf = e.roofs.as_ref().unwrap().iter().find(|r| r.id == "RF1").unwrap();
    let dz = e.roof_base_elevation(rf) - p.roof_base_elevation(&p.roofs.as_ref().unwrap()[0]);
    assert!((dz - 0.12 / 30f64.to_radians().cos()).abs() < 1e-9, "{dz}");
    assert_eq!(e.roof_layers(rf).len(), 4);
    // Bestand: unverändert.
    let b = project_for_text(&p, "bestand");
    assert_eq!(b.ceilings.as_ref().unwrap()[0].ceiling_type_id.as_deref(), Some("decke-alt"));
    assert_eq!(b.roofs.as_ref().unwrap()[0].roof_type_id.as_deref(), Some("dach-alt"));

    // Umgestellt und zurück: gleiche Auflösung, Bestand stellt den Ursprung her.
    let q = u_project(&p, "umbauplan");
    let u2 = View::new(&q, Some("umbauplan"), None).unwrap().resolve(&q);
    assert_eq!(u.slabs["C1"].type_id, u2.slabs["C1"].type_id);
    assert_eq!(u.slabs["RF1"].level, u2.slabs["RF1"].level);
    let back = u_project(&q, "bestand");
    let c = &back.ceilings.as_ref().unwrap()[0];
    assert_eq!((c.ceiling_type_id.as_deref(), c.top.is_none(), c.extra.0.contains_key(ORIGIN)), (Some("decke-alt"), true, false));
    let r = &back.roofs.as_ref().unwrap()[0];
    assert_eq!((r.roof_type_id.as_deref(), r.base_elevation), (Some("dach-alt"), None));

    // Schnitt quer durch Decke und Dach: Umbauplan mit roten Schichten (mehr als ohne Sanierung), Abbruch gelb.
    let plain = project(&decke_dach_fixture(false));
    let (yellow, red) = (default_style(RenovationStatus::Demolish).fill, default_style(RenovationStatus::New).fill);
    let count = |v: &[Primitive], c: &str| v.iter().filter(|q| matches!(q, Primitive::Polygon { fill, .. } if fill == c)).count();
    let (su, su0) = (section_at(&p, "schnitt-q", "umbauplan"), section_at(&plain, "schnitt-q", "umbauplan"));
    assert!(count(&su, &red) > count(&su0, &red), "{} {}", count(&su, &red), count(&su0, &red));
    assert!(count(&section_at(&p, "schnitt-q", "abbruch"), &yellow) > count(&section_at(&plain, "schnitt-q", "abbruch"), &yellow));
    assert_eq!(count(&section_at(&p, "schnitt-q", "bestand"), &red), 0);

    // 3D: geschichtete Platten der Decke je Schicht (rot und grau im Umbauplan).
    let parts: Value = serde_json::from_str(&crate::queries::run(&p, "model3dParts", &[1.0, 1.0, 0.0], r#"{"renovation":"umbauplan"}"#).unwrap()).unwrap();
    let rgb = |s: RenovationStatus| crate::style::hex_to_rgb(&default_style(s).fill, [0.0; 3]);
    let cols: Vec<[f64; 3]> = parts["slabs"].as_array().unwrap().iter().filter(|s| s["ceilingId"] == "C1").map(|s| [0, 1, 2].map(|k| s["color"][k].as_f64().unwrap())).collect();
    let near = |a: &[f64; 3], b: [f64; 3]| (0..3).all(|k| (a[k] - b[k]).abs() < 1e-6);
    assert!(cols.iter().any(|c| near(c, rgb(RenovationStatus::New))) && cols.iter().any(|c| near(c, rgb(RenovationStatus::Existing))), "{cols:?}");

    // Abfragen: Paare aller drei Bauteilarten.
    let all: Value = serde_json::from_str(&crate::queries::run(&p, "renovationPairs", &[], "").unwrap()).unwrap();
    let kinds: Vec<&str> = all["pairs"].as_array().unwrap().iter().map(|x| x["kind"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"ceiling") && kinds.contains(&"roof"), "{kinds:?}");
    assert_eq!(all["renovated"], 2);
    let pc: Value = serde_json::from_str(&crate::queries::run(&p, "renovationPair", &[], r#"{"type":"decke-alt","kind":"ceiling"}"#).unwrap()).unwrap();
    assert_eq!((pc["target"].as_str(), pc["elements"].as_u64(), pc["renovated"].as_u64()), (Some("decke-neu"), Some(1), Some(1)));
    assert_eq!(pc["old"].as_array().unwrap().last().unwrap()["fate"], "kept");
    // Unsinn: Dach ohne Typ, Decke mit fehlendem Sanierungstyp — keine Sanierung, kein Panic.
    let mut q = p.clone();
    q.roofs.as_mut().unwrap()[0].roof_type_id = None;
    q.ceilings.as_mut().unwrap()[0].renovation.as_mut().unwrap().new_type_id = Some("gibts-nicht".into());
    let r = View::new(&q, Some("umbauplan"), None).unwrap().resolve(&q);
    assert!(r.slabs.is_empty());
    let _ = section_at(&q, "schnitt-q", "umbauplan");
}

#[test]
fn ifc_status_je_schicht() {
    let p = project(&decke_dach_fixture(true));
    let (old, new) = ifc_layer_status(&p, "C1").unwrap();
    assert_eq!(old, "Zementestrich 6.0 cm: DEMOLISH; Wärmedämmung 2.0 cm: DEMOLISH; Beton 20.0 cm: EXISTING");
    assert!(new.starts_with("Innenputz 1.0 cm: NEW") && new.ends_with("Beton 20.0 cm: EXISTING"), "{new}");
    assert!(ifc_layer_status(&p, "RF1").is_some() && ifc_layer_status(&p, "W2").is_none() && ifc_layer_status(&p, "gibts-nicht").is_none());
    // Im Export: `Dossier_Umbau` mit den Listen, auch im Endzustand (umgestellte Decke über ihren Ursprung).
    for q in [p.clone(), project_for_text(&p, "endzustand").into_owned()] {
        let f = crate::ifc_data::ifc_export_data(&q, &crate::ifc_data::IfcOptions::default()).unwrap();
        let (_, text) = crate::export_flat::from_bytes(&f.to_bytes()).unwrap();
        let s: Vec<&str> = text.split('\0').collect();
        for want in ["SchichtenBestand", "SchichtenSanierung", old.as_str()] {
            assert!(s.contains(&want), "fehlt: {want}");
        }
    }
}
