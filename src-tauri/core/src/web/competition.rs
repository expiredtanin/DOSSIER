//! Bindung der Anonymitäts-Prüfung (`crate::competition`) für die TS-Fassade `anonymityFindings`
//! (`src/export/competitionCheck.ts`). Eingabe das Projekt und die Zusatzangaben als JSON, Ausgabe ein
//! JSON-Array der Treffer; kaputte Eingaben ergeben eine leere Liste, nie einen Panic.

use serde_json::Value;
use wasm_bindgen::prelude::wasm_bindgen;

/// Treffer identifizierender Angaben im Freitext des Projekts (JSON-Array, leer = sauber).
#[wasm_bindgen]
pub fn anonymity_findings(project_json: &str, input_json: &str) -> String {
    let root = serde_json::from_str::<Value>(project_json).unwrap_or(Value::Null);
    let input = serde_json::from_str::<crate::competition::CheckInput>(input_json).unwrap_or_default();
    serde_json::to_string(&crate::competition::anonymity_findings(&root, &input)).unwrap_or_else(|_| "[]".into())
}
