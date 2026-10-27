//! Bindungen der Treppen-Geometrie (`crate::stair`). Kodierung s. dort.

use crate::stair as s;
use wasm_bindgen::prelude::wasm_bindgen;

/// Parameter (16 Zahlen) + Gesamt-Steighöhe → flache Treppengeometrie; Unsinn → leer.
#[wasm_bindgen]
pub fn stair_geometry_flat(params: &[f64], total_rise: f64) -> Vec<f64> {
    s::geometry(params, total_rise)
}

/// Plan-Aussenlinie: `[0, n, x, y …]` (Polygon) oder `[1, …]` (Wendel).
#[wasm_bindgen]
pub fn stair_outline_flat(params: &[f64]) -> Vec<f64> {
    s::outline(params)
}

/// Schnittaufteilung aus flacher Geometrie und Schnitthöhe über der Treppen-UK.
#[wasm_bindgen]
pub fn stair_cut_flat(geometry: &[f64], cut_rise: f64) -> Vec<f64> {
    s::cut(geometry, cut_rise)
}

/// `[minX, minY, maxX, maxY]` aller Tritte + Podest.
#[wasm_bindgen]
pub fn stair_bbox_flat(geometry: &[f64]) -> Vec<f64> {
    s::bbox(geometry)
}

/// Vorgabe-Stufenzahl aus Steighöhe und Lauflänge.
#[wasm_bindgen]
pub fn stair_default_step_count(total_rise: f64, run_length: f64) -> u32 {
    s::default_step_count(total_rise, run_length)
}
