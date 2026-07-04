// kernel2d — Rust/WASM-Port von `src/geometry/kernel2d.ts` (+ reine Geometrie aus
// room/ceiling/roomArea/stair). Handgeschriebene f64-Mathematik, KEINE externen
// Geometrie-Crates: Akzeptanzkriterium ist Differential-Paritaet gegen die naive
// TS-Routine (siehe PORT_PLAN.md). Fremd-Crates mit anderem Algorithmus braechen
// die Paritaet per Konstruktion.
//
// Aufbau (waechst ueber die Phasen des PORT_PLAN):
//   - Phase 1 (hier): Vec2 + Vektor-Helfer (Port von src/model/geometry.ts) +
//     leere Batch-WASM-Fassade. `cargo test` + `build:kernel2d` gruen.
//   - Phase 2+: Schnitt/Offset/Trim/Fillet/Fläche/Kreis/detectRooms/… .
//
// KRITISCHE PARITAETS-REGELN (PORT_PLAN §6), gelten fuer den ganzen Port:
//   - `len` = Math.hypot → `f64::hypot` (NICHT (x²+y²).sqrt()).
//   - `normalize` Null-Guard: `len || 1` → `if l==0.0 {1.0} else {l}` (Ergebnis
//     {0,0}, kein NaN).
//   - Zwei Epsilons: EPS=1e-7 (kernel2d) UND hartkodiert 1e-9 in lineIntersect.
//   - Term-Reihenfolge in cross/signedArea/Diskriminante exakt beibehalten
//     (f64 nicht assoziativ; kein Kahan/Reorder).

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

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

// --- Trim / Split / Join -----------------------------------------------------
// Reine Geometrie auf Polylinien (`Vec2[]` + `closed`). Struktur- und
// reihenfolgeabhaengig — Sortier-Reihenfolge, Dedup-Schwellen (1e-6) und die
// greedy-Verbindungslogik von joinChains muessen EXAKT wie TS sein.

/// Polylinie / Cutter / Kette: `{pts, closed}` (Port des TS-`{pts, closed}`).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Polyline {
    pub pts: Vec<Vec2>,
    pub closed: bool,
}

/// Ein Schnitt-Treffer auf einer Kante: Kantenindex + Parameter + Punkt.
#[derive(Clone, Copy)]
struct EdgeHit {
    edge: usize,
    t: f64,
    point: Vec2,
}

/// Lineare Interpolation zweier Punkte.
fn lerp(a: Vec2, b: Vec2, t: f64) -> Vec2 {
    add(a, scale(sub(b, a), t))
}

/// Entfernt aufeinanderfolgende (nahezu) gleiche Punkte (kein Ringschluss).
fn dedupe_consecutive(pts: &[Vec2]) -> Vec<Vec2> {
    let mut out: Vec<Vec2> = Vec::new();
    for &p in pts {
        if out.is_empty() || !vec_equal(out[out.len() - 1], p, EPS) {
            out.push(p);
        }
    }
    out
}

/// Dedup aufeinanderfolgender Punkte UND schliessender Duplikat-Endpunkt.
fn dedupe_ring(pts: &[Vec2]) -> Vec<Vec2> {
    let mut out = dedupe_consecutive(pts);
    if out.len() > 1 && vec_equal(out[0], out[out.len() - 1], EPS) {
        out.pop();
    }
    out
}

/// Vergleichsfunktion `(edge, t)` wie TS `(p.edge-q.edge) || (p.t-q.t)`, stabil.
fn cmp_edge_t(p: &EdgeHit, q: &EdgeHit) -> Ordering {
    p.edge
        .cmp(&q.edge)
        .then(p.t.partial_cmp(&q.t).unwrap_or(Ordering::Equal))
}

/// Zerschneidet eine STRECKE an allen inneren Cutter-Schnitten (t ∈ (EPS,1-EPS)).
pub fn split_segment_by_cutters(a1: Vec2, a2: Vec2, cutters: &[Polyline]) -> Vec<(Vec2, Vec2)> {
    let mut ts: Vec<f64> = vec![0.0, 1.0];
    for c in cutters {
        for h in segment_polyline_hits(a1, a2, &c.pts, c.closed) {
            if h.t > EPS && h.t < 1.0 - EPS {
                ts.push(h.t);
            }
        }
    }
    ts.sort_by(|p, q| p.partial_cmp(q).unwrap_or(Ordering::Equal));
    let da = sub(a2, a1);
    let mut pieces: Vec<(Vec2, Vec2)> = Vec::new();
    for i in 0..ts.len() - 1 {
        if ts[i + 1] - ts[i] < 1e-6 {
            continue;
        }
        pieces.push((add(a1, scale(da, ts[i])), add(a1, scale(da, ts[i + 1]))));
    }
    pieces
}

