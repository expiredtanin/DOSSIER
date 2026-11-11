//! [180] Alles Sichtbare liegt auf einer Klasse: Grundriss, Schnitt und Ansicht des Musterprojekts (Fixture) mit
//! Schattenstudie, Körpern, Raster und Schnittführungen. Sind alle Klassen aus, bleibt nichts; jede Klasse der
//! abgeleiteten Darstellung (`standards::DERIVED_CATEGORIES`) entfernt genau ihre Primitive.
//! Die beiden Musterhäuser (TS-Bauer) prüft `src/plan/derivedCategories.test.ts` über den WASM-Kern.

use super::domains::{plan_domains_buf, PlanArgs};
use super::prim::Primitive;
use crate::model::*;
use crate::standards::{derived_categories, AUTO_DIM_CATEGORY, SECTION_MARK_CATEGORY, SHADOW_CATEGORY};
use serde_json::{json, Value};

/// 2026-06-21T08:00:00Z (Morgensonne: lange Schatten).
const WHEN: f64 = 1_782_028_800_000.0;

fn project() -> Project {
    let mut v: Value = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
    let layers = v["layers"].as_array_mut().unwrap();
    layers.extend(derived_categories());
    v["sunStudy"] = json!({"when": "2026-06-21T08:00:00Z", "show": true});
    // Körper (Klasse „35") und Abzugskörper (Klasse „20") im EG, Achsraster (Klasse „00").
    v["extrudedSolids"] = json!([
        {"id": "k1", "type": "extrudedSolid", "levelId": "eg", "categoryCode": "35", "points": [{"x": 7, "y": 1}, {"x": 8, "y": 1}, {"x": 8, "y": 2}, {"x": 7, "y": 2}], "height": 1.5},
        {"id": "v1", "type": "extrudedSolid", "levelId": "eg", "categoryCode": "20", "operation": "subtract", "points": [{"x": 1, "y": -0.2}, {"x": 1.5, "y": -0.2}, {"x": 1.5, "y": 0.2}, {"x": 1, "y": 0.2}], "height": 0.5, "baseOffset": 1.0}
    ]);
    v["drawings2d"].as_array_mut().unwrap().push(json!({"id": "raster", "type": "drawing2d", "levelId": "eg", "categoryCode": "00",
        "geom": {"shape": "grid", "origin": {"x": 0, "y": 0}, "angle": 0,
            "a": [{"label": "1", "pos": 0}, {"label": "2", "pos": 5}], "b": [{"label": "A", "pos": 0}, {"label": "B", "pos": 4}]}}));
    serde_json::from_value(v).unwrap()
}

fn all_codes(p: &Project) -> Vec<String> {
    p.flat_categories().iter().map(|c| c.code.clone()).collect()
}

fn plan(p: &Project, floor: &str, show: &[String]) -> Vec<Primitive> {
    let a = PlanArgs::parse(1.0, &json!({"floor": floor, "show": show, "global": true, "scale": 100, "sunWhen": WHEN}).to_string()).unwrap();
    let buf = plan_domains_buf(p, &a).unwrap();
    super::buf::View::parse(&buf).unwrap().prims().unwrap()
}

/// Sichtbarkeit wie `visibilityArgs` in TS: unsichtbar sind alle Codes (Baum und Bauteile) ausser `show`.
fn vis_json(p: &Project, show: &[String]) -> Value {
    let mut codes: Vec<String> = all_codes(p);
    codes.extend(p.walls.iter().map(|w| w.category_code.clone()));
    codes.extend(p.openings.iter().flatten().map(|o| o.category_code.clone()));
    codes.extend(p.stairs.iter().flatten().map(|o| o.category_code.clone()));
    let invisible: Vec<String> = codes.into_iter().filter(|c| !show.contains(c)).collect();
    json!({"hasVis": true, "invisible": invisible, "hasDisplay": false})
}

fn level_of<'a>(p: &'a Project, kind: DrawingLevelKind) -> &'a DrawingLevel {
    p.drawing_levels.iter().find(|l| l.kind == kind).unwrap()
}

fn section(p: &Project, show: &[String]) -> Vec<Primitive> {
    let mut t = vis_json(p, show);
    t["level"] = serde_json::to_value(level_of(p, DrawingLevelKind::Section)).unwrap();
    let buf = super::section::section_plan_buf(p, &[0.0, 1.0, 0.0], &t.to_string()).unwrap();
    super::buf::View::parse(&buf).unwrap().prims().unwrap()
}

