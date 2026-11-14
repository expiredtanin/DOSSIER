//! Tests von `kernel2d` (aus `lib.rs` verschoben, [164]): Vektor-Grundlagen, Schnitte, Offset, Fillet, Trim, Treppen, Räume.

use super::*;

const T: f64 = 1e-12;

#[test]
fn len_uses_hypot() {
    assert!((len(Vec2::new(3.0, 4.0)) - 5.0).abs() < T);
}

#[test]
fn normalize_zero_guard_yields_origin_not_nan() {
    let n = normalize(Vec2::new(0.0, 0.0));
    assert_eq!(n, Vec2::new(0.0, 0.0));
}

#[test]
fn cross_dot_term_order() {
    let p = Vec2::new(1.0, 2.0);
    let q = Vec2::new(3.0, 4.0);
    assert!((cross(p, q) - (1.0 * 4.0 - 2.0 * 3.0)).abs() < T);
    assert!((dot(p, q) - (1.0 * 3.0 + 2.0 * 4.0)).abs() < T);
}

#[test]
fn line_intersect_parallel_is_none() {
    let a = Vec2::new(0.0, 0.0);
    let da = Vec2::new(1.0, 0.0);
    let b = Vec2::new(0.0, 1.0);
    let db = Vec2::new(1.0, 0.0);
    assert!(line_intersect(a, da, b, db).is_none());
}

#[test]
fn line_intersect_crossing() {
    let hit = line_intersect(
        Vec2::new(0.0, 0.0),
        Vec2::new(1.0, 0.0),
        Vec2::new(2.0, -1.0),
        Vec2::new(0.0, 1.0),
    )
    .unwrap();
    assert!((hit.x - 2.0).abs() < T && hit.y.abs() < T);
}

#[test]
fn signed_area_unit_square_ccw() {
    let sq = [
        Vec2::new(0.0, 0.0),
        Vec2::new(1.0, 0.0),
        Vec2::new(1.0, 1.0),
        Vec2::new(0.0, 1.0),
    ];
    assert!((signed_area(&sq) - 1.0).abs() < T);
    assert!(is_ccw(&sq));
    // Umgekehrte Reihenfolge → CW, Flaeche negativ.
    let mut cw = sq;
    cw.reverse();
    assert!((signed_area(&cw) + 1.0).abs() < T);
    assert!(!is_ccw(&cw));
}

#[test]
fn segment_intersect_crossing_and_miss() {
    let hit = segment_intersect(
        Vec2::new(0.0, 0.0),
        Vec2::new(2.0, 2.0),
        Vec2::new(0.0, 2.0),
        Vec2::new(2.0, 0.0),
        EPS,
    )
    .unwrap();
    assert!((hit.point.x - 1.0).abs() < T && (hit.point.y - 1.0).abs() < T);
    assert!((hit.t - 0.5).abs() < T && (hit.s - 0.5).abs() < T);
    // Kein Treffer: zweite Strecke zu kurz.
    assert!(segment_intersect(
        Vec2::new(0.0, 0.0),
        Vec2::new(2.0, 2.0),
        Vec2::new(0.0, 2.0),
        Vec2::new(0.9, 1.1),
        EPS,
    )
    .is_none());
}

#[test]
fn circle_circle_two_points() {
    // Zwei Einheitskreise, Zentren Abstand 1 → Schnitt bei x=0.5, y=±√3/2.
    let pts = circle_circle_intersect(Vec2::new(0.0, 0.0), 1.0, Vec2::new(1.0, 0.0), 1.0);
    assert_eq!(pts.len(), 2);
    let expect_y = (3.0_f64).sqrt() / 2.0;
    for p in &pts {
        assert!((p.x - 0.5).abs() < 1e-9);
        assert!((p.y.abs() - expect_y).abs() < 1e-9);
    }
}

#[test]
fn line_circle_tangent_one_point() {
    // Gerade y=1 tangiert Einheitskreis in (0,1).
    let pts = line_circle_intersect(
        Vec2::new(-1.0, 1.0),
        Vec2::new(1.0, 1.0),
        Vec2::new(0.0, 0.0),
        1.0,
    );
    assert_eq!(pts.len(), 1);
    assert!(pts[0].x.abs() < 1e-9 && (pts[0].y - 1.0).abs() < 1e-9);
}

