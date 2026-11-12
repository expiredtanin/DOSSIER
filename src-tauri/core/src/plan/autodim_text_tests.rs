//! [199] Masszahlen der automatischen Aussenbemassung überdecken sich nicht — weder untereinander (auch nicht
//! zwischen den Ketten einer Seite) noch mit den Hilfslinien/Masslinien einer anderen Kette. Beide Musterhäuser
//! (komplex: Ketten aus `tests/fixtures/autodim_musterhaus_komplex.json` = `autodim` 1:100 von UG/EG/OG; einfach:
//! `autodim` auf `sample_project.json`) in 1:200, 1:100 und 1:50.

use super::domains::{Bounds, Ctx};
use super::domains::PlanArgs;
use super::drawings::{plan_drawings, Keep, Out, Sink, Target};
use super::prim::Primitive;
use crate::model::{Project, Vec2};
use serde_json::{json, Value};

type Quad = [Vec2; 4];

fn project_with(drawings: Vec<Value>) -> Project {
    serde_json::from_value(json!({
        "id": "t", "name": "T", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
        "drawingLevels": [], "layers": [{"code": "81", "name": "Auto-Bemassung", "color": "#303038", "lw": 0.13, "visible": true, "locked": false}],
        "walls": [], "openings": [], "ceilings": [], "stairs": [], "rooms": [], "drawings2d": drawings, "context": []
    }))
    .unwrap()
}

fn komplex() -> Vec<Value> {
    serde_json::from_str(include_str!("../../tests/fixtures/autodim_musterhaus_komplex.json")).unwrap()
}

/// Einfaches Musterhaus: Aussenbemassung über den Befehl (1:100) aller Geschosse.
fn einfach() -> (Vec<Value>, Vec<String>) {
    let r: serde_json::Map<String, Value> = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
    let levels: Vec<String> = r["drawingLevels"].as_array().unwrap().iter().filter_map(|l| l["id"].as_str().map(String::from)).collect();
    let mut all = Vec::new();
    for l in &levels {
        let mut dims = crate::cmd_autodim_tests::added(&crate::cmd_autodim_tests::run(&r, l, 100.0));
        for d in &mut dims {
            d["categoryCode"] = json!("81");
        }
        all.extend(dims);
    }
    // Nur Geschosse mit Ketten (Schnitt-/Ansichtsebenen bekommen keine).
    let levels = levels.into_iter().filter(|l| all.iter().any(|d| d["levelId"] == json!(l))).collect();
    (all, levels)
}

fn draw(p: &Project, level: &str, scale: f64) -> Vec<Primitive> {
    let a = PlanArgs::parse(1.0, &json!({"floor": level, "show": ["81"], "scale": scale}).to_string()).unwrap();
    let c = Ctx::new(p, &a);
    let mut out = Out::default();
    let mut b = Bounds::new();
    plan_drawings(&c, &mut Sink::new(Target::Vec(&mut out), Keep::All), &mut b).unwrap();
    out.prims
}

/// Kasten einer Masszahl (Anfang = linke Grundlinie, Versalhöhe der Ziffern 0.72 Schrifthöhe).
fn text_box(at: Vec2, s: &str, h: f64, angle: f64) -> Quad {
    let w = crate::text_layout::text_width_em(s, false) * h;
    let (c, si) = (angle.cos(), angle.sin());
    let p = |x: f64, y: f64| Vec2 { x: at.x + c * x - si * y, y: at.y + si * x + c * y };
    [p(0.0, 0.0), p(w, 0.0), p(w, 0.72 * h), p(0.0, 0.72 * h)]
}

/// Überdecken sich zwei konvexe Vierecke (echt, mehr als `eps`)? Trennachsen.
fn quads_overlap(a: &Quad, b: &Quad, eps: f64) -> bool {
    for q in [a, b] {
        for i in 0..4 {
            let (p0, p1) = (q[i], q[(i + 1) % 4]);
            let n = (-(p1.y - p0.y), p1.x - p0.x);
            let l = (n.0 * n.0 + n.1 * n.1).sqrt();
            if l < 1e-12 {
                continue;
            }
            let pr = |v: &Vec2| (v.x * n.0 + v.y * n.1) / l;
            let (a0, a1) = a.iter().map(pr).fold((f64::INFINITY, f64::NEG_INFINITY), |m, x| (m.0.min(x), m.1.max(x)));
            let (b0, b1) = b.iter().map(pr).fold((f64::INFINITY, f64::NEG_INFINITY), |m, x| (m.0.min(x), m.1.max(x)));
            if a1 <= b0 + eps || b1 <= a0 + eps {
                return false;
            }
        }
    }
    true
}

fn seg_quad(a: Vec2, b: Vec2, q: &Quad, eps: f64) -> bool {
    quads_overlap(&[a, b, b, a], q, eps)
}

/// Gerade Kette (kein Bogen-/Radiusmass)?
fn straight(id: &str) -> bool {
    !id.contains("-arc-") && !id.contains("-radius-")
}

/// Kette ohne letzte Stelle: `autodim-eg-north-steps` → `autodim-eg-north`.
fn side(id: &str) -> &str {
    id.rsplit_once('-').map_or(id, |x| x.0)
}

