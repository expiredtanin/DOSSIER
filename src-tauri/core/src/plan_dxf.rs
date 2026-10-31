//! DXF-/DWG-Sammler des Grundrisses ([K3d], früher `src/export/exportDxf.ts::collectPlanDrawing`
//! und `dxfCadParts.ts`): liest den zusammengesetzten Plan ([`crate::plan_parts`]) und das Projekt
//! und schreibt die flache Zeichnung, die `src-tauri/fileio/src/export.rs` zur Datei macht
//! (Kodierung dort; Gegenstück der früheren TS-Klasse `FlatDrawing`). Modell-Space in echten
//! Metern, Ebenen aus den Kategorien, Bemassungen als DIMENSION, Türen/Fenster und Blockinstanzen
//! als BLOCK + INSERT, Schraffuren als HATCH, Strichmuster als Linientypen.
//!
//! Gleiche Eingabe ⇒ dieselben Zahlen und Zeichenketten in derselben Reihenfolge wie die TS-Fassung
//! (Zeichenketten-Indizes nach erstem Gebrauch, Definitionen an der Stelle ihres ersten Gebrauchs).
//! Texte: die Zeilen der Raumstempel und die Absätze/Wörter der Einzeltexte setzt der Kern aus dem
//! Text-JSON des Puffers ([`crate::plan_text::dxf_text`] → [`TextIn`]); der Zeilenumbruch nach
//! Spaltenbreite läuft hier (er hängt in Blöcken an der blocklokalen Grösse).

use crate::hatch::{self, Hatch, HatchKind, Motif, Pattern, V2};
use crate::js_fmt::{js_number, to_fixed};
use crate::jsmath::hypot;
use crate::jsnum;
use crate::model::{Drawing2D, Drawing2DGeom, ElementKind, LayerCategory, LineStyle, LineStyleKind, Opening, OpeningDoorType, Project};
use crate::plan::overrides::js_trim;
use crate::plan_buf::{whole, View, F_DASH_NULL, T_ARC, T_CIRCLE, T_DRAWING_ARC, T_DRAWING_TEXT, T_LINE, T_POLYGON, T_TEXT};
use crate::plan_parts::{pick_ids, Part};
use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

const FLAT_VERSION: f64 = 1.0;
const REC_LAYER: f64 = 1.0;
const REC_LINE: f64 = 2.0;
const REC_POLYLINE: f64 = 3.0;
const REC_ARC: f64 = 4.0;
const REC_CIRCLE: f64 = 5.0;
const REC_HATCH: f64 = 7.0;
const REC_GRADIENT: f64 = 8.0;
const REC_LTYPE: f64 = 9.0;
const REC_PEN: f64 = 11.0;
const REC_STYLE: f64 = 12.0;
const REC_TEXT2: f64 = 13.0;
const REC_DIMSTYLE: f64 = 14.0;
const REC_DIM: f64 = 15.0;
const REC_BLOCK: f64 = 16.0;
const REC_BLOCK_END: f64 = 17.0;
const REC_INSERT: f64 = 18.0;
const REC_LAYOUT: f64 = 19.0;
/// Papierbereich eines Projekt-Layouts, Ansichtsfenster darin, Blockeinfügung darin ([93], fileio `export.rs`).
const REC_SHEET: f64 = 20.0;
const REC_SHEET_VP: f64 = 21.0;
const REC_SHEET_INSERT: f64 = 22.0;

/// Sammel-Ebenen für Primitive ohne eigene Kategorie.
const LAYER_HATCH: &str = "HATCH";
const LAYER_SYMBOLS: &str = "SYMBOLS";
const LAYER_CONTEXT: &str = "CONTEXT";
const LAYER_DEFAULT: &str = "PLAN";
const LAYER_SECTIONS: &str = "SECTIONS";
const LAYER_EXTRUSION: &str = "EXTRUSION";
/// Ebene „0": Inhalt von Blöcken (erbt die Ebene des INSERT).
const LAYER_ZERO: &str = "0";

/// Entitäten-Arten der Statistik (Tests): LINE, LWPOLYLINE, ARC, CIRCLE, TEXT, HATCH, DIMENSION, INSERT.
pub const KINDS: [&str; 8] = ["LINE", "LWPOLYLINE", "ARC", "CIRCLE", "TEXT", "HATCH", "DIMENSION", "INSERT"];
const K_LINE: usize = 0;
const K_POLY: usize = 1;
const K_ARC: usize = 2;
const K_CIRCLE: usize = 3;
const K_TEXT: usize = 4;
const K_HATCH: usize = 5;
const K_DIM: usize = 6;
const K_INSERT: usize = 7;

/// Bemassungs-Standards in Papier-mm (`DIM_DEFAULTS_MM`).
const DIM_GAP: f64 = 1.0;
const DIM_OVERSHOOT: f64 = 1.0;
const DIM_TICK: f64 = 3.0;
const DIM_TEXT: f64 = 4.0;

/// Optionen des Exports.
pub struct DxfOptions {
    /// Massstabsnenner (schon geprüft: endlich und > 0).
    pub scale: f64,
    pub include_hatches: bool,
    /// Masszahl in Zentimetern statt Metern.
    pub dim_cm: bool,
    pub paper_layout: bool,
    /// Ausmass des Plans (`Plan.bounds`) für den Papierbereich.
    pub bounds: [f64; 4],
    /// Standard-Schrift (erste Schrift der Projekt-Textstile, sonst Arial; [`crate::plan_text::default_font`]).
    pub default_font: String,
    /// Exportierte Ebene (Geschoss): Ansichtsfenster der Projekt-Layouts, die sie zeigen, kommen mit in
    /// den Papierbereich (`paper_layout`); leer = keine.
    pub floor: String,
    /// Beschriftungen der Blatt-Tabellen ([111]) als JSON (Schlüssel → Text); leer = nur Kennungen.
    pub table_labels: String,
}

/// Schrift eines Texts (Familie nach `font_name_of`, sonst Standard-Schrift).
#[derive(Clone, Debug, PartialEq)]
pub struct TextStyleIn {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
}

/// Eine fertig gesetzte Zeile eines Raumstempels.
#[derive(Clone, Debug, PartialEq)]
pub struct StampLine {
    pub text: String,
    pub height: f64,
    /// 0 links, 1 Mitte, 2 rechts.
    pub align: f64,
    pub style: TextStyleIn,
    /// Versatz der Grundlinie vom Anker nach unten (Meter).
    pub down: f64,
}

/// Text-Eingabe je Text-Eintrag (aus dem Text-JSON gesetzt, s. [`crate::plan_text::dxf_text`]).
#[derive(Clone, Debug, PartialEq)]
pub enum TextIn {
    /// `text` (Raumstempel): Anker und Zeilen.
    Stamp { at: V2, lines: Vec<StampLine> },
    /// `drawingText`: Anker, Winkel, Höhe, Spaltenbreite (NaN = keine), Schrift und Absätze
    /// (Text des Absatzes, Wörter nach `split(/\s+/)`).
    Single { at: V2, angle: f64, height: f64, wrap: f64, style: TextStyleIn, paras: Vec<(String, Vec<String>)> },
}

/// Ergebnis: Zahlen und Zeichenketten der flachen Zeichnung, Entitäten je Art (Modell, Blöcke).
pub struct FlatDxf {
    pub nums: Vec<f64>,
    pub strings: Vec<String>,
    pub model: [u32; 8],
    pub blocks: [u32; 8],
}

// ── Flache Zeichnung ───────────────────────────────────────────────────────

/// Zahlenpuffer einer Zeichnung (`None` = die Hauptzeichnung, deren Puffer `root` ist) bzw. eines
/// Blockinhalts, mit eigenem Linientyp-Zustand und Zählern.
struct Buf {
    nums: Option<Vec<f64>>,
    pen: f64,
    counts: [u32; 8],
}

impl Buf {
    fn main() -> Buf {
        Buf { nums: None, pen: -1.0, counts: [0; 8] }
    }
    fn block() -> Buf {
        Buf { nums: Some(Vec::new()), pen: -1.0, counts: [0; 8] }
    }
}

/// Was Hauptzeichnung und Blockinhalte teilen (Definitionen landen immer in `root`).
struct Flat {
    root: Vec<f64>,
    strings: Vec<String>,
    str_idx: HashMap<String, usize>,
    layers: HashMap<String, usize>,
    ltypes: HashMap<String, usize>,
    styles: HashMap<String, usize>,
    dim_styles: HashMap<String, usize>,
    blocks: HashSet<String>,
    block_counts: [u32; 8],
}

impl Flat {
    fn new() -> Flat {
        Flat {
            root: vec![FLAT_VERSION],
            strings: Vec::new(),
            str_idx: HashMap::new(),
            layers: HashMap::new(),
            ltypes: HashMap::new(),
            styles: HashMap::new(),
            dim_styles: HashMap::new(),
            blocks: HashSet::new(),
            block_counts: [0; 8],
        }
    }

    fn push(&mut self, b: &mut Buf, v: &[f64]) {
        match b.nums.as_mut() {
            Some(n) => n.extend_from_slice(v),
            None => self.root.extend_from_slice(v),
        }
    }

    fn str(&mut self, s: &str) -> f64 {
        let clean: String = s.chars().filter(|c| *c != '\0').collect();
        if let Some(&i) = self.str_idx.get(&clean) {
            return i as f64;
        }
        self.strings.push(clean.clone());
        let i = self.strings.len() - 1;
        self.str_idx.insert(clean, i);
        i as f64
    }

    /// Ebene (`rgb` 0xRRGGBB oder None = ACI 7, `lw` in 1/100 mm), idempotent über den Namen.
    fn add_layer(&mut self, name: &str, rgb: Option<f64>, lw: f64) -> f64 {
        if let Some(&i) = self.layers.get(name) {
            return i as f64;
        }
        let idx = self.layers.len();
        self.layers.insert(name.to_string(), idx);
        let s = self.str(name);
        self.root.extend_from_slice(&[REC_LAYER, s, rgb.unwrap_or(-1.0), lw]);
        idx as f64
    }

