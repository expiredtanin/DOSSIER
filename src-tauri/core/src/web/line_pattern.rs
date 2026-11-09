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

/// [169] SVG-Pfad (`d`) eines Zugs in Papier-mm (`[x0, y0, x1, y1, …]`, Y nach unten) mit erkannten Bögen
/// (`crate::plan::arc_fit`): Kreis bzw. Strecken und `A`-Befehle; leer, wenn kein Bogen erkannt wurde oder
/// die Eingabe Unsinn ist (dann bleibt `polygon`/`polyline`). `tol` = Toleranz in mm.
#[wasm_bindgen]
pub fn plan_arc_path_d(pts_mm: &[f64], closed: bool, tol: f64) -> String {
    use crate::hatch::V2;
    use crate::plan::arc_fit;
    if pts_mm.len() < 8 || pts_mm.len() % 2 != 0 || !(tol > 0.0) || !tol.is_finite() {
        return String::new();
    }
    let pts: Vec<V2> = pts_mm.chunks_exact(2).map(|c| V2 { x: c[0], y: c[1] }).collect();
    let fmt = |v: f64| crate::js_fmt::js_number(crate::jsnum::round(v * 1000.0) / 1000.0);
    match arc_fit::fit(&pts, closed, tol) {
        Some(sh) => arc_fit::svg_d_with(&sh, &|p| p, 1.0, &fmt, true),
        None => String::new(),
    }
}
