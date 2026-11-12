//! Tests zum Schnitt (`plan/section/`): Bänder, Stil, Dominanz, Primitive, Overrides, Abfrage.

use super::*;

fn sample() -> Project {
    serde_json::from_str(include_str!("../../../tests/fixtures/sample_project.json")).unwrap()
}

/// Beispiel mit ausdrücklich aussen bündigen Fenstern (ohne die [168]-Vorgabe bei Aussendämmung:
/// Rahmen in der Leibung, Dämmung überdeckt ihn).
fn sample_flush() -> Project {
    let mut p = sample();
    for t in p.window_types.iter_mut().flatten() {
        t.inset_face = Some(WindowTypeInsetFace::Aussen);
    }
    p
}

fn level(p: &Project, id: &str) -> LevelSpec {
    let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
    LevelSpec::from_json(&serde_json::to_value(l).unwrap())
}

#[test]
fn ebene_wie_section_plane_from_level() {
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: -1.0, y: 2.0 }, Vec2 { x: 6.0, y: 2.0 }]), ..Default::default() };
    let pl = l.plane().unwrap();
    assert_eq!(pl.point, [-1.0, 0.0, 2.0]);
    assert_eq!(pl.normal, [-0.0, 0.0, 1.0]);
    assert_eq!(pl.u_model(), (1.0, 0.0));
    let l0 = LevelSpec { line: Some([Vec2 { x: 1.0, y: 1.0 }, Vec2 { x: 1.0, y: 1.0 }]), ..Default::default() };
    assert!(l0.plane().is_none());
}

#[test]
fn json_zahlen_wie_frueher() {
    // JS schreibt die kürzeste Darstellung, serde_json (ohne float_roundtrip) liest Mantisse/10^k.
    assert_eq!(json_f32(2.6), 2.6f32);
    assert_eq!(json_f32(-0.0), 0.0f32);
    assert_eq!(json_f32(3.0), 3.0f32);
    assert_eq!(json_f32(1e-9), 1e-9f32);
    // Gleichstand der kürzesten Darstellung → gerade Ziffer (wie serde_json beim Schreiben).
    assert_eq!(js_f32(5.00390625f32), 5.0039062f64);
    // Schnellweg = Lesung (gerechnete Zahlen mit 16–17 Ziffern, Rundungsgrenzen)
    let mut x = 0.123456789f64;
    for i in 0..200_000 {
        x = (x * 1.6180339887 + 0.37).fract() * [1e-5, 0.3, 7.0, 123.0, 4567.0, 1e9][i % 6];
        let v = if i % 7 == 0 { -x } else { x };
        assert_eq!(json_f32(v).to_bits(), json_f32_read(v).to_bits(), "{v}");
        let mid = ((v as f32) as f64 + ((v as f32).next_up() as f64)) / 2.0;
        assert_eq!(json_f32(mid).to_bits(), json_f32_read(mid).to_bits(), "{mid}");
    }
}

/// [95] Schnitt quer durch die Tasche einer Taschen-Schiebetür: die Wandschichten fehlen dort über
/// die Türhöhe (7 cm × 2.0 m), ausserhalb der Tasche bleibt der Schnitt voll.
#[test]
fn schnitt_durch_die_tasche() {
    use crate::plan::walls::tests::pocket_project;
    let wall_area = |p: &Project, x: f64| {
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x, y: -1.0 }, Vec2 { x, y: 1.0 }]), ..Default::default() };
        let out = compute_section(p, &l, &[]).unwrap().unwrap();
        out.cuts
            .iter()
            .filter(|c| c.kind == Kind::Wall)
            .map(|c| {
                let n = c.pts.len();
                (0..n).map(|i| c.pts[i][0] * c.pts[(i + 1) % n][1] - c.pts[(i + 1) % n][0] * c.pts[i][1]).sum::<f64>().abs() / 2.0
            })
            .sum::<f64>()
    };
    let p = pocket_project(DoorTypeKind::Tasche, Some(OpeningHinge::End), 1.0);
    let full = wall_area(&p, 3.5);
    assert!((full - 0.16 * 2.6).abs() < 1e-4, "{full}");
    assert!((full - wall_area(&p, 2.4) - 0.07 * 2.0).abs() < 1e-4);
    // Gegenseite (Anschlag, x = 0.5) ohne Tasche.
    assert!((full - wall_area(&p, 0.5)).abs() < 1e-4);
}

/// [G1] Abzugskörper beliebiger Form (Netz, hier dreieckiges Prisma quer durch die Wand): seine
/// Schnittfläche wird aus der Wand-Poché ausgespart; er selbst erscheint weder als Schnittfläche
/// noch in der Projektion.
#[test]
fn abzugskoerper_beliebiger_form_im_schnitt() {
    use crate::plan::walls::tests::pocket_project;
    let mut p = pocket_project(DoorTypeKind::Tasche, Some(OpeningHinge::End), 1.0);
    // Profil/Verjüngung nur, damit es kein senkrechtes Prisma ist (das ginge über `section_rects`).
    let pts = vec![Vec2 { x: 3.2, y: -1.0 }, Vec2 { x: 3.8, y: -1.0 }, Vec2 { x: 3.8, y: 1.0 }, Vec2 { x: 3.2, y: 1.0 }];
    p.extruded_solids = Some(vec![ExtrudedSolid { id: "v".into(), level_id: "eg".into(), points: pts, height: 1.0, base_offset: Some(1.0), taper: Some(0.5), operation: Some("subtract".into()), ..Default::default() }]);
    // Dreieckiges Prisma längs x: Querschnitt (y, z) = (−1, 1), (1, 1), (0, 2).
    let tri = [[-1.0, 1.0], [1.0, 1.0], [0.0, 2.0]];
    let mut positions = Vec::new();
    for x in [3.2, 3.8] {
        for q in tri {
            positions.extend([x, q[0], q[1]]);
        }
    }
    let indices: Vec<f64> = [0, 2, 1, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5].iter().map(|&i| i as f64).collect();
    let body = BodyMesh { index: 0, positions, indices };
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 3.5, y: -1.0 }, Vec2 { x: 3.5, y: 1.0 }]), ..Default::default() };
    let area = |c: &Cut| {
        let n = c.pts.len();
        (0..n).map(|i| c.pts[i][0] * c.pts[(i + 1) % n][1] - c.pts[(i + 1) % n][0] * c.pts[i][1]).sum::<f64>().abs() / 2.0
    };
    let full: f64 = compute_section(&p, &l, &[]).unwrap().unwrap().cuts.iter().filter(|c| c.kind == Kind::Wall).map(area).sum();
    let out = compute_section(&p, &l, std::slice::from_ref(&body)).unwrap().unwrap();
    let cut: f64 = out.cuts.iter().filter(|c| c.kind == Kind::Wall).map(area).sum();
    // Wand 16 cm mittig auf y = 0: ∫ min(0.16, 2·(2 − z)) dz über 1…2 = 0.16·0.92 + 0.08².
    assert!((full - cut - (0.16 * 0.92 + 0.0064)).abs() < 1e-5, "{full} {cut}");
    assert!(out.cuts.iter().all(|c| c.kind != Kind::Body));
    // Keine Kante des Abzugskörpers in der Projektion (Prisma-Enden bei x = 3.8 liegen hinter der Ebene).
    let apex = |q: [f64; 2]| (q[0] - 1.0).abs() < 1e-6 && (q[1] - 2.0).abs() < 1e-6;
    assert!(!out.visible.iter().chain(&out.hidden).any(|e| apex(e.a) || apex(e.b)));
}

/// [G1] Freier Körper mit Bauteil (`componentId`): seine Schnittfläche trägt Füllung und Schraffur des
/// Bauteils (SIA), ohne Bauteil die neutrale Körper-Füllung.
#[test]
fn koerper_mit_bauteil_im_schnitt() {
    let mut p = sample();
    let comp = p.components.iter().find(|k| p.hatch(&k.hatch_id).is_some_and(|h| h.pattern != HatchPattern::None && h.pattern != HatchPattern::Solid)).unwrap().clone();
    let sq = vec![Vec2 { x: 20.0, y: 0.0 }, Vec2 { x: 22.0, y: 0.0 }, Vec2 { x: 22.0, y: 2.0 }, Vec2 { x: 20.0, y: 2.0 }];
    p.extruded_solids = Some(vec![ExtrudedSolid { id: "k".into(), level_id: "eg".into(), category_code: "20".into(), points: sq, height: 1.0, ..Default::default() }]);
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 19.0, y: 1.0 }, Vec2 { x: 23.0, y: 1.0 }]), ..Default::default() };
    let body = |p: &Project| {
        let out = compute_section(p, &l, &crate::solid_mesh::body_meshes(p)).unwrap().unwrap();
        out.cuts.into_iter().find(|c| c.kind == Kind::Body).expect("Körper geschnitten")
    };
    let c = body(&p);
    assert_eq!(c.fill.as_deref(), Some(BODY_FILL));
    assert!(c.hatch.is_none() && c.component_id.is_none());
    p.extruded_solids.as_mut().unwrap()[0].component_id = Some(comp.id.clone());
    let c = body(&p);
    assert_eq!(c.hatch.as_ref().map(|h| h.pattern), p.hatch(&comp.hatch_id).map(|h| h.pattern));
    assert_eq!(c.component_id.as_deref(), Some(comp.id.as_str()));
}

/// [157] Wangentreppe hinter der Schnittebene (von vorn gesehen): neben den Tritten die Wangen (Ansichtskante
/// aussen an der Treppe, bis zur Austrittshöhe) und der Handlauf beidseitig — vorher schwebten die Tritte
/// als „graue Streifen“ ohne Wange und Geländer.
#[test]
fn wangentreppe_hinter_dem_schnitt_mit_wange_und_handlauf() {
    let mut p = sample();
    p.walls.clear();
    p.ceilings = Some(vec![]);
    p.openings = None;
    let st = &mut p.stairs.as_mut().unwrap()[0];
    st.type_id = Some("stair-wange-holz".into());
    let ty = p.stair_types.as_mut().unwrap().iter_mut().find(|t| t.id == "stair-wange-holz").unwrap();
    ty.railing = Some(StairTypeRailing::Beide);
    // Ebene vor dem Antritt (y = 0.2), Blick nach +y; u = x + 1. Treppe x 3.2 … 4.2 ⇒ u 4.2 … 5.2.
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: -1.0, y: 0.2 }, Vec2 { x: 8.0, y: 0.2 }]), ..Default::default() };
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let top = |at: f64| out.visible.iter().filter(|e| (e.a[0] - at).abs() < 1e-6 && (e.b[0] - at).abs() < 1e-6).map(|e| e.a[1].max(e.b[1])).fold(f64::NEG_INFINITY, f64::max);
    // Wangen 5 cm aussen an den Tritten, Oberkante 5 cm über dem Austritt (2.6).
    assert!((top(4.15) - 2.65).abs() < 1e-6 && (top(5.25) - 2.65).abs() < 1e-6, "{} {}", top(4.15), top(5.25));
    // Handlauf 0.9 m über dem obersten Tritt.
    let high = out.visible.iter().filter(|e| e.a[0] > 4.1 && e.a[0] < 5.3 && e.a[1].max(e.b[1]) > 3.3).count();
    assert!(high > 0, "Handlauf fehlt");
}

