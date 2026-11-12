//! Bindungen der Render-Szene (`crate::plan::scene`) auf gehaltenen Plan-Puffern. Abschnitte als
//! `[Puffer-Nr, von, bis, …]`, gedimmte Bereiche als `[von, bis, …]` (s. `plan_parts`). Fehlt
//! ein Puffer (verdrängt) oder ist eine Eingabe kaputt, ist das Ergebnis leer — TS legt die
//! Puffer dann neu ab und fragt nochmals.

use crate::plan::parts::{parts_from, ranges_from};
use crate::plan::scene::SText;
use crate::plan::text::{scene_texts, ScreenTexts};
use crate::plan::scene::{build_scene, encode_scene_bin, encode_scene_f64, Scene};
use crate::plan::line_ends::LineEnds;
use wasm_bindgen::prelude::wasm_bindgen;

fn scene_of(segs: &[f64], greyed: &[f64]) -> Option<Scene> {
    let held = super::plan_buf::held_for_segs(segs)?;
    let mut parts = parts_from(segs, |nr| held.iter().find(|e| e.0 == nr).map(|e| &*e.1))?;
    build_scene(&mut parts, &ranges_from(greyed)?)
}

/// Gesetzte Textzeilen des Plans (`plan_text::scene_texts`) beim Massstab 1:`paper_scale_n`.
/// `screen`: Auswahl der Bildschirm-Szene (ohne gedrehte Einzeltexte, [194]); `None` = alle (Exporte).
fn texts_of(segs: &[f64], greyed: &[f64], paper_scale_n: f64, screen: Option<ScreenTexts>) -> Option<Vec<SText>> {
    let held = super::plan_buf::held_for_segs(segs)?;
    let mut parts = parts_from(segs, |nr| held.iter().find(|e| e.0 == nr).map(|e| &*e.1))?;
    scene_texts(&mut parts, &ranges_from(greyed)?, paper_scale_n, screen)
}

/// Textzeilen als `[n, (x, y, sizeMm, r, g, b, a, code, nUtf16)*, UTF-16-Einheiten…]`; `code` =
/// Ausrichtung (unteres Byte) | Schnitt << 8, nur mit `style`.
fn texts_f64(texts: &[SText], style: bool) -> Vec<f64> {
    let mut out = Vec::with_capacity(1 + texts.len() * 12);
    out.push(texts.len() as f64);
    let mut units: Vec<f64> = Vec::new();
    for t in texts {
        let s = String::from_utf8_lossy(&t.content);
        let n0 = units.len();
        units.extend(s.encode_utf16().map(f64::from));
        let code = if style { t.align | (t.style << 8) } else { t.align };
        out.extend_from_slice(&[t.pos.x, t.pos.y, t.size_mm, t.color[0], t.color[1], t.color[2], t.color[3], code as f64, (units.len() - n0) as f64]);
    }
    out.extend(units);
    out
}

/// render2d-Szene v1 (Bytes für `set_scene_bin`/`push_native_scene`) samt Texten, gesetzt beim
/// Massstab 1:`paper_scale_n` (die Abschnitte tragen das Text-JSON). `line_ends` = Linienenden
/// und -ecken `cap | join << 2` ([146]). Leer = Fehler.
#[wasm_bindgen]
pub fn plan_scene_bin(segs: &[f64], greyed: &[f64], paper_scale_n: f64, line_ends: u32) -> Vec<u8> {
    // Bildschirm-Szene (Browser): gedrehte Einzeltexte zeichnet das SVG-Overlay ([194]).
    let Some(texts) = texts_of(segs, greyed, paper_scale_n, Some(ScreenTexts::default())) else { return Vec::new() };
    match scene_of(segs, greyed) {
        Some(mut s) => {
            s.line_ends = LineEnds::from_code(line_ends as f64).code();
            encode_scene_bin(&s, &texts)
        }
        None => Vec::new(),
    }
}

/// Textzeilen der Szene für Export/`--format json`: `[n, (x, y, sizeMm, r, g, b, a, align,
/// nUtf16)*, UTF-16-Einheiten…]`. Leer = Fehler.
#[wasm_bindgen]
pub fn plan_scene_texts(segs: &[f64], greyed: &[f64], paper_scale_n: f64) -> Vec<f64> {
    match texts_of(segs, greyed, paper_scale_n, None) {
        Some(texts) => texts_f64(&texts, false),
        None => Vec::new(),
    }
}

/// Textzeilen der BILDSCHIRM-Szene für die native Fläche ([194], `native2d_scene_texts`): Format wie
/// `plan_scene_texts`, Kennung = Ausrichtung | Schnitt << 8 (Bit 0 fett, Bit 1 kursiv); ohne gedrehte
/// Einzeltexte und ohne den Eintrag mit Plan-Index `skip` (Text im Editor; < 0 = keiner). Leer = Fehler.
#[wasm_bindgen]
pub fn plan_screen_texts(segs: &[f64], greyed: &[f64], paper_scale_n: f64, skip: f64) -> Vec<f64> {
    let skip = (skip.is_finite() && skip >= 0.0).then_some(skip as usize);
    match texts_of(segs, greyed, paper_scale_n, Some(ScreenTexts { skip })) {
        Some(texts) => texts_f64(&texts, true),
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
