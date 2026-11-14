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

/// [158] Raumbuch: Oberflächen je Raum.
const ROOM_BOOK: &[Col] = &[
    c("floor", "openings.col.floor", 1.2, false, true),
    c("number", "roomBook.col.number", 1.0, false, true),
    c("name", "sheetTable.col.room", 2.4, false, true),
    c("area", "sheetTable.col.area", 1.2, true, true),
    c("usage", "roomBook.col.usage", 1.6, false, true),
    c("floorFinish", "roomBook.col.floorFinish", 2.4, false, true),
    c("wallFinish", "roomBook.col.wallFinish", 2.4, false, true),
    c("ceilingFinish", "roomBook.col.ceilingFinish", 2.4, false, true),
    c("buildUp", "roomBook.col.buildUp", 3.0, false, false),
    c("clearHeight", "roomBook.col.clearHeight", 1.2, true, false),
    c("heightMin", "roomBook.col.heightMin", 1.2, true, true),
    c("heightMean", "roomBook.col.heightMean", 1.2, true, true),
    c("areaUnder1", "roomBook.col.areaUnder1", 1.3, true, true),
    c("area1To15", "roomBook.col.area1To15", 1.3, true, true),
    c("wallArea", "roomBook.col.wallArea", 1.3, true, false),
    c("reveals", "roomBook.col.reveals", 1.2, true, false),
    c("skirting", "roomBook.col.skirting", 1.2, true, false),
    c("perimeter", "roomBook.col.perimeter", 1.2, true, false),
    c("wet", "roomBook.col.wet", 1.0, false, false),
];

/// [209] Kostenschätzung grob.
const COSTS: &[Col] = &[
    c("code", "sheetTable.col.costCode", 0.9, false, true),
    c("group", "sheetTable.col.costGroup", 3.6, false, true),
    c("quantity", "sheetTable.col.quantity", 1.4, true, true),
    c("unit", "sheetTable.col.unit", 0.8, false, true),
    c("rate", "sheetTable.col.rate", 1.3, true, true),
    c("amount", "sheetTable.col.amount", 1.8, true, true),
];

/// [255] Baurecht-Nachweis.
const SITE_PROOF: &[Col] = &[
    c("item", "siteProof.col.item", 4.6, false, true),
    c("allowed", "siteProof.col.allowed", 1.4, true, true),
    c("actual", "siteProof.col.actual", 1.4, true, true),
    c("reserve", "siteProof.col.reserve", 1.8, true, true),
    c("ok", "siteProof.col.ok", 1.0, false, true),
];

/// [158] Raumbuch-Spalten, die nur erscheinen, wenn ein Raum eine Dachschräge hat.
const SLOPE_COLS: &[&str] = &["heightMin", "heightMean", "areaUnder1", "area1To15"];

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
    "roomBook.usage.living",
    "roomBook.usage.sleeping",
    "roomBook.usage.kitchen",
    "roomBook.usage.dining",
    "roomBook.usage.bath",
    "roomBook.usage.wc",
    "roomBook.usage.shower",
    "roomBook.usage.laundry",
    "roomBook.usage.circulation",
    "roomBook.usage.technical",
    "roomBook.usage.storage",
    "roomBook.usage.office",
    "roomBook.usage.other",
    "roomBook.wet",
    "costs.group.B",
    "costs.group.C",
    "costs.group.D",
    "costs.group.E",
    "costs.group.F",
    "costs.group.G",
    "costs.group.H",
    "costs.group.I",
    "costs.group.J",
    "costs.row.subtotal",
    "costs.row.fees",
    "costs.row.reserve",
    "costs.row.net",
    "costs.row.vat",
    "costs.row.gross",
    "costs.lump",
    "siteProof.ok.yes",
    "siteProof.ok.no",
    "siteProof.none",
    "siteProof.row.gfz",
    "siteProof.row.az",
    "siteProof.row.bmz",
    "siteProof.row.uz",
    "siteProof.row.gz",
    "siteProof.row.totalHeight",
    "siteProof.row.facadeHeight",
    "siteProof.row.setback",
    "siteProof.row.profile",
];

