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
use crate::plan_buf::{LineRef, Writer};
use std::borrow::Cow;
use std::collections::HashMap;

/// Standard-Massstab (1:100), wenn ein Aufrufer keinen mitgibt.
pub const DEFAULT_SCALE_DENOMINATOR: f64 = 100.0;

// Bemassung (SIA 400 B.5.3): Defaults in Papier-mm (`model/dimension.ts`).
const DIM_GAP_MM: f64 = 1.0;
const DIM_OVERSHOOT_MM: f64 = 1.0;
const DIM_TICK_LEN_MM: f64 = 3.0;
const DIM_TEXT_HEIGHT_MM: f64 = 4.0;

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

// Massstabsbalken, Papier-mm.
const SCALEBAR_HEIGHT_MM: f64 = 1.5;
const SCALEBAR_TICK_MM: f64 = 1.0;
const SCALEBAR_TEXT_MM: f64 = 3.0;

// Konstruktionslinie / Strahl.
const XLINE_EXTEND_M: f64 = 1000.0;
const XLINE_WEIGHT_MM: f64 = 0.13;
const XLINE_DASH: [f64; 4] = [0.3, 0.1, 0.03, 0.1];

/// Default-Grösse der Linienenden (Papier-mm).
const END_MARK_DEFAULT_SIZE_MM: f64 = 3.0;

/// Verschachtelungstiefe von Blöcken (ein Block, der sich selbst enthält, endet hier).
const MAX_BLOCK_DEPTH: u32 = 32;

/// Strichmuster-Kennungen für den Linienzug im Plan-Puffer (TS: dieselbe Array-Referenz):
/// das Muster eines Linienstils (ohne LTSCALE) ist je Stil eine Referenz, ein gestrecktes
/// Muster je Element-Aufruf eine neue, das Konstruktionslinien-Muster eine Konstante.
const DASH_REF_STYLE: u32 = 1_000_000;
const DASH_REF_XLINE: u32 = 999_999;

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
        let e = MemoEntry { key, shown: c.shown(key.0), greyed: c.greyed(key.0), cat: c.cat(key.0), ov: c.overrides(key.0, Some(key.1)) };
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
        Drawing2DGeom::Polyline { bulge, .. } => !marks && bulge.as_ref().is_none_or(|b| b.iter().all(|v| *v == 0.0 || v.is_nan())),
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
fn kote_label(value: f64) -> String {
    if value.abs() < 1e-6 {
        return "±0.00".into();
    }
    format!("{}{}", if value > 0.0 { "+" } else { "" }, to_fixed(value, 2))
}

