//! [152] Importierte Netze im Schnitt (Tests zu `plan/section/`).

use super::*;
use crate::mesh_view::tests::{barrel, cube, prism};

fn mesh(id: &str, (positions, indices): (Vec<f64>, Vec<f64>)) -> ContextObject {
    ContextObject::ImportedMesh(ImportedMesh { id: id.into(), name: format!("Netz {id}"), category_code: "10".into(), positions, indices, ..Default::default() })
}

/// Schnitt längs x bei y = 0 ab x = −5 (u = x + 5), Blick nach +y (hinter der Ebene: y > 0).
fn lv(hidden: bool) -> LevelSpec {
    LevelSpec { kind: "section".into(), line: Some([Vec2 { x: -5.0, y: 0.0 }, Vec2 { x: 8.0, y: 0.0 }]), direction_sign: Some(1.0), hidden_lines: hidden, ..Default::default() }
}

fn with(ctx: Vec<ContextObject>) -> Project {
    Project { context: Some(ctx), ..Default::default() }
}

fn mesh_cuts(o: &Output) -> Vec<&Cut> {
    o.cuts.iter().filter(|c| c.kind == Kind::Mesh).collect()
}

#[test]
fn wuerfel_netz_geschnitten() {
    let p = with(vec![mesh("w", cube(1.0, 3.0, -1.0, 2.0, 0.0, 2.5))]);
    let o = compute_section(&p, &lv(false), &[]).unwrap().unwrap();
    let c = mesh_cuts(&o);
    assert_eq!(c.len(), 1, "{:?}", o.cuts);
    assert!((ring_area(&c[0].pts).abs() - 5.0).abs() < 1e-9);
    let b = bbox(&c[0].pts);
    assert!((b[0] - 6.0).abs() < 1e-9 && (b[1] - 8.0).abs() < 1e-9 && b[2].abs() < 1e-9 && (b[3] - 2.5).abs() < 1e-9, "{b:?}");
    assert_eq!(c[0].source_id.as_deref(), Some("w"));
    assert_eq!(c[0].category.as_deref(), Some("10"));
    assert!(o.mesh_lines.is_empty());
    // Ab 1:100 schwarz, Pick über die Kontext-Id; ausgeblendete Kategorie: nichts.
    let (prims, _) = section_primitives_at(&o, false, false, &Visibility::default(), 100.0, Detail::Mittel, false, &CutRules::default());
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { fill, context_object_id: Some(id), .. } if id == "w" && fill == HATCH_INK)));
    let vis = Visibility { has_vis: true, invisible: ["10".to_string()].into(), ..Default::default() };
    let (prims, _) = section_primitives_at(&o, false, false, &vis, 100.0, Detail::Mittel, false, &CutRules::default());
    assert!(!prims.iter().any(|q| matches!(q, Primitive::Polygon { context_object_id: Some(_), .. })));
}

#[test]
fn tonnen_netz_flaeche_exakt() {
    let (r, big, n) = (2.7, 3.0, 24usize);
    let p = with(vec![mesh("t", barrel(r, big, 5.0, n, -2.0, 2.0))]);
    let o = compute_section(&p, &lv(false), &[]).unwrap().unwrap();
    let c = mesh_cuts(&o);
    assert_eq!(c.len(), 1);
    // Polygon-Halbring: n Trapeze, je ½·(R² − r²)·sin(π/n).
    let want = 0.5 * n as f64 * (big * big - r * r) * (std::f64::consts::PI / n as f64).sin();
    assert!((ring_area(&c[0].pts).abs() - want).abs() < 1e-9, "{} statt {want}", ring_area(&c[0].pts).abs());
    let b = bbox(&c[0].pts);
    assert!((b[3] - 8.0).abs() < 1e-9 && (b[2] - 5.0).abs() < 1e-9, "Scheitel 8 m, Kämpfer 5 m: {b:?}");
}