/// [157] Gekrümmte Platten-Seiten (Treppenloch rund, Bogen-Rand) hinter der Schnittebene ohne senkrechte
/// Facettenfugen: nur die Silhouetten links und rechts.
#[test]
fn runde_platte_ohne_facettenfugen() {
    let mut p = sample();
    p.walls.clear();
    p.stairs = Some(vec![]);
    let c = &mut p.ceilings.as_mut().unwrap()[0];
    c.outline = (0..32).map(|k| {
        let a = std::f64::consts::TAU * k as f64 / 32.0;
        Vec2 { x: 2.0 + 1.5 * a.cos(), y: 4.0 + 1.5 * a.sin() }
    }).collect();
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: -1.0, y: 1.0 }, Vec2 { x: 8.0, y: 1.0 }]), ..Default::default() };
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let vertical: Vec<f64> = out.visible.iter().filter(|e| e.kind == Kind::Slab && (e.a[0] - e.b[0]).abs() < 1e-9).map(|e| e.a[0]).collect();
    // Silhouetten bei u = 3 − 1.5 und 3 + 1.5 (Ecken bei 0° und 180°); keine Fugen dazwischen.
    assert!(vertical.iter().all(|u| (u - 1.5).abs() < 1e-6 || (u - 4.5).abs() < 1e-6), "{vertical:?}");
}

/// [G1] Treppenuntersicht: gerade Betontreppe längs geschnitten — die Laufplatte unten als gerade
/// Linie (exakt, aus dem Laufplatten-Netz), nicht mehr als Sägezahn aus 1.5-cm-Scheiben.
#[test]
fn treppenuntersicht_exakt() {
    let p = sample();
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 3.2, y: -1.0 }, Vec2 { x: 3.2, y: 5.0 }]), ..Default::default() };
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let st: Vec<&Cut> = out.cuts.iter().filter(|c| c.stair_id.as_deref() == Some("ST1")).collect();
    assert_eq!(st.len(), 1, "{:?}", out.cuts.iter().map(|c| (c.kind, c.index, c.stair_id.clone(), c.pts.len())).collect::<Vec<_>>());
    let pts = &st[0].pts;
    // ST1: Lauf 3.2 m ab y = 0.4, Steigung 2.6 m, 15 Stufen ⇒ Laufplatte 0.208 m senkrecht.
    let soffit = |u: f64| (((u - 1.4) / 3.2) * 2.6 - 0.208).max(0.0);
    assert!(pts.iter().all(|q| q[1] >= soffit(q[0]) - 1e-6), "{pts:?}");
    assert!(pts.iter().filter(|q| q[1] > 0.1 && (q[1] - soffit(q[0])).abs() < 1e-6).count() >= 2, "{pts:?}");
    assert!(pts.len() < 2 * 15 + 10, "{pts:?}");
}

/// [151] U-Betontreppe längs durch Lauf 1 geschnitten: Laufplatte exakt UND die Podestplatte im Schnitt.
#[test]
fn u_treppe_lauf_und_podest_im_schnitt() {
    let mut p = sample();
    let st = &mut p.stairs.as_mut().unwrap()[0];
    st.shape = StairShape::U;
    st.start = Vec2 { x: 3.15, y: 0.35 };
    st.dir = Vec2 { x: 0.0, y: 1.0 };
    st.run_length = 2.0;
    st.run2_length = Some(2.0);
    st.turn = Some(-1.0);
    st.gap = Some(0.1);
    st.landing_length = Some(0.9);
    st.width = 0.9;
    st.step_count = 15.0;
    st.total_rise = Some(2.6);
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 3.15, y: -1.0 }, Vec2 { x: 3.15, y: 5.0 }]), ..Default::default() };
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let pts: Vec<[f64; 2]> = out.cuts.iter().filter(|c| c.stair_id.as_deref() == Some("ST1")).flat_map(|c| c.pts.clone()).collect();
    // Podest: y 2.35 … 3.25 (u = y + 1), Oberkante 8 Steigungen
    let top = 8.0 * 2.6 / 15.0;
    assert!(pts.iter().any(|q| (q[0] - 4.25).abs() < 1e-6 && (q[1] - top).abs() < 1e-6), "{pts:?}");
    // Lauf 1 ab y = 0.35 (u = 1.35) bis zum Podest
    assert!(pts.iter().any(|q| (q[0] - 1.35).abs() < 1e-6), "{pts:?}");
}

/// [95][T2] Schnitt durch die Tasche in der Bogenwand (radial) und unter schräger Oberkante.
#[test]
fn schnitt_durch_die_tasche_bogen_und_dach() {
    use crate::plan::walls::tests::{pocket_project_with, POCKET_BULGE};
    let wall_area = |p: &Project, a: Vec2, b: Vec2| {
        let l = LevelSpec { kind: "section".into(), line: Some([a, b]), ..Default::default() };
        let out = compute_section(p, &l, &[]).unwrap().unwrap();
        out.cuts
            .iter()
            .filter(|c| c.kind == Kind::Wall)
            .map(|c| {
                let n = c.pts.len();
                (0..n).map(|i| c.pts[i][0] * c.pts[(i + 1) % n][1] - c.pts[(i + 1) % n][0] * c.pts[i][1]).sum::<f64>().abs() / 2.0
            })
            .sum::<f64>()
    };
    let arc = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(0.0, 0.0), kernel2d::Vec2::new(4.0, 0.0), Some(POCKET_BULGE)).unwrap();
    let radial = |s: f64| {
        let (c, n) = (arc.point(s, 0.0), arc.normal(s));
        (Vec2 { x: c.x - n.x, y: c.y - n.y }, Vec2 { x: c.x + n.x, y: c.y + n.y })
    };
    let flat = |x: f64| (Vec2 { x, y: -1.0 }, Vec2 { x, y: 1.0 });
    for (bulge, roof) in [(Some(POCKET_BULGE), false), (None, true)] {
        let line = |s: f64| if bulge.is_some() { radial(s) } else { flat(s) };
        let full = pocket_project_with(DoorTypeKind::Schiebe, None, 1.0, bulge, roof);
        let p = pocket_project_with(DoorTypeKind::Tasche, None, 1.0, bulge, roof);
        for (s, k) in [(0.5, 0.07 * 2.0), (3.5, 0.0)] {
            let (a, b) = line(s);
            let (fa, pa) = (wall_area(&full, a, b), wall_area(&p, a, b));
            assert!(fa > 0.3, "{bulge:?} {roof} {fa}");
            assert!((fa - pa - k).abs() < 1e-3, "{bulge:?} {roof} s={s}: {fa} {pa}");
        }
    }
}

/// [140] Dünne Schichten (Parkett, Putz) im Schnitt ab 1:100 in der Nachbarschicht, 1:50 alle; der
/// Umriss der Fläche bleibt gleich (nur die Fuge entfällt).
#[test]
fn duenne_schnittschichten_je_massstab_zusammengefasst() {
    let rect = |v0: f64, v1: f64| vec![[0.0, v1], [5.0, v1], [5.0, v0], [0.0, v0]];
    let mk = |v0: f64, v1: f64, fill: &str| {
        let mut c = Cut::new(Kind::Slab, 0, rect(v0, v1));
        c.fill = Some(fill.into());
        c.source_id = Some("D1".into());
        c
    };
    // Parkett 1 cm, Unterlagsboden 8 cm, Trittschall 2 cm, Beton 22 cm, Putz 1 cm
    let cuts = vec![mk(0.32, 0.33, "#a"), mk(0.24, 0.32, "#b"), mk(0.22, 0.24, "#c"), mk(0.0, 0.22, "#d"), mk(-0.01, 0.0, "#e")];
    assert_eq!(merge_thin_cuts(&cuts, 20.0).len(), 5, "1:20: alle Schichten");
    assert_eq!(merge_thin_cuts(&cuts, 50.0).len(), 2, "1:50 (Teil 5): dünne Schichten zusammengefasst");
    let m = merge_thin_cuts(&cuts, 100.0);
    assert_eq!(m.len(), 2, "{:?}", m.iter().map(|c| (c.fill.clone(), ring_bbox(&c.pts))).collect::<Vec<_>>());
    let total: f64 = m.iter().map(|c| ring_area(&c.pts)).sum();
    assert!((total - 5.0 * 0.34).abs() < 1e-4, "{total}");
    let b = m.iter().find(|c| c.fill.as_deref() == Some("#b")).unwrap();
    let bb = ring_bbox(&b.pts);
    assert!((bb[1] - 0.24).abs() < 1e-5 && (bb[3] - 0.33).abs() < 1e-5, "Parkett geht im Unterlagsboden auf: {bb:?}");
    let d = m.iter().find(|c| c.fill.as_deref() == Some("#d")).unwrap();
    let bd = ring_bbox(&d.pts);
    assert!((bd[1] + 0.01).abs() < 1e-5 && (bd[3] - 0.24).abs() < 1e-5, "Putz und Trittschall im Beton: {bd:?}");
    // Trittschall 2 cm = 0.2 mm bei 1:100 → dünn, gleich lange Kanten: zur dickeren Nachbarschicht (Beton).
    assert!(m.iter().all(|c| c.fill.as_deref() != Some("#c")));
    // Anderes Bauteil verschmilzt nicht.
    let mut other = cuts.clone();
    other[0].source_id = Some("D2".into());
    assert!(merge_thin_cuts(&other, 100.0).iter().any(|c| c.fill.as_deref() == Some("#a")));
    // [140] Teil 5: Trittschall 4 cm (0.4 mm Papier) geht in 1:100 auf, Unterlagsboden 6.5 cm bleibt.
    let cuts = vec![mk(0.30, 0.315, "#a"), mk(0.235, 0.30, "#b"), mk(0.195, 0.235, "#c"), mk(0.0, 0.195, "#d")];
    let m = merge_thin_cuts(&cuts, 100.0);
    assert_eq!(m.len(), 2);
    assert!(m.iter().all(|c| c.fill.as_deref() != Some("#c") && c.fill.as_deref() != Some("#a")));
    assert_eq!(merge_thin_cuts(&cuts, 50.0).len(), 3, "1:50: Trittschall (0.8 mm) bleibt, Parkett nicht");
    assert_eq!(merge_thin_cuts(&cuts, 20.0).len(), 4);
}

/// [140] Teil 6: Unterbau-Schichten (Kies, Magerbeton, Erdreich) bleiben im Schnitt 1:100 schraffiert mit
/// Fuge; die Bodenplatte darüber schwarz. Erkannt am Bauteil (`loose_fill_components`) oder an der Schraffur.
#[test]
fn unterbau_im_schnitt_1_100_nicht_schwarz() {
    let rect = |v0: f64, v1: f64| vec![[0.0, v1], [5.0, v1], [5.0, v0], [0.0, v0]];
    let cut = |comp: &str, v0: f64, v1: f64, pattern: HatchPattern| {
        let mut c = Cut::new(Kind::Slab, 0, rect(v0, v1));
        c.component_id = Some(comp.into());
        c.source_id = Some("c-bodenplatte".into());
        c.hatch = Some(HatchRender { pattern, ..section_hatch() });
        c.fill = Some(HATCH_PAPER.into());
        c
    };
    let out = Output {
        cuts: vec![cut("std-c-stahlbeton", -0.25, 0.0, HatchPattern::Diagonal), cut("mager", -0.3, -0.25, HatchPattern::Diagonal), cut("std-c-kies", -0.4, -0.3, HatchPattern::Gravel)],
        ..Default::default()
    };
    let loose: HashSet<String> = ["mager".to_string()].into();
    let fills = |scale: f64, loose: &HashSet<String>| -> Vec<(String, HatchPattern, String)> {
        let (prims, _) = section_primitives_at(&out, true, false, &Visibility::default(), scale, Detail::Mittel, false, &CutRules { loose: loose.clone(), ..Default::default() });
        prims.iter().filter_map(|q| match q { Primitive::Polygon { fill, hatch, stroke, ceiling_id: Some(_), .. } => Some((fill.clone(), hatch.pattern, stroke.clone())), _ => None }).collect()
    };
    let f = fills(100.0, &loose);
    assert_eq!(f[0], (HATCH_INK.to_string(), HatchPattern::None, "none".to_string()), "Platte schwarz");
    assert_eq!(f[1].1, HatchPattern::Diagonal, "Magerbeton (Bauteil) schraffiert");
    assert_ne!(f[1].0, HATCH_INK);
    assert_eq!(f[2].1, HatchPattern::Gravel, "Kies (Schraffur) schraffiert");
    assert_ne!(f[2].2, "none", "mit Fuge");
    // Ohne Bauteil-Liste: nur die Kies-Schraffur erkannt.
    let f = fills(100.0, &HashSet::new());
    assert_eq!(f[1].0, HATCH_INK);
    assert_eq!(f[2].1, HatchPattern::Gravel);
    // Musterhaus komplex: die Kies-Schicht der Bodenplatte ist ein loses Bauteil.
    let p = sample();
    assert!(loose_fill_components(&p).iter().all(|id| p.components.iter().any(|c| &c.id == id && crate::standards::is_loose_fill(c))));
}