/// Höhenkote (SIA 400 B.5.4): OK = Spitze nach unten, UK = Spitze nach oben; fertig = Kontur,
/// roh = gefüllt. `at` ist die Spitze. Geteilt vom 2D-Element `kote` und den automatischen Koten
/// im Schnitt/in der Ansicht ([`level_markers`]).
#[allow(clippy::too_many_arguments)]
fn push_kote(sink: &mut Sink, at: Vec2, value: f64, kind: KoteKind, color: &str, weight: f64, greyed: bool, id: Option<&str>) {
    let up = if matches!(kind, KoteKind::OkFertig | KoteKind::OkRoh) { 1.0 } else { -1.0 };
    let filled = matches!(kind, KoteKind::OkRoh | KoteKind::UkRoh);
    let pts = vec![at, v(at.x - KOTE_TRI_HALF_W_M, at.y + up * KOTE_TRI_SIZE_M), v(at.x + KOTE_TRI_HALF_W_M, at.y + up * KOTE_TRI_SIZE_M)];
    sink.push(polygon(pts, if filled { color } else { "none" }, color, weight, no_hatch(), greyed, id), 0);
    sink.push(text(v(at.x + KOTE_TRI_HALF_W_M + KOTE_TEXT_GAP_M, at.y + up * KOTE_TRI_SIZE_M * 0.5), kote_label(value), KOTE_TEXT_HEIGHT_M, 0.0, color, greyed, id), 0);
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
        let f = crate::plan_misc::end_mark(at.x, at.y, dir.x, dir.y, code, size, self.scale);
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
    let weight = resolve_stroke_weight(attrs.weight, d.stroke_weight_source, category, ls.map(|l| l.weight).or(category.map(|k| k.lw)).unwrap_or(WALL_FALLBACK_MM));
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
        Drawing2DGeom::Polyline { pts, closed, bulge } => {
            let n = pts.len();
            let bl = bulge.as_deref();
            let closed_ring = *closed && n > 2;
            if closed_ring {
                let ring = bulge_polyline_points(pts, bl, true);
                fill_poly(&mut em, ring)?;
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
        Drawing2DGeom::Dimension { pts, offset, gap_mm, overshoot_mm, tick_len_mm, text_height_mm, line_weight_mm, ext_weight_mm, tick_weight_mm, text_offsets_mm } => {
            let mm = |x: f64| mm_to_model(x, scale);
            for i in 0..pts.len().saturating_sub(1) {
                let st = DimStyle {
                    gap: mm(gap_mm.unwrap_or(DIM_GAP_MM)),
                    overshoot: mm(overshoot_mm.unwrap_or(DIM_OVERSHOOT_MM)),
                    tick_len: mm(tick_len_mm.unwrap_or(DIM_TICK_LEN_MM)),
                    text_height: mm(text_height_mm.unwrap_or(DIM_TEXT_HEIGHT_MM)),
                    line_weight: line_weight_mm.unwrap_or(em.weight),
                    ext_weight: ext_weight_mm.unwrap_or(em.weight),
                    tick_weight: tick_weight_mm.unwrap_or(em.weight * 2.0),
                    text_offset: match text_offsets_mm.as_ref().and_then(|l| l.get(i)) {
                        Some(o) => (mm(o.along), mm(o.perp)),
                        None => (0.0, 0.0),
                    },
                };
                dimension_segment(&mut em, pts[i], pts[i + 1], *offset, &st);
            }
        }
        Drawing2DGeom::Kote { at, value, kind, .. } => {
            push_kote(em.sink, *at, *value, *kind, em.color, em.weight, em.greyed, Some(em.id));
        }
        Drawing2DGeom::Detailref { at, label, sheet_layout_id, sheet_label } => {
            em.circle(*at, DETAILREF_RADIUS_M, "none", Some(None));
            em.seg(v(at.x - DETAILREF_RADIUS_M, at.y), v(at.x + DETAILREF_RADIUS_M, at.y));
            let sheet_name = sheet_layout_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.layouts.as_deref().unwrap_or(&[]).iter().find(|l| l.id == id)).map(|l| l.name.as_str());
            let lower = sheet_name.or(sheet_label.as_deref()).unwrap_or("");
            let text_x = at.x - DETAILREF_RADIUS_M * 0.62;
            em.text(v(text_x, at.y + DETAILREF_RADIUS_M * 0.32), label.clone(), DETAILREF_TEXT_HEIGHT_M);
            if !lower.is_empty() {
                em.text(v(text_x, at.y - DETAILREF_RADIUS_M * 0.68), lower.to_string(), DETAILREF_TEXT_HEIGHT_M);
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
            while i <= *segments {
                let x = at.x + i * segment_length;
                em.seg(v(x, at.y), v(x, at.y - tick_len));
                let dist = i * segment_length;
                let dist_text = if dist.is_finite() && dist.trunc() == dist { js_number(dist) } else { to_fixed(dist, 2) };
                let label = if i == *segments { format!("{dist_text}m") } else { dist_text };
                em.text(v(x + text_h * 0.25, at.y - tick_len - text_h * 1.2), label, text_h);
                i += 1.0;
            }
        }
        Drawing2DGeom::Pointmarker { at } => {
            em.circle(*at, POINTMARKER_RADIUS_M, "none", Some(None));
            em.seg(v(at.x - POINTMARKER_CROSS_M, at.y), v(at.x + POINTMARKER_CROSS_M, at.y));
            em.seg(v(at.x, at.y - POINTMARKER_CROSS_M), v(at.x, at.y + POINTMARKER_CROSS_M));
        }
        Drawing2DGeom::Text { at, text: s, height, angle, width, marks, doc, leader_target, leader_bend_points, path_pts } => {
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
    let p = text(at, to_fixed(line_len, 2), st.text_height, angle, em.color, em.greyed, Some(em.id));
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
        G::Polyline { pts, closed, bulge } => {
            let pts = map(pts);
            let bulge = bulge.as_ref().map(|b| if reverses_orientation(f) { b.iter().map(|x| -x).collect() } else { b.clone() });
            G::Polyline { pts, closed: *closed, bulge }
        }
        G::Rect { min, max } => {
            let c = [*min, v(max.x, min.y), *max, v(min.x, max.y)].map(f);
            let aligned = (c[0].y - c[1].y).abs() < 1e-6 && (c[1].x - c[2].x).abs() < 1e-6 && (c[2].y - c[3].y).abs() < 1e-6;
            if aligned {
                let fold = |k: fn(f64, f64) -> f64, s: fn(&Vec2) -> f64| c.iter().map(s).reduce(k).unwrap_or(f64::NAN);
                G::Rect { min: v(fold(jsnum::min, |q| q.x), fold(jsnum::min, |q| q.y)), max: v(fold(jsnum::max, |q| q.x), fold(jsnum::max, |q| q.y)) }
            } else {
                G::Polyline { pts: c.to_vec(), closed: true, bulge: None }
            }
        }
        G::Circle { center, r } => G::Circle { center: f(*center), r: *r },
        G::Arc { center, r, a0, a1 } => G::Arc { center: f(*center), r: *r, a0: *a0, a1: *a1 },
        G::Ellipse { center, rx, ry, rotation } => G::Ellipse { center: f(*center), rx: *rx, ry: *ry, rotation: *rotation },
        G::Bezier { pts } => G::Bezier { pts: map(pts) },
        G::Spline { pts, closed, mode } => G::Spline { pts: map(pts), closed: *closed, mode: *mode },
        G::Dimension { pts, .. } => {
            let mut out = g.clone();
            if let G::Dimension { pts: p2, .. } = &mut out {
                *p2 = map(pts);
            }
            out
        }
        G::Kote { at, value, kind, rotation } => G::Kote { at: f(*at), value: *value, kind: *kind, rotation: *rotation },
        G::Detailref { at, label, sheet_layout_id, sheet_label } => G::Detailref { at: f(*at), label: label.clone(), sheet_layout_id: sheet_layout_id.clone(), sheet_label: sheet_label.clone() },
        G::Scalebar { at, segment_length, segments } => G::Scalebar { at: f(*at), segment_length: *segment_length, segments: *segments },
        G::Pointmarker { at } => G::Pointmarker { at: f(*at) },
        G::Text { at, text, height, angle, width, marks, doc, leader_target, leader_bend_points, path_pts } => G::Text {
            at: f(*at),
            text: text.clone(),
            height: *height,
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
        G::Scalebar { at, segment_length, segments } => {
            acc(at);
            acc(&v(at.x + segment_length * segments, at.y));
        }
        G::Xline { .. } | G::Ray { .. } | G::Block { .. } => {}
    }
}

/// Liegt die Zeichnung auf dem Geschoss (und ist sie im Druck nicht ausgenommen, `noPrint`)?
fn on_floor(c: &Ctx, d: &Drawing2D) -> bool {
    d.level_id == c.a.floor && !(c.a.for_print && d.no_print == Some(true))
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
        let Some(d) = crate::plan_buf::whole(i).and_then(|i| c.p.drawings2d.get(i)) else { continue };
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
        push_kote(&mut sink, v(x, z), jsnum::round(z * 100.0) / 100.0, KoteKind::OkFertig, INK, 0.18, false, None);
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

    #[test]
    fn bemassung_masszahl_und_striche() {
        let p = project(serde_json::json!({}));
        let out = render(&p, drawing(serde_json::json!({"shape": "dimension", "pts": [{"x": 0, "y": 0}, {"x": 3.25, "y": 0}], "offset": 0.5})), 50.0);
        assert_eq!(out.len(), 6);
        match &out[5] {
            Primitive::DrawingText { text, height_m, .. } => {
                assert_eq!(text, "3.25");
                assert!((height_m - 0.2).abs() < 1e-12);
            }
            o => panic!("{o:?}"),
        }
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
                let mut w = crate::plan_buf::Writer::new(true);
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