    fn layer(&mut self, name: &str) -> f64 {
        match self.layers.get(name) {
            Some(&i) => i as f64,
            None => self.add_layer(name, None, 25.0),
        }
    }

    fn add_linetype(&mut self, name: &str, el: &[f64]) -> f64 {
        if let Some(&i) = self.ltypes.get(name) {
            return i as f64;
        }
        let idx = self.ltypes.len();
        self.ltypes.insert(name.to_string(), idx);
        let s = self.str(name);
        self.root.extend_from_slice(&[REC_LTYPE, s, el.len() as f64]);
        self.root.extend_from_slice(el);
        idx as f64
    }

    fn set_pen(&mut self, b: &mut Buf, ltype: f64) {
        if ltype == b.pen {
            return;
        }
        b.pen = ltype;
        self.push(b, &[REC_PEN, ltype]);
    }

    fn add_text_style(&mut self, name: &str, font: &str, bold: bool, italic: bool) -> f64 {
        if let Some(&i) = self.styles.get(name) {
            return i as f64;
        }
        let idx = self.styles.len();
        self.styles.insert(name.to_string(), idx);
        let s = self.str(name);
        let f = self.str(font);
        self.root.extend_from_slice(&[REC_STYLE, s, f, b01(bold), b01(italic), 1.0]);
        idx as f64
    }

    fn add_line(&mut self, b: &mut Buf, layer: &str, p: V2, q: V2) {
        b.counts[K_LINE] += 1;
        let l = self.layer(layer);
        self.push(b, &[REC_LINE, l, p.x, p.y, q.x, q.y]);
    }

    fn add_polyline(&mut self, b: &mut Buf, layer: &str, pts: &[V2], closed: bool) {
        if pts.len() < 2 {
            return;
        }
        b.counts[K_POLY] += 1;
        let l = self.layer(layer);
        self.push(b, &[REC_POLYLINE, l, b01(closed), pts.len() as f64]);
        for p in pts {
            self.push(b, &[p.x, p.y]);
        }
    }

    fn add_arc(&mut self, b: &mut Buf, layer: &str, c: V2, r: f64, start: f64, end: f64) {
        b.counts[K_ARC] += 1;
        let l = self.layer(layer);
        self.push(b, &[REC_ARC, l, c.x, c.y, r, start, end]);
    }

    fn add_circle(&mut self, b: &mut Buf, layer: &str, c: V2, r: f64) {
        b.counts[K_CIRCLE] += 1;
        let l = self.layer(layer);
        self.push(b, &[REC_CIRCLE, l, c.x, c.y, r]);
    }

    #[allow(clippy::too_many_arguments)]
    fn add_text2(&mut self, b: &mut Buf, layer: &str, at: V2, height: f64, rot: f64, value: &str, halign: f64, style: f64) {
        b.counts[K_TEXT] += 1;
        let l = self.layer(layer);
        let s = self.str(value);
        self.push(b, &[REC_TEXT2, l, s, at.x, at.y, height, rot, halign, style]);
    }

