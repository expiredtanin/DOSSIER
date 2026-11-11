//! Tests zur Ansicht (`plan/elevation/`): Farben, Beispielprojekt, importierte Netze, Schatten, Öffnungen.

use super::*;

fn sample() -> Project {
    serde_json::from_str(include_str!("../../../tests/fixtures/sample_project.json")).unwrap()
}

#[test]
fn farben_wie_ts() {
    assert_eq!(rgb_to_hex([1.0, 0.0, 0.5]), "#ff0080");
    assert_eq!(rgb_to_hex([f64::NAN, 2.0, -1.0]), "#NaNff00");
    assert_eq!(hex_to_rgb(" #ff0000 ", [0.0; 3]), [1.0, 0.0, 0.0]);
    assert_eq!(hex_to_rgb("#abc", [0.5; 3]), [0.5; 3]);
}

#[test]
fn beispiel_ansicht() {
    let p = sample();
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
    let (prims, b) = elevation_primitives(&p, &level, true, false, &Visibility::default(), 100.0).unwrap().unwrap();
    let json = serde_json::to_string(&prims).unwrap();
    assert!(json.contains("\"wallId\":\"W1\"") && json.contains("\"openingId\":\"O1\"") && json.contains("elevation-ground"), "{json}");
    assert!(json.contains("#8f959e"), "Schlagschatten fehlt");
    // [137] Schlagschatten anwählbar: Pick-Id der Ansichts-Schatten (Objekt-Info schaltet sie)
    let shadow: Vec<_> = prims.iter().filter(|q| matches!(q, Primitive::Polygon { fill, .. } if fill == SHADOW_FILL)).collect();
    assert!(!shadow.is_empty() && shadow.iter().all(|q| matches!(q, Primitive::Polygon { context_object_id: Some(id), .. } if id == crate::plan::extras::SITE_PICK_VIEW_SHADOWS)));
    assert!(b[2] > b[0]);
    // Painter: die Bodenlinie zuletzt
    assert!(matches!(prims.last(), Some(Primitive::Line { cls, .. }) if cls == "elevation-ground"));
}

/// [152] Importierte Netze in der Ansicht: Flächen (Pick über die Kontext-Id), Kanten exakt verdeckt durch
/// Bauteile davor; offene Netze beidseitig; ausgeblendete Kategorie entfällt.
#[test]
fn importierte_netze_in_der_ansicht() {
    use crate::mesh_view::tests::cube;
    let mesh = |id: &str, (positions, indices): (Vec<f64>, Vec<f64>)| ContextObject::ImportedMesh(ImportedMesh { id: id.into(), name: id.into(), category_code: "10".into(), color: Some("#ff0000".into()), positions, indices, ..Default::default() });
    // Ansicht von y = −1 nach +y, u = x + 5.
    let level = LevelSpec { kind: "elevation".into(), line: Some([Vec2 { x: -5.0, y: -1.0 }, Vec2 { x: 8.0, y: -1.0 }]), direction_sign: Some(1.0), ..Default::default() };
    let lines = |prims: &[Primitive]| -> Vec<([f64; 2], [f64; 2])> {
        prims.iter().filter_map(|q| match q {
            Primitive::Line { a, b, cls, .. } if cls != "elevation-ground" => Some(([a.x, a.y], [b.x, b.y])),
            _ => None,
        }).collect()
    };
    let mut p = Project { context: Some(vec![mesh("n", cube(0.0, 2.0, 2.0, 3.0, 0.0, 2.0))]), ..Default::default() };
    let (prims, _) = elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { fill, context_object_id: Some(id), .. } if id == "n" && fill == "#ff0000")));
    let l = lines(&prims);
    assert_eq!(l.len(), 4, "Umriss der Vorderseite ohne Diagonale: {l:?}");
    assert!(l.iter().all(|(a, b)| a[0].min(b[0]) > 5.0 - 1e-9 && a[0].max(b[0]) < 7.0 + 1e-9));
    // Eine 1 m hohe Wand davor verdeckt den unteren Teil.
    p.walls = vec![Wall { id: "w".into(), start: Vec2 { x: -1.0, y: 0.5 }, end: Vec2 { x: 5.0, y: 0.5 }, height: 1.0, ..Default::default() }];
    let (prims, _) = elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    let mesh_lines: Vec<_> = lines(&prims).into_iter().filter(|(a, b)| a[0].min(b[0]) > 5.0 - 1e-6 && a[0].max(b[0]) < 7.0 + 1e-6).collect();
    assert_eq!(mesh_lines.len(), 3, "{mesh_lines:?}");
    assert!(mesh_lines.iter().all(|(a, b)| a[1].min(b[1]) > 1.0 - 1e-6), "{mesh_lines:?}");
    assert!(lines(&prims).iter().any(|(a, b)| (a[0] - 7.0).abs() < 1e-9 && (b[0] - 7.0).abs() < 1e-9 && (a[1].max(b[1]) - 2.0).abs() < 1e-9), "Kante über der Wand sichtbar");
    // Offene Fläche, von hinten gesehen: trotzdem gezeichnet.
    let pos = vec![0.0, 2.0, 0.0, 0.0, 2.0, 2.0, 3.0, 2.0, 2.0, 3.0, 2.0, 0.0];
    for idx in [vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], vec![0.0, 2.0, 1.0, 0.0, 3.0, 2.0]] {
        let q = Project { context: Some(vec![mesh("f", (pos.clone(), idx))]), ..Default::default() };
        let (prims, _) = elevation_primitives(&q, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
        assert!(prims.iter().any(|x| matches!(x, Primitive::Polygon { context_object_id: Some(id), .. } if id == "f")));
        assert_eq!(lines(&prims).len(), 4);
    }
    // Kategorie ausgeblendet: weder Fläche noch Kante.
    let vis = Visibility { has_vis: true, has_display: true, invisible: ["10".to_string()].into(), ..Default::default() };
    p.walls.clear();
    let r = elevation_primitives(&p, &level, false, false, &vis, 100.0).unwrap();
    assert!(r.is_none_or(|(prims, _)| !prims.iter().any(|x| matches!(x, Primitive::Polygon { context_object_id: Some(_), .. })) && lines(&prims).is_empty()));
}

/// [115] Freie Körper in der Ansicht (Netz aus dem Kern): Flächen mit Körper-Id, Kanten sichtbar, die Wand
/// dahinter verdeckt; Klasse aus ⇒ weg (verdeckt dann auch nichts mehr).
#[test]
fn freie_koerper_in_der_ansicht() {
    let level = LevelSpec { kind: "elevation".into(), line: Some([Vec2 { x: -5.0, y: -1.0 }, Vec2 { x: 8.0, y: -1.0 }]), direction_sign: Some(1.0), ..Default::default() };
    let pt = |x: f64, y: f64| Vec2 { x, y };
    // Wand x −1…5 bei y = 3 (3 m hoch), davor ein Quader 0…2 × 0…1, 2 m hoch, Klasse „50".
    let mut p = Project {
        walls: vec![Wall { id: "w".into(), start: pt(-1.0, 3.0), end: pt(5.0, 3.0), height: 3.0, category_code: "20".into(), ..Default::default() }],
        extruded_solids: Some(vec![ExtrudedSolid { id: "k".into(), category_code: "50".into(), points: vec![pt(0.0, 0.0), pt(2.0, 0.0), pt(2.0, 1.0), pt(0.0, 1.0)], height: 2.0, ..Default::default() }]),
        ..Default::default()
    };
    let lines = |prims: &[Primitive]| -> Vec<([f64; 2], [f64; 2])> {
        prims.iter().filter_map(|q| match q {
            Primitive::Line { a, b, cls, .. } if cls == "elevation-outline" => Some(([a.x, a.y], [b.x, b.y])),
            _ => None,
        }).collect()
    };
    // u = x + 5: Quader u 5…7, Wand u 4…10.
    let (prims, _) = elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { extruded_solid_id: Some(id), .. } if id == "k")), "Körperfläche mit Pick-Id");
    let l = lines(&prims);
    let on = |x: f64, y0: f64, y1: f64| l.iter().any(|(a, b)| (a[0] - x).abs() < 1e-6 && (b[0] - x).abs() < 1e-6 && (a[1].min(b[1]) - y0).abs() < 1e-6 && (a[1].max(b[1]) - y1).abs() < 1e-6);
    assert!(on(5.0, 0.0, 2.0) && on(7.0, 0.0, 2.0), "senkrechte Quaderkanten: {l:?}");
    assert!(l.iter().any(|(a, b)| (a[1] - 2.0).abs() < 1e-6 && (b[1] - 2.0).abs() < 1e-6 && (a[0].min(b[0]) - 5.0).abs() < 1e-6 && (a[0].max(b[0]) - 7.0).abs() < 1e-6), "Oberkante des Quaders");
    // Die Wand-Unterkante (Höhe 0) ist hinter dem Quader verdeckt: kein Stück zwischen u 5 und 7.
    let hidden_part = l.iter().any(|(a, b)| a[1].abs() < 1e-6 && b[1].abs() < 1e-6 && a[0].min(b[0]) < 7.0 - 1e-6 && a[0].max(b[0]) > 5.0 + 1e-6 && !((a[0] - 5.0).abs() < 1e-6 && (b[0] - 7.0).abs() < 1e-6 || (a[0] - 7.0).abs() < 1e-6 && (b[0] - 5.0).abs() < 1e-6));
    assert!(!hidden_part, "Wandkante hinter dem Quader verdeckt: {l:?}");
    // Klasse „50" aus: kein Körper, die Wandfläche liegt wieder frei (keine Quaderkanten).
    let vis = Visibility { has_vis: true, has_display: true, invisible: ["50".to_string()].into(), ..Default::default() };
    let (prims, _) = elevation_primitives(&p, &level, false, false, &vis, 100.0).unwrap().unwrap();
    assert!(!prims.iter().any(|q| matches!(q, Primitive::Polygon { extruded_solid_id: Some(_), .. })));
    let l = lines(&prims);
    assert!(!l.iter().any(|(a, b)| (a[0] - 7.0).abs() < 1e-6 && (b[0] - 7.0).abs() < 1e-6), "{l:?}");
    // Abzugskörper sind kein Material: nicht gezeichnet.
    p.extruded_solids.as_mut().unwrap()[0].operation = Some("subtract".into());
    let (prims, _) = elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    assert!(!prims.iter().any(|q| matches!(q, Primitive::Polygon { extruded_solid_id: Some(_), .. })));
}

