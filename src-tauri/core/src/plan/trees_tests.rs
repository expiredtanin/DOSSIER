//! [149]/[271] Bäume in Schnitt und Ansicht werden von näheren Bauteilen verdeckt.

use super::*;
use crate::plan::section::Occluder;
use serde_json::{json, Value};

fn sample() -> Project {
    serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
}

/// Beispielhaus (x 0…5, y 0…4, zwei Geschosse) mit Bäumen: Schnitt A liegt bei y = 2 und blickt nach +y, Ansicht Süd bei
/// y = −2 und blickt nach +y.
fn with_trees(trees: Value) -> Project {
    let mut p = sample();
    p.trees = serde_json::from_value(trees).unwrap();
    p
}

fn tree_at(id: &str, x: f64, y: f64) -> Value {
    json!({"id": id, "type": "tree", "floorId": "eg", "categoryCode": "13", "position": {"x": x, "y": y},
        "trunkDiameter": 0.4, "crownDiameter": 6, "crownBase": 3, "height": 12, "shape": "round", "status": "existing", "foliage": "deciduous"})
}

fn section(p: &Project) -> Vec<Primitive> {
    section_at(p, 200.0)
}

fn section_at(p: &Project, scale: f64) -> Vec<Primitive> {
    let level = p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap();
    let v = json!({"level": level, "scale": scale, "detail": "mittel"});
    let buf = crate::queries::run_bin(p, "sectionPlan", &[0.0, 1.0, 0.0], &v.to_string()).unwrap();
    crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default()
}

fn elevation(p: &Project) -> Vec<Primitive> {
    let level = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let buf = crate::queries::run_bin(p, "elevationPlan", &[0.0, 0.0, 100.0], &json!({"level": level}).to_string()).unwrap();
    crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default()
}

/// Sichtbare Strecken des Baums `id` (Linien der Teile und Umrisse von Polygonen mit Strich), ohne Schnittflächen.
fn tree_segments(prims: &[Primitive], id: &str) -> Vec<(Vec2, Vec2)> {
    let pick = pick_id(id);
    let mut out = Vec::new();
    for q in prims {
        match q {
            Primitive::Line { a, b, cls, .. } if &**cls == "tree-view" => out.push((*a, *b)),
            Primitive::Polygon { pts, stroke, fill, context_object_id: Some(c), .. } if *c == pick && stroke != "none" && fill == "none" => {
                out.extend((0..pts.len()).map(|i| (pts[i], pts[(i + 1) % pts.len()])));
            }
            _ => {}
        }
    }
    out
}

fn bounds(segs: &[(Vec2, Vec2)]) -> [f64; 4] {
    segs.iter().flat_map(|(a, b)| [*a, *b]).fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q.x), b[1].min(q.y), b[2].max(q.x), b[3].max(q.y)])
}

/// Baum 8 m hinter dem Haus: ohne Verdeckung stünde seine Krone (Mitte x 2.5, Höhe 3…12) quer durchs Haus; mit ihr
/// bleibt nur, was über Dach und Wand hinausragt. Der Stamm (Höhe 0…3) liegt ganz hinter dem Haus.
#[test]
fn baum_hinter_dem_haus_im_schnitt_verdeckt() {
    let free = with_trees(json!([tree_at("frei", 20.0, 10.0)]));
    let hidden = with_trees(json!([tree_at("hinten", 2.5, 10.0)]));
    let all = tree_segments(&section(&free), "frei");
    assert!(all.len() > 20, "frei stehender Baum: ganze Silhouette");
    let segs = tree_segments(&section(&hidden), "hinten");
    assert!(!segs.is_empty(), "über das Haus hinaus bleibt die Krone sichtbar");
    // Kein Strich im Bereich des Hauses unterhalb der Wandkrone.
    let wall_top = 2.6 + 2.6;
    let low: Vec<_> = segs.iter().filter(|(a, b)| (a.x + b.x) / 2.0 > -0.5 && (a.x + b.x) / 2.0 < 5.5 && (a.y + b.y) / 2.0 < wall_top - 0.3).collect();
    assert!(low.is_empty(), "Krone und Stamm hinter Wänden und Decken verdeckt: {low:?}");
    // Der Stamm (Breite 0.4 bei x 2.5) liegt hinter dem Haus: kein Stammrand.
    assert!(!segs.iter().any(|(a, b)| a.y < 2.0 && b.y < 2.0 && a.x > 2.2 && a.x < 2.8), "Stamm verdeckt");
    // Sichtbar ist weniger als die freie Silhouette, die Spitze der Krone aber bleibt.
    let (bb, ba) = (bounds(&segs), bounds(&all));
    assert!(bb[3] - bb[1] < ba[3] - ba[1] - 1.0 && bb[3] > 11.0, "{bb:?} {ba:?}");
    // Die Pick-Fläche bleibt erhalten.
    assert!(section(&hidden).iter().any(|q| matches!(q, Primitive::Polygon { context_object_id: Some(c), stroke, .. } if *c == pick_id("hinten") && stroke == "none")));
}