/// Befunde eines Geschosses: überdeckte Zahlen (Paare) und Zahlen auf Linien einer anderen Kette.
fn findings(p: &Project, level: &str, scale: f64) -> Vec<String> {
    let prims = draw(p, level, scale);
    let eps = 0.05 * scale / 1000.0; // 0.05 mm Papier
    let texts: Vec<(String, String, Quad)> = prims
        .iter()
        .filter_map(|q| match q {
            Primitive::DrawingText { at, text, height_m, angle, drawing_id: Some(id), .. } if id.starts_with("autodim-") => Some((id.clone(), text.clone(), text_box(*at, text, *height_m, *angle))),
            _ => None,
        })
        .collect();
    let lines: Vec<(String, Vec2, Vec2)> = prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Line { a, b, drawing_id: Some(id), .. } if id.starts_with("autodim-") && straight(id) => Some((id.clone(), *a, *b)),
            _ => None,
        })
        .collect();
    assert!(!texts.is_empty(), "{level}: keine Masszahlen");
    let mut bad = Vec::new();
    for (i, (ia, ta, qa)) in texts.iter().enumerate() {
        for (ib, tb, qb) in &texts[i + 1..] {
            if quads_overlap(qa, qb, eps) {
                bad.push(format!("{level} 1:{scale}: „{ta}“ ({ia}) auf „{tb}“ ({ib})"));
            }
        }
        if !straight(ia) {
            continue;
        }
        // Linien einer anderen Kette derselben Seite (Hilfslinien laufen durch die inneren Ketten).
        for (il, a, b) in &lines {
            if il != ia && side(il) == side(ia) && seg_quad(*a, *b, qa, eps) {
                bad.push(format!("{level} 1:{scale}: „{ta}“ ({ia}) auf Linie von {il}"));
                break;
            }
        }
    }
    bad
}

#[test]
fn masszahlen_aussenbemassung_ueberdecken_sich_nicht() {
    let levels = ["ug", "eg", "og"];
    let p = project_with(komplex());
    let (dims, lv) = einfach();
    let q = project_with(dims);
    let mut bad = Vec::new();
    for scale in [200.0, 100.0, 50.0] {
        for l in levels {
            bad.extend(findings(&p, l, scale));
        }
        for l in &lv {
            bad.extend(findings(&q, l, scale).into_iter().map(|s| format!("einfach {s}")));
        }
    }
    assert!(bad.is_empty(), "{} Überdeckungen:\n{}", bad.len(), bad.join("\n"));
}

/// Kettenabstand mindestens 7 mm Papier (wie `autodim` bei 1:100): bei 1:200 rücken die äusseren Ketten hinaus,
/// bei 1:100/1:50 bleiben sie, wo sie gespeichert sind.
#[test]
fn kettenabstand_in_papier_mm() {
    let p = project_with(komplex());
    // Lage der Masslinie je Kette = y der waagrechten Masslinie (Nord: oben).
    let line_y = |scale: f64, id: &str| -> f64 {
        let prims = draw(&p, "eg", scale);
        prims
            .iter()
            .filter_map(|q| match q {
                Primitive::Line { a, b, drawing_id: Some(d), .. } if d == id && (a.y - b.y).abs() < 1e-9 && (a.x - b.x).abs() > 0.5 => Some(a.y),
                _ => None,
            })
            .next()
            .unwrap()
    };
    let ids = ["autodim-eg-north-openings", "autodim-eg-north-steps", "autodim-eg-north-total"];
    for scale in [100.0, 50.0] {
        let y: Vec<f64> = ids.iter().map(|i| line_y(scale, i)).collect();
        assert!(((y[1] - y[0]).abs() - 0.7).abs() < 1e-6 && ((y[2] - y[1]).abs() - 0.7).abs() < 1e-6, "1:{scale} unverändert: {y:?}");
    }
    let y: Vec<f64> = ids.iter().map(|i| line_y(200.0, i)).collect();
    assert!(((y[1] - y[0]).abs() - 1.4).abs() < 1e-6 && ((y[2] - y[1]).abs() - 1.4).abs() < 1e-6, "1:200 7 mm: {y:?}");
    assert!((y[0] - line_y(100.0, ids[0])).abs() < 1e-9, "innerste bleibt");
}

/// Kurzes Segment neben der Hilfslinie einer äusseren Kette, die keinen Punkt der inneren trifft: die Zahl weicht
/// auf die freie Seite aus statt auf die Hilfslinie.
#[test]
fn ausweichende_zahl_nicht_auf_hilfslinie() {
    let chain = |id: &str, xs: &[f64], off: f64| {
        json!({"id": id, "type": "drawing2d", "levelId": "eg", "categoryCode": "81", "geom": {"shape": "dimension",
            "pts": xs.iter().map(|x| json!({"x": x, "y": 0.0})).collect::<Vec<_>>(), "offset": off}})
    };
    let p = project_with(vec![chain("autodim-eg-north-openings", &[0.0, 5.0, 5.5, 10.0], 1.0), chain("autodim-eg-north-total", &[0.0, 4.8, 10.0], 1.7)]);
    for scale in [100.0, 200.0] {
        let bad = findings(&p, "eg", scale);
        assert!(bad.is_empty(), "{bad:?}");
    }
}