#[test]
fn polyline_edges_open_and_closed() {
    let pts = [
        Vec2::new(0.0, 0.0),
        Vec2::new(1.0, 0.0),
        Vec2::new(1.0, 1.0),
    ];
    assert_eq!(polyline_edges(&pts, false).len(), 2);
    assert_eq!(polyline_edges(&pts, true).len(), 3);
    assert!(polyline_edges(&[], true).is_empty());
    assert!(polyline_edges(&[Vec2::new(0.0, 0.0)], true).is_empty());
}

#[test]
fn offset_segment_left_positive() {
    // Strecke (0,0)->(1,0), Offset +0.5 → linke Normale (0,1) → y=0.5.
    let (a, b) = offset_segment(Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0), 0.5);
    assert!((a.x).abs() < T && (a.y - 0.5).abs() < T);
    assert!((b.x - 1.0).abs() < T && (b.y - 0.5).abs() < T);
}

#[test]
fn offset_polyline_right_angle_miter() {
    // L-Ecke (0,0)->(1,0)->(1,1), offen, Offset +0.5 (nach innen/links).
    // Innerer Gehrungspunkt = Schnitt der beiden verschobenen Kanten bei (0.5,0.5).
    let l = [
        Vec2::new(0.0, 0.0),
        Vec2::new(1.0, 0.0),
        Vec2::new(1.0, 1.0),
    ];
    let out = offset_polyline(&l, 0.5, false);
    assert_eq!(out.len(), 3);
    assert!((out[1].x - 0.5).abs() < 1e-9 && (out[1].y - 0.5).abs() < 1e-9);
}

#[test]
fn fillet_right_angle() {
    // Rechter Winkel bei (0,0), Schenkel entlang +x und +y, r=1.
    // setback = r/tan(45°) = 1; center auf Winkelhalbierender bei (1,1).
    let f = fillet_corner(
        Vec2::new(0.0, 0.0),
        Vec2::new(5.0, 0.0),
        Vec2::new(0.0, 5.0),
        1.0,
    )
    .unwrap();
    assert!((f.tangent_a.x - 1.0).abs() < 1e-9 && f.tangent_a.y.abs() < 1e-9);
    assert!(f.tangent_b.x.abs() < 1e-9 && (f.tangent_b.y - 1.0).abs() < 1e-9);
    assert!((f.center.x - 1.0).abs() < 1e-9 && (f.center.y - 1.0).abs() < 1e-9);
    assert!((f.radius - 1.0).abs() < T);
}

#[test]
fn fillet_collinear_is_none() {
    // Gestreckt (180°) → kollinear → None.
    assert!(fillet_corner(
        Vec2::new(0.0, 0.0),
        Vec2::new(1.0, 0.0),
        Vec2::new(-1.0, 0.0),
        0.5,
    )
    .is_none());
    // Zu grosser Radius für die Schenkellänge → None.
    assert!(fillet_corner(
        Vec2::new(0.0, 0.0),
        Vec2::new(0.1, 0.0),
        Vec2::new(0.0, 0.1),
        10.0,
    )
    .is_none());
}

fn poly(pts: &[(f64, f64)], closed: bool) -> Polyline {
    Polyline {
        pts: pts.iter().map(|&(x, y)| Vec2::new(x, y)).collect(),
        closed,
    }
}

#[test]
fn trim_segment_removes_picked_piece() {
    // Strecke (0,0)->(4,0), ein vertikaler Cutter bei x=2 → zwei Stuecke.
    // Pick bei (0.5,0) → linkes Stueck faellt weg, rechtes bleibt.
    let cutters = [poly(&[(2.0, -1.0), (2.0, 1.0)], false)];
    let rest = trim_segment(
        Vec2::new(0.0, 0.0),
        Vec2::new(4.0, 0.0),
        &cutters,
        Vec2::new(0.5, 0.0),
    );
    assert_eq!(rest.len(), 1);
    assert!((rest[0].0.x - 2.0).abs() < 1e-9 && (rest[0].1.x - 4.0).abs() < 1e-9);
}