/// Baum auf der Betrachterseite (y = −5 gegen Blickrichtung +y): im Schnitt gar nicht gezeichnet; ein Baum, dessen
/// Krone die Ebene trifft, erscheint als Querschnitt.
#[test]
fn baum_vor_der_schnittebene_fehlt() {
    let p = with_trees(json!([tree_at("vorn", 2.5, -5.0), tree_at("ein", 2.5, 1.0)]));
    let prims = section(&p);
    assert!(tree_segments(&prims, "vorn").is_empty());
    assert!(!prims.iter().any(|q| matches!(q, Primitive::Polygon { context_object_id: Some(c), .. } if *c == pick_id("vorn"))));
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { context_object_id: Some(c), stroke_width_mm, .. } if *c == pick_id("ein") && *stroke_width_mm > 0.0)));
}

/// Der Schnitt des Baums selbst (Krone/Stamm in der Ebene) bleibt, ebenso die ganze Silhouette dahinter, wo nichts
/// davor liegt (Baum neben dem Haus).
#[test]
fn baum_in_der_ebene_wird_geschnitten() {
    let p = with_trees(json!([tree_at("neben", 12.0, 2.0)]));
    let prims = section(&p);
    let cut = prims.iter().filter(|q| matches!(q, Primitive::Polygon { context_object_id: Some(c), stroke_width_mm, .. } if *c == pick_id("neben") && *stroke_width_mm > 0.3)).count();
    assert_eq!(cut, 2, "Kronen- und Stammquerschnitt");
    assert!(tree_segments(&prims, "neben").len() > 20, "Silhouette dahinter bleibt");
}

/// Direkt: Verdecker davor schneiden Linien und Umrisse, Verdecker dahinter nicht; Unsinn lässt alles stehen.
#[test]
fn occlude_in_section_einzeln() {
    let quad = |x0: f64, y0: f64, x1: f64, y1: f64| vec![v(x0, y0), v(x1, y0), v(x1, y1), v(x0, y1)];
    let tree = |d: f64| vec![(d, vec![poly(quad(0.0, 0.0, 4.0, 4.0), "none", "#000", 0.2, Some(pick_id("t")), None), line(v(-1.0, 1.0), v(5.0, 1.0), "tree-view", 0.2, "#000", None, None)])];
    let wall = |depth: f64| vec![Occluder { depth, pts: vec![[1.0, -1.0], [3.0, -1.0], [3.0, 2.0], [1.0, 2.0]] }];
    let n_lines = |prims: &[Primitive]| prims.iter().filter(|q| matches!(q, Primitive::Line { .. })).count();
    // Wand (Tiefe 1) vor dem Baum (Tiefe 5): die Linie bei y = 1 zerfällt in links und rechts.
    let out = occlude_in_section(tree(5.0), &wall(1.0));
    let ls: Vec<_> = out.iter().filter_map(|q| if let Primitive::Line { a, b, .. } = q { Some((a.x, b.x)) } else { None }).collect();
    assert!(ls.iter().any(|&(a, b)| a == -1.0 && (b - 1.0).abs() < 1e-9) && ls.iter().any(|&(a, b)| (a - 3.0).abs() < 1e-9 && b == 5.0), "{ls:?}");
    assert!(out.iter().any(|q| matches!(q, Primitive::Polygon { stroke, context_object_id: Some(_), .. } if stroke == "none")), "Pick bleibt");
    assert!(n_lines(&out) > 3);
    // Wand hinter dem Baum: unverändert.
    let out = occlude_in_section(tree(5.0), &wall(9.0));
    assert!(matches!(&out[0], Primitive::Polygon { stroke, .. } if stroke == "#000") && n_lines(&out) == 1);
    // Ohne Verdecker, mit NaN im Baum oder im Verdecker: nichts geht verloren, kein Panic.
    assert_eq!(occlude_in_section(tree(5.0), &[]).len(), 2);
    let mut nan = tree(5.0);
    nan[0].1.push(line(v(f64::NAN, 0.0), v(1.0, 1.0), "tree-view", 0.2, "#000", None, None));
    assert!(occlude_in_section(nan, &wall(1.0)).len() >= 3);
    let bad = vec![Occluder { depth: f64::NAN, pts: vec![[f64::NAN, 0.0], [1.0, 1.0], [2.0, 0.0]] }];
    assert_eq!(occlude_in_section(tree(f64::NAN), &bad).len(), 2);
}

