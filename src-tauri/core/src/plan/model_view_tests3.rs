//! [173] Etappe 3 der Modelldarstellung: Raumstempel-Zeilen nach Stufe (der Stempel geht vor), Bemassung
//! (Ketten der automatischen Aussenbemassung, Höhenkoten), Stufennummern der Treppe und die mitgelieferten
//! Stufen (Standards). Ohne Wahl bzw. mit leeren Abschnitten bleibt alles gleich.

use super::*;
use crate::plan::domains::{plan_domains, plan_domains_buf, DomainPrims, PlanArgs};
use crate::plan::prim::Primitive;

fn sample() -> Project {
    serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
}

fn with_mv(mut p: Project, json: serde_json::Value) -> Project {
    let mut v = json;
    v["id"] = "mv".into();
    v["name"] = "Eigene".into();
    p.model_view_options = Some(vec![serde_json::from_value(v).unwrap()]);
    p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().model_view_option_id = Some("mv".into());
    p
}

fn drawing(id: &str, level: &str, geom: serde_json::Value) -> Drawing2D {
    serde_json::from_value(serde_json::json!({"id": id, "type": "drawing2d", "levelId": level, "categoryCode": "90", "geom": geom})).unwrap()
}

fn dim(id: &str, y: f64) -> Drawing2D {
    drawing(id, "eg", serde_json::json!({"shape": "dimension", "pts": [{"x": 0.0, "y": y}, {"x": 5.0, "y": y}], "offset": -0.5}))
}

/// Musterprojekt mit automatischer Aussenbemassung (drei Ketten Süd, eine Bogenkette), eigener Masskette und Kote.
fn with_drawings(mut p: Project) -> Project {
    p.drawings2d = vec![
        dim("autodim-eg-south-openings", -1.0),
        dim("autodim-eg-south-steps", -1.5),
        dim("autodim-eg-south-total", -2.0),
        dim("autodim-eg-arc-w-1", -2.5),
        dim("eigene", 6.0),
        drawing("k1", "eg", serde_json::json!({"shape": "kote", "at": {"x": 1.0, "y": 1.0}, "value": 0.0, "kind": "okFertig", "rotation": 0.0})),
    ];
    p
}

fn codes(p: &Project) -> Vec<String> {
    let mut c: Vec<String> = p.flat_categories().iter().map(|c| c.code.clone()).collect();
    c.extend(p.walls.iter().map(|w| w.category_code.clone()));
    c.extend(p.openings.iter().flatten().map(|o| o.category_code.clone()));
    c.extend(p.stairs.iter().flatten().map(|o| o.category_code.clone()));
    c.extend(p.rooms.iter().flatten().map(|o| o.category_code.clone()));
    c
}

fn args(p: &Project, scale: f64) -> PlanArgs {
    PlanArgs::parse_in(p, 1.0, &serde_json::json!({"floor": "eg", "show": codes(p), "scale": scale}).to_string()).unwrap()
}

fn plan(p: &Project, scale: f64) -> DomainPrims {
    plan_domains(p, &args(p, scale)).unwrap()
}

fn buf(p: &Project, scale: f64) -> Vec<u8> {
    plan_domains_buf(p, &args(p, scale)).unwrap()
}

/// Zeilen unter dem Namen im Stempel des Raums R1.
fn stamp_lines(d: &DomainPrims) -> Vec<String> {
    d.rooms
        .iter()
        .find_map(|q| match q {
            Primitive::Text { extra_lines, room_id: Some(r), .. } if r == "R1" => Some(extra_lines.iter().map(|l| l.text.clone()).collect()),
            _ => None,
        })
        .expect("Stempel R1")
}

fn stamp_text(d: &DomainPrims) -> String {
    d.rooms
        .iter()
        .find_map(|q| match q {
            Primitive::Text { doc, room_id: Some(r), .. } if r == "R1" => Some(doc.paragraphs.iter().flat_map(|p| p.runs.iter()).map(|r| r.text.clone()).collect::<Vec<_>>().join("|")),
            _ => None,
        })
        .unwrap()
}

fn dividers(d: &DomainPrims) -> usize {
    d.rooms.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "void")).count()
}