/// [152] Ganz verdeckte Netz-Flächen entfallen (Maler-Liste), teilweise sichtbare bleiben; die Kanten bleiben exakt.
#[test]
fn verdeckte_netzflaechen_entfallen() {
    use crate::mesh_view::tests::cube;
    let mesh = |id: &str, (positions, indices): (Vec<f64>, Vec<f64>)| ContextObject::ImportedMesh(ImportedMesh { id: id.into(), name: id.into(), category_code: "10".into(), positions, indices, ..Default::default() });
    let level = LevelSpec { kind: "elevation".into(), line: Some([Vec2 { x: -5.0, y: -1.0 }, Vec2 { x: 8.0, y: -1.0 }]), direction_sign: Some(1.0), ..Default::default() };
    let count = |prims: &[Primitive], id: &str| prims.iter().filter(|q| matches!(q, Primitive::Polygon { context_object_id: Some(i), .. } if i == id)).count();
    // Wand x −1…5, 3 m hoch, bei y = 0.5; dahinter „hinten" (ganz verdeckt), „teil" (ragt rechts heraus),
    // „ueber" (ragt oben heraus), „netz" verdeckt von der Netz-Platte „platte" davor.
    let p = Project {
        walls: vec![Wall { id: "w".into(), start: Vec2 { x: -1.0, y: 0.5 }, end: Vec2 { x: 5.0, y: 0.5 }, height: 3.0, ..Default::default() }],
        context: Some(vec![
            mesh("hinten", cube(0.0, 2.0, 2.0, 3.0, 0.0, 2.0)),
            mesh("teil", cube(4.0, 6.0, 2.0, 3.0, 0.0, 2.0)),
            mesh("ueber", cube(1.0, 2.0, 4.0, 5.0, 0.0, 3.5)),
            mesh("platte", cube(5.5, 7.5, 1.0, 1.2, 0.0, 2.0)),
            mesh("netz", cube(6.0, 7.0, 3.0, 4.0, 0.0, 1.5)),
        ]),
        ..Default::default()
    };
    let (prims, _) = elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    assert_eq!(count(&prims, "hinten"), 0);
    assert_eq!(count(&prims, "netz"), 0);
    assert!(count(&prims, "teil") > 0 && count(&prims, "ueber") > 0 && count(&prims, "platte") > 0);
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { wall_id: Some(i), .. } if i == "w")));
}

/// [G4] Verdeckte Kanten der Ansicht gestrichelt nur mit `hiddenLines`; Kanten liegen über den
/// Füllungen (nach der letzten Fläche) und nie doppelt.
#[test]
fn verdeckte_kanten_auf_wunsch() {
    let p = sample();
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let mut v = serde_json::to_value(l).unwrap();
    let (prims, _) = elevation_primitives(&p, &LevelSpec::from_json(&v), false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    let json = serde_json::to_string(&prims).unwrap();
    assert!(!json.contains("elevation-hidden"));
    let last_fill = prims.iter().rposition(|x| matches!(x, Primitive::Polygon { wall_id: Some(_), .. })).unwrap();
    let first_edge = prims.iter().position(|x| matches!(x, Primitive::Line { cls, .. } if cls == "elevation-outline")).unwrap();
    assert!(first_edge > last_fill);
    let mut seen = std::collections::HashSet::new();
    for x in &prims {
        if let Primitive::Line { a, b, cls, .. } = x {
            if cls == "elevation-outline" {
                let k = |q: &Vec2| ((q.x * 1e4).round() as i64, (q.y * 1e4).round() as i64);
                let key = if k(a) < k(b) { (k(a), k(b)) } else { (k(b), k(a)) };
                assert!(seen.insert(key), "doppelt: {a:?} {b:?}");
            }
        }
    }
    v["hiddenLines"] = serde_json::Value::Bool(true);
    let (prims, _) = elevation_primitives(&p, &LevelSpec::from_json(&v), false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    assert!(serde_json::to_string(&prims).unwrap().contains("elevation-hidden"));
}

fn render(p: &Project, scale: f64) -> String {
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
    let (prims, _) = elevation_primitives(p, &level, false, false, &Visibility::default(), scale).unwrap().unwrap();
    serde_json::to_string(&prims).unwrap()
}

/// [G2] Wände unter dem Dach: in der Traufansicht verdeckt das Dach Giebel- und Innenwände (keine
/// Wandfläche über der Traufkante), in der Giebelansicht steht die Giebelwand bis unter das Dach.
#[test]
fn waende_unter_dem_dach_in_der_ansicht() {
    let p: Project = serde_json::from_value(serde_json::json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [], "openings": [],
        "drawingLevels": [
            {"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
            {"id": "s", "name": "S", "kind": "elevation", "visible": true, "locked": false, "linePoints": [{"x": -2, "y": -3}, {"x": 12, "y": -3}], "directionSign": 1},
            {"id": "w", "name": "W", "kind": "elevation", "visible": true, "locked": false, "linePoints": [{"x": -3, "y": 10}, {"x": -3, "y": -2}], "directionSign": 1}
        ],
        "walls": [
            {"id": "WS", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 10, "y": 0}, "height": 3.5},
            {"id": "WW", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 0, "y": 8}, "end": {"x": 0, "y": 0}, "height": 9.0},
            {"id": "WI", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 5, "y": 0}, "end": {"x": 5, "y": 8}, "height": 9.0}
        ],
        "roofs": [{"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35",
            "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}],
            "shape": "sattel", "pitchDeg": 45, "overhang": 0.5, "overhangGable": 0.3, "ridgeAxis": "x", "thickness": 0.3}]
    }))
    .unwrap();
    let view = |id: &str| {
        let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap().0
    };
    let wall_top = |prims: &[Primitive], id: &str| -> f64 {
        prims
            .iter()
            .filter_map(|q| match q {
                Primitive::Polygon { pts, wall_id: Some(w), .. } if w == id => Some(pts.iter().map(|v| v.y).fold(f64::NEG_INFINITY, f64::max)),
                _ => None,
            })
            .fold(f64::NEG_INFINITY, f64::max)
    };
    // Traufe: Oberkante der Dachfläche an der Vorderkante (tiefster Punkt der Dachflächen).
    let r = &p.roofs.as_ref().unwrap()[0];
    let eave = crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r)).planes.iter().flatten().map(|q| q[2]).fold(f64::INFINITY, f64::min);
    let s = view("s");
    // Sichtbar bis unter die Traufstirn (Dicke 0.3 senkrecht zur 45°-Fläche: 0.3·cos 45° tiefer).
    let fascia = eave - 0.3 * 0.5f64.sqrt();
    assert!(wall_top(&s, "WW") <= fascia + 1e-3 && wall_top(&s, "WI") <= fascia + 1e-3, "{} {} {fascia}", wall_top(&s, "WW"), wall_top(&s, "WI"));
    assert!((wall_top(&s, "WS") - fascia).abs() < 1e-3, "Traufwand bis zur Traufstirn sichtbar: {}", wall_top(&s, "WS"));
    // Giebel: First-Unterkante = Traufkante 3.0 + 4.5 (bei 45°) − 0.3·√2.
    let w = view("w");
    let ridge_under = 7.5 - 0.3 * 2f64.sqrt();
    assert!((wall_top(&w, "WW") - ridge_under).abs() < 1e-6, "{}", wall_top(&w, "WW"));
}

