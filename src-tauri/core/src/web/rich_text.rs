//! Bindungen der Rich-Text-Bearbeitung (`crate::rich_text`) für die TS-Fassade `src/text/richText.ts`.
//! Das Dokument reist als JSON (Text, keine Geometrie); kaputte Eingaben ergeben "" (die Fassade gibt
//! dann das Eingabedokument zurück) — nie Panic.

use crate::model::{RichTextDoc, TextStylePreset};
use crate::rich_text as rt;
use wasm_bindgen::prelude::wasm_bindgen;

fn doc(json: &str) -> Option<RichTextDoc> {
    serde_json::from_str(json).ok()
}

fn out(d: &RichTextDoc) -> String {
    serde_json::to_string(d).unwrap_or_default()
}

/// Dokument normalisieren (Runs verschmelzen, leere entfernen).
#[wasm_bindgen]
pub fn rich_normalize(doc_json: &str) -> String {
    doc(doc_json).map(|d| out(&rt::normalize_doc(&d))).unwrap_or_default()
}

/// Mark auf `[start, end)` setzen; `value_json` = JSON-Wert (`null`/`false` entfernt).
#[wasm_bindgen]
pub fn rich_apply_mark(doc_json: &str, start: f64, end: f64, mark: &str, value_json: &str) -> String {
    let v = serde_json::from_str(value_json).unwrap_or(serde_json::Value::Null);
    doc(doc_json).map(|d| out(&rt::apply_mark(&d, start, end, mark, &v))).unwrap_or_default()
}

/// Boolesches Mark im Bereich umschalten.
#[wasm_bindgen]
pub fn rich_toggle_mark(doc_json: &str, start: f64, end: f64, mark: &str) -> String {
    doc(doc_json).map(|d| out(&rt::toggle_mark(&d, start, end, mark))).unwrap_or_default()
}

/// Ist das boolesche Mark über den ganzen Bereich aktiv?
#[wasm_bindgen]
pub fn rich_is_mark_active(doc_json: &str, start: f64, end: f64, mark: &str) -> bool {
    doc(doc_json).map_or(false, |d| rt::is_mark_active(&d, start, end, mark))
}

/// Gemeinsamer Wert (JSON) eines Marks im Bereich; `"null"` = uneinheitlich/leer.
#[wasm_bindgen]
pub fn rich_common_mark_value(doc_json: &str, start: f64, end: f64, mark: &str) -> String {
    doc(doc_json).and_then(|d| rt::common_mark_value(&d, start, end, mark)).map_or("null".into(), |v| v.to_string())
}

/// Stabile Serialisierung (normalisiert, feste Schlüsselreihenfolge).
#[wasm_bindgen]
pub fn rich_serialize(doc_json: &str) -> String {
    doc(doc_json).map(|d| rt::serialize(&d)).unwrap_or_default()
}

/// Stil auf den Bereich anwenden (leerer Bereich = ganzes Dokument).
#[wasm_bindgen]
pub fn rich_apply_preset(doc_json: &str, start: f64, end: f64, preset_json: &str) -> String {
    let Ok(p) = serde_json::from_str::<TextStylePreset>(preset_json) else { return String::new() };
    doc(doc_json).map(|d| out(&rt::apply_preset(&d, start, end, &p))).unwrap_or_default()
}
