//! [176] Geknickter Schnitt: Abwicklung (`unfold.rs`).

use super::*;

/// Zwei Wände: W1 quer zum ersten Segment (x = 2), W2 quer zum zweiten (y = 6, x 4…8).
fn zwei_waende() -> Project {
    waende(4.0, 8.0)
}

/// Wie [`zwei_waende`], W2 von x = `x0` bis `x1`.
fn waende(x0: f64, x1: f64) -> Project {
    serde_json::from_value(serde_json::json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [],
        "drawingLevels": [{"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0}],
        "walls": [
            {"id": "W1", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 2, "y": -3}, "end": {"x": 2, "y": 3}, "height": 3.0},
            {"id": "W2", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": x0, "y": 6}, "end": {"x": x1, "y": 6}, "height": 3.0}
        ]
    }))
    .unwrap()
}

fn l_schnitt(sign: f64, bends: Vec<Vec2>) -> LevelSpec {
    LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 6.0, y: 10.0 }]), bends, direction_sign: Some(sign), ..Default::default() }
}

fn knick() -> Vec<Vec2> {
    vec![Vec2 { x: 6.0, y: 0.0 }]
}

/// u-Bereich der Schnittflächen einer Wand.
fn cut_ranges(out: &Output, id: &str) -> Vec<(f64, f64)> {
    out.cuts
        .iter()
        .filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some(id))
        .map(|c| c.pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), q| (a.min(q[0]), b.max(q[0]))))
        .collect()
}

#[test]
fn l_schnitt_zeigt_beide_waende_je_einmal() {
    let p = zwei_waende();
    for sign in [1.0, -1.0] {
        let out = compute_section(&p, &l_schnitt(sign, knick()), &[]).unwrap().unwrap();
        let (w1, w2) = (cut_ranges(&out, "W1"), cut_ranges(&out, "W2"));
        assert_eq!(w1.len(), 1, "W1 genau einmal geschnitten ({sign}): {w1:?}");
        assert_eq!(w2.len(), 1, "W2 genau einmal geschnitten ({sign}): {w2:?}");
        // W1 bei 2 m, W2 bei 6 + 6 = 12 m der Abwicklung (Richtung wie der gerade Schnitt: sign).
        let mid = |r: (f64, f64)| 0.5 * (r.0 + r.1);
        assert!((mid(w1[0]) - sign * 2.0).abs() < 0.2, "{w1:?}");
        assert!((mid(w2[0]) - sign * 12.0).abs() < 0.2, "{w2:?}");
    }
}

#[test]
fn abwicklung_laenge_ist_summe_der_segmente() {
    let l = l_schnitt(1.0, knick());
    let segs = unfold::segments(&l).unwrap();
    assert_eq!(segs.len(), 2);
    assert_eq!(unfold::bend_us(&l), vec![6.0]);
    let last = segs[1].1.as_ref().unwrap();
    assert_eq!(last.offset, 6.0);
    assert_eq!(last.lo, 0.0);
    assert_eq!(last.hi, f64::INFINITY);
    // Ende der Abwicklung: 6 + 10 = 16 (Versatz + Länge des letzten Segments).
    let [a, b] = segs[1].0.line.unwrap();
    assert_eq!(last.offset + (b.x - a.x).hypot(b.y - a.y), 16.0);
    assert_eq!(unfold::bend_us(&l_schnitt(-1.0, knick())), vec![-6.0]);
}

