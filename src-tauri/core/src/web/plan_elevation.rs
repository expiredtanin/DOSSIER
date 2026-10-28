//! Bindungen der Ansichts-Geometrie (`crate::plan_elevation`). Layouts s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Sichtbare Teilstücke von Segmenten gegen nähere Verdecker; Unsinn → leer.
#[wasm_bindgen]
pub fn elevation_clip_segments_flat(occ: &[f64], segs: &[f64]) -> Vec<f64> {
    crate::plan_elevation::clip_segments(occ, segs)
}

/// Ob Punkte hinter einem näheren Verdecker liegen; Unsinn → leer.
#[wasm_bindgen]
pub fn elevation_occluded_points_flat(occ: &[f64], pts: &[f64]) -> Vec<f64> {
    crate::plan_elevation::occluded_points(occ, pts)
}

/// Schlagschatten auskragender Flächen auf Fassaden; Unsinn → leer.
#[wasm_bindgen]
pub fn elevation_shadows_flat(walls: &[f64], slabs: &[f64]) -> Vec<f64> {
    crate::plan_elevation::shadows(walls, slabs)
}

/// XOR-Umrisskanten frontaler Rechteckgruppen; Unsinn → leer.
#[wasm_bindgen]
pub fn elevation_xor_outline_flat(polys: &[f64]) -> Vec<f64> {
    crate::plan_elevation::xor_outline(polys)
}

/// Sichtbare Wand-, Decken- und Dachflächen in Ansichts-Koordinaten; Unsinn → leer.
#[wasm_bindgen]
pub fn elevation_faces_flat(frame: &[f64], walls: &[f64], slabs: &[f64], roofs: &[f64]) -> Vec<f64> {
    crate::plan_elevation::faces(frame, walls, slabs, roofs)
}

/// Eck-Verlängerung der Wandenden für die Ansicht; Unsinn → leer.
#[wasm_bindgen]
pub fn elevation_wall_extensions_flat(input: &[f64]) -> Vec<f64> {
    crate::plan_elevation::wall_extensions(input)
}

/// Projektion und Aufteilung (Glas, Flügel, Sprossen, Bank, Symbol) der Öffnungen; Unsinn → leer.
#[wasm_bindgen]
pub fn elevation_openings_flat(frame: &[f64], input: &[f64]) -> Vec<f64> {
    crate::plan_elevation::openings(frame, input)
}
