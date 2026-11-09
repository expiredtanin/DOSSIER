//! [166] Richtung der Dämm-Strichschraffur („Dämmstoffe (SIA-Linien)", EPS/XPS): die Striche stehen
//! immer quer (90°) zur Schicht — im Grundriss zur lokalen Wandachse (gerade Wand beliebig gedreht,
//! Bogenwand radial, Ecke/Gehrung, Y, T, kollinear, Wand an/durch Stütze), im Schnitt zur Schicht
//! (Wand senkrecht, Decke waagrecht, Dach geneigt). Geprüft werden die tatsächlich gezeichneten
//! Schraffurlinien aller drei Ausgaben des Plan-Puffers: render2d-Szene (Bildschirm und PDF-Export
//! `sceneToPrintSvg`), CLI-SVG (`plan/svg.rs`) und Druck-SVG der Layout-Blätter (`plan/print_svg.rs`).
//! Vorher lief die Schaar je nach Ausgabe längs oder quer: die Szene (Kern-Generator wie die SVG-
//! `<pattern>`-Kachel: Winkel 0 = Linie senkrecht) und die beiden SVG-Ausgaben (eigene Linienschar:
//! Winkel 0 = Linie waagrecht) lasen den Schraffur-Winkel um 90° verschieden.

use super::buf::{View, Writer};
use super::domains::{plan_domains, PlanArgs};
use super::parts::Part;
use super::prim::Primitive;
use super::wall_join_tests::{add_arc_deg, add_column, add_wall, polar};
use crate::hatch::V2;
use crate::model::*;

/// Schraffur der harten Dämmung genau wie in den Standards.
const EPS_HATCH: &str = "std-h-daemmstoffe-sia";

fn layer(c: &str, t: f64) -> Layer {
    Layer { component_id: c.into(), thickness: t, ..Default::default() }
}

/// Testprojekt: nur die Dämmschicht schraffiert (Standard-Schraffur), alle anderen Schichten leer.
/// Wandtypen `aw` (Putz/EPS/Backstein/Putz), `dw` (symmetrisch Putz/EPS/Putz), `bw` (Beton).
fn base() -> Project {
    let mut p = Project::default();
    let std_h = crate::standards::hatches().into_iter().find(|h| h["id"] == EPS_HATCH).expect("Standard-Schraffur");
    p.hatches.push(serde_json::from_value(std_h).unwrap());
    p.hatches.push(serde_json::from_value(serde_json::json!({"id": "none", "name": "none", "pattern": "none", "scale": 1, "angle": 0, "color": "#1a1a1a"})).unwrap());
    for (id, prio, hatch) in [("render", 10.0, "none"), ("eps", 20.0, EPS_HATCH), ("brick", 50.0, "none"), ("concrete", 100.0, "none")] {
        p.components.push(Component { id: id.into(), join_priority: prio, hatch_id: hatch.into(), ..Default::default() });
    }
    p.wall_types.push(WallType { id: "aw".into(), layers: vec![layer("render", 0.02), layer("eps", 0.16), layer("brick", 0.15), layer("render", 0.015)], ..Default::default() });
    p.wall_types.push(WallType { id: "dw".into(), layers: vec![layer("render", 0.015), layer("eps", 0.12), layer("render", 0.015)], ..Default::default() });
    p.wall_types.push(WallType { id: "bw".into(), layers: vec![layer("concrete", 0.2)], ..Default::default() });
    p.drawing_levels.push(DrawingLevel { id: "eg".into(), kind: DrawingLevelKind::Floor, floor_height: Some(2.6), ..Default::default() });
    p
}

/// Richtung (Einheitsvektor) der lokalen Schichtachse am Punkt `m` eines Bandes.
type Axis = Box<dyn Fn(V2) -> V2>;

/// Gezeichneter Lauf (Linie/Polylinie) in Modell-Metern.
type Seg = Vec<V2>;

fn unit(x: f64, y: f64) -> V2 {
    let l = x.hypot(y);
    V2 { x: x / l, y: y / l }
}

