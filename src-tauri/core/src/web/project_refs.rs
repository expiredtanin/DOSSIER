//! Bindung der Projekt-Warnungen (`crate::project_refs`) für die TS-Fassade `projectWarnings`
//! (`src/core/ops.ts`) und `dossier-cli validate`. Eingabe das Projekt als JSON, Ausgabe ein
//! JSON-Array der Warnungen; kaputte Eingaben ergeben eine Warnung, nie einen Panic.

use serde_json::Value;
use wasm_bindgen::prelude::wasm_bindgen;

/// Warnungen (hängende Verweise, Zyklen, nicht lesbare Werte) eines Projekts.
#[wasm_bindgen]
pub fn project_warnings(project_json: &str) -> String {
    let out = match serde_json::from_str::<Value>(project_json) {
        Ok(Value::Object(m)) => crate::project_refs::project_warnings(&m),
        Ok(_) => vec!["kein JSON-Objekt".to_string()],
        Err(e) => vec![e.to_string()],
    };
    Value::from(out).to_string()
}
