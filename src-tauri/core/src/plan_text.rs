//! Texte eines Plans für die Ausgaben ([K3d]/[K4], früher TS: `planSceneTexts` in
//! `src/plan/toRenderScene.ts`, `stampLines`/`textInput` in `src/export/exportDxf.ts`): Raumstempel
//! (`text`) und Einzeltexte (`drawingText`) reisen im Plan-Puffer als JSON (Rich-Text-Dokument,
//! Live-Zeilen, Höhe, Spalte); gesetzt wird hier beim Verbrauch — die Zeilenlage hängt am Massstab
//! der Ausgabe (Raumstempel in Papier-pt, Run-Grössen der Einzeltexte in pt), nicht am Plan.
//! Layout selbst: [`crate::text_layout`].
//!
//! Zahlen im JSON, die TS als `null` geschrieben hat (NaN), werden NaN.

use crate::model::{Marks, RichTextDoc};
use crate::plan::prim::StampLine;
use crate::plan_buf::{whole, T_DRAWING_TEXT, T_TEXT};
use crate::plan_dxf::{StampLine as DxfLine, TextIn, TextStyleIn};
use crate::plan_parts::{in_ranges, Part};
use crate::plan_scene::{to_rgba, Rgba, SText};
use crate::text_layout::{doc_from_text, doc_to_lines, font_name_of, is_blank, plain_text, split_ws, stamp_block, wrap_doc_to_lines, LayoutOpts, LineAlign, Placed, PT_TO_MM, TEXT_LINE_HEIGHT_MULT};
use serde::{Deserialize, Deserializer};

fn num<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct P {
    #[serde(deserialize_with = "num")]
    pub x: f64,
    #[serde(deserialize_with = "num")]
    pub y: f64,
}

/// Raumstempel (`Primitive` `text`).
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StampText {
    pub at: P,
    pub doc: RichTextDoc,
    #[serde(default)]
    pub extra_lines: Vec<StampLine>,
    #[serde(deserialize_with = "num")]
    pub base_pt: f64,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub greyed: Option<bool>,
}

/// Einzeltext (`Primitive` `drawingText`).
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SingleText {
    pub at: P,
    #[serde(default)]
    pub text: String,
    #[serde(deserialize_with = "num")]
    pub height_m: f64,
    #[serde(deserialize_with = "num")]
    pub angle: f64,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub marks: Option<Marks>,
    #[serde(default)]
    pub wrap_width: Option<f64>,
    #[serde(default)]
    pub doc: Option<RichTextDoc>,
    #[serde(default)]
    pub greyed: Option<bool>,
    #[serde(default)]
    pub opacity: Option<f64>,
}

impl SingleText {
    /// `p.doc ?? docFromText(p.text, p.marks ?? {})`.
    pub fn doc(&self) -> RichTextDoc {
        match &self.doc {
            Some(d) => d.clone(),
            None => doc_from_text(&self.text, self.marks.as_ref().unwrap_or(&Marks::default())),
        }
    }
    /// `p.wrapWidth && p.wrapWidth > 0 ? p.wrapWidth : undefined`.
    pub fn wrap(&self) -> Option<f64> {
        self.wrap_width.filter(|w| *w > 0.0)
    }
}

pub enum TextPrim {
    Stamp(StampText),
    Single(SingleText),
}

/// Text-Eintrag `i` eines Abschnitts lesen (`None`: kein Text, kein JSON oder unlesbar).
pub fn read_text(part: &mut Part, i: usize) -> Option<TextPrim> {
    let rec = part.view.rec(i)?;
    if rec.tag != T_TEXT && rec.tag != T_DRAWING_TEXT {
        return None;
    }
    let idx = *rec.f.first()?;
    whole(idx)?;
    let js = part.str(idx)?;
    if rec.tag == T_TEXT {
        serde_json::from_str(js).ok().map(TextPrim::Stamp)
    } else {
        serde_json::from_str(js).ok().map(TextPrim::Single)
    }
}

// ── Render-Szene ─────────────────────────────────────────────────────────────────────────────────

const INK: Rgba = [0.1, 0.1, 0.1, 1.0];
/// Grauton gedimmter Texte (wie `GREY_RGB`).
const GREY_RGB: f64 = 0.549;

fn greyed_color(c: Rgba, greyed: bool) -> Rgba {
    if greyed {
        [GREY_RGB, GREY_RGB, GREY_RGB, c[3]]
    } else {
        c
    }
}

fn push(out: &mut Vec<SText>, x: f64, y: f64, content: String, size_mm: f64, color: Rgba, align: LineAlign) {
    out.push(SText { pos: crate::hatch::V2 { x, y }, size_mm, color, align: align.code(), content: content.into_bytes() });
}

