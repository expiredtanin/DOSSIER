//! Bindung des DXF-Sammlers (`crate::plan_dxf`) auf gehaltenen Plan-Puffern (Abschnitte wie
//! `plan_parts`) und dem Projekt-Dokument. Leeres Ergebnis = Puffer fehlt (TS legt neu ab und
//! fragt nochmals), Dokument nicht offen/unpassend oder kaputte Eingabe — nie Panic.

use crate::plan_dxf::{collect, encode, texts_from, DxfOptions};
use crate::plan_parts::parts_from;
use wasm_bindgen::prelude::wasm_bindgen;

/// Flache Zeichnung (Format `plan_dxf::encode`). `opts` = `[Massstab, Schraffuren 0/1, cm 0/1,
/// Papierbereich 0/1, minX, minY, maxX, maxY]`; `text_nums`/`text_strs` = Text-Eingabe
/// (`plan_dxf::texts_from`, Texte je mit `\0` davor); `default_font` = Standard-Schrift.
#[wasm_bindgen]
pub fn plan_dxf_flat(doc: u32, segs: &[f64], text_nums: &[f64], text_strs: &str, opts: &[f64], default_font: &str) -> Vec<u8> {
    let Ok([scale, hatches, cm, layout, min_x, min_y, max_x, max_y]) = <[f64; 8]>::try_from(opts) else { return Vec::new() };
    if !(scale.is_finite() && scale > 0.0) {
        return Vec::new();
    }
    let strs: Vec<&str> = text_strs.split('\0').skip(1).collect();
    let Some(texts) = texts_from(text_nums, &strs) else { return Vec::new() };
    let Some(held) = super::plan_buf::held_for_segs(segs) else { return Vec::new() };
    let Some(mut parts) = parts_from(segs, |nr| held.iter().find(|e| e.0 == nr).map(|e| &*e.1)) else { return Vec::new() };
    let o = DxfOptions {
        scale,
        include_hatches: hatches != 0.0,
        dim_cm: cm != 0.0,
        paper_layout: layout != 0.0,
        bounds: [min_x, min_y, max_x, max_y],
        default_font: default_font.to_string(),
    };
    super::document::with_doc(doc, |d| {
        let p = d.project().ok()?;
        collect(&mut parts, &texts, p, &o).map(|f| encode(&f))
    })
    .flatten()
    .unwrap_or_default()
}
