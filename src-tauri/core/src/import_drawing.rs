//! Zeichnungs-Import ([K4] S4, vorher `io/dxfParser.ts::decodeImport`, `io/dxfToDrawings.ts`,
//! `io/pdfVector.ts::pdfPageToImport`, `io/pdfLineStyles.ts`, `ui/ImportDialog.tsx::buildDrawings` und
//! `state/useProjectFileActions.ts::runImport`): das Format-Modul (`src-tauri/fileio`, eigenes WASM) liest
//! DXF/DWG bzw. eine PDF-Seite in einen flachen Puffer + String-Tabelle; hier wird daraus die Import-Form
//! ([`DrawingImport`]: Konturen, Texte, Meshes, Ebenenfarben …), die Zusammenfassung für den Dialog
//! ([`summary_json`]) und die Ops, die alles ins Projekt bringen ([`import_ops`]): neue Zeichnungsebene,
//! Kategorien je DXF-Layer, Linienstile der PDF-Strichmuster, 2D-Zeichnungen, Kontext-Meshes — als EINE
//! Op-Folge (ein Undo-Schritt).
//!
//! Aufbau des Puffers: `fileio/src/import.rs::encode` (Version 3) bzw. `fileio/src/pdf_vector.rs::encode`
//! (Version 2). Grosse ASCII-DXF liest die App in mehreren Stücken parallel; jedes Stück ist ein eigener
//! Puffer (`chunks`), die Teilergebnisse werden wie früher in TS zusammengeführt.
//!
//! Zahlen und Texte wie in der TS-Fassung (`Math.round`, `toFixed`, `String(n)`, ids aus Zeit + Zähler),
//! Schlüsselreihenfolge der erzeugten Objekte wie die früheren Objekt-Literale.

use crate::grips::js_num;
use crate::js_fmt::{js_number, to_fixed};
use crate::jsnum;
use crate::ops::Op;
use serde_json::{json, Map, Value};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};

/// Kategorie generischer Importe (`GENERIC_IMPORT_CATEGORY`, „10 Situation").
pub const GENERIC_IMPORT_CODE: &str = "10";
/// Füllfarbe aus HATCH importierter Flächen (`DXF_HATCH_FILL`).
const DXF_HATCH_FILL: &str = "#c8c8c8";
/// Papier-Millimeter je PDF-Punkt.
pub const PT_TO_MM: f64 = 25.4 / 72.0;

thread_local! {
    /// Laufnummer der erzeugten ids (wie die Modul-Zähler der TS-Fassung).
    static SEQ: Cell<u64> = const { Cell::new(0) };
}

/// Nächste Laufnummer für ids.
pub fn next_seq() -> u64 {
    SEQ.with(|s| {
        let v = s.get();
        s.set(v + 1);
        v
    })
}

/// Zeitstempel als Text wie `${Date.now()}` (ganze ms).
pub fn now_text(now: f64) -> String {
    js_number(if now.is_finite() { now.trunc() } else { 0.0 })
}

/// `#rrggbb` aus einer Zahl (`(c & 0xffffff).toString(16).padStart(6, "0")`).
pub fn hex_color(c: f64) -> String {
    format!("#{:06x}", jsnum::to_int32(c) & 0xffffff)
}

// ── Import-Form ──────────────────────────────────────────────────────────────

/// Echte Kurve einer Kontur (CIRCLE/ARC bzw. aus Bézier-Folgen erkannt).
#[derive(Clone, Debug)]
pub struct Curve {
    pub circle: bool,
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
    pub a0: f64,
    pub a1: f64,
}

#[derive(Clone, Debug)]
pub struct Contour {
    pub layer: String,
    /// Höhe (in 2D-Zeichnungen ohne Bedeutung).
    pub z: f64,
    pub closed: bool,
    pub filled: bool,
    pub curve: Option<Curve>,
    pub pts: Vec<[f64; 2]>,
    /// Polylinie mit Bögen: Stützpunkte + DXF-Bulge je Stützpunkt.
    pub bulge: Option<(Vec<[f64; 2]>, Vec<f64>)>,
}

#[derive(Clone, Debug)]
pub struct Text {
    pub layer: String,
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub height: f64,
    pub angle: f64,
}

#[derive(Clone, Debug)]
pub struct Mesh {
    pub id: String,
    pub name: String,
    pub layer: String,
    pub positions: Vec<f64>,
    pub indices: Vec<f64>,
}

/// Ergebnis eines Zeichnungs-Imports (vorher `DxfImportResult`).
#[derive(Clone, Debug, Default)]
pub struct DrawingImport {
    pub contours: Vec<Contour>,
    pub texts: Vec<Text>,
    pub meshes: Vec<Mesh>,
    /// Farbe je Layer (Reihenfolge wie ein JS-Objekt mit Zuweisung).
    pub layer_colors: Map<String, Value>,
    pub layer_line_weights: Map<String, Value>,
    pub layer_fill_colors: Map<String, Value>,
    pub layer_dashes: Vec<(String, Vec<f64>)>,
    pub entity_counts: Map<String, Value>,
    pub total: f64,
    pub ins_units: Option<f64>,
    pub unit_scale: Option<f64>,
    pub layouts: Option<Vec<(String, f64)>>,
    pub layout: Option<String>,
    pub recovered: bool,
}

