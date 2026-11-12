//! [207] Situationsplan / Schwarzplan: eigenes Gebäude schwarz, Kontext grau (bzw. schwarz), Klassen, Planzeichen.

use super::*;
use crate::plan::domains::{plan_domains_buf, PlanArgs};
use crate::standards::{derived_categories, model_views, SITUATION_CATEGORY, SYMBOL_CATEGORY};
use serde_json::{json, Value};

/// Würfel 10 × 6 × 8 m an (x0, y0), Dreiecke wie beim Import (aussen, ohne Boden-Duplikate).
fn box_mesh(id: &str, category: &str, x0: f64, y0: f64) -> Value {
    let (x1, y1) = (x0 + 10.0, y0 + 6.0);
    let positions = [x0, y0, 0.0, x1, y0, 0.0, x1, y1, 0.0, x0, y1, 0.0, x0, y0, 8.0, x1, y0, 8.0, x1, y1, 8.0, x0, y1, 8.0];
    let indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    json!({"type": "importedMesh", "id": id, "name": id, "categoryCode": category, "positions": positions.to_vec(), "indices": indices.to_vec()})
}

fn project() -> Project {
    let mut v: Value = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
    v["layers"].as_array_mut().unwrap().extend(derived_categories());
    v["layers"].as_array_mut().unwrap().push(json!({"code": "12", "name": "Gebäude", "color": "#888888", "lw": 0.18, "visible": true, "locked": false}));
    // Untergeschoss mit einer Wand ausserhalb des Hauses: zählt nicht zum Gebäude über dem Terrain.
    v["drawingLevels"].as_array_mut().unwrap().push(json!({"id": "ug", "name": "UG", "kind": "floor", "visible": true, "locked": false, "baseElevation": -2.7}));
    v["walls"].as_array_mut().unwrap().push(json!({"id": "w-ug", "type": "wall", "floorId": "ug", "categoryCode": "20", "start": {"x": 20, "y": 0}, "end": {"x": 25, "y": 0}, "wallTypeId": "aw", "height": 2.6}));
    v["modelViewOptions"] = Value::Array(model_views());
    v["context"] = json!([box_mesh("nachbar-1", "12", 12.0, -1.0), box_mesh("nachbar-2", "12", -14.0, 5.0)]);
    serde_json::from_value(v).unwrap()
}

fn codes(p: &Project) -> Vec<String> {
    p.flat_categories().iter().map(|c| c.code.clone()).collect()
}

fn plan(p: &Project, show: &[String], model_view: &str) -> Vec<Primitive> {
    let a = PlanArgs::parse(1.0, &json!({"floor": "eg", "show": show, "global": true, "scale": 500, "modelView": model_view}).to_string()).unwrap();
    let buf = plan_domains_buf(p, &a).unwrap();
    crate::plan::buf::View::parse(&buf).unwrap().prims().unwrap()
}

fn without(codes: &[String], code: &str) -> Vec<String> {
    codes.iter().filter(|c| *c != code).cloned().collect()
}

fn fills<'a>(ps: &'a [Primitive], color: &str) -> Vec<&'a Primitive> {
    ps.iter().filter(|q| matches!(q, Primitive::Polygon { fill, .. } if fill == color)).collect()
}

fn ring_area(pts: &[Vec2]) -> f64 {
    (0..pts.len()).map(|i| (pts[i].x * pts[(i + 1) % pts.len()].y - pts[(i + 1) % pts.len()].x * pts[i].y) / 2.0).sum::<f64>().abs()
}

#[test]
fn eigenes_gebaeude_schwarz_ohne_bauteile() {
    let p = project();
    let ps = plan(&p, &codes(&p), "std-mv-situation-wbw");
    // Keine Wand-Poché, keine Raumstempel, keine Schnittmarken.
    assert!(!ps.iter().any(|q| matches!(q, Primitive::Polygon { wall_id: Some(_), .. })), "Wände entfallen");
    assert!(!ps.iter().any(|q| matches!(q, Primitive::Text { room_id: Some(_), .. })), "Raumstempel entfallen");
    let black: Vec<_> = fills(&ps, "#000000").into_iter().filter(|q| matches!(q, Primitive::Polygon { context_object_id: None, stroke_width_mm, .. } if *stroke_width_mm == 0.1)).collect();
    assert_eq!(black.len(), 1, "ein schwarzer Umriss (UG-Wand zählt nicht)");
    let Primitive::Polygon { pts, .. } = black[0] else { unreachable!() };
    assert!(pts.iter().all(|q| q.x < 6.0), "nur das Haus über dem Terrain: {pts:?}");
    let a = ring_area(pts);
    assert!(a > 15.0 && a < 40.0, "Fläche des Hauses: {a}");
}

#[test]
fn kontext_grau_und_schwarzplan_schwarz() {
    let p = project();
    let wbw = plan(&p, &codes(&p), "std-mv-situation-wbw");
    let grey: Vec<_> = wbw.iter().filter(|q| matches!(q, Primitive::Polygon { context_object_id: Some(_), fill, .. } if fill == "#b8b8b8")).collect();
    assert_eq!(grey.len(), 2, "zwei Nachbarn grau");
    let Primitive::Polygon { pts, context_object_id, .. } = grey[0] else { unreachable!() };
    assert_eq!(context_object_id.as_deref(), Some("nachbar-1"));
    assert!((ring_area(pts) - 60.0).abs() < 1e-6, "Grundfläche aus der Aufsicht: {}", ring_area(pts));
    let sp = plan(&p, &codes(&p), "std-mv-schwarzplan");
    let black_ctx = sp.iter().filter(|q| matches!(q, Primitive::Polygon { context_object_id: Some(_), fill, .. } if fill == "#000000")).count();
    assert_eq!(black_ctx, 2, "Schwarzplan: Nachbarn schwarz");
}

