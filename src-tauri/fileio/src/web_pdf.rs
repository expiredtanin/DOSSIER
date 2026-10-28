// WASM-Bindung des Vektor-PDF-Lesers (`pdf_vector.rs`, [76]): Bytes rein, flacher Puffer + String-
// Tabelle raus. TS-Seite: `src/io/pdfVector.ts`. Kaputte/verschlüsselte Dateien → JS-Fehler mit
// Meldung (kein Panic).

use wasm_bindgen::prelude::*;

/// Ergebnis einer Seite; `geom()`/`strings()` holen die Daten (je einmal, danach leer).
#[wasm_bindgen]
pub struct PdfVectorPage {
    geom: Vec<f64>,
    strings: Vec<String>,
}

#[wasm_bindgen]
impl PdfVectorPage {
    /// Flacher Puffer, Aufbau s. `pdf_vector::encode`.
    pub fn geom(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.geom)
    }
    /// String-Tabelle (Texte, Schriftnamen), per Index aus `geom` referenziert.
    pub fn strings(&mut self) -> Vec<String> {
        std::mem::take(&mut self.strings)
    }
}

/// Seite `page` (0-basiert) eines PDF lesen: Pfade (pt) und Texte.
#[wasm_bindgen]
pub fn pdf_read_page(bytes: Vec<u8>, page: u32) -> Result<PdfVectorPage, JsValue> {
    let p = crate::pdf_vector::read_pdf_page(bytes, page as usize).map_err(|e| JsValue::from_str(&e))?;
    let (geom, strings) = crate::pdf_vector::encode(&p);
    Ok(PdfVectorPage { geom, strings })
}

/// Seitenzahl eines PDF.
#[wasm_bindgen]
pub fn pdf_page_count(bytes: Vec<u8>) -> Result<u32, JsValue> {
    crate::pdf_vector::pdf_page_count(bytes).map_err(|e| JsValue::from_str(&e))
}