/// [140] Teil 5: Schnitt 1:100 — geschnittene Flächen schwarz ohne Fuge/Schraffur, Umriss bleibt;
/// 1:50, „fein" und `cutHatch` mit Schraffur und Fugen.
#[test]
fn schnittflaechen_schwarz_ab_1_100() {
    let p = sample();
    let l = level(&p, "schnitt-a");
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let vis = Visibility::default();
    let stat = |scale: f64, detail: Detail, cut_hatch: bool| {
        let (prims, _) = section_primitives_at(&out, true, false, &vis, scale, detail, cut_hatch, &CutRules::of(&p, &out, RuleView::at(scale, None)));
        let cuts: Vec<_> = prims.iter().filter_map(|q| match q { Primitive::Polygon { fill, hatch, stroke, wall_id, ceiling_id, .. } if wall_id.is_some() || ceiling_id.is_some() => Some((fill.clone(), hatch.pattern, stroke.clone())), _ => None }).collect();
        let outline = prims.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "section-cut-outline")).count();
        (cuts, outline)
    };
    let (c, o) = stat(100.0, Detail::Mittel, false);
    assert!(!c.is_empty() && o > 0);
    assert!(c.iter().all(|(f, h, s)| f == HATCH_INK && *h == HatchPattern::None && s == "none"), "{c:?}");
    for (scale, detail, ch) in [(50.0, Detail::Mittel, false), (100.0, Detail::Fein, false), (100.0, Detail::Mittel, true)] {
        let (c, _) = stat(scale, detail, ch);
        assert!(c.iter().any(|(f, h, s)| f != HATCH_INK && *h != HatchPattern::None && s != "none"), "{scale} {detail:?} {ch}");
    }
}

/// [33] „Deckenaufbau weiss“ (Standardregel, über eine Ansichtsvorlage eingeschaltet): im Schnitt 1:100 sind
/// Unterlagsboden und Dämmung über der Betondecke EINE weisse Fläche ohne Schraffur mit Umriss, die Decke
/// selbst und die Wände bleiben schwarz; 1:50 ebenso weiss statt schraffiert. Ohne Regel (oder Regel aus)
/// unverändert. Eine Regel nach Baustoff-Kategorie mit Schraffur „material“ zeigt die Schraffur auch ab 1:100.
#[test]
fn override_deckenaufbau_weiss() {
    let mut p = sample();
    let l = level(&p, "schnitt-a");
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let vis = Visibility::default();
    let slab = |p: &Project, scale: f64| {
        let (prims, _) = section_primitives_at(&out, true, false, &vis, scale, Detail::Mittel, false, &CutRules::of(p, &out, RuleView::at(scale, None)));
        prims.iter().filter_map(|q| match q { Primitive::Polygon { fill, hatch, stroke, ceiling_id: Some(_), .. } => Some((fill.clone(), hatch.pattern, stroke.clone())), _ => None }).collect::<Vec<_>>()
    };
    let before = slab(&p, 100.0);
    // Estrich-Stücke (Dämmung liegt jeweils darunter, gleich breit oder fehlt am Wandanschluss) und Beton.
    let n = |comp: &str| out.cuts.iter().filter(|c| c.kind == Kind::Slab && c.component_id.as_deref() == Some(comp)).count();
    let (screed, insulation, concrete) = (n("screed"), n("insulation"), n("concrete"));
    assert!(screed >= insulation && insulation > 0 && concrete > 0);
    assert_eq!(before.len(), screed + insulation + concrete);
    assert!(before.iter().all(|(f, _, s)| f == HATCH_INK && s == "none"));
    // Standardregel geladen, aber aus: nichts ändert sich.
    p.override_rules = Some(crate::standards::override_rules().into_iter().map(|v| serde_json::from_value(v).unwrap()).collect());
    assert_eq!(slab(&p, 100.0), before);
    assert!(cut_overrides(&p, &out.cuts, RuleView::at(100.0, None)).is_empty());
    p.override_rules.as_mut().unwrap()[0].enabled = true;
    let after = slab(&p, 100.0);
    let white: Vec<_> = after.iter().filter(|(f, _, _)| f == "#ffffff").collect();
    assert_eq!(white.len(), screed, "Estrich + Dämmung je Stück als eine Fläche: {after:?}");
    assert!(white.iter().all(|w| (w.1, w.2.as_str()) == (HatchPattern::None, SECTION_INK)));
    assert_eq!(after.iter().filter(|(f, _, s)| f == HATCH_INK && s == "none").count(), concrete, "Betondecke bleibt schwarz");
    // Massstab-Kriterium der Standardregel: erst ab 1:100 — im 1:50 bleibt der Aufbau schraffiert.
    let at50 = slab(&p, 50.0);
    assert!(at50.iter().all(|(f, _, _)| f != "#ffffff"), "1:50 ohne Regel: {at50:?}");
    p.override_rules.as_mut().unwrap()[0].min_scale = None;
    let at50 = slab(&p, 50.0);
    assert_eq!(at50.iter().filter(|(f, h, _)| f == "#ffffff" && *h == HatchPattern::None).count(), screed);
    assert!(at50.iter().any(|(f, h, _)| f != "#ffffff" && *h != HatchPattern::None), "Beton 1:50 schraffiert");
    // Wände unberührt (Regel gilt nur für Decken).
    let walls = |p: &Project| {
        let (prims, _) = section_primitives_at(&out, true, false, &vis, 100.0, Detail::Mittel, false, &CutRules::of(p, &out, RuleView::at(100.0, None)));
        prims.iter().filter(|q| matches!(q, Primitive::Polygon { wall_id: Some(_), fill, .. } if fill != HATCH_INK)).count()
    };
    assert_eq!(walls(&p), 0);
    // Baustoff-Kategorie „insulation“ mit Materialschraffur: Dämmung der Wände auch 1:100 schraffiert.
    let mut r: OverrideRule = serde_json::from_value(serde_json::json!({"id": "d", "name": "Dämmung", "enabled": true,
        "condition": {"type": "material_category", "operator": "equals", "value": "insulation"}, "actions": {"hatch": "material"}})).unwrap();
    p.override_rules = Some(vec![r.clone()]);
    assert!(walls(&p) > 0);
    r.enabled = false;
    p.override_rules = Some(vec![r]);
    assert_eq!(walls(&p), 0);
}

/// [140] Trittschall 4 cm: 1:100 (0.4 mm Papier) ohne Zickzack, 1:50 mit; dicke Dämmung bleibt.
#[test]
fn duenne_daemmung_ohne_muster_ab_1_100() {
    let rect = |v0: f64, v1: f64| vec![[0.0, v1], [5.0, v1], [5.0, v0], [0.0, v0]];
    let mk = |v0: f64, v1: f64, pattern: HatchPattern| {
        let mut c = Cut::new(Kind::Slab, 0, rect(v0, v1));
        c.hatch = Some(HatchRender { pattern, ..section_hatch() });
        c
    };
    let cuts = vec![mk(0.0, 0.04, HatchPattern::Insulation), mk(0.1, 0.26, HatchPattern::Insulation), mk(0.3, 0.33, HatchPattern::InsulationHard), mk(0.4, 0.43, HatchPattern::Diagonal)];
    let pat = |cs: &[Cut]| cs.iter().map(|c| c.hatch.as_ref().unwrap().pattern).collect::<Vec<_>>();
    use HatchPattern as P;
    assert_eq!(pat(&plain_thin_insulation(cuts.clone(), 50.0)), [P::Insulation, P::Insulation, P::InsulationHard, P::Diagonal], "1:50 alle Muster");
    assert_eq!(pat(&plain_thin_insulation(cuts.clone(), 100.0)), [P::None, P::Insulation, P::None, P::Diagonal], "1:100");
    assert_eq!(pat(&plain_thin_insulation(cuts, 0.0)), [P::Insulation, P::Insulation, P::InsulationHard, P::Diagonal]);
}

#[test]
fn beispiel_schnitt_mit_pick_ids() {
    let p = sample();
    let l = level(&p, "schnitt-a");
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let (prims, b) = section_primitives(&out, false, false, &Visibility::default());
    let json = serde_json::to_string(&prims).unwrap();
    assert!(json.contains("\"wallId\":\"W2\"") && json.contains("\"roofId\":\"RF1\""), "{json}");
    assert!(json.contains("section-ground"));
    assert!(b[2] > b[0] && b[3] > b[1]);
    // Kategorie ausgeblendet → keine Dach-Schnittflächen mehr.
    let vis = Visibility { has_vis: true, invisible: ["31".to_string()].into_iter().collect(), ..Default::default() };
    let (hidden, _) = section_primitives(&out, false, false, &vis);
    assert!(!serde_json::to_string(&hidden).unwrap().contains("\"roofId\""));
}

