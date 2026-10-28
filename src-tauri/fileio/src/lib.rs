// dossier-fileio — Dateiformate von Dossier in Rust (DXF/DWG lesen und schreiben über acadrust,
// später IFC). Eigenes WASM-Paket `src/engine/pkgFileIo`, das erst beim Import/Export nachgeladen wird
// (`src/engine/fileioWasm.ts`) — der Kern (`src-tauri/core`) bleibt davon unberührt und klein.
//
// Aufbau (je Format ein Modul, parallel bearbeitbar; in `lib.rs` nur `mod`-Zeilen ergänzen):
//   - `parse_dxf_summary` (unten): Übersicht eines DXF, Startpunkt/Probe.
//   - Import (DXF/DWG → flache Elementliste für `io/dxfToDrawings.ts`), Export (Zeichnung → DXF/DWG).
//   - `#[cfg(feature = "web")]` wasm-bindgen-Fassade; Bytes rein, Bytes/flache Puffer raus; Unsinn ergibt
//     einen Fehler-String, nie einen Panic.
//
// acadrust: `DxfReader::from_reader(Cursor<Vec<u8>>)` (Read + Seek + 'static) — ohne Dateisystem, WASM-tauglich.

pub mod export;
pub mod common;
pub mod import;
pub mod split;
pub mod text;
pub mod annotation;
#[cfg(feature = "web")]
mod web_import;
#[cfg(feature = "web")]
mod web_pointcloud;
pub mod ifc_step;
pub mod ifc_import;
pub mod ifc_semantic;
pub mod ifc_export;
pub mod ifc_openings;
pub mod mesh_export;
pub mod bcf;
pub mod csg;
mod ifc_sweep;
mod ifc_nurbs;
pub mod pointcloud;
pub mod pointcloud_las;
pub mod pointcloud_e57;
pub mod pointcloud_text;
pub mod pdf_object;
pub mod pdf_vector;
pub mod pdf_geom;
#[cfg(feature = "web")]
mod web_pdf;

use std::collections::HashMap;
use std::io::Cursor;

use acadrust::DxfReader;

// serde_json nur bei Feature "web" als optionale Dep, aber serde ist immer da.
// Fuer den headless-Kern bauen wir das JSON mit einem einfachen Format-String,
// damit keine Compile-Time-Dep auf serde_json im Default-Feature noetig ist.

/// Parst ein DXF aus einem Byte-Slice und gibt ein JSON-Summary zurueck.
///
/// Rueckgabe-JSON-Schema:
/// ```json
/// {
///   "version": "AC1015",
///   "entityCount": 5,
///   "entityTypeCounts": { "LINE": 3, "CIRCLE": 2 },
///   "layerNames": ["0", "Wand"]
/// }
/// ```
///
/// Fehler: String mit Fehlerbeschreibung.
pub fn parse_dxf_summary(bytes: &[u8]) -> Result<String, String> {
    // Cursor<Vec<u8>> implementiert Read + Seek + 'static — kein std::fs noetig.
    // (from_reader verlangt R: 'static; Cursor<&[u8]> wuerde die Lifetime verletzen.)
    let cursor = Cursor::new(bytes.to_vec());
    let reader = DxfReader::from_reader(cursor)
        .map_err(|e| format!("DxfReader::from_reader fehlgeschlagen: {e}"))?;

    let doc = reader
        .read()
        .map_err(|e| format!("DxfReader::read fehlgeschlagen: {e}"))?;

    // Versions-String aus dem Enum (Debug-Format, z. B. "AC1015").
    let version = format!("{:?}", doc.version);

    // Entitaeten zaehlen und nach Typ aufschluesseln.
    let mut type_counts: HashMap<&str, usize> = HashMap::new();
    for entity in doc.entities() {
        let typ = entity.as_entity().entity_type();
        *type_counts.entry(typ).or_insert(0) += 1;
    }
    let entity_count = type_counts.values().sum::<usize>();

    // Layer-Namen aus der Layer-Tabelle.
    let mut layer_names: Vec<String> = doc
        .layers
        .iter()
        .map(|l| l.name.clone())
        .collect();
    layer_names.sort();

    // JSON-Serialisierung ohne optionale serde_json-Dep im Default-Feature.
    // Fuer den headless-Test reicht ein sauberer Format-String.
    let type_counts_json = {
        let mut pairs: Vec<String> = type_counts
            .iter()
            .map(|(k, v)| format!("    \"{k}\": {v}"))
            .collect();
        pairs.sort(); // deterministisch fuer Tests
        format!("{{\n{}\n  }}", pairs.join(",\n"))
    };

    let layer_names_json = {
        let quoted: Vec<String> = layer_names
            .iter()
            .map(|n| format!("\"{}\"", n.replace('"', "\\\"")))
            .collect();
        format!("[{}]", quoted.join(", "))
    };

    Ok(format!(
        "{{\n  \"version\": \"{version}\",\n  \"entityCount\": {entity_count},\n  \"entityTypeCounts\": {type_counts_json},\n  \"layerNames\": {layer_names_json}\n}}"
    ))
}

