//! Bindungen des Projektdatei-Formats (`crate::project_format`). Laden/Speichern laufen über das
//! Dokument (`doc_load_file`, `doc_serialize` in `web/document.rs`).

use wasm_bindgen::prelude::wasm_bindgen;

/// Aktuelle Version des Dateiformats.
#[wasm_bindgen]
pub fn project_format_version() -> u32 {
    crate::project_format::PROJECT_FORMAT_VERSION as u32
}
