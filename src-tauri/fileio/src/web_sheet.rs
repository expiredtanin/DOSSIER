// WASM-Bindung des Tabellen-Lesers (`sheet_import.rs`, [61]): Bytes rein, JSON raus
// (`[{"name":…,"rows":[[null|"text"|1.5,…],…]}]`). Kaputte Dateien → JS-Fehler mit Meldung (kein Panic).

use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

use crate::sheet_import::{parse_number, read_sheets, Cell};

/// Tabellenblätter einer .xlsx/.ods/.csv-Datei als JSON-Text.
#[wasm_bindgen]
pub fn sheet_read(bytes: Vec<u8>, file_name: String) -> Result<String, JsValue> {
    let sheets = read_sheets(&bytes, &file_name).map_err(|e| JsValue::from_str(&e))?;
    let out: Vec<Value> = sheets
        .iter()
        .map(|s| {
            let rows: Vec<Value> = s
                .rows
                .iter()
                .map(|r| {
                    Value::Array(
                        r.iter()
                            .map(|c| match c {
                                Cell::Empty => Value::Null,
                                Cell::Text(t) => Value::String(t.clone()),
                                Cell::Num(n) => json!(n),
                            })
                            .collect(),
                    )
                })
                .collect();
            json!({ "name": s.name, "rows": rows })
        })
        .collect();
    Ok(Value::Array(out).to_string())
}

/// Zahl aus Zelltext ("1'250,5", "12,5 m²") oder NaN.
#[wasm_bindgen]
pub fn sheet_parse_number(text: String) -> f64 {
    parse_number(&text).unwrap_or(f64::NAN)
}

// ── Zuordnung Spalten → Raumprogramm (`sheet_map.rs`); JSON rein/raus, Unsinn → leeres Ergebnis ──

use crate::sheet_map::{self, Columns, Field, ImportLine, Mapping};

fn rows_from_json(s: &str) -> Vec<Vec<Cell>> {
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(s) else { return Vec::new() };
    rows.iter()
        .map(|r| {
            r.as_array()
                .map(|cs| {
                    cs.iter()
                        .map(|c| match c {
                            Value::String(t) => Cell::Text(t.clone()),
                            Value::Number(n) => Cell::Num(n.as_f64().unwrap_or(f64::NAN)),
                            _ => Cell::Empty,
                        })
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect()
}

fn mapping_to_json(m: &Mapping) -> Value {
    let mut cols = serde_json::Map::new();
    for f in sheet_map::FIELDS {
        if let Some(c) = m.columns.get(f) {
            cols.insert(f.key().into(), json!(c));
        }
    }
    json!({ "headerRow": m.header_row, "columns": cols })
}

fn mapping_from_json(s: &str) -> Mapping {
    let v: Value = serde_json::from_str(s).unwrap_or(Value::Null);
    let mut columns = Columns::default();
    if let Some(o) = v.get("columns").and_then(|c| c.as_object()) {
        for (k, c) in o {
            if let (Some(f), Some(i)) = (Field::from_key(k), c.as_u64()) {
                columns.0[f as usize] = Some(i as usize);
            }
        }
    }
    Mapping { header_row: v.get("headerRow").and_then(|h| h.as_u64()).map(|h| h as usize), columns }
}

/// Text einer Zelle (JSON-Wert: Zahl, Text oder null).
#[wasm_bindgen]
pub fn sheet_cell_text(cell_json: String) -> String {
    match serde_json::from_str::<Value>(&cell_json) {
        Ok(Value::String(t)) => sheet_map::cell_text(&Cell::Text(t)),
        Ok(Value::Number(n)) => sheet_map::cell_text(&Cell::Num(n.as_f64().unwrap_or(f64::NAN))),
        _ => String::new(),
    }
}

/// Flächenart aus Text ("HNF", "Hauptnutzfläche") oder "".
#[wasm_bindgen]
pub fn sheet_parse_kind(text: String) -> String {
    sheet_map::parse_kind(&text).unwrap_or("").to_string()
}

/// Kopfzeile (0-basiert) oder -1.
#[wasm_bindgen]
pub fn sheet_detect_header_row(rows_json: String) -> i32 {
    sheet_map::detect_header_row(&rows_from_json(&rows_json)).map_or(-1, |r| r as i32)
}

/// Spaltenvorschlag als JSON `{headerRow, columns}`.
#[wasm_bindgen]
pub fn sheet_suggest_mapping(rows_json: String) -> String {
    mapping_to_json(&sheet_map::suggest_mapping(&rows_from_json(&rows_json))).to_string()
}

fn line_json(l: &ImportLine) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("sheetRow".into(), json!(l.sheet_row));
    if let Some(r) = &l.row {
        let mut row = serde_json::Map::new();
        row.insert("name".into(), json!(r.name));
        row.insert("area".into(), json!(r.area));
        if let Some(c) = r.count {
            row.insert("count".into(), json!(c));
        }
        if let Some(k) = r.sia_category {
            row.insert("siaCategory".into(), json!(k));
        }
        if let Some(g) = &r.group {
            row.insert("group".into(), json!(g));
        }
        if let Some(n) = &r.note {
            row.insert("note".into(), json!(n));
        }
        o.insert("row".into(), Value::Object(row));
    }
    if let Some(s) = l.skip {
        o.insert("skip".into(), json!(s));
    }
    if let Some(g) = &l.group_heading {
        o.insert("groupHeading".into(), json!(g));
    }
    if let Some(k) = &l.unknown_kind {
        o.insert("unknownKind".into(), json!(k));
    }
    Value::Object(o)
}

/// Zeilen abbilden: JSON-Array von `ImportLine`.
#[wasm_bindgen]
pub fn sheet_map_rows(rows_json: String, mapping_json: String, skip_sums: bool) -> String {
    let lines = sheet_map::map_rows(&rows_from_json(&rows_json), &mapping_from_json(&mapping_json), skip_sums);
    Value::Array(lines.iter().map(line_json).collect()).to_string()
}