#[test]
fn alles_auf_klassen() {
    let p = project();
    let all = codes(&p);
    let own = |ps: &[Primitive]| ps.iter().filter(|q| matches!(q, Primitive::Polygon { context_object_id: None, fill, stroke_width_mm, .. } if fill == "#000000" && *stroke_width_mm == 0.1)).count();
    let ctx = |ps: &[Primitive]| ps.iter().filter(|q| matches!(q, Primitive::Polygon { context_object_id: Some(_), .. })).count();
    let north = |ps: &[Primitive]| ps.iter().any(|q| matches!(q, Primitive::DrawingText { text, .. } if text == "N"));
    let base = plan(&p, &all, "std-mv-situation-wbw");
    assert!(own(&base) == 1 && ctx(&base) == 2 && north(&base));
    let no_own = plan(&p, &without(&all, SITUATION_CATEGORY), "std-mv-situation-wbw");
    assert!(own(&no_own) == 0 && ctx(&no_own) == 2 && north(&no_own), "Klasse 83 schaltet das eigene Gebäude");
    let no_ctx = plan(&p, &without(&all, "12"), "std-mv-situation-wbw");
    assert!(own(&no_ctx) == 1 && ctx(&no_ctx) == 0, "Klasse der Netze schaltet den Kontext");
    let no_sym = plan(&p, &without(&all, SYMBOL_CATEGORY), "std-mv-situation-wbw");
    assert!(own(&no_sym) == 1 && !north(&no_sym), "Klasse 84 schaltet Nordpfeil und Massstabsbalken");
}

#[test]
fn gewoehnlicher_grundriss_bleibt() {
    let p = project();
    let ps = plan(&p, &codes(&p), "mittel");
    assert!(ps.iter().any(|q| matches!(q, Primitive::Polygon { wall_id: Some(_), .. })));
    assert!(fills(&ps, "#b8b8b8").is_empty());
    assert!(!ps.iter().any(|q| matches!(q, Primitive::DrawingText { text, .. } if text == "N")));
}

#[test]
fn dachaufsicht_zaehlt_zum_gebaeude() {
    let p = project();
    let Some(r) = p.roofs.as_deref().and_then(|r| r.first()) else { panic!("Fixture hat ein Dach") };
    let g = crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r));
    let polys = own_polygons(&p);
    let (min_x, max_x) = g.eaves.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |a, q| (a.0.min(q[0]), a.1.max(q[0])));
    let xs: Vec<f64> = polys.iter().flat_map(|q| q[0].iter().map(|r| r[0])).collect();
    assert!(xs.iter().cloned().fold(f64::INFINITY, f64::min) <= min_x + 1e-6 && xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max) >= max_x - 1e-6, "Umriss deckt die Traufe");
}

#[test]
fn netz_flaeche_ohne_senkrechte() {
    // Nur senkrechte Dreiecke: keine Fläche in der Aufsicht.
    let pos = [0.0, 0.0, 0.0, 5.0, 0.0, 0.0, 5.0, 0.0, 3.0];
    assert!(mesh_polygons(&pos, &[0.0, 1.0, 2.0]).is_empty());
    // Ungültige Indizes und NaN: ohne Panic leer.
    assert!(mesh_polygons(&[0.0, 0.0, 0.0, f64::NAN, 0.0, 0.0, 1.0, 1.0, 0.0], &[0.0, 1.0, 2.0, 0.0, 9.0, 1.0]).is_empty());
}

#[test]
fn massstabsbalken_rund_und_im_papiermass() {
    assert_eq!(scalebar_total(500.0), 20.0);
    assert_eq!(scalebar_total(1000.0), 50.0);
    assert_eq!(scalebar_total(200.0), 10.0);
    let s = symbols(500.0, 40.0, -10.0);
    // Vier Balkenfelder + zwei Spitzenhälften, alle unter der Lage (Papierabstand 12 mm = 6 m).
    let polys: Vec<_> = s.iter().filter_map(|q| if let Primitive::Polygon { pts, .. } = q { Some(pts) } else { None }).collect();
    assert_eq!(polys.len(), 6);
    assert!(polys.iter().flat_map(|p| p.iter()).all(|q| q.y < -10.0), "unter der Oberkante der Lage");
}

#[test]
fn baurecht_nur_parzellengrenze() {
    let mut p = project();
    p.site_rules = Some(serde_json::from_value(json!({"parcel": [{"x": -8, "y": -8}, {"x": 16, "y": -8}, {"x": 16, "y": 12}, {"x": -8, "y": 12}], "setbacks": [3, 3, 3, 3], "defaultSetback": 3, "show": true})).unwrap());
    let mut all = codes(&p);
    all.push("01".into());
    let ps = plan(&p, &all, "std-mv-situation-wbw");
    let cls = |c: &str| ps.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == c)).count();
    assert!(cls("site-parcel") >= 4, "Parzellengrenze bleibt");
    assert_eq!(cls("site-allowed"), 0, "kein Baubereich");
    let normal = plan(&p, &all, "mittel");
    assert!(normal.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "site-allowed")).count() > 0, "im gewöhnlichen Grundriss schon");
}