pub fn catalog(source: LayoutTableSource) -> &'static [Col] {
    match source {
        LayoutTableSource::Openings | LayoutTableSource::Unknown => OPENINGS,
        LayoutTableSource::Areas => AREAS,
        LayoutTableSource::Rooms => ROOMS,
        LayoutTableSource::Elements => ELEMENTS,
        LayoutTableSource::Earthworks => EARTHWORKS,
        LayoutTableSource::RoomBook => ROOM_BOOK,
        LayoutTableSource::Costs => COSTS,
        LayoutTableSource::SiteProof => SITE_PROOF,
    }
}

/// Katalog als JSON für die UI: `{sources: {openings: [{id, key, numeric, default}]}, valueKeys: […]}`.
pub fn catalog_json() -> Value {
    let one = |s: &[Col]| s.iter().map(|k| json!({"id": k.id, "key": k.key, "numeric": k.numeric, "default": k.default})).collect::<Vec<_>>();
    json!({
        "sources": {"openings": one(OPENINGS), "areas": one(AREAS), "rooms": one(ROOMS), "elements": one(ELEMENTS), "earthworks": one(EARTHWORKS), "roomBook": one(ROOM_BOOK), "costs": one(COSTS), "siteProof": one(SITE_PROOF)},
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
    Cell::Num { n: if n.is_finite() { Some(n) } else { None }, d, g: false }
}
fn txt(s: impl Into<String>) -> Cell {
    Cell::Text(s.into())
}
fn opt(s: &Option<String>) -> Cell {
    txt(s.clone().unwrap_or_default())
}

struct Data {
    rows: Vec<Vec<Cell>>,
    /// Raumbuch: mindestens ein Raum hat eine Dachschräge; ohne fallen die Spalten der Höhenbereiche weg.
    sloped: bool,
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
                Cell::Num { n: r.u_value, d: 2, g: false },
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
    Data { rows, sloped: false, total_last: false }
}

fn areas_data(p: &Project, lb: &Labels) -> Data {
    let t = crate::flaechen::area_table(p);
    let row = |r: &crate::flaechen::AreaRow, name: String| {
        vec![txt(name), num(r.hnf, 2), num(r.nnf, 2), num(r.nf, 2), num(r.vf, 2), num(r.ff, 2), num(r.ngf, 2), num(r.kf, 2), num(r.gf, 2), num(r.agf, 2), num(r.height, 2), num(r.gv, 1), num(r.rooms as f64, 0)]
    };
    let mut rows: Vec<Vec<Cell>> = t.levels.iter().map(|r| row(r, r.name.clone())).collect();
    rows.push(row(&t.total, lb.get("sheetTable.v.total")));
    Data { rows, sloped: false, total_last: true }
}

fn rooms_data(p: &Project) -> Data {
    let cmp = crate::room_program::compare(p);
    let rows = cmp
        .rows
        .iter()
        .map(|r| vec![txt(r.name.clone()), opt(&r.group), num(r.target_count as f64, 0), num(r.target_area, 2), num(r.soll, 2), num(r.ist, 2), num(r.diff, 2), Cell::Num { n: r.diff_pct.map(|v| v * 100.0), d: 1, g: false }])
        .collect();
    Data { rows, sloped: false, total_last: false }
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
    Data { rows, sloped: false, total_last: false }
}

fn data_of(p: &Project, t: &LayoutTable, lb: &Labels) -> Data {
    match t.source {
        LayoutTableSource::Openings | LayoutTableSource::Unknown => openings_data(p, t.filter.as_deref(), lb),
        LayoutTableSource::Areas => areas_data(p, lb),
        LayoutTableSource::Rooms => rooms_data(p),
        LayoutTableSource::Elements => elements_data(p, lb),
        LayoutTableSource::Earthworks => earthworks_data(p, lb),
        LayoutTableSource::RoomBook => room_book_data(p, lb),
        LayoutTableSource::Costs => costs_data(p, lb),
        LayoutTableSource::SiteProof => site_proof_data(p, lb),
    }
}

/// [158] Raumbuch: eine Zeile je Raum (Reihenfolge wie `room_book`).
fn room_book_data(p: &Project, lb: &Labels) -> Data {
    let book = crate::room_book::room_book(p);
    let sloped = book.rows.iter().any(|r| r.area_under_1 + r.area_1_to_15 > 1e-9);
    let rows = book
        .rows
        .into_iter()
        .map(|r| {
            vec![
                txt(r.floor),
                txt(r.number),
                txt(r.name),
                num(r.area, 2),
                txt(if r.usage.is_empty() { String::new() } else { lb.get(&format!("roomBook.usage.{}", r.usage)) }),
                txt(r.floor_finish),
                txt(r.wall_finish),
                txt(r.ceiling_finish),
                txt(r.floor_build_up),
                num(r.clear_height, 2),
                num(r.height_min, 2),
                num(r.height_mean, 2),
                num(r.area_under_1, 2),
                num(r.area_1_to_15, 2),
                num(r.wall_area, 2),
                num(r.reveal_area, 2),
                num(r.skirting, 2),
                num(r.perimeter, 2),
                txt(if r.wet { lb.get("roomBook.wet") } else { String::new() }),
            ]
        })
        .collect();
    Data { rows, sloped, total_last: false }
}

/// [209] Kostenschätzung: eine Zeile je Kennwert, dann Summe B–J, Honorare, Reserve, Total exkl. MwSt, MwSt und
/// Total inkl. MwSt mit Genauigkeit (Summenzeile). Beträge in CHF mit Tausender-Apostroph.
fn costs_data(p: &Project, lb: &Labels) -> Data {
    let r = crate::kosten::estimate(p);
    let chf = |n: f64| Cell::Num { n: if n.is_finite() { Some(n) } else { None }, d: 0, g: true };
    let empty = || txt("");
    let mut rows: Vec<Vec<Cell>> = r
        .rows
        .iter()
        .map(|g| {
            let name = g.name.clone().unwrap_or_else(|| lb.get(&format!("costs.group.{}", g.code)));
            let unit = if g.unit.is_empty() { lb.get("costs.lump") } else { g.unit.to_string() };
            vec![txt(g.code.clone()), txt(name), Cell::Num { n: Some(g.quantity), d: if g.unit.is_empty() { 0 } else { 1 }, g: true }, txt(unit), chf(g.rate), chf(g.amount)]
        })
        .collect();
    let pct = |label: &str, v: f64| format!("{} {} %", lb.get(label), to_fixed(v, 1).trim_end_matches(".0"));
    rows.push(vec![empty(), txt(lb.get("costs.row.subtotal")), empty(), empty(), empty(), chf(r.subtotal)]);
    rows.push(vec![txt("V"), txt(pct("costs.row.fees", r.fees_pct)), empty(), empty(), empty(), chf(r.fees)]);
    rows.push(vec![txt("Y"), txt(pct("costs.row.reserve", r.reserve_pct)), empty(), empty(), empty(), chf(r.reserve)]);
    rows.push(vec![empty(), txt(lb.get("costs.row.net")), empty(), empty(), empty(), chf(r.net)]);
    rows.push(vec![txt("Z"), txt(pct("costs.row.vat", r.vat_pct)), empty(), empty(), empty(), chf(r.vat)]);
    rows.push(vec![empty(), txt(format!("{} (±{} %)", lb.get("costs.row.gross"), to_fixed(r.accuracy_pct, 0))), empty(), empty(), empty(), chf(r.gross)]);
    Data { rows, sloped: false, total_last: true }
}

/// [255] Baurecht-Nachweis: eine Zeile je Prüfgrösse; fehlende Vorgabe/Projektwert als „—“. Ohne Angaben aus dem
/// Dokument (IVHB-Optionen) rechnet der Nachweis mit Parzellenfläche bzw. Parzellengrenze.
fn site_proof_data(p: &Project, lb: &Labels) -> Data {
    let pr = crate::site_proof::site_proof(p, &Default::default());
    let dash = || txt(lb.get("siteProof.none"));
    let val = |v: Option<f64>, d: usize| v.filter(|x| x.is_finite()).map_or_else(dash, |x| num(x, d));
    let rows = pr
        .rows
        .iter()
        .map(|r| {
            let ok = match r.ok {
                Some(true) => txt(lb.get("siteProof.ok.yes")),
                Some(false) => txt(lb.get("siteProof.ok.no")),
                None => dash(),
            };
            vec![txt(lb.get(&format!("siteProof.row.{}", r.key))), val(r.allowed, r.decimals), val(r.actual, r.decimals), val(r.reserve, r.decimals), ok]
        })
        .collect();
    Data { rows, sloped: false, total_last: false }
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
    Data { rows, sloped: false, total_last }
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
        Cell::Num { n: Some(n), d, g } => crate::area_report::fmt_num(*n, *d, *g),
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
        let cat = catalog(src.source);
        let mut idx = column_indices(src);
        if src.source == LayoutTableSource::RoomBook && !data.sloped {
            let keep: Vec<usize> = idx.iter().copied().filter(|&k| !SLOPE_COLS.contains(&cat[k].id)).collect();
            if !keep.is_empty() {
                idx = keep;
            }
        }
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

    /// [158] Raumbuch als Blatt-Tabelle: Standard-Spalten, Nutzung beschriftet, Material-Name.
    #[test]
    fn raumbuch_tabelle() {
        let mut t = table("rb", None);
        t.source = LayoutTableSource::RoomBook;
        let mut p = project(0, vec![t]);
        p.components = vec![Component { id: "par".into(), name: "Parkett".into(), ..Default::default() }];
        p.rooms = Some(vec![Room {
            id: "r".into(),
            floor_id: "eg".into(),
            name: "Wohnen".into(),
            usage: Some(RoomUsage::Living),
            floor_finish: Some("par".into()),
            wall_finish: Some("Abrieb".into()),
            boundary: vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 4.0, y: 0.0 }, Vec2 { x: 4.0, y: 5.0 }, Vec2 { x: 0.0, y: 5.0 }],
            stamp: Some(RoomStamp { number: Some("0.01".into()), name: "Wohnen".into(), ..Default::default() }),
            ..Default::default()
        }]);
        let lb = Labels::parse(&json!({"roomBook.usage.living": "WOHN", "roomBook.col.floorFinish": "Boden"}));
        let r = render(&p, &p.layouts.as_ref().unwrap()[0], &lb);
        assert_eq!(r[0].total, 1);
        let tx = texts(&r[0]);
        for s in ["Boden", "EG", "0.01", "Wohnen", "20.00", "WOHN", "Parkett", "Abrieb"] {
            assert!(tx.contains(&s.to_string()), "{s}: {tx:?}");
        }
        assert_eq!(catalog_json()["sources"]["roomBook"].as_array().unwrap().iter().filter(|c| c["default"] == true).count(), 12);
        assert_eq!(serde_json::to_value(LayoutTableSource::RoomBook).unwrap(), "roomBook");
    }

    /// [158] Neue Raumbuch-Spalten: Leibungen/Sockel immer, Höhenbereiche nur mit Dachschräge.
    #[test]
    fn raumbuch_spalten_schraege_leibung_sockel() {
        let mut t = table("rb", None);
        t.source = LayoutTableSource::RoomBook;
        t.columns = Some(vec!["name".into(), "heightMin".into(), "areaUnder1".into(), "reveals".into(), "skirting".into()]);
        let mut p = project(0, vec![t]);
        let sq = vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 4.0, y: 0.0 }, Vec2 { x: 4.0, y: 4.0 }, Vec2 { x: 0.0, y: 4.0 }];
        p.rooms = Some(vec![Room { id: "r".into(), floor_id: "eg".into(), name: "Studio".into(), boundary: sq, ..Default::default() }]);
        let lb = Labels::parse(&json!({"roomBook.col.heightMin": "HMIN", "roomBook.col.reveals": "LEIB", "roomBook.col.skirting": "SOCK"}));
        let tx = texts(&render(&p, &p.layouts.as_ref().unwrap()[0], &lb)[0]);
        assert!(tx.contains(&"LEIB".to_string()) && tx.contains(&"SOCK".to_string()), "{tx:?}");
        assert!(!tx.contains(&"HMIN".to_string()), "ohne Schräge keine Höhenbereiche: {tx:?}");
        assert!(tx.contains(&"16.00".to_string()), "Sockel = Umfang: {tx:?}");
        // Mit Dach: Spalte erscheint, Fläche < 1.0 m ist > 0.
        p.drawing_levels.iter_mut().for_each(|l| l.floor_height = Some(3.0));
        let roof: Roof = serde_json::from_value(json!({ "id": "d", "type": "roof", "floorId": "eg", "categoryCode": "50",
            "outline": [{"x": 0, "y": 0}, {"x": 4, "y": 0}, {"x": 4, "y": 4}, {"x": 0, "y": 4}],
            "shape": "sattel", "pitchDeg": 45.0, "thickness": 0.0, "baseElevation": 0.0 })).unwrap();
        p.roofs = Some(vec![roof]);
        let tx = texts(&render(&p, &p.layouts.as_ref().unwrap()[0], &lb)[0]);
        assert!(tx.contains(&"HMIN".to_string()), "{tx:?}");
    }

    #[test]
    fn ohne_tabellen_und_abfrage() {
        let p = project(1, vec![]);
        assert!(render(&p, &p.layouts.as_ref().unwrap()[0], &lb()).is_empty());
        assert_eq!(query(&p, r#"{"layoutId":"nix"}"#), json!([]));
        assert!(catalog_json()["sources"]["elements"].as_array().unwrap().len() >= 6);
    }

    /// [209] Kostenschätzung als Blatt-Tabelle: Gruppen beschriftet, Franken mit Apostroph, Total als Summenzeile.
    #[test]
    fn kosten_tabelle() {
        let mut t = table("k", None);
        t.source = LayoutTableSource::Costs;
        let mut p = project(0, vec![t]);
        p.drawing_levels[0].floor_height = Some(3.0);
        let r = render(&p, &p.layouts.as_ref().unwrap()[0], &Labels::parse(&json!({"costs.group.C": "Konstruktion", "costs.row.gross": "Total inkl. MwSt."})));
        assert_eq!(r[0].total, 9 + 6, "9 Hauptgruppen + Summe, V, Y, exkl., MwSt, inkl.");
        let tx = texts(&r[0]);
        assert!(tx.contains(&"Konstruktion".to_string()), "{tx:?}");
        let gross = crate::kosten::estimate(&p).gross;
        assert!(gross > 1000.0);
        assert!(tx.contains(&crate::area_report::fmt_num(gross, 0, true)), "{tx:?}");
        assert!(tx.iter().any(|s| s.starts_with("Total inkl. MwSt. (±15 %)")), "{tx:?}");
        assert_eq!(serde_json::to_value(LayoutTableSource::Costs).unwrap(), "costs");
        assert_eq!(crate::area_report::fmt_num(1234567.5, 2, true), "1'234'567.50");
        assert_eq!(crate::area_report::fmt_num(-999.0, 0, true), "-999");
        assert_eq!(crate::area_report::fmt_num(-1000.0, 0, true), "-1'000");
    }
    /// [255] Baurecht-Nachweis als Blatt-Tabelle: ohne Vorgaben überall „—“, mit Vorgabe zulässig/Projekt/Reserve/ja-nein.
    #[test]
    fn baurecht_nachweis_tabelle() {
        let mut t = table("n", None);
        t.source = LayoutTableSource::SiteProof;
        let mut p = project(0, vec![t]);
        p.parcel_area = Some(400.0);
        let lb = Labels::parse(&json!({"siteProof.none": "—", "siteProof.ok.yes": "ja", "siteProof.ok.no": "nein", "siteProof.row.az": "AZ", "siteProof.row.totalHeight": "Gesamthöhe"}));
        let r = render(&p, &p.layouts.as_ref().unwrap()[0], &lb);
        assert_eq!(r[0].total, 8, "7 Ziffern/Höhen + Grenzabstand");
        let tx = texts(&r[0]);
        assert!(tx.contains(&"AZ".to_string()) && tx.contains(&"—".to_string()), "{tx:?}");
        assert!(!tx.contains(&"ja".to_string()) && !tx.contains(&"nein".to_string()), "ohne Vorgaben nichts erfüllt/verletzt: {tx:?}");
        // Mit Vorgabe AZ 0.001 (überschritten, falls das Projekt Flächen hat) bzw. Höhe 100 m.
        let mut rules = crate::model::SiteRules::default();
        rules.max_height = Some(100.0);
        p.site_rules = Some(rules);
        let tx = texts(&render(&p, &p.layouts.as_ref().unwrap()[0], &lb)[0]);
        assert!(tx.contains(&"100.00".to_string()), "{tx:?}");
        assert_eq!(serde_json::to_value(LayoutTableSource::SiteProof).unwrap(), "siteProof");
        assert!(catalog_json()["sources"]["siteProof"].as_array().unwrap().len() == 5);
    }
}
