// kernel2d — 2D-Geometrie-Kern von Dossier (Offset/Trim/Extend/Fillet/Fase/Split/
// Join/Bruch, auch mit Bogen-Segmenten), dazu reine Geometrie aus room/ceiling/
// roomArea/stair/opening. Handgeschriebene f64-Mathematik, KEINE externen
// Geometrie-Crates. Ursprünglich als bitnaher Port von `src/geometry/kernel2d.ts`
// entstanden; seit der Umstellung auf den Rust-Kern ist DIESE Fassung die
// produktive: `dossier-core` bindet das Crate als Pfad-Abhängigkeit ein
// (`src-tauri/core/src/web/kernel2d.rs`), `kernel2d.ts` ist nur noch die Fassade.
// Die Bogen-Varianten liegen in `bulge.rs`.
//
// Numerische Regeln (aus der Paritaet mit der frueheren TS-Fassung, gelten weiter):
//   - `len` = Math.hypot → `f64::hypot` (NICHT (x²+y²).sqrt()).
//   - `normalize` Null-Guard: `len || 1` → `if l==0.0 {1.0} else {l}` (Ergebnis
//     {0,0}, kein NaN).
//   - Zwei Epsilons: EPS=1e-7 (kernel2d) UND hartkodiert 1e-9 in lineIntersect.
//   - Term-Reihenfolge in cross/signedArea/Diskriminante exakt beibehalten
//     (f64 nicht assoziativ; kein Kahan/Reorder).

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

mod bulge;
pub use bulge::*;

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
    if n < 2 || edge_index >= n {
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
    if n < 3 || i == j || i >= n || j >= n {
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
    if closed && n > 0 {
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

/// Nächste Position (Kantenindex, geklemmter Parameter) auf einer Punktfolge zu
/// `pt`; None bei < 2 Punkten. Grundlage für BREAK.
pub fn nearest_on_polyline(pts: &[Vec2], closed: bool, pt: Vec2) -> Option<(usize, f64)> {
    let n = pts.len();
    if n < 2 {
        return None;
    }
    let edge_count = if closed { n } else { n - 1 };
    let mut best: Option<(usize, f64)> = None;
    let mut best_d = f64::INFINITY;
    for i in 0..edge_count {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let t = project_param(pt, a, b).min(1.0).max(0.0);
        let d = dist(pt, lerp(a, b, t));
        if d < best_d {
            best_d = d;
            best = Some((i, t));
        }
    }
    best
}

/// Entfernt den Abschnitt ZWISCHEN zwei Positionen (Kantenindex, t) einer OFFENEN
/// Kurve (BREAK, Zwei-Punkt-Variante; Reihenfolge egal). Bis zu zwei Reststücke.
/// Positionen ausserhalb der Kurve → leer.
pub fn break_curve(pts: &[Vec2], hit1: (usize, f64), hit2: (usize, f64)) -> Vec<Vec<Vec2>> {
    let pos = |h: (usize, f64)| h.0 as f64 + h.1;
    let (lo, hi) = if pos(hit1) <= pos(hit2) { (hit1, hit2) } else { (hit2, hit1) };
    if lo.0 + 1 >= pts.len() || hi.0 + 1 >= pts.len() {
        return Vec::new();
    }
    let p1 = lerp(pts[lo.0], pts[lo.0 + 1], lo.1);
    let p2 = lerp(pts[hi.0], pts[hi.0 + 1], hi.1);
    let mut left = pts[..lo.0 + 1].to_vec();
    left.push(p1);
    let mut right = vec![p2];
    right.extend_from_slice(&pts[hi.0 + 1..]);
    [dedupe_consecutive(&left), dedupe_consecutive(&right)].into_iter().filter(|s| s.len() >= 2).collect()
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

pub const IDEAL_RISER: f64 = 0.17;
pub const IDEAL_TREAD: f64 = 0.29;
pub const MIN_STEPS: i64 = 2;
const DEG: f64 = std::f64::consts::PI / 180.0;

/// norm in stair.ts: `lenOf(a) || 1e-9` (NICHT EPS!).
#[inline]
fn stair_norm(a: Vec2) -> Vec2 {
    let l = len(a);
    let l = if l == 0.0 { 1e-9 } else { l };
    Vec2 { x: a.x / l, y: a.y / l }
}

/// Linke Normale (stair.ts `leftN`).
#[inline]
fn stair_left_n(u: Vec2) -> Vec2 {
    Vec2 { x: -u.y, y: u.x }
}

/// Sinnvolle Default-Stufenzahl (Port von `defaultStepCount`).
pub fn default_step_count(total_rise: f64, run_length: f64) -> i64 {
    let by_rise = (total_rise / IDEAL_RISER).round() as i64;
    let by_rise = if by_rise < MIN_STEPS { MIN_STEPS } else { by_rise };
    let max_by_run = if run_length > 0.0 {
        let v = (run_length / 0.24).floor() as i64 + 1;
        if v < MIN_STEPS { MIN_STEPS } else { v }
    } else {
        by_rise
    };
    let res = if by_rise < max_by_run { by_rise } else { max_by_run };
    if res < MIN_STEPS { MIN_STEPS } else { res }
}

/// Ein Tritt im Grundriss (Port von `TreadRect`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreadRect {
    pub pts: Vec<Vec2>,
    pub index: i64,
    pub top_rise: f64,
    pub base_rise: f64,
}

/// Vollstaendige abgeleitete Treppengeometrie (Port von `StairGeometry`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StairGeometry {
    pub treads: Vec<TreadRect>,
    pub landing: Option<Vec<Vec2>>,
    pub riser_height: f64,
    pub tread_depth: f64,
    pub run_line: Vec<Vec2>,
    pub arrow: StairArrow,
    pub total_rise: f64,
}

/// Auf-/Abpfeil (Port von `arrow`-Typ in stair.ts).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StairArrow {
    pub shaft: (Vec2, Vec2),
    pub head: (Vec2, Vec2, Vec2),
}

/// Schnitt-Aufteilung (Port von `StairCut`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StairCut {
    pub below_indices: Vec<i64>,
    pub above_indices: Vec<i64>,
    pub break_line: Option<Vec<(Vec2, Vec2)>>,
}