struct Rd<'a> {
    g: &'a [f64],
    s: &'a [String],
    i: usize,
}

impl Rd<'_> {
    fn num(&mut self) -> Result<f64, String> {
        let v = *self.g.get(self.i).ok_or("Importpuffer zu kurz")?;
        self.i += 1;
        Ok(v)
    }
    fn count(&mut self) -> Result<usize, String> {
        let v = self.num()?;
        if v.is_finite() && v >= 0.0 && v.fract() == 0.0 && (v as usize) <= self.g.len() {
            Ok(v as usize)
        } else if v.is_finite() && v <= 0.0 {
            Ok(0)
        } else {
            Err("Importpuffer beschädigt".into())
        }
    }
    fn str(&mut self) -> Result<String, String> {
        let k = self.num()?;
        Ok(if k >= 0.0 && k.fract() == 0.0 { self.s.get(k as usize).cloned().unwrap_or_default() } else { String::new() })
    }
    fn take(&mut self, n: usize) -> Result<&[f64], String> {
        let end = self.i.checked_add(n).filter(|&e| e <= self.g.len()).ok_or("Importpuffer zu kurz")?;
        let out = &self.g[self.i..end];
        self.i = end;
        Ok(out)
    }
}

/// Dekodiert einen DXF/DWG-Puffer (`import.rs::encode`, Version 3). `id_prefix` macht Mesh-ids
/// eindeutig, wenn mehrere Stücke parallel gelesen wurden (`c0-` …).
pub fn decode_drawing(geom: &[f64], strings: &[String], id_prefix: &str, now: f64) -> Result<DrawingImport, String> {
    let mut r = Rd { g: geom, s: strings, i: 0 };
    if r.num()? != 3.0 {
        return Err("Unbekanntes Importformat (Version).".into());
    }
    let fmt = if r.num()? == 1.0 { "DWG" } else { "DXF" };
    let ins_units = r.num()?;
    let unit_scale = r.num()?;
    let total = r.num()?;
    let mut out = DrawingImport { total, ins_units: Some(ins_units), unit_scale: Some(unit_scale), ..Default::default() };
    for _ in 0..r.count()? {
        let name = r.str()?;
        let c = r.num()?;
        out.layer_colors.insert(name, Value::String(hex_color(c)));
    }
    for _ in 0..r.count()? {
        let name = r.str()?;
        let n = r.num()?;
        out.entity_counts.insert(name, js_num(n));
    }
    let n_contours = r.count()?;
    out.contours.reserve(n_contours);
    for _ in 0..n_contours {
        let layer = r.str()?;
        let flags = jsnum::to_int32(r.num()?);
        let z = r.num()?;
        let mut c = Contour { layer, z, closed: flags & 1 != 0, filled: flags & 2 != 0, curve: None, pts: Vec::new(), bulge: None };
        if flags & 4 != 0 {
            let circle = r.num()? == 1.0;
            let v = r.take(5)?;
            c.curve = Some(Curve { circle, cx: v[0], cy: v[1], r: v[2], a0: v[3], a1: v[4] });
        }
        let np = r.count()?;
        let v = r.take(2 * np)?;
        c.pts = v.chunks_exact(2).map(|p| [p[0], p[1]]).collect();
        if flags & 8 != 0 {
            let nv = r.count()?;
            let v = r.take(3 * nv)?;
            let pts = v.chunks_exact(3).map(|p| [p[0], p[1]]).collect();
            let bulge = v.chunks_exact(3).map(|p| p[2]).collect();
            c.bulge = Some((pts, bulge));
        }
        out.contours.push(c);
    }
    for _ in 0..r.count()? {
        let layer = r.str()?;
        let text = r.str()?;
        let v = r.take(4)?;
        out.texts.push(Text { layer, text, x: v[0], y: v[1], height: v[2], angle: v[3] });
    }
    let n_meshes = r.count()?;
    let stamp = now_text(now);
    for _ in 0..n_meshes {
        let layer = r.str()?;
        let n_pos = r.count()?;
        let n_idx = r.count()?;
        let positions = r.take(n_pos * 3)?.to_vec();
        let indices = r.take(n_idx)?.to_vec();
        let name = if n_meshes > 1 { format!("{fmt}-Mesh ({layer})") } else { format!("{fmt}-Mesh") };
        out.meshes.push(Mesh { id: format!("{id_prefix}imported-{stamp}-{}", next_seq()), name, layer, positions, indices });
    }
    let mut layouts = Vec::new();
    for _ in 0..r.count()? {
        let name = r.str()?;
        layouts.push((name, r.num()?));
    }
    out.layouts = Some(layouts);
    out.recovered = r.num()? == 1.0;
    let layout_idx = r.num()?;
    out.layout = (layout_idx >= 0.0).then(|| strings.get(layout_idx as usize).cloned()).flatten();
    Ok(out)
}

