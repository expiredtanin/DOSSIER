//! Bindungen des Text-Layouts (`crate::text_layout`) für die TS-Fassade `src/text/renderHtml.ts`
//! (`docToLines`/`wrapDocToLines`, Raumstempel-Block, einfacher Umbruch) und `src/text/textFrame.ts`.
//! Das Dokument reist als JSON (Text, keine Geometrie); kaputte Eingaben ergeben ein leeres
//! Ergebnis — nie Panic.
//!
//! Zeilen kommen flach zurück (`encode_lines`): `[nZeilen, nStile, Stil*, Zeile*]`;
//! Stil = `[Grösse, Bits, Versatz, nFarbe, nSchrift (−1 = keine), Farbe…, Schrift…]` (Bits: 1 fett,
//! 2 kursiv, 4 unterstrichen, 8 durchgestrichen, 16 mit Versatz; Texte als UTF-16-Einheiten);
//! Zeile = `[Ausrichtung 0/1/2, Vorschub, x, Grundlinie y, nTspans, (Stil, Absatz, Run, von, bis)*]`
//! (Lage aus [`place_lines`] bzw. dem Raumstempel-Block — die Verbraucher rechnen keine Lage mehr)
//! — der Text eines Tspans ist `runs[Run].text.slice(von, bis)` des Absatzes in der Eingabe (TS hat
//! sie schon; keine Texte über die Grenze zurück).

use crate::model::RichTextDoc;
use crate::text_layout::{layout_refs, place_lines, tspan_of, stamp_block_refs, stamp_extra_tspan, text_frame_corners, wrap_plain, LayoutOpts, LineAlign, LineRef, Tok, Tspan};
use wasm_bindgen::prelude::wasm_bindgen;

fn style_bits(t: &Tspan) -> f64 {
    let deco = match t.text_decoration {
        Some("underline") => 4,
        Some("line-through") => 8,
        Some(_) => 12,
        None => 0,
    };
    (t.bold as u32 | (t.italic as u32) << 1 | deco | (t.baseline_shift.is_some() as u32) << 4) as f64
}

/// Verweis-Zeilen flach (Format s. Modulkopf); `style(tok)` = Stil (Tspan ohne Text) des Stücks,
/// `at` = (x, Grundlinie) je Zeile.
fn encode_lines(lines: &[LineRef], at: &[(f64, f64)], style: impl Fn(&Tok) -> Tspan) -> Vec<f64> {
    let mut styles: Vec<Tspan> = Vec::new();
    let mut keys: Vec<(usize, usize)> = Vec::new();
    let mut key_style: Vec<usize> = Vec::new();
    let mut body: Vec<f64> = Vec::new();
    for (k, l) in lines.iter().enumerate() {
        let (x, y) = at.get(k).copied().unwrap_or((f64::NAN, f64::NAN));
        body.extend_from_slice(&[l.align.code() as f64, l.line_height, x, y, l.toks.len() as f64]);
        for t in &l.toks {
            let si = match keys.iter().position(|q| *q == (t.para, t.run)) {
                Some(i) => key_style[i],
                None => {
                    let st = style(t);
                    let same = |u: &Tspan| {
                        u.font_size.to_bits() == st.font_size.to_bits()
                            && style_bits(u) == style_bits(&st)
                            && u.baseline_shift.map(f64::to_bits) == st.baseline_shift.map(f64::to_bits)
                            && u.fill == st.fill
                            && u.font_family == st.font_family
                    };
                    let si = match styles.iter().position(same) {
                        Some(i) => i,
                        None => {
                            styles.push(st);
                            styles.len() - 1
                        }
                    };
                    keys.push((t.para, t.run));
                    key_style.push(si);
                    si
                }
            };
            body.extend_from_slice(&[si as f64, t.para as f64, t.run as f64, t.u0 as f64, t.u1 as f64]);
        }
    }
    let mut out = vec![lines.len() as f64, styles.len() as f64];
    for t in &styles {
        out.extend_from_slice(&[t.font_size, style_bits(t), t.baseline_shift.unwrap_or(0.0), t.fill.encode_utf16().count() as f64]);
        out.push(t.font_family.as_ref().map_or(-1.0, |f| f.encode_utf16().count() as f64));
        out.extend(t.fill.encode_utf16().map(f64::from));
        if let Some(f) = &t.font_family {
            out.extend(f.encode_utf16().map(f64::from));
        }
    }
    out.extend(body);
    out
}