#[test]
fn split_at_intersections_closed_square_by_two_cuts() {
    // Einheitsquadrat, ein waagerechter Schneider y=0.5 quer → zwei Ringe.
    let square = [
        Vec2::new(0.0, 0.0),
        Vec2::new(1.0, 0.0),
        Vec2::new(1.0, 1.0),
        Vec2::new(0.0, 1.0),
    ];
    let others = vec![vec![Vec2::new(-1.0, 0.5), Vec2::new(2.0, 0.5)]];
    let parts = split_at_intersections(&square, true, &others);
    assert_eq!(parts.len(), 2, "zwei geschlossene Teilpolygone");
    for p in &parts {
        assert!(p.len() >= 3);
    }
}

#[test]
fn join_chains_merges_and_closes() {
    // Drei offene Kanten eines Dreiecks → eine geschlossene Kette.
    let input = vec![
        poly(&[(0.0, 0.0), (1.0, 0.0)], false),
        poly(&[(1.0, 0.0), (0.5, 1.0)], false),
        poly(&[(0.5, 1.0), (0.0, 0.0)], false),
    ];
    let out = join_chains(&input);
    assert_eq!(out.len(), 1);
    assert!(out[0].closed, "Dreieck schliesst sich");
    assert_eq!(out[0].pts.len(), 3, "Schlusspunkt-Duplikat entfernt");
}

#[test]
fn remove_segment_open_keeps_longer_piece() {
    // Offene Polylinie mit 5 Punkten; innere Kante 1 entfernen → laengeres Stueck.
    let pts: Vec<Vec2> = (0..5).map(|i| Vec2::new(i as f64, 0.0)).collect();
    let out = remove_segment(&pts, false, 1);
    assert!(!out.closed);
    assert_eq!(out.pts.len(), 3, "rechtes (laengeres) Stueck pts[2..5]");
    assert!((out.pts[0].x - 2.0).abs() < 1e-9);
}

#[test]
fn chamfer_rechter_winkel_und_kollinear() {
    let c = chamfer_corner(Vec2::new(0.0, 0.0), Vec2::new(2.0, 0.0), Vec2::new(0.0, 2.0), 0.5).unwrap();
    assert_eq!(c, Chamfer { a: Vec2::new(0.5, 0.0), b: Vec2::new(0.0, 0.5) });
    assert!(chamfer_corner(Vec2::new(0.0, 0.0), Vec2::new(2.0, 0.0), Vec2::new(-2.0, 0.0), 0.5).is_none());
    assert!(chamfer_corner(Vec2::new(0.0, 0.0), Vec2::new(2.0, 0.0), Vec2::new(0.0, 0.3), 0.5).is_none());
}

#[test]
fn ttr_zwei_achsen_und_gerade_kreis() {
    let x = TangentTarget::Line { a: Vec2::new(-10.0, 0.0), b: Vec2::new(10.0, 0.0) };
    let y = TangentTarget::Line { a: Vec2::new(0.0, -10.0), b: Vec2::new(0.0, 10.0) };
    let c = tangent_circle_centers(x, y, 2.0);
    assert_eq!(c.len(), 4);
    for (qx, qy) in [(2.0, 2.0), (2.0, -2.0), (-2.0, 2.0), (-2.0, -2.0)] {
        assert!(c.iter().any(|p| (p.x - qx).abs() < 1e-9 && (p.y - qy).abs() < 1e-9));
    }
    let k = TangentTarget::Circle { center: Vec2::new(0.0, 6.0), r: 3.0 };
    let c = tangent_circle_centers(x, k, 2.0);
    assert!(c.iter().any(|p| (p.x - 3.0).abs() < 1e-9 && (p.y - 2.0).abs() < 1e-9));
    // Parallele Geraden im Abstand 2r: keine (statt unendlich vieler) Kandidaten.
    let l2 = TangentTarget::Line { a: Vec2::new(0.0, 4.0), b: Vec2::new(10.0, 4.0) };
    assert!(tangent_circle_centers(x, l2, 2.0).is_empty());
}

