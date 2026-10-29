//! Text-Layout ([K3d]/[K4], früher `src/text/renderHtml.ts` `docToLines`/`wrapDocToLines`/`runToTspan`
//! und `src/text/textFrame.ts`): Rich-Text-Dokument → Zeilen mit Tspans (Grössen schon in
//! Benutzereinheiten), Wortumbruch auf eine Spaltenbreite, geschätzter Text-Rahmen. Grundlage der
//! Text-Verbraucher im Kern (Render-Szene, Druck-SVG, DXF; `plan_text.rs`) und — über die Bindung
//! `text_lines` — der TS-Fassade für Editor-Vorschau, Layout-Blatt und SVG-Rückfall.
//!
//! Glyphen-Metrik: es gibt keine. Wie die TS-Fassung schätzt der Umbruch die Breite eines Wortes
//! als `UTF-16-Länge × Schriftgrösse × 0.55` (keine Schriftdatei, kein Canvas-Messen) — damit ist
//! das Ergebnis bitgleich zur TS-Fassung und unabhängig von installierten Schriften.
//!
//! JS-Semantik, wo sie das Ergebnis bestimmt: Leerraum wie `\s` (WhiteSpace + LineTerminator, s.
//! [`js_space`]), Längen in UTF-16-Einheiten (`String.length`), Rundung `Math.round(n·1000)/1000`,
//! `Math.max` mit NaN.

use crate::jsnum;
use crate::model::{Align, Marks, Paragraph, RichTextDoc, TextRun};
pub use crate::plan::overrides::{js_space, js_trim};
use serde::Serialize;

/// Faktor, um den Hoch-/Tiefstellung verkleinert wird.
pub const SCRIPT_SCALE: f64 = 0.7;
/// Geschätzte Zeichenbreite als Vielfaches der Schriftgrösse (Umbruch, Text-Rahmen).
pub const CHAR_WIDTH_FACTOR: f64 = 0.55;
/// Zeilenabstand gezeichneter Einzeltexte (Vielfaches der Höhe), `TEXT_LINE_HEIGHT_MULT`.
pub const TEXT_LINE_HEIGHT_MULT: f64 = 1.25;
/// 1 pt in Papier-mm.
pub const PT_TO_MM: f64 = 25.4 / 72.0;

/// Ausrichtung einer Zeile. Unbekannte Werte (`Align::Unknown`) gelten wie fehlende als links —
/// alle Verbraucher behandelten sie schon in TS wie links.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineAlign {
    Left,
    Center,
    Right,
}

impl LineAlign {
    pub fn of(a: Option<Align>) -> LineAlign {
        match a {
            Some(Align::Center) => LineAlign::Center,
            Some(Align::Right) => LineAlign::Right,
            _ => LineAlign::Left,
        }
    }
    /// 0 links · 1 Mitte · 2 rechts (render2d, DXF).
    pub fn code(self) -> u32 {
        match self {
            LineAlign::Left => 0,
            LineAlign::Center => 1,
            LineAlign::Right => 2,
        }
    }
}

/// Ein Tspan (ein Run bzw. ein Wort innerhalb einer Zeile), Feldreihenfolge wie `SvgTspan` in TS.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tspan {
    pub text: String,
    /// Schriftgrösse in Benutzereinheiten (auf 1/1000 gerundet).
    pub font_size: f64,
    pub fill: String,
    #[serde(rename = "fontWeight", skip_serializing_if = "std::ops::Not::not", serialize_with = "ser_weight")]
    pub bold: bool,
    #[serde(rename = "fontStyle", skip_serializing_if = "std::ops::Not::not", serialize_with = "ser_style")]
    pub italic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_decoration: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline_shift: Option<f64>,
}

fn ser_weight<S: serde::Serializer>(_: &bool, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str("700")
}
fn ser_style<S: serde::Serializer>(_: &bool, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str("italic")
}

impl Tspan {
    /// `fontWeight` (`"700"` oder keins), wie das SVG-Attribut.
    pub fn font_weight(&self) -> Option<&'static str> {
        self.bold.then_some("700")
    }
    pub fn font_style(&self) -> Option<&'static str> {
        self.italic.then_some("italic")
    }
}

/// Eine Zeile (Absatz bzw. umbrochene Teilzeile).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub tspans: Vec<Tspan>,
    pub align: LineAlign,
    /// Vorschub zu dieser Zeile (Benutzereinheiten).
    pub line_height: f64,
}