/// Gesetzte Zeilen eines Dokuments (`PlacedLine[]`, flach). `opts` = `[lineHeight, unitPerPt,
/// basePt gesetzt 0/1, basePt, Umbruchbreite, x, y, Spaltenbreite]` (Umbruch ≤ 0/NaN = keiner;
/// Spalte 0/NaN = keine, sonst Mitte/rechts darin, s. [`place_lines`]); `color` fehlt → `#000000`.
/// Leer = kaputte Eingabe.
#[wasm_bindgen]
pub fn text_lines(doc_json: &str, opts: &[f64], color: Option<String>) -> Vec<f64> {
    let Ok([line_height, unit_per_pt, has_base, base_pt, wrap, x, y, col]) = <[f64; 8]>::try_from(opts) else { return Vec::new() };
    let Ok(doc) = serde_json::from_str::<RichTextDoc>(doc_json) else { return Vec::new() };
    let o = LayoutOpts { line_height, unit_per_pt, base_pt: if has_base != 0.0 { base_pt } else { 12.0 }, color: color.as_deref().unwrap_or("#000000") };
    let refs = layout_refs(&doc, &o, Some(wrap));
    let at = place_lines(refs.iter().map(|l| (l.align, l.line_height)), x, y, Some(col));
    encode_lines(&refs, &at, |t| tspan_of(String::new(), &doc.paragraphs[t.para].runs[t.run].marks, o.base_pt, o.unit_per_pt, o.color))
}

/// Rahmen eines Einzeltexts: `opts` = `[atX, atY, heightM, angle, Spaltenbreite (NaN = keine),
/// Grundlinie→Oberkante]` → `[x0, y0, …, x3, y3]` (Reihenfolge s. `text_frame_corners`). Leer =
/// kaputte Eingabe.
#[wasm_bindgen]
pub fn text_frame(doc_json: &str, opts: &[f64]) -> Vec<f64> {
    let Ok([x, y, height_m, angle, wrap, baseline]) = <[f64; 6]>::try_from(opts) else { return Vec::new() };
    let Ok(doc) = serde_json::from_str::<RichTextDoc>(doc_json) else { return Vec::new() };
    text_frame_corners(&doc, (x, y), height_m, angle, Some(wrap), baseline).iter().flat_map(|c| [c.0, c.1]).collect()
}

/// Raumstempel-Block der Plan-Ansicht (`stamp_block_refs`): `prim_json` = das Primitiv `text`;
/// Zeilen flach mit x = `x0` und Grundlinie `y` (um `y0` zentriert, `y` nach unten; Live-Zeile `i`
/// als Absatz Absatzzahl + `i`). Leer = kaputte Eingabe.
#[wasm_bindgen]
pub fn text_stamp_block(prim_json: &str, unit_per_pt: f64, x0: f64, y0: f64) -> Vec<f64> {
    let Ok(p) = serde_json::from_str::<crate::plan_text::StampText>(prim_json) else { return Vec::new() };
    let extra: Vec<(&str, LineAlign)> = p.extra_lines.iter().map(|l| (l.text.as_str(), LineAlign::of(Some(l.align)))).collect();
    let color = p.color.as_deref().unwrap_or("#000000");
    let placed = stamp_block_refs(&p.doc, &extra, p.base_pt, unit_per_pt, color, y0);
    let at: Vec<(f64, f64)> = placed.iter().map(|q| (x0, q.1)).collect();
    let lines: Vec<LineRef> = placed.into_iter().map(|q| q.0).collect();
    let n = p.doc.paragraphs.len();
    encode_lines(&lines, &at, |t| {
        if t.para >= n {
            stamp_extra_tspan(String::new(), p.base_pt, unit_per_pt, color)
        } else {
            tspan_of(String::new(), &p.doc.paragraphs[t.para].runs[t.run].marks, p.base_pt, unit_per_pt, color)
        }
    })
}

/// Einfacher Text auf die Spalte `wrap` umbrochen (Schriftgrösse `font_size`, gleiche Einheiten),
/// Zeilen als JSON-Liste.
#[wasm_bindgen]
pub fn text_wrap_plain(text: &str, wrap: f64, font_size: f64) -> String {
    serde_json::to_string(&wrap_plain(text, wrap, font_size)).unwrap_or_default()
}
