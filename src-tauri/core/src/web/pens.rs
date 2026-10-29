//! Bindungen der Stift-Paletten (`crate::pens`): zustandslos; die Rechnung auf dem Projekt (Neu-Backen,
//! Stift löschen, Standardsatz) läuft als Wurzel-Abfrage (`doc_query_root`). Unbekannter Name = leerer Text.

use crate::pens;
use serde_json::{json, Value};
use wasm_bindgen::prelude::wasm_bindgen;

/// Paletten: `freePalette` (48 Farben), `standardPalette` (`{pens, styles}`), `hslToHex` (`arg_json` = `[h, s, l]`).
#[wasm_bindgen]
pub fn pens_call(name: &str, arg_json: &str) -> String {
    match name {
        "freePalette" => json!(pens::free_color_palette()).to_string(),
        "standardPalette" => {
            let (p, s) = pens::standard_pen_palette();
            json!({"pens": p, "styles": s}).to_string()
        }
        "hslToHex" => match serde_json::from_str::<Value>(arg_json).ok().as_ref().and_then(Value::as_array) {
            Some(a) if a.len() == 3 => {
                let n = |i: usize| a[i].as_f64().unwrap_or(f64::NAN);
                json!(pens::hsl_to_hex(n(0), n(1), n(2))).to_string()
            }
            _ => String::new(),
        },
        _ => String::new(),
    }
}
