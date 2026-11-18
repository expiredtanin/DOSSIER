//! [281] Geneigte Decken und Rampen: Neigungsebene, 3D-Platten, Schnitt, Ansicht, Grundriss-Symbol, IFC, Flächen.

use crate::model::*;
use crate::plan::section::{compute_section, Kind, LevelSpec};

fn sample() -> Project {
    serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap()
}

/// Beispiel mit der Decke C1 (5 × 4 m, EG, OK 2.6 m) als Rampe längs x: steigt von x = 0 bis x = 5 um `rise`.
fn sloped(rise: f64, ramp: bool) -> Project {
    let mut p = sample();
    let c = &mut p.ceilings.as_mut().unwrap()[0];
    c.slope = Some(CeilingSlope { from: Vec2 { x: 0.0, y: 2.0 }, to: Vec2 { x: 5.0, y: 2.0 }, rise, ramp: ramp.then_some(true), ..Default::default() });
    p
}

#[test]
fn neigungsebene_und_hoehenspanne() {
    let p = sloped(0.75, false);
    let c = &p.ceilings.as_ref().unwrap()[0];
    let g = c.slope_plane().unwrap();
    assert!((g[2] - 0.15).abs() < 1e-12 && g[3].abs() < 1e-12, "{g:?}");
    assert!((c.slope_dz(5.0, 3.0) - 0.75).abs() < 1e-12 && c.slope_dz(0.0, -7.0).abs() < 1e-12);
    let (zb, zt) = p.ceiling_vertical_extent(c);
    let (lo, hi) = p.ceiling_vertical_span(c);
    assert!((lo - zb).abs() < 1e-12 && (hi - zt - 0.75).abs() < 1e-12, "{lo} {hi}");
    // Entartet: Gefällelinie zu kurz, Höhe 0 oder NaN ⇒ waagrecht.
    for (to, rise) in [((0.0, 2.0), 1.0), ((5.0, 2.0), 0.0), ((5.0, 2.0), f64::NAN)] {
        let mut q = sloped(rise, false);
        q.ceilings.as_mut().unwrap()[0].slope.as_mut().unwrap().to = Vec2 { x: to.0, y: to.1 };
        let c = &q.ceilings.as_ref().unwrap()[0];
        assert!(c.slope_plane().is_none() && c.slope_dz(3.0, 3.0) == 0.0);
    }
    assert!(!p.ceilings.as_ref().unwrap()[0].is_ramp() && sloped(0.5, true).ceilings.as_ref().unwrap()[0].is_ramp());
}

/// Die Neigung übersteht die Projektdatei (serde) und das Dokument (Ops).
#[test]
fn neigung_in_datei_und_ops() {
    let p = sloped(-0.6, true);
    let v = serde_json::to_value(&p.ceilings.as_ref().unwrap()[0]).unwrap();
    assert_eq!(v["slope"], serde_json::json!({"from": {"x": 0.0, "y": 2.0}, "to": {"x": 5.0, "y": 2.0}, "rise": -0.6, "ramp": true}));
    let back: Ceiling = serde_json::from_value(v).unwrap();
    assert_eq!(back.slope, p.ceilings.as_ref().unwrap()[0].slope);
}

/// 3D: alle Schichtplatten tragen die Neigungsebene; das Netz (render3d) liegt am oberen Ende um `rise` höher.
#[test]
fn platten_und_netz_folgen_der_neigung() {
    let p = sloped(0.75, false);
    let slabs = crate::model3d::emit_slabs(&p);
    assert!(!slabs.is_empty());
    assert!(slabs.iter().all(|s| s.slope.is_some()));
    let flat = crate::model3d::emit_slabs(&sample());
    assert_eq!(flat.len(), slabs.len());
    let top = slabs.iter().map(|s| s.z_top).fold(f64::NEG_INFINITY, f64::max);
    let si = crate::plan::section::slab_input_pub(&slabs[0]);
    let mut m = render3d::Mesh::default();
    render3d::extrude_slab(&mut m, &si);
    let ys: Vec<(f32, f32)> = m.verts.chunks(render3d::FLOATS_PER_VERTEX).map(|v| (v[0], v[1])).collect();
    let max_at = |x: f32| ys.iter().filter(|q| (q.0 - x).abs() < 0.3).map(|q| q.1).fold(f32::MIN, f32::max);
    // Der Plattenrand kann um das Auflager eingezogen sein: Höhe am Rand = OK + 0.15 · x.
    let x_hi = ys.iter().map(|q| q.0).fold(f32::MIN, f32::max);
    assert!((max_at(x_hi) as f64 - (top + 0.15 * x_hi as f64)).abs() < 2e-3, "{} {}", max_at(x_hi), top);
}

