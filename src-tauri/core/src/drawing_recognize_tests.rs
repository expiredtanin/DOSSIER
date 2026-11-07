//! Tests zu [154] Bauteile aus Zeichnung erkennen: synthetische Grundrisse (L-Haus mit T- und Kreuzstoss,
//! Bogenwand, Tür mit Bogen, Fenster, Durchbruch, Raumtexte), Layer-Filter, Schichtlinie, Ops, Unsinn.

use super::*;
use serde_json::json;

const EPS: f64 = 1e-6;

struct B {
    inp: Input,
}

impl B {
    fn new() -> B {
        B { inp: Input::default() }
    }
    fn line(&mut self, layer: &str, a: V, b: V) -> &mut B {
        let l = self.inp.layer(layer);
        self.inp.segs.push(Seg { a, b, layer: l });
        self
    }
    /// Geschlossener Linienzug (Polylinie als Kanten).
    fn ring(&mut self, layer: &str, pts: &[V]) -> &mut B {
        for i in 0..pts.len() {
            self.line(layer, pts[i], pts[(i + 1) % pts.len()]);
        }
        self
    }
    fn rect(&mut self, layer: &str, x0: f64, y0: f64, x1: f64, y1: f64) -> &mut B {
        self.ring(layer, &[(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
    }
    fn arc(&mut self, layer: &str, c: V, r: f64, a0_deg: f64, sweep_deg: f64) -> &mut B {
        let l = self.inp.layer(layer);
        self.inp.arcs.push(ArcIn { c, r, a0: a0_deg.to_radians(), sweep: sweep_deg.to_radians(), layer: l });
        self
    }
    fn text(&mut self, at: V, t: &str, h: f64) -> &mut B {
        self.inp.texts.push(TextIn { at, text: t.into(), h, angle: 0.0 });
        self
    }
}

fn near(a: V, b: V, tol: f64) -> bool {
    len(sub(a, b)) <= tol
}

/// Wand mit Achse a–b (beide Richtungen).
fn has_wall(r: &Recognition, a: V, b: V, t: f64) -> bool {
    r.walls.iter().any(|w| (w.t - t).abs() < 1e-6 && ((near(w.a, a, 1e-6) && near(w.b, b, 1e-6)) || (near(w.a, b, 1e-6) && near(w.b, a, 1e-6))))
}

/// L-Haus (Achsen 12×6 + 6×4, Aussenwände 30 cm) mit zwei Innenwänden 15 cm: T-Stösse bei (6,0) und (0,6),
/// Kreuz bei (6,6). Zeichnung wie aus CAD: Aussenumriss + Raumumrisse (lichte Masse).
fn l_house() -> B {
    let mut b = B::new();
    b.ring("A-WALL", &[(-0.15, -0.15), (12.15, -0.15), (12.15, 6.15), (6.15, 6.15), (6.15, 10.15), (-0.15, 10.15)]);
    b.rect("A-WALL", 0.15, 0.15, 5.925, 5.925); // A1
    b.rect("A-WALL", 0.15, 6.075, 5.85, 9.85); // A2
    b.rect("A-WALL", 6.075, 0.15, 11.85, 5.85); // B
    b
}

#[test]
fn l_haus_mit_t_und_kreuzstoss() {
    let mut b = l_house();
    b.text((1.0, 3.0), "Wohnen", 0.35).text((1.0, 2.5), "33.35 m²", 0.25).text((1.0, 2.0), "HNF", 0.25);
    b.text((7.0, 3.0), "Küche", 0.35).text((1.0, 8.0), "Zimmer", 0.35).text((1.0, 7.5), "1.07", 0.2);
    let r = analyze(&b.inp);
    assert!(r.layer_filter);
    assert_eq!(r.walls.len(), 8, "{:#?}", r.walls);
    for (a, bb, t) in [
        ((0.0, 0.0), (12.0, 0.0), 0.3),
        ((12.0, 0.0), (12.0, 6.0), 0.3),
        ((12.0, 6.0), (6.0, 6.0), 0.3),
        ((6.0, 6.0), (6.0, 10.0), 0.3),
        ((6.0, 10.0), (0.0, 10.0), 0.3),
        ((0.0, 10.0), (0.0, 0.0), 0.3),
        ((6.0, 0.0), (6.0, 6.0), 0.15),
        ((0.0, 6.0), (6.0, 6.0), 0.15),
    ] {
        assert!(has_wall(&r, a, bb, t), "fehlt {a:?}–{bb:?} t={t}: {:#?}", r.walls);
    }
    // Aussenwände laufen gegen den Uhrzeigersinn (rechts = aussen).
    let bottom = r.walls.iter().find(|w| w.a.1.abs() < EPS && w.b.1.abs() < EPS).unwrap();
    assert!(bottom.b.0 > bottom.a.0);
    assert!(r.openings.is_empty(), "{:?}", r.openings);
    assert_eq!(r.rooms.len(), 3);
    let wohnen = r.rooms.iter().find(|x| x.name.as_deref() == Some("Wohnen")).expect("Wohnen");
    assert!((polygon_area(&wohnen.ring).abs() - 33.350625).abs() < 1e-6, "{:?}", wohnen.ring);
    assert_eq!(wohnen.sia, Some("HNF"));
    assert_eq!(wohnen.area_text, Some(33.35));
    assert!(r.rooms.iter().any(|x| x.name.as_deref() == Some("Küche")));
    // Grösster Text gewinnt vor der Raumnummer.
    assert!(r.rooms.iter().any(|x| x.name.as_deref() == Some("Zimmer")));
    assert!(r.unclear.is_empty(), "{:?}", r.unclear);
}

#[test]
fn flaechenangabe_falsch_ist_unklar() {
    let mut b = l_house();
    b.text((7.0, 3.0), "Küche", 0.35).text((7.0, 2.0), "20.0 m2", 0.25).text((20.0, 2.0), "5 m²", 0.25);
    let r = analyze(&b.inp);
    let codes: Vec<&str> = r.unclear.iter().map(|u| u.code).collect();
    assert!(codes.contains(&"areaMismatch") && codes.contains(&"areaOutside"), "{codes:?}");
}

/// Gerade Wand 6 m (30 cm) mit Lücken; Hilfe für die Öffnungs-Tests.
fn wall_with_gaps(gaps: &[(f64, f64)]) -> B {
    let mut b = B::new();
    let mut x = 0.0;
    let mut spans = Vec::new();
    for &(g0, g1) in gaps {
        spans.push((x, g0));
        x = g1;
    }
    spans.push((x, 6.0));
    for (x0, x1) in spans {
        b.rect("Mauerwerk Wand", x0, -0.15, x1, 0.15);
    }
    b
}

#[test]
fn tuer_mit_bogen_fenster_und_durchbruch() {
    let mut b = wall_with_gaps(&[(1.0, 1.9), (3.0, 4.2), (4.6, 5.4)]);
    // Tür: Scharnier am rechten Pfosten (x = 1.9), Blatt schlägt nach −y auf (Bogen 180°…270°).
    b.arc("Türen", (1.9, -0.12), 0.9, 180.0, 90.0).line("Türen", (1.9, -0.12), (1.9, -1.02));
    // Fenster: Glaslinien im Band.
    b.line("Fenster", (3.0, -0.03), (4.2, -0.03)).line("Fenster", (3.0, 0.03), (4.2, 0.03));
    let r = analyze(&b.inp);
    assert_eq!(r.walls.len(), 1, "{:#?}", r.walls);
    let w = &r.walls[0];
    assert!((w.t - 0.3).abs() < EPS);
    assert_eq!(w.material, Some("mauerwerk"));
    assert_eq!(r.openings.len(), 3, "{:#?}", r.openings);
    // Lage unabhängig von der Wandrichtung: Anfang des Pfostens in Weltkoordinaten.
    let u = mul(sub(w.b, w.a), 1.0 / len(sub(w.b, w.a)));
    let x_of = |o: &ROpening| {
        let p0 = add(w.a, mul(u, o.pos));
        let p1 = add(w.a, mul(u, o.pos + o.width));
        (p0.0.min(p1.0), p0.0.max(p1.0))
    };
    let door = r.openings.iter().find(|o| matches!(o.kind, RKind::Door { .. })).unwrap();
    let (x0, x1) = x_of(door);
    assert!((x0 - 1.0).abs() < EPS && (x1 - 1.9).abs() < EPS);
    let RKind::Door { hinge_end, swing_right, leaves } = door.kind else { unreachable!() };
    assert_eq!(leaves, 1);
    // Scharnier bei x = 1.9, Blatt auf −y — in Wandrichtung ausgedrückt.
    let hinge = add(w.a, mul(u, if hinge_end { door.pos + door.width } else { door.pos }));
    assert!((hinge.0 - 1.9).abs() < EPS);
    let n = (-u.1, u.0);
    let side = if swing_right { -1.0 } else { 1.0 };
    assert!(mul(n, side).1 < 0.0, "Aufschlag nach −y");
    let win = r.openings.iter().find(|o| o.kind == RKind::Window).unwrap();
    let (x0, x1) = x_of(win);
    assert!((x0 - 3.0).abs() < EPS && (x1 - 4.2).abs() < EPS);
    let void = r.openings.iter().find(|o| o.kind == RKind::Void).unwrap();
    let (x0, x1) = x_of(void);
    assert!((x0 - 4.6).abs() < EPS && (x1 - 5.4).abs() < EPS);
    assert!(r.unclear.is_empty(), "{:?}", r.unclear);
}

#[test]
fn zweifluegelige_tuer_aus_zwei_halben_boegen() {
    let mut b = wall_with_gaps(&[(2.0, 3.6)]);
    b.arc("Türen", (2.0, 0.15), 0.8, 0.0, 90.0).arc("Türen", (3.6, 0.15), 0.8, 90.0, 90.0);
    let r = analyze(&b.inp);
    assert_eq!(r.openings.len(), 1);
    assert!(matches!(r.openings[0].kind, RKind::Door { leaves: 2, .. }), "{:?}", r.openings);
    assert!((r.openings[0].width - 1.6).abs() < EPS);
}

#[test]
fn breite_luecke_ohne_hinweis_trennt_waende() {
    let r = analyze(&wall_with_gaps(&[(2.0, 4.5)]).inp);
    assert_eq!(r.walls.len(), 2);
    assert!(r.openings.is_empty());
    // Mit Fensterlinien wird es eine Wand mit Fenster.
    let mut b = wall_with_gaps(&[(2.0, 4.5)]);
    b.line("Fenster", (2.0, 0.0), (4.5, 0.0));
    let r = analyze(&b.inp);
    assert_eq!(r.walls.len(), 1);
    assert_eq!(r.openings.len(), 1);
    assert_eq!(r.openings[0].kind, RKind::Window);
}

#[test]
fn tuer_in_der_ecke() {
    // Ecke bei (0,0): Wand 1 entlang x (Lücke 0.15–1.05 an der Ecke), Wand 2 entlang y.
    let mut b = B::new();
    b.ring("Wand", &[(-0.15, -0.15), (6.0, -0.15), (6.0, 0.15), (1.05, 0.15), (1.05, -0.15)]);
    b.line("Wand", (-0.15, -0.15), (-0.15, 5.0)).line("Wand", (0.15, 0.15), (0.15, 5.0)).line("Wand", (-0.15, 5.0), (0.15, 5.0));
    b.line("Wand", (-0.15, -0.15), (0.15, -0.15)).line("Wand", (0.15, -0.15), (0.15, 0.15));
    b.arc("Tür", (0.15, 0.15), 0.9, 0.0, 90.0);
    let r = analyze(&b.inp);
    assert_eq!(r.walls.len(), 2, "{:#?}", r.walls);
    assert!(has_wall(&r, (0.0, 0.0), (6.0, 0.0), 0.3), "{:#?}", r.walls);
    assert!(has_wall(&r, (0.0, 0.0), (0.0, 5.0), 0.3), "{:#?}", r.walls);
    assert_eq!(r.openings.len(), 1, "{:?} {:?}", r.openings, r.unclear);
    assert!(matches!(r.openings[0].kind, RKind::Door { leaves: 1, .. }));
    assert!((r.openings[0].width - 0.9).abs() < EPS);
}

#[test]
fn bogenwand_aus_konzentrischen_boegen() {
    let mut b = B::new();
    b.arc("Wand", (0.0, 0.0), 4.85, 0.0, 90.0).arc("Wand", (0.0, 0.0), 5.15, 0.0, 90.0);
    b.line("Wand", (4.85, 0.0), (5.15, 0.0)).line("Wand", (0.0, 4.85), (0.0, 5.15));
    let r = analyze(&b.inp);
    assert_eq!(r.walls.len(), 1, "{:#?}", r.walls);
    let w = &r.walls[0];
    assert!((w.t - 0.3).abs() < EPS);
    assert!(near(w.a, (5.0, 0.0), 1e-9) && near(w.b, (0.0, 5.0), 1e-9), "{w:?}");
    let arc = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(w.a.0, w.a.1), kernel2d::Vec2::new(w.b.0, w.b.1), w.bulge).unwrap();
    assert!((arc.r - 5.0).abs() < 1e-9 && (arc.sweep - PI / 2.0).abs() < 1e-9, "{arc:?}");
    assert!(len(sub((arc.center.x, arc.center.y), (0.0, 0.0))) < 1e-9);
    // Kein Türbogen-Hinweis (die Bögen sind die Wand).
    assert!(r.unclear.is_empty());
}

#[test]
fn bogenwand_aus_polylinien_bulge() {
    // Polylinien-Bogen (Modell-Bulge, negativ = gegen den Uhrzeigersinn).
    let bl = -tan(PI / 8.0);
    let a1 = bulge_arc((4.85, 0.0), (0.0, 4.85), bl, 0).unwrap();
    let a2 = bulge_arc((5.15, 0.0), (0.0, 5.15), bl, 0).unwrap();
    assert!((a1.sweep - PI / 2.0).abs() < 1e-9 && a1.a0.abs() < 1e-9, "{a1:?}");
    let mut inp = Input::default();
    inp.layer("Wand");
    inp.arcs.extend([a1, a2]);
    let r = analyze(&inp);
    assert_eq!(r.walls.len(), 1);
}

#[test]
fn layer_filter_ignoriert_moebel() {
    let mut b = wall_with_gaps(&[]);
    // Möbel parallel in 40 cm Abstand (wäre sonst eine Wand) und ein Tisch.
    b.line("Möbel", (1.0, 0.55), (4.0, 0.55)).rect("Möbel", 1.0, 2.0, 3.0, 2.4);
    b.line("Mauerwerk Wand", (8.0, 8.0), (12.0, 8.0));
    let r = analyze(&b.inp);
    assert!(r.layer_filter);
    assert_eq!(r.walls.len(), 1, "{:#?}", r.walls);
    // Die einsame Linie auf dem Wand-Layer ist unklar.
    assert_eq!(r.unclear.iter().filter(|u| u.code == "lineUnpaired").count(), 1, "{:?}", r.unclear);
    // Ohne Wand-Layer zählt alles: der Tisch (40 cm) wird eine Wand.
    let mut b = B::new();
    b.rect("0", 0.0, -0.15, 6.0, 0.15).rect("0", 1.0, 2.0, 3.0, 2.4);
    let r = analyze(&b.inp);
    assert!(!r.layer_filter);
    assert_eq!(r.walls.len(), 2);
}

#[test]
fn schichtlinie_und_achslinie_ergeben_eine_wand() {
    let mut b = B::new();
    // Aussenwand 34.5 cm: Putz/Dämmung/Mauerwerk-Linien (Schichtgrenzen bei −0.1525 und 0.0075).
    for y in [-0.1725, -0.1525, 0.0075, 0.1575, 0.1725] {
        b.line("Wand", (0.0, y), (5.0, y));
    }
    let r = analyze(&b.inp);
    assert_eq!(r.walls.len(), 1, "{:#?}", r.walls);
    assert!((r.walls[0].t - 0.345).abs() < 1e-9);
    assert!(near(mul(add(r.walls[0].a, r.walls[0].b), 0.5), (2.5, 0.0), 1e-9));
}

#[test]
fn schraffur_bestaetigt_und_gibt_material() {
    let mut b = wall_with_gaps(&[]);
    let l = b.inp.layer("Schraffur");
    b.inp.fills.push(FillIn { ring: vec![(0.0, -0.15), (6.0, -0.15), (6.0, 0.15), (0.0, 0.15)], layer: l, hatch: Some("Beton".into()) });
    let r = analyze(&b.inp);
    assert!(r.walls[0].filled);
    assert_eq!(r.walls[0].material, Some("beton"));
}

#[test]
fn material_und_flaechentexte() {
    assert_eq!(material_of("A-WALL-CONC"), None);
    assert_eq!(material_of("Wand Beton"), Some("beton"));
    assert_eq!(material_of("MW 15"), Some("mauerwerk"));
    assert_eq!(material_of("Wand_KS"), Some("kalksandstein"));
    assert_eq!(material_of("Kasten"), None);
    assert_eq!(parse_area("17.01 m²"), Some(17.01));
    assert_eq!(parse_area("F: 17,5 m2"), Some(17.5));
    assert_eq!(parse_area("1'017 qm"), Some(1017.0));
    assert_eq!(parse_area("Wohnen"), None);
    assert!(wallish_layer("20_Wände") && wallish_layer("A-WALL") && wallish_layer("Mauerwerk") && !wallish_layer("Möbel"));
}

#[test]
fn unsinn_ohne_panic() {
    let mut b = B::new();
    b.line("Wand", (f64::NAN, 0.0), (1.0, 0.0)).line("Wand", (0.0, 0.0), (0.0, 0.0)).arc("Wand", (0.0, 0.0), f64::INFINITY, 0.0, 90.0);
    b.line("Wand", (0.0, 0.0), (1e300, 1e300)).line("Wand", (0.0, 0.1), (1e300, 1e300));
    let _ = analyze(&b.inp);
    let _ = analyze(&Input::default());
}

// ── Über das Projekt (Ops) ───────────────────────────────────────────────────

fn project(drawings: Vec<Value>) -> (Project, serde_json::Map<String, Value>) {
    let v = json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [],
        "components": [{"id": "brick", "name": "Mauerwerk", "color": "#a0522d"}, {"id": "concrete", "name": "Beton", "color": "#999999"}],
        "wallTypes": [{"id": "aw", "name": "Aussenwand 30", "layers": [{"componentId": "brick", "thickness": 0.3}]}],
        "doorTypes": [{"id": "dt1", "name": "Tür", "kind": "dreh", "leafCount": 1, "leafStyle": "glatt", "frameThickness": 0.06}],
        "layers": [
            {"code": "20", "name": "Wände", "color": "#000000", "lw": 0.5, "visible": true, "locked": false},
            {"code": "21", "name": "Türen/Fenster", "color": "#000000", "lw": 0.25, "visible": true, "locked": false},
            {"code": "60", "name": "Räume", "color": "#6b7280", "lw": 0.1, "visible": true, "locked": false},
            {"code": "101", "name": "A-WALL", "color": "#000000", "lw": 0.5, "visible": true, "locked": false},
            {"code": "102", "name": "A-DOOR", "color": "#000000", "lw": 0.25, "visible": true, "locked": false},
            {"code": "103", "name": "A-ANNO", "color": "#000000", "lw": 0.25, "visible": true, "locked": false}
        ],
        "openings": [], "walls": [],
        "drawingLevels": [
            {"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 2.8},
            {"id": "imp", "name": "Import", "kind": "drawing", "visible": true, "locked": false}
        ],
        "drawings2d": drawings
    });
    let p: Project = serde_json::from_value(v.clone()).unwrap();
    (p, v.as_object().unwrap().clone())
}

fn dl(id: &str, code: &str, geom: Value) -> Value {
    json!({"id": id, "type": "drawing2d", "levelId": "imp", "categoryCode": code, "geom": geom})
}

fn poly(pts: &[V]) -> Value {
    json!({"shape": "polyline", "closed": true, "pts": pts.iter().map(|p| json!({"x": p.0, "y": p.1})).collect::<Vec<_>>()})
}

/// Raum 5 × 4 (Achsen) mit Aussenwänden 30 cm und Innenwand 15 cm, Tür mit Bogen, Raumtext.
fn small_house() -> Vec<Value> {
    vec![
        dl("o", "101", poly(&[(-0.15, -0.15), (1.0, -0.15), (1.0, 0.15), (0.15, 0.15), (0.15, 3.85), (4.85, 3.85), (4.85, 0.15), (1.9, 0.15), (1.9, -0.15), (5.15, -0.15), (5.15, 4.15), (-0.15, 4.15)])),
        dl("i", "101", poly(&[(2.425, 0.15), (2.575, 0.15), (2.575, 3.85), (2.425, 3.85)])),
        dl("arc", "102", json!({"shape": "arc", "center": {"x": 1.0, "y": 0.0}, "r": 0.9, "a0": 0.0, "a1": PI / 2.0})),
        dl("t1", "103", json!({"shape": "text", "at": {"x": 0.5, "y": 2.0}, "text": "Wohnen", "height": 0.35, "angle": 0.0})),
        dl("t2", "103", json!({"shape": "text", "at": {"x": 0.5, "y": 1.5}, "text": "9.5 m²", "height": 0.25, "angle": 0.0})),
    ]
}

/// Neue Elemente einer Liste aus den Ops.
fn added(ops: &[Op], coll: &str) -> Vec<Value> {
    ops.iter()
        .filter_map(|o| match o {
            Op::Add { collection, items, .. } if collection == coll => Some(items.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

fn req(extra: Value) -> Value {
    let mut v = json!({"cmd": "recognize", "src": "imp", "stamp": "s", "typeName": "Wand {cm} cm (erkannt)",
        "ctx": {"level": "eg", "floorHeight": 2.8, "cat": "20", "wallType": "aw"}});
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}

#[test]
fn ops_waende_typen_oeffnungen_raeume() {
    let (p, root) = project(small_house());
    let ops = crate::cmd_create::ops(&root, &p, &req(json!({}))).expect("recognize");
    let items = |coll: &str| added(&ops, coll);
    let walls = items("walls");
    assert_eq!(walls.len(), 5, "{walls:#?}");
    // 30 cm: vorhandener Typ; 15 cm: neuer Typ (Baustoff des aktiven Typs).
    assert_eq!(walls.iter().filter(|w| w["wallTypeId"] == "aw").count(), 4);
    let types = items("wallTypes");
    assert_eq!(types.len(), 1, "{types:?}");
    assert_eq!(types[0]["name"], "Wand 15 cm (erkannt)");
    assert_eq!(types[0]["layers"][0]["componentId"], "brick");
    assert!(walls.iter().all(|w| w["floorId"] == "eg" && w["height"] == 2.8 && w["categoryCode"] == "20"));
    let openings = items("openings");
    assert_eq!(openings.len(), 1, "{openings:?}");
    let o = &openings[0];
    assert_eq!(o["kind"], "door");
    assert_eq!(o["typeId"], "dt1");
    assert_eq!(o["sillHeight"], 0.0);
    assert!((o["width"].as_f64().unwrap() - 0.9).abs() < 1e-9);
    let host = walls.iter().find(|w| w["id"] == o["hostWallId"]).unwrap();
    assert_eq!(host["wallTypeId"], "aw");
    let rooms = items("rooms");
    assert_eq!(rooms.len(), 2);
    assert!(rooms.iter().any(|r| r["name"] == "Wohnen" && r["categoryCode"] == "60"));
    // Alles typisiert lesbar.
    for w in &walls {
        let _: crate::model::Wall = serde_json::from_value(w.clone()).unwrap();
    }
    let _: crate::model::Opening = serde_json::from_value(o.clone()).unwrap();
    for r in &rooms {
        let _: crate::model::Room = serde_json::from_value(r.clone()).unwrap();
    }
    for t in &types {
        let _: crate::model::WallType = serde_json::from_value(t.clone()).unwrap();
    }
}

#[test]
fn auswahl_vorschau_und_bericht() {
    let (p, root) = project(small_house());
    // Nur die Innenwand gewählt: eine Wand.
    let ops = crate::cmd_create::ops(&root, &p, &req(json!({"ids": ["i"]}))).unwrap();
    let n = added(&ops, "walls").len();
    // Ohne Gegen-Wände kein Stoss; ein Wand-Layer mit 4 Linien → Filter an.
    assert_eq!(n, 1);
    let pv = crate::cmd_create::preview(&root, &p, &req(json!({})), &[]);
    assert!(pv.ok);
    assert_eq!(pv.info, vec![5.0, 1.0, 0.0, 0.0, 2.0, 1.0, 0.0]);
    let rep = report(&p, &json!({"q": "recognize", "level": "eg", "src": "imp"}));
    assert_eq!(rep["walls"], 5);
    assert_eq!(rep["doors"], 1);
    assert_eq!(rep["layerFilter"], true);
    // „9.5 m²“ steht im westlichen Raum (2.275 × 3.7 = 8.4175 m²): Abweichung > 5 %.
    assert_eq!(rep["unclear"][0]["code"], "areaMismatch");
    // Leere Ebene: nichts.
    let pv = crate::cmd_create::preview(&root, &p, &req(json!({"src": "eg"})), &[]);
    assert!(!pv.ok);
    assert!(crate::cmd_create::ops(&root, &p, &req(json!({"src": "eg"}))).unwrap().is_empty());
}

/// Erker wie im Musterhaus komplex: gerade Wand – halbkreisförmige Bogenwand – gerade Wand, der Bogen im
/// DXF in Sehnen zerlegt (Polylinie ohne Bulge). → drei Wände, Bogenwand mit Mittelpunkt/Radius, Stösse auf
/// den Achsen.
#[test]
fn tessellierter_erker() {
    let (c, t): (V, f64) = ((15.0, 5.0), 0.39);
    let arc_pts = |r: f64, a0: f64, a1: f64, n: usize| -> Vec<V> {
        (0..=n)
            .map(|i| {
                let a = a0 + (a1 - a0) * i as f64 / n as f64;
                (c.0 + r * a.cos(), c.1 + r * a.sin())
            })
            .collect()
    };
    let ro = 2.0 + t / 2.0;
    let ri = 2.0 - t / 2.0;
    let ao = (t / 2.0 / ro).asin();
    let ai = (t / 2.0 / ri).asin();
    // Aussen: x = 15.195 und der äussere Bogen; innen: x = 14.805 und der innere Bogen.
    let mut outer = vec![(15.195, 0.0)];
    outer.extend(arc_pts(ro, -PI / 2.0 + ao, PI / 2.0 - ao, 24));
    outer.push((15.195, 10.0));
    let mut inner = vec![(14.805, 0.0)];
    inner.extend(arc_pts(ri, -PI / 2.0 - ai, PI / 2.0 + ai, 24));
    inner.push((14.805, 10.0));
    let mut inp = Input::default();
    let l = inp.layer("Wand");
    fit_arcs(&outer, l, &mut inp.segs, &mut inp.arcs);
    fit_arcs(&inner, l, &mut inp.segs, &mut inp.arcs);
    assert_eq!(inp.arcs.len(), 2, "{:?}", inp.arcs);
    assert!(inp.arcs.iter().all(|a| len(sub(a.c, c)) < 1e-9));
    let r = analyze(&inp);
    assert_eq!(r.walls.len(), 3, "{:#?}", r.walls);
    assert!(has_wall(&r, (15.0, 0.0), (15.0, 3.0), t) && has_wall(&r, (15.0, 7.0), (15.0, 10.0), t), "{:#?}", r.walls);
    let w = r.walls.iter().find(|w| w.bulge.is_some()).unwrap();
    assert!(near(w.a, (15.0, 3.0), 1e-6) && near(w.b, (15.0, 7.0), 1e-6), "{w:?}");
    let arc = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(w.a.0, w.a.1), kernel2d::Vec2::new(w.b.0, w.b.1), w.bulge).unwrap();
    assert!((arc.r - 2.0).abs() < 1e-6 && len(sub((arc.center.x, arc.center.y), c)) < 1e-6, "{arc:?}");
    // Fenster im Bogen: Bogenwand mit Lücke 60°–75° (Fensterbögen im Band) → eine Bogenwand mit Fenster.
    let mut inp = Input::default();
    let l = inp.layer("Wand");
    let f = inp.layer("Fenster");
    for (r0, a0, sw) in [(ro, -60.0, 120.0), (ri, -60.0, 120.0), (ro, 75.0, 30.0), (ri, 75.0, 30.0)] {
        inp.arcs.push(ArcIn { c, r: r0, a0: wrap2pi(f64::to_radians(a0)), sweep: f64::to_radians(sw), layer: l });
    }
    inp.arcs.push(ArcIn { c, r: 2.0, a0: f64::to_radians(60.0), sweep: f64::to_radians(15.0), layer: f });
    let r = analyze(&inp);
    assert_eq!(r.walls.len(), 1, "{:#?}", r.walls);
    assert_eq!(r.openings.len(), 1, "{:?}", r.openings);
    assert_eq!(r.openings[0].kind, RKind::Window);
    assert!((r.openings[0].pos - 2.0 * f64::to_radians(120.0)).abs() < 1e-6 && (r.openings[0].width - 2.0 * f64::to_radians(15.0)).abs() < 1e-6, "{:?}", r.openings);
    // Rechtecke und Zickzack bleiben gerade.
    let mut segs = Vec::new();
    let mut arcs = Vec::new();
    fit_arcs(&[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.0, 0.0)], 0, &mut segs, &mut arcs);
    fit_arcs(&[(0.0, 0.0), (1.0, 0.1), (2.0, 0.0), (3.0, 0.1), (4.0, 0.0)], 0, &mut segs, &mut arcs);
    assert!(arcs.is_empty());
    assert_eq!(segs.len(), 8);
}

// ── Schiebetüren, Zarge/Futter, Türen in Bogenwänden, Stützen (7.11.) ───────

impl B {
    /// Pfeil von `from` nach `to` mit zwei Spitzen-Strichen (24°, 13 cm) am Ziel.
    fn arrow(&mut self, layer: &str, from: V, to: V) -> &mut B {
        let d = sub(from, to);
        let u = mul(d, 1.0 / len(d));
        let (c, s) = (24f64.to_radians().cos(), 24f64.to_radians().sin());
        let h1 = (u.0 * c - u.1 * s, u.0 * s + u.1 * c);
        let h2 = (u.0 * c + u.1 * s, -u.0 * s + u.1 * c);
        self.line(layer, from, to).line(layer, to, add(to, mul(h1, 0.13))).line(layer, to, add(to, mul(h2, 0.13)))
    }
    /// Stütze als Kandidat (wie `collect` sie aus einem geschlossenen Umriss liest) samt Umriss.
    fn column(&mut self, layer: &str, c: V, w: f64, d: f64, round: bool, filled: bool) -> &mut B {
        let l = self.inp.layer(layer);
        let ring: Vec<V> = if round {
            (0..32)
                .map(|i| {
                    let a = 2.0 * PI * i as f64 / 32.0;
                    (c.0 + w / 2.0 * a.cos(), c.1 + w / 2.0 * a.sin())
                })
                .collect()
        } else {
            vec![(c.0 - w / 2.0, c.1 - d / 2.0), (c.0 + w / 2.0, c.1 - d / 2.0), (c.0 + w / 2.0, c.1 + d / 2.0), (c.0 - w / 2.0, c.1 + d / 2.0)]
        };
        if round {
            self.inp.arcs.push(ArcIn { c, r: w / 2.0, a0: 0.0, sweep: 2.0 * PI, layer: l });
        } else {
            self.ring(layer, &ring);
        }
        self.inp.cols.push(ColIn { c, w, d, rot: 0.0, round, ring, filled, layer: l });
        self
    }
}

/// Weltkoordinaten (x) der Pfosten einer Öffnung in einer Wand entlang x.
fn xs_of(r: &Recognition, o: &ROpening) -> (f64, f64) {
    let w = &r.walls[o.wall];
    let u = mul(sub(w.b, w.a), 1.0 / len(sub(w.b, w.a)));
    let p0 = add(w.a, mul(u, o.pos));
    let p1 = add(w.a, mul(u, o.pos + o.width));
    (p0.0.min(p1.0), p0.0.max(p1.0))
}

#[test]
fn schiebetuer_vor_der_wand_mit_pfeil() {
    // Lücke 2.0–2.9 (90 cm), Blatt vor der Wand (+y), Rahmen im Band, Pfeil in Schieberichtung.
    let mut b = wall_with_gaps(&[(2.0, 2.9)]);
    b.rect("Türen", 1.95, 0.16, 2.95, 0.20).rect("Türen", 2.04, -0.03, 2.86, 0.03);
    b.arrow("Türen", (2.675, 0.27), (2.225, 0.27));
    let r = analyze(&b.inp);
    assert_eq!(r.openings.len(), 1, "{:?}", r.openings);
    assert_eq!(r.openings[0].kind, RKind::Slide { lift: false });
    let (x0, x1) = xs_of(&r, &r.openings[0]);
    assert!((x0 - 2.0).abs() < EPS && (x1 - 2.9).abs() < EPS);
    assert!(r.unclear.is_empty(), "{:?}", r.unclear);
}

/// Hebeschiebetür 3 m (Lücke 1.0–4.0): zwei Flügel versetzt im Band, je mit Glaslinie, Rahmen.
fn lift_slide(arrow: bool) -> B {
    let mut b = wall_with_gaps(&[(1.0, 4.0)]);
    b.rect("Fenster", 1.0, -0.007, 2.53, 0.041).line("Fenster", (1.0, 0.017), (2.53, 0.017));
    b.rect("Fenster", 2.47, 0.049, 4.0, 0.097).line("Fenster", (2.47, 0.073), (4.0, 0.073));
    b.rect("Fenster", 1.0, -0.015, 4.0, 0.085);
    if arrow {
        b.arrow("Fenster", (3.55, 0.137), (2.2, 0.137));
    }
    b
}

#[test]
fn hebeschiebetuer_mit_versetzten_fluegeln() {
    for arrow in [true, false] {
        let r = analyze(&lift_slide(arrow).inp);
        assert_eq!(r.walls.len(), 1, "Pfeil {arrow}: {:#?}", r.walls);
        assert_eq!(r.openings.len(), 1, "Pfeil {arrow}: {:?}", r.openings);
        assert_eq!(r.openings[0].kind, RKind::Slide { lift: true }, "Pfeil {arrow}");
        let (x0, x1) = xs_of(&r, &r.openings[0]);
        assert!((x0 - 1.0).abs() < EPS && (x1 - 4.0).abs() < EPS);
    }
    // Schmal (1.2 m) und ohne Pfeil: zweiflügliges Fenster mit versetzten Flügeln bleibt Fenster.
    let mut b = wall_with_gaps(&[(1.0, 2.2)]);
    b.rect("Fenster", 1.0, -0.007, 1.63, 0.041).rect("Fenster", 1.57, 0.049, 2.2, 0.097);
    let r = analyze(&b.inp);
    assert_eq!(r.openings.len(), 1);
    assert_eq!(r.openings[0].kind, RKind::Window);
    // Gewöhnliches Fenster (Rahmen + Glas über die ganze Breite, gleiche Lage) bleibt Fenster.
    let mut b = wall_with_gaps(&[(1.0, 2.8)]);
    b.rect("Fenster", 1.0, -0.04, 2.8, 0.04).line("Fenster", (1.0, 0.0), (2.8, 0.0));
    let r = analyze(&b.inp);
    assert_eq!(r.openings[0].kind, RKind::Window);
}

#[test]
fn tuer_mit_zarge_breiter_als_bogen() {
    // Rohbaulücke 1.0–2.0 (1 m), Zarge 10 cm: Scharnier bei x = 1.1, Blatt 80 cm, Aufschlag nach −y.
    let mut b = wall_with_gaps(&[(1.0, 2.0)]);
    b.rect("Türen", 1.0, -0.15, 1.1, 0.15).rect("Türen", 1.9, -0.15, 2.0, 0.15);
    b.arc("Türen", (1.1, -0.12), 0.8, 270.0, 90.0).line("Türen", (1.1, -0.12), (1.1, -0.92));
    let r = analyze(&b.inp);
    assert_eq!(r.openings.len(), 1, "{:?} {:?}", r.openings, r.unclear);
    let o = &r.openings[0];
    let RKind::Door { hinge_end, swing_right, leaves: 1 } = o.kind else { panic!("{o:?}") };
    // Tür mit Lückenbreite, Anschlag am linken Pfosten.
    let (x0, x1) = xs_of(&r, o);
    assert!((x0 - 1.0).abs() < EPS && (x1 - 2.0).abs() < EPS, "{x0} {x1}");
    let w = &r.walls[0];
    let u = mul(sub(w.b, w.a), 1.0 / len(sub(w.b, w.a)));
    let hinge = add(w.a, mul(u, if hinge_end { o.pos + o.width } else { o.pos }));
    assert!((hinge.0 - 1.0).abs() < EPS, "{hinge:?}");
    let side = if swing_right { -1.0 } else { 1.0 };
    assert!(mul((-u.1, u.0), side).1 < 0.0);
    assert!(r.unclear.is_empty(), "{:?}", r.unclear);
}

#[test]
fn tuer_in_bogenwand() {
    // Bogenwand r = 5 (30 cm), 0°–90° mit Lücke 30°–40° (≈ 0.87 m); Tür: Scharnier am Pfosten bei 30°,
    // Blatt schlägt nach innen (zum Mittelpunkt) auf.
    let (ri, ro) = (4.85, 5.15);
    let mut b = B::new();
    for (r0, a0, sw) in [(ri, 0.0, 30.0), (ro, 0.0, 30.0), (ri, 40.0, 50.0), (ro, 40.0, 50.0)] {
        b.arc("Wand", (0.0, 0.0), r0, a0, sw);
    }
    let a30 = 30f64.to_radians();
    let a40 = 40f64.to_radians();
    let hinge = (5.0 * a30.cos(), 5.0 * a30.sin());
    let other = (5.0 * a40.cos(), 5.0 * a40.sin());
    let w = len(sub(other, hinge));
    // Offenstellung: senkrecht zur Sehne nach innen.
    let ch = mul(sub(other, hinge), 1.0 / w);
    let inward = (-ch.1, ch.0);
    let open = add(hinge, mul(inward, w));
    let a_closed = atan2(ch.1, ch.0).to_degrees();
    b.arc("Tür", hinge, w, a_closed, 90.0).line("Tür", hinge, open);
    let r = analyze(&b.inp);
    assert_eq!(r.walls.len(), 1, "{:#?}", r.walls);
    assert_eq!(r.openings.len(), 1, "{:?} {:?}", r.openings, r.unclear);
    let o = &r.openings[0];
    let RKind::Door { hinge_end, swing_right, leaves: 1 } = o.kind else { panic!("{o:?}") };
    // Wand gegen den Uhrzeigersinn ab 0°: Scharnier am Lückenanfang, Aufschlag links (= innen).
    assert!(!hinge_end && !swing_right, "{o:?}");
    assert!((o.pos - 5.0 * a30).abs() < 1e-6 && (o.width - 5.0 * (a40 - a30)).abs() < 1e-6, "{o:?}");
    assert!(r.unclear.is_empty(), "{:?}", r.unclear);
}

#[test]
fn stuetzen_aus_kleinen_gefuellten_umrissen() {
    let mut b = l_house();
    // Freistehend: Rechteck 30 × 30 gefüllt, Kreis Ø 25 gefüllt, Rechteck 40 × 20 auf Stützen-Layer (ohne Füllung).
    b.column("Beton", (3.0, 3.0), 0.3, 0.3, false, true);
    b.column("Beton", (9.0, 3.0), 0.25, 0.25, true, true);
    b.column("Stützen", (3.0, 8.0), 0.4, 0.2, false, false);
    // Nicht: ungefüllt auf fremdem Layer (Möbel), zu gross, an einer Wand anliegend.
    b.column("Möbel", (4.0, 4.0), 0.4, 0.4, false, false);
    b.column("Beton", (9.0, 4.5), 0.8, 0.8, false, true);
    b.column("Beton", (6.075 + 0.15, 2.0), 0.3, 0.3, false, true);
    let r = analyze(&b.inp);
    // Wände wie ohne Stützen.
    assert_eq!(r.walls.len(), 8, "{:#?}", r.walls);
    assert_eq!(r.columns.len(), 3, "{:#?}", r.columns);
    let at = |c: V| r.columns.iter().find(|x| near(x.c, c, 1e-9)).unwrap_or_else(|| panic!("{c:?}: {:?}", r.columns));
    let a = at((3.0, 3.0));
    assert!(!a.round && (a.w - 0.3).abs() < EPS && (a.d - 0.3).abs() < EPS);
    let k = at((9.0, 3.0));
    assert!(k.round && (k.w - 0.25).abs() < EPS);
    let s = at((3.0, 8.0));
    assert!((s.w - 0.4).abs() < EPS && (s.d - 0.2).abs() < EPS);
}

#[test]
fn stuetzen_aus_dem_projekt_und_ops() {
    let mut d = small_house();
    d.push(json!({"id": "c1", "type": "drawing2d", "levelId": "imp", "categoryCode": "103", "fillColor": "#000000",
        "geom": {"shape": "rect", "min": {"x": 3.5, "y": 1.85}, "max": {"x": 3.8, "y": 2.15}}}));
    d.push(json!({"id": "c2", "type": "drawing2d", "levelId": "imp", "categoryCode": "103", "fillColor": "#000000",
        "geom": {"shape": "circle", "center": {"x": 1.2, "y": 3.0}, "r": 0.15}}));
    // Gedrehtes Quadrat 30 × 30 (45°) als Polylinie.
    let h = 0.15 * 2f64.sqrt();
    let mut c3 = dl("c3", "103", poly(&[(4.0, 3.0 - h), (4.0 + h, 3.0), (4.0, 3.0 + h), (4.0 - h, 3.0)]));
    c3["hatchId"] = json!("x");
    d.push(c3);
    let (p, root) = project(d);
    let ops = crate::cmd_create::ops(&root, &p, &req(json!({}))).unwrap();
    assert_eq!(added(&ops, "walls").len(), 5);
    let cols = added(&ops, "columns");
    assert_eq!(cols.len(), 3, "{cols:#?}");
    for c in &cols {
        let col: crate::model::Column = serde_json::from_value(c.clone()).unwrap();
        assert_eq!(col.floor_id, "eg");
        assert!((col.height - 2.8).abs() < 1e-9);
    }
    let round = cols.iter().find(|c| c["profile"]["kind"] == "round").unwrap();
    assert!((round["profile"]["radius"].as_f64().unwrap() - 0.15).abs() < 1e-9);
    assert!((round["position"]["x"].as_f64().unwrap() - 1.2).abs() < 1e-9);
    let rot = cols.iter().find(|c| (c["position"]["x"].as_f64().unwrap() - 4.0).abs() < 1e-9).unwrap();
    assert!((rot["profile"]["width"].as_f64().unwrap() - 0.3).abs() < 1e-9);
    let a = rot["rotation"].as_f64().unwrap().rem_euclid(PI / 2.0);
    assert!((a - PI / 4.0).abs() < 1e-9, "{a}");
    let rep = report(&p, &json!({"q": "recognize", "level": "eg", "src": "imp"}));
    assert_eq!(rep["columns"], 3);
}

#[test]
fn schiebetuer_ops_mit_typ() {
    // Ohne Schiebetür-Typ im Projekt: neuer Türtyp „schiebe“ (Name aus der Anfrage).
    let mut d = small_house();
    d.retain(|x| x["id"] != "arc");
    let lines = [((1.0, 0.17), (1.9, 0.17)), ((1.9, 0.17), (1.9, 0.21)), ((1.9, 0.21), (1.0, 0.21)), ((1.0, 0.21), (1.0, 0.17)), ((1.675, 0.3), (1.225, 0.3)), ((1.225, 0.3), (1.34, 0.25)), ((1.225, 0.3), (1.34, 0.35))];
    for (i, (a, b)) in lines.iter().enumerate() {
        d.push(dl(&format!("s{i}"), "102", json!({"shape": "line", "a": {"x": a.0, "y": a.1}, "b": {"x": b.0, "y": b.1}})));
    }
    let (p, root) = project(d);
    let ops = crate::cmd_create::ops(&root, &p, &req(json!({"slideTypeName": "Schiebetür (erkannt)"}))).unwrap();
    let types = added(&ops, "doorTypes");
    assert_eq!(types.len(), 1, "{types:?}");
    let t: crate::model::DoorType = serde_json::from_value(types[0].clone()).unwrap();
    assert_eq!(t.kind, crate::model::DoorTypeKind::Schiebe);
    assert_eq!(t.name, "Schiebetür (erkannt)");
    let o = &added(&ops, "openings")[0];
    assert_eq!(o["kind"], "door");
    assert_eq!(o["typeId"], types[0]["id"]);
    let rep = report(&p, &json!({"q": "recognize", "level": "eg", "src": "imp"}));
    assert_eq!(rep["doors"], 1);
    assert_eq!(rep["slidingDoors"], 1);
}
