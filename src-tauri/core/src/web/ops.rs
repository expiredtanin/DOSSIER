//! Bindungen der Op-Prüfung (`crate::ops`) für die TS-Fassaden `validateOps`/`validateProject`
//! (`src/core/ops.ts`). Eingaben als JSON (Nicht-endlich-Marken s. `crate::ops`), Ausgabe ein
//! JSON-Array der Meldungen. Kaputte Eingaben ergeben eine Meldung, nie einen Panic.

use crate::ops::{ops_from_json, validate_ops, validate_project};
use serde_json::{Map, Value};
use wasm_bindgen::prelude::wasm_bindgen;

fn object(text: &str) -> Result<Map<String, Value>, String> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err("kein JSON-Objekt".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Prüft angewendete Ops: `after_json`/`before_json` = Projekt (oder die berührten Felder) nach
/// bzw. vor den Ops; `before_json` leer = unbekannt.
#[wasm_bindgen]
pub fn ops_validate(ops_json: &str, after_json: &str, before_json: &str) -> String {
    let run = || -> Result<Vec<String>, String> {
        let ops = ops_from_json(&serde_json::from_str::<Value>(ops_json).map_err(|e| e.to_string())?)?;
        let after = object(after_json)?;
        let before = if before_json.is_empty() { None } else { Some(object(before_json)?) };
        Ok(validate_ops(&after, &ops, before.as_ref()))
    };
    Value::from(run().unwrap_or_else(|e| vec![e])).to_string()
}

/// Prüft ein ganzes Projekt (doppelte ids, nicht endliche Zahlen).
#[wasm_bindgen]
pub fn project_validate(project_json: &str) -> String {
    let problems = object(project_json).map(|p| validate_project(&p)).unwrap_or_else(|e| vec![e]);
    Value::from(problems).to_string()
}