/// [157] Decke mit gekrümmtem Rand (Erker, als Vieleck): keine Fugen zwischen den Facetten der Stirn, die
/// Ober- und Unterkante laufen durch.
#[test]
fn deckenstirn_bogen_ohne_facettenfugen() {
    let mut p = sample();
    p.walls.clear();
    p.openings = Some(vec![]);
    p.roofs = Some(vec![]);
    p.stairs = Some(vec![]);
    let mut ce = p.ceilings.as_ref().unwrap()[0].clone();
    let mut outline = vec![Vec2 { x: 0.0, y: 4.0 }, Vec2 { x: 0.0, y: 0.0 }];
    for k in 0..=12 {
        let t = std::f64::consts::PI * (1.0 + k as f64 / 12.0);
        outline.push(Vec2 { x: 3.0 + 1.5 * t.cos(), y: 1.5 * t.sin() });
    }
    outline.extend([Vec2 { x: 6.0, y: 0.0 }, Vec2 { x: 6.0, y: 4.0 }]);
    ce.outline = outline;
    p.ceilings = Some(vec![ce]);
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
    let (prims, _) = elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    let lines: Vec<(Vec2, Vec2)> = prims.iter().filter_map(|q| match q { Primitive::Line { a, b, cls, .. } if cls.starts_with("elevation-") && cls != "elevation-ground" => Some((*a, *b)), _ => None }).collect();
    // Ansichts-x = Welt-x + 1: Bogen von 2.5 bis 5.5; innen keine senkrechten Fugen.
    let inner: Vec<f64> = lines.iter().filter(|(a, b)| (a.x - b.x).abs() < 1e-6 && a.x > 2.7 && a.x < 5.3).map(|(a, _)| a.x).collect();
    assert!(inner.is_empty(), "Facetten-Fugen: {inner:?}");
    // Oberkante über den Bogen 2.5..5.5 lückenlos.
    let top = lines.iter().filter(|(a, b)| (a.y - b.y).abs() < 1e-6).map(|(a, _)| a.y).fold(f64::NEG_INFINITY, f64::max);
    let mut segs: Vec<(f64, f64)> = lines.iter().filter(|(a, b)| (a.y - top).abs() < 1e-6 && (b.y - top).abs() < 1e-6).map(|(a, b)| (a.x.min(b.x), a.x.max(b.x))).collect();
    segs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut reach = 2.5;
    for (x0, x1) in &segs {
        assert!(*x0 <= reach + 1e-6, "Lücke in der Oberkante bei {reach}: {segs:?}");
        reach = f64::max(reach, *x1);
    }
    assert!(reach >= 5.5 - 1e-6, "Oberkante endet bei {reach}: {segs:?}");
}

/// [157] Erker: Decke bündig mit der Aussenseite einer Bogenwand, aber gröber facettiert. Die Deckenstirn liegt
/// hinter der Wand — keine Stücke ihrer Schichtbänder in der Wandfläche (vorher an jeder Ecke des Deckenrands).
#[test]
fn buendige_deckenstirn_hinter_bogenwand() {
    let mut p = sample();
    p.walls.retain(|w| w.id == "W1");
    p.openings = Some(vec![]);
    p.roofs = Some(vec![]);
    p.stairs = Some(vec![]);
    p.walls[0].bulge = Some(-0.5);
    // Achsbogen: Sehne 5, Pfeil 1.25 ⇒ r = 3.125, Mitte (2.5, 1.875); Aussenseite r + 0.1725.
    let (cx, cy, ro) = (2.5, 1.875, 3.125 + 0.1725);
    let a0 = std::f64::consts::PI + (1.875f64 / 2.5).atan();
    let a1 = 2.0 * std::f64::consts::PI - (1.875f64 / 2.5).atan();
    let mut outline: Vec<Vec2> = (0..=5).map(|k| {
        let a = a0 + (a1 - a0) * k as f64 / 5.0;
        Vec2 { x: cx + ro * a.cos(), y: cy + ro * a.sin() }
    }).collect();
    outline.extend([Vec2 { x: 5.0, y: 4.0 }, Vec2 { x: 0.0, y: 4.0 }]);
    let mut ce = p.ceilings.as_ref().unwrap()[0].clone();
    ce.outline = outline;
    p.ceilings = Some(vec![ce]);
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
    let (prims, _) = elevation_primitives(&p, &level, true, false, &Visibility::default(), 100.0).unwrap().unwrap();
    // Waagrechte Linien in der Wandfläche (Ansichts-x 1.3 … 5.7, unter der Wandkrone 2.6).
    let inner: Vec<(Vec2, Vec2)> = prims.iter().filter_map(|q| match q {
        Primitive::Line { a, b, cls, .. } if cls.starts_with("elevation-") && (a.y - b.y).abs() < 1e-9 && a.y > 0.05 && a.y < 2.6 - 1e-3 && a.x.max(b.x) > 1.3 && a.x.min(b.x) < 5.7 => Some((*a, *b)),
        _ => None,
    }).collect();
    assert!(inner.is_empty(), "Schichtband-Stücke: {inner:?}");
    let shadow: Vec<&Vec<Vec2>> = prims.iter().filter_map(|q| match q { Primitive::Polygon { fill, pts, .. } if fill == SHADOW_FILL => Some(pts), _ => None }).collect();
    assert!(shadow.is_empty(), "Schatten einer bündigen Stirn: {shadow:?}");
}

/// [T2] Bogenwand in der Ansicht: keine Facetten-Fugen der Sehnen-Teilkörper, Umriss bleibt.
#[test]
fn bogenwand_ohne_facettenfugen() {
    let mut p = sample();
    p.walls.retain(|w| w.id == "W1");
    p.openings = Some(vec![]);
    p.roofs = Some(vec![]);
    p.ceilings = Some(vec![]);
    p.stairs = Some(vec![]);
    p.walls[0].bulge = Some(-0.5); // Bogen nach Süden, zur Ansicht hin (vor der Ansichtslinie y = −2)
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
    let (prims, _) = elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    let mut inner = Vec::new();
    let mut all = 0;
    for pr in &prims {
        if let Primitive::Line { a, b, cls, .. } = pr {
            if cls == "elevation-outline" && (a.x - b.x).abs() < 1e-6 {
                all += 1;
                // Ansichts-x = Welt-x + 1 (Ansichtslinie ab x = −1); die Wand reicht von 1 bis 6.
                if a.x > 1.3 && a.x < 5.7 {
                    inner.push(a.x);
                }
            }
        }
    }
    assert!(all >= 2, "Silhouette fehlt");
    assert!(inner.is_empty(), "Facetten-Fugen: {inner:?}");
}

#[test]
fn ansichtsschraffur_und_ansichtsfarbe_der_aussenschicht() {
    let mut p = sample();
    assert!(!render(&p, 50.0).contains("elevation-surface-pattern"), "ohne Muster keine Linien");
    let outer = p.wall_types.iter().find(|t| t.id == "aw").unwrap().layers[0].component_id.clone();
    let c = p.components.iter_mut().find(|c| c.id == outer).unwrap();
    c.elevation_color = Some("#123456".into());
    c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, spacing: 0.1, ..Default::default() });
    let fine = render(&p, 50.0);
    let n_fine = fine.matches("elevation-surface-pattern").count();
    assert!(n_fine > 20, "{n_fine}");
    assert!(fine.contains("#123456"), "Ansichtsfarbe der Aussenschicht");
    let n_mid = render(&p, 200.0).matches("elevation-surface-pattern").count();
    assert!(n_mid < n_fine && n_mid > 0, "{n_mid} vs {n_fine}");
    assert_eq!(render(&p, 2000.0).matches("elevation-surface-pattern").count(), 0, "grob: weggelassen");
}

