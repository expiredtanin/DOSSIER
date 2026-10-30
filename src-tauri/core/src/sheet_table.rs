//! Tabellen auf Layout-Blättern ([111]): eine lebendige Liste des Modells (Fenster/Türen [97], Flächen
//! SIA 416 [70], Raumprogramm, Bauteile mit U-Wert [71]) als Zeichen-Primitive in Papier-mm. Gerechnet wird
//! bei jedem Aufruf aus dem Dokument, darum folgt die Tabelle dem Modell. Dieselben Primitive zeichnen die
//! Blattansicht (SVG), das Druck-PDF (jsPDF, Vektortext) und der DXF-Export (`plan_dxf.rs`).
//! Beschriftungen kommen von aussen (`Labels`, TS-`t()`); Kennungen der Spalten stehen im Katalog.
//! Aufteilen: Ist `heightMm` gesetzt, zeigt eine Tabelle nur die Zeilen, die hineinpassen; eine Tabelle mit
//! `continues` zeigt die folgenden Zeilen derselben Quelle (Quelle/Spalten/Filter erbt sie vom Anfang der Kette).

use crate::area_report::Cell;
use crate::js_fmt::to_fixed;
use crate::model::*;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Eine Spalte der Quelle.
pub struct Col {
    pub id: &'static str,
    /// Schlüssel der Beschriftung (`t()` auf der TS-Seite).
    pub key: &'static str,
    /// Relative Breite.
    pub w: f64,
    pub numeric: bool,
    /// In den Standard-Spalten.
    pub default: bool,
}

const fn c(id: &'static str, key: &'static str, w: f64, numeric: bool, default: bool) -> Col {
    Col { id, key, w, numeric, default }
}

const OPENINGS: &[Col] = &[
    c("mark", "openings.col.mark", 1.4, false, true),
    c("kind", "sheetTable.col.kind", 1.3, false, false),
    c("type", "openings.col.type", 2.4, false, true),
    c("floor", "openings.col.floor", 1.4, false, true),
    c("rooms", "openings.col.rooms", 3.2, false, false),
    c("width", "openings.col.width", 1.3, true, true),
    c("height", "openings.col.height", 1.3, true, true),
    c("sill", "openings.col.sill", 1.3, true, true),
    c("clearWidth", "openings.col.clearWidth", 1.4, true, false),
    c("clearHeight", "openings.col.clearHeight", 1.4, true, false),
    c("swing", "openings.col.swing", 2.6, false, false),
    c("fire", "openings.col.fire", 1.1, false, false),
    c("sound", "openings.col.sound", 1.5, false, false),
    c("u", "openings.col.u", 1.3, true, true),
    c("rc", "openings.col.rc", 1.1, false, false),
    c("ext", "openings.col.ext", 1.4, false, false),
    c("notes", "openings.col.notes", 3.0, false, false),
];

const AREAS: &[Col] = &[
    c("name", "sheetTable.col.floor", 2.4, false, true),
    c("hnf", "sheetTable.col.hnf", 1.2, true, true),
    c("nnf", "sheetTable.col.nnf", 1.2, true, true),
    c("nf", "sheetTable.col.nf", 1.2, true, true),
    c("vf", "sheetTable.col.vf", 1.2, true, true),
    c("ff", "sheetTable.col.ff", 1.2, true, true),
    c("ngf", "sheetTable.col.ngf", 1.2, true, true),
    c("kf", "sheetTable.col.kf", 1.2, true, false),
    c("gf", "sheetTable.col.gf", 1.2, true, true),
    c("agf", "sheetTable.col.agf", 1.2, true, false),
    c("height", "sheetTable.col.floorHeight", 1.3, true, false),
    c("gv", "sheetTable.col.gv", 1.4, true, false),
    c("rooms", "sheetTable.col.roomCount", 1.1, true, false),
];

const ROOMS: &[Col] = &[
    c("name", "sheetTable.col.room", 3.0, false, true),
    c("group", "sheetTable.col.group", 2.0, false, false),
    c("count", "sheetTable.col.count", 1.1, true, false),
    c("targetArea", "sheetTable.col.targetArea", 1.5, true, false),
    c("soll", "sheetTable.col.soll", 1.4, true, true),
    c("ist", "sheetTable.col.ist", 1.4, true, true),
    c("diff", "sheetTable.col.diff", 1.4, true, true),
    c("diffPct", "sheetTable.col.diffPct", 1.3, true, false),
];

