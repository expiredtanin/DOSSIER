//! Bindungen der Import-Umwandlung ([K4] S4, `crate::import_drawing`, `crate::import_ifc`,
//! `crate::import_context`): das Format-Modul (eigenes WASM `pkgFileIo`) liest die Datei in flache Puffer,
//! der Kern macht daraus Ops und wendet sie als EINEN Undo-Schritt auf das Dokument an.
//!
//! Antworten als JSON; Fehler (kaputter Puffer, Dokument nicht offen) als Text mit `\u{1}` vorn, von der
//! Prüfung zurückgewiesene Änderungen als `{"problems":[…]}` (Dokument unverändert).

use super::document::with_doc;
use crate::document::Document;
use crate::import_drawing::{self as imp, Decision, Source};
use crate::ops::Op;
use serde_json::{json, Value};
use wasm_bindgen::prelude::wasm_bindgen;

fn err(e: impl std::fmt::Display) -> String {
    format!("\u{1}{e}")
}

fn now_of(now_ms: f64) -> f64 {
    if now_ms.is_finite() { now_ms } else { 0.0 }
}

/// Ops als JSON-Liste, ohne die Elemente zu kopieren (grosse Importe: 10⁵ Zeichnungen).
pub(crate) fn write_ops(out: &mut Vec<u8>, ops: &[Op]) {
    out.push(b'[');
    for (i, op) in ops.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        match op {
            Op::Add { collection, items, at } => {
                out.extend_from_slice(b"{\"kind\":\"add\",\"collection\":");
                let _ = serde_json::to_writer(&mut *out, collection);
                out.extend_from_slice(b",\"items\":[");
                for (k, it) in items.iter().enumerate() {
                    if k > 0 {
                        out.push(b',');
                    }
                    let _ = serde_json::to_writer(&mut *out, it);
                }
                out.push(b']');
                if let Some(a) = at {
                    out.extend_from_slice(format!(",\"at\":{a}").as_bytes());
                }
                out.push(b'}');
            }
            op => {
                let _ = serde_json::to_writer(&mut *out, &op.to_json());
            }
        }
    }
    out.push(b']');
}

/// Ops als Benutzer-Änderung anwenden; Antwort `{"ops":[…], …extra}` bzw. `{"problems":[…]}`.
fn commit(d: &mut Document, ops: Vec<Op>, extra: &[(&str, Value)], key: &str, now: f64) -> String {
    let mut out: Vec<u8> = b"{\"ops\":".to_vec();
    write_ops(&mut out, &ops);
    for (k, v) in extra {
        out.push(b',');
        let _ = serde_json::to_writer(&mut out, k);
        out.push(b':');
        let _ = serde_json::to_writer(&mut out, v);
    }
    out.push(b'}');
    let text = String::from_utf8(out).unwrap_or_default();
    if ops.is_empty() {
        return text;
    }
    let marks = text.contains("\\u0001");
    let key = (!key.is_empty()).then_some(key);
    match d.commit(ops, key, now, marks) {
        Ok(()) => text,
        Err(problems) => json!({ "problems": problems }).to_string(),
    }
}

fn source_of(json: &str) -> Source {
    serde_json::from_str(json).unwrap_or_default()
}

/// Zusammenfassung eines gelesenen Zeichnungs-Imports für den Dialog (Zahlen, Layer, Diagnose, Layouts).
/// `geom` = Stücke (`[n, len_0 …, daten …]`), `strings_json` = String-Tabellen je Stück, `source_json` s. [`Source`].
#[wasm_bindgen]
pub fn import_drawing_summary(geom: &[f64], strings_json: &str, source_json: &str) -> String {
    match imp::read_source(geom, strings_json, &source_of(source_json), 0.0) {
        Ok(d) => imp::summary_json(&d).to_string(),
        Err(e) => err(e),
    }
}

/// Die ganze Import-Form als JSON (Leseansicht für Tests/Diagnose, s. `import_drawing::view_json`).
#[wasm_bindgen]
pub fn import_drawing_view(geom: &[f64], strings_json: &str, source_json: &str, now_ms: f64) -> String {
    match imp::read_source(geom, strings_json, &source_of(source_json), now_of(now_ms)) {
        Ok(d) => imp::view_json(&d).to_string(),
        Err(e) => err(e),
    }
}

/// Nur die Meshes eines Zeichnungs-Imports als Kontext-Objekte (JSON-Liste), z. B. swissBUILDINGS3D-Kacheln.
#[wasm_bindgen]
pub fn import_drawing_meshes(geom: &[f64], strings_json: &str, source_json: &str, now_ms: f64) -> String {
    match imp::read_source(geom, strings_json, &source_of(source_json), now_of(now_ms)) {
        Ok(d) => Value::Array(imp::mesh_values(&d)).to_string(),
        Err(e) => err(e),
    }
}