/// [94] Sturz, Fensterbänke und Storenkasten im Sturz erscheinen im Schnitt nur, wenn gesetzt.
#[test]
fn sturz_baenke_und_storenkasten_im_schnitt() {
    let mut p = sample();
    // Schnittlinie quer durch die Mitte von O1 (Wand W1).
    let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
    let w1 = p.walls.iter().find(|w| w.id == o1.host_wall_id).unwrap().clone();
    let (u, n) = axis_frame(&w1);
    let m = o1.position + o1.width / 2.0;
    let c = (w1.start.x + u.0 * m, w1.start.y + u.1 * m);
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.0 - n.0 * 3.0, y: c.1 - n.1 * 3.0 }, Vec2 { x: c.0 + n.0 * 3.0, y: c.1 + n.1 * 3.0 }]), ..Default::default() };
    let vis = Visibility::default();
    let base = section_opening_primitives(&p, &l, &vis).unwrap();
    assert!(!base.is_empty());
    let typed = p.openings.as_deref().unwrap_or(&[]).iter().filter(|o| o.type_id.is_some()).count();
    assert!(typed > 0);
    for t in p.window_types.iter_mut().flatten() {
        t.lintel_height = Some(0.2);
        t.sill_board = Some(WindowTypeSillBoard::Beide);
        t.shading = Some(WindowShading { create: true, kind: WindowShadingKind::Raffstore, r#box: WindowShadingBox { width: 0.0, height: 0.3, depth: 0.18, ..Default::default() }, mount: Some(WindowShadingMount::Sturz), ..Default::default() });
    }
    for t in p.door_types.iter_mut().flatten() {
        t.lintel_height = Some(0.2);
    }
    let more = section_opening_primitives(&p, &l, &vis).unwrap();
    assert!(more.len() > base.len(), "{} {}", more.len(), base.len());
    let json = serde_json::to_string(&more).unwrap();
    assert!(json.contains(LINTEL_FILL) && json.contains(SHADING_PACK_FILL), "{json}");
}

/// [94] Anschlag im Schnitt: Die Schichten vor dem Rahmen (Aussenputz, Dämmung) reichen am Sturz um die
/// Anschlagtiefe unter die Öffnungs-OK (Sturz-Nase) und an der Brüstung darüber — als Teil des Schicht-
/// Bands (ein Umriss, keine Fuge), nicht als eigenes Öffnungs-Stück. Ohne Anschlag bleibt das Loch glatt.
#[test]
fn anschlag_im_schnitt_sturz_nase_und_bruestung() {
    let mut p = sample_flush();
    let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
    let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap().clone();
    let (u, n) = axis_frame(&w1);
    let m = o1.position + o1.width / 2.0;
    let c = (w1.start.x + u.0 * m, w1.start.y + u.1 * m);
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.0 - n.0 * 3.0, y: c.1 - n.1 * 3.0 }, Vec2 { x: c.0 + n.0 * 3.0, y: c.1 + n.1 * 3.0 }]), ..Default::default() };
    let (zb, zt) = opening_extent(&p, &w1, &o1);
    // (Sturz-UK, Brüstungs-OK, Anzahl Bänder über der Öffnung) einer Schicht.
    let edges = |p: &Project, comp: &str| -> (f64, f64, usize) {
        let out = compute_section(p, &l, &[]).unwrap().unwrap();
        let mine: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1") && c.component_id.as_deref() == Some(comp)).collect();
        let above: Vec<&&Cut> = mine.iter().filter(|c| c.pts.iter().all(|q| q[1] > zb + 0.3)).collect();
        let head = above.iter().flat_map(|c| c.pts.iter().map(|q| q[1])).fold(f64::INFINITY, f64::min);
        let sill = mine.iter().flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y < zt - 0.3).fold(f64::NEG_INFINITY, f64::max);
        (head, sill, above.len())
    };
    // Ohne Anschlag (Rahmen aussen bündig): glattes Loch durch alle Schichten.
    let mut count = HashMap::new();
    for comp in ["render-ext", "insulation", "brick"] {
        let (h, s, k) = edges(&p, comp);
        assert!((h - zt).abs() < 1e-6 && (s - zb).abs() < 1e-6, "{comp}: {h} {s}");
        count.insert(comp, k);
    }
    // Rahmen 18 cm hinter der Aussenfläche (hinter der Dämmung), Anschlag 5 cm.
    for t in p.window_types.iter_mut().flatten() {
        t.inset_face = Some(WindowTypeInsetFace::Aussen);
        t.inset_from_face = Some(0.18);
        t.rebate_depth = Some(0.05);
    }
    for comp in ["render-ext", "insulation"] {
        let (h, s, k) = edges(&p, comp);
        assert!((h - (zt - 0.05)).abs() < 1e-6, "{comp}: Sturz-Nase {h} vs {}", zt - 0.05);
        assert!((s - (zb + 0.05)).abs() < 1e-6, "{comp}: Brüstung {s} vs {}", zb + 0.05);
        assert_eq!(k, count[comp], "{comp}: Nase gehört zum Band (keine Fuge)");
    }
    // Mauerwerk hinter dem Rahmen: unverändert.
    let (h, s, _) = edges(&p, "brick");
    assert!((h - zt).abs() < 1e-6 && (s - zb).abs() < 1e-6, "brick: {h} {s}");
    // Überdämmt [106] innerhalb der Nase: kein doppeltes Stück; darüber hinaus Teil desselben Umrisses.
    let reveal = |a: f64| vec![crate::model::LayerReveal { layer: 1.0, mode: crate::model::RevealMode::Ueberdaemmt, amount: Some(a), ..Default::default() }];
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.layer_reveals = Some(reveal(0.03));
    }
    let (h, _, k) = edges(&p, "insulation");
    assert!((h - (zt - 0.05)).abs() < 1e-6 && k == count["insulation"], "{h} {k}");
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.layer_reveals = Some(reveal(0.08));
    }
    let (h, _, k) = edges(&p, "insulation");
    assert!((h - (zt - 0.08)).abs() < 1e-6 && k == count["insulation"], "{h} {k}");
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.layer_reveals = None;
    }
    // Anschlag unten eigens (Rahmen-Detail): Brüstung 2 cm, Sturz bleibt 5 cm.
    for t in p.window_types.iter_mut().flatten() {
        t.frame_detail = Some(crate::model::FrameDetail { rebates: Some(crate::model::OpeningSides { bottom: Some(0.02), ..Default::default() }), ..Default::default() });
    }
    let (h, s, _) = edges(&p, "render-ext");
    assert!((h - (zt - 0.05)).abs() < 1e-6 && (s - (zb + 0.02)).abs() < 1e-6, "{h} {s}");
    // Die Nase ist kein eigenes Öffnungs-Stück mehr (sonst doppelt).
    let with = section_opening_primitives(&p, &l, &Visibility::default()).unwrap().len();
    for t in p.window_types.iter_mut().flatten() {
        t.frame_detail = None;
        t.rebate_depth = Some(0.0);
    }
    let without = section_opening_primitives(&p, &l, &Visibility::default()).unwrap().len();
    assert_eq!(with, without);
    // [168] Ohne Anschlag (keine Nase): der Schichteinzug (Dämmung überdämmt 3 cm) ist trotzdem Teil des
    // Schicht-Bands — eine Fläche, kein eigens umrandetes Stück unter dem Sturz.
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.layer_reveals = Some(reveal(0.03));
    }
    let (h, s, k) = edges(&p, "insulation");
    assert!((h - (zt - 0.03)).abs() < 1e-6 && (s - (zb + 0.03)).abs() < 1e-6, "{h} {s}");
    assert_eq!(k, count["insulation"], "Einzug gehört zum Band");
}

/// [184] Grob (Fenster nur als Strich): Sturz-Unterkante und Brüstungs-Oberkante des Wandschnitts sind flach —
/// kein Anschlag, keine Nase, kein Schichteinzug. Fein (ohne `flat_openings`) bleibt wie bisher.
#[test]
fn grob_wandschnitt_an_oeffnung_flach() {
    let mut p = sample_flush();
    let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
    let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap().clone();
    let (u, n) = axis_frame(&w1);
    let m = o1.position + o1.width / 2.0;
    let c = (w1.start.x + u.0 * m, w1.start.y + u.1 * m);
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.0 - n.0 * 3.0, y: c.1 - n.1 * 3.0 }, Vec2 { x: c.0 + n.0 * 3.0, y: c.1 + n.1 * 3.0 }]), ..Default::default() };
    let (zb, zt) = opening_extent(&p, &w1, &o1);
    // Anschlag 5 cm und Überdämmung 3 cm: im Fein-Schnitt Nase bzw. Einzug.
    for t in p.window_types.iter_mut().flatten() {
        t.inset_face = Some(WindowTypeInsetFace::Aussen);
        t.inset_from_face = Some(0.18);
        t.rebate_depth = Some(0.05);
    }
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.layer_reveals = Some(vec![crate::model::LayerReveal { layer: 1.0, mode: crate::model::RevealMode::Ueberdaemmt, amount: Some(0.03), ..Default::default() }]);
    }
    // Alle Wandschnitt-Kanten in der Öffnungshöhe: nur zb und zt (keine Stufe dazwischen).
    let ys = |vis: &Visibility| -> Vec<f64> {
        let out = compute_section_vis(&p, &l, &[], vis).unwrap().unwrap();
        let mut ys: Vec<f64> = out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1")).flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y > zb - 0.1 && *y < zt + 0.1).collect();
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
        ys.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
        ys
    };
    let fine = ys(&Visibility::default());
    assert!(fine.iter().any(|y| (y - (zt - 0.05)).abs() < 1e-6) && fine.iter().any(|y| (y - (zb + 0.05)).abs() < 1e-6), "fein: Anschlag {fine:?}");
    let flat = Visibility { flat_openings: ["O1".to_string()].into(), ..Default::default() };
    let rough = ys(&flat);
    assert!(rough.iter().all(|y| (y - zb).abs() < 1e-6 || (y - zt).abs() < 1e-6), "grob: keine Stufe {rough:?}");
    assert!(rough.iter().any(|y| (y - zb).abs() < 1e-6) && rough.iter().any(|y| (y - zt).abs() < 1e-6), "{rough:?}");
}

/// [G3] Rundbogen-Fenster: an der Schnittstelle reicht die Wand bis an den Bogen, Rahmen/Glas folgen.
#[test]
fn rundbogen_im_schnitt() {
    let mut p = sample_flush();
    let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
    let w1 = p.walls.iter().find(|w| w.id == o1.host_wall_id).unwrap().clone();
    let (u, n) = axis_frame(&w1);
    // Viertel der Breite: Bogen 0,5 m Radius, Kämpfer 0,7 m über der Brüstung.
    let m = o1.position + o1.width / 4.0;
    let c = (w1.start.x + u.0 * m, w1.start.y + u.1 * m);
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.0 - n.0 * 3.0, y: c.1 - n.1 * 3.0 }, Vec2 { x: c.0 + n.0 * 3.0, y: c.1 + n.1 * 3.0 }]), ..Default::default() };
    let (zb, zt) = opening_extent(&p, &w1, &o1);
    let top_of = |p: &Project| -> f64 {
        let out = compute_section(p, &l, &[]).unwrap().unwrap();
        out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1")).flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y > zb + 0.1).fold(f64::INFINITY, f64::min)
    };
    assert!((top_of(&p) - zt).abs() < 1e-3, "Rechteck: Sturz bei {zt}");
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.shape = Some(OpeningShape::Rundbogen);
    }
    let want = zb + 0.7 + (0.25f64 - 0.0625).sqrt();
    assert!((top_of(&p) - want).abs() < 5e-3, "{} vs {want}", top_of(&p));
    let prims = section_opening_primitives(&p, &l, &Visibility::default()).unwrap();
    let ys: Vec<f64> = prims.iter().filter_map(|pr| if let Primitive::Polygon { pts, opening_id: Some(id), .. } = pr { (id == "O1").then(|| pts.iter().map(|q| q.y).fold(f64::NEG_INFINITY, f64::max)) } else { None }).collect();
    assert!(!ys.is_empty() && ys.iter().all(|y| *y < want + 5e-3), "kein Sturz/Kasten über dem Bogen: {ys:?}");
}

/// [171] Rundfenster, Schnitt genau am Rand seines Rechtecks (Musterhaus komplex, Schnitt B-B im DG): die Wand
/// ist dort ganz (Sehne 0), statt eines leeren Rechteck-Lochs ohne Fenster.
#[test]
fn rundfenster_schnitt_am_rand_ohne_loch() {
    let mut p = sample_flush();
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.shape = Some(OpeningShape::Rund);
        o.height = o.width;
    }
    let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
    let w1 = p.walls.iter().find(|w| w.id == o1.host_wall_id).unwrap().clone();
    let (u, n) = axis_frame(&w1);
    let (zb, zt) = opening_extent(&p, &w1, &o1);
    for m in [o1.position, o1.position + o1.width, o1.position + 1e-5] {
        let c = (w1.start.x + u.0 * m, w1.start.y + u.1 * m);
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.0 - n.0 * 3.0, y: c.1 - n.1 * 3.0 }, Vec2 { x: c.0 + n.0 * 3.0, y: c.1 + n.1 * 3.0 }]), ..Default::default() };
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        let mut iv: Vec<(f64, f64)> = out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1")).map(|c| c.pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), q| (l.min(q[1]), h.max(q[1])))).collect();
        iv.sort_by(|a, b| a.0.total_cmp(&b.0));
        // Die Wandbänder decken die ganze Fensterhöhe ohne Lücke.
        let mut reach = zb;
        for (lo, hi) in &iv {
            if *lo <= reach + 1e-3 {
                reach = reach.max(*hi);
            }
        }
        assert!(reach >= zt, "Wand bei {m}: Lücke über {reach} ({zb}..{zt}) {iv:?}");
    }
}

