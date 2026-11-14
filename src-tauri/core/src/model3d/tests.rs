//! Tests zur 3D-Ableitung (`model3d/`): Wände, Decken, Öffnungen, Treppen, Dächer, Kontext, Pick-Geometrie.

use super::*;

/// [149] Bäume im 3D (Stamm + Krone bei den Stützen-Meshes), im Pick und mit Fuss auf dem Gelände.
#[test]
fn baeume_im_3d_und_pick() {
    let mut p = sample();
    let n0 = parts(&p, true, 1.0, false).unwrap().column_meshes.len();
    p.trees = Some(vec![Tree { id: "T1".into(), r#type: "tree".into(), floor_id: "eg".into(), category_code: "13".into(), position: Vec2 { x: 20.0, y: 5.0 }, trunk_diameter: 0.4, crown_diameter: 6.0, crown_base: 3.0, height: 12.0, species: Some("Quercus robur".into()), ..Default::default() }, Tree { id: "T2".into(), shape: TreeShape::Conical, foliage: TreeFoliage::Conifer, base_offset: Some(0.5), ..Tree { id: "T1".into(), r#type: "tree".into(), floor_id: "eg".into(), category_code: "13".into(), position: Vec2 { x: 20.0, y: 5.0 }, trunk_diameter: 0.4, crown_diameter: 6.0, crown_base: 3.0, height: 12.0, species: Some("Quercus robur".into()), ..Default::default() } }]);
    let m = parts(&p, true, 1.0, false).unwrap().column_meshes;
    assert_eq!(m.len(), n0 + 4);
    let crown = &m[n0 + 1];
    assert_eq!(crown.color, crate::tree::CROWN_RGB);
    assert_eq!(m[n0 + 3].color, crate::tree::CONIFER_RGB);
    let zmax = crown.positions.chunks_exact(3).map(|q| q[2]).fold(f64::NEG_INFINITY, f64::max);
    let base = p.floor("eg").map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
    assert!((zmax - (base + 12.0)).abs() < 1e-9, "{zmax}");
    let z2 = m[n0 + 2].positions.chunks_exact(3).map(|q| q[2]).fold(f64::INFINITY, f64::min);
    assert!((z2 - (base + 0.5)).abs() < 1e-9, "Fuss mit Versatz: {z2}");
    // Wenige Dreiecke je Baum.
    assert!(m[n0..].iter().map(|x| x.indices.len() / 3).sum::<usize>() < 2 * 250);
    let g = pick_geometry(&p).unwrap();
    assert_eq!(g.trees.len(), 2);
    assert_eq!(g.trees[0].tree_id, "T1");
    // Welt-Dreiecke (x, Höhe, y): Höhe bis zur Spitze.
    let h = g.trees[0].tris.iter().flatten().map(|v| v[1]).fold(f64::NEG_INFINITY, f64::max);
    assert!((h - (base + 12.0)).abs() < 1e-9);
}

/// [112] Achsraster mit `show3d` erscheint als Boden-Spur (eine Strecke je Achse), ohne Flag nicht.
#[test]
fn achsraster_im_3d_nur_mit_flag() {
    let mk = |show: serde_json::Value| -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "openings": [], "walls": [],
            "drawingLevels": [{"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 1.0}],
            "drawings2d": [{"id": "G", "type": "drawing2d", "levelId": "F", "categoryCode": "20", "geom": {"shape": "grid", "origin": {"x": 0, "y": 0}, "angle": 0,
                "a": [{"label": "1", "pos": 0}, {"label": "2", "pos": 4}], "b": [{"label": "A", "pos": 0}], "show3d": show}}]
        }))
        .unwrap()
    };
    assert!(drawing_line_verts(&mk(serde_json::json!(false))).is_empty());
    let v = drawing_line_verts(&mk(serde_json::json!(true)));
    // 3 Achsen × 1 Segment × 2 Endpunkte × 6 Zahlen.
    assert_eq!(v.len(), 3 * 2 * 6);
    assert!((v[1] - 1.01).abs() < 1e-4, "Höhe = Geschoss-UK + 0.01: {}", v[1]);
}

/// Walmdach 12×7 m: zwei Trapeze + zwei Walm-Dreiecke, First (3,3)-(8,3).
fn walm_planes() -> Vec<Vec<V3>> {
    vec![
        vec![[-0.5, -0.5, 5.2], [11.5, -0.5, 5.2], [8.0, 3.0, 7.061], [3.0, 3.0, 7.061]],
        vec![[-0.5, 6.5, 5.2], [11.5, 6.5, 5.2], [8.0, 3.0, 7.061], [3.0, 3.0, 7.061]],
        vec![[-0.5, -0.5, 5.2], [-0.5, 6.5, 5.2], [3.0, 3.0, 7.061]],
        vec![[11.5, -0.5, 5.2], [11.5, 6.5, 5.2], [8.0, 3.0, 7.061]],
    ]
}

fn near(a: V3, b: V3) -> bool {
    hypot(&[a[0] - b[0], a[1] - b[1], a[2] - b[2]]) < 1e-6
}

/// [T6]/[114] Gelände in ausgeblendeter Kategorie kommt nicht ins 3D.
#[test]
fn gelaende_ausgeblendet_nicht_im_3d() {
    let t = crate::model::TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], indices: vec![0.0, 1.0, 2.0], ..Default::default() };
    let cat = |visible| crate::model::LayerCategory { code: "02".into(), name: "Gelände".into(), visible, ..Default::default() };
    let mk = |visible| Project { context: Some(vec![ContextObject::TerrainMesh(t.clone())]), layers: vec![cat(visible)], ..Default::default() };
    assert_eq!(emit_context_meshes(&mk(true)).len(), 1);
    assert!(emit_context_meshes(&mk(false)).is_empty());
    // Elternebene „05 Kontext" aus blendet das Kind „02" mit aus.
    let parent = |visible| crate::model::LayerCategory { code: "05".into(), name: "Kontext".into(), visible, children: Some(vec![cat(true)]), ..Default::default() };
    let pp = |visible| Project { layers: vec![parent(visible)], ..mk(true) };
    assert_eq!(emit_context_meshes(&pp(true)).len(), 1);
    assert!(emit_context_meshes(&pp(false)).is_empty());
}

/// [137] 3D-Picken: Dreiecke der Baugrube (Sohle, Böschung) tragen die Id der Baugrube, das übrige
/// Gelände die des Netzes.
#[test]
fn pick_gelaende_und_baugrube_im_3d() {
    let t = crate::model::TerrainMesh {
        id: "t".into(),
        positions: vec![0.0, 0.0, 0.0, 60.0, 0.0, 6.0, 60.0, 40.0, 6.0, 0.0, 40.0, 0.0],
        indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
        ..Default::default()
    };
    let v = |x: f64, y: f64| crate::model::Vec2 { x, y };
    let pit = crate::model::Excavation { id: "bg".into(), outline: vec![v(20.0, 15.0), v(30.0, 15.0), v(30.0, 25.0), v(20.0, 25.0)], bottom: 1.0, ..Default::default() };
    let p = Project { context: Some(vec![ContextObject::Excavation(pit), ContextObject::TerrainMesh(t)]), ..Default::default() };
    let g = pick_geometry(&p).unwrap();
    let of = |id: &str| g.context_meshes.iter().find(|m| m.context_object_id == id).map(|m| m.tris.clone()).unwrap_or_default();
    let (bg, terr) = (of("bg"), of("t"));
    assert!(!bg.is_empty() && !terr.is_empty(), "{} {}", bg.len(), terr.len());
    // Welt (x, z, −y): alle Baugruben-Dreiecke liegen im Wirkbereich (x 18…32, y 13…27), Sohle auf 1 m dabei.
    for tri in &bg {
        let (cx, cy) = ((tri[0][0] + tri[1][0] + tri[2][0]) / 3.0, -(tri[0][2] + tri[1][2] + tri[2][2]) / 3.0);
        assert!((17.0..=33.0).contains(&cx) && (12.0..=28.0).contains(&cy), "{cx} {cy}");
    }
    assert!(bg.iter().any(|tri| tri.iter().all(|q| (q[1] - 1.0).abs() < 1e-6)));
}

/// [137] Stützen sind im 3D anwählbar: ihr Prisma kommt mit Id in die Pick-Geometrie (Welt: x, Höhe, y —
/// wie render3d `Extrusion`; vorher −y, d. h. gespiegelt zur Darstellung).
#[test]
fn pick_stuetzen_im_3d() {
    let p: Project = serde_json::from_value(serde_json::json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "openings": [], "walls": [],
        "drawingLevels": [{"id": "EG", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0.0}],
        "columns": [{"id": "k1", "type": "column", "floorId": "EG", "categoryCode": "25", "position": {"x": 2, "y": 3}, "profile": {"kind": "rect", "width": 0.3, "depth": 0.3}, "rotation": 0, "height": 2.5}],
        "drawings2d": []
    }))
    .unwrap();
    let g = pick_geometry(&p).unwrap();
    assert_eq!(g.columns.len(), 1);
    assert_eq!(g.columns[0].column_id, "k1");
    let v: Vec<&V3> = g.columns[0].tris.iter().flatten().collect();
    assert!(v.iter().all(|q| (q[0] - 2.0).abs() <= 0.15 + 1e-9 && (q[2] - 3.0).abs() <= 0.15 + 1e-9 && q[1] >= -1e-9 && q[1] <= 2.5 + 1e-9));
    assert!(v.iter().any(|q| (q[1] - 2.5).abs() < 1e-9));
}