#[test]
fn netz_mit_loch_als_schluesselloch() {
    // Rahmen: Quader 4 × 3 mit Durchbruch 2 × 1 längs y (Aussen- und Innenmantel, Deckel als Ringflächen).
    let outer = [[0.0, 0.0], [4.0, 0.0], [4.0, 3.0], [0.0, 3.0]];
    // Innenmantel mit Normalen ins Loch: Profil im Uhrzeigersinn.
    let inner = [[1.0, 1.0], [1.0, 2.0], [3.0, 2.0], [3.0, 1.0]];
    let (mut pos, mut idx) = prism(&outer, &[], -1.0, 1.0);
    let (p2, i2) = prism(&inner, &[], -1.0, 1.0);
    pos.extend(p2);
    idx.extend(i2.into_iter().map(|x| x + 8.0));
    // Ecken: aussen unten 0..4, oben 4..8; innen unten 8..12, oben 12..16 (innen[k] gegenläufig zu aussen[k]).
    let inn = |k: usize| [8, 11, 10, 9][k % 4];
    for k in 0..4 {
        let (a, b, c, d) = (k % 4, (k + 1) % 4, inn(k + 1), inn(k));
        idx.extend([a, b, c, a, c, d].map(|i| i as f64));
        idx.extend([d, c, b, d, b, a].map(|i| (i + 4) as f64));
    }
    let info = crate::mesh_view::analyze(&pos, &idx).unwrap();
    assert!(info.closed, "Rahmen geschlossen");
    let p = with(vec![mesh("r", (pos, idx))]);
    let o = compute_section(&p, &lv(false), &[]).unwrap().unwrap();
    let c = mesh_cuts(&o);
    assert_eq!(c.len(), 1, "{c:?}");
    assert!((ring_area(&c[0].pts).abs() - (12.0 - 2.0)).abs() < 1e-9, "Fläche ohne Loch: {}", ring_area(&c[0].pts));
    assert!(c[0].nse.as_ref().is_some_and(|n| !n.is_empty()), "Brückenkanten ohne Strich");
}

#[test]
fn offenes_netz_als_linie() {
    // Senkrechte Fläche x = 2, y −1…1, z 0…2 (ohne Dicke).
    let pos = vec![2.0, -1.0, 0.0, 2.0, 1.0, 0.0, 2.0, 1.0, 2.0, 2.0, -1.0, 2.0];
    let idx = vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0];
    let p = with(vec![mesh("f", (pos, idx))]);
    let o = compute_section(&p, &lv(false), &[]).unwrap().unwrap();
    assert!(mesh_cuts(&o).is_empty());
    assert_eq!(o.mesh_lines.len(), 1, "{:?}", o.mesh_lines);
    let l = &o.mesh_lines[0].1;
    let len: f64 = l.windows(2).map(|w| hypot2(w[1][0] - w[0][0], w[1][1] - w[0][1])).sum();
    assert!((len - 2.0).abs() < 1e-9 && l.iter().all(|q| (q[0] - 7.0).abs() < 1e-9), "{l:?}");
    let (prims, _) = section_primitives(&o, false, false, &Visibility::default());
    assert!(prims.iter().any(|q| matches!(q, Primitive::Line { cls, .. } if cls == "section-cut-outline")));
    // Ganz hinter der Ebene: keine Schnittlinie, aber Projektion (beidseitig, auch von hinten).
    let pos = vec![0.0, 2.0, 0.0, 3.0, 2.0, 0.0, 3.0, 2.0, 2.0, 0.0, 2.0, 2.0];
    for idx in [vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], vec![0.0, 2.0, 1.0, 0.0, 3.0, 2.0]] {
        let o = compute_section(&with(vec![mesh("f", (pos.clone(), idx))]), &lv(false), &[]).unwrap().unwrap();
        assert!(o.mesh_lines.is_empty());
        let n = o.visible.iter().filter(|e| e.kind == Kind::Mesh).count();
        assert_eq!(n, 4, "Umriss der Fläche ohne Diagonale: {:?}", o.visible);
    }
}

#[test]
fn netz_hinter_wand_verdeckt() {
    let top = |o: &Output| o.visible.iter().filter(|e| e.kind == Kind::Mesh).map(|e| e.a[1].max(e.b[1])).fold(f64::NEG_INFINITY, f64::max);
    let low = mesh("n", cube(0.0, 2.0, 3.0, 4.0, 0.0, 2.0));
    // Frei: Umriss sichtbar.
    let o = compute_section(&with(vec![low.clone()]), &lv(false), &[]).unwrap().unwrap();
    assert!((top(&o) - 2.0).abs() < 1e-9, "{:?}", o.visible);
    assert_eq!(o.visible.iter().filter(|e| e.kind == Kind::Mesh).count(), 4, "Vorderseite ohne Diagonale: {:?}", o.visible);
    assert!(o.cuts.is_empty());
    // Hinter einer 3 m hohen Wand (y = 1): ganz verdeckt, verdeckte Kanten als solche.
    let wall = Wall { id: "w".into(), start: Vec2 { x: -1.0, y: 1.0 }, end: Vec2 { x: 5.0, y: 1.0 }, height: 3.0, ..Default::default() };
    let mut p = with(vec![low]);
    p.walls = vec![wall.clone()];
    let o = compute_section(&p, &lv(true), &[]).unwrap().unwrap();
    assert!(!o.visible.iter().any(|e| e.kind == Kind::Mesh), "{:?}", o.visible);
    assert!(o.hidden.iter().any(|e| e.kind == Kind::Mesh));
    // Höher als die Wand: nur der Teil über der Wand sichtbar.
    let mut p = with(vec![mesh("n", cube(0.0, 2.0, 3.0, 4.0, 0.0, 4.0))]);
    p.walls = vec![wall];
    let o = compute_section(&p, &lv(false), &[]).unwrap().unwrap();
    let vis: Vec<&Edge> = o.visible.iter().filter(|e| e.kind == Kind::Mesh).collect();
    assert!(!vis.is_empty() && vis.iter().all(|e| e.a[1].min(e.b[1]) > 3.0 - 1e-6), "{vis:?}");
    // Ansichtsbereich: weiter weg als die Tiefe → entfällt.
    let mut l = lv(false);
    l.depth = Some(2.0);
    let o = compute_section(&with(vec![mesh("n", cube(0.0, 2.0, 3.0, 4.0, 0.0, 2.0))]), &l, &[]).unwrap().unwrap();
    assert!(!o.visible.iter().any(|e| e.kind == Kind::Mesh));
}