/// Achsparallele BBox (Treppen, eigenes Struct um Konflikte zu vermeiden).
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StairBBox {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// Tritt-Rechteck zwischen Achsparametern `a0..a1` entlang `dir`, Breite `half_w`
/// (Port der lokalen Hilfsfunktion `treadRect`).
fn tread_rect_pts(origin: Vec2, dir: Vec2, n: Vec2, a0: f64, a1: f64, half_w: f64) -> Vec<Vec2> {
    let p0 = add(origin, scale(dir, a0));
    let p1 = add(origin, scale(dir, a1));
    vec![
        add(p0, scale(n, half_w)),
        add(p1, scale(n, half_w)),
        add(p1, scale(n, -half_w)),
        add(p0, scale(n, -half_w)),
    ]
}

/// Auf-/Abpfeil aus der Lauflinie (Port von `arrowFor`).
fn arrow_for(run_line: &[Vec2], up: bool) -> StairArrow {
    let a = run_line[0];
    let b = run_line[run_line.len() - 1];
    let tip = if up { b } else { a };
    let from = if up {
        run_line[run_line.len() - 2]
    } else {
        run_line[1]
    };
    let dir = stair_norm(sub(tip, from));
    let n = stair_left_n(dir);
    let s = 0.22_f64;
    let back = add(tip, scale(dir, -s));
    let w1 = add(back, scale(n, s * 0.55));
    let w2 = add(back, scale(n, -s * 0.55));
    StairArrow { shaft: (a, b), head: (w1, tip, w2) }
}

/// Achteck-Approximation des Wendel-Auges (Port von `eyePolygon`, 12 Segmente).
fn eye_polygon(center: Vec2, r: f64) -> Vec<Vec2> {
    (0..12).map(|i| {
        let t = (i as f64 / 12.0) * std::f64::consts::PI * 2.0;
        Vec2 { x: center.x + r * t.cos(), y: center.y + r * t.sin() }
    }).collect()
}

/// Treppen-Parameter (enthaelt alle geometrisch relevanten
/// Felder des TS-Typs `Stair`; Modell-Semantik-Felder wie id/floorId werden
/// ignoriert).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StairParams {
    pub shape: String,
    pub start: Vec2,
    pub dir: Vec2,
    pub run_length: f64,
    #[serde(default)]
    pub run2_length: Option<f64>,
    #[serde(default)]
    pub turn: Option<i32>,
    #[serde(default)]
    pub center: Option<Vec2>,
    #[serde(default)]
    pub radius: Option<f64>,
    #[serde(default)]
    pub sweep: Option<f64>,
    pub width: f64,
    pub step_count: i64,
    #[serde(default)]
    pub up: Option<bool>,
    /// Bezugskante der gespeicherten Achse: "links" | "mitte" | "rechts" (fehlend = Mitte).
    #[serde(default)]
    pub referenz: Option<String>,
}

/// Achse auf die visuelle Treppen-MITTE versetzen (Referenz links/rechts): `start` und `center`
/// wandern um ±halbe Breite quer zur Laufrichtung. "mitte"/fehlend: unverändert.
/// `links` = Achse ist die linke Kante, die Mitte liegt eine halbe Breite rechts (−n).
fn stair_at_mid(stair: &StairParams, u: Vec2, half_w: f64) -> StairParams {
    let mut s = stair.clone();
    let mid_off = match stair.referenz.as_deref() {
        Some("links") => -half_w,
        Some("rechts") => half_w,
        _ => return s,
    };
    let c = scale(stair_left_n(u), mid_off);
    s.start = add(stair.start, c);
    s.center = stair.center.map(|ce| add(ce, c));
    s
}

/// Gerade Treppe (Port von `straightGeometry`).
fn straight_geometry(
    stair: &StairParams,
    total_rise: f64,
    steps: i64,
    riser_height: f64,
    half_w: f64,
    u: Vec2,
    n: Vec2,
) -> StairGeometry {
    let run_length = stair.run_length.max(0.1);
    let tread_depth = run_length / steps as f64;
    let mut treads: Vec<TreadRect> = Vec::new();
    for i in 0..steps {
        treads.push(TreadRect {
            pts: tread_rect_pts(stair.start, u, n, i as f64 * tread_depth, (i + 1) as f64 * tread_depth, half_w),
            index: i,
            base_rise: i as f64 * riser_height,
            top_rise: (i + 1) as f64 * riser_height,
        });
    }
    let run_line: Vec<Vec2> = vec![
        add(stair.start, scale(u, tread_depth * 0.5)),
        add(stair.start, scale(u, run_length - tread_depth * 0.15)),
    ];
    let up = stair.up.unwrap_or(true);
    StairGeometry {
        arrow: arrow_for(&run_line, up),
        treads,
        landing: None,
        riser_height,
        tread_depth,
        run_line,
        total_rise,
    }
}

/// L-Treppe (Port von `lGeometry`).
fn l_geometry(
    stair: &StairParams,
    total_rise: f64,
    steps: i64,
    riser_height: f64,
    half_w: f64,
    u: Vec2,
    n: Vec2,
) -> StairGeometry {
    let run1 = stair.run_length.max(0.1);
    let run2 = stair.run2_length.unwrap_or(stair.run_length).max(0.1);
    let turn = stair.turn.unwrap_or(1);
    let body_steps = steps - 1;
    let s1 = {
        let v = ((body_steps as f64 * run1) / (run1 + run2)).round() as i64;
        if v < 1 { 1 } else { v }
    };
    let s2 = {
        let v = body_steps - s1;
        if v < 1 { 1 } else { v }
    };
    let td1 = run1 / s1 as f64;
    let td2 = run2 / s2 as f64;

    let mut treads: Vec<TreadRect> = Vec::new();
    let mut rise = 0.0_f64;
    for i in 0..s1 {
        treads.push(TreadRect {
            pts: tread_rect_pts(stair.start, u, n, i as f64 * td1, (i + 1) as f64 * td1, half_w),
            index: i,
            base_rise: rise,
            top_rise: rise + riser_height,
        });
        rise += riser_height;
    }
    let corner_center = add(stair.start, scale(u, run1 + half_w));
    let u2: Vec2 = if turn > 0 { n } else { scale(n, -1.0) };
    let n2 = stair_left_n(u2);
    let landing: Vec<Vec2> = vec![
        add(add(corner_center, scale(u, -half_w)), scale(n, half_w)),
        add(add(corner_center, scale(u, half_w)), scale(n, half_w)),
        add(add(corner_center, scale(u, half_w)), scale(n, -half_w)),
        add(add(corner_center, scale(u, -half_w)), scale(n, -half_w)),
    ];
    rise += riser_height; // Podest-Tritt
    let run2_start = add(corner_center, scale(u2, half_w));
    for i in 0..s2 {
        treads.push(TreadRect {
            pts: tread_rect_pts(run2_start, u2, n2, i as f64 * td2, (i + 1) as f64 * td2, half_w),
            index: s1 + 1 + i,
            base_rise: rise,
            top_rise: rise + riser_height,
        });
        rise += riser_height;
    }
    let run_line: Vec<Vec2> = vec![
        add(stair.start, scale(u, td1 * 0.5)),
        corner_center,
        add(run2_start, scale(u2, run2 - td2 * 0.15)),
    ];
    let up = stair.up.unwrap_or(true);
    StairGeometry {
        arrow: arrow_for(&run_line, up),
        treads,
        landing: Some(landing),
        riser_height,
        tread_depth: td1,
        run_line,
        total_rise,
    }
}