    fn add_hatch(&mut self, b: &mut Buf, layer: &str, pts: &[V2], solid: bool, rgb: Option<f64>, families: &[(f64, f64)], dashes: &[f64]) {
        if pts.len() < 3 {
            return;
        }
        b.counts[K_HATCH] += 1;
        let (families, dashes): (&[(f64, f64)], &[f64]) = if solid { (&[], &[]) } else { (families, dashes) };
        let l = self.layer(layer);
        self.push(b, &[REC_HATCH, l, if solid { 0.0 } else { 1.0 }, rgb.unwrap_or(-1.0), dashes.len() as f64]);
        self.push(b, dashes);
        self.push(b, &[families.len() as f64]);
        for f in families {
            self.push(b, &[f.0, f.1]);
        }
        self.push(b, &[pts.len() as f64]);
        for p in pts {
            self.push(b, &[p.x, p.y]);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add_gradient(&mut self, b: &mut Buf, layer: &str, pts: &[V2], rgb1: f64, rgb2: f64, angle: f64, radial: bool) {
        if pts.len() < 3 {
            return;
        }
        b.counts[K_HATCH] += 1;
        let l = self.layer(layer);
        self.push(b, &[REC_GRADIENT, l, rgb1, rgb2, angle, b01(radial), pts.len() as f64]);
        for p in pts {
            self.push(b, &[p.x, p.y]);
        }
    }

    /// Bemassungsstil `d` = `[textStyle, scale, txt, tick, exo, exe, gap, dec, lfac]`.
    fn add_dim_style(&mut self, name: &str, d: [f64; 9]) -> f64 {
        if let Some(&i) = self.dim_styles.get(name) {
            return i as f64;
        }
        let idx = self.dim_styles.len();
        self.dim_styles.insert(name.to_string(), idx);
        let s = self.str(name);
        self.root.extend_from_slice(&[REC_DIMSTYLE, s]);
        self.root.extend_from_slice(&d);
        self.root.push(-1.0);
        idx as f64
    }

    #[allow(clippy::too_many_arguments)]
    fn add_dimension(&mut self, b: &mut Buf, layer: &str, style: f64, p1: V2, p2: V2, on: V2, text_at: Option<V2>) {
        b.counts[K_DIM] += 1;
        let l = self.layer(layer);
        let t = text_at.unwrap_or(V2 { x: 0.0, y: 0.0 });
        self.push(b, &[REC_DIM, l, style, p1.x, p1.y, p2.x, p2.y, on.x, on.y, b01(text_at.is_some()), t.x, t.y]);
    }

    /// Blockdefinition mit dem Inhalt `content` (blocklokal) an dieser Stelle.
    fn define_block(&mut self, b: &mut Buf, name: &str, description: &str, atts: &[(&str, &str, &str)], content: Buf) {
        if self.blocks.contains(name) {
            return;
        }
        self.blocks.insert(name.to_string());
        let s = self.str(name);
        let d = if description.is_empty() { -1.0 } else { self.str(description) };
        self.push(b, &[REC_BLOCK, s, d, atts.len() as f64]);
        for (tag, prompt, def) in atts {
            let t = self.str(tag);
            let p = self.str(prompt);
            let v = self.str(def);
            self.push(b, &[t, p, v, 0.0, 0.0, 0.1]);
        }
        // Der Block beginnt mit „nach Ebene“; danach gilt der Linientyp, mit dem sein Inhalt endete.
        self.push(b, &[REC_PEN, -1.0]);
        self.push(b, content.nums.as_deref().unwrap_or(&[]));
        self.push(b, &[REC_BLOCK_END]);
        b.pen = content.pen;
        for k in 0..8 {
            self.block_counts[k] += content.counts[k];
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add_insert(&mut self, b: &mut Buf, layer: &str, name: &str, at: V2, rot: f64, scale: f64, values: &[(&str, String)]) {
        b.counts[K_INSERT] += 1;
        let l = self.layer(layer);
        let s = self.str(name);
        self.push(b, &[REC_INSERT, l, s, at.x, at.y, rot, scale, scale, values.len() as f64]);
        for (tag, v) in values {
            let t = self.str(tag);
            let v = self.str(v);
            self.push(b, &[t, v]);
        }
    }
}

fn b01(v: bool) -> f64 {
    if v {
        1.0
    } else {
        0.0
    }
}

/// Inhalt eines Blocks als Schlüssel (`roundKey`): Zahlen auf 1 mm gerundet.
pub fn round_key(nums: &[f64]) -> String {
    let mut out = String::new();
    for v in nums {
        out.push_str(&js_number(jsnum::round(v * 1000.0)));
        out.push(',');
    }
    out
}

// ── Hilfsfunktionen (früher `dxfCadParts.ts`) ──────────────────────────────

/// Strichmuster (Papier-mm) → Linientyp-Elemente in Modell-Metern (Strich +, Lücke −); `None` ohne Strich.
pub fn dash_to_ltype_meters(dash_mm: &[f64], scale: f64) -> Option<Vec<f64>> {
    let mut pat: Vec<f64> = dash_mm.iter().map(|d| if d.is_finite() { jsnum::max(0.0, *d) } else { 0.0 }).collect();
    if pat.is_empty() || pat.iter().all(|d| *d == 0.0) {
        return None;
    }
    if pat.len() % 2 == 1 {
        pat.extend_from_within(..);
    }
    let k = scale / 1000.0;
    Some(
        pat.iter()
            .enumerate()
            .map(|(i, p)| {
                let len = p * k;
                if i % 2 == 0 {
                    len
                } else {
                    -jsnum::max(len, 1e-6)
                }
            })
            .collect(),
    )
}

/// `String(Math.round(v * 100) / 100)`.
fn n2(v: f64) -> String {
    js_number(jsnum::round(v * 100.0) / 100.0)
}

/// Linientyp-Name zu einem Strichmuster: Projekt-Linienstil mit gleichem Muster, sonst
/// `DOSSIER_STRICH_<an>_<aus>…`.
pub fn ltype_name_for(dash_mm: &[f64], styles: &[LineStyle]) -> String {
    let same = |a: &[f64], b: &[f64]| a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9);
    let hit = styles.iter().find(|s| {
        let dash_kind = matches!(s.kind, None | Some(LineStyleKind::Dash));
        s.dash.as_ref().is_some_and(|d| !d.is_empty() && dash_kind && same(d, dash_mm))
    });
    if let Some(h) = hit {
        let t = js_trim(&h.name);
        if !t.is_empty() {
            return t.to_string();
        }
    }
    let parts: Vec<String> = dash_mm.iter().map(|v| n2(*v)).collect();
    format!("DOSSIER_STRICH_{}", parts.join("_"))
}

/// Papier und Ansichtsfenster (`paperFor`): (paperW, paperH, vpW, vpH).
pub fn paper_for(w: f64, h: f64, scale: f64, margin: f64) -> (f64, f64, f64, f64) {
    const SIZES: [(f64, f64); 5] = [(297.0, 210.0), (420.0, 297.0), (594.0, 420.0), (841.0, 594.0), (1189.0, 841.0)];
    let need_w = (w * 1000.0) / scale + 2.0 * margin;
    let need_h = (h * 1000.0) / scale + 2.0 * margin;
    for (pw, ph) in SIZES {
        if need_w <= pw && need_h <= ph {
            return (pw, ph, pw - 2.0 * margin, ph - 2.0 * margin);
        }
        if need_w <= ph && need_h <= pw {
            return (ph, pw, ph - 2.0 * margin, pw - 2.0 * margin);
        }
    }
    let pw = (need_w / 10.0).ceil() * 10.0;
    let ph = (need_h / 10.0).ceil() * 10.0;
    (pw, ph, pw - 2.0 * margin, ph - 2.0 * margin)
}

/// `/^#?([0-9a-f]{6})$/i` nach JS-`trim` → 0xRRGGBB, sonst dunkelgrau.
fn rgb_from_hex(hex: &str) -> f64 {
    let t = js_trim(hex);
    let h = t.strip_prefix('#').unwrap_or(t);
    if h.len() == 6 && h.bytes().all(|c| c.is_ascii_hexdigit()) {
        return i64::from_str_radix(h, 16).map_or(0x111111 as f64, |v| v as f64);
    }
    0x111111 as f64
}

/// `/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i` → 0xRRGGBB, sonst `None` (Farbe der Ebene).
fn rgb_or_null(hex: &str) -> Option<f64> {
    let t = js_trim(hex);
    let h = t.strip_prefix('#').unwrap_or(t);
    if !h.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let full: String = match h.len() {
        6 => h.to_string(),
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        _ => return None,
    };
    i64::from_str_radix(&full, 16).ok().map(|v| v as f64)
}

/// Millimeter → DXF-LWEIGHT (1/100 mm).
fn mm_to_lwe(mm: f64) -> f64 {
    jsnum::max(0.0, jsnum::round(mm * 100.0))
}

/// Strichmuster (mm) → Zyklus in Welt-Metern; ungerade Länge verdoppelt; `None` = durchgezogen.
fn dash_cycle_meters(dash: &[f64]) -> Option<Vec<f64>> {
    let pat: Vec<f64> = dash.iter().map(|d| jsnum::max(0.0, *d) * hatch::DASH_MM_TO_M).filter(|d| *d > 0.0).collect();
    if pat.is_empty() {
        return None;
    }
    Some(if pat.len() % 2 == 0 { pat } else { [pat.clone(), pat].concat() })
}

/// Eine Schraffurlinie in durchgezogene Teilstücke nach `cycle` (`dashSeg`).
fn dash_seg(a: V2, b: V2, cycle: &[f64]) -> Vec<(V2, V2)> {
    let mut out = Vec::new();
    let len = hypot(&[b.x - a.x, b.y - a.y]);
    if len < 1e-9 {
        return out;
    }
    let ux = (b.x - a.x) / len;
    let uy = (b.y - a.y) / len;
    let mut pos = 0.0;
    let mut idx = 0usize;
    let mut on = true;
    while pos < len - 1e-9 {
        let step = jsnum::min(cycle[idx % cycle.len()], len - pos);
        if on && step > 1e-9 {
            out.push((V2 { x: a.x + ux * pos, y: a.y + uy * pos }, V2 { x: a.x + ux * (pos + step), y: a.y + uy * (pos + step) }));
        }
        pos += step;
        idx += 1;
        on = !on;
    }
    out
}

/// Muster, die nicht als DXF-Linienscharen gehen und als Polylinien geschrieben werden ([109]).
fn is_curve_pattern(p: Pattern) -> bool {
    matches!(
        p,
        Pattern::Insulation | Pattern::InsulationHard | Pattern::InsulationWave | Pattern::Timber | Pattern::Earth | Pattern::Gravel | Pattern::Stone | Pattern::Dots | Pattern::WoodBased | Pattern::Wood | Pattern::Barrier
    )
}

/// Linienscharen einer Vektor-Schraffur als (Winkel rad, Abstand m) (`hatchFamilies`).
fn hatch_families(h: &Hatch) -> Vec<(f64, f64)> {
    let unit_m = 1.0 / 90.0;
    let tile_m = 8.0 * h.scale * unit_m;
    let spacing = jsnum::max(0.02, tile_m);
    if !spacing.is_finite() {
        return Vec::new();
    }
    let angle = (h.angle * PI) / 180.0;
    let mut out = vec![(angle, spacing)];
    if h.pattern == Pattern::Crosshatch {
        out.push((angle + PI / 2.0, spacing));
    }
    out
}

/// Winkel (0..2π) von `c` nach `p`.
fn angle_rad(c: V2, p: V2) -> f64 {
    let a = jsnum::atan2(p.y - c.y, p.x - c.x);
    if a < 0.0 {
        a + 2.0 * PI
    } else {
        a
    }
}

/// `v.toFixed(2)` für Attribute, nicht endlich → leer.
fn m2(v: f64) -> String {
    if v.is_finite() {
        to_fixed(v, 2)
    } else {
        String::new()
    }
}

// ── Primitive des Plans ─────────────────────────────────────────────────────

/// Verlauf einer Schraffur (aus ihrem JSON).
#[derive(Clone, Debug)]
struct Gradient {
    color1: String,
    color2: String,
    angle: f64,
    radial: bool,
}

#[derive(Clone, Debug)]
struct HatchIn {
    h: Hatch,
    color: String,
    /// `None`: kein Verlauf (oder JSON fehlt/kaputt — dann ohne Verlauf, wie unlesbare Farben).
    gradient: Option<Gradient>,
}

/// Ein Plan-Primitiv in der Form, die der Sammler braucht.
#[derive(Clone, Debug)]
enum Prim {
    Line { a: V2, b: V2, cls: String, dash: Vec<f64>, zigzag: Option<(f64, f64)>, motif: Option<Motif> },
    Arc { center: V2, from: V2, to: V2, r: f64, dash: Vec<f64> },
    Polygon { pts: Vec<V2>, fill: String, stroke: String, hatch: Option<HatchIn> },
    Circle { center: V2, r: f64, dash: Vec<f64> },
    DrawingArc { center: V2, r: f64, a0: f64, a1: f64, dash: Vec<f64> },
    Single { at: V2, angle: f64, height: f64, wrap: f64, style: TextStyleIn, paras: Vec<(String, Vec<String>)> },
    Stamp { at: V2, lines: Vec<StampLine> },
    /// Textpfad, Bild, Platzhalter: nichts zu schreiben.
    Other,
}

/// Ids eines Primitivs (nicht leer = gesetzt, wie die JS-Wahrheitsprüfung).
#[derive(Clone, Debug, Default)]
struct Ids {
    wall: Option<String>,
    drawing: Option<String>,
    column: Option<String>,
    solid: Option<String>,
    room: Option<String>,
    opening: Option<String>,
}

struct Entry {
    prim: Prim,
    ids: Ids,
    /// `cls` einer Linie bzw. Typ-Kennung (für die Ebene).
    tag: u32,
}

fn pts_of(v: &[f64]) -> Vec<V2> {
    v.chunks_exact(2).map(|c| V2 { x: c[0], y: c[1] }).collect()
}

/// Eintrag `i` eines Abschnitts lesen; Hatch-Tabelle des Puffers gecacht.
fn read_entry(part: &mut Part, i: usize, hatches: &[(i32, Hatch, i32)], text: Option<&TextIn>) -> Option<Entry> {
    let view: &View = &part.view;
    let rec = view.rec(i)?;
    let f = &rec.f;
    let mut ids = Ids::default();
    for (kind, si) in pick_ids(view, &rec)? {
        let s = view.string(whole(si)?)?;
        if s.is_empty() {
            continue;
        }
        match kind {
            1 => ids.wall = Some(s),
            2 => ids.drawing = Some(s),
            4 => ids.opening = Some(s),
            6 => ids.room = Some(s),
            7 => ids.solid = Some(s),
            9 => ids.column = Some(s),
            _ => {}
        }
    }
    let dash = |rec: &crate::plan_buf::Rec| -> Option<Vec<f64>> {
        if rec.flags & F_DASH_NULL != 0 {
            return Some(Vec::new());
        }
        match rec.dash {
            Some((o, n)) => view.pool(o, n),
            None => Some(Vec::new()),
        }
    };
    let v = |x: f64, y: f64| V2 { x, y };
    let s = |idx: f64| -> Option<String> {
        if idx == -1.0 {
            Some(String::new())
        } else {
            view.string(whole(idx)?)
        }
    };
    let prim = match rec.tag {
        T_POLYGON => {
            let pts = pts_of(&view.pool(whole(f[5])?, whole(f[6])?.checked_mul(2)?)?);
            let hatch = if f[3] >= 0.0 {
                let (json, h, color) = hatches.get(whole(f[3])?)?.clone();
                let color = if color >= 0 { view.string(color as usize)? } else { String::new() };
                let gradient = if h.kind == HatchKind::Gradient && json >= 0 {
                    view.string(json as usize).and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok()).and_then(|j| {
                        let g = j.get("gradient")?;
                        Some(Gradient {
                            color1: g.get("color1")?.as_str()?.to_string(),
                            color2: g.get("color2")?.as_str()?.to_string(),
                            angle: g.get("angle").and_then(|a| a.as_f64()).unwrap_or(f64::NAN),
                            radial: g.get("type").and_then(|t| t.as_str()) == Some("radial"),
                        })
                    })
                } else {
                    None
                };
                Some(HatchIn { h, color, gradient })
            } else {
                None
            };
            Prim::Polygon { pts, fill: s(f[0])?, stroke: s(f[1])?, hatch }
        }
        T_LINE => Prim::Line {
            a: v(f[4], f[5]),
            b: v(f[6], f[7]),
            cls: s(f[0])?,
            dash: dash(&rec)?,
            zigzag: rec.zigzag,
            motif: match rec.motif {
                Some((length, o, n)) => Some(Motif { points: pts_of(&view.pool(o, n.checked_mul(2)?)?), length }),
                None => None,
            },
        },
        T_ARC => Prim::Arc { center: v(f[4], f[5]), from: v(f[6], f[7]), to: v(f[8], f[9]), r: f[10], dash: dash(&rec)? },
        T_CIRCLE => Prim::Circle { center: v(f[4], f[5]), r: f[6], dash: dash(&rec)? },
        T_DRAWING_ARC => Prim::DrawingArc { center: v(f[3], f[4]), r: f[5], a0: f[6], a1: f[7], dash: dash(&rec)? },
        T_TEXT => match text {
            Some(TextIn::Stamp { at, lines }) => Prim::Stamp { at: *at, lines: lines.clone() },
            _ => Prim::Other,
        },
        T_DRAWING_TEXT => match text {
            Some(TextIn::Single { at, angle, height, wrap, style, paras }) => {
                Prim::Single { at: *at, angle: *angle, height: *height, wrap: *wrap, style: style.clone(), paras: paras.clone() }
            }
            _ => Prim::Other,
        },
        _ => Prim::Other,
    };
    Some(Entry { prim, ids, tag: rec.tag })
}

/// Blocklokales System: Verschiebung `-origin`, Drehung `-rot`, Skalierung `1/scale`.
#[derive(Clone, Copy)]
struct Frame {
    origin: V2,
    rot: f64,
    scale: f64,
}

impl Frame {
    fn local(&self, p: V2) -> V2 {
        let c = jsnum::cos(self.rot);
        let s = jsnum::sin(self.rot);
        let dx = p.x - self.origin.x;
        let dy = p.y - self.origin.y;
        V2 { x: (dx * c + dy * s) / self.scale, y: (-dx * s + dy * c) / self.scale }
    }
}

/// Primitiv im lokalen System des Blocks (`primitiveToLocal`); andere Arten → `None`.
fn to_local(p: &Prim, f: Frame) -> Option<Prim> {
    let rot_deg = (f.rot * 180.0) / PI;
    Some(match p {
        Prim::Line { a, b, cls, dash, zigzag, .. } => Prim::Line {
            a: f.local(*a),
            b: f.local(*b),
            cls: cls.clone(),
            dash: dash.clone(),
            zigzag: zigzag.map(|(amp, wav)| (amp / f.scale, wav / f.scale)),
            motif: None,
        },
        Prim::Arc { center, from, to, r, dash } => Prim::Arc { center: f.local(*center), from: f.local(*from), to: f.local(*to), r: r / f.scale, dash: dash.clone() },
        Prim::Polygon { pts, fill, stroke, hatch } => Prim::Polygon {
            pts: pts.iter().map(|q| f.local(*q)).collect(),
            fill: fill.clone(),
            stroke: stroke.clone(),
            hatch: hatch.as_ref().map(|h| {
                let mut h = h.clone();
                h.h.angle -= rot_deg;
                h
            }),
        },
        Prim::Circle { center, r, dash } => Prim::Circle { center: f.local(*center), r: r / f.scale, dash: dash.clone() },
        Prim::DrawingArc { center, r, a0, a1, dash } => Prim::DrawingArc { center: f.local(*center), r: r / f.scale, a0: a0 - f.rot, a1: a1 - f.rot, dash: dash.clone() },
        Prim::Single { at, angle, height, wrap, style, paras } => Prim::Single {
            at: f.local(*at),
            angle: angle - f.rot,
            height: height / f.scale,
            // `p.wrapWidth && p.wrapWidth / f.scale`: 0/NaN bleiben.
            wrap: if *wrap != 0.0 && !wrap.is_nan() { wrap / f.scale } else { *wrap },
            style: style.clone(),
            paras: paras.clone(),
        },
        _ => return None,
    })
}

/// Zeilen eines Einzeltexts (`drawingTextLines`): Absätze, bei Spaltenbreite wortweise umbrochen
/// (`text_layout::wrap_words`, Zeichenzahl in UTF-16-Einheiten); Zeilenabstand 1.25 × Höhe.
fn single_lines(height: f64, wrap: f64, paras: &[(String, Vec<String>)]) -> Vec<(String, f64)> {
    let mut lines: Vec<String> = Vec::new();
    if wrap > 0.0 {
        let m = crate::text_layout::max_chars(wrap, height);
        for (_, words) in paras {
            crate::text_layout::wrap_words(words, m, &mut lines);
        }
    } else {
        lines.extend(paras.iter().map(|p| p.0.clone()));
    }
    lines.into_iter().enumerate().map(|(k, t)| (t, k as f64 * height * 1.25)).collect()
}

/// Eindeutige Blocknamen: gleiche Schlüssel teilen einen Namen, gleiche Wunschnamen werden nummeriert.
#[derive(Default)]
struct BlockNames {
    by_key: HashMap<String, String>,
    used: HashSet<String>,
}

impl BlockNames {
    fn name(&mut self, key: &str, wish: &str) -> (String, bool) {
        if let Some(n) = self.by_key.get(key) {
            return (n.clone(), false);
        }
        let mut name = wish.to_string();
        let mut i = 2;
        while self.used.contains(&name.to_lowercase()) {
            name = format!("{wish}_{i}");
            i += 1;
        }
        self.used.insert(name.to_lowercase());
        self.by_key.insert(key.to_string(), name.clone());
        (name, true)
    }
}

/// Gemeinsamer Zustand beim Sammeln.
struct Ctx<'a> {
    project: &'a Project,
    o: &'a DxfOptions,
    flat: Flat,
}

impl Ctx<'_> {
    fn ltype_of(&mut self, dash: &[f64]) -> f64 {
        if dash.is_empty() {
            return -1.0;
        }
        match dash_to_ltype_meters(dash, self.o.scale) {
            Some(el) => {
                let name = ltype_name_for(dash, &self.project.line_styles);
                self.flat.add_linetype(&name, &el)
            }
            None => -1.0,
        }
    }

