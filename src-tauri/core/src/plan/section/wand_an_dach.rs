//! [G2] Wand an Dach: Schnitt und 3D-Körper der Wände unter einem Satteldach.

use super::*;

fn haus() -> Project {
    serde_json::from_value(serde_json::json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [],
        "drawingLevels": [
            {"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
            {"id": "q", "name": "Q", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": 2, "y": -2}, {"x": 2, "y": 10}], "directionSign": 1},
            {"id": "l", "name": "L", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": -2, "y": 4}, {"x": 12, "y": 4}], "directionSign": 1}
        ],
        "walls": [
            {"id": "WS", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 10, "y": 0}, "height": 3.5},
            {"id": "WW", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 0, "y": 8}, "end": {"x": 0, "y": 0}, "height": 9.0},
            {"id": "WB", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 6, "y": 1}, "end": {"x": 6, "y": 7}, "height": 9.0, "bulge": 0.4}
        ],
        "openings": [{"id": "F1", "type": "opening", "hostWallId": "WW", "categoryCode": "21", "kind": "window", "position": 3.5, "width": 1.0, "height": 1.2, "sillHeight": 3.6}],
        "roofs": [{"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35",
            "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}],
            "shape": "sattel", "pitchDeg": 45, "overhang": 0.5, "ridgeAxis": "x", "thickness": 0.3}]
    }))
    .unwrap()
}

/// Dach-Unterkante (Traufkante 3.0 bei y = −0.5, 45°, Dicke 0.3 senkrecht).
fn under(y: f64) -> f64 {
    3.0 + (4.5 - (y - 4.0).abs()) - 0.3 * 2f64.sqrt()
}

#[test]
fn schnitt_endet_an_der_dachunterkante() {
    let p = haus();
    for id in ["q", "l"] {
        let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let out = compute_section(&p, &level, &[]).unwrap().unwrap();
        let walls: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Wall).collect();
        assert!(!walls.is_empty());
        let top = walls.iter().flat_map(|c| c.pts.iter().map(|q| q[1])).fold(f64::NEG_INFINITY, f64::max);
        // Nie über der First-Unterkante.
        assert!(top <= under(4.0) + 1e-4, "{id}: {top}");
    }
    // Querschnitt quer zum First: Traufwand mit schräger Krone.
    let l = p.drawing_levels.iter().find(|l| l.id == "q").unwrap();
    let out = compute_section(&p, &LevelSpec::from_json(&serde_json::to_value(l).unwrap()), &[]).unwrap().unwrap();
    let sloped = out.cuts.iter().filter(|c| c.kind == Kind::Wall).any(|c| {
        let ys: Vec<f64> = c.pts.iter().map(|q| q[1]).filter(|v| *v > 2.0).collect();
        ys.len() >= 2 && (ys.iter().copied().fold(f64::NEG_INFINITY, f64::max) - ys.iter().copied().fold(f64::INFINITY, f64::min)) > 0.1
    });
    assert!(sloped, "Traufwand im Querschnitt mit schräger Krone");
}

#[test]
fn koerper_dicht_und_volumen_exakt() {
    let p = haus();
    let walls = model3d::emit_walls(&p, true).unwrap();
    let ww: Vec<&RWall> = walls.iter().filter(|w| w.wall_id == "WW").collect();
    let mut vol = 0.0;
    for w in walls.iter().filter(|w| w.top_plane.is_some()) {
        let m = model3d::wall_piece_mesh(w).unwrap();
        assert!(m.is_closed(), "{w:?}");
        assert!((m.volume().abs() - model3d::wall_piece_volume(w)).abs() < 1e-9);
    }
    for w in &ww {
        assert!(w.holes.as_ref().is_none_or(|h| h.is_empty()), "Fenster unter dem Dach als Teilkörper: {w:?}");
        vol += model3d::wall_piece_volume(w);
    }
    // Giebelwand: Fünfeck unter der Unterkante × Dicke, minus Fenster.
    let t = p.wall_thickness(&p.walls[1], 0.2);
    let area = |y0: f64, y1: f64| (y1 - y0) * (under(y0) + under(y1)) / 2.0;
    let expect = t * (area(0.0, 4.0) + area(4.0, 8.0) - 1.2);
    // Gehrungen an den Ecken ändern das Volumen nur an den Enden.
    assert!((vol - expect).abs() < t * t * 7.0, "{vol} vs {expect}");
    // Bogenwand ([T2]): Sehnen-Teilwände ebenfalls unter dem Dach.
    let wb: Vec<&RWall> = walls.iter().filter(|w| w.wall_id == "WB").collect();
    assert!(wb.len() > 4 && wb.iter().all(|w| w.base_elevation + w.height <= under(4.0) + 1e-6), "{}", wb.len());
}

/// [132] T-Dach: Hauptdach (First in x, Traufe 3.0, 45°) und Anbau (First in y, Traufe 3.0) auf
/// demselben Geschoss; der Anbau beginnt unter dem Hauptdach. Schnitt bei y = 1 mit Blick auf den Anbau.
fn t_dach(dir: f64, ys: f64) -> Project {
    serde_json::from_value(serde_json::json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [], "openings": [], "walls": [],
        "drawingLevels": [
            {"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
            {"id": "s", "name": "S", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": -2, "y": 1}, {"x": 12, "y": 1}], "directionSign": dir}
        ],
        "roofs": [
            {"id": "H", "type": "roof", "floorId": "F", "categoryCode": "35",
             "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}],
             "shape": "sattel", "pitchDeg": 45, "overhang": 0, "overhangGable": 0, "ridgeAxis": "x", "thickness": 0.3},
            {"id": "A", "type": "roof", "floorId": "F", "categoryCode": "35",
             "outline": [{"x": 3, "y": ys}, {"x": 7, "y": ys}, {"x": 7, "y": 14}, {"x": 3, "y": 14}],
             "shape": "sattel", "pitchDeg": 45, "overhang": 0, "overhangGable": 0, "ridgeAxis": "y", "thickness": 0.3}
        ]
    }))
    .unwrap()
}

