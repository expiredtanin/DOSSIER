//! Tests zur Vektor-Axonometrie ([266], `plan/axo.rs`).

use super::*;

/// Projekt mit Würfeln aus Wänden (1 m dick, 1 m lang, 1 m hoch): je `(x, y, z)` die untere Ecke.
fn cubes(c: &[(f64, f64, f64)]) -> Project {
    let mut levels = Vec::new();
    let mut walls = Vec::new();
    for (i, (x, y, z)) in c.iter().enumerate() {
        levels.push(serde_json::json!({"id": format!("l{i}"), "name": format!("L{i}"), "kind": "floor", "visible": true, "locked": false, "floorHeight": 1.0, "baseElevation": z}));
        walls.push(serde_json::json!({"id": format!("w{i}"), "type": "wall", "floorId": format!("l{i}"), "categoryCode": "20", "wallTypeId": "t", "start": {"x": x, "y": y + 0.5}, "end": {"x": x + 1.0, "y": y + 0.5}, "height": 1.0}));
    }
    serde_json::from_value(serde_json::json!({
        "id": "p", "name": "P", "lineStyles": [], "hatches": [], "components": [{"id": "c", "name": "C", "hatchId": ""}],
        "wallTypes": [{"id": "t", "name": "T", "layers": [{"componentId": "c", "thickness": 1.0}]}],
        "drawingLevels": levels, "layers": [{"code": "20", "name": "W", "color": "#000", "lw": 0.5, "visible": true, "locked": false}],
        "walls": walls, "drawings2d": []
    }))
    .expect("Projekt")
}

fn args(v: serde_json::Value, p: &Project) -> AxoArgs {
    AxoArgs::parse(p, &v).expect("Argumente")
}

/// Sichtbare Linien (a, b, Silhouette), kollineare anstossende Stücke zusammengefasst.
fn lines(prims: &[Primitive]) -> Vec<([f64; 2], [f64; 2], bool)> {
    let mut l: Vec<([f64; 2], [f64; 2], bool)> = prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Line { a, b, cls, .. } if cls == "axo-edge" || cls == "axo-outline" => Some(([a.x, a.y], [b.x, b.y], cls == "axo-outline")),
            _ => None,
        })
        .collect();
    let col = |a: ([f64; 2], [f64; 2], bool), b: ([f64; 2], [f64; 2], bool)| -> Option<([f64; 2], [f64; 2], bool)> {
        let d = [a.1[0] - a.0[0], a.1[1] - a.0[1]];
        let cr = |p: [f64; 2]| (d[0] * (p[1] - a.0[1]) - d[1] * (p[0] - a.0[0])).abs();
        if cr(b.0) > 1e-6 || cr(b.1) > 1e-6 {
            return None;
        }
        let near = |p: [f64; 2], q: [f64; 2]| (p[0] - q[0]).abs() + (p[1] - q[1]).abs() < 1e-6;
        for (x, y) in [(a.0, a.1), (a.1, a.0)] {
            for (u, w) in [(b.0, b.1), (b.1, b.0)] {
                if near(y, u) {
                    return Some((x, w, a.2 || b.2));
                }
            }
        }
        None
    };
    'outer: loop {
        for i in 0..l.len() {
            for j in i + 1..l.len() {
                if let Some(m) = col(l[i], l[j]) {
                    l[i] = m;
                    l.remove(j);
                    continue 'outer;
                }
            }
        }
        break;
    }
    l
}

fn prims_of(p: &Project, v: serde_json::Value) -> Vec<Primitive> {
    axo_primitives(p, &args(v, p), false).unwrap().expect("Bild").0
}

#[test]
fn wuerfel_isometrie_neun_kanten() {
    let p = cubes(&[(0.0, 0.0, 0.0)]);
    for view in ["southeast", "southwest", "northeast", "northwest"] {
        let l = lines(&prims_of(&p, serde_json::json!({"view": view})));
        assert_eq!(l.len(), 9, "{view}: {l:?}");
        assert_eq!(l.iter().filter(|e| e.2).count(), 6, "{view}: Umriss sechs Kanten");
    }
}

#[test]
fn wuerfel_flaechen_getoent_nach_lage() {
    let p = cubes(&[(0.0, 0.0, 0.0)]);
    let prims = prims_of(&p, serde_json::json!({"view": "southeast"}));
    let fills: Vec<&String> = prims.iter().filter_map(|q| match q { Primitive::Polygon { fill, wall_id, .. } => { assert_eq!(wall_id.as_deref(), Some("w0")); Some(fill) } _ => None }).collect();
    assert_eq!(fills.len(), 3, "drei sichtbare Seiten");
    let mut f = fills.clone();
    f.sort();
    f.dedup();
    assert_eq!(f.len(), 3, "drei verschiedene Grautöne: {fills:?}");
    // Ohne Füllungen nur Linien.
    let prims = prims_of(&p, serde_json::json!({"view": "southeast", "fills": false}));
    assert!(prims.iter().all(|q| matches!(q, Primitive::Line { .. })));
}

