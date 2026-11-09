//! Vec2 und die Vektor-Grundlagen (sub/add/scale/len/normalize/cross/dot, Geradenschnitt, Abstand) samt EPS; Grundlage aller anderen Module von `kernel2d`.
//! Teil von `kernel2d` (aus `lib.rs` aufgeteilt, [164]; `lib.rs` re-exportiert alles).

use serde::{Deserialize, Serialize};

/// EPS aus kernel2d.ts (Primitive/Schnitt/Trim). ACHTUNG: `lineIntersect`
/// benutzt bewusst ein ANDERES, hartkodiertes 1e-9 — nicht dieses EPS.
pub const EPS: f64 = 1e-7;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const fn new(x: f64, y: f64) -> Self {
        Vec2 { x, y }
    }
}

// --- Vektor-Helfer: 1:1-Port aus src/model/geometry.ts -----------------------

#[inline]
pub fn sub(a: Vec2, b: Vec2) -> Vec2 {
    Vec2 { x: a.x - b.x, y: a.y - b.y }
}

#[inline]
pub fn add(a: Vec2, b: Vec2) -> Vec2 {
    Vec2 { x: a.x + b.x, y: a.y + b.y }
}

#[inline]
pub fn scale(a: Vec2, s: f64) -> Vec2 {
    Vec2 { x: a.x * s, y: a.y * s }
}

/// `len` = `Math.hypot` → `f64::hypot` (NICHT sqrt(x²+y²), siehe §6).
#[inline]
pub fn len(a: Vec2) -> f64 {
    a.x.hypot(a.y)
}

/// Null-Guard wie TS `len(a) || 1`: bei Laenge 0 → Divisor 1 (Ergebnis {0,0}).
#[inline]
pub fn normalize(a: Vec2) -> Vec2 {
    let l = len(a);
    let l = if l == 0.0 { 1.0 } else { l };
    Vec2 { x: a.x / l, y: a.y / l }
}

/// Linke Normale (90° gegen den Uhrzeigersinn gedreht).
#[inline]
pub fn left_normal(a: Vec2) -> Vec2 {
    Vec2 { x: -a.y, y: a.x }
}

/// Kreuzprodukt (Z-Komponente). Term-Reihenfolge exakt wie TS: `p.x*q.y - p.y*q.x`.
#[inline]
pub fn cross(p: Vec2, q: Vec2) -> f64 {
    p.x * q.y - p.y * q.x
}

/// Skalarprodukt. Term-Reihenfolge exakt wie TS: `p.x*q.x + p.y*q.y`.
#[inline]
pub fn dot(p: Vec2, q: Vec2) -> f64 {
    p.x * q.x + p.y * q.y
}

/// Schnittpunkt der Geraden (a + t·da) mit (b + s·db). None bei (nahezu)
/// parallelen Richtungen. HARTKODIERTES 1e-9 (nicht EPS!) — der Offset-Miter-
/// Fallback haengt an genau dieser Schwelle (§6).
pub fn line_intersect(a: Vec2, da: Vec2, b: Vec2, db: Vec2) -> Option<Vec2> {
    let denom = cross(da, db);
    if denom.abs() < 1e-9 {
        return None; // parallel → kein Schnitt
    }
    let t = cross(sub(b, a), db) / denom;
    Some(add(a, scale(da, t)))
}

/// Abstand zweier Punkte (= `len(sub(a,b))`, hypot-basiert).
#[inline]
pub fn dist(a: Vec2, b: Vec2) -> f64 {
    len(sub(a, b))
}

/// Punkt-Gleichheit innerhalb Toleranz (Port von `vecEqual`, Default-eps = EPS).
pub fn vec_equal(a: Vec2, b: Vec2, eps: f64) -> bool {
    (a.x - b.x).abs() <= eps && (a.y - b.y).abs() <= eps
}