fn solid_project() -> Project {
    serde_json::from_value(serde_json::json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "openings": [], "walls": [],
        "drawingLevels": [
            {"id": "EG", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0.0},
            {"id": "OG", "name": "OG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 3.0}],
        "extrudedSolids": [
            {"id": "s1", "type": "extrudedSolid", "levelId": "OG", "points": [{"x": 1, "y": 2}, {"x": 3, "y": 2}, {"x": 3, "y": 5}, {"x": 1, "y": 5}], "height": 1.5, "baseOffset": 0.5},
            {"id": "v1", "type": "extrudedSolid", "levelId": "EG", "points": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "height": 1.0, "operation": "subtract"}],
        "drawings2d": []
    }))
    .unwrap()
}

/// [137] Freie Körper sind im 3D anwählbar: Prisma über dem Umriss (Welt x, Höhe, y), UK = Geschoss + Versatz;
/// Abzugskörper (nur Umriss) nicht. Mit Explosion wandern sie mit ihrem Geschoss.
#[test]
fn pick_freie_koerper_im_3d() {
    let p = solid_project();
    let g = pick_geometry(&p).unwrap();
    assert_eq!(g.solids.len(), 1);
    assert_eq!(g.solids[0].solid_id, "s1");
    let v: Vec<&V3> = g.solids[0].tris.iter().flatten().collect();
    assert!(v.iter().all(|q| (1.0 - 1e-9..=3.0 + 1e-9).contains(&q[0]) && (2.0 - 1e-9..=5.0 + 1e-9).contains(&q[2]) && (3.5 - 1e-9..=5.0 + 1e-9).contains(&q[1])));
    assert!(v.iter().any(|q| (q[1] - 5.0).abs() < 1e-9) && v.iter().any(|q| (q[1] - 3.5).abs() < 1e-9));
    let e = crate::explode3d::pick_geometry(&p, 2.0).unwrap();
    let top = e.solids[0].tris.iter().flatten().map(|q| q[1]).fold(f64::NEG_INFINITY, f64::max);
    assert!((top - 7.0).abs() < 1e-9, "{top}");
}

/// [137] Dachfenster sind im 3D anwählbar (Netz mit Id); das Dach hat dort ein Loch statt der vollen Fläche.
#[test]
fn pick_dachfenster_im_3d() {
    let mut p = sample();
    p.openings.as_mut().unwrap().push(Opening {
        id: "DF".into(),
        kind: ElementKind::Window,
        width: 0.78,
        height: 1.18,
        host_roof_id: Some("RF1".into()),
        host_point: Some(Vec2 { x: 2.5, y: 1.0 }),
        ..Default::default()
    });
    let g = pick_geometry(&p).unwrap();
    let df = g.opening_meshes.iter().find(|m| m.opening_id == "DF").expect("Dachfenster in der Pick-Geometrie");
    assert!(df.tris.len() > 12);
    // Welt (x, Höhe, y): um den Wirtpunkt (2.5, 1.0).
    let (cx, cz) = df.tris.iter().flatten().fold((0.0, 0.0), |a, q| (a.0 + q[0], a.1 + q[2]));
    let n = (df.tris.len() * 3) as f64;
    assert!((cx / n - 2.5).abs() < 1.0 && (cz / n - 1.0).abs() < 1.5, "{} {}", cx / n, cz / n);
    assert!(g.roofs.iter().any(|r| r.roof_id == "RF1" && !r.tris.is_empty()));
}

/// [137]/[181] Gelände-Elemente verschwinden mit ihrer Klasse aus 3D und Pick-Geometrie; ein Gelände anderer Klasse bleibt.
#[test]
fn gelaende_nach_klasse_ausblenden() {
    let mk = |id: &str, code: &str| {
        ContextObject::TerrainMesh(TerrainMesh {
            id: id.into(),
            positions: vec![0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 10.0, 10.0, 1.0],
            indices: vec![0.0, 1.0, 2.0],
            category_code: code.into(),
            ..Default::default()
        })
    };
    let mut p = Project { context: Some(vec![mk("b", "05"), mk("c", "02")]), ..Default::default() };
    let ids = |p: &Project| pick_geometry(p).unwrap().context_meshes.iter().map(|m| m.context_object_id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&p), vec!["b", "c"]);
    assert_eq!(emit_context_meshes(&p).len(), 2);
    p.layers = serde_json::from_value(serde_json::json!([{"code": "02", "name": "Gelände", "color": "#000000", "visible": false}])).unwrap();
    assert_eq!(ids(&p), vec!["b"]);
    assert_eq!(emit_context_meshes(&p).len(), 1);
}

/// [212] Gelände mit Bauteil: Farbe des Bauteils und Textur-Ebene seiner Farbkarte (hinter den Gebäude-Karten, deren
/// Ebenen bleiben); ohne Bauteil, mit unbekanntem oder ohne Karte: Grundfarbe, keine Ebene.
#[test]
fn gelaende_material_aus_bauteil() {
    let mut p = sample();
    let before = wall_material_color_maps(&p);
    let mut comps = p.components.clone();
    comps.push(serde_json::from_value(serde_json::json!({
        "id": "rasen", "name": "Rasen", "color": "#4a7a30",
        "material": { "color": "/assets/materials/Grass005/color.jpg", "sizeM": 4 }
    })).unwrap());
    comps.push(serde_json::from_value(serde_json::json!({ "id": "ohne", "name": "Ohne Karte", "color": "#808080" })).unwrap());
    p.components = comps;
    let terrain = |comp: Option<&str>| ContextObject::TerrainMesh(TerrainMesh {
        id: "t".into(),
        positions: vec![0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 10.0, 10.0, 1.0],
        indices: vec![0.0, 1.0, 2.0],
        category_code: "02".into(),
        component_id: comp.map(str::to_owned),
        ..Default::default()
    });
    let mesh = |p: &Project| emit_context_meshes(p).into_iter().find(|m| m.kind == "terrain").unwrap();
    p.context = Some(vec![terrain(None)]);
    assert_eq!(mesh(&p).material_index, None);
    assert_eq!(wall_material_color_maps(&p), before);
    p.context = Some(vec![terrain(Some("rasen"))]);
    let maps = wall_material_color_maps(&p);
    assert_eq!(&maps[..before.len()], &before[..], "Gebäude-Ebenen unverändert");
    assert_eq!(maps.last().map(String::as_str), Some("/assets/materials/Grass005/color.jpg"));
    let m = mesh(&p);
    assert_eq!(m.material_index, Some(maps.len() as f64));
    assert!((m.color[1] - 0x7a as f64 / 255.0).abs() < 1e-9, "Farbe des Bauteils: {:?}", m.color);
    for comp in ["ohne", "gibtsnicht", ""] {
        p.context = Some(vec![terrain(Some(comp))]);
        assert_eq!(mesh(&p).material_index, None, "{comp}");
    }
    // Rundreise JSON: `componentId`.
    let js = serde_json::to_value(TerrainMesh { component_id: Some("rasen".into()), ..Default::default() }).unwrap();
    assert_eq!(js["componentId"], serde_json::json!("rasen"));
}

/// [T4] Import-Mesh glatt: Knickwinkel geht ans 3D (Vorgabe 30°), kantig ohne; JSON `creaseAngle`.
#[test]
fn import_mesh_glatt_mit_knickwinkel() {
    let mesh = |smooth: Option<bool>, crease: Option<f64>| {
        let m = ImportedMesh { id: "m".into(), positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], indices: vec![0.0, 1.0, 2.0], smooth_shading: smooth, crease_angle: crease, ..Default::default() };
        let p = Project { context: Some(vec![ContextObject::ImportedMesh(m)]), ..Default::default() };
        emit_context_meshes(&p).remove(0)
    };
    assert_eq!(mesh(None, Some(45.0)).crease_angle, None);
    assert_eq!(mesh(Some(true), None).crease_angle, Some(DEFAULT_CREASE_DEG));
    assert_eq!(mesh(Some(true), Some(12.5)).crease_angle, Some(12.5));
    assert_eq!(mesh(Some(true), Some(f64::NAN)).crease_angle, Some(DEFAULT_CREASE_DEG));
    let js = serde_json::to_value(mesh(Some(true), Some(12.5))).unwrap();
    assert_eq!(js["creaseAngle"], serde_json::json!(12.5));
    assert!(serde_json::to_value(mesh(None, None)).unwrap().get("creaseAngle").is_none());
}

#[test]
fn gehrung_erkennt_first_und_grate_als_geteilt() {
    let planes = walm_planes();
    let m = Mitre::new(&planes);
    assert_eq!(m.shared[0], vec![false, true, true, true]); // Traufe, Grat, First, Grat
    assert_eq!(m.shared[2], vec![false, true, true]);
}

#[test]
fn unterseiten_treffen_sich_am_first_apex() {
    let planes = walm_planes();
    let m = Mitre::new(&planes);
    let d = 0.27;
    let (a, b, c) = (m.at(0, d)[3], m.at(1, d)[3], m.at(2, d)[2]);
    assert!(near(a, b) && near(a, c));
    assert!(a[2] < 7.061);
    assert_eq!(m.at(0, 0.0), planes[0]);
    assert!(m.at(0, 0.2)[0][2] < 5.2);
}

fn sample() -> Project {
    serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
}

