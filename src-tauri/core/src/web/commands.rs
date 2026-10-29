//! Bindungen der Befehle im Kern (`crate::commands`): Befehl rechnen und gleich als Benutzer-Änderung
//! anwenden (ein Aufruf, keine Op-Übergabe hin und zurück), Vorschau der Transformationen.

use super::document::with_doc;
use serde_json::json;
use wasm_bindgen::prelude::wasm_bindgen;

/// Befehl `req_json` (s. `crate::commands::ops`) auf dem Dokument `h` rechnen und mit Verlauf anwenden
/// (`key` = coalesceKey, `now_ms` wie `doc_commit`). Antwort: `{"ops":[…]}` (angewendet; leer = nichts
/// zu tun) oder `{"problems":[…]}` (zurückgewiesen, Dokument unverändert); Fehler als Text mit `\u{1}` vorn.
#[wasm_bindgen]
pub fn doc_cmd_commit(h: u32, req_json: &str, key: &str, now_ms: f64) -> String {
    let key = (!key.is_empty()).then_some(key);
    let now = if now_ms.is_finite() { now_ms } else { 0.0 };
    let out = with_doc(h, |d| -> Result<String, String> {
        let res = crate::grips::GripResult { ops: crate::commands::ops(d.root(), req_json)?, notice: None };
        let text = crate::grips::result_json(&res);
        if res.ops.is_empty() {
            return Ok(text);
        }
        // Nicht endliche Ergebnisse stehen als Marken in den Ops (die Prüfung weist sie zurück).
        let marks = text.contains("\\u0001");
        match d.commit(res.ops, key, now, marks) {
            Ok(()) => Ok(text),
            Err(problems) => Ok(json!({ "problems": problems }).to_string()),
        }
    });
    match out {
        Some(Ok(t)) => t,
        Some(Err(e)) => format!("\u{1}{e}"),
        None => "\u{1}Dokument nicht offen".to_string(),
    }
}

/// Vorschau-Formen einer Transformation (`req_json` wie `cmdOps` mit `cmd: "transform"`, dazu `scale`
/// und `top`): flach je Form `[art (0 Linie, 1 Polygon), n, x0, y0, …]`; leer bei Fehler.
#[wasm_bindgen]
pub fn doc_cmd_preview(h: u32, req_json: &str) -> Vec<f64> {
    let Ok(req) = serde_json::from_str::<crate::cmd_transform::TransformReq>(req_json) else { return Vec::new() };
    with_doc(h, |d| {
        let pending = crate::cmd_transform::preview_pending(d.root(), &req);
        let p = if pending.has_drawings() { d.project().ok() } else { None };
        crate::cmd_transform::preview_finish(p, pending, req.scale.0, req.top.0)
    })
    .unwrap_or_default()
}

/// Abfrage eines Befehls zwischen den Schritten (`crate::cmd_edit::query`: Treffer, Vorschau-Formen) auf
/// dem Dokument `h`; Antwort-JSON (Zahlen mit Nicht-endlich-Marken), Fehler als Text mit `\u{1}` vorn.
#[wasm_bindgen]
pub fn doc_cmd_query(h: u32, req_json: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(req_json) {
        Ok(v) => v,
        Err(e) => return format!("\u{1}Befehls-Abfrage: {e}"),
    };
    match with_doc(h, |d| crate::cmd_edit::query(d.root(), &v)) {
        Some(Ok(v)) => v.to_string(),
        Some(Err(e)) => format!("\u{1}{e}"),
        None => "\u{1}Dokument nicht offen".to_string(),
    }
}
