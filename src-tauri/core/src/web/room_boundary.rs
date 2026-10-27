//! Bindungen der Raum-Erkennung (`crate::room_boundary`). Kodierung dort.

use crate::room_boundary as rb;
use wasm_bindgen::prelude::wasm_bindgen;

/// Wände → Räume `[n, (nPkt, x, y, …)…]`; Lücken ≤ `gap_tol` werden geschlossen.
#[wasm_bindgen]
pub fn rooms_detect(walls: &[f64], gap_tol: f64, min_area: f64, offset_to_inner: bool) -> Vec<f64> {
    rb::detect(walls, gap_tol, min_area, offset_to_inner)
}

/// Umriss der Zelle um den Punkt `[nPkt, x, y, …]`, leer = keine.
#[wasm_bindgen]
pub fn room_from_point(px: f64, py: f64, walls: &[f64], gap_tol: f64, offset_to_inner: bool) -> Vec<f64> {
    rb::from_point(px, py, walls, gap_tol, offset_to_inner)
}

/// Wie `room_from_point`, aber auf fertigen Wand-Innenflächen (ohne Offset).
#[wasm_bindgen]
pub fn room_from_point_faces(px: f64, py: f64, faces: &[f64], gap_tol: f64) -> Vec<f64> {
    rb::from_point_faces(px, py, faces, gap_tol)
}
