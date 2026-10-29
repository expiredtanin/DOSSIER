//! Bindung des Druck-SVG (`crate::plan_print_svg`) auf gehaltenen Plan-Puffern (Abschnitte wie
//! `plan_parts`). Ergebnis `"1"` + Anweisungsliste; leer = Puffer fehlt (TS legt neu ab und fragt
//! nochmals) oder kaputte Eingabe — nie Panic.

use crate::plan_parts::parts_from;
use crate::plan_print_svg::{print_svg_ops, PrintOptions};
use wasm_bindgen::prelude::wasm_bindgen;

/// `opts` = `[Massstab-Nenner, Blattbreite mm, Blatthöhe mm, minX, minY, maxX, maxY]`.
#[wasm_bindgen]
pub fn plan_print_svg_ops(segs: &[f64], opts: &[f64]) -> String {
    let Ok([n, w, h, min_x, min_y, max_x, max_y]) = <[f64; 7]>::try_from(opts) else { return String::new() };
    let Some(held) = super::plan_buf::held_for_segs(segs) else { return String::new() };
    let Some(mut parts) = parts_from(segs, |nr| held.iter().find(|e| e.0 == nr).map(|e| &*e.1)) else { return String::new() };
    let o = PrintOptions { scale_denominator: n, page_w: w, page_h: h, bounds: [min_x, min_y, max_x, max_y] };
    match print_svg_ops(&mut parts, &o) {
        Some(s) => format!("1{s}"),
        None => String::new(),
    }
}
