//! Bindungen der Render-Szene (`crate::plan_scene`) auf gehaltenen Plan-Puffern. Abschnitte als
//! `[Puffer-Nr, von, bis, …]`, gedimmte Bereiche als `[von, bis, …]` (s. `plan_parts`). Fehlt
//! ein Puffer (verdrängt) oder ist eine Eingabe kaputt, ist das Ergebnis leer — TS legt die
//! Puffer dann neu ab und fragt nochmals.

use crate::plan_parts::{parts_from, ranges_from};
use crate::plan_scene::{build_scene, encode_scene_bin, encode_scene_f64, texts_from, Scene};
use wasm_bindgen::prelude::wasm_bindgen;

fn scene_of(segs: &[f64], greyed: &[f64]) -> Option<Scene> {
    let held = super::plan_buf::held_for_segs(segs)?;
    let mut parts = parts_from(segs, |nr| held.iter().find(|e| e.0 == nr).map(|e| &*e.1))?;
    build_scene(&mut parts, &ranges_from(greyed)?)
}

/// render2d-Szene v1 (Bytes für `set_scene_bin`/`push_native_scene`); Texte fertig gesetzt aus
/// TS: `[x, y, sizeMm, r, g, b, a, align, nBytes]*` + UTF-8-Bytes. Leer = Fehler.
#[wasm_bindgen]
pub fn plan_scene_bin(segs: &[f64], greyed: &[f64], text_nums: &[f64], text_bytes: &[u8]) -> Vec<u8> {
    let Some(texts) = texts_from(text_nums, text_bytes) else { return Vec::new() };
    match scene_of(segs, greyed) {
        Some(s) => encode_scene_bin(&s, &texts),
        None => Vec::new(),
    }
}

/// Verlustfreie Szene (Format s. `plan_scene`) für Export und `--format json`. Leer = Fehler.
#[wasm_bindgen]
pub fn plan_scene_f64(segs: &[f64], greyed: &[f64]) -> Vec<f64> {
    match scene_of(segs, greyed) {
        Some(s) => encode_scene_f64(&s),
        None => Vec::new(),
    }
}