/// [G3] Rundbogen: Füllkörper in Wandfarbe zwischen Rechteck-Loch und Bogen, Rahmen und Glas entlang
/// des Umrisses; alle Quader innerhalb des Öffnungs-Rechtecks.
#[test]
fn formoeffnung_fuellkoerper_rahmen_glas() {
    let mut p = sample();
    // Ohne die [168]-Vorgabe (Dämmung überdeckt den Rahmen): Fenster ausdrücklich aussen bündig.
    for t in p.window_types.iter_mut().flatten() {
        t.inset_face = Some(WindowTypeInsetFace::Aussen);
    }
    let plain = emit_opening_meshes(&p, 2.0).len();
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.shape = Some(OpeningShape::Rundbogen);
    }
    let meshes = emit_opening_meshes(&p, 2.0);
    let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap();
    let wall_rgb = resolve_wall_bands(&p, &wall_material_color_maps(&p), w1, false).0[0].color;
    // [216] Der Wandkörper reicht bis zum Umriss: die Öffnungsteile haben keine Füllkörper mehr, nur Rahmen und Glas.
    assert_ne!(meshes.len(), plain);
    assert!(meshes.iter().all(|m| m.color != wall_rgb), "keine Füllkörper in den Öffnungsteilen");
    assert!(emit_walls(&p, true).unwrap().iter().any(|w| w.wall_id == "W1" && w.body.is_some()));
    // Die Füllkörper selbst (Export, Bogenwände): Streifen in Wandfarbe zwischen Rechteck-Loch und Bogen.
    let (zb, _) = p.wall_vertical_extent(w1);
    let o1 = p.openings.as_ref().unwrap().iter().find(|o| o.id == "O1").unwrap();
    let direct = shaped_wall_opening_meshes(&p, w1, &wall_ref(&p, w1), o1, [3.0, 4.0, zb + 0.9, zb + 2.1]);
    let fills: Vec<&RMesh> = direct.iter().filter(|m| m.color == wall_rgb).collect();
    assert!(fills.len() >= 10, "Bogenzwickel als Streifen: {}", fills.len());
    // O1: x 3…4 an der Wand y = 0, Brüstung 0,9, Höhe 1,2: Füllung nur über dem Kämpfer (0,7).
    for m in &fills {
        for c in m.positions.chunks_exact(3) {
            assert!(c[0] > 3.0 - 1e-9 && c[0] < 4.0 + 1e-9 && c[2] >= zb + 0.9 + 0.7 - 1e-9 && c[2] <= zb + 2.1 + 1e-9, "{c:?}");
        }
    }
    assert!(meshes.iter().any(|m| m.color == PART_RGB[0]) && meshes.iter().any(|m| m.color == PART_RGB[1]));
}

/// [234] Eine Formöffnung, die über die Wandoberkante reicht (Brüstung + Höhe > Wandhöhe), wird an der Oberkante
/// gekappt wie das Rechteck: weder Leibung, Rahmen und Glas noch der Wandkörper ragen über die Wand.
#[test]
fn formoeffnung_ueber_wandoberkante_ragt_nicht_ueber_die_wand() {
    let mut p = sample();
    let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap().clone();
    let (_, zt) = p.wall_vertical_extent(&w1);
    for shape in [None, Some(OpeningShape::Rundbogen), Some(OpeningShape::Spitzbogen)] {
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.shape = shape;
            o.sill_height = 0.9;
            o.height = zt + 1.0;
        }
        let max_z = |ms: &[RMesh]| ms.iter().flat_map(|m| m.positions.chunks_exact(3).map(|c| c[2])).fold(f64::NEG_INFINITY, f64::max);
        let meshes = emit_opening_meshes(&p, 2.0);
        assert!(max_z(&meshes) <= zt + 1e-6, "{shape:?}: Öffnungsteile bis {} über Wandoberkante {zt}", max_z(&meshes));
        let walls = emit_walls(&p, true).unwrap();
        for b in walls.iter().filter(|w| w.wall_id == "W1").filter_map(|w| w.body.as_ref()) {
            let top = b.positions.chunks_exact(3).map(|c| c[2]).fold(f64::NEG_INFINITY, f64::max);
            assert!(top <= zt + 1e-3, "{shape:?}: Wandkörper bis {top} über {zt}");
        }
    }
}

/// [103] Dachfenster: jede Dachschicht bleibt ein geschlossener Körper mit Loch; Fensterteile kommen dazu.
#[test]
fn dachfenster_schneidet_alle_schichten() {
    let mut p = sample();
    let before = emit_roofs(&p, None).unwrap();
    p.openings.as_mut().unwrap().push(Opening {
        id: "DF".into(),
        kind: ElementKind::Window,
        width: 0.78,
        height: 1.18,
        host_roof_id: Some("RF1".into()),
        host_point: Some(Vec2 { x: 2.5, y: 1.0 }),
        ..Default::default()
    });
    let after = emit_roofs(&p, None).unwrap();
    assert_eq!(before.len(), after.len());
    for m in &after {
        assert!(crate::wall_mesh_cut::is_watertight(&m.positions, &m.indices, 1e-6), "Schicht dicht");
    }
    let vol = |ms: &[RMesh]| ms.iter().map(|m| crate::export_flat::mesh_volume(&m.positions, &m.indices)).sum::<f64>();
    let removed = vol(&before) - vol(&after);
    let t: f64 = p.roof_layers(&p.roofs.as_ref().unwrap()[0]).iter().map(|l| l.thickness).sum();
    assert!((removed - 0.78 * 1.18 * t).abs() < 1e-6, "Loch = Fläche × Dicke: {removed}");
    let parts = emit_opening_meshes(&p, 2.0).len() - emit_opening_meshes(&sample(), 2.0).len();
    assert!(parts >= 9, "Rahmen, Glas, Eindeckrahmen: {parts}");
    let layers = emit_roof_cut_layers(&p).unwrap().len();
    assert!(layers > emit_roof_cut_layers(&sample()).unwrap().len());
}

/// Flachdach auf L-Umriss ([148]): Körper = L × Dachaufbau (nicht Bounding-Box), jede Schicht dicht;
/// ein Dachfenster genau über der Fuge zweier Teilflächen schneidet beide, Laibung nur einmal.
#[test]
fn flachdach_l_volumen_und_dachfenster_ueber_der_fuge() {
    let mut p = sample();
    let l = [(0.0, 0.0), (11.0, 0.0), (11.0, 4.0), (8.0, 4.0), (8.0, 6.0), (0.0, 6.0)];
    {
        let r = &mut p.roofs.as_mut().unwrap()[0];
        r.outline = l.iter().map(|&(x, y)| Vec2 { x, y }).collect();
        r.shape = crate::model::RoofShape::Flach;
        r.pitch_deg = 0.0;
        r.overhang = 0.0;
        r.overhang_gable = None;
    }
    let t: f64 = p.roof_layers(&p.roofs.as_ref().unwrap()[0]).iter().map(|l| l.thickness).sum();
    let vol = |ms: &[RMesh]| ms.iter().map(|m| crate::export_flat::mesh_volume(&m.positions, &m.indices)).sum::<f64>();
    let before = emit_roofs(&p, None).unwrap();
    assert!((vol(&before) - 60.0 * t).abs() < 1e-6, "L-Fläche × Dicke: {} statt {}", vol(&before), 60.0 * t);
    for m in &before {
        assert!(crate::wall_mesh_cut::is_watertight(&m.positions, &m.indices, 1e-6), "Schicht dicht");
        assert!(m.positions.chunks_exact(3).all(|c| !(c[0] > 8.0 + 1e-9 && c[1] > 4.0 + 1e-9)), "nichts über der Aussparung");
    }
    // Fuge = gemeinsame Kante zweier Teilflächen; Dachfenster mitten darauf.
    let g = crate::roof::roof_geometry(&p.roofs.as_ref().unwrap()[0].params(), 0.0);
    assert!(g.planes.len() >= 2);
    let (a, b) = (0..g.planes.len())
        .flat_map(|i| (0..g.planes[i].len()).map(move |k| (i, k)))
        .find_map(|(i, k)| {
            let pl = &g.planes[i];
            let (u, v) = (pl[k], pl[(k + 1) % pl.len()]);
            g.planes.iter().enumerate().any(|(j, q)| j != i && q.contains(&u) && q.contains(&v)).then_some((u, v))
        })
        .expect("Fuge");
    let mid = Vec2 { x: (a[0] + b[0]) / 2.0, y: (a[1] + b[1]) / 2.0 };
    p.openings.as_mut().unwrap().push(Opening { id: "DF".into(), kind: ElementKind::Window, width: 0.6, height: 0.6, host_roof_id: Some("RF1".into()), host_point: Some(mid), ..Default::default() });
    let after = emit_roofs(&p, None).unwrap();
    for m in &after {
        assert!(crate::wall_mesh_cut::is_watertight(&m.positions, &m.indices, 1e-6), "Schicht mit Loch über der Fuge dicht");
    }
    let removed = vol(&before) - vol(&after);
    assert!((removed - 0.36 * t).abs() < 1e-6, "Loch = Fläche × Dicke: {removed}");
}

/// [103] Deckenöffnung: Aussparung im Slab.
#[test]
fn deckenoeffnung_im_slab() {
    let mut p = sample();
    let n0: usize = emit_slabs(&p).iter().map(|s| s.outline.len()).sum();
    p.openings.as_mut().unwrap().push(Opening { id: "DO".into(), kind: ElementKind::Window, width: 1.0, height: 1.0, host_ceiling_id: Some("C1".into()), host_point: Some(Vec2 { x: 2.0, y: 2.0 }), ..Default::default() });
    let n1: usize = emit_slabs(&p).iter().map(|s| s.outline.len()).sum();
    assert!(n1 > n0, "Loch-Ring eingebunden");
}

#[test]
fn beispielprojekt_hat_decken_und_gueltige_farben() {
    let p: Project = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
    let slabs = emit_slabs(&p);
    assert!(!slabs.is_empty());
    assert!(slabs.iter().all(|s| s.z_top > s.z_bottom && s.outline.len() >= 3));
}

/// Dachkörper einer Schicht (Versatz `d0` bis `d1` unter der Oberkante) wie in `emit_roofs`.
fn roof_slab_closed(planes: &[Vec<V3>], d0: f64, d1: f64) -> bool {
    let mitre = Mitre::new(planes);
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    for (i, plane) in planes.iter().enumerate() {
        if plane.len() >= 3 {
            push_roof_slab_between(&mut positions, &mut indices, &mitre.at(i, d0), &mitre.at(i, d1), &mitre.shared[i]);
        }
    }
    crate::wall_mesh_cut::is_watertight(&positions, &indices, 1e-6)
}