/// Ids der gezeichneten 2D-Zeichnungen.
fn drawn(d: &DomainPrims) -> Vec<String> {
    let mut ids: Vec<String> = d.drawings.prims.iter().filter_map(|q| serde_json::to_value(q).ok()?.get("drawingId")?.as_str().map(String::from)).collect();
    ids.dedup();
    ids
}

fn step_texts(d: &DomainPrims) -> Vec<String> {
    d.stairs.iter().filter_map(|q| if let Primitive::DrawingText { text, .. } = q { Some(text.clone()) } else { None }).collect()
}

#[test]
fn leere_abschnitte_wie_heute() {
    let mut p = with_drawings(sample());
    let r2 = Room { id: "R2".into(), stamp: Some(RoomStamp { name: "Bad".into(), number: Some("E.02".into()), show_floor_area: Some(true), show_finish: Some(true), ..Default::default() }), ..p.rooms.as_ref().unwrap()[0].clone() };
    p.rooms.as_mut().unwrap().push(r2);
    for scale in [50.0, 100.0, 200.0] {
        let heute = buf(&p, scale);
        let e = with_mv(p.clone(), serde_json::json!({"roomStamps": {}, "dimensions": {}, "stairs": {}}));
        assert_eq!(heute, buf(&e, scale), "leere Stufe 1:{scale}");
        // Ausdrücklich „wie heute" gesetzt.
        let e = with_mv(p.clone(), serde_json::json!({"roomStamps": {"number": true}, "dimensions": {"chains": "all", "levelMarks": true}, "stairs": {"stepNumbers": false}}));
        assert_eq!(heute, buf(&e, scale), "Basiswerte 1:{scale}");
    }
}

#[test]
fn raumstempel_ohne_stempel_nach_stufe() {
    let p = sample();
    assert_eq!(stamp_lines(&plan(&p, 100.0)).len(), 1, "heute: nur die Fläche");
    let q = with_mv(p.clone(), serde_json::json!({"roomStamps": {"area": false, "usage": true, "height": true}}));
    let l = stamp_lines(&plan(&q, 100.0));
    assert_eq!(l.len(), 2, "{l:?}");
    assert!(l[0].starts_with("HNF · "), "{l:?}");
    assert!(l[1].starts_with("LH ") && l[1].ends_with(" m"), "{l:?}");
    // Belag nach Stufe (der Raum hat keinen: keine Zeile).
    let q = with_mv(p.clone(), serde_json::json!({"roomStamps": {"area": false, "finish": true}}));
    assert!(stamp_lines(&plan(&q, 100.0)).is_empty());
}

#[test]
fn raumstempel_einstellung_am_stempel_geht_vor() {
    let mut p = sample();
    p.rooms.as_mut().unwrap()[0].stamp = Some(RoomStamp { name: "Wohnen".into(), number: Some("E.01".into()), show_floor_area: Some(true), show_divider: Some(false), ..Default::default() });
    let heute = plan(&p, 100.0);
    assert!(stamp_text(&heute).contains("E.01"));
    assert_eq!(dividers(&heute), 0);
    // Stufe: keine Fläche, keine Nummer, Trennlinie — die Fläche (am Stempel an) und die Trennlinie (am Stempel
    // aus) bleiben, die Nummer (Text am Stempel, Sichtbarkeit Stufe) fällt weg.
    let q = with_mv(p.clone(), serde_json::json!({"roomStamps": {"area": false, "number": false, "divider": true, "height": true}}));
    let d = plan(&q, 100.0);
    assert!(!stamp_text(&d).contains("E.01"), "{}", stamp_text(&d));
    let l = stamp_lines(&d);
    assert!(l[0].ends_with(" m²") && l.iter().any(|x| x.starts_with("LH ")), "{l:?}");
    assert_eq!(dividers(&d), 0, "Stempel: Trennlinie aus");
    // Stempel ohne Trennlinien-Wahl: die Stufe entscheidet.
    p.rooms.as_mut().unwrap()[0].stamp.as_mut().unwrap().show_divider = None;
    let q = with_mv(p.clone(), serde_json::json!({"roomStamps": {"divider": true}}));
    assert_eq!(dividers(&plan(&q, 100.0)), 1);
    assert_eq!(dividers(&plan(&p, 100.0)), 0, "ohne Stufe keine Trennlinie");
}