#[test]
fn verdeckter_wuerfel_entfaellt() {
    // Von Norden (hinten, [270]) gesehen: der kleinere Würfel liegt ganz hinter dem grossen.
    let mut p = cubes(&[(0.0, 0.0, 0.0), (0.0, -5.0, 0.0)]);
    p.walls[1].start.x = 0.25;
    p.walls[1].end.x = 0.75;
    p.walls[1].height = 0.5;
    let l = lines(&prims_of(&p, serde_json::json!({"view": "back"})));
    assert_eq!(l.len(), 4, "nur das Quadrat vorne: {l:?}");
    // Mit verdeckten Kanten: die Kanten des hinteren Würfels gestrichelt.
    let prims = prims_of(&p, serde_json::json!({"view": "back", "hidden": true}));
    let hidden = prims.iter().filter(|q| matches!(q, Primitive::Line { cls, dash: Some(Some(_)), .. } if cls == "axo-hidden")).count();
    assert!(hidden >= 3, "verdeckte Kanten: {hidden}");
    // In der Isometrie zwei Würfel hintereinander: der hintere wird teilweise verdeckt, keine Linie quert den vorderen.
    let p = cubes(&[(0.0, 0.0, 0.0), (-1.5, 1.5, 0.0)]);
    // 9 Kanten des vorderen und 9 sichtbare Teilstücke des hinteren (an den vorderen anstossend, nicht darüber).
    let l = lines(&prims_of(&p, serde_json::json!({"view": "southeast"})));
    assert_eq!(l.len(), 18, "{l:?}");
    let a = lines(&prims_of(&cubes(&[(0.0, 0.0, 0.0)]), serde_json::json!({"view": "southeast"})));
    let hull: Vec<[f64; 2]> = a.iter().filter(|e| e.2).flat_map(|e| [e.0, e.1]).collect();
    let (cx, cy) = (hull.iter().map(|q| q[0]).sum::<f64>() / hull.len() as f64, hull.iter().map(|q| q[1]).sum::<f64>() / hull.len() as f64);
    for e in l.iter().filter(|e| !a.iter().any(|f| f.0 == e.0 && f.1 == e.1)) {
        // Mitte eines Stücks des hinteren Würfels: nicht im Innern des vorderen (Sechseck um die Mitte, Radius < 0.8).
        let m = [(e.0[0] + e.1[0]) / 2.0, (e.0[1] + e.1[1]) / 2.0];
        assert!(((m[0] - cx).powi(2) + (m[1] - cy).powi(2)).sqrt() > 0.35, "Linie im vorderen Würfel: {e:?}");
    }
}

#[test]
fn militaer_grundriss_unverzerrt_senkrechte_unverkuerzt() {
    let p = cubes(&[(0.0, 0.0, 0.0)]);
    for kind in ["military", "military30"] {
        let l = lines(&prims_of(&p, serde_json::json!({"view": "southeast", "projection": kind})));
        let len = |e: &([f64; 2], [f64; 2], bool)| ((e.1[0] - e.0[0]).powi(2) + (e.1[1] - e.0[1]).powi(2)).sqrt();
        assert!(l.iter().all(|e| (len(e) - 1.0).abs() < 1e-6), "{kind}: alle Kanten 1 m: {l:?}");
        assert!(l.iter().filter(|e| (e.0[0] - e.1[0]).abs() < 1e-9).count() >= 3, "{kind}: Senkrechte senkrecht");
        assert_eq!(l.len(), 9, "{kind}");
    }
    // 30/60: die Süd-/Nordkanten (x) liegen 30° geneigt.
    let l = lines(&prims_of(&p, serde_json::json!({"view": "southeast", "projection": "military30"})));
    let ang = |e: &([f64; 2], [f64; 2], bool)| (e.1[1] - e.0[1]).abs().atan2((e.1[0] - e.0[0]).abs()).to_degrees();
    assert!(l.iter().any(|e| (ang(e) - 30.0).abs() < 1e-6) && l.iter().any(|e| (ang(e) - 60.0).abs() < 1e-6));
}

#[test]
fn kamera_parallel_und_perspektive() {
    let p = cubes(&[(0.0, 0.0, 0.0)]);
    let cam = |kind: &str| serde_json::json!({"camera": {"kind": kind, "position": [6.0, -5.0, 4.0], "direction": [-5.5, 5.5, -3.5], "up": [0.0, 0.0, 1.0], "fovDeg": 40.0}});
    for kind in ["orthogonal", "perspective"] {
        let l = lines(&prims_of(&p, cam(kind)));
        assert_eq!(l.len(), 9, "{kind}: {l:?}");
        assert!(l.iter().all(|e| e.0.iter().chain(e.1.iter()).all(|v| v.is_finite())));
    }
    // Perspektive: die senkrechten Kanten laufen nach unten zusammen (Blick von oben), sie sind nicht parallel.
    let l = lines(&prims_of(&p, cam("perspective")));
    let vert: Vec<_> = l.iter().filter(|e| (e.1[1] - e.0[1]).abs() > 3.0 * (e.1[0] - e.0[0]).abs()).collect();
    assert!(vert.len() >= 3);
    assert!(vert.iter().any(|e| (e.1[0] - e.0[0]).abs() > 1e-3), "Fluchten: {vert:?}");
    // Kamera im Würfel bzw. hinter dem Blick: kein Absturz, kein Unsinn.
    let inside = serde_json::json!({"camera": {"kind": "perspective", "position": [0.5, 0.5, 0.5], "direction": [1.0, 0.0, 0.0], "up": [0.0, 0.0, 1.0], "fovDeg": 60.0}});
    let r = axo_primitives(&p, &args(inside, &p), false).unwrap();
    if let Some((prims, b)) = r {
        assert!(b.iter().all(|v| v.is_finite()) && !prims.is_empty());
    }
}