/// Wendeltreppe (Port von `spiralGeometry`).
fn spiral_geometry(
    stair: &StairParams,
    total_rise: f64,
    steps: i64,
    riser_height: f64,
    half_w: f64,
) -> StairGeometry {
    let center = stair.center.unwrap_or(stair.start);
    let radius = (half_w + 0.1).max(stair.radius.unwrap_or(stair.width));
    let sweep = stair.sweep.unwrap_or(270.0) * DEG;
    let start_vec = sub(stair.start, center);
    let a0 = start_vec.y.atan2(start_vec.x);
    let d_a = sweep / steps as f64;
    let r_in = (radius - half_w).max(0.02);
    let r_out = radius + half_w;

    let mut treads: Vec<TreadRect> = Vec::new();
    for i in 0..steps {
        let t0 = a0 + i as f64 * d_a;
        let t1 = a0 + (i + 1) as f64 * d_a;
        let pts: Vec<Vec2> = vec![
            Vec2 { x: center.x + r_in * t0.cos(), y: center.y + r_in * t0.sin() },
            Vec2 { x: center.x + r_out * t0.cos(), y: center.y + r_out * t0.sin() },
            Vec2 { x: center.x + r_out * t1.cos(), y: center.y + r_out * t1.sin() },
            Vec2 { x: center.x + r_in * t1.cos(), y: center.y + r_in * t1.sin() },
        ];
        treads.push(TreadRect {
            pts,
            index: i,
            base_rise: i as f64 * riser_height,
            top_rise: (i + 1) as f64 * riser_height,
        });
    }
    let n_seg = steps.max(2) as usize;
    let mut run_line: Vec<Vec2> = Vec::new();
    for i in 0..=n_seg {
        let tt = a0 + (sweep * i as f64) / n_seg as f64;
        run_line.push(Vec2 { x: center.x + radius * tt.cos(), y: center.y + radius * tt.sin() });
    }
    let tread_depth = (2.0 * std::f64::consts::PI * radius * (sweep / (2.0 * std::f64::consts::PI))) / steps as f64;
    let up = stair.up.unwrap_or(true);
    StairGeometry {
        arrow: arrow_for(&run_line, up),
        treads,
        landing: Some(eye_polygon(center, r_in)),
        riser_height,
        tread_depth,
        run_line,
        total_rise,
    }
}

/// Vollstaendige Treppengeometrie (Port von `stairGeometry`).
pub fn stair_geometry(stair: &StairParams, total_rise: f64) -> StairGeometry {
    let steps = (stair.step_count as i64).max(MIN_STEPS);
    let riser_height = total_rise / steps as f64;
    let half_w = (0.05_f64).max(stair.width / 2.0);
    let u = stair_norm(stair.dir);
    let n = stair_left_n(u);
    let s = stair_at_mid(stair, u, half_w);
    let stair = &s;

    if stair.shape == "spiral" {
        return spiral_geometry(stair, total_rise, steps, riser_height, half_w);
    }
    if stair.shape == "L" {
        return l_geometry(stair, total_rise, steps, riser_height, half_w, u, n);
    }
    straight_geometry(stair, total_rise, steps, riser_height, half_w, u, n)
}

/// Aussenlinie einer Wendeltreppe: radiale Schliesslinien + Innen-/Aussenbogen.
#[derive(Clone, Debug)]
pub struct SpiralOutline {
    /// Radiale Abschlusslinien (Innenpunkt → Aussenpunkt) bei a0 und a1.
    pub lines: [(Vec2, Vec2); 2],
    /// Kreisbögen (Mittelpunkt, r, a0, a1): Innen- und Aussenkreis.
    pub arcs: [(Vec2, f64, f64, f64); 2],
}

/// Plan-Aussenlinie: genau eines von `polygon` (gerade/L) bzw. `spiral` (Wendel) ist gesetzt.
#[derive(Clone, Debug)]
pub struct StairOutline {
    pub polygon: Option<Vec<Vec2>>,
    pub spiral: Option<SpiralOutline>,
}

/// Linien-Schnittpunkt wie TS `lineIntersect2d` (det < 1e-9 → None).
fn stair_line_intersect(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2) -> Option<Vec2> {
    let det = d1.x * (-d2.y) - d1.y * (-d2.x);
    if det.abs() < 1e-9 {
        return None;
    }
    let dx = p2.x - p1.x;
    let dy = p2.y - p1.y;
    let t = (dx * (-d2.y) - dy * (-d2.x)) / det;
    Some(Vec2 { x: p1.x + d1.x * t, y: p1.y + d1.y * t })
}

/// Aussenlinie einer Treppe im Grundriss (Port von `stairOutline`; Referenz wie in `stair_geometry`).
pub fn stair_outline(stair: &StairParams) -> StairOutline {
    let half_w = (0.05_f64).max(stair.width / 2.0);
    let u = stair_norm(stair.dir);
    let st = stair_at_mid(stair, u, half_w);
    let s = &st;
    let n = stair_left_n(u);
    if s.shape == "spiral" {
        let center = s.center.unwrap_or(s.start);
        let radius = (half_w + 0.1).max(s.radius.unwrap_or(s.width));
        let sweep = s.sweep.unwrap_or(270.0) * DEG;
        let sv = sub(s.start, center);
        let a0 = sv.y.atan2(sv.x);
        let a1 = a0 + sweep;
        let r_in = (radius - half_w).max(0.02);
        let r_out = radius + half_w;
        let at = |r: f64, a: f64| Vec2 { x: center.x + r * a.cos(), y: center.y + r * a.sin() };
        return StairOutline {
            polygon: None,
            spiral: Some(SpiralOutline {
                lines: [(at(r_in, a0), at(r_out, a0)), (at(r_in, a1), at(r_out, a1))],
                arcs: [(center, r_in, a0, a1), (center, r_out, a0, a1)],
            }),
        };
    }
    if s.shape == "L" {
        let l1 = s.run_length.max(1e-4);
        let turn = s.turn.unwrap_or(1);
        let u2 = if turn > 0 { n } else { scale(n, -1.0) };
        let n2 = stair_left_n(u2);
        let l2 = s.run2_length.unwrap_or(s.run_length).max(1e-4);
        let corner = add(s.start, scale(u, l1 + half_w));
        let run2_start = add(corner, scale(u2, half_w));
        let p0l = add(s.start, scale(n, half_w));
        let p0r = add(s.start, scale(n, -half_w));
        let end_run2 = add(run2_start, scale(u2, l2));
        let p3l = add(end_run2, scale(n2, half_w));
        let p3r = add(end_run2, scale(n2, -half_w));
        let corner_l = stair_line_intersect(p0l, u, p3l, scale(u2, -1.0))
            .unwrap_or_else(|| add(corner, scale(n, half_w)));
        let corner_r = stair_line_intersect(p0r, u, p3r, scale(u2, -1.0))
            .unwrap_or_else(|| add(corner, scale(n, -half_w)));
        return StairOutline { polygon: Some(vec![p0l, p0r, corner_r, p3r, p3l, corner_l]), spiral: None };
    }
    let l = s.run_length.max(1e-4);
    let end = add(s.start, scale(u, l));
    StairOutline {
        polygon: Some(vec![
            add(s.start, scale(n, half_w)),
            add(s.start, scale(n, -half_w)),
            add(end, scale(n, -half_w)),
            add(end, scale(n, half_w)),
        ]),
        spiral: None,
    }
}

