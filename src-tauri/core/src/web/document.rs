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

/// Abfrage auf dem typisierten Projekt; Ergebnis als JSON, leer bei Fehler (Dokument nicht offen,
/// Modell passt nicht, unbekannte Abfrage). Abfragen: `kennzahlen`, `siteCheck` (`null` ohne
/// Baurecht), `buildingFootprint`, `modelTop` (`null` ohne Bauteile).
#[wasm_bindgen]
pub fn doc_query(h: u32, name: &str) -> String {
    use crate::{kennzahlen, site_rules};
    let name = name.to_owned();
    with_doc(h, move |d| {
        let p = d.project().ok()?;
        let json = match name.as_str() {
            "kennzahlen" => serde_json::to_string(&kennzahlen::compute(&p)),
            "siteCheck" => serde_json::to_string(&site_rules::check_project(&p)),
            "buildingFootprint" => serde_json::to_string(&site_rules::building_footprint(&p)),
            "modelTop" => serde_json::to_string(&site_rules::model_top(&p)),
            _ => return None,
        };
        json.ok()
    })
    .flatten()
    .unwrap_or_default()
}
