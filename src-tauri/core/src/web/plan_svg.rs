//! Bindung des SVG-Text-Exports (`crate::plan_svg`) auf gehaltenen Plan-Puffern (Abschnitte wie
//! `plan_parts`). Leerer Text = Puffer fehlt oder kaputt (TS legt neu ab und fragt nochmals).

use crate::plan_parts::parts_from;
use crate::plan_svg::{plan_svg, SvgOptions};
use wasm_bindgen::prelude::wasm_bindgen;

/// `opts` = `[Massstab-Nenner, Rand m, minX, minY, maxX, maxY]`.
#[wasm_bindgen]
pub fn plan_svg_string(segs: &[f64], opts: &[f64]) -> String {
    let [n, margin, min_x, min_y, max_x, max_y] = match <[f64; 6]>::try_from(opts) {
        Ok(a) => a,
        Err(_) => return String::new(),
    };
    let Some(held) = super::plan_buf::held_for_segs(segs) else { return String::new() };
    let Some(mut parts) = parts_from(segs, |nr| held.iter().find(|e| e.0 == nr).map(|e| &*e.1)) else { return String::new() };
    plan_svg(&mut parts, &SvgOptions { scale_denominator: n, margin_m: margin, min_x, min_y, max_x, max_y }).unwrap_or_default()
}