impl Line {
    /// Inhalt der Zeile (Runs verkettet).
    pub fn content(&self) -> String {
        self.tspans.iter().map(|t| t.text.as_str()).collect()
    }
    /// Grösste Schrift der Zeile (`Math.max(...fontSize)`), `None` ohne Tspans.
    pub fn max_size(&self) -> Option<f64> {
        if self.tspans.is_empty() {
            None
        } else {
            Some(self.tspans.iter().fold(f64::NEG_INFINITY, |m, t| jsnum::max(m, t.font_size)))
        }
    }
}

/// Optionen wie `SvgTextOptions` (ohne Anker, den setzt der Aufrufer).
#[derive(Clone, Copy, Debug)]
pub struct LayoutOpts<'a> {
    /// Vorschub für Absätze ohne eigene `lineHeight`.
    pub line_height: f64,
    /// `sizePt × unitPerPt` = Grösse in Benutzereinheiten.
    pub unit_per_pt: f64,
    /// Basisgrösse (pt) für Runs ohne eigene Grösse (TS: `basePt ?? 12`).
    pub base_pt: f64,
    /// Standardfarbe (TS: `color ?? "#000000"`).
    pub color: &'a str,
}

/// `Math.round(n * 1000) / 1000`.
pub fn round3(n: f64) -> f64 {
    jsnum::round(n * 1000.0) / 1000.0
}

/// Länge in UTF-16-Einheiten (`String.length`).
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `!s.trim()`: leer oder nur Leerraum.
pub fn is_blank(s: &str) -> bool {
    js_trim(s).is_empty()
}

/// `runToTspan`.
pub fn run_to_tspan(run: &TextRun, base_pt: f64, unit_per_pt: f64, color: &str) -> Tspan {
    tspan_of(run.text.clone(), &run.marks, base_pt, unit_per_pt, color)
}

pub fn tspan_of(text: String, m: &Marks, base_pt: f64, unit_per_pt: f64, color: &str) -> Tspan {
    let sup = m.super_ == Some(true);
    let sub = m.sub == Some(true);
    let size_pt = m.size_pt.unwrap_or(base_pt) * if sup || sub { SCRIPT_SCALE } else { 1.0 };
    let font_size = size_pt * unit_per_pt;
    let deco = match (m.underline == Some(true), m.strike == Some(true)) {
        (true, true) => Some("underline line-through"),
        (true, false) => Some("underline"),
        (false, true) => Some("line-through"),
        (false, false) => None,
    };
    let baseline_shift = if sub {
        Some(round3(-font_size * 0.2))
    } else if sup {
        Some(round3(font_size * 0.35))
    } else {
        None
    };
    Tspan {
        text,
        font_size: round3(font_size),
        fill: m.color.clone().unwrap_or_else(|| color.to_string()),
        bold: m.bold == Some(true),
        italic: m.italic == Some(true),
        font_family: m.font.clone().filter(|f| !f.is_empty()),
        text_decoration: deco,
        baseline_shift,
    }
}

fn para_line_height(p: &Paragraph, o: &LayoutOpts) -> f64 {
    match p.line_height {
        Some(lh) => o.base_pt * o.unit_per_pt * lh,
        None => o.line_height,
    }
}

/// Verweis auf ein Textstück: Absatz `para`, Run `run` (Live-Zeilen des Raumstempels: `para` ≥
/// Absatzzahl, `run` 0), Bereich in Bytes (`b0..b1`) und in UTF-16-Einheiten (`u0..u1`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tok {
    pub para: usize,
    pub run: usize,
    pub b0: usize,
    pub b1: usize,
    pub u0: usize,
    pub u1: usize,
}

/// Eine Zeile als Verweise auf die Quelle (das eigentliche Layout; [`Line`] ist die ausgeschriebene
/// Form).
#[derive(Clone, Debug, PartialEq)]
pub struct LineRef {
    pub toks: Vec<Tok>,
    pub align: LineAlign,
    pub line_height: f64,
}

/// Gerundete Schriftgrösse eines Runs (wie `runToTspan`).
fn run_font_size(m: &Marks, base_pt: f64, unit_per_pt: f64) -> f64 {
    let script = m.super_ == Some(true) || m.sub == Some(true);
    let size_pt = m.size_pt.unwrap_or(base_pt) * if script { SCRIPT_SCALE } else { 1.0 };
    round3(size_pt * unit_per_pt)
}

