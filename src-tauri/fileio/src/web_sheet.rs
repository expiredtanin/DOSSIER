// WASM-Bindung des Tabellen-Lesers (`sheet_import.rs`, [61]): Bytes rein, JSON raus
// (`[{"name":…,"rows":[[null|"text"|1.5,…],…]}]`). Kaputte Dateien → JS-Fehler mit Meldung (kein Panic).

use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

use crate::sheet_import::{parse_number, read_sheets, Cell};

/// Tabellenblätter einer .xlsx/.ods/.csv-Datei als JSON-Text.
#[wasm_bindgen]
pub fn sheet_read(bytes: Vec<u8>, file_name: String) -> Result<String, JsValue> {
    let sheets = read_sheets(&bytes, &file_name).map_err(|e| JsValue::from_str(&e))?;
    let out: Vec<Value> = sheets
        .iter()
        .map(|s| {
            let rows: Vec<Value> = s
                .rows
                .iter()
                .map(|r| {
                    Value::Array(
                        r.iter()
                            .map(|c| match c {
                                Cell::Empty => Value::Null,
                                Cell::Text(t) => Value::String(t.clone()),
                                Cell::Num(n) => json!(n),
                            })
                            .collect(),
                    )
                })
                .collect();
            json!({ "name": s.name, "rows": rows })
        })
        .collect();
    Ok(Value::Array(out).to_string())
}

/// Zahl aus Zelltext ("1'250,5", "12,5 m²") oder NaN.
#[wasm_bindgen]
pub fn sheet_parse_number(text: String) -> f64 {
    parse_number(&text).unwrap_or(f64::NAN)
}
