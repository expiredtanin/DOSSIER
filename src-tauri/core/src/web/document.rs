//! Bindungen des Projekt-Dokuments (`crate::document`): Handles in einer Tabelle, damit TS das
//! Projekt nicht bei jedem Aufruf neu übergeben muss.

use crate::document::{Document, Op};
use serde_json::Value;
use std::cell::RefCell;
use wasm_bindgen::prelude::wasm_bindgen;

thread_local! {
    static DOCS: RefCell<Vec<Option<Document>>> = const { RefCell::new(Vec::new()) };
}

fn with_doc<R>(h: u32, f: impl FnOnce(&mut Document) -> R) -> Option<R> {
    DOCS.with(|d| d.borrow_mut().get_mut((h as usize).checked_sub(1)?)?.as_mut().map(f))
}

/// Öffnet ein Dokument aus Projekt-JSON; Handle ≥ 1, 0 bei Fehler.
#[wasm_bindgen]
pub fn doc_open(json: &str) -> u32 {
    let Ok(doc) = Document::from_json(json) else { return 0 };
    DOCS.with(|d| {
        let mut d = d.borrow_mut();
        if let Some(i) = d.iter().position(Option::is_none) {
            d[i] = Some(doc);
            i as u32 + 1
        } else {
            d.push(Some(doc));
            d.len() as u32
        }
    })
}

#[wasm_bindgen]
pub fn doc_close(h: u32) {
    DOCS.with(|d| {
        if let Some(slot) = (h as usize).checked_sub(1).and_then(|i| d.borrow_mut().get_mut(i).map(|s| s.take())) {
            drop(slot);
        }
    });
}

/// Wendet eine Op-Folge (JSON-Array) an. Leerer Text = ok, sonst JSON-Array der Meldungen.
#[wasm_bindgen]
pub fn doc_apply(h: u32, ops_json: &str) -> String {
    let parsed: Result<Vec<Op>, String> = serde_json::from_str::<Value>(ops_json)
        .map_err(|e| e.to_string())
        .and_then(|v| v.as_array().ok_or("Ops sind kein Array".to_string()).and_then(|a| a.iter().map(Op::from_json).collect()));
    let problems = match parsed {
        Err(e) => vec![e],
        Ok(ops) => match with_doc(h, |d| d.apply(&ops)) {
            None => vec!["Dokument nicht offen".to_string()],
            Some(Ok(())) => return String::new(),
            Some(Err(p)) => p,
        },
    };
    Value::from(problems).to_string()
}

/// Das ganze Dokument als JSON (leer, wenn nicht offen).
#[wasm_bindgen]
pub fn doc_json(h: u32) -> String {
    with_doc(h, |d| d.to_json()).unwrap_or_default()
}

/// Abfrage auf dem typisierten Projekt; Ergebnis als JSON. Fehler (Dokument nicht offen, Modell
/// passt nicht, unbekannte Abfrage, Rechenfehler) kommen als Text mit vorangestelltem `\u{1}`.
/// Abfragen s. `crate::queries`.
#[wasm_bindgen]
pub fn doc_query(h: u32, name: &str) -> String {
    doc_query_args(h, name, &[], "")
}

/// Wie [`doc_query`] mit Zahlen- und Textargument.
#[wasm_bindgen]
pub fn doc_query_args(h: u32, name: &str, args: &[f64], text: &str) -> String {
    let result = with_doc(h, |d| {
        let p = d.project().map_err(|e| format!("Projekt passt nicht zum Kern-Modell: {e}"))?;
        crate::queries::run(&p, name, args, text)
    })
    .unwrap_or_else(|| Err("Dokument nicht offen".to_string()));
    match result {
        Ok(json) => json,
        Err(e) => format!("\u{1}{e}"),
    }
}

/// Boden-Spuren aller 2D-Zeichnungen als LineList-Vertices `[px, py, pz, r, g, b]` (Float32);
/// leer bei Fehler oder ohne Zeichnungen.
#[wasm_bindgen]
pub fn doc_drawing_line_verts(h: u32) -> Vec<f32> {
    with_doc(h, |d| d.project().ok().map(|p| crate::model3d::drawing_line_verts(&p))).flatten().unwrap_or_default()
}
