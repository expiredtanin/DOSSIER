//! Bindung `woff2_to_sfnt` für den PDF-Export ([208]): jsPDF bettet nur TTF ein, die gebündelten Schriften
//! (`public/fonts`) liegen als WOFF2 vor. Kaputte Eingaben ergeben einen leeren Puffer, nie einen Panic.

use wasm_bindgen::prelude::wasm_bindgen;

/// WOFF2 (oder rohes SFNT) -> SFNT/TTF-Bytes; leer bei Fehlern.
#[wasm_bindgen]
pub fn woff2_to_sfnt(bytes: &[u8]) -> Vec<u8> {
    crate::woff2::to_sfnt(bytes).unwrap_or_default()
}