// ---------------------------------------------------------------------------
// WASM-Fassade (nur bei Feature "web" compiliert)
// ---------------------------------------------------------------------------

#[cfg(feature = "web")]
mod wasm {
    use super::parse_dxf_summary;
    use wasm_bindgen::prelude::*;

    /// Initialisiert den Panic-Hook fuer bessere Fehlermeldungen im Browser.
    #[wasm_bindgen(start)]
    pub fn init_panic_hook() {
        console_error_panic_hook::set_once();
    }

    /// WASM-Fassade: nimmt einen Byte-Buffer (Uint8Array aus JS) und gibt ein
    /// JSON-String zurueck, das das DXF-Summary beschreibt.
    ///
    /// JS-Aufruf:
    /// ```js
    /// import init, { parse_dxf_summary_json } from './pkgDwgImport/dwgimport.js';
    /// await init();
    /// const json = parse_dxf_summary_json(new Uint8Array(buffer));
    /// ```
    #[wasm_bindgen]
    pub fn parse_dxf_summary_json(bytes: &[u8]) -> Result<String, JsValue> {
        parse_dxf_summary(bytes)
            .map_err(|e| JsValue::from_str(&e))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimales ASCII-DXF mit 3 LINE- und 2 CIRCLE-Entitaeten auf Layer "WAND"
    /// und Layer "0". Wird direkt als Byte-Slice eingebettet — kein Datei-IO.
    const MINI_DXF: &str = r#"  0
SECTION
  2
HEADER
  9
$ACADVER
  1
AC1015
  0
ENDSEC
  0
SECTION
  2
TABLES
  0
TABLE
  2
LAYER
 70
     2
  0
LAYER
  2
0
 70
     0
 62
     7
  6
Continuous
  0
LAYER
  2
WAND
 70
     0
 62
     3
  6
Continuous
  0
ENDTAB
  0
ENDSEC
  0
SECTION
  2
ENTITIES
  0
LINE
  8
WAND
 10
0.0
 20
0.0
 30
0.0
 11
100.0
 21
0.0
 31
0.0
  0
LINE
  8
WAND
 10
100.0
 20
0.0
 30
0.0
 11
100.0
 21
50.0
 31
0.0
  0
LINE
  8
0
 10
100.0
 20
50.0
 30
0.0
 11
0.0
 21
0.0
 31
0.0
  0
CIRCLE
  8
WAND
 10
50.0
 20
25.0
 30
0.0
 40
10.0
  0
CIRCLE
  8
0
 10
20.0
 20
10.0
 30
0.0
 40
5.0
  0
ENDSEC
  0
EOF
"#;

    #[test]
    fn test_parse_mini_dxf() {
        let result = parse_dxf_summary(MINI_DXF.as_bytes());
        assert!(result.is_ok(), "parse_dxf_summary schlug fehl: {:?}", result);

        let json = result.unwrap();
        println!("DXF-Summary:\n{json}");

        // Version muss AC1015 sein.
        assert!(json.contains("AC1015"), "Version AC1015 nicht im JSON: {json}");

        // Genau 5 Entitaeten: 3 LINE + 2 CIRCLE.
        assert!(
            json.contains("\"entityCount\": 5"),
            "entityCount soll 5 sein: {json}"
        );
        assert!(
            json.contains("\"LINE\": 3"),
            "LINE-Zaehler soll 3 sein: {json}"
        );
        assert!(
            json.contains("\"CIRCLE\": 2"),
            "CIRCLE-Zaehler soll 2 sein: {json}"
        );

        // Layer "WAND" und "0" muessen erscheinen.
        assert!(json.contains("\"WAND\""), "Layer WAND fehlt: {json}");
        assert!(json.contains("\"0\""), "Layer 0 fehlt: {json}");
    }
}
