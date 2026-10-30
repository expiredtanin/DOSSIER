//! Bindungen der Zeichenbefehle (`crate::cmd_create`): Vorschau je Mausschritt (Optionen als JSON, die
//! Punkte flach) und Treffer-Abfragen zwischen den Schritten. Der Commit läuft über `doc_cmd_commit`.
//!
//! Je Mausschritt ändern sich meist nur die Punkte: die zuletzt gelesenen Optionen bleiben hier liegen,
//! `doc_create_preview_again` rechnet mit ihnen (kein JSON hin und kein Parsen je Mausschritt — die
//! Wand-Vorschau ist sonst langsamer als die frühere TS-Fassung).

use super::document::with_doc;
use crate::cmd_create::Req;
use serde_json::Value;
use std::cell::RefCell;
use wasm_bindgen::prelude::wasm_bindgen;

thread_local! {
    static LAST_REQ: RefCell<Option<Req>> = const { RefCell::new(None) };
}

fn run(h: u32, req: &Req, pts: &[f64]) -> Vec<f64> {
    if pts.len() % 2 != 0 {
        return Vec::new();
    }
    with_doc(h, |d| crate::cmd_create::preview_req(d.root(), req, pts).flat()).unwrap_or_default()
}

/// Vorschau eines Zeichenbefehls auf dem Dokument `h`: `[ok, nInfo, info…, Formen…]` (Formen wie
/// `doc_cmd_preview`); leer bei Fehler. Merkt sich die Optionen für [`doc_create_preview_again`].
#[wasm_bindgen]
pub fn doc_create_preview(h: u32, req_json: &str, pts: &[f64]) -> Vec<f64> {
    let req = serde_json::from_str::<Value>(req_json).ok().filter(Value::is_object).map(Req::new);
    let out = req.as_ref().map_or_else(Vec::new, |r| run(h, r, pts));
    LAST_REQ.with(|l| *l.borrow_mut() = req);
    out
}

/// Wie [`doc_create_preview`] mit den zuletzt übergebenen Optionen (nur neue Punkte).
#[wasm_bindgen]
pub fn doc_create_preview_again(h: u32, pts: &[f64]) -> Vec<f64> {
    LAST_REQ.with(|l| l.borrow().as_ref().map_or_else(Vec::new, |r| run(h, r, pts)))
}

/// Treffer-Abfrage eines Zeichenbefehls (`crate::cmd_create::query`), Antwort-JSON (Zahlen mit
/// Nicht-endlich-Marken); Fehler als Text mit `\u{1}` vorn.
#[wasm_bindgen]
pub fn doc_create_query(h: u32, req_json: &str) -> String {
    let v: Value = match serde_json::from_str(req_json) {
        Ok(v) => v,
        Err(e) => return format!("\u{1}Zeichen-Abfrage: {e}"),
    };
    match with_doc(h, |d| crate::cmd_create::query(d.root(), &v)) {
        Some(Some(Ok(v))) => v.to_string(),
        Some(Some(Err(e))) => format!("\u{1}{e}"),
        Some(None) => "\u{1}Unbekannte Zeichen-Abfrage".to_string(),
        None => "\u{1}Dokument nicht offen".to_string(),
    }
}

/// B-Rep-Beschreibung eines Körpers (`crate::cmd_solid::extruded_solid_spec`) als JSON (Zahlen mit
/// Nicht-endlich-Marken); leer = keine Beschreibung oder kein Körper.
#[wasm_bindgen]
pub fn extruded_solid_spec_json(solid_json: &str, floor_z: f64) -> String {
    serde_json::from_str::<Value>(solid_json)
        .ok()
        .and_then(|s| crate::cmd_solid::extruded_solid_spec(&s, floor_z))
        .map_or_else(String::new, |v| v.to_string())
}

/// Gelände-TIN aus Höhenlinien (`crate::cmd_solid::terrain_from_contours`) als JSON; `id` des Netzes.
#[wasm_bindgen]
pub fn terrain_from_contours_json(contours_json: &str, id: &str) -> String {
    let c: Value = serde_json::from_str(contours_json).unwrap_or(Value::Null);
    crate::cmd_solid::terrain_from_contours(c.as_array().map(Vec::as_slice).unwrap_or(&[]), id).to_string()
}

/// Wie [`terrain_from_contours_json`] mit Optionen ([T6]): `smooth` Glättungsstufen (0–4), `max_edge` grösste
/// Kante in m (≤ 0 automatisch), `breaklines` ≠ 0 erzwingt die Konturen als Bruchkanten.
#[wasm_bindgen]
pub fn terrain_from_contours_opts_json(contours_json: &str, id: &str, smooth: f64, max_edge: f64, breaklines: f64) -> String {
    let c: Value = serde_json::from_str(contours_json).unwrap_or(Value::Null);
    let o = crate::terrain::TerrainOpts {
        smooth: if smooth.is_finite() { smooth.clamp(0.0, 4.0) as u32 } else { 2 },
        max_edge: if max_edge.is_finite() { max_edge } else { 0.0 },
        breaklines: breaklines != 0.0,
    };
    crate::cmd_solid::terrain_from_contours_with(c.as_array().map(Vec::as_slice).unwrap_or(&[]), id, o).to_string()
}