const ELEMENTS: &[Col] = &[
    c("kind", "sheetTable.col.kind", 1.4, false, true),
    c("type", "sheetTable.col.buildup", 4.0, false, true),
    c("floor", "openings.col.floor", 1.4, false, true),
    c("area", "sheetTable.col.area", 1.4, true, true),
    c("thickness", "sheetTable.col.thickness", 1.3, true, false),
    c("u", "openings.col.u", 1.3, true, true),
    c("ext", "openings.col.ext", 1.4, false, false),
];

const EARTHWORKS: &[Col] = &[
    c("name", "sheetTable.col.name", 2.4, false, true),
    c("bottom", "sheetTable.col.bottom", 1.3, true, true),
    c("area", "sheetTable.col.area", 1.3, true, true),
    c("cut", "sheetTable.col.cut", 1.4, true, true),
    c("fill", "sheetTable.col.fill", 1.4, true, true),
    c("backfill", "sheetTable.col.backfill", 1.6, true, true),
];

/// Schlüssel der Werttexte (Art, aussen/innen, Aufschlag …).
pub const VALUE_KEYS: &[&str] = &[
    "sheetTable.v.window",
    "sheetTable.v.door",
    "sheetTable.v.wall",
    "sheetTable.v.ceiling",
    "sheetTable.v.roof",
    "sheetTable.v.total",
    "sheetTable.v.noData",
    "openings.external",
    "openings.internal",
    "openings.hinge.start",
    "openings.hinge.end",
    "openings.swing.left",
    "openings.swing.right",
    "openings.dir.in",
    "openings.dir.out",
];

pub fn catalog(source: LayoutTableSource) -> &'static [Col] {
    match source {
        LayoutTableSource::Openings | LayoutTableSource::Unknown => OPENINGS,
        LayoutTableSource::Areas => AREAS,
        LayoutTableSource::Rooms => ROOMS,
        LayoutTableSource::Elements => ELEMENTS,
        LayoutTableSource::Earthworks => EARTHWORKS,
    }
}

/// Katalog als JSON für die UI: `{sources: {openings: [{id, key, numeric, default}]}, valueKeys: […]}`.
pub fn catalog_json() -> Value {
    let one = |s: &[Col]| s.iter().map(|k| json!({"id": k.id, "key": k.key, "numeric": k.numeric, "default": k.default})).collect::<Vec<_>>();
    json!({
        "sources": {"openings": one(OPENINGS), "areas": one(AREAS), "rooms": one(ROOMS), "elements": one(ELEMENTS), "earthworks": one(EARTHWORKS)},
        "valueKeys": VALUE_KEYS,
    })
}

/// Beschriftungen (Schlüssel → Text).
#[derive(Default)]
pub struct Labels(HashMap<String, String>);

impl Labels {
    pub fn parse(v: &Value) -> Labels {
        Labels(v.as_object().map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()).unwrap_or_default())
    }
    pub fn get(&self, key: &str) -> String {
        self.0.get(key).cloned().unwrap_or_else(|| key.rsplit('.').next().unwrap_or(key).to_string())
    }
}

fn num(n: f64, d: usize) -> Cell {
    Cell::Num { n: if n.is_finite() { Some(n) } else { None }, d }
}
fn txt(s: impl Into<String>) -> Cell {
    Cell::Text(s.into())
}
fn opt(s: &Option<String>) -> Cell {
    txt(s.clone().unwrap_or_default())
}

struct Data {
    rows: Vec<Vec<Cell>>,
    /// Letzte Zeile ist eine Summenzeile.
    total_last: bool,
}