fn wall_axis(w: &Wall) -> Axis {
    match crate::wall_arc::WallArc::of_wall(w) {
        // Bogen: Tangente = senkrecht zum Radius.
        Some(a) => {
            let c = a.center;
            Box::new(move |m: V2| unit(-(m.y - c.y), m.x - c.x))
        }
        None => {
            let u = unit(w.end.x - w.start.x, w.end.y - w.start.y);
            Box::new(move |_| u)
        }
    }
}

fn inside(pts: &[V2], q: V2) -> bool {
    let n = pts.len();
    let mut c = false;
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (pts[i], pts[j]);
        if (a.y > q.y) != (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x {
            c = !c;
        }
        j = i;
    }
    c
}

fn edge_dist(pts: &[V2], q: V2) -> f64 {
    let n = pts.len();
    (0..n)
        .map(|i| {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let l2 = dx * dx + dy * dy;
            let t = if l2 > 0.0 { (((q.x - a.x) * dx + (q.y - a.y) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
            (q.x - a.x - t * dx).hypot(q.y - a.y - t * dy)
        })
        .fold(f64::INFINITY, f64::min)
}

/// Prüft jede Linie, die in einem gestrichelten Band liegt: Winkel zur lokalen Achse = 90° ± 1°.
/// Jedes Band muss mindestens eine geprüfte Linie haben (sonst fehlt die Schraffur).
fn check(bands: &[(Vec<V2>, Axis)], runs: &[Seg], what: &str) {
    let mut hits = vec![0usize; bands.len()];
    // Je Teilstrecke: Umrisse (auch als Polylinie) liegen auf dem Bandrand und fallen weg.
    for (a, b) in runs.iter().flat_map(|r| r.windows(2).map(|w| (w[0], w[1]))) {
        let len = (b.x - a.x).hypot(b.y - a.y);
        // Sehr kurze Stücke (Spitze einer Gehrung) tragen Rundungsfehler der Ausgabe (0.001 mm).
        if len < 0.02 {
            continue;
        }
        let m = V2 { x: (a.x + b.x) / 2.0, y: (a.y + b.y) / 2.0 };
        let mut ks = (0..bands.len()).filter(|&j| inside(&bands[j].0, m));
        // Genau ein Band (überlappende Bänder, z. B. Decke über dem Wandkopf im Schnitt, sind mehrdeutig).
        let (Some(k), None) = (ks.next(), ks.next()) else { continue };
        if edge_dist(&bands[k].0, m) <= 2e-3 {
            continue;
        }
        let u = (bands[k].1)(m);
        let d = unit(b.x - a.x, b.y - a.y);
        let cos = (d.x * u.x + d.y * u.y).abs();
        let deg = cos.clamp(0.0, 1.0).acos().to_degrees();
        assert!((deg - 90.0).abs() <= 1.0, "{what}: Dämm-Strich {deg:.2}° zur Schichtachse statt 90° (Linie {a:?} → {b:?})");
        hits[k] += 1;
    }
    for (k, h) in hits.iter().enumerate() {
        // Schmale Restflächen (unter 2 cm, z. B. ein Schichtrest neben der Decke) tragen nur zu kurze Striche.
        let pts = &bands[k].0;
        let n = pts.len();
        let area = (0..n).map(|i| pts[i].x * pts[(i + 1) % n].y - pts[(i + 1) % n].x * pts[i].y).sum::<f64>().abs() / 2.0;
        let perim: f64 = (0..n).map(|i| (pts[(i + 1) % n].x - pts[i].x).hypot(pts[(i + 1) % n].y - pts[i].y)).sum();
        if 2.0 * area / perim < 0.02 {
            continue;
        }
        assert!(*h > 0, "{what}: Band {k} ohne geprüfte Schraffurlinie ({:?}…)", bands[k].0.first());
    }
}

/// Die drei Ausgaben eines Plan-Puffers: Linien der Szene, des CLI-SVG und des Druck-SVG.
fn rendered(prims: &[Primitive], scale: f64) -> Vec<(&'static str, Vec<Seg>)> {
    let mut w = Writer::new(true);
    w.group(prims);
    let bytes = w.finish();
    let parts = || {
        let view = View::parse(&bytes).unwrap();
        let n = view.len();
        vec![Part::new(view, 0, n).unwrap()]
    };
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for q in prims {
        if let Primitive::Polygon { pts, .. } = q {
            for p in pts {
                (x0, y0, x1, y1) = (x0.min(p.x), y0.min(p.y), x1.max(p.x), y1.max(p.y));
            }
        }
    }
    // render2d-Szene: Schraffurläufe als Polylinien.
    let scene = super::scene::build_scene(&mut parts(), &[]).unwrap();
    let s: Vec<Seg> = scene.polylines.iter().map(|r| r.pts.clone()).collect();
    // CLI-SVG: y gespiegelt (`top − y`).
    let o = super::svg::SvgOptions { scale_denominator: scale, margin_m: 0.0, min_x: x0, min_y: y0, max_x: x1, max_y: y1, hatch: true, line_ends: Default::default() };
    let svg = super::svg::plan_svg(&mut parts(), &o).unwrap();
    let attr = |l: &str, k: &str| -> Option<String> { l.split(&format!(" {k}=\"")).nth(1).and_then(|r| r.split('"').next()).map(String::from) };
    let pts_of = |s: &str| -> Vec<(f64, f64)> {
        s.split(' ').filter_map(|q| q.split_once(',')).map(|(a, b)| (a.parse().unwrap(), b.parse().unwrap())).collect()
    };
    let mut v: Vec<Seg> = Vec::new();
    let from_svg = |x: f64, y: f64| V2 { x, y: y1 - y };
    for l in svg.lines() {
        if l.starts_with("<line") {
            let n = |k| attr(l, k).unwrap().parse::<f64>().unwrap();
            v.push(vec![from_svg(n("x1"), n("y1")), from_svg(n("x2"), n("y2"))]);
        } else if l.starts_with("<polyline") {
            v.push(pts_of(&attr(l, "points").unwrap()).into_iter().map(|(x, y)| from_svg(x, y)).collect());
        }
    }
    // Druck-SVG (Papier-mm, y nach unten, Blatt = Ausmass): Anweisungen `E`, Ebene, Tag, Name/Wert….
    let k = 1000.0 / scale;
    let po = super::print_svg::PrintOptions { scale_denominator: scale, page_w: (x1 - x0) * k, page_h: (y1 - y0) * k, bounds: [x0, y0, x1, y1] };
    let ops = super::print_svg::print_svg_ops(&mut parts(), &po).unwrap();
    let from_paper = |x: f64, y: f64| V2 { x: x0 + x / k, y: y1 - y / k };
    let mut pr: Vec<Seg> = Vec::new();
    for rec in ops.split('\u{1e}') {
        let f: Vec<&str> = rec.split('\u{1f}').collect();
        if f.len() < 3 || f[0] != "E" {
            continue;
        }
        let get = |k: &str| f[3..].chunks(2).find(|c| c.len() == 2 && c[0] == k).map(|c| c[1]);
        match f[2] {
            "line" => {
                let n = |k| get(k).unwrap().parse::<f64>().unwrap();
                pr.push(vec![from_paper(n("x1"), n("y1")), from_paper(n("x2"), n("y2"))]);
            }
            "polyline" => pr.push(pts_of(get("points").unwrap()).into_iter().map(|(x, y)| from_paper(x, y)).collect()),
            _ => {}
        }
    }
    vec![("Szene", s), ("CLI-SVG", v), ("Druck-SVG", pr)]
}

/// Grundriss bei 1:`scale` (Detail fein): Dämm-Bänder (Polygone mit Strichschraffur) und ihre Wandachse.
/// Liefert die Zahl der Bänder an Öffnungen (Anschlag-Nasen).
fn plan_case(p: &Project, scale: f64, what: &str) -> usize {
    let t = serde_json::json!({ "floor": "eg", "show": ["20"], "grey": [], "scale": scale }).to_string();
    let d = plan_domains(p, &PlanArgs::parse(2.0, &t).unwrap()).unwrap();
    let prims: Vec<Primitive> = d.walls.into_iter().chain(d.columns).collect();
    let mut bands: Vec<(Vec<V2>, Axis)> = Vec::new();
    let mut at_openings = 0;
    for q in &prims {
        if let Primitive::Polygon { pts, hatch, wall_id: Some(id), opening_id, .. } = q {
            if hatch.pattern == HatchPattern::Diagonal {
                at_openings += usize::from(opening_id.is_some());
                let w = p.walls.iter().find(|w| &w.id == id).unwrap();
                bands.push((pts.iter().map(|q| V2 { x: q.x, y: q.y }).collect(), wall_axis(w)));
            }
        }
    }
    assert!(!bands.is_empty(), "{what}: keine Dämm-Bänder");
    for (out, segs) in rendered(&prims, scale) {
        check(&bands, &segs, &format!("{what} 1:{scale} {out}"));
    }
    at_openings
}

/// Fenster mit Anschlag (Wandnase je Schicht) in der Wand `wall`.
fn add_window(p: &mut Project, wall: &str, position: f64) {
    // Wie die Fenster im Musterhaus komplex: Rahmen 18 cm hinter der Aussenfläche, Anschlag 5 cm.
    let wt = serde_json::json!({"id": "fe", "name": "Fenster", "kind": "dreh", "wingCount": 1, "frameThickness": 0.08, "frameDepth": 0.08, "frameWidth": 0.08,
        "insetFromFace": 0.18, "insetFace": "aussen", "rebateDepth": 0.05,
        "frameDetail": {"frameSides": {"left": 0.08, "right": 0.08, "top": 0.1, "bottom": 0.12}, "rebates": {"left": 0.05, "right": 0.05, "top": 0.05, "bottom": 0.02}}});
    p.window_types.get_or_insert_with(Vec::new).push(serde_json::from_value(wt).unwrap());
    let id = format!("O{}", p.openings.as_ref().map_or(0, |o| o.len()) + 1);
    p.openings.get_or_insert_with(Vec::new).push(Opening { id, host_wall_id: wall.into(), kind: ElementKind::Window, type_id: Some("fe".into()), category_code: "20".into(), position, width: 1.2, height: 1.4, ..Default::default() });
}

/// Alle Wandfälle im Grundriss, 1:50 und 1:20.
#[test]
fn daemm_striche_quer_zur_wand_im_grundriss() {
    let rect = |w: f64, d: f64| ColumnProfile::Rect { width: w, depth: d };
    let mut cases: Vec<(String, Project)> = Vec::new();
    // Gerade Wände, beliebig gedreht (auch rückwärts gezeichnet).
    for deg in [0.0, 17.0, 45.0, 90.0, 133.0, 180.0, 211.0, 270.0, 333.0] {
        let mut p = base();
        add_wall(&mut p, "aw", (0.0, 0.0), polar((0.0, 0.0), 3.0, deg));
        cases.push((format!("gerade {deg}°"), p));
    }
    // Bogenwände (Gegen- und Uhrzeigersinn, Halbkreis).
    for (a0, a1) in [(0.0, 90.0), (90.0, 0.0), (200.0, 380.0), (-30.0, 150.0)] {
        let mut p = base();
        add_arc_deg(&mut p, "aw", (0.0, 0.0), 2.5, a0, a1);
        cases.push((format!("Bogen {a0}°→{a1}°"), p));
    }
    // Ecken (Gehrung) 90°, 135°, 60°, in zwei Drehlagen.
    for (turn, rot) in [(90.0, 0.0), (135.0, 0.0), (60.0, 0.0), (90.0, 30.0), (135.0, 200.0), (60.0, 110.0)] {
        let mut p = base();
        let o = polar((0.0, 0.0), 3.0, rot);
        add_wall(&mut p, "aw", (0.0, 0.0), o);
        add_wall(&mut p, "aw", o, polar(o, 3.0, rot + 180.0 - turn));
        cases.push((format!("Ecke {turn}° gedreht {rot}°"), p));
    }
    // Y-Knoten und T-Stoss.
    {
        let mut p = base();
        for deg in [10.0, 130.0, 250.0] {
            add_wall(&mut p, "dw", (0.0, 0.0), polar((0.0, 0.0), 3.0, deg));
        }
        cases.push(("Y".into(), p));
        let mut p = base();
        add_wall(&mut p, "aw", (-3.0, 0.0), (3.0, 0.0));
        add_wall(&mut p, "dw", (0.0, 0.0), (0.0, -3.0));
        cases.push(("T".into(), p));
        // Gebogener Ast am Y.
        let mut p = base();
        add_wall(&mut p, "dw", (0.0, 0.0), polar((0.0, 0.0), 3.0, 0.0));
        add_wall(&mut p, "dw", (0.0, 0.0), polar((0.0, 0.0), 3.0, 120.0));
        super::wall_join_tests::add_arc(&mut p, "dw", (0.0, 0.0), polar((0.0, 0.0), 3.0, 240.0), 0.2);
        cases.push(("Y mit Bogen".into(), p));
    }
    // Kollineare Wände gleichen Typs (Stossfuge), schräg.
    {
        let mut p = base();
        add_wall(&mut p, "aw", (0.0, 0.0), polar((0.0, 0.0), 3.0, 25.0));
        add_wall(&mut p, "aw", polar((0.0, 0.0), 3.0, 25.0), polar((0.0, 0.0), 6.0, 25.0));
        cases.push(("kollinear".into(), p));
    }
    // Wand an Stütze (endet an der Kontur), Wand durch Stütze (Streifen), runde Stütze, schräg.
    {
        let mut p = base();
        add_wall(&mut p, "aw", (0.0, 0.0), (3.0, 0.0));
        add_column(&mut p, "C", (3.1, 0.0), rect(0.3, 0.4), Some("concrete"));
        cases.push(("Wand an Stütze".into(), p));
        let mut p = base();
        add_wall(&mut p, "aw", (0.0, 0.0), (6.0, 0.0));
        add_column(&mut p, "C", (3.0, -0.05), rect(0.3, 0.3), Some("concrete"));
        cases.push(("Wand durch Stütze".into(), p));
        let mut p = base();
        add_wall(&mut p, "aw", (0.0, 0.0), polar((0.0, 0.0), 6.0, 35.0));
        let c = polar((0.0, 0.0), 3.0, 35.0);
        add_column(&mut p, "C", c, ColumnProfile::Round { radius: 0.25 }, Some("concrete"));
        cases.push(("schräge Wand durch runde Stütze".into(), p));
    }
    for (what, p) in &cases {
        for scale in [50.0, 20.0] {
            plan_case(p, scale, what);
        }
    }
    // Fenster mit Anschlag: die Wandnasen (Schichtstücke in der Leibung) schraffiert wie ihre Wand, auch in
    // der Bogenwand (radial) — [168] als Teil der Schicht-Fläche (kein eigenes Öffnungs-Stück mehr).
    for (what, arc) in [("Fenster in schräger Wand", false), ("Fenster in Bogenwand", true)] {
        let mut p = base();
        if arc {
            add_arc_deg(&mut p, "aw", (0.0, 0.0), 3.0, 200.0, 340.0);
        } else {
            add_wall(&mut p, "aw", (0.0, 0.0), polar((0.0, 0.0), 5.0, 30.0));
        }
        add_window(&mut p, "W1", 1.8);
        for scale in [50.0, 20.0] {
            assert_eq!(plan_case(&p, scale, what), 0, "{what}: Nase als eigenes Stück");
        }
    }
}

/// Schnitt: Wand (senkrechte Schichten), Decke (waagrecht) und geneigtes Dach mit EPS — die Striche
/// stehen quer zur Schicht (Achse = lange Kante des Schicht-Bandes).
#[test]
fn daemm_striche_quer_zur_schicht_im_schnitt() {
    use super::overrides::RuleView;
    use super::section::{compute_section, section_primitives_at, CutRules, LevelSpec, Visibility};
    let mut p = base();
    add_wall(&mut p, "aw", (0.0, 0.0), (6.0, 0.0));
    add_wall(&mut p, "aw", (0.0, 4.0), (6.0, 4.0));
    p.ceiling_types = Some(vec![CeilingType { id: "ct".into(), name: "Decke".into(), layers: vec![layer("render", 0.08), layer("eps", 0.12), layer("concrete", 0.22)], ..Default::default() }]);
    p.ceilings = Some(vec![Ceiling {
        id: "D1".into(),
        r#type: "ceiling".into(),
        floor_id: "eg".into(),
        category_code: "25".into(),
        outline: vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 6.0, y: 0.0 }, Vec2 { x: 6.0, y: 4.0 }, Vec2 { x: 0.0, y: 4.0 }],
        ceiling_type_id: Some("ct".into()),
        ..Default::default()
    }]);
    p.roof_types = Some(vec![RoofType { id: "rt".into(), name: "Dach".into(), layers: vec![layer("eps", 0.18), layer("concrete", 0.2)], ..Default::default() }]);
    p.roofs = Some(vec![serde_json::from_value(serde_json::json!({
        "id": "R1", "type": "roof", "floorId": "eg", "categoryCode": "35", "roofTypeId": "rt",
        "outline": [{"x": -0.5, "y": -0.5}, {"x": 6.5, "y": -0.5}, {"x": 6.5, "y": 4.5}, {"x": -0.5, "y": 4.5}],
        "shape": "sattel", "pitchDeg": 35, "overhang": 0, "ridgeAxis": "x", "baseElevation": 3.2, "thickness": 0.38
    }))
    .unwrap()]);
    for (scale, x) in [(50.0, 3.0), (20.0, 2.2)] {
        // Schnittlinie quer zu den Wänden (Blick in +x).
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x, y: -2.0 }, Vec2 { x, y: 6.0 }]), cut_hatch: true, ..Default::default() };
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        let (prims, _) = section_primitives_at(&out, false, false, &Visibility::default(), scale, super::style::Detail::Fein, true, &CutRules::of(&p, &out, RuleView::at(scale, None)));
        let mut bands: Vec<(Vec<V2>, Axis)> = Vec::new();
        let mut kinds = std::collections::HashSet::new();
        for q in &prims {
            if let Primitive::Polygon { pts, hatch, wall_id, ceiling_id, roof_id, .. } = q {
                if hatch.pattern != HatchPattern::Diagonal {
                    continue;
                }
                let kind = if wall_id.is_some() { "Wand" } else if ceiling_id.is_some() { "Decke" } else if roof_id.is_some() { "Dach" } else { "?" };
                kinds.insert(kind);
                // Schichtachse: Wand senkrecht, Decke waagrecht, Dach = längste Kante des Bandes (Neigung).
                let n = pts.len();
                let (i, _) = (0..n).map(|i| (i, (pts[(i + 1) % n].x - pts[i].x).hypot(pts[(i + 1) % n].y - pts[i].y))).fold((0, -1.0), |a, b| if b.1 > a.1 { b } else { a });
                let u = match kind {
                    "Wand" => unit(0.0, 1.0),
                    "Decke" => unit(1.0, 0.0),
                    _ => unit(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y),
                };
                bands.push((pts.iter().map(|q| V2 { x: q.x, y: q.y }).collect(), Box::new(move |_| u)));
            }
        }
        assert!(kinds.contains("Wand") && kinds.contains("Decke") && kinds.contains("Dach"), "1:{scale}: Schnitt trifft {kinds:?}");
        for (o, segs) in rendered(&prims, scale) {
            check(&bands, &segs, &format!("Schnitt 1:{scale} {o}"));
        }
    }
}

