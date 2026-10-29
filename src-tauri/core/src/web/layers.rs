//! Bindungen der Ebenen-/Geschoss-Logik (`crate::layers`, `crate::levels`): zustandslos, JSON hinein,
//! JSON hinaus. Kaputte Eingaben ergeben einen leeren Text (nie ein Panic).

use crate::layers;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use wasm_bindgen::prelude::wasm_bindgen;

fn list(json: &str) -> Option<Vec<Value>> {
    match serde_json::from_str::<Value>(json).ok()? {
        Value::Array(a) => Some(a),
        _ => None,
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn obj(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

/// Rechnung `name` auf dem Kategorie-Baum `layers_json` (Liste); `arg_json`: je nach Rechnung ein Text,
/// eine Liste oder ein Objekt. Antwort als JSON, bei Unsinn (kein Baum, unbekannter Name) leerer Text.
#[wasm_bindgen]
pub fn layers_call(name: &str, layers_json: &str, arg_json: &str, now_ms: f64) -> String {
    let Some(cats) = list(layers_json) else { return String::new() };
    let arg: Value = if arg_json.is_empty() { Value::Null } else { serde_json::from_str(arg_json).unwrap_or(Value::Null) };
    let out: Value = match name {
        "flatten" => Value::Array(layers::flatten(&cats).into_iter().cloned().collect()),
        "find" => layers::find(&cats, text(&arg)).cloned().unwrap_or(Value::Null),
        "visibleCodes" => json!(layers::visible_codes(&cats)),
        "setVisible" => {
            let codes: HashSet<String> = strings(&arg["codes"]).into_iter().collect();
            layers::set_visible(&cats, &codes, arg["visible"].as_bool().unwrap_or(false)).map_or(Value::Null, Value::Array)
        }
        "isolate" => {
            let codes: HashSet<String> = strings(&arg).into_iter().collect();
            layers::isolate(&cats, &codes).map_or(Value::Null, Value::Array)
        }
        "names" => json!(layers::names(&cats, &strings(&arg))),
        "toggle" => Value::Array(layers::toggle(&cats, text(&arg))),
        "applyVisibility" => Value::Array(layers::apply_visibility(&cats, &obj(&arg))),
        "patch" => Value::Array(layers::patch(&cats, text(&arg["code"]), &obj(&arg["patch"]))),
        "addChild" => Value::Array(layers::add_child(&cats, text(&arg["parent"]), &arg["child"])),
        "insertAfter" => Value::Array(layers::insert_after(&cats, text(&arg["code"]), &arg["clone"])),
        "remove" => Value::Array(layers::remove(&cats, text(&arg))),
        "nextFreeCode" => Value::String(layers::next_free_code(&cats, if now_ms.is_finite() { now_ms } else { 0.0 })),
        // Fehlende Kontext-Kategorien ergänzen (`ensureContextCategories`); `null` = nichts fehlt.
        "ensureContext" => {
            let mut cats = cats;
            let codes = strings(&arg);
            if crate::import_context::ensure_context_categories(&mut cats, codes.iter().map(String::as_str)) { Value::Array(cats) } else { Value::Null }
        }
        _ => return String::new(),
    };
    out.to_string()
}

/// `recomputeFloorElevations` auf der Ebenen-Liste (JSON); leerer Text bei Unsinn.
#[wasm_bindgen]
pub fn levels_recompute_elevations(levels_json: &str) -> String {
    match list(levels_json) {
        Some(l) => Value::Array(crate::levels::recompute_floor_elevations(&l)).to_string(),
        None => String::new(),
    }
}