#[test]
fn raumstempel_flaeche_kategorie_stufe_steuert_wenn_stempel_offen() {
    let mut p = sample();
    p.rooms.as_mut().unwrap()[0].stamp = Some(RoomStamp { name: "Wohnen".into(), ..Default::default() });
    // Stempel ohne Wahl, ohne Stufe: Basis (Fläche ja, Kategorie nein) — wie ein Stempel mit dem alten Standard.
    let l = stamp_lines(&plan(&p, 100.0));
    assert_eq!(l.len(), 1, "{l:?}");
    assert!(l[0].ends_with(" m²"), "{l:?}");
    // Die Stufe steuert Fläche und Kategorie.
    let q = with_mv(p.clone(), serde_json::json!({"roomStamps": {"area": false, "usage": true}}));
    let l = stamp_lines(&plan(&q, 100.0));
    assert_eq!(l.len(), 1, "{l:?}");
    assert!(l[0].starts_with("HNF · "), "{l:?}");
    // Der Stempel geht vor, wo er gesetzt ist.
    p.rooms.as_mut().unwrap()[0].stamp.as_mut().unwrap().show_floor_area = Some(true);
    p.rooms.as_mut().unwrap()[0].stamp.as_mut().unwrap().show_usage = Some(false);
    let q = with_mv(p.clone(), serde_json::json!({"roomStamps": {"area": false, "usage": true}}));
    let l = stamp_lines(&plan(&q, 100.0));
    assert_eq!(l.len(), 1, "{l:?}");
    assert!(l[0].ends_with(" m²"), "{l:?}");
}

#[test]
fn bemassung_ketten_und_koten_nach_stufe() {
    let p = with_drawings(sample());
    let all = ["autodim-eg-south-openings", "autodim-eg-south-steps", "autodim-eg-south-total", "autodim-eg-arc-w-1", "eigene", "k1"];
    assert_eq!(drawn(&plan(&p, 100.0)), all);
    let q = with_mv(p.clone(), serde_json::json!({"dimensions": {"chains": "outer"}}));
    assert_eq!(drawn(&plan(&q, 100.0)), ["autodim-eg-south-steps", "autodim-eg-south-total", "eigene", "k1"]);
    let q = with_mv(p.clone(), serde_json::json!({"dimensions": {"chains": "total", "levelMarks": false}}));
    assert_eq!(drawn(&plan(&q, 100.0)), ["autodim-eg-south-total", "eigene"]);
    assert!(buf(&q, 100.0).len() < buf(&p, 100.0).len());
}

#[test]
fn kette_aus_der_id() {
    let d = |id: &str, level: &str| drawing(id, level, serde_json::json!({"shape": "dimension", "pts": [], "offset": 0.0}));
    assert_eq!(autodim_chain(&d("autodim-og-1-west-openings", "og-1")), Some("openings"));
    assert_eq!(autodim_chain(&d("autodim-eg-south2-total", "eg")), Some("total"));
    assert_eq!(autodim_chain(&d("autodim-eg-oblique1-steps", "eg")), Some("steps"));
    assert_eq!(autodim_chain(&d("autodim-eg-arc-wand-3", "eg")), Some("arc"));
    assert_eq!(autodim_chain(&d("autodim-eg-south-total", "og")), None, "andere Ebene");
    assert_eq!(autodim_chain(&d("massk-1", "eg")), None);
}

#[test]
fn stufennummern_nach_stufe() {
    let p = sample();
    assert!(step_texts(&plan(&p, 50.0)).is_empty(), "Basis: keine Nummern");
    let q = with_mv(p.clone(), serde_json::json!({"stairs": {"stepNumbers": true}}));
    let n = step_texts(&plan(&q, 50.0));
    assert!(n.len() >= 10, "{n:?}");
    assert_eq!(n[0], "1");
    assert_eq!(n.last().unwrap(), &n.len().to_string());
    // Ohne Stufen über der Schnitthöhe: auch ohne deren Nummern.
    let q = with_mv(p.clone(), serde_json::json!({"stairs": {"stepNumbers": true, "aboveCut": "off"}}));
    let m = step_texts(&plan(&q, 50.0));
    assert!(!m.is_empty() && m.len() < n.len(), "{} < {}", m.len(), n.len());
}