/// Trim: schneidet an den Cuttern und VERWIRFT das dem `pick` naechste Teilstueck.
pub fn trim_segment(a1: Vec2, a2: Vec2, cutters: &[Polyline], pick: Vec2) -> Vec<(Vec2, Vec2)> {
    let pieces = split_segment_by_cutters(a1, a2, cutters);
    if pieces.len() <= 1 {
        return pieces;
    }
    let mut best = 0usize;
    let mut best_d = f64::INFINITY;
    for (i, pc) in pieces.iter().enumerate() {
        let d = point_segment_distance(pick, pc.0, pc.1);
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    pieces
        .into_iter()
        .enumerate()
        .filter(|(i, _)| *i != best)
        .map(|(_, p)| p)
        .collect()
}

/// Globaler Lauf-Parameter (edgeIndex + t) des dem Punkt naechsten Kettenpunktes.
fn nearest_param_on_chain(edges: &[(Vec2, Vec2)], p: Vec2) -> f64 {
    let mut best = 0.0;
    let mut best_d = f64::INFINITY;
    for (ei, &(a, b)) in edges.iter().enumerate() {
        let t = project_param(p, a, b).min(1.0).max(0.0);
        let q = add(a, scale(sub(b, a), t));
        let d = dist(p, q);
        if d < best_d {
            best_d = d;
            best = ei as f64 + t;
        }
    }
    best
}

/// Quick-Trim einer ganzen Kurve an einem Klickpunkt (siehe TS-Doku).
pub fn trim_polyline(pts: &[Vec2], closed: bool, cutters: &[Polyline], pick: Vec2) -> Vec<Polyline> {
    let edges = polyline_edges(pts, closed);
    if edges.is_empty() {
        return vec![Polyline { pts: pts.to_vec(), closed }];
    }
    let mut cuts: Vec<EdgeHit> = Vec::new();
    for ei in 0..edges.len() {
        let (a1, a2) = edges[ei];
        for c in cutters {
            for h in segment_polyline_hits(a1, a2, &c.pts, c.closed) {
                if h.t > EPS && h.t < 1.0 - EPS {
                    cuts.push(EdgeHit { edge: ei, t: h.t, point: h.point });
                }
            }
        }
    }
    cuts.sort_by(cmp_edge_t);
    let mut cut: Vec<EdgeHit> = Vec::new();
    for h in cuts {
        if let Some(prev) = cut.last() {
            if prev.edge == h.edge && (prev.t - h.t).abs() < 1e-6 {
                continue;
            }
        }
        cut.push(h);
    }
    if cut.is_empty() {
        return vec![Polyline { pts: pts.to_vec(), closed }];
    }

    if !closed {
        let pick_pos = nearest_param_on_chain(&edges, pick);
        let cut_pos: Vec<f64> = cut.iter().map(|c| c.edge as f64 + c.t).collect();
        let mut lo_idx: isize = -1;
        let mut hi_idx: usize = cut.len();
        for i in 0..cut.len() {
            if cut_pos[i] <= pick_pos {
                lo_idx = i as isize;
            } else {
                hi_idx = i;
                break;
            }
        }
        let mut result: Vec<Polyline> = Vec::new();
        if lo_idx >= 0 {
            let c = cut[lo_idx as usize];
            let mut head: Vec<Vec2> = pts[..c.edge + 1].to_vec();
            head.push(c.point);
            let d = dedupe_consecutive(&head);
            if d.len() >= 2 {
                result.push(Polyline { pts: d, closed: false });
            }
        }
        if hi_idx < cut.len() {
            let c = cut[hi_idx];
            let mut tail: Vec<Vec2> = vec![c.point];
            for k in c.edge + 1..pts.len() {
                tail.push(pts[k]);
            }
            let d = dedupe_consecutive(&tail);
            if d.len() >= 2 {
                result.push(Polyline { pts: d, closed: false });
            }
        }
        return result;
    }

    // Geschlossen.
    if cut.len() == 1 {
        return vec![Polyline { pts: pts.to_vec(), closed: true }];
    }
    let total = edges.len();
    let span = |e_x: usize, p_x: Vec2, e_y: usize, p_y: Vec2| -> Vec<Vec2> {
        let mut out: Vec<Vec2> = vec![p_x];
        let mut e = e_x;
        let mut steps = 0usize;
        while steps <= total {
            if e == e_y {
                break;
            }
            out.push(edges[e].1);
            e = (e + 1) % total;
            steps += 1;
        }
        out.push(p_y);
        dedupe_consecutive(&out)
    };
    let pick_pos = nearest_param_on_chain(&edges, pick);
    let cut_pos: Vec<f64> = cut.iter().map(|c| c.edge as f64 + c.t).collect();
    let mut seg: isize = -1;
    for i in 0..cut.len() {
        let a = cut_pos[i];
        let b = cut_pos[(i + 1) % cut.len()];
        let inside = if i == cut.len() - 1 {
            pick_pos >= a || pick_pos <= b
        } else {
            pick_pos >= a && pick_pos <= b
        };
        if inside {
            seg = i as isize;
            break;
        }
    }
    if seg < 0 {
        seg = 0;
    }
    let seg = seg as usize;
    let from = cut[(seg + 1) % cut.len()];
    let to = cut[seg];
    let chain = span(from.edge, from.point, to.edge, to.point);
    if chain.len() < 2 {
        return Vec::new();
    }
    vec![Polyline { pts: chain, closed: false }]
}

/// Verlaengert das gewaehlte Ende bis zur naechsten Cutter-Kante (oder None).
pub fn extend_segment(
    a1: Vec2,
    a2: Vec2,
    end: &str,
    cutters: &[Polyline],
) -> Option<(Vec2, Vec2)> {
    let mut best_t: Option<f64> = None;
    for c in cutters {
        for (b1, b2) in polyline_edges(&c.pts, c.closed) {
            let h = match line_segment_intersect(a1, a2, b1, b2, EPS) {
                Some(h) => h,
                None => continue,
            };
            if end == "end" && h.t > 1.0 + EPS {
                if best_t.map_or(true, |bt| h.t < bt) {
                    best_t = Some(h.t);
                }
            } else if end == "start" && h.t < -EPS {
                if best_t.map_or(true, |bt| h.t > bt) {
                    best_t = Some(h.t);
                }
            }
        }
    }
    let bt = best_t?;
    let da = sub(a2, a1);
    let hit_point = add(a1, scale(da, bt));
    Some(if end == "end" {
        (a1, hit_point)
    } else {
        (hit_point, a2)
    })
}

/// Teilt eine Polylinie an EINEM Punkt P = lerp(pts[edgeIndex], next, t).
pub fn split_polyline_at_param(
    pts: &[Vec2],
    closed: bool,
    edge_index: usize,
    t: f64,
) -> Vec<Vec<Vec2>> {
    let n = pts.len();
    if n < 2 {
        return vec![pts.to_vec()];
    }
    let a = pts[edge_index];
    let b = pts[(edge_index + 1) % n];
    let p = lerp(a, b, t);
    let at_start = t <= EPS;
    let at_end = t >= 1.0 - EPS;

    if !closed {
        let mut left: Vec<Vec2> = pts[..edge_index + 1].to_vec();
        if !at_start && !at_end {
            left.push(p);
        } else if at_end {
            left.push(b);
        }
        let mut right: Vec<Vec2> = Vec::new();
        if !at_start && !at_end {
            right.push(p);
        } else if at_start {
            right.push(a);
        }
        for i in edge_index + 1..n {
            right.push(pts[i]);
        }
        let pieces: Vec<Vec<Vec2>> = [left, right]
            .into_iter()
            .filter(|s| s.len() >= 2)
            .collect();
        return if !pieces.is_empty() {
            pieces
        } else {
            vec![pts.to_vec()]
        };
    }

    let mut out: Vec<Vec2> = Vec::new();
    if !at_start {
        out.push(p);
    }
    for k in 1..=n {
        out.push(pts[(edge_index + k) % n]);
    }
    if !at_start {
        out.push(p);
    } else {
        out.push(a);
    }
    vec![dedupe_consecutive(&out)]
}

/// Teilt ein GESCHLOSSENES Polygon an zwei Randpunkten via Sehne (2 Ringe).
pub fn split_closed_by_chord(
    pts: &[Vec2],
    i: usize,
    ti: f64,
    j: usize,
    tj: f64,
) -> Option<(Vec<Vec2>, Vec<Vec2>)> {
    let n = pts.len();
    if n < 3 || i == j {
        return None;
    }
    let (ia, ta, ib, tb) = if i > j {
        (j, tj, i, ti)
    } else {
        (i, ti, j, tj)
    };
    let p_a = lerp(pts[ia], pts[(ia + 1) % n], ta);
    let p_b = lerp(pts[ib], pts[(ib + 1) % n], tb);
    let mut arc1: Vec<Vec2> = vec![p_a];
    for k in ia + 1..=ib {
        arc1.push(pts[k % n]);
    }
    arc1.push(p_b);
    let mut arc2: Vec<Vec2> = vec![p_b];
    for k in ib + 1..=ia + n {
        arc2.push(pts[k % n]);
    }
    arc2.push(p_a);
    Some((dedupe_ring(&arc1), dedupe_ring(&arc2)))
}

/// Entfernt das Segment `edge_index` (offen: laengeres Stueck; geschlossen: auftrennen).
pub fn remove_segment(pts: &[Vec2], closed: bool, edge_index: usize) -> Polyline {
    let n = pts.len();
    if closed {
        let mut out: Vec<Vec2> = Vec::new();
        for k in 1..=n {
            out.push(pts[(edge_index + k) % n]);
        }
        return Polyline { pts: dedupe_consecutive(&out), closed: false };
    }
    if n == 0 {
        return Polyline { pts: Vec::new(), closed: false };
    }
    if edge_index == 0 {
        return Polyline { pts: pts[1..].to_vec(), closed: false };
    }
    if edge_index >= n - 1 {
        return Polyline { pts: pts[..n - 1].to_vec(), closed: false };
    }
    let left = pts[..edge_index + 1].to_vec();
    let right = pts[edge_index + 1..].to_vec();
    if left.len() >= right.len() {
        Polyline { pts: left, closed: false }
    } else {
        Polyline { pts: right, closed: false }
    }
}

/// Kanten einer (offenen ODER implizit geschlossenen) Punktliste.
fn polyline_edges_auto(pts: &[Vec2]) -> Vec<(Vec2, Vec2)> {
    let closed = pts.len() > 2 && vec_equal(pts[0], pts[pts.len() - 1], EPS);
    if closed {
        polyline_edges(&pts[..pts.len() - 1], true)
    } else {
        polyline_edges(pts, false)
    }
}

/// Offene Polylinie an gegebenen EdgeHits (auf ihren Kanten) zerschneiden.
fn split_open_by_edge_hits(pts: &[Vec2], hits: &[EdgeHit]) -> Vec<Vec<Vec2>> {
    if pts.is_empty() {
        return Vec::new();
    }
    let mut pieces: Vec<Vec<Vec2>> = Vec::new();
    let mut cur: Vec<Vec2> = vec![pts[0]];
    let mut hi = 0usize;
    for ei in 0..pts.len() - 1 {
        while hi < hits.len() && hits[hi].edge == ei {
            let p = hits[hi].point;
            cur.push(p);
            pieces.push(cur.clone());
            cur = vec![p];
            hi += 1;
        }
        cur.push(pts[ei + 1]);
    }
    pieces.push(cur);
    pieces
        .into_iter()
        .map(|s| dedupe_consecutive(&s))
        .filter(|s| s.len() >= 2)
        .collect()
}

/// Offene Polylinie an einer Liste von Schnitt-PUNKTEN (auf dem Zug) zerschneiden.
fn split_open_at_hits(pts: &[Vec2], cut_points: &[Vec2]) -> Vec<Vec<Vec2>> {
    if cut_points.is_empty() {
        return vec![pts.to_vec()];
    }
    let mut hits: Vec<EdgeHit> = Vec::new();
    for ei in 0..pts.len().saturating_sub(1) {
        let a = pts[ei];
        let b = pts[ei + 1];
        for &cp in cut_points {
            let t = project_param(cp, a, b);
            if t > EPS && t < 1.0 - EPS && point_segment_distance(cp, a, b) < 1e-6 {
                hits.push(EdgeHit { edge: ei, t, point: cp });
            }
        }
    }
    hits.sort_by(cmp_edge_t);
    split_open_by_edge_hits(pts, &hits)
}

/// Teilt das Ziel an allen Schnittpunkten mit den anderen Polylinien.
pub fn split_at_intersections(
    target_pts: &[Vec2],
    closed: bool,
    others: &[Vec<Vec2>],
) -> Vec<Vec<Vec2>> {
    let edges = polyline_edges(target_pts, closed);
    let mut hits: Vec<EdgeHit> = Vec::new();
    for ei in 0..edges.len() {
        let (a1, a2) = edges[ei];
        for o in others {
            for (b1, b2) in polyline_edges_auto(o) {
                if let Some(h) = segment_intersect(a1, a2, b1, b2, EPS) {
                    hits.push(EdgeHit { edge: ei, t: h.t, point: h.point });
                }
            }
        }
    }
    hits.sort_by(cmp_edge_t);
    let mut dedup: Vec<EdgeHit> = Vec::new();
    for h in hits {
        if let Some(prev) = dedup.last() {
            if prev.edge == h.edge && (prev.t - h.t).abs() < 1e-6 {
                continue;
            }
        }
        if h.t <= EPS || h.t >= 1.0 - EPS {
            continue;
        }
        dedup.push(h);
    }
    if dedup.is_empty() {
        return vec![target_pts.to_vec()];
    }
    if closed {
        if dedup.len() == 2 {
            return match split_closed_by_chord(
                target_pts, dedup[0].edge, dedup[0].t, dedup[1].edge, dedup[1].t,
            ) {
                Some((a, b)) => vec![a, b],
                None => vec![target_pts.to_vec()],
            };
        }
        let opened = split_polyline_at_param(target_pts, true, dedup[0].edge, dedup[0].t)
            .into_iter()
            .next()
            .unwrap_or_default();
        let cut_pts: Vec<Vec2> = dedup[1..].iter().map(|h| h.point).collect();
        return split_open_at_hits(&opened, &cut_pts);
    }
    split_open_by_edge_hits(target_pts, &dedup)
}

/// Verschmilzt Polylinien an koinzidenten Endpunkten zu laengeren Ketten.
/// Greedy `i<j`-erster-Treffer-dann-Neustart — reihenfolgeabhaengig, exakt wie TS.
pub fn join_chains(polylines: &[Polyline]) -> Vec<Polyline> {
    let mut closed_out: Vec<Polyline> = Vec::new();
    let mut open: Vec<Vec<Vec2>> = Vec::new();
    for pl in polylines {
        if pl.closed {
            closed_out.push(Polyline { pts: pl.pts.clone(), closed: true });
        } else if pl.pts.len() >= 2 {
            open.push(pl.pts.clone());
        } else if pl.pts.len() == 1 {
            open.push(pl.pts.clone());
        }
    }

    let mut merged = true;
    while merged {
        merged = false;
        'outer: for i in 0..open.len() {
            for j in i + 1..open.len() {
                let a = &open[i];
                let b = &open[j];
                let a_s = a[0];
                let a_e = a[a.len() - 1];
                let b_s = b[0];
                let b_e = b[b.len() - 1];
                let combined: Option<Vec<Vec2>> = if vec_equal(a_e, b_s, EPS) {
                    let mut v = a.clone();
                    v.extend_from_slice(&b[1..]);
                    Some(v)
                } else if vec_equal(a_e, b_e, EPS) {
                    let mut v = a.clone();
                    let mut rev: Vec<Vec2> = b[..b.len() - 1].to_vec();
                    rev.reverse();
                    v.extend(rev);
                    Some(v)
                } else if vec_equal(a_s, b_e, EPS) {
                    let mut v = b.clone();
                    v.extend_from_slice(&a[1..]);
                    Some(v)
                } else if vec_equal(a_s, b_s, EPS) {
                    let mut v: Vec<Vec2> = b.clone();
                    v.reverse();
                    v.extend_from_slice(&a[1..]);
                    Some(v)
                } else {
                    None
                };
                if let Some(c) = combined {
                    open.remove(j);
                    open[i] = c;
                    merged = true;
                    break 'outer;
                }
            }
        }
    }

    let mut out: Vec<Polyline> = closed_out;
    for chain in open {
        if chain.len() > 2 && vec_equal(chain[0], chain[chain.len() - 1], EPS) {
            out.push(Polyline { pts: chain[..chain.len() - 1].to_vec(), closed: true });
        } else {
            out.push(Polyline { pts: chain, closed: false });
        }
    }
    out
}

