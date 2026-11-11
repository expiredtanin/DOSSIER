//! Freie 2D-Zeichnungen im Grundriss ([K3d]/[K4]): leitet `Drawing2D`-Elemente (Linie, Polylinie mit
//! Bögen, Rechteck, Kreis, Bogen, Ellipse, Bezier, Spline, Bemassung, Kote, Detailverweis,
//! Massstabsbalken, Punktmarke, Text, Block, Bild) in Plan-Primitive ab — Rust-Gegenstück zum
//! früheren `src/plan/generatePlan/drawing2d.ts` samt Filter und Override-Regeln aus `generatePlan`.
//! Rechenreihenfolge und Feldform wie in TS (bitgleich, s. `jsnum.rs`/`jsmath.rs`).
//!
//! Farbe/Strichstärke kommen aus dem Element, sonst aus dem Linienstil, sonst aus der Ebene.
//! Ein Block wird über `scale_geom` (Skalierung, Drehung, Verschiebung) rekursiv ausgegeben.
//! Texte bleiben Daten (`drawingText`); das Text-Layout macht der Verbraucher.

use super::domains::{Bounds, Ctx};
use super::overrides::Actions;
use super::prim::{HatchRender, Primitive};
use super::style::*;
use crate::js_fmt::{js_number, to_fixed};
use crate::jsmath::hypot2;
use crate::jsnum;
use crate::model::*;
use crate::plan::buf::{LineRef, Writer};
use std::borrow::Cow;
use std::collections::HashMap;

/// Standard-Massstab (1:100), wenn ein Aufrufer keinen mitgibt.
pub const DEFAULT_SCALE_DENOMINATOR: f64 = 100.0;

// Bemassung (SIA 400 B.5.3): Defaults in Papier-mm (`model/dimension.ts`).
const DIM_GAP_MM: f64 = 1.0;
const DIM_OVERSHOOT_MM: f64 = 1.0;
// [140] Masszahl 2.5 mm, Schrägstrich 2 mm (vorher 4 / 3 — grösser als Raumstempel).
const DIM_TICK_LEN_MM: f64 = 2.0;
const DIM_TEXT_HEIGHT_MM: f64 = 2.5;

// Höhenkote (SIA 400 B.5.4), fixe Modell-Meter.
const KOTE_TRI_SIZE_M: f64 = 0.15;
const KOTE_TRI_HALF_W_M: f64 = KOTE_TRI_SIZE_M * 0.6;
const KOTE_TEXT_HEIGHT_M: f64 = 0.2;
const KOTE_TEXT_GAP_M: f64 = 0.08;

// Detail-/Schnitt-Verweis und Punktmarke, fixe Modell-Meter.
const DETAILREF_RADIUS_M: f64 = 0.3;
const DETAILREF_TEXT_HEIGHT_M: f64 = 0.2;
const POINTMARKER_RADIUS_M: f64 = 0.08;
const POINTMARKER_CROSS_M: f64 = 0.12;

/// Die fixen Symbolgrössen oben (Kote, Detailverweis, Punktmarke) sind Papier-mm bei 1:100. Auf der
/// Blatt-Ebene eines Layouts (Papier 1:1, [93]) gilt dasselbe Papiermass: Faktor 1/100.
pub const SHEET_SYMBOL_FACTOR: f64 = 0.01;

/// Faktor der fixen Symbolgrössen auf der Ebene `level`: 1 im Modell, [`SHEET_SYMBOL_FACTOR`] auf einem Blatt.
pub fn symbol_factor(p: &Project, level: &str) -> f64 {
    if p.drawing_levels.iter().any(|l| l.id == level && l.layout_id.as_deref().is_some_and(|s| !s.is_empty())) {
        SHEET_SYMBOL_FACTOR
    } else {
        1.0
    }
}

/// [37] Symbolgrösse (Kote, Detailverweis, Punktmarke) in Papiergrösse: auf dem Blatt der Blatt-Faktor, im
/// Modell mit dem Massstab mitgehend (bei 1:100 = 1, die bisherige feste Grösse).
pub fn symbol_factor_at(p: &Project, level: &str, scale: f64) -> f64 {
    let f = symbol_factor(p, level);
    if f != 1.0 || !(scale.is_finite() && scale > 0.0) {
        return f;
    }
    scale / 100.0
}

/// Rand um die Achsen im Ausmass, damit die Blasen ins Bild passen (Meter).
const GRID_BUBBLE_MARGIN_M: f64 = 1.0;

// Massstabsbalken, Papier-mm.
const SCALEBAR_HEIGHT_MM: f64 = 1.5;
const SCALEBAR_TICK_MM: f64 = 1.0;
const SCALEBAR_TEXT_MM: f64 = 3.0;

// Konstruktionslinie / Strahl.
const XLINE_EXTEND_M: f64 = 1000.0;
const XLINE_WEIGHT_MM: f64 = 0.13;
const XLINE_DASH: [f64; 4] = super::line_pattern::CONSTRUCTION;

/// Default-Grösse der Linienenden (Papier-mm).
const END_MARK_DEFAULT_SIZE_MM: f64 = 3.0;

/// Verschachtelungstiefe von Blöcken (ein Block, der sich selbst enthält, endet hier).
const MAX_BLOCK_DEPTH: u32 = 32;

/// Strichmuster-Kennungen für den Linienzug im Plan-Puffer (TS: dieselbe Array-Referenz):
/// das Muster eines Linienstils (ohne LTSCALE) ist je Stil eine Referenz, ein gestrecktes
/// Muster je Element-Aufruf eine neue, das Konstruktionslinien-Muster eine Konstante.
const DASH_REF_STYLE: u32 = 1_000_000;
const DASH_REF_XLINE: u32 = 999_999;

/// Marke eines Bemassungspunkts mit ungültigem Bezug ([38], nur Bildschirm): Radius in Papier-mm, Farbe.
const LOST_MARK_MM: f64 = 1.2;
const LOST_MARK_COLOR: &str = "#e0301e";

/// Papier-mm → Modell-Meter beim Massstab 1:`scale` (`mmToModel`).
pub fn mm_to_model(mm: f64, scale: f64) -> f64 {
    (mm / 1000.0) * scale
}

/// Welche Primitive eine Ausgabe behält.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Keep {
    All,
    /// Ohne 'line' (kompakte Unterlage: die Linien entstehen bei Bedarf).
    NoLines,
    /// Nur 'line' (Linien der kompakten Unterlage).
    OnlyLines,
}

/// Erzeugte Primitive samt Strichmuster-Kennung je Primitiv (0 = keine Liste, s. `plan_buf`).
#[derive(Default)]
pub struct Out {
    pub prims: Vec<Primitive>,
    pub dash_refs: Vec<u32>,
}

/// Ziel einer Ausgabe: eine Liste (Tests, Vergleich) oder direkt ein Plan-Puffer (ohne die
/// Primitive als Objekte zu halten — bei Kataster-Importen Hunderttausende Linien).
pub enum Target<'o> {
    Vec(&'o mut Out),
    Buf(&'o mut Writer),
}

/// Senke: Filter (`Keep`), Transparenz der offenen Element-Aufrufe, Ziel.
pub struct Sink<'o> {
    t: Target<'o>,
    keep: Keep,
    /// (opacity, fillOpacity) je offenem Element-Aufruf (geklemmt, nur unter 1), innen zuletzt.
    frames: Vec<(Option<f64>, Option<f64>)>,
    next_ref: u32,
}

impl<'o> Sink<'o> {
    pub fn new(t: Target<'o>, keep: Keep) -> Self {
        Sink { t, keep, frames: Vec::new(), next_ref: 0 }
    }

    fn fresh_ref(&mut self) -> u32 {
        self.next_ref += 1;
        self.next_ref
    }

    /// Ein Primitiv (keine Linie, s. [`Sink::line`]) mit der Transparenz der offenen Aufrufe,
    /// innen zuerst (TS stempelt sie am Ende jedes Aufrufs, also in dieser Reihenfolge).
    fn push(&mut self, mut p: Primitive, dash_ref: u32) {
        if self.keep == Keep::OnlyLines {
            return;
        }
        for &(op, fo) in self.frames.iter().rev() {
            if let Some(cl) = op {
                match &mut p {
                    Primitive::DrawingImage { opacity, .. } => *opacity *= cl,
                    q => {
                        if let Some(o) = opacity_mut(q) {
                            *o = Some(o.unwrap_or(1.0) * cl);
                        }
                    }
                }
            }
            if let (Some(cl), Primitive::Polygon { opacity, .. }) = (fo, &mut p) {
                *opacity = Some(opacity.unwrap_or(1.0) * cl);
            }
        }
        match &mut self.t {
            Target::Vec(o) => {
                o.prims.push(p);
                o.dash_refs.push(dash_ref);
            }
            Target::Buf(w) => w.push_ref(&p, dash_ref),
        }
    }

    /// Eine Linie (Transparenz wie [`Sink::push`]; `fillOpacity` trifft nur Polygone).
    fn line(&mut self, l: LineRef, dash_ref: u32) {
        if self.keep == Keep::NoLines {
            return;
        }
        let mut opacity = l.opacity;
        for &(op, _) in self.frames.iter().rev() {
            if let Some(cl) = op {
                opacity = Some(opacity.unwrap_or(1.0) * cl);
            }
        }
        match &mut self.t {
            Target::Vec(o) => {
                o.prims.push(Primitive::Line {
                    a: l.a,
                    b: l.b,
                    cls: l.cls.into(),
                    weight_mm: l.weight_mm,
                    dash: l.dash.map(|d| d.map(|x| x.to_vec())),
                    zigzag: l.zigzag.cloned(),
                    motif: l.motif.cloned(),
                    color: l.color.map(String::from),
                    drawing_id: l.drawing_id.map(String::from),
                    opening_id: l.opening_id.map(String::from),
                    stair_id: l.stair_id.map(String::from),
                    greyed: l.greyed,
                    opacity,
                });
                o.dash_refs.push(dash_ref);
            }
            Target::Buf(w) => w.line_ref(&LineRef { opacity, ..l }, dash_ref),
        }
    }
}

/// Formname für `object_name` der Override-Regeln.
pub fn shape_name(g: &Drawing2DGeom) -> &'static str {
    match g {
        Drawing2DGeom::Line { .. } => "line",
        Drawing2DGeom::Xline { .. } => "xline",
        Drawing2DGeom::Ray { .. } => "ray",
        Drawing2DGeom::Polyline { .. } => "polyline",
        Drawing2DGeom::Rect { .. } => "rect",
        Drawing2DGeom::Circle { .. } => "circle",
        Drawing2DGeom::Arc { .. } => "arc",
        Drawing2DGeom::Ellipse { .. } => "ellipse",
        Drawing2DGeom::Bezier { .. } => "bezier",
        Drawing2DGeom::Spline { .. } => "spline",
        Drawing2DGeom::Dimension { .. } => "dimension",
        Drawing2DGeom::Kote { .. } => "kote",
        Drawing2DGeom::Detailref { .. } => "detailref",
        Drawing2DGeom::Scalebar { .. } => "scalebar",
        Drawing2DGeom::Pointmarker { .. } => "pointmarker",
        Drawing2DGeom::Grid { .. } => "grid",
        Drawing2DGeom::Text { .. } => "text",
        Drawing2DGeom::Block { .. } => "block",
        Drawing2DGeom::Image { .. } => "image",
    }
}

/// Element-Attribute nach den Override-Regeln (Farbe, Strichstärke, Linienstil) und die Ebene.
#[derive(Clone, Copy, Default)]
pub struct Attrs<'a> {
    pub color: Option<&'a str>,
    pub weight: Option<f64>,
    pub line_style_id: Option<&'a str>,
    pub category: Option<&'a LayerCategory>,
}

impl<'a> Attrs<'a> {
    /// Ohne Overrides: die Felder des Elements.
    pub fn of(c: &Ctx<'a>, d: &'a Drawing2D) -> Self {
        Attrs { color: d.color.as_deref(), weight: d.weight_mm, line_style_id: d.line_style_id.as_deref(), category: c.cat(&d.category_code) }
    }

    /// Mit Override-Aktionen (`ov.x ?? d.x`).
    pub fn with(d: &'a Drawing2D, ov: &'a Actions, category: Option<&'a LayerCategory>) -> Self {
        Attrs {
            color: ov.color.as_deref().or(d.color.as_deref()),
            weight: ov.lineweight.or(d.weight_mm),
            line_style_id: ov.linetype_id.as_deref().or(d.line_style_id.as_deref()),
            category,
        }
    }
}

/// Je Ebene und Formname einmal nachgeschlagen (wenige verschiedene je Plan): sichtbar, gedimmt,
/// Kategorie, Override-Aktionen.
struct MemoEntry<'a> {
    key: (&'a str, &'static str),
    shown: bool,
    greyed: bool,
    cat: Option<&'a LayerCategory>,
    ov: Actions,
}

#[derive(Default)]
struct Memo<'a> {
    entries: Vec<MemoEntry<'a>>,
    /// Nächster zu ersetzender Eintrag, wenn die Tabelle voll ist.
    next: usize,
    /// Zuletzt getroffener Eintrag (Zeichnungen folgen oft gleichartig aufeinander).
    last: usize,
}

impl<'a> Memo<'a> {
    const MAX: usize = 64;

    fn get(&mut self, c: &Ctx<'a>, d: &'a Drawing2D) -> &MemoEntry<'a> {
        let key = (d.category_code.as_str(), shape_name(&d.geom));
        if self.entries.get(self.last).is_some_and(|e| e.key == key) {
            return &self.entries[self.last];
        }
        if let Some(i) = self.entries.iter().position(|e| e.key == key) {
            self.last = i;
            return &self.entries[i];
        }
        let e = MemoEntry { key, shown: c.shown(key.0), greyed: c.greyed(key.0), cat: c.cat(key.0), ov: c.overrides(None, key.0, Some(key.1)) };
        let i = if self.entries.len() < Self::MAX {
            self.entries.push(e);
            self.entries.len() - 1
        } else {
            let i = self.next;
            self.next = (self.next + 1) % Self::MAX;
            self.entries[i] = e;
            i
        };
        self.last = i;
        &self.entries[i]
    }
}

/// Kompakte Unterlage: Zeichnungen, deren Primitive nur Linien (plus ggf. die Fläche einer
/// geschlossenen Kontur) sind — Linie/Polylinie ohne Linienenden und ohne Bogen-Segmente.
pub fn compact_eligible(d: &Drawing2D) -> bool {
    let marks = d.end_marks.as_ref().is_some_and(|m| m.start.is_some() || m.end.is_some());
    match &d.geom {
        Drawing2DGeom::Line { .. } => !marks,
        Drawing2DGeom::Polyline { bulge, holes, .. } => {
            !marks && holes.as_ref().is_none_or(Vec::is_empty) && bulge.as_ref().is_none_or(|b| b.iter().all(|v| *v == 0.0 || v.is_nan()))
        }
        _ => false,
    }
}

/// Primitive EINES Elements: Hülle um [`emit_inner`] mit der Objekt-Transparenz (`opacity`, alle
/// Primitive) und der Flächen-Transparenz (`fillOpacity`, Polygone) als Rahmen der Senke — so
/// trifft sie auch die rekursiv erzeugte Block-Geometrie (dort mehrfach, wie in TS).
#[allow(clippy::too_many_arguments)]
pub fn emit(c: &Ctx, d: &Drawing2D, attrs: Attrs, geom: &Drawing2DGeom, greyed: bool, scale: f64, sink: &mut Sink, depth: u32) -> Result<(), String> {
    let clamp = |v: Option<f64>| v.filter(|x| *x < 1.0).map(|x| jsnum::max(0.0, x));
    sink.frames.push((clamp(d.opacity), clamp(d.fill_opacity)));
    let r = emit_inner(c, d, attrs, geom, greyed, scale, sink, depth);
    sink.frames.pop();
    r
}

fn opacity_mut(p: &mut Primitive) -> Option<&mut Option<f64>> {
    match p {
        Primitive::Polygon { opacity, .. }
        | Primitive::Line { opacity, .. }
        | Primitive::Arc { opacity, .. }
        | Primitive::Text { opacity, .. }
        | Primitive::DrawingText { opacity, .. }
        | Primitive::DrawingTextPath { opacity, .. }
        | Primitive::DrawingCircle { opacity, .. }
        | Primitive::DrawingArc { opacity, .. } => Some(opacity),
        Primitive::DrawingImage { .. } => None,
    }
}