/// Zeilen als Verweise (`docToLines`/`wrapDocToLines`): ohne Spalte (`wrap` ≤ 0/NaN/`None`) eine
/// Zeile je Absatz (leere Runs entfallen), sonst wortweise umbrochen — Wortbreite = UTF-16-Länge ×
/// Schriftgrösse × 0.55, Leerraum am Zeilenrand fällt weg, Run-Grenzen bleiben.
pub fn layout_refs(doc: &RichTextDoc, o: &LayoutOpts, wrap: Option<f64>) -> Vec<LineRef> {
    let max_width = wrap.filter(|w| *w > 0.0);
    struct Token {
        tok: Tok,
        width: f64,
        is_space: bool,
    }
    let mut lines = Vec::new();
    for (pi, p) in doc.paragraphs.iter().enumerate() {
        let line_height = para_line_height(p, o);
        let align = LineAlign::of(p.align);
        let Some(max_width) = max_width else {
            let toks = p.runs.iter().enumerate().filter(|(_, r)| !r.text.is_empty()).map(|(ri, r)| Tok { para: pi, run: ri, b0: 0, b1: r.text.len(), u0: 0, u1: utf16_len(&r.text) }).collect();
            lines.push(LineRef { toks, align, line_height });
            continue;
        };
        let mut tokens: Vec<Token> = Vec::new();
        for (ri, run) in p.runs.iter().enumerate() {
            if run.text.is_empty() {
                continue;
            }
            let fs = run_font_size(&run.marks, o.base_pt, o.unit_per_pt);
            let (mut b, mut u) = (0, 0);
            for part in split_keep_ws(&run.text) {
                let ul = utf16_len(part);
                let is_space = part.chars().next().is_some_and(js_space);
                tokens.push(Token { tok: Tok { para: pi, run: ri, b0: b, b1: b + part.len(), u0: u, u1: u + ul }, width: ul as f64 * fs * CHAR_WIDTH_FACTOR, is_space });
                b += part.len();
                u += ul;
            }
        }
        if tokens.is_empty() {
            lines.push(LineRef { toks: Vec::new(), align, line_height });
            continue;
        }
        let mut current: Vec<Token> = Vec::new();
        let mut current_width = 0.0;
        let flush = |current: &mut Vec<Token>, lines: &mut Vec<LineRef>| {
            while current.last().is_some_and(|t| t.is_space) {
                current.pop();
            }
            lines.push(LineRef { toks: current.drain(..).map(|t| t.tok).collect(), align, line_height });
        };
        for tok in tokens {
            if current.is_empty() && tok.is_space {
                continue;
            }
            if !current.is_empty() && current_width + tok.width > max_width {
                flush(&mut current, &mut lines);
                current_width = 0.0;
                if tok.is_space {
                    continue;
                }
            }
            current_width += tok.width;
            current.push(tok);
        }
        flush(&mut current, &mut lines);
    }
    lines
}

/// Verweis-Zeilen ausschreiben (Tspans mit Text und Stil des Runs).
pub fn lines_of(doc: &RichTextDoc, refs: Vec<LineRef>, o: &LayoutOpts) -> Vec<Line> {
    refs.into_iter()
        .map(|l| Line {
            tspans: l
                .toks
                .iter()
                .map(|t| {
                    let r = &doc.paragraphs[t.para].runs[t.run];
                    tspan_of(r.text[t.b0..t.b1].to_string(), &r.marks, o.base_pt, o.unit_per_pt, o.color)
                })
                .collect(),
            align: l.align,
            line_height: l.line_height,
        })
        .collect()
}

/// `docToLines`: eine Zeile je Absatz, leere Runs entfallen.
pub fn doc_to_lines(doc: &RichTextDoc, o: &LayoutOpts) -> Vec<Line> {
    lines_of(doc, layout_refs(doc, o, None), o)
}