/// Punkt-in-Polygon (Ray-Casting) — gleiches Muster wie `pointInOutline` /
/// stair.ts `pointInPolygon` (Nenner-Guard `|| 1e-12`).
pub fn point_in_polygon(p: Vec2, poly: &[Vec2]) -> bool {
    let nn = poly.len();
    if nn == 0 {
        return false;
    }
    let mut inside = false;
    let mut j = nn - 1;
    for i in 0..nn {
        let a = poly[i];
        let b = poly[j];
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

/// Schnittaufteilung (Port von `stairCut`).
pub fn stair_cut(geo: &StairGeometry, cut_rise: f64) -> StairCut {
    let mut below: Vec<i64> = Vec::new();
    let mut above: Vec<i64> = Vec::new();
    let mut break_idx: i64 = -1;
    for tr in &geo.treads {
        if tr.top_rise <= cut_rise + 1e-6 {
            below.push(tr.index);
        } else {
            if break_idx < 0 {
                break_idx = tr.index;
            }
            above.push(tr.index);
        }
    }
    let break_line = if break_idx >= 0 {
        geo.treads.iter().find(|t| t.index == break_idx).map(|tr| {
            let (c0, c1, c2, c3) = (tr.pts[0], tr.pts[1], tr.pts[2], tr.pts[3]);
            let mid01 = scale(add(c0, c1), 0.5);
            let mid23 = scale(add(c2, c3), 0.5);
            let off = scale(stair_norm(sub(c1, c0)), 0.06);
            vec![
                (add(mid01, off), add(mid23, off)),
                (sub(mid01, off), sub(mid23, off)),
            ]
        })
    } else {
        None
    };
    StairCut { below_indices: below, above_indices: above, break_line }
}

/// Achsparallele BBox aller Tritte + Podest (Port von `stairBBox`).
pub fn stair_bbox(geo: &StairGeometry) -> StairBBox {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for tr in &geo.treads {
        for p in &tr.pts {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x);
            max_y = max_y.max(p.y);
        }
    }
    if let Some(land) = &geo.landing {
        for p in land {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x);
            max_y = max_y.max(p.y);
        }
    }
    if !min_x.is_finite() {
        return StairBBox { min_x: 0.0, min_y: 0.0, max_x: 0.0, max_y: 0.0 };
    }
    StairBBox { min_x, min_y, max_x, max_y }
}

/// Ob ein Punkt irgendeinen Tritt (oder das Podest) trifft (Port `pointHitsStair`).
pub fn point_hits_stair(p: Vec2, geo: &StairGeometry) -> bool {
    for tr in &geo.treads {
        if point_in_polygon(p, &tr.pts) {
            return true;
        }
    }
    if let Some(land) = &geo.landing {
        if point_in_polygon(p, land) {
            return true;
        }
    }
    false
}

// --- Raum-Erkennung (roomBoundary.ts, Slice 3) -------------------------------
// Lokale Konstanten exakt wie TS (EPS=1e-9, normalize-Guard 1e-12).

const RB_EPS: f64 = 1e-9;

/// normalize (roomBoundary-Variante): Guard `l < 1e-12 → {0,0}` (NICHT `l||1`).
#[inline]
fn rb_normalize(a: Vec2) -> Vec2 {
    let l = len(a);
    if l < 1e-12 { Vec2 { x: 0.0, y: 0.0 } } else { Vec2 { x: a.x / l, y: a.y / l } }
}

/// cross (lokal, identisch zur globalen).
#[inline]
fn rb_cross(a: Vec2, b: Vec2) -> f64 {
    a.x * b.y - a.y * b.x
}

// ── Planarer Graph ────────────────────────────────────────────────────────────

struct RbNode {
    p: Vec2,
}

struct RbUEdge {
    u: usize,
    v: usize,
}

struct RbSplit {
    t: f64,
    p: Vec2,
}

/// Baut den planaren Graphen aus Mittellinien-Segmenten (Port von `buildPlanarGraph`).
fn build_planar_graph(segments: &[(Vec2, Vec2)], snap: f64) -> (Vec<RbNode>, Vec<RbUEdge>) {
    let mut nodes: Vec<RbNode> = Vec::new();

    let add_node = |nodes: &mut Vec<RbNode>, p: Vec2| -> usize {
        for i in 0..nodes.len() {
            if dist(nodes[i].p, p) <= snap {
                return i;
            }
        }
        nodes.push(RbNode { p: Vec2 { x: p.x, y: p.y } });
        nodes.len() - 1
    };

    // Rohe Segmente: degenerate (zu kurze) herausfiltern.
    let raw: Vec<(Vec2, Vec2)> = segments
        .iter()
        .filter(|(a, b)| dist(*a, *b) > snap)
        .cloned()
        .collect();

    let mut per_segment: Vec<Vec<RbSplit>> = raw
        .iter()
        .map(|(a, b)| vec![RbSplit { t: 0.0, p: *a }, RbSplit { t: 1.0, p: *b }])
        .collect();

    for i in 0..raw.len() {
        for j in i + 1..raw.len() {
            let (aa, ab) = raw[i];
            let (ba, bb) = raw[j];
            let da = sub(ab, aa);
            let db = sub(bb, ba);
            let denom = rb_cross(da, db);
            if denom.abs() < RB_EPS {
                continue;
            }
            let t = rb_cross(sub(ba, aa), db) / denom;
            let s = rb_cross(sub(ba, aa), da) / denom;
            let tol_t = snap / len(da).max(1e-9);
            let tol_s = snap / len(db).max(1e-9);
            if t < -tol_t || t > 1.0 + tol_t || s < -tol_s || s > 1.0 + tol_s {
                continue;
            }
            let p = add(aa, scale(da, t));
            per_segment[i].push(RbSplit { t, p });
            per_segment[j].push(RbSplit { t: s, p });
        }
    }

    let mut edge_set: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
    let mut edges: Vec<RbUEdge> = Vec::new();

    let push_edge = |edges: &mut Vec<RbUEdge>, edge_set: &mut std::collections::HashSet<(usize, usize)>, u: usize, v: usize| {
        if u == v { return; }
        let key = if u < v { (u, v) } else { (v, u) };
        if edge_set.contains(&key) { return; }
        edge_set.insert(key);
        edges.push(RbUEdge { u, v });
    };

    for i in 0..raw.len() {
        per_segment[i].sort_by(|p, q| p.t.partial_cmp(&q.t).unwrap_or(std::cmp::Ordering::Equal));
        let mut prev: Option<usize> = None;
        let mut prev_t = f64::NEG_INFINITY;
        for sp in &per_segment[i] {
            if sp.t - prev_t < 1e-9 && prev.is_some() {
                continue;
            }
            let idx = add_node(&mut nodes, sp.p);
            if let Some(pr) = prev {
                if idx != pr {
                    push_edge(&mut edges, &mut edge_set, pr, idx);
                }
            }
            prev = Some(idx);
            prev_t = sp.t;
        }
    }

    (nodes, edges)
}

// ── Face-Extraktion ───────────────────────────────────────────────────────────

struct RbHalfEdge {
    from: usize,
    to: usize,
    angle: f64,
    used: bool,
}

