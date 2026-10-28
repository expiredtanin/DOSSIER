// WASM-Bindung des Imports (`import.rs`): Bytes rein, flacher Puffer + String-Tabelle raus.
// TS-Seite: `src/io/fileioImport.ts` (Dekodierung), `dxfParser.ts`/`dwgParser.ts` (Fassaden).
// Kaputte Dateien → JS-Fehler mit Meldung (kein Panic).

use wasm_bindgen::prelude::*;

/// Ergebnis eines Imports; `geom()`/`strings()` holen die Daten (je einmal, danach leer).
#[wasm_bindgen]
pub struct ImportedDrawing {
    geom: Vec<f64>,
    strings: Vec<String>,
}

#[wasm_bindgen]
impl ImportedDrawing {
    /// Flacher Puffer, Aufbau s. `import::encode`.
    pub fn geom(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.geom)
    }
    /// String-Tabelle (Ebenen, Texte, Entity-Typen), per Index aus `geom` referenziert.
    pub fn strings(&mut self) -> Vec<String> {
        std::mem::take(&mut self.strings)
    }
}

/// DXF (ASCII/Binär) oder DWG lesen und abbilden.
#[wasm_bindgen]
pub fn import_drawing(bytes: Vec<u8>) -> Result<ImportedDrawing, JsValue> {
    let data = crate::import::import_owned(bytes).map_err(|e| JsValue::from_str(&e))?;
    let (geom, strings) = crate::import::encode(&data);
    Ok(ImportedDrawing { geom, strings })
}

/// Schnittstellen für das parallele Lesen einer grossen ASCII-DXF (`split::split_offsets`):
/// `[entitiesStart, …, entitiesEnd]` als Byte-Offsets; leer = nicht teilen.
#[wasm_bindgen]
pub fn dxf_split_offsets(bytes: &[u8], chunk_count: u32) -> Vec<f64> {
    crate::split::split_offsets(bytes, chunk_count as usize)
        .map(|v| v.into_iter().map(|o| o as f64).collect())
        .unwrap_or_default()
}
