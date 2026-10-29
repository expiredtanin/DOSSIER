//! Bindungen der Render-Szene (`crate::plan_scene`) auf gehaltenen Plan-Puffern. Abschnitte als
//! `[Puffer-Nr, von, bis, …]`, gedimmte Bereiche als `[von, bis, …]` (s. `plan_parts`). Fehlt
//! ein Puffer (verdrängt) oder ist eine Eingabe kaputt, ist das Ergebnis leer — TS legt die
//! Puffer dann neu ab und fragt nochmals.

use crate::plan_parts::{parts_from, ranges_from};
use crate::plan_scene::SText;
use crate::plan_text::scene_texts;
use crate::plan_scene::{build_scene, encode_scene_bin, encode_scene_f64, Scene};
use wasm_bindgen::prelude::wasm_bindgen;

fn scene_of(segs: &[f64], greyed: &[f64]) -> Option<Scene> {
    let held = super::plan_buf::held_for_segs(segs)?;
    let mut parts = parts_from(segs, |nr| held.iter().find(|e| e.0 == nr).map(|e| &*e.1))?;
    build_scene(&mut parts, &ranges_from(greyed)?)
}

/// Gesetzte Textzeilen des Plans (`plan_text::scene_texts`) beim Massstab 1:`paper_scale_n`.
fn texts_of(segs: &[f64], greyed: &[f64], paper_scale_n: f64) -> Option<Vec<SText>> {
    let held = super::plan_buf::held_for_segs(segs)?;
    let mut parts = parts_from(segs, |nr| held.iter().find(|e| e.0 == nr).map(|e| &*e.1))?;
    scene_texts(&mut parts, &ranges_from(greyed)?, paper_scale_n)
}

/// render2d-Szene v1 (Bytes für `set_scene_bin`/`push_native_scene`) samt Texten, gesetzt beim
/// Massstab 1:`paper_scale_n` (die Abschnitte tragen das Text-JSON). Leer = Fehler.
#[wasm_bindgen]
pub fn plan_scene_bin(segs: &[f64], greyed: &[f64], paper_scale_n: f64) -> Vec<u8> {
    let Some(texts) = texts_of(segs, greyed, paper_scale_n) else { return Vec::new() };
    match scene_of(segs, greyed) {
        Some(s) => encode_scene_bin(&s, &texts),
        None => Vec::new(),
    }
}

/// Textzeilen der Szene für Export/`--format json`: `[n, (x, y, sizeMm, r, g, b, a, align,
/// nUtf16)*, UTF-16-Einheiten…]`. Leer = Fehler.
#[wasm_bindgen]
pub fn plan_scene_texts(segs: &[f64], greyed: &[f64], paper_scale_n: f64) -> Vec<f64> {
    let Some(texts) = texts_of(segs, greyed, paper_scale_n) else { return Vec::new() };
    let mut out = Vec::with_capacity(1 + texts.len() * 12);
    out.push(texts.len() as f64);
    let mut units: Vec<f64> = Vec::new();
    for t in &texts {
        let s = String::from_utf8_lossy(&t.content);
        let n0 = units.len();
        units.extend(s.encode_utf16().map(f64::from));
        out.extend_from_slice(&[t.pos.x, t.pos.y, t.size_mm, t.color[0], t.color[1], t.color[2], t.color[3], t.align as f64, (units.len() - n0) as f64]);
    }
    out.extend(units);
    out
}

/// Verlustfreie Szene (Format s. `plan_scene`) für Export und `--format json`. Leer = Fehler.
#[wasm_bindgen]
pub fn plan_scene_f64(segs: &[f64], greyed: &[f64]) -> Vec<f64> {
    match scene_of(segs, greyed) {
        Some(s) => encode_scene_f64(&s),
        None => Vec::new(),
    }
}