/// [140] Tusche-Ansicht (Schwarz-Weiss, Standard): keine Materialfarben, Flächen weiss, Glas hellgrau,
/// Schatten und Ansichtsschraffur in neutralem Grau (Schatten bleiben).
#[test]
fn tusche_ansicht_ohne_materialfarben() {
    let mut p = sample();
    let outer = p.wall_types.iter().find(|t| t.id == "aw").unwrap().layers[0].component_id.clone();
    let c = p.components.iter_mut().find(|c| c.id == outer).unwrap();
    c.elevation_color = Some("#c0603a".into());
    c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, spacing: 0.1, color: Some("#a0522d".into()), ..Default::default() });
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
    let (prims, _) = elevation_primitives(&p, &level, true, true, &Visibility::default(), 50.0).unwrap().unwrap();
    let neutral = |c: &str| c == "none" || crate::plan::extras::is_neutral(c);
    let mut shadow = false;
    let mut pattern = false;
    for q in &prims {
        match q {
            Primitive::Polygon { fill, stroke, context_object_id, .. } => {
                assert!(neutral(fill) && neutral(stroke), "bunt: {fill} {stroke}");
                shadow |= context_object_id.as_deref() == Some(crate::plan::extras::SITE_PICK_VIEW_SHADOWS);
            }
            Primitive::Line { cls, color, .. } => {
                let c = color.as_deref().unwrap_or("#000");
                assert!(neutral(c), "bunte Linie {cls}: {c}");
                if cls == "elevation-surface-pattern" {
                    pattern = true;
                    assert_eq!(c, MONO_PATTERN_INK, "Muster grau, nicht schwarz");
                }
            }
            _ => {}
        }
    }
    assert!(shadow && pattern);
    let json = serde_json::to_string(&prims).unwrap();
    assert!(json.contains(GLASS_FILL_MONO) && !json.contains("#c0603a"));
}

/// [G3] Formöffnung: Rahmen als Umriss (viele Ecken), Glas eingerückt; [103] Dachfenster auf der
/// Südfläche sichtbar.
#[test]
fn formoeffnung_und_dachfenster_in_der_ansicht() {
    let mut p = sample();
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.shape = Some(OpeningShape::Rund);
    }
    p.openings.as_mut().unwrap().push(Opening { id: "DF".into(), kind: ElementKind::Window, category_code: "21".into(), width: 0.78, height: 1.18, host_roof_id: Some("RF1".into()), host_point: Some(Vec2 { x: 2.5, y: 1.0 }), ..Default::default() });
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
    let (prims, _) = elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    let polys = |id: &str| -> Vec<usize> { prims.iter().filter_map(|pr| if let Primitive::Polygon { pts, opening_id: Some(o), .. } = pr { (o == id).then_some(pts.len()) } else { None }).collect() };
    let o1 = polys("O1");
    assert!(o1.len() == 2 && o1.iter().all(|n| *n >= 40), "Rahmen + Glas als Ellipse: {o1:?}");
    assert_eq!(polys("DF"), vec![4, 4], "Dachfenster: Rahmen + Glas");
    let first_df = prims.iter().position(|pr| matches!(pr, Primitive::Polygon { opening_id: Some(o), .. } if o == "DF")).unwrap();
    // Dachflächen, die das Dachfenster überdecken (die Traufstirn [G2] liegt davor, berührt es nicht).
    let bb = |pts: &[Vec2]| pts.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q.x), b[1].min(q.y), b[2].max(q.x), b[3].max(q.y)]);
    let Primitive::Polygon { pts: df_pts, .. } = &prims[first_df] else { unreachable!() };
    let d = bb(df_pts);
    let last_roof = prims
        .iter()
        .rposition(|pr| matches!(pr, Primitive::Polygon { roof_id: Some(_), pts, .. } if { let r = bb(pts); r[0] < d[2] && r[2] > d[0] && r[1] < d[3] && r[3] > d[1] }))
        .unwrap();
    assert!(first_df > last_roof, "Dachfenster vor der Dachfläche gezeichnet");
}

/// [169] Rundbogen- und Rundfenster in einer Wand schräg zur Ansicht (40°): die Projektion ist eine Ellipse mit
/// waagrechter Halbachse r · cos 40°. Die Bogenerkennung der Ausgaben findet sie als Ellipsenbogen (SVG `A` mit
/// zwei Radien, DXF ELLIPSE); senkrecht zur Ansicht bleibt es ein Kreisbogen.
#[test]
fn schraeges_rundbogenfenster_als_ellipse() {
    use crate::plan::arc_fit::{fit, Seg, Shape, TOL};
    let mut p = sample();
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.shape = Some(OpeningShape::Rundbogen);
    }
    let ell_of = |prims: &[Primitive]| -> Vec<(f64, f64)> {
        prims
            .iter()
            .filter_map(|pr| if let Primitive::Polygon { pts, opening_id: Some(o), .. } = pr { (o == "O1").then_some(pts) } else { None })
            .filter_map(|pts| {
                let v: Vec<crate::hatch::V2> = pts.iter().map(|q| crate::hatch::V2 { x: q.x, y: q.y }).collect();
                match fit(&v, true, TOL)? {
                    Shape::Path { segs, .. } => segs.iter().find_map(|g| match *g {
                        Seg::Ell { rx, ry, .. } => Some((rx, ry)),
                        Seg::Arc { r, .. } => Some((r, r)),
                        _ => None,
                    }),
                    Shape::Circle { r, .. } => Some((r, r)),
                }
            })
            .collect()
    };
    let view = |line: [Vec2; 2]| {
        let level = LevelSpec { kind: "elevation".into(), line: Some(line), direction_sign: Some(1.0), ..Default::default() };
        elevation_primitives(&p, &level, false, false, &Visibility::default(), 50.0).unwrap().unwrap().0
    };
    // Gerade von vorn: Kreisbögen (rx = ry).
    let front = ell_of(&view([Vec2 { x: -1.0, y: -2.0 }, Vec2 { x: 6.0, y: -2.0 }]));
    assert!(!front.is_empty() && front.iter().all(|(rx, ry)| (rx - ry).abs() < 1e-6), "{front:?}");
    // Schräg: Ellipsenbögen mit rx / ry = cos 40°.
    let a = 40f64.to_radians();
    let oblique = ell_of(&view([Vec2 { x: 2.0, y: -6.0 }, Vec2 { x: 2.0 + 8.0 * a.cos(), y: -6.0 + 8.0 * a.sin() }]));
    assert!(!oblique.is_empty(), "kein Bogen erkannt");
    assert!(oblique.iter().all(|(rx, ry)| (rx / ry - a.cos()).abs() < 1e-6), "{oblique:?}");
}

/// [171] Rundfenster (Ochsenauge, Musterhaus komplex West/Ost): kein Quadrat um den Kreis — die Kanten des
/// Rechteck-Lochs der Wand entfallen, die Fassaden-Schraffur reicht bis an den Rahmen.
#[test]
fn rundfenster_ohne_rechteck_in_der_ansicht() {
    let mut p = sample();
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.shape = Some(OpeningShape::Rund);
        o.height = o.width;
    }
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
    let (prims, _) = elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    let bb = prims.iter().filter_map(|pr| if let Primitive::Polygon { pts, opening_id: Some(o), .. } = pr { (o == "O1").then_some(pts) } else { None }).fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, pts| pts.iter().fold(b, |b, q| [b[0].min(q.x), b[1].min(q.y), b[2].max(q.x), b[3].max(q.y)]));
    assert!(bb[2] > bb[0]);
    let tol = 0.02;
    let near = |a: f64, b: f64| (a - b).abs() < tol;
    let square: Vec<_> = prims
        .iter()
        .filter_map(|pr| if let Primitive::Line { a, b, cls, .. } = pr { (cls == "elevation-outline").then_some((a, b)) } else { None })
        .filter(|(a, b)| {
            let inside = |q: &Vec2| q.x > bb[0] - tol && q.x < bb[2] + tol && q.y > bb[1] - tol && q.y < bb[3] + tol;
            let side = (near(a.x, b.x) && (near(a.x, bb[0]) || near(a.x, bb[2]))) || (near(a.y, b.y) && (near(a.y, bb[1]) || near(a.y, bb[3])));
            inside(a) && inside(b) && side && (a.x - b.x).abs() + (a.y - b.y).abs() > 0.05
        })
        .collect();
    assert!(square.is_empty(), "Rechteck um das Rundfenster: {square:?}");
    // [171] Auch kurze Reststücke der Lochkanten (Strich neben dem Rahmen): im Band von 0.12 m um das Fenster
    // liegt keine Umrisslinie, ausser dem Rahmen selbst.
    let band = 0.12;
    let stubs: Vec<_> = prims
        .iter()
        .filter_map(|pr| if let Primitive::Line { a, b, cls, .. } = pr { (cls == "elevation-outline").then_some((a, b)) } else { None })
        .filter(|(a, b)| {
            let inside = |q: &Vec2| q.x > bb[0] - band && q.x < bb[2] + band && q.y > bb[1] - band && q.y < bb[3] + band;
            inside(a) && inside(b)
        })
        .collect();
    assert!(stubs.is_empty(), "Reststrich am Rundfenster: {stubs:?}");
}

