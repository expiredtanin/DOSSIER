//! [260] Darstellungsart von Fenstern und Türen im Grundriss: symbolisch (Vorgabe, Symbol unabhängig von der
//! Schnitthöhe) oder geschnitten (nach der Schnitthöhe: Wand geschlossen, Öffnung als Linie über/unter Schnitt).
//! Rangfolge Element > Typ > Modelldarstellung > symbolisch.

use crate::model::*;
use crate::plan::domains::{plan_domains, DomainPrims, PlanArgs};
use crate::plan::prim::Primitive;


fn sample() -> Project {
    serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
}

/// Musterprojekt mit dem Badfenster O1: Brüstung 1.10 m, Höhe 0.6 m — ganz über der Schnitthöhe 1.0 m.
fn bath_window() -> Project {
    let mut p = sample();
    let o1 = p.openings.as_mut().unwrap().iter_mut().find(|o| o.id == "O1").unwrap();
    (o1.sill_height, o1.height) = (1.1, 0.6);
    p
}

fn o1_mut(p: &mut Project) -> &mut Opening {
    p.openings.as_mut().unwrap().iter_mut().find(|o| o.id == "O1").unwrap()
}

fn with_mv(mut p: Project, mode: &str) -> Project {
    let v = serde_json::json!({"id": "mv", "name": "Eigene", "walls": {"openingPlanMode": mode}});
    p.model_view_options = Some(vec![serde_json::from_value(v).unwrap()]);
    p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().model_view_option_id = Some("mv".into());
    p
}

fn run(p: &Project) -> DomainPrims {
    let codes: Vec<String> = p.walls.iter().map(|w| w.category_code.clone()).chain(p.openings.iter().flatten().map(|o| o.category_code.clone())).collect();
    let t = serde_json::json!({"floor": "eg", "show": codes, "scale": 100.0}).to_string();
    plan_domains(p, &PlanArgs::parse_in(p, 1.0, &t).unwrap()).unwrap()
}

/// Mitte der Öffnung O1 auf der Wandachse.
fn o1_center(p: &Project) -> Vec2 {
    let o = p.openings.iter().flatten().find(|o| o.id == "O1").unwrap();
    let w = p.walls.iter().find(|w| w.id == o.host_wall_id).unwrap();
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let l = (dx * dx + dy * dy).sqrt();
    let s = o.position + o.width / 2.0;
    Vec2 { x: w.start.x + dx / l * s, y: w.start.y + dy / l * s }
}

fn inside(pts: &[Vec2], q: Vec2) -> bool {
    let mut c = false;
    let n = pts.len();
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        if (a.y > q.y) != (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x {
            c = !c;
        }
    }
    c
}

/// Schliesst eine gefüllte Wandfläche die Öffnung (Wand im Grundriss geschlossen)?
fn wall_closed_at(d: &DomainPrims, q: Vec2) -> bool {
    d.walls.iter().any(|x| matches!(x, Primitive::Polygon { pts, fill, wall_id: Some(_), opening_id: None, .. } if fill != "none" && inside(pts, q)))
}

/// Linien „über Schnitt“ (Strichpunkt) bzw. „unter Schnitt“ (gepunktet) im Wand-Bereich.
fn view_range_lines(d: &DomainPrims) -> usize {
    d.walls.iter().filter(|x| matches!(x, Primitive::Line { cls, .. } if cls == "view-range")).count()
}

#[test]
fn symbolisch_badfenster_ab_110_als_symbol() {
    let p = bath_window();
    let d = run(&p);
    let c = o1_center(&p);
    assert!(!wall_closed_at(&d, c), "Vorgabe symbolisch: Wandlücke wie ein geschnittenes Fenster");
    assert_eq!(view_range_lines(&d), 0, "keine Linie über Schnitt");
    // Dieselbe Darstellung wie ein Fenster, das die Schnittebene trifft (Lücke, Symbol im Wandbereich).
    let mut q = sample();
    (o1_mut(&mut q).sill_height, o1_mut(&mut q).height) = (0.9, 1.2);
    assert!(!wall_closed_at(&run(&q), c));
    // Auch unter der Schnittebene (Kellerfenster) und ganz darüber (Oberlicht) symbolisch.
    let mut k = sample();
    (o1_mut(&mut k).sill_height, o1_mut(&mut k).height) = (0.1, 0.5);
    let dk = run(&k);
    assert!(!wall_closed_at(&dk, c) && view_range_lines(&dk) == 0, "Kellerfenster");
}