fn v(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Punkt `p` um `d` in Richtung `dir` zurückgezogen (Linienverkürzung unter einer Spitze).
fn pull_back(p: Vec2, dir: Vec2, d: f64) -> Vec2 {
    if d <= 0.0 {
        return p;
    }
    let len = hypot2(dir.x, dir.y);
    if len < 1e-9 {
        return p;
    }
    v(p.x - (dir.x / len) * d, p.y - (dir.y / len) * d)
}

fn polygon(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, hatch: HatchRender, greyed: bool, id: Option<&str>) -> Primitive {
    Primitive::Polygon {
        pts,
        fill: fill.into(),
        stroke: stroke.into(),
        stroke_width_mm: w,
        hatch,
        greyed: Some(greyed),
        opacity: None,
        no_stroke_edges: None,
        wall_id: None,
        drawing_id: id.map(String::from),
        ceiling_id: None,
        opening_id: None,
        stair_id: None,
        room_id: None,
        extruded_solid_id: None,
        context_object_id: None,
        column_id: None,
        roof_id: None,
        section_line_id: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn text(at: Vec2, s: String, h: f64, angle: f64, color: &str, greyed: bool, id: Option<&str>) -> Primitive {
    Primitive::DrawingText { at, text: s, height_m: h, angle, color: color.into(), marks: None, wrap_width: None, doc: None, drawing_id: id.map(String::from), greyed: Some(greyed), opacity: None }
}

/// Höhenwert „+3.25" · „±0.00" · „-0.10" (SIA 400 B.5.4, Figur 18).
pub(super) fn kote_label(value: f64) -> String {
    if value.abs() < 1e-6 {
        return "±0.00".into();
    }
    format!("{}{}", if value > 0.0 { "+" } else { "" }, to_fixed(value, 2))
}

/// Höhenkote (SIA 400 B.5.4): OK = Spitze nach unten, UK = Spitze nach oben; fertig = Kontur,
/// roh = gefüllt. `at` ist die Spitze. Geteilt vom 2D-Element `kote` und den automatischen Koten
/// im Schnitt/in der Ansicht ([`level_markers`]).
#[allow(clippy::too_many_arguments)]
fn push_kote(sink: &mut Sink, at: Vec2, value: f64, kind: KoteKind, color: &str, weight: f64, greyed: bool, id: Option<&str>, f: f64) {
    push_kote_labeled(sink, at, kote_label(value), kind, color, weight, greyed, id, f);
}

/// [`push_kote`] mit fertigem Text (z. B. „±0.00 = 512.40").
#[allow(clippy::too_many_arguments)]
fn push_kote_labeled(sink: &mut Sink, at: Vec2, label: String, kind: KoteKind, color: &str, weight: f64, greyed: bool, id: Option<&str>, f: f64) {
    let up = if matches!(kind, KoteKind::OkFertig | KoteKind::OkRoh) { 1.0 } else { -1.0 };
    let filled = matches!(kind, KoteKind::OkRoh | KoteKind::UkRoh);
    let (size, half) = (KOTE_TRI_SIZE_M * f, KOTE_TRI_HALF_W_M * f);
    let pts = vec![at, v(at.x - half, at.y + up * size), v(at.x + half, at.y + up * size)];
    sink.push(polygon(pts, if filled { color } else { "none" }, color, weight, no_hatch(), greyed, id), 0);
    sink.push(text(v(at.x + half + KOTE_TEXT_GAP_M * f, at.y + up * size * 0.5), label, KOTE_TEXT_HEIGHT_M * f, 0.0, color, greyed, id), 0);
}

/// Aufgelöster Stil eines Element-Aufrufs.
struct Em<'a, 's, 'o> {
    sink: &'s mut Sink<'o>,
    id: &'a str,
    greyed: bool,
    color: &'a str,
    weight: f64,
    /// `None` = `dash: null`.
    dash: Option<Cow<'a, [f64]>>,
    dash_ref: u32,
    zigzag: Option<&'a LineStyleZigzag>,
    motif: Option<&'a LineStyleMotif>,
    marks: Option<&'a Drawing2DEndMarks>,
    scale: f64,
}

impl Em<'_, '_, '_> {
    /// Linie im Stil des Elements.
    fn seg(&mut self, a: Vec2, b: Vec2) {
        let r = if self.dash.is_some() { self.dash_ref } else { 0 };
        let l = LineRef {
            a,
            b,
            cls: "draw2d",
            weight_mm: self.weight,
            dash: Some(self.dash.as_deref()),
            zigzag: self.zigzag,
            motif: self.motif,
            color: Some(self.color),
            drawing_id: Some(self.id),
            opening_id: None,
            stair_id: None,
            greyed: Some(self.greyed),
            opacity: None,
        };
        self.sink.line(l, r);
    }

    /// Linie mit eigener Stärke/eigenem Muster (Bemassung, Hilfslinien), ohne Zickzack/Motiv.
    fn line(&mut self, a: Vec2, b: Vec2, w: f64, dash: Option<&[f64]>, dash_ref: u32) {
        let r = if dash.is_some() { dash_ref } else { 0 };
        let l = LineRef { a, b, cls: "draw2d", weight_mm: w, dash: Some(dash), zigzag: None, motif: None, color: Some(self.color), drawing_id: Some(self.id), opening_id: None, stair_id: None, greyed: Some(self.greyed), opacity: None };
        self.sink.line(l, r);
    }

    fn circle(&mut self, center: Vec2, r: f64, fill: &str, dash: Option<Option<Vec<f64>>>) {
        let dr = if matches!(dash, Some(Some(_))) { self.dash_ref } else { 0 };
        self.sink.push(
            Primitive::DrawingCircle { center, r, fill: fill.into(), stroke: self.color.into(), weight_mm: self.weight, dash, drawing_id: Some(self.id.into()), greyed: Some(self.greyed), opacity: None },
            dr,
        );
    }

    fn arc(&mut self, center: Vec2, r: f64, a0: f64, a1: f64) {
        let dr = if self.dash.is_some() { self.dash_ref } else { 0 };
        self.sink.push(
            Primitive::DrawingArc { center, r, a0, a1, stroke: self.color.into(), weight_mm: self.weight, dash: Some(self.dash.as_ref().map(|x| x.to_vec())), drawing_id: Some(self.id.into()), greyed: Some(self.greyed), opacity: None },
            dr,
        );
    }

    fn text(&mut self, at: Vec2, s: String, h: f64) {
        let p = text(at, s, h, 0.0, self.color, self.greyed, Some(self.id));
        self.sink.push(p, 0);
    }

    /// Ein Linienende an `at` (`dir` zeigt auswärts); zurück kommt die Verkürzung der Linie.
    fn end_mark(&mut self, at: Vec2, dir: Vec2, mark: Option<EndMark>) -> f64 {
        let code = match mark {
            None | Some(EndMark::None) => return 0.0,
            Some(EndMark::Arrow) => 1.0,
            Some(EndMark::ArrowOpen) => 2.0,
            Some(EndMark::Dot) => 3.0,
            Some(EndMark::Tick) => 4.0,
            Some(EndMark::Square) => 5.0,
            Some(EndMark::Unknown) => f64::NAN,
        };
        let size = self.marks.and_then(|m| m.size_mm).unwrap_or(END_MARK_DEFAULT_SIZE_MM);
        let f = crate::plan::misc::end_mark(at.x, at.y, dir.x, dir.y, code, size, self.scale);
        if f.is_empty() {
            return 0.0;
        }
        let id = Some(self.id);
        let mut i = 2;
        for _ in 0..(f[1] as usize) {
            if f[i] == 1.0 {
                let n = f[i + 1] as usize;
                let pts = (0..n).map(|j| v(f[i + 2 + 2 * j], f[i + 3 + 2 * j])).collect();
                self.sink.push(polygon(pts, self.color, self.color, self.weight, no_hatch(), self.greyed, id), 0);
                i += 2 + 2 * n;
            } else if f[i] == 2.0 {
                self.line(v(f[i + 1], f[i + 2]), v(f[i + 3], f[i + 4]), self.weight, None, 0);
                i += 5;
            } else {
                self.sink.push(
                    Primitive::DrawingCircle {
                        center: v(f[i + 1], f[i + 2]),
                        r: f[i + 3],
                        fill: self.color.into(),
                        stroke: self.color.into(),
                        weight_mm: self.weight,
                        dash: None,
                        drawing_id: id.map(String::from),
                        greyed: Some(self.greyed),
                        opacity: None,
                    },
                    0,
                );
                i += 4;
            }
        }
        f[0]
    }

    fn start_mark(&self) -> Option<EndMark> {
        self.marks.and_then(|m| m.start)
    }

    fn end_mark_kind(&self) -> Option<EndMark> {
        self.marks.and_then(|m| m.end)
    }

    fn has_marks(&self) -> bool {
        self.start_mark().is_some() || self.end_mark_kind().is_some()
    }

    /// Enden einer offenen, tessellierten Punktfolge zeichnen und die Folge dort zurückziehen.
    fn with_end_marks(&mut self, mut pts: Vec<Vec2>) -> Vec<Vec2> {
        if pts.len() < 2 || !self.has_marks() {
            return pts;
        }
        let last = pts.len() - 1;
        let dir_start = v(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        let dir_end = v(pts[last].x - pts[last - 1].x, pts[last].y - pts[last - 1].y);
        let (s, e) = (self.start_mark(), self.end_mark_kind());
        let cut = self.end_mark(pts[0], dir_start, s);
        pts[0] = pull_back(pts[0], dir_start, cut);
        let cut = self.end_mark(pts[last], dir_end, e);
        pts[last] = pull_back(pts[last], dir_end, cut);
        pts
    }
}

/// Bogen-Parameter (`bulgeArc` in TS: Gerade unter 1e-9, sonst über den Kern).
struct BulgeArc {
    center: Vec2,
    r: f64,
    a0: f64,
    a1: f64,
    sweep: f64,
}

fn bulge_arc(a: Vec2, b: Vec2, bulge: f64) -> Option<BulgeArc> {
    if !(bulge.abs() >= 1e-9) {
        return None;
    }
    let r = crate::bulge::arc(a.x, a.y, b.x, b.y, bulge);
    if r.len() < 6 {
        return None;
    }
    Some(BulgeArc { center: v(r[0], r[1]), r: r[2], a0: r[3], a1: r[4], sweep: r[5] })
}

fn pts_of(f: &[f64]) -> Vec<Vec2> {
    f.chunks_exact(2).map(|c| v(c[0], c[1])).collect()
}

fn flat(p: &[Vec2]) -> Vec<f64> {
    p.iter().flat_map(|q| [q.x, q.y]).collect()
}

/// `bulgePolylinePoints`: ohne echten Bogen die Eingabepunkte, sonst tesselliert.
fn bulge_polyline_points(pts: &[Vec2], bulge: Option<&[f64]>, closed: bool) -> Vec<Vec2> {
    let real = bulge.is_some_and(|b| b.iter().any(|x| x.abs() > 1e-9));
    if !real {
        return pts.to_vec();
    }
    pts_of(&crate::bulge::polyline_points(&flat(pts), bulge.unwrap_or(&[]), closed))
}

#[allow(clippy::too_many_arguments)]
fn emit_inner(c: &Ctx, d: &Drawing2D, attrs: Attrs, geom: &Drawing2DGeom, greyed: bool, scale: f64, sink: &mut Sink, depth: u32) -> Result<(), String> {
    let p = c.p;
    let category = attrs.category;
    let ls_idx = attrs.line_style_id.filter(|s| !s.is_empty()).and_then(|id| p.line_styles.iter().position(|l| l.id == id));
    let ls = ls_idx.map(|i| &p.line_styles[i]);
    let color = attrs.color.or(ls.map(|l| l.color.as_str())).or(category.map(|k| k.color.as_str())).unwrap_or(MONO_INK);
    let weight = resolve_stroke_weight(attrs.weight, d.stroke_weight_source, category, category.map(|k| k.lw).unwrap_or(WALL_FALLBACK_MM));
    let dash_scale = match d.dash_scale {
        Some(s) if s > 0.0 => s,
        _ => 1.0,
    };
    let raw = ls.and_then(|l| l.dash.as_ref());
    let (dash, dash_ref) = match raw {
        None => (None, 0),
        Some(r) if dash_scale != 1.0 => (Some(Cow::Owned(r.iter().map(|x| x * dash_scale).collect::<Vec<f64>>())), sink.fresh_ref()),
        Some(r) => (Some(Cow::Borrowed(r.as_slice())), DASH_REF_STYLE + ls_idx.unwrap_or(0) as u32),
    };
    let layer_color = |src: Option<AttributeSource>| if src == Some(AttributeSource::Layer) { category.map(|k| k.color.as_str()) } else { None };
    let foreground = d.foreground.as_deref().or(layer_color(d.foreground_source));
    let background = d.background.as_deref().or(layer_color(d.background_source));
    let hatch_id = resolve_hatch_id(d.hatch_id.as_deref(), d.hatch_source, category, None);
    let zigzag = ls.filter(|l| l.kind == Some(LineStyleKind::Zigzag)).and_then(|l| l.zigzag.as_ref());
    let motif = ls.filter(|l| l.kind == Some(LineStyleKind::Custom)).and_then(|l| l.motif.as_ref());
    let fill_color = background.or(d.fill_color.as_deref()).unwrap_or("none");

    let mut em = Em { sink, id: &d.id, greyed, color, weight, dash, dash_ref, zigzag, motif, marks: d.end_marks.as_ref(), scale };

    // Gefüllte Fläche einer geschlossenen Form (Vollton-Füllung und/oder Schraffur), vor den Strichen.
    let fill_poly = |em: &mut Em, pts: Vec<Vec2>| -> Result<(), String> {
        let hatch = match hatch_id.filter(|s| !s.is_empty()) {
            // Hängende Schraffur (Datei/Import): Fläche ohne Muster statt Abbruch.
            Some(h) => resolve_hatch(p, h, None, foreground, Some((d.hatch_angle_deg, d.hatch_scale, d.hatch_origin))).unwrap_or_else(no_hatch),
            None => no_hatch(),
        };
        let pr = polygon(pts, fill_color, "none", 0.0, hatch, em.greyed, Some(em.id));
        em.sink.push(pr, 0);
        Ok(())
    };

    match geom {
        Drawing2DGeom::Line { a, b } => {
            let d_a = v(a.x - b.x, a.y - b.y);
            let d_b = v(b.x - a.x, b.y - a.y);
            let (s, e) = (em.start_mark(), em.end_mark_kind());
            let cut_a = em.end_mark(*a, d_a, s);
            let cut_b = em.end_mark(*b, d_b, e);
            em.seg(pull_back(*a, d_a, cut_a), pull_back(*b, d_b, cut_b));
        }
        Drawing2DGeom::Xline { a, b } | Drawing2DGeom::Ray { a, b } => {
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let len = hypot2(dx, dy);
            if len >= 1e-6 || len.is_nan() {
                let (ux, uy) = (dx / len, dy / len);
                let from = if matches!(geom, Drawing2DGeom::Xline { .. }) { v(a.x - ux * XLINE_EXTEND_M, a.y - uy * XLINE_EXTEND_M) } else { *a };
                let w = jsnum::min(em.weight, XLINE_WEIGHT_MM);
                em.line(from, v(b.x + ux * XLINE_EXTEND_M, b.y + uy * XLINE_EXTEND_M), w, Some(&XLINE_DASH), DASH_REF_XLINE);
            }
        }
        Drawing2DGeom::Polyline { pts, closed, bulge, holes } => {
            let n = pts.len();
            let bl = bulge.as_deref();
            let closed_ring = *closed && n > 2;
            // Inseln ([77]): gültige Ringe (≥ 3 Punkte), nur bei geschlossener Kontur.
            let holes: Vec<&Vec<Vec2>> = if closed_ring { holes.iter().flatten().filter(|h| h.len() >= 3).collect() } else { Vec::new() };
            if closed_ring {
                let ring = bulge_polyline_points(pts, bl, true);
                if holes.is_empty() {
                    fill_poly(&mut em, ring)?;
                } else {
                    // Ein Ring mit Brücken zu den Löchern (wie Decken): Füllung/Schraffur sparen sie aus.
                    let outer: Vec<[f64; 2]> = ring.iter().map(|q| [q.x, q.y]).collect();
                    let hs: Vec<Vec<[f64; 2]>> = holes.iter().map(|h| h.iter().map(|q| [q.x, q.y]).collect()).collect();
                    let merged = crate::polygon_holes::merge_holes(&outer, &hs, 1e-4);
                    fill_poly(&mut em, merged.ring.iter().map(|q| v(q[0], q[1])).collect())?;
                }
            }
            for h in &holes {
                for i in 0..h.len() {
                    em.seg(h[i], h[(i + 1) % h.len()]);
                }
            }
            let bulge_at = |i: usize| bl.and_then(|b| b.get(i)).copied();
            let open = !closed_ring;
            let mut first = pts.first().copied().unwrap_or_default();
            let mut last = pts.last().copied().unwrap_or_default();
            if open && n >= 2 && em.has_marks() {
                let tangent_at = |i: usize, at_start: bool| -> Vec2 {
                    let (a, b) = (pts[i], pts[i + 1]);
                    match bulge_arc(a, b, bulge_at(i).unwrap_or(0.0)) {
                        None => {
                            if at_start {
                                v(a.x - b.x, a.y - b.y)
                            } else {
                                v(b.x - a.x, b.y - a.y)
                            }
                        }
                        Some(arc) => {
                            let q = if at_start { a } else { b };
                            let rx = q.x - arc.center.x;
                            let ry = q.y - arc.center.y;
                            let sign = (if arc.sweep >= 0.0 { 1.0 } else { -1.0 }) * (if at_start { -1.0 } else { 1.0 });
                            v(-ry * sign, rx * sign)
                        }
                    }
                };
                let dir_start = tangent_at(0, true);
                let dir_end = tangent_at(n - 2, false);
                let (s, e) = (em.start_mark(), em.end_mark_kind());
                let cut = em.end_mark(first, dir_start, s);
                first = pull_back(first, dir_start, cut);
                let cut = em.end_mark(last, dir_end, e);
                last = pull_back(last, dir_end, cut);
            }
            // Ein Segment: gerade als Linie, gekrümmt als echter Bogen (CCW von a0 nach a1).
            let emit_segment = |em: &mut Em, a: Vec2, b: Vec2, bulge: Option<f64>| match bulge.and_then(|bv| bulge_arc(a, b, bv)) {
                None => em.seg(a, b),
                Some(arc) => {
                    let ccw = arc.sweep >= 0.0;
                    em.arc(arc.center, arc.r, if ccw { arc.a0 } else { arc.a1 }, if ccw { arc.a1 } else { arc.a0 });
                }
            };
            for i in 0..n.saturating_sub(1) {
                let a = if i == 0 { first } else { pts[i] };
                let b = if i == n - 2 { last } else { pts[i + 1] };
                emit_segment(&mut em, a, b, bulge_at(i));
            }
            if !open {
                emit_segment(&mut em, pts[n - 1], pts[0], bulge_at(n - 1));
            }
        }
        Drawing2DGeom::Rect { min, max } => {
            let c1 = *min;
            let c2 = v(max.x, min.y);
            let c3 = *max;
            let c4 = v(min.x, max.y);
            fill_poly(&mut em, vec![c1, c2, c3, c4])?;
            em.seg(c1, c2);
            em.seg(c2, c3);
            em.seg(c3, c4);
            em.seg(c4, c1);
        }
        Drawing2DGeom::Circle { center, r } => {
            let dash = Some(em.dash.as_ref().map(|x| x.to_vec()));
            em.circle(*center, *r, fill_color, dash);
        }
        Drawing2DGeom::Arc { center, r, a0, a1 } => em.arc(*center, *r, *a0, *a1),
        Drawing2DGeom::Ellipse { center, rx, ry, rotation } => {
            let pts = pts_of(&crate::curves::ellipse(center.x, center.y, *rx, *ry, *rotation, 64.0));
            fill_poly(&mut em, pts.clone())?;
            for i in 0..pts.len() {
                em.seg(pts[i], pts[(i + 1) % pts.len()]);
            }
        }
        Drawing2DGeom::Bezier { pts } => {
            let raw = if pts.len() < 4 { pts.clone() } else { pts_of(&crate::curves::bezier_chain(&flat(pts), 24.0)) };
            let q = em.with_end_marks(raw);
            for i in 0..q.len().saturating_sub(1) {
                em.seg(q[i], q[i + 1]);
            }
        }
        Drawing2DGeom::Spline { pts, closed, mode } => {
            let closed = *closed && pts.len() > 2;
            let raw = if pts.len() < 3 {
                pts.clone()
            } else if *mode == Some(SplineMode::Control) {
                pts_of(&crate::curves::uniform_bspline(&flat(pts), closed, 16.0))
            } else {
                pts_of(&crate::curves::catmull_rom(&flat(pts), closed, 16.0))
            };
            if closed {
                fill_poly(&mut em, raw.clone())?;
            }
            let q = if closed { raw } else { em.with_end_marks(raw) };
            for i in 0..q.len().saturating_sub(1) {
                em.seg(q[i], q[i + 1]);
            }
            if closed {
                em.seg(q[q.len() - 1], q[0]);
            }
        }
        // [140] Übersichtsplan (ab 1:500, Detail „mittel" automatisch grob): keine Masslinien.
        Drawing2DGeom::Dimension { .. } if c.a.auto_coarse && c.a.scale >= super::domains::OVERVIEW_FROM => {}
        Drawing2DGeom::Dimension { pts, offset, gap_mm, overshoot_mm, tick_len_mm, text_height_mm, line_weight_mm, ext_weight_mm, tick_weight_mm, text_offsets_mm, refs, kind, arc_center } => {
            let mm = |x: f64| mm_to_model(x, scale);
            // [157] Aussenbemassung hinter der sichtbaren Böschung (nur beim Zeichnen).
            let shifted = if arc_center.is_none() && kind.is_none() { *offset + autodim_shift(c, d, scale) } else { *offset };
            let offset = &shifted;
            if let Some(k) = kind {
                let st = DimStyle {
                    gap: mm(gap_mm.unwrap_or(DIM_GAP_MM)),
                    overshoot: mm(overshoot_mm.unwrap_or(DIM_OVERSHOOT_MM)),
                    tick_len: mm(tick_len_mm.unwrap_or(DIM_TICK_LEN_MM)),
                    text_height: mm(text_height_mm.unwrap_or(DIM_TEXT_HEIGHT_MM)),
                    line_weight: line_weight_mm.unwrap_or(em.weight),
                    ext_weight: ext_weight_mm.unwrap_or(em.weight),
                    tick_weight: tick_weight_mm.unwrap_or(em.weight * 2.0),
                    // [172] Masszahl-Griff: gespeicherter Versatz (Papier-mm) wie bei linearen Massen.
                    text_offset: text_offsets_mm.as_ref().and_then(|l| l.first()).map_or((0.0, 0.0), |o| (mm(o.along), mm(o.perp))),
                };
                dimension_round(&mut em, pts, *offset, *k, &st);
            }
            let auto = if kind.is_none() && arc_center.is_none() { dim_auto_offsets(pts, mm(text_height_mm.unwrap_or(DIM_TEXT_HEIGHT_MM))) } else { Vec::new() };
            for i in 0..(if kind.is_some() { 0 } else { pts.len().saturating_sub(1) }) {
                let st = DimStyle {
                    gap: mm(gap_mm.unwrap_or(DIM_GAP_MM)),
                    overshoot: mm(overshoot_mm.unwrap_or(DIM_OVERSHOOT_MM)),
                    tick_len: mm(tick_len_mm.unwrap_or(DIM_TICK_LEN_MM)),
                    text_height: mm(text_height_mm.unwrap_or(DIM_TEXT_HEIGHT_MM)),
                    line_weight: line_weight_mm.unwrap_or(em.weight),
                    ext_weight: ext_weight_mm.unwrap_or(em.weight),
                    tick_weight: tick_weight_mm.unwrap_or(em.weight * 2.0),
                    // [172] Gespeicherte Abweichung gilt (auch frei verschobene Texte alter Projekte); sonst die Vorgabe
                    // „mittig, nötigenfalls aussen".
                    text_offset: match text_offsets_mm.as_ref().and_then(|l| l.get(i)).filter(|o| o.along != 0.0 || o.perp != 0.0) {
                        Some(o) => (mm(o.along), mm(o.perp)),
                        None if arc_center.is_none() => auto.get(i).copied().unwrap_or((0.0, 0.0)),
                        None => (0.0, 0.0),
                    },
                };
                match arc_center {
                    Some(c) => arc_dimension_segment(&mut em, *c, pts[i], pts[i + 1], *offset, &st),
                    None => dimension_segment(&mut em, pts[i], pts[i + 1], *offset, &st),
                }
            }
            // Ungültiger Bezug ([38]): nur am Bildschirm eine rote Marke am Punkt.
            if !c.a.for_print {
                for i in crate::dim_assoc::lost_points(refs.as_ref()) {
                    if let Some(q) = pts.get(i) {
                        let r = mm(LOST_MARK_MM);
                        em.sink.push(
                            Primitive::DrawingCircle { center: *q, r, fill: LOST_MARK_COLOR.into(), stroke: LOST_MARK_COLOR.into(), weight_mm: em.weight, dash: None, drawing_id: Some(em.id.into()), greyed: Some(em.greyed), opacity: None },
                            0,
                        );
                    }
                }
            }
        }
        Drawing2DGeom::Kote { at, value, kind, .. } => {
            push_kote(em.sink, *at, *value, *kind, em.color, em.weight, em.greyed, Some(em.id), symbol_factor_at(p, &d.level_id, scale));
        }
        Drawing2DGeom::Detailref { at, label, sheet_layout_id, sheet_label } => {
            let f = symbol_factor_at(p, &d.level_id, scale);
            let (radius, text_h) = (DETAILREF_RADIUS_M * f, DETAILREF_TEXT_HEIGHT_M * f);
            em.circle(*at, radius, "none", Some(None));
            em.seg(v(at.x - radius, at.y), v(at.x + radius, at.y));
            let sheet_name = sheet_layout_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.layouts.as_deref().unwrap_or(&[]).iter().find(|l| l.id == id)).map(|l| l.name.as_str());
            let lower = sheet_name.or(sheet_label.as_deref()).unwrap_or("");
            let text_x = at.x - radius * 0.62;
            em.text(v(text_x, at.y + radius * 0.32), label.clone(), text_h);
            if !lower.is_empty() {
                em.text(v(text_x, at.y - radius * 0.68), lower.to_string(), text_h);
            }
        }
        Drawing2DGeom::Scalebar { at, segment_length, segments } => {
            let bar_h = mm_to_model(SCALEBAR_HEIGHT_MM, scale);
            let tick_len = mm_to_model(SCALEBAR_TICK_MM, scale);
            let text_h = mm_to_model(SCALEBAR_TEXT_MM, scale);
            let mut i = 0.0;
            while i < *segments {
                let x0 = at.x + i * segment_length;
                let x1 = x0 + segment_length;
                let pts = vec![v(x0, at.y), v(x1, at.y), v(x1, at.y + bar_h), v(x0, at.y + bar_h)];
                let fill = if i % 2.0 == 0.0 { em.color } else { "none" };
                let pr = polygon(pts, fill, em.color, em.weight, no_hatch(), em.greyed, Some(em.id));
                em.sink.push(pr, 0);
                i += 1.0;
            }
            let mut i = 0.0;
            let mut labels: Vec<(f64, String)> = Vec::new();
            while i <= *segments {
                let x = at.x + i * segment_length;
                em.seg(v(x, at.y), v(x, at.y - tick_len));
                let dist = i * segment_length;
                let dist_text = if dist.is_finite() && dist.trunc() == dist { js_number(dist) } else { to_fixed(dist, 2) };
                let label = if i == *segments { format!("{dist_text}m") } else { dist_text };
                labels.push((i, label));
                i += 1.0;
            }
            for (i, label) in scalebar_labels(labels, segment_length.abs(), text_h) {
                em.text(v(at.x + i * segment_length + text_h * 0.25, at.y - tick_len - text_h * 1.2), label, text_h);
            }
        }
        Drawing2DGeom::Pointmarker { at } => {
            let f = symbol_factor_at(p, &d.level_id, scale);
            let (r, cross) = (POINTMARKER_RADIUS_M * f, POINTMARKER_CROSS_M * f);
            em.circle(*at, r, "none", Some(None));
            em.seg(v(at.x - cross, at.y), v(at.x + cross, at.y));
            em.seg(v(at.x, at.y - cross), v(at.x, at.y + cross));
        }
        Drawing2DGeom::Grid { bubble_mm, .. } => {
            if let Some(spec) = crate::grid::Spec::of(geom) {
                // [140] Achsen enden an der Gebäudegrundfläche (alle Geschosse vereinigt).
                // [157] Blasen nicht auf den Massketten und Höhenkoten des Geschosses ([179] je Plan einmal gerechnet).
                emit_grid(&mut em, &spec, crate::grid::bubble_diameter(*bubble_mm, scale), c.house_rings(), c.dims_obstacles());
            }
        }
        Drawing2DGeom::Text { at, text: s, height, angle, width, marks, doc, leader_target, leader_bend_points, path_pts, paper_height } => {
            // [37] Papiergrösse: Schrifthöhe in mm auf dem Blatt, unabhängig vom Massstab.
            let height = &paper_height.filter(|mm| mm.is_finite() && *mm > 0.0).map_or(*height, |mm| mm_to_model(mm, scale));
            let color = marks.as_ref().and_then(|m| m.color.clone()).unwrap_or_else(|| em.color.to_string());
            if let Some(path) = path_pts.as_ref().filter(|q| q.len() >= 2) {
                em.sink.push(
                    Primitive::DrawingTextPath { path_pts: path.clone(), text: s.clone(), height_m: *height, color, drawing_id: Some(d.id.clone()), greyed: Some(greyed), opacity: None },
                    0,
                );
            } else {
                em.sink.push(
                    Primitive::DrawingText {
                        at: *at,
                        text: s.clone(),
                        height_m: *height,
                        angle: *angle,
                        color,
                        marks: marks.clone(),
                        wrap_width: width.filter(|w| *w > 0.0),
                        doc: doc.clone(),
                        drawing_id: Some(d.id.clone()),
                        greyed: Some(greyed),
                        opacity: None,
                    },
                    0,
                );
                if let Some(target) = leader_target {
                    let mut path = vec![*at];
                    path.extend(leader_bend_points.iter().flatten().copied());
                    path.push(*target);
                    let tip = path.len() - 1;
                    let dir = v(path[tip].x - path[tip - 1].x, path[tip].y - path[tip - 1].y);
                    let mark = em.end_mark_kind().or(Some(EndMark::Arrow));
                    let cut = em.end_mark(path[tip], dir, mark);
                    let tip_pulled = pull_back(path[tip], dir, cut);
                    for i in 0..tip {
                        em.seg(path[i], if i == tip - 1 { tip_pulled } else { path[i + 1] });
                    }
                }
            }
        }
        Drawing2DGeom::Block { block_def_id, at, rotation, scale: bscale } => {
            if depth >= MAX_BLOCK_DEPTH {
                return Ok(());
            }
            let Some(def) = p.block_defs.as_deref().unwrap_or(&[]).iter().find(|b| &b.id == block_def_id) else {
                return Ok(());
            };
            let scl = bscale.unwrap_or(1.0);
            let (cs, sn) = (jsnum::cos(*rotation), jsnum::sin(*rotation));
            let at = *at;
            let xf = move |q: Vec2| v(at.x + (q.x * scl) * cs - (q.y * scl) * sn, at.y + (q.x * scl) * sn + (q.y * scl) * cs);
            for sub in &def.geom2d {
                let g2 = scale_geom(sub, &xf, scl);
                emit(c, d, attrs, &g2, greyed, scale, em.sink, depth + 1)?;
            }
        }
        Drawing2DGeom::Image { min, max, src, opacity } => {
            em.sink.push(Primitive::DrawingImage { min: *min, max: *max, src: src.clone(), opacity: opacity.unwrap_or(1.0), drawing_id: Some(d.id.clone()), greyed: Some(greyed) }, 0);
        }
    }
    Ok(())
}

/// Stil eines Mass-Segments (Modell-Meter bzw. Strichstärken in Papier-mm).
struct DimStyle {
    gap: f64,
    overshoot: f64,
    tick_len: f64,
    text_height: f64,
    line_weight: f64,
    ext_weight: f64,
    tick_weight: f64,
    /// Versatz der Masszahl (entlang, quer).
    text_offset: (f64, f64),
}

/// Lage der Masszahl (`dimTextFrame`): Basis, Leserichtung, Querachse, Winkel (nie kopfüber).
pub fn dim_text_frame(a: Vec2, b: Vec2, offset: f64, text_height: f64) -> (Vec2, Vec2, Vec2, f64) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let l = hypot2(dx, dy);
    let len = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let nx = -dy / len;
    let ny = dx / len;
    let mid = v((a.x + b.x) / 2.0 + nx * offset, (a.y + b.y) / 2.0 + ny * offset);
    let mut angle = jsnum::atan2(dy, dx);
    if jsnum::cos(angle) < 0.0 {
        angle += std::f64::consts::PI;
    }
    let read = v(jsnum::cos(angle), jsnum::sin(angle));
    let up = v(-jsnum::sin(angle), jsnum::cos(angle));
    (v(mid.x + up.x * text_height * 0.6, mid.y + up.y * text_height * 0.6), read, up, angle)
}