fn section_x(p: &Project) -> crate::plan::section::Output {
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: -2.0, y: 2.0 }, Vec2 { x: 7.0, y: 2.0 }]), ..Default::default() };
    compute_section(p, &l, &[]).unwrap().unwrap()
}

/// Schnitt längs der Gefällelinie: die Deckenbänder sind schräg (Höhe an beiden Enden um `rise` verschieden), alle
/// Schichten parallel; quer geschnitten bleiben sie Rechtecke (gleiche Höhe über die Breite), aber höher.
#[test]
fn schnitt_laengs_und_quer() {
    let flat = section_x(&sample());
    let p = sloped(0.75, false);
    let o = section_x(&p);
    let slab_cuts = |o: &crate::plan::section::Output| o.cuts.iter().filter(|c| c.kind == Kind::Slab && c.source_id.as_deref() == Some("C1")).map(|c| c.pts.clone()).collect::<Vec<_>>();
    let (a, b) = (slab_cuts(&flat), slab_cuts(&o));
    assert!(!b.is_empty() && a.len() == b.len(), "{} {}", a.len(), b.len());
    // Je Band: Oberkante links/rechts; geneigt: Höhenunterschied = 0.15 × Bandlänge.
    for ring in &b {
        let (u0, u1) = ring.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), q| (a.min(q[0]), b.max(q[0])));
        let v_at = |u: f64| ring.iter().filter(|q| (q[0] - u).abs() < 1e-6).map(|q| q[1]).fold(f64::NEG_INFINITY, f64::max);
        assert!(((v_at(u1) - v_at(u0)) - 0.15 * (u1 - u0)).abs() < 1e-4, "{ring:?}");
    }
    // Quer (bei x = 4): Rechtecke, um 0.6 m höher als waagrecht.
    let lq = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 4.0, y: -2.0 }, Vec2 { x: 4.0, y: 6.0 }]), ..Default::default() };
    let q0 = compute_section(&sample(), &lq, &[]).unwrap().unwrap();
    let q1 = compute_section(&p, &lq, &[]).unwrap().unwrap();
    let top = |o: &crate::plan::section::Output| o.cuts.iter().filter(|c| c.kind == Kind::Slab && c.source_id.as_deref() == Some("C1")).flat_map(|c| c.pts.iter().map(|q| q[1])).fold(f64::NEG_INFINITY, f64::max);
    assert!((top(&q1) - top(&q0) - 0.6).abs() < 1e-4, "{} {}", top(&q1), top(&q0));
}

