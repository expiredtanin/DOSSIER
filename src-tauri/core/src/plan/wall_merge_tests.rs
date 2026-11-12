//! [198] Gleiche Schichten benachbarter Wände verschmelzen: am T-Stoss, an Ecken und Kreuzungen liegt
//! zwischen zwei Flächen gleichen Stils (Innenputz an Innenputz, Dämmung an Dämmung) keine Linie mehr;
//! am Materialwechsel (andere Schraffur, andere Schicht) bleibt sie.

use super::prim::Primitive;
use super::seams::{style_key, Region};
use super::wall_join_tests::*;
use crate::model::*;

/// Gezeichnete Strecken: Wandlinien (Umriss, Fugen) und Kanten gestrichener Wand-Polygone.
fn drawn(ps: &[Primitive]) -> Vec<(Vec2, Vec2)> {
    let mut out = Vec::new();
    for q in ps {
        match q {
            Primitive::Line { a, b, cls, opening_id: None, .. } if matches!(&**cls, "wall-outline" | "layer-joint" | "layer-joint-l") => out.push((*a, *b)),
            Primitive::Polygon { pts, stroke, stroke_width_mm, no_stroke_edges, wall_id: Some(_), opening_id: None, .. } if stroke != "none" && *stroke_width_mm > 0.0 => {
                let skip = no_stroke_edges.clone().unwrap_or_default();
                for i in 0..pts.len() {
                    if !skip.contains(&(i as f64)) {
                        out.push((pts[i], pts[(i + 1) % pts.len()]));
                    }
                }
            }
            _ => {}
        }
    }
    out.retain(|(a, b)| (a.x - b.x).hypot(a.y - b.y) > 1e-9);
    out
}

fn regions(ps: &[Primitive]) -> Vec<Region> {
    ps.iter()
        .filter_map(|q| match q {
            Primitive::Polygon { pts, fill, stroke, hatch, greyed, wall_id: Some(w), opening_id: None, .. } if stroke == "none" && fill != "none" => Some(Region::new(pts.clone(), style_key(fill, *greyed, hatch), w.clone())),
            _ => None,
        })
        .collect()
}