/// [172] Lage der Masszahl eines Radius-/Durchmesser-/Bogenlängenmasses: `at` = Ankerpunkt auf der Masslinie
/// (Radius: Mitte der Strecke, Durchmesser: Mittelpunkt, Bogen: Bogenmitte auf der Masslinie), `angle` = Leserichtung
/// (nie kopfüber), `len` = Länge der Masslinie (für die Einrast-Stellen des Masszahl-Griffs), `text` = die Zahl.
pub struct RoundLabel {
    pub at: Vec2,
    pub angle: f64,
    pub len: f64,
    pub text: String,
}

pub fn round_label(kind: DimKind, pts: &[Vec2], offset: f64) -> Option<RoundLabel> {
    let (&c, &p) = (pts.first()?, pts.get(1)?);
    let r = hypot2(p.x - c.x, p.y - c.y);
    if !(r > 1e-6) {
        return None;
    }
    let upright = |a: f64| if jsnum::cos(a) < 0.0 { a + std::f64::consts::PI } else { a };
    let ang = jsnum::atan2(p.y - c.y, p.x - c.x);
    Some(match kind {
        DimKind::Radius => RoundLabel { at: v((c.x + p.x) / 2.0, (c.y + p.y) / 2.0), angle: upright(ang), len: r, text: format!("R {}", to_fixed(r, 2)) },
        DimKind::Diameter => RoundLabel { at: c, angle: upright(ang), len: 2.0 * r, text: format!("\u{d8} {}", to_fixed(2.0 * r, 2)) },
        DimKind::Arc => {
            let p1 = *pts.get(2)?;
            let a1 = jsnum::atan2(p1.y - c.y, p1.x - c.x);
            let sweep = (a1 - ang).rem_euclid(std::f64::consts::TAU);
            let rr = r + offset;
            if !(rr > 1e-6) || !(sweep > 1e-9) {
                return None;
            }
            let am = ang + sweep / 2.0;
            RoundLabel { at: v(c.x + jsnum::cos(am) * rr, c.y + jsnum::sin(am) * rr), angle: upright(am + std::f64::consts::FRAC_PI_2), len: rr * sweep, text: format!("L {}", to_fixed(r * sweep, 2)) }
        }
    })
}

/// [172] Textanfang so, dass die Zahl `s` (Schrifthöhe `h`) um `mid` zentriert steht: Texte hängen an ihrem Anfang
/// (linke Grundlinie), die Masszahl aber soll mittig über dem Massstrich stehen.
fn centered(mid: Vec2, read: Vec2, s: &str, h: f64) -> Vec2 {
    let w = crate::text_layout::text_width_em(s, false) * h;
    v(mid.x - read.x * w / 2.0, mid.y - read.y * w / 2.0)
}

/// Breite der Masszahl eines Segments der Länge `len` (Modell-Meter bei Schrifthöhe `h`).
pub fn dim_text_width(len: f64, h: f64) -> f64 {
    crate::text_layout::text_width_em(&to_fixed(len, 2), false) * h
}

/// Luft zwischen Masszahl und Hilfslinie bzw. Nachbarzahl (Modell-Meter bei Schrifthöhe `h`).
pub fn dim_text_pad(h: f64) -> f64 {
    0.4 * h
}

