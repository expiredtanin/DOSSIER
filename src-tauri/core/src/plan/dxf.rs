//! DXF-/DWG-Sammler des Grundrisses ([K3d], früher `src/export/exportDxf.ts::collectPlanDrawing`
//! und `dxfCadParts.ts`): liest den zusammengesetzten Plan ([`crate::plan::parts`]) und das Projekt
//! und schreibt die flache Zeichnung, die `src-tauri/fileio/src/export.rs` zur Datei macht
//! (Kodierung dort; Gegenstück der früheren TS-Klasse `FlatDrawing`). Modell-Space in echten
//! Metern, Ebenen aus den Kategorien, Bemassungen als DIMENSION, Türen/Fenster und Blockinstanzen
//! als BLOCK + INSERT, Schraffuren als HATCH, Strichmuster als Linientypen.
//!
//! Gleiche Eingabe ⇒ dieselben Zahlen und Zeichenketten in derselben Reihenfolge wie die TS-Fassung
//! (Zeichenketten-Indizes nach erstem Gebrauch, Definitionen an der Stelle ihres ersten Gebrauchs).
//! Texte: die Zeilen der Raumstempel und die Absätze/Wörter der Einzeltexte setzt der Kern aus dem
//! Text-JSON des Puffers ([`crate::plan::text::dxf_text`] → [`TextIn`]); der Zeilenumbruch nach
//! Spaltenbreite läuft hier (er hängt in Blöcken an der blocklokalen Grösse).

use crate::hatch::{self, Hatch, HatchKind, Motif, Pattern, V2};
use crate::js_fmt::{js_number, to_fixed};
use crate::jsmath::hypot;
use crate::jsnum;
use crate::model::{Drawing2D, Drawing2DGeom, ElementKind, LayerCategory, LineStyle, LineStyleKind, Opening, OpeningDoorType, Project};
use crate::plan::overrides::js_trim;
use crate::plan::buf::{whole, View, F_DASH_NULL, T_ARC, T_CIRCLE, T_DRAWING_ARC, T_DRAWING_TEXT, T_LINE, T_POLYGON, T_TEXT};
use crate::plan::parts::{pick_ids, Part};
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
/// [146] Linienenden/-ecken des Projekts `[cap | join << 2]` → `$ENDCAPS`/`$JOINSTYLE`.
const REC_LINE_ENDS: f64 = 23.0;
/// [169] LWPOLYLINE mit Bulges: `[Ebene, geschlossen, n, n × (x, y, bulge)]`.
const REC_POLYLINE_BULGE: f64 = 24.0;
/// [169] HATCH mit Bögen im Rand (Randpunkte mit Bulge), fileio Satz 25.
const REC_HATCH_BULGE: f64 = 25.0;
/// [169] Ellipsenbogen (schräg gesehenes Rundbogenfenster), fileio Satz 26.
const REC_ELLIPSE: f64 = 26.0;
/// [200] Stift der folgenden Entitäten: `[rgb (0xRRGGBB, −1 = nach Ebene), Strichstärke (1/100 mm, −1 = nach Ebene)]`,
/// gilt bis zum nächsten Satz (Blockinhalte beginnen wieder „nach Ebene").
const REC_ENTITY_PEN: f64 = 27.0;

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
const DIM_TICK: f64 = 2.0;
const DIM_TEXT: f64 = 2.5;

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
    /// Standard-Schrift (erste Schrift der Projekt-Textstile, sonst Arial; [`crate::plan::text::default_font`]).
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
    /// [200] Textfarbe (CSS-Hex der ersten Textstrecke der Zeile, wie die Anzeige).
    pub color: String,
    /// Versatz der Grundlinie vom Anker nach unten (Meter).
    pub down: f64,
    /// [140] Versatz der Zeile vom Anker nach rechts (Meter; Block um den Anker zentriert,
    /// `text_layout::stamp_line_offsets`).
    pub dx: f64,
}

/// Text-Eingabe je Text-Eintrag (aus dem Text-JSON gesetzt, s. [`crate::plan::text::dxf_text`]).
#[derive(Clone, Debug, PartialEq)]
pub enum TextIn {
    /// `text` (Raumstempel): Anker und Zeilen.
    Stamp { at: V2, lines: Vec<StampLine> },
    /// `drawingText`: Anker, Winkel, Höhe, Spaltenbreite (NaN = keine), Schrift und Absätze
    /// (Text des Absatzes, Wörter nach `split(/\s+/)`).
    /// `color` [200]: Textfarbe (Hex).
    Single { at: V2, angle: f64, height: f64, wrap: f64, style: TextStyleIn, color: String, paras: Vec<(String, Vec<String>)> },
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
    /// [200] Stift (Farbe, Strichstärke) der zuletzt geschriebenen Entität; (−1, −1) = nach Ebene.
    epen: (f64, f64),
    counts: [u32; 8],
}

impl Buf {
    fn main() -> Buf {
        Buf { nums: None, pen: -1.0, epen: (-1.0, -1.0), counts: [0; 8] }
    }
    fn block() -> Buf {
        Buf { nums: Some(Vec::new()), pen: -1.0, epen: (-1.0, -1.0), counts: [0; 8] }
    }
}

/// Was Hauptzeichnung und Blockinhalte teilen (Definitionen landen immer in `root`).
struct Flat {
    root: Vec<f64>,
    strings: Vec<String>,
    str_idx: HashMap<String, usize>,
    layers: HashMap<String, usize>,
    /// [200] Standard-Farbe und -Strichstärke (auf CAD-Stufe gerastet) je Ebene, für „weicht ab?".
    layer_defaults: HashMap<String, (Option<f64>, f64)>,
    /// [200] Stift des gerade ausgegebenen Primitivs (vom Sammelschritt gesetzt).
    pen: Pen,
    /// [200] In Blöcken: Ebene, gegen deren Standard der Stift verglichen wird (die der Einfügung, nicht „0").
    pen_ref: Option<String>,
    ltypes: HashMap<String, usize>,
    styles: HashMap<String, usize>,
    dim_styles: HashMap<String, usize>,
    blocks: HashSet<String>,
    block_counts: [u32; 8],
    /// [153] Polylinien-Sätze als „Muster durchlaufend" schreiben (gesetzt rund um einen gestrichelten Ring).
    plinegen: bool,
}

