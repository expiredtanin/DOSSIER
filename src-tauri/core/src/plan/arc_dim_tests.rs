//! [303] Bogenmasskette (Erker): Masszahlen laufen nicht in Masslinie, Massstriche und Hilfslinien — die Zahl steht mit
//! Abstand zur Linie zwischen den Begrenzungen, passt sie nicht, daneben (gleiche Logik wie bei geraden Ketten).

use super::domains::{Bounds, Ctx, PlanArgs};
use super::drawings::{plan_drawings, Keep, Out, Sink, Target};
use super::prim::Primitive;
use crate::model::{Project, Vec2};
use serde_json::json;

fn chain(offset: f64, deg: &[f64]) -> Project {
    let pts: Vec<_> = deg.iter().map(|a| json!({"x": 2.0 * a.to_radians().cos(), "y": 2.0 * a.to_radians().sin()})).collect();
    serde_json::from_value(json!({
        "id": "t", "name": "T", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
        "drawingLevels": [], "layers": [{"code": "81", "name": "Auto-Bemassung", "color": "#303038", "lw": 0.13, "visible": true, "locked": false}],
        "walls": [], "openings": [], "ceilings": [], "stairs": [], "rooms": [],
        "drawings2d": [{"id": "d", "type": "drawing2d", "levelId": "eg", "categoryCode": "81",
            "geom": {"shape": "dimension", "pts": pts, "offset": offset, "arcCenter": {"x": 0, "y": 0}}}],
        "context": []
    }))
    .unwrap()
}

fn prims(p: &Project) -> Vec<Primitive> {
    let a = PlanArgs::parse(1.0, &json!({"floor": "eg", "show": ["81"], "scale": 100}).to_string()).unwrap();
    let c = Ctx::new(p, &a);
    let mut out = Out::default();
    let mut b = Bounds::new();
    plan_drawings(&c, &mut Sink::new(Target::Vec(&mut out), Keep::All), &mut b).unwrap();
    out.prims
}

/// Liegt `q` im (um `m` aufgeweiteten) Kasten der Zahl?
fn in_box(q: Vec2, at: Vec2, s: &str, h: f64, angle: f64, m: f64) -> bool {
    let w = crate::text_layout::text_width_em(s, false) * h;
    let (c, si) = (angle.cos(), angle.sin());
    let (dx, dy) = (q.x - at.x, q.y - at.y);
    let (x, y) = (c * dx + si * dy, -si * dx + c * dy);
    x > -m && x < w + m && y > -m && y < 0.72 * h + m
}

fn hits(offset: f64, deg: &[f64]) -> Vec<String> {
    let ps = prims(&chain(offset, deg));
    let mut bad = Vec::new();
    let mut n = 0;
    for t in &ps {
        let Primitive::DrawingText { at, text, height_m, angle, .. } = t else { continue };
        n += 1;
        for l in &ps {
            let Primitive::Line { a, b, .. } = l else { continue };
            for k in 0..=40 {
                let f = k as f64 / 40.0;
                let q = Vec2 { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
                if in_box(q, *at, text, *height_m, *angle, 0.1 * height_m) {
                    bad.push(format!("Zahl {text} trifft Linie bei ({:.2}, {:.2})", q.x, q.y));
                    break;
                }
            }
        }
    }
    assert!(n > 0, "keine Masszahlen");
    bad
}

#[test]
fn bogenkette_zahlen_ohne_linien() {
    // Segmente 40° (1.40 m), 5° (0.17 m: Zahl passt nicht), 60° (2.09 m).
    for off in [0.5, -0.5] {
        let bad = hits(off, &[0.0, 40.0, 45.0, 105.0]);
        assert!(bad.is_empty(), "Offset {off}: {bad:?}");
    }
}

#[test]
fn bogenmass_einzelsegment_zahl_mit_abstand() {
    for off in [0.5, -0.5] {
        let bad = hits(off, &[0.0, 70.0]);
        assert!(bad.is_empty(), "Offset {off}: {bad:?}");
    }
}