#[test]
fn satteldach_first_und_traufe() {
    let p: Project = serde_json::from_value(serde_json::json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
        "drawingLevels": [], "layers": [], "walls": [], "drawings2d": [],
        "roofs": [{"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35",
            "outline": [{"x": 0, "y": 0}, {"x": 12, "y": 0}, {"x": 12, "y": 8}, {"x": 0, "y": 8}],
            "shape": "sattel", "pitchDeg": 50, "overhang": 0.0, "ridgeAxis": "x", "baseElevation": 3.0, "thickness": 0.25}]
    }))
    .unwrap();
    let a = args(serde_json::json!({"view": "southeast"}), &p);
    let (prims, b) = axo_primitives(&p, &a, false).unwrap().expect("Dach");
    let l = lines(&prims);
    // Isometrie Südost, Dach 50° (steiler als der Blick): die Nordfläche ist abgewandt, der First Umriss.
    let Projection::Parallel { m, .. } = a.proj else { panic!() };
    let pv = |q: V3| [dot(m[0], q), dot(m[1], q)];
    let ridge_z = 3.0 + 4.0 * 50f64.to_radians().tan();
    let (r0, r1) = (pv([0.0, 4.0, ridge_z]), pv([12.0, 4.0, ridge_z]));
    let on = |e: &([f64; 2], [f64; 2], bool), q: [f64; 2], tol: f64| {
        let d = [e.1[0] - e.0[0], e.1[1] - e.0[1]];
        let len = (d[0] * d[0] + d[1] * d[1]).sqrt();
        let t = ((q[0] - e.0[0]) * d[0] + (q[1] - e.0[1]) * d[1]) / (len * len);
        let c = [e.0[0] + d[0] * t, e.0[1] + d[1] * t];
        t > -1e-6 && t < 1.0 + 1e-6 && ((c[0] - q[0]).powi(2) + (c[1] - q[1]).powi(2)).sqrt() < tol
    };
    let mid = [(r0[0] + r1[0]) / 2.0, (r0[1] + r1[1]) / 2.0];
    assert!(l.iter().any(|e| on(e, mid, 0.4)), "First fehlt: {l:?}");
    // Traufe Süd (y = 0, z = 3) sichtbar, die Nordtraufe (hinter dem First) verdeckt.
    let s_mid = pv([6.0, 0.0, 3.0]);
    let n_mid = pv([6.0, 8.0, 3.0]);
    assert!(l.iter().any(|e| on(e, s_mid, 0.4)), "Traufe Süd fehlt");
    assert!(!l.iter().any(|e| on(e, n_mid, 0.05)), "Traufe Nord müsste verdeckt sein");
    assert!(b[3] > b[1]);
}