/// Führt die Teilergebnisse mehrerer Stücke zusammen (vorher `dxfParserAsync.ts::mergeResults`).
pub fn merge(parts: Vec<DrawingImport>) -> DrawingImport {
    let mut out = DrawingImport::default();
    let mut first = true;
    for p in parts {
        if first {
            out.ins_units = p.ins_units;
            out.unit_scale = p.unit_scale;
            out.layouts = p.layouts.clone();
            first = false;
        }
        out.meshes.extend(p.meshes);
        out.contours.extend(p.contours);
        out.texts.extend(p.texts);
        for (k, v) in p.layer_colors {
            out.layer_colors.insert(k, v);
        }
        for (k, v) in p.entity_counts {
            let n = out.entity_counts.get(&k).and_then(Value::as_f64).unwrap_or(0.0) + v.as_f64().unwrap_or(0.0);
            out.entity_counts.insert(k, js_num(n));
        }
        out.total += p.total;
    }
    out
}

// ── Vektor-PDF ([76]) ────────────────────────────────────────────────────────

/// Pfad einer PDF-Seite (pt, angezeigte Seite).
pub struct PdfPath {
    pub pts: Vec<[f64; 2]>,
    pub closed: bool,
    pub stroke: Option<String>,
    pub fill: Option<String>,
    pub line_width: f64,
    pub dash: Vec<f64>,
    pub curve: Option<Curve>,
}

pub struct PdfText {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub size: f64,
    pub angle: f64,
    pub color: String,
}

pub struct PdfPage {
    pub page_count: f64,
    pub page_index: f64,
    pub width: f64,
    pub height: f64,
    pub rotate: f64,
    pub truncated: bool,
    pub images: f64,
    pub paths: Vec<PdfPath>,
    pub texts: Vec<PdfText>,
}

/// Dekodiert den Puffer aus `pdf_vector.rs::encode` (Version 2).
pub fn decode_pdf(geom: &[f64], strings: &[String]) -> Result<PdfPage, String> {
    let mut r = Rd { g: geom, s: strings, i: 0 };
    if r.num()? != 2.0 {
        return Err("Unbekanntes PDF-Importformat (Version).".into());
    }
    let page_count = r.num()?;
    let page_index = r.num()?;
    let width = r.num()?;
    let height = r.num()?;
    r.take(8)?; // MediaBox, CropBox
    let rotate = r.num()?;
    let truncated = r.num()? == 1.0;
    let images = r.num()?;
    let mut paths = Vec::new();
    for _ in 0..r.count()? {
        let flags = jsnum::to_int32(r.num()?);
        let s = r.num()?;
        let f = r.num()?;
        let line_width = r.num()?;
        let nd = r.count()?;
        let dash = r.take(nd)?.to_vec();
        let np = r.count()?;
        let pts = r.take(2 * np)?.chunks_exact(2).map(|p| [p[0], p[1]]).collect();
        let curve = if flags & 16 != 0 {
            let v = r.take(5)?;
            Some(Curve { circle: flags & 32 != 0, cx: v[0], cy: v[1], r: v[2], a0: v[3], a1: v[4] })
        } else {
            None
        };
        paths.push(PdfPath {
            pts,
            closed: flags & 1 != 0,
            stroke: (flags & 2 != 0).then(|| hex_color(s)),
            fill: (flags & 4 != 0).then(|| hex_color(f)),
            line_width,
            dash,
            curve,
        });
    }
    let mut texts = Vec::new();
    for _ in 0..r.count()? {
        let text = r.str()?;
        let _font = r.str()?;
        let v = r.take(5)?;
        texts.push(PdfText { text, x: v[0], y: v[1], size: v[2], angle: v[3], color: hex_color(v[4]) });
    }
    Ok(PdfPage { page_count, page_index, width, height, rotate, truncated, images, paths, texts })
}

/// Modell-Meter je PDF-Punkt bei Massstab 1:`scale`.
pub fn pdf_meters_per_pt(scale: f64) -> f64 {
    (PT_TO_MM / 1000.0) * scale
}

/// Strichstärke in Papier-mm, auf 0.01 mm gerundet.
pub fn pdf_line_weight_mm(lw: f64) -> f64 {
    jsnum::round(lw * PT_TO_MM * 100.0) / 100.0
}

/// Strichmuster in Papier-mm, auf 0.05 mm gerundet.
pub fn pdf_dash_mm(dash: &[f64]) -> Vec<f64> {
    dash.iter().map(|d| jsnum::round((d * PT_TO_MM) / 0.05) * 0.05).map(|d| jsnum::round(d * 100.0) / 100.0).collect()
}

/// Kurzschrift eines Strichmusters: „0.9/0.6".
pub fn pdf_dash_label(dash_mm: &[f64]) -> String {
    dash_mm.iter().map(|d| js_number(jsnum::round(d * 100.0) / 100.0)).collect::<Vec<_>>().join("/")
}

/// Ebenenname einer gestrichenen Linie.
pub fn pdf_stroke_layer(p: &PdfPath) -> String {
    let lw = to_fixed(pdf_line_weight_mm(p.line_width), 2);
    let dash = if p.dash.is_empty() { String::new() } else { format!(" (Strich {})", pdf_dash_label(&pdf_dash_mm(&p.dash))) };
    format!("PDF {lw} {}{dash}", p.stroke.as_deref().unwrap_or("#000000"))
}

fn polygon_area(pts: &[[f64; 2]]) -> f64 {
    let n = pts.len();
    let mut a = 0.0;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
        j = i;
    }
    (a / 2.0).abs()
}