#[test]
fn geschnittenes_netz_verdeckt_seine_rueckseite() {
    // Würfel durch die Ebene: hinter der Schnittfläche nichts, keine Kante auf der Schnittfläche.
    let o = compute_section(&with(vec![mesh("w", cube(1.0, 3.0, -1.0, 2.0, 0.0, 2.5))]), &lv(true), &[]).unwrap().unwrap();
    let inside = |q: [f64; 2]| q[0] > 6.0 + 1e-6 && q[0] < 8.0 - 1e-6 && q[1] > 1e-6 && q[1] < 2.5 - 1e-6;
    for e in o.visible.iter().chain(&o.hidden) {
        assert!(!inside([(e.a[0] + e.b[0]) / 2.0, (e.a[1] + e.b[1]) / 2.0]), "{e:?}");
    }
}

#[test]
fn netz_override_fuellung_und_ausblenden() {
    let mut p = with(vec![mesh("w", cube(1.0, 3.0, -1.0, 2.0, 0.0, 2.5))]);
    let rule = |id: &str, actions: serde_json::Value| -> OverrideRule {
        serde_json::from_value(serde_json::json!({"id": id, "name": id, "enabled": true, "condition": {"type": "element_kind", "operator": "equals", "value": "mesh"}, "actions": actions})).unwrap()
    };
    p.override_rules = Some(vec![rule("weiss", serde_json::json!({"fillColor": "#ffffff", "hatch": "none"}))]);
    let o = compute_section(&p, &lv(false), &[]).unwrap().unwrap();
    let rules = CutRules::of(&p, &o, RuleView::at(100.0, None).view("section"));
    let (prims, _) = section_primitives_at(&o, false, false, &Visibility::default(), 100.0, Detail::Mittel, false, &rules);
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { fill, context_object_id: Some(id), .. } if id == "w" && fill == "#ffffff")), "Regel-Füllung statt schwarz");
    p.override_rules = Some(vec![rule("weg", serde_json::json!({"hide": true}))]);
    let hidden = super::super::overrides::hidden_elements(&p, RuleView::at(100.0, None).view("section"));
    assert!(hidden.contains("w"));
    let q = without_elements(&p, &hidden);
    assert!(mesh_cuts(&compute_section(&q, &lv(false), &[]).unwrap().unwrap()).is_empty());
}

/// [152]/[181] Geschlossenes Gelände-Netz (z. B. IFC-Gelände als 1 m dicke Platte, beim Import zum Gelände-Element
/// geworden): im Schnitt Geländelinie (nur Oberkante) mit Erdreich statt geschnittener Körper; ein Netzkörper gleicher
/// Form bleibt Körper — entscheidend ist die Elementart, nicht Name oder Herkunft.
#[test]
fn geschlossenes_gelaende_als_gelaendelinie() {
    let (positions, indices) = cube(-4.0, 7.0, -3.0, 3.0, -1.0, 0.0);
    let terrain = ContextObject::TerrainMesh(TerrainMesh { id: "g".into(), name: "Site".into(), category_code: "02".into(), positions: positions.clone(), indices: indices.clone(), ..Default::default() });
    {
        let p = with(vec![terrain, mesh("w", cube(1.0, 3.0, -1.0, 2.0, 0.0, 2.5))]);
        let o = compute_section(&p, &lv(false), &[]).unwrap().unwrap();
        let c = mesh_cuts(&o);
        assert_eq!(c.len(), 1, "nur der Würfel als Schnittfläche");
        assert_eq!(c[0].source_id.as_deref(), Some("w"));
        // Geländelinie = Oberkante z = 0 über die ganze Breite (u 1 … 12), kein Unterrand.
        let len: f64 = o.profiles.iter().flat_map(|pr| pr.pts.windows(2)).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum();
        assert!(o.profiles.iter().all(|pr| !pr.natural && pr.pts.iter().all(|q| q[1].abs() < 1e-9)), "{:?}", o.profiles);
        assert!((len - 11.0).abs() < 1e-6, "{len}");
        assert_eq!(o.terrain_id.as_deref(), Some("g"));
        assert!(!o.earth.is_empty(), "Erdreich-Band unter der Linie");
        // Keine Projektionskanten des Geländes.
        assert!(o.visible.iter().all(|e| e.kind != Kind::Mesh || o.meshes.get(e.index).is_some_and(|m| m.id == "w")));
        let (prims, _) = section_primitives_at(&o, false, false, &Visibility::default(), 100.0, Detail::Mittel, false, &CutRules::default());
        assert!(prims.iter().any(|q| matches!(q, Primitive::Line { cls, .. } if cls == "section-terrain")));
    }
    // Netzkörper gleicher Form (auch mit Namen „Gelände"): Körper.
    let p = with(vec![ContextObject::ImportedMesh(ImportedMesh { id: "g".into(), name: "Gelände".into(), category_code: "10".into(), positions, indices, ..Default::default() })]);
    let o = compute_section(&p, &lv(false), &[]).unwrap().unwrap();
    assert_eq!(mesh_cuts(&o).len(), 1);
    assert!(o.profiles.is_empty());
}

