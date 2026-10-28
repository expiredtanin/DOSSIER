//! Bindung des gewichteten Straight Skeletons (`crate::skeleton`). Kodierung s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Ringe `[nRinge, (nPkt, x, y, …)…]`, Geschwindigkeit je Kante, Budget (≤ 0 = Standard) →
/// `[status, nKanten, (nUmläufe, (nPkt, (x, y, t)…)…)…]`; Fehler → `[status]` (nie Panic).
#[wasm_bindgen]
pub fn straight_skeleton(rings: &[f64], speeds: &[f64], budget: f64) -> Vec<f64> {
    crate::skeleton::faces_flat(rings, speeds, budget)
}