/// Seite → Import-Form bei Massstab 1:`scale` (vorher `pdfPageToImport`).
pub fn pdf_to_import(page: &PdfPage, scale: f64, with_texts: bool) -> DrawingImport {
    let k = pdf_meters_per_pt(scale);
    let mut out = DrawingImport::default();
    let page_area = page.width * page.height;
    let (mut n_fill, mut n_stroke) = (0.0, 0.0);
    let to_m = |pts: &[[f64; 2]]| pts.iter().map(|p| [p[0] * k, p[1] * k]).collect::<Vec<_>>();
    for p in &page.paths {
        if let Some(fill) = &p.fill {
            if p.closed && !(fill == "#ffffff" && p.stroke.is_none() && polygon_area(&p.pts) > 0.5 * page_area) {
                let layer = format!("PDF Fläche {fill}");
                out.layer_colors.insert(layer.clone(), Value::String(fill.clone()));
                out.layer_fill_colors.insert(layer.clone(), Value::String(fill.clone()));
                if !out.layer_line_weights.get(&layer).is_some_and(|v| !v.is_null()) {
                    out.layer_line_weights.insert(layer.clone(), json!(0.05));
                }
                out.contours.push(Contour { layer, z: 0.0, closed: true, filled: true, curve: None, pts: to_m(&p.pts), bulge: None });
                n_fill += 1.0;
            }
        }
        if let Some(stroke) = &p.stroke {
            let layer = pdf_stroke_layer(p);
            out.layer_colors.insert(layer.clone(), Value::String(stroke.clone()));
            out.layer_line_weights.insert(layer.clone(), js_num(jsnum::max(0.05, pdf_line_weight_mm(p.line_width))));
            if !p.dash.is_empty() && !out.layer_dashes.iter().any(|(l, _)| *l == layer) {
                out.layer_dashes.push((layer.clone(), pdf_dash_mm(&p.dash)));
            }
            let curve = p.curve.as_ref().map(|c| Curve { circle: c.circle, cx: c.cx * k, cy: c.cy * k, r: c.r * k, a0: c.a0, a1: c.a1 });
            out.contours.push(Contour { layer, z: 0.0, closed: p.closed, filled: false, curve, pts: to_m(&p.pts), bulge: None });
            n_stroke += 1.0;
        }
    }
    if with_texts {
        for t in &page.texts {
            let layer = format!("PDF Text {}", t.color);
            out.layer_colors.insert(layer.clone(), Value::String(t.color.clone()));
            out.texts.push(Text { layer, text: t.text.clone(), x: t.x * k, y: t.y * k, height: t.size * k, angle: t.angle });
        }
    }
    for (key, n) in [("PATH", n_stroke), ("FILL", n_fill), ("TEXT", out.texts.len() as f64), ("IMAGE", page.images)] {
        out.entity_counts.insert(key.into(), js_num(n));
    }
    out.total = (page.paths.len() + page.texts.len()) as f64;
    out.unit_scale = Some(k);
    out.recovered = page.truncated;
    out
}

/// Kurzbericht einer Seite (CLI `pdf-info`, vorher `pdfPageInfo`): Zahlen und Umriss in pt und Papier-mm.
pub fn pdf_page_info(page: &PdfPage) -> Value {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut grow = |x: f64, y: f64| {
        if x < min_x {
            min_x = x;
        }
        if y < min_y {
            min_y = y;
        }
        if x > max_x {
            max_x = x;
        }
        if y > max_y {
            max_y = y;
        }
    };
    let mut points = 0usize;
    for p in &page.paths {
        points += p.pts.len();
        for q in &p.pts {
            grow(q[0], q[1]);
        }
    }
    for t in &page.texts {
        grow(t.x, t.y);
    }
    let mut layers = Map::new();
    let mut bump = |l: String| {
        let n = layers.get(&l).and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
        layers.insert(l, js_num(n));
    };
    for p in &page.paths {
        if p.stroke.is_some() {
            bump(pdf_stroke_layer(p));
        }
        if let Some(f) = &p.fill {
            bump(format!("PDF Fläche {f}"));
        }
    }
    let r = |v: f64| js_num(jsnum::round(v * 100.0) / 100.0);
    json!({
        "pages": js_num(page.page_count),
        "page": js_num(page.page_index + 1.0),
        "sizePt": [r(page.width), r(page.height)],
        "sizeMm": [r(page.width * PT_TO_MM), r(page.height * PT_TO_MM)],
        "rotate": js_num(page.rotate),
        "paths": page.paths.len(),
        "points": points,
        "texts": page.texts.len(),
        "images": js_num(page.images),
        "truncated": page.truncated,
        "bboxPt": if min_x.is_finite() { json!([r(min_x), r(min_y), r(max_x), r(max_y)]) } else { Value::Null },
        "layers": layers,
    })
}

// ── Quelle (Bindung) ─────────────────────────────────────────────────────────

/// Woher die Import-Form kommt: `{"kind":"drawing"}` (Stücke eines DXF/DWG) oder
/// `{"kind":"pdf","scale":100,"texts":true}`.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct Source {
    pub kind: String,
    pub scale: Option<f64>,
    pub texts: Option<bool>,
}