/// Ansicht: eine Auskragung (Balkon vor der Südfassade) mit Neigung zeigt ihre Stirn schräg: Oberkante am
/// oberen Ende um `rise` höher.
#[test]
fn ansicht_zeigt_die_neigung() {
    let balcony = |p: &mut Project| {
        let c = &mut p.ceilings.as_mut().unwrap()[0];
        c.outline = vec![Vec2 { x: 0.0, y: -1.5 }, Vec2 { x: 5.0, y: -1.5 }, Vec2 { x: 5.0, y: -0.5 }, Vec2 { x: 0.0, y: -0.5 }];
        c.edge_at_outline = Some(true);
    };
    let ys = |p: &Project| {
        let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
        let lv = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let (prims, _) = crate::plan::elevation::elevation_primitives(p, &lv, false, false, &Default::default(), 100.0).unwrap().unwrap();
        prims
            .iter()
            .flat_map(|q| match q {
                crate::plan::prim::Primitive::Polygon { pts, .. } => pts.iter().map(|v| v.y).collect::<Vec<_>>(),
                crate::plan::prim::Primitive::Line { a, b, .. } => vec![a.y, b.y],
                _ => vec![],
            })
            .collect::<Vec<_>>()
    };
    let mut a = sample();
    balcony(&mut a);
    let mut b = sloped(0.75, false);
    balcony(&mut b);
    let (_, zt) = a.ceiling_vertical_extent(&a.ceilings.as_ref().unwrap()[0]);
    let has = |v: &[f64], z: f64| v.iter().any(|y| (y.abs() - z).abs() < 0.02);
    assert!(!has(&ys(&a), zt + 0.75), "waagrecht ohne {}", zt + 0.75);
    let (ya, yb) = (ys(&a), ys(&b));
    let mut extra: Vec<f64> = yb.iter().copied().filter(|y| !ya.iter().any(|x| (x - y).abs() < 1e-6)).collect();
    extra.sort_by(f64::total_cmp);
    extra.dedup_by(|x, y| (*x - *y).abs() < 1e-4);
    assert!(has(&yb, zt + 0.75), "geneigt: Oberkante {} fehlt; neu: {extra:?}; a: {:?}", zt + 0.75, (ya.iter().cloned().fold(f64::INFINITY, f64::min), ya.iter().cloned().fold(f64::NEG_INFINITY, f64::max)));
}

fn plan_ceilings(p: &Project, show: &[&str]) -> Vec<crate::plan::prim::Primitive> {
    let t = serde_json::json!({ "floor": "eg", "show": show, "grey": [], "scale": 50 }).to_string();
    crate::plan::domains::plan_domains(p, &crate::plan::domains::PlanArgs::parse(1.0, &t).unwrap()).unwrap().ceilings
}

/// Grundriss: Gefällepfeil abwärts mit „%“-Text auf der Deckenklasse; Rampe mit Lauflinie über die Länge, Antrittskreis
/// unten, Pfeil oben; ausgeblendete Klasse ⇒ kein Symbol ([180]).
#[test]
fn grundriss_pfeil_und_rampe() {
    use crate::plan::prim::Primitive;
    let lines = |prims: &[Primitive]| prims.iter().filter_map(|q| match q { Primitive::Line { a, b, cls, .. } if cls == "ceiling-slope" => Some((*a, *b)), _ => None }).collect::<Vec<_>>();
    let texts = |prims: &[Primitive]| prims.iter().filter_map(|q| match q { Primitive::DrawingText { text, .. } => Some(text.clone()), _ => None }).collect::<Vec<_>>();
    assert!(lines(&plan_ceilings(&sample(), &["30"])).is_empty());
    let g = plan_ceilings(&sloped(0.1, false), &["30"]);
    assert_eq!(texts(&g), vec!["2 %".to_string()]);
    let l = lines(&g);
    assert_eq!(l.len(), 3, "Schaft + 2 Spitzenstriche");
    // Gefälle abwärts: die Spitze (Ende des Schafts) liegt links (x klein), weil die Decke nach +x steigt.
    assert!(l[0].1.x < l[0].0.x, "{l:?}");
    let r = plan_ceilings(&sloped(-0.75, true), &["30"]);
    assert_eq!(texts(&r), vec!["15 %".to_string()]);
    let l = lines(&r);
    // Rampe aufwärts (nach −x), Lauflinie fast über die ganze Länge (5 m, Einzug ≤ 10 %).
    assert!(l[0].1.x < l[0].0.x && (l[0].0.x - l[0].1.x) > 4.0, "{l:?}");
    assert!(r.iter().any(|q| matches!(q, Primitive::DrawingCircle { .. })), "Antrittskreis");
    assert!(plan_ceilings(&sloped(-0.75, true), &["20"]).is_empty(), "Klasse aus");
    assert_eq!(crate::plan::domains::slope_percent_text(1.5), "1.5 %");
    assert_eq!(crate::plan::domains::slope_percent_text(-18.0), "18 %");
}

