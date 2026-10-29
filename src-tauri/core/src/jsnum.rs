//! Zahl-Semantik von JavaScript für bitgleiche Portierungen ([K3b] GPU-Kompilierung, Schraffur).
//!
//! - `Math.min/max` liefern bei NaN NaN (Rust `f64::min/max` ignorieren NaN).
//! - `Math.round` rundet halbe Werte Richtung +∞ (Rust `round` weg von 0).
//! - `x | 0` ist ToInt32 (Rest modulo 2³², Rust `as i32` sättigt).
//! - `Math.pow` (`x ** 3`) und Trigonometrie: im Web-Build (wasm32 + Feature "web") ruft der Kern `Math.cos/sin/tan/atan2/acos`
//!   der laufenden JS-Engine. Nur so sind die Werte bitgleich zur bisherigen TS-Fassung — V8
//!   (glibc-abgeleitete sin/cos), JavaScriptCore (System-libm von macOS) und Rusts libm (musl)
//!   unterscheiden sich in einzelnen Fällen in der letzten Stelle. Nativ (`cargo test`, Tauri)
//!   gilt die Rust-Standardbibliothek.

#[cfg(all(feature = "web", target_arch = "wasm32"))]
mod trig {
    use wasm_bindgen::prelude::wasm_bindgen;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = Math, js_name = cos)]
        fn js_cos(x: f64) -> f64;
        #[wasm_bindgen(js_namespace = Math, js_name = sin)]
        fn js_sin(x: f64) -> f64;
        #[wasm_bindgen(js_namespace = Math, js_name = atan2)]
        fn js_atan2(y: f64, x: f64) -> f64;
        #[wasm_bindgen(js_namespace = Math, js_name = acos)]
        fn js_acos(x: f64) -> f64;
        #[wasm_bindgen(js_namespace = Math, js_name = pow)]
        fn js_pow(x: f64, y: f64) -> f64;
        #[wasm_bindgen(js_namespace = Math, js_name = tan)]
        fn js_tan(x: f64) -> f64;
    }
    #[inline]
    pub fn tan(x: f64) -> f64 {
        js_tan(x)
    }
    #[inline]
    pub fn pow(x: f64, y: f64) -> f64 {
        js_pow(x, y)
    }

    #[inline]
    pub fn cos(x: f64) -> f64 {
        js_cos(x)
    }
    #[inline]
    pub fn sin(x: f64) -> f64 {
        js_sin(x)
    }
    #[inline]
    pub fn atan2(y: f64, x: f64) -> f64 {
        js_atan2(y, x)
    }
    #[inline]
    pub fn acos(x: f64) -> f64 {
        js_acos(x)
    }
}

#[cfg(not(all(feature = "web", target_arch = "wasm32")))]
mod trig {
    #[inline]
    pub fn cos(x: f64) -> f64 {
        x.cos()
    }
    #[inline]
    pub fn sin(x: f64) -> f64 {
        x.sin()
    }
    #[inline]
    pub fn atan2(y: f64, x: f64) -> f64 {
        y.atan2(x)
    }
    #[inline]
    pub fn acos(x: f64) -> f64 {
        x.acos()
    }
    #[inline]
    pub fn pow(x: f64, y: f64) -> f64 {
        x.powf(y)
    }
    #[inline]
    pub fn tan(x: f64) -> f64 {
        x.tan()
    }
}

pub use trig::{acos, atan2, cos, pow, sin, tan};

/// `Math.min(a, b)` (NaN gewinnt; −0 < +0).
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)` (NaN gewinnt; +0 > −0).
#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

/// `Math.round(x)`: halbe Werte Richtung +∞, −0 bleibt −0, Werte in (−0.5, 0) → −0.
#[inline]
pub fn round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    if x > 0.0 && x < 0.5 {
        return 0.0;
    }
    if x < 0.0 && x >= -0.5 {
        return -0.0;
    }
    let r = x.ceil();
    if r - 0.5 > x {
        r - 1.0
    } else {
        r
    }
}

/// ToInt32 (`x | 0`).
#[inline]
pub fn to_int32(x: f64) -> i32 {
    // Schneller Weg im i32-Bereich (`as` schneidet wie ToInt32 Richtung 0 ab; NaN → 0).
    if (-2147483648.0..=2147483647.0).contains(&x) {
        return x as i32;
    }
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    let m = t.rem_euclid(4294967296.0);
    (m as u64 as u32) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rundung_wie_js() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(-0.5).to_bits(), (-0.0f64).to_bits());
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(-126.5), -126.0);
        assert!(round(f64::NAN).is_nan());
    }

    #[test]
    fn min_max_wie_js() {
        assert!(min(1.0, f64::NAN).is_nan());
        assert!(max(f64::NAN, 1.0).is_nan());
        assert_eq!(max(0.0, -0.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(min(0.0, -0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(max(-1.0, min(1.0, 3.0)), 1.0);
    }

    #[test]
    fn int32_wie_js() {
        assert_eq!(to_int32(4294967296.0 + 5.0), 5);
        assert_eq!(to_int32(2147483648.0), -2147483648);
        assert_eq!(to_int32(-1.7), -1);
        assert_eq!(to_int32(f64::NAN), 0);
        assert_eq!(to_int32(-4294967297.0), -1);
    }
}