fn elevation(p: &Project, show: &[String]) -> Vec<Primitive> {
    let mut t = vis_json(p, show);
    t["level"] = serde_json::to_value(level_of(p, DrawingLevelKind::Elevation)).unwrap();
    let buf = super::elevation::elevation_plan_buf(p, &[0.0, 1.0, 100.0], &t.to_string()).unwrap();
    super::buf::View::parse(&buf).unwrap().prims().unwrap()
}

fn without(codes: &[String], code: &str) -> Vec<String> {
    codes.iter().filter(|c| *c != code).cloned().collect()
}

fn ctx_id(q: &Primitive) -> Option<&str> {
    match q {
        Primitive::Polygon { context_object_id, .. } => context_object_id.as_deref(),
        _ => None,
    }
}

fn section_mark(q: &Primitive) -> bool {
    match q {
        Primitive::Polygon { section_line_id, .. } => section_line_id.is_some(),
        Primitive::Line { cls, .. } => cls.starts_with("section-line") || cls.starts_with("section-mark"),
        _ => false,
    }
}

/// Alle Klassen aus ⇒ Grundriss, Schnitt und Ansicht leer. Mit allen Klassen ist von allem etwas da.
#[test]
fn alle_klassen_aus_leert_plan_schnitt_ansicht() {
    let p = project();
    let all = all_codes(&p);
    let full = plan(&p, "eg", &all);
    assert!(full.iter().any(|q| ctx_id(q) == Some(super::extras::SITE_PICK_SUN)), "Schatten");
    assert!(full.iter().any(|q| matches!(q, Primitive::Polygon { extruded_solid_id: Some(_), .. })), "Körper");
    assert!(full.iter().any(|q| matches!(q, Primitive::Polygon { section_line_id: Some(_), .. })), "Schnittmarken");
    for floor in ["eg", "og"] {
        let rest = plan(&p, floor, &[]);
        assert!(rest.is_empty(), "Grundriss {floor}: {rest:?}");
    }
    assert!(!section(&p, &all).is_empty());
    let rest = section(&p, &[]);
    assert!(rest.is_empty(), "Schnitt: {rest:?}");
    let full = elevation(&p, &all);
    assert!(full.iter().any(|q| ctx_id(q) == Some(super::extras::SITE_PICK_VIEW_SHADOWS)), "Schlagschatten der Ansicht");
    let rest = elevation(&p, &[]);
    assert!(rest.is_empty(), "Ansicht: {rest:?}");
}

/// Klasse „Schatten" aus: Grundriss ohne Sonnenschatten, Ansicht ohne Schlagschatten, sonst gleich.
#[test]
fn klasse_schatten() {
    let p = project();
    let all = all_codes(&p);
    let off = without(&all, SHADOW_CATEGORY);
    let (a, b) = (plan(&p, "eg", &all), plan(&p, "eg", &off));
    let sun = |v: &[Primitive]| v.iter().filter(|q| ctx_id(q) == Some(super::extras::SITE_PICK_SUN)).count();
    assert!(sun(&a) > 0 && sun(&b) == 0);
    assert_eq!(a.len() - sun(&a), b.len());
    let shade = |v: &[Primitive]| v.iter().filter(|q| ctx_id(q) == Some(super::extras::SITE_PICK_VIEW_SHADOWS)).count();
    let (a, b) = (elevation(&p, &all), elevation(&p, &off));
    assert!(shade(&a) > 0 && shade(&b) == 0);
    // Ohne die Klasse im Projekt (vor „Standards laden") bleibt der Schatten sichtbar.
    let mut q = p.clone();
    q.layers.retain(|l| l.code != SHADOW_CATEGORY);
    assert_eq!(sun(&plan(&q, "eg", &off)), sun(&plan(&p, "eg", &all)));
}

/// Klasse „Schnittmarken" aus: Grundriss ohne Schnitt-/Ansichtsmarken, sonst gleich.
#[test]
fn klasse_schnittmarken() {
    let p = project();
    let all = all_codes(&p);
    let (a, b) = (plan(&p, "eg", &all), plan(&p, "eg", &without(&all, SECTION_MARK_CATEGORY)));
    let marks = |v: &[Primitive]| v.iter().filter(|q| matches!(q, Primitive::Polygon { section_line_id: Some(_), .. })).count();
    assert!(marks(&a) > 0 && marks(&b) == 0);
    assert!(b.len() < a.len());
    assert!(!b.iter().any(section_mark));
}