fn openings_data(p: &Project, filter: Option<&str>, lb: &Labels) -> Data {
    let rows = crate::opening_schedule::opening_schedule(p)
        .into_iter()
        .filter(|r| match filter {
            Some("window") => r.kind == "window",
            Some("door") => r.kind == "door",
            _ => true,
        })
        .map(|r| {
            let rooms: Vec<&str> = [r.room_left.as_deref(), r.room_right.as_deref()].into_iter().flatten().collect();
            let swing = match (r.hinge, r.swing, r.dir) {
                (Some(h), Some(s), Some(d)) => format!("{} · {} · {}", lb.get(&format!("openings.hinge.{h}")), lb.get(&format!("openings.swing.{s}")), lb.get(&format!("openings.dir.{d}"))),
                _ => String::new(),
            };
            vec![
                txt(r.mark),
                txt(lb.get(if r.kind == "door" { "sheetTable.v.door" } else { "sheetTable.v.window" })),
                txt(r.type_name),
                txt(r.floor),
                txt(rooms.join(" ↔ ")),
                num(r.width, 2),
                num(r.height, 2),
                num(r.sill, 2),
                num(r.clear_width, 2),
                num(r.clear_height, 2),
                txt(swing),
                txt(r.fire_rating),
                txt(r.sound_class),
                Cell::Num { n: r.u_value, d: 2 },
                txt(r.burglary_class),
                txt(match r.external {
                    Some(true) => lb.get("openings.external"),
                    Some(false) => lb.get("openings.internal"),
                    None => String::new(),
                }),
                txt(r.notes),
            ]
        })
        .collect();
    Data { rows, total_last: false }
}

fn areas_data(p: &Project, lb: &Labels) -> Data {
    let t = crate::flaechen::area_table(p);
    let row = |r: &crate::flaechen::AreaRow, name: String| {
        vec![txt(name), num(r.hnf, 2), num(r.nnf, 2), num(r.nf, 2), num(r.vf, 2), num(r.ff, 2), num(r.ngf, 2), num(r.kf, 2), num(r.gf, 2), num(r.agf, 2), num(r.height, 2), num(r.gv, 1), num(r.rooms as f64, 0)]
    };
    let mut rows: Vec<Vec<Cell>> = t.levels.iter().map(|r| row(r, r.name.clone())).collect();
    rows.push(row(&t.total, lb.get("sheetTable.v.total")));
    Data { rows, total_last: true }
}

fn rooms_data(p: &Project) -> Data {
    let cmp = crate::room_program::compare(p);
    let rows = cmp
        .rows
        .iter()
        .map(|r| vec![txt(r.name.clone()), opt(&r.group), num(r.target_count as f64, 0), num(r.target_area, 2), num(r.soll, 2), num(r.ist, 2), num(r.diff, 2), Cell::Num { n: r.diff_pct.map(|v| v * 100.0), d: 1 }])
        .collect();
    Data { rows, total_last: false }
}

fn elements_data(p: &Project, lb: &Labels) -> Data {
    use crate::u_value::Kind;
    let rows = crate::u_value::element_schedule(p)
        .into_iter()
        .map(|r| {
            vec![
                txt(lb.get(match r.kind {
                    Kind::Wall => "sheetTable.v.wall",
                    Kind::Ceiling => "sheetTable.v.ceiling",
                    Kind::Roof => "sheetTable.v.roof",
                })),
                txt(r.type_name),
                txt(r.floor),
                num(r.area, 2),
                num(r.thickness * 100.0, 1),
                match r.u {
                    Some(u) => num(u, 2),
                    None => txt(lb.get("sheetTable.v.noData")),
                },
                txt(match r.external {
                    Some(true) => lb.get("openings.external"),
                    Some(false) => lb.get("openings.internal"),
                    None => String::new(),
                }),
            ]
        })
        .collect();
    Data { rows, total_last: false }
}

fn data_of(p: &Project, t: &LayoutTable, lb: &Labels) -> Data {
    match t.source {
        LayoutTableSource::Openings | LayoutTableSource::Unknown => openings_data(p, t.filter.as_deref(), lb),
        LayoutTableSource::Areas => areas_data(p, lb),
        LayoutTableSource::Rooms => rooms_data(p),
        LayoutTableSource::Elements => elements_data(p, lb),
        LayoutTableSource::Earthworks => earthworks_data(p, lb),
    }
}

/// [68] Erdarbeiten je Baugrube (m³ gegen das gewachsene Terrain) mit Summenzeile.
fn earthworks_data(p: &Project, lb: &Labels) -> Data {
    let q = crate::excavation::quantities(p);
    let mut rows: Vec<Vec<Cell>> = q.iter().map(|e| vec![txt(e.name.clone()), num(e.bottom, 2), num(e.bottom_area, 1), num(e.cut, 1), num(e.fill, 1), num(e.backfill, 1)]).collect();
    let total_last = q.len() > 1;
    if total_last {
        let s = |f: fn(&crate::excavation::ExQty) -> f64| q.iter().map(f).sum::<f64>();
        rows.push(vec![txt(lb.get("sheetTable.v.total")), num(f64::NAN, 2), num(s(|e| e.bottom_area), 1), num(s(|e| e.cut), 1), num(s(|e| e.fill), 1), num(s(|e| e.backfill), 1)]);
    }
    Data { rows, total_last }
}