#[test]
fn stufennummern_beruehren_die_pfeilspitze_nicht() {
    let p = sample();
    let q = with_mv(p.clone(), serde_json::json!({"stairs": {"stepNumbers": true}}));
    let d = plan(&q, 50.0);
    // Pfeilspitze (Linien `stair-arrow`, gefüllte Spitze) gegen die Kästen der Nummern.
    let mut arrows: Vec<[f64; 4]> = Vec::new();
    for pr in &d.stairs {
        match pr {
            Primitive::Line { a, b, cls, .. } if cls == "stair-arrow" => arrows.push([a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y)]),
            Primitive::Polygon { pts, fill, .. } if fill != "none" && pts.len() == 3 => {
                arrows.push([pts.iter().map(|q| q.x).fold(f64::INFINITY, f64::min), pts.iter().map(|q| q.y).fold(f64::INFINITY, f64::min), pts.iter().map(|q| q.x).fold(f64::NEG_INFINITY, f64::max), pts.iter().map(|q| q.y).fold(f64::NEG_INFINITY, f64::max)])
            }
            _ => {}
        }
    }
    assert!(!arrows.is_empty(), "Pfeil vorhanden");
    let mut n = 0;
    for pr in &d.stairs {
        if let Primitive::DrawingText { at, text, height_m, .. } = pr {
            n += 1;
            let w = crate::text_layout::text_width_em(text, false) * height_m;
            for b in &arrows {
                let hit = at.x < b[2] && at.x + w > b[0] && at.y < b[3] && at.y + 0.7 * height_m > b[1];
                assert!(!hit, "Nummer {text} berührt die Pfeilspitze");
            }
        }
    }
    assert!(n >= 10, "Nummern bleiben (bis auf höchstens eine): {n}");
}

#[test]
fn hoehenkoten_rangfolge_ebene_vor_stufe() {
    let p = sample();
    let o = resolve(None, crate::plan::style::Detail::Mittel, 100.0);
    assert!(o.level_marks(None));
    let q = with_mv(p.clone(), serde_json::json!({"dimensions": {"levelMarks": false}}));
    let o = for_view(&q, Some("mv"), crate::plan::style::Detail::Mittel, 100.0);
    assert!(!o.level_marks(None));
    assert!(o.level_marks(Some(true)), "Ebene geht vor");
}

#[test]
fn mitgelieferte_stufen_aus_den_standards() {
    let root = serde_json::to_value(sample()).unwrap().as_object().unwrap().clone();
    let ops = crate::standards::merge_ops(&root);
    let add: Vec<ModelViewOption> = ops
        .iter()
        .filter(|o| o["collection"] == "modelViewOptions" || o["key"] == "modelViewOptions")
        .flat_map(|o| o.get("items").or_else(|| o.get("value")).and_then(|v| v.as_array()).cloned().unwrap_or_default())
        .map(|v| serde_json::from_value(v).unwrap())
        .collect();
    let names: Vec<&str> = add.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, ["Wettbewerb 1:200", "Baueingabe 1:100", "Ausführung 1:50", "Rohbau/Statik"]);
    // Alles bekannt (keine verlorenen Felder) und unterscheidbar.
    for m in &add {
        assert!(m.extra.0.is_empty(), "{}: {:?}", m.name, m.extra);
        assert!(m.id.starts_with("std-mv-"));
    }
    let w = resolve(Some(&add[0]), crate::plan::style::Detail::Mittel, 200.0);
    assert_eq!(w.dims.chains, DimChains::Total);
    assert_eq!(w.stamp.number, Some(false));
    let r = resolve(Some(&add[3]), crate::plan::style::Detail::Mittel, 100.0);
    assert_eq!(r.wall.layers, LayerMode::Core);
    let a = resolve(Some(&add[2]), crate::plan::style::Detail::Fein, 50.0);
    assert!(a.stair.step_numbers && a.stamp.height == Some(true));
    // Übernommen und dann im Plan gewählt: Grundriss ändert sich.
    let mut p = with_drawings(sample());
    p.model_view_options = Some(add.clone());
    let heute = buf(&p, 100.0);
    p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().model_view_option_id = Some("std-mv-wettbewerb-200".into());
    assert_ne!(heute, buf(&p, 100.0));
}
