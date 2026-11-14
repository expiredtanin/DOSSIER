//! [198] Gleiche Schichten benachbarter Wände verschmelzen: am T-Stoss, an Ecken und Kreuzungen liegt
//! zwischen zwei Flächen gleichen Stils (Innenputz an Innenputz, Dämmung an Dämmung) keine Linie mehr;
//! am Materialwechsel (andere Schraffur, andere Schicht) bleibt sie.

use super::prim::{HatchRender, Primitive};
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

/// Sichtbare Schichtflächen (gefüllte Bänder ohne Strich; Vereinigungen tragen keine Wand-Id): Index, Punkte,
/// Stil-Schlüssel ohne Ausrichtung/Ursprung, Besitzer (Wand bzw. `u<Index>` für eine Vereinigung).
type Vis<'a> = (usize, &'a Vec<Vec2>, String, String);

fn visible(ps: &[Primitive]) -> Vec<Vis<'_>> {
    ps.iter()
        .enumerate()
        .filter_map(|(i, q)| match q {
            Primitive::Polygon { pts, fill, stroke, hatch, greyed, wall_id, opening_id: None, .. } if stroke == "none" && fill != "none" => {
                let h = HatchRender { angle: 0.0, origin: None, polar: None, ..(**hatch).clone() };
                Some((i, pts, style_key(fill, *greyed, &h), wall_id.clone().unwrap_or_else(|| format!("u{i}"))))
            }
            _ => None,
        })
        .collect()
}

fn inside(poly: &[Vec2], p: Vec2) -> bool {
    let n = poly.len();
    let mut c = false;
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        if (a.y > p.y) != (b.y > p.y) && p.x < a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x) {
            c = !c;
        }
    }
    c
}

/// Oberste sichtbare Fläche an `p` (zuletzt gezeichnet).
fn top_at<'a, 'b>(vs: &'b [Vis<'a>], p: Vec2) -> Option<&'b Vis<'a>> {
    vs.iter().filter(|v| inside(v.1, p)).max_by_key(|v| v.0)
}

/// Beide Punkte zeigen dieselbe sichtbare Fläche (eine vereinigte Fläche, eine Schraffur).
fn same_face(ps: &[Primitive], a: (f64, f64), b: (f64, f64)) -> bool {
    let vs = visible(ps);
    match (top_at(&vs, Vec2 { x: a.0, y: a.1 }), top_at(&vs, Vec2 { x: b.0, y: b.1 })) {
        (Some(x), Some(y)) => x.0 == y.0,
        _ => false,
    }
}