/// [G9] Gehrung an Punkten mit mehr als zwei Dachflächen (Zeltspitze auf Rechteck mit zwei
/// Neigungen, Kehlpunkte, konvexe Teilstücke einer Skelett-Fläche, Mansardknick): jede
/// Dachschicht ist ein geschlossener Körper. Vorher klafften dort Lücken (Zelt 7×5 m:
/// 1.1e-3 m², Walm auf L: 0.77 m²).
#[test]
fn g9_dachschichten_geschlossen() {
    use crate::roof::{roof_geometry, MansardType, RoofParams, Shape};
    use crate::roof_skeleton::Axis;
    let l = vec![[0.0, 0.0], [11.0, 0.0], [11.0, 4.0], [8.0, 4.0], [8.0, 6.0], [0.0, 6.0]];
    let u = vec![[0.0, 0.0], [12.0, 0.0], [12.0, 9.0], [8.0, 9.0], [8.0, 4.0], [4.0, 4.0], [4.0, 9.0], [0.0, 9.0]];
    let rect = vec![[0.0, 0.0], [7.0, 0.0], [7.0, 5.0], [0.0, 5.0]];
    let star = vec![[0.0, 0.0], [8.0, 0.0], [10.0, 5.0], [4.0, 3.0], [-2.0, 5.0]];
    let skew = vec![[0.0, 0.0], [10.0, 0.0], [13.0, 5.0], [3.0, 5.0]];
    let shapes = [
        (Shape::Walm, MansardType::Giebel),
        (Shape::Zelt, MansardType::Giebel),
        (Shape::Sattel, MansardType::Giebel),
        (Shape::Mansarde, MansardType::Giebel),
        (Shape::Mansarde, MansardType::Walm),
        (Shape::Mansarde, MansardType::Zelt),
    ];
    for outline in [&rect, &l, &u, &star, &skew] {
        for (shape, mt) in shapes {
            for axis in [Axis::X, Axis::Y] {
                let p = RoofParams {
                    outline: outline.clone(),
                    shape,
                    pitch_deg: 35.0,
                    pitch_upper_deg: None,
                    mansard_type: mt,
                    mansard_knee_ratio: None,
                    half_hip_ratio: None,
                    overhang: 0.5,
                    overhang_gable: None,
                    ridge_axis: axis,
                    holes: vec![],
                    edge_pitch_deg: None,
                };
                let g = roof_geometry(&p, 6.0);
                for (d0, d1) in [(0.0, 0.3), (0.3, 0.42)] {
                    assert!(roof_slab_closed(&g.planes, d0, d1), "{outline:?} {shape:?} {mt:?} {axis:?} {d0}–{d1}");
                }
            }
        }
    }
}
/// [26] Dächer mit Innenhof und Neigung je Kante: jede Dachschicht ist ein geschlossener Körper
/// (auch an den Hofkanten, mit Giebeln und verschieden geneigten Kanten).
#[test]
fn dachschichten_mit_hof_und_kantenneigung_geschlossen() {
    use crate::roof::{roof_geometry, MansardType, RoofParams, Shape};
    use crate::roof_skeleton::Axis;
    let big = vec![[0.0, 0.0], [12.0, 0.0], [12.0, 8.0], [0.0, 8.0]];
    let court = vec![[4.0, 2.0], [4.0, 6.0], [8.0, 6.0], [8.0, 2.0]];
    let tri = vec![[2.0, 1.5], [2.0, 3.5], [3.5, 2.5]];
    let variants: Vec<(Vec<Vec<[f64; 2]>>, Option<Vec<Option<f64>>>)> = vec![
        (vec![court.clone()], None),
        (vec![court.clone(), vec![[9.0, 2.0], [9.0, 4.0], [11.0, 4.0], [11.0, 2.0]]], None),
        (vec![tri], None),
        (vec![], Some(vec![Some(20.0), Some(50.0), Some(30.0), Some(60.0)])),
        (vec![court.clone()], Some(vec![Some(20.0), None, Some(-1.0), Some(45.0), Some(10.0)])),
        (vec![], Some(vec![Some(-1.0), None, Some(-1.0), None])),
    ];
    for (holes, edges) in variants {
        for (shape, mt) in [(Shape::Walm, MansardType::Giebel), (Shape::Zelt, MansardType::Giebel), (Shape::Sattel, MansardType::Giebel), (Shape::Mansarde, MansardType::Giebel), (Shape::Mansarde, MansardType::Walm)] {
            for overhang in [0.0, 0.4] {
                let p = RoofParams {
                    outline: big.clone(),
                    shape,
                    pitch_deg: 35.0,
                    pitch_upper_deg: None,
                    mansard_type: mt,
                    mansard_knee_ratio: None,
                    half_hip_ratio: None,
                    overhang,
                    overhang_gable: None,
                    ridge_axis: Axis::X,
                    holes: holes.clone(),
                    edge_pitch_deg: edges.clone(),
                };
                let g = roof_geometry(&p, 6.0);
                assert!(!g.planes.is_empty());
                // Mansarde mit Hof UND verschieden geneigten Kanten: die zweite Schicht (Versatz bis 0.42 m)
                // ist dort schmaler als der Versatz — bekannte Grenze, nur die erste Schicht prüfen.
                let layers: &[(f64, f64)] = if shape == Shape::Mansarde && !holes.is_empty() && edges.is_some() { &[(0.0, 0.3)] } else { &[(0.0, 0.3), (0.3, 0.42)] };
                for &(d0, d1) in layers {
                    assert!(roof_slab_closed(&g.planes, d0, d1), "{holes:?} {edges:?} {shape:?} {mt:?} oh {overhang} {d0}–{d1}");
                }
            }
        }
    }
}

/// [95] Taschen-Schiebetür: der Hohlraum (Blattbreite + 5 cm × 7 cm × Türhöhe) fehlt im Wandkörper,
/// geschichtet wie einschichtig; Tasche auf der Bandseite.
#[test]
fn tasche_aus_dem_wandkoerper_ausgeschnitten() {
    use crate::plan::walls::tests::pocket_project;
    let vol = |ws: &[RWall]| -> f64 {
        ws.iter().map(|w| wall_piece_volume(w) - w.holes.as_deref().unwrap_or(&[]).iter().map(|h| (h.to - h.from) * (h.z_top - h.z_bottom) * w.thickness).sum::<f64>()).sum()
    };
    for layered in [false, true] {
        let full = vol(&emit_walls(&pocket_project(DoorTypeKind::Schiebe, None, 1.0), layered).unwrap());
        for (hinge, x_pocket, x_other) in [(None, 0.5, 2.5), (Some(OpeningHinge::End), 2.4, 0.5)] {
            let ws = emit_walls(&pocket_project(DoorTypeKind::Tasche, hinge, 1.0), layered).unwrap();
            let v = vol(&ws);
            assert!((full - v - 0.95 * 0.07 * 2.0).abs() < 1e-9, "{layered} {full} {v}");
            // Wandmitte (y = 0): in der Tasche kein Körper bis zur Türhöhe, darüber schon.
            let solid_at = |x: f64, z: f64| {
                ws.iter().any(|w| {
                    let lo_hi = |a: f64, b: f64| (a.min(b), a.max(b));
                    let (x0, x1) = lo_hi(w.start[0], w.end[0]);
                    x0 < x && x < x1 && w.start[1].abs() < w.thickness / 2.0 && w.base_elevation < z && z < w.base_elevation + w.height
                })
            };
            assert!(!solid_at(x_pocket, 1.0), "{layered} {hinge:?}");
            assert!(solid_at(x_pocket, 2.3), "{layered} {hinge:?}");
            assert!(solid_at(x_other, 1.0), "{layered} {hinge:?}");
        }
        let ws = emit_walls(&pocket_project(DoorTypeKind::Tasche, None, 2.0), layered).unwrap();
        assert!((full - vol(&ws) - 2.0 * 0.5 * 0.07 * 2.0).abs() < 1e-9, "zweiflügelig {layered}");
    }
}

/// [95][T2] Tasche in der Bogenwand (entlang der Sehnen-Teilkörper, Länge = Achsmass) und unter
/// schräger Oberkante (Dachanschluss, `top_plane`/`top_drop`): Volumen −Hohlraum wie gerade.
#[test]
fn tasche_in_bogenwand_und_unter_dach() {
    use crate::plan::walls::tests::{pocket_project_with, POCKET_BULGE};
    let vol = |ws: &[RWall]| -> f64 {
        ws.iter().map(|w| wall_piece_volume(w) - w.holes.as_deref().unwrap_or(&[]).iter().map(|h| (h.to - h.from) * (h.z_top - h.z_bottom) * w.thickness).sum::<f64>()).sum()
    };
    for (bulge, roof, tol) in [(Some(POCKET_BULGE), false, 2e-4), (None, true, 1e-9)] {
        for layered in [false, true] {
            for (hinge, leaves, k) in [(None, 1.0, 0.95), (Some(OpeningHinge::End), 1.0, 0.95), (None, 2.0, 1.0)] {
                let full = emit_walls(&pocket_project_with(DoorTypeKind::Schiebe, hinge, leaves, bulge, roof), layered).unwrap();
                if roof {
                    assert!(full.iter().any(|w| w.top_plane.is_some() && w.top_drop.is_some()), "schräge Oberkante");
                }
                let ws = emit_walls(&pocket_project_with(DoorTypeKind::Tasche, hinge, leaves, bulge, roof), layered).unwrap();
                let d = vol(&full) - vol(&ws);
                assert!((d - k * 0.07 * 2.0).abs() < tol, "{bulge:?} {roof} {layered} {hinge:?} {leaves}: {d}");
                // Unter dem Dach: Oberkante der Teilkörper weiter auf der Dachebene (nicht über die Ursprungshöhe).
                for w in ws.iter().filter(|w| w.top_plane.is_some()) {
                    let fp = wall_footprint(w).unwrap();
                    let top = fp.iter().map(|q| wall_top_at(w, *q)).fold(f64::MIN, f64::max);
                    assert!(top <= w.base_elevation + w.height + 1e-9 && top > 2.0, "{w:?}");
                }
            }
        }
    }
}

