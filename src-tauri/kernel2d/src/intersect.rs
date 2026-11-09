//! Punkt-Strecke-Abstände, Strecken-/Geraden-/Polylinien-Schnitte und Kreis-Schnitte; gerufen von Trim, Fillet und `bulge`.
//! Teil von `kernel2d` (aus `lib.rs` aufgeteilt, [164]; `lib.rs` re-exportiert alles).

use crate::*;
use serde::{Deserialize, Serialize};

// --- Punkt/Strecke -----------------------------------------------------------

/// Projektionsparameter t von p auf die Gerade a→b (nicht geklemmt).
/// Guard `l2 < EPS → 0` exakt wie TS.
pub fn project_param(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let ab = sub(b, a);
    let l2 = dot(ab, ab);
    if l2 < EPS {
        return 0.0;
    }
    dot(sub(p, a), ab) / l2
}

/// Naechster Punkt auf der STRECKE a→b zu p (t auf [0,1] geklemmt). Klemm-
/// Reihenfolge wie TS `Math.max(0, Math.min(1, t))` → `.min(1).max(0)`.
pub fn closest_point_on_segment(p: Vec2, a: Vec2, b: Vec2) -> Vec2 {
    let t = project_param(p, a, b).min(1.0).max(0.0);
    add(a, scale(sub(b, a), t))
}

/// Abstand von p zur Strecke a→b.
pub fn point_segment_distance(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    dist(p, closest_point_on_segment(p, a, b))
}

// --- Schnitt -----------------------------------------------------------------

/// Ergebnis eines Strecken-/Linienschnitts (Port von `Hit`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    pub point: Vec2,
    /// Parameter auf der ersten Strecke (0 = a1, 1 = a2).
    pub t: f64,
    /// Parameter auf der zweiten Strecke (0 = b1, 1 = b2).
    pub s: f64,
}

/// Schnitt zweier STRECKEN a1→a2 und b1→b2 (None ausserhalb [-eps,1+eps] oder
/// parallel). ACHTUNG: denom-Test gegen `EPS` (Konstante), Bereichstest gegen
/// den Parameter `eps` — im Default-Pfad sind beide EPS (wie TS-Default).
pub fn segment_intersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2, eps: f64) -> Option<Hit> {
    let da = sub(a2, a1);
    let db = sub(b2, b1);
    let denom = cross(da, db);
    if denom.abs() < EPS {
        return None; // parallel/kollinear
    }
    let t = cross(sub(b1, a1), db) / denom;
    let s = cross(sub(b1, a1), da) / denom;
    if t < -eps || t > 1.0 + eps || s < -eps || s > 1.0 + eps {
        return None;
    }
    Some(Hit { point: add(a1, scale(da, t)), t, s })
}

/// Schnitt der unendlichen GERADE a1→a2 mit der STRECKE b1→b2 (s ∈ [0,1], t frei).
pub fn line_segment_intersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2, eps: f64) -> Option<Hit> {
    let da = sub(a2, a1);
    let db = sub(b2, b1);
    let denom = cross(da, db);
    if denom.abs() < EPS {
        return None;
    }
    let t = cross(sub(b1, a1), db) / denom;
    let s = cross(sub(b1, a1), da) / denom;
    if s < -eps || s > 1.0 + eps {
        return None;
    }
    Some(Hit { point: add(a1, scale(da, t)), t, s })
}

/// Kanten einer Polylinie als (from,to)-Paare (Schlusskante bei `closed`).
/// Leere/ein-Punkt-Eingabe → leer (usize-Unterlauf vermeiden, TS-Verhalten).
pub fn polyline_edges(pts: &[Vec2], closed: bool) -> Vec<(Vec2, Vec2)> {
    let mut out = Vec::new();
    if pts.is_empty() {
        return out;
    }
    for i in 0..pts.len() - 1 {
        out.push((pts[i], pts[i + 1]));
    }
    if closed && pts.len() > 2 {
        out.push((pts[pts.len() - 1], pts[0]));
    }
    out
}

/// Alle Schnittpunkte einer STRECKE mit den Kanten einer Polylinie, nach t
/// sortiert, dedupliziert ab Schwelle 1e-6. STABILE Sortierung (`sort_by`) wie
/// JS `Array.sort`.
pub fn segment_polyline_hits(a1: Vec2, a2: Vec2, pts: &[Vec2], closed: bool) -> Vec<Hit> {
    let mut hits: Vec<Hit> = Vec::new();
    for (b1, b2) in polyline_edges(pts, closed) {
        if let Some(h) = segment_intersect(a1, a2, b1, b2, EPS) {
            hits.push(h);
        }
    }
    hits.sort_by(|p, q| p.t.partial_cmp(&q.t).unwrap_or(std::cmp::Ordering::Equal));
    let mut dedup: Vec<Hit> = Vec::new();
    for h in hits {
        if dedup.is_empty() || (dedup[dedup.len() - 1].t - h.t).abs() > 1e-6 {
            dedup.push(h);
        }
    }
    dedup
}

// --- Kreis-Schnitte ----------------------------------------------------------

/// Schnittpunkte einer unendlichen GERADE a→b mit einem Kreis (0/1/2 Punkte).
/// Diskriminante `B*B - 4*A*C` in exakt dieser Term-Reihenfolge; Klemmung
/// `disc < -EPS → []`, sonst `disc < 0 → 0`.
pub fn line_circle_intersect(a: Vec2, b: Vec2, center: Vec2, r: f64) -> Vec<Vec2> {
    let d = sub(b, a);
    let f = sub(a, center);
    let aa = dot(d, d);
    if aa < EPS {
        return Vec::new();
    }
    let bb = 2.0 * dot(f, d);
    let cc = dot(f, f) - r * r;
    let mut disc = bb * bb - 4.0 * aa * cc;
    if disc < -EPS {
        return Vec::new();
    }
    if disc < 0.0 {
        disc = 0.0;
    }
    let sq = disc.sqrt();
    let t1 = (-bb - sq) / (2.0 * aa);
    let t2 = (-bb + sq) / (2.0 * aa);
    let mut out = vec![add(a, scale(d, t1))];
    if (t1 - t2).abs() > EPS {
        out.push(add(a, scale(d, t2)));
    }
    out
}

/// Schnittpunkte einer STRECKE a→b mit einem Kreis (nur t ∈ [-EPS, 1+EPS]).
pub fn segment_circle_intersect(a: Vec2, b: Vec2, center: Vec2, r: f64) -> Vec<Vec2> {
    line_circle_intersect(a, b, center, r)
        .into_iter()
        .filter(|p| {
            let t = project_param(*p, a, b);
            t >= -EPS && t <= 1.0 + EPS
        })
        .collect()
}

/// Schnittpunkte zweier Kreise (0/1/2 Punkte).
pub fn circle_circle_intersect(c1: Vec2, r1: f64, c2: Vec2, r2: f64) -> Vec<Vec2> {
    let d = dist(c1, c2);
    if d < EPS {
        return Vec::new(); // konzentrisch
    }
    if d > r1 + r2 + EPS || d < (r1 - r2).abs() - EPS {
        return Vec::new(); // getrennt/innen
    }
    let a = (r1 * r1 - r2 * r2 + d * d) / (2.0 * d);
    let h2 = r1 * r1 - a * a;
    let h = if h2 > 0.0 { h2.sqrt() } else { 0.0 };
    let u = normalize(sub(c2, c1));
    let mid = add(c1, scale(u, a));
    let n = left_normal(u);
    if h < EPS {
        return vec![mid];
    }
    vec![add(mid, scale(n, h)), add(mid, scale(n, -h))]
}