/// Extrahiert die minimalen geschlossenen Maschen (Port von `extractFaces`).
fn extract_faces(nodes: &[RbNode], edges: &[RbUEdge]) -> Vec<Vec<usize>> {
    let mut half_edges: Vec<RbHalfEdge> = Vec::new();
    let mut outgoing: Vec<Vec<usize>> = (0..nodes.len()).map(|_| Vec::new()).collect();

    let angle_of = |from: usize, to: usize| -> f64 {
        let d = sub(nodes[to].p, nodes[from].p);
        d.y.atan2(d.x)
    };

    for e in edges {
        let h1 = half_edges.len();
        half_edges.push(RbHalfEdge { from: e.u, to: e.v, angle: angle_of(e.u, e.v), used: false });
        outgoing[e.u].push(h1);
        let h2 = half_edges.len();
        half_edges.push(RbHalfEdge { from: e.v, to: e.u, angle: angle_of(e.v, e.u), used: false });
        outgoing[e.v].push(h2);
    }

    // Abgehende Halbkanten je Knoten nach Winkel sortieren (stabil).
    for list in outgoing.iter_mut() {
        list.sort_by(|&h1, &h2| half_edges[h1].angle.partial_cmp(&half_edges[h2].angle).unwrap_or(std::cmp::Ordering::Equal));
    }

    // Positionsindex je Halbkante in der sortierten Liste seines from-Knotens.
    let mut pos_in_list: Vec<usize> = vec![0; half_edges.len()];
    for list in &outgoing {
        for (k, &h) in list.iter().enumerate() {
            pos_in_list[h] = k;
        }
    }

    // Zwilling: Paare liegen benachbart (2i, 2i+1).
    let twin = |h: usize| -> usize { if h % 2 == 0 { h + 1 } else { h - 1 } };

    let mut faces: Vec<Vec<usize>> = Vec::new();
    let max_steps = half_edges.len() + 2;

    for start in 0..half_edges.len() {
        if half_edges[start].used {
            continue;
        }
        let mut face_nodes: Vec<usize> = Vec::new();
        let mut h = start;
        let mut guard = 0;
        loop {
            half_edges[h].used = true;
            face_nodes.push(half_edges[h].from);
            let tw = twin(h);
            let to = half_edges[h].to;
            let list = &outgoing[to];
            let pos = pos_in_list[tw];
            let next_pos = if pos == 0 { list.len() - 1 } else { pos - 1 };
            h = list[next_pos];
            guard += 1;
            if h == start || guard >= max_steps {
                break;
            }
        }
        if face_nodes.len() >= 3 {
            faces.push(face_nodes);
        }
    }

    // Aussenmaschen verwerfen: nur CCW (positive Flaeche) behalten.
    faces.into_iter().filter(|f| {
        let poly: Vec<Vec2> = f.iter().map(|&n| nodes[n].p).collect();
        signed_area(&poly) > RB_EPS
    }).collect()
}

// ── Innen-Offset ──────────────────────────────────────────────────────────────

/// Versetzt ein CCW-Polygon um `d` nach innen (Port von `offsetInward`).
fn offset_inward(poly: &[Vec2], d: f64) -> Vec<Vec2> {
    let n = poly.len();
    if n < 3 || d <= 0.0 {
        return poly.to_vec();
    }
    // CCW sicherstellen.
    let pts_owned: Vec<Vec2>;
    let pts: &[Vec2] = if signed_area(poly) > 0.0 {
        poly
    } else {
        pts_owned = { let mut v = poly.to_vec(); v.reverse(); v };
        &pts_owned
    };
    // Verschobene Kanten: linke Normale zeigt ins Innere bei CCW.
    let shifted: Vec<(Vec2, Vec2)> = (0..n).map(|i| {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let dir = rb_normalize(sub(b, a));
        let nrm = left_normal(dir);
        (add(a, scale(nrm, d)), dir)
    }).collect();

    let mut out: Vec<Vec2> = Vec::new();
    for i in 0..n {
        let prev = &shifted[(i + n - 1) % n];
        let curr = &shifted[i];
        let denom = rb_cross(prev.1, curr.1);
        if denom.abs() < 1e-9 {
            out.push(curr.0);
            continue;
        }
        let t = rb_cross(sub(curr.0, prev.0), curr.1) / denom;
        out.push(add(prev.0, scale(prev.1, t)));
    }
    out
}

/// Dedupliziert aufeinanderfolgende nahezu gleiche Punkte im Ring (Port von
/// `dedupeRing`, Toleranz 1e-7 wie TS).
fn dedupe_ring_rb(pts: &[Vec2]) -> Vec<Vec2> {
    let tol = 1e-7_f64;
    let mut out: Vec<Vec2> = Vec::new();
    for &p in pts {
        if let Some(&last) = out.last() {
            if dist(last, p) <= tol {
                continue;
            }
        }
        out.push(p);
    }
    if out.len() > 1 {
        let first = out[0];
        if dist(first, *out.last().unwrap()) <= tol {
            out.pop();
        }
    }
    out
}

/// Durchschnittliche Wanddicke (Port von `averageThickness`).
fn average_thickness(walls: &[WallSegment]) -> f64 {
    if walls.is_empty() {
        return 0.0;
    }
    let s: f64 = walls.iter().map(|w| w.thickness).sum();
    s / walls.len() as f64
}

// ── Oeffentliche Structs (Raumerkennung) ───────────────────────────────

/// Wandsegment (Port von `WallSegment`): Mittellinie a→b mit Dicke.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WallSegment {
    pub a: Vec2,
    pub b: Vec2,
    pub thickness: f64,
}

/// Wand-Innenflaeche (Port von `WallFace`).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WallFace {
    pub a: Vec2,
    pub b: Vec2,
}

// ── Oeffentliche Funktionen ───────────────────────────────────────────────────