fn pick_base(extra: serde_json::Value) -> Project {
    let mut v = serde_json::json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "openings": [], "walls": [],
        "drawingLevels": [{"id": "EG", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 1.0}],
        "drawings2d": []
    });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

/// [137] Treppengeländer sind im 3D anwählbar: Handlauf-Dreiecke tragen die Treppen-Id und reichen über die Hülle.
#[test]
fn pick_treppengelaender_im_3d() {
    let mk = |railing: &str| {
        pick_base(serde_json::json!({
            "stairTypes": [{"id": "t", "name": "T", "structure": "massiv", "closedRisers": false, "treadThickness": 0.04, "railing": railing, "defaultWidth": 1.0}],
            "stairs": [{"id": "s1", "type": "stair", "floorId": "EG", "categoryCode": "35", "shape": "straight", "start": {"x": 0, "y": 0}, "dir": {"x": 1, "y": 0},
                "runLength": 3.0, "width": 1.0, "stepCount": 16, "totalRise": 2.8, "typeId": "t"}]
        }))
    };
    assert!(pick_geometry(&mk("keine")).unwrap().stair_meshes.is_empty());
    let g = pick_geometry(&mk("beide")).unwrap();
    assert_eq!(g.stair_meshes.len(), 1);
    assert_eq!(g.stair_meshes[0].stair_id, "s1");
    assert!(!g.stair_meshes[0].tris.is_empty());
    let top = g.stair_meshes[0].tris.iter().flatten().map(|q| q[1]).fold(f64::MIN, f64::max);
    assert!(top > g.stairs[0].z_top, "Geländer über der OK der Treppe: {top} > {}", g.stairs[0].z_top);
}

/// [137] Kreis, Bogen und Text (Bäume, Symbole) bekommen flache Pick-Flächen auf Geschosshöhe.
#[test]
fn pick_kreis_bogen_text_im_3d() {
    let d = |id: &str, geom: serde_json::Value| serde_json::json!({"id": id, "type": "drawing2d", "levelId": "EG", "categoryCode": "20", "geom": geom});
    let p = pick_base(serde_json::json!({"drawings2d": [
        d("c", serde_json::json!({"shape": "circle", "center": {"x": 2, "y": 3}, "r": 1.5})),
        d("a", serde_json::json!({"shape": "arc", "center": {"x": 10, "y": 0}, "r": 2.0, "a0": 0.0, "a1": std::f64::consts::FRAC_PI_2})),
        d("t", serde_json::json!({"shape": "text", "at": {"x": 20, "y": 0}, "text": "Baum", "height": 0.5, "angle": 0.0})),
        d("l", serde_json::json!({"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 1, "y": 0}}))
    ]}));
    let g = pick_geometry(&p).unwrap();
    let ids: Vec<&str> = g.drawing_meshes.iter().map(|m| m.drawing_id.as_str()).collect();
    assert_eq!(ids, ["c", "a", "t"]);
    for m in &g.drawing_meshes {
        assert!(m.tris.iter().flatten().all(|q| (q[1] - 1.01).abs() < 1e-9), "Geschosshöhe + EPS");
    }
    // Scheibe: Mittelpunkt (2, 3) liegt in einem Dreieck, ein Punkt ausserhalb nicht.
    let inside = |tris: &[Tri], x: f64, z: f64| {
        tris.iter().any(|t| {
            let s = |a: V3, b: V3| (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0]);
            let (d1, d2, d3) = (s(t[0], t[1]), s(t[1], t[2]), s(t[2], t[0]));
            !((d1 < 0.0 || d2 < 0.0 || d3 < 0.0) && (d1 > 0.0 || d2 > 0.0 || d3 > 0.0))
        })
    };
    assert!(inside(&g.drawing_meshes[0].tris, 2.5, 3.5) && !inside(&g.drawing_meshes[0].tris, 4.0, 3.0));
    // Bogen: auf dem Bogen ja, im Zentrum nein.
    assert!(inside(&g.drawing_meshes[1].tris, 10.0 + 2.0 * 0.5f64.sqrt(), 2.0 * 0.5f64.sqrt()) && !inside(&g.drawing_meshes[1].tris, 10.0, 0.0));
    // Text: 4 Zeichen · 0.6 · 0.5 = 1.2 m breit.
    assert!(inside(&g.drawing_meshes[2].tris, 21.0, 0.2) && !inside(&g.drawing_meshes[2].tris, 22.0, 0.2));
}

/// [181] Netzkörper (z. B. Nachbargebäude) in ausgeblendeter Klasse: weder im 3D noch als Pick-Dreiecke.
#[test]
fn netzkoerper_klasse_ausgeblendet() {
    let mk = |visible: bool| Project {
        context: Some(vec![ContextObject::ImportedMesh(ImportedMesh { id: "m".into(), category_code: "12".into(), positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], indices: vec![0.0, 1.0, 2.0], ..Default::default() })]),
        layers: vec![crate::model::LayerCategory { code: "12".into(), name: "Gebäude".into(), visible, ..Default::default() }],
        ..Default::default()
    };
    assert_eq!(emit_context_meshes(&mk(true)).len(), 1);
    assert_eq!(pick_geometry(&mk(true)).unwrap().context_meshes.len(), 1);
    assert!(emit_context_meshes(&mk(false)).is_empty());
    assert!(pick_geometry(&mk(false)).unwrap().context_meshes.is_empty());
}

/// [68] Verbau im 3D: Körper in der Farbe der Verbauart, Klasse der Baugrube, Pick wählt die Baugrube.
#[test]
fn verbau_im_3d_klasse_und_pick() {
    let t = crate::model::TerrainMesh {
        id: "t".into(),
        category_code: "02".into(),
        positions: vec![-50.0, -50.0, 0.0, 50.0, -50.0, 0.0, 50.0, 50.0, 0.0, -50.0, 50.0, 0.0],
        indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
        ..Default::default()
    };
    let v = |x: f64, y: f64| crate::model::Vec2 { x, y };
    let pit = crate::model::Excavation {
        id: "bg".into(),
        category_code: "07".into(),
        outline: vec![v(0.0, 0.0), v(8.0, 0.0), v(8.0, 6.0), v(0.0, 6.0)],
        bottom: -3.0,
        edge_shoring: Some(vec![true, false, true, false]),
        shoring_kind: Some("soldierPile".into()),
        shoring_embed: Some(0.5),
        ..Default::default()
    };
    let cat = |visible| crate::model::LayerCategory { code: "07".into(), name: "Baugrube".into(), visible, ..Default::default() };
    let mk = |visible| Project { context: Some(vec![ContextObject::TerrainMesh(t.clone()), ContextObject::Excavation(pit.clone())]), layers: vec![cat(visible)], ..Default::default() };
    let meshes = emit_context_meshes(&mk(true));
    assert_eq!(meshes.len(), 2, "Gelände + Verbau");
    let m = meshes.iter().find(|m| matches!(m.owner, Owner::Context(1))).unwrap();
    assert_eq!(m.color, shoring_rgb("soldierPile"));
    // Zwei Wände: unten Sohle - 0.5, oben Gelände (0).
    let zs: Vec<f64> = m.positions.chunks_exact(3).map(|q| q[2]).collect();
    assert!((zs.iter().cloned().fold(f64::INFINITY, f64::min) + 3.5).abs() < 1e-6 && zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max).abs() < 1e-6);
    assert_eq!(m.indices.len(), 2 * 12 * 3);
    // Klasse aus: Verbau weg, Gelände bleibt.
    let off = emit_context_meshes(&mk(false));
    assert_eq!(off.len(), 1);
    assert!(off.iter().all(|m| matches!(m.owner, Owner::Context(0))));
    // Pick.
    let g = pick_geometry(&mk(true)).unwrap();
    assert!(g.context_meshes.iter().any(|m| m.context_object_id == "bg" && m.tris.len() == 24));
    assert!(pick_geometry(&mk(false)).unwrap().context_meshes.iter().all(|m| m.context_object_id != "bg" || m.tris.len() != 24), "Klasse aus: kein Verbau-Pick");
}

/// [216] Jede Kante des Körper-Netzes gehört (nach Lage) zu genau zwei Dreiecken: keine inneren Flächen (Stossfugen).
fn body_without_seams(b: &WallBody) -> bool {
    let key = |i: u32| -> [i64; 3] {
        let c = &b.positions[i as usize * 3..i as usize * 3 + 3];
        [(c[0] * 1e5).round() as i64, (c[1] * 1e5).round() as i64, (c[2] * 1e5).round() as i64]
    };
    let mut n: std::collections::HashMap<([i64; 3], [i64; 3]), usize> = std::collections::HashMap::new();
    for t in b.indices.chunks_exact(3) {
        for k in 0..3 {
            let (u, v) = (key(t[k]), key(t[(k + 1) % 3]));
            if u != v {
                *n.entry((u.min(v), u.max(v))).or_default() += 1;
            }
        }
    }
    n.values().all(|c| *c == 2)
}

