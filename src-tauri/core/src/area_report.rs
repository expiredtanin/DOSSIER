//! Flächen-/Kennzahlen-Nachweis ([70]): CSV schreiben und lesen, Seitenaufteilung (Papier-mm) und SVG.
//! Hervorgegangen aus `src/export/areaReport.ts` (dort bleiben Aufbau mit `t()`-Beschriftung und die
//! jsPDF-Ausgabe; das PDF zeichnet die Primitive aus [`layout`]). Zahlen wie JS (`toFixed`, `String(n)`).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::js_fmt::{js_number, to_fixed};

/// Zelle: Text oder Zahl (`d` Nachkommastellen, `n = null` = nicht berechenbar).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Cell {
    Text(String),
    Num { n: Option<f64>, d: usize },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Row {
    pub cells: Vec<Cell>,
    #[serde(default)]
    pub total: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Section {
    pub heading: String,
    pub columns: Vec<String>,
    pub widths: Vec<f64>,
    pub rows: Vec<Row>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub title: String,
    pub project_name: String,
    pub sections: Vec<Section>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LayoutOptions {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub margin: Option<f64>,
}

/// Zeichen-Primitiv einer Seite (Papier-mm).
#[derive(Debug, Clone, PartialEq)]
pub enum Prim {
    Text { x: f64, y: f64, s: String, size: f64, bold: bool, right: bool },
    Line { x1: f64, y1: f64, x2: f64, y2: f64, w: f64 },
}

pub struct Layout {
    pub width: f64,
    pub height: f64,
    pub pages: Vec<Vec<Prim>>,
}

// ── CSV ─────────────────────────────────────────────────────────────────────

fn csv_field(v: &str) -> String {
    if v.contains(['"', ',', '\n', '\r', ';']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

/// Zelle als Text, so wie sie ausgegeben wird (Punkt als Dezimaltrenner, `null` = leer).
pub fn cell_text(c: &Cell) -> String {
    match c {
        Cell::Text(s) => s.clone(),
        Cell::Num { n: None, .. } => String::new(),
        Cell::Num { n: Some(n), d } => to_fixed(*n, *d),
    }
}

/// CSV des Berichts: Titel, Projekt, dann je Abschnitt Überschrift, Kopf, Zeilen; Fussnoten mit „* ".
pub fn to_csv(report: &Report, delimiter: &str) -> String {
    let line = |cells: &[String]| cells.iter().map(|c| csv_field(c)).collect::<Vec<_>>().join(delimiter);
    let mut out: Vec<String> = vec![line(&[report.title.clone()]), line(&[report.project_name.clone()]), String::new()];
    for s in &report.sections {
        out.push(line(&[s.heading.clone()]));
        out.push(line(&s.columns));
        for r in &s.rows {
            out.push(line(&r.cells.iter().map(cell_text).collect::<Vec<_>>()));
        }
        out.push(String::new());
    }
    for n in &report.notes {
        out.push(line(&[format!("* {n}")]));
    }
    out.join("\n") + "\n"
}

/// Zerlegt CSV-Text in Zeilen von Feldern (Anführungszeichen, Trenner, Zeilenumbruch im Feld).
fn parse_csv_rows(text: &str, delimiter: &str) -> Vec<Vec<String>> {
    let cs: Vec<char> = text.chars().collect();
    let delim = {
        let mut it = delimiter.chars();
        match (it.next(), it.next()) {
            (Some(c), None) => Some(c),
            _ => None, // mehrstelliger Trenner trifft nie (wie `c === delimiter` in TS)
        }
    };
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if quoted {
            if c == '"' {
                if cs.get(i + 1) == Some(&'"') {
                    field.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' {
            quoted = true;
        } else if Some(c) == delim {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && cs.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(c);
        }
        i += 1;
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// `/^-?\d+(\.\d+)?$/` (ASCII-Ziffern).
fn is_number(c: &str) -> bool {
    let b = c.strip_prefix('-').unwrap_or(c);
    let (int, frac) = match b.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (b, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|x| x.is_ascii_digit());
    digits(int) && frac.map_or(true, digits)
}

/// Liest eine mit [`to_csv`] geschriebene CSV zurück (Rundreise): JSON `{title, projectName, sections, notes}`;
/// Zahlen als Zahl (Zelle leer → `null` an Zahlenstellen), Texte als Text.
pub fn parse_csv(text: &str, delimiter: &str) -> Value {
    let rows = parse_csv_rows(text, delimiter);
    let mut blocks: Vec<Vec<Vec<String>>> = Vec::new();
    let mut cur: Vec<Vec<String>> = Vec::new();
    for r in rows {
        if r.len() == 1 && r[0].is_empty() {
            if !cur.is_empty() {
                blocks.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(r);
        }
    }
    if !cur.is_empty() {
        blocks.push(cur);
    }
    let mut it = blocks.into_iter();
    let head = it.next().unwrap_or_default();
    let first = |b: &Vec<Vec<String>>, i: usize| b.get(i).and_then(|r| r.first()).cloned().unwrap_or_default();
    let mut sections: Vec<Value> = Vec::new();
    let mut notes: Vec<Value> = Vec::new();
    for b in it {
        if b.first().and_then(|r| r.first()).map_or(false, |c| c.starts_with("* ")) {
            for r in &b {
                notes.push(json!(r[0].chars().skip(2).collect::<String>()));
            }
            continue;
        }
        let rows: Vec<Value> = b
            .iter()
            .skip(2)
            .map(|r| {
                Value::Array(
                    r.iter()
                        .enumerate()
                        .map(|(i, c)| {
                            if is_number(c) {
                                json!(c.parse::<f64>().unwrap_or(f64::NAN))
                            } else if i == 0 || !c.is_empty() {
                                json!(c)
                            } else {
                                Value::Null
                            }
                        })
                        .collect(),
                )
            })
            .collect();
        sections.push(json!({ "heading": first(&b, 0), "columns": b.get(1).cloned().unwrap_or_default(), "rows": rows }));
    }
    json!({ "title": first(&head, 0), "projectName": first(&head, 1), "sections": sections, "notes": notes })
}

// ── Seitenaufteilung ────────────────────────────────────────────────────────

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Zeilenumbruch nach Zeichenzahl (Helvetica ≈ 0.5 em je Zeichen).
fn wrap(text: &str, max_mm: f64, size_pt: f64) -> Vec<String> {
    let per = (max_mm / (size_pt * 0.3528 * 0.5)).floor().max(10.0);
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    for w in text.split_whitespace() {
        if !cur.is_empty() && (utf16_len(&cur) + 1 + utf16_len(w)) as f64 > per {
            lines.push(std::mem::take(&mut cur));
            cur = w.to_string();
        } else if cur.is_empty() {
            cur = w.to_string();
        } else {
            cur = format!("{cur} {w}");
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

fn text(x: f64, y: f64, s: &str, size: f64, bold: bool, right: bool) -> Prim {
    Prim::Text { x, y, s: s.to_string(), size, bold, right }
}

/// Teilt den Bericht in Seiten mit Zeichen-Primitiven (Blattgrösse in mm, Default A4 quer).
pub fn layout(report: &Report, o: &LayoutOptions) -> Layout {
    let width = o.width.unwrap_or(297.0);
    let height = o.height.unwrap_or(210.0);
    let m = o.margin.unwrap_or(12.0);
    let inner = width - 2.0 * m;
    let row_h = 6.0;
    let mut pages: Vec<Vec<Prim>> = vec![Vec::new()];
    let mut y = m;
    macro_rules! page {
        () => {
            pages.last_mut().unwrap()
        };
    }
    macro_rules! ensure {
        ($h:expr) => {
            if y + $h > height - m {
                pages.push(Vec::new());
                y = m;
            }
        };
    }
    page!().push(text(m, y + 5.0, &report.title, 15.0, true, false));
    y += 8.0;
    if !report.project_name.is_empty() {
        page!().push(text(m, y + 4.0, &report.project_name, 10.0, false, false));
        y += 6.0;
    }
    y += 4.0;

    for s in &report.sections {
        ensure!(row_h * 3.0 + 6.0);
        page!().push(text(m, y + 4.0, &s.heading, 10.0, true, false));
        y += 7.0;
        let sum: f64 = s.widths.iter().sum();
        let mut xs: Vec<f64> = Vec::new();
        let mut x = m;
        for w in &s.widths {
            xs.push(x);
            x += (w / sum) * inner;
        }
        xs.push(x);
        let numeric: Vec<bool> = (0..s.columns.len()).map(|i| s.rows.iter().any(|r| matches!(r.cells.get(i), Some(Cell::Num { .. })))).collect();
        // 0 = keine Linie, 1 = oben
        let draw_row = |pages: &mut Vec<Vec<Prim>>, y: &mut f64, cells: &[String], bold: bool, top: bool| {
            if *y + row_h > height - m {
                pages.push(Vec::new());
                *y = m;
            }
            let pg = pages.last_mut().unwrap();
            if top {
                pg.push(Prim::Line { x1: m, y1: *y, x2: m + inner, y2: *y, w: 0.35 });
            }
            for (i, c) in cells.iter().enumerate() {
                let right = numeric.get(i).copied().unwrap_or(false);
                let xi = xs.get(i).copied().unwrap_or(f64::NAN);
                let xn = xs.get(i + 1).copied().unwrap_or(f64::NAN);
                pg.push(text(if right { xn - 1.5 } else { xi + 1.5 }, *y + 4.2, c, 8.5, bold, right));
            }
            *y += row_h;
        };
        draw_row(&mut pages, &mut y, &s.columns, true, false);
        page!().push(Prim::Line { x1: m, y1: y, x2: m + inner, y2: y, w: 0.35 });
        for r in &s.rows {
            let cells: Vec<String> = r
                .cells
                .iter()
                .map(|c| match c {
                    Cell::Text(t) => t.clone(),
                    Cell::Num { n: None, .. } => "–".to_string(),
                    Cell::Num { n: Some(n), d } => to_fixed(*n, *d),
                })
                .collect();
            let total = r.total == Some(true);
            draw_row(&mut pages, &mut y, &cells, total, total);
        }
        page!().push(Prim::Line { x1: m, y1: y, x2: m + inner, y2: y, w: 0.35 });
        y += 6.0;
    }

    for n in &report.notes {
        let lines = wrap(n, inner, 7.5);
        ensure!(lines.len() as f64 * 3.4 + 1.0);
        for l in &lines {
            page!().push(text(m, y + 2.8, l, 7.5, false, false));
            y += 3.4;
        }
        y += 1.0;
    }
    let total = pages.len();
    for (i, p) in pages.iter_mut().enumerate() {
        p.push(text(width - m, height - m / 2.0, &format!("{} / {}", i + 1, total), 7.0, false, true));
    }
    Layout { width, height, pages }
}

/// Layout als JSON `{width, height, pages: [[{k:"text"|"line", …}]]}`.
pub fn layout_json(l: &Layout) -> Value {
    let pages: Vec<Value> = l
        .pages
        .iter()
        .map(|p| {
            Value::Array(
                p.iter()
                    .map(|q| match q {
                        Prim::Line { x1, y1, x2, y2, w } => json!({ "k": "line", "x1": x1, "y1": y1, "x2": x2, "y2": y2, "w": w }),
                        Prim::Text { x, y, s, size, bold, right } => {
                            let mut o = json!({ "k": "text", "x": x, "y": y, "s": s, "size": size });
                            if *bold {
                                o["bold"] = json!(true);
                            }
                            if *right {
                                o["align"] = json!("right");
                            }
                            o
                        }
                    })
                    .collect(),
            )
        })
        .collect();
    json!({ "width": l.width, "height": l.height, "pages": pages })
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// SVG einer Seite (Papier-mm, viewBox in mm); eine zu grosse Seitennummer wählt die letzte.
pub fn to_svg(report: &Report, page: usize, o: &LayoutOptions) -> String {
    let lay = layout(report, o);
    let prims = lay.pages.get(page.min(lay.pages.len() - 1)).map(|p| p.as_slice()).unwrap_or(&[]);
    let body: Vec<String> = prims
        .iter()
        .map(|p| match p {
            Prim::Line { x1, y1, x2, y2, w } => format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"#111\" stroke-width=\"{}\"/>",
                js_number(*x1), js_number(*y1), js_number(*x2), js_number(*y2), js_number(*w)
            ),
            Prim::Text { x, y, s, size, bold, right } => format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"{}\" font-family=\"Helvetica, Arial, sans-serif\" font-weight=\"{}\" text-anchor=\"{}\" fill=\"#111\">{}</text>",
                js_number(*x), js_number(*y), to_fixed(size * 0.3528, 3), if *bold { 700 } else { 400 }, if *right { "end" } else { "start" }, esc(s)
            ),
        })
        .collect();
    let (w, h) = (js_number(lay.width), js_number(lay.height));
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}mm\" height=\"{h}mm\" viewBox=\"0 0 {w} {h}\">\n<rect width=\"{w}\" height=\"{h}\" fill=\"#fff\"/>\n{}\n</svg>\n",
        body.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Report {
        serde_json::from_value(json!({
            "title": "Flächen", "projectName": "Haus \"A\"; B",
            "sections": [{ "heading": "Tabelle", "columns": ["Geschoss", "HNF"], "widths": [3, 2],
                "rows": [{ "cells": ["EG", { "n": 12.345, "d": 2 }] }, { "cells": ["Σ", { "n": null, "d": 2 }], "total": true }] }],
            "notes": ["Eine Fussnote"]
        }))
        .unwrap()
    }

    #[test]
    fn csv_rundreise() {
        let csv = to_csv(&sample(), ";");
        assert!(csv.starts_with("Flächen\n\"Haus \"\"A\"\"; B\"\n\nTabelle\nGeschoss;HNF\nEG;12.35\nΣ;\n\n* Eine Fussnote\n"));
        let p = parse_csv(&csv, ";");
        assert_eq!(p["projectName"], "Haus \"A\"; B");
        assert_eq!(p["sections"][0]["rows"][0], json!(["EG", 12.35]));
        assert_eq!(p["sections"][0]["rows"][1], json!(["Σ", null]));
        assert_eq!(p["notes"][0], "Eine Fussnote");
    }

    #[test]
    fn seiten_und_svg() {
        let l = layout(&sample(), &LayoutOptions::default());
        assert_eq!(l.pages.len(), 1);
        let svg = to_svg(&sample(), 0, &LayoutOptions::default());
        assert!(svg.contains("viewBox=\"0 0 297 210\"") && svg.contains("1 / 1"));
        let lang = Report { notes: (0..200).map(|i| format!("Notiz {i}")).collect(), ..sample() };
        assert!(layout(&lang, &LayoutOptions::default()).pages.len() > 1);
    }
}
