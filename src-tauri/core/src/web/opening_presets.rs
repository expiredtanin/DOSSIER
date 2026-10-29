//! Bindung der Fenster-/Türtyp-Vorlagen (`crate::opening_presets`, [95]).

use wasm_bindgen::prelude::wasm_bindgen;

/// Vorlagen als JSON `{ windowTypes, doorTypes }`.
#[wasm_bindgen]
pub fn opening_type_presets_json() -> String {
    crate::opening_presets::presets_json()
}