// --- Batch-WASM-Fassade (Feature "web") --------------------------------------
// Phase 1: nur ein Versions-/Ping-Export, um die WASM-Grenze + das Tooling
// (wasm-pack → pkgKernel2d → Vite/vitest) end-to-end gruen zu bekommen. Die
// echten Batch-Fassaden (offset_polylines_json, intersect_batch_json, …) kommen
// ab Phase 2, Muster: geometry::compute_joins_json (JSON rein/raus, O(n)-Grenze).

/// Ping-Export: beweist die WASM-Grenze. Nimmt ein JSON-`Vec2`, spiegelt es
/// normalisiert zurueck — genug, um Init + JSON-Marshalling im vitest-Harness
/// zu verifizieren, bevor die echten Operationen landen.
#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn kernel2d_normalize_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let v: Vec2 = serde_json::from_str(input_json)
        .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))?;
    let out = normalize(v);
    serde_json::to_string(&out).map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
}

// Grobkoernige Grenze: je Operation EINE Batch-Funktion (N Queries rein, N
// Ergebnisse raus), Muster geometry::compute_joins_json. Serde-Helfer buendeln
// das immergleiche JsValue-Fehlermapping. Die Query-Structs definieren zugleich
// das JSON-Format, das der vitest-Differential-Harness sendet.