/// Versatz der Masszahl um eine Zeile nach oben für „über der Linie" (Modell-Meter bei Schrifthöhe `h`): Versalhöhe
/// 0.75 h plus Abstand 0.6 h. Unter der Linie ([`dim_text_below`]) liegt die Oberkante der Zahl im selben Abstand darunter.
pub fn dim_text_row(h: f64) -> f64 {
    1.35 * h
}

/// Versatz der Masszahl „unter der Linie" (negativ, quer zur Leserichtung).
pub fn dim_text_below(h: f64) -> f64 {
    -1.95 * h
}

/// [172] Vorgabe-Lage der Masszahlen einer Kette: je Segment (entlang, quer) in der Leserichtung relativ zur
/// Mitte über dem Massstrich (Modell-Meter). Passt die Zahl zwischen die Hilfslinien, ist es (0, 0); sonst
/// rückt sie nach aussen (links vom Segment, rechts davon, bei mittleren Segmenten auf die Seite des längeren
/// Nachbarn), auf die erste Seite ohne Überdeckung, notfalls eine Zeile höher. Für Plan und Griffe gleich.
pub fn dim_auto_offsets(pts: &[Vec2], h: f64) -> Vec<(f64, f64)> {
    let n = pts.len().saturating_sub(1);
    let mut out = vec![(0.0, 0.0); n];
    if n == 0 || !(h.is_finite() && h > 0.0) || pts.iter().any(|q| !(q.x.is_finite() && q.y.is_finite())) {
        return out;
    }
    let lens: Vec<f64> = (0..n).map(|i| hypot2(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)).collect();
    let starts: Vec<f64> = lens.iter().scan(0.0, |acc, l| { let s = *acc; *acc += l; Some(s) }).collect();
    let widths: Vec<f64> = lens.iter().map(|l| dim_text_width(*l, h)).collect();
    let pad = dim_text_pad(h);
    let fits: Vec<bool> = (0..n).map(|i| widths[i] + 2.0 * pad <= lens[i]).collect();
    // Belegte Streifen entlang der Kette: passende Zahlen in der Mitte ihres Segments.
    let mut taken: Vec<(f64, f64)> = (0..n).filter(|i| fits[*i]).map(|i| (starts[i] + lens[i] / 2.0 - widths[i] / 2.0, starts[i] + lens[i] / 2.0 + widths[i] / 2.0)).collect();
    let free = |c: f64, w: f64, taken: &[(f64, f64)]| taken.iter().all(|(a, b)| c + w / 2.0 + pad <= *a || c - w / 2.0 - pad >= *b);
    for i in 0..n {
        if fits[i] || lens[i] < 1e-6 {
            continue;
        }
        let w = widths[i];
        let left = starts[i] - pad - w / 2.0;
        let right = starts[i] + lens[i] + pad + w / 2.0;
        let prefer_left = if i == 0 { true } else if i == n - 1 { false } else { lens[i - 1] >= lens[i + 1] };
        let order = if prefer_left { [left, right] } else { [right, left] };
        let (centre, row) = match order.iter().find(|c| free(**c, w, &taken)) {
            Some(c) => (*c, 0.0),
            None => (order[0], dim_text_row(h)),
        };
        taken.push((centre - w / 2.0, centre + w / 2.0));
        // Entlang a→b in die Leserichtung umrechnen (der Text liest nie kopfüber).
        let (_, read, _, _) = dim_text_frame(pts[i], pts[i + 1], 0.0, h);
        let u = v((pts[i + 1].x - pts[i].x) / lens[i], (pts[i + 1].y - pts[i].y) / lens[i]);
        let s = if read.x * u.x + read.y * u.y >= 0.0 { 1.0 } else { -1.0 };
        out[i] = (s * (centre - starts[i] - lens[i] / 2.0), row);
    }
    out
}

/// Ein Mass-Segment (SIA 400 B.5.3): Masshilfslinien, Masslinie, Massstriche, Masszahl.
fn dimension_segment(em: &mut Em, a: Vec2, b: Vec2, offset: f64, st: &DimStyle) {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let line_len = hypot2(dx, dy);
    if line_len < 1e-6 {
        return;
    }
    let (ux, uy) = (dx / line_len, dy / line_len);
    let (nx, ny) = (-uy, ux);
    let sign = if offset >= 0.0 { 1.0 } else { -1.0 };
    let dim_a = v(a.x + nx * offset, a.y + ny * offset);
    let dim_b = v(b.x + nx * offset, b.y + ny * offset);
    let (dash, dref) = (em.dash.clone(), em.dash_ref);
    let dash = dash.as_deref();
    em.line(v(a.x + nx * st.gap * sign, a.y + ny * st.gap * sign), v(dim_a.x + nx * st.overshoot * sign, dim_a.y + ny * st.overshoot * sign), st.ext_weight, dash, dref);
    em.line(v(b.x + nx * st.gap * sign, b.y + ny * st.gap * sign), v(dim_b.x + nx * st.overshoot * sign, dim_b.y + ny * st.overshoot * sign), st.ext_weight, dash, dref);
    em.line(dim_a, dim_b, st.line_weight, dash, dref);
    // Massstriche: 45°-Diagonale, an beiden Enden parallel (SIA 400 Figur 13).
    let tx = (ux + nx) / std::f64::consts::SQRT_2;
    let ty = (uy + ny) / std::f64::consts::SQRT_2;
    let half = st.tick_len / 2.0;
    for q in [dim_a, dim_b] {
        em.line(v(q.x - tx * half, q.y - ty * half), v(q.x + tx * half, q.y + ty * half), st.tick_weight, None, 0);
    }
    let (base, read, up, angle) = dim_text_frame(a, b, offset, st.text_height);
    let (along, perp) = st.text_offset;
    let at = v(base.x + read.x * along + up.x * perp, base.y + read.y * along + up.y * perp);
    let label = to_fixed(line_len, 2);
    let at = centered(at, read, &label, st.text_height);
    let p = text(at, label, st.text_height, angle, em.color, em.greyed, Some(em.id));
    em.sink.push(p, 0);
}

/// Achsraster ([112]): Achsen strichpunktiert, an den Enden Blasen mit der Beschriftung.
/// [157] Beschriftungen des Massstabsbalkens (Teilstrich-Index, Text), ausgedünnt: liegen die Teilstriche
/// (`seg` Modell-m) enger als eine Zahl breit ist (Schrift `text_h`, Inter-Metrik + 0.4 Schrifthöhe Luft),
/// nur jeder k-te (k = 1, 2, 5, 10 …); 0 und das Ende („…m“) immer, die Zahl vor dem Ende entfällt, wenn sie
/// sonst hineinragt.
fn scalebar_labels(labels: Vec<(f64, String)>, seg: f64, text_h: f64) -> Vec<(f64, String)> {
    let width = |s: &str| crate::text_layout::text_width_em(s, false) * text_h + 0.4 * text_h;
    let Some(last) = labels.last().map(|l| l.0) else { return labels };
    if !(seg > 0.0) || !seg.is_finite() {
        return labels;
    }
    let need = labels.iter().filter(|l| l.0 < last).map(|l| width(&l.1)).fold(0.0, f64::max);
    let k = [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0].into_iter().find(|k| k * seg >= need).unwrap_or(last.max(1.0));
    let mut out: Vec<(f64, String)> = labels.into_iter().filter(|l| l.0 % k == 0.0 || l.0 == last).collect();
    // Vor dem Ende: die vorletzte Zahl muss neben dem Ende Platz haben (sonst weg, ausser der 0).
    while out.len() >= 2 {
        let (j, ref s) = out[out.len() - 2];
        if (last - j) * seg >= width(s) || j == 0.0 {
            break;
        }
        out.remove(out.len() - 2);
    }
    // Reicht der ganze Balken nicht für „0“ und das Ende: nur das Ende.
    if out.len() == 2 && out[0].0 == 0.0 && last * seg < width(&out[0].1) {
        out.remove(0);
    }
    out
}

/// [157] Wie weit die Blase (Radius `r`) am Achsende `end` in Richtung `dir` hinaus muss, damit sie mit Luft
/// (10 % des Radius) ausserhalb jedes Gebäuderings und frei von den Massketten `dims` liegt; 0, wenn sie schon
/// frei ist (höchstens 60 m).
fn bubble_shift(end: Vec2, dir: Vec2, r: f64, house: &[Vec<Vec2>], dims: &super::stamp_place::Obstacles) -> f64 {
    if !(r > 0.0) || (house.is_empty() && dims.is_empty()) || !(end.x.is_finite() && end.y.is_finite() && dir.x.is_finite() && dir.y.is_finite()) {
        return 0.0;
    }
    let clear = |c: Vec2| {
        house.iter().all(|ring| {
            !super::context::inside(c, ring) && (0..ring.len()).all(|k| super::context::seg_dist(c, [ring[k].x, ring[k].y], [ring[(k + 1) % ring.len()].x, ring[(k + 1) % ring.len()].y]) > r * 1.1)
        }) && (dims.is_empty() || dims.clearance(c, r * 1.1, r * 1.1) > 0.0)
    };
    let step = r / 4.0;
    let mut t = 0.0;
    while t <= 60.0 {
        if clear(v(end.x + dir.x * (t + r), end.y + dir.y * (t + r))) {
            return t;
        }
        t += step;
    }
    0.0
}

fn emit_grid(em: &mut Em, spec: &crate::grid::Spec, diameter: f64, house: &[Vec<Vec2>], dims: &super::stamp_place::Obstacles) {
    use crate::grid::Shape;
    // [153] Achsen strichpunktiert in Papier-mm (vorher mit dem Massstab in Modell-Meter vorskaliert).
    let dash = super::line_pattern::AXIS;
    let dash_ref = em.sink.fresh_ref();
    let w = jsnum::min(em.weight, XLINE_WEIGHT_MM.max(0.18));
    let r = diameter / 2.0;
    let text_h = diameter * 0.5;
    // [157] Blasen vor das Gebäude: endet eine gerade Achse im Gebäude (Anbau über die Rasterlinie), rückt
    // ihre Blase entlang der Achse hinaus; alle Blasen derselben Seite (gleiche Richtung) gleich weit.
    let axes = spec.axes();
    let side = |d: (f64, f64)| ((d.0 * 1e3).round() as i64, (d.1 * 1e3).round() as i64);
    let mut shift: HashMap<(i64, i64), f64> = HashMap::new();
    for ax in axes.iter().filter(|ax| matches!(ax.shape, Shape::Line { .. })) {
        for (end, dir) in ax.bubbles.iter().flatten() {
            let t = bubble_shift(v(end.0, end.1), v(dir.0, dir.1), r, house, dims);
            let e = shift.entry(side(*dir)).or_insert(0.0);
            *e = e.max(t);
        }
    }
    for ax in axes {
        let line = matches!(ax.shape, Shape::Line { .. });
        let shift_of = |dir: (f64, f64)| if line { shift.get(&side(dir)).copied().unwrap_or(0.0) } else { 0.0 };
        match ax.shape {
            Shape::Line { a, b } => {
                for (p0, p1) in super::context::outside(v(a.0, a.1), v(b.0, b.1), house) {
                    em.line(p0, p1, w, Some(&dash), dash_ref);
                }
                // Verlängerung bis zur hinausgerückten Blase (nur ausserhalb des Gebäudes).
                for (end, dir) in ax.bubbles.iter().flatten() {
                    let t = shift_of(*dir);
                    if t > 0.0 {
                        for (p0, p1) in super::context::outside(v(end.0, end.1), v(end.0 + dir.0 * t, end.1 + dir.1 * t), house) {
                            em.line(p0, p1, w, Some(&dash), dash_ref);
                        }
                    }
                }
            }
            Shape::Arc { c, r: rad, a0, a1 } => {
                let dash_v = Some(dash.to_vec());
                if a1 - a0 >= std::f64::consts::TAU - 1e-9 {
                    em.sink.push(
                        Primitive::DrawingCircle { center: v(c.0, c.1), r: rad, fill: "none".into(), stroke: em.color.into(), weight_mm: w, dash: Some(dash_v), drawing_id: Some(em.id.into()), greyed: Some(em.greyed), opacity: None },
                        dash_ref,
                    );
                } else {
                    em.sink.push(
                        Primitive::DrawingArc { center: v(c.0, c.1), r: rad, a0, a1, stroke: em.color.into(), weight_mm: w, dash: Some(dash_v), drawing_id: Some(em.id.into()), greyed: Some(em.greyed), opacity: None },
                        dash_ref,
                    );
                }
            }
        }
        for (end, dir) in ax.bubbles.iter().flatten() {
            let t = shift_of(*dir);
            let c = v(end.0 + dir.0 * (t + r), end.1 + dir.1 * (t + r));
            em.circle(c, r, "none", Some(None));
            let n = ax.label.chars().count() as f64;
            em.text(v(c.x - text_h * 0.3 * n, c.y - text_h * 0.35), ax.label.clone(), text_h);
        }
    }
}

/// Radius-, Durchmesser- und Bogenlängen-Mass ([38]): `pts` = Mittelpunkt, Punkt auf dem Kreis
/// (bzw. Bogenanfang, Bogenende); Mass auf dem Rand mit Massstrichen und Masszahl.
fn dimension_round(em: &mut Em, pts: &[Vec2], offset: f64, kind: DimKind, st: &DimStyle) {
    let (Some(&c), Some(&p)) = (pts.first(), pts.get(1)) else { return };
    let r = hypot2(p.x - c.x, p.y - c.y);
    if !(r > 1e-6) {
        return;
    }
    let (ux, uy) = ((p.x - c.x) / r, (p.y - c.y) / r);
    let tick = |em: &mut Em, q: Vec2, tx: f64, ty: f64| {
        let (nx, ny) = (-ty, tx);
        let (dx, dy) = ((tx + nx) / std::f64::consts::SQRT_2, (ty + ny) / std::f64::consts::SQRT_2);
        let h = st.tick_len / 2.0;
        em.line(v(q.x - dx * h, q.y - dy * h), v(q.x + dx * h, q.y + dy * h), st.tick_weight, None, 0);
    };
    // [172] Masszahl: Anker, Winkel und Text aus `round_label`, dazu der Versatz (entlang, quer) des Einrast-Griffs.
    let label = |em: &mut Em| {
        let Some(l) = round_label(kind, pts, offset) else { return };
        let (read, up) = (v(jsnum::cos(l.angle), jsnum::sin(l.angle)), v(-jsnum::sin(l.angle), jsnum::cos(l.angle)));
        let (al, pe) = st.text_offset;
        let q = v(l.at.x + up.x * (st.text_height * 0.6 + pe) + read.x * al, l.at.y + up.y * (st.text_height * 0.6 + pe) + read.y * al);
        // Mittig über dem Ankerpunkt, nicht mit dem Anfang daran hängend.
        let q = centered(q, read, &l.text, st.text_height);
        let pr = text(q, l.text, st.text_height, l.angle, em.color, em.greyed, Some(em.id));
        em.sink.push(pr, 0);
    };
    let (dash, dref) = (em.dash.clone(), em.dash_ref);
    let dash = dash.as_deref();
    match kind {
        DimKind::Radius => {
            em.line(c, p, st.line_weight, dash, dref);
            tick(em, p, ux, uy);
            tick(em, c, ux, uy);
            label(em);
        }
        DimKind::Diameter => {
            let q = v(c.x - ux * r, c.y - uy * r);
            em.line(q, p, st.line_weight, dash, dref);
            tick(em, p, ux, uy);
            tick(em, q, ux, uy);
            label(em);
        }
        DimKind::Arc => {
            let Some(&p1) = pts.get(2) else { return };
            let a0 = jsnum::atan2(p.y - c.y, p.x - c.x);
            let a1 = jsnum::atan2(p1.y - c.y, p1.x - c.x);
            let sweep = (a1 - a0).rem_euclid(std::f64::consts::TAU);
            let rr = r + offset;
            if !(rr > 1e-6) || !(sweep > 1e-9) {
                return;
            }
            let sign = if offset >= 0.0 { 1.0 } else { -1.0 };
            for (a, pt) in [(a0, p), (a1, p1)] {
                let (cx, cy) = (jsnum::cos(a), jsnum::sin(a));
                em.line(v(pt.x + cx * st.gap * sign, pt.y + cy * st.gap * sign), v(c.x + cx * (rr + st.overshoot * sign), c.y + cy * (rr + st.overshoot * sign)), st.ext_weight, dash, dref);
                tick(em, v(c.x + cx * rr, c.y + cy * rr), -cy, cx);
            }
            em.sink.push(
                Primitive::DrawingArc { center: c, r: rr, a0, a1: a0 + sweep, stroke: em.color.into(), weight_mm: st.line_weight, dash: Some(dash.map(|x| x.to_vec())), drawing_id: Some(em.id.into()), greyed: Some(em.greyed), opacity: None },
                if dash.is_some() { dref } else { 0 },
            );
            label(em);
        }
    }
}

