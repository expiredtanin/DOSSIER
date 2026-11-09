//! Polygon-Kennzahlen (Fläche, Umfang, Schwerpunkt) und Umriss-/Decken-Hilfen (normalisieren, Bounding-Box, Punkt-im-Umriss); gerufen von Raum- und Deckenlogik.
//! Teil von `kernel2d` (aus `lib.rs` aufgeteilt, [164]; `lib.rs` re-exportiert alles).

use crate::*;
use serde::{Deserialize, Serialize};

// --- Polygon-Kennzahlen (roomArea) -------------------------------------------

/// Absolute Polygonflaeche in m² (Port von `polygonArea`).
pub fn polygon_area(pts: &[Vec2]) -> f64 {
    signed_area(pts).abs()
}

/// Umfang eines geschlossenen Polygons (Summe aller Kantenlaengen, hypot).
pub fn perimeter(pts: &[Vec2]) -> f64 {
    let n = pts.len();
    if n < 2 {
        return 0.0;
    }
    let mut p = 0.0;
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        p += (b.x - a.x).hypot(b.y - a.y);
    }
    p
}

/// Flaechenschwerpunkt (momenten-gewichtet); degeneriert (|A|<1e-12) → Mittelwert.
pub fn centroid(pts: &[Vec2]) -> Vec2 {
    let n = pts.len();
    if n == 0 {
        return Vec2::new(0.0, 0.0);
    }
    if n < 3 {
        let (mut sx, mut sy) = (0.0, 0.0);
        for p in pts {
            sx += p.x;
            sy += p.y;
        }
        return Vec2::new(sx / n as f64, sy / n as f64);
    }
    let (mut a, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let p = pts[i];
        let q = pts[(i + 1) % n];
        let cr = p.x * q.y - q.x * p.y;
        a += cr;
        cx += (p.x + q.x) * cr;
        cy += (p.y + q.y) * cr;
    }
    a /= 2.0;
    if a.abs() < 1e-12 {
        let (mut sx, mut sy) = (0.0, 0.0);
        for p in pts {
            sx += p.x;
            sy += p.y;
        }
        return Vec2::new(sx / n as f64, sy / n as f64);
    }
    Vec2::new(cx / (6.0 * a), cy / (6.0 * a))
}

// --- Umriss-/Decken-Utilities (ceiling) --------------------------------------

/// Kleinste sinnvolle Deckenflaeche (m²) — darunter gilt der Umriss als entartet.
pub const MIN_CEILING_AREA: f64 = 1e-4;

/// Achsparallele Bounding-Box (serde camelCase: minX/minY/maxX/maxY wie TS).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BBox {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// Normalisiert einen Umriss: Dedup, schliessenden Duplikat-Endpunkt weg,
/// CCW erzwingen. None bei < 3 Restpunkten.
pub fn normalize_outline(pts: &[Vec2]) -> Option<Vec<Vec2>> {
    let mut clean: Vec<Vec2> = Vec::new();
    for &p in pts {
        if clean.is_empty() || !vec_equal(clean[clean.len() - 1], p, EPS) {
            clean.push(p);
        }
    }
    if clean.len() > 1 && vec_equal(clean[0], clean[clean.len() - 1], EPS) {
        clean.pop();
    }
    if clean.len() < 3 {
        return None;
    }
    if is_ccw(&clean) {
        Some(clean)
    } else {
        clean.reverse();
        Some(clean)
    }
}

/// Fläche eines Deckenumrisses in m² (immer positiv).
pub fn ceiling_area(pts: &[Vec2]) -> f64 {
    signed_area(pts).abs()
}

/// Ob ein Umriss ein gueltiges (nicht entartetes) Deckenpolygon bildet.
pub fn is_valid_outline(pts: &[Vec2]) -> bool {
    match normalize_outline(pts) {
        Some(norm) => ceiling_area(&norm) >= MIN_CEILING_AREA,
        None => false,
    }
}

/// Achsparallele Bounding-Box; leer/entartet → Null-Box.
pub fn outline_bbox(pts: &[Vec2]) -> BBox {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in pts {
        min_x = min_x.min(p.x);
        min_y = min_y.min(p.y);
        max_x = max_x.max(p.x);
        max_y = max_y.max(p.y);
    }
    if !min_x.is_finite() {
        return BBox { min_x: 0.0, min_y: 0.0, max_x: 0.0, max_y: 0.0 };
    }
    BBox { min_x, min_y, max_x, max_y }
}

/// Schwerpunkt des Umriss-Polygons (ceiling-Variante: f = 1/(6·signedArea)).
pub fn outline_centroid(pts: &[Vec2]) -> Vec2 {
    let a = signed_area(pts);
    if a.abs() < 1e-12 {
        let (mut sx, mut sy) = (0.0, 0.0);
        for p in pts {
            sx += p.x;
            sy += p.y;
        }
        let n = if pts.is_empty() { 1.0 } else { pts.len() as f64 };
        return Vec2::new(sx / n, sy / n);
    }
    let (mut cx, mut cy) = (0.0, 0.0);
    let n = pts.len();
    for i in 0..n {
        let p = pts[i];
        let q = pts[(i + 1) % n];
        let cr = p.x * q.y - q.x * p.y;
        cx += (p.x + q.x) * cr;
        cy += (p.y + q.y) * cr;
    }
    let f = 1.0 / (6.0 * a);
    Vec2::new(cx * f, cy * f)
}

/// Punkt-in-Polygon (Ray-Casting) fuer einen geschlossenen Umriss. Der TS-Guard
/// `(b.y-a.y || 1e-12)` wird exakt nachgebildet (Null-Nenner → 1e-12).
pub fn point_in_outline(p: Vec2, outline: &[Vec2]) -> bool {
    let n = outline.len();
    if n == 0 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let a = outline[i];
        let b = outline[j];
        let denom = if b.y - a.y == 0.0 { 1e-12 } else { b.y - a.y };
        let intersect =
            (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / denom + a.x;
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}
