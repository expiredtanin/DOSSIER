//! Bindungen kleiner IFC-Bausteine (`crate::export_ifc`); die Datei selbst liefert `doc_export_ifc`.

use wasm_bindgen::prelude::wasm_bindgen;

/// Deterministische 22-stellige IFC-GUID aus einer Element-ID.
#[wasm_bindgen]
pub fn ifc_guid(id: &str) -> String {
    crate::export_ifc::ifc_guid(id)
}

/// STEP-String-Literal (ISO 10303-21) mit Escapes.
#[wasm_bindgen]
pub fn ifc_string(s: &str) -> String {
    crate::export_ifc::ifc_string(s)
}
