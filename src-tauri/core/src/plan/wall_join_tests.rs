//! [141] Wandknoten im Grundriss, je Fall ein kleines Testprojekt: Y-Knoten, kollineare Wände gleichen
//! Typs, Wand an Stütze, gerichtete Dämm-Muster an der Gehrung. Geprüft wird auf den Grundriss-Primitiven
//! (Bänder, Umriss-Polygone, Umrisslinien, Stützen): Polygonzahl, keine Überlappungen, geschlossene
//! Vereinigung ohne Lücke, keine Umrisslinie durch eine Fläche.

use super::domains::{plan_domains, PlanArgs};
use super::prim::Primitive;
use crate::flat::Polygon;
use crate::model::*;

fn layer(c: &str, t: f64) -> Layer {
    Layer { component_id: c.into(), thickness: t, ..Default::default() }
}

/// Bauteile wie im Beispiel (Priorität: Putz 10, Dämmung 20, Backstein 50, Beton 100) und die
/// Wandtypen `aw` (Aussenwand 36.5 cm), `iw` (Innenwand 15 cm), `bw` (Beton 20 cm).
fn base() -> Project {
    let mut p = Project::default();
    for (id, prio, hatch) in [("render-ext", 10.0, "none"), ("insulation", 20.0, "ins"), ("brick", 50.0, "diag"), ("render-int", 10.0, "none"), ("concrete", 100.0, "cross"), ("xps", 20.0, "ins-hard")] {
        p.components.push(Component { id: id.into(), join_priority: prio, hatch_id: hatch.into(), ..Default::default() });
    }
    for (id, pattern, angle) in [("none", "none", 0.0), ("ins", "insulation", 0.0), ("ins-hard", "insulationHard", 0.0), ("diag", "diagonal", 45.0), ("cross", "crosshatch", 45.0)] {
        p.hatches.push(serde_json::from_value(serde_json::json!({"id": id, "name": id, "pattern": pattern, "scale": 1, "angle": angle, "relativeToWall": true, "color": "#1a1a1a"})).unwrap());
    }
    p.wall_types.push(WallType { id: "aw".into(), layers: vec![layer("render-ext", 0.02), layer("insulation", 0.16), layer("brick", 0.15), layer("render-int", 0.015)], ..Default::default() });
    p.wall_types.push(WallType { id: "aw2".into(), layers: vec![layer("render-ext", 0.02), layer("xps", 0.14), layer("concrete", 0.2), layer("render-int", 0.015)], ..Default::default() });
    p.wall_types.push(WallType { id: "iw".into(), layers: vec![layer("render-int", 0.015), layer("brick", 0.12), layer("render-int", 0.015)], ..Default::default() });
    p.wall_types.push(WallType { id: "dw".into(), layers: vec![layer("render-int", 0.015), layer("insulation", 0.12), layer("render-int", 0.015)], ..Default::default() });
    p.wall_types.push(WallType { id: "dw2".into(), layers: vec![layer("render-int", 0.015), layer("xps", 0.1), layer("render-int", 0.015)], ..Default::default() });
    p.wall_types.push(WallType { id: "bw".into(), layers: vec![layer("concrete", 0.2)], ..Default::default() });
    p.drawing_levels.push(DrawingLevel { id: "eg".into(), kind: DrawingLevelKind::Floor, floor_height: Some(2.6), ..Default::default() });
    p
}

fn add_wall(p: &mut Project, t: &str, s: (f64, f64), e: (f64, f64)) {
    let id = format!("W{}", p.walls.len() + 1);
    p.walls.push(Wall { id, floor_id: "eg".into(), wall_type_id: t.into(), category_code: "20".into(), start: Vec2 { x: s.0, y: s.1 }, end: Vec2 { x: e.0, y: e.1 }, height: 2.6, ..Default::default() });
}

fn add_column(p: &mut Project, id: &str, at: (f64, f64), profile: ColumnProfile, comp: Option<&str>) {
    p.columns.get_or_insert_with(Vec::new).push(Column {
        id: id.into(),
        r#type: "column".into(),
        floor_id: "eg".into(),
        category_code: "20".into(),
        position: Vec2 { x: at.0, y: at.1 },
        profile,
        height: 2.6,
        component_id: comp.map(String::from),
        ..Default::default()
    });
}