#[test]
fn leeres_projekt_und_unsinn_ohne_absturz() {
    let empty = Project::default();
    let buf = axo_plan_buf(&empty, &[0.0, 100.0], r#"{"view":"southeast"}"#).unwrap();
    let v = crate::plan::buf::View::parse(&buf).unwrap();
    assert!(v.groups().unwrap_or_default().is_empty());
    let p = cubes(&[(0.0, 0.0, 0.0)]);
    for t in [
        r#"{"camera":{"kind":"perspective","position":[NaN,0,0],"direction":[1,0,0]}}"#,
        r#"{"camera":{"kind":"perspective","position":[1e300,-1e300,1e300],"direction":[-1,1,-1],"fovDeg":1e308}}"#,
        r#"{"camera":{"kind":"orthogonal","position":[0,0,0],"direction":[0,0,0]}}"#,
        r#"{"camera":{"kind":"perspective","position":[0,0,0],"direction":[0,0,1],"up":[0,0,1]}}"#,
        r#"{"view":"gibtsnicht"}"#,
        r#"{"cameraId":"fehlt"}"#,
        r#"{"view":"southeast","projection":"military30","aspect":-1}"#,
        "{}",
    ] {
        // NaN ist kein JSON: Fehler statt Absturz.
        let _ = axo_plan_buf(&p, &[f64::NAN, f64::INFINITY], t);
    }
    assert!(axo_plan_buf(&p, &[0.0, 100.0], "kein json").is_err());
    // Riesige Koordinaten im Modell.
    let mut big = cubes(&[(0.0, 0.0, 0.0)]);
    big.walls[0].start.x = 1e200;
    let _ = axo_plan_buf(&big, &[0.0, 100.0], r#"{"view":"southeast"}"#);
}

#[test]
fn klassen_ausgeblendet() {
    let p = cubes(&[(0.0, 0.0, 0.0)]);
    let a = args(serde_json::json!({"view": "southeast", "hasVis": true, "invisible": ["20"]}), &p);
    assert!(axo_primitives(&p, &a, false).unwrap().is_none(), "Klasse 20 aus: kein Bauteil");
}

#[test]
fn kamera_element_des_projekts() {
    let mut p = cubes(&[(0.0, 0.0, 0.0)]);
    p.cameras = Some(vec![serde_json::from_value(serde_json::json!({"id": "k", "type": "camera", "name": "K", "floorId": "l0", "categoryCode": "92", "position": {"x": 6, "y": -5}, "eyeHeight": 3.0, "target": {"x": 0.5, "y": 0.5}, "targetHeight": 0.5, "fovDeg": 40, "projection": "perspective"})).unwrap()]);
    let l = lines(&prims_of(&p, serde_json::json!({"cameraId": "k"})));
    assert_eq!(l.len(), 9, "{l:?}");
}

#[test]
fn ausschnitt_3d_auf_dem_blatt() {
    let mut p = cubes(&[(0.0, 0.0, 0.0)]);
    let snap: ViewSnapshot = serde_json::from_value(serde_json::json!({"id": "s3", "name": "3D", "viewType": "perspektive", "view3d": "iso", "scaleDenominator": 50, "detail": "mittel", "activeLevelId": "l0", "layerVisibility": {"20": true}, "drawingVisibility": {}})).unwrap();
    p.view_snapshots = Some(vec![snap.clone()]);
    let buf = crate::sheet_viewports::snapshot_buf(&p, &snap, 50.0, None).expect("3D-Dokument");
    let prims = crate::plan::buf::View::parse(&buf).unwrap().prims().unwrap();
    assert_eq!(lines(&prims).len(), 9);
    // Klasse aus: kein Inhalt.
    let mut off = snap.clone();
    off.layer_visibility.insert("20".into(), false);
    assert!(crate::sheet_viewports::snapshot_buf(&p, &off, 50.0, None).is_none());
    // Militär mit verdeckten Kanten über `doc3d` (zwei Würfel: der hintere teils verdeckt; Rückseiten zeigt die
    // Zeichnung nicht, nur verdeckte Teile zugewandter Flächen).
    let p = cubes(&[(0.0, 0.0, 0.0), (-1.5, 1.5, 0.0)]);
    let mut mil = snap.clone();
    mil.doc3d = Some(serde_json::from_value(serde_json::json!({"projection": "military", "hiddenLines": true, "fills": false})).unwrap());
    let buf = crate::sheet_viewports::snapshot_buf(&p, &mil, 50.0, None).unwrap();
    let prims = crate::plan::buf::View::parse(&buf).unwrap().prims().unwrap();
    assert!(prims.iter().all(|q| matches!(q, Primitive::Line { .. })));
    assert!(prims.iter().any(|q| matches!(q, Primitive::Line { cls, .. } if cls == "axo-hidden")));
}

/// Zeitprofil von Hand: `AXO_OBP=mk.obp cargo test --release --lib axo_zeit -- --ignored --nocapture`.
#[test]
#[ignore]
fn axo_zeit() {
    let Ok(path) = std::env::var("AXO_OBP") else { return };
    let p: Project = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let a = args(serde_json::json!({"view": "southeast"}), &p);
    let t = std::time::Instant::now();
    let (prep, refs) = prepare(&p, &a.proj, &a.vis, false, Some(TerrainClip::Parcel), 100.0).unwrap().unwrap();
    eprintln!("Flächen: {} in {:?}", prep.faces.len(), t.elapsed());
    let t = std::time::Instant::now();
    let segs = hlr::hidden_lines(&prep.faces, &hlr::Opts { tol: 1e-4, depth_eps: 1e-4, hidden: false, ..hlr::Opts::default() });
    eprintln!("Kanten: {} in {:?}", segs.len(), t.elapsed());
    let t = std::time::Instant::now();
    let out = compute(&prep.faces, &prep.model_n, light_of(&a.proj), AxoOpts { hidden: false, fills: false });
    eprintln!("ohne Füllung: {} in {:?}", out.edges.len(), t.elapsed());
    let t = std::time::Instant::now();
    let out = compute(&prep.faces, &prep.model_n, light_of(&a.proj), AxoOpts { hidden: false, fills: true });
    eprintln!("mit Füllung: {} in {:?}", out.fills.len(), t.elapsed());
    let area = |r: &[[f64; 2]]| r.iter().zip(r.iter().cycle().skip(1)).map(|(a, b)| a[0] * b[1] - b[0] * a[1]).sum::<f64>() / 2.0;
    for (polys, _, o) in &out.fills {
        for poly in polys {
            let ring = if poly.len() > 1 { crate::voids::keyhole(poly).0 } else { poly[0].clone() };
            let s = simplify(&ring);
            assert!((area(&ring) - area(&s)).abs() < 1e-6, "simplify ändert die Fläche von {:?}", refs.get(*o as usize).and_then(|r| r.id.clone()));
            let whole: f64 = poly.iter().enumerate().map(|(k, r)| if k == 0 { area(r).abs() } else { -area(r).abs() }).sum();
            assert!((area(&ring).abs() - whole).abs() < 1e-6);
        }
    }
}

/// Zwischenpunkte auf Geraden fallen weg, die Fläche bleibt; ein doppelter Schlusspunkt nimmt nicht beide Ecken mit.
#[test]
fn ringe_vereinfachen_ohne_flaechenverlust() {
    let area = |r: &[[f64; 2]]| r.iter().zip(r.iter().cycle().skip(1)).map(|(a, b)| a[0] * b[1] - b[0] * a[1]).sum::<f64>() / 2.0;
    let r = vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [2.0, 1.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.0]];
    let s = simplify(&r);
    assert_eq!(s.len(), 4, "{s:?}");
    assert!((area(&s) - 2.0).abs() < 1e-12);
    let tri = vec![[0.0, 0.0], [2.0, 0.0], [1.0, 2.0], [0.0, 0.0], [0.0, 0.0]];
    assert!((area(&simplify(&tri)) - 2.0).abs() < 1e-12);
}

/// [270] Seitenrichtig: Erker im Osten (Würfel bei x = +5), Garage im Westen (x = −6), Nordflügel (y = +5). In der
/// Zeichnung (x rechts, y oben wie der Plan) liegt der Erker von Süden/Südost aus rechts, von Norden/Nordwest aus links;
/// die Kamera der 3D-Ansicht (Modell-Koordinaten, `camera`) und die Vorgaben `iso`/`southeast` stimmen überein.
#[test]
fn testhaus_seitenrichtig_in_allen_vorgaben() {
    let mid = |p: &Project, v: serde_json::Value, k: usize| -> f64 {
        let l = lines(&prims_of(p, v));
        assert!(!l.is_empty());
        l.iter().map(|e| e.0[k] + e.1[k]).sum::<f64>() / (2 * l.len()) as f64
    };
    let (erker, garage) = (cubes(&[(5.0, 0.0, 0.0)]), cubes(&[(-6.0, 0.0, 0.0)]));
    let views = [("southeast", true), ("iso", true), ("south", true), ("front", true), ("southwest", true), ("isoFrontLeft", true), ("perspective", true), ("northwest", false), ("north", false), ("back", false), ("northeast", false), ("isoBackRight", false), ("isoBackLeft", false)];
    for (view, east_right) in views {
        for kind in ["iso", "military", "military30"] {
            let v = serde_json::json!({"view": view, "projection": kind});
            let (e, g) = (mid(&erker, v.clone(), 0), mid(&garage, v, 0));
            assert_eq!(e > g, east_right, "{view}/{kind}: Erker {e:.2}, Garage {g:.2}");
        }
    }
    // Draufsicht wie der Grundriss: Norden oben, Osten rechts; von Osten (`side`): Norden rechts.
    let (nord, sued) = (cubes(&[(0.0, 5.0, 0.0)]), cubes(&[(0.0, -6.0, 0.0)]));
    let top = serde_json::json!({"view": "top"});
    assert!(mid(&nord, top.clone(), 1) > mid(&sued, top.clone(), 1));
    assert!(mid(&erker, top.clone(), 0) > mid(&garage, top, 0));
    let side = serde_json::json!({"view": "side"});
    assert!(mid(&nord, side.clone(), 0) > mid(&sued, side, 0));
    // Kamera der 3D-Ansicht aus Südosten (Modell-Koordinaten): dieselbe Seite wie die Vorgabe.
    let cam = serde_json::json!({"camera": {"kind": "orthogonal", "position": [30.0, -30.0, 25.0], "direction": [-1.0, 1.0, -0.8], "up": [0.0, 0.0, 1.0], "orthoHeight": 30.0}});
    let (e, g) = (mid(&erker, cam.clone(), 0), mid(&garage, cam, 0));
    assert!(e > g, "Kamera Südost: Erker {e:.2}, Garage {g:.2}");
}

/// [253] Entourage (Auto) erscheint im 3D-Dokument; seine Klasse schaltet es ab.
#[test]
fn entourage_im_3d_dokument() {
    let mut p = cubes(&[(0.0, 0.0, 0.0)]);
    let n0 = lines(&prims_of(&p, serde_json::json!({"view": "southeast"}))).len();
    p.drawings2d.push(serde_json::from_value(serde_json::json!({"id": "pers1", "type": "drawing2d", "levelId": "l0", "categoryCode": "24", "geom": {"shape": "libobj", "libId": "lib:auto", "at": {"x": 4.0, "y": -3.0}, "rotation": 0.5}})).unwrap());
    let n1 = lines(&prims_of(&p, serde_json::json!({"view": "southeast"}))).len();
    assert!(n1 > n0 + 10, "{n0} -> {n1}");
    assert_eq!(lines(&prims_of(&p, serde_json::json!({"view": "southeast", "hasVis": true, "invisible": ["24"]}))).len(), n0, "Klasse aus");
}

/// [253] Entourage auch in den schiefen Projektionen (`military`, `military30`): Kanten kommen hinzu und die Klasse
/// schaltet sie ab.
#[test]
fn entourage_in_schiefen_projektionen() {
    let mut p = cubes(&[(0.0, 0.0, 0.0)]);
    p.drawings2d.push(serde_json::from_value(serde_json::json!({"id": "pers1", "type": "drawing2d", "levelId": "l0", "categoryCode": "24", "geom": {"shape": "libobj", "libId": "lib:auto", "at": {"x": 4.0, "y": -3.0}, "rotation": 0.5}})).unwrap());
    for kind in ["military", "military30", "iso"] {
        let n1 = lines(&prims_of(&p, serde_json::json!({"view": "southeast", "projection": kind}))).len();
        let n0 = lines(&prims_of(&p, serde_json::json!({"view": "southeast", "projection": kind, "hasVis": true, "invisible": ["24"]}))).len();
        assert!(n1 > n0 + 10, "{kind}: {n0} -> {n1}");
    }
}

/// [285] Bäume (`Project.trees`) erscheinen im 3D-Dokument wie im 3D (Stamm + Krone); ihre Klasse schaltet sie ab, auch in
/// den schiefen Projektionen.
#[test]
fn baeume_im_3d_dokument() {
    let mut p = cubes(&[(0.0, 0.0, 0.0)]);
    p.trees = Some(vec![serde_json::from_value(serde_json::json!({
        "id": "T1", "type": "tree", "floorId": "l0", "categoryCode": "13", "position": {"x": 6.0, "y": -4.0},
        "trunkDiameter": 0.4, "crownDiameter": 5.0, "crownBase": 2.0, "height": 8.0
    }))
    .unwrap()]);
    for kind in ["iso", "military"] {
        let n1 = lines(&prims_of(&p, serde_json::json!({"view": "southeast", "projection": kind}))).len();
        let n0 = lines(&prims_of(&p, serde_json::json!({"view": "southeast", "projection": kind, "hasVis": true, "invisible": ["13"]}))).len();
        assert!(n1 > n0 + 10, "{kind}: {n0} -> {n1}");
    }
}

/// [305] Fenster im 3D-Dokument: Rahmen (deckend) und Glas (nicht deckend, hell getönt; ihre Kanten fein, soweit der Rahmen sie nicht deckt) aus denselben
/// Teilen wie das 3D (`emit_opening_meshes`); ab 1:200 nur Rahmenring und Glas (weniger Flächen als bei 1:100);
/// die Klasse der Öffnung schaltet beides ab.
#[test]
fn fenster_mit_rahmen_und_glas() {
    let p: Project = serde_json::from_str(include_str!("../../tests/fixtures/robust/wettbewerb.json")).unwrap();
    let a = args(serde_json::json!({"view": "southeast"}), &p);
    let parts = |scale: f64| {
        let (prep, refs) = prepare(&p, &a.proj, &a.vis, false, Some(TerrainClip::Parcel), scale).unwrap().expect("Flächen");
        let n = |glass: bool| prep.faces.iter().filter(|f| refs.get(f.owner as usize).is_some_and(|r| r.opening && r.glass == glass)).count();
        (n(false), n(true))
    };
    let (rahmen100, glas100) = parts(100.0);
    let (rahmen200, glas200) = parts(200.0);
    assert!(rahmen200 > 0 && glas200 > 0, "Rahmen {rahmen200}, Glas {glas200} bei 1:200");
    assert!(rahmen100 > rahmen200, "1:100 mit Flügel-Detail: {rahmen100} > {rahmen200}");
    assert_eq!(glas100, glas200, "Glas in jedem Massstab");
    // Glas hell getönt mit Deckkraft.
    let (prims, _) = axo_primitives(&p, &a, false).unwrap().expect("Bild");
    let glass: Vec<&Primitive> = prims.iter().filter(|q| matches!(q, Primitive::Polygon { fill, .. } if fill == WINDOW_GLASS_FILL)).collect();
    assert!(!glass.is_empty(), "Glasflächen im Bild");
    assert!(glass.iter().all(|q| matches!(q, Primitive::Polygon { opacity: Some(o), .. } if *o < 1.0)));
    // Klasse aller Öffnungen aus: weder Rahmen noch Glas.
    let mut codes: Vec<String> = p.openings.as_deref().unwrap().iter().map(|o| o.category_code.clone()).collect();
    codes.sort();
    codes.dedup();
    let off = args(serde_json::json!({"view": "southeast", "hasVis": true, "invisible": codes}), &p);
    let (prep, refs) = prepare(&p, &off.proj, &off.vis, false, Some(TerrainClip::Parcel), 100.0).unwrap().expect("Flächen");
    assert!(prep.faces.iter().all(|f| !refs.get(f.owner as usize).is_some_and(|r| r.opening)));
}

/// [307] Gelände: Rechteck 13 × 13 m auf Höhe 0 (zwei Dreiecke), Klasse „02“.
fn with_terrain(mut p: Project) -> Project {
    let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![-6.0, -6.0, 0.0, 7.0, -6.0, 0.0, 7.0, 7.0, 0.0, -6.0, 7.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], ..Default::default() };
    p.context = Some(vec![ContextObject::TerrainMesh(t)]);
    p.layers.push(serde_json::from_value(serde_json::json!({"code": "02", "name": "Gelände", "color": "#000", "lw": 0.5, "visible": true, "locked": false})).unwrap());
    p
}

