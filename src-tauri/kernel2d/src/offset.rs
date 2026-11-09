//! Polygon-Fläche und Wicklung sowie Versatz (Offset) von Strecken und Polylinien; gerufen von `bulge` und den Bindungen in `dossier-core`.
//! Teil von `kernel2d` (aus `lib.rs` aufgeteilt, [164]; `lib.rs` re-exportiert alles).

use crate::*;

// --- Polygon-Flaeche / Wicklung ----------------------------------------------

/// Vorzeichenbehaftete Polygonflaeche (Shoelace); >0 = CCW, <0 = CW.
/// Summierung in identischer Vertex-Reihenfolge (f64 nicht assoziativ).
pub fn signed_area(pts: &[Vec2]) -> f64 {
    let n = pts.len();
    if n == 0 {
        return 0.0;
    }
    let mut s = 0.0;
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        s += a.x * b.y - b.x * a.y;
    }
    s / 2.0
}

/// Ob ein Polygonzug gegen den Uhrzeigersinn (CCW) gewickelt ist.
pub fn is_ccw(pts: &[Vec2]) -> bool {
    signed_area(pts) > 0.0
}

// --- Offset ------------------------------------------------------------------

/// Offset einer einzelnen Strecke um `d` (links positiv).
pub fn offset_segment(a: Vec2, b: Vec2, d: f64) -> (Vec2, Vec2) {
    let n = left_normal(normalize(sub(b, a)));
    let off = scale(n, d);
    (add(a, off), add(b, off))
}

/// Offset einer Polylinie um `d` (links positiv) mit GEHRUNG (miter). Bei
/// (nahezu) parallelen Nachbarkanten faellt `line_intersect` (Schwelle 1e-9)
/// auf den verschobenen Endpunkt zurueck — dieser geometrische Sprung MUSS an
/// exakt 1e-9 haengen (nicht EPS). Selbstschnitte werden NICHT geheilt (wie TS).
pub fn offset_polyline(pts: &[Vec2], d: f64, closed: bool) -> Vec<Vec2> {
    // Auf signifikante Kanten reduzieren (Duplikate verwerfen).
    let mut clean: Vec<Vec2> = Vec::new();
    for &p in pts {
        if clean.is_empty() || dist(clean[clean.len() - 1], p) > EPS {
            clean.push(p);
        }
    }
    if closed && clean.len() > 1 && dist(clean[0], clean[clean.len() - 1]) <= EPS {
        clean.pop();
    }
    let n = clean.len();
    if n < 2 {
        return pts.to_vec();
    }
    let edges: Vec<(Vec2, Vec2)> = polyline_edges(&clean, closed)
        .into_iter()
        .map(|(a, b)| offset_segment(a, b, d))
        .collect();
    if edges.is_empty() {
        return pts.to_vec();
    }
    // Schnitt zweier (verschobener) Kanten als unendliche Geraden; None → fallback.
    let join = |e1: (Vec2, Vec2), e2: (Vec2, Vec2), fallback: Vec2| -> Vec2 {
        let d1 = sub(e1.1, e1.0);
        let d2 = sub(e2.1, e2.0);
        line_intersect(e1.0, d1, e2.0, d2).unwrap_or(fallback)
    };
    let m = edges.len();
    let mut result: Vec<Vec2> = Vec::new();
    if !closed {
        result.push(edges[0].0);
        for i in 0..m - 1 {
            result.push(join(edges[i], edges[i + 1], edges[i].1));
        }
        result.push(edges[m - 1].1);
        return result;
    }
    for i in 0..m {
        let prev = edges[(i + m - 1) % m];
        let curr = edges[i];
        result.push(join(prev, curr, curr.0));
    }
    result
}
