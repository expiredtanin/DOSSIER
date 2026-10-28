//! Bindungen des Projektdatei-Formats (`crate::project_format`).

use crate::project_format::{parse_project_file, Parsed};
use serde_json::{json, Value};
use wasm_bindgen::prelude::wasm_bindgen;

/// Liest eine Projektdatei (Text). Antwort als JSON:
/// `{"ok":true,"project":{…},"warnings":[…],"migratedFrom":null|n}` oder `{"ok":false,"error":"…"}`.
#[wasm_bindgen]
pub fn project_parse(text: &str, now_ms: f64) -> String {
    let v: Value = match parse_project_file(text, now_ms) {
        Parsed::Ok { project, warnings, migrated_from } => json!({"ok": true, "project": project, "warnings": warnings, "migratedFrom": migrated_from}),
        Parsed::Err(error) => json!({"ok": false, "error": error}),
    };
    v.to_string()
}

/// Aktuelle Version des Dateiformats.
#[wasm_bindgen]
pub fn project_format_version() -> u32 {
    crate::project_format::PROJECT_FORMAT_VERSION as u32
}