/// [171] Strich rechts am Rundfenster (Ansicht West): ein Reststück der Lochkante im Band (Einzug der Dämmung)
/// ausserhalb des Umrisses entfällt, Kanten der Wand weiter weg bleiben.
#[test]
fn lochkanten_im_band_der_formoeffnung() {
    use super::silhouette::EdgeSeg;
    let e = |a: Pt, b: Pt| EdgeSeg { a, b, hidden: false, owner: 1 };
    let b = [14.45, 6.75, 15.55, 7.9];
    let mut edges = vec![
        e([15.55, 7.7], [15.6, 7.7]),     // Strich im Band rechts: weg
        e([15.6, 6.8], [15.6, 7.8]),      // Lochkante im Band: weg
        e([14.45, 6.75], [15.55, 6.75]),  // Seite auf dem Umriss: weg
        e([15.55, 7.7], [16.5, 7.7]),     // Wandkante, reicht weit hinaus: bleibt
        e([10.0, 7.7], [11.0, 7.7]),      // woanders: bleibt
        e([15.0, 7.0], [15.2, 7.1]),      // im Umriss, quer: bleibt (Rahmen/Verdecker entscheiden)
    ];
    drop_hole_edges(&mut edges, b);
    let left: Vec<_> = edges.iter().map(|e| (e.a, e.b)).collect();
    assert_eq!(left, vec![([15.55, 7.7], [16.5, 7.7]), ([10.0, 7.7], [11.0, 7.7]), ([15.0, 7.0], [15.2, 7.1])]);
}

/// [105] Umfassungszarge in der Ansicht: Spiegel über die Rohbaukante hinaus (Rahmen breiter als
/// die Öffnung), Blatt um die Zarge eingerückt.
#[test]
fn zargenspiegel_in_der_ansicht() {
    let mut p = sample();
    let o1 = p.openings.iter().flatten().find(|o| o.id == "O1").unwrap().clone();
    let frame_w = |p: &Project| -> f64 {
        let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let (prims, _) = elevation_primitives(p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
        let pr = prims.iter().find(|pr| matches!(pr, Primitive::Polygon { opening_id: Some(o), .. } if o == "O1")).unwrap();
        let Primitive::Polygon { pts, .. } = pr else { unreachable!() };
        pts.iter().map(|q| q.x).fold(f64::NEG_INFINITY, f64::max) - pts.iter().map(|q| q.x).fold(f64::INFINITY, f64::min)
    };
    let door = |kind: Option<DoorTypeFrameKind>| {
        let mut q = p.clone();
        q.door_types = Some(vec![DoorType { id: "dt".into(), frame_kind: kind, ..Default::default() }]);
        for o in q.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.kind = ElementKind::Door;
            o.type_id = Some("dt".into());
            o.sill_height = 0.0;
        }
        q
    };
    // [105] Zarge (Vorgabe): Bekleidung 2 cm über die Rohbaukante; Blockrahmen in der Leibung.
    let plain = frame_w(&door(None));
    assert!((plain - o1.width - 0.04).abs() < 1e-6, "{plain}");
    let block = frame_w(&door(Some(DoorTypeFrameKind::Blockrahmen)));
    assert!((block - o1.width).abs() < 1e-6, "{block}");
    let zarge = frame_w(&door(Some(DoorTypeFrameKind::Umfassungszarge)));
    assert!((zarge - o1.width - 0.1).abs() < 1e-6, "{zarge}");
    p.openings = None;
}

/// Beispielhaus n × n gekachelt (wie `bigSampleProject.testing.ts`): Wände, Öffnungen, Decken, Dächer.
fn big_sample(n: usize, pitch: f64) -> Project {
    let s = sample();
    let mut p = s.clone();
    p.walls.clear();
    let (mut ops, mut ceils, mut roofs) = (Vec::new(), Vec::new(), Vec::new());
    for i in 0..n {
        for j in 0..n {
            let (dx, dy) = (i as f64 * pitch, j as f64 * pitch);
            let sfx = format!("_{i}_{j}");
            let sh = |q: &Vec2| Vec2 { x: q.x + dx, y: q.y + dy };
            for w in &s.walls {
                let mut w = w.clone();
                w.id += &sfx;
                (w.start, w.end) = (sh(&w.start), sh(&w.end));
                p.walls.push(w);
            }
            for o in s.openings.iter().flatten() {
                let mut o = o.clone();
                o.id += &sfx;
                o.host_wall_id += &sfx;
                ops.push(o);
            }
            for c in s.ceilings.iter().flatten() {
                let mut c = c.clone();
                c.id += &sfx;
                c.outline = c.outline.iter().map(sh).collect();
                ceils.push(c);
            }
            for r in s.roofs.iter().flatten() {
                let mut r = r.clone();
                r.id += &sfx;
                r.outline = r.outline.iter().map(sh).collect();
                roofs.push(r);
            }
        }
    }
    (p.openings, p.ceilings, p.roofs) = (Some(ops), Some(ceils), Some(roofs));
    p.stairs = None;
    p.rooms = None;
    p
}

/// Leistungswächter ([G2]-Verdeckung): Die Ansicht des 8×8 gekachelten Beispiels dauerte nach dem
/// Wand↔Dach-Anschluss Sekunden (jeder Sichtstrahl gegen alle Dächer/Stirnen/Gauben). Grosszügige
/// Schranke (auch Debug-Build unter Last); `cargo test --release … -- --ignored --nocapture
/// ansicht_gross_messen` misst genauer.
#[test]
fn ansicht_gross_schnell() {
    let p = big_sample(8, 8.0);
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
    let t0 = std::time::Instant::now();
    let (prims, _) = elevation_primitives(&p, &level, true, false, &Visibility::default(), 100.0).unwrap().unwrap();
    let ms = t0.elapsed().as_secs_f64() * 1e3;
    assert!(prims.len() > 1000);
    // Schranke gegen einen Rückfall um Grössenordnungen, nicht gegen Rauschen: parallele Builds/Agents
    // lasten die Maschine aus (unter Last bis ~15 s im Debug-Build gemessen).
    let limit = if cfg!(debug_assertions) { 40_000.0 } else { 20_000.0 };
    assert!(ms < limit, "Ansicht 8×8: {ms:.0} ms");
}

#[test]
#[ignore]
fn ansicht_gross_messen() {
    for n in [8usize, 16] {
        let p = big_sample(n, 8.0);
        let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let t0 = std::time::Instant::now();
        let runs = 3;
        for _ in 0..runs {
            elevation_primitives(&p, &level, true, false, &Visibility::default(), 100.0).unwrap().unwrap();
        }
        println!("Ansicht {n}×{n}: {:.1} ms", t0.elapsed().as_secs_f64() * 1e3 / runs as f64);
    }
}

/// Kleines Projekt für [132]: Geschoss F, Ansicht Süd (Blick nach Norden) und West, frei stehendes
/// Dach ohne Wände bis ans Dach, dazu Stützen.
fn proj132(roofs: serde_json::Value, columns: serde_json::Value) -> Project {
    serde_json::from_value(serde_json::json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [], "openings": [],
        "drawingLevels": [
            {"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
            {"id": "s", "name": "S", "kind": "elevation", "visible": true, "locked": false, "linePoints": [{"x": -2, "y": -3}, {"x": 12, "y": -3}], "directionSign": 1},
            {"id": "w", "name": "W", "kind": "elevation", "visible": true, "locked": false, "linePoints": [{"x": -3, "y": 10}, {"x": -3, "y": -2}], "directionSign": 1}
        ],
        "walls": [],
        "roofs": roofs,
        "columns": columns
    }))
    .unwrap()
}

