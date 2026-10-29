//! Bindungen der Layout-Blätter und Ordner-Bäume (`crate::layout_model`, `crate::folder_tree`): zustandslos,
//! JSON hinein, JSON hinaus. Kaputte Eingaben ergeben einen leeren Text (nie ein Panic). Projekt-Rechnungen
//! (Ordner-PDF, Titelblock) laufen als Wurzel-Abfragen (`doc_query_root`).

use crate::folder_tree::{self, Folder, Leaf};
use serde::Deserialize;
use serde_json::{json, Value};
use wasm_bindgen::prelude::wasm_bindgen;

#[derive(Deserialize, Default)]
#[serde(default)]
struct Args {
    folders: Vec<Folder>,
    leaves: Vec<Leaf>,
    #[serde(rename = "folderId")]
    folder_id: String,
    candidate: String,
    root: String,
}

/// Rechnung `name` auf `arg_json`: `treeBuild` / `treeCollect` / `treeDelete` (`{folders, leaves, folderId}`),
/// `isDescendant` (`{folders, candidate, root}`), `sheetSize` (`{paper, landscape, customWidthMm, customHeightMm}`).
#[wasm_bindgen]
pub fn layout_call(name: &str, arg_json: &str) -> String {
    let out: Value = match name {
        "sheetSize" => {
            let Ok(a) = serde_json::from_str::<Value>(arg_json) else { return String::new() };
            let size = crate::layout_model::sheet_size(
                a["paper"].as_str().unwrap_or(""),
                a["landscape"].as_bool().unwrap_or(false),
                a["customWidthMm"].as_f64(),
                a["customHeightMm"].as_f64(),
            );
            match size {
                Some((w, h)) => json!({"w": w, "h": h}),
                None => return String::new(),
            }
        }
        _ => {
            let Ok(a) = serde_json::from_str::<Args>(arg_json) else { return String::new() };
            match name {
                "treeBuild" => json!(folder_tree::build(&a.folders, &a.leaves)),
                "treeCollect" => json!(folder_tree::collect(&a.folders, &a.leaves, &a.folder_id)),
                "treeDelete" => json!(folder_tree::delete(&a.folders, &a.leaves, &a.folder_id)),
                "isDescendant" => json!(folder_tree::is_descendant(&a.folders, &a.candidate, &a.root)),
                _ => return String::new(),
            }
        }
    };
    out.to_string()
}
