//! Bindung der Körper-Booleans (`crate::solid_bool`, [107] Schritt 2): Netze flach
//! `[n_verts, x, y, z, …, n_tris, i0, i1, i2, …]`, `op` 0 = Vereinigung, 1 = Differenz, 2 = Schnitt.
//! Kaputte Eingaben oder Fehler ⇒ leerer Puffer (nie Panik).

use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
pub fn solid_boolean(op: f64, a: &[f64], b: &[f64]) -> Vec<f64> {
    crate::solid_bool::boolean_flat(op, a, b)
}