/// [132] Was vom Anbaudach unter dem Hauptdach liegt, ist vom Schnitt aus verdeckt: Im Dachraum bei
/// y = 1 deckt die Unterseite der Hauptdach-Fläche alles über ihrer Höhe an der Schnittebene; sichtbare
/// Anbau-Kanten gibt es dort nicht (auch keine durch die Öffnung im Hauptdach unter dem Anbau).
#[test]
fn t_dach_anbau_unter_dem_hauptdach_verdeckt() {
    // Unterkante der Hauptdach-Südfläche an der Schnittebene y = 1.
    let z_cut = 3.0 + 1.0 - 0.3 * 2f64.sqrt();
    for (dir, ys) in [(1.0, 5.5), (-1.0, 5.5), (1.0, 6.3), (-1.0, 6.3)] {
        let p = t_dach(dir, ys);
        let l = p.drawing_levels.iter().find(|l| l.id == "s").unwrap();
        let out = compute_section(&p, &LevelSpec::from_json(&serde_json::to_value(l).unwrap()), &[]).unwrap().unwrap();
        let bad: Vec<_> = out.visible.iter().filter(|e| e.kind == Kind::Roof && e.index == 1 && e.a[1].max(e.b[1]) > z_cut + 1e-3).map(|e| (e.a, e.b)).collect();
        assert!(bad.is_empty(), "dir {dir} ys {ys}: sichtbare Anbau-Kanten über {z_cut}: {bad:?}");
    }
}

/// [132] Flachdach hinter dem Schnitt: Stirn als Band (Ober- und Unterkante), nicht nur eine Linie.
#[test]
fn flachdach_hinter_dem_schnitt_mit_stirn() {
    let p: Project = serde_json::from_value(serde_json::json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [], "openings": [], "walls": [],
        "drawingLevels": [
            {"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
            {"id": "s", "name": "S", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": -2, "y": -1}, {"x": 12, "y": -1}], "directionSign": 1},
            {"id": "t", "name": "T", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": 12, "y": -1}, {"x": -2, "y": -1}], "directionSign": 1}
        ],
        "roofs": [{"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35",
            "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}],
            "shape": "flach", "pitchDeg": 0, "overhang": 0, "ridgeAxis": "x", "baseElevation": 3.0, "thickness": 0.4}]
    }))
    .unwrap();
    // Eine der beiden Blickrichtungen sieht das Dach (die andere schaut weg).
    let mut seen = false;
    for id in ["s", "t"] {
        let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
        let out = compute_section(&p, &LevelSpec::from_json(&serde_json::to_value(l).unwrap()), &[]).unwrap().unwrap();
        let hz = |z: f64| out.visible.iter().any(|e| e.kind == Kind::Roof && (e.a[1] - z).abs() < 1e-6 && (e.b[1] - z).abs() < 1e-6 && (e.a[0] - e.b[0]).abs() > 9.9);
        if hz(3.0) || hz(2.6) {
            assert!(hz(3.0) && hz(2.6), "{id}: Ober- und Unterkante der Stirn");
            seen = true;
        }
    }
    assert!(seen, "Flachdach fehlt im Schnitt");
}

/// [148] Flachdach auf L-Umriss: der Schnitt trifft nur die Schenkel, nie die Aussparung (früher
/// Bounding-Box). Schnitte quer durch beide Schenkel, durch einen Schenkel neben der Aussparung.
#[test]
fn flachdach_l_schnitt_durch_die_schenkel() {
    let line = |id: &str, a: (f64, f64), b: (f64, f64)| serde_json::json!({"id": id, "name": id, "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": a.0, "y": a.1}, {"x": b.0, "y": b.1}], "directionSign": 1});
    let p: Project = serde_json::from_value(serde_json::json!({
        "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [], "openings": [], "walls": [],
        "drawingLevels": [
            {"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
            line("beide", (4.0, -2.0), (4.0, 9.0)),
            line("oben", (-2.0, 5.0), (14.0, 5.0)),
            line("rechts", (9.5, -2.0), (9.5, 9.0))
        ],
        "roofs": [{"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35",
            "outline": [{"x": 0, "y": 0}, {"x": 11, "y": 0}, {"x": 11, "y": 4}, {"x": 8, "y": 4}, {"x": 8, "y": 6}, {"x": 0, "y": 6}],
            "shape": "flach", "pitchDeg": 0, "overhang": 0, "ridgeAxis": "x", "baseElevation": 3.0, "thickness": 0.4}]
    }))
    .unwrap();
    for (id, len) in [("beide", 6.0), ("oben", 8.0), ("rechts", 4.0)] {
        let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
        let out = compute_section(&p, &LevelSpec::from_json(&serde_json::to_value(l).unwrap()), &[]).unwrap().unwrap();
        let roof: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Roof).collect();
        assert!(!roof.is_empty(), "{id}: Dach geschnitten");
        let us = roof.iter().flat_map(|c| c.pts.iter().map(|q| q[0]));
        let (lo, hi) = us.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), u| (lo.min(u), hi.max(u)));
        assert!(((hi - lo) - len).abs() < 1e-6, "{id}: Schnittlänge {} statt {len}", hi - lo);
        let area: f64 = roof.iter().map(|c| crate::roof_skeleton::signed_area(&c.pts).abs()).sum();
        assert!((area - len * 0.4).abs() < 1e-6, "{id}: Schnittfläche {area}");
    }
}