fn terrain_fills(prims: &[Primitive]) -> usize {
    prims.iter().filter(|q| matches!(q, Primitive::Polygon { context_object_id: Some(id), .. } if id == "t")).count()
}

#[test]
fn gelaende_flaeche_mit_umriss_ohne_dreiecksfuge() {
    let p = with_terrain(cubes(&[(0.0, 0.0, 0.0)]));
    let prims = prims_of(&p, serde_json::json!({"view": "southeast", "terrainClip": "none"}));
    assert!(terrain_fills(&prims) >= 1, "Geländefläche fehlt");
    // Würfel auf dem Gelände: 9 Würfelkanten + 4 Geländekanten, die Diagonale der zwei Dreiecke fehlt.
    let l = lines(&prims_of(&p, serde_json::json!({"view": "southeast", "terrain": false})));
    assert_eq!(l.len(), 9, "ohne Gelände nur der Würfel");
    let with = lines(&prims);
    assert!(with.len() <= 9 + 4 + 2 && with.len() >= 9 + 4 - 2, "Würfel + Geländerand, keine Diagonale: {}", with.len());
    // Reines Gelände: genau vier Randkanten, eine getönte Fläche.
    let mut q = with_terrain(cubes(&[(0.0, 0.0, 0.0)]));
    q.walls.clear();
    q.drawing_levels.clear();
    let prims = prims_of(&q, serde_json::json!({"view": "southeast", "terrainClip": "none"}));
    assert_eq!(lines(&prims).len(), 4, "{:?}", lines(&prims));
    assert_eq!(terrain_fills(&prims), 1);
}