/// Gezeichnete Strecken (ganze Strecke oder Teilstück), die zwei Flächen gleichen Stils verschiedener Wände trennen.
fn seams(ps: &[Primitive]) -> Vec<(Vec2, Vec2)> {
    let rs = regions(ps);
    let d = 1e-3;
    drawn(ps)
        .into_iter()
        .filter(|(a, b)| {
            let len = (b.x - a.x).hypot(b.y - a.y);
            let n = Vec2 { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
            // Proben alle 2.5 mm entlang der Strecke (nur Teilstücke können zwischen gleichen Flächen liegen).
            let steps = (len / 2.5e-3).ceil().max(1.0) as usize;
            (0..steps).any(|i| {
                let t = (i as f64 + 0.5) / steps as f64;
                let m = Vec2 { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
                let side = |s: f64| rs.iter().filter(|r| r.contains(Vec2 { x: m.x + n.x * s * d, y: m.y + n.y * s * d })).collect::<Vec<_>>();
                let (l, r) = (side(1.0), side(-1.0));
                l.iter().any(|x| r.iter().any(|y| x.key == y.key && x.owner != y.owner))
            })
        })
        .collect()
}

fn has_segment(ps: &[Primitive], pred: impl Fn(Vec2, Vec2) -> bool) -> bool {
    drawn(ps).into_iter().any(|(a, b)| pred(a, b))
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

/// T-Stoss Innenwand an Innenwand (gleicher Innenputz): keine Linie zwischen den Putzflächen
/// (vorher ein Stück Umrisslinie der Durchgangswand unter dem Putz des Abzweigs); die Fuge Putz/Backstein
/// des Abzweigs und der Wandumriss ausserhalb bleiben.
#[test]
fn t_stoss_innenputz_ohne_trennlinie() {
    let mut p = base();
    add_wall(&mut p, "iw", (0.0, 0.0), (6.0, 0.0));
    add_wall(&mut p, "iw", (3.0, 0.0), (3.0, 3.0));
    let ps = prims(&p);
    assert!(seams(&ps).is_empty(), "Trennlinien: {:?}", seams(&ps));
    // Das Stück Wandumriss unter dem Abzweig-Putz (y = 7.5 cm, x 3.06 … 3.075) ist weg, beide Seiten.
    let stub = |a: Vec2, b: Vec2| near(a.y, 0.075) && near(b.y, 0.075) && a.x.min(b.x) < 3.07 && a.x.max(b.x) > 3.065;
    assert!(!has_segment(&ps, stub), "Putzfuge steht noch");
    // Umriss ausserhalb, Fuge Putz/Backstein im Abzweig bleiben.
    assert!(has_segment(&ps, |a, b| near(a.y, 0.075) && near(b.y, 0.075) && a.x.min(b.x) < 0.01 && a.x.max(b.x) > 2.9), "Wandumriss links");
    assert!(has_segment(&ps, |a, b| near(a.x, 3.06) && near(b.x, 3.06) && a.y.min(b.y) < 0.2 && a.y.max(b.y) > 2.9), "Fuge Putz/Backstein");
}

/// Gegenprobe: ohne Verschmelzung findet der Test die Trennlinie (Stück Wandumriss unter dem Putz).
#[test]
fn ohne_verschmelzung_steht_die_trennlinie() {
    let mut p = base();
    add_wall(&mut p, "iw", (0.0, 0.0), (6.0, 0.0));
    add_wall(&mut p, "iw", (3.0, 0.0), (3.0, 3.0));
    super::seams::OFF.with(|o| o.set(true));
    let ps = prims(&p);
    super::seams::OFF.with(|o| o.set(false));
    assert!(!seams(&ps).is_empty(), "Trennlinie wird nicht erkannt");
}

/// Kreuzung und Ecke: ebenso keine Linie zwischen gleichen Flächen.
#[test]
fn kreuzung_und_ecke_ohne_trennlinie() {
    let cases: [(&str, Vec<((f64, f64), (f64, f64))>); 5] = [
        ("iw", vec![((0.0, 0.0), (6.0, 0.0)), ((3.0, -3.0), (3.0, 0.0)), ((3.0, 0.0), (3.0, 3.0))]),
        ("iw", vec![((0.0, 0.0), (3.0, 0.0)), ((3.0, 0.0), (3.0, 3.0))]),
        ("aw", vec![((0.0, 0.0), (6.0, 0.0)), ((3.0, 0.0), (3.0, 3.0))]),
        ("aw", vec![((0.0, 0.0), (3.0, 0.0)), ((3.0, 0.0), (3.0, 3.0))]),
        ("dw", vec![((0.0, 0.0), (6.0, 0.0)), ((3.0, 0.0), (3.0, 3.0))]),
    ];
    for (t, walls) in cases {
        let mut p = base();
        for (s, e) in &walls {
            add_wall(&mut p, t, *s, *e);
        }
        let ps = prims(&p);
        assert!(seams(&ps).is_empty(), "{t} {walls:?}: Trennlinien {:?}", seams(&ps));
    }
}

/// Innenwand an Aussenwand: Innenputz an Innenputz verschmolzen, Dämmung/Backstein der Aussenwand unberührt.
#[test]
fn t_stoss_innenwand_an_aussenwand() {
    let mut p = base();
    add_wall(&mut p, "aw", (0.0, 0.0), (6.0, 0.0));
    add_wall(&mut p, "iw", (3.0, 0.0), (3.0, 3.0));
    let ps = prims(&p);
    assert!(seams(&ps).is_empty(), "Trennlinien: {:?}", seams(&ps));
    // Die Fuge Backstein/Putz der Aussenwand läuft ausserhalb der Kernbreite weiter.
    let before = drawn(&ps).len();
    assert!(before > 8, "{before}");
}

/// Materialwechsel behält seine Linie: Abzweig mit anderer Putz-Schraffur an Durchgangswand mit Putz ohne Muster.
#[test]
fn materialwechsel_behaelt_die_linie() {
    let mut p = base();
    p.components.push(Component { id: "render-x".into(), join_priority: 10.0, hatch_id: "diag".into(), ..Default::default() });
    let layer = |c: &str, t: f64| Layer { component_id: c.into(), thickness: t, ..Default::default() };
    p.wall_types.push(WallType { id: "ix".into(), layers: vec![layer("render-x", 0.015), layer("brick", 0.12), layer("render-x", 0.015)], ..Default::default() });
    add_wall(&mut p, "iw", (0.0, 0.0), (6.0, 0.0));
    add_wall(&mut p, "ix", (3.0, 0.0), (3.0, 3.0));
    let ps = prims(&p);
    let stub = |a: Vec2, b: Vec2| near(a.y, 0.075) && near(b.y, 0.075) && a.x.min(b.x) < 3.07 && a.x.max(b.x) > 3.065;
    assert!(has_segment(&ps, stub), "Linie am Materialwechsel (Putz anderer Schraffur) fehlt");
}

/// Bild für den Bericht (`DOSSIER_S198_DIR=… cargo test -- --ignored t_stoss_bild`): T-Stoss vorher/nachher als SVG.
#[test]
#[ignore]
fn t_stoss_bild() {
    let Ok(dir) = std::env::var("DOSSIER_S198_DIR") else { return };
    for (name, off) in [("vorher", true), ("nachher", false)] {
        let mut p = base();
        add_wall(&mut p, "iw", (0.0, 0.0), (6.0, 0.0));
        add_wall(&mut p, "iw", (3.0, 0.0), (3.0, 3.0));
        super::seams::OFF.with(|o| o.set(off));
        let ps = prims(&p);
        super::seams::OFF.with(|o| o.set(false));
        let mut s = String::from("<svg xmlns='http://www.w3.org/2000/svg' viewBox='2.85 -0.15 0.3 0.4' width='900' height='1200'><rect x='2.85' y='-0.15' width='0.3' height='0.4' fill='white'/>");
        for q in &ps {
            if let Primitive::Polygon { pts, stroke, hatch, .. } = q {
                if stroke == "none" {
                    let c = if hatch.pattern == HatchPattern::None { "#cfe3ff" } else { "#eeeeee" };
                    let d: Vec<String> = pts.iter().map(|v| format!("{},{}", v.x, v.y)).collect();
                    s += &format!("<polygon points='{}' fill='{c}'/>", d.join(" "));
                }
            }
        }
        for (a, b) in drawn(&ps) {
            s += &format!("<line x1='{}' y1='{}' x2='{}' y2='{}' stroke='black' stroke-width='0.0015'/>", a.x, a.y, b.x, b.y);
        }
        s += "</svg>";
        std::fs::write(format!("{dir}/t_stoss_{name}.svg"), s).unwrap();
    }
}