/// pointInPolygon (roomBoundary-Variante, KEIN Nenner-Guard — `b.y - a.y + 0`).
pub fn rb_point_in_polygon(p: Vec2, poly: &[Vec2]) -> bool {
    let mut inside = false;
    let n = poly.len();
    if n == 0 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let a = poly[i];
        let b = poly[j];
        let intersects =
            (a.y > p.y) != (b.y > p.y)
            && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x;
        if intersects {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Erkennt geschlossene Raeume aus Wandsegmenten (Port von `detectRooms`).
pub fn detect_rooms(
    walls: &[WallSegment],
    gap_tol: f64,
    min_area: f64,
    offset_to_inner: bool,
) -> Vec<Vec<Vec2>> {
    if walls.len() < 3 {
        return Vec::new();
    }
    let segs: Vec<(Vec2, Vec2)> = walls.iter().map(|w| (w.a, w.b)).collect();
    let (nodes, edges) = build_planar_graph(&segs, gap_tol);
    if edges.len() < 3 {
        return Vec::new();
    }
    let faces = extract_faces(&nodes, &edges);
    let half = average_thickness(walls) / 2.0;

    let mut rooms: Vec<Vec<Vec2>> = Vec::new();
    for f in faces {
        let raw: Vec<Vec2> = f.iter().map(|&n| nodes[n].p).collect();
        let mut poly = dedupe_ring_rb(&raw);
        if poly.len() < 3 {
            continue;
        }
        if offset_to_inner && half > 0.0 {
            poly = dedupe_ring_rb(&offset_inward(&poly, half));
            if poly.len() < 3 {
                continue;
            }
        }
        if polygon_area(&poly) < min_area {
            continue;
        }
        // Kanonisch CCW zurueckgeben.
        if signed_area(&poly) < 0.0 {
            poly.reverse();
        }
        rooms.push(poly);
    }
    rooms
}

/// Klick-in-Raum-Fallback (Port von `roomFromPointInside`).
pub fn room_from_point_inside(
    point: Vec2,
    walls: &[WallSegment],
    gap_tol: f64,
    offset_to_inner: bool,
) -> Option<Vec<Vec2>> {
    if walls.len() < 3 {
        return None;
    }
    let segs: Vec<(Vec2, Vec2)> = walls.iter().map(|w| (w.a, w.b)).collect();
    let (nodes, edges) = build_planar_graph(&segs, gap_tol);
    if edges.len() < 3 {
        return None;
    }
    let faces = extract_faces(&nodes, &edges);
    let half = average_thickness(walls) / 2.0;

    let mut best: Option<Vec<Vec2>> = None;
    let mut best_area = f64::INFINITY;

    for f in faces {
        let raw: Vec<Vec2> = f.iter().map(|&n| nodes[n].p).collect();
        let raw = dedupe_ring_rb(&raw);
        if raw.len() < 3 {
            continue;
        }
        if !rb_point_in_polygon(point, &raw) {
            continue;
        }
        let area = polygon_area(&raw);
        if area >= best_area {
            continue;
        }
        let mut inner = raw.clone();
        if offset_to_inner && half > 0.0 {
            let off = dedupe_ring_rb(&offset_inward(&raw, half));
            if off.len() >= 3 {
                inner = off;
            }
        }
        if signed_area(&inner) < 0.0 {
            inner.reverse();
        }
        best = Some(inner);
        best_area = area;
    }

    best
}

/// Klick-Tracer auf bereits berechneten Wand-Innenflaechen (Port von
/// `roomFromPointInsideFaces`).
pub fn room_from_point_inside_faces(
    point: Vec2,
    wall_faces: &[WallFace],
    gap_tol: f64,
) -> Option<Vec<Vec2>> {
    if wall_faces.len() < 3 {
        return None;
    }
    let segs: Vec<(Vec2, Vec2)> = wall_faces.iter().map(|f| (f.a, f.b)).collect();
    let (nodes, edges) = build_planar_graph(&segs, gap_tol);
    if edges.len() < 3 {
        return None;
    }
    let faces = extract_faces(&nodes, &edges);

    let mut best: Option<Vec<Vec2>> = None;
    let mut best_area = f64::INFINITY;

    for f in faces {
        let raw: Vec<Vec2> = f.iter().map(|&n| nodes[n].p).collect();
        let poly = dedupe_ring_rb(&raw);
        if poly.len() < 3 {
            continue;
        }
        if !rb_point_in_polygon(point, &poly) {
            continue;
        }
        let area = polygon_area(&poly);
        if area < best_area {
            let mut out = poly;
            if signed_area(&out) < 0.0 {
                out.reverse();
            }
            best = Some(out);
            best_area = area;
        }
    }

    best
}

// --- Oeffnungs-Geometrie (Port von src/geometry/opening.ts, Slice 4) --------
// `Wall`/`Opening`/`Project`-Kopplung durch Vec2/number-Parameter ersetzt
// (PORT_PLAN §1 "Teilweise im Scope"): `thickness`/`refOffset` werden hier als
// bereits aufgeloeste Zahlen uebergeben (TS: `wallTypeThickness(getWallType(...))`
// bzw. `wallReferenceOffset(wall, total)` gegen ein `Project`). Nur
// `openingVerticalExtent` bleibt TS (haengt an `Project.drawingLevels` via
// `wallVerticalExtent`) und wird hier NICHT portiert.
//
// `DEG` (Grad→Radiant, Port des lokalen `DEG` in opening.ts) ist bereits als
// modul-weite Konstante aus dem stair-Slice vorhanden (identischer Wert).

/// Punkt entlang der Strecke p1→p2 im Abstand d vom Start (Port von `along`
/// aus src/model/geometry.ts).
pub fn along(p1: Vec2, p2: Vec2, d: f64) -> Vec2 {
    add(p1, scale(normalize(sub(p2, p1)), d))
}

/// Achslaenge einer Wand (Port von `wallAxisLength`; Wand → start/end).
pub fn wall_axis_length(start: Vec2, end: Vec2) -> f64 {
    (end.x - start.x).hypot(end.y - start.y)
}

/// Oeffnungs-Intervall entlang der Achse (Port von `openingInterval`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Interval {
    pub from: f64,
    pub to: f64,
}

pub fn opening_interval(start: Vec2, end: Vec2, position: f64, width: f64) -> Option<Interval> {
    let axis = wall_axis_length(start, end);
    let from = position.min(axis).max(0.0);
    let to = (position + width).min(axis).max(from);
    if to - from < 1e-4 {
        return None; // entartet: Breite <= 0 oder vollstaendig ausserhalb der Achse
    }
    Some(Interval { from, to })
}

/// Einheits-Laufrichtung (u) und linke Normale (n) der Wandachse (Port von
/// `wallAxisFrame`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct AxisFrame {
    pub u: Vec2,
    pub n: Vec2,
}

pub fn wall_axis_frame(start: Vec2, end: Vec2) -> AxisFrame {
    let u = normalize(sub(end, start));
    AxisFrame { u, n: left_normal(u) }
}

/// Die beiden Pfosten-Punkte einer Oeffnung im Grundriss (Port von `openingJambs`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Jambs {
    pub jamb_start: Vec2,
    pub jamb_end: Vec2,
}

pub fn opening_jambs(start: Vec2, end: Vec2, position: f64, width: f64) -> Option<Jambs> {
    let iv = opening_interval(start, end, position, width)?;
    Some(Jambs {
        jamb_start: along(start, end, iv.from),
        jamb_end: along(start, end, iv.to),
    })
}

/// Luecken-Rechteck-Ecken ueber die volle Wanddicke (Port von `openingGapQuad`).
/// Reihenfolge: jambStart(+n/2) → jambEnd(+n/2) → jambEnd(−n/2) → jambStart(−n/2).
pub fn opening_gap_quad(
    start: Vec2,
    end: Vec2,
    position: f64,
    width: f64,
    thickness: f64,
    ref_offset: f64,
) -> Option<Vec<Vec2>> {
    let jambs = opening_jambs(start, end, position, width)?;
    let n = wall_axis_frame(start, end).n;
    let outer = ref_offset + thickness / 2.0;
    let inner = ref_offset - thickness / 2.0;
    Some(vec![
        add(jambs.jamb_start, scale(n, outer)),
        add(jambs.jamb_end, scale(n, outer)),
        add(jambs.jamb_end, scale(n, inner)),
        add(jambs.jamb_start, scale(n, inner)),
    ])
}

/// Mittelpunkt einer Oeffnung im Grundriss (Port von `openingCenter`).
pub fn opening_center(start: Vec2, end: Vec2, position: f64, width: f64) -> Option<Vec2> {
    let iv = opening_interval(start, end, position, width)?;
    Some(along(start, end, (iv.from + iv.to) / 2.0))
}

/// Aufgeloeste Tuer-Symbol-Geometrie im Grundriss (Port von `DoorSymbol`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DoorSymbol {
    pub hinge: Vec2,
    pub open_end: Vec2,
    pub closed_end: Vec2,
    pub radius: f64,
    pub jamb_start: Vec2,
    pub jamb_end: Vec2,
    pub normal: Vec2,
}

/// Port von `doorSymbol`. `swing`/`opening_dir`/`hinge_side` folgen der TS-
/// `??`-Fallback-Semantik (`None` → TS-Default); `swing_angle` `None` → 90°.
pub fn door_symbol(
    start: Vec2,
    end: Vec2,
    position: f64,
    width: f64,
    swing: Option<&str>,
    opening_dir: Option<&str>,
    hinge_side: Option<&str>,
    swing_angle: Option<f64>,
) -> Option<DoorSymbol> {
    let jambs = opening_jambs(start, end, position, width)?;
    let frame = wall_axis_frame(start, end);
    let (jamb_start, jamb_end) = (jambs.jamb_start, jambs.jamb_end);
    // TS berechnet die Breite NEU aus den geklemmten Pfosten (nicht das rohe
    // `o.width`) — bewusst repliziert.
    let w = (jamb_end.x - jamb_start.x).hypot(jamb_end.y - jamb_start.y);

    let swing_sign = if swing.unwrap_or("left") == "left" { 1.0 } else { -1.0 };
    let dir_sign = if opening_dir.unwrap_or("in") == "in" { 1.0 } else { -1.0 };
    let swing_dir = scale(frame.n, swing_sign * dir_sign);

    let hinge_at_start = hinge_side.unwrap_or("start") == "start";
    let hinge = if hinge_at_start { jamb_start } else { jamb_end };
    let closed_dir = if hinge_at_start { frame.u } else { scale(frame.u, -1.0) };

    let angle = swing_angle.unwrap_or(90.0) * DEG;
    let open_dir = Vec2 {
        x: closed_dir.x * angle.cos() + swing_dir.x * angle.sin(),
        y: closed_dir.y * angle.cos() + swing_dir.y * angle.sin(),
    };
    Some(DoorSymbol {
        hinge,
        open_end: add(hinge, scale(open_dir, w)),
        closed_end: add(hinge, scale(closed_dir, w)),
        radius: w,
        jamb_start,
        jamb_end,
        normal: frame.n,
    })
}