#[test]
fn nearest_und_break() {
    let pts: Vec<Vec2> = vec![Vec2::new(0.0, 0.0), Vec2::new(4.0, 0.0), Vec2::new(4.0, 4.0)];
    let h1 = nearest_on_polyline(&pts, false, Vec2::new(1.0, 0.5)).unwrap();
    assert_eq!(h1.0, 0);
    assert!((h1.1 - 0.25).abs() < 1e-12);
    let h2 = nearest_on_polyline(&pts, false, Vec2::new(4.5, 2.0)).unwrap();
    assert_eq!(h2.0, 1);
    assert!(nearest_on_polyline(&pts[..1], false, Vec2::new(0.0, 0.0)).is_none());
    // Reihenfolge der Klicks egal.
    let out = break_curve(&pts, h2, h1);
    assert_eq!(out, vec![vec![Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0)], vec![Vec2::new(4.0, 2.0), Vec2::new(4.0, 4.0)]]);
    assert!(break_curve(&pts, (5, 0.5), (0, 0.5)).is_empty());
}

#[test]
fn kaputte_indizes_ohne_panic() {
    let pts: Vec<Vec2> = (0..4).map(|i| Vec2::new(i as f64, (i % 2) as f64)).collect();
    assert_eq!(split_polyline_at_param(&pts, false, 9, 0.5), vec![pts.clone()]);
    assert!(split_closed_by_chord(&pts, 0, 0.5, 7, 0.5).is_none());
    assert!(remove_segment(&[], true, 3).pts.is_empty());
}

// --- Treppen ---------------------------------------------------------------------------

fn stair(shape: &str) -> StairParams {
    StairParams {
        shape: shape.to_string(),
        start: Vec2 { x: 0.0, y: 0.0 },
        dir: Vec2 { x: 1.0, y: 0.0 },
        run_length: 3.0,
        run2_length: None,
        turn: None,
        center: None,
        radius: None,
        sweep: None,
        width: 1.2,
        step_count: 16,
        up: None,
        referenz: None,
        gap: None,
        landing_length: None,
        run1_steps: None,
        mid_steps: None,
        run2_offset: None,
        mid_offset: None,
    }
}

fn near(a: Vec2, x: f64, y: f64) -> bool {
    (a.x - x).abs() < 1e-9 && (a.y - y).abs() < 1e-9
}

/// [258] Lauflänge f64::MAX (Summe/Produkt laufen über, Stufenzahl sättigt zu i64::MAX): endlich viele Tritte.
#[test]
fn regression_stair_riesige_lauflaenge() {
    for shape in ["L", "U", "straightLanding", "straight"] {
        let mut p = stair(shape);
        p.run_length = f64::MAX;
        p.run2_length = Some(3.0);
        let g = stair_geometry(&p, 1.0);
        assert!(g.treads.len() <= 20, "{shape}: {} Tritte", g.treads.len());
    }
}

#[test]
fn stair_gerade_tritte_lauflinie_pfeil() {
    let g = stair_geometry(&stair("straight"), 2.8);
    assert_eq!(g.treads.len(), 16);
    assert!((g.riser_height - 0.175).abs() < 1e-12);
    assert!((g.tread_depth - 3.0 / 16.0).abs() < 1e-12);
    assert!(g.landing.is_none());
    let t0 = &g.treads[0];
    assert!(near(t0.pts[0], 0.0, 0.6) && near(t0.pts[2], 3.0 / 16.0, -0.6));
    assert!((g.treads[15].top_rise - 2.8).abs() < 1e-12);
    assert_eq!(g.run_line.len(), 2);
    // Pfeilspitze am oberen Ende (up Default = true)
    assert!(near(g.arrow.head.1, g.run_line[1].x, g.run_line[1].y));
    let mut down = stair("straight");
    down.up = Some(false);
    let gd = stair_geometry(&down, 2.8);
    assert!(near(gd.arrow.head.1, gd.run_line[0].x, gd.run_line[0].y));
}

#[test]
fn stair_l_podest_und_zweiter_lauf() {
    let mut p = stair("L");
    p.run2_length = Some(2.0);
    let g = stair_geometry(&p, 2.8);
    assert_eq!(g.treads.len(), 15); // 16 Stufen − 1 Podest
    let land = g.landing.as_ref().unwrap();
    assert_eq!(land.len(), 4);
    assert_eq!(g.run_line.len(), 3);
    // Podest-Mitte = start + u·(run1 + halfW)
    assert!(near(g.run_line[1], 3.6, 0.0));
    // zweiter Lauf geht nach +y (turn Default = links)
    assert!(g.run_line[2].y > 1.0);
    assert_eq!(g.treads[g.treads.len() - 1].index, 15);
    p.turn = Some(-1);
    assert!(stair_geometry(&p, 2.8).run_line[2].y < -1.0);
}