/// [216] Formöffnung in der Wand: EIN Körper je Band mit rundem Loch statt Rechteck-Loch + Füllkörper; die
/// Stücke zeigt render3d nicht mehr (`noMesh`).
#[test]
fn formoeffnung_wandkoerper_mit_rundem_loch() {
    let mut p = sample();
    p.openings = Some(vec![]);
    let plain: f64 = emit_walls(&p, true).unwrap().iter().filter(|w| w.wall_id == "W1").map(wall_piece_volume).sum();
    let o: Opening = serde_json::from_value(serde_json::json!({
        "id": "R1", "type": "opening", "hostWallId": "W1", "categoryCode": "21", "kind": "window", "typeId": "",
        "position": 0.5, "width": 1.2, "height": 1.2, "sillHeight": 0.9, "shape": "rund"
    }))
    .unwrap();
    let outline = crate::opening_shape::opening_outline(&o, 1.2, 1.2).unwrap();
    let n = outline.len();
    let area = (0..n).map(|i| outline[i][0] * outline[(i + 1) % n][1] - outline[(i + 1) % n][0] * outline[i][1]).sum::<f64>() / 2.0;
    let wt = p.wall_type(&p.walls[0]).unwrap().clone();
    let total = Project::type_thickness(&wt.layers);
    p.openings = Some(vec![o]);
    let walls = emit_walls(&p, true).unwrap();
    let w1: Vec<&RWall> = walls.iter().filter(|w| w.wall_id == "W1").collect();
    assert!(w1.iter().all(|w| w.no_mesh), "alle Stücke der Wand ohne eigene Extrusion");
    let bodies: Vec<&WallBody> = w1.iter().filter_map(|w| w.body.as_ref()).collect();
    assert_eq!(bodies.len(), wt.layers.len(), "ein Körper je Schicht");
    let vol: f64 = bodies.iter().map(|b| crate::solid_bool::Mesh { positions: b.positions.clone(), indices: b.indices.clone() }.volume().abs()).sum();
    // Die Stücke überlappen um 0,1 mm (Vereinigung ohne Stossfugen): Volumen auf ein Prozent genau.
    assert!((plain - vol - area * total).abs() < 1e-2, "Rest {} soll {}", plain - vol, area * total);
    // Das Loch ist rund (Volumen oben = Kreisfläche, nicht 1.2 × 1.2): kein Körper hat eine Ecke am Rechteck-Loch.
    let (x0, z0) = (0.5, p.wall_vertical_extent(&p.walls[0]).0 + 0.9);
    let at_corner = |b: &WallBody| b.positions.chunks_exact(3).any(|c| (c[0] - x0).abs() < 1e-6 && (c[2] - z0).abs() < 1e-6);
    assert!(!bodies.iter().any(|b| at_corner(b)), "Rechteck-Loch im Körper");
    assert!(bodies.iter().all(|b| body_without_seams(b)), "innere Flächen (Stossfugen) im Körper");
}

/// [216] Giebelwand mit rundem Fenster auf dem First: die Stücke (links/rechts des Firsts, Ebene Oberkante) sind zu EINEM
/// Körper je Band vereinigt, ohne innere Flächen an der Stossfuge, und das Fenster ist ein rundes Loch.
#[test]
fn giebelwand_mit_rundfenster_ohne_stossfuge() {
    let mut p = sample();
    p.ceilings = Some(vec![]);
    p.walls.retain(|w| w.id == "W6");
    p.walls[0].height = 6.0;
    p.walls[0].roof_attach = Some(true);
    let o: Opening = serde_json::from_value(serde_json::json!({
        "id": "R1", "type": "opening", "hostWallId": "W6", "categoryCode": "21", "kind": "window", "typeId": "",
        "position": 1.5, "width": 1.0, "height": 1.0, "sillHeight": 1.5, "shape": "rund"
    }))
    .unwrap();
    p.openings = Some(vec![o]);
    let walls = emit_walls(&p, true).unwrap();
    assert!(walls.iter().any(|w| w.top_plane.is_some()), "Giebel mit schräger Oberkante");
    let bodies: Vec<&WallBody> = walls.iter().filter_map(|w| w.body.as_ref()).collect();
    assert!(!bodies.is_empty());
    for b in bodies {
        assert!(body_without_seams(b), "innere Flächen im Giebel-Körper");
        let m = crate::solid_bool::Mesh { positions: b.positions.clone(), indices: b.indices.clone() };
        assert!(m.volume().abs() > 0.1 && m.is_closed());
    }
}

/// [217] Wandkörper mit negativer/NaN-Höhe und ebener Oberkante: `wall_top_at`/`wall_piece_mesh` dürfen nicht
/// panikieren (`f64::clamp` mit min > max oder NaN-Grenzen legte das WASM-Modul lahm).
#[test]
fn wandkoerper_mit_kaputter_hoehe_ohne_panic() {
    use crate::plan::walls::tests::pocket_project;
    let ws = emit_walls(&pocket_project(DoorTypeKind::Schiebe, None, 1.0), false).unwrap();
    let mut w = ws[0].clone();
    w.top_plane = Some([3.0, 0.1, 0.0]);
    for h in [-3.0, f64::NAN, 0.0, f64::INFINITY, -1e300] {
        w.height = h;
        let _ = wall_top_at(&w, [0.0, 0.0]);
        let _ = wall_piece_mesh(&w);
        let _ = wall_piece_volume(&w);
    }
    for c in [[f64::NAN, 0.0, 0.0], [f64::INFINITY, 1.0, 1.0]] {
        w.height = 2.5;
        w.top_plane = Some(c);
        assert!(wall_top_at(&w, [1.0, 1.0]).is_finite());
    }
    w.base_elevation = f64::NAN;
    let _ = wall_piece_mesh(&w);
}

/// [231] Ganze Giebelwand (W6 über die volle Hausbreite, First bei y = 2 mitten in der Wand) mit einem Fenster über dem
/// First; `shape` = Form der Öffnung (`None` = Rechteck). Liefert das Projekt, die Fläche der Öffnung und das Volumen
/// der Wand ohne Öffnung.
fn gable_with_window(shape: Option<&str>) -> (Project, f64, f64) {
    let mut p = sample();
    p.ceilings = Some(vec![]);
    p.walls.retain(|w| w.id == "W6");
    p.walls[0].end.y = 4.0;
    p.walls[0].height = 6.0;
    p.walls[0].roof_attach = Some(true);
    p.openings = Some(vec![]);
    let plain: f64 = emit_walls(&p, true).unwrap().iter().map(wall_piece_volume).sum();
    let mut o = serde_json::json!({
        "id": "F1", "type": "opening", "hostWallId": "W6", "categoryCode": "21", "kind": "window", "typeId": "",
        "position": 1.4, "width": 1.2, "height": 1.2, "sillHeight": 1.0
    });
    if let Some(s) = shape {
        o["shape"] = serde_json::json!(s);
    }
    let o: Opening = serde_json::from_value(o).unwrap();
    let area = match crate::opening_shape::opening_outline(&o, 1.2, 1.2) {
        Some(r) => (0..r.len()).map(|i| r[i][0] * r[(i + 1) % r.len()][1] - r[(i + 1) % r.len()][0] * r[i][1]).sum::<f64>().abs() / 2.0,
        None => 1.2 * 1.2,
    };
    p.openings = Some(vec![o]);
    (p, area, plain)
}

/// [231] Prüft die Giebelwand aus [`gable_with_window`]: kein Stück wird mehr extrudiert, je Schicht EIN Körper ohne
/// innere Flächen (keine Fuge von der Öffnung bis zum Dach, keine am First), und das Loch hat die Fläche der Öffnung.
fn assert_gable_body(p: &Project, area: f64, plain: f64) {
    let walls = emit_walls(p, true).unwrap();
    assert!(walls.iter().any(|w| w.top_plane.is_some()), "Giebel mit schräger Oberkante");
    assert!(walls.iter().all(|w| w.no_mesh), "alle Stücke ohne eigene Extrusion (keine Pfeiler/Sturz-Streifen)");
    let bodies: Vec<&WallBody> = walls.iter().filter_map(|w| w.body.as_ref()).collect();
    let wt = p.wall_type(&p.walls[0]).unwrap();
    assert_eq!(bodies.len(), wt.layers.len(), "ein Körper je Schicht");
    let mut vol = 0.0;
    for b in &bodies {
        assert!(body_without_seams(b), "innere Flächen (Fugen) im Giebel-Körper");
        let m = crate::solid_bool::Mesh { positions: b.positions.clone(), indices: b.indices.clone() };
        assert!(m.is_closed());
        vol += m.volume().abs();
    }
    let total = Project::type_thickness(&wt.layers);
    assert!((plain - vol - area * total).abs() < 1e-3, "Loch {} soll {}", (plain - vol) / total, area);
}

/// [231] Rechteckfenster in der Giebelwand über dem First: früher in Pfeiler, Brüstung und Sturz mit je eigener
/// Oberkante zerlegt (zwei senkrechte Fugen vom Fenster bis zum Dach), jetzt ein Körper je Schicht mit Rechteck-Loch.
#[test]
fn giebelwand_mit_rechteckfenster_ein_koerper() {
    let (p, area, plain) = gable_with_window(None);
    assert_gable_body(&p, area, plain);
}

/// [231] Rundfenster mitten auf dem First der ganzen Giebelwand: die beiden Stücke links/rechts des Firsts stossen an
/// derselben Schnittlinie zusammen; je Stück unterteilt blieb die Stossfläche als Fuge (Rechteck-Streifen bis zum Boden,
/// Bogen nur halb sichtbar). Jetzt ein Körper je Schicht mit rundem Loch.
#[test]
fn giebelwand_mit_rundfenster_auf_dem_first_ohne_fuge() {
    let (p, area, plain) = gable_with_window(Some("rund"));
    assert_gable_body(&p, area, plain);
}