#[test]
fn geschnitten_wand_geschlossen_linie_ueber_schnitt() {
    let mut p = bath_window();
    o1_mut(&mut p).plan_mode = Some(OpeningPlanMode::Geschnitten);
    let d = run(&p);
    let c = o1_center(&p);
    assert!(wall_closed_at(&d, c), "geschnitten: die Wand bleibt über der Öffnung geschlossen");
    let dash = crate::plan::view_range::ABOVE_DASH.to_vec();
    let above: Vec<&Primitive> = d.walls.iter().filter(|x| matches!(x, Primitive::Line { cls, dash: Some(Some(v)), .. } if cls == "view-range" && *v == dash)).collect();
    assert!(!above.is_empty(), "Öffnung als Linie über Schnitt (Strichpunkt)");
    // [256] Auf schwarzer Wand (1:100) hell.
    assert!(above.iter().any(|x| matches!(x, Primitive::Line { color: Some(k), .. } if k == crate::plan::contrast::CONTRAST_INK)));
    // Unter der Schnittebene: gepunktet.
    let mut k = sample();
    (o1_mut(&mut k).sill_height, o1_mut(&mut k).height) = (0.1, 0.5);
    o1_mut(&mut k).plan_mode = Some(OpeningPlanMode::Geschnitten);
    let dk = run(&k);
    let dotted = crate::plan::view_range::UNDER_DASH.to_vec();
    assert!(wall_closed_at(&dk, c));
    assert!(dk.walls.iter().any(|x| matches!(x, Primitive::Line { cls, dash: Some(Some(v)), .. } if cls == "view-range" && *v == dotted)), "unter Schnitt gepunktet");
    // Trifft der Schnitt die Öffnung, bleibt sie geschnitten wie bisher.
    let mut q = sample();
    o1_mut(&mut q).plan_mode = Some(OpeningPlanMode::Geschnitten);
    let dq = run(&q);
    assert!(!wall_closed_at(&dq, c) && view_range_lines(&dq) == 0);
}

#[test]
fn rangfolge_element_vor_typ_vor_modelldarstellung() {
    let c = o1_center(&bath_window());
    let closed = |p: &Project| wall_closed_at(&run(p), c);
    // Modelldarstellung geschnitten ⇒ geschlossen.
    let mv = with_mv(bath_window(), "geschnitten");
    assert!(closed(&mv));
    // Typ symbolisch geht vor der Modelldarstellung.
    let mut ty = mv.clone();
    let tid = o1_mut(&mut ty).type_id.clone().unwrap();
    ty.window_types.as_mut().unwrap().iter_mut().find(|t| t.id == tid).unwrap().plan_mode = Some(OpeningPlanMode::Symbolisch);
    assert!(!closed(&ty));
    // Element geschnitten geht vor dem Typ.
    let mut el = ty.clone();
    o1_mut(&mut el).plan_mode = Some(OpeningPlanMode::Geschnitten);
    assert!(closed(&el));
    // Typ geschnitten ohne Modelldarstellung, Element symbolisch geht vor.
    let mut t2 = bath_window();
    t2.window_types.as_mut().unwrap().iter_mut().find(|t| t.id == tid).unwrap().plan_mode = Some(OpeningPlanMode::Geschnitten);
    assert!(closed(&t2));
    o1_mut(&mut t2).plan_mode = Some(OpeningPlanMode::Symbolisch);
    assert!(!closed(&t2));
    // Auflösung direkt.
    let o = crate::plan::model_view::resolve(None, crate::plan::style::Detail::Mittel, 100.0);
    assert_eq!(o.wall.opening_plan_mode(None, None), OpeningPlanMode::Symbolisch);
    assert_eq!(o.wall.opening_plan_mode(None, Some(OpeningPlanMode::Geschnitten)), OpeningPlanMode::Geschnitten);
    assert_eq!(o.wall.opening_plan_mode(Some(OpeningPlanMode::Symbolisch), Some(OpeningPlanMode::Geschnitten)), OpeningPlanMode::Symbolisch);
}

#[test]
fn tuer_typ_geschnitten_gilt_fuer_tueren() {
    // Tür D1 mit Brüstung über der Schnittebene (z. B. Oberlicht-Tür in einer Schachtwand), Türtyp geschnitten.
    let mut p = sample();
    let d1 = p.openings.as_mut().unwrap().iter_mut().find(|o| o.id == "D1").unwrap();
    (d1.sill_height, d1.height) = (1.2, 0.8);
    let base = run(&p);
    assert_eq!(view_range_lines(&base), 0);
    p.door_types.as_mut().unwrap().iter_mut().find(|t| t.id == "door-standard").unwrap().plan_mode = Some(OpeningPlanMode::Geschnitten);
    assert!(view_range_lines(&run(&p)) > 0);
}