    fn style_of(&mut self, s: Option<&TextStyleIn>) -> f64 {
        let (family, bold, italic) = match s {
            Some(s) => (s.family.clone(), s.bold, s.italic),
            None => (self.o.default_font.clone(), false, false),
        };
        let plain = family == self.o.default_font && !bold && !italic;
        let name = if plain { "DOSSIER".to_string() } else { format!("DOSSIER_{family}{}{}", if bold { "_B" } else { "" }, if italic { "_I" } else { "" }) };
        self.flat.add_text_style(&name, &family, bold, italic)
    }

    /// Ein Primitiv als Entität(en) (`emitPrimitive`); `hatch_layer` = Ebene der Schraffuren.
    fn emit(&mut self, b: &mut Buf, p: &Prim, layer: &str, hatch_layer: &str) {
        match p {
            Prim::Line { a, b: q, dash, zigzag, motif, .. } => {
                if let Some((amp, wav)) = zigzag {
                    let pts = hatch::zigzag_points(*a, *q, amp * hatch::DASH_MM_TO_M, wav * hatch::DASH_MM_TO_M).unwrap_or_else(|| vec![*a, *q]);
                    self.flat.set_pen(b, -1.0);
                    self.flat.add_polyline(b, layer, &pts, false);
                } else if let Some(m) = motif {
                    let pts = hatch::motif_points_opt(*a, *q, m, hatch::DASH_MM_TO_M).unwrap_or_else(|| vec![*a, *q]);
                    self.flat.set_pen(b, -1.0);
                    self.flat.add_polyline(b, layer, &pts, false);
                } else {
                    let lt = self.ltype_of(dash);
                    self.flat.set_pen(b, lt);
                    self.flat.add_line(b, layer, *a, *q);
                }
            }
            Prim::Arc { center, from, to, r, dash } => {
                let lt = self.ltype_of(dash);
                self.flat.set_pen(b, lt);
                let a1 = angle_rad(*center, *from);
                let a2 = angle_rad(*center, *to);
                let v1 = (from.x - center.x, from.y - center.y);
                let v2 = (to.x - center.x, to.y - center.y);
                let cross = v1.0 * v2.1 - v1.1 * v2.0;
                if cross >= 0.0 {
                    self.flat.add_arc(b, layer, *center, *r, a1, a2);
                } else {
                    self.flat.add_arc(b, layer, *center, *r, a2, a1);
                }
            }
            Prim::Circle { center, r, dash } => {
                let lt = self.ltype_of(dash);
                self.flat.set_pen(b, lt);
                self.flat.add_circle(b, layer, *center, *r);
            }
            Prim::DrawingArc { center, r, a0, a1, dash } => {
                let lt = self.ltype_of(dash);
                self.flat.set_pen(b, lt);
                self.flat.add_arc(b, layer, *center, *r, *a0, *a1);
            }
            Prim::Single { at, angle, height, wrap, style, paras } => {
                let dir = V2 { x: jsnum::sin(*angle), y: -jsnum::cos(*angle) };
                for (text, down) in single_lines(*height, *wrap, paras) {
                    if js_trim(&text).is_empty() || !(*height > 0.0) {
                        continue;
                    }
                    let p = V2 { x: at.x + dir.x * down, y: at.y + dir.y * down };
                    let st = self.style_of(Some(style));
                    self.flat.add_text2(b, layer, p, *height, *angle, &text, 0.0, st);
                }
            }
            Prim::Stamp { at, lines } => {
                for l in lines {
                    let st = self.style_of(Some(&l.style));
                    self.flat.add_text2(b, layer, V2 { x: at.x, y: at.y - l.down }, l.height, 0.0, &l.text, l.align, st);
                }
            }
            Prim::Polygon { pts, fill, stroke, hatch } => {
                if pts.len() < 2 {
                    return;
                }
                let (pattern, kind) = hatch.as_ref().map_or((Pattern::None, HatchKind::Vector), |h| (h.h.pattern, h.h.kind));
                // Unsichtbare Pick-Bänder: weder Füllung noch Umriss noch Schraffur.
                if stroke == "none" && fill == "none" && pattern == Pattern::None && kind != HatchKind::Gradient {
                    return;
                }
                let include = self.o.include_hatches;
                if let (true, Some(h)) = (include && kind == HatchKind::Gradient && pts.len() >= 3, hatch) {
                    if let Some(g) = &h.gradient {
                        if let (Some(c1), Some(c2)) = (rgb_or_null(&g.color1), rgb_or_null(&g.color2)) {
                            if g.angle.is_finite() {
                                self.flat.add_gradient(b, hatch_layer, pts, c1, c2, (g.angle * PI) / 180.0, g.radial);
                            }
                        }
                    }
                } else if let (true, Some(h)) = (include && kind != HatchKind::Image && pts.len() >= 3, hatch) {
                    if pattern == Pattern::Solid {
                        self.flat.add_hatch(b, hatch_layer, pts, true, rgb_or_null(&h.color), &[], &[]);
                    } else if pattern != Pattern::None && h.h.random {
                        let cycle = dash_cycle_meters(&hatch::hatch_dash(&h.h));
                        let segs: Vec<(V2, V2)> =
                            hatch::build_random_hatch_runs(pts, &h.h, None).into_iter().filter(|r| r.len() >= 2).map(|r| (r[0], r[r.len() - 1])).collect();
                        self.flat.set_pen(b, -1.0);
                        for (a, q) in segs {
                            match &cycle {
                                Some(c) => {
                                    for (x, y) in dash_seg(a, q, c) {
                                        self.flat.add_line(b, hatch_layer, x, y);
                                    }
                                }
                                None => self.flat.add_line(b, hatch_layer, a, q),
                            }
                        }
                    } else if is_curve_pattern(pattern) || h.h.polar.is_some() {
                        // Schicht-/Kurvenmuster ([109]: Dämmschlange, Zickzack, Welle, Holzkreuz, Erdreich,
                        // Kies, Naturstein) und polare Schraffur ([T2] Bogenwand) kennt DXF-HATCH nicht: als
                        // Polylinien aus dem Kern-Generator.
                        let runs = hatch::apply_dash_runs(hatch::build_hatch_runs(pts, &h.h), &hatch::hatch_dash(&h.h));
                        self.flat.set_pen(b, -1.0);
                        for run in runs.iter().filter(|r| r.len() >= 2) {
                            self.flat.add_polyline(b, hatch_layer, run, false);
                        }
                    } else if pattern != Pattern::None {
                        let families = hatch_families(&h.h);
                        if !families.is_empty() {
                            let dashes = dash_cycle_meters(&hatch::hatch_dash(&h.h)).unwrap_or_default();
                            self.flat.add_hatch(b, hatch_layer, pts, false, rgb_or_null(&h.color), &families, &dashes);
                        }
                    }
                }
                self.flat.set_pen(b, -1.0);
                self.flat.add_polyline(b, layer, pts, true);
            }
            Prim::Other => {}
        }
    }

