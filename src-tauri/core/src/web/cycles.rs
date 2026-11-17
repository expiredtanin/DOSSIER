//! Bindung der Cycles-Nachbearbeitung ([215], `crate::cycles_post`): lineares Fliesskomma-Bild → sRGB 8 Bit.

use crate::cycles_post::{tonemap, Look};
use wasm_bindgen::prelude::wasm_bindgen;

/// `data`: RGB oder RGBA (`channels` 3/4), zeilenweise von oben, lineares Licht; `ev`: Zusatzbelichtung in Blenden;
/// `look`: "filmic" (Standard) oder "standard". Ergebnis: RGB 8 Bit; leer bei kaputtem Puffer.
#[wasm_bindgen]
pub fn cycles_tonemap(data: &[f32], channels: u32, ev: f64, look: &str) -> Vec<u8> {
    tonemap(data, channels as usize, ev, Look::parse(look))
}