/// [216] Bogenwand (Sehnen-Stücke mit radialen Gehrungen): je Band EIN Körper ohne senkrechte innere Flächen an den
/// Gehrungen (im 3D war jede Sehne als Linie sichtbar); das Fenster bleibt offen, die Stücke zeigt render3d nicht mehr.
#[test]
fn bogenwand_ein_koerper_ohne_sehnen_fugen() {
    for bulge in [0.4, -1.0] {
        let mut p = sample();
        p.walls.retain(|w| w.id == "W1");
        p.walls[0].bulge = Some(bulge);
        let walls = emit_walls(&p, true).unwrap();
        assert!(walls.iter().all(|w| w.no_mesh), "{bulge}: alle Stücke ohne eigene Extrusion");
        let n_bands = walls.iter().map(|w| w.band).max().unwrap() + 1;
        let bodies: Vec<(usize, &WallBody)> = walls.iter().filter_map(|w| w.body.as_ref().map(|b| (w.band, b))).collect();
        assert_eq!(bodies.len(), n_bands, "{bulge}: ein Körper je Band");
        for (band, b) in bodies {
            let m = crate::solid_bool::Mesh { positions: b.positions.clone(), indices: b.indices.clone() };
            assert!(m.is_closed());
            // Volumen = Summe der Stücke ohne ihre Löcher (bis auf die Überlappung der Leibungsstücke um 0,1 mm).
            let hole = |w: &RWall| w.holes.iter().flatten().map(|h| (h.to - h.from) * (h.z_top - h.z_bottom) * w.thickness).sum::<f64>();
            let sum: f64 = walls.iter().filter(|w| w.band == band).map(|w| wall_piece_volume(w) - hole(w)).sum();
            assert!((m.volume().abs() - sum).abs() < 0.03 * sum, "{bulge} Band {band}: {} soll {sum}", m.volume().abs());
            // Keine senkrechte Kante mit mehr als zwei Dreiecken (Stirnflächen zweier Sehnen an der Gehrung).
            let key = |i: u32| -> [i64; 3] {
                let c = &b.positions[i as usize * 3..i as usize * 3 + 3];
                [(c[0] * 1e5).round() as i64, (c[1] * 1e5).round() as i64, (c[2] * 1e5).round() as i64]
            };
            let mut n: std::collections::HashMap<([i64; 3], [i64; 3]), usize> = std::collections::HashMap::new();
            for t in b.indices.chunks_exact(3) {
                for k in 0..3 {
                    let (u, v) = (key(t[k]), key(t[(k + 1) % 3]));
                    if u != v {
                        *n.entry((u.min(v), u.max(v))).or_default() += 1;
                    }
                }
            }
            // Ecken der Sehnen-Gehrungen: Ende eines Stücks mit Schnittlinie, an dem das nächste gleich hohe und gleich lange
            // mit ihr beginnt. An den Laibungen stossen Pfeiler, Brüstung, Sturz und Leibungsstücke wie bei geraden Wänden
            // zusammen; zwischen ungleich langen Sehnen ist die radiale Gehrung nicht ihre Winkelhalbierende, die Bänder
            // treffen sie um ~1e-5 m versetzt (Stirnflächen nur teilweise deckungsgleich, auch bei den Stücken).
            let ps: Vec<&RWall> = walls.iter().filter(|w| w.band == band).collect();
            let plen = |q: &RWall| hypot2(q.end[0] - q.start[0], q.end[1] - q.start[1]);
            let mut corners: Vec<[f64; 2]> = Vec::new();
            for a in &ps {
                let same = |b: &&&RWall| (b.base_elevation - a.base_elevation).abs() < 1e-9 && (b.height - a.height).abs() < 1e-9 && (plen(b) - plen(a)).abs() < 1e-6;
                let Some(c) = a.end_cut.filter(|c| ps.iter().filter(same).any(|b| b.start_cut == Some(*c))) else { continue };
                let l = hypot2(c[2], c[3]);
                for s in [-1.0, 1.0] {
                    corners.push([a.end[0] + s * c[2] / l * a.thickness / 2.0, a.end[1] + s * c[3] / l * a.thickness / 2.0]);
                }
            }
            assert!(corners.len() > 4, "{bulge} Band {band}: Gehrungen");
            let at_joint = |u: &[i64; 3]| corners.iter().any(|c| (c[0] - u[0] as f64 * 1e-5).abs() < 1e-3 && (c[1] - u[1] as f64 * 1e-5).abs() < 1e-3);
            let joints = n.iter().filter(|((u, v), c)| **c != 2 && u[0] == v[0] && u[1] == v[1] && at_joint(u)).count();
            assert_eq!(joints, 0, "{bulge} Band {band}: innere Stirnflächen an den Gehrungen");
        }
    }
}

/// Liegt `pt` im geschlossenen Netz? Strahl senkrecht nach oben, Treffer zählen (ungerade = innen).
fn inside_mesh(positions: &[f64], indices: &[u32], pt: [f64; 3]) -> bool {
    let v = |i: u32| [positions[i as usize * 3], positions[i as usize * 3 + 1], positions[i as usize * 3 + 2]];
    let mut hits = 0;
    for t in indices.chunks_exact(3) {
        let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
        // Dreieck in der Grundrissprojektion, Punkt darin (baryzentrisch), Treffer oberhalb von pt.
        let d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if d.abs() < 1e-15 {
            continue;
        }
        let l1 = ((b[1] - c[1]) * (pt[0] - c[0]) + (c[0] - b[0]) * (pt[1] - c[1])) / d;
        let l2 = ((c[1] - a[1]) * (pt[0] - c[0]) + (a[0] - c[0]) * (pt[1] - c[1])) / d;
        let l3 = 1.0 - l1 - l2;
        if l1 < 0.0 || l2 < 0.0 || l3 < 0.0 {
            continue;
        }
        if l1 * a[2] + l2 * b[2] + l3 * c[2] > pt[2] {
            hits += 1;
        }
    }
    hits % 2 == 1
}

/// [216] Bogenwand W1 (Halbkreis) mit einer Formöffnung `shape` (u 2 … 3.2 m Bogenlänge, Brüstung 0.9, 1.2 × 1.2 m);
/// `reveal` = mit Schichteinzug [106] (Öffnung gerade auf der Sehne über `reveal_zone`).
fn arc_wall_with_shape(shape: &str, reveal: bool) -> Project {
    let mut p = sample();
    p.walls.retain(|w| w.id == "W1");
    p.walls[0].bulge = Some(-1.0);
    let mut o = serde_json::json!({
        "id": "R1", "type": "opening", "hostWallId": "W1", "categoryCode": "21", "kind": "window", "typeId": "",
        "position": 2.0, "width": 1.2, "height": 1.2, "sillHeight": 0.9, "shape": shape
    });
    if reveal {
        o["layerReveals"] = serde_json::json!([{ "layer": -1, "mode": "zurueck", "amount": 0.05 }, { "layer": 0, "mode": "leibung" }]);
    }
    p.openings = Some(vec![serde_json::from_value(o).unwrap()]);
    p
}

/// [216] Formöffnung in der Bogenwand (Erker): der Wandkörper schneidet die echte Form (Rund-/Spitzbogen) statt eines
/// Rechteck-Lochs mit Füllkörpern — ohne Schichteinzug gebogen (Leibungen radial), mit Schichteinzug gerade auf der Sehne;
/// die Öffnungsteile haben keine Füllkörper und keine Quader-Leibungen mehr.
#[test]
fn formoeffnung_in_bogenwand_mit_echter_form() {
    for (shape, reveal) in [("rund", false), ("spitzbogen", false), ("rundbogen", true), ("rund", true)] {
        let p = arc_wall_with_shape(shape, reveal);
        let a = crate::wall_arc::WallArc::of_wall(&p.walls[0]).unwrap();
        let o = &p.openings.as_ref().unwrap()[0];
        assert!(!reveal || crate::opening_detail::opening_reveal(&p, &p.walls[0], o).is_some(), "{shape}: Schichteinzug");
        let walls = emit_walls(&p, true).unwrap();
        assert!(walls.iter().all(|w| w.no_mesh), "{shape}/{reveal}: alle Stücke ohne eigene Extrusion");
        let n_bands = walls.iter().map(|w| w.band).max().unwrap() + 1;
        let bodies: Vec<&WallBody> = walls.iter().filter_map(|w| w.body.as_ref()).collect();
        assert_eq!(bodies.len(), n_bands, "{shape}/{reveal}: ein Körper je Band");
        for b in &bodies {
            assert!(crate::solid_bool::Mesh { positions: b.positions.clone(), indices: b.indices.clone() }.is_closed(), "{shape}/{reveal}: geschlossen");
        }
        // Lage (Bogenlänge s, quer n, Höhe z) → Welt: gebogen bzw. auf der Sehne über die Einzug-Zone.
        let zb = p.wall_vertical_extent(&p.walls[0]).0 + 0.9;
        let world = |s: f64, n: f64, z: f64| -> [f64; 3] {
            if reveal {
                let r = crate::opening_detail::opening_reveal(&p, &p.walls[0], o).unwrap();
                let ms = r.sides[..2].iter().flatten().map(|x| x.shift).fold(0.0f64, f64::max);
                let (sa, sb) = crate::wall_arc::reveal_zone(r.from, r.to, ms, a.length());
                let (pa, u, chord) = crate::wall_arc::chord_of(&a, sa, sb);
                let t = (s - sa) / (sb - sa) * chord;
                [pa.x + u.x * t - u.y * n, pa.y + u.y * t + u.x * n, z]
            } else {
                let w = a.point(s, n);
                [w.x, w.y, z]
            }
        };
        let solid = |pt: [f64; 3]| bodies.iter().any(|b| inside_mesh(&b.positions, &b.indices, pt));
        // Mitte der Öffnung offen, Ecken des umschreibenden Rechtecks oben (ausserhalb der Form) Wand — quer an mehreren
        // Stellen in der Wand (nicht im Rücksprung des Innenputzes).
        for n in [-0.09, 0.0123, 0.11] {
            assert!(!solid(world(2.6, n, zb + 0.6)), "{shape}/{reveal}: Öffnung zu bei n {n}");
            assert!(!solid(world(2.6, n, zb + 1.1)), "{shape}/{reveal}: Scheitel zu bei n {n}");
            assert!(solid(world(2.03, n, zb + 1.17)), "{shape}/{reveal}: Rechteck-Ecke oben links offen bei n {n}");
            assert!(solid(world(3.17, n, zb + 1.17)), "{shape}/{reveal}: Rechteck-Ecke oben rechts offen bei n {n}");
            assert!(solid(world(1.7, n, zb + 0.6)), "{shape}/{reveal}: Wand neben der Öffnung fehlt bei n {n}");
        }
        // Öffnungsteile: Rahmen/Glas (und je Seite ein Leibungskörper), keine Füllkörper-Quader.
        let meshes = emit_opening_meshes(&p, 1.0);
        assert!(!meshes.is_empty() && meshes.len() <= 10, "{shape}/{reveal}: {} Öffnungsteile (Quader?)", meshes.len());
    }
}