    /// Bemassungskette → je Segment eine DIMENSION (`emitDimensions`).
    fn dimensions(&mut self, b: &mut Buf, d: &Drawing2D, layer: &str) {
        let Drawing2DGeom::Dimension { pts, offset, gap_mm, overshoot_mm, tick_len_mm, text_height_mm, text_offsets_mm, .. } = &d.geom else { return };
        let th = text_height_mm.unwrap_or(DIM_TEXT);
        let tick = tick_len_mm.unwrap_or(DIM_TICK);
        let gap = gap_mm.unwrap_or(DIM_GAP);
        let over = overshoot_mm.unwrap_or(DIM_OVERSHOOT);
        if ![th, tick, gap, over].iter().all(|v| v.is_finite() && *v >= 0.0) || th <= 0.0 {
            return;
        }
        let scale = self.o.scale;
        let cm = self.o.dim_cm;
        let is_default = th == DIM_TEXT && tick == DIM_TICK && gap == DIM_GAP && over == DIM_OVERSHOOT;
        let variant = if is_default { String::new() } else { format!("_{}-{}-{}-{}", js_number(th), js_number(tick), js_number(gap), js_number(over)).replace('.', ",") };
        let name = format!("DOSSIER_1-{}{}{}", js_number(scale), if cm { "_cm" } else { "" }, variant);
        let ts = self.style_of(None);
        let style = self.flat.add_dim_style(
            &name,
            [ts, scale, th / 1000.0, tick / 1000.0, gap / 1000.0, over / 1000.0, (th * 0.6) / 1000.0, if cm { 0.0 } else { 2.0 }, if cm { 100.0 } else { 1.0 }],
        );
        let mm = |v: f64| (v / 1000.0) * scale;
        let text_h = mm(th);
        for i in 0..pts.len().saturating_sub(1) {
            let a = V2 { x: pts[i].x, y: pts[i].y };
            let q = V2 { x: pts[i + 1].x, y: pts[i + 1].y };
            let len = hypot(&[q.x - a.x, q.y - a.y]);
            if len < 1e-6 {
                continue;
            }
            let nx = -(q.y - a.y) / len;
            let ny = (q.x - a.x) / len;
            let on = V2 { x: a.x + nx * offset, y: a.y + ny * offset };
            let text_at = text_offsets_mm.as_ref().and_then(|l| l.get(i)).filter(|o| o.along != 0.0 || o.perp != 0.0).map(|o| {
                let (base, read, up) = dim_text_frame(a, q, *offset, text_h);
                let (al, pe) = (mm(o.along), mm(o.perp));
                let pos = V2 { x: base.x + read.x * al + up.x * pe, y: base.y + read.y * al + up.y * pe };
                V2 { x: pos.x + up.x * (text_h / 2.0), y: pos.y + up.y * (text_h / 2.0) }
            });
            self.flat.add_dimension(b, layer, style, a, q, on, text_at);
        }
    }

    /// Blockinstanz → BLOCK je Definition + INSERT (`emitBlockInstance`); `false` = als lose Primitive.
    fn block_instance(&mut self, b: &mut Buf, d: &Drawing2D, prims: &[&Prim], layer: &str, names: &mut BlockNames) -> bool {
        let Drawing2DGeom::Block { block_def_id, at, rotation, scale, .. } = &d.geom else { return false };
        let Some(def) = self.project.block_defs.as_ref().and_then(|l| l.iter().find(|x| &x.id == block_def_id)) else { return false };
        let s = scale.unwrap_or(1.0);
        if !(s > 0.0) || !s.is_finite() || !rotation.is_finite() || !at.x.is_finite() || !at.y.is_finite() {
            return false;
        }
        let trimmed = js_trim(&def.name);
        let wish = if trimmed.is_empty() { "Block" } else { trimmed };
        let (name, fresh) = names.name(&format!("blockdef:{}", def.id), wish);
        let at = V2 { x: at.x, y: at.y };
        if fresh {
            let frame = Frame { origin: at, rot: *rotation, scale: s };
            let mut content = Buf::block();
            for p in prims {
                if let Some(lp) = to_local(p, frame) {
                    self.emit(&mut content, &lp, LAYER_ZERO, LAYER_ZERO);
                }
            }
            self.flat.set_pen(&mut content, -1.0);
            let desc = def.name.clone();
            self.flat.define_block(b, &name, &desc, &[], content);
        }
        self.flat.add_insert(b, layer, &name, at, *rotation, s, &[]);
        true
    }

    /// Tür/Fenster → BLOCK in Wandrichtung + INSERT mit Attributen (`emitOpening`).
    fn opening(&mut self, b: &mut Buf, o: &Opening, prims: &[&Prim], layer: &str, names: &mut BlockNames) -> bool {
        let Some(wall) = self.project.walls.iter().find(|w| w.id == o.host_wall_id) else { return false };
        let len = hypot(&[wall.end.x - wall.start.x, wall.end.y - wall.start.y]);
        if len < 1e-6 || !o.position.is_finite() {
            return false;
        }
        let ux = (wall.end.x - wall.start.x) / len;
        let uy = (wall.end.y - wall.start.y) / len;
        let origin = V2 { x: wall.start.x + ux * o.position, y: wall.start.y + uy * o.position };
        let rot = jsnum::atan2(uy, ux);
        let frame = Frame { origin, rot, scale: 1.0 };
        let mut content = Buf::block();
        for p in prims {
            if let Some(lp) = to_local(p, frame) {
                self.emit(&mut content, &lp, LAYER_ZERO, LAYER_ZERO);
            }
        }
        self.flat.set_pen(&mut content, -1.0);
        let is_door = o.kind == ElementKind::Door;
        let wall_opening = o.door_type == Some(OpeningDoorType::Wandoeffnung);
        let kind_name = if !is_door {
            "Fenster"
        } else if wall_opening {
            "Wandoeffnung"
        } else {
            "Tuer"
        };
        let cm = |v: f64| js_number(jsnum::round(v * 100.0));
        let wish = format!("{kind_name}_{}x{}", cm(o.width), cm(o.height));
        let key = format!("{kind_name}:{}", round_key(content.nums.as_deref().unwrap_or(&[])));
        let (name, fresh) = names.name(&key, &wish);
        let mut atts: Vec<(&str, &str, &str)> =
            vec![("ID", "Kennung", ""), ("TYP", "Art", kind_name), ("TYPENAME", "Typ", ""), ("BREITE_M", "Breite [m]", ""), ("HOEHE_M", "Hoehe [m]", "")];
        if !is_door {
            atts.push(("BRUESTUNG_M", "Bruestung [m]", ""));
        }
        let label = if !is_door {
            "Fenster"
        } else if wall_opening {
            "Wandöffnung"
        } else {
            "Tür"
        };
        if fresh {
            let desc = format!("{label} {} × {} m", m2(o.width), m2(o.height));
            self.flat.define_block(b, &name, &desc, &atts, content);
        }
        let type_name = o
            .type_id
            .as_ref()
            .and_then(|tid| {
                if is_door {
                    self.project.door_types.as_ref()?.iter().find(|t| &t.id == tid).map(|t| t.name.clone())
                } else {
                    self.project.window_types.as_ref()?.iter().find(|t| &t.id == tid).map(|t| t.name.clone())
                }
            })
            .unwrap_or_default();
        let mut values: Vec<(&str, String)> =
            vec![("ID", o.id.clone()), ("TYP", label.to_string()), ("TYPENAME", type_name), ("BREITE_M", m2(o.width)), ("HOEHE_M", m2(o.height))];
        if !is_door {
            values.push(("BRUESTUNG_M", m2(o.sill_height)));
        }
        self.flat.add_insert(b, layer, &name, origin, rot, 1.0, &values);
        true
    }
}

