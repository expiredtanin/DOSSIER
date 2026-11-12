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
        // Bilder auf Blättern ([208], `layout_image.rs`): `imageInfo` (`{src}`) liest Format und Pixelgrösse aus der
        // Data-URL; `imageGeometry` (`{xMm,yMm,widthMm,heightMm,pixelWidth,crop?}`) liefert Klipp-/Zeichen-Rechteck
        // und dpi; `imageAspect` (`{pixelWidth,pixelHeight,crop?}`); `imageInitial` (`{pixelWidth,pixelHeight,sheetW,sheetH}`).
        "imageInfo" => {
            let Ok(a) = serde_json::from_str::<Value>(arg_json) else { return String::new() };
            match crate::layout_image::image_info(a["src"].as_str().unwrap_or("")) {
                Some(i) => json!(i),
                None => return String::new(),
            }
        }
        "imageGeometry" | "imageAspect" | "imageInitial" => {
            let Ok(a) = serde_json::from_str::<Value>(arg_json) else { return String::new() };
            let num = |k: &str| a[k].as_f64().filter(|v| v.is_finite());
            let crop = a["crop"].as_object().and_then(|c| Some((c.get("x")?.as_f64()?, c.get("y")?.as_f64()?, c.get("w")?.as_f64()?, c.get("h")?.as_f64()?)));
            match name {
                "imageGeometry" => {
                    let (Some(x), Some(y), Some(w), Some(h), Some(px)) = (num("xMm"), num("yMm"), num("widthMm"), num("heightMm"), num("pixelWidth")) else { return String::new() };
                    json!(crate::layout_image::geometry(crate::layout_image::Rect { x, y, w, h }, px, crop))
                }
                "imageAspect" => {
                    let (Some(pw), Some(ph)) = (num("pixelWidth"), num("pixelHeight")) else { return String::new() };
                    json!(crate::layout_image::aspect(pw, ph, crop))
                }
                _ => {
                    let (Some(pw), Some(ph), Some(sw), Some(sh)) = (num("pixelWidth"), num("pixelHeight"), num("sheetW"), num("sheetH")) else { return String::new() };
                    json!(crate::layout_image::initial_frame(pw, ph, sw, sh, 0.6))
                }
            }
        }
        // Plakat-Vorlagen ([208], `layout_poster.rs`): `posterMetrics` (`{widthMm,heightMm}`) und `posterHeader`
        // (`{widthMm,heightMm,keywordLabel,keyword,title,planText}`).
        "posterMetrics" | "posterHeader" => {
            let Ok(a) = serde_json::from_str::<Value>(arg_json) else { return String::new() };
            let (Some(w), Some(h)) = (a["widthMm"].as_f64().filter(|v| *v > 0.0 && v.is_finite()), a["heightMm"].as_f64().filter(|v| *v > 0.0 && v.is_finite())) else { return String::new() };
            if name == "posterMetrics" {
                json!(crate::layout_poster::metrics(w, h))
            } else {
                let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
                json!(crate::layout_poster::header_items(w, h, &s("keywordLabel"), &s("keyword"), &s("title"), &s("planText")))
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
