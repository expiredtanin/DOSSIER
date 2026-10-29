//! Bindungen des Flächen-Nachweises (`crate::area_report`): der Bericht reist als JSON (Texte und
//! wenige Zahlen, keine Geometrie). Kaputte Eingaben → leeres Ergebnis ("" bzw. "null"), nie Panic.

use crate::area_report as ar;
use wasm_bindgen::prelude::wasm_bindgen;

fn report(json: &str) -> Option<ar::Report> {
    serde_json::from_str(json).ok()
}

fn opts(json: &str) -> ar::LayoutOptions {
    serde_json::from_str(json).unwrap_or_default()
}

/// Bericht-JSON → CSV-Text ("" bei kaputtem Bericht).
#[wasm_bindgen]
pub fn area_report_csv(report_json: &str, delimiter: &str) -> String {
    report(report_json).map(|r| ar::to_csv(&r, delimiter)).unwrap_or_default()
}

/// CSV-Text → JSON `{title, projectName, sections, notes}`.
#[wasm_bindgen]
pub fn area_report_parse_csv(text: &str, delimiter: &str) -> String {
    ar::parse_csv(text, delimiter).to_string()
}

/// Bericht-JSON, Optionen-JSON → Layout-JSON `{width, height, pages}` ("null" bei kaputtem Bericht).
#[wasm_bindgen]
pub fn area_report_layout(report_json: &str, opts_json: &str) -> String {
    match report(report_json) {
        Some(r) => ar::layout_json(&ar::layout(&r, &opts(opts_json))).to_string(),
        None => "null".into(),
    }
}

/// Bericht-JSON, Seite, Optionen-JSON → SVG-Text ("" bei kaputtem Bericht).
#[wasm_bindgen]
pub fn area_report_svg(report_json: &str, page: u32, opts_json: &str) -> String {
    report(report_json).map(|r| ar::to_svg(&r, page as usize, &opts(opts_json))).unwrap_or_default()
}