/// `dimTextFrame`: (Grundpunkt, Leserichtung, quer dazu).
fn dim_text_frame(a: V2, b: V2, offset: f64, text_height: f64) -> (V2, V2, V2) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let h = hypot(&[dx, dy]);
    let len = if h == 0.0 || h.is_nan() { 1.0 } else { h };
    let nx = -dy / len;
    let ny = dx / len;
    let mid = V2 { x: (a.x + b.x) / 2.0 + nx * offset, y: (a.y + b.y) / 2.0 + ny * offset };
    let mut angle = jsnum::atan2(dy, dx);
    if jsnum::cos(angle) < 0.0 {
        angle += PI;
    }
    let read = V2 { x: jsnum::cos(angle), y: jsnum::sin(angle) };
    let up = V2 { x: -jsnum::sin(angle), y: jsnum::cos(angle) };
    (V2 { x: mid.x + up.x * text_height * 0.6, y: mid.y + up.y * text_height * 0.6 }, read, up)
}

fn flatten<'a>(cats: &'a [LayerCategory], out: &mut Vec<&'a LayerCategory>) {
    for c in cats {
        out.push(c);
        if let Some(ch) = &c.children {
            flatten(ch, out);
        }
    }
}

/// Sammelt die flache Zeichnung aus den Abschnitten des Plans (Texte aus ihrem JSON). `None` bei
/// kaputtem Puffer.
pub fn collect(parts: &mut [Part], project: &Project, o: &DxfOptions) -> Option<FlatDxf> {
    let entries = read_entries(parts, o.scale, &o.default_font)?;

    let mut cx = Ctx { project, o, flat: Flat::new() };
    let mut main = Buf::main();

    // 1) Ebenen aus den Kategorien (Code_Name, Farbe, Strichstärke), dann die Sammel-Ebenen.
    let mut cats = Vec::new();
    flatten(&project.layers, &mut cats);
    let mut layer_by_code: HashMap<&str, String> = HashMap::new();
    for c in &cats {
        let name = format!("{}_{}", c.code, c.name);
        cx.flat.add_layer(&name, Some(rgb_from_hex(&c.color)), mm_to_lwe(c.lw));
        layer_by_code.insert(c.code.as_str(), name);
    }
    cx.flat.add_layer(LAYER_SYMBOLS, Some(0x111111 as f64), 18.0);
    cx.flat.add_layer(LAYER_HATCH, Some(0x888888 as f64), 13.0);
    cx.flat.add_layer(LAYER_CONTEXT, Some(0x9aa3ad as f64), 10.0);
    cx.flat.add_layer(LAYER_DEFAULT, Some(0x111111 as f64), 18.0);
    cx.flat.add_layer(LAYER_SECTIONS, Some(0x111111 as f64), 18.0);
    cx.flat.add_layer(LAYER_EXTRUSION, Some(rgb_from_hex("#d98c40")), 13.0);
    cx.flat.add_layer(LAYER_ZERO, None, 25.0);

    emit_entries(&mut cx, &mut main, &entries, &layer_by_code, true);
    cx.flat.set_pen(&mut main, -1.0);

    // 5) Papierbereich (optional): Layout mit Ansichtsfenster im Planmassstab.
    if o.paper_layout {
        let [min_x, min_y, max_x, max_y] = o.bounds;
        let w = max_x - min_x;
        let h = max_y - min_y;
        if [min_x, min_y, max_x, max_y].iter().all(|v| v.is_finite()) && w > 0.0 && h > 0.0 {
            let (pw, ph, vw, vh) = paper_for(w, h, o.scale, 10.0);
            let s = cx.flat.str(&format!("Plan 1-{}", js_number(o.scale)));
            cx.flat.push(&mut main, &[REC_LAYOUT, s, pw, ph, pw / 2.0, ph / 2.0, vw, vh, (min_x + max_x) / 2.0, (min_y + max_y) / 2.0, o.scale]);
        }
        sheets(&mut cx, &mut main, &layer_by_code);
    }
    let Flat { root, strings, block_counts, .. } = cx.flat;
    Some(FlatDxf { nums: root, strings, model: main.counts, blocks: block_counts })
}

/// Schritte 2–4 des Sammelns: Primitive (in Plan-Reihenfolge) in Entitäten von `main` übersetzen —
/// Bemassungen, Blockinstanzen und Öffnungen als CAD-Objekte, der Rest je Primitiv.
/// `objects = false`: auch Bemassungen, Blockinstanzen und Öffnungen nur als ihre Primitive (Inhalt
/// eines Blocks, der keine weiteren Blöcke definieren darf).
fn emit_entries(cx: &mut Ctx, main: &mut Buf, entries: &[Entry], layer_by_code: &HashMap<&str, String>, objects: bool) {
    let project = cx.project;
    // 2) Rückverweise Primitiv → Kategorie.
    let code_by_wall: HashMap<&str, &str> = project.walls.iter().map(|w| (w.id.as_str(), w.category_code.as_str())).collect();
    let code_by_drawing: HashMap<&str, &str> = project.drawings2d.iter().map(|d| (d.id.as_str(), d.category_code.as_str())).collect();
    let code_by_column: HashMap<&str, &str> = project.columns.iter().flatten().map(|c| (c.id.as_str(), c.category_code.as_str())).collect();
    let code_by_room: HashMap<&str, &str> = project.rooms.iter().flatten().map(|r| (r.id.as_str(), r.category_code.as_str())).collect();
    let layer_of_code = |m: &HashMap<&str, &str>, id: &str| -> Option<String> { layer_by_code.get(m.get(id).copied().unwrap_or("")).cloned() };
    let drawing_layer = |id: Option<&String>, fallback: &str| -> String {
        match id {
            Some(id) => layer_of_code(&code_by_drawing, id).unwrap_or_else(|| LAYER_DEFAULT.to_string()),
            None => fallback.to_string(),
        }
    };
    let layer_for = |e: &Entry| -> String {
        match e.tag {
            T_POLYGON => {
                if let Some(w) = &e.ids.wall {
                    return layer_of_code(&code_by_wall, w).unwrap_or_else(|| LAYER_DEFAULT.to_string());
                }
                if e.ids.drawing.is_some() {
                    return drawing_layer(e.ids.drawing.as_ref(), LAYER_DEFAULT);
                }
                if let Some(c) = &e.ids.column {
                    return layer_of_code(&code_by_column, c).unwrap_or_else(|| LAYER_DEFAULT.to_string());
                }
                if e.ids.solid.is_some() {
                    return LAYER_EXTRUSION.to_string();
                }
                LAYER_DEFAULT.to_string()
            }
            T_LINE => {
                let cls = match &e.prim {
                    Prim::Line { cls, .. } => cls.as_str(),
                    _ => "",
                };
                if cls == "context-line" {
                    return LAYER_CONTEXT.to_string();
                }
                if cls == "section-line" {
                    return LAYER_SECTIONS.to_string();
                }
                drawing_layer(e.ids.drawing.as_ref(), LAYER_SYMBOLS)
            }
            T_DRAWING_TEXT => drawing_layer(e.ids.drawing.as_ref(), LAYER_SYMBOLS),
            T_TEXT => match &e.ids.room {
                Some(r) => layer_of_code(&code_by_room, r).unwrap_or_else(|| LAYER_SYMBOLS.to_string()),
                None => LAYER_SYMBOLS.to_string(),
            },
            _ => LAYER_SYMBOLS.to_string(),
        }
    };

    // 3) Gruppen: Bemassungen, Blockinstanzen und Öffnungen werden CAD-Objekte.
    let mut dim_by_id: HashMap<&str, &Drawing2D> = HashMap::new();
    let mut block_by_id: HashMap<&str, &Drawing2D> = HashMap::new();
    for d in &project.drawings2d {
        match d.geom {
            // Radius-/Durchmesser-/Bogenmass (`kind`) und Bogenmass [T2] (`arcCenter`) gehen als Linien, Bögen und Text hinaus.
            Drawing2DGeom::Dimension { kind: None, arc_center: None, .. } => {
                dim_by_id.insert(d.id.as_str(), d);
            }
            Drawing2DGeom::Block { .. } => {
                block_by_id.insert(d.id.as_str(), d);
            }
            _ => {}
        }
    }
    let opening_by_id: HashMap<&str, &Opening> = project.openings.iter().flatten().map(|x| (x.id.as_str(), x)).collect();
    let group_key = |e: &Entry| -> Option<(u8, String)> {
        if !objects {
            return None;
        }
        if let Some(did) = &e.ids.drawing {
            if dim_by_id.contains_key(did.as_str()) {
                return Some((b'd', did.clone()));
            }
            if block_by_id.contains_key(did.as_str()) {
                return Some((b'b', did.clone()));
            }
        }
        if let Some(oid) = &e.ids.opening {
            if opening_by_id.contains_key(oid.as_str()) {
                return Some((b'o', oid.clone()));
            }
        }
        None
    };
    let keys: Vec<Option<(u8, String)>> = entries.iter().map(group_key).collect();
    let mut groups: HashMap<&(u8, String), Vec<usize>> = HashMap::new();
    for (i, k) in keys.iter().enumerate() {
        if let Some(k) = k {
            groups.entry(k).or_default().push(i);
        }
    }
    let mut names = BlockNames::default();
    let mut done: HashSet<&(u8, String)> = HashSet::new();

    // 4) Jedes Primitiv in Entitäten übersetzen.
    for (i, e) in entries.iter().enumerate() {
        if let Some(key) = &keys[i] {
            if !done.insert(key) {
                continue;
            }
            let members: Vec<&Entry> = groups.get(key).map(|l| l.iter().map(|&k| &entries[k]).collect()).unwrap_or_default();
            let prims: Vec<&Prim> = members.iter().map(|m| &m.prim).collect();
            let id = key.1.as_str();
            match key.0 {
                b'd' => {
                    let d = dim_by_id[id];
                    let layer = drawing_layer(Some(&key.1), LAYER_DEFAULT);
                    cx.dimensions(main, d, &layer);
                }
                b'b' => {
                    let d = block_by_id[id];
                    let layer = drawing_layer(Some(&d.id), LAYER_DEFAULT);
                    if !cx.block_instance(main, d, &prims, &layer, &mut names) {
                        for m in &members {
                            let l = layer_for(m);
                            cx.emit(main, &m.prim, &l, LAYER_HATCH);
                        }
                    }
                }
                _ => {
                    let op = opening_by_id[id];
                    let layer = layer_by_code.get(op.category_code.as_str()).cloned().unwrap_or_else(|| LAYER_SYMBOLS.to_string());
                    if !cx.opening(main, op, &prims, &layer, &mut names) {
                        for m in &members {
                            let l = layer_for(m);
                            cx.emit(main, &m.prim, &l, LAYER_HATCH);
                        }
                    }
                }
            }
            continue;
        }
        let l = layer_for(e);
        cx.emit(main, &e.prim, &l, LAYER_HATCH);
    }
}