/// Stücke aus dem Übergabepuffer: `[n, len_0 … len_{n−1}, daten_0 …]`, String-Tabellen als JSON-Liste von Listen.
pub fn split_chunks<'a>(geom: &'a [f64], strings: &'a [Vec<String>]) -> Result<Vec<(&'a [f64], &'a [String])>, String> {
    let n = *geom.first().ok_or("Importpuffer leer")?;
    if !(n.is_finite() && n >= 0.0 && n.fract() == 0.0 && (n as usize) < geom.len() && (n as usize) == strings.len()) {
        return Err("Importpuffer beschädigt".into());
    }
    let n = n as usize;
    let mut at = 1 + n;
    let mut out = Vec::with_capacity(n);
    for k in 0..n {
        let len = geom[1 + k];
        if !(len.is_finite() && len >= 0.0 && len.fract() == 0.0) {
            return Err("Importpuffer beschädigt".into());
        }
        let end = at.checked_add(len as usize).filter(|&e| e <= geom.len()).ok_or("Importpuffer zu kurz")?;
        out.push((&geom[at..end], strings[k].as_slice()));
        at = end;
    }
    Ok(out)
}

/// Import-Form aus dem Übergabepuffer (`source` sagt, wie er zu lesen ist).
pub fn read_source(geom: &[f64], strings_json: &str, source: &Source, now: f64) -> Result<DrawingImport, String> {
    let strings: Vec<Vec<String>> = serde_json::from_str(strings_json).map_err(|e| format!("Import-Texte: {e}"))?;
    let chunks = split_chunks(geom, &strings)?;
    if source.kind == "pdf" {
        let (g, s) = chunks.first().ok_or("PDF-Seite fehlt")?;
        let page = decode_pdf(g, s)?;
        let scale = source.scale.unwrap_or(100.0);
        return Ok(pdf_to_import(&page, scale, source.texts != Some(false)));
    }
    if chunks.len() == 1 {
        return decode_drawing(chunks[0].0, chunks[0].1, "", now);
    }
    let parts = chunks.iter().enumerate().map(|(i, (g, s))| decode_drawing(g, s, &format!("c{i}-"), now)).collect::<Result<Vec<_>, _>>()?;
    Ok(merge(parts))
}

// ── Zusammenfassung für den Dialog ───────────────────────────────────────────

/// Unterschiedliche Layer-Namen der Konturen (`distinctLayers`).
pub fn contour_layers(d: &DrawingImport) -> Vec<String> {
    let mut seen = HashSet::new();
    d.contours.iter().filter(|c| !c.layer.is_empty() && seen.insert(c.layer.as_str())).map(|c| c.layer.clone()).collect()
}

/// Wie [`contour_layers`], über Konturen UND Texte (`distinctImportLayers`).
pub fn import_layers(d: &DrawingImport) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out = Vec::new();
    for l in d.contours.iter().map(|c| c.layer.as_str()).chain(d.texts.iter().map(|t| t.layer.as_str())) {
        if !l.is_empty() && seen.insert(l) {
            out.push(l.to_string());
        }
    }
    out
}

/// Was der Import-Dialog zeigt: Zahlen, Layer, Diagnose, Layouts, Einheit.
pub fn summary_json(d: &DrawingImport) -> Value {
    let mut m = Map::new();
    m.insert("contours".into(), d.contours.len().into());
    m.insert("texts".into(), d.texts.len().into());
    m.insert("meshes".into(), d.meshes.len().into());
    m.insert("layers".into(), contour_layers(d).into());
    m.insert("diagnostics".into(), json!({"entityCounts": d.entity_counts, "total": js_num(d.total)}));
    if let Some(u) = d.ins_units {
        m.insert("insUnits".into(), js_num(u));
    }
    if let Some(u) = d.unit_scale {
        m.insert("unitScale".into(), js_num(u));
    }
    if let Some(l) = &d.layouts {
        m.insert("layouts".into(), l.iter().map(|(name, n)| json!({"name": name, "entities": js_num(*n)})).collect());
    }
    if let Some(l) = &d.layout {
        m.insert("layout".into(), l.clone().into());
    }
    m.insert("recovered".into(), d.recovered.into());
    Value::Object(m)
}

/// Meshes als Kontext-Objekte (`ImportedMesh`, Kategorie „10 Situation"; Layer „0" ohne `layer`).
pub fn mesh_values(d: &DrawingImport) -> Vec<Value> {
    d.meshes
        .iter()
        .map(|m| {
            let mut o = Map::new();
            o.insert("id".into(), m.id.clone().into());
            o.insert("type".into(), "importedMesh".into());
            o.insert("name".into(), m.name.clone().into());
            o.insert("categoryCode".into(), GENERIC_IMPORT_CODE.into());
            if m.layer != "0" {
                o.insert("layer".into(), m.layer.clone().into());
            }
            o.insert("positions".into(), Value::Array(m.positions.iter().map(|&x| js_num(x)).collect()));
            o.insert("indices".into(), Value::Array(m.indices.iter().map(|&x| js_num(x)).collect()));
            Value::Object(o)
        })
        .collect()
}