/// Textzeilen der Render-Szene in Zeichenreihenfolge (`planSceneTexts`): Raumstempel = Rich-Text-
/// Zeilen + Live-Zeilen, Block vertikal um den Anker zentriert, Vorschub 1.3 × Basisgrösse;
/// Einzeltexte top-down ab `at` mit `heightM` als Basisgrösse, umbrochen auf die Spalte.
/// `paper_scale_n` (1:N) rechnet Papier-mm in Modell-Meter um. `None` bei kaputtem Puffer.
pub fn scene_texts(parts: &mut [Part], ranges: &[(usize, usize)], paper_scale_n: f64) -> Option<Vec<SText>> {
    let mm_to_m = paper_scale_n / 1000.0;
    let mut out = Vec::new();
    let mut gi = 0usize;
    for part in parts.iter_mut() {
        for i in part.from..part.to {
            let forced = !ranges.is_empty() && in_ranges(ranges, gi);
            gi += 1;
            let tag = part.view.rec(i)?.tag;
            if tag != T_TEXT && tag != T_DRAWING_TEXT {
                continue;
            }
            match read_text(part, i) {
                Some(TextPrim::Stamp(t)) => stamp_scene(&t, forced, mm_to_m, &mut out),
                Some(TextPrim::Single(t)) => single_scene(&t, forced, mm_to_m, &mut out),
                None => {}
            }
        }
    }
    Some(out)
}

fn stamp_scene(t: &StampText, forced: bool, mm_to_m: f64, out: &mut Vec<SText>) {
    let greyed = t.greyed == Some(true) || forced;
    let color = t.color.as_deref();
    let def = greyed_color(to_rgba(color).unwrap_or(INK), greyed);
    let o = LayoutOpts { line_height: 0.0, unit_per_pt: PT_TO_MM, base_pt: t.base_pt, color: color.unwrap_or("#000000") };
    let base_mm = t.base_pt * PT_TO_MM;
    let mut flat: Vec<(String, f64, Rgba, LineAlign)> = Vec::new();
    for line in doc_to_lines(&t.doc, &o) {
        let fill = line.tspans.first().map(|s| s.fill.as_str()).or(color);
        let c = greyed_color(to_rgba(fill).unwrap_or(def), greyed);
        flat.push((line.content(), line.max_size().unwrap_or(base_mm), c, line.align));
    }
    for l in &t.extra_lines {
        flat.push((l.text.clone(), base_mm * 0.8, def, LineAlign::of(Some(l.align))));
    }
    if flat.is_empty() {
        return;
    }
    let base_h = base_mm * mm_to_m;
    let line_gap = base_h * 1.3;
    let total_h = base_h + (flat.len() - 1) as f64 * line_gap;
    for (k, (content, size, c, align)) in flat.into_iter().enumerate() {
        if is_blank(&content) {
            continue;
        }
        push(out, t.at.x, t.at.y + total_h / 2.0 - base_h * 0.8 - k as f64 * line_gap, content, size, c, align);
    }
}

fn single_scene(t: &SingleText, forced: bool, mm_to_m: f64, out: &mut Vec<SText>) {
    let greyed = t.greyed == Some(true) || forced;
    let color = t.color.as_deref();
    let def = greyed_color(to_rgba(color).unwrap_or(INK), greyed);
    let unit_per_pt = PT_TO_MM * mm_to_m;
    let base_pt = if unit_per_pt > 0.0 { t.height_m / unit_per_pt } else { 0.0 };
    let o = LayoutOpts { line_height: t.height_m * TEXT_LINE_HEIGHT_MULT, unit_per_pt, base_pt, color: color.unwrap_or("#000000") };
    let mut dy = 0.0;
    for (k, line) in wrap_doc_to_lines(&t.doc(), &o, t.wrap()).into_iter().enumerate() {
        if k > 0 {
            dy += line.line_height;
        }
        let content = line.content();
        if is_blank(&content) {
            continue;
        }
        let size_m = line.max_size().unwrap_or(t.height_m);
        let fill = line.tspans.first().map(|s| s.fill.as_str()).or(color);
        let c = greyed_color(to_rgba(fill).unwrap_or(def), greyed);
        push(out, t.at.x, t.at.y - dy, content, if unit_per_pt > 0.0 { size_m / mm_to_m } else { size_m }, c, line.align);
    }
}

// ── DXF ──────────────────────────────────────────────────────────────────────────────────────────

/// Standard-Schrift des DXF-Exports: erste Schrift der Projekt-Textstile, sonst Arial.
pub fn default_font(project: &crate::model::Project) -> String {
    project.text_styles.iter().flatten().find_map(|s| font_name_of(s.marks.font.as_deref())).unwrap_or_else(|| "Arial".to_string())
}