/// Ansicht Süd: ein Baum hinter dem Haus (y = 10) wird vom Haus verdeckt (liegt im Zeichenstapel darunter); ein Baum vor
/// der Fassade (y = −4) liegt darüber, seine Krone ohne Deckfüllung, damit die Fassade sichtbar bleibt.
#[test]
fn ansicht_baeume_vor_und_hinter_dem_haus() {
    let p = with_trees(json!([tree_at("hinten", 2.5, 10.0), tree_at("vorn", 2.5, -4.0)]));
    let prims = elevation(&p);
    let find = |id: &str| prims.iter().position(|q| matches!(q, Primitive::Polygon { context_object_id: Some(c), pts, .. } if *c == pick_id(id) && pts.len() > 4));
    let (h, v_) = (find("hinten"), find("vorn"));
    assert!(h.is_some() && v_.is_some());
    let wall = |q: &Primitive| matches!(q, Primitive::Polygon { wall_id: Some(_), .. });
    let last_wall = prims.iter().rposition(wall).unwrap();
    let first_wall = prims.iter().position(wall).unwrap();
    assert!(h.unwrap() < first_wall, "Baum hinten wird unter der Fassade gezeichnet");
    assert!(v_.unwrap() > last_wall, "Baum vorn über der Fassade");
    assert!(matches!(&prims[v_.unwrap()], Primitive::Polygon { fill, .. } if fill == "none"), "{:?}", &prims[v_.unwrap()]);
}

fn person_at(id: &str, x: f64, y: f64) -> Drawing2D {
    serde_json::from_value(json!({"id": id, "type": "drawing2d", "levelId": "eg", "categoryCode": "24", "geom": {"shape": "libobj", "libId": "lib:person-stehend", "at": {"x": x, "y": y}, "rotation": 0.0}})).unwrap()
}

/// Polygone der Entourage (Zeichnung `id`) in den Primitiven: (gefüllt?, Ausmass).
fn entourage_polys(prims: &[Primitive], id: &str) -> Vec<(bool, [f64; 4])> {
    prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Polygon { pts, fill, drawing_id: Some(d), .. } if d == id && !pts.is_empty() => Some((fill != "none", bounds(&pts.iter().map(|p| (*p, *p)).collect::<Vec<_>>()))),
            _ => None,
        })
        .collect()
}

/// [253] Ansicht: Person vor der Fassade zeichnet als gefüllte Silhouetten ihrer Teile (Pick = Zeichnung, 1.75 m hoch,
/// über der Fassade gemalt); eine Person hinter dem Haus wird unter der Fassade gemalt.
#[test]
fn entourage_in_der_ansicht() {
    let mut p = sample();
    p.drawings2d.push(person_at("vorn", 2.5, -1.0));
    p.drawings2d.push(person_at("hinten", 2.5, 10.0));
    let prims = elevation(&p);
    let vorn = entourage_polys(&prims, "vorn");
    assert!(vorn.len() >= 5 && vorn.iter().all(|(f, _)| *f), "{vorn:?}");
    let b = vorn.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, (_, q)| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[2]), b[3].max(q[3])]);
    assert!((b[3] - b[1] - 1.75).abs() < 0.02 && b[2] - b[0] < 1.0, "{b:?}");
    let wall = |q: &Primitive| matches!(q, Primitive::Polygon { wall_id: Some(_), .. });
    let own = |id: &'static str| move |q: &Primitive| matches!(q, Primitive::Polygon { drawing_id: Some(d), .. } if d == id);
    assert!(prims.iter().position(own("vorn")).unwrap() > prims.iter().rposition(wall).unwrap(), "vorn über der Fassade");
    assert!(prims.iter().position(own("hinten")).unwrap() < prims.iter().position(wall).unwrap(), "hinten unter der Fassade");
}

/// [253] Schnitt: Person hinter der Ebene als Umriss (ungefüllt); vor der Ebene entfällt sie; hinter dem Haus bleibt die
/// Pick-Fläche; die Klasse schaltet sie ab.
#[test]
fn entourage_im_schnitt() {
    let mut p = sample();
    p.drawings2d.push(person_at("frei", 20.0, 10.0));
    p.drawings2d.push(person_at("vorn", 20.0, -5.0));
    let prims = section(&p);
    let frei = entourage_polys(&prims, "frei");
    assert!(frei.len() >= 5 && frei.iter().all(|(f, _)| !*f), "{frei:?}");
    assert!(entourage_polys(&prims, "vorn").is_empty(), "vor der Ebene fehlt sie");
    p.drawings2d.push(person_at("haus", 2.5, 3.0));
    assert!(!entourage_polys(&section(&p), "haus").is_empty(), "Pick-Fläche bleibt");
    let level = p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap();
    let v = json!({"level": level, "scale": 200, "detail": "mittel", "hasVis": true, "invisible": ["24"]});
    let buf = crate::queries::run_bin(&p, "sectionPlan", &[0.0, 1.0, 0.0], &v.to_string()).unwrap();
    let off = crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default();
    assert!(entourage_polys(&off, "frei").is_empty(), "Klasse aus");
}

