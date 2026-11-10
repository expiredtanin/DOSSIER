//! Zauberstab ([77]): Klick in eine von Linien umschlossene Fläche → ihr Umriss. Grundlage sind dieselben
//! Strecken wie beim Fang (`snap_model`: 2D-Zeichnungen und Modell-Kanten des Geschosses, Kreise/Bögen als
//! Sehnenzüge), daraus der planare Graph und die kleinste Masche um den Punkt (`kernel2d`,
//! `room_from_point_inside_faces`, wie die Raumerkennung aus Wandflächen).
//!
//! Inseln: geschlossene Formen ganz in der Masche, die ihren Rand nicht berühren (eigene Zusammenhangs-
//! komponente des Graphen, z. B. Stütze im Raum), werden Löcher (wie Schraffur-Inseln in CAD). Nur die
//! äussersten: eine Insel im Loch einer Insel bleibt unberücksichtigt. Eine Form, die den Rand berührt,
//! gehört zum Graphen der Masche und formt deren Umriss selbst.

use crate::model::Project;
use crate::snap_model::Circle;
use kernel2d::{Vec2, WallFace};
use std::collections::HashSet;

/// Lücken bis zu dieser Weite (m) gelten als geschlossen.
const GAP_TOL: f64 = 1e-3;
/// Schutz vor quadratischem Aufwand (Kataster mit zehntausenden Linien).
const MAX_SEGMENTS: usize = 20_000;
/// Sehnen je Vollkreis.
const CIRCLE_STEPS: usize = 64;

fn arc_segments(c: &Circle, out: &mut Vec<[f64; 4]>) {
    let (a0, a1) = c.arc.unwrap_or((0.0, std::f64::consts::TAU));
    let mut span = a1 - a0;
    while span <= 0.0 {
        span += std::f64::consts::TAU;
    }
    let n = ((span / std::f64::consts::TAU) * CIRCLE_STEPS as f64).ceil().max(2.0) as usize;
    let pt = |t: f64| (c.cx + c.r * crate::jsnum::cos(t), c.cy + c.r * crate::jsnum::sin(t));
    let mut prev = pt(a0);
    for i in 1..=n {
        let q = pt(a0 + span * i as f64 / n as f64);
        out.push([prev.0, prev.1, q.0, q.1]);
        prev = q;
    }
}

/// Gefundene Fläche: Umriss (gegen den Uhrzeigersinn) und Inseln (im Uhrzeigersinn).
#[derive(Debug, Clone, PartialEq)]
pub struct Region {
    pub outer: Vec<(f64, f64)>,
    pub holes: Vec<Vec<(f64, f64)>>,
}