/// [T2] Bogenmass-Segment: Masslinie als Kreisbogen um `c` im Radius |a − c| + `offset`, radiale
/// Masshilfslinien, 45°-Massstriche zur Tangente, Masszahl = Bogenlänge (kürzerer Bogen) auf |a − c|.
fn arc_dimension_segment(em: &mut Em, c: Vec2, a: Vec2, b: Vec2, offset: f64, st: &DimStyle) {
    let r = hypot2(a.x - c.x, a.y - c.y);
    if !(r > 1e-6) || !offset.is_finite() {
        return;
    }
    let (ta, tb) = (jsnum::atan2(a.y - c.y, a.x - c.x), jsnum::atan2(b.y - c.y, b.x - c.x));
    let pi = std::f64::consts::PI;
    let mut d = tb - ta;
    while d > pi {
        d -= 2.0 * pi;
    }
    while d <= -pi {
        d += 2.0 * pi;
    }
    if d.abs() < 1e-9 {
        return;
    }
    let rm = r + offset;
    let sign = if offset >= 0.0 { 1.0 } else { -1.0 };
    let at = |t: f64, rr: f64| v(c.x + rr * jsnum::cos(t), c.y + rr * jsnum::sin(t));
    let (dash, dref) = (em.dash.clone(), em.dash_ref);
    let dash = dash.as_deref();
    // Radiale Masshilfslinien vom Punkt (Abstand) bis über die Masslinie (Überstand).
    for t in [ta, ta + d] {
        em.line(at(t, r + st.gap * sign), at(t, rm + st.overshoot * sign), st.ext_weight, dash, dref);
    }
    // Masslinie: Bogen in ≤ 2°-Stücken.
    let n = ((d.abs() / (pi / 90.0)).ceil() as usize).max(1);
    for k in 0..n {
        let (t0, t1) = (ta + d * k as f64 / n as f64, ta + d * (k + 1) as f64 / n as f64);
        em.line(at(t0, rm), at(t1, rm), st.line_weight, dash, dref);
    }
    // Massstriche: 45° zwischen Tangente (Laufrichtung) und Radiale, an beiden Enden gleich.
    let half = st.tick_len / 2.0;
    for t in [ta, ta + d] {
        let q = at(t, rm);
        let tan = v(-jsnum::sin(t) * d.signum(), jsnum::cos(t) * d.signum());
        let rad = v(jsnum::cos(t), jsnum::sin(t));
        let (tx, ty) = ((tan.x + rad.x) / std::f64::consts::SQRT_2, (tan.y + rad.y) / std::f64::consts::SQRT_2);
        em.line(v(q.x - tx * half, q.y - ty * half), v(q.x + tx * half, q.y + ty * half), st.tick_weight, None, 0);
    }
    // Masszahl tangential in der Bogenmitte, aussen an der Masslinie (nie kopfüber).
    let tm = ta + d / 2.0;
    let mut angle = tm + pi / 2.0;
    if jsnum::cos(angle) < 0.0 {
        angle += pi;
    }
    let read = v(jsnum::cos(angle), jsnum::sin(angle));
    let up = v(-jsnum::sin(angle), jsnum::cos(angle));
    let base = at(tm, rm + sign * st.text_height * 0.6);
    let (along, perp) = st.text_offset;
    let pos = v(base.x + read.x * along + up.x * perp, base.y + read.y * along + up.y * perp);
    let label = to_fixed(r * d.abs(), 2);
    let pos = centered(pos, read, &label, st.text_height);
    let p = text(pos, label, st.text_height, angle, em.color, em.greyed, Some(em.id));
    em.sink.push(p, 0);
}

/// Dreht die Umlauf-Orientierung um (Spiegelung)? Flächenvorzeichen eines Test-Dreiecks.
fn reverses_orientation(f: &dyn Fn(Vec2) -> Vec2) -> bool {
    let (p0, p1, p2) = (f(v(0.0, 0.0)), f(v(1.0, 0.0)), f(v(0.0, 1.0)));
    (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y) < 0.0
}

/// `mvGeom`: jeden Punkt einer Zeichengeometrie unter `f` abbilden.
pub fn mv_geom(g: &Drawing2DGeom, f: &dyn Fn(Vec2) -> Vec2) -> Drawing2DGeom {
    use Drawing2DGeom as G;
    let map = |l: &Vec<Vec2>| l.iter().map(|q| f(*q)).collect::<Vec<Vec2>>();
    match g {
        G::Line { a, b } => G::Line { a: f(*a), b: f(*b) },
        G::Xline { a, b } => G::Xline { a: f(*a), b: f(*b) },
        G::Ray { a, b } => G::Ray { a: f(*a), b: f(*b) },
        G::Polyline { pts, closed, bulge, holes } => {
            let pts = map(pts);
            let bulge = bulge.as_ref().map(|b| if reverses_orientation(f) { b.iter().map(|x| -x).collect() } else { b.clone() });
            let holes = holes.as_ref().map(|hs| hs.iter().map(map).collect());
            G::Polyline { pts, closed: *closed, bulge, holes }
        }
        G::Rect { min, max } => {
            let c = [*min, v(max.x, min.y), *max, v(min.x, max.y)].map(f);
            let aligned = (c[0].y - c[1].y).abs() < 1e-6 && (c[1].x - c[2].x).abs() < 1e-6 && (c[2].y - c[3].y).abs() < 1e-6;
            if aligned {
                let fold = |k: fn(f64, f64) -> f64, s: fn(&Vec2) -> f64| c.iter().map(s).reduce(k).unwrap_or(f64::NAN);
                G::Rect { min: v(fold(jsnum::min, |q| q.x), fold(jsnum::min, |q| q.y)), max: v(fold(jsnum::max, |q| q.x), fold(jsnum::max, |q| q.y)) }
            } else {
                G::Polyline { pts: c.to_vec(), closed: true, bulge: None, holes: None }
            }
        }
        G::Circle { center, r } => G::Circle { center: f(*center), r: *r },
        G::Arc { center, r, a0, a1 } => G::Arc { center: f(*center), r: *r, a0: *a0, a1: *a1 },
        G::Ellipse { center, rx, ry, rotation } => G::Ellipse { center: f(*center), rx: *rx, ry: *ry, rotation: *rotation },
        G::Bezier { pts } => G::Bezier { pts: map(pts) },
        G::Spline { pts, closed, mode } => G::Spline { pts: map(pts), closed: *closed, mode: *mode },
        G::Dimension { pts, .. } => {
            let mut out = g.clone();
            if let G::Dimension { pts: p2, arc_center, .. } = &mut out {
                *p2 = map(pts);
                *arc_center = arc_center.map(f);
            }
            out
        }
        G::Kote { at, value, kind, rotation } => G::Kote { at: f(*at), value: *value, kind: *kind, rotation: *rotation },
        G::Detailref { at, label, sheet_layout_id, sheet_label } => G::Detailref { at: f(*at), label: label.clone(), sheet_layout_id: sheet_layout_id.clone(), sheet_label: sheet_label.clone() },
        G::Scalebar { at, segment_length, segments } => G::Scalebar { at: f(*at), segment_length: *segment_length, segments: *segments },
        G::Pointmarker { at } => G::Pointmarker { at: f(*at) },
        G::Grid { origin, angle, radial, a, b, extend, bubbles, bubble_mm, levels, show_3d } => {
            let o = f(*origin);
            let ex = f(v(origin.x + angle.cos(), origin.y + angle.sin()));
            let flip = reverses_orientation(f);
            let neg = |l: &Vec<GridAxis>| l.iter().map(|x| GridAxis { label: x.label.clone(), pos: -x.pos, bubble: x.bubble }).collect::<Vec<_>>();
            let ang = (ex.y - o.y).atan2(ex.x - o.x);
            let (a2, b2) = match (flip, radial == &Some(true)) {
                (false, _) => (a.clone(), b.clone()),
                (true, false) => (a.clone(), neg(b)),
                (true, true) => (neg(a), b.clone()),
            };
            G::Grid { origin: o, angle: ang, radial: *radial, a: a2, b: b2, extend: *extend, bubbles: *bubbles, bubble_mm: *bubble_mm, levels: levels.clone(), show_3d: *show_3d }
        }
        G::Text { at, text, height, angle, width, marks, doc, leader_target, leader_bend_points, path_pts, paper_height } => G::Text {
            at: f(*at),
            text: text.clone(),
            height: *height,
            paper_height: *paper_height,
            angle: *angle,
            width: *width,
            marks: marks.clone(),
            doc: doc.clone(),
            leader_target: leader_target.map(f),
            leader_bend_points: leader_bend_points.as_ref().map(map),
            path_pts: path_pts.as_ref().map(map),
        },
        G::Block { block_def_id, at, rotation, scale } => {
            let tip = v(at.x + jsnum::cos(*rotation), at.y + jsnum::sin(*rotation));
            let nb = f(*at);
            let nt = f(tip);
            G::Block { block_def_id: block_def_id.clone(), at: nb, rotation: jsnum::atan2(nt.y - nb.y, nt.x - nb.x), scale: *scale }
        }
        G::Image { min, max, src, opacity } => {
            let old = v((min.x + max.x) / 2.0, (min.y + max.y) / 2.0);
            let new = f(old);
            let (dx, dy) = (new.x - old.x, new.y - old.y);
            G::Image { min: v(min.x + dx, min.y + dy), max: v(max.x + dx, max.y + dy), src: src.clone(), opacity: *opacity }
        }
    }
}

/// `scaleGeom`: wie [`mv_geom`], zusätzlich Grössenfelder (Radien, Schrift, Abstände) um `k`.
pub fn scale_geom(g: &Drawing2DGeom, f: &dyn Fn(Vec2) -> Vec2, k: f64) -> Drawing2DGeom {
    use Drawing2DGeom as G;
    let mut out = mv_geom(g, f);
    match &mut out {
        G::Circle { r, .. } | G::Arc { r, .. } => *r *= k,
        G::Ellipse { rx, ry, .. } => {
            *rx *= k;
            *ry *= k;
        }
        G::Dimension { offset, .. } => *offset *= k,
        G::Grid { a, b, extend, radial, .. } => {
            if *radial != Some(true) {
                a.iter_mut().for_each(|x| x.pos *= k);
            }
            b.iter_mut().for_each(|x| x.pos *= k);
            if let Some(e) = extend {
                *e *= k;
            }
        }
        G::Text { height, width, .. } => {
            *height *= k;
            if let Some(w) = width {
                *w *= k;
            }
        }
        G::Scalebar { segment_length, .. } => *segment_length *= k,
        G::Block { scale, .. } => *scale = Some(scale.unwrap_or(1.0) * k),
        _ => {}
    }
    out
}

/// Ausmass einer Zeichnung für „Einpassen"/Druck (`computeBounds` in TS).
fn acc_bounds(g: &Drawing2DGeom, b: &mut Bounds) {
    use Drawing2DGeom as G;
    let mut acc = |q: &Vec2| b.acc(q.x, q.y);
    match g {
        G::Line { .. } | G::Polyline { .. } => {
            let pts: &[Vec2] = match g {
                G::Line { a, b } => &[*a, *b],
                G::Polyline { pts, .. } => pts,
                _ => &[],
            };
            let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            for q in pts {
                if q.x < x0 {
                    x0 = q.x;
                }
                if q.x > x1 {
                    x1 = q.x;
                }
                if q.y < y0 {
                    y0 = q.y;
                }
                if q.y > y1 {
                    y1 = q.y;
                }
            }
            if x0.is_finite() {
                acc(&v(x0, y0));
                acc(&v(x1, y1));
            }
        }
        G::Rect { min, max } | G::Image { min, max, .. } => {
            acc(min);
            acc(max);
        }
        G::Circle { center, r } | G::Arc { center, r, .. } => {
            acc(&v(center.x - r, center.y - r));
            acc(&v(center.x + r, center.y + r));
        }
        G::Ellipse { center, rx, ry, .. } => {
            acc(&v(center.x - rx, center.y - ry));
            acc(&v(center.x + rx, center.y + ry));
        }
        G::Bezier { pts } | G::Spline { pts, .. } => pts.iter().for_each(acc),
        G::Dimension { pts, offset, .. } => {
            pts.iter().for_each(&mut acc);
            let reach = offset * 1.4;
            for i in 0..pts.len().saturating_sub(1) {
                let (a, bb) = (pts[i], pts[i + 1]);
                let len = hypot2(bb.x - a.x, bb.y - a.y);
                if len < 1e-9 {
                    continue;
                }
                let nx = (-(bb.y - a.y) / len) * reach;
                let ny = ((bb.x - a.x) / len) * reach;
                acc(&v(a.x + nx, a.y + ny));
                acc(&v(bb.x + nx, bb.y + ny));
            }
        }
        G::Kote { at, .. } | G::Detailref { at, .. } | G::Pointmarker { at } | G::Text { at, .. } => acc(at),
        G::Grid { .. } => {
            if let Some(spec) = crate::grid::Spec::of(g) {
                for ax in spec.axes() {
                    match ax.shape {
                        // Rand für die Blasen an den Enden (Durchmesser bis ≈ 1 m bei 1:100).
                        crate::grid::Shape::Line { a, b: e } => {
                            acc(&v(a.0 - GRID_BUBBLE_MARGIN_M, a.1 - GRID_BUBBLE_MARGIN_M));
                            acc(&v(e.0 + GRID_BUBBLE_MARGIN_M, e.1 + GRID_BUBBLE_MARGIN_M));
                            acc(&v(a.0 + GRID_BUBBLE_MARGIN_M, a.1 + GRID_BUBBLE_MARGIN_M));
                            acc(&v(e.0 - GRID_BUBBLE_MARGIN_M, e.1 - GRID_BUBBLE_MARGIN_M));
                        }
                        crate::grid::Shape::Arc { c, r, .. } => {
                            acc(&v(c.0 - r - GRID_BUBBLE_MARGIN_M, c.1 - r - GRID_BUBBLE_MARGIN_M));
                            acc(&v(c.0 + r + GRID_BUBBLE_MARGIN_M, c.1 + r + GRID_BUBBLE_MARGIN_M));
                        }
                    }
                }
            }
        }
        G::Scalebar { at, segment_length, segments } => {
            acc(at);
            acc(&v(at.x + segment_length * segments, at.y));
        }
        G::Xline { .. } | G::Ray { .. } | G::Block { .. } => {}
    }
}

/// Liegt die Zeichnung auf dem Geschoss (und ist sie im Druck nicht ausgenommen, `noPrint`)?
/// [157] Zusätzlicher Abstand einer Kette der automatischen Aussenbemassung (`autodim-<Geschoss>-<Seite>-<Kette>`,
/// gerade) beim Zeichnen: zeigt der Grundriss die Baugrube und schneidet eine Kette dieser Seite Sohle oder
/// Böschung (bis zur Böschungsoberkante), rücken alle Ketten der Seite gleich weit hinaus — die innerste mit
/// 4 mm Papier Luft hinter die Böschung. Im Modell bleiben die Ketten, wo sie sind (Geschosse ohne Gelände,
/// Ausmass des Präsentationsplans).
fn autodim_shift(c: &Ctx, d: &Drawing2D, scale: f64) -> f64 {
    let prefix = format!("autodim-{}-", d.level_id);
    let Some(rest) = d.id.strip_prefix(&prefix) else { return 0.0 };
    let Some((side, _)) = rest.rsplit_once('-') else { return 0.0 };
    if side == "arc" || side.starts_with("arc-") {
        return 0.0;
    }
    let obst = super::context::excavation_segments(c);
    if obst.is_empty() {
        return 0.0;
    }
    let group = format!("{prefix}{side}-");
    let margin = mm_to_model(4.0, scale);
    let mut need: f64 = 0.0;
    for g in c.p.drawings2d.iter().filter(|g| g.id.starts_with(&group)) {
        let Drawing2DGeom::Dimension { pts, offset, arc_center: None, kind: None, .. } = &g.geom else { continue };
        let (Some(a), Some(b)) = (pts.first(), pts.last()) else { continue };
        let len = hypot2(b.x - a.x, b.y - a.y);
        if !(len > 1e-6) || !offset.is_finite() || offset.abs() < 1e-9 {
            continue;
        }
        let u = ((b.x - a.x) / len, (b.y - a.y) / len);
        // Aussen = Seite des Versatzes (wie `dimension_segment`).
        let sg = offset.signum();
        let n = (-u.1 * sg, u.0 * sg);
        let (t0, t1) = (-margin, len + margin);
        let mut s_max = f64::NEG_INFINITY;
        for &(p, q) in &obst {
            let (tp, tq) = ((p[0] - a.x) * u.0 + (p[1] - a.y) * u.1, (q[0] - a.x) * u.0 + (q[1] - a.y) * u.1);
            let (sp, sq) = ((p[0] - a.x) * n.0 + (p[1] - a.y) * n.1, (q[0] - a.x) * n.0 + (q[1] - a.y) * n.1);
            // Teilstück im Streifen der Kette.
            let (lo, hi) = if (tq - tp).abs() < 1e-12 {
                if tp < t0 || tp > t1 { continue } else { (0.0, 1.0) }
            } else {
                let (f0, f1) = ((t0 - tp) / (tq - tp), (t1 - tp) / (tq - tp));
                (f0.min(f1).max(0.0), f0.max(f1).min(1.0))
            };
            if lo > hi {
                continue;
            }
            s_max = s_max.max(sp + (sq - sp) * lo).max(sp + (sq - sp) * hi);
        }
        // Nur was aussen vor der Kette liegt und sie erreicht.
        if s_max > 0.0 && s_max + margin > offset.abs() {
            need = need.max(s_max + margin - offset.abs());
        }
    }
    need * d_sign(d)
}

/// Vorzeichen des Versatzes einer Masskette (der Abstand wächst in seiner Richtung).
fn d_sign(d: &Drawing2D) -> f64 {
    match &d.geom {
        Drawing2DGeom::Dimension { offset, .. } if *offset < 0.0 => -1.0,
        _ => 1.0,
    }
}

/// [173] Dazu die Bemassung der Modelldarstellung: Ketten der automatischen Aussenbemassung und Höhenkoten
/// (`model_view::DimOpts::shows`).
fn on_floor(c: &Ctx, d: &Drawing2D) -> bool {
    crate::grid::visible_on(d, &c.a.floor) && !(c.a.for_print && d.no_print == Some(true)) && c.mv().dims.shows(d)
}