#[test]
fn keller_unter_gelaende_verdeckt() {
    // Würfel unter dem Gelände (Oberkante −0.5): kein Würfel-Strich, nur der Geländerand.
    let p = with_terrain(cubes(&[(0.0, 0.0, -1.5)]));
    let l = lines(&prims_of(&p, serde_json::json!({"view": "southeast", "terrainClip": "none"})));
    assert_eq!(l.len(), 4, "{l:?}");
    // Gelände aus (Parameter) bzw. Klasse „02“ ausgeblendet: der Würfel erscheint.
    assert_eq!(lines(&prims_of(&p, serde_json::json!({"view": "southeast", "terrain": false}))).len(), 9);
    let a = args(serde_json::json!({"view": "southeast", "terrainClip": "none", "hasVis": true, "invisible": ["02"]}), &p);
    let prims = axo_primitives(&p, &a, false).unwrap().unwrap().0;
    assert_eq!(terrain_fills(&prims), 0);
    assert_eq!(lines(&prims).len(), 9);
}

#[test]
fn baugrube_gibt_das_haus_im_gelaende_frei() {
    // Versenkter Würfel in einer Baugrube: er schaut aus der Grube heraus (mehr als der Geländerand).
    let mut q = with_terrain(cubes(&[(0.0, 0.0, -1.5)]));
    let v = |x: f64, y: f64| Vec2 { x, y };
    let pit = Excavation { id: "bg".into(), outline: vec![v(-3.0, -3.0), v(4.0, -3.0), v(4.0, 4.0), v(-3.0, 4.0)], bottom: -1.5, ..Default::default() };
    q.context.as_mut().unwrap().push(ContextObject::Excavation(pit));
    let n = lines(&prims_of(&q, serde_json::json!({"view": "southeast", "terrainClip": "none"}))).len();
    assert!(n > 4 + 3, "Würfel in der Baugrube sichtbar: {n}");
}