/// Gezeichnete Strecken, deren beide Seiten (oberste sichtbare Fläche) gleichen Stil zeigen: dieselbe Fläche
/// (Linie quer durch eine vereinigte Fläche) oder Flächen verschiedener Wände.
fn visible_seams(ps: &[Primitive]) -> Vec<(Vec2, Vec2)> {
    let vs = visible(ps);
    let d = 1e-3;
    drawn(ps)
        .into_iter()
        .filter(|(a, b)| {
            let len = (b.x - a.x).hypot(b.y - a.y);
            let n = Vec2 { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
            let steps = (len / 2.5e-3).ceil().max(1.0) as usize;
            (0..steps).any(|i| {
                let t = (i as f64 + 0.5) / steps as f64;
                let m = Vec2 { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
                let side = |s: f64| top_at(&vs, Vec2 { x: m.x + n.x * s * d, y: m.y + n.y * s * d });
                match (side(1.0), side(-1.0)) {
                    (Some(l), Some(r)) => l.2 == r.2 && (l.0 == r.0 || l.3 != r.3),
                    _ => false,
                }
            })
        })
        .collect()
}

/// Gleiche sichtbare Flächen überlappen nicht (Schraffur nur einmal): Summe der Flächen je Stil − Fläche der Vereinigung.
fn same_style_overlap(ps: &[Primitive]) -> f64 {
    let vs = visible(ps);
    let mut keys: Vec<&String> = vs.iter().map(|v| &v.2).collect();
    keys.sort();
    keys.dedup();
    keys.iter().map(|k| overlap(&vs.iter().filter(|v| &v.2 == *k).map(|v| v.1.clone()).collect::<Vec<_>>()).0).sum()
}

/// [198] T-Stoss: der Innenputz beider Wände ist EINE Fläche (Vereinigung, eine Schraffur), ohne Linie dazwischen;
/// die Wände bleiben über ihre (unsichtbaren) Pick-Flächen einzeln wählbar.
#[test]
fn t_stoss_putz_eine_flaeche() {
    let mut p = base();
    add_wall(&mut p, "iw", (0.0, 0.0), (6.0, 0.0));
    add_wall(&mut p, "iw", (3.0, 0.0), (3.0, 3.0));
    let ps = prims(&p);
    // Der Abzweig-Putz läuft bis an den Backstein der Durchgangswand und schliesst links bzw. rechts an deren Putz an.
    assert!(same_face(&ps, (1.0, 0.0675), (2.9325, 1.5)), "Putz links: Durchgangswand und Abzweig getrennt");
    assert!(same_face(&ps, (5.0, 0.0675), (3.0675, 1.5)), "Putz rechts getrennt");
    // Backstein und Putz bleiben verschiedene Flächen.
    assert!(!same_face(&ps, (1.0, 0.0), (1.0, 0.0675)));
    assert!(visible_seams(&ps).is_empty(), "Linien in gleichen Flächen: {:?}", visible_seams(&ps));
    assert!(same_style_overlap(&ps) < 1e-9);
    // Pick-Flächen je Wand (Wand-Id, ohne Füllung) bleiben.
    for id in ["W1", "W2"] {
        assert!(ps.iter().any(|q| matches!(q, Primitive::Polygon { wall_id: Some(w), fill, .. } if w == id && fill == "none")), "Pick-Fläche {id}");
    }
}

/// [198] L-Ecke und Kreuzung: Backstein bzw. Putz beider Wände eine Fläche, keine Linie darin.
#[test]
fn ecke_und_kreuzung_eine_flaeche() {
    let mut p = base();
    add_wall(&mut p, "iw", (0.0, 0.0), (3.0, 0.0));
    add_wall(&mut p, "iw", (3.0, 0.0), (3.0, 3.0));
    let ps = prims(&p);
    assert!(same_face(&ps, (1.0, 0.0), (3.0, 1.0)), "Ecke: Backstein getrennt");
    assert!(visible_seams(&ps).is_empty(), "{:?}", visible_seams(&ps));

    let mut p = base();
    add_wall(&mut p, "iw", (0.0, 0.0), (6.0, 0.0));
    add_wall(&mut p, "iw", (3.0, -3.0), (3.0, 0.0));
    add_wall(&mut p, "iw", (3.0, 0.0), (3.0, 3.0));
    let ps = prims(&p);
    assert!(same_face(&ps, (2.9325, 1.5), (1.0, 0.0675)), "Kreuzung: Putz getrennt");
    assert!(visible_seams(&ps).is_empty(), "{:?}", visible_seams(&ps));
    assert!(same_style_overlap(&ps) < 1e-9);
}

/// [198] Mischmaterial: Putz mit anderer Schraffur wird nicht mit dem Putz ohne Muster vereinigt, die Linie bleibt.
#[test]
fn mischmaterial_bleibt_getrennt() {
    let mut p = base();
    p.components.push(Component { id: "render-x".into(), join_priority: 10.0, hatch_id: "diag".into(), ..Default::default() });
    let layer = |c: &str, t: f64| Layer { component_id: c.into(), thickness: t, ..Default::default() };
    p.wall_types.push(WallType { id: "ix".into(), layers: vec![layer("render-x", 0.015), layer("brick", 0.12), layer("render-x", 0.015)], ..Default::default() });
    add_wall(&mut p, "iw", (0.0, 0.0), (6.0, 0.0));
    add_wall(&mut p, "ix", (3.0, 0.0), (3.0, 3.0));
    let ps = prims(&p);
    assert!(!same_face(&ps, (1.0, 0.0675), (3.0675, 1.5)));
    let stub = |a: Vec2, b: Vec2| near(a.y, 0.075) && near(b.y, 0.075) && a.x.min(b.x) < 3.07 && a.x.max(b.x) > 3.065;
    assert!(has_segment(&ps, stub), "Linie am Materialwechsel fehlt");
}

/// [198] Durchlaufende, nicht verbundene Wände (Überlappung): gleicher Stoff einmal gefüllt und schraffiert,
/// keine Wandlinie quer durch die gemeinsame Fläche.
#[test]
fn ueberlappung_einmal_schraffiert() {
    let mut p = base();
    add_wall(&mut p, "bw", (0.0, 0.0), (6.0, 0.0));
    add_wall(&mut p, "bw", (3.0, -3.0), (3.0, 3.0));
    let ps = prims(&p);
    assert!(same_face(&ps, (1.0, 0.0), (3.0, 2.0)), "Beton getrennt");
    assert!(same_style_overlap(&ps) < 1e-9, "doppelt schraffiert: {}", same_style_overlap(&ps));
    assert!(visible_seams(&ps).is_empty(), "{:?}", visible_seams(&ps));
}

/// [198]/[190] Bogenwand an gerader Wand (verbundene Enden): Schichten ohne Muster (Putz) werden eine Fläche;
/// schraffierte Schichten bleiben getrennt — die Bogenwand schraffiert polar (folgt der Krümmung), die gerade
/// Wand parallel: eine gemeinsame Schraffur gäbe es nur mit der Richtung einer der beiden (offen).
#[test]
fn bogenwand_an_gerader_wand() {
    let mut p = base();
    add_wall(&mut p, "iw", (-3.0, 0.0), (3.0, 0.0));
    add_arc_deg(&mut p, "iw", (3.0, 2.0), 2.0, -90.0, 0.0);
    let ps = prims(&p);
    let putz = polar((3.0, 2.0), 1.9325, -45.0);
    assert!(same_face(&ps, (1.0, 0.0675), putz), "Putz Bogen/Gerade getrennt");
    assert!(!same_face(&ps, (1.0, 0.0), polar((3.0, 2.0), 2.0, -45.0)), "Backstein: polare und gerade Schraffur vereinigt");
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