/// [171] Innenwand des EG ohne Wand darüber (einfaches Musterhaus, W9): sie endet unter der tragenden Platte und
/// sticht nicht durch Trittschalldämmung und Unterlagsboden des OG.
#[test]
fn wand_von_unten_sticht_nicht_durch_den_bodenaufbau() {
    let p = sample();
    let out = compute_section(&p, &level(&p, "schnitt-a"), &[]).unwrap().unwrap();
    let w9_top = out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W9")).flat_map(|c| c.pts.iter().map(|q| q[1])).fold(f64::NEG_INFINITY, f64::max);
    let slab_bottom = out.cuts.iter().filter(|c| c.kind == Kind::Slab && c.component_id.as_deref() == Some("concrete")).flat_map(|c| c.pts.iter().map(|q| q[1])).fold(f64::INFINITY, f64::min);
    assert!(w9_top.is_finite() && slab_bottom.is_finite());
    assert!(w9_top <= slab_bottom + 1e-6, "W9 bis {w9_top}, Platte ab {slab_bottom}");
    // Der Bodenaufbau über W9 bleibt durchgehend (ein Band je Schicht über die Wand hinweg).
    let (u0, u1) = out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W9")).flat_map(|c| c.pts.iter().map(|q| q[0])).fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), x| (l.min(x), h.max(x)));
    let over = out.cuts.iter().filter(|c| c.kind == Kind::Slab && c.component_id.as_deref() == Some("screed")).any(|c| {
        let (l, h) = c.pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), q| (l.min(q[0]), h.max(q[0])));
        l < u0 - 0.01 && h > u1 + 0.01
    });
    assert!(over, "Unterlagsboden ohne Unterbruch über W9");
}

/// [T2]/[G3]/[106] Bogenwand: Rundbogen-Fenster im Schnitt (Wand bis an den Bogen) und Schichteinzug
/// am Sturz (Sehne zwischen den Laibungen).
#[test]
fn rundbogen_und_einzug_in_bogenwand() {
    let mut p = sample_flush();
    p.walls.iter_mut().find(|w| w.id == "W1").unwrap().bulge = Some(-0.3);
    let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
    let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap().clone();
    let a = crate::wall_arc::WallArc::of_wall(&w1).unwrap();
    let m = o1.position + o1.width / 4.0;
    let (c, n) = (a.point(m, 0.0), a.normal(m));
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.x - n.x * 3.0, y: c.y - n.y * 3.0 }, Vec2 { x: c.x + n.x * 3.0, y: c.y + n.y * 3.0 }]), ..Default::default() };
    let (zb, zt) = opening_extent(&p, &w1, &o1);
    let top_of = |p: &Project| -> f64 {
        let out = compute_section(p, &l, &[]).unwrap().unwrap();
        out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1")).flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y > zb + 0.1).fold(f64::INFINITY, f64::min)
    };
    assert!((top_of(&p) - zt).abs() < 1e-3, "Rechteck: Sturz bei {zt}");
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.shape = Some(OpeningShape::Rundbogen);
    }
    let want = zb + 0.7 + (0.25f64 - 0.0625).sqrt();
    assert!((top_of(&p) - want).abs() < 1e-2, "{} vs {want}", top_of(&p));
    // Schichteinzug: innerste Schicht springt am Sturz 5 cm zurück.
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.shape = None;
        o.layer_reveals = Some(vec![crate::model::LayerReveal { layer: -1.0, mode: crate::model::RevealMode::Zurueck, amount: Some(0.05), ..Default::default() }]);
    }
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let inner_top = out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1") && c.component_id.as_deref() == Some("render-int")).flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y > zb + 0.1).fold(f64::INFINITY, f64::min);
    assert!((inner_top - (zt + 0.05)).abs() < 1e-3, "Innenputz am Sturz zurück: {inner_top} vs {}", zt + 0.05);
}

/// [106]/[G3] Schnitt quer durch einen Rundbogen nahe der Leibung: der zurückspringende Innenputz
/// folgt dem um 5 cm versetzten Bogen (senkrecht zum Umriss, nicht 5 cm lotrecht über dem Bogen).
#[test]
fn rundbogen_schichteinzug_folgt_dem_bogen() {
    let mut p = sample();
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.shape = Some(OpeningShape::Rundbogen);
        o.layer_reveals = Some(vec![crate::model::LayerReveal { layer: -1.0, mode: crate::model::RevealMode::Zurueck, amount: Some(0.05), ..Default::default() }]);
    }
    let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
    let w1 = p.walls.iter().find(|w| w.id == o1.host_wall_id).unwrap().clone();
    let (from, to) = opening_interval(&w1, &o1).unwrap();
    let (zb, zt) = opening_extent(&p, &w1, &o1);
    let (u, n) = axis_frame(&w1);
    let at = from + 0.1;
    let c = (w1.start.x + u.0 * at, w1.start.y + u.1 * at);
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.0 - n.0 * 3.0, y: c.1 - n.1 * 3.0 }, Vec2 { x: c.0 + n.0 * 3.0, y: c.1 + n.1 * 3.0 }]), ..Default::default() };
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let low = |comp: Option<&str>| out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some(w1.id.as_str()) && (comp.is_none() || c.component_id.as_deref() == comp)).flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y > zb + 0.1).fold(f64::INFINITY, f64::min);
    let (r, spring) = ((to - from) / 2.0, zt - (to - from) / 2.0);
    let dx = r - 0.1;
    let arch = spring + (r * r - dx * dx).sqrt();
    assert!((low(None) - arch).abs() < 5e-3, "Wand bis an den Bogen: {} vs {arch}", low(None));
    let want = spring + ((r + 0.05) * (r + 0.05) - dx * dx).sqrt();
    let inner = low(Some("render-int"));
    assert!((inner - want).abs() < 5e-3, "Innenputz am versetzten Bogen: {inner} vs {want} (lotrecht wäre {})", arch + 0.05);
    // Innenputz in die Leibung (2 cm): das Stück hängt unter dem Bogen, senkrecht zum Umriss gemessen.
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.layer_reveals = Some(vec![crate::model::LayerReveal { layer: -1.0, mode: crate::model::RevealMode::Leibung, amount: Some(0.02), ..Default::default() }]);
    }
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let lowest = out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some(w1.id.as_str())).flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y > zb + 0.1).fold(f64::INFINITY, f64::min);
    let want = spring + ((r - 0.02) * (r - 0.02) - dx * dx).sqrt();
    assert!((lowest - want).abs() < 5e-3, "Leibungsstück am Bogen: {lowest} vs {want} (lotrecht wäre {})", arch - 0.02);
}

/// [G3] Projektion hinter der Schnittebene: Rundfenster zeigt den Umriss statt des Rechteck-Lochs.
#[test]
fn formoeffnung_in_der_projektion() {
    let mut p = sample();
    let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
    let w1 = p.walls.iter().find(|w| w.id == o1.host_wall_id).unwrap().clone();
    let (u, n) = axis_frame(&w1);
    let edges_of = |p: &Project, sign: f64| -> usize {
        let (a, b) = ((w1.start.x + n.0 * sign * 1.5, w1.start.y + n.1 * sign * 1.5), (w1.end.x + n.0 * sign * 1.5, w1.end.y + n.1 * sign * 1.5));
        let mut best = 0;
        for (s, e) in [(a, b), (b, a)] {
            let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: s.0 - u.0, y: s.1 - u.1 }, Vec2 { x: e.0 + u.0, y: e.1 + u.1 }]), ..Default::default() };
            let out = compute_section(p, &l, &[]).unwrap().unwrap();
            let (zb, zt) = opening_extent(p, &w1, &o1);
            best = best.max(out.visible.iter().filter(|e| e.kind == Kind::Wall && e.a[1] > zb + 0.01 && e.a[1] < zt - 0.01 && e.b[1] > zb + 0.01 && e.b[1] < zt - 0.01).count());
        }
        best
    };
    let rect = edges_of(&p, 1.0).max(edges_of(&p, -1.0));
    for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
        o.shape = Some(OpeningShape::Rund);
    }
    let round = edges_of(&p, 1.0).max(edges_of(&p, -1.0));
    assert!(round >= rect + 20, "Umriss als Kantenzug: {rect} → {round}");
}

/// [103] Dachfenster: Lücke in allen Dachschichten, Rahmen/Glas geschnitten.
#[test]
fn dachfenster_im_schnitt() {
    let mut p = sample();
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 2.5, y: -2.0 }, Vec2 { x: 2.5, y: 6.0 }]), ..Default::default() };
    let roof_cuts = |p: &Project| compute_section(p, &l, &[]).unwrap().unwrap().cuts.iter().filter(|c| c.kind == Kind::Roof).count();
    let before = roof_cuts(&p);
    assert!(before > 0);
    p.openings.as_mut().unwrap().push(Opening {
        id: "DF".into(),
        kind: ElementKind::Window,
        category_code: "21".into(),
        width: 0.78,
        height: 1.18,
        host_roof_id: Some("RF1".into()),
        host_point: Some(Vec2 { x: 2.5, y: 1.0 }),
        ..Default::default()
    });
    assert!(roof_cuts(&p) > before, "Schichten links und rechts des Fensters");
    let prims = section_opening_primitives(&p, &l, &Visibility::default()).unwrap();
    let df: Vec<_> = prims.iter().filter(|pr| matches!(pr, Primitive::Polygon { opening_id: Some(id), .. } if id == "DF")).collect();
    assert!(df.len() >= 4, "Rahmen beidseits, Glas, Eindeckrahmen: {}", df.len());
}

/// [T2] Schräger Schnitt durch eine Bogenwand: je Durchstoss genau ein Band je Schicht (auch wenn die
/// Ebene eine Stossfuge der Sehnen-Teilkörper quert), Schichtfolge vollständig.
#[test]
fn bogenwand_im_schnitt_je_schicht_ein_band() {
    let mut p = sample();
    p.walls.retain(|w| w.id == "W1");
    p.openings = Some(vec![]);
    p.ceilings = Some(vec![]);
    p.roofs = Some(vec![]);
    p.stairs = Some(vec![]);
    p.walls[0].bulge = Some(-1.0); // Halbkreis nach Süden, Mitte (2.5, 0), r 2.5
    for l in p.drawing_levels.iter_mut().filter(|l| l.id == "schnitt-a") {
        l.line_points = Some([Vec2 { x: -1.0, y: -1.5 }, Vec2 { x: 6.0, y: -1.5 }]);
    }
    let out = compute_section(&p, &level(&p, "schnitt-a"), &[]).unwrap().unwrap();
    let walls: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Wall).collect();
    assert_eq!(walls.len(), 8, "2 Durchstösse × 4 Schichten: {:#?}", walls.iter().map(|c| (bbox(&c.pts), c.component_id.clone())).collect::<Vec<_>>());
    let mut us: Vec<[f64; 4]> = walls.iter().map(|c| bbox(&c.pts)).collect();
    us.sort_by(|a, b| cmp_num(a[0] - b[0]));
    // Lückenlos je Durchstoss.
    for k in [0usize, 4] {
        for i in k..k + 3 {
            assert!((us[i][1] - us[i + 1][0]).abs() < 1e-6, "{us:?}");
        }
    }
    // Hinter der Ebene keine Facetten-Fugen der Sehnen-Teilkörper (nur Umriss).
    let seams = out.visible.iter().chain(&out.hidden).filter(|e| e.kind == Kind::Wall && (e.a[0] - e.b[0]).abs() < 1e-4).count();
    assert!(seams <= 4, "senkrechte Kanten: {seams}");
}

/// [G4] Projektion exakt: Dach hinter der Ebene sichtbar, keine Kante im Inneren einer Schnittfläche
/// (die Schnittflächen verdecken), Fenster der Rückwand als Umriss ohne die Stossfugen der
/// Wandstücke darunter, verdeckte Kanten nur mit `hiddenLines`.
#[test]
fn projektion_exakt_sichtbar() {
    let p = sample();
    let mut l = level(&p, "schnitt-a");
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    assert!(out.visible.iter().any(|e| e.kind == Kind::Roof), "Dach hinter der Ebene fehlt");
    assert!(out.hidden.is_empty());
    let inside = |c: &Cut, q: [f64; 2]| {
        let b = bbox(&c.pts);
        q[0] > b[0] + 1e-3 && q[0] < b[1] - 1e-3 && q[1] > b[2] + 1e-3 && q[1] < b[3] - 1e-3
    };
    for e in &out.visible {
        let m = [(e.a[0] + e.b[0]) / 2.0, (e.a[1] + e.b[1]) / 2.0];
        assert!(!out.cuts.iter().filter(|c| c.pts.len() == 4).any(|c| inside(c, m)), "Kante in einer Schnittfläche: {e:?}");
    }
    l.hidden_lines = true;
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    assert!(!out.hidden.is_empty());
    let (prims, _) = section_primitives(&out, false, true, &Visibility::default());
    assert!(serde_json::to_string(&prims).unwrap().contains("section-hidden"));
}