/// [308] Gelände 60 × 60 m (zwei Dreiecke) um den Würfel, Parzelle 10 × 10 m.
fn big_terrain(parcel: bool) -> Project {
    let mut p = cubes(&[(0.0, 0.0, 0.0)]);
    let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![-30.0, -30.0, 0.0, 30.0, -30.0, 0.0, 30.0, 30.0, 0.0, -30.0, 30.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], ..Default::default() };
    p.context = Some(vec![ContextObject::TerrainMesh(t)]);
    p.layers.push(serde_json::from_value(serde_json::json!({"code": "02", "name": "Gelände", "color": "#000", "lw": 0.5, "visible": true, "locked": false})).unwrap());
    if parcel {
        p.site_rules = serde_json::from_value(serde_json::json!({"parcel": [{"x": -5.0, "y": -5.0}, {"x": 5.0, "y": -5.0}, {"x": 5.0, "y": 5.0}, {"x": -5.0, "y": 5.0}], "defaultSetback": 3.0})).ok();
    }
    p
}

fn extent(p: &Project, v: serde_json::Value) -> (Vec<Primitive>, [f64; 4]) {
    let a = args(v, p);
    axo_primitives(p, &a, false).unwrap().unwrap()
}

#[test]
fn gelaende_auf_parzelle_zugeschnitten_mit_sockel() {
    let p = big_terrain(true);
    let (prims, b) = extent(&p, serde_json::json!({"view": "southeast"}));
    let (_, b_none) = extent(&p, serde_json::json!({"view": "southeast", "terrainClip": "none"}));
    assert!((b[2] - b[0]) < 0.9 * (b_none[2] - b_none[0]), "Bild kleiner als ohne Zuschnitt: {b:?} vs {b_none:?}");
    // Parzelle ± 2 m = 14 m breit, Isometrie: Breite ≈ 14·√2 ≈ 19.8 m.
    assert!((b[2] - b[0]) < 22.0 && (b[2] - b[0]) > 12.0, "{b:?}");
    // Sockel: Seitenflächen sind eigene, dunklere Flächen mit Geländebezug.
    let tints: std::collections::BTreeSet<String> = prims.iter().filter_map(|q| match q {
        Primitive::Polygon { context_object_id: Some(id), fill, .. } if id == "t" => Some(format!("{fill:?}")),
        _ => None,
    }).collect();
    assert!(tints.len() >= 2, "Oberfläche und Sockelseiten verschieden getönt: {tints:?}");
    // Ohne Parzelle: Gebäude + 5 m (11 × 11 m Gebäude-Rand → deutlich kleiner als 60 m).
    let q = big_terrain(false);
    let (_, bq) = extent(&q, serde_json::json!({"view": "southeast"}));
    assert!((bq[2] - bq[0]) < 0.9 * (b_none[2] - b_none[0]), "{bq:?}");
    // Ohne Sockel („none“) keine Seitenflächen.
    let n_side = |v: serde_json::Value| terrain_fills(&extent(&p, v).0);
    assert!(n_side(serde_json::json!({"view": "southeast"})) > n_side(serde_json::json!({"view": "southeast", "terrainClip": "none"})));
}

/// [309] Gelände als Raster `nx × ny` Zellen (2·nx·ny Dreiecke) über [x0, x1] × [y0, y1], Höhe 0.1·x.
fn grid_terrain(x: (f64, f64), y: (f64, f64), nx: usize, ny: usize) -> TerrainMesh {
    let (mut pos, mut idx) = (Vec::new(), Vec::new());
    for j in 0..=ny {
        for i in 0..=nx {
            let (px, py) = (x.0 + (x.1 - x.0) * i as f64 / nx as f64, y.0 + (y.1 - y.0) * j as f64 / ny as f64);
            pos.extend([px, py, 0.1 * px]);
        }
    }
    for j in 0..ny {
        for i in 0..nx {
            let a = (j * (nx + 1) + i) as f64;
            let b = a + 1.0;
            let c = a + (nx + 1) as f64;
            idx.extend([a, b, c + 1.0, a, c + 1.0, c]);
        }
    }
    TerrainMesh { id: "t".into(), category_code: "02".into(), positions: pos, indices: idx, ..Default::default() }
}

fn parcel_project(t: TerrainMesh, parcel: serde_json::Value, walls: bool) -> Project {
    let mut p = cubes(&[(0.0, 0.0, 0.0)]);
    if !walls {
        p.walls.clear();
        p.drawing_levels.clear();
    }
    p.context = Some(vec![ContextObject::TerrainMesh(t)]);
    p.layers.push(serde_json::from_value(serde_json::json!({"code": "02", "name": "Gelände", "color": "#000", "lw": 0.5, "visible": true, "locked": false})).unwrap());
    p.site_rules = serde_json::from_value(serde_json::json!({"parcel": parcel, "defaultSetback": 3.0})).ok();
    p
}

/// [309] Dichtes Netz (> 12 000 Dreiecke), das die schiefe Parzelle + 2 m nicht ganz deckt: der Sockelrand ist ein
/// sauberer Umriss mit vier Ecken (kein Treppenrand), Kanten oben, unten und senkrecht zusammengefasst.
#[test]
fn sockelrand_gerade_bei_dichtem_netz_und_schiefer_parzelle() {
    let parcel = serde_json::json!([{"x": -10.0, "y": -8.0}, {"x": 12.0, "y": -10.0}, {"x": 14.0, "y": 10.0}, {"x": -9.0, "y": 12.0}]);
    // Netz y −20 … 4 m: deckt die Parzelle + 2 m im Norden (bis 14 m) nicht; 2 · 120 · 50 = 12 000 + Dreiecke.
    let p = parcel_project(grid_terrain((-30.0, 30.0), (-20.0, 4.0), 130, 60), parcel, false);
    let l = lines(&prims_of(&p, serde_json::json!({"view": "southeast"})));
    // Oben 4 + unten 4 + senkrechte Ecken höchstens 4 (verdeckte entfallen).
    assert!(l.len() <= 12, "Sockelrand gezackt: {} Linien: {l:?}", l.len());
    assert!(l.len() >= 8, "{}", l.len());
}

