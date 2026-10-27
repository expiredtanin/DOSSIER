//! Bindungen des Plan-Puffers (`crate::plan_buf`). Format s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Plan-Puffer lesen und neu schreiben (Hin-und-zurück-Prüfung der TS-Kodierung); leer bei
/// fremder Version oder kaputtem Puffer.
#[wasm_bindgen]
pub fn plan_buf_recode(buf: &[f64]) -> Vec<f64> {
    crate::plan_buf::recode(buf)
}