/// [157] Verdeckte Kanten liegen hinter der Schnittebene: die Schnittflächen decken sie zu (vorher lagen
/// dunkle Strichlinien auf den schwarzen Wänden 1:100, Musterhaus komplex Schnitt A-A Aussenwand).
#[test]
fn verdeckte_kanten_unter_den_schnittflaechen() {
    let p = sample();
    let mut l = level(&p, "schnitt-a");
    l.hidden_lines = true;
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    for scale in [50.0, 100.0] {
        let (prims, _) = section_primitives_at(&out, true, true, &Visibility::default(), scale, Detail::Mittel, false, &CutRules::default());
        let first_cut = prims.iter().position(|q| matches!(q, Primitive::Polygon { fill, .. } if fill != "none")).expect("Schnittfläche");
        let hidden: Vec<usize> = prims.iter().enumerate().filter(|(_, q)| matches!(q, Primitive::Line { cls, .. } if cls == "section-hidden")).map(|(i, _)| i).collect();
        assert!(!hidden.is_empty());
        assert!(hidden.iter().all(|&i| i < first_cut), "1:{scale}: verdeckte Kante über einer Schnittfläche");
    }
}

/// [T6]/[68] Gelände mit Baugrube: gestaltetes + gewachsenes Terrain, Erdreich ohne Gebäude-Inneres;
/// Fassaden-Geländehöhen fürs Baurecht.
#[test]
fn gelaende_mit_baugrube_im_schnitt() {
    let mut p = sample();
    let flat = TerrainMesh {
        id: "t".into(),
        positions: vec![-50.0, -50.0, 0.0, 50.0, -50.0, 0.0, 50.0, 50.0, 0.0, -50.0, 50.0, 0.0],
        indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
        category_code: "02".into(),
        ..Default::default()
    };
    let pit = Excavation {
        id: "bg".into(),
        outline: vec![Vec2 { x: -1.0, y: -1.0 }, Vec2 { x: 6.0, y: -1.0 }, Vec2 { x: 6.0, y: 5.0 }, Vec2 { x: -1.0, y: 5.0 }],
        bottom: -2.0,
        ..Default::default()
    };
    p.context = Some(vec![ContextObject::TerrainMesh(flat), ContextObject::Excavation(pit)]);
    let out = compute_section(&p, &level(&p, "schnitt-a"), &[]).unwrap().unwrap();
    assert!(out.profiles.iter().any(|pr| pr.natural) && out.profiles.iter().any(|pr| !pr.natural));
    let designed_min = out.profiles.iter().filter(|pr| !pr.natural).flat_map(|pr| pr.pts.iter().map(|q| q[1])).fold(f64::INFINITY, f64::min);
    assert!((designed_min + 2.0).abs() < 1e-6, "{designed_min}");
    assert!(!out.earth.is_empty());
    let (prims, _) = section_primitives(&out, false, false, &Visibility::default());
    // [137] Das Erdreich-Band und die Geländefläche der Ansicht wählen das Gelände.
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { hatch, context_object_id: Some(id), .. } if hatch.pattern == HatchPattern::Earth && id == "t")));
    assert!(prims.iter().any(|q| matches!(q, Primitive::Line { cls, dash: Some(Some(_)), .. } if cls == "section-terrain")));
    let (ep, _) = super::super::elevation::elevation_primitives(&p, &level(&p, "ansicht-sued"), false, false, &Visibility::default(), 100.0).unwrap().unwrap();
    let sil: Vec<f64> = ep.iter().filter_map(|q| if let Primitive::Line { cls, a, b, .. } = q { (cls == "elevation-terrain").then_some(a.y.min(b.y)) } else { None }).collect();
    // Die Ansichtslinie (y = −2) liegt in der Böschung: die Silhouette taucht vor dem Gebäude ein, nie unter die Sohle.
    assert!(!sil.is_empty() && sil.iter().all(|z| *z <= 1e-6 && *z >= -2.0 - 1e-6) && sil.iter().any(|z| *z < -0.5), "{sil:?}");
    assert!(ep.iter().any(|q| matches!(q, Primitive::Polygon { fill, context_object_id: Some(id), .. } if fill == "#ffffff" && id == "t")));
    assert!(!ep.iter().any(|q| matches!(q, Primitive::Line { cls, .. } if cls == "elevation-ground")));
    let f = crate::site_rules::facade_terrain(&p);
    assert!(!f.is_empty() && f.iter().all(|q| q.natural == Some(0.0) && q.designed.is_some_and(|z| (z + 2.0).abs() < 1e-6)));
}

/// [68] Verbau im Schnitt: verbaute Kanten werden zu geschnittenen Wänden mit Dicke und Schraffur der Verbauart,
/// das Erdreich-Band spart sie aus; Klasse der Baugrube steuert die Sichtbarkeit.
#[test]
fn verbauwand_im_schnitt() {
    let mut p = sample();
    let flat = TerrainMesh {
        id: "t".into(),
        positions: vec![-50.0, -50.0, 0.0, 50.0, -50.0, 0.0, 50.0, 50.0, 0.0, -50.0, 50.0, 0.0],
        indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
        category_code: "02".into(),
        ..Default::default()
    };
    let pit = Excavation {
        id: "bg".into(),
        category_code: "07".into(),
        outline: vec![Vec2 { x: -1.0, y: -1.0 }, Vec2 { x: 6.0, y: -1.0 }, Vec2 { x: 6.0, y: 5.0 }, Vec2 { x: -1.0, y: 5.0 }],
        bottom: -2.0,
        edge_shoring: Some(vec![true; 4]),
        shoring_kind: Some("borePile".into()),
        shoring_thickness: Some(0.5),
        ..Default::default()
    };
    p.context = Some(vec![ContextObject::TerrainMesh(flat), ContextObject::Excavation(pit)]);
    let out = compute_section(&p, &level(&p, "schnitt-a"), &[]).unwrap().unwrap();
    assert!(!out.shoring.is_empty(), "Verbauwand geschnitten");
    for w in &out.shoring {
        let zs: Vec<f64> = w.ring.iter().map(|q| q[1]).collect();
        let (lo, hi) = (zs.iter().cloned().fold(f64::INFINITY, f64::min), zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
        assert!((lo + 3.0).abs() < 1e-6 && hi.abs() < 1e-6, "Sohle −2 minus Einbindung 1, Oberkante Gelände 0: {lo} {hi}");
        assert!(w.ring[1][0] - w.ring[0][0] >= 0.5 - 1e-6, "mindestens die Wanddicke");
        assert_eq!(w.category, "07");
    }
    let (prims, _) = section_primitives(&out, false, false, &Visibility::default());
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { hatch, context_object_id: Some(id), .. } if id == "bg" && hatch.pattern != HatchPattern::None)));
    // Das Erdreich-Band lässt die Wand aus.
    let wall_area: f64 = out.shoring.iter().map(|w| (w.ring[1][0] - w.ring[0][0]) * (w.ring[3][1] - w.ring[0][1])).sum();
    assert!(wall_area > 1.0);
    // Klasse aus: keine Wand.
    let vis = Visibility { has_vis: true, invisible: ["07".to_string()].into_iter().collect(), ..Default::default() };
    let (prims2, _) = section_primitives(&out, false, false, &vis);
    assert!(!prims2.iter().any(|q| matches!(q, Primitive::Polygon { context_object_id: Some(id), .. } if id == "bg")));
    // Ohne die Wand kein Loch im Erdreich-Band: die Fläche wächst um (mindestens) die Wandfläche.
    let earth_area = |pr: &[Primitive]| -> f64 {
        pr.iter()
            .filter_map(|q| match q {
                Primitive::Polygon { pts, hatch, .. } if hatch.pattern == HatchPattern::Earth => Some((0..pts.len()).map(|i| pts[i].x * pts[(i + 1) % pts.len()].y - pts[(i + 1) % pts.len()].x * pts[i].y).sum::<f64>().abs() / 2.0),
                _ => None,
            })
            .sum()
    };
    assert!(earth_area(&prims2) > earth_area(&prims) + 0.5, "{} {} {wall_area}", earth_area(&prims2), earth_area(&prims));
}

/// [68] Verbau in der Ansicht: Wandflächen der Baugrube (Pick = Baugrube), Klasse steuert sie.
#[test]
fn verbauwand_in_der_ansicht() {
    let (p, _) = shoring_site();
    let lv = level(&p, "ansicht-sued");
    let run = |vis: &Visibility| super::super::elevation::elevation_primitives(&p, &lv, false, false, vis, 100.0).unwrap().unwrap().0;
    let has = |ep: &[Primitive]| ep.iter().any(|q| matches!(q, Primitive::Polygon { context_object_id: Some(id), .. } if id == "bg"));
    assert!(has(&run(&Visibility::default())), "Verbau in der Ansicht");
    let vis = Visibility { has_vis: true, invisible: ["07".to_string()].into_iter().collect(), ..Default::default() };
    assert!(!has(&run(&vis)), "Klasse aus: kein Verbau");
}

fn shoring_site() -> (Project, Excavation) {
    let mut p = sample();
    let flat = TerrainMesh {
        id: "t".into(),
        positions: vec![-50.0, -50.0, 0.0, 50.0, -50.0, 0.0, 50.0, 50.0, 0.0, -50.0, 50.0, 0.0],
        indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
        category_code: "02".into(),
        ..Default::default()
    };
    let pit = Excavation {
        id: "bg".into(),
        category_code: "07".into(),
        outline: vec![Vec2 { x: -1.0, y: -1.0 }, Vec2 { x: 6.0, y: -1.0 }, Vec2 { x: 6.0, y: 5.0 }, Vec2 { x: -1.0, y: 5.0 }],
        bottom: -2.0,
        edge_shoring: Some(vec![true; 4]),
        ..Default::default()
    };
    p.context = Some(vec![ContextObject::TerrainMesh(flat), ContextObject::Excavation(pit.clone())]);
    (p, pit)
}

/// [191] Verbau an einer Bogenkante: der Schnitt quer durch den Halbkreis trifft das gekrümmte Band zweimal — zwei
/// schmale Wandstücke (je etwa die Wanddicke), nicht ein Stück vom ersten bis zum letzten Durchgang.
#[test]
fn verbau_an_bogenkante_im_schnitt() {
    let (mut p, mut pit) = shoring_site();
    pit.outline_bulge = Some(vec![0.0, -1.0, 0.0, 0.0]);
    pit.edge_shoring = Some(vec![false, true, false, false]);
    let flat = p.context.as_ref().unwrap()[0].clone();
    p.context = Some(vec![flat, ContextObject::Excavation(pit)]);
    p.drawing_levels.push(serde_json::from_value(serde_json::json!({ "id": "s-bogen", "name": "Schnitt C", "kind": "section", "visible": true, "locked": false,
        "linePoints": [{ "x": 7.5, "y": -3.0 }, { "x": 7.5, "y": 7.0 }], "directionSign": 1 })).unwrap());
    let out = compute_section(&p, &level(&p, "s-bogen"), &[]).unwrap().unwrap();
    assert_eq!(out.shoring.len(), 2, "{:?}", out.shoring.iter().map(|w| w.ring.clone()).collect::<Vec<_>>());
    for w in &out.shoring {
        let width = w.ring[1][0] - w.ring[0][0];
        // Wanddicke 0.2 m schräg geschnitten: 0.2 / cos(30°) ≈ 0.23 m.
        assert!(width > 0.2 - 1e-6 && width < 0.26, "{width}");
    }
}