/// Kleinste geschlossene Fläche um `at` auf dem Geschoss `level` samt Inseln;
/// `None`, wenn der Punkt in keiner geschlossenen Masche liegt.
pub fn region_at(p: &Project, level: &str, at: (f64, f64)) -> Option<Region> {
    if !(at.0.is_finite() && at.1.is_finite()) {
        return None;
    }
    // Alle Kategorien (auch ausgeblendete Ebenen zählen als Begrenzung, wie beim Schraffieren in CAD).
    let mut codes: HashSet<String> = p.drawings2d.iter().map(|d| d.category_code.clone()).collect();
    codes.extend(p.walls.iter().map(|w| w.category_code.clone()));
    let skip = HashSet::new();
    let mut segs: Vec<[f64; 4]> = Vec::new();
    for part in [crate::snap_model::collect_drawings(p, level, &codes, &skip), crate::snap_model::collect_model(p, level, &codes, &skip)] {
        segs.extend(part.segs.segs.iter().copied());
        for c in &part.circles {
            arc_segments(c, &mut segs);
        }
    }
    segs.retain(|s| s.iter().all(|v| v.is_finite()) && (s[0] - s[2]).abs() + (s[1] - s[3]).abs() > 1e-9);
    if segs.len() < 3 || segs.len() > MAX_SEGMENTS {
        return None;
    }
    let faces: Vec<WallFace> = segs.iter().map(|s| WallFace { a: Vec2::new(s[0], s[1]), b: Vec2::new(s[2], s[3]) }).collect();
    let (ring, holes) = kernel2d::region_with_islands(Vec2::new(at.0, at.1), &faces, GAP_TOL)?;
    let pl = |r: &[Vec2]| r.iter().map(|q| (q.x, q.y)).collect::<Vec<_>>();
    (ring.len() >= 3).then(|| Region { outer: pl(&ring), holes: holes.iter().filter(|h| h.len() >= 3).map(|h| pl(h)).collect() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(drawings: serde_json::Value) -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [],
            "openings": [], "walls": [], "drawingLevels": [{"id": "L", "name": "L", "kind": "floor", "visible": true, "locked": false}],
            "drawings2d": drawings
        }))
        .unwrap()
    }

    fn line(id: &str, a: (f64, f64), b: (f64, f64)) -> serde_json::Value {
        serde_json::json!({"id": id, "levelId": "L", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": a.0, "y": a.1}, "b": {"x": b.0, "y": b.1}}})
    }

    fn area(r: &[(f64, f64)]) -> f64 {
        r.iter().enumerate().map(|(i, a)| { let c = r[(i + 1) % r.len()]; a.0 * c.1 - c.0 * a.1 }).sum::<f64>() / 2.0
    }

    /// Vier Linien, die sich über die Ecken hinaus kreuzen, und eine Teilungslinie: der Klick findet die
    /// richtige Hälfte; ausserhalb nichts.
    #[test]
    fn masche_um_den_punkt() {
        let p = project(serde_json::json!([
            line("a", (-1.0, 0.0), (5.0, 0.0)), line("b", (4.0, -1.0), (4.0, 4.0)), line("c", (5.0, 3.0), (-1.0, 3.0)),
            line("d", (0.0, 4.0), (0.0, -1.0)), line("e", (2.0, 0.0), (2.0, 3.0))
        ]));
        let r = region_at(&p, "L", (1.0, 1.0)).unwrap().outer;
        assert!((area(&r) - 6.0).abs() < 1e-9, "{r:?}");
        let r = region_at(&p, "L", (3.0, 2.0)).unwrap().outer;
        assert!((area(&r) - 6.0).abs() < 1e-9);
        assert!(region_at(&p, "L", (10.0, 10.0)).is_none());
        assert!(region_at(&p, "L", (f64::NAN, 0.0)).is_none());
    }

    /// Befehl `wand`: geschlossene Polylinie mit Schraffur um die Masche; ausserhalb keine Ops.
    #[test]
    fn befehl_erzeugt_schraffur() {
        let p = project(serde_json::json!([
            line("a", (0.0, 0.0), (2.0, 0.0)), line("b", (2.0, 0.0), (2.0, 2.0)), line("c", (2.0, 2.0), (0.0, 2.0)), line("d", (0.0, 2.0), (0.0, 0.0))
        ]));
        let root = serde_json::to_value(&p).unwrap();
        let root = root.as_object().unwrap();
        let v = serde_json::json!({"cmd": "wand", "at": {"x": 1, "y": 1}, "hatchId": "h1", "stamp": "s", "ctx": {"level": "L", "cat": "20"}});
        let ops = crate::cmd_create::ops(root, &p, &v).unwrap();
        let item = &ops[0].to_json()["items"][0];
        assert_eq!(item["geom"]["shape"], "polyline");
        assert_eq!(item["geom"]["closed"], true);
        assert_eq!(item["hatchId"], "h1");
        assert_eq!(item["geom"]["pts"].as_array().unwrap().len(), 4);
        let out = serde_json::json!({"cmd": "wand", "at": {"x": 9, "y": 9}, "stamp": "s", "ctx": {"level": "L", "cat": "20"}});
        assert!(crate::cmd_create::ops(root, &p, &out).unwrap().is_empty());
    }

    fn rect(id: &str, a: (f64, f64), b: (f64, f64)) -> Vec<serde_json::Value> {
        let c = [a, (b.0, a.1), b, (a.0, b.1)];
        (0..4).map(|i| line(&format!("{id}{i}"), c[i], c[(i + 1) % 4])).collect()
    }

    /// [77] Inseln: Raum aus Linien mit quadratischer Stütze und runder Stütze darin → Umriss + 2 Löcher;
    /// ein Quadrat in der Stütze (Insel in der Insel) zählt nicht; ein Quadrat am Rand formt den Umriss.
    #[test]
    fn inseln_werden_loecher() {
        let mut d = rect("r", (0.0, 0.0), (10.0, 6.0));
        d.extend(rect("s", (2.0, 2.0), (3.0, 3.0)));
        d.extend(rect("t", (2.3, 2.3), (2.7, 2.7)));
        d.push(serde_json::json!({"id": "k", "levelId": "L", "categoryCode": "20", "geom": {"shape": "circle", "center": {"x": 6, "y": 3}, "r": 0.5}}));
        // Am Rand: Nische (berührt die rechte Kante).
        d.extend(rect("n", (9.0, 4.0), (10.0, 5.0)));
        let p = project(serde_json::Value::Array(d));
        let r = region_at(&p, "L", (1.0, 1.0)).unwrap();
        assert_eq!(r.holes.len(), 2, "{:?}", r.holes);
        // Umriss ohne Nische: 60 - 1; Löcher im Uhrzeigersinn.
        assert!((area(&r.outer) - 59.0).abs() < 1e-9, "{}", area(&r.outer));
        let ha: f64 = r.holes.iter().map(|h| area(h)).sum();
        assert!((ha + 1.0 + std::f64::consts::PI * 0.25).abs() < 0.01, "{ha}");
        // Klick in die Stütze: deren Ring mit dem inneren Quadrat als Loch.
        let s = region_at(&p, "L", (2.1, 2.1)).unwrap();
        assert!((area(&s.outer) - 1.0).abs() < 1e-9);
        assert_eq!(s.holes.len(), 1);
        // Befehl schreibt `holes`.
        let root = serde_json::to_value(&p).unwrap();
        let v = serde_json::json!({"cmd": "wand", "at": {"x": 1, "y": 1}, "stamp": "s", "ctx": {"level": "L", "cat": "20"}});
        let ops = crate::cmd_create::ops(root.as_object().unwrap(), &p, &v).unwrap();
        let item = &ops[0].to_json()["items"][0];
        assert_eq!(item["geom"]["holes"].as_array().unwrap().len(), 2);
        // Ohne Inseln kein Feld.
        let q = project(serde_json::Value::Array(rect("r", (0.0, 0.0), (2.0, 2.0))));
        let root = serde_json::to_value(&q).unwrap();
        let ops = crate::cmd_create::ops(root.as_object().unwrap(), &q, &v).unwrap();
        assert!(ops[0].to_json()["items"][0]["geom"].get("holes").is_none());
    }

    /// Kreis als Begrenzung (Sehnenzug).
    #[test]
    fn kreis_als_rand() {
        let p = project(serde_json::json!([{"id": "k", "levelId": "L", "categoryCode": "20", "geom": {"shape": "circle", "center": {"x": 0, "y": 0}, "r": 1}}]));
        let r = region_at(&p, "L", (0.1, 0.1)).unwrap().outer;
        assert!((area(&r) - std::f64::consts::PI).abs() < 0.01, "{}", area(&r));
    }

    /// [77] Spline (geschlossen) als Begrenzung: tesselliert wie beim Fang.
    #[test]
    fn spline_als_rand() {
        let pts: Vec<_> = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)].iter().map(|p| serde_json::json!({"x": p.0, "y": p.1})).collect();
        let p = project(serde_json::json!([{"id": "s", "levelId": "L", "categoryCode": "20", "geom": {"shape": "spline", "pts": pts, "closed": true}}]));
        let r = region_at(&p, "L", (1.0, 1.0)).unwrap().outer;
        assert!(area(&r) > 3.5 && area(&r) < 7.0, "{}", area(&r));
        // Offene Spline + Linie schliessen eine Fläche.
        let pts: Vec<_> = [(0.0, 0.0), (1.0, 1.0), (2.0, 0.0)].iter().map(|p| serde_json::json!({"x": p.0, "y": p.1})).collect();
        let p = project(serde_json::json!([
            {"id": "s", "levelId": "L", "categoryCode": "20", "geom": {"shape": "spline", "pts": pts, "closed": false}},
            line("l", (0.0, 0.0), (2.0, 0.0))
        ]));
        let r = region_at(&p, "L", (1.0, 0.3)).unwrap().outer;
        assert!(area(&r) > 0.8 && area(&r) < 2.0, "{}", area(&r));
    }
}
