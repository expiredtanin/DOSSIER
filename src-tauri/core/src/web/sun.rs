//! Bindungen von Sonnenstand und Schatten (`crate::sun`).

use crate::flat_read::pairs;
use crate::flat::{decode, encode};
use crate::sun::{self, SunPosition};
use wasm_bindgen::prelude::wasm_bindgen;

/// `[azimut, höhe]` in Grad.
#[wasm_bindgen]
pub fn sun_position(lat: f64, lon: f64, unix_ms: f64) -> Vec<f64> {
    let s = sun::sun_position(lat, lon, unix_ms);
    vec![s.azimuth, s.elevation]
}

/// Grundriss als `[x0, y0, x1, y1, …]` → Schatten-Ring im selben Format.
#[wasm_bindgen]
pub fn sun_shadow_of_prism(footprint: &[f64], z_bottom: f64, z_top: f64, azimuth: f64, elevation: f64) -> Vec<f64> {
    let r = sun::shadow_of_prism(&pairs(footprint), z_bottom, z_top, SunPosition { azimuth, elevation });
    r.into_iter().flatten().collect()
}

/// Ein Polygon (`flat`, erstes Polygon zählt) → lochfreie Teile (`flat`, je ein Ring).
#[wasm_bindgen]
pub fn sun_without_holes(poly: &[f64]) -> Vec<f64> {
    let Some(first) = decode(poly).and_then(|p| p.into_iter().next()) else { return encode(&[]) };
    let parts: Vec<_> = sun::without_holes(&first).into_iter().map(|r| vec![r]).collect();
    encode(&parts)
}
