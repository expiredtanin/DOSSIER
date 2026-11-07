//! Achsraster in Schnitt und Ansicht ([112]): Rasterachsen quer zur Blickebene als senkrechte
//! strichpunktierte Stummel über (bzw. unter) dem Bild ([157]) (x = Lage entlang der Schnittlinie, y = Höhe) mit Blase und Beschriftung
//! oben (bzw. unten bei „nur Anfang"). Hängt als eigene Gruppe hinter dem Schnitt/der Ansicht.

use super::prim::Primitive;
use super::section::{LevelSpec, Plane};
use crate::grid::{bubble_diameter, section_axes, Spec};
use crate::model::{Drawing2DGeom, GridBubbles, Project, Vec2};

/// [140] Achsen in Tusche (schwarz), nicht grau.
const INK: &str = "#1f242c";
const AXIS_MM: f64 = 0.18;
/// Überstand der Achse über die Gebäudehöhe und unter die Bodenlinie (Meter).
const OVER_TOP: f64 = 0.8;
const OVER_BOTTOM: f64 = 0.3;

fn v2(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Achslinien und Blasen für eine Ebene; `bounds` = Ausmass des Schnitts/der Ansicht (x0, y0, x1, y1),
/// `scale` = Massstabsnenner. Leer ohne Raster oder ohne Ebene.
pub fn grid_prims(p: &Project, level: &LevelSpec, bounds: [f64; 4], scale: f64) -> Vec<Primitive> {
    let Some(plane) = level.plane() else { return Vec::new() };
    let mut out = Vec::new();
    for d in &p.drawings2d {
        let Drawing2DGeom::Grid { bubble_mm, bubbles, .. } = &d.geom else { continue };
        let Some(spec) = Spec::of(&d.geom) else { continue };
        // [137] Achsen, Blasen und Beschriftung tragen die Raster-Id: im Schnitt/in der Ansicht anwählbar.
        let id = Some(d.id.clone());
        out.extend(one(&spec, &plane, level, bounds, bubble_diameter(*bubble_mm, scale), bubbles.unwrap_or(GridBubbles::Both)).into_iter().map(|mut q| {
            match &mut q {
                Primitive::Line { drawing_id, .. } | Primitive::DrawingCircle { drawing_id, .. } | Primitive::DrawingText { drawing_id, .. } => *drawing_id = id.clone(),
                _ => {}
            }
            q
        }));
    }
    out
}

/// Ausmass der Achsen (für die Bounds des Aufrufers).
pub fn extent(prims: &[Primitive]) -> Option<[f64; 4]> {
    let mut b: Option<[f64; 4]> = None;
    let mut acc = |x: f64, y: f64| {
        let r = b.get_or_insert([x, y, x, y]);
        r[0] = r[0].min(x);
        r[1] = r[1].min(y);
        r[2] = r[2].max(x);
        r[3] = r[3].max(y);
    };
    for q in prims {
        match q {
            Primitive::Line { a, b, .. } => {
                acc(a.x, a.y);
                acc(b.x, b.y);
            }
            Primitive::DrawingCircle { center, r, .. } => {
                acc(center.x - r, center.y - r);
                acc(center.x + r, center.y + r);
            }
            _ => {}
        }
    }
    b
}

/// Vereinigt das Ausmass `bounds` mit dem der Achsen.
pub fn union_bounds(bounds: [f64; 4], grid: &[Primitive]) -> [f64; 4] {
    extent(grid).map_or(bounds, |g| [bounds[0].min(g[0]), bounds[1].min(g[1]), bounds[2].max(g[2]), bounds[3].max(g[3])])
}

fn one(spec: &Spec, plane: &Plane, level: &LevelSpec, bounds: [f64; 4], diameter: f64, bubbles: GridBubbles) -> Vec<Primitive> {
    let (bx, by) = plane.base();
    let (ux, uy) = plane.u_model();
    let l = ux.hypot(uy);
    if !(l > 1e-12) || !bounds.iter().all(|x| x.is_finite()) {
        return Vec::new();
    }
    let u = (ux / l, uy / l);
    // Länge der Schnittlinie in u: die Achsen ausserhalb dieser Spanne gehören nicht zum Bild.
    let [p0, p1] = level.line.unwrap_or([v2(bx, by), v2(bx, by)]);
    let e = (p1.x - p0.x) * u.0 + (p1.y - p0.y) * u.1;
    let (lo, hi) = (e.min(0.0), e.max(0.0));
    // [153] Achsen strichpunktiert in Papier-mm (vorher mit dem Massstab vorskaliert).
    let dash = super::line_pattern::AXIS.to_vec();
    let (y0, y1) = (bounds[1] - OVER_BOTTOM, bounds[3] + OVER_TOP);
    let (r, text_h) = (diameter / 2.0, diameter * 0.5);
    let mut out = Vec::new();
    for (label, x) in section_axes(spec, (bx, by), u, level.kind == "elevation") {
        if x < lo - 1e-9 || x > hi + 1e-9 {
            continue;
        }
        // [140] Ansicht: die Achse läuft nicht über die Fassade. [157] Schnitt ebenso (sonst liegt sie als dunkle
        // Strichlinie in der geschnittenen Wand und im Fenster), und nur auf der Seite der Blase: unten stünde der
        // Stummel im Erdreich unter dem Terrain.
        let start = bubbles == GridBubbles::Start;
        let spans: &[(f64, f64)] = if start { &[(y0, bounds[1])] } else { &[(bounds[3], y1)] };
        for &(ya, yb) in spans {
            out.push(Primitive::Line {
                a: v2(x, ya),
                b: v2(x, yb),
                cls: "draw2d".into(),
                weight_mm: AXIS_MM,
                dash: Some(Some(dash.clone())),
                zigzag: None,
                motif: None,
                color: Some(INK.into()),
                drawing_id: None,
                opening_id: None,
                stair_id: None,
                greyed: None,
                opacity: None,
            });
        }
        let (y, dir) = if bubbles == GridBubbles::Start { (y0, -1.0) } else { (y1, 1.0) };
        let c = v2(x, y + dir * r);
        out.push(Primitive::DrawingCircle { center: c, r, fill: "none".into(), stroke: INK.into(), weight_mm: 0.25, dash: None, drawing_id: None, greyed: None, opacity: None });
        let n = label.chars().count() as f64;
        out.push(Primitive::DrawingText {
            at: v2(c.x - text_h * 0.3 * n, c.y - text_h * 0.35),
            text: label.clone(),
            height_m: text_h,
            angle: 0.0,
            color: INK.into(),
            marks: None,
            wrap_width: None,
            doc: None,
            drawing_id: None,
            greyed: None,
            opacity: None,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(grid: serde_json::Value) -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "openings": [], "walls": [],
            "drawingLevels": [{"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0}],
            "drawings2d": [{"id": "G", "type": "drawing2d", "levelId": "F", "categoryCode": "20", "geom": grid}]
        }))
        .unwrap()
    }

    fn texts(prims: &[Primitive]) -> Vec<String> {
        prims.iter().filter_map(|q| if let Primitive::DrawingText { text, .. } = q { Some(text.clone()) } else { None }).collect()
    }

    #[test]
    fn senkrechte_achsen_mit_blase() {
        let p = project(serde_json::json!({"shape": "grid", "origin": {"x": 0, "y": 0}, "angle": 0,
            "a": [{"label": "1", "pos": 0}, {"label": "2", "pos": 4}], "b": [{"label": "A", "pos": 0}, {"label": "B", "pos": 6}]}));
        // Schnitt entlang +x bei y = 3 von x = -1 bis 8: schneidet die Achsen 1 und 2 (u = 1 und 5).
        let level = LevelSpec { kind: "section".into(), line: Some([v2(-1.0, 3.0), v2(8.0, 3.0)]), ..Default::default() };
        let prims = grid_prims(&p, &level, [0.0, 0.0, 9.0, 6.0], 100.0);
        let lines: Vec<(f64, f64, f64)> = prims.iter().filter_map(|q| if let Primitive::Line { a, b, .. } = q { Some((a.x, a.y, b.y)) } else { None }).collect();
        assert_eq!(lines.len(), 2, "{prims:?}");
        assert!((lines[0].0 - 1.0).abs() < 1e-9 && (lines[1].0 - 5.0).abs() < 1e-9);
        // [157] Auch im Schnitt nur ein Stummel über dem Bild bis zur Blase: keine Achse durch die geschnittene
        // Aussenwand (dunkle Strichlinie im Poché und im Fenster, Musterhaus komplex A-A).
        assert!(lines.iter().all(|l| l.1.min(l.2) >= 6.0 - 1e-9 && l.1.max(l.2) > 6.0), "{lines:?}");
        assert_eq!(texts(&prims), ["1", "2"]);
        // [153] Achsmuster in Papier-mm, unabhängig vom Massstab (vorher mit N/1000 vorskaliert).
        for n in [50.0, 200.0] {
            let dashes: Vec<Vec<f64>> = grid_prims(&p, &level, [0.0, 0.0, 9.0, 6.0], n).iter().filter_map(|q| if let Primitive::Line { dash: Some(Some(d)), .. } = q { Some(d.clone()) } else { None }).collect();
            assert!(!dashes.is_empty() && dashes.iter().all(|d| d[..] == super::super::line_pattern::AXIS[..]), "1:{n} {dashes:?}");
        }
        // [137] alles mit der Raster-Id (anwählbar)
        assert!(prims.iter().all(|q| matches!(q, Primitive::Line { drawing_id: Some(i), .. } | Primitive::DrawingCircle { drawing_id: Some(i), .. } | Primitive::DrawingText { drawing_id: Some(i), .. } if i == "G")), "{prims:?}");
        // Schnitt längs der Achsen 1/2: nur die waagrechten Achsen A, B queren.
        let level = LevelSpec { kind: "section".into(), line: Some([v2(2.0, -1.0), v2(2.0, 9.0)]), ..Default::default() };
        let prims = grid_prims(&p, &level, [0.0, 0.0, 9.0, 6.0], 100.0);
        assert_eq!(texts(&prims), ["A", "B"]);
        assert!(union_bounds([0.0, 0.0, 9.0, 6.0], &prims)[3] > 6.0);
        // Ansicht von Süden (y = -3): Achsen 1, 2 stehen senkrecht zur Ebene und erscheinen an ihrer Lage.
        let level = LevelSpec { kind: "elevation".into(), line: Some([v2(-1.0, -3.0), v2(8.0, -3.0)]), ..Default::default() };
        let prims = grid_prims(&p, &level, [0.0, 0.0, 9.0, 6.0], 100.0);
        assert_eq!(texts(&prims), ["1", "2"]);
        // [140] In der Ansicht laufen die Achsen nicht über die Fassade; [157] nur der Stummel auf der Seite der Blase
        // (oben), keiner unten im Erdreich unter dem Terrain.
        let lines: Vec<(f64, f64)> = prims.iter().filter_map(|q| if let Primitive::Line { a, b, .. } = q { Some((a.y.min(b.y), a.y.max(b.y))) } else { None }).collect();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines.iter().all(|(lo, _)| *lo >= 6.0 - 1e-9), "{lines:?}");
        // Blase unten („nur Anfang"): Stummel unten.
        let mut q = p.clone();
        if let Drawing2DGeom::Grid { bubbles, .. } = &mut q.drawings2d[0].geom {
            *bubbles = Some(GridBubbles::Start);
        }
        let lines: Vec<(f64, f64)> = grid_prims(&q, &level, [0.0, 0.0, 9.0, 6.0], 100.0).iter().filter_map(|q| if let Primitive::Line { a, b, .. } = q { Some((a.y.min(b.y), a.y.max(b.y))) } else { None }).collect();
        assert!(lines.len() == 2 && lines.iter().all(|(_, hi)| *hi <= 1e-9), "{lines:?}");
    }
}
