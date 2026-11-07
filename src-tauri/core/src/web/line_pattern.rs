//! Bindung der Linientypen ([153], `crate::plan::line_pattern`): Musterphase für die TS-Ausgaben
//! (PDF-Druck-SVG `sceneToPrintSvg.ts`), gleiche Rechnung wie Plan-SVG, Druck-SVG und Strich-Shader.

use wasm_bindgen::prelude::wasm_bindgen;

/// Musterphase (Papier-mm) eines gestrichelten Zugs der Länge `len_mm` mit Muster `dash_mm` (Papier-mm)
/// für `stroke-dashoffset`; 0 bei leerem/ungültigem Muster oder Unsinn — nie Panic.
#[wasm_bindgen]
pub fn line_dash_phase(len_mm: f64, dash_mm: &[f64]) -> f64 {
    let p = crate::plan::line_pattern::phase(len_mm, dash_mm);
    if p.is_finite() {
        p
    } else {
        0.0
    }
}