/// Läufe einer Podesttreppe: Tritte vor und nach dem Index-Sprung (Podest).
fn runs_of(g: &StairGeometry) -> (Vec<&TreadRect>, Vec<&TreadRect>) {
    let split = (1..g.treads.len()).find(|&k| g.treads[k].index != g.treads[k - 1].index + 1).unwrap();
    (g.treads[..split].iter().collect(), g.treads[split..].iter().collect())
}

#[test]
fn stair_u_halbpodest_und_gegenlauf() {
    // [151] U: Lauf 1 nach +x, Halbpodest, Lauf 2 links daneben zurück (Auge 0.2).
    let mut p = stair("U");
    p.run2_length = Some(3.0);
    p.gap = Some(0.2);
    p.step_count = 17;
    let g = stair_geometry(&p, 2.89);
    let (r1, r2) = runs_of(&g);
    assert_eq!(r1.len() + r2.len(), 16); // 17 Steigungen − 1 Podest
    assert_eq!((r1.len(), r2.len()), (8, 8));
    // gleiche Steigung überall, Podest = eine Steigung über dem letzten Tritt von Lauf 1
    for t in &g.treads {
        assert!((t.top_rise - t.base_rise - 0.17).abs() < 1e-12);
    }
    assert!((r2[0].base_rise - r1[7].top_rise - 0.17).abs() < 1e-12);
    assert!((r2[7].top_rise - 2.89).abs() < 1e-12);
    // Podest über beide Läufe und das Auge: u 3 … 4.2, v −0.6 … 2.0
    let land = g.landing.as_ref().unwrap();
    let (mut lo, mut hi) = (Vec2 { x: 9.0, y: 9.0 }, Vec2 { x: -9.0, y: -9.0 });
    for q in land {
        lo = Vec2 { x: lo.x.min(q.x), y: lo.y.min(q.y) };
        hi = Vec2 { x: hi.x.max(q.x), y: hi.y.max(q.y) };
    }
    assert!(near(lo, 3.0, -0.6) && near(hi, 4.2, 2.0), "{lo:?} {hi:?}");
    // Lauf 2 läuft nach −x, Mitte bei y = 1.4 (Breite + Auge)
    let c = |t: &TreadRect| Vec2 { x: (t.pts[0].x + t.pts[2].x) / 2.0, y: (t.pts[0].y + t.pts[2].y) / 2.0 };
    assert!((c(r2[0]).y - 1.4).abs() < 1e-9 && c(r2[7]).x < c(r2[0]).x);
    assert!((c(r2[0]).x - (3.0 - 3.0 / 16.0)).abs() < 1e-9);
    // Lauflinie: Lauf 1 → Podestmitte → hinüber → Lauf 2
    assert_eq!(g.run_line.len(), 4);
    assert!(near(g.run_line[1], 3.6, 0.0) && near(g.run_line[2], 3.6, 1.4));
    // Drehsinn rechts: Lauf 2 bei y = −1.4
    p.turn = Some(-1);
    let g = stair_geometry(&p, 2.89);
    assert!(near(g.run_line[2], 3.6, -1.4));
    // Aussenlinie: 8 Ecken, das Auge bleibt frei
    p.turn = Some(1);
    let poly = stair_outline(&p).polygon.unwrap();
    assert_eq!(poly.len(), 8);
    assert!(!point_in_polygon(Vec2 { x: 1.5, y: 0.7 }, &poly));
    assert!(point_in_polygon(Vec2 { x: 1.5, y: 1.4 }, &poly) && point_in_polygon(Vec2 { x: 3.5, y: 0.7 }, &poly));
    // Podestlänge und Stufen je Lauf vorgegeben
    p.landing_length = Some(1.5);
    p.run1_steps = Some(10);
    let g = stair_geometry(&p, 2.89);
    let (r1, r2) = runs_of(&g);
    assert_eq!((r1.len(), r2.len()), (10, 6));
    assert!(near(g.run_line[1], 3.75, 0.0));
}