/// Gewählte Spalten als Indizes in den Katalog (unbekannte Kennungen fallen weg; leer ⇒ Standard).
fn column_indices(t: &LayoutTable) -> Vec<usize> {
    let cat = catalog(t.source);
    let mut idx: Vec<usize> = t.columns.iter().flatten().filter_map(|id| cat.iter().position(|k| k.id == id.as_str())).collect();
    if idx.is_empty() {
        idx = cat.iter().enumerate().filter(|(_, k)| k.default).map(|(i, _)| i).collect();
    }
    idx
}

// ── Ausgabe ─────────────────────────────────────────────────────────────────

/// Zeichen-Primitiv in Papier-mm (y nach unten; Text: Grundlinie).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum TPrim {
    Text { x: f64, y: f64, s: String, size: f64, bold: bool, italic: bool, font: &'static str, align: &'static str },
    Line { x1: f64, y1: f64, x2: f64, y2: f64, w: f64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableOut {
    pub id: String,
    pub prims: Vec<TPrim>,
    /// Tatsächlich gezeichnete Höhe (mm).
    pub width_mm: f64,
    pub height_mm: f64,
    /// Zeilen der Quelle gesamt / in dieser Tabelle gezeigt / am Ende nicht untergebrachte (nur ohne Folgetabelle).
    pub total: usize,
    pub shown: usize,
    pub hidden: usize,
}

const PAD: f64 = 1.0;
const PT_MM: f64 = 0.352_777_8;

fn font_class(name: &str) -> &'static str {
    let n = name.to_lowercase();
    if n.contains("courier") || n.contains("mono") || n.contains("consolas") {
        "mono"
    } else if (n.contains("serif") && !n.contains("sans")) || n.contains("times") || n.contains("georgia") || n.contains("garamond") || n.contains("palatino") {
        "serif"
    } else {
        "sans"
    }
}

/// Schrift der Tabelle: (Familie, Grösse in mm, Rumpf fett, kursiv).
fn font_of(p: &Project, t: &LayoutTable) -> (&'static str, f64, bool, bool) {
    let marks = t.text_style_id.as_deref().and_then(|id| p.text_styles.as_deref()?.iter().find(|s| s.id == id)).map(|s| &s.marks);
    let pt = t.font_size_pt.filter(|v| v.is_finite() && *v > 0.0).or_else(|| marks.and_then(|m| m.size_pt)).unwrap_or(8.0).clamp(3.0, 72.0);
    (marks.and_then(|m| m.font.as_deref()).map_or("sans", font_class), pt * PT_MM, marks.and_then(|m| m.bold).unwrap_or(false), marks.and_then(|m| m.italic).unwrap_or(false))
}

fn cell_text(c: &Cell) -> String {
    match c {
        Cell::Text(s) => s.clone(),
        Cell::Num { n: None, .. } => "–".to_string(),
        Cell::Num { n: Some(n), d } => to_fixed(*n, *d),
    }
}

/// Text auf die Spaltenbreite kürzen (≈ 0.5 em je Zeichen, fett etwas breiter).
fn fit(s: &str, width: f64, size: f64, bold: bool) -> String {
    let per = size * if bold { 0.56 } else { 0.5 };
    let max = ((width - 2.0 * PAD) / per).floor().max(1.0) as usize;
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_string();
    }
    let mut out: String = chars[..max.saturating_sub(1)].iter().collect();
    out.push('…');
    out
}

fn row_height(t: &LayoutTable, size: f64) -> f64 {
    t.row_height_mm.filter(|v| v.is_finite() && *v > 0.5).unwrap_or(size * 1.9)
}

/// Zeilen, die in den Rahmen passen (`usize::MAX` ohne Höhe).
fn capacity(t: &LayoutTable, p: &Project) -> usize {
    let Some(h) = t.height_mm.filter(|v| v.is_finite() && *v > 0.0) else { return usize::MAX };
    let (_, size, _, _) = font_of(p, t);
    let rh = row_height(t, size);
    let head = if t.header.unwrap_or(true) { rh } else { 0.0 };
    ((h - head) / rh + 1e-9).floor().max(0.0) as usize
}