/// [309] Konkave Parzelle (L-Form): Zuschnitt folgt dem Umriss (sechs Ecken, nicht die Rechteck-Hülle).
#[test]
fn zuschnitt_auf_konkaven_parzellenumriss() {
    let l_shape = serde_json::json!([{"x": -10.0, "y": -10.0}, {"x": 10.0, "y": -10.0}, {"x": 10.0, "y": 0.0}, {"x": 0.0, "y": 0.0}, {"x": 0.0, "y": 10.0}, {"x": -10.0, "y": 10.0}]);
    let p = parcel_project(grid_terrain((-30.0, 30.0), (-30.0, 30.0), 12, 12), l_shape, false);
    let l = lines(&prims_of(&p, serde_json::json!({"view": "southeast"})));
    // Aufsicht ist nicht nötig: ohne Aufsicht gilt die Obergrenze 6 oben + 6 unten + 6 senkrecht.
    assert!(l.len() <= 18, "{}", l.len());
    // Fläche des Zuschnitts: L (300 m²) + 2 m Rand, deutlich kleiner als die Hülle (24 × 24 = 576 m²).
    let a = crate::plan::axo_terrain::clip_area_for_test(&p).expect("Fläche");
    assert!(a > 300.0 && a < 480.0, "{a}");
}

/// [309] Keller unter dem Gelände: Sockel-Unterkante mindestens 0.5 m unter dem tiefsten Bauteil.
#[test]
fn sockel_unter_dem_tiefsten_bauteil() {
    let parcel = serde_json::json!([{"x": -5.0, "y": -5.0}, {"x": 6.0, "y": -5.0}, {"x": 6.0, "y": 6.0}, {"x": -5.0, "y": 6.0}]);
    let t = || TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![-30.0, -30.0, 0.0, 30.0, -30.0, 0.0, 30.0, 30.0, 0.0, -30.0, 30.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], ..Default::default() };
    let mut p = parcel_project(t(), parcel.clone(), true);
    p.drawing_levels[0].base_elevation = Some(-6.0);
    let h = |p: &Project| {
        let a = args(serde_json::json!({"view": "southeast"}), p);
        let b = axo_primitives(p, &a, false).unwrap().unwrap().1;
        b[3] - b[1]
    };
    let mut q = parcel_project(t(), parcel, true);
    q.drawing_levels[0].base_elevation = Some(-0.2);
    // Bauteil bei −6: Unterkante −6.5 statt −1. Bild höher um ≈ 5.5 m · Höhenmassstab (Isometrie ≈ 0.82).
    assert!(h(&p) - h(&q) > 4.0, "{} vs {}", h(&p), h(&q));
}

/// [310] Sockelseiten: je gerader Randkante des Zuschnitts eine einzige senkrechte Fläche (keine Fugen zwischen Dreieckskanten).
#[test]
fn sockelseite_je_randkante_eine_flaeche() {
    // Parzelle schief zum Raster: der Zuschnitt zerlegt die Seiten in viele Stücke.
    let parcel = serde_json::json!([{"x": -10.0, "y": -8.0}, {"x": 12.0, "y": -10.0}, {"x": 14.0, "y": 10.0}, {"x": -9.0, "y": 12.0}]);
    let p = parcel_project(grid_terrain((-30.0, 30.0), (-30.0, 30.0), 40, 40), parcel, false);
    let a = args(serde_json::json!({"view": "southeast"}), &p);
    let (prep, refs) = prepare(&p, &a.proj, &a.vis, false, Some(TerrainClip::Parcel), 100.0).unwrap().expect("Flächen");
    let sides = prep.faces.iter().filter(|f| refs.get(f.owner as usize).is_some_and(|r| r.terrain_side)).count();
    assert_eq!(sides, 4, "eine Fläche je Seite des Zuschnitts");
}

/// [310] Haus im Gelände: Durchdringungslinie Wand ∩ Gelände (die Wand reicht unter das Gelände, Höhe 0.1·x).
#[test]
fn durchdringungslinie_haus_gelaende() {
    let t = grid_terrain((-30.0, 30.0), (-30.0, 30.0), 12, 12);
    let mut p = parcel_project(t, serde_json::json!([{"x": -20.0, "y": -20.0}, {"x": 20.0, "y": -20.0}, {"x": 20.0, "y": 20.0}, {"x": -20.0, "y": 20.0}]), true);
    p.drawing_levels[0].base_elevation = Some(-1.0);
    let with = lines(&prims_of(&p, serde_json::json!({"view": "southeast"})));
    let mut q = p.clone();
    q.context = None;
    let without = lines(&prims_of(&q, serde_json::json!({"view": "southeast"})));
    // Über dem Gelände entsteht mindestens eine Linie, die es ohne Gelände nicht gibt (Fusslinie der Wände am Boden).
    let new_lines = with.iter().filter(|l| !without.iter().any(|m| (m.0[0] - l.0[0]).abs() < 1e-3 && (m.0[1] - l.0[1]).abs() < 1e-3 && (m.1[0] - l.1[0]).abs() < 1e-3 && (m.1[1] - l.1[1]).abs() < 1e-3)).count();
    assert!(new_lines >= 3, "Schnittlinie Haus/Gelände fehlt: {new_lines} neue Linien");
}