/// Domäne „2D-Zeichnungen" von `planDomains`: alle gezeichneten Zeichnungen des Geschosses in
/// Projekt-Reihenfolge, mit Override-Regeln; mit `compact` ohne die Linien der Zeichnungen der
/// kompakten Unterlage ([`underlay_groups`]). Das Ausmass aller gezeichneten Zeichnungen geht in
/// `bounds`.
pub fn plan_drawings(c: &Ctx, sink: &mut Sink, bounds: &mut Bounds) -> Result<(), String> {
    let mut memo = Memo::default();
    for d in &c.p.drawings2d {
        if !on_floor(c, d) {
            continue;
        }
        let m = memo.get(c, d);
        if !m.shown {
            continue;
        }
        sink.keep = if c.a.compact && compact_eligible(d) { Keep::NoLines } else { Keep::All };
        emit(c, d, Attrs::with(d, &m.ov, m.cat), &d.geom, m.greyed, c.a.scale, sink, 0)?;
        acc_bounds(&d.geom, bounds);
    }
    sink.keep = Keep::All;
    Ok(())
}

/// [140] Zeichnungsarten, denen Raumstempel ausweichen (Bemassung, Koten, Texte, Symbole/Möbel als Blöcke,
/// Detailverweise, Punktmarken). Linien, Flächen, Raster und Bilder nicht: sie laufen oft durch ganze Räume.
pub fn is_stamp_obstacle(g: &Drawing2DGeom) -> bool {
    matches!(g, Drawing2DGeom::Dimension { .. } | Drawing2DGeom::Kote { .. } | Drawing2DGeom::Text { .. } | Drawing2DGeom::Block { .. } | Drawing2DGeom::Detailref { .. } | Drawing2DGeom::Pointmarker { .. })
}

/// [140] Primitive der gezeichneten Zeichnungen des Geschosses, denen Raumstempel ausweichen
/// ([`is_stamp_obstacle`]), wie [`plan_drawings`] sie zeichnet.
pub fn stamp_obstacle_prims(c: &Ctx) -> Vec<Primitive> {
    prims_where(c, is_stamp_obstacle)
}

/// [179] Hindernisse der Zeichnungen des Geschosses ([`is_stamp_obstacle`]) und, daraus in einem Durchgang,
/// die der Masse und Höhenkoten allein (Achsblasen weichen ihnen aus, [157]).
pub(super) fn drawn_and_dimension_obstacles(c: &Ctx) -> (super::stamp_place::Obstacles, super::stamp_place::Obstacles) {
    let mut memo = Memo::default();
    let (mut drawn, mut dims) = (super::stamp_place::Obstacles::default(), super::stamp_place::Obstacles::default());
    for d in c.p.drawings2d.iter().filter(|d| is_stamp_obstacle(&d.geom) && on_floor(c, d)) {
        let m = memo.get(c, d);
        if !m.shown {
            continue;
        }
        let mut out = Out::default();
        let mut sink = Sink::new(Target::Vec(&mut out), Keep::All);
        // Fehler einer Zeichnung: ohne sie weiter (Hindernisse sind nur ein Hinweis für die Lage).
        let _ = emit(c, d, Attrs::with(d, &m.ov, m.cat), &d.geom, m.greyed, c.a.scale, &mut sink, 0);
        let is_dim = matches!(d.geom, Drawing2DGeom::Dimension { .. } | Drawing2DGeom::Kote { .. });
        for q in &out.prims {
            drawn.add_prim(q);
            if is_dim {
                dims.add_prim(q);
            }
        }
    }
    (drawn, dims)
}

/// [150] Blasen und Beschriftungen der Achsraster des Geschosses (ohne die Achsen): Höhenlinien-Beschriftungen
/// weichen ihnen aus.
pub fn grid_bubble_prims(c: &Ctx) -> Vec<Primitive> {
    prims_where(c, |g| matches!(g, Drawing2DGeom::Grid { .. })).into_iter().filter(|q| matches!(q, Primitive::DrawingCircle { .. } | Primitive::DrawingText { .. })).collect()
}

fn prims_where(c: &Ctx, pred: impl Fn(&Drawing2DGeom) -> bool) -> Vec<Primitive> {
    let mut out = Out::default();
    let mut memo = Memo::default();
    let mut sink = Sink::new(Target::Vec(&mut out), Keep::All);
    for d in c.p.drawings2d.iter().filter(|d| pred(&d.geom) && on_floor(c, d)) {
        let m = memo.get(c, d);
        if !m.shown {
            continue;
        }
        // Fehler einer Zeichnung: ohne sie weiter (Hindernisse sind nur ein Hinweis für die Lage).
        let _ = emit(c, d, Attrs::with(d, &m.ov, m.cat), &d.geom, m.greyed, c.a.scale, &mut sink, 0);
    }
    out.prims
}

/// [156] Grundflächen der gezeichneten Blöcke (Möbel, Sanitär-/Einbau-Symbole) des Geschosses als konvexe
/// Hülle ihrer Striche: der Bodenbelag spart sie aus.
pub fn block_footprints(c: &Ctx) -> Vec<Vec<[f64; 2]>> {
    let mut memo = Memo::default();
    let mut res = Vec::new();
    for d in c.p.drawings2d.iter().filter(|d| matches!(d.geom, Drawing2DGeom::Block { .. }) && on_floor(c, d)) {
        let m = memo.get(c, d);
        if !m.shown {
            continue;
        }
        let mut out = Out::default();
        let mut sink = Sink::new(Target::Vec(&mut out), Keep::All);
        if emit(c, d, Attrs::with(d, &m.ov, m.cat), &d.geom, m.greyed, c.a.scale, &mut sink, 0).is_err() {
            continue;
        }
        let mut o = super::stamp_place::Obstacles::default();
        for q in &out.prims {
            o.add_prim(q);
        }
        let hull = super::floor_finish::convex_hull(o.points());
        if hull.len() >= 3 {
            res.push(hull);
        }
    }
    res
}

/// Mittlere Grösse eines Stücks der 2D-Zeichnungen (Elemente) und Obergrenze.
const CHUNK_MEAN: u64 = 256;
const CHUNK_MAX: usize = 2048;

#[inline]
fn mix(h: u64, v: u64) -> u64 {
    let x = (h ^ v).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    x ^ (x >> 31)
}

/// SplitMix64-Endmischung: gleichmässig verteilt auch für fortlaufende Element-Stände.
#[inline]
fn spread(v: u64) -> u64 {
    let mut z = v.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Ein Stück der Zeichnungs-Domäne: Schlüssel und Puffer (`None`, wenn der Aufrufer es schon hat).
pub type ChunkOut = (u64, Option<Vec<u8>>);

/// Domäne „2D-Zeichnungen" in Stücken (`planDomains` mit Cache, `plan/cache.rs`): die gezeichneten
/// Elemente werden inhaltsbestimmt in Stücke geteilt (Grenze nach einem Element, dessen Stand es
/// will — eine Änderung verschiebt nur Grenzen in ihrer Nähe). Ein Stück ist ein eigener
/// Plan-Puffer mit Schlüssel aus `salt` und den Element-Ständen; Stücke, deren Schlüssel der
/// Aufrufer schon hat (`have`), kommen ohne Puffer zurück. Ein neues Stück übernimmt die Elemente
/// des vorigen Stücks, aus dem es hervorgeht (fertig geschrieben, in Läufen kopiert), nur
/// neue/geänderte Elemente werden erzeugt. Inhalt wie [`plan_drawings`] (ein Linienzug setzt sich
/// über eine Stückgrenze nicht fort — das gäbe es nur bei doppelten ids).
#[allow(clippy::too_many_arguments)]
pub fn plan_drawings_chunked(c: &Ctx, stamps: &[u64], cache: &mut super::cache::DrawCache, salt: u64, have: &std::collections::HashSet<u64>, bounds: &mut Bounds) -> Result<Vec<ChunkOut>, String> {
    use super::cache::Chunk;
    if stamps.len() != c.p.drawings2d.len() {
        return Err("Element-Stände der 2D-Zeichnungen fehlen".into());
    }
    let mut memo = Memo::default();
    // Gezeichnete Elemente: (Index, Stand, gedimmt/kompakt).
    let mut seq: Vec<(usize, u64, u8)> = Vec::new();
    for (i, (d, &stamp)) in c.p.drawings2d.iter().zip(stamps).enumerate() {
        if !on_floor(c, d) {
            continue;
        }
        let m = memo.get(c, d);
        if !m.shown {
            continue;
        }
        let keep = if c.a.compact && compact_eligible(d) { Keep::NoLines } else { Keep::All };
        seq.push((i, stamp, m.greyed as u8 | ((keep as u8) << 1)));
    }
    let mut old = std::mem::take(&mut cache.chunks);
    let mut new: HashMap<u64, Chunk> = HashMap::new();
    let mut out = Vec::new();
    let mut next_ref = 0;
    let mut start = 0;
    let mut h = salt;
    for k in 0..seq.len() {
        let (_, stamp, flags) = seq[k];
        h = mix(mix(h, stamp), flags as u64);
        let end = spread(stamp) % CHUNK_MEAN == 0 || k + 1 - start >= CHUNK_MAX || k + 1 == seq.len();
        if !end {
            continue;
        }
        let key = h >> 12;
        let part = &seq[start..=k];
        start = k + 1;
        h = salt;
        if new.contains_key(&key) {
            // Gleicher Inhalt zweimal (praktisch ausgeschlossen): das Stück ist schon da.
            let ch = &new[&key];
            bounds.merge(ch.bounds);
            out.push((key, if have.contains(&key) { None } else { Some(chunk_bytes(ch)) }));
            continue;
        }
        let mut ch = match old.remove(&key) {
            Some(ch) => ch,
            None => build_chunk(c, part, &cache.owner, &old, &new, &mut memo, &mut next_ref)?,
        };
        bounds.merge(ch.bounds);
        // Der Puffer reist einmal; danach entsteht er bei Bedarf aus den Elementen neu.
        let bytes = ch.bytes.take();
        out.push((key, if have.contains(&key) { None } else { Some(bytes.unwrap_or_else(|| chunk_bytes(&ch))) }));
        new.insert(key, ch);
    }
    // Zuordnung Element → Stück nachführen: Einträge verworfener Stücke weg, neue Stücke eintragen.
    for (key, ch) in &old {
        for p in &ch.kept.parts {
            if cache.owner.get(&p.tag) == Some(key) {
                cache.owner.remove(&p.tag);
            }
        }
    }
    for (key, ch) in new.iter_mut() {
        if ch.fresh {
            ch.fresh = false;
            for p in &ch.kept.parts {
                cache.owner.insert(p.tag, *key);
            }
        }
    }
    cache.chunks = new;
    Ok(out)
}

/// Puffer eines gemerkten Stücks (alle Elemente in einem Lauf kopiert).
fn chunk_bytes(ch: &super::cache::Chunk) -> Vec<u8> {
    let mut w = Writer::with_tables(ch.tables.clone(), true);
    let g = w.begin_group();
    w.copy_parts(&ch.kept, 0, ch.kept.parts.len());
    w.end_group(g);
    w.finish()
}

/// Ein neues Stück aus den Elementen `part`: unveränderte Elemente des vorigen Stücks, aus dem das
/// erste von ihnen stammt, werden in Läufen kopiert (mit dessen Tabellen), die übrigen erzeugt.
#[allow(clippy::too_many_arguments)]
fn build_chunk<'a>(
    c: &Ctx<'a>,
    part: &[(usize, u64, u8)],
    owner: &HashMap<u64, u64>,
    old: &HashMap<u64, super::cache::Chunk>,
    new: &HashMap<u64, super::cache::Chunk>,
    memo: &mut Memo<'a>,
    next_ref: &mut u32,
) -> Result<super::cache::Chunk, String> {
    let base_key = part.iter().find_map(|(_, s, _)| owner.get(s).copied());
    let base = base_key.and_then(|k| old.get(&k).or_else(|| new.get(&k)));
    let mut w = Writer::with_tables(base.map_or_else(Default::default, |b| b.tables.clone()), true);
    w.post = super::extras::post_for(c.p, c.a);
    let g = w.begin_group();
    w.begin_kept();
    if let Some(b) = base {
        w.reserve_like(&b.kept);
    }
    let mut run: Option<(usize, usize)> = None;
    let mut cursor = 0;
    let mut bounds = Bounds::new();
    for &(i, stamp, flags) in part {
        let found = base.filter(|_| owner.get(&stamp) == base_key.as_ref()).and_then(|b| b.kept.find(stamp, flags, cursor));
        cursor = found.unwrap_or(cursor) + 1;
        if let (Some(j), Some(b)) = (found, base) {
            match run.as_mut() {
                Some(r) if r.1 == j => r.1 += 1,
                _ => {
                    if let Some((x, y)) = run.take() {
                        w.copy_parts(&b.kept, x, y);
                    }
                    run = Some((j, j + 1));
                }
            }
            bounds.merge(b.kept.parts[j].bounds);
            continue;
        }
        if let (Some((x, y)), Some(b)) = (run.take(), base) {
            w.copy_parts(&b.kept, x, y);
        }
        let d = &c.p.drawings2d[i];
        let m = memo.get(c, d);
        let keep = if flags & 2 != 0 { Keep::NoLines } else { Keep::All };
        w.part_begin();
        let mut sink = Sink::new(Target::Buf(&mut w), keep);
        sink.next_ref = *next_ref;
        emit(c, d, Attrs::with(d, &m.ov, m.cat), &d.geom, flags & 1 != 0, c.a.scale, &mut sink, 0)?;
        *next_ref = sink.next_ref;
        let mut b = Bounds::new();
        acc_bounds(&d.geom, &mut b);
        bounds.merge(b.raw());
        w.part_end(stamp, flags, b.raw());
    }
    if let (Some((x, y)), Some(b)) = (run.take(), base) {
        w.copy_parts(&b.kept, x, y);
    }
    let kept = w.end_kept();
    w.end_group(g);
    let (bytes, tables) = w.finish_keep();
    Ok(super::cache::Chunk { tables, kept, bounds: bounds.raw(), bytes: Some(bytes), fresh: true })
}

/// Gruppen der kompakten Unterlage: je (gedimmt, Ebene) in Reihenfolge des ersten Auftretens die
/// Indizes (in `project.drawings2d`) der Zeichnungen, deren Linien bei Bedarf entstehen. Format:
/// `[nGruppen, (gedimmt 0/1, n, Index…)…]`.
pub fn underlay_groups(c: &Ctx) -> Vec<f64> {
    let mut keys: HashMap<(bool, &str), usize> = HashMap::new();
    let mut groups: Vec<(bool, Vec<f64>)> = Vec::new();
    if c.a.compact {
        let mut memo = Memo::default();
        for (i, d) in c.p.drawings2d.iter().enumerate() {
            if !on_floor(c, d) || !compact_eligible(d) {
                continue;
            }
            let m = memo.get(c, d);
            if !m.shown {
                continue;
            }
            let g = m.greyed;
            let k = *keys.entry((g, d.category_code.as_str())).or_insert_with(|| {
                groups.push((g, Vec::new()));
                groups.len() - 1
            });
            groups[k].1.push(i as f64);
        }
    }
    let mut out = vec![groups.len() as f64];
    for (g, idx) in groups {
        out.push(if g { 1.0 } else { 0.0 });
        out.push(idx.len() as f64);
        out.extend(idx);
    }
    out
}

/// Nur die Linien der Zeichnungen `indices` (kompakte Unterlage, mit Override-Regeln).
pub fn underlay_lines(c: &Ctx, indices: &[f64], greyed: bool, sink: &mut Sink) -> Result<(), String> {
    sink.keep = Keep::OnlyLines;
    let mut memo = Memo::default();
    for &i in indices {
        let Some(d) = crate::plan::buf::whole(i).and_then(|i| c.p.drawings2d.get(i)) else { continue };
        let m = memo.get(c, d);
        emit(c, d, Attrs::with(d, &m.ov, m.cat), &d.geom, greyed, c.a.scale, sink, 0)?;
    }
    Ok(())
}