impl Flat {
    fn new() -> Flat {
        Flat {
            root: vec![FLAT_VERSION],
            strings: Vec::new(),
            str_idx: HashMap::new(),
            layers: HashMap::new(),
            layer_defaults: HashMap::new(),
            pen: Pen::default(),
            pen_ref: None,
            ltypes: HashMap::new(),
            styles: HashMap::new(),
            dim_styles: HashMap::new(),
            blocks: HashSet::new(),
            block_counts: [0; 8],
            plinegen: false,
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
        self.layer_defaults.insert(name.to_string(), (rgb, snap_lweight(lw)));
        let s = self.str(name);
        self.root.extend_from_slice(&[REC_LAYER, s, rgb.unwrap_or(-1.0), lw]);
        idx as f64
    }

    /// [200] Stift (Farbe, Strichstärke) der nächsten Entitäten setzen; schreibt nur bei Änderung.
    fn set_epen(&mut self, b: &mut Buf, color: f64, lw: f64) {
        if b.epen == (color, lw) {
            return;
        }
        b.epen = (color, lw);
        self.push(b, &[REC_ENTITY_PEN, color, lw]);
    }

    /// [200] Den Stift des aktuellen Primitivs auf `layer` setzen: Werte, die dem Ebenen-Standard gleichen, bleiben
    /// „nach Ebene" (−1); abweichende gehen als eigene Farbe bzw. Strichstärke an die Entitäten.
    fn apply_pen(&mut self, b: &mut Buf, layer: &str) {
        let (dc, dl) = self.layer_defaults.get(self.pen_ref.as_deref().unwrap_or(layer)).copied().unwrap_or((None, f64::NAN));
        let color = match self.pen.color {
            Some(c) if dc != Some(c) => c,
            _ => -1.0,
        };
        let lw = match self.pen.lw {
            Some(w) if w != dl => w,
            _ => -1.0,
        };
        self.set_epen(b, color, lw);
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

    /// Geschlossen-Flag der Polylinien-Sätze: Bit 0 = geschlossen, Bit 1 = Muster durchlaufend (plinegen,
    /// DXF Gruppe 70 Bit 128; nur bei geschlossenem, gestricheltem Zug, vom Aufrufer mit `plinegen` gesetzt).
    fn closed_flag(&self, closed: bool) -> f64 {
        if closed && self.plinegen {
            3.0
        } else {
            b01(closed)
        }
    }

    fn add_polyline(&mut self, b: &mut Buf, layer: &str, pts: &[V2], closed: bool) {
        if pts.len() < 2 {
            return;
        }
        b.counts[K_POLY] += 1;
        let l = self.layer(layer);
        self.push(b, &[REC_POLYLINE, l, self.closed_flag(closed), pts.len() as f64]);
        for p in pts {
            self.push(b, &[p.x, p.y]);
        }
    }

    /// [169] Zug mit erkannten Bögen ([`crate::plan::arc_fit`]): ganzer Kreis als CIRCLE, sonst LWPOLYLINE mit
    /// Bulges, mit Ellipsenbögen LWPOLYLINE-Stücke und ELLIPSE; ohne Bogen `false` (der Aufrufer schreibt den
    /// Zug wie bisher).
    fn add_curve(&mut self, b: &mut Buf, layer: &str, pts: &[V2], closed: bool) -> bool {
        use crate::plan::arc_fit;
        let Some(shape) = arc_fit::fit(pts, closed, arc_fit::TOL) else { return false };
        if let arc_fit::Shape::Circle { c, r, .. } = shape {
            self.add_circle(b, layer, c, r);
            return true;
        }
        if let Some(pieces) = arc_fit::pieces(&shape) {
            let l = self.layer(layer);
            for pc in pieces {
                match pc {
                    arc_fit::Piece::Poly(v, bulge) => {
                        b.counts[K_POLY] += 1;
                        self.push(b, &[REC_POLYLINE_BULGE, l, 0.0, v.len() as f64]);
                        for (p, g) in v.iter().zip(&bulge) {
                            self.push(b, &[p.x, p.y, *g]);
                        }
                    }
                    arc_fit::Piece::Ellipse { c, major, ratio, t0, t1 } => {
                        b.counts[K_ARC] += 1;
                        self.push(b, &[REC_ELLIPSE, l, c.x, c.y, major.x, major.y, ratio, t0, t1]);
                    }
                }
            }
            return true;
        }
        let Some((v, bulge)) = arc_fit::bulges(&shape) else { return false };
        b.counts[K_POLY] += 1;
        let l = self.layer(layer);
        self.push(b, &[REC_POLYLINE_BULGE, l, self.closed_flag(closed), v.len() as f64]);
        for (p, g) in v.iter().zip(&bulge) {
            self.push(b, &[p.x, p.y, *g]);
        }
        true
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
        // [169] Rand mit erkannten Bögen (Kreis, Bogenwand, Erker): Polylinien-Rand mit Bulges.
        let arcs = crate::plan::arc_fit::ring_bulges(pts, crate::plan::arc_fit::TOL);
        let rec = if arcs.is_some() { REC_HATCH_BULGE } else { REC_HATCH };
        self.push(b, &[rec, l, if solid { 0.0 } else { 1.0 }, rgb.unwrap_or(-1.0), dashes.len() as f64]);
        self.push(b, dashes);
        self.push(b, &[families.len() as f64]);
        for f in families {
            self.push(b, &[f.0, f.1]);
        }
        match arcs {
            Some((v, bulge)) => {
                self.push(b, &[v.len() as f64]);
                for (p, g) in v.iter().zip(&bulge) {
                    self.push(b, &[p.x, p.y, *g]);
                }
            }
            None => {
                self.push(b, &[pts.len() as f64]);
                for p in pts {
                    self.push(b, &[p.x, p.y]);
                }
            }
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

/// Farbe einer Ebene: `#rrggbb` bzw. `#rgb` nach JS-`trim` → 0xRRGGBB, sonst dunkelgrau ([200]: auch die Kurzform, damit
/// Ebenen- und Elementfarbe gleich gelesen werden).
fn rgb_from_hex(hex: &str) -> f64 {
    rgb_or_null(hex).unwrap_or(0x111111 as f64)
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
    // [166] Lesart wie Szene/SVG-Kachel (`hatch::build_hatch_runs`): Winkel 0 = Musterlinie senkrecht, die
    // Drehung im Bildschirm-Uhrzeigersinn → Linienrichtung im Modell (y nach oben, DXF) = 90° − Winkel.
    // Vorher Winkel = Linienrichtung: 0°/90°-Scharen (Dämm-Striche, Glas) lagen um 90° verdreht.
    let angle = (PI / 2.0 - (h.angle * PI) / 180.0).rem_euclid(PI);
    let mut out = vec![(angle, spacing)];
    if h.pattern == Pattern::Crosshatch {
        out.push(((angle + PI / 2.0).rem_euclid(PI), spacing));
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

/// [200] Stift eines Primitivs: Farbe (0xRRGGBB) und Strichstärke (1/100 mm, auf die CAD-Stufen gerastet);
/// `None` = nicht gesetzt (nach Ebene).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Pen {
    color: Option<f64>,
    lw: Option<f64>,
}

/// Genormte CAD-Strichstärken (1/100 mm), wie `fileio/export.rs`.
const STD_LINE_WEIGHTS: [i16; 24] =
    [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

/// Strichstärke (1/100 mm) auf die nächste CAD-Stufe; nicht endlich/negativ → −3 (Standard).
fn snap_lweight(v: f64) -> f64 {
    if !v.is_finite() || v < 0.0 {
        return -3.0;
    }
    let w = jsnum::round(v).min(211.0) as i16;
    STD_LINE_WEIGHTS.iter().copied().min_by_key(|s| (s - w).abs()).map_or(25.0, f64::from)
}

impl Pen {
    /// Farbe aus dem CSS-Text (Hex), Strichstärke aus Papier-mm (NaN/fehlt → nach Ebene).
    fn of(color: &str, weight_mm: f64) -> Pen {
        Pen { color: rgb_or_null(color), lw: weight_mm.is_finite().then(|| snap_lweight(mm_to_lwe(weight_mm))) }
    }
}

/// Ein Plan-Primitiv in der Form, die der Sammler braucht.
#[derive(Clone, Debug)]
enum Prim {
    Line { a: V2, b: V2, cls: String, dash: Vec<f64>, zigzag: Option<(f64, f64)>, motif: Option<Motif> },
    Arc { center: V2, from: V2, to: V2, r: f64, dash: Vec<f64> },
    Polygon { pts: Vec<V2>, fill: String, stroke: String, hatch: Option<HatchIn> },
    Circle { center: V2, r: f64, dash: Vec<f64> },
    DrawingArc { center: V2, r: f64, a0: f64, a1: f64, dash: Vec<f64> },
    Single { at: V2, angle: f64, height: f64, wrap: f64, style: TextStyleIn, color: String, paras: Vec<(String, Vec<String>)> },
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
    /// [200] Farbe und Strichstärke des Elements (Linien, Bögen, Kreise, Umrisse).
    pen: Pen,
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
    let dash = |rec: &crate::plan::buf::Rec| -> Option<Vec<f64>> {
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
            Some(TextIn::Single { at, angle, height, wrap, style, color, paras }) => {
                Prim::Single { at: *at, angle: *angle, height: *height, wrap: *wrap, style: style.clone(), color: color.clone(), paras: paras.clone() }
            }
            _ => Prim::Other,
        },
        _ => Prim::Other,
    };
    let pen = match rec.tag {
        // [200] Linie/Bogen ohne eigene Farbe: Klassen-Farbe, sonst Tinte — wie die Anzeige (`scene::stroke_color_for`).
        T_LINE | T_ARC => {
            let own = s(f[1])?;
            let cls = s(f[0])?;
            let color = crate::plan::scene::cls_stroke(Some(&cls)).map(str::to_string).unwrap_or_else(|| {
                if js_trim(&own).is_empty() { crate::plan::scene::DEFAULT_LINE.to_string() } else { own }
            });
            Pen::of(&color, f[2])
        }
        T_POLYGON | T_CIRCLE => Pen::of(&s(f[1])?, f[2]),
        T_DRAWING_ARC => Pen::of(&s(f[0])?, f[1]),
        _ => Pen::default(),
    };
    Some(Entry { prim, pen, ids, tag: rec.tag })
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
        Prim::Single { at, angle, height, wrap, style, color, paras } => Prim::Single {
            at: f.local(*at),
            angle: angle - f.rot,
            height: height / f.scale,
            // `p.wrapWidth && p.wrapWidth / f.scale`: 0/NaN bleiben.
            wrap: if *wrap != 0.0 && !wrap.is_nan() { wrap / f.scale } else { *wrap },
            style: style.clone(),
            color: color.clone(),
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

    /// [153] Linientyp eines gestrichelten Vollkreises vom Radius `r` (Modell-Meter): Muster auf ganze
    /// Wiederholungen über den Umfang gestreckt, eigener Linientyp je Radius (`…_R<mm>`). DXF/DWG kennen keine
    /// Musterphase je Objekt (das Muster beginnt am Entitätsanfang); so schliesst die Naht des Kreises trotzdem.
    fn ltype_of_circle(&mut self, dash: &[f64], r: f64) -> f64 {
        self.ltype_of_ring(dash, std::f64::consts::TAU * r, "R", r)
    }

    /// [153] Linientyp eines gestrichelten geschlossenen Zugs (Rechteck, Vieleck, Ellipse) vom Umfang `len`
    /// (Modell-Meter): Muster auf ganze Wiederholungen gestreckt, eigener Linientyp je Umfang (`…_U<mm>`).
    /// Zusammen mit dem Flag „Muster durchlaufend" (plinegen) läuft die Phase über die Ecken.
    fn ltype_of_closed(&mut self, dash: &[f64], len: f64) -> f64 {
        self.ltype_of_ring(dash, len, "U", len)
    }

    fn ltype_of_ring(&mut self, dash: &[f64], len: f64, tag: &str, key_m: f64) -> f64 {
        let k = self.o.scale / 1000.0;
        if dash.is_empty() || !(k > 0.0) || !(len > 0.0) {
            return self.ltype_of(dash);
        }
        let fit = crate::plan::line_pattern::fit_closed(dash, len / k);
        match dash_to_ltype_meters(&fit, self.o.scale) {
            Some(el) => {
                let name = format!("{}_{tag}{}", ltype_name_for(dash, &self.project.line_styles), jsnum::round(key_m * 1000.0));
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

    /// [200] Blockinhalt auf Ebene „0" (schwimmt mit der Einfügung): Farbe und Strichstärke der Elemente (Klassen-Stil
    /// aufgelöst) stehen an den Entitäten, soweit sie vom Standard der Ebene der Einfügung abweichen.
    fn block_content(&mut self, content: &mut Buf, members: &[&Entry], frame: Frame, insert_layer: &str) {
        self.flat.pen_ref = Some(insert_layer.to_string());
        for m in members {
            if let Some(lp) = to_local(&m.prim, frame) {
                self.flat.pen = m.pen;
                self.emit(content, &lp, LAYER_ZERO, LAYER_ZERO);
                self.flat.pen = Pen::default();
            }
        }
        self.flat.pen_ref = None;
    }

    /// [200] Ein Plan-Eintrag mit dem Stift seines Elements.
    fn emit_pen(&mut self, b: &mut Buf, e: &Entry, layer: &str) {
        self.flat.pen = e.pen;
        self.emit(b, &e.prim, layer, LAYER_HATCH);
        self.flat.pen = Pen::default();
    }

    /// [200] Textfarbe: gleicht sie der Ebenenfarbe, bleibt der Text nach Ebene, sonst eigene Farbe (Stärke nie).
    fn text_pen(&mut self, b: &mut Buf, color: &str, layer: &str) {
        self.flat.pen = Pen { color: rgb_or_null(color), lw: None };
        self.flat.apply_pen(b, layer);
        self.flat.pen = Pen::default();
    }

    /// Ein Primitiv als Entität(en) (`emitPrimitive`); `hatch_layer` = Ebene der Schraffuren.
    fn emit(&mut self, b: &mut Buf, p: &Prim, layer: &str, hatch_layer: &str) {
        match p {
            Prim::Line { a, b: q, dash, zigzag, motif, .. } => {
                if let Some((amp, wav)) = zigzag {
                    let pts = hatch::zigzag_points(*a, *q, amp * hatch::DASH_MM_TO_M, wav * hatch::DASH_MM_TO_M).unwrap_or_else(|| vec![*a, *q]);
                    self.flat.set_pen(b, -1.0);
                    self.flat.apply_pen(b, layer);
                    self.flat.add_polyline(b, layer, &pts, false);
                } else if let Some(m) = motif {
                    let pts = hatch::motif_points_opt(*a, *q, m, hatch::DASH_MM_TO_M).unwrap_or_else(|| vec![*a, *q]);
                    self.flat.set_pen(b, -1.0);
                    self.flat.apply_pen(b, layer);
                    self.flat.add_polyline(b, layer, &pts, false);
                } else {
                    let lt = self.ltype_of(dash);
                    self.flat.set_pen(b, lt);
                    self.flat.apply_pen(b, layer);
                    self.flat.add_line(b, layer, *a, *q);
                }
            }
            Prim::Arc { center, from, to, r, dash } => {
                let lt = self.ltype_of(dash);
                self.flat.set_pen(b, lt);
                self.flat.apply_pen(b, layer);
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
                let lt = self.ltype_of_circle(dash, *r);
                self.flat.set_pen(b, lt);
                self.flat.apply_pen(b, layer);
                self.flat.add_circle(b, layer, *center, *r);
            }
            Prim::DrawingArc { center, r, a0, a1, dash } => {
                let lt = self.ltype_of(dash);
                self.flat.set_pen(b, lt);
                self.flat.apply_pen(b, layer);
                self.flat.add_arc(b, layer, *center, *r, *a0, *a1);
            }
            Prim::Single { at, angle, height, wrap, style, color, paras } => {
                let dir = V2 { x: jsnum::sin(*angle), y: -jsnum::cos(*angle) };
                for (text, down) in single_lines(*height, *wrap, paras) {
                    if js_trim(&text).is_empty() || !(*height > 0.0) {
                        continue;
                    }
                    let p = V2 { x: at.x + dir.x * down, y: at.y + dir.y * down };
                    let st = self.style_of(Some(style));
                    self.text_pen(b, color, layer);
                    self.flat.add_text2(b, layer, p, *height, *angle, &text, 0.0, st);
                }
            }
            Prim::Stamp { at, lines } => {
                for l in lines {
                    let st = self.style_of(Some(&l.style));
                    self.text_pen(b, &l.color, layer);
                    self.flat.add_text2(b, layer, V2 { x: at.x + l.dx, y: at.y - l.down }, l.height, 0.0, &l.text, l.align, st);
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
                self.flat.set_epen(b, -1.0, -1.0);
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
                // [200] Umriss in Farbe und Strichstärke des Elements (Schraffuren oben bleiben nach Ebene).
                self.flat.apply_pen(b, layer);
                // [169] Runde Stütze als CIRCLE, Bogenwand-/Bogen-Umrisse als LWPOLYLINE mit Bulges.
                if !self.flat.add_curve(b, layer, pts, true) {
                    self.flat.add_polyline(b, layer, pts, true);
                }
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
        // [172] Vorgabe-Lage wie im Plan: passt die Zahl nicht zwischen die Hilfslinien, steht sie ausserhalb.
        let auto = super::drawings::dim_auto_offsets(pts, text_h);
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
            let stored = text_offsets_mm.as_ref().and_then(|l| l.get(i)).filter(|o| o.along != 0.0 || o.perp != 0.0).map(|o| (mm(o.along), mm(o.perp)));
            let text_at = stored.or(auto.get(i).copied().filter(|o| o.0 != 0.0 || o.1 != 0.0)).map(|(al, pe)| {
                let (base, read, up) = dim_text_frame(a, q, *offset, text_h);
                let pos = V2 { x: base.x + read.x * al + up.x * pe, y: base.y + read.y * al + up.y * pe };
                V2 { x: pos.x + up.x * (text_h / 2.0), y: pos.y + up.y * (text_h / 2.0) }
            });
            self.flat.add_dimension(b, layer, style, a, q, on, text_at);
        }
    }

    /// Blockinstanz → BLOCK je Definition + INSERT (`emitBlockInstance`); `false` = als lose Primitive.
    /// [253] Objekte der Bibliothek (`Libobj`): ein Block je Objekt-Id und Parametersatz (`DOSSIER_<id>_<hash>`,
    /// bei Objekten mit Zufall zusätzlich je Seed), Inhalt = erzeugte Linien in Objektlage.
    fn block_instance(&mut self, b: &mut Buf, d: &Drawing2D, members: &[&Entry], layer: &str, names: &mut BlockNames) -> bool {
        let (at, rotation, s, key, wish, desc) = match &d.geom {
            Drawing2DGeom::Block { block_def_id, at, rotation, scale, .. } => {
                let Some(def) = self.project.block_defs.as_ref().and_then(|l| l.iter().find(|x| &x.id == block_def_id)) else { return false };
                let trimmed = js_trim(&def.name);
                (at, *rotation, scale.unwrap_or(1.0), format!("blockdef:{}", def.id), if trimmed.is_empty() { "Block".to_string() } else { trimmed.to_string() }, def.name.clone())
            }
            Drawing2DGeom::Libobj { lib_id, at, rotation, params, seed } => {
                let seeded = crate::furniture_lib::find(lib_id).is_some_and(|o| o.def().seeded);
                let pj = serde_json::to_string(&params.clone().unwrap_or_default()).unwrap_or_default();
                let key = format!("libobj:{lib_id}:{pj}{}", if seeded { format!(":{}", seed.unwrap_or(0)) } else { String::new() });
                let h = key.bytes().fold(2166136261u32, |h, c| (h ^ c as u32).wrapping_mul(16777619));
                let id: String = lib_id.trim_start_matches("lib:").chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
                (at, *rotation, 1.0, key, format!("DOSSIER_{id}_{h:08X}"), format!("Objektbibliothek {lib_id}"))
            }
            _ => return false,
        };
        if !(s > 0.0) || !s.is_finite() || !rotation.is_finite() || !at.x.is_finite() || !at.y.is_finite() {
            return false;
        }
        let (name, fresh) = names.name(&key, &wish);
        let at = V2 { x: at.x, y: at.y };
        if fresh {
            let frame = Frame { origin: at, rot: rotation, scale: s };
            let mut content = Buf::block();
            self.block_content(&mut content, members, frame, layer);
            self.flat.set_pen(&mut content, -1.0);
            self.flat.define_block(b, &name, &desc, &[], content);
        }
        self.flat.add_insert(b, layer, &name, at, rotation, s, &[]);
        true
    }

    /// Tür/Fenster → BLOCK in Wandrichtung + INSERT mit Attributen (`emitOpening`).
    fn opening(&mut self, b: &mut Buf, o: &Opening, members: &[&Entry], layer: &str, names: &mut BlockNames) -> bool {
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
        self.block_content(&mut content, members, frame, layer);
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
    // [146] Projekt-Einstellung Linienenden/-ecken in den DXF-/DWG-Kopf.
    cx.flat.root.extend_from_slice(&[REC_LINE_ENDS, crate::plan::line_ends::LineEnds::of(project).code() as f64]);

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
    cx.flat.set_epen(&mut main, -1.0, -1.0);

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
            Drawing2DGeom::Block { .. } | Drawing2DGeom::Libobj { .. } => {
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
    let plain = |e: &Entry| matches!(&e.prim, Prim::Line { zigzag: None, motif: None, .. });
    let mut skip_to = 0usize;
    for (i, e) in entries.iter().enumerate() {
        if i < skip_to {
            continue;
        }
        // [169] Aneinander anschliessende Einzel-Linien gleicher Ebene und gleichen Musters (Ansichtskante einer
        // runden Stütze, Umriss-Linien an Bogenwänden): erkannte Bögen als CIRCLE bzw. LWPOLYLINE mit Bulges.
        if keys[i].is_none() && plain(e) {
            let l = layer_for(e);
            let Prim::Line { a, b: q, dash, .. } = &e.prim else { unreachable!() };
            let mut pts = vec![*a, *q];
            let mut j = i + 1;
            while j < entries.len() && keys[j].is_none() && plain(&entries[j]) {
                let Prim::Line { a: aj, b: bj, dash: dj, .. } = &entries[j].prim else { break };
                let last = pts[pts.len() - 1];
                if dj != dash || entries[j].pen != e.pen || (aj.x - last.x).abs() > 1e-9 || (aj.y - last.y).abs() > 1e-9 || layer_for(&entries[j]) != l {
                    break;
                }
                pts.push(*bj);
                j += 1;
            }
            if pts.len() >= 4 {
                let closed = (pts[0].x - pts[pts.len() - 1].x).abs() <= 1e-9 && (pts[0].y - pts[pts.len() - 1].y).abs() <= 1e-9;
                let ring = if closed { &pts[..pts.len() - 1] } else { &pts[..] };
                let shape = crate::plan::arc_fit::fit(ring, closed, crate::plan::arc_fit::TOL);
                // [153] Gestrichelter geschlossener Zug: Muster auf ganze Wiederholungen über den Umfang gestreckt
                // und „Muster durchlaufend" (plinegen), damit die Naht schliesst und die Phase über die Ecken läuft.
                let ring_len = match &shape {
                    Some(sh) => crate::plan::arc_fit::length(sh),
                    None => (0..ring.len()).map(|i| crate::jsmath::hypot2(ring[(i + 1) % ring.len()].x - ring[i].x, ring[(i + 1) % ring.len()].y - ring[i].y)).sum(),
                };
                let fitted = closed && !dash.is_empty();
                let lt = if fitted { cx.ltype_of_closed(dash, ring_len) } else { cx.ltype_of(dash) };
                if shape.is_some() || fitted {
                    cx.flat.set_pen(main, lt);
                    cx.flat.pen = e.pen;
                    cx.flat.apply_pen(main, &l);
                    cx.flat.pen = Pen::default();
                    cx.flat.plinegen = fitted;
                    if shape.is_some() {
                        cx.flat.add_curve(main, &l, ring, closed);
                    } else {
                        cx.flat.add_polyline(main, &l, ring, true);
                    }
                    cx.flat.plinegen = false;
                    skip_to = j;
                    continue;
                }
            }
        }
        if let Some(key) = &keys[i] {
            if !done.insert(key) {
                continue;
            }
            cx.flat.set_epen(main, -1.0, -1.0);
            let members: Vec<&Entry> = groups.get(key).map(|l| l.iter().map(|&k| &entries[k]).collect()).unwrap_or_default();
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
                    if !cx.block_instance(main, d, &members, &layer, &mut names) {
                        for m in &members {
                            let l = layer_for(m);
                            cx.emit_pen(main, m, &l);
                        }
                    }
                }
                _ => {
                    let op = opening_by_id[id];
                    let layer = layer_by_code.get(op.category_code.as_str()).cloned().unwrap_or_else(|| LAYER_SYMBOLS.to_string());
                    if !cx.opening(main, op, &members, &layer, &mut names) {
                        for m in &members {
                            let l = layer_for(m);
                            cx.emit_pen(main, m, &l);
                        }
                    }
                }
            }
            continue;
        }
        let l = layer_for(e);
        cx.emit_pen(main, e, &l);
    }
}

/// Primitive der Abschnitte in Plan-Reihenfolge lesen (Texte gesetzt beim Massstab `scale`).
fn read_entries(parts: &mut [Part], scale: f64, font: &str) -> Option<Vec<Entry>> {
    let mut entries: Vec<Entry> = Vec::new();
    for part in parts.iter_mut() {
        let hatches = part.view.hatch_table()?;
        for i in part.from..part.to {
            let text = crate::plan::text::read_text(part, i).map(|t| crate::plan::text::dxf_text(&t, scale, font));
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
        // Anonyme Abgabe ([208]): Blattnamen sind frei wählbar und können Büro- oder Projektangaben tragen.
        let base = if js_trim(&layout.name).is_empty() || crate::competition::anonymous_keyword(p).is_some() { format!("Blatt {}", n + 1) } else { layout.name.clone() };
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
                    auto_coarse: false,
                    rules: None,
                    model_view: None,
                    trace_of: None,
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

    /// [172] Passt die Masszahl nicht zwischen die Hilfslinien, steht sie im DXF an der ausgewichenen Lage (Textposition
    /// gesetzt, ausserhalb des Segments); passt sie, bleibt die Vorgabe (kein Text-Override).
    #[test]
    fn masszahl_ausgewichen_im_dxf() {
        let mut v = crate::sheet_viewports::tests::json();
        let dim = |id: &str, x1: f64| serde_json::json!({"id": id, "levelId": "eg", "categoryCode": "20", "geom": {"shape": "dimension", "pts": [{"x": 0.0, "y": 0.0}, {"x": x1, "y": 0.0}], "offset": 0.5}});
        v["drawings2d"].as_array_mut().unwrap().push(dim("kurz", 0.1));
        v["drawings2d"].as_array_mut().unwrap().push(dim("lang", 3.0));
        let p: Project = serde_json::from_value(v).unwrap();
        let a = crate::plan::domains::PlanArgs::parse(1.0, r#"{"floor":"eg","show":["20"],"scale":100}"#).unwrap();
        let buf = crate::plan::domains::plan_domains_buf(&p, &a).unwrap();
        let view = View::parse(&buf).unwrap();
        let len = view.len();
        let mut parts = [Part::new(view, 0, len).unwrap()];
        let o = DxfOptions { scale: 100.0, include_hatches: true, dim_cm: false, paper_layout: false, bounds: [0.0, 0.0, 10.0, 4.0], default_font: "Arial".into(), floor: "eg".into(), table_labels: String::new() };
        let f = collect(&mut parts, &p, &o).unwrap();
        let dims: Vec<&[f64]> = f.nums.windows(12).filter(|w| w[0] == REC_DIM).collect();
        assert_eq!(dims.len(), 2);
        let kurz = dims.iter().find(|w| (w[5] - 0.1).abs() < 1e-9).expect("kurz");
        let lang = dims.iter().find(|w| (w[5] - 3.0).abs() < 1e-9).expect("lang");
        assert_eq!(kurz[9], 1.0, "ausgewichen: Textposition gesetzt");
        assert!(kurz[10] < -1e-6, "links vom Segment, x = {}", kurz[10]);
        assert_eq!(lang[9], 0.0, "passt: Vorgabe");
    }

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

    /// [208] Anonyme Abgabe: Blattnamen (frei wählbar) kommen nicht in die Datei, das Blatt heisst „Blatt n".
    #[test]
    fn anonyme_abgabe_blattnamen() {
        let mut p: Project = serde_json::from_value(crate::sheet_viewports::tests::json()).unwrap();
        p.layouts.as_mut().unwrap()[0].name = "BUEROXY Plan".into();
        let a = crate::plan::domains::PlanArgs::parse(1.0, r#"{"floor":"eg","show":["20"],"scale":100}"#).unwrap();
        let buf = crate::plan::domains::plan_domains_buf(&p, &a).unwrap();
        let o = DxfOptions { scale: 100.0, include_hatches: true, dim_cm: false, paper_layout: true, bounds: [0.0, 0.0, 10.0, 4.0], default_font: "Arial".into(), floor: "eg".into(), table_labels: String::new() };
        let run = |p: &Project| {
            let view = View::parse(&buf).unwrap();
            let len = view.len();
            let mut parts = [Part::new(view, 0, len).unwrap()];
            collect(&mut parts, p, &o).unwrap().strings
        };
        assert!(run(&p).iter().any(|s| s == "BUEROXY Plan"));
        p.competition = Some(crate::model::CompetitionSettings { anonymous: true, keyword: "FALKE 7".into(), ..Default::default() });
        let s = run(&p);
        assert!(!s.iter().any(|x| x.contains("BUEROXY")), "{s:?}");
        assert!(s.iter().any(|x| x == "Blatt 1"));
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

    /// [253] Objekte der Bibliothek gehen als BLOCK + INSERT hinaus: gleiche Id und Parameter teilen einen Block
    /// (`DOSSIER_<id>_<hash>`), andere Parameter bekommen einen eigenen; die Einfügung trägt Lage und Drehung.
    #[test]
    fn libobj_als_block_und_insert() {
        let mut v = crate::sheet_viewports::tests::json();
        let lo = |id: &str, x: f64, rot: f64, params: serde_json::Value| serde_json::json!({"id": id, "type": "drawing2d", "levelId": "eg", "categoryCode": "20",
            "geom": {"shape": "libobj", "libId": "lib:wc-wand", "at": {"x": x, "y": 2.0}, "rotation": rot, "params": params}});
        let d = v["drawings2d"].as_array_mut().unwrap();
        d.push(lo("w1", 1.0, 0.0, serde_json::json!({})));
        d.push(lo("w2", 3.0, std::f64::consts::FRAC_PI_2, serde_json::json!({})));
        d.push(lo("w3", 5.0, 0.0, serde_json::json!({"w": 0.45})));
        let p: Project = serde_json::from_value(v).unwrap();
        let a = crate::plan::domains::PlanArgs::parse(1.0, r#"{"floor":"eg","show":["20"],"scale":50}"#).unwrap();
        let buf = crate::plan::domains::plan_domains_buf(&p, &a).unwrap();
        let view = View::parse(&buf).unwrap();
        let len = view.len();
        let mut parts = [Part::new(view, 0, len).unwrap()];
        let o = DxfOptions { scale: 50.0, include_hatches: true, dim_cm: false, paper_layout: false, bounds: [0.0, 0.0, 10.0, 4.0], default_font: "Arial".into(), floor: "eg".into(), table_labels: String::new() };
        let f = collect(&mut parts, &p, &o).unwrap();
        let blocks: Vec<&String> = f.strings.iter().filter(|s| s.starts_with("DOSSIER_wc_wand_")).collect();
        assert_eq!(blocks.len(), 2, "gleiche Parameter ein Block, andere Breite ein zweiter: {blocks:?}");
        assert_eq!(f.nums.iter().filter(|x| **x == REC_BLOCK).count(), 2);
        let is_lib = |w: &&[f64]| f.strings.get(w[2] as usize).is_some_and(|n| n.starts_with("DOSSIER_wc_wand_"));
        let inserts: Vec<&[f64]> = f.nums.windows(9).filter(|w| w[0] == REC_INSERT).filter(is_lib).collect();
        assert_eq!(inserts.len(), 3);
        let rot = inserts.iter().find(|w| (w[3] - 3.0).abs() < 1e-9).expect("INSERT w2");
        assert!((rot[4] - 2.0).abs() < 1e-9 && (rot[5] - std::f64::consts::FRAC_PI_2).abs() < 1e-9, "{rot:?}");
        // Keine losen Linien ausserhalb der Blöcke: nur Blockinhalt (Ebene „0") trägt die Symbol-Linien.
        assert!(f.nums.contains(&REC_LINE));
    }

    /// [200] Stift je Element: weicht Farbe/Strichstärke einer Zeichnungslinie vom Ebenen-Standard ab, steht davor ein
    /// ENTPEN-Satz; gleiche Werte (Ebene „20": #000, 0.5 mm) bleiben nach Ebene; danach wird zurückgesetzt.
    #[test]
    fn stift_je_element_vor_der_entitaet() {
        let mut v = crate::sheet_viewports::tests::json();
        v["drawings2d"][0]["color"] = serde_json::json!("#c03020");
        v["drawings2d"][0]["weightMm"] = serde_json::json!(0.35);
        v["drawings2d"][1]["color"] = serde_json::json!("#000");
        v["drawings2d"][1]["weightMm"] = serde_json::json!(0.5);
        let p: Project = serde_json::from_value(v).unwrap();
        let a = crate::plan::domains::PlanArgs::parse(1.0, r#"{"floor":"eg","show":["20"],"scale":100}"#).unwrap();
        let buf = crate::plan::domains::plan_domains_buf(&p, &a).unwrap();
        let view = View::parse(&buf).unwrap();
        let len = view.len();
        let mut parts = [Part::new(view, 0, len).unwrap()];
        let o = DxfOptions { scale: 100.0, include_hatches: true, dim_cm: false, paper_layout: false, bounds: [0.0, 0.0, 10.0, 4.0], default_font: "Arial".into(), floor: "eg".into(), table_labels: String::new() };
        let f = collect(&mut parts, &p, &o).unwrap();
        // Satzfolge der Hauptzeichnung nach den Ebenen: (Satzart, Farbe/Ebene, Strichstärke/x1).
        let at = f.nums.iter().position(|x| *x == REC_ENTITY_PEN).expect("ENTPEN-Satz");
        assert_eq!(&f.nums[at..at + 3], &[REC_ENTITY_PEN, 0xc03020 as f64, 35.0]);
        assert_eq!(f.nums[at + 3], REC_LINE, "Stift gilt für die folgende Linie");
        assert_eq!(&f.nums[at + 5..at + 9], &[0.0, 0.0, 10.0, 0.0]);
        // Die zweite Linie trägt Standard-Werte der Ebene: zurück auf „nach Ebene", nie eine eigene Farbe/Stärke.
        let pens: Vec<&[f64]> = f.nums.windows(3).filter(|w| w[0] == REC_ENTITY_PEN).collect();
        assert!(pens.iter().all(|w| w[1] == 0xc03020 as f64 || w[1] == -1.0), "{pens:?}");
        assert_eq!(pens.last().map(|w| (w[1], w[2])), Some((-1.0, -1.0)), "am Ende wieder nach Ebene");
    }

    /// [200] Linien ohne eigene Farbe tragen den aufgelösten Klassen-Stil (Tür-/Achslinie: Klassenfarbe, sonst Tinte),
    /// Texte ihre Farbe; in Blöcken gleich.
    #[test]
    fn klassen_stil_und_textfarbe_im_dxf() {
        use crate::model::Vec2;
        use crate::plan::buf::Writer;
        use crate::plan::prim::Primitive;
        let v = |x: f64, y: f64| Vec2 { x, y };
        let line = |cls: &str, color: Option<&str>, w: f64, y: f64| Primitive::Line {
            a: v(0.0, y), b: v(1.0, y), cls: cls.into(), weight_mm: w, dash: None, zigzag: None, motif: None,
            color: color.map(Into::into), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None,
        };
        let text = |color: &str, y: f64| Primitive::DrawingText {
            at: v(0.0, y), text: "Hallo".into(), height_m: 0.25, angle: 0.0, color: color.into(), marks: None, wrap_width: None, doc: None,
            drawing_id: None, greyed: None, opacity: None,
        };
        let mut w = Writer::new(false);
        w.push(&line("door-swing", None, 0.35, 0.0));
        w.push(&line("wall-axis", None, 0.13, 1.0));
        w.push(&line("misc", None, 0.25, 2.0));
        w.push(&line("misc", Some("#336699"), 0.5, 3.0));
        w.push(&text("#c03020", 4.0));
        w.push(&text("#336699", 5.0));
        let bytes = w.finish();
        let p: Project = serde_json::from_value(crate::sheet_viewports::tests::json()).unwrap();
        let view = View::parse(&bytes).unwrap();
        let n = view.len();
        let mut parts = [Part::new(view, 0, n).unwrap()];
        let o = DxfOptions { scale: 100.0, include_hatches: true, dim_cm: false, paper_layout: false, bounds: [0.0, 0.0, 10.0, 6.0], default_font: "Arial".into(), floor: "eg".into(), table_labels: String::new() };
        let f = collect(&mut parts, &p, &o).unwrap();
        // Satzfolge ab dem ersten Linien-/Textsatz: (Stift davor, Art der Entität).
        let mut seq: Vec<(f64, f64, f64)> = Vec::new();
        let (mut col, mut lw) = (-1.0, -1.0);
        for (i, x) in f.nums.iter().enumerate() {
            if *x == REC_ENTITY_PEN && f.nums.get(i + 3).is_some_and(|k| *k == REC_LINE || *k == REC_TEXT2) {
                (col, lw) = (f.nums[i + 1], f.nums[i + 2]);
                seq.push((f.nums[i + 3], col, lw));
            }
        }
        let _ = (col, lw);
        let line_pens: Vec<(f64, f64)> = seq.iter().filter(|s| s.0 == REC_LINE).map(|s| (s.1, s.2)).collect();
        assert!(line_pens.contains(&(0x1a1a1a as f64, 35.0)), "Türlinie: Tinte, 0,35 mm: {line_pens:?}");
        assert!(line_pens.contains(&(0x4a453e as f64, 13.0)), "Achslinie: Klassenfarbe: {line_pens:?}");
        assert!(line_pens.contains(&(0x1a1a1a as f64, 25.0)) || line_pens.iter().any(|p| p.0 == 0x1a1a1a as f64), "{line_pens:?}");
        assert!(line_pens.contains(&(0x336699 as f64, 50.0)), "eigene Farbe bleibt: {line_pens:?}");
        let text_pens: Vec<f64> = seq.iter().filter(|s| s.0 == REC_TEXT2).map(|s| s.1).collect();
        assert_eq!(text_pens, vec![0xc03020 as f64, 0x336699 as f64], "Texte mit eigener Farbe, ohne Strichstärke");
        assert!(seq.iter().filter(|s| s.0 == REC_TEXT2).all(|s| s.2 == -1.0));
    }

    #[test]
    fn strichstaerke_rastet_auf_cad_stufen() {
        assert_eq!(snap_lweight(35.0), 35.0);
        assert_eq!(snap_lweight(33.0), 35.0);
        assert_eq!(snap_lweight(10.0), 9.0);
        assert_eq!(snap_lweight(500.0), 211.0);
        assert_eq!(snap_lweight(f64::NAN), -3.0);
        assert_eq!(Pen::of("#112233", 0.25), Pen { color: Some(0x112233 as f64), lw: Some(25.0) });
        assert_eq!(Pen::of("none", f64::NAN), Pen::default());
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

    /// [153] Gestrichelter Vollkreis: eigener Linientyp je Radius, Muster auf ganze Wiederholungen über den Umfang.
    #[test]
    fn kreis_linientyp_mit_ganzen_wiederholungen() {
        let project = Project::default();
        let o = DxfOptions { scale: 100.0, include_hatches: false, dim_cm: false, paper_layout: false, bounds: [0.0; 4], default_font: "Arial".into(), floor: String::new(), table_labels: String::new() };
        let mut cx = Ctx { project: &project, o: &o, flat: Flat::new() };
        let a = cx.ltype_of_circle(&[2.0, 1.0], 0.73);
        let b = cx.ltype_of_circle(&[2.0, 1.0], 0.73);
        let c = cx.ltype_of_circle(&[2.0, 1.0], 1.5);
        assert!(a >= 0.0 && a == b && c != a, "{a} {b} {c}");
        assert_eq!(cx.ltype_of_circle(&[], 1.0), -1.0);
        // Elemente des ersten Linientyps: Summe × Wiederholungen = Umfang (Modell-Meter).
        let el = cx.flat.root.windows(3).position(|w| w[0] == REC_LTYPE).map(|i| &cx.flat.root[i + 3..i + 5]).unwrap();
        let total = el[0].abs() + el[1].abs();
        let reps = std::f64::consts::TAU * 0.73 / total;
        assert!((reps - reps.round()).abs() < 1e-6 && reps.round() >= 1.0, "{el:?} {reps}");
    }

    /// [153] Linientyp eines geschlossenen Zugs: ganze Wiederholungen über den Umfang, ein Typ je Umfang.
    #[test]
    fn closed_linientyp_mit_ganzen_wiederholungen() {
        let project = Project::default();
        let o = DxfOptions { scale: 100.0, include_hatches: false, dim_cm: false, paper_layout: false, bounds: [0.0; 4], default_font: "Arial".into(), floor: String::new(), table_labels: String::new() };
        let mut cx = Ctx { project: &project, o: &o, flat: Flat::new() };
        let a = cx.ltype_of_closed(&[2.0, 1.0], 22.0);
        assert_eq!(a, cx.ltype_of_closed(&[2.0, 1.0], 22.0));
        assert_ne!(a, cx.ltype_of_closed(&[2.0, 1.0], 12.0));
        let el = cx.flat.root.windows(3).position(|w| w[0] == REC_LTYPE).map(|i| &cx.flat.root[i + 3..i + 5]).unwrap();
        let reps = 22.0 / (el[0].abs() + el[1].abs());
        assert!((reps - reps.round()).abs() < 1e-6 && reps.round() >= 1.0, "{el:?} {reps}");
    }

    #[test]
    fn blocklokal_verschoben_gedreht_skaliert() {
        let f = Frame { origin: V2 { x: 10.0, y: 5.0 }, rot: PI / 2.0, scale: 2.0 };
        let Some(Prim::Line { a, b, .. }) = to_local(&Prim::Line { a: V2 { x: 10.0, y: 5.0 }, b: V2 { x: 10.0, y: 9.0 }, cls: "x".into(), dash: vec![], zigzag: None, motif: None }, f) else { panic!() };
        assert!(a.x.abs() < 1e-12 && a.y.abs() < 1e-12);
        // 4 m in Richtung +y = lokale +x, durch Skalierung 2.
        assert!((b.x - 2.0).abs() < 1e-12 && b.y.abs() < 1e-12);
        let style = TextStyleIn { family: "Arial".into(), bold: false, italic: false };
        let Some(Prim::Single { height, angle, wrap, .. }) = to_local(&Prim::Single { at: V2 { x: 10.0, y: 5.0 }, angle: PI / 2.0, height: 0.4, wrap: 0.0, style, color: "#000".into(), paras: vec![] }, f) else { panic!() };
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
        assert_eq!(rgb_from_hex("#000"), 0.0);
        assert_eq!(rgb_or_null("#abc"), Some(0xaabbcc as f64));
        assert_eq!(rgb_or_null("none"), None);
        let words = |s: &str| s.split(' ').map(|w| w.to_string()).collect::<Vec<_>>();
        let lines = single_lines(1.0, 3.0, &[("aa bb cc".into(), words("aa bb cc"))]);
        // maxChars = floor(3 / 0.55) = 5 → "aa bb", "cc".
        assert_eq!(lines.iter().map(|l| l.0.as_str()).collect::<Vec<_>>(), vec!["aa bb", "cc"]);
        assert_eq!(lines[1].1, 1.25);
    }
}