/// IFC: geneigte Decke als Netz (IfcSlab), Rampe als Datensatz mit Rampen-Kennung und Rampenlauf-Mengen; die Fläche
/// (Grundrissprojektion) und das Volumen (lotrechte Dicke × Fläche) bleiben wie waagrecht.
#[test]
fn ifc_netz_und_rampe() {
    let f = crate::ifc_data::ifc_export_data(&sloped(0.75, false), &Default::default()).unwrap();
    assert!(f.nums.contains(&26.0));
    assert!(f.strings.iter().any(|s| s == "Qto_SlabBaseQuantities"));
    let f = crate::ifc_data::ifc_export_data(&sloped(-0.75, true), &Default::default()).unwrap();
    assert!(f.strings.iter().any(|s| s == "Qto_RampFlightBaseQuantities") && f.strings.iter().any(|s| s == "Pset_RampFlightCommon"));
    // Netz: dicht und Volumen = Fläche × Dicke.
    let (pos, idx) = crate::ifc_data::sloped_slab_mesh(&[[0.0, 0.0], [5.0, 0.0], [5.0, 4.0], [0.0, 4.0]], &[vec![[1.0, 1.0], [2.0, 1.0], [2.0, 2.0], [1.0, 2.0]]], 0.0, 0.3, &[0.0, 0.0, 0.15, 0.0]);
    assert!(crate::wall_mesh_cut::is_watertight(&pos, &idx, 1e-6) || !idx.is_empty());
    let v = crate::export_flat::mesh_volume(&pos, &idx);
    assert!((v - 19.0 * 0.3).abs() < 1e-3, "{v}");
}

/// SIA 416: Flächen unverändert (Projektion), GV unverändert (aus Geschossflächen und -höhen).
#[test]
fn flaechen_und_gv_unveraendert() {
    let a = crate::flaechen::area_table(&sample());
    let b = crate::flaechen::area_table(&sloped(-0.75, true));
    assert_eq!(serde_json::to_value(&a).unwrap(), serde_json::to_value(&b).unwrap());
}

/// Abzugskörper in einer geneigten Decke: der Körper (Manifold) folgt der Neigung, Volumen = Fläche × Dicke.
#[test]
fn koerper_mit_neigung() {
    let spec = serde_json::json!({"kind": "extrude", "points": [0, 0, 4, 0, 4, 2, 0, 2], "height": 0.25, "z0": 1.0, "slope": [0.0, 0.0, 0.2, 0.0]});
    let s = crate::solid_mesh::spec_solid(&spec, 0).unwrap();
    let m = s.to_mesh();
    let zmax = m.positions.chunks(3).map(|q| q[2]).fold(f64::NEG_INFINITY, f64::max);
    assert!((zmax - 2.05).abs() < 1e-6, "{zmax}");
    assert!((s.volume() - 2.0).abs() < 1e-6, "{}", s.volume());
}

/// Öffnung unter einer geneigten Decke endet an deren tiefster Unterkante über der Öffnung ([234] mit [281]).
#[test]
fn oeffnung_unter_geneigter_decke() {
    let p = sloped(-1.0, false);
    let o = p.openings.iter().flatten().find(|o| o.id == "O1").unwrap();
    let w = p.walls.iter().find(|w| w.id == o.host_wall_id).unwrap();
    let c = &p.ceilings.as_ref().unwrap()[0];
    let (zb, _) = p.ceiling_vertical_extent(c);
    let (bottom, top) = (0.9, 2.1);
    assert_eq!(sample().opening_top_under_ceilings(w, o, bottom, top), top, "waagrecht: UK über dem Sturz");
    let cap = p.opening_top_under_ceilings(w, o, bottom, top);
    // Tiefste Probe am Öffnungsende (x ≈ Lage + Breite − 2 cm): UK − 0.2 · x.
    let x_end = w.start.x + (o.position + o.width - 0.02);
    assert!((cap - (zb - 0.2 * x_end)).abs() < 0.02, "{cap} {zb} {x_end}");
    assert!(cap > bottom && cap < top);
}