#[test]
fn stair_u_versatz_und_mittellauf() {
    // Gegenlauf um einen Auftritt ins Podest versetzt: Podest auf seiner Seite ausgeklinkt.
    let mut p = stair("U");
    p.run2_length = Some(3.0);
    p.gap = Some(0.2);
    p.step_count = 17;
    p.run2_offset = Some(0.375);
    let g = stair_geometry(&p, 2.89);
    let (_, r2) = runs_of(&g);
    assert!((r2[0].pts[0].x - 3.375).abs() < 1e-9, "{:?}", r2[0].pts);
    let land = g.landing.as_ref().unwrap();
    assert_eq!(land.len(), 6);
    assert!(point_in_polygon(Vec2 { x: 3.2, y: 0.5 }, land) && !point_in_polygon(Vec2 { x: 3.2, y: 1.4 }, land));
    assert!(stair_outline(&p).polygon.unwrap().len() >= 8);
    // Zwei Viertelpodeste und ein Mittellauf quer über das Auge (1.5 m, 4 Steigungen)
    let mut q = stair("U");
    q.run2_length = Some(2.0);
    q.gap = Some(2.0);
    q.mid_steps = Some(4);
    q.step_count = 18;
    q.run1_steps = Some(7);
    let g = stair_geometry(&q, 3.06);
    let jumps: Vec<usize> = (1..g.treads.len()).filter(|&k| g.treads[k].index != g.treads[k - 1].index + 1).collect();
    assert_eq!(jumps, vec![7, 11]); // Lauf 1: 7, Mittellauf: 4, Lauf 3: 5
    assert_eq!(g.treads.len(), 16);
    assert!((g.treads[15].top_rise - 3.06).abs() < 1e-12);
    let mid = &g.treads[7..11];
    // Mittellauf nach +y, Auftritt wie Lauf 1 (3/7), mittig im Auge (0.6 … 2.6)
    let td = 3.0 / 7.0;
    let y0 = mid[0].pts.iter().map(|q| q.y).fold(f64::INFINITY, f64::min);
    assert!((y0 - (0.6 + (2.0 - 4.0 * td) / 2.0)).abs() < 1e-9, "{y0}");
    assert!((mid[3].top_rise - mid[3].base_rise - 0.17).abs() < 1e-12);
    assert!(mid.iter().all(|t| t.pts.iter().all(|q| q.x > 2.99 && q.x < 4.21)));
    let l2 = g.landing2.as_ref().unwrap();
    assert!(l2.iter().all(|q| q.y > 2.4) && g.landing.as_ref().unwrap().iter().all(|q| q.y < 1.0));
    // Lauf 3 zurück nach −x bei y = 3.2
    let last = &g.treads[15];
    assert!(last.pts.iter().all(|q| (q.y - 3.2).abs() < 0.61) && last.pts.iter().all(|q| q.x < 3.0 + 1e-9));
    assert_eq!(g.run_line.len(), 4);
    let poly = stair_outline(&q).polygon.unwrap();
    assert!(!point_in_polygon(Vec2 { x: 1.0, y: 1.6 }, &poly) && point_in_polygon(Vec2 { x: 3.6, y: 1.6 }, &poly));
}