fn view132(p: &Project, id: &str) -> Vec<Primitive> {
    let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
    elevation_primitives(p, &LevelSpec::from_json(&serde_json::to_value(l).unwrap()), false, false, &Visibility::default(), 100.0).unwrap().unwrap().0
}

fn outline_lines(prims: &[Primitive]) -> Vec<(Vec2, Vec2)> {
    prims.iter().filter_map(|q| match q { Primitive::Line { a, b, cls, .. } if cls == "elevation-outline" => Some((*a, *b)), _ => None }).collect()
}

/// [132] Flachdach in der Ansicht: die Stirn (Dicke des Aufbaus) erscheint als Band mit Ober- und
/// Unterkante, nicht als nichts (die Dachfläche liegt auf der Kante).
#[test]
fn flachdach_zeigt_stirn_in_der_ansicht() {
    let p = proj132(
        serde_json::json!([{"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35",
            "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}],
            "shape": "flach", "pitchDeg": 0, "overhang": 0, "ridgeAxis": "x", "baseElevation": 3.0, "thickness": 0.4}]),
        serde_json::json!([]),
    );
    for id in ["s", "w"] {
        let prims = view132(&p, id);
        let roof: Vec<&Primitive> = prims.iter().filter(|q| matches!(q, Primitive::Polygon { roof_id: Some(r), .. } if r == "R")).collect();
        assert!(!roof.is_empty(), "{id}: keine Dachfläche");
        let (lo, hi) = roof.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), q| match q {
            Primitive::Polygon { pts, .. } => pts.iter().fold((lo, hi), |(lo, hi), v| (lo.min(v.y), hi.max(v.y))),
            _ => (lo, hi),
        });
        assert!((hi - lo - 0.4).abs() < 1e-6, "{id}: Stirnband {lo}..{hi}");
        // Ober- und Unterkante als waagrechte Linien über die ganze Breite.
        let lines = outline_lines(&prims);
        for z in [lo, hi] {
            assert!(lines.iter().any(|(a, b)| (a.y - z).abs() < 1e-6 && (b.y - z).abs() < 1e-6 && (a.x - b.x).abs() > 7.9), "{id}: Kante bei {z} fehlt");
        }
    }
}

/// [169] Flachdach mit gekrümmtem Rand (Erker als Vieleck): die Stirn zeigt in der Ansicht keine senkrechten
/// Fugen an den Facetten, nur ihre Ober- und Unterkante und die echten Ecken.
#[test]
fn dachstirn_bogen_ohne_facettenfugen() {
    let mut outline = vec![serde_json::json!({"x": 0, "y": 8}), serde_json::json!({"x": 0, "y": 0}), serde_json::json!({"x": 2, "y": 0})];
    for k in 1..12 {
        let t = std::f64::consts::PI * (1.0 + k as f64 / 12.0);
        outline.push(serde_json::json!({"x": 5.0 + 3.0 * t.cos(), "y": 3.0 * t.sin()}));
    }
    outline.extend([serde_json::json!({"x": 8, "y": 0}), serde_json::json!({"x": 10, "y": 0}), serde_json::json!({"x": 10, "y": 8})]);
    let p = proj132(
        serde_json::json!([{"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35", "outline": outline,
            "shape": "flach", "pitchDeg": 0, "overhang": 0, "ridgeAxis": "x", "baseElevation": 3.0, "thickness": 0.4}]),
        serde_json::json!([]),
    );
    let prims = view132(&p, "s");
    // Ansichts-x = Welt-x + 2: Bogen von 4 bis 10; innen keine senkrechten Fugen.
    let inner: Vec<f64> = outline_lines(&prims).iter().filter(|(a, b)| (a.x - b.x).abs() < 1e-6 && a.x > 4.2 && a.x < 9.8).map(|(a, _)| a.x).collect();
    assert!(inner.is_empty(), "Facetten-Fugen: {inner:?}");
    // Ober- und Unterkante der Stirn bleiben.
    let lines = outline_lines(&prims);
    let (lo, hi) = prims.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), q| match q {
        Primitive::Polygon { pts, roof_id: Some(_), .. } => pts.iter().fold((lo, hi), |(lo, hi), v| (lo.min(v.y), hi.max(v.y))),
        _ => (lo, hi),
    });
    assert!((hi - lo - 0.4).abs() < 1e-6, "{lo}..{hi}");
    for z in [lo, hi] {
        let mut segs: Vec<(f64, f64)> = lines.iter().filter(|(a, b)| (a.y - z).abs() < 1e-6 && (b.y - z).abs() < 1e-6).map(|(a, b)| (a.x.min(b.x), a.x.max(b.x))).collect();
        segs.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut reach = 4.0;
        for (x0, x1) in &segs {
            if *x0 <= reach + 1e-6 {
                reach = reach.max(*x1);
            }
        }
        assert!(reach >= 10.0 - 1e-6, "Kante bei {z} endet bei {reach}: {segs:?}");
    }
}

/// [132] Stützen erscheinen in der Ansicht (Fläche mit Pick-Id, Umriss); runde ohne Facettenfugen.
/// [140] Ansicht: Silhouette des Baukörpers mittel (0.35), innere Kanten fein (0.13), Grundlinie schwer.
#[test]
fn silhouette_mittel_details_fein() {
    let p = proj132(
        serde_json::json!([]),
        serde_json::json!([
            {"id": "C1", "type": "column", "floorId": "F", "categoryCode": "25", "position": {"x": 2, "y": 2}, "profile": {"kind": "rect", "width": 0.2, "depth": 0.2}, "rotation": 0, "height": 2.5},
            {"id": "C2", "type": "column", "floorId": "F", "categoryCode": "25", "position": {"x": 2, "y": 4}, "profile": {"kind": "rect", "width": 0.6, "depth": 0.2}, "rotation": 0, "height": 1.5}
        ]),
    );
    let prims = view132(&p, "s");
    let ws: Vec<f64> = prims.iter().filter_map(|q| match q { Primitive::Line { cls, weight_mm, .. } if cls == "elevation-outline" => Some(*weight_mm), _ => None }).collect();
    assert!(ws.contains(&SILHOUETTE_MM), "Silhouette fehlt: {ws:?}");
    // C1 (schmal, vorne) steht vor C2 (breiter, niedriger): die Oberkante von C2 ist Silhouette, die
    // Kanten von C1 innerhalb von C2 sind fein.
    assert!(ws.contains(&EDGE_MM), "innere Kanten fehlen: {ws:?}");
    assert!(GROUND_MM > SILHOUETTE_MM && SILHOUETTE_MM > EDGE_MM);
}

#[test]
fn stuetzen_in_der_ansicht() {
    let p = proj132(
        serde_json::json!([]),
        serde_json::json!([
            {"id": "C1", "type": "column", "floorId": "F", "categoryCode": "25", "position": {"x": 2, "y": 2}, "profile": {"kind": "rect", "width": 0.2, "depth": 0.2}, "rotation": 0, "height": 2.5},
            {"id": "C2", "type": "column", "floorId": "F", "categoryCode": "25", "position": {"x": 6, "y": 2}, "profile": {"kind": "round", "radius": 0.15}, "rotation": 0, "height": 2.5}
        ]),
    );
    let prims = view132(&p, "s");
    for id in ["C1", "C2"] {
        assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { column_id: Some(c), .. } if c == id)), "{id} fehlt");
    }
    // Senkrechte Kanten: je Stütze genau zwei (links, rechts), keine Facettenfugen der runden.
    let verticals = outline_lines(&prims).into_iter().filter(|(a, b)| (a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() > 1.0).count();
    assert_eq!(verticals, 4);
}

