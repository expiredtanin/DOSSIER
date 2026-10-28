//! Bindungen der Kennzahlen-Rechenteile (`crate::kennzahlen`).

use crate::flat_read::pairs;
use crate::kennzahlen;
use wasm_bindgen::prelude::wasm_bindgen;

/// Grundriss `[x0, y0, …]`, Kreisradius (NaN = kein Kreis), Höhe, Verjüngung → m³.
#[wasm_bindgen]
pub fn kz_solid_volume(points: &[f64], circle_r: f64, height: f64, taper: f64) -> f64 {
    kennzahlen::solid_volume(&pairs(points), circle_r, height, taper)
}