fn polar(o: (f64, f64), r: f64, deg: f64) -> (f64, f64) {
    let a = deg.to_radians();
    (o.0 + r * a.cos(), o.1 + r * a.sin())
}

/// Wand- und Stützen-Primitive des Erdgeschosses (1:50, Detail fein, alle Schichten).
fn prims(p: &Project) -> Vec<Primitive> {
    let t = serde_json::json!({ "floor": "eg", "show": ["20"], "grey": [], "scale": 50 }).to_string();
    let d = plan_domains(p, &PlanArgs::parse(2.0, &t).unwrap()).unwrap();
    d.walls.into_iter().chain(d.columns).collect()
}

/// Gefüllte Flächen (Schichtbänder, Stützen).
fn filled(ps: &[Primitive]) -> Vec<Vec<Vec2>> {
    ps.iter()
        .filter_map(|q| match q {
            Primitive::Polygon { pts, fill, opening_id: None, .. } if fill != "none" => Some(pts.clone()),
            _ => None,
        })
        .collect()
}

/// Gezeichnete Umriss-Strecken: Kanten gestrichener Polygone ohne `no_stroke_edges`, Umrisslinien.
fn outline(ps: &[Primitive]) -> Vec<(Vec2, Vec2)> {
    let mut out = Vec::new();
    for q in ps {
        match q {
            Primitive::Polygon { pts, stroke, stroke_width_mm, no_stroke_edges, opening_id: None, .. } if stroke != "none" && *stroke_width_mm > 0.0 => {
                let skip = no_stroke_edges.clone().unwrap_or_default();
                for i in 0..pts.len() {
                    if !skip.contains(&(i as f64)) {
                        out.push((pts[i], pts[(i + 1) % pts.len()]));
                    }
                }
            }
            Primitive::Line { a, b, cls, .. } if cls == "wall-outline" || cls == "column-outline" => out.push((*a, *b)),
            _ => {}
        }
    }
    out.retain(|(a, b)| (a.x - b.x).hypot(a.y - b.y) > 1e-9);
    out
}

fn area(pts: &[Vec2]) -> f64 {
    let n = pts.len();
    (0..n).map(|i| pts[i].x * pts[(i + 1) % n].y - pts[(i + 1) % n].x * pts[i].y).sum::<f64>().abs() / 2.0
}

fn to_poly(pts: &[Vec2]) -> Polygon {
    vec![pts.iter().map(|p| [p.x, p.y]).collect()]
}

fn ring_area(r: &[[f64; 2]]) -> f64 {
    let n = r.len();
    (0..n).map(|i| r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1]).sum::<f64>().abs() / 2.0
}

/// Polygon um `eps` nach aussen versetzt (Kantenlinien parallel verschoben, Ecken neu geschnitten):
/// schräge gemeinsame Kanten verschmelzen in der Vereinigung trotz Ganzzahlraster von i_overlay.
fn grow(pts: &[Vec2], eps: f64) -> Vec<Vec2> {
    let n = pts.len();
    let s: f64 = (0..n).map(|i| pts[i].x * pts[(i + 1) % n].y - pts[(i + 1) % n].x * pts[i].y).sum::<f64>().signum();
    let out_n = |a: Vec2, b: Vec2| {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l = dx.hypot(dy).max(1e-30);
        Vec2 { x: s * dy / l, y: -s * dx / l }
    };
    (0..n)
        .map(|i| {
            let (p, c, q) = (pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]);
            let (n1, n2) = (out_n(p, c), out_n(c, q));
            let k = 1.0 + n1.x * n2.x + n1.y * n2.y;
            if k < 1e-6 {
                return Vec2 { x: c.x + n1.x * eps, y: c.y + n1.y * eps };
            }
            Vec2 { x: c.x + (n1.x + n2.x) * eps / k, y: c.y + (n1.y + n2.y) * eps / k }
        })
        .collect()
}

/// Summe der Flächen − Fläche der Vereinigung (Überlappung) und die Vereinigung der um 1e-7 m
/// versetzten Flächen (Körper, Lücken).
fn overlap(polys: &[Vec<Vec2>]) -> (f64, Vec<Polygon>) {
    let sum: f64 = polys.iter().map(|q| area(q)).sum();
    let u = crate::polygon_bool::union(&polys.iter().map(|q| to_poly(q)).collect::<Vec<_>>());
    let ua: f64 = u.iter().map(|pl| ring_area(&pl[0]) - pl[1..].iter().map(|h| ring_area(h)).sum::<f64>()).sum();
    let g = crate::polygon_bool::union(&polys.iter().map(|q| to_poly(&grow(q, 1e-7))).collect::<Vec<_>>());
    (sum - ua, g)
}