/// Primitive der Abschnitte in Plan-Reihenfolge lesen (Texte gesetzt beim Massstab `scale`).
fn read_entries(parts: &mut [Part], scale: f64, font: &str) -> Option<Vec<Entry>> {
    let mut entries: Vec<Entry> = Vec::new();
    for part in parts.iter_mut() {
        let hatches = part.view.hatch_table()?;
        for i in part.from..part.to {
            let text = crate::plan_text::read_text(part, i).map(|t| crate::plan_text::dxf_text(&t, scale, font));
            entries.push(read_entry(part, i, &hatches, text.as_ref())?);
        }
    }
    Some(entries)
}

/// Papierbereiche der Projekt-Layouts ([93]): je Layout ein Blatt in mm, die Ansichtsfenster, die die
/// exportierte Ebene zeigen (Mitte/Massstab wie in der App, `sheet_viewports.rs`), und die Zeichnung der
/// Blatt-Ebene als Block (Papier-Meter, y nach oben mit Ursprung oben links), eingefügt mit Faktor
/// 1000 an der oberen linken Papierecke. Im Block bleiben Bemassungen/Blöcke einfache Primitive.
fn sheets(cx: &mut Ctx, main: &mut Buf, layer_by_code: &HashMap<&str, String>) {
    use crate::plan::domains::{plan_domains_buf, PlanArgs};
    let p = cx.project;
    let codes: HashSet<String> = p.flat_categories().iter().map(|c| c.code.clone()).collect();
    let mut used: HashSet<String> = HashSet::new();
    used.insert(format!("Plan 1-{}", js_number(cx.o.scale)));
    for (n, layout) in p.layouts.iter().flatten().enumerate() {
        let master = layout.master_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.master_layouts.iter().flatten().find(|m| m.id == id));
        let size = match master {
            Some(m) => serde_json::to_value(m).ok(),
            None => serde_json::to_value(layout).ok(),
        }
        .and_then(|v| crate::layout_model::effective_sheet_size(&v));
        let Some((pw, ph)) = size else { continue };
        // Eindeutiger Name (gleichnamige Blätter, Kollision mit dem Plan-Layout).
        let base = if js_trim(&layout.name).is_empty() { format!("Blatt {}", n + 1) } else { layout.name.clone() };
        let mut name = base.clone();
        let mut k = 2;
        while used.contains(&name) {
            name = format!("{base} ({k})");
            k += 1;
        }
        used.insert(name.clone());
        let name_s = cx.flat.str(&name);
        // Blatt-Zeichnung als Block (vor dem Blatt definiert).
        let mut block: Option<String> = None;
        if let Some(level) = p.drawing_levels.iter().find(|l| l.layout_id.as_deref() == Some(layout.id.as_str())) {
            if p.drawings2d.iter().any(|d| d.level_id == level.id) {
                let args = PlanArgs {
                    floor: level.id.clone(),
                    detail: crate::plan::style::Detail::Mittel,
                    show: codes.clone(),
                    grey: HashSet::new(),
                    reference_lines: false,
                    global: false,
                    scale: 1.0,
                    for_print: true,
                    compact: false,
                    mono: false,
                    sun_when: None,
                };
                if let Some(entries) = plan_domains_buf(p, &args).ok().and_then(|buf| {
                    let view = View::parse(&buf)?;
                    let len = view.len();
                    let mut parts = [Part::new(view, 0, len)?];
                    read_entries(&mut parts, 1.0, &cx.o.default_font)
                }) {
                    let o1 = DxfOptions { scale: 1.0, include_hatches: cx.o.include_hatches, dim_cm: cx.o.dim_cm, paper_layout: false, bounds: [0.0; 4], default_font: cx.o.default_font.clone(), floor: String::new(), table_labels: String::new() };
                    let mut sub = Ctx { project: p, o: &o1, flat: std::mem::replace(&mut cx.flat, Flat::new()) };
                    let mut content = Buf::block();
                    emit_entries(&mut sub, &mut content, &entries, layer_by_code, false);
                    let bname = format!("SHEET_{}", n + 1);
                    sub.flat.define_block(main, &bname, &name, &[], content);
                    cx.flat = sub.flat;
                    block = Some(bname);
                }
            }
        }
        cx.flat.push(main, &[REC_SHEET, name_s, pw, ph]);
        if !cx.o.floor.is_empty() {
            for m in crate::sheet_viewports::viewport_maps(p, layout).iter().filter(|m| m.level == cx.o.floor) {
                cx.flat.push(main, &[REC_SHEET_VP, name_s, m.x_mm + m.w_mm / 2.0, ph - (m.y_mm + m.h_mm / 2.0), m.w_mm, m.h_mm, m.cx, m.cy, m.scale]);
            }
        }
        if let Some(b) = block {
            let bs = cx.flat.str(&b);
            cx.flat.push(main, &[REC_SHEET_INSERT, name_s, bs, 0.0, ph, 1000.0]);
        }
        // Blatt-Tabellen ([111]): Text und Linien als Block in Papier-Metern (wie die Blatt-Zeichnung).
        let labels = crate::sheet_table::Labels::parse(&serde_json::from_str::<serde_json::Value>(&cx.o.table_labels).unwrap_or_default());
        let tables = crate::sheet_table::render(p, layout, &labels);
        if tables.iter().any(|t| !t.prims.is_empty()) {
            let mut content = Buf::block();
            for t in &tables {
                for pr in &t.prims {
                    match pr {
                        crate::sheet_table::TPrim::Line { x1, y1, x2, y2, .. } => cx.flat.add_line(&mut content, "TABELLE", V2 { x: x1 / 1000.0, y: -y1 / 1000.0 }, V2 { x: x2 / 1000.0, y: -y2 / 1000.0 }),
                        crate::sheet_table::TPrim::Text { x, y, s, size, bold, italic, font, align } => {
                            let family = match *font {
                                "serif" => "Times New Roman".to_string(),
                                "mono" => "Courier New".to_string(),
                                _ => cx.o.default_font.clone(),
                            };
                            let st = cx.flat.add_text_style(&format!("TABELLE_{font}{}{}", if *bold { "_B" } else { "" }, if *italic { "_I" } else { "" }), &family, *bold, *italic);
                            cx.flat.add_text2(&mut content, "TABELLE", V2 { x: x / 1000.0, y: -y / 1000.0 }, size / 1000.0, 0.0, s, if *align == "r" { 2.0 } else { 0.0 }, st);
                        }
                    }
                }
            }
            let bname = format!("SHEETTAB_{}", n + 1);
            cx.flat.define_block(main, &bname, &name, &[], content);
            let bs = cx.flat.str(&bname);
            cx.flat.push(main, &[REC_SHEET_INSERT, name_s, bs, 0.0, ph, 1000.0]);
        }
    }
}