fn chair_at(id: &str, x: f64, y: f64) -> Drawing2D {
    serde_json::from_value(json!({"id": id, "type": "drawing2d", "levelId": "eg", "categoryCode": "24", "geom": {"shape": "libobj", "libId": "lib:stuhl", "at": {"x": x, "y": y}, "rotation": 0.0}})).unwrap()
}

/// Linien im Rechteck `b` = [x0, y0, x1, y1] (beide Endpunkte, mit Toleranz).
fn lines_in(prims: &[Primitive], b: [f64; 4]) -> Vec<(f64, f64)> {
    let inside = |p: &Vec2| p.x >= b[0] - 1e-6 && p.x <= b[2] + 1e-6 && p.y >= b[1] - 1e-6 && p.y <= b[3] + 1e-6;
    prims.iter().filter_map(|q| match q { Primitive::Line { a, b: e, weight_mm, .. } if inside(a) && inside(e) => Some((*weight_mm, a.x)), _ => None }).collect()
}

/// [311] Schnitt 1:100: Möbel hinter der Ebene zeigen ihre Ansichtskanten aus dem 3D-Netz (mehr als die vier Kanten der Hülle,
/// alle innerhalb der Hülle) statt eines Umrisses; ab 1:200 bleibt der Umriss; die Klasse schaltet die Kanten ab.
#[test]
fn entourage_im_schnitt_ansichtskanten() {
    let mut p = sample();
    p.drawings2d.push(chair_at("stuhl", 20.0, 10.0));
    let hull = {
        let polys = entourage_polys(&section(&p), "stuhl");
        assert!(!polys.is_empty(), "1:200: Umriss");
        polys.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, (_, q)| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[2]), b[3].max(q[3])])
    };
    let prims = section_at(&p, 100.0);
    assert!(entourage_polys(&prims, "stuhl").is_empty(), "keine Umriss-Polygone mehr");
    let l = lines_in(&prims, hull);
    assert!(l.len() > 8, "Ansichtskanten des Stuhls: {}", l.len());
    // Mindestens ein Stück der Hülle ist leer (Sitzfläche/Lehne), die Kanten füllen die Hülle nicht nur am Rand.
    let (xmin, xmax) = (hull[0], hull[2]);
    assert!(l.iter().any(|&(_, x)| x > xmin + 0.05 * (xmax - xmin) && x < xmax - 0.05 * (xmax - xmin)), "Kanten im Inneren der Hülle");
    // Ansichtskanten fein (nicht die Schnittstärke).
    assert!(l.iter().all(|&(w, _)| w <= 0.2 + 1e-9), "{l:?}");
    // 1:200 und gröber: keine Kantenpracht.
    assert!(lines_in(&section_at(&p, 200.0), hull).len() < 3);
    // Klasse aus: nichts.
    let level = p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap();
    let v = json!({"level": level, "scale": 100, "detail": "mittel", "hasVis": true, "invisible": ["24"]});
    let buf = crate::queries::run_bin(&p, "sectionPlan", &[0.0, 1.0, 0.0], &v.to_string()).unwrap();
    let off = crate::plan::buf::View::parse(&buf).and_then(|v| v.prims()).unwrap_or_default();
    assert!(lines_in(&off, hull).is_empty(), "Klasse aus");
}

/// [311] Ein geschnittener Stuhl (Ebene y = 2, Stuhl bei y = 2.1): nur Umriss in Schnittstärke, keine Fläche mit Füllung oder Schraffur.
#[test]
fn entourage_geschnitten_nur_umriss() {
    let mut p = sample();
    p.drawings2d.push(chair_at("stuhl", 20.0, 2.1));
    let hull = entourage_polys(&section(&p), "stuhl").iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, (_, q)| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[2]), b[3].max(q[3])]);
    assert!(hull[0].is_finite());
    let prims = section_at(&p, 100.0);
    let l = lines_in(&prims, hull);
    let heavy = l.iter().filter(|&&(w, _)| w >= 0.25 - 1e-9).count();
    assert!(heavy >= 3, "Schnittumriss: {l:?}");
    assert!(l.len() > heavy, "dazu feine Ansichtskanten dahinter");
    let inside = |q: &Primitive| matches!(q, Primitive::Polygon { pts, .. } if !pts.is_empty() && pts.iter().all(|p| p.x >= hull[0] - 1e-6 && p.x <= hull[2] + 1e-6 && p.y >= hull[1] - 1e-6 && p.y <= hull[3] + 1e-6));
    assert!(!prims.iter().any(inside), "keine Fläche");
}