/// Körper (auch Abzugskörper) liegen auf ihrer Klasse: im Grundriss und im Schnitt (Projektion) weg mit ihr.
#[test]
fn koerper_auf_ihrer_klasse() {
    let p = project();
    let all = all_codes(&p);
    let solid = |v: &[Primitive], id: &str| v.iter().any(|q| matches!(q, Primitive::Polygon { extruded_solid_id: Some(s), .. } if s == id));
    let a = plan(&p, "eg", &all);
    assert!(solid(&a, "k1") && solid(&a, "v1"));
    let b = plan(&p, "eg", &without(&all, "35"));
    assert!(!solid(&b, "k1") && solid(&b, "v1"));
}

/// Ansicht: Öffnungen und Treppen folgen ihrer Klasse (früher nur zusammen mit dem Darstellungsmodus); Raster
/// in Schnitt und Ansicht seiner.
#[test]
fn ansicht_oeffnungen_treppen_raster() {
    let p = project();
    let all = all_codes(&p);
    let opening = |v: &[Primitive]| v.iter().any(|q| matches!(q, Primitive::Polygon { opening_id: Some(_), .. }));
    let stair = |v: &[Primitive]| v.iter().any(|q| matches!(q, Primitive::Polygon { ceiling_id: Some(id), .. } if id == "ST1"));
    let grid = |v: &[Primitive]| v.iter().any(|q| matches!(q, Primitive::DrawingCircle { drawing_id: Some(id), .. } if id == "raster"));
    let a = elevation(&p, &all);
    assert!(opening(&a) && stair(&a) && grid(&a));
    let codes: Vec<String> = all.iter().filter(|c| *c != "21").cloned().collect();
    let b = elevation(&p, &codes);
    assert!(!opening(&b), "Öffnungen aus");
    assert!(!stair(&elevation(&p, &without(&all, "40"))), "Treppe aus");
    assert!(!grid(&elevation(&p, &without(&all, "00"))), "Raster aus (Ansicht)");
    assert!(grid(&section(&p, &all)) && !grid(&section(&p, &without(&all, "00"))), "Raster (Schnitt)");
    // Wand aus: ihre Öffnungen gehen mit.
    let c = elevation(&p, &without(&all, "20"));
    assert!(!opening(&c), "Öffnungen einer ausgeblendeten Wand");
}

/// Schnitt: Projektionskanten folgen der Klasse ihres Bauteils.
#[test]
fn schnitt_projektion_nach_klasse() {
    let p = project();
    let all = all_codes(&p);
    let visible = |v: &[Primitive]| v.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "section-visible")).count();
    let a = section(&p, &all);
    let b = section(&p, &without(&all, "20"));
    assert!(visible(&a) > visible(&b), "{} {}", visible(&a), visible(&b));
}

/// Aussenbemassung landet auf „Auto-Bemassung" (ohne die Klasse im Projekt: auf der aktiven).
#[test]
fn aussenbemassung_auf_eigener_klasse() {
    let p = project();
    let mut r: serde_json::Map<String, Value> = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
    let run = |r: &serde_json::Map<String, Value>| -> Vec<String> {
        let ops = crate::commands::ops(r, &crate::model::lenient::typed_for_test(r), &json!({"cmd": "autodim", "ctx": {"level": "eg", "cat": "50"}, "stamp": "s"}).to_string()).unwrap();
        ops.iter()
            .filter_map(|o| if let crate::ops::Op::Add { items, .. } = o { Some(items) } else { None })
            .flatten()
            .map(|d| d["categoryCode"].as_str().unwrap_or_default().to_string())
            .collect()
    };
    let cats = run(&r);
    assert!(!cats.is_empty() && cats.iter().all(|c| c == AUTO_DIM_CATEGORY), "{cats:?}");
    r.insert("layers".into(), json!([{"code": "50", "name": "Text", "color": "#000", "lw": 0.13, "visible": true, "locked": false}]));
    assert!(run(&r).iter().all(|c| c == "50"));
}
