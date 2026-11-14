//! Bindung der Objektbibliothek (`crate::furniture_lib`, [253]): Katalog und Vorschau-Geometrie als JSON.
//! Unsinn (kaputtes JSON, unbekannte Id) ergibt Platzhalter bzw. leere Listen — nie einen Panic.

use crate::plan::style::Detail;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::wasm_bindgen;

/// Katalog `{ objects: [{id, group, category, categoryCode, categoryName, anchor, seeded, params}], categories }`.
#[wasm_bindgen]
pub fn furniture_lib_catalog_json() -> String {
    crate::furniture_lib::catalog_json().to_string()
}

/// Lokale Geometrie (Array von `Drawing2DGeom`) eines Objekts: `params_json` = Parameter-Map, `detail` = grob|mittel|fein.
#[wasm_bindgen]
pub fn furniture_lib_geometry_json(lib_id: &str, params_json: &str, detail: &str, seed: u32) -> String {
    let params: BTreeMap<String, serde_json::Value> = serde_json::from_str(params_json).unwrap_or_default();
    let g = crate::furniture_lib::geometry_for(lib_id, &params, Detail::parse(detail), seed);
    serde_json::to_string(&g).unwrap_or_else(|_| "[]".into())
}