#[cfg(feature = "web")]
fn to_js<T: serde::Serialize>(v: &T) -> Result<String, wasm_bindgen::JsValue> {
    serde_json::to_string(v).map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
}

#[cfg(feature = "web")]
fn from_js<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, wasm_bindgen::JsValue> {
    serde_json::from_str(s).map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct ProjQuery {
    p: Vec2,
    a: Vec2,
    b: Vec2,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct SegQuery {
    a1: Vec2,
    a2: Vec2,
    b1: Vec2,
    b2: Vec2,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct PolyHitsQuery {
    a1: Vec2,
    a2: Vec2,
    pts: Vec<Vec2>,
    closed: bool,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct LineCircleQuery {
    a: Vec2,
    b: Vec2,
    center: Vec2,
    r: f64,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct CircleCircleQuery {
    c1: Vec2,
    r1: f64,
    c2: Vec2,
    r2: f64,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct OffsetSegQuery {
    a: Vec2,
    b: Vec2,
    d: f64,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct OffsetPolyQuery {
    pts: Vec<Vec2>,
    d: f64,
    closed: bool,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct FilletQuery {
    corner: Vec2,
    p1: Vec2,
    p2: Vec2,
    r: f64,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct SplitCuttersQuery {
    a1: Vec2,
    a2: Vec2,
    cutters: Vec<Polyline>,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct TrimSegQuery {
    a1: Vec2,
    a2: Vec2,
    cutters: Vec<Polyline>,
    pick: Vec2,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct TrimPolyQuery {
    pts: Vec<Vec2>,
    closed: bool,
    cutters: Vec<Polyline>,
    pick: Vec2,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct ExtendQuery {
    a1: Vec2,
    a2: Vec2,
    end: String,
    cutters: Vec<Polyline>,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct SplitAtParamQuery {
    pts: Vec<Vec2>,
    closed: bool,
    #[serde(rename = "edgeIndex")]
    edge_index: usize,
    t: f64,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct ChordQuery {
    pts: Vec<Vec2>,
    i: usize,
    ti: f64,
    j: usize,
    tj: f64,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct RemoveSegQuery {
    pts: Vec<Vec2>,
    closed: bool,
    #[serde(rename = "edgeIndex")]
    edge_index: usize,
}

#[cfg(feature = "web")]
#[derive(Deserialize)]
struct SplitIntersectQuery {
    #[serde(rename = "targetPts")]
    target_pts: Vec<Vec2>,
    closed: bool,
    others: Vec<Vec<Vec2>>,
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn project_param_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<ProjQuery> = from_js(input_json)?;
    let out: Vec<f64> = qs.iter().map(|q| project_param(q.p, q.a, q.b)).collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn closest_point_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<ProjQuery> = from_js(input_json)?;
    let out: Vec<Vec2> = qs
        .iter()
        .map(|q| closest_point_on_segment(q.p, q.a, q.b))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn point_segment_distance_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<ProjQuery> = from_js(input_json)?;
    let out: Vec<f64> = qs
        .iter()
        .map(|q| point_segment_distance(q.p, q.a, q.b))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn segment_intersect_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<SegQuery> = from_js(input_json)?;
    let out: Vec<Option<Hit>> = qs
        .iter()
        .map(|q| segment_intersect(q.a1, q.a2, q.b1, q.b2, EPS))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn line_segment_intersect_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<SegQuery> = from_js(input_json)?;
    let out: Vec<Option<Hit>> = qs
        .iter()
        .map(|q| line_segment_intersect(q.a1, q.a2, q.b1, q.b2, EPS))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn segment_polyline_hits_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<PolyHitsQuery> = from_js(input_json)?;
    let out: Vec<Vec<Hit>> = qs
        .iter()
        .map(|q| segment_polyline_hits(q.a1, q.a2, &q.pts, q.closed))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn line_circle_intersect_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<LineCircleQuery> = from_js(input_json)?;
    let out: Vec<Vec<Vec2>> = qs
        .iter()
        .map(|q| line_circle_intersect(q.a, q.b, q.center, q.r))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn segment_circle_intersect_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<LineCircleQuery> = from_js(input_json)?;
    let out: Vec<Vec<Vec2>> = qs
        .iter()
        .map(|q| segment_circle_intersect(q.a, q.b, q.center, q.r))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn circle_circle_intersect_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<CircleCircleQuery> = from_js(input_json)?;
    let out: Vec<Vec<Vec2>> = qs
        .iter()
        .map(|q| circle_circle_intersect(q.c1, q.r1, q.c2, q.r2))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn signed_area_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let polys: Vec<Vec<Vec2>> = from_js(input_json)?;
    let out: Vec<f64> = polys.iter().map(|p| signed_area(p)).collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn is_ccw_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let polys: Vec<Vec<Vec2>> = from_js(input_json)?;
    let out: Vec<bool> = polys.iter().map(|p| is_ccw(p)).collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn offset_segment_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<OffsetSegQuery> = from_js(input_json)?;
    let out: Vec<(Vec2, Vec2)> = qs.iter().map(|q| offset_segment(q.a, q.b, q.d)).collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn offset_polyline_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<OffsetPolyQuery> = from_js(input_json)?;
    let out: Vec<Vec<Vec2>> = qs
        .iter()
        .map(|q| offset_polyline(&q.pts, q.d, q.closed))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn fillet_corner_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<FilletQuery> = from_js(input_json)?;
    let out: Vec<Option<Fillet>> = qs
        .iter()
        .map(|q| fillet_corner(q.corner, q.p1, q.p2, q.r))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn split_segment_by_cutters_batch_json(
    input_json: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<SplitCuttersQuery> = from_js(input_json)?;
    let out: Vec<Vec<(Vec2, Vec2)>> = qs
        .iter()
        .map(|q| split_segment_by_cutters(q.a1, q.a2, &q.cutters))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn trim_segment_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<TrimSegQuery> = from_js(input_json)?;
    let out: Vec<Vec<(Vec2, Vec2)>> = qs
        .iter()
        .map(|q| trim_segment(q.a1, q.a2, &q.cutters, q.pick))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn trim_polyline_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<TrimPolyQuery> = from_js(input_json)?;
    let out: Vec<Vec<Polyline>> = qs
        .iter()
        .map(|q| trim_polyline(&q.pts, q.closed, &q.cutters, q.pick))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn extend_segment_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<ExtendQuery> = from_js(input_json)?;
    let out: Vec<Option<(Vec2, Vec2)>> = qs
        .iter()
        .map(|q| extend_segment(q.a1, q.a2, &q.end, &q.cutters))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn split_polyline_at_param_batch_json(
    input_json: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<SplitAtParamQuery> = from_js(input_json)?;
    let out: Vec<Vec<Vec<Vec2>>> = qs
        .iter()
        .map(|q| split_polyline_at_param(&q.pts, q.closed, q.edge_index, q.t))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn split_closed_by_chord_batch_json(
    input_json: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<ChordQuery> = from_js(input_json)?;
    let out: Vec<Option<(Vec<Vec2>, Vec<Vec2>)>> = qs
        .iter()
        .map(|q| split_closed_by_chord(&q.pts, q.i, q.ti, q.j, q.tj))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn remove_segment_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<RemoveSegQuery> = from_js(input_json)?;
    let out: Vec<Polyline> = qs
        .iter()
        .map(|q| remove_segment(&q.pts, q.closed, q.edge_index))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn split_at_intersections_batch_json(
    input_json: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let qs: Vec<SplitIntersectQuery> = from_js(input_json)?;
    let out: Vec<Vec<Vec<Vec2>>> = qs
        .iter()
        .map(|q| split_at_intersections(&q.target_pts, q.closed, &q.others))
        .collect();
    to_js(&out)
}

#[cfg(feature = "web")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn join_chains_batch_json(input_json: &str) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let groups: Vec<Vec<Polyline>> = from_js(input_json)?;
    let out: Vec<Vec<Polyline>> = groups.iter().map(|g| join_chains(g)).collect();
    to_js(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: f64 = 1e-12;

    #[test]
    fn len_uses_hypot() {
        assert!((len(Vec2::new(3.0, 4.0)) - 5.0).abs() < T);
    }

    #[test]
    fn normalize_zero_guard_yields_origin_not_nan() {
        let n = normalize(Vec2::new(0.0, 0.0));
        assert_eq!(n, Vec2::new(0.0, 0.0));
    }

    #[test]
    fn cross_dot_term_order() {
        let p = Vec2::new(1.0, 2.0);
        let q = Vec2::new(3.0, 4.0);
        assert!((cross(p, q) - (1.0 * 4.0 - 2.0 * 3.0)).abs() < T);
        assert!((dot(p, q) - (1.0 * 3.0 + 2.0 * 4.0)).abs() < T);
    }

    #[test]
    fn line_intersect_parallel_is_none() {
        let a = Vec2::new(0.0, 0.0);
        let da = Vec2::new(1.0, 0.0);
        let b = Vec2::new(0.0, 1.0);
        let db = Vec2::new(1.0, 0.0);
        assert!(line_intersect(a, da, b, db).is_none());
    }

    #[test]
    fn line_intersect_crossing() {
        let hit = line_intersect(
            Vec2::new(0.0, 0.0),
            Vec2::new(1.0, 0.0),
            Vec2::new(2.0, -1.0),
            Vec2::new(0.0, 1.0),
        )
        .unwrap();
        assert!((hit.x - 2.0).abs() < T && hit.y.abs() < T);
    }

    #[test]
    fn signed_area_unit_square_ccw() {
        let sq = [
            Vec2::new(0.0, 0.0),
            Vec2::new(1.0, 0.0),
            Vec2::new(1.0, 1.0),
            Vec2::new(0.0, 1.0),
        ];
        assert!((signed_area(&sq) - 1.0).abs() < T);
        assert!(is_ccw(&sq));
        // Umgekehrte Reihenfolge → CW, Flaeche negativ.
        let mut cw = sq;
        cw.reverse();
        assert!((signed_area(&cw) + 1.0).abs() < T);
        assert!(!is_ccw(&cw));
    }

    #[test]
    fn segment_intersect_crossing_and_miss() {
        let hit = segment_intersect(
            Vec2::new(0.0, 0.0),
            Vec2::new(2.0, 2.0),
            Vec2::new(0.0, 2.0),
            Vec2::new(2.0, 0.0),
            EPS,
        )
        .unwrap();
        assert!((hit.point.x - 1.0).abs() < T && (hit.point.y - 1.0).abs() < T);
        assert!((hit.t - 0.5).abs() < T && (hit.s - 0.5).abs() < T);
        // Kein Treffer: zweite Strecke zu kurz.
        assert!(segment_intersect(
            Vec2::new(0.0, 0.0),
            Vec2::new(2.0, 2.0),
            Vec2::new(0.0, 2.0),
            Vec2::new(0.9, 1.1),
            EPS,
        )
        .is_none());
    }

    #[test]
    fn circle_circle_two_points() {
        // Zwei Einheitskreise, Zentren Abstand 1 → Schnitt bei x=0.5, y=±√3/2.
        let pts = circle_circle_intersect(Vec2::new(0.0, 0.0), 1.0, Vec2::new(1.0, 0.0), 1.0);
        assert_eq!(pts.len(), 2);
        let expect_y = (3.0_f64).sqrt() / 2.0;
        for p in &pts {
            assert!((p.x - 0.5).abs() < 1e-9);
            assert!((p.y.abs() - expect_y).abs() < 1e-9);
        }
    }

    #[test]
    fn line_circle_tangent_one_point() {
        // Gerade y=1 tangiert Einheitskreis in (0,1).
        let pts = line_circle_intersect(
            Vec2::new(-1.0, 1.0),
            Vec2::new(1.0, 1.0),
            Vec2::new(0.0, 0.0),
            1.0,
        );
        assert_eq!(pts.len(), 1);
        assert!(pts[0].x.abs() < 1e-9 && (pts[0].y - 1.0).abs() < 1e-9);
    }

    #[test]
    fn polyline_edges_open_and_closed() {
        let pts = [
            Vec2::new(0.0, 0.0),
            Vec2::new(1.0, 0.0),
            Vec2::new(1.0, 1.0),
        ];
        assert_eq!(polyline_edges(&pts, false).len(), 2);
        assert_eq!(polyline_edges(&pts, true).len(), 3);
        assert!(polyline_edges(&[], true).is_empty());
        assert!(polyline_edges(&[Vec2::new(0.0, 0.0)], true).is_empty());
    }

    #[test]
    fn offset_segment_left_positive() {
        // Strecke (0,0)->(1,0), Offset +0.5 → linke Normale (0,1) → y=0.5.
        let (a, b) = offset_segment(Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0), 0.5);
        assert!((a.x).abs() < T && (a.y - 0.5).abs() < T);
        assert!((b.x - 1.0).abs() < T && (b.y - 0.5).abs() < T);
    }

    #[test]
    fn offset_polyline_right_angle_miter() {
        // L-Ecke (0,0)->(1,0)->(1,1), offen, Offset +0.5 (nach innen/links).
        // Innerer Gehrungspunkt = Schnitt der beiden verschobenen Kanten bei (0.5,0.5).
        let l = [
            Vec2::new(0.0, 0.0),
            Vec2::new(1.0, 0.0),
            Vec2::new(1.0, 1.0),
        ];
        let out = offset_polyline(&l, 0.5, false);
        assert_eq!(out.len(), 3);
        assert!((out[1].x - 0.5).abs() < 1e-9 && (out[1].y - 0.5).abs() < 1e-9);
    }

    #[test]
    fn fillet_right_angle() {
        // Rechter Winkel bei (0,0), Schenkel entlang +x und +y, r=1.
        // setback = r/tan(45°) = 1; center auf Winkelhalbierender bei (1,1).
        let f = fillet_corner(
            Vec2::new(0.0, 0.0),
            Vec2::new(5.0, 0.0),
            Vec2::new(0.0, 5.0),
            1.0,
        )
        .unwrap();
        assert!((f.tangent_a.x - 1.0).abs() < 1e-9 && f.tangent_a.y.abs() < 1e-9);
        assert!(f.tangent_b.x.abs() < 1e-9 && (f.tangent_b.y - 1.0).abs() < 1e-9);
        assert!((f.center.x - 1.0).abs() < 1e-9 && (f.center.y - 1.0).abs() < 1e-9);
        assert!((f.radius - 1.0).abs() < T);
    }

    #[test]
    fn fillet_collinear_is_none() {
        // Gestreckt (180°) → kollinear → None.
        assert!(fillet_corner(
            Vec2::new(0.0, 0.0),
            Vec2::new(1.0, 0.0),
            Vec2::new(-1.0, 0.0),
            0.5,
        )
        .is_none());
        // Zu grosser Radius für die Schenkellänge → None.
        assert!(fillet_corner(
            Vec2::new(0.0, 0.0),
            Vec2::new(0.1, 0.0),
            Vec2::new(0.0, 0.1),
            10.0,
        )
        .is_none());
    }

    fn poly(pts: &[(f64, f64)], closed: bool) -> Polyline {
        Polyline {
            pts: pts.iter().map(|&(x, y)| Vec2::new(x, y)).collect(),
            closed,
        }
    }

    #[test]
    fn trim_segment_removes_picked_piece() {
        // Strecke (0,0)->(4,0), ein vertikaler Cutter bei x=2 → zwei Stuecke.
        // Pick bei (0.5,0) → linkes Stueck faellt weg, rechtes bleibt.
        let cutters = [poly(&[(2.0, -1.0), (2.0, 1.0)], false)];
        let rest = trim_segment(
            Vec2::new(0.0, 0.0),
            Vec2::new(4.0, 0.0),
            &cutters,
            Vec2::new(0.5, 0.0),
        );
        assert_eq!(rest.len(), 1);
        assert!((rest[0].0.x - 2.0).abs() < 1e-9 && (rest[0].1.x - 4.0).abs() < 1e-9);
    }

    #[test]
    fn split_at_intersections_closed_square_by_two_cuts() {
        // Einheitsquadrat, ein waagerechter Schneider y=0.5 quer → zwei Ringe.
        let square = [
            Vec2::new(0.0, 0.0),
            Vec2::new(1.0, 0.0),
            Vec2::new(1.0, 1.0),
            Vec2::new(0.0, 1.0),
        ];
        let others = vec![vec![Vec2::new(-1.0, 0.5), Vec2::new(2.0, 0.5)]];
        let parts = split_at_intersections(&square, true, &others);
        assert_eq!(parts.len(), 2, "zwei geschlossene Teilpolygone");
        for p in &parts {
            assert!(p.len() >= 3);
        }
    }

    #[test]
    fn join_chains_merges_and_closes() {
        // Drei offene Kanten eines Dreiecks → eine geschlossene Kette.
        let input = vec![
            poly(&[(0.0, 0.0), (1.0, 0.0)], false),
            poly(&[(1.0, 0.0), (0.5, 1.0)], false),
            poly(&[(0.5, 1.0), (0.0, 0.0)], false),
        ];
        let out = join_chains(&input);
        assert_eq!(out.len(), 1);
        assert!(out[0].closed, "Dreieck schliesst sich");
        assert_eq!(out[0].pts.len(), 3, "Schlusspunkt-Duplikat entfernt");
    }

    #[test]
    fn remove_segment_open_keeps_longer_piece() {
        // Offene Polylinie mit 5 Punkten; innere Kante 1 entfernen → laengeres Stueck.
        let pts: Vec<Vec2> = (0..5).map(|i| Vec2::new(i as f64, 0.0)).collect();
        let out = remove_segment(&pts, false, 1);
        assert!(!out.closed);
        assert_eq!(out.pts.len(), 3, "rechtes (laengeres) Stueck pts[2..5]");
        assert!((out.pts[0].x - 2.0).abs() < 1e-9);
    }
}
