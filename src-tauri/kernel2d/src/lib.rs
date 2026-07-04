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
}