/// [68] Einbindetiefe als Feld: `shoringEmbed` ersetzt die Vorgabe von 1 m.
#[test]
fn verbauwand_einbindetiefe_feld() {
    let mut p = sample();
    let flat = TerrainMesh {
        id: "t".into(),
        positions: vec![-50.0, -50.0, 0.0, 50.0, -50.0, 0.0, 50.0, 50.0, 0.0, -50.0, 50.0, 0.0],
        indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
        category_code: "02".into(),
        ..Default::default()
    };
    let pit = Excavation {
        id: "bg".into(),
        outline: vec![Vec2 { x: -1.0, y: -1.0 }, Vec2 { x: 6.0, y: -1.0 }, Vec2 { x: 6.0, y: 5.0 }, Vec2 { x: -1.0, y: 5.0 }],
        bottom: -2.0,
        edge_shoring: Some(vec![true; 4]),
        shoring_embed: Some(2.5),
        ..Default::default()
    };
    p.context = Some(vec![ContextObject::TerrainMesh(flat), ContextObject::Excavation(pit)]);
    let out = compute_section(&p, &level(&p, "schnitt-a"), &[]).unwrap().unwrap();
    assert!(!out.shoring.is_empty());
    for w in &out.shoring {
        let lo = w.ring.iter().map(|q| q[1]).fold(f64::INFINITY, f64::min);
        assert!((lo + 4.5).abs() < 1e-6, "{lo}");
    }
}

fn ov_rule(conds: serde_json::Value, actions: serde_json::Value) -> OverrideRule {
    let c = conds.as_array().unwrap();
    serde_json::from_value(serde_json::json!({"id": "r", "name": "r", "enabled": true, "condition": c[0], "conditions": c[1..].to_vec(), "actions": actions})).unwrap()
}

/// [33] „Ausblenden“ im Schnitt: Wände samt Öffnungen weg (auch nicht im Schnitt-Cache vom Lauf ohne Regel),
/// Decken bleiben; Gelände über Regeln (ausblenden, Linie, Füllung); Linienstil einer Schicht-Regel als
/// gestrichelte Fugen.
#[test]
fn ausblenden_gelaende_und_linienstil_im_schnitt() {
    let mut p = sample();
    p.context = Some(vec![ContextObject::TerrainMesh(TerrainMesh {
        id: "t".into(),
        name: "Gelände".into(),
        positions: vec![-50.0, -50.0, 0.0, 50.0, -50.0, 0.0, 50.0, 50.0, 0.0, -50.0, 50.0, 0.0],
        indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
        ..Default::default()
    })]);
    let l = p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap();
    let text = serde_json::json!({ "level": serde_json::to_value(l).unwrap(), "scale": 50 }).to_string();
    // Gleicher Schlüssel (7) wie ein vorbereiteter Schnitt: die Regel darf nicht den gemerkten Schnitt treffen.
    let run = |p: &Project| -> Vec<Vec<Primitive>> {
        let (prims, groups, _) = crate::plan::buf::decode(&section_plan_buf(p, &[0.0, 1.0, 7.0, 0.0], &text).unwrap()).unwrap();
        groups.iter().map(|&(a, b)| prims[a..b].to_vec()).collect()
    };
    let walls = |g: &[Vec<Primitive>]| g[0].iter().filter(|q| matches!(q, Primitive::Polygon { wall_id: Some(_), .. })).count();
    let slabs = |g: &[Vec<Primitive>]| g[0].iter().filter(|q| matches!(q, Primitive::Polygon { ceiling_id: Some(_), .. })).count();
    let before = run(&p);
    assert!(walls(&before) > 0 && slabs(&before) > 0);
    p.override_rules = Some(vec![ov_rule(serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "wall"}, {"type": "view_kind", "operator": "equals", "value": "section"}]), serde_json::json!({"hide": true}))]);
    let g = run(&p);
    assert_eq!(walls(&g), 0, "Wände ausgeblendet");
    assert!(slabs(&g) > 0);
    assert!(g.get(1).is_none_or(|ops| ops.is_empty()), "Öffnungen der Wände mit");
    p.override_rules.as_mut().unwrap()[0].enabled = false;
    assert_eq!(walls(&run(&p)), walls(&before));
    // Gelände: Linie und Erdreich-Füllung, dann ausblenden.
    let terrain = |g: &[Vec<Primitive>]| g[0].iter().filter_map(|q| match q { Primitive::Line { cls, color, weight_mm, .. } if cls == "section-terrain" => Some((color.clone(), *weight_mm)), _ => None }).collect::<Vec<_>>();
    let earth = |g: &[Vec<Primitive>]| g[0].iter().filter_map(|q| match q { Primitive::Polygon { context_object_id: Some(id), fill, .. } if id == "t" => Some(fill.clone()), _ => None }).collect::<Vec<_>>();
    assert!(!terrain(&before).is_empty() && !earth(&before).is_empty());
    p.override_rules = Some(vec![ov_rule(serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "terrain"}]), serde_json::json!({"color": "#00aa00", "lineweight": 0.7, "fillColor": "#eeeeee"}))]);
    let g = run(&p);
    assert!(terrain(&g).iter().all(|(c, w)| c.as_deref() == Some("#00aa00") && (*w - 0.7).abs() < 1e-9));
    assert!(earth(&g).iter().all(|f| f == "#eeeeee"));
    p.override_rules = Some(vec![ov_rule(serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "terrain"}]), serde_json::json!({"hide": true}))]);
    let g = run(&p);
    assert!(terrain(&g).is_empty() && earth(&g).is_empty());
    assert!(g[0].iter().any(|q| matches!(q, Primitive::Line { cls, .. } if cls == "section-ground")), "ohne Gelände die Grundlinie");
    // Linienstil einer Schicht-Regel (Dämmung): Fugen der Schicht gestrichelt.
    let dashed = |g: &[Vec<Primitive>]| g[0].iter().filter(|q| matches!(q, Primitive::Line { cls, dash: Some(Some(m)), .. } if cls == "section-joint" && m == &vec![0.35, 0.3])).count();
    assert_eq!(dashed(&before), 0);
    p.override_rules = Some(vec![ov_rule(serde_json::json!([{"type": "material_category", "operator": "equals", "value": "insulation"}]), serde_json::json!({"linetypeId": "hatch-dash"}))]);
    assert!(dashed(&run(&p)) > 0);
}

#[test]
fn beschnittene_baender_behalten_ihre_ebene() {
    // Von der Dominanz beschnittene Wand-/Deckenstücke tragen ihre Kategorie weiter: Ebene aus → weg.
    let p = sample();
    let out = compute_section(&p, &level(&p, "schnitt-a"), &[]).unwrap().unwrap();
    assert!(out.cuts.iter().filter(|c| c.kind != Kind::Body).all(|c| c.category.is_some()), "{:#?}", out.cuts);
    let codes: Vec<String> = out.cuts.iter().filter_map(|c| c.category.clone()).collect();
    let vis = Visibility { has_vis: true, invisible: codes.into_iter().collect(), ..Default::default() };
    let (prims, _) = section_primitives(&out, false, false, &vis);
    assert!(prims.iter().all(|p| !matches!(p, Primitive::Polygon { .. })));
}

/// Mehrschichtige Decke + Treppe im Schnitt: je Deckenschicht genau ein Band mit ihrem Bauteil und
/// ihrer Dicke (nicht jedes Schicht-Prisma nochmals in alle Schichten geteilt), Treppen-Tritte ohne
/// Decken-Besitzer (früher: Besitzer per Zählung, Index-Versatz).
#[test]
fn mehrschichtige_decke_und_treppe_im_schnitt() {
    let p = sample();
    let l = level(&p, "schnitt-a");
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let slab: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Slab && c.stair_id.is_none()).collect();
    // Je Schicht ein Band (von stärkeren Wandschichten in Stücke geteilt): Bauteil + Höhenlage.
    let mut layers: Vec<(&str, f64, f64)> = Vec::new();
    for c in &slab {
        let b = bbox(&c.pts);
        let comp = c.component_id.as_deref().expect("Schicht-Bauteil");
        match layers.iter().find(|l| l.0 == comp) {
            Some(l) => assert!((l.1 - b[2]).abs() < 1e-5 && (l.2 - b[3]).abs() < 1e-5, "{comp}: {b:?} statt {l:?}"),
            None => layers.push((comp, b[2], b[3])),
        }
    }
    assert!(slab.iter().all(|c| c.source_id.as_deref() == Some("C1") && c.category.as_deref() == Some("30")));
    layers.sort_by(|a, b| b.2.total_cmp(&a.2));
    let names: Vec<&str> = layers.iter().map(|l| l.0).collect();
    assert_eq!(names, ["screed", "insulation", "concrete"], "{slab:#?}");
    // Schichtdicken 0.06 / 0.04 / 0.20 von oben nach unten, aneinander anschliessend.
    for (l, t) in layers.iter().zip([0.06, 0.04, 0.2]) {
        assert!((l.2 - l.1 - t).abs() < 1e-5, "{layers:?}");
    }
    assert!((layers[0].1 - layers[1].2).abs() < 1e-5 && (layers[1].1 - layers[2].2).abs() < 1e-5, "{layers:?}");
    // Stil der Schicht (Füllung + Schraffur des Bauteils), nicht die Rückfall-Schraffur ohne Füllung.
    assert!(slab.iter().all(|c| c.fill.is_some() && c.hatch.is_some() && c.join_priority.is_some()), "{slab:#?}");
    // Treppe: alle Tritt-Bänder mit Treppen-Herkunft, ohne Decken-Bauteil.
    let stair: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Slab && c.stair_id.is_some()).collect();
    assert!(!stair.is_empty());
    assert!(stair.iter().all(|c| c.stair_id.as_deref() == Some("ST1") && c.category.as_deref() == Some("40") && c.component_id.is_none()), "{stair:#?}");
    // Kein Decken-/Treppenband bleibt ohne Herkunft.
    assert!(out.cuts.iter().filter(|c| c.kind == Kind::Slab).all(|c| c.source_id.is_some() || c.stair_id.is_some()));
}

#[test]
fn puffer_hat_zwei_gruppen() {
    let p = sample();
    let text = serde_json::json!({ "level": serde_json::to_value(p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap()).unwrap() }).to_string();
    let buf = section_plan_buf(&p, &[0.0, 1.0, 0.0, 0.0], &text).unwrap();
    let (prims, groups, bounds) = crate::plan::buf::decode(&buf).unwrap();
    assert_eq!(groups.len(), 2);
    assert!(bounds.is_some() && !prims.is_empty());
    // Ohne Schnittlinie: leerer Puffer ohne Gruppen.
    let none = section_plan_buf(&p, &[0.0, 0.0], r#"{"level":{"kind":"section"}}"#).unwrap();
    assert!(crate::plan::buf::decode(&none).unwrap().1.is_empty());
}


/// [157] Fenster in der Bogenwand: der Rahmen sitzt im Schnitt in der geschnittenen Wand (Öffnung tangential am
/// Bogen an der Schnittstelle; vorher auf der Sehne, um die Pfeilhöhe neben der Wand: nur der Umriss lag im Schnitt).
#[test]
fn fenster_in_bogenwand_sitzt_in_der_wand() {
    let mut p = sample_flush();
    p.walls.iter_mut().find(|w| w.id == "W1").unwrap().bulge = Some(-0.3);
    let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
    let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap().clone();
    let a = crate::wall_arc::WallArc::of_wall(&w1).unwrap();
    // Schnitt nahe der Laibung, wo die Sehne am weitesten vom Bogen weg liegt.
    let m = o1.position + o1.width * 0.15;
    let (c, n) = (a.point(m, 0.0), a.normal(m));
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.x - n.x * 3.0, y: c.y - n.y * 3.0 }, Vec2 { x: c.x + n.x * 3.0, y: c.y + n.y * 3.0 }]), ..Default::default() };
    let out = compute_section(&p, &l, &[]).unwrap().unwrap();
    let wall_u: Vec<[f64; 2]> = out
        .cuts
        .iter()
        .filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1"))
        .map(|c| {
            let b = bbox(&c.pts);
            [b[0], b[1]]
        })
        .collect();
    let (u0, u1) = (wall_u.iter().map(|b| b[0]).fold(f64::INFINITY, f64::min), wall_u.iter().map(|b| b[1]).fold(f64::NEG_INFINITY, f64::max));
    assert!(u1 > u0, "Wandschnitt fehlt");
    let prims = section_opening_primitives(&p, &l, &Visibility::default()).unwrap();
    let mut n_frame = 0;
    for pr in &prims {
        if let Primitive::Polygon { pts, opening_id: Some(id), fill, .. } = pr {
            if id == "O1" && fill == "#ffffff" {
                n_frame += 1;
                let (f0, f1) = (pts.iter().map(|q| q.x).fold(f64::INFINITY, f64::min), pts.iter().map(|q| q.x).fold(f64::NEG_INFINITY, f64::max));
                assert!(f0 >= u0 - 1e-3 && f1 <= u1 + 1e-3, "Rahmen {f0}..{f1} ausserhalb des Wandschnitts {u0}..{u1}");
            }
        }
    }
    assert!(n_frame > 0, "Rahmenteile im Schnitt fehlen");
}