#[test]
fn stair_u_mittellauf_versetzt() {
    // [151] Mittellauf aus der Mitte des Auges verschoben: ungleiche Viertelpodeste.
    let mut q = stair("U");
    q.run2_length = Some(2.0);
    q.gap = Some(2.0);
    q.mid_steps = Some(4);
    q.step_count = 18;
    q.run1_steps = Some(7);
    let td = 3.0 / 7.0;
    let ext = (2.0 - 4.0 * td) / 2.0;
    let y_min = |pts: &[Vec2]| pts.iter().map(|q| q.y).fold(f64::INFINITY, f64::min);
    let y_max = |pts: &[Vec2]| pts.iter().map(|q| q.y).fold(f64::NEG_INFINITY, f64::max);
    for (o, eff) in [(0.1, 0.1), (-0.05, -0.05), (5.0, ext), (-5.0, -ext)] {
        q.mid_offset = Some(o);
        let g = stair_geometry(&q, 3.06);
        let mid = &g.treads[7..11];
        // Antritt des Mittellaufs um den Versatz verschoben (begrenzt auf die Reserve im Auge)
        assert!((y_min(&mid[0].pts) - (0.6 + ext + eff)).abs() < 1e-9, "{o}: {}", y_min(&mid[0].pts));
        assert!((y_max(&mid[3].pts) - (0.6 + ext + eff + 4.0 * td)).abs() < 1e-9);
        // Podest 1 reicht bis zum Antritt, Podest 2 beginnt am Austritt des Mittellaufs
        assert!((y_max(g.landing.as_ref().unwrap()) - (0.6 + ext + eff)).abs() < 1e-9);
        assert!((y_min(g.landing2.as_ref().unwrap()) - (0.6 + ext + eff + 4.0 * td)).abs() < 1e-9);
    }
    // ohne Mittellauf wirkungslos
    let mut h = stair("U");
    h.gap = Some(0.2);
    let a = stair_geometry(&h, 2.8);
    h.mid_offset = Some(0.3);
    let b = stair_geometry(&h, 2.8);
    assert_eq!(format!("{:?}", a.landing), format!("{:?}", b.landing));
}

#[test]
fn stair_gerade_mit_zwischenpodest() {
    let mut p = stair("straightLanding");
    p.run2_length = Some(2.0);
    p.landing_length = Some(1.0);
    p.run1_steps = Some(9);
    let g = stair_geometry(&p, 2.8);
    let (r1, r2) = runs_of(&g);
    assert_eq!((r1.len(), r2.len()), (9, 6));
    assert!((r1[8].top_rise - 9.0 * 0.175).abs() < 1e-12 && (r2[0].base_rise - 10.0 * 0.175).abs() < 1e-12);
    let land = g.landing.as_ref().unwrap();
    assert!(land.iter().all(|q| (q.x - 3.0).abs() < 1e-9 || (q.x - 4.0).abs() < 1e-9));
    // Lauf 2 schliesst nach dem Podest an und endet bei 6 m
    assert!((r2[0].pts[0].x - 4.0).abs() < 1e-9 && (r2[5].pts[1].x - 6.0).abs() < 1e-9);
    assert!((g.tread_depth - 3.0 / 9.0).abs() < 1e-12);
    let poly = stair_outline(&p).polygon.unwrap();
    assert!(near(poly[2], 6.0, -0.6));
    // ohne Vorgaben: Podest = Laufbreite, Aufteilung nach Lauflängen
    let mut q = stair("straightLanding");
    q.run2_length = Some(3.0);
    let g = stair_geometry(&q, 2.8);
    let (r1, r2) = runs_of(&g);
    assert_eq!((r1.len(), r2.len()), (8, 7)); // round(15·½) = 8
    assert!((r2[0].pts[0].x - 4.2).abs() < 1e-9);
    // Unsinn bei der Stufenvorgabe: auf 1 … Läufe−1 begrenzt
    q.run1_steps = Some(99);
    let g = stair_geometry(&q, 2.8);
    let (r1, r2) = runs_of(&g);
    assert_eq!((r1.len(), r2.len()), (14, 1));
}

#[test]
fn stair_wendel_keile_und_auge() {
    let mut p = stair("spiral");
    p.center = Some(Vec2 { x: 0.0, y: 0.0 });
    p.start = Vec2 { x: 1.0, y: 0.0 };
    p.radius = Some(1.0);
    p.step_count = 12;
    let g = stair_geometry(&p, 2.4);
    assert_eq!(g.treads.len(), 12);
    assert_eq!(g.landing.as_ref().unwrap().len(), 12);
    assert_eq!(g.run_line.len(), 13);
    assert!((g.tread_depth - (1.0 * 270.0 * DEG) / 12.0).abs() < 1e-12);
    // Innenradius = radius − halfW = 0.4
    assert!(near(g.treads[0].pts[0], 0.4, 0.0));
}

