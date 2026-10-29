//! Bindung des Z-Anordnens (`crate::reorder`): ids der Liste und gewählte ids als JSON, Antwort die neue
//! Reihenfolge als Index-Liste (`null` = nichts zu tun). Kaputte Eingaben ergeben einen leeren Text.

use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
pub fn reorder_call(list_ids_json: &str, selected_json: &str, op: &str) -> String {
    let Ok(list) = serde_json::from_str::<Vec<Option<String>>>(list_ids_json) else { return String::new() };
    let Ok(selected) = serde_json::from_str::<Vec<String>>(selected_json) else { return String::new() };
    match crate::reorder::reorder(&list, &selected, op) {
        Some(order) => serde_json::json!(order).to_string(),
        None => "null".to_string(),
    }
}