/// [36] Ansichtsbereich in der Ansicht: Bauteile ganz hinter der Tiefe entfallen; ohne Tiefe alle da.
#[test]
fn tiefe_blendet_ferne_bauteile_in_der_ansicht_aus() {
    let mut p = proj132(
        serde_json::json!([]),
        serde_json::json!([
            {"id": "C1", "type": "column", "floorId": "F", "categoryCode": "25", "position": {"x": 2, "y": 2}, "profile": {"kind": "rect", "width": 0.2, "depth": 0.2}, "rotation": 0, "height": 2.5},
            {"id": "C2", "type": "column", "floorId": "F", "categoryCode": "25", "position": {"x": 6, "y": 12}, "profile": {"kind": "rect", "width": 0.2, "depth": 0.2}, "rotation": 0, "height": 2.5}
        ]),
    );
    let has = |prims: &[Primitive], id: &str| prims.iter().any(|q| matches!(q, Primitive::Polygon { column_id: Some(c), .. } if c == id));
    let all = view132(&p, "s");
    assert!(has(&all, "C1") && has(&all, "C2"));
    let n_all = outline_lines(&all).len();
    p.drawing_levels.iter_mut().find(|l| l.id == "s").unwrap().depth = Some(8.0);
    let near = view132(&p, "s");
    assert!(has(&near, "C1"), "C1 liegt 5 m hinter der Ebene");
    assert!(!has(&near, "C2"), "C2 liegt 15 m hinter der Ebene");
    assert!(outline_lines(&near).len() < n_all, "Kanten der fernen Stütze entfallen");
}

fn ov_rule(id: &str, conds: serde_json::Value, actions: serde_json::Value) -> OverrideRule {
    let c = conds.as_array().unwrap();
    serde_json::from_value(serde_json::json!({"id": id, "name": id, "enabled": true, "condition": c[0], "conditions": c[1..].to_vec(), "actions": actions})).unwrap()
}

fn render_rules(p: &Project, mono: bool, on: Option<&HashSet<String>>) -> Vec<Primitive> {
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
    elevation_primitives_with(p, &level, false, mono, &Visibility::default(), 50.0, on).unwrap().unwrap().0
}

fn wall_fills(prims: &[Primitive]) -> Vec<String> {
    prims.iter().filter_map(|q| match q { Primitive::Polygon { wall_id: Some(_), fill, .. } => Some(fill.clone()), _ => None }).collect()
}

/// [33] Element-Regeln wirken auf Ansichtsflächen und -kanten: Füllung, Linienfarbe/-stärke, Umriss aus,
/// ausblenden; Kriterium Darstellung (`view_kind`). Ohne passende Regel unverändert.
#[test]
fn override_regeln_in_der_ansicht() {
    let mut p = sample();
    let base = serde_json::to_string(&render_rules(&p, false, None)).unwrap();
    // Regel nur für den Grundriss: Ansicht unverändert.
    p.override_rules = Some(vec![ov_rule("r-plan", serde_json::json!([{"type": "view_kind", "operator": "equals", "value": "plan"}]), serde_json::json!({"fillColor": "#ff0000", "hide": true}))]);
    assert_eq!(serde_json::to_string(&render_rules(&p, false, None)).unwrap(), base);
    // Ausgeschaltet: unverändert.
    p.override_rules = Some(vec![ov_rule("r1", serde_json::json!([{"type": "view_kind", "operator": "equals", "value": "elevation"}, {"type": "element_kind", "operator": "equals", "value": "wall"}]), serde_json::json!({"fillColor": "#ff0000", "color": "#00aa00", "lineweight": 0.5}))]);
    p.override_rules.as_mut().unwrap()[0].enabled = false;
    assert_eq!(serde_json::to_string(&render_rules(&p, false, None)).unwrap(), base);
    // Eingeschaltet (auch über die Regel-ids eines Ausschnitts).
    let on: HashSet<String> = ["r1".to_string()].into();
    for prims in [render_rules(&p, true, Some(&on)), { p.override_rules.as_mut().unwrap()[0].enabled = true; render_rules(&p, true, None) }] {
        let fills = wall_fills(&prims);
        assert!(!fills.is_empty() && fills.iter().all(|f| f == "#ff0000"), "{fills:?}");
        assert!(prims.iter().any(|q| matches!(q, Primitive::Line { color: Some(c), weight_mm, .. } if c == "#00aa00" && (*weight_mm - 0.5).abs() < 1e-9)));
        // Dach unverändert (Bauteilart Wand).
        assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { roof_id: Some(_), fill, .. } if fill == "#ffffff")));
    }
    // Umriss aus: keine Kanten in der Regelfarbe; Dach ausblenden: keine Dachflächen.
    p.override_rules = Some(vec![
        ov_rule("r2", serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "roof"}]), serde_json::json!({"hide": true})),
        ov_rule("r3", serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "wall"}]), serde_json::json!({"outline": false})),
    ]);
    let prims = render_rules(&p, false, None);
    assert!(!prims.iter().any(|q| matches!(q, Primitive::Polygon { roof_id: Some(_), .. })), "Dach ausgeblendet");
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { wall_id: Some(_), .. })));
    let n_edges = |prims: &[Primitive]| prims.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "elevation-outline")).count();
    p.override_rules.as_mut().unwrap()[1].enabled = false;
    assert!(n_edges(&prims) < n_edges(&render_rules(&p, false, None)), "Wandkanten ohne Umriss");
}

/// [33] Linienstil in der Ansicht (Element- und Schicht-Regel), Schlagschatten und Gelände über Regeln
/// (Bauteilart „Schatten“/„Gelände“: Füllung, Linie, Ausblenden); allgemeine Regeln lassen beide in Ruhe.
#[test]
fn linienstil_schatten_und_gelaende_in_der_ansicht() {
    let mut p = sample();
    p.context = Some(vec![ContextObject::TerrainMesh(TerrainMesh {
        id: "t".into(),
        name: "Gelände".into(),
        positions: vec![-50.0, -50.0, -0.5, 50.0, -50.0, -0.5, 50.0, 50.0, 0.3, -50.0, 50.0, 0.3],
        indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
        ..Default::default()
    })]);
    let render = |p: &Project| {
        let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
        elevation_primitives_with(p, &LevelSpec::from_json(&serde_json::to_value(l).unwrap()), true, false, &Visibility::default(), 50.0, None).unwrap().unwrap().0
    };
    let dashed = |prims: &[Primitive]| prims.iter().filter(|q| matches!(q, Primitive::Line { cls, dash: Some(Some(m)), .. } if cls.starts_with("elevation-outline") && m == &vec![0.35, 0.3])).count();
    let shadows = |prims: &[Primitive]| prims.iter().filter_map(|q| match q { Primitive::Polygon { fill, context_object_id: Some(id), .. } if id == crate::plan::extras::SITE_PICK_VIEW_SHADOWS => Some(fill.clone()), _ => None }).collect::<Vec<_>>();
    let terrain = |prims: &[Primitive]| prims.iter().filter_map(|q| match q { Primitive::Line { cls, color, dash, .. } if cls == "elevation-terrain" => Some((color.clone(), dash.clone())), _ => None }).collect::<Vec<_>>();
    let mask = |prims: &[Primitive]| prims.iter().filter_map(|q| match q { Primitive::Polygon { fill, context_object_id: Some(id), .. } if id == "t" => Some(fill.clone()), _ => None }).collect::<Vec<_>>();
    let base = render(&p);
    assert_eq!(dashed(&base), 0);
    assert!(!shadows(&base).is_empty() && !terrain(&base).is_empty() && !mask(&base).is_empty());
    // Linienstil: Element-Regel (Wand) und Schicht-Regel (Baustoff der sichtbaren Schicht).
    p.override_rules = Some(vec![ov_rule("w", serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "wall"}]), serde_json::json!({"linetypeId": "hatch-dash"}))]);
    assert!(dashed(&render(&p)) > 0);
    p.override_rules = Some(vec![ov_rule("m", serde_json::json!([{"type": "material", "operator": "equals", "value": "Aussenputz"}]), serde_json::json!({"linetypeId": "hatch-dash"}))]);
    assert!(dashed(&render(&p)) > 0);
    // Allgemeine Regel („Ansicht ohne Materialschraffur“-artig): Schatten und Gelände bleiben.
    p.override_rules = Some(vec![ov_rule("g", serde_json::json!([{"type": "element_kind", "operator": "not_equals", "value": "opening"}]), serde_json::json!({"fillColor": "#ffffff", "color": "#ff0000"}))]);
    let prims = render(&p);
    assert_eq!(shadows(&prims), shadows(&base));
    assert_eq!(terrain(&prims), terrain(&base));
    // Schatten: Füllung, dann ausblenden.
    p.override_rules = Some(vec![ov_rule("s", serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "shadow"}]), serde_json::json!({"fillColor": "#3355ff"}))]);
    let s = shadows(&render(&p));
    assert!(!s.is_empty() && s.iter().all(|f| f == "#3355ff"));
    p.override_rules.as_mut().unwrap()[0].actions.hide = Some(true);
    let prims = render(&p);
    assert!(shadows(&prims).is_empty());
    assert!(!prims.iter().any(|q| matches!(q, Primitive::Polygon { fill, .. } if fill == OPENING_SHADOW_FILL)), "Leibungsschatten auch");
    // Gelände: Linie (Farbe, Linienstil) und Füllung, dann ausblenden (Grundlinie statt Silhouette).
    p.override_rules = Some(vec![ov_rule("t", serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "terrain"}]), serde_json::json!({"color": "#00aa00", "linetypeId": "hatch-dash", "fillColor": "#eeeeee"}))]);
    let prims = render(&p);
    assert!(terrain(&prims).iter().all(|(c, d)| c.as_deref() == Some("#00aa00") && d == &Some(Some(vec![0.35, 0.3]))));
    assert!(mask(&prims).iter().all(|f| f == "#eeeeee"));
    p.override_rules.as_mut().unwrap()[0].actions.hide = Some(true);
    let prims = render(&p);
    assert!(terrain(&prims).is_empty() && mask(&prims).is_empty());
    assert!(prims.iter().any(|q| matches!(q, Primitive::Line { cls, .. } if cls == "elevation-ground")));
}