/// Die ganze Import-Form als JSON (Leseansicht für Tests und Diagnose; Form wie das frühere
/// `DxfImportResult`: ein Konturen-Satz, Texte, Meshes, Ebenenfarben …).
pub fn view_json(d: &DrawingImport) -> Value {
    let p = |q: &[f64; 2]| json!({"x": js_num(q[0]), "y": js_num(q[1])});
    let contours: Vec<Value> = d
        .contours
        .iter()
        .map(|c| {
            let mut o = Map::new();
            o.insert("z".into(), js_num(c.z));
            o.insert("pts".into(), c.pts.iter().map(p).collect());
            o.insert("closed".into(), c.closed.into());
            o.insert("layer".into(), c.layer.clone().into());
            if c.filled {
                o.insert("filled".into(), true.into());
            }
            if let Some(k) = &c.curve {
                o.insert(
                    "curve".into(),
                    json!({"kind": if k.circle { "circle" } else { "arc" }, "cx": js_num(k.cx), "cy": js_num(k.cy), "r": js_num(k.r), "a0": js_num(k.a0), "a1": js_num(k.a1)}),
                );
            }
            if let Some((pts, b)) = &c.bulge {
                o.insert("bulgePolyline".into(), json!({"pts": pts.iter().map(p).collect::<Vec<_>>(), "bulge": b.iter().map(|&x| js_num(x)).collect::<Vec<_>>()}));
            }
            Value::Object(o)
        })
        .collect();
    let mut m = Map::new();
    m.insert("meshes".into(), mesh_values(d).into());
    let sets = if contours.is_empty() {
        Vec::new()
    } else {
        vec![json!({"type": "contourSet", "categoryCode": GENERIC_IMPORT_CODE, "contours": contours})]
    };
    m.insert("contours".into(), sets.into());
    m.insert(
        "texts".into(),
        d.texts.iter().map(|t| json!({"at": {"x": js_num(t.x), "y": js_num(t.y)}, "text": t.text, "height": js_num(t.height), "angle": js_num(t.angle), "layer": t.layer})).collect(),
    );
    m.insert("layerColors".into(), Value::Object(d.layer_colors.clone()));
    m.insert("layerLineWeights".into(), Value::Object(d.layer_line_weights.clone()));
    m.insert("layerFillColors".into(), Value::Object(d.layer_fill_colors.clone()));
    m.insert("layerDashes".into(), d.layer_dashes.iter().map(|(l, v)| (l.clone(), json!(v.iter().map(|&x| js_num(x)).collect::<Vec<_>>()))).collect::<Map<_, _>>().into());
    if let Value::Object(s) = summary_json(d) {
        for k in ["diagnostics", "insUnits", "unitScale", "layouts", "layout", "recovered"] {
            if let Some(v) = s.get(k) {
                m.insert(k.into(), v.clone());
            }
        }
    }
    Value::Object(m)
}

// ── Ops ──────────────────────────────────────────────────────────────────────

/// Ziel-Ebene des Imports.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Existing {
        #[serde(rename = "levelId")]
        level_id: String,
    },
    New {
        name: String,
    },
}

/// Entscheidung des Import-Dialogs (bzw. des CLI). Übersetzte Texte bringt die Hülle mit (der Kern kennt
/// kein i18n): `levelNameTemplate` (Name einer neuen Zeichnung ohne Eingabe, `{n}` = Nummer),
/// `parentName` (Elternkategorie der neuen Layer-Kategorien), `dashStyleTemplate` (Linienstil, `{pattern}`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub target: Target,
    /// `"byLayer"` | `"active"`.
    pub category_mode: String,
    pub active_category_code: String,
    #[serde(default)]
    pub import_meshes: bool,
    /// Mitte des Ausschnitts für `placement: "viewCenter"`; fehlt = an den Datei-Koordinaten.
    #[serde(default)]
    pub view_center: Option<[f64; 2]>,
    #[serde(default)]
    pub level_name_template: String,
    #[serde(default)]
    pub parent_name: String,
    #[serde(default)]
    pub dash_style_template: String,
}

/// Ergebnis von [`import_ops`].
pub struct ImportResult {
    pub ops: Vec<Op>,
    /// Ziel-Ebene (neu angelegt oder gewählt).
    pub level_id: String,
    pub drawings: usize,
    pub meshes: usize,
}

fn layer_list(root: &Map<String, Value>) -> Vec<Value> {
    root.get("layers").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Gleiches Strichmuster (Toleranz 15 % bzw. 0.06 mm je Glied, `sameDash`).
fn same_dash(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(v, w)| (v - w).abs() <= jsnum::max(0.06, 0.15 * jsnum::max(*v, *w)))
}