/// [180] Ausgeblendete Klassen nehmen an der Verdeckung nicht teil: Eine Wand (Klasse 77) vor einer Rückwand
/// (Klasse 78), beide hinter der Schnittebene. Sichtbar oder grau verdeckt sie einen Teil der Rückwandkanten;
/// ausgeblendet (`invisible` bzw. `norender`) erscheint die Rückwand vollständig, wie ohne die Wand.
#[test]
fn ausgeblendete_klasse_verdeckt_nicht() {
    let mut p = sample();
    let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap().clone();
    let wall = |id: &str, cat: &str, x0: f64, x1: f64, y: f64| Wall { id: id.into(), category_code: cat.into(), start: Vec2 { x: x0, y }, end: Vec2 { x: x1, y }, ..w1.clone() };
    p.walls.push(wall("RUECK", "78", 0.0, 10.0, 50.0));
    p.walls.push(wall("VORN", "77", 4.0, 6.0, 45.0));
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: -5.0, y: 40.0 }, Vec2 { x: 15.0, y: 40.0 }]), ..Default::default() };
    let back = |out: &Output| -> f64 { out.visible.iter().filter(|e| out.edge_cats.get(&(e.kind, e.index)).map(String::as_str) == Some("78")).map(|e| hypot2(e.b[0] - e.a[0], e.b[1] - e.a[1])).sum() };
    let back_len = |vis: &Visibility| back(&compute_section_vis(&p, &l, &[], vis).unwrap().unwrap());
    let set = |c: &str| -> HashSet<String> { [c.to_string()].into() };
    let full = {
        let mut q = p.clone();
        q.walls.retain(|w| w.id != "VORN");
        back(&compute_section(&q, &l, &[]).unwrap().unwrap())
    };
    let shown = back_len(&Visibility::default());
    assert!(full > 0.0 && shown < full - 1.0, "Vorderwand verdeckt: {shown} < {full}");
    let off = back_len(&Visibility { has_vis: true, invisible: set("77"), ..Default::default() });
    assert!((off - full).abs() < 1e-6, "ausgeblendet: Rückwand vollständig ({off} = {full})");
    let norender = back_len(&Visibility { has_display: true, norender: set("77"), ..Default::default() });
    assert!((norender - full).abs() < 1e-6, "nicht gerendert: {norender} = {full}");
    let grey = back_len(&Visibility { has_display: true, grey: set("77"), ..Default::default() });
    assert!((grey - shown).abs() < 1e-6, "grau verdeckt weiter: {grey} = {shown}");
}

/// [180] Der Schnitt-Cache unterscheidet die ausgeblendeten Klassen (gleicher Aufrufer-Schlüssel).
#[test]
fn schnitt_cache_kennt_ausgeblendete_klassen() {
    let p = sample();
    let l = p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap();
    let run = |invisible: &[&str]| section_plan_buf(&p, &[0.0, 0.0, 4711.0], &serde_json::json!({ "level": serde_json::to_value(l).unwrap(), "hasVis": true, "invisible": invisible }).to_string()).unwrap();
    let all = run(&[]);
    let off = run(&["31"]);
    assert_ne!(all, off, "Dach aus ergibt einen anderen Schnitt");
    assert_eq!(run(&[]), all);
    assert_eq!(run(&["31"]), off);
}

/// [187]/[143] Höhenlinien-Satz (ohne Gelände-Netz): die Schnittpunkte mit der Ebene ergeben die Geländelinie, darunter
/// das Erdreich-Band mit Pick-Id des Satzes (Klasse = die des Satzes, `Profile::category`).
#[test]
fn hoehenlinien_ergeben_gelaendelinie_und_erdreich() {
    let mut p = sample();
    let ring = |x0: f64, x1: f64, z: f64| Contour { z, pts: vec![Vec2 { x: x0, y: -50.0 }, Vec2 { x: x1, y: -50.0 }, Vec2 { x: x1, y: 50.0 }, Vec2 { x: x0, y: 50.0 }], closed: true, ..Default::default() };
    p.context = Some(vec![ContextObject::ContourSet(ContourSet { id: "hl".into(), name: "HL".into(), category_code: "02".into(), contours: vec![ring(-4.0, 8.0, -1.0), ring(-2.0, 7.0, -0.5), ring(-1.5, 6.5, 0.0)], ..Default::default() })]);
    let l = p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap();
    let text = serde_json::json!({ "level": serde_json::to_value(l).unwrap(), "scale": 50 }).to_string();
    let run = |p: &Project| -> Vec<Primitive> {
        let (prims, groups, _) = crate::plan::buf::decode(&section_plan_buf(p, &[0.0, 1.0, 7.0, 0.0], &text).unwrap()).unwrap();
        prims[groups[0].0..groups[0].1].to_vec()
    };
    let g = run(&p);
    let lines = g.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "section-terrain")).count();
    assert_eq!(lines, 5, "6 Schnittpunkte = 5 Segmente");
    assert!(g.iter().any(|q| matches!(q, Primitive::Polygon { context_object_id: Some(id), .. } if id == "hl")), "Erdreich mit Pick-Id");
}

/// [198] Zwei Wandschnitte mit gleichem Innenputz (gleiche Füllung/Schraffur, verschiedene Wände) stossen
/// ohne feine Fuge aneinander; die Fuge zum Backstein (anderer Stil) und die Fuge zwischen zwei Schichten
/// DERSELBEN Wand bleiben.
#[test]
fn schnitt_gleiche_flaechen_verschiedener_waende_ohne_fuge() {
    let cut = |src: &str, x0: f64, x1: f64, pattern: HatchPattern| {
        let mut c = Cut::new(Kind::Wall, 0, vec![[x0, 0.0], [x1, 0.0], [x1, 2.5], [x0, 2.5]]);
        c.source_id = Some(src.into());
        c.hatch = Some(HatchRender { pattern, ..section_hatch() });
        c.fill = Some(HATCH_PAPER.into());
        c
    };
    // Wand A: Putz 0…0.05, Backstein 0.05…0.2; Wand B: Putz 0.2…0.25 und 0.25…0.3 (zwei Schichten gleichen Stils);
    // Wand A: Putz 0.3…0.35 (stösst an den Putz der Wand B).
    let out = Output {
        cuts: vec![cut("A", 0.0, 0.05, HatchPattern::None), cut("A", 0.05, 0.2, HatchPattern::Diagonal), cut("B", 0.2, 0.25, HatchPattern::None), cut("B", 0.25, 0.3, HatchPattern::None), cut("A", 0.3, 0.35, HatchPattern::None)],
        ..Default::default()
    };
    let (prims, _) = section_primitives_at(&out, false, false, &Visibility::default(), 20.0, Detail::Mittel, true, &CutRules::default());
    let edges: Vec<(f64, f64, f64, f64)> = prims
        .iter()
        .flat_map(|q| match q {
            Primitive::Polygon { pts, stroke, no_stroke_edges, .. } if stroke != "none" => {
                let skip = no_stroke_edges.clone().unwrap_or_default();
                (0..pts.len()).filter(|i| !skip.contains(&(*i as f64))).map(|i| (pts[i].x, pts[i].y, pts[(i + 1) % pts.len()].x, pts[(i + 1) % pts.len()].y)).collect::<Vec<_>>()
            }
            Primitive::Line { a, b, cls, .. } if &**cls == "section-joint" => vec![(a.x, a.y, b.x, b.y)],
            _ => vec![],
        })
        .collect();
    let at = |x: f64| edges.iter().any(|(ax, _, bx, _)| (ax - x).abs() < 1e-6 && (bx - x).abs() < 1e-6);
    assert!(at(0.05), "Fuge Putz/Backstein bleibt: {edges:?}");
    assert!(at(0.2), "Fuge Backstein/Putz (Materialwechsel) bleibt");
    assert!(at(0.25), "Fuge zwischen zwei Schichten DERSELBEN Wand bleibt");
    assert!(!at(0.3), "Putz B an Putz A (gleicher Stil, verschiedene Wände): keine Fuge");
}

/// [204] Das gewachsene Terrain (gestrichelt) läuft nicht durch die Räume des Gebäudes: Wo ein Bauteilschnitt links und
/// rechts davon auf derselben Höhe liegt, ist es verdeckt; ausserhalb (in der Baugrube vor dem Haus) bleibt es.
#[test]
fn gewachsenes_gelaende_nicht_durch_gebaeude() {
    let mut p = sample();
    let flat = TerrainMesh {
        id: "t".into(),
        positions: vec![-50.0, -50.0, 0.0, 50.0, -50.0, 0.0, 50.0, 50.0, 0.0, -50.0, 50.0, 0.0],
        indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
        category_code: "02".into(),
        ..Default::default()
    };
    let pit = Excavation {
        id: "bg".into(),
        outline: vec![Vec2 { x: -3.0, y: -1.0 }, Vec2 { x: 8.0, y: -1.0 }, Vec2 { x: 8.0, y: 5.0 }, Vec2 { x: -3.0, y: 5.0 }],
        bottom: -2.0,
        ..Default::default()
    };
    p.context = Some(vec![ContextObject::TerrainMesh(flat), ContextObject::Excavation(pit)]);
    let out = compute_section(&p, &level(&p, "schnitt-a"), &[]).unwrap().unwrap();
    let nat: Vec<&Profile> = out.profiles.iter().filter(|pr| pr.natural).collect();
    assert!(!nat.is_empty(), "gewachsenes Terrain bleibt in der Baugrube vor dem Haus");
    // Haus-Spanne auf Höhe 0: kleinster/grösster x der Schnittflächen, die diese Höhe überdecken.
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for c in &out.cuts {
        let (zmin, zmax) = c.pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |a, q| (a.0.min(q[1]), a.1.max(q[1])));
        if zmin <= 0.0 && zmax >= 0.0 {
            for q in &c.pts {
                lo = lo.min(q[0]);
                hi = hi.max(q[0]);
            }
        }
    }
    assert!(lo.is_finite() && hi - lo > 2.0);
    for pr in &nat {
        for q in &pr.pts {
            assert!(q[0] <= lo + 1e-6 || q[0] >= hi - 1e-6, "gewachsenes Terrain im Gebäude bei x = {} (Haus {lo}..{hi})", q[0]);
        }
    }
    assert!(nat.iter().any(|pr| pr.pts.iter().any(|q| q[0] <= lo + 1e-6)), "vor dem Haus bleibt es");
}
