//! Bindung der Linienenden (`crate::plan_misc`, für 2D-Zeichnungen). Kontext-Fussabdruck und
//! Schnittführung ruft die Plan-Erzeugung im Kern direkt (`plan/context.rs`).

use wasm_bindgen::prelude::wasm_bindgen;

/// Linienende (Pfeil, Punkt, Schrägstrich, Quadrat); leer ohne Wirkung.
#[wasm_bindgen]
pub fn end_mark_flat(x: f64, y: f64, dx: f64, dy: f64, art: f64, mm: f64, scale_denominator: f64) -> Vec<f64> {
    crate::plan_misc::end_mark(x, y, dx, dy, art, mm, scale_denominator)
}
