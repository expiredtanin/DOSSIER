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
    let (prep, refs) = prepare(&p, &a.proj, &a.vis, false).unwrap().unwrap();
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
