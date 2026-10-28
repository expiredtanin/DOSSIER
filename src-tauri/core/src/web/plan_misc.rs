//! Bindungen kleiner Plan-Bausteine (`crate::plan_misc`). Layouts s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Grundriss-Fussabdruck eines Meshes (Sockelkanten); Unsinn → leer.
#[wasm_bindgen]
pub fn context_footprint_flat(positions: &[f64], indices: &[f64]) -> Vec<f64> {
    crate::plan_misc::context_footprint(positions, indices)
}

/// `[minX, minY, maxX, maxY]` der x/y-Werte eines [x,y,z…]-Arrays; leer ohne Punkte.
#[wasm_bindgen]
pub fn context_bbox_flat(positions: &[f64]) -> Vec<f64> {
    crate::plan_misc::bbox(positions)
}

/// Schnittführungs-Symbol einer Linie; leer bei zu kurzer Linie.
#[wasm_bindgen]
pub fn section_line_flat(p0x: f64, p0y: f64, p1x: f64, p1y: f64, sign: f64) -> Vec<f64> {
    crate::plan_misc::section_line(p0x, p0y, p1x, p1y, sign)
}

/// Linienende (Pfeil, Punkt, Schrägstrich, Quadrat); leer ohne Wirkung.
#[wasm_bindgen]
pub fn end_mark_flat(x: f64, y: f64, dx: f64, dy: f64, art: f64, mm: f64, scale_denominator: f64) -> Vec<f64> {
    crate::plan_misc::end_mark(x, y, dx, dy, art, mm, scale_denominator)
}