/// Projektion: W2 liegt hinter beiden Ebenen, gehört aber nur in den Streifen des zweiten Segments
/// (Winkelhalbierende am Knick).
#[test]
fn projektion_nur_im_eigenen_streifen() {
    // W2 (x 3…5) ganz hinter dem zweiten Segment (Tiefe 1…3), Stirnseite sichtbar.
    let p = waende(3.0, 5.0);
    let out = compute_section(&p, &l_schnitt(1.0, knick()), &[]).unwrap().unwrap();
    let walls_r = model3d::emit_walls_with(&p, false, false).unwrap();
    let edges: Vec<&Edge> = out.visible.iter().filter(|e| e.kind == Kind::Wall).collect();
    assert!(edges.iter().any(|e| walls_r[e.index].wall_id == "W2"));
    for e in &edges {
        if walls_r[e.index].wall_id == "W2" {
            assert!(e.a[0].min(e.b[0]) >= 6.0 - 1e-6, "W2 nur rechts vom Knick: {e:?}");
        }
    }
    // Gerade Ebene entlang des ersten Segments (ohne Streifen) sähe W2 dagegen (u 3…5).
    let gerade = LevelSpec { line: Some([Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 6.0, y: 0.0 }]), ..l_schnitt(1.0, vec![]) };
    let o2 = compute_section(&p, &gerade, &[]).unwrap().unwrap();
    assert!(o2.visible.iter().any(|e| e.kind == Kind::Wall && walls_r[e.index].wall_id == "W2" && e.a[0].max(e.b[0]) < 6.0 + 1e-6));
}

#[test]
fn ohne_wirksame_knicke_wie_gerade() {
    let p = zwei_waende();
    let gerade = l_schnitt(1.0, vec![]);
    // Knick auf der Geraden (Mitte) und doppelte Punkte entfallen.
    let mitte = l_schnitt(1.0, vec![Vec2 { x: 3.0, y: 5.0 }, Vec2 { x: 3.0, y: 5.0 }]);
    assert!(unfold::segments(&gerade).is_none());
    assert!(unfold::segments(&mitte).is_none());
    let a = compute_section(&p, &gerade, &[]).unwrap().unwrap();
    let b = compute_section(&p, &mitte, &[]).unwrap().unwrap();
    assert_eq!(format!("{:?}", a.cuts), format!("{:?}", b.cuts));
    assert_eq!(format!("{:?}", a.visible), format!("{:?}", b.visible));
}

#[test]
fn polygon_zuschnitt_markiert_neue_kanten() {
    let sq = [[0.0, 0.0], [4.0, 0.0], [4.0, 1.0], [0.0, 1.0]];
    let (pts, nse) = unfold::clip_poly_u(&sq, None, 1.0, 3.0).unwrap();
    assert_eq!(pts.len(), 4);
    assert!(pts.iter().all(|q| q[0] >= 1.0 && q[0] <= 3.0));
    // Zwei neue senkrechte Kanten (auf u = 1 und u = 3) ohne Strich.
    let nse = nse.unwrap();
    assert_eq!(nse.len(), 2);
    for k in nse {
        let (a, b) = (pts[k as usize], pts[(k as usize + 1) % 4]);
        assert_eq!(a[0], b[0]);
    }
}

#[test]
fn plan_puffer_mit_knicklinie() {
    let p = zwei_waende();
    let mut lv = serde_json::json!({ "kind": "section", "linePoints": [{"x": 0, "y": 0}, {"x": 6, "y": 10}], "directionSign": 1 });
    let text = |lv: &serde_json::Value| serde_json::json!({ "level": lv }).to_string();
    let gerade = section_plan_buf(&p, &[0.0, 1.0, 0.0], &text(&lv)).unwrap();
    lv["bendPoints"] = serde_json::json!([{"x": 6, "y": 0}]);
    let geknickt = section_plan_buf(&p, &[0.0, 1.0, 0.0], &text(&lv)).unwrap();
    let prims = |b: &[u8]| -> Vec<Primitive> { crate::plan::buf::View::parse(b).and_then(|v| v.prims()).unwrap() };
    let bends = |prims: &[Primitive]| -> Vec<(f64, f64)> { prims.iter().filter_map(|q| if let Primitive::Line { cls, a, b, .. } = q { (cls == "section-bend").then_some((a.x, b.x)) } else { None }).collect() };
    assert!(bends(&prims(&gerade)).is_empty());
    assert_eq!(bends(&prims(&geknickt)), vec![(6.0, 6.0)]);
}
