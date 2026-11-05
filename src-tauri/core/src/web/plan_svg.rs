//! Bindung des SVG-Text-Exports (`crate::plan::svg`) auf gehaltenen Plan-Puffern (Abschnitte wie
//! `plan_parts`). Leerer Text = Puffer fehlt oder kaputt (TS legt neu ab und fragt nochmals).

use crate::plan::parts::parts_from;
use crate::plan::svg::{plan_svg, SvgOptions};
use wasm_bindgen::prelude::wasm_bindgen;

/// `opts` = `[Massstab-Nenner, Rand m, minX, minY, maxX, maxY, (Schraffur 0/1)]`.
#[wasm_bindgen]
pub fn plan_svg_string(segs: &[f64], opts: &[f64]) -> String {
    let hatch = opts.len() == 7 && opts[6] != 0.0;
    let [n, margin, min_x, min_y, max_x, max_y] = match <[f64; 6]>::try_from(&opts[..opts.len().min(6)]) {
        Ok(a) => a,
        Err(_) => return String::new(),
    };
    let Some(held) = super::plan_buf::held_for_segs(segs) else { return String::new() };
    let Some(mut parts) = parts_from(segs, |nr| held.iter().find(|e| e.0 == nr).map(|e| &*e.1)) else { return String::new() };
    plan_svg(&mut parts, &SvgOptions { scale_denominator: n, margin_m: margin, min_x, min_y, max_x, max_y, hatch }).unwrap_or_default()
}
