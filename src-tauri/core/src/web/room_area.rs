//! Bindungen der Raum-Flächen und der SIA-416-Bilanz (`crate::room_area`).
//! Rechnungen ohne Prüfung der Zahlen: NaN/∞ ergeben NaN, nie einen Panic.

use crate::flat_read::pairs;
use crate::room_area as ra;
use wasm_bindgen::prelude::wasm_bindgen;

/// Ring `[x0, y0, …]`, Abzug (m²) → `[brutto, netto, umfang, schwerpunktX, schwerpunktY]`.
#[wasm_bindgen]
pub fn room_evaluate(pts: &[f64], deduction: f64) -> Vec<f64> {
    let e = ra::evaluate(&pairs(pts), deduction);
    vec![e.gross, e.net, e.perimeter, e.centroid[0], e.centroid[1]]
}

/// Ring `[x0, y0, …]` → absolute Fläche.
#[wasm_bindgen]
pub fn room_polygon_area(pts: &[f64]) -> f64 {
    ra::evaluate(&pairs(pts), 0.0).gross
}

/// Ring `[x0, y0, …]` → `[x, y]`.
#[wasm_bindgen]
pub fn room_centroid(pts: &[f64]) -> Vec<f64> {
    let c = ra::evaluate(&pairs(pts), 0.0).centroid;
    vec![c[0], c[1]]
}

/// Kategorie-Indizes und Flächen je Raum (gleich lang) →
/// `[6 Flächen je Blatt-Kategorie, 6 Raumzahlen, 3 Flächen NF/NGF/GF, 3 Raumzahlen]`.
/// Ungültige Indizes (NaN, ausserhalb) werden übergangen.
#[wasm_bindgen]
pub fn room_balance(categories: &[f64], areas: &[f64]) -> Vec<f64> {
    let rooms: Vec<(usize, f64)> = categories
        .iter()
        .zip(areas)
        .filter(|(c, _)| c.is_finite() && **c >= 0.0 && c.fract() == 0.0 && **c < ra::CATEGORIES.len() as f64)
        .map(|(c, a)| (*c as usize, *a))
        .collect();
    let b = ra::balance(&rooms);
    let mut out = Vec::with_capacity(18);
    out.extend(b.leaf_area);
    out.extend(b.leaf_count.iter().map(|&n| n as f64));
    out.extend(b.agg_area);
    out.extend(b.agg_count.iter().map(|&n| n as f64));
    out
}

/// Blatt-Kategorien in Index-Reihenfolge (TS prüft damit seine Namensliste).
#[wasm_bindgen]
pub fn room_sia_categories() -> Vec<String> {
    ra::CATEGORIES.iter().map(|s| s.to_string()).collect()
}