/// Linienstile der PDF-Strichmuster (`planDashLineStyles`): vorhandene mit gleichem Muster oder neue.
fn plan_dash_styles(dashes: &[(String, Vec<f64>)], existing: &[Value], name_template: &str) -> (Vec<Value>, HashMap<String, String>) {
    let mut created: Vec<Value> = Vec::new();
    let mut by_layer = HashMap::new();
    let mut used: HashSet<String> = existing.iter().filter_map(|l| l.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    let dash_of = |l: &Value| -> Option<Vec<f64>> {
        let kind = l.get("kind").and_then(Value::as_str).unwrap_or("dash");
        if kind != "dash" {
            return None;
        }
        l.get("dash")?.as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect())
    };
    for (layer, dash) in dashes {
        if dash.len() < 2 {
            continue;
        }
        let known = existing.iter().chain(created.iter()).find(|l| dash_of(l).is_some_and(|d| same_dash(&d, dash)));
        if let Some(k) = known {
            by_layer.insert(layer.clone(), k.get("id").and_then(Value::as_str).unwrap_or("").to_string());
            continue;
        }
        let label = pdf_dash_label(dash);
        let mut base = String::from("pdf-dash-");
        let mut in_run = false;
        for ch in label.chars() {
            if ch.is_ascii_alphanumeric() {
                base.push(ch);
                in_run = false;
            } else if !in_run {
                base.push('_');
                in_run = true;
            }
        }
        let mut id = base.clone();
        let mut n = 2;
        while used.contains(&id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        used.insert(id.clone());
        let name = name_template.replace("{pattern}", &label);
        created.push(json!({"id": id, "name": name, "weight": 0.02, "color": "#1a1a1a", "dash": dash.iter().map(|&d| js_num(d)).collect::<Vec<_>>()}));
        by_layer.insert(layer.clone(), id);
    }
    (created, by_layer)
}

fn pt(p: [f64; 2], dx: f64, dy: f64) -> Value {
    json!({"x": js_num(p[0] + dx), "y": js_num(p[1] + dy)})
}

/// Eine Kontur → 2D-Geometrie (`contourGeom`); `None` = zu wenig Punkte.
fn contour_geom(c: &Contour, dx: f64, dy: f64) -> Option<Value> {
    if let Some(k) = &c.curve {
        let center = pt([k.cx, k.cy], dx, dy);
        return Some(if k.circle {
            json!({"shape": "circle", "center": center, "r": js_num(k.r)})
        } else {
            json!({"shape": "arc", "center": center, "r": js_num(k.r), "a0": js_num(k.a0), "a1": js_num(k.a1)})
        });
    }
    // VORZEICHEN: DXF-Bulge > 0 = Bogen im Gegenuhrzeigersinn (Scheitel rechts der Sehne), im Modell liegt
    // der Scheitel bei Bulge > 0 LINKS der Sehne (`kernel2d/src/bulge.rs`) — also umgekehrt.
    if let Some((pts, bulge)) = &c.bulge {
        if pts.len() >= 2 && bulge.len() == pts.len() {
            return Some(json!({
                "shape": "polyline",
                "pts": pts.iter().map(|&p| pt(p, dx, dy)).collect::<Vec<_>>(),
                "closed": c.closed,
                "bulge": bulge.iter().map(|&b| js_num(if b == 0.0 { 0.0 } else { -b })).collect::<Vec<_>>(),
            }));
        }
    }
    if c.pts.len() < 2 {
        return None;
    }
    if c.pts.len() == 2 && !c.closed {
        return Some(json!({"shape": "line", "a": pt(c.pts[0], dx, dy), "b": pt(c.pts[1], dx, dy)}));
    }
    Some(json!({"shape": "polyline", "pts": c.pts.iter().map(|&p| pt(p, dx, dy)).collect::<Vec<_>>(), "closed": c.closed}))
}

/// Umriss aller entstehenden Zeichnungen (`drawingsBBox` über Linie, Polylinie, Kreis/Bogen, Text).
fn bbox(d: &DrawingImport) -> Option<[f64; 4]> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut acc = |x: f64, y: f64| {
        min_x = jsnum::min(min_x, x);
        min_y = jsnum::min(min_y, y);
        max_x = jsnum::max(max_x, x);
        max_y = jsnum::max(max_y, y);
    };
    for c in &d.contours {
        if let Some(k) = &c.curve {
            acc(k.cx - k.r, k.cy - k.r);
            acc(k.cx + k.r, k.cy + k.r);
            continue;
        }
        let pts = match &c.bulge {
            Some((p, b)) if p.len() >= 2 && b.len() == p.len() => p,
            _ if c.pts.len() < 2 => continue,
            _ => &c.pts,
        };
        for p in pts {
            acc(p[0], p[1]);
        }
    }
    for t in &d.texts {
        acc(t.x, t.y);
    }
    min_x.is_finite().then_some([min_x, min_y, max_x, max_y])
}

fn ensure_layers_with_parent(layers: &mut Vec<Value>, parent: Option<Value>) {
    if let Some(p) = parent {
        layers.push(p);
    }
}

