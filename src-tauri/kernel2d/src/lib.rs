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
}
