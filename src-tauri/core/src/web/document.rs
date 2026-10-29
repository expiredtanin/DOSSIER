//! Bindungen des Projekt-Dokuments (`crate::document`): Handles in einer Tabelle, damit TS das
//! Projekt nicht bei jedem Aufruf neu übergeben muss.

use crate::document::{Document, Op};
use crate::ops::{ops_from_json, ops_to_json};
use serde_json::Value;
use std::cell::RefCell;
use wasm_bindgen::prelude::wasm_bindgen;

thread_local! {
    static DOCS: RefCell<Vec<Option<Document>>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn with_doc<R>(h: u32, f: impl FnOnce(&mut Document) -> R) -> Option<R> {
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

/// Projektdatei (Text) einlesen, migrieren, prüfen und ins Dokument laden ([K4] S4: Öffnen, Vorlage,
/// Wiederherstellen); der Verlauf wird geleert. Antwort als JSON:
/// `{"ok":true,"warnings":[…],"migratedFrom":null|n}` oder `{"ok":false,"error":"…"}` (Dokument unverändert).
#[wasm_bindgen]
pub fn doc_load_file(h: u32, text: &str, now_ms: f64) -> String {
    let now = if now_ms.is_finite() { now_ms } else { 0.0 };
    let v = match with_doc(h, |d| d.load_file(text, now)) {
        Some(Ok((warnings, migrated_from))) => serde_json::json!({"ok": true, "warnings": warnings, "migratedFrom": migrated_from}),
        Some(Err(error)) => serde_json::json!({"ok": false, "error": error}),
        None => serde_json::json!({"ok": false, "error": "Dokument nicht offen"}),
    };
    v.to_string()
}

/// Projekt-JSON (ein Objekt, schon im aktuellen Format) ins Dokument laden (Neu, Musterhaus, Abgleich
/// nach einer Änderung vorbei an den Ops); der Verlauf wird geleert. `false` bei kaputtem JSON (unverändert).
#[wasm_bindgen]
pub fn doc_load_json(h: u32, json: &str) -> bool {
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(json) else { return false };
    with_doc(h, |d| d.load(root)).is_some()
}

#[wasm_bindgen]
pub fn doc_close(h: u32) {
    DOCS.with(|d| {
        if let Some(slot) = (h as usize).checked_sub(1).and_then(|i| d.borrow_mut().get_mut(i).map(|s| s.take())) {
            drop(slot);
        }
    });
}

fn parse_ops(ops_json: &str) -> Result<Vec<Op>, String> {
    serde_json::from_str::<Value>(ops_json).map_err(|e| e.to_string()).and_then(|v| ops_from_json(&v))
}

/// Ob der Text Nicht-endlich-Marken enthalten kann (`"\u0001NaN"` …, s. `crate::ops`).
fn may_have_marks(ops_json: &str) -> bool {
    ops_json.contains("\\u0001")
}

fn problems_text(r: Option<Result<(), Vec<String>>>, parsed_err: Option<String>) -> String {
    let problems = match (parsed_err, r) {
        (Some(e), _) => vec![e],
        (None, None) => vec!["Dokument nicht offen".to_string()],
        (None, Some(Ok(()))) => return String::new(),
        (None, Some(Err(p))) => p,
    };
    Value::from(problems).to_string()
}

/// Wendet eine Op-Folge (JSON-Array) an, ohne Verlauf (Abgleich). Leerer Text = ok, sonst
/// JSON-Array der Meldungen (Dokument unverändert).
#[wasm_bindgen]
pub fn doc_apply(h: u32, ops_json: &str) -> String {
    match parse_ops(ops_json) {
        Err(e) => problems_text(None, Some(e)),
        Ok(ops) => problems_text(with_doc(h, |d| d.apply_marked(&ops, may_have_marks(ops_json))), None),
    }
}

/// Eine Benutzer-Änderung: Ops anwenden, prüfen (NaN, neue doppelte ids) und als Undo-Schritt
/// aufzeichnen. `key` = coalesceKey (leer = keiner), `now_ms` = Zeit für das Koaleszenz-Fenster.
/// Leerer Text = angenommen, sonst JSON-Array der Meldungen (Dokument und Verlauf unverändert).
#[wasm_bindgen]
pub fn doc_commit(h: u32, ops_json: &str, key: &str, now_ms: f64) -> String {
    match parse_ops(ops_json) {
        Err(e) => problems_text(None, Some(e)),
        Ok(ops) => {
            let key = (!key.is_empty()).then_some(key);
            let now = if now_ms.is_finite() { now_ms } else { 0.0 };
            problems_text(with_doc(h, |d| d.commit(ops, key, now, may_have_marks(ops_json))), None)
        }
    }
}

/// Einen Schritt zurück: die angewendeten Ops als JSON-Array (für die TS-Leseansicht), leer = nichts.
#[wasm_bindgen]
pub fn doc_undo(h: u32) -> String {
    with_doc(h, |d| d.undo().map(|ops| ops_to_json(&ops))).flatten().unwrap_or_default()
}

/// Einen Schritt vor: die angewendeten Ops als JSON-Array, leer = nichts.
#[wasm_bindgen]
pub fn doc_redo(h: u32) -> String {
    with_doc(h, |d| d.redo().map(|ops| ops_to_json(&ops))).flatten().unwrap_or_default()
}

/// Verlaufsstand `[Undo-Tiefe, Redo-Tiefe, geschätzte Bytes]` (leer, wenn nicht offen).
#[wasm_bindgen]
pub fn doc_history_state(h: u32) -> Vec<f64> {
    with_doc(h, |d| {
        let hi = d.history();
        vec![hi.undo_depth() as f64, hi.redo_depth() as f64, hi.bytes() as f64]
    })
    .unwrap_or_default()
}

/// Verlauf leeren (z. B. nach einer Änderung am Projekt vorbei an den Ops).
#[wasm_bindgen]
pub fn doc_history_clear(h: u32) {
    with_doc(h, |d| d.history_mut().clear());
}

/// Grenzen des Verlaufs: höchstens `steps` Schritte und ungefähr `bytes` Speicher (≤ 0 = unverändert).
#[wasm_bindgen]
pub fn doc_history_limits(h: u32, steps: f64, bytes: f64) {
    with_doc(h, |d| {
        let hi = d.history_mut();
        if steps.is_finite() && steps >= 1.0 {
            hi.max_steps = steps as usize;
        }
        if bytes.is_finite() && bytes >= 1.0 {
            hi.max_bytes = bytes as usize;
        }
    });
}

/// Gruppe öffnen: alle Änderungen bis `doc_group_end` werden ein Undo-Schritt (verschachtelbar).
#[wasm_bindgen]
pub fn doc_group_begin(h: u32) {
    with_doc(h, |d| d.history_mut().begin_group());
}

/// Wie `doc_group_begin`, mit Schlüssel und Zeit (ms): aufeinanderfolgende Gruppen mit gleichem
/// Schlüssel im Zeitfenster werden ein Undo-Schritt (Griff-Zug mit mitgeführten Elementen).
#[wasm_bindgen]
pub fn doc_group_begin_keyed(h: u32, key: &str, now_ms: f64) {
    let key = (!key.is_empty()).then_some(key);
    let now = if now_ms.is_finite() { now_ms } else { 0.0 };
    with_doc(h, |d| d.history_mut().begin_group_keyed(key, now));
}

#[wasm_bindgen]
pub fn doc_group_end(h: u32) {
    with_doc(h, |d| d.history_mut().end_group());
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

/// Abfrage auf der rohen Projekt-Wurzel (`crate::queries::run_root`); Fehler wie bei [`doc_query`].
#[wasm_bindgen]
pub fn doc_query_root(h: u32, name: &str, text: &str) -> String {
    let result = with_doc(h, |d| crate::queries::run_root(d.root(), name, text)).unwrap_or_else(|| Err("Dokument nicht offen".to_string()));
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

/// Das Projekt als Datei-Text (Formatversion vorn, Einrückung 2); leer, wenn das Dokument nicht offen ist.
#[wasm_bindgen]
pub fn doc_serialize(h: u32) -> String {
    with_doc(h, |d| d.serialize()).unwrap_or_default()
}

/// Abfrage mit binärer Antwort (`crate::queries::run_bin`, z. B. `planDomains` als Plan-Puffer v2).
/// Fehler kommen als Fehlerpuffer (`plan_buf::encode_error`).
#[wasm_bindgen]
pub fn doc_query_bin(h: u32, name: &str, args: &[f64], text: &str) -> Vec<u8> {
    let result = with_doc(h, |d| {
        let p = d.project().map_err(|e| format!("Projekt passt nicht zum Kern-Modell: {e}"))?;
        crate::queries::run_bin(&p, name, args, text)
    })
    .unwrap_or_else(|| Err("Dokument nicht offen".to_string()));
    result.unwrap_or_else(|e| crate::plan_buf::encode_error(&e))
}