/// [33] Baustoff-Kriterium greift auf die sichtbare Oberflächenschicht (äusserste Wandschicht, Dachdeckung);
/// Schraffur „ohne“ unterdrückt die Ansichtsschraffur, eine Projekt-Schraffur legt sie auf die Fläche.
#[test]
fn override_baustoff_der_oberflaeche_und_schraffur() {
    let mut p = sample();
    let c = p.components.iter_mut().find(|c| c.id == "render-ext").unwrap();
    c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, spacing: 0.1, ..Default::default() });
    let n_pat = |prims: &[Primitive]| prims.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "elevation-surface-pattern")).count();
    assert!(n_pat(&render_rules(&p, false, None)) > 20);
    // Tragende Schicht (Backstein) ist nicht sichtbar: Regel greift nicht.
    p.override_rules = Some(vec![ov_rule("b", serde_json::json!([{"type": "material", "operator": "equals", "value": "Backstein"}]), serde_json::json!({"fillColor": "#ff0000"}))]);
    assert!(!wall_fills(&render_rules(&p, false, None)).iter().any(|f| f == "#ff0000"));
    p.override_rules = Some(vec![ov_rule("a", serde_json::json!([{"type": "material", "operator": "equals", "value": "Aussenputz"}]), serde_json::json!({"fillColor": "#ff0000", "hatch": "none"}))]);
    let prims = render_rules(&p, false, None);
    assert!(wall_fills(&prims).iter().any(|f| f == "#ff0000"), "Aussenputz = sichtbare Schicht");
    assert_eq!(n_pat(&prims), 0, "Schraffur ohne");
    // Dachdeckung (erste Schicht des Dachtyps).
    p.roof_types = Some(vec![serde_json::from_value(serde_json::json!({"id": "rt", "name": "Ziegeldach", "layers": [{"componentId": "roof-tiles", "thickness": 0.05}, {"componentId": "concrete", "thickness": 0.2}]})).unwrap()]);
    p.roofs.as_mut().unwrap()[0].roof_type_id = Some("rt".into());
    p.override_rules = Some(vec![ov_rule("d", serde_json::json!([{"type": "material", "operator": "equals", "value": "Dachziegel"}]), serde_json::json!({"fillColor": "#0000ff"}))]);
    let prims = render_rules(&p, false, None);
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { roof_id: Some(_), fill, .. } if fill == "#0000ff")));
    assert!(!wall_fills(&prims).iter().any(|f| f == "#0000ff"));
    // Projekt-Schraffur auf der Fläche statt Ansichtsschraffur.
    let hid = p.hatches.iter().find(|h| h.id == "diagonal").map(|h| h.id.clone()).expect("Schraffur im Beispiel");
    p.override_rules = Some(vec![ov_rule("h", serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "wall"}]), serde_json::json!({"hatch": hid}))]);
    let prims = render_rules(&p, false, None);
    assert_eq!(n_pat(&prims), 0);
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { wall_id: Some(_), hatch, .. } if hatch.pattern != HatchPattern::None)));
}

/// [33] Öffnungen: Linienfarbe/-stärke und Glasfüllung aus Regeln; ausgeblendete Wand nimmt ihre Öffnungen mit.
#[test]
fn override_oeffnungen_in_der_ansicht() {
    let mut p = sample();
    p.override_rules = Some(vec![ov_rule("o", serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "opening"}]), serde_json::json!({"color": "#00aa00", "fillColor": "#999999"}))]);
    let prims = render_rules(&p, true, None);
    let ops: Vec<&Primitive> = prims.iter().filter(|q| matches!(q, Primitive::Polygon { opening_id: Some(_), .. })).collect();
    assert!(!ops.is_empty() && ops.iter().all(|q| matches!(q, Primitive::Polygon { stroke, .. } if stroke == "#00aa00" || stroke == "none")));
    assert!(ops.iter().any(|q| matches!(q, Primitive::Polygon { fill, .. } if fill == "#999999")));
    p.override_rules = Some(vec![ov_rule("w", serde_json::json!([{"type": "object_name", "operator": "contains", "value": "Aussenwand"}]), serde_json::json!({"hide": true}))]);
    let prims = render_rules(&p, true, None);
    assert!(!prims.iter().any(|q| matches!(q, Primitive::Polygon { opening_id: Some(_), .. })), "Öffnungen der ausgeblendeten Wände entfallen");
}

/// [33] Mitgelieferter Baustein „Ansicht ohne Materialschraffur“: Flächen weiss ohne Ansichtsschraffur und
/// Ansichtsfarbe, Fenster bleiben grau; im Grundriss/Schnitt wirkungslos (Kriterium Darstellung).
#[test]
fn baustein_ansicht_ohne_materialschraffur() {
    let mut p = sample();
    let c = p.components.iter_mut().find(|c| c.id == "render-ext").unwrap();
    c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, spacing: 0.1, ..Default::default() });
    c.elevation_color = Some("#c0603a".into());
    let mut rules: Vec<OverrideRule> = crate::standards::override_rules().into_iter().map(|v| serde_json::from_value(v).unwrap()).collect();
    let r = rules.iter_mut().find(|r| r.id == crate::standards::STD_RULE_ELEVATION_PLAIN).unwrap();
    assert!(!r.enabled, "ausgeschaltet geliefert");
    r.enabled = true;
    p.override_rules = Some(rules);
    let prims = render_rules(&p, false, None);
    let json = serde_json::to_string(&prims).unwrap();
    assert!(!json.contains("elevation-surface-pattern") && !json.contains("#c0603a"), "ohne Schraffur und Ansichtsfarbe");
    assert!(wall_fills(&prims).iter().all(|f| f == "#ffffff"));
    assert!(json.contains(GLASS_FILL_COLOR), "Fenster grau");
    let rv = super::super::overrides::RuleView::at(100.0, None);
    let s = super::super::overrides::Subject { element_kind: Some("wall"), ..Default::default() };
    assert!(super::super::overrides::effective_layer(p.override_rules.as_deref(), &s, rv.view("section")).fill_color.is_none());
    assert!(super::super::overrides::effective_layer(p.override_rules.as_deref(), &s, rv.view("plan")).fill_color.is_none());
}

/// [171] Einfaches Musterhaus, Ansicht Süd: die OG-Wände unter dem Satteldach (Teilkörper je Schichtlage, quer
/// versetzt) werden an den Ecken verlängert wie im EG — keine zurückspringenden Eckstreifen mit Fuge und Schatten.
#[test]
fn ecken_der_wand_unter_dem_dach_ohne_fuge() {
    let p = sample();
    let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
    let (prims, _) = elevation_primitives(&p, &level, false, true, &Visibility::default(), 100.0).unwrap().unwrap();
    // u = x + 1 (Ansichtslinie ab x = −1): Wandachse der Ecken bei u = 1 bzw. 6, Aussenfläche bei 0.8275 / 6.1725.
    let seams: Vec<_> = prims
        .iter()
        .filter_map(|q| if let Primitive::Line { a, b, cls, .. } = q { (cls == "elevation-outline").then_some((a, b)) } else { None })
        .filter(|(a, b)| (a.x - b.x).abs() < 1e-6 && ((a.x - 1.0).abs() < 1e-3 || (a.x - 6.0).abs() < 1e-3) && a.y.min(b.y) >= 2.6 - 1e-6)
        .collect();
    assert!(seams.is_empty(), "Fugen an den OG-Ecken: {seams:?}");
}