/// Automatische Höhenkoten im Schnitt/in der Ansicht (`levelMarkers.ts`): je Geschoss OK fertig
/// Boden plus die oberste Kante, links neben der Zeichnung mit kurzer Bezugslinie.
pub fn level_markers(p: &Project, b: [f64; 4]) -> Vec<Primitive> {
    const INK: &str = "#1f242c";
    const MARK_OFFSET_M: f64 = 1.2;
    const LEADER_GAP_M: f64 = 0.15;
    let [min_x, min_y, max_x, max_y] = b;
    if !(max_x > min_x) || !(max_y > min_y) {
        return Vec::new();
    }
    let x = min_x - MARK_OFFSET_M;
    let mut heights: Vec<f64> = Vec::new();
    let mut push_h = |z: f64| {
        if z < min_y - 1e-6 || z > max_y + 1e-6 {
            return;
        }
        if heights.iter().any(|h| (h - z).abs() < 0.05) {
            return;
        }
        heights.push(z);
    };
    for l in &p.drawing_levels {
        if l.kind == DrawingLevelKind::Floor {
            if let Some(z) = l.base_elevation {
                push_h(z);
            }
        }
    }
    push_h(max_y);
    let mut out = Out::default();
    let mut sink = Sink::new(Target::Vec(&mut out), Keep::All);
    for z in heights {
        sink.line(
            LineRef { a: v(x - 0.3, z), b: v(min_x - LEADER_GAP_M, z), cls: "section-level-leader", weight_mm: 0.13, dash: None, zigzag: None, motif: None, color: Some(INK), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None },
            0,
        );
        let value = jsnum::round(z * 100.0) / 100.0;
        let mut label = kote_label(value);
        // ±0.00 = Bezugsgeschoss ([131]): mit bekannter Meereshöhe „±0.00 = 512.40" (m ü. M.).
        if let Some(masl) = p.reference_elevation_masl.filter(|m| m.is_finite() && value.abs() < 1e-6) {
            label = format!("{label} = {}", to_fixed(masl, 2));
        }
        push_kote_labeled(&mut sink, v(x, z), label, KoteKind::OkFertig, INK, 0.18, false, None, 1.0);
    }
    out.prims
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::domains::PlanArgs;

    pub(crate) fn args(scale: f64) -> PlanArgs {
        PlanArgs::parse(1.0, &format!(r#"{{"floor":"eg","show":["20"],"scale":{scale}}}"#)).unwrap()
    }

    fn project(extra: serde_json::Value) -> Project {
        let mut base = serde_json::json!({
            "id": "t", "name": "T", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
            "drawingLevels": [], "layers": [{"code": "20", "name": "Zeichnung", "color": "#0a0a0a", "lw": 0.5, "visible": true, "locked": false}],
            "walls": [], "openings": [], "ceilings": [], "stairs": [], "rooms": [], "drawings2d": [], "context": []
        });
        if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                b.insert(k.clone(), v.clone());
            }
        }
        serde_json::from_value(base).unwrap()
    }

    fn render(p: &Project, d: serde_json::Value, scale: f64) -> Vec<Primitive> {
        let d: Drawing2D = serde_json::from_value(d).unwrap();
        let a = args(scale);
        let c = Ctx::new(p, &a);
        let mut out = Out::default();
        emit(&c, &d, Attrs::of(&c, &d), &d.geom, false, scale, &mut Sink::new(Target::Vec(&mut out), Keep::All), 0).unwrap();
        out.prims
    }

    fn drawing(geom: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "id": "d1", "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "geom": geom })
    }

    /// [93] Auf der Blatt-Ebene (Papier 1:1) haben Kote, Detailverweis und Punktmarke dasselbe
    /// Papiermass wie im Grundriss bei 1:100 (Faktor 1/100), im Grundriss bleiben sie unverändert.
    #[test]
    fn symbole_auf_dem_blatt_in_papiergroesse() {
        let levels = serde_json::json!({"drawingLevels": [
            {"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false},
            {"id": "sh", "name": "Blatt", "kind": "drawing", "visible": true, "locked": false, "layoutId": "L"}
        ]});
        let p = project(levels);
        let on = |level: &str, geom: serde_json::Value| -> Vec<Primitive> {
            let mut d = drawing(geom);
            d["levelId"] = serde_json::json!(level);
            // Grundriss 1:100, Blatt Papier 1:1.
            render(&p, d, if level == "sh" { 1.0 } else { 100.0 })
        };
        let extent = |prims: &[Primitive]| -> f64 {
            let mut b = Bounds::new();
            for pr in prims {
                match pr {
                    Primitive::Polygon { pts, .. } => pts.iter().for_each(|q| b.acc(q.x, q.y)),
                    Primitive::Line { a, b: q, .. } => {
                        b.acc(a.x, a.y);
                        b.acc(q.x, q.y);
                    }
                    Primitive::DrawingCircle { center, r, .. } => {
                        b.acc(center.x - r, center.y - r);
                        b.acc(center.x + r, center.y + r);
                    }
                    _ => {}
                }
            }
            let r = b.get().unwrap();
            (r[2] - r[0]).max(r[3] - r[1])
        };
        for geom in [
            serde_json::json!({"shape": "kote", "at": {"x": 0.1, "y": -0.1}, "value": 3.25, "kind": "okFertig", "rotation": 0}),
            serde_json::json!({"shape": "detailref", "at": {"x": 0.1, "y": -0.1}, "label": "A"}),
            serde_json::json!({"shape": "pointmarker", "at": {"x": 0.1, "y": -0.1}}),
        ] {
            let (model, sheet) = (extent(&on("eg", geom.clone())), extent(&on("sh", geom.clone())));
            assert!((sheet - model * SHEET_SYMBOL_FACTOR).abs() < 1e-9, "{geom}: {model} → {sheet}");
            // [37] Im Grundriss 1:50 halb so gross wie bei 1:100 (Papiergrösse).
            let mut d = drawing(geom.clone());
            d["levelId"] = serde_json::json!("eg");
            let half = extent(&render(&p, d, 50.0));
            assert!((half - model * 0.5).abs() < 1e-9, "{geom}: {model} → {half}");
        }
    }

    /// [112] Achsraster: strichpunktierte Achsen, Blasen (Kreis + Beschriftung) an beiden Enden,
    /// Ringe als Bögen, Blasengrösse folgt dem Massstab; auf anderen Geschossen sichtbar (`levels` leer).
    #[test]
    fn achsraster_achsen_und_blasen() {
        let p = project(serde_json::json!({}));
        let grid = |radial: bool| {
            drawing(serde_json::json!({"shape": "grid", "origin": {"x": 0, "y": 0}, "angle": 0, "radial": radial,
                "a": [{"label": "1", "pos": 0}, {"label": "2", "pos": if radial { 90.0 } else { 5.0 }}], "b": [{"label": "A", "pos": 0}, {"label": "B", "pos": 4}], "extend": 1}))
        };
        let prims = render(&p, grid(false), 100.0);
        let lines = prims.iter().filter(|q| matches!(q, Primitive::Line { dash: Some(Some(_)), .. })).count();
        let circles: Vec<f64> = prims.iter().filter_map(|q| if let Primitive::DrawingCircle { r, .. } = q { Some(*r) } else { None }).collect();
        let texts: Vec<String> = prims.iter().filter_map(|q| if let Primitive::DrawingText { text, .. } = q { Some(text.clone()) } else { None }).collect();
        assert_eq!(lines, 4);
        assert_eq!(circles.len(), 8);
        // [140] 5 mm Durchmesser bei 1:100 = 0.5 m → Radius 0.25.
        assert!(circles.iter().all(|r| (r - 0.25).abs() < 1e-9), "{circles:?}");
        assert_eq!(texts.len(), 8);
        assert!(["1", "2", "A", "B"].iter().all(|t| texts.iter().any(|x| x == t)));
        // Halber Massstab → halbe Blase.
        let half: Vec<f64> = render(&p, grid(false), 50.0).iter().filter_map(|q| if let Primitive::DrawingCircle { r, .. } = q { Some(*r) } else { None }).collect();
        assert!((half[0] - 0.125).abs() < 1e-9);
        // Radial: 2 Strahlen (Linien) und 2 Ringe (Bögen, Ring A mit Radius 0 entfällt als Vollkreis-Punkt).
        let prims = render(&p, grid(true), 100.0);
        assert_eq!(prims.iter().filter(|q| matches!(q, Primitive::Line { .. })).count(), 2);
        assert!(prims.iter().any(|q| matches!(q, Primitive::DrawingArc { r, .. } if (*r - 4.0).abs() < 1e-9)));
    }

    /// [140] Achsen im Grundriss enden am Gebäude: innerhalb der Gebäudegrundfläche keine Achslinie,
    /// ausserhalb (bis zu den Blasen) strichpunktiert.
    #[test]
    fn achsraster_unterbrochen_im_gebaeude() {
        let p = project(serde_json::json!({"extrudedSolids": [{"id": "s", "type": "extrudedSolid", "levelId": "eg", "height": 3,
            "points": [{"x": -1, "y": 1}, {"x": 6, "y": 1}, {"x": 6, "y": 3}, {"x": -1, "y": 3}]}]}));
        let grid = drawing(serde_json::json!({"shape": "grid", "origin": {"x": 0, "y": 0}, "angle": 0,
            "a": [{"label": "1", "pos": 0}, {"label": "2", "pos": 5}], "b": [{"label": "A", "pos": 0}, {"label": "B", "pos": 4}], "extend": 1}));
        let prims = render(&p, grid, 100.0);
        let segs: Vec<(Vec2, Vec2)> = prims.iter().filter_map(|q| match q { Primitive::Line { a, b, dash: Some(Some(_)), .. } => Some((*a, *b)), _ => None }).collect();
        // Achsen 1, 2 (senkrecht) je zwei Stücke, A, B (waagrecht, ausserhalb) je eins.
        assert_eq!(segs.len(), 6, "{segs:?}");
        for (a, b) in &segs {
            let m = v((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
            assert!(!(m.x > -1.0 && m.x < 6.0 && m.y > 1.0 && m.y < 3.0), "Achse im Gebäude: {a:?} {b:?}");
        }
        assert_eq!(prims.iter().filter(|q| matches!(q, Primitive::DrawingCircle { .. })).count(), 8, "Blasen bleiben");
    }

    /// [157] Blasen gehören vor das Gebäude: endet eine Achse im Gebäude (Anbau über die Rasterlinie), rückt
    /// die Blase entlang der Achse nach aussen, alle Blasen derselben Seite gleich weit (eine Reihe), die Achse
    /// läuft ausserhalb bis zur Blase; Blasen, die schon frei liegen, bleiben auf der Reihe.
    #[test]
    fn achsblasen_ausserhalb_des_gebaeudes() {
        // Anbau 1.5..3.5 × 3..6.5: das obere Ende von Achse 2 (x = 2.5, extend 1 → y = 5) liegt darin.
        let p = project(serde_json::json!({"extrudedSolids": [{"id": "s", "type": "extrudedSolid", "levelId": "eg", "height": 3,
            "points": [{"x": 1.5, "y": 3}, {"x": 3.5, "y": 3}, {"x": 3.5, "y": 6.5}, {"x": 1.5, "y": 6.5}]}]}));
        let grid = drawing(serde_json::json!({"shape": "grid", "origin": {"x": 0, "y": 0}, "angle": 0,
            "a": [{"label": "1", "pos": 0}, {"label": "2", "pos": 2.5}, {"label": "3", "pos": 5}], "b": [{"label": "A", "pos": 0}, {"label": "B", "pos": 4}], "extend": 1}));
        let prims = render(&p, grid, 100.0);
        let circles: Vec<(Vec2, f64)> = prims.iter().filter_map(|q| if let Primitive::DrawingCircle { center, r, .. } = q { Some((*center, *r)) } else { None }).collect();
        assert_eq!(circles.len(), 10);
        let inside = |q: Vec2, r: f64| q.x + r > 1.5 && q.x - r < 3.5 && q.y + r > 3.0 && q.y - r < 6.5;
        for (c, r) in &circles {
            assert!(!inside(*c, *r), "Blase im Gebäude: {c:?}");
        }
        // Obere Reihe (Achsen 1–3) auf einer Höhe über dem Anbau.
        let top: Vec<f64> = circles.iter().filter(|(c, _)| c.y > 4.5).map(|(c, _)| c.y).collect();
        assert_eq!(top.len(), 3, "{circles:?}");
        assert!(top.iter().all(|y| (y - top[0]).abs() < 1e-9 && *y > 6.5), "{top:?}");
        // Untere Reihe unverändert (y = -1 − r).
        assert!(circles.iter().filter(|(c, _)| c.y < 0.0).all(|(c, r)| (c.y - (-1.0 - r)).abs() < 1e-9));
        // Achse 2 läuft oberhalb des Anbaus bis an die Blase.
        let segs: Vec<(Vec2, Vec2)> = prims.iter().filter_map(|q| match q { Primitive::Line { a, b, dash: Some(Some(_)), .. } => Some((*a, *b)), _ => None }).collect();
        let r = circles[0].1;
        assert!(segs.iter().any(|(a, b)| (a.x - 2.5).abs() < 1e-9 && (a.y.max(b.y) - (top[0] - r)).abs() < 1e-6 && a.y.min(b.y) >= 6.5 - 1e-9), "{segs:?}");
    }

    /// [157] Blasen stehen nicht auf einer Masskette des Geschosses (EG: die Aussenbemassung rückt vor die
    /// Baugrube und lag dann unter den Blasen A/B/C): die Reihe rückt hinter die Kette.
    #[test]
    fn achsblasen_nicht_auf_der_bemassung() {
        let grid = serde_json::json!({"shape": "grid", "origin": {"x": 0, "y": 0}, "angle": 0,
            "a": [{"label": "1", "pos": 0}, {"label": "2", "pos": 5}], "b": [{"label": "A", "pos": 0}, {"label": "B", "pos": 4}], "extend": 1});
        let free = render(&project(serde_json::json!({})), drawing(grid.clone()), 100.0);
        let (c0, r) = free.iter().find_map(|q| if let Primitive::DrawingCircle { center, r, .. } = q { (center.y < 0.0).then_some((*center, *r)) } else { None }).unwrap();
        // Masskette waagrecht genau durch die untere Blasenreihe.
        let y = c0.y;
        let dim = serde_json::json!({"id": "m", "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "dimension", "pts": [{"x": -2.0, "y": y}, {"x": 7.0, "y": y}], "offset": 0.0}});
        let p = project(serde_json::json!({"drawings2d": [dim]}));
        let prims = render(&p, drawing(grid), 100.0);
        let low: Vec<Vec2> = prims.iter().filter_map(|q| if let Primitive::DrawingCircle { center, .. } = q { (center.y < 0.0).then_some(*center) } else { None }).collect();
        assert_eq!(low.len(), 2);
        assert!(low.iter().all(|c| (c.y - y).abs() > r && c.y < y), "{low:?} Kette bei {y}");
        assert!(low.iter().all(|c| (c.y - low[0].y).abs() < 1e-9), "eine Reihe: {low:?}");
    }

    /// [157] Massstabsbalken im kleinen Massstab: die Zahlen (3 mm Papier) stehen nicht ineinander — liegen
    /// die Teilstriche enger als eine Beschriftung, wird nur jede k-te beschriftet (immer 0 und das Ende mit „m“).
    #[test]
    fn massstabsbalken_zahlen_ueberlappen_nicht() {
        let p = project(serde_json::json!({}));
        let bar = drawing(serde_json::json!({"shape": "scalebar", "at": {"x": 0, "y": 0}, "segmentLength": 1, "segments": 5}));
        let labels = |scale: f64| -> Vec<(f64, String, f64)> {
            render(&p, bar.clone(), scale).iter().filter_map(|q| if let Primitive::DrawingText { at, text, height_m, .. } = q { Some((at.x, text.clone(), *height_m)) } else { None }).collect()
        };
        // 1:100: 1 m = 10 mm Papier, alle sechs Zahlen.
        assert_eq!(labels(100.0).iter().map(|l| l.1.as_str()).collect::<Vec<_>>(), ["0", "1", "2", "3", "4", "5m"]);
        // 1:500: 1 m = 2 mm Papier — jede zweite Zahl, die 4 entfällt neben „5m“; nichts überlappt.
        let l = labels(500.0);
        assert_eq!(l.iter().map(|l| l.1.as_str()).collect::<Vec<_>>(), ["0", "2", "5m"], "{l:?}");
        for w in l.windows(2) {
            let width = crate::text_layout::text_width_em(&w[0].1, false) * w[0].2;
            assert!(w[1].0 - w[0].0 > width, "{l:?}");
        }
        // 1:200: 1 m = 5 mm Papier — 0 vorne, „5m“ am Ende, nichts überlappt.
        let l = labels(200.0);
        assert!(l.first().is_some_and(|x| x.1 == "0") && l.last().is_some_and(|x| x.1 == "5m"), "{l:?}");
        for w in l.windows(2) {
            let width = crate::text_layout::text_width_em(&w[0].1, false) * w[0].2;
            assert!(w[1].0 - w[0].0 > width, "{l:?}");
        }
    }

    /// [112] Raster erscheint in jedem Geschoss, bei `levels` nur in den genannten.
    #[test]
    fn achsraster_je_geschoss() {
        let g = |levels: Option<Vec<&str>>| {
            let mut d: Drawing2D = serde_json::from_value(drawing(serde_json::json!({"shape": "grid", "origin": {"x": 0, "y": 0}, "angle": 0, "a": [], "b": []}))).unwrap();
            if let Drawing2DGeom::Grid { levels: l, .. } = &mut d.geom {
                *l = levels.map(|v| v.into_iter().map(String::from).collect());
            }
            d
        };
        let p = project(serde_json::json!({}));
        let a = args(100.0);
        let c = Ctx::new(&p, &a);
        let mut d = g(None);
        d.level_id = "og".into();
        assert!(on_floor(&c, &d), "ohne levels: in allen Geschossen (Plan zeigt eg)");
        assert!(!on_floor(&c, &g(Some(vec!["og"]))));
        assert!(on_floor(&c, &g(Some(vec!["og", "eg"]))));
    }

    /// [38] Radius-, Durchmesser- und Bogenlängen-Mass: Linien, Masszahl mit R / Ø / L.
    #[test]
    fn rund_bemassung_zeichnet_zahl() {
        let p = project(serde_json::json!({}));
        let dim = |kind: &str, pts: serde_json::Value| drawing(serde_json::json!({"shape": "dimension", "pts": pts, "offset": 0.5, "kind": kind}));
        let texts = |prims: &[Primitive]| -> Vec<String> { prims.iter().filter_map(|q| if let Primitive::DrawingText { text, .. } = q { Some(text.clone()) } else { None }).collect() };
        let r = render(&p, dim("radius", serde_json::json!([{"x": 0, "y": 0}, {"x": 3, "y": 0}])), 100.0);
        assert_eq!(texts(&r), ["R 3.00"]);
        let r = render(&p, dim("diameter", serde_json::json!([{"x": 0, "y": 0}, {"x": 3, "y": 0}])), 100.0);
        assert_eq!(texts(&r), ["\u{d8} 6.00"]);
        let r = render(&p, dim("arc", serde_json::json!([{"x": 0, "y": 0}, {"x": 2, "y": 0}, {"x": 0, "y": 2}])), 100.0);
        assert_eq!(texts(&r), ["L 3.14"]);
        assert!(r.iter().any(|q| matches!(q, Primitive::DrawingArc { r, .. } if (*r - 2.5).abs() < 1e-9)));
    }

    #[test]
    fn rechteck_flaeche_und_vier_linien_in_ebenenfarbe() {
        let p = project(serde_json::json!({}));
        let out = render(&p, drawing(serde_json::json!({"shape": "rect", "min": {"x": 0, "y": 0}, "max": {"x": 2, "y": 1}})), 100.0);
        assert_eq!(out.len(), 5);
        let s = serde_json::to_string(&out[1]).unwrap();
        assert!(s.contains("\"color\":\"#0a0a0a\"") && s.contains("\"weightMm\":0.5") && s.contains("\"dash\":null"), "{s}");
        assert!(matches!(out[0], Primitive::Polygon { .. }));
    }

    #[test]
    fn block_mit_selbstbezug_endet() {
        let p = project(serde_json::json!({ "blockDefs": [{ "id": "b", "name": "B", "geom2d": [
            { "shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 1, "y": 0} },
            { "shape": "block", "blockDefId": "b", "at": {"x": 0, "y": 0}, "rotation": 0 } ] }] }));
        let out = render(&p, drawing(serde_json::json!({"shape": "block", "blockDefId": "b", "at": {"x": 0, "y": 0}, "rotation": 0})), 100.0);
        assert_eq!(out.len(), MAX_BLOCK_DEPTH as usize);
    }

    /// [37] Text in Papiergrösse: 2.5 mm auf dem Blatt in jedem Massstab; ohne `paperHeight` gilt `height`.
    #[test]
    fn text_in_papiergroesse() {
        let p = project(serde_json::json!({}));
        let h = |geom: serde_json::Value, scale: f64| match render(&p, drawing(geom), scale).into_iter().next() {
            Some(Primitive::DrawingText { height_m, .. }) => height_m,
            o => panic!("{o:?}"),
        };
        let paper = serde_json::json!({"shape": "text", "at": {"x": 0, "y": 0}, "text": "A", "height": 0.3, "angle": 0, "paperHeight": 2.5});
        assert!((h(paper.clone(), 100.0) - 0.25).abs() < 1e-12);
        assert!((h(paper, 50.0) - 0.125).abs() < 1e-12);
        let model = serde_json::json!({"shape": "text", "at": {"x": 0, "y": 0}, "text": "A", "height": 0.3, "angle": 0});
        assert!((h(model, 50.0) - 0.3).abs() < 1e-12);
    }

    #[test]
    fn bemassung_masszahl_und_striche() {
        let p = project(serde_json::json!({}));
        let out = render(&p, drawing(serde_json::json!({"shape": "dimension", "pts": [{"x": 0, "y": 0}, {"x": 3.25, "y": 0}], "offset": 0.5})), 50.0);
        assert_eq!(out.len(), 6);
        match &out[5] {
            Primitive::DrawingText { text, height_m, .. } => {
                assert_eq!(text, "3.25");
                assert!((height_m - 0.125).abs() < 1e-12);
            }
            o => panic!("{o:?}"),
        }
    }

    /// [172] Masszahlen einer waagrechten Kette: (Text, Mitte der Zahl; y = Grundlinie) in Emissionsreihenfolge.
    fn dim_texts(out: &[Primitive]) -> Vec<(String, Vec2)> {
        out.iter()
            .filter_map(|pr| match pr {
                Primitive::DrawingText { text, at, height_m, .. } => Some((text.clone(), v(at.x + super::dim_text_width(text.parse().unwrap(), *height_m) / 2.0, at.y))),
                _ => None,
            })
            .collect()
    }

    /// [172] Vorgabe: jede Zahl mittig über ihrem Segment, im festen Abstand (0.6 Schrifthöhe) über der Linie.
    #[test]
    fn masszahl_mittig_je_segment() {
        let p = project(serde_json::json!({}));
        let out = render(&p, drawing(serde_json::json!({"shape": "dimension", "pts": [{"x": 0, "y": 0}, {"x": 3, "y": 0}, {"x": 7, "y": 0}], "offset": 1.0})), 100.0);
        let t = dim_texts(&out);
        assert_eq!(t.len(), 2);
        let h = 0.25;
        assert!((t[0].1.x - 1.5).abs() < 1e-9 && (t[1].1.x - 5.0).abs() < 1e-9, "{t:?}");
        // Ketten-Offset 1 m nach links der Richtung (+y), Zahl 0.6 h darüber.
        assert!((t[0].1.y - (1.0 + 0.6 * h)).abs() < 1e-9, "{t:?}");
    }

    /// [172] Zu schmales Segment: Zahl nach aussen; erstes links, letztes rechts, mittleres zum längeren Nachbarn.
    #[test]
    fn masszahl_weicht_bei_platzmangel_aus() {
        let p = project(serde_json::json!({}));
        let pts = |xs: &[f64]| serde_json::Value::Array(xs.iter().map(|x| serde_json::json!({"x": x, "y": 0})).collect());
        // Erstes (0.3 m) und letztes (0.3 m) Segment sind zu schmal.
        let out = render(&p, drawing(serde_json::json!({"shape": "dimension", "pts": pts(&[0.0, 0.3, 4.3, 4.6]), "offset": 1.0})), 100.0);
        let t = dim_texts(&out);
        assert_eq!(t.len(), 3);
        assert!(t[0].1.x < 0.0, "erstes Segment links hinaus: {t:?}");
        assert!((t[1].1.x - 2.3).abs() < 1e-9, "langes Segment mittig: {t:?}");
        assert!(t[2].1.x > 4.6, "letztes Segment rechts hinaus: {t:?}");
        // Mittleres schmales Segment (zwischen 0.3 und 5 m): wandert zum längeren Nachbarn, ohne dessen Zahl zu berühren.
        let out = render(&p, drawing(serde_json::json!({"shape": "dimension", "pts": pts(&[0.0, 2.0, 2.3, 7.3]), "offset": 1.0})), 100.0);
        let t = dim_texts(&out);
        let w = |s: &str| super::dim_text_width(s.parse().unwrap(), 0.25);
        assert!(t[1].1.x > 2.3, "nach rechts zum längeren Nachbarn: {t:?}");
        assert!(t[1].1.x - w("0.30") / 2.0 >= 2.3 - 1e-9 || t[1].1.x < 2.3, "{t:?}");
        let (mid_r, nb_l) = (t[1].1.x + w("0.30") / 2.0, t[2].1.x - w("5.00") / 2.0);
        assert!(mid_r <= nb_l + 1e-9, "überdeckt Nachbarzahl: {t:?}");
    }

    /// [172] Radius-, Durchmesser- und Bogenlängenmass: Masszahl mittig über ihrem Ankerpunkt (nicht mit dem Anfang daran hängend).
    #[test]
    fn rundmass_masszahl_mittig() {
        let p = project(serde_json::json!({}));
        let mid_of = |geom: serde_json::Value| -> (String, Vec2) {
            let out = render(&p, drawing(geom), 100.0);
            out.iter()
                .find_map(|pr| match pr {
                    Primitive::DrawingText { text, at, height_m, angle, .. } => {
                        let w = crate::text_layout::text_width_em(text, false) * height_m;
                        Some((text.clone(), v(at.x + angle.cos() * w / 2.0, at.y + angle.sin() * w / 2.0)))
                    }
                    _ => None,
                })
                .expect("Text")
        };
        let h = 0.25;
        let (t, m) = mid_of(serde_json::json!({"shape": "dimension", "kind": "radius", "pts": [{"x": 0, "y": 0}, {"x": 2, "y": 0}], "offset": 0.0}));
        assert_eq!(t, "R 2.00");
        assert!((m.x - 1.0).abs() < 1e-9 && (m.y - 0.6 * h).abs() < 1e-9, "{m:?}");
        let (t, m) = mid_of(serde_json::json!({"shape": "dimension", "kind": "diameter", "pts": [{"x": 0, "y": 0}, {"x": 2, "y": 0}], "offset": 0.0}));
        assert_eq!(t, "\u{d8} 4.00");
        assert!((m.x - 0.0).abs() < 1e-9, "{m:?}");
        let (t, m) = mid_of(serde_json::json!({"shape": "dimension", "kind": "arc", "pts": [{"x": 0, "y": 0}, {"x": 2, "y": 0}, {"x": 0, "y": 2}], "offset": 0.5}));
        assert!(t.starts_with("L "));
        // Anker (Bogenmitte) liegt auf der Diagonale; die Zahl steht quer dazu zentriert: Mitte ⟂ Verbindung zum Mittelpunkt.
        assert!((m.x - m.y).abs() < 0.2 * h + 1e-9, "{m:?}");
    }

    /// [172] Rundmass: gespeicherter Masszahl-Versatz (Papier-mm) verschiebt die Zahl in Leserichtung und quer.
    #[test]
    fn rundmass_masszahl_versatz() {
        let p = project(serde_json::json!({}));
        let at = |offs: serde_json::Value| -> Vec2 {
            let g = serde_json::json!({"shape": "dimension", "kind": "radius", "pts": [{"x": 0, "y": 0}, {"x": 2, "y": 0}], "offset": 0.0, "textOffsetsMm": offs});
            render(&p, drawing(g), 100.0).iter().find_map(|pr| if let Primitive::DrawingText { at, .. } = pr { Some(*at) } else { None }).expect("Text")
        };
        let (a, b) = (at(serde_json::json!([])), at(serde_json::json!([{"along": 3.0, "perp": 2.0}])));
        assert!((b.x - a.x - 0.3).abs() < 1e-9 && (b.y - a.y - 0.2).abs() < 1e-9, "{a:?} {b:?}");
    }

    /// [172] Gespeicherte Abweichung (frei verschobener Text alter Projekte) bleibt, wo sie ist; (0,0) = Vorgabe.
    #[test]
    fn masszahl_gespeicherte_abweichung_bleibt() {
        let p = project(serde_json::json!({}));
        let g = |offs: serde_json::Value| serde_json::json!({"shape": "dimension", "pts": [{"x": 0, "y": 0}, {"x": 0.3, "y": 0}], "offset": 0.0, "textOffsetsMm": offs});
        let moved = dim_texts(&render(&p, drawing(g(serde_json::json!([{"along": 2.0, "perp": 3.0}]))), 100.0));
        // 2 mm / 3 mm Papier bei 1:100 = 0.2 m / 0.3 m, ab der Mitte (0.15, 0.15).
        assert!((moved[0].1.x - 0.35).abs() < 1e-9 && (moved[0].1.y - (0.15 + 0.3)).abs() < 1e-9, "{moved:?}");
        let auto = dim_texts(&render(&p, drawing(g(serde_json::json!([{"along": 0, "perp": 0}]))), 100.0));
        assert!(auto[0].1.x < 0.0, "Vorgabe weicht aus: {auto:?}");
    }

    /// [T2] Bogenmass: Viertelkreis r 2 → Masszahl π (Bogenlänge), Masslinie auf r 2.5, radiale Hilfslinien.
    #[test]
    fn bogenmass_masszahl_ist_bogenlaenge() {
        let p = project(serde_json::json!({}));
        let out = render(&p, drawing(serde_json::json!({"shape": "dimension", "pts": [{"x": 2, "y": 0}, {"x": 0, "y": 2}], "offset": 0.5, "arcCenter": {"x": 0, "y": 0}})), 50.0);
        let texts: Vec<&str> = out.iter().filter_map(|pr| if let Primitive::DrawingText { text, .. } = pr { Some(text.as_str()) } else { None }).collect();
        assert_eq!(texts, vec!["3.14"]);
        let ends: Vec<(Vec2, Vec2)> = out.iter().filter_map(|pr| if let Primitive::Line { a, b, .. } = pr { Some((*a, *b)) } else { None }).collect();
        assert!(ends.len() > 40, "Bogen in Stücken: {}", ends.len());
        // Masslinie: Punkte im Radius 2.5 (ohne Hilfslinien und Striche).
        let on = ends.iter().filter(|(a, b)| ((a.x.hypot(a.y) - 2.5).abs() < 1e-9) && ((b.x.hypot(b.y) - 2.5).abs() < 1e-9)).count();
        assert_eq!(on, 45);
    }

    #[test]
    fn kote_label() {
        assert_eq!(super::kote_label(0.0), "±0.00");
        assert_eq!(super::kote_label(3.25), "+3.25");
        assert_eq!(super::kote_label(-0.1), "-0.10");
    }

    #[test]
    fn hoehenkoten_je_geschoss() {
        let p = project(serde_json::json!({ "drawingLevels": [
            {"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3, "cutHeight": 1, "baseElevation": 0},
            {"id": "og", "name": "OG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3, "cutHeight": 1, "baseElevation": 3}] }));
        let out = level_markers(&p, [0.0, 0.0, 10.0, 6.0]);
        // je Höhe (0, 3, 6): Bezugslinie, Dreieck, Zahl
        assert_eq!(out.len(), 9);
        assert!(level_markers(&p, [0.0, 0.0, 0.0, 6.0]).is_empty());
    }

    /// [131] Untergeschoss unter ±0.00: negative Kote; mit `referenceElevationMasl` trägt ±0.00 die Meereshöhe.
    #[test]
    fn hoehenkoten_untergeschoss_und_meereshoehe() {
        let p = project(serde_json::json!({ "referenceElevationMasl": 512.4, "drawingLevels": [
            {"id": "ug", "name": "UG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 2.8, "baseElevation": -2.8},
            {"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3, "baseElevation": 0, "zeroLevel": true}] }));
        let texts: Vec<String> = level_markers(&p, [0.0, -3.0, 10.0, 3.0])
            .into_iter()
            .filter_map(|q| if let Primitive::DrawingText { text, .. } = q { Some(text) } else { None })
            .collect();
        assert_eq!(texts, vec!["-2.80".to_string(), "±0.00 = 512.40".into(), "+3.00".into()]);
    }

    /// [77] Polylinie mit Insel: die Fläche (Füllung/Schraffur) spart das Loch aus, sein Umriss wird gezeichnet.
    #[test]
    fn insel_wird_ausgespart() {
        let p = project(serde_json::json!({}));
        let mut d = drawing(serde_json::json!({"shape": "polyline", "closed": true,
            "pts": [{"x": 0, "y": 0}, {"x": 4, "y": 0}, {"x": 4, "y": 4}, {"x": 0, "y": 4}],
            "holes": [[{"x": 1, "y": 1}, {"x": 1, "y": 2}, {"x": 2, "y": 2}, {"x": 2, "y": 1}]]}));
        d["fillColor"] = "#ff0000".into();
        let out = render(&p, d.clone(), 100.0);
        let Primitive::Polygon { pts, .. } = &out[0] else { panic!("{:?}", out[0]) };
        let k: Vec<kernel2d::Vec2> = pts.iter().map(|q| kernel2d::Vec2::new(q.x, q.y)).collect();
        assert!(!kernel2d::rb_point_in_polygon(kernel2d::Vec2::new(1.5, 1.5), &k), "{pts:?}");
        assert!(kernel2d::rb_point_in_polygon(kernel2d::Vec2::new(3.0, 3.0), &k));
        assert_eq!(out.len(), 1 + 4 + 4);
        assert!(!compact_eligible(&serde_json::from_value(d).unwrap()));
    }

    #[test]
    fn kompakt_nur_ohne_enden_und_boegen() {
        let mk = |g: serde_json::Value| -> Drawing2D { serde_json::from_value(drawing(g)).unwrap() };
        assert!(compact_eligible(&mk(serde_json::json!({"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 1, "y": 0}}))));
        assert!(!compact_eligible(&mk(serde_json::json!({"shape": "polyline", "pts": [], "closed": false, "bulge": [0.5]}))));
        assert!(compact_eligible(&mk(serde_json::json!({"shape": "polyline", "pts": [], "closed": false, "bulge": [0]}))));
        assert!(!compact_eligible(&mk(serde_json::json!({"shape": "circle", "center": {"x": 0, "y": 0}, "r": 1}))));
    }

    /// Messung (von Hand): `PLAN_BIG=projekt.obp cargo test --release --lib messung_zeichnungen -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn messung_zeichnungen() {
        let Ok(path) = std::env::var("PLAN_BIG") else { return };
        let mut doc = crate::document::Document::from_json(&std::fs::read_to_string(path).unwrap()).unwrap();
        let p = doc.project().unwrap().clone();
        let codes: Vec<String> = p.flat_categories().iter().map(|c| c.code.clone()).chain(p.drawings2d.iter().map(|d| d.category_code.clone())).collect();
        for compact in [false, true] {
            let t = serde_json::json!({ "floor": "eg", "show": codes, "grey": [], "global": true, "compact": compact }).to_string();
            let a = PlanArgs::parse(1.0, &t).unwrap();
            let c = Ctx::new(&p, &a);
            // Liste (Tests) und direkt in den Puffer (Abfrage `planDomains`).
            let list = || {
                let mut out = Out::default();
                plan_drawings(&c, &mut Sink::new(Target::Vec(&mut out), Keep::All), &mut Bounds::new()).unwrap();
                out
            };
            let buf = || {
                let mut w = crate::plan::buf::Writer::new(true);
                let s = w.begin_group();
                plan_drawings(&c, &mut Sink::new(Target::Buf(&mut w), Keep::All), &mut Bounds::new()).unwrap();
                w.end_group(s);
                w.finish()
            };
            let n = list().prims.len();
            let time = |f: &dyn Fn()| {
                f();
                let t0 = std::time::Instant::now();
                for _ in 0..10 {
                    f();
                }
                t0.elapsed().as_secs_f64() * 100.0
            };
            let tl = time(&|| drop(list()));
            let tb = time(&|| drop(buf()));
            println!("kompakt {compact}: {n} Primitive, als Liste {tl:.1} ms, direkt in den Puffer {tb:.1} ms");
        }
    }
}
