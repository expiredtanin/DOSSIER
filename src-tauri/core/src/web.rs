//! wasm-bindgen-Fassade (Feature "web"). Eingaben/Ausgaben als flache `f64`-Puffer (s. `flat`).
//! Kaputte Eingaben ergeben ein leeres Ergebnis statt eines Panics (ein Panic legt das ganze
//! WASM-Modul lahm, [14]).

use crate::flat::{decode, encode};
use crate::polygon_bool;
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Version des Kern-Moduls (für Diagnose/Startprotokoll).
#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub fn poly_union(a: &[f64]) -> Vec<f64> {
    encode(&polygon_bool::union(&decode(a).unwrap_or_default()))
}

#[wasm_bindgen]
pub fn poly_difference(a: &[f64], b: &[f64]) -> Vec<f64> {
    let (Some(a), Some(b)) = (decode(a), decode(b)) else { return encode(&[]) };
    encode(&polygon_bool::difference(&a, &b))
}

#[wasm_bindgen]
pub fn poly_intersection(a: &[f64], b: &[f64]) -> Vec<f64> {
    let (Some(a), Some(b)) = (decode(a), decode(b)) else { return encode(&[]) };
    encode(&polygon_bool::intersection(&a, &b))
}