/// `text.split(/(\s+)/)` ohne leere Teile: abwechselnd Wort- und Leerraum-Stücke.
pub fn split_keep_ws(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut prev: Option<bool> = None;
    for (i, c) in s.char_indices() {
        let sp = js_space(c);
        if prev.is_some_and(|p| p != sp) {
            out.push(&s[start..i]);
            start = i;
        }
        prev = Some(sp);
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// `s.split(/\s+/)` (JS): Teile zwischen Leerraum-Folgen, auch leere am Rand; `""` → `[""]`.
pub fn split_ws(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_ws = false;
    for (i, c) in s.char_indices() {
        let sp = js_space(c);
        if sp && !in_ws {
            out.push(&s[start..i]);
            in_ws = true;
        } else if !sp && in_ws {
            start = i;
            in_ws = false;
        }
    }
    out.push(if in_ws { "" } else { &s[start..] });
    out
}

/// `wrapDocToLines`: wie [`doc_to_lines`], bricht aber wortweise auf `wrap` um (gleiche Einheiten
/// wie die Schriftgrösse); `wrap` ≤ 0/NaN/`None` → eine Zeile je Absatz. Run-Grenzen bleiben.
pub fn wrap_doc_to_lines(doc: &RichTextDoc, o: &LayoutOpts, wrap: Option<f64>) -> Vec<Line> {
    lines_of(doc, layout_refs(doc, o, wrap), o)
}

/// Eine gesetzte Zeile mit ihrer Grundlinie (`y`).
#[derive(Clone, Debug, PartialEq)]
pub struct Placed {
    pub line: Line,
    pub y: f64,
}

/// Raumstempel-Block als Verweise (Plan-Ansicht, DXF): Rich-Text-Zeilen (Vorschub 1.3 ×
/// Basisgrösse bzw. die Absatz-Zeilenhöhe), darunter die Live-Zeilen (`extra`: Text und
/// Ausrichtung; Verweis-Absatz = Absatzzahl + Nummer), vertikal um `y0` zentriert; `y` wächst nach
/// unten (Bildschirm) — im Modell ist es der Abstand nach unten.
pub fn stamp_block_refs(doc: &RichTextDoc, extra: &[(&str, LineAlign)], base_pt: f64, unit_per_pt: f64, color: &str, y0: f64) -> Vec<(LineRef, f64)> {
    let base_fs = base_pt * unit_per_pt;
    let line_gap = base_fs * 1.3;
    let mut lines = layout_refs(doc, &LayoutOpts { line_height: line_gap, unit_per_pt, base_pt, color }, None);
    let n = doc.paragraphs.len();
    for (i, (text, align)) in extra.iter().enumerate() {
        lines.push(LineRef { toks: vec![Tok { para: n + i, run: 0, b0: 0, b1: text.len(), u0: 0, u1: utf16_len(text) }], align: *align, line_height: line_gap });
    }
    if lines.is_empty() {
        return Vec::new();
    }
    let total_h = base_fs + lines[1..].iter().fold(0.0, |s, l| s + l.line_height);
    let mut y = y0 - total_h / 2.0 + base_fs * 0.8;
    lines
        .into_iter()
        .enumerate()
        .map(|(k, line)| {
            if k > 0 {
                y += line.line_height;
            }
            (line, y)
        })
        .collect()
}

/// Stil der Live-Zeilen eines Raumstempels (0.8 × Basisgrösse, ungerundet, Farbe `color`).
pub fn stamp_extra_tspan(text: String, base_pt: f64, unit_per_pt: f64, color: &str) -> Tspan {
    Tspan { text, font_size: base_pt * unit_per_pt * 0.8, fill: color.to_string(), bold: false, italic: false, font_family: None, text_decoration: None, baseline_shift: None }
}

/// Raumstempel-Block ausgeschrieben ([`stamp_block_refs`]).
pub fn stamp_block(doc: &RichTextDoc, extra: &[(&str, LineAlign)], base_pt: f64, unit_per_pt: f64, color: &str, y0: f64) -> Vec<Placed> {
    let o = LayoutOpts { line_height: 0.0, unit_per_pt, base_pt, color };
    let n = doc.paragraphs.len();
    stamp_block_refs(doc, extra, base_pt, unit_per_pt, color, y0)
        .into_iter()
        .map(|(l, y)| {
            let tspans = l
                .toks
                .iter()
                .map(|t| {
                    if t.para >= n {
                        stamp_extra_tspan(extra[t.para - n].0.to_string(), base_pt, unit_per_pt, color)
                    } else {
                        let r = &doc.paragraphs[t.para].runs[t.run];
                        tspan_of(r.text[t.b0..t.b1].to_string(), &r.marks, o.base_pt, o.unit_per_pt, o.color)
                    }
                })
                .collect();
            Placed { line: Line { tspans, align: l.align, line_height: l.line_height }, y }
        })
        .collect()
}

/// Wortumbruch eines Absatzes nach Zeichenzahl (Wörter nach `split(/\s+/)`, mit einem Leerzeichen
/// verbunden; Länge in UTF-16-Einheiten) — einfacher Text ohne Rich-Dokument (Plan-Ansicht, DXF).
pub fn wrap_words<S: AsRef<str>>(words: &[S], max_chars: f64, lines: &mut Vec<String>) {
    let mut line = String::new();
    for word in words {
        let word = word.as_ref();
        if line.is_empty() {
            line = word.to_string();
        } else if (utf16_len(&line) + 1 + utf16_len(word)) as f64 <= max_chars {
            line.push(' ');
            line.push_str(word);
        } else {
            lines.push(std::mem::replace(&mut line, word.to_string()));
        }
    }
    lines.push(line);
}

/// Höchstzahl Zeichen je Zeile: `max(1, floor(Spalte / (Grösse × 0.55)))`.
pub fn max_chars(wrap: f64, font_size: f64) -> f64 {
    jsnum::max(1.0, (wrap / (font_size * CHAR_WIDTH_FACTOR)).floor())
}

/// Einfacher Text auf eine Spalte umbrochen (Absätze an `\n`).
pub fn wrap_plain(text: &str, wrap: f64, font_size: f64) -> Vec<String> {
    let m = max_chars(wrap, font_size);
    let mut lines = Vec::new();
    for para in text.split('\n') {
        wrap_words(&split_ws(para), m, &mut lines);
    }
    lines
}

/// `docFromText(text, marks)`: je Zeile (`\n`) ein Absatz, leere Zeile ohne Run.
pub fn doc_from_text(text: &str, marks: &Marks) -> RichTextDoc {
    RichTextDoc {
        version: 1.0,
        paragraphs: text
            .split('\n')
            .map(|l| Paragraph {
                runs: if l.is_empty() { vec![] } else { vec![TextRun { text: l.to_string(), marks: marks.clone(), ..Default::default() }] },
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    }
}

/// `plainText(doc)`: Absätze (Runs verkettet) mit `\n` verbunden.
pub fn plain_text(doc: &RichTextDoc) -> String {
    doc.paragraphs.iter().map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>()).collect::<Vec<_>>().join("\n")
}

/// `fontNameOf`: erste Schriftfamilie eines CSS-`font-family`-Werts ohne Anführungszeichen;
/// generische Familien und CSS-Variablen (`var(…)`) → `None`.
pub fn font_name_of(css: Option<&str>) -> Option<String> {
    let css = css.filter(|c| !c.is_empty())?;
    // `css.replace(/var\([^)]*\)/g, "")`
    let mut s = String::with_capacity(css.len());
    let mut pos = 0;
    while let Some(i) = css[pos..].find("var(").map(|i| pos + i) {
        let Some(j) = css[i + 4..].find(')').map(|j| i + 4 + j) else { break };
        s.push_str(&css[pos..i]);
        pos = j + 1;
    }
    s.push_str(&css[pos..]);
    const GENERIC: [&str; 9] = ["sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "inherit", "initial"];
    for raw in s.split(',') {
        let mut t = js_trim(raw);
        // `.replace(/^["']|["']$/g, "")`
        if t.starts_with(['"', '\'']) {
            t = &t[1..];
        }
        if t.ends_with(['"', '\'']) {
            t = &t[..t.len() - 1];
        }
        let name = js_trim(t);
        if name.is_empty() || GENERIC.iter().any(|g| name.eq_ignore_ascii_case(g)) {
            continue;
        }
        return Some(name.to_string());
    }
    None
}

/// `textFrameCorners`: vier Ecken (oben-links · oben-rechts · unten-rechts · unten-links vor der
/// Drehung) des geschätzten Rahmens eines Einzeltexts in Modell-Metern. `at` = Grundlinie links der
/// ersten Zeile; Höhe aus der echten Zeilenzahl, Breite aus der längsten Zeile geschätzt (oder
/// `wrap`); `baseline_from_top` = Grundlinie → Oberkante als Vielfaches der Höhe (in TS gemessen).
pub fn text_frame_corners(doc: &RichTextDoc, at: (f64, f64), height_m: f64, angle: f64, wrap: Option<f64>, baseline_from_top: f64) -> [(f64, f64); 4] {
    let line_height = height_m * TEXT_LINE_HEIGHT_MULT;
    let wrap = wrap.filter(|w| *w > 0.0);
    let o = LayoutOpts { line_height, unit_per_pt: 1.0, base_pt: height_m, color: "#000000" };
    let lines = wrap_doc_to_lines(doc, &o, wrap);
    let max_chars = if lines.is_empty() {
        1.0
    } else {
        lines.iter().fold(1.0, |m, l| jsnum::max(m, l.tspans.iter().map(|t| utf16_len(&t.text)).sum::<usize>() as f64))
    };
    let width = wrap.unwrap_or_else(|| jsnum::max(height_m, max_chars * height_m * CHAR_WIDTH_FACTOR));
    let height = jsnum::max(1.0, lines.len() as f64) * line_height;
    let top = height_m * baseline_from_top;
    let local = [(0.0, top), (width, top), (width, top - height), (0.0, top - height)];
    let (c, s) = (jsnum::cos(angle), jsnum::sin(angle));
    local.map(|(x, y)| (at.0 + x * c - y * s, at.1 + x * s + y * c))
}

#[cfg(test)]
mod tests {
    use super::*;

    const O: LayoutOpts = LayoutOpts { line_height: 10.0, unit_per_pt: 1.0, base_pt: 10.0, color: "#000000" };

    fn doc(paras: Vec<Vec<(&str, Marks)>>) -> RichTextDoc {
        RichTextDoc {
            version: 1.0,
            paragraphs: paras
                .into_iter()
                .map(|runs| Paragraph { runs: runs.into_iter().map(|(t, m)| TextRun { text: t.into(), marks: m, ..Default::default() }).collect(), ..Default::default() })
                .collect(),
            ..Default::default()
        }
    }

    fn texts(lines: &[Line]) -> Vec<String> {
        lines.iter().map(Line::content).collect()
    }

    #[test]
    fn ohne_spalte_eine_zeile_je_absatz() {
        let d = doc_from_text("hallo welt\n\nzwei", &Marks::default());
        assert_eq!(wrap_doc_to_lines(&d, &O, None), doc_to_lines(&d, &O));
        assert_eq!(wrap_doc_to_lines(&d, &O, Some(f64::NAN)), doc_to_lines(&d, &O));
        assert_eq!(texts(&doc_to_lines(&d, &O)), ["hallo welt", "", "zwei"]);
    }

    #[test]
    fn bricht_wortweise_um_und_verliert_nichts() {
        let d = doc_from_text("eins zwei drei vier fünf", &Marks::default());
        let l = wrap_doc_to_lines(&d, &O, Some(30.0));
        // 5.5 Einheiten je Zeichen: "eins" (22) + " " (5.5) passt, "zwei" (22) nicht mehr.
        assert_eq!(texts(&l), ["eins", "zwei", "drei", "vier", "fünf"]);
        let l = wrap_doc_to_lines(&doc_from_text("aa bb cc", &Marks::default()), &O, Some(1.0));
        assert_eq!(texts(&l), ["aa", "bb", "cc"]);
    }

    #[test]
    fn run_grenzen_und_formatierung_bleiben() {
        let bold = Marks { bold: Some(true), ..Default::default() };
        let d = doc(vec![vec![("normal ", Marks::default()), ("fett", bold), (" weiter", Marks::default())]]);
        let l = wrap_doc_to_lines(&d, &O, Some(1000.0));
        assert_eq!(l.len(), 1);
        let t: Vec<_> = l[0].tspans.iter().map(|t| (t.text.as_str(), t.bold)).collect();
        assert_eq!(t, [("normal", false), (" ", false), ("fett", true), (" ", false), ("weiter", false)]);
    }

    #[test]
    fn leerer_absatz_ergibt_leere_zeile() {
        let d = doc(vec![vec![], vec![("x", Marks::default())]]);
        let l = wrap_doc_to_lines(&d, &O, Some(100.0));
        assert_eq!(l.len(), 2);
        assert!(l[0].tspans.is_empty());
    }

    #[test]
    fn breite_in_utf16_einheiten_und_js_leerraum() {
        // 🏠 zählt 2 Einheiten (11 bei Grösse 10), NBSP trennt Wörter, U+0085 nicht (kein JS-\s).
        assert_eq!(split_keep_ws("a\u{a0}b\u{85}c  d"), ["a", "\u{a0}", "b\u{85}c", "  ", "d"]);
        assert_eq!(split_ws(" a  b "), ["", "a", "b", ""]);
        assert_eq!(split_ws(""), [""]);
        let d = doc_from_text("🏠 🏠", &Marks::default());
        assert_eq!(texts(&wrap_doc_to_lines(&d, &O, Some(27.5))), ["🏠 🏠"]);
        assert_eq!(texts(&wrap_doc_to_lines(&d, &O, Some(27.4))), ["🏠", "🏠"]);
    }

    #[test]
    fn tspan_grosse_hochstellung_farbe() {
        let m = Marks { super_: Some(true), size_pt: Some(9.0), color: Some(String::new()), font: Some(String::new()), underline: Some(true), strike: Some(true), ..Default::default() };
        let t = run_to_tspan(&TextRun { text: "x".into(), marks: m, ..Default::default() }, 12.0, 25.4 / 72.0, "#123");
        assert_eq!(t.font_size, round3(9.0 * 0.7 * (25.4 / 72.0)));
        assert_eq!(t.baseline_shift, Some(round3(9.0 * 0.7 * (25.4 / 72.0) * 0.35)));
        assert_eq!(t.fill, ""); // `color ?? …`: leere Farbe bleibt
        assert_eq!(t.font_family, None);
        assert_eq!(t.text_decoration, Some("underline line-through"));
        let j = serde_json::to_string(&t).unwrap();
        assert!(j.starts_with("{\"text\":\"x\",\"fontSize\":") && !j.contains("fontWeight") && j.contains("\"baselineShift\":"));
    }

    #[test]
    fn absatz_zeilenhoehe_aus_basisgroesse() {
        let mut d = doc_from_text("a\nb", &Marks::default());
        d.paragraphs[1].line_height = Some(1.5);
        d.paragraphs[1].align = Some(Align::Unknown);
        let l = doc_to_lines(&d, &LayoutOpts { line_height: 7.0, unit_per_pt: 2.0, base_pt: 10.0, color: "#000" });
        assert_eq!((l[0].line_height, l[1].line_height, l[1].align), (7.0, 30.0, LineAlign::Left));
    }

    #[test]
    fn schriftname_aus_css() {
        assert_eq!(font_name_of(Some("\"Helvetica Neue\", Arial, sans-serif")).as_deref(), Some("Helvetica Neue"));
        assert_eq!(font_name_of(Some("var(--font-ui, sans-serif)")), None);
        assert_eq!(font_name_of(Some("sans-serif, Arial")).as_deref(), Some("Arial"));
        assert_eq!(font_name_of(Some("'Source Sans 3'")).as_deref(), Some("Source Sans 3"));
        assert_eq!(font_name_of(Some("SERIF, 'x")).as_deref(), Some("x"));
        assert_eq!(font_name_of(Some("var(--a), Times")).as_deref(), Some("Times"));
        assert_eq!(font_name_of(None), None);
        assert_eq!(font_name_of(Some("")), None);
        assert_eq!(font_name_of(Some("\"")), None);
    }

    #[test]
    fn text_rahmen() {
        let d = doc_from_text("Hallo", &Marks::default());
        let c = text_frame_corners(&d, (0.0, 0.0), 0.2, 0.0, None, 0.9);
        assert!((c[0].1 - 0.18).abs() < 1e-12 && (c[2].1 - (0.18 - 0.25)).abs() < 1e-12);
        assert!((c[1].0 - 5.0 * 0.2 * 0.55).abs() < 1e-12);
        let w = text_frame_corners(&d, (0.0, 0.0), 0.2, 0.0, Some(1.5), 0.9);
        assert_eq!(w[1].0, 1.5);
        let r = text_frame_corners(&d, (0.0, 0.0), 0.2, std::f64::consts::FRAC_PI_2, None, 0.9);
        assert!((r[0].0 + 0.18).abs() < 1e-12 && r[0].1.abs() < 1e-12);
    }
}