/// Text-Eingabe des DXF-Sammlers für einen Text-Eintrag (`scale` = Massstabsnenner).
pub fn dxf_text(t: &TextPrim, scale: f64, default_font: &str) -> TextIn {
    let family = |font: Option<&str>| font_name_of(font).unwrap_or_else(|| default_font.to_string());
    match t {
        TextPrim::Stamp(p) => TextIn::Stamp { at: crate::hatch::V2 { x: p.at.x, y: p.at.y }, lines: stamp_lines(p, scale, &family) },
        TextPrim::Single(p) => {
            let paras: Vec<String> = match &p.doc {
                Some(d) => plain_text(d).split('\n').map(str::to_string).collect(),
                None => split_lines(&p.text),
            };
            let marks = p.marks.as_ref().or_else(|| p.doc.as_ref().and_then(|d| d.paragraphs.first()).and_then(|q| q.runs.first()).map(|r| &r.marks));
            let style = TextStyleIn {
                family: family(marks.and_then(|m| m.font.as_deref())),
                bold: marks.is_some_and(|m| m.bold == Some(true)),
                italic: marks.is_some_and(|m| m.italic == Some(true)),
            };
            TextIn::Single {
                at: crate::hatch::V2 { x: p.at.x, y: p.at.y },
                angle: p.angle,
                height: p.height_m,
                wrap: p.wrap_width.unwrap_or(f64::NAN),
                style,
                paras: paras.into_iter().map(|q| { let w = split_ws(&q).into_iter().map(str::to_string).collect(); (q, w) }).collect(),
            }
        }
    }
}

/// `text.split(/\r?\n/)`.
fn split_lines(s: &str) -> Vec<String> {
    let parts: Vec<&str> = s.split('\n').collect();
    let n = parts.len();
    parts.into_iter().enumerate().map(|(k, p)| if k + 1 < n { p.strip_suffix('\r').unwrap_or(p) } else { p }.to_string()).collect()
}

/// Zeilen eines Raumstempels für den DXF-Export (`stampLines`): wie in der Plan-Ansicht vertikal um
/// den Anker zentriert ([`stamp_block`]), Höhen in Modell-Metern beim Massstab.
fn stamp_lines(p: &StampText, scale: f64, family: &dyn Fn(Option<&str>) -> String) -> Vec<DxfLine> {
    let unit_per_pt = (0.0254 / 72.0) * scale;
    let extra: Vec<(&str, LineAlign)> = p.extra_lines.iter().map(|l| (l.text.as_str(), LineAlign::of(Some(l.align)))).collect();
    let mut out = Vec::new();
    for Placed { line, y } in stamp_block(&p.doc, &extra, p.base_pt, unit_per_pt, p.color.as_deref().unwrap_or("#000000"), 0.0) {
        let text = line.content();
        let Some(first) = line.tspans.first() else { continue };
        if is_blank(&text) {
            continue;
        }
        out.push(DxfLine {
            height: line.max_size().unwrap_or(f64::NAN),
            align: line.align.code() as f64,
            style: TextStyleIn { family: family(first.font_family.as_deref()), bold: first.bold, italic: first.italic },
            down: y,
            text,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_lesen_und_null_als_nan() {
        let s: SingleText = serde_json::from_str(r##"{"kind":"drawingText","at":{"x":1,"y":null},"text":"a","heightM":0.2,"angle":0,"color":"#000","wrapWidth":null}"##).unwrap();
        assert!(s.at.y.is_nan() && s.wrap().is_none());
        assert_eq!(s.doc().paragraphs.len(), 1);
        let t: StampText = serde_json::from_str(r##"{"kind":"text","at":{"x":0,"y":0},"doc":{"version":1,"paragraphs":[]},"extraLines":[{"text":"x","align":"center"}],"basePt":9,"color":"#fff","roomId":"r"}"##).unwrap();
        assert_eq!(t.extra_lines.len(), 1);
    }

    #[test]
    fn zeilen_mit_wagenruecklauf() {
        assert_eq!(split_lines("a\r\nb\r"), ["a", "b\r"]);
        assert_eq!(split_lines(""), [""]);
    }

    #[test]
    fn raumstempel_zentriert_und_leerzeilen_ohne_text() {
        let t: StampText = serde_json::from_str(r##"{"at":{"x":2,"y":3},"doc":{"version":1,"paragraphs":[{"runs":[{"text":"Wohnen","marks":{"bold":true}}],"align":"center"},{"runs":[]}]},"extraLines":[{"text":"17.01 m²","align":"right"}],"basePt":10,"color":"#333"}"##).unwrap();
        let mut out = Vec::new();
        stamp_scene(&t, false, 0.1, &mut out);
        assert_eq!(out.len(), 2);
        let base_h = 10.0 * PT_TO_MM * 0.1;
        assert_eq!(out[0].pos.y, 3.0 + (base_h + 2.0 * base_h * 1.3) / 2.0 - base_h * 0.8);
        assert_eq!((out[0].align, out[1].align), (1, 2));
        let l = stamp_lines(&t, 100.0, &|f| f.unwrap_or("Arial").to_string());
        assert_eq!(l.len(), 2);
        assert!(l[0].style.bold && l[0].style.family == "Arial");
    }
}