/// Aufgeloeste Fenster-Linien im Grundriss (Port von `WindowSymbol`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowSymbol {
    pub frame: Vec<Vec2>,
    pub glass_lines: Vec<(Vec2, Vec2)>,
    pub mullion_lines: Vec<(Vec2, Vec2)>,
}

/// Port von `windowSymbol`. `thickness`/`ref_offset` sind bereits aufgeloeste
/// Werte (siehe Modul-Kommentar); `wing_count` `None` → TS-Default `1`.
pub fn window_symbol(
    start: Vec2,
    end: Vec2,
    position: f64,
    width: f64,
    thickness: f64,
    ref_offset: f64,
    glass_count: f64,
    wing_count: Option<f64>,
) -> Option<WindowSymbol> {
    let jambs = opening_jambs(start, end, position, width)?;
    let (jamb_start, jamb_end) = (jambs.jamb_start, jambs.jamb_end);
    let n = wall_axis_frame(start, end).n;
    let outer = ref_offset + thickness / 2.0;
    let inner = ref_offset - thickness / 2.0;
    let frame_quad = vec![
        add(jamb_start, scale(n, outer)),
        add(jamb_end, scale(n, outer)),
        add(jamb_end, scale(n, inner)),
        add(jamb_start, scale(n, inner)),
    ];

    let mut glass_lines: Vec<(Vec2, Vec2)> = Vec::new();
    let count = glass_count.max(1.0);
    let mut i: i64 = 0;
    while (i as f64) < count {
        let spread = thickness / 8.0;
        let off = if count == 1.0 {
            ref_offset
        } else {
            ref_offset + ((i as f64) - (count - 1.0) / 2.0) * spread * 2.0
        };
        glass_lines.push((add(jamb_start, scale(n, off)), add(jamb_end, scale(n, off))));
        i += 1;
    }

    let mut mullion_lines: Vec<(Vec2, Vec2)> = Vec::new();
    let wings = wing_count.unwrap_or(1.0).round().min(4.0).max(1.0);
    if wings > 1.0 {
        let post_depth = thickness * 0.6;
        let p_outer = ref_offset + post_depth / 2.0;
        let p_inner = ref_offset - post_depth / 2.0;
        let wings_n = wings as i64;
        for k in 1..wings_n {
            let t = k as f64 / wings;
            let on_axis = add(jamb_start, scale(sub(jamb_end, jamb_start), t));
            mullion_lines.push((add(on_axis, scale(n, p_outer)), add(on_axis, scale(n, p_inner))));
        }
    }

    Some(WindowSymbol { frame: frame_quad, glass_lines, mullion_lines })
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

    #[test]
    fn chamfer_rechter_winkel_und_kollinear() {
        let c = chamfer_corner(Vec2::new(0.0, 0.0), Vec2::new(2.0, 0.0), Vec2::new(0.0, 2.0), 0.5).unwrap();
        assert_eq!(c, Chamfer { a: Vec2::new(0.5, 0.0), b: Vec2::new(0.0, 0.5) });
        assert!(chamfer_corner(Vec2::new(0.0, 0.0), Vec2::new(2.0, 0.0), Vec2::new(-2.0, 0.0), 0.5).is_none());
        assert!(chamfer_corner(Vec2::new(0.0, 0.0), Vec2::new(2.0, 0.0), Vec2::new(0.0, 0.3), 0.5).is_none());
    }

    #[test]
    fn ttr_zwei_achsen_und_gerade_kreis() {
        let x = TangentTarget::Line { a: Vec2::new(-10.0, 0.0), b: Vec2::new(10.0, 0.0) };
        let y = TangentTarget::Line { a: Vec2::new(0.0, -10.0), b: Vec2::new(0.0, 10.0) };
        let c = tangent_circle_centers(x, y, 2.0);
        assert_eq!(c.len(), 4);
        for (qx, qy) in [(2.0, 2.0), (2.0, -2.0), (-2.0, 2.0), (-2.0, -2.0)] {
            assert!(c.iter().any(|p| (p.x - qx).abs() < 1e-9 && (p.y - qy).abs() < 1e-9));
        }
        let k = TangentTarget::Circle { center: Vec2::new(0.0, 6.0), r: 3.0 };
        let c = tangent_circle_centers(x, k, 2.0);
        assert!(c.iter().any(|p| (p.x - 3.0).abs() < 1e-9 && (p.y - 2.0).abs() < 1e-9));
        // Parallele Geraden im Abstand 2r: keine (statt unendlich vieler) Kandidaten.
        let l2 = TangentTarget::Line { a: Vec2::new(0.0, 4.0), b: Vec2::new(10.0, 4.0) };
        assert!(tangent_circle_centers(x, l2, 2.0).is_empty());
    }

    #[test]
    fn nearest_und_break() {
        let pts: Vec<Vec2> = vec![Vec2::new(0.0, 0.0), Vec2::new(4.0, 0.0), Vec2::new(4.0, 4.0)];
        let h1 = nearest_on_polyline(&pts, false, Vec2::new(1.0, 0.5)).unwrap();
        assert_eq!(h1.0, 0);
        assert!((h1.1 - 0.25).abs() < 1e-12);
        let h2 = nearest_on_polyline(&pts, false, Vec2::new(4.5, 2.0)).unwrap();
        assert_eq!(h2.0, 1);
        assert!(nearest_on_polyline(&pts[..1], false, Vec2::new(0.0, 0.0)).is_none());
        // Reihenfolge der Klicks egal.
        let out = break_curve(&pts, h2, h1);
        assert_eq!(out, vec![vec![Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0)], vec![Vec2::new(4.0, 2.0), Vec2::new(4.0, 4.0)]]);
        assert!(break_curve(&pts, (5, 0.5), (0, 0.5)).is_empty());
    }

    #[test]
    fn kaputte_indizes_ohne_panic() {
        let pts: Vec<Vec2> = (0..4).map(|i| Vec2::new(i as f64, (i % 2) as f64)).collect();
        assert_eq!(split_polyline_at_param(&pts, false, 9, 0.5), vec![pts.clone()]);
        assert!(split_closed_by_chord(&pts, 0, 0.5, 7, 0.5).is_none());
        assert!(remove_segment(&[], true, 3).pts.is_empty());
    }

    // --- Treppen ---------------------------------------------------------------------------

    fn stair(shape: &str) -> StairParams {
        StairParams {
            shape: shape.to_string(),
            start: Vec2 { x: 0.0, y: 0.0 },
            dir: Vec2 { x: 1.0, y: 0.0 },
            run_length: 3.0,
            run2_length: None,
            turn: None,
            center: None,
            radius: None,
            sweep: None,
            width: 1.2,
            step_count: 16,
            up: None,
            referenz: None,
        }
    }

    fn near(a: Vec2, x: f64, y: f64) -> bool {
        (a.x - x).abs() < 1e-9 && (a.y - y).abs() < 1e-9
    }

    #[test]
    fn stair_gerade_tritte_lauflinie_pfeil() {
        let g = stair_geometry(&stair("straight"), 2.8);
        assert_eq!(g.treads.len(), 16);
        assert!((g.riser_height - 0.175).abs() < 1e-12);
        assert!((g.tread_depth - 3.0 / 16.0).abs() < 1e-12);
        assert!(g.landing.is_none());
        let t0 = &g.treads[0];
        assert!(near(t0.pts[0], 0.0, 0.6) && near(t0.pts[2], 3.0 / 16.0, -0.6));
        assert!((g.treads[15].top_rise - 2.8).abs() < 1e-12);
        assert_eq!(g.run_line.len(), 2);
        // Pfeilspitze am oberen Ende (up Default = true)
        assert!(near(g.arrow.head.1, g.run_line[1].x, g.run_line[1].y));
        let mut down = stair("straight");
        down.up = Some(false);
        let gd = stair_geometry(&down, 2.8);
        assert!(near(gd.arrow.head.1, gd.run_line[0].x, gd.run_line[0].y));
    }

    #[test]
    fn stair_l_podest_und_zweiter_lauf() {
        let mut p = stair("L");
        p.run2_length = Some(2.0);
        let g = stair_geometry(&p, 2.8);
        assert_eq!(g.treads.len(), 15); // 16 Stufen − 1 Podest
        let land = g.landing.as_ref().unwrap();
        assert_eq!(land.len(), 4);
        assert_eq!(g.run_line.len(), 3);
        // Podest-Mitte = start + u·(run1 + halfW)
        assert!(near(g.run_line[1], 3.6, 0.0));
        // zweiter Lauf geht nach +y (turn Default = links)
        assert!(g.run_line[2].y > 1.0);
        assert_eq!(g.treads[g.treads.len() - 1].index, 15);
        p.turn = Some(-1);
        assert!(stair_geometry(&p, 2.8).run_line[2].y < -1.0);
    }

    #[test]
    fn stair_wendel_keile_und_auge() {
        let mut p = stair("spiral");
        p.center = Some(Vec2 { x: 0.0, y: 0.0 });
        p.start = Vec2 { x: 1.0, y: 0.0 };
        p.radius = Some(1.0);
        p.step_count = 12;
        let g = stair_geometry(&p, 2.4);
        assert_eq!(g.treads.len(), 12);
        assert_eq!(g.landing.as_ref().unwrap().len(), 12);
        assert_eq!(g.run_line.len(), 13);
        assert!((g.tread_depth - (1.0 * 270.0 * DEG) / 12.0).abs() < 1e-12);
        // Innenradius = radius − halfW = 0.4
        assert!(near(g.treads[0].pts[0], 0.4, 0.0));
    }

    #[test]
    fn stair_referenz_versetzt_achse_auf_die_mitte() {
        let mut p = stair("straight");
        p.referenz = Some("links".into());
        let g = stair_geometry(&p, 2.8);
        // Achse = linke Kante → Mitte eine halbe Breite rechts (−y bei Lauf +x)
        assert!(near(g.treads[0].pts[0], 0.0, 0.0) && near(g.treads[0].pts[3], 0.0, -1.2));
        p.referenz = Some("rechts".into());
        let g = stair_geometry(&p, 2.8);
        assert!(near(g.treads[0].pts[0], 0.0, 1.2));
        // Wendel: auch das Zentrum wandert mit
        let mut sp = stair("spiral");
        sp.referenz = Some("rechts".into());
        sp.center = Some(Vec2 { x: 5.0, y: 5.0 });
        let o = stair_outline(&sp);
        assert!((o.spiral.unwrap().arcs[0].0.y - 5.6).abs() < 1e-9);
    }

    #[test]
    fn stair_outline_formen() {
        let o = stair_outline(&stair("straight"));
        let poly = o.polygon.unwrap();
        assert_eq!(poly.len(), 4);
        assert!(near(poly[0], 0.0, 0.6) && near(poly[2], 3.0, -0.6));
        assert!(o.spiral.is_none());
        let mut l = stair("L");
        l.run2_length = Some(2.0);
        let poly = stair_outline(&l).polygon.unwrap();
        assert_eq!(poly.len(), 6);
        let sp = stair_outline(&stair("spiral")).spiral.unwrap();
        assert!((sp.arcs[0].1 - 0.5).abs() < 1e-9 || sp.arcs[0].1 > 0.0);
        assert!((sp.arcs[1].1 - sp.arcs[0].1 - 1.2).abs() < 1e-9);
    }

    #[test]
    fn stair_unsinn_ohne_panic() {
        let mut p = stair("straight");
        p.dir = Vec2 { x: 0.0, y: 0.0 };
        let _ = stair_geometry(&p, 2.8);
        p.width = f64::NAN;
        p.run_length = f64::NAN;
        let g = stair_geometry(&p, f64::NAN);
        assert_eq!(g.treads.len(), 16);
        p.step_count = -5;
        assert_eq!(stair_geometry(&p, 2.8).treads.len(), 2);
        for shape in ["L", "spiral"] {
            let mut q = stair(shape);
            q.width = f64::NAN;
            q.step_count = 0;
            let _ = stair_geometry(&q, 1.0);
            let _ = stair_outline(&q);
        }
    }

    #[test]
    fn stair_cut_bbox_und_treffer() {
        let g = stair_geometry(&stair("straight"), 2.8);
        let c = stair_cut(&g, 1.0);
        assert_eq!(c.below_indices.len(), 5); // 0.175·5 = 0.875 ≤ 1 < 1.05
        assert_eq!(c.above_indices.len(), 11);
        assert_eq!(c.break_line.as_ref().unwrap().len(), 2);
        assert!(stair_cut(&g, 99.0).break_line.is_none());
        let b = stair_bbox(&g);
        assert!((b.max_x - 3.0).abs() < 1e-9 && (b.min_y + 0.6).abs() < 1e-9);
        assert!(point_hits_stair(Vec2 { x: 1.0, y: 0.0 }, &g));
        assert!(!point_hits_stair(Vec2 { x: 1.0, y: 5.0 }, &g));
        let leer = StairGeometry {
            treads: vec![], landing: None, riser_height: 0.0, tread_depth: 0.0,
            run_line: vec![], arrow: StairArrow { shaft: (Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 0.0, y: 0.0 }), head: (Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 0.0, y: 0.0 }) },
            total_rise: 0.0,
        };
        assert_eq!(stair_bbox(&leer).max_x, 0.0);
    }

    #[test]
    fn default_step_count_regeln() {
        assert_eq!(default_step_count(2.8, 10.0), 16);
        assert_eq!(default_step_count(2.8, 3.0), 13); // Lauflänge deckelt: floor(3/0.24)+1
        assert_eq!(default_step_count(0.1, 0.0), 2);
        assert_eq!(default_step_count(f64::NAN, 3.0), 2);
    }
}
