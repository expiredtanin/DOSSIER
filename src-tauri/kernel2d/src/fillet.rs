//! Eck-Verrundung (Fillet), Fase (Chamfer) und Tangente-Tangente-Radius-Kreise; gerufen von den Zeichenbefehlen über `dossier-core`.
//! Teil von `kernel2d` (aus `lib.rs` aufgeteilt, [164]; `lib.rs` re-exportiert alles).

use crate::*;
use serde::{Deserialize, Serialize};

// --- Fillet (Eck-Verrundung) -------------------------------------------------

/// Ergebnis einer Eck-Verrundung (Port von `Fillet`). serde-camelCase, damit die
/// JSON-Keys (`tangentA`/`startAngle` …) exakt der TS-Referenz entsprechen.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fillet {
    pub center: Vec2,
    pub radius: f64,
    /// Tangentenpunkt auf dem ersten Schenkel (corner→p1).
    pub tangent_a: Vec2,
    /// Tangentenpunkt auf dem zweiten Schenkel (corner→p2).
    pub tangent_b: Vec2,
    pub start_angle: f64,
    pub end_angle: f64,
}

/// Verrundet die Ecke bei `corner` (Schenkel corner→p1, corner→p2) mit Radius r.
/// None bei (nahezu) kollinearen/zu kurzen Schenkeln. Transzendente Kette
/// (`acos/tan/sin/atan2`) — libm nativ↔wasm↔JS driftet um letzte ULP, daher im
/// Diff-Test Winkel-Epsilon 1e-7 rad (Struktur/None-Entscheidung bleibt exakt).
pub fn fillet_corner(corner: Vec2, p1: Vec2, p2: Vec2, r: f64) -> Option<Fillet> {
    let u1 = normalize(sub(p1, corner));
    let u2 = normalize(sub(p2, corner));
    // Klemm-Reihenfolge wie TS `Math.max(-1, Math.min(1, dot))`.
    let cos_theta = dot(u1, u2).min(1.0).max(-1.0);
    let theta = cos_theta.acos();
    if theta < 1e-4 || std::f64::consts::PI - theta < 1e-4 {
        return None; // kollinear
    }
    let tan_half = (theta / 2.0).tan();
    if tan_half < EPS {
        return None;
    }
    let setback = r / tan_half;
    if setback > len(sub(p1, corner)) + EPS || setback > len(sub(p2, corner)) + EPS {
        return None;
    }
    let tangent_a = add(corner, scale(u1, setback));
    let tangent_b = add(corner, scale(u2, setback));
    let bis = normalize(add(u1, u2));
    let center_dist = r / (theta / 2.0).sin();
    let center = add(corner, scale(bis, center_dist));
    let start_angle = (tangent_a.y - center.y).atan2(tangent_a.x - center.x);
    let end_angle = (tangent_b.y - center.y).atan2(tangent_b.x - center.x);
    Some(Fillet {
        center,
        radius: r,
        tangent_a,
        tangent_b,
        start_angle,
        end_angle,
    })
}

/// Ergebnis einer Eck-Fasung: Punkte auf den beiden Schenkeln.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Chamfer {
    /// Punkt auf corner→p1 im Abstand `distance` vom Eck.
    pub a: Vec2,
    /// Punkt auf corner→p2 im Abstand `distance` vom Eck.
    pub b: Vec2,
}

/// Gleichabstands-Fase der Ecke bei `corner` (Schenkel corner→p1, corner→p2).
/// None bei (nahezu) kollinearen Schenkeln oder `distance` länger als ein Schenkel.
pub fn chamfer_corner(corner: Vec2, p1: Vec2, p2: Vec2, distance: f64) -> Option<Chamfer> {
    let u1 = normalize(sub(p1, corner));
    let u2 = normalize(sub(p2, corner));
    let cos_theta = dot(u1, u2).min(1.0).max(-1.0);
    let theta = cos_theta.acos();
    if theta < 1e-4 || std::f64::consts::PI - theta < 1e-4 {
        return None; // kollinear
    }
    if distance > len(sub(p1, corner)) + EPS || distance > len(sub(p2, corner)) + EPS {
        return None;
    }
    Some(Chamfer { a: add(corner, scale(u1, distance)), b: add(corner, scale(u2, distance)) })
}

// --- Tangente-Tangente-Radius --------------------------------------------------

/// Tangentialobjekt: Gerade durch a/b (unendlich gedacht) oder Kreis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TangentTarget {
    Line { a: Vec2, b: Vec2 },
    Circle { center: Vec2, r: f64 },
}

/// Ort aller Mittelpunkte von Kreisen mit Radius `r`, die `t` berühren
/// (Gerade: beide Seiten; Kreis: äussere und — falls nicht entartet — innere Berührung).
fn tangent_loci(t: TangentTarget, r: f64) -> Vec<TangentTarget> {
    match t {
        TangentTarget::Line { a, b } => {
            let (a1, b1) = offset_segment(a, b, r);
            let (a2, b2) = offset_segment(a, b, -r);
            vec![TangentTarget::Line { a: a1, b: b1 }, TangentTarget::Line { a: a2, b: b2 }]
        }
        TangentTarget::Circle { center, r: tr } => {
            let mut out = vec![TangentTarget::Circle { center, r: tr + r }];
            let inner = (tr - r).abs();
            if inner > EPS {
                out.push(TangentTarget::Circle { center, r: inner });
            }
            out
        }
    }
}

fn intersect_loci(l1: TangentTarget, l2: TangentTarget) -> Vec<Vec2> {
    use TangentTarget::*;
    match (l1, l2) {
        (Line { a: a1, b: b1 }, Line { a: a2, b: b2 }) => {
            line_intersect(a1, sub(b1, a1), a2, sub(b2, a2)).into_iter().collect()
        }
        (Line { a, b }, Circle { center, r }) | (Circle { center, r }, Line { a, b }) => {
            line_circle_intersect(a, b, center, r)
        }
        (Circle { center: c1, r: r1 }, Circle { center: c2, r: r2 }) => circle_circle_intersect(c1, r1, c2, r2),
    }
}

/// Alle Mittelpunkt-Kandidaten eines Kreises mit Radius `r`, der `t1` UND `t2`
/// berührt (TTR). Unsortiert/undedupliziert; der Aufrufer wählt per Referenzpunkt.
pub fn tangent_circle_centers(t1: TangentTarget, t2: TangentTarget, r: f64) -> Vec<Vec2> {
    let mut out = Vec::new();
    for l1 in tangent_loci(t1, r) {
        for l2 in tangent_loci(t2, r) {
            out.extend(intersect_loci(l1, l2));
        }
    }
    out
}