/// [234] Öffnung, die unter der Wandoberkante in eine Decke ragt (Musterhaus komplex `og-f1` vor der Korrektur: Brüstung 0,9 +
/// Höhe 1,6 = 2,5 m, Decke ab 2,43 m, Wand bis 2,8 m): Leibung, Rahmen, Glas und Wandloch enden an der Deckenunterkante wie an
/// der Wandoberkante — Rechteck und Rundbogen, gerade und Bogenwand; ohne Decke darüber bleibt die volle Höhe.
#[test]
fn oeffnung_in_die_decke_endet_an_der_deckenunterkante() {
    for (shape, bulge) in [(None, None), (Some(OpeningShape::Rundbogen), None), (None, Some(-0.3)), (Some(OpeningShape::Rundbogen), Some(-0.3))] {
        let mut p = sample();
        p.walls.retain(|w| w.id == "W1");
        p.walls[0].height = 2.8;
        p.walls[0].bulge = bulge;
        for f in p.drawing_levels.iter_mut().filter(|f| f.id == "eg") {
            f.floor_height = Some(2.8);
        }
        let c = &mut p.ceilings.as_mut().unwrap()[0];
        c.thickness = Some(0.37);
        // Umriss über die ganze (auch gebogene) Wand.
        c.outline = vec![Vec2 { x: -1.0, y: -3.0 }, Vec2 { x: 6.0, y: -3.0 }, Vec2 { x: 6.0, y: 4.0 }, Vec2 { x: -1.0, y: 4.0 }];
        assert!((p.ceiling_vertical_extent(&p.ceilings.as_ref().unwrap()[0]).0 - 2.43).abs() < 1e-9);
        p.openings.as_mut().unwrap().retain(|o| o.id == "O1");
        let o = &mut p.openings.as_mut().unwrap()[0];
        (o.sill_height, o.height, o.shape) = (0.9, 1.6, shape);
        let max_z = |ms: &[RMesh]| ms.iter().flat_map(|m| m.positions.chunks_exact(3).map(|c| c[2])).fold(f64::NEG_INFINITY, f64::max);
        let top = max_z(&emit_opening_meshes(&p, 2.0));
        assert!((top - 2.43).abs() < 1e-6, "{shape:?}/{bulge:?}: Öffnungsteile bis {top} statt 2,43");
        let w = &p.walls[0];
        let o = &p.openings.as_ref().unwrap()[0];
        assert!((crate::plan::view_range::opening_vertical_extent(&p, w, o).1 - 2.43).abs() < 1e-9, "Plan/Schnitt");
        let walls = emit_walls(&p, true).unwrap();
        let hole_top = walls.iter().flat_map(|w| w.holes.iter().flatten()).map(|h| h.z_top).fold(f64::NEG_INFINITY, f64::max);
        // Wandloch (Rechteck; bei Formöffnungen das Loch der Stücke, das der Körper nach dem Umriss schneidet).
        assert!((hole_top - 2.43).abs() < 1e-6, "{shape:?}/{bulge:?}: Wandloch bis {hole_top}");
        // Ohne Decke über der Öffnung (Umriss daneben): volle Höhe bis 2,5.
        p.ceilings.as_mut().unwrap()[0].outline = vec![Vec2 { x: 10.0, y: 0.0 }, Vec2 { x: 12.0, y: 0.0 }, Vec2 { x: 12.0, y: 2.0 }, Vec2 { x: 10.0, y: 2.0 }];
        let top = max_z(&emit_opening_meshes(&p, 2.0));
        assert!((top - 2.5).abs() < 1e-6, "{shape:?}/{bulge:?}: ohne Decke bis {top} statt 2,5");
    }
}

/// [216] Rahmen, Flügel, Glas und Fensterbank in der Bogenwand (Erker, r = 2,5 m, Fenster 1,2 m: Pfeilhöhe ≈ 7 cm) folgen
/// dem Bogen: jeder Punkt eines Teils (Ecken, Dreiecks-Schwerpunkte, Kantenmitten) liegt quer zur Wand im Bereich seiner
/// Ecken — kein Versatz der geraden Sehne zur Leibung in Brüstungsmitte. Rechteck und Formöffnung, Teile dicht.
/// Schmale Öffnungen (Pfeilhöhe ≤ 1 cm) bleiben gerade.
#[test]
fn fenster_in_bogenwand_folgt_dem_bogen() {
    assert!(follows_arc(2.0, 1.2) && follows_arc(2.0, 0.6) && !follows_arc(2.0, 0.3) && !follows_arc(20.0, 1.2));
    for shape in [None, Some(OpeningShape::Rund), Some(OpeningShape::Rundbogen)] {
        let mut p = sample();
        p.walls.retain(|w| w.id == "W1");
        p.walls[0].bulge = Some(-1.0);
        p.openings.as_mut().unwrap().retain(|o| o.id == "O1");
        let o = &mut p.openings.as_mut().unwrap()[0];
        (o.position, o.width, o.height, o.shape) = (2.0, 1.2, 1.2, shape);
        // Ohne Schichteinzug (mit [106]/[168] liegen Wandloch und Teile gerade auf einer Sehne, `reveal_zone`).
        o.layer_reveals = Some(Vec::new());
        let a = crate::wall_arc::WallArc::of_wall(&p.walls[0]).unwrap();
        let meshes = emit_opening_meshes(&p, 2.0);
        assert!(meshes.iter().any(|m| m.color == PART_RGB[0]) && meshes.iter().any(|m| m.color == PART_RGB[1]), "{shape:?}: Rahmen und Glas");
        for m in &meshes {
            let v = |i: u32| [m.positions[i as usize * 3], m.positions[i as usize * 3 + 1], m.positions[i as usize * 3 + 2]];
            let n_of = |q: [f64; 3]| a.local(kernel2d::Vec2::new(q[0], q[1])).1;
            let ns: Vec<f64> = (0..m.positions.len() as u32 / 3).map(|i| n_of(v(i))).collect();
            let (lo, hi) = (ns.iter().copied().fold(f64::INFINITY, f64::min), ns.iter().copied().fold(f64::NEG_INFINITY, f64::max));
            for t in m.indices.chunks_exact(3) {
                let (p0, p1, p2) = (v(t[0]), v(t[1]), v(t[2]));
                let mid = |a: [f64; 3], b: [f64; 3]| [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, 0.0];
                for q in [[(p0[0] + p1[0] + p2[0]) / 3.0, (p0[1] + p1[1] + p2[1]) / 3.0, 0.0], mid(p0, p1), mid(p1, p2), mid(p2, p0)] {
                    let n = n_of(q);
                    assert!(n > lo - 2e-3 && n < hi + 2e-3, "{shape:?}: Teil (Farbe {:?}) quer {n} ausserhalb {lo} … {hi} (Sehne?)", m.color);
                }
            }
            // Dicht ohne T-Stösse: jede Kante (verschweisst, ohne Richtung — die Quader sind nicht einheitlich orientiert)
            // gehört genau zwei Dreiecken.
            let key = |i: u32| [0, 1, 2].map(|k| (m.positions[i as usize * 3 + k] * 1e7).round() as i64);
            let mut edges: std::collections::HashMap<([i64; 3], [i64; 3]), usize> = std::collections::HashMap::new();
            for t in m.indices.chunks_exact(3) {
                for k in 0..3 {
                    let (u, w) = (key(t[k]), key(t[(k + 1) % 3]));
                    if u != w {
                        *edges.entry((u.min(w), u.max(w))).or_default() += 1;
                    }
                }
            }
            assert!(edges.values().all(|c| *c == 2), "{shape:?}: Teil {:?} offen", m.color);
        }
    }
}

/// [216] `slice_x`: ein Quader, an zwei Ebenen zerschnitten, bleibt geschlossen und behält sein Volumen; alle Ecken an
/// den Teilstellen.
#[test]
fn slice_x_quader_bleibt_geschlossen() {
    let b = crate::solid_bool::Mesh::prism(&[[0.0, 0.0], [1.0, 0.0], [1.0, 0.5], [0.0, 0.5]], 0.0, 0.3);
    let (pos, idx) = slice_x(&b.positions, &b.indices, &[-1.0, 0.25, 0.6, 2.0]);
    let m = crate::solid_bool::Mesh { positions: pos, indices: idx };
    assert!(m.is_closed());
    assert!((m.volume().abs() - 0.15).abs() < 1e-12);
    assert!(m.positions.chunks_exact(3).all(|c| [0.0, 0.25, 0.6, 1.0].iter().any(|x| (c[0] - x).abs() < 1e-12)));
    assert!(m.positions.chunks_exact(3).any(|c| c[0] == 0.25) && m.positions.chunks_exact(3).any(|c| c[0] == 0.6));
}