fn dist_seg(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let l2 = dx * dx + dy * dy;
    let t = if l2 < 1e-24 { 0.0 } else { (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0) };
    (p.x - a.x - t * dx).hypot(p.y - a.y - t * dy)
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

/// Punkt liegt strikt in einer der Flächen (mehr als `eps` vom Rand).
fn strictly_in(polys: &[Vec<Vec2>], p: Vec2, eps: f64) -> bool {
    polys.iter().any(|q| inside(q, p) && (0..q.len()).all(|i| dist_seg(p, q[i], q[(i + 1) % q.len()]) > eps))
}

/// Strecken einer Vereinigung (alle Ringe).
fn union_edges(u: &[Polygon]) -> Vec<(Vec2, Vec2)> {
    let mut e = Vec::new();
    for pl in u {
        for r in pl {
            for i in 0..r.len() {
                let (a, b) = (r[i], r[(i + 1) % r.len()]);
                e.push((Vec2 { x: a[0], y: a[1] }, Vec2 { x: b[0], y: b[1] }));
            }
        }
    }
    e
}

/// Der Umriss schliesst: jeder Randpunkt der Vereinigung liegt auf einer gezeichneten Umriss-Strecke.
fn assert_closed(u: &[Polygon], lines: &[(Vec2, Vec2)], what: &str) {
    for (a, b) in union_edges(u) {
        for k in 1..10 {
            let t = k as f64 / 10.0;
            let p = Vec2 { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
            assert!(lines.iter().any(|(c, d)| dist_seg(p, *c, *d) < 1e-6), "{what}: Umriss offen bei {p:?}");
        }
    }
}

/// Keine Umrisslinie läuft durch eine Fläche (Überlappungs-/Trennlinie).
fn assert_no_line_through(polys: &[Vec<Vec2>], lines: &[(Vec2, Vec2)], what: &str) {
    for (a, b) in lines {
        for k in 1..8 {
            let t = k as f64 / 8.0;
            let p = Vec2 { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
            assert!(!strictly_in(polys, p, 1e-6), "{what}: Umrisslinie durch eine Fläche bei {p:?} ({a:?}–{b:?})");
        }
    }
}

/// Keine Umrisslinie im Inneren der Vereinigung (gleiches Material: ein Körper ohne Trennlinie).
fn assert_no_inner_line(u: &[Polygon], lines: &[(Vec2, Vec2)], what: &str) {
    let edges = union_edges(u);
    for (a, b) in lines {
        let m = Vec2 { x: (a.x + b.x) / 2.0, y: (a.y + b.y) / 2.0 };
        assert!(edges.iter().any(|(c, d)| dist_seg(m, *c, *d) < 1e-6), "{what}: Linie im Körper {a:?}–{b:?}");
    }
}

fn holes(u: &[Polygon]) -> usize {
    u.iter().map(|pl| pl.len() - 1).sum()
}

// ── (1) Y-Knoten ────────────────────────────────────────────────────────────

/// Drei Wände gleichen Typs mit schiefen Winkeln (0/120/240° Aussenwand, 0/100/225° Innenwand): das
/// stärkste Paar auf Gehrung, der dritte Ast endet an BEIDEN Flächen (Kerbe bzw. Spitze) — keine
/// Überlappung, keine Lücke, ein Körper, Umriss geschlossen.
#[test]
fn y_knoten_dritter_ast_an_beiden_flaechen() {
    for (t, angles) in [("aw", [0.0, 120.0, 240.0]), ("iw", [0.0, 100.0, 225.0]), ("aw", [0.0, 150.0, 260.0]), ("iw", [30.0, 160.0, 75.0])] {
        let mut p = base();
        for a in angles {
            add_wall(&mut p, t, (0.0, 0.0), polar((0.0, 0.0), 3.0, a));
        }
        let ps = prims(&p);
        let polys = filled(&ps);
        let what = format!("{t} {angles:?}");
        let n_layers = p.wall_types.iter().find(|w| w.id == t).unwrap().layers.len();
        assert_eq!(polys.len(), 3 * n_layers, "{what}: ein Band je Schicht und Wand");
        let (ov, u) = overlap(&polys);
        assert!(ov.abs() < 1e-6, "{what}: Überlappung {ov}");
        assert_eq!(u.len(), 1, "{what}: ein Körper");
        assert_eq!(holes(&u), 0, "{what}: keine Lücke im Knoten");
        let lines = outline(&ps);
        assert_closed(&u, &lines, &what);
        assert_no_line_through(&polys, &lines, &what);
    }
}

// ── (2) Kollineare Wände ────────────────────────────────────────────────────

/// Gleiche Achse, gleicher Typ (gegenläufig nur symmetrisch: sonst liegen die Schichten gespiegelt):
/// stumpf aneinander, überlappend, ganz enthalten, schräg — ein Körper, keine Trennlinie, keine
/// doppelten Umrisse.
#[test]
fn kollineare_wande_gleichen_typs_ein_koerper() {
    let cases: [(&str, (f64, f64), (f64, f64), (f64, f64), (f64, f64)); 7] = [
        ("iw", (0.0, 0.0), (3.0, 0.0), (3.0, 0.0), (6.0, 0.0)),
        ("iw", (0.0, 0.0), (4.0, 0.0), (3.0, 0.0), (7.0, 0.0)),
        ("iw", (0.0, 0.0), (6.0, 0.0), (2.0, 0.0), (4.0, 0.0)),
        ("iw", (0.0, 0.0), (3.0, 0.0), (6.0, 0.0), (2.0, 0.0)),
        ("aw", (0.0, 0.0), (3.0, 0.0), (3.0, 0.0), (6.0, 0.0)),
        ("aw", (3.0, 0.0), (6.0, 0.0), (0.0, 0.0), (4.0, 0.0)),
        ("aw", (0.0, 0.0), (4.0, 1.0), (3.0, 0.75), (8.0, 2.0)),
    ];
    for (t, s1, e1, s2, e2) in cases {
        let mut p = base();
        add_wall(&mut p, t, s1, e1);
        add_wall(&mut p, t, s2, e2);
        let ps = prims(&p);
        let polys = filled(&ps);
        let what = format!("{t} {s1:?}-{e1:?} / {s2:?}-{e2:?}");
        let (ov, u) = overlap(&polys);
        assert!(ov.abs() < 1e-6, "{what}: Überlappung {ov}");
        assert_eq!(u.len(), 1, "{what}: ein Körper");
        let lines = outline(&ps);
        assert_no_inner_line(&u, &lines, &what);
        assert_closed(&u, &lines, &what);
        // Keine doppelten Umrisse: die Umrisslänge entspricht dem Rand der Vereinigung.
        let len = |e: &[(Vec2, Vec2)]| e.iter().map(|(a, b)| (a.x - b.x).hypot(a.y - b.y)).sum::<f64>();
        assert!((len(&lines) - len(&union_edges(&u))).abs() < 1e-6, "{what}: Umriss {} statt {}", len(&lines), len(&union_edges(&u)));
    }
    // Gegenprobe: verschiedene Typen bleiben getrennt (Materialwechsel mit Linie).
    let mut p = base();
    add_wall(&mut p, "iw", (0.0, 0.0), (3.0, 0.0));
    add_wall(&mut p, "bw", (3.0, 0.0), (6.0, 0.0));
    let lines = outline(&prims(&p));
    assert!(lines.iter().any(|(a, b)| (a.x - 3.0).abs() < 1e-9 && (b.x - 3.0).abs() < 1e-9), "Typwechsel: Stosslinie bleibt");
}

// ── (3) Wand an Stütze ──────────────────────────────────────────────────────

/// Backstein-Wand endet in einer Betonstütze (rechteckig): die Stütze dominiert — die Wand endet an
/// der Stützenkontur, keine Überlappung, keine Linie durch eine Fläche. Gleiches Material (Betonwand an
/// Betonstütze): ein Körper ohne Trennlinie. Mauerwerksstütze in Betonwand: die Wand dominiert.
#[test]
fn wand_endet_an_stuetze() {
    let rect = |w: f64, d: f64| ColumnProfile::Rect { width: w, depth: d };
    // Stütze dominiert (Beton über Backstein), auch Aussenwand und tiefe Stütze.
    for (t, prof) in [("iw", rect(0.3, 0.3)), ("aw", rect(0.3, 0.4)), ("iw", rect(0.4, 0.3))] {
        let mut p = base();
        add_wall(&mut p, t, (0.0, 0.0), (3.0, 0.0));
        add_column(&mut p, "C", (3.1, 0.0), prof.clone(), Some("concrete"));
        let ps = prims(&p);
        let polys = filled(&ps);
        let what = format!("{t} {prof:?}");
        let (ov, u) = overlap(&polys);
        assert!(ov.abs() < 1e-6, "{what}: Überlappung {ov}");
        assert_eq!(u.len(), 1, "{what}: Wand schliesst an die Stütze an");
        let lines = outline(&ps);
        assert_no_line_through(&polys, &lines, &what);
        assert_closed(&u, &lines, &what);
    }
    // Gleiches Material: ein Körper ohne Trennlinie.
    let mut p = base();
    add_wall(&mut p, "bw", (0.0, 0.0), (3.0, 0.0));
    add_column(&mut p, "C", (3.1, 0.0), rect(0.3, 0.3), Some("concrete"));
    let ps = prims(&p);
    let polys = filled(&ps);
    let (ov, u) = overlap(&polys);
    assert!(ov.abs() < 1e-6, "Beton/Beton: Überlappung {ov}");
    let lines = outline(&ps);
    assert_no_inner_line(&u, &lines, "Beton/Beton");
    assert_closed(&u, &lines, "Beton/Beton");
    // Wand dominiert: Backsteinstütze in einer Betonwand — die Stütze wird an der Wand beschnitten.
    let mut p = base();
    add_wall(&mut p, "bw", (0.0, 0.0), (3.0, 0.0));
    add_column(&mut p, "C", (3.0, 0.0), rect(0.3, 0.3), Some("brick"));
    let ps = prims(&p);
    let polys = filled(&ps);
    let (ov, u) = overlap(&polys);
    assert!(ov.abs() < 1e-6, "Beton-Wand/Backstein-Stütze: Überlappung {ov}");
    let lines = outline(&ps);
    assert_no_line_through(&polys, &lines, "Beton-Wand/Backstein-Stütze");
    assert_closed(&u, &lines, "Beton-Wand/Backstein-Stütze");
}

// ── (4) Gerichtete Dämm-Muster an der Gehrung ───────────────────────────────

fn to_hatch(h: &super::prim::HatchRender) -> crate::hatch::Hatch {
    use crate::hatch::{Hatch, HatchKind, Pattern, V2};
    Hatch {
        pattern: match h.pattern {
            HatchPattern::Insulation => Pattern::Insulation,
            HatchPattern::InsulationHard => Pattern::InsulationHard,
            HatchPattern::InsulationWave => Pattern::InsulationWave,
            _ => Pattern::None,
        },
        kind: HatchKind::Vector,
        random: false,
        scale: h.scale,
        angle: h.angle,
        line_weight: h.line_weight,
        origin: h.origin.map(|o| V2 { x: o.x, y: o.y }),
        seed: None,
        density: None,
        length_min: None,
        length_max: None,
        dash: vec![],
        motif: None,
        polar: None,
    }
}

/// Schichtmuster (Dämmschlange, Zickzack) zweier Wände auf Gehrung: jeder Lauf, der an der
/// Gehrungslinie endet, setzt sich in der Nachbarwand am selben Punkt fort (kein gezacktes Ende).
/// Verschiedene Winkel und Orientierungen (Ende an Anfang, Anfang an Ende, Anfang an Anfang, Ende an
/// Ende).
#[test]
fn daemm_muster_gehen_an_der_gehrung_ineinander_ueber() {
    // Gleich orientierte Enden (Fall 2, 3) nur mit symmetrischem Wandtyp (sonst trifft die Dämmung
    // der einen Wand auf den Backstein der anderen).
    let cases = [("aw", HatchPattern::Insulation, [0, 1].as_slice()), ("aw2", HatchPattern::InsulationHard, &[0, 1]), ("dw", HatchPattern::Insulation, &[0, 1, 2, 3]), ("dw2", HatchPattern::InsulationHard, &[0, 1, 2, 3])];
    for (t, pat, flips) in cases {
        for deg in [90.0, 135.0, 60.0, 110.0] {
            for &flip in flips {
                let mut p = base();
                let c = (4.0, 0.0);
                let far = polar(c, 3.3, deg);
                match flip {
                    0 => {
                        add_wall(&mut p, t, (0.0, 0.0), c);
                        add_wall(&mut p, t, c, far);
                    }
                    1 => {
                        add_wall(&mut p, t, c, (0.0, 0.0));
                        add_wall(&mut p, t, far, c);
                    }
                    2 => {
                        add_wall(&mut p, t, c, (0.0, 0.0));
                        add_wall(&mut p, t, c, far);
                    }
                    _ => {
                        add_wall(&mut p, t, (0.0, 0.0), c);
                        add_wall(&mut p, t, far, c);
                    }
                }
                let what = format!("{t} {deg}° Fall {flip}");
                let ps = prims(&p);
                let bands: Vec<(String, Vec<Vec2>, super::prim::HatchRender)> = ps
                    .iter()
                    .filter_map(|q| match q {
                        Primitive::Polygon { pts, hatch, wall_id: Some(w), .. } if hatch.pattern == pat => Some((w.clone(), pts.clone(), hatch.clone())),
                        _ => None,
                    })
                    .collect();
                assert_eq!(bands.len(), 2, "{what}");
                // Gehrungslinie: gemeinsame Kante der beiden Bänder (Punkte beider Polygone).
                let shared: Vec<Vec2> = bands[0].1.iter().copied().filter(|a| bands[1].1.iter().any(|b| (a.x - b.x).hypot(a.y - b.y) < 1e-9)).collect();
                assert_eq!(shared.len(), 2, "{what}: Gehrungskante");
                let (m0, m1) = (shared[0], shared[1]);
                let ends = |i: usize| -> Vec<crate::hatch::V2> {
                    let poly: Vec<crate::hatch::V2> = bands[i].1.iter().map(|q| crate::hatch::V2 { x: q.x, y: q.y }).collect();
                    crate::hatch::build_hatch_runs(&poly, &to_hatch(&bands[i].2))
                        .into_iter()
                        .flat_map(|r| [r[0], r[r.len() - 1]])
                        .filter(|q| dist_seg(Vec2 { x: q.x, y: q.y }, m0, m1) < 1e-9)
                        // Ecken der Gehrungskante (Lauf an der Schichtkante) zählen nicht.
                        .filter(|q| (q.x - m0.x).hypot(q.y - m0.y) > 1e-6 && (q.x - m1.x).hypot(q.y - m1.y) > 1e-6)
                        .collect()
                };
                let (a, b) = (ends(0), ends(1));
                assert!(!a.is_empty(), "{what}: Muster erreicht die Gehrung");
                for q in &a {
                    assert!(b.iter().any(|r| (q.x - r.x).hypot(q.y - r.y) < 1e-6), "{what}: Lauf endet bei {q:?} ohne Fortsetzung ({} / {})", a.len(), b.len());
                }
                assert_eq!(a.len(), b.len(), "{what}");
            }
        }
    }
}

/// Wand mit Ecke am Anfang und materialbewusstem T-Stoss am Ende: die Schichtbänder folgen am Anfang
/// der Gehrung (vorher galten nur die Schicht-Schnitte des T-Endes, der Anfang blieb rechtwinklig und
/// überlappte die Eckwand).
#[test]
fn ecke_am_anfang_t_stoss_am_ende() {
    let mut p = base();
    add_wall(&mut p, "aw", (0.0, 3.0), (0.0, 0.0));
    add_wall(&mut p, "aw", (0.0, 0.0), (4.0, 0.0));
    add_wall(&mut p, "aw", (4.0, -2.0), (4.0, 2.0));
    let ps = prims(&p);
    let polys: Vec<Vec<Vec2>> = ps
        .iter()
        .filter_map(|q| match q {
            Primitive::Polygon { pts, fill, wall_id: Some(w), .. } if fill != "none" && w != "W3" => Some(pts.clone()),
            _ => None,
        })
        .collect();
    let (ov, u) = overlap(&polys);
    assert!(ov.abs() < 1e-6, "Überlappung an der Ecke {ov}");
    assert_eq!((u.len(), holes(&u)), (1, 0));
}
