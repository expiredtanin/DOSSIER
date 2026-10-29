//! Bindungen der Raum-Erkennung (`crate::room_boundary`). Kodierung dort.

use crate::room_boundary as rb;
use wasm_bindgen::prelude::wasm_bindgen;

/// Wände → Räume `[n, (nPkt, x, y, …)…]`; Lücken ≤ `gap_tol` werden geschlossen.
#[wasm_bindgen]
pub fn rooms_detect(walls: &[f64], gap_tol: f64, min_area: f64, offset_to_inner: bool) -> Vec<f64> {
    rb::detect(walls, gap_tol, min_area, offset_to_inner)
}