/// [256] Nachbargebäude (Netz auf „12 Gebäude", Klasse mit Füllung): im Schnitt hellgrau mit Umriss in Klassenfarbe
/// statt schwarz, nicht in der schweren Schnittkante; ohne Füllung der Klasse wie bisher schwarz. Über das Geländeende
/// hinaus nichts (Gelände u 1 … 12): der Nachbar rechts davon entfällt, einer über dem Rand wird beschnitten.
#[test]
fn nachbargebaeude_hellgrau_und_nur_ueber_dem_gelaende() {
    let (positions, indices) = cube(-4.0, 7.0, -3.0, 3.0, -1.0, 0.0);
    let terrain = ContextObject::TerrainMesh(TerrainMesh { id: "g".into(), name: "Site".into(), category_code: "02".into(), positions, indices, ..Default::default() });
    let nb = |id: &str, x0: f64, x1: f64| ContextObject::ImportedMesh(ImportedMesh { id: id.into(), name: id.into(), category_code: "12".into(), positions: cube(x0, x1, -1.0, 2.0, 0.0, 6.0).0, indices: cube(x0, x1, -1.0, 2.0, 0.0, 6.0).1, ..Default::default() });
    let mut p = with(vec![terrain, nb("innen", 0.0, 2.0), nb("rand", 6.0, 9.0), nb("weg", 10.0, 12.0)]);
    p.layers = vec![LayerCategory { code: "12".into(), name: "Gebäude".into(), color: "#888888".into(), lw: 0.25, visible: true, fill: Some("#d9d9d9".into()), ..Default::default() }];
    let o = compute_section(&p, &lv(false), &[]).unwrap().unwrap();
    let ids = |o: &Output| mesh_cuts(o).iter().filter_map(|c| c.source_id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&o), ["innen", "rand"], "rechts vom Gelände kein Schnitt");
    let rand = mesh_cuts(&o).into_iter().find(|c| c.source_id.as_deref() == Some("rand")).unwrap();
    assert!((bbox(&rand.pts)[1] - 12.0).abs() < 1e-9, "endet am Geländeende u = 12: {:?}", rand.pts);
    assert!(o.visible.iter().chain(&o.hidden).all(|e| e.kind != Kind::Mesh || (e.a[0] <= 12.0 + 1e-9 && e.b[0] <= 12.0 + 1e-9)), "Kanten enden am Gelände");
    let rules = CutRules::of(&p, &o, RuleView::at(100.0, None));
    let (prims, _) = section_primitives_at(&o, true, false, &Visibility::default(), 100.0, Detail::Mittel, false, &rules);
    let poly = |id: &str| prims.iter().find_map(|q| match q { Primitive::Polygon { fill, stroke, stroke_width_mm, context_object_id: Some(i), .. } if i == id => Some((fill.clone(), stroke.clone(), *stroke_width_mm)), _ => None }).unwrap();
    assert_eq!(poly("innen"), ("#d9d9d9".to_string(), "#888888".to_string(), 0.25));
    assert!(!prims.iter().any(|q| matches!(q, Primitive::Line { cls, a, .. } if cls == "section-cut-outline" && a.x > 4.9 && a.x < 7.1)), "keine schwere Schnittkante um den Nachbarn");
    // Klasse ohne Füllung: schwarz wie freie Körper.
    p.layers[0].fill = None;
    let rules = CutRules::of(&p, &o, RuleView::at(100.0, None));
    let (prims, _) = section_primitives_at(&o, true, false, &Visibility::default(), 100.0, Detail::Mittel, false, &rules);
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { fill, context_object_id: Some(i), .. } if i == "innen" && fill == HATCH_INK)));
}