/// Anfang einer Fortsetzungs-Kette (bei Zyklus oder unbekanntem Verweis: die Tabelle selbst).
fn chain_head(tables: &[LayoutTable], i: usize) -> usize {
    let mut cur = i;
    for _ in 0..tables.len() {
        match tables[cur].continues.as_deref().and_then(|id| tables.iter().position(|t| t.id == id)) {
            Some(j) if j != i => cur = j,
            _ => return cur,
        }
    }
    i
}

/// Zeilen, die vorige Tabellen der Kette schon zeigen.
fn chain_offset(tables: &[LayoutTable], i: usize, p: &Project) -> usize {
    let mut off = 0usize;
    let mut cur = i;
    for _ in 0..tables.len() {
        match tables[cur].continues.as_deref().and_then(|id| tables.iter().position(|t| t.id == id)) {
            Some(j) if j != i => {
                off = off.saturating_add(capacity(&tables[j], p));
                cur = j;
            }
            _ => break,
        }
    }
    off
}

/// Alle Tabellen eines Layouts als Primitive.
pub fn render(p: &Project, layout: &Layout, lb: &Labels) -> Vec<TableOut> {
    let tables = layout.tables.as_deref().unwrap_or(&[]);
    let mut out = Vec::new();
    let mut cache: HashMap<usize, Data> = HashMap::new();
    for (i, t) in tables.iter().enumerate() {
        if !(t.width_mm.is_finite() && t.width_mm > 0.0 && t.x_mm.is_finite() && t.y_mm.is_finite()) {
            continue;
        }
        let head = chain_head(tables, i);
        let src = &tables[head];
        let data = cache.entry(head).or_insert_with(|| data_of(p, src, lb));
        let idx = column_indices(src);
        let cat = catalog(src.source);
        let (family, size, body_bold, italic) = font_of(p, t);
        let rh = row_height(t, size);
        let has_head = t.header.unwrap_or(true);
        let cap = capacity(t, p);
        let off = chain_offset(tables, i, p).min(data.rows.len());
        let end = off.saturating_add(cap).min(data.rows.len());
        let shown = end - off;
        let successor = tables.iter().any(|o| o.continues.as_deref() == Some(t.id.as_str()) && o.id != t.id);
        let hidden = if successor { 0 } else { data.rows.len() - end };

        let sum: f64 = idx.iter().map(|&k| cat[k].w).sum();
        let mut xs = vec![t.x_mm];
        for &k in &idx {
            xs.push(xs.last().unwrap() + cat[k].w / sum * t.width_mm);
        }
        let height = (if has_head { rh } else { 0.0 }) + shown as f64 * rh;
        let borders = t.borders.as_deref().unwrap_or("grid");
        let mut prims: Vec<TPrim> = Vec::new();
        let hline = |prims: &mut Vec<TPrim>, y: f64, w: f64| prims.push(TPrim::Line { x1: t.x_mm, y1: y, x2: t.x_mm + t.width_mm, y2: y, w });
        let base = |top: f64| top + rh / 2.0 + size * 0.35;
        let mut y = t.y_mm;
        let cell = |prims: &mut Vec<TPrim>, ci: usize, s: &str, top: f64, bold: bool| {
            let k = &cat[idx[ci]];
            let right = k.numeric;
            prims.push(TPrim::Text {
                x: if right { xs[ci + 1] - PAD } else { xs[ci] + PAD },
                y: base(top),
                s: fit(s, xs[ci + 1] - xs[ci], size, bold),
                size,
                bold,
                italic,
                font: family,
                align: if right { "r" } else { "l" },
            });
        };
        if has_head {
            for ci in 0..idx.len() {
                cell(&mut prims, ci, &lb.get(cat[idx[ci]].key), y, true);
            }
            y += rh;
        }
        for (n, row) in data.rows[off..end].iter().enumerate() {
            let is_total = data.total_last && off + n + 1 == data.rows.len();
            for ci in 0..idx.len() {
                let s = row.get(idx[ci]).map(cell_text).unwrap_or_default();
                cell(&mut prims, ci, &s, y, body_bold || is_total);
            }
            if is_total && borders != "none" {
                hline(&mut prims, y, 0.35);
            }
            y += rh;
        }
        // Linien.
        let (top, bottom) = (t.y_mm, t.y_mm + height);
        if borders != "none" && height > 0.0 {
            let first = t.y_mm + if has_head { rh } else { 0.0 };
            match borders {
                "outer" => {
                    prims.push(TPrim::Line { x1: t.x_mm, y1: top, x2: t.x_mm + t.width_mm, y2: top, w: 0.35 });
                    prims.push(TPrim::Line { x1: t.x_mm, y1: bottom, x2: t.x_mm + t.width_mm, y2: bottom, w: 0.35 });
                    prims.push(TPrim::Line { x1: t.x_mm, y1: top, x2: t.x_mm, y2: bottom, w: 0.35 });
                    prims.push(TPrim::Line { x1: t.x_mm + t.width_mm, y1: top, x2: t.x_mm + t.width_mm, y2: bottom, w: 0.35 });
                    if has_head {
                        hline(&mut prims, first, 0.35);
                    }
                }
                _ => {
                    let grid = borders == "grid";
                    hline(&mut prims, top, 0.35);
                    hline(&mut prims, bottom, 0.35);
                    if has_head {
                        hline(&mut prims, first, 0.35);
                    }
                    for n in 1..shown {
                        hline(&mut prims, first + n as f64 * rh, 0.12);
                    }
                    if grid {
                        for (k, x) in xs.iter().enumerate() {
                            let edge = k == 0 || k + 1 == xs.len();
                            prims.push(TPrim::Line { x1: *x, y1: top, x2: *x, y2: bottom, w: if edge { 0.35 } else { 0.12 } });
                        }
                    }
                }
            }
        }
        out.push(TableOut { id: t.id.clone(), prims, width_mm: t.width_mm, height_mm: height, total: data.rows.len(), shown, hidden });
    }
    out
}