/// Bestätigten Zeichnungs-Import (DXF/DWG/PDF) als EINEN Undo-Schritt ins Dokument `h` übernehmen.
/// `decision_json` s. [`Decision`]. Antwort: `{"ops":[…],"levelId":"…","drawings":n,"meshes":n}`.
#[wasm_bindgen]
pub fn doc_import_drawing(h: u32, geom: &[f64], strings_json: &str, source_json: &str, decision_json: &str, key: &str, now_ms: f64) -> String {
    let now = now_of(now_ms);
    let dec: Decision = match serde_json::from_str(decision_json) {
        Ok(d) => d,
        Err(e) => return err(format!("Import-Entscheidung: {e}")),
    };
    let d = match imp::read_source(geom, strings_json, &source_of(source_json), now) {
        Ok(d) => d,
        Err(e) => return err(e),
    };
    with_doc(h, |doc| {
        let r = imp::import_ops(doc.root(), &d, &dec, now);
        let extra = [("levelId", Value::from(r.level_id)), ("drawings", r.drawings.into()), ("meshes", r.meshes.into())];
        commit(doc, r.ops, &extra, key, now)
    })
    .unwrap_or_else(|| err("Dokument nicht offen"))
}

/// IFC ins Dokument `h` übernehmen (Kontext-Meshes, mit `opts.elements` Bauteile), ein Undo-Schritt.
/// `meta` = Bericht des Lesers (JSON), dazu Positionen, Indizes und (Bauteile) die Zahlen der Erkennung.
/// Antwort: `{"ops":[…],"report":{…},"summary":{…}|null,"kept":{…},"contextObjects":n}`.
#[wasm_bindgen]
pub fn doc_import_ifc(h: u32, meta: &str, positions: &[f64], indices: &[u32], element_data: &[f64], opts_json: &str, key: &str, now_ms: f64) -> String {
    let now = now_of(now_ms);
    let opts: crate::import_ifc::IfcOptions = serde_json::from_str(opts_json).unwrap_or_default();
    let idx: Vec<f64> = indices.iter().map(|&i| i as f64).collect();
    with_doc(h, |doc| match crate::import_ifc::ifc_import(doc.root(), meta, positions, &idx, element_data, &opts, now) {
        Ok(r) => {
            let extra = [
                ("report", r.report),
                ("summary", r.summary.unwrap_or(Value::Null)),
                ("kept", Value::Object(r.kept)),
                ("contextObjects", r.context_objects.into()),
            ];
            commit(doc, r.ops, &extra, key, now)
        }
        Err(e) => err(e),
    })
    .unwrap_or_else(|| err("Dokument nicht offen"))
}

fn strings_of(json: &str) -> Result<Vec<String>, String> {
    serde_json::from_str(json).map_err(|e| format!("Import-Texte: {e}"))
}

/// Bericht eines gelesenen Mesh-Imports (Format, Achse, Einheit, Dreiecke, Hinweise) und Ausdehnung
/// (`[dx, dy, dz]` in Metern, `null` ohne Punkte) für den Dialog: `{"report":{…},"extent":…}`.
#[wasm_bindgen]
pub fn mesh_import_report(flat: &[f64], strings_json: &str) -> String {
    match strings_of(strings_json).and_then(|s| crate::import_context::decode_mesh(flat, &s)) {
        Ok((objects, report)) => {
            let extent = crate::import_context::mesh_extent(&objects).map_or(Value::Null, |e| json!(e));
            json!({"report": report, "extent": extent}).to_string()
        }
        Err(e) => err(e),
    }
}

/// Optionen des Mesh-Imports: Dateiname, Platzierung (`center`|`original`), Gruppierung (`object`|`merge`|`auto`).
#[derive(serde::Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct MeshOptions {
    file_name: String,
    placement: Option<String>,
    group: Option<String>,
}

/// Gelesenes 3D-Modell (OBJ/STL/glTF/PLY) als Kontext-Meshes ins Dokument `h`, ein Undo-Schritt.
/// Antwort: `{"ops":[…],"report":{…},"contextObjects":n}`.
#[wasm_bindgen]
pub fn doc_import_mesh(h: u32, flat: &[f64], strings_json: &str, opts_json: &str, key: &str, now_ms: f64) -> String {
    let now = now_of(now_ms);
    let opts: MeshOptions = serde_json::from_str(opts_json).unwrap_or_default();
    let (objects, report) = match strings_of(strings_json).and_then(|s| crate::import_context::decode_mesh(flat, &s)) {
        Ok(r) => r,
        Err(e) => return err(e),
    };
    with_doc(h, |doc| {
        let origin = crate::import_context::project_geo_origin(doc.root());
        let meshes = crate::import_context::mesh_objects_to_meshes(
            &objects,
            &opts.file_name,
            opts.placement.as_deref().unwrap_or("center"),
            origin,
            opts.group.as_deref().unwrap_or("auto"),
            now,
        );
        let n = meshes.len();
        let ops = crate::import_context::context_ops(doc.root(), meshes);
        commit(doc, ops, &[("report", report), ("contextObjects", n.into())], key, now)
    })
    .unwrap_or_else(|| err("Dokument nicht offen"))
}

/// Kurzbericht einer gelesenen PDF-Seite (CLI `pdf-info`): Zahlen, Ebenen, Umriss.
#[wasm_bindgen]
pub fn pdf_page_info(geom: &[f64], strings_json: &str) -> String {
    match strings_of(strings_json).and_then(|s| imp::decode_pdf(geom, &s)) {
        Ok(p) => imp::pdf_page_info(&p).to_string(),
        Err(e) => err(e),
    }
}