#[test]
fn stair_referenz_versetzt_achse_auf_die_mitte() {
    let mut p = stair("straight");
    p.referenz = Some("links".into());
    let g = stair_geometry(&p, 2.8);
    // Achse = linke Kante → Mitte eine halbe Breite rechts (−y bei Lauf +x)
    assert!(near(g.treads[0].pts[0], 0.0, 0.0) && near(g.treads[0].pts[3], 0.0, -1.2));
    p.referenz = Some("rechts".into());
    let g = stair_geometry(&p, 2.8);
    assert!(near(g.treads[0].pts[0], 0.0, 1.2));
    // Wendel: auch das Zentrum wandert mit
    let mut sp = stair("spiral");
    sp.referenz = Some("rechts".into());
    sp.center = Some(Vec2 { x: 5.0, y: 5.0 });
    let o = stair_outline(&sp);
    assert!((o.spiral.unwrap().arcs[0].0.y - 5.6).abs() < 1e-9);
}

#[test]
fn stair_outline_formen() {
    let o = stair_outline(&stair("straight"));
    let poly = o.polygon.unwrap();
    assert_eq!(poly.len(), 4);
    assert!(near(poly[0], 0.0, 0.6) && near(poly[2], 3.0, -0.6));
    assert!(o.spiral.is_none());
    let mut l = stair("L");
    l.run2_length = Some(2.0);
    let poly = stair_outline(&l).polygon.unwrap();
    assert_eq!(poly.len(), 6);
    let sp = stair_outline(&stair("spiral")).spiral.unwrap();
    assert!((sp.arcs[0].1 - 0.5).abs() < 1e-9 || sp.arcs[0].1 > 0.0);
    assert!((sp.arcs[1].1 - sp.arcs[0].1 - 1.2).abs() < 1e-9);
}

#[test]
fn stair_unsinn_ohne_panic() {
    let mut p = stair("straight");
    p.dir = Vec2 { x: 0.0, y: 0.0 };
    let _ = stair_geometry(&p, 2.8);
    p.width = f64::NAN;
    p.run_length = f64::NAN;
    let g = stair_geometry(&p, f64::NAN);
    assert_eq!(g.treads.len(), 16);
    p.step_count = -5;
    assert_eq!(stair_geometry(&p, 2.8).treads.len(), 2);
    for shape in ["L", "spiral", "U", "straightLanding"] {
        let mut q = stair(shape);
        q.gap = Some(f64::NAN);
        q.landing_length = Some(-1.0);
        q.width = f64::NAN;
        q.step_count = 0;
        let _ = stair_geometry(&q, 1.0);
        let _ = stair_outline(&q);
    }
}

#[test]
fn stair_cut_bbox_und_treffer() {
    let g = stair_geometry(&stair("straight"), 2.8);
    let c = stair_cut(&g, 1.0);
    assert_eq!(c.below_indices.len(), 5); // 0.175·5 = 0.875 ≤ 1 < 1.05
    assert_eq!(c.above_indices.len(), 11);
    assert_eq!(c.break_line.as_ref().unwrap().len(), 2);
    assert!(stair_cut(&g, 99.0).break_line.is_none());
    let b = stair_bbox(&g);
    assert!((b.max_x - 3.0).abs() < 1e-9 && (b.min_y + 0.6).abs() < 1e-9);
    assert!(point_hits_stair(Vec2 { x: 1.0, y: 0.0 }, &g));
    assert!(!point_hits_stair(Vec2 { x: 1.0, y: 5.0 }, &g));
    let leer = StairGeometry {
        treads: vec![], landing: None, landing2: None, riser_height: 0.0, tread_depth: 0.0,
        run_line: vec![], arrow: StairArrow { shaft: (Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 0.0, y: 0.0 }), head: (Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 0.0, y: 0.0 }) },
        total_rise: 0.0,
    };
    assert_eq!(stair_bbox(&leer).max_x, 0.0);
}

#[test]
fn default_step_count_regeln() {
    assert_eq!(default_step_count(2.8, 10.0), 16);
    assert_eq!(default_step_count(2.8, 3.0), 13); // Lauflänge deckelt: floor(3/0.24)+1
    assert_eq!(default_step_count(0.1, 0.0), 2);
    assert_eq!(default_step_count(f64::NAN, 3.0), 2);
}