/// Abfrage `sheetTables`: `text` = JSON `{"layoutId": …, "labels": {Schlüssel: Text}}`.
pub fn query(p: &Project, text: &str) -> Value {
    let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let id = v["layoutId"].as_str().unwrap_or("");
    let lb = Labels::parse(&v["labels"]);
    match p.layouts.iter().flatten().find(|l| l.id == id) {
        Some(l) => serde_json::to_value(render(p, l, &lb)).unwrap_or(Value::Null),
        None => json!([]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(id: &str, pos: f64) -> Opening {
        Opening { id: id.into(), host_wall_id: "w".into(), kind: ElementKind::Window, position: pos, width: 1.0, height: 1.2, ..Default::default() }
    }

    fn project(n: usize, tables: Vec<LayoutTable>) -> Project {
        let mut p = Project::default();
        p.drawing_levels = vec![DrawingLevel { id: "eg".into(), name: "EG".into(), kind: DrawingLevelKind::Floor, ..Default::default() }];
        p.wall_types = vec![WallType { id: "wt".into(), name: "W".into(), layers: vec![Layer { thickness: 0.3, ..Default::default() }], ..Default::default() }];
        p.walls = vec![Wall { id: "w".into(), floor_id: "eg".into(), start: Vec2 { x: 0.0, y: 0.0 }, end: Vec2 { x: 50.0, y: 0.0 }, wall_type_id: "wt".into(), height: 2.6, ..Default::default() }];
        p.openings = Some((0..n).map(|i| win(&format!("f{i}"), 1.0 + 2.0 * i as f64)).collect());
        p.layouts = Some(vec![Layout { id: "L".into(), name: "Blatt".into(), tables: Some(tables), ..Default::default() }]);
        p
    }

    fn table(id: &str, h: Option<f64>) -> LayoutTable {
        LayoutTable { id: id.into(), source: LayoutTableSource::Openings, x_mm: 10.0, y_mm: 20.0, width_mm: 150.0, height_mm: h, ..Default::default() }
    }

    fn texts(o: &TableOut) -> Vec<String> {
        o.prims.iter().filter_map(|p| if let TPrim::Text { s, .. } = p { Some(s.clone()) } else { None }).collect()
    }

    fn lb() -> Labels {
        Labels::parse(&json!({"openings.col.mark": "Nr.", "openings.col.type": "Typ"}))
    }

    #[test]
    fn waechst_mit_dem_modell() {
        let mut p = project(2, vec![table("t", None)]);
        let a = render(&p, &p.layouts.as_ref().unwrap()[0], &lb());
        assert_eq!((a[0].total, a[0].shown, a[0].hidden), (2, 2, 0));
        assert!(texts(&a[0]).contains(&"Nr.".to_string()), "Kopf beschriftet");
        assert!(texts(&a[0]).contains(&"F1.02".to_string()));
        // Ein weiteres Fenster: die Tabelle wird länger.
        p.openings.as_mut().unwrap().push(win("neu", 9.0));
        let b = render(&p, &p.layouts.as_ref().unwrap()[0], &lb());
        assert_eq!(b[0].shown, 3);
        assert!(b[0].height_mm > a[0].height_mm);
        assert!(texts(&b[0]).contains(&"F1.03".to_string()));
    }

    #[test]
    fn aufteilen_ueber_mehrere_rahmen() {
        // 8 pt → Zeile 5.37 mm; Rahmen 25 mm = Kopf + 3 Zeilen.
        let mut t2 = table("t2", Some(25.0));
        t2.continues = Some("t1".into());
        t2.x_mm = 170.0;
        let p = project(7, vec![table("t1", Some(25.0)), t2]);
        let r = render(&p, &p.layouts.as_ref().unwrap()[0], &lb());
        assert_eq!((r[0].shown, r[0].hidden), (3, 0), "Folgetabelle vorhanden: nichts verloren gemeldet");
        assert_eq!((r[1].shown, r[1].hidden), (3, 1), "Rest 1 Zeile passt nicht mehr");
        assert!(texts(&r[1]).contains(&"F1.04".to_string()) && !texts(&r[1]).contains(&"F1.03".to_string()));
        assert!(texts(&r[1]).contains(&"Nr.".to_string()), "Kopf wiederholt");
    }

    #[test]
    fn spaltenwahl_filter_und_unbekanntes() {
        let mut t = table("t", None);
        t.columns = Some(vec!["mark".into(), "nope".into(), "width".into()]);
        t.filter = Some("door".into());
        let p = project(2, vec![t]);
        let r = render(&p, &p.layouts.as_ref().unwrap()[0], &lb());
        assert_eq!(r[0].total, 0, "keine Türen");
        assert_eq!(texts(&r[0]).len(), 2, "nur Kopf: Nr. + Breite-Schlüssel");
    }

    #[test]
    fn zahlen_rechts_text_links_und_kuerzen() {
        let mut p = project(1, vec![table("t", None)]);
        p.openings.as_mut().unwrap()[0].notes = Some("x".repeat(80));
        p.layouts.as_mut().unwrap()[0].tables.as_mut().unwrap()[0].columns = Some(vec!["notes".into(), "width".into()]);
        let r = render(&p, &p.layouts.as_ref().unwrap()[0], &lb());
        let rows: Vec<&TPrim> = r[0].prims.iter().filter(|x| matches!(x, TPrim::Text { .. })).collect();
        match (rows[2], rows[3]) {
            (TPrim::Text { s, align: a1, .. }, TPrim::Text { s: s2, align: a2, .. }) => {
                assert!(s.ends_with('…') && s.chars().count() < 80);
                assert_eq!((*a1, *a2, s2.as_str()), ("l", "r", "1.00"));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn quellen_flaechen_bauteile_und_zyklus() {
        let mut a = table("a", None);
        a.source = LayoutTableSource::Areas;
        let mut e = table("e", None);
        e.source = LayoutTableSource::Elements;
        // Zyklus: a ↔ b darf nicht hängen.
        let mut x = table("x", Some(30.0));
        x.continues = Some("y".into());
        let mut y = table("y", Some(30.0));
        y.continues = Some("x".into());
        let p = project(1, vec![a, e, x, y]);
        let r = render(&p, &p.layouts.as_ref().unwrap()[0], &lb());
        assert_eq!(r.len(), 4);
        assert_eq!(r[1].total, 1, "eine Wand");
        assert!(r[0].total >= 1, "Summenzeile");
    }

    #[test]
    fn ohne_tabellen_und_abfrage() {
        let p = project(1, vec![]);
        assert!(render(&p, &p.layouts.as_ref().unwrap()[0], &lb()).is_empty());
        assert_eq!(query(&p, r#"{"layoutId":"nix"}"#), json!([]));
        assert!(catalog_json()["sources"]["elements"].as_array().unwrap().len() >= 6);
    }
}