/// Ergebnis als Bytes: f64-Teil `[MAGIC "DXF1", nZahlen, nTexte, 8 Modell-, 8 Block-Zähler,
/// Zahlen…, Länge je Text…]`, danach die Texte als UTF-16.
pub fn encode(f: &FlatDxf) -> Vec<u8> {
    let mut head: Vec<f64> = vec![DXF_MAGIC, f.nums.len() as f64, f.strings.len() as f64];
    head.extend(f.model.iter().map(|v| *v as f64));
    head.extend(f.blocks.iter().map(|v| *v as f64));
    head.extend_from_slice(&f.nums);
    let units: Vec<Vec<u16>> = f.strings.iter().map(|s| s.encode_utf16().collect()).collect();
    head.extend(units.iter().map(|u| u.len() as f64));
    let mut out = Vec::with_capacity(head.len() * 8 + units.iter().map(|u| u.len() * 2).sum::<usize>());
    for v in head {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for u in units {
        for c in u {
            out.extend_from_slice(&c.to_le_bytes());
        }
    }
    out
}

/// Kennung der Antwort (`"DXF1"`).
pub const DXF_MAGIC: f64 = 0x4458_4631 as f64;

#[cfg(test)]
mod tests {
    use super::*;

    /// [93] Mit Papierbereich: das Projekt-Layout als Blatt, sein Ansichtsfenster auf das exportierte
    /// Geschoss und die Blatt-Zeichnung als Block, eingefügt mit Faktor 1000 oben links.
    #[test]
    fn projekt_layout_mit_blatt_zeichnung() {
        let mut v = crate::sheet_viewports::tests::json();
        v["drawings2d"].as_array_mut().unwrap().push(serde_json::json!(
            {"id": "s1", "levelId": "sh", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": 0.02, "y": -0.02}, "b": {"x": 0.1, "y": -0.02}}}
        ));
        let p: Project = serde_json::from_value(v).unwrap();
        let a = crate::plan::domains::PlanArgs::parse(1.0, r#"{"floor":"eg","show":["20"],"scale":100}"#).unwrap();
        let buf = crate::plan::domains::plan_domains_buf(&p, &a).unwrap();
        let view = View::parse(&buf).unwrap();
        let len = view.len();
        let mut parts = [Part::new(view, 0, len).unwrap()];
        let o = DxfOptions { scale: 100.0, include_hatches: true, dim_cm: false, paper_layout: true, bounds: [0.0, 0.0, 10.0, 4.0], default_font: "Arial".into(), floor: "eg".into(), table_labels: String::new() };
        let f = collect(&mut parts, &p, &o).unwrap();
        let find = |rec: f64, n: usize| -> Vec<Vec<f64>> {
            f.nums.windows(n).filter(|w| w[0] == rec && f.strings.get(w[1] as usize).is_some_and(|s| s == "Blatt")).map(|w| w.to_vec()).collect()
        };
        let sheet = find(REC_SHEET, 4);
        assert_eq!(sheet.len(), 1);
        assert_eq!(&sheet[0][2..], &[420.0, 297.0]);
        let vp = find(REC_SHEET_VP, 9);
        assert_eq!(vp.len(), 1);
        // Rechteck (100, 50, 200 × 100 mm) → Mitte (200, 297 − 100) im DXF-Papier (y nach oben), 1:100.
        assert_eq!(&vp[0][2..6], &[200.0, 197.0, 200.0, 100.0]);
        assert_eq!(vp[0][8], 100.0);
        let ins = find(REC_SHEET_INSERT, 6);
        assert_eq!(ins.len(), 1);
        assert_eq!(f.strings[ins[0][2] as usize], "SHEET_1");
        assert_eq!(&ins[0][3..], &[0.0, 297.0, 1000.0]);
        assert!(f.strings.iter().any(|s| s == "SHEET_1") && f.nums.contains(&REC_BLOCK));
        // Ohne Geschoss kein Ansichtsfenster.
        let o2 = DxfOptions { floor: String::new(), ..o };
        let view = View::parse(&buf).unwrap();
        let mut parts = [Part::new(view, 0, len).unwrap()];
        let f2 = collect(&mut parts, &p, &o2).unwrap();
        assert!(!f2.nums.windows(2).any(|w| w[0] == REC_SHEET_VP && f2.strings.get(w[1] as usize).is_some_and(|s| s == "Blatt")));
    }

    /// [111] Blatt-Tabelle als Block mit Text und Linien, eingefügt oben links.
    #[test]
    fn blatt_tabelle_im_dxf() {
        let mut v = crate::sheet_viewports::tests::json();
        v["layouts"][0]["tables"] = serde_json::json!([{"id": "t", "source": "openings", "xMm": 10, "yMm": 20, "widthMm": 100}]);
        let p: Project = serde_json::from_value(v).unwrap();
        let a = crate::plan::domains::PlanArgs::parse(1.0, r#"{"floor":"eg","show":["20"],"scale":100}"#).unwrap();
        let buf = crate::plan::domains::plan_domains_buf(&p, &a).unwrap();
        let view = View::parse(&buf).unwrap();
        let len = view.len();
        let mut parts = [Part::new(view, 0, len).unwrap()];
        let o = DxfOptions { scale: 100.0, include_hatches: true, dim_cm: false, paper_layout: true, bounds: [0.0, 0.0, 10.0, 4.0], default_font: "Arial".into(), floor: "eg".into(), table_labels: r#"{"openings.col.mark":"Nr."}"#.into() };
        let f = collect(&mut parts, &p, &o).unwrap();
        assert!(f.strings.iter().any(|s| s == "SHEETTAB_1"), "Tabellen-Block");
        assert!(f.strings.iter().any(|s| s == "Nr."), "Kopf beschriftet");
        assert!(f.nums.contains(&REC_TEXT2) && f.nums.contains(&REC_LINE));
    }

    #[test]
    fn linientyp_aus_strichmuster() {
        assert_eq!(dash_to_ltype_meters(&[2.0, 1.0], 100.0), Some(vec![0.2, -0.1]));
        // Ungerade Länge wird verdoppelt, Lücke 0 → 1 µm.
        assert_eq!(dash_to_ltype_meters(&[3.0], 50.0).map(|v| v.len()), Some(2));
        assert_eq!(dash_to_ltype_meters(&[1.0, 0.0], 100.0), Some(vec![0.1, -1e-6]));
        assert_eq!(dash_to_ltype_meters(&[0.0, 0.0], 100.0), None);
        assert_eq!(dash_to_ltype_meters(&[], 100.0), None);
        assert_eq!(ltype_name_for(&[2.0, 0.5], &[]), "DOSSIER_STRICH_2_0.5");
        let r6 = |v: Vec<f64>| v.iter().map(|x| (x * 1e6).round() / 1e6).collect::<Vec<_>>();
        assert_eq!(r6(dash_to_ltype_meters(&[2.0, 1.0, 0.5], 50.0).unwrap()), vec![0.1, -0.05, 0.025, -0.1, 0.05, -0.025]);
        // Punkt (Strich 0) bleibt 0.
        assert_eq!(dash_to_ltype_meters(&[0.0, 1.0], 100.0).unwrap()[0], 0.0);
        // Projekt-Linienstil mit gleichem Muster (Name getrimmt); andere Arten zählen nicht.
        let st = |name: &str, kind: Option<LineStyleKind>| LineStyle { name: name.into(), dash: Some(vec![3.0, 1.0]), kind, ..Default::default() };
        assert_eq!(ltype_name_for(&[3.0, 1.0], &[st(" Strichlinie ", None)]), "Strichlinie");
        assert_eq!(ltype_name_for(&[3.0, 1.0], &[st("Zz", Some(LineStyleKind::Zigzag)), st("  ", None)]), "DOSSIER_STRICH_3_1");
    }

    #[test]
    fn blocklokal_verschoben_gedreht_skaliert() {
        let f = Frame { origin: V2 { x: 10.0, y: 5.0 }, rot: PI / 2.0, scale: 2.0 };
        let Some(Prim::Line { a, b, .. }) = to_local(&Prim::Line { a: V2 { x: 10.0, y: 5.0 }, b: V2 { x: 10.0, y: 9.0 }, cls: "x".into(), dash: vec![], zigzag: None, motif: None }, f) else { panic!() };
        assert!(a.x.abs() < 1e-12 && a.y.abs() < 1e-12);
        // 4 m in Richtung +y = lokale +x, durch Skalierung 2.
        assert!((b.x - 2.0).abs() < 1e-12 && b.y.abs() < 1e-12);
        let style = TextStyleIn { family: "Arial".into(), bold: false, italic: false };
        let Some(Prim::Single { height, angle, wrap, .. }) = to_local(&Prim::Single { at: V2 { x: 10.0, y: 5.0 }, angle: PI / 2.0, height: 0.4, wrap: 0.0, style, paras: vec![] }, f) else { panic!() };
        assert!((height - 0.2).abs() < 1e-12 && angle.abs() < 1e-12 && wrap == 0.0);
        let Some(Prim::Circle { center, r, .. }) = to_local(&Prim::Circle { center: V2 { x: 10.0, y: 7.0 }, r: 1.0, dash: vec![] }, f) else { panic!() };
        assert!((r - 0.5).abs() < 1e-12 && (center.x - 1.0).abs() < 1e-12);
        assert!(to_local(&Prim::Other, f).is_none());
        assert_eq!(round_key(&[1.0001, 2.0]), round_key(&[1.0004, 2.0]));
        assert_ne!(round_key(&[1.0001, 2.0]), round_key(&[1.002, 2.0]));
    }

    #[test]
    fn papierformat_und_schluessel() {
        // 20 × 10 m bei 1:100 → 220 × 120 mm passt auf A4 quer.
        assert_eq!(paper_for(20.0, 10.0, 100.0, 10.0), (297.0, 210.0, 277.0, 190.0));
        // Hochformat-Ausschnitt → A4 hoch.
        assert_eq!(paper_for(10.0, 20.0, 100.0, 10.0), (210.0, 297.0, 190.0, 277.0));
        // Zu gross für A0 → Sonderformat in 10-mm-Schritten.
        assert_eq!(paper_for(200.0, 100.0, 100.0, 10.0).0, 2020.0);
        // 30 × 18 m bei 1:100 → A3.
        assert_eq!(paper_for(30.0, 18.0, 100.0, 10.0).0, 420.0);
        assert_eq!(round_key(&[0.0004, -0.0004, 1.2345]), "0,0,1235,");
    }

    #[test]
    fn farben_und_zeilen() {
        assert_eq!(rgb_from_hex(" #A0b1C2 "), 0xa0b1c2 as f64);
        assert_eq!(rgb_from_hex("rot"), 0x111111 as f64);
        assert_eq!(rgb_or_null("#abc"), Some(0xaabbcc as f64));
        assert_eq!(rgb_or_null("none"), None);
        let words = |s: &str| s.split(' ').map(|w| w.to_string()).collect::<Vec<_>>();
        let lines = single_lines(1.0, 3.0, &[("aa bb cc".into(), words("aa bb cc"))]);
        // maxChars = floor(3 / 0.55) = 5 → "aa bb", "cc".
        assert_eq!(lines.iter().map(|l| l.0.as_str()).collect::<Vec<_>>(), vec!["aa bb", "cc"]);
        assert_eq!(lines[1].1, 1.25);
    }
}