/// Die Ops eines bestätigten Imports auf dem Projekt `root` (vorher `runImport` + `buildDrawings`).
pub fn import_ops(root: &Map<String, Value>, d: &DrawingImport, dec: &Decision, now: f64) -> ImportResult {
    let mut ops = Vec::new();
    let stamp = now_text(now);
    // Ziel-Ebene.
    let level_id = match &dec.target {
        Target::Existing { level_id } => level_id.clone(),
        Target::New { name } => {
            let id = format!("drawing-{stamp}");
            let n = root
                .get("drawingLevels")
                .and_then(Value::as_array)
                .map_or(0, |l| l.iter().filter(|z| z.get("kind").and_then(Value::as_str) == Some("drawing")).count())
                + 1;
            let name = if name.trim().is_empty() { dec.level_name_template.replace("{n}", &n.to_string()) } else { name.trim().to_string() };
            ops.push(Op::Add {
                collection: "drawingLevels".into(),
                items: vec![json!({"id": id, "name": name, "kind": "drawing", "visible": true, "locked": false})],
                at: None,
            });
            id
        }
    };
    // Layer als Kategorien: fehlende als Unterkategorien einer neuen Elternkategorie.
    let mut layers = layer_list(root);
    let mut layers_changed = false;
    let by_layer = dec.category_mode == "byLayer";
    let mut code_by_layer: HashMap<String, String> = HashMap::new();
    if by_layer {
        let names = import_layers(d);
        let plan = crate::layers::plan_import(&names, &layers, &d.layer_colors, &d.layer_line_weights);
        code_by_layer = plan.code_by_layer.into_iter().collect();
        if !plan.children.is_empty() {
            let parent = json!({"code": plan.parent_code, "name": dec.parent_name, "color": "#707078", "lw": 0.18, "visible": true, "locked": false, "children": plan.children});
            ensure_layers_with_parent(&mut layers, Some(parent));
            layers_changed = true;
        }
    }
    // PDF-Strichmuster → Linienstile.
    let existing_styles = root.get("lineStyles").and_then(Value::as_array).cloned().unwrap_or_default();
    let (created, style_by_layer) = plan_dash_styles(&d.layer_dashes, &existing_styles, &dec.dash_style_template);
    if !created.is_empty() {
        ops.push(Op::Add { collection: "lineStyles".into(), items: created, at: None });
    }
    // Layer-Name → Kategorie: Plan, sonst gleichnamige Kategorie (Stand vor dem Import), sonst die aktive.
    let mut by_name: HashMap<String, String> = HashMap::new();
    for c in crate::layers::flatten(&layer_list(root)) {
        if let (Some(code), Some(name)) = (c.get("code").and_then(Value::as_str), c.get("name").and_then(Value::as_str)) {
            by_name.insert(name.to_lowercase(), code.to_string());
        }
    }
    let active = dec.active_category_code.as_str();
    let code_for = |layer: &str| -> String {
        if !(by_layer && !layer.is_empty()) {
            return active.to_string();
        }
        code_by_layer.get(layer).or_else(|| by_name.get(&layer.to_lowercase())).cloned().unwrap_or_else(|| active.to_string())
    };
    // Platzierung „viewCenter": Mitte des Umrisses auf die Mitte des Ausschnitts.
    let (dx, dy) = match (dec.view_center, bbox(d)) {
        (Some(c), Some(b)) => (c[0] - (b[0] + b[2]) / 2.0, c[1] - (b[1] + b[3]) / 2.0),
        _ => (0.0, 0.0),
    };
    let mut drawings = Vec::with_capacity(d.contours.len() + d.texts.len());
    for c in &d.contours {
        let Some(geom) = contour_geom(c, dx, dy) else { continue };
        let is_polyline = geom.get("shape").and_then(Value::as_str) == Some("polyline");
        let mut o = Map::new();
        o.insert("id".into(), format!("dxf2d-{stamp}-{}", next_seq()).into());
        o.insert("type".into(), "drawing2d".into());
        o.insert("levelId".into(), level_id.clone().into());
        o.insert("categoryCode".into(), code_for(&c.layer).into());
        o.insert("geom".into(), geom);
        if let Some(s) = style_by_layer.get(&c.layer).filter(|s| !s.is_empty()) {
            o.insert("lineStyleId".into(), s.clone().into());
        }
        if c.filled && is_polyline {
            let fill = d.layer_fill_colors.get(&c.layer).and_then(Value::as_str).unwrap_or(DXF_HATCH_FILL);
            o.insert("fillColor".into(), fill.into());
        }
        drawings.push(Value::Object(o));
    }
    for t in &d.texts {
        drawings.push(json!({
            "id": format!("dxf2d-{stamp}-{}", next_seq()),
            "type": "drawing2d",
            "levelId": level_id,
            "categoryCode": code_for(&t.layer),
            "geom": {"shape": "text", "at": pt([t.x, t.y], dx, dy), "text": t.text, "height": js_num(t.height), "angle": js_num(t.angle)},
        }));
    }
    let n_drawings = drawings.len();
    if !drawings.is_empty() {
        ops.push(Op::Add { collection: "drawings2d".into(), items: drawings, at: None });
    }
    let mut n_meshes = 0;
    if dec.import_meshes && !d.meshes.is_empty() {
        let meshes = mesh_values(d);
        n_meshes = meshes.len();
        ops.push(Op::Add { collection: "context".into(), items: meshes, at: None });
        if crate::import_context::ensure_context_categories(&mut layers, [GENERIC_IMPORT_CODE]) {
            layers_changed = true;
        }
    }
    if layers_changed {
        ops.push(Op::SetField { key: "layers".into(), value: Some(Value::Array(layers)), at: None });
    }
    ImportResult { ops, level_id, drawings: n_drawings, meshes: n_meshes }
}

#[cfg(test)]
#[path = "import_drawing_tests.rs"]
mod tests;
