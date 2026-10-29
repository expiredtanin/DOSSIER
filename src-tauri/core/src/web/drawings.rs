//! Bindungen der 2D-Zeichnungen im Grundriss (`crate::plan::drawings`). Die Plan-Primitive selbst
//! kommen über die Dokument-Abfragen (`planDomains`, `drawingPrims`, `drawingLines`).

use wasm_bindgen::prelude::wasm_bindgen;

/// Lage der Masszahl eines Mass-Segments `[baseX, baseY, readX, readY, upX, upY, angle]`
/// (`dimTextFrame`, geteilt von Plan und Masszahl-Griff); leer bei NaN/∞.
#[wasm_bindgen]
pub fn dim_text_frame(ax: f64, ay: f64, bx: f64, by: f64, offset: f64, text_height: f64) -> Vec<f64> {
    if ![ax, ay, bx, by, offset, text_height].iter().all(|v| v.is_finite()) {
        return Vec::new();
    }
    let v = |x, y| crate::model::Vec2 { x, y };
    let (base, read, up, angle) = crate::plan::drawings::dim_text_frame(v(ax, ay), v(bx, by), offset, text_height);
    vec![base.x, base.y, read.x, read.y, up.x, up.y, angle]
}
