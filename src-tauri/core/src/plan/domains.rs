//! Plan-Domänen auf dem Dokument ([K3d]): Decken, Dächer, Räume (mit Raumstempel-Daten), Wände mit
//! Öffnungen (`walls.rs`), Treppen (`stairs.rs`), Kontext und Schnittlinien (`context.rs`), Stützen und Extrusions-Umrisse als fertige [`Primitive`] — Rust-Gegenstück zu `generatePlan/{ceilings,roofs,
//! rooms,structures}.ts` samt Filter, Override-Regeln und Stil-Auflösung aus `generatePlan.ts`.
//! Die JSON-Ausgabe gleicht Feld für Feld der früheren TS-Ausgabe.
//!
//! Sichtbarkeit/Darstellungsmodus kommen als Code-Mengen vom Aufrufer (`show`: sichtbar und
//! gezeichnet, `grey`: gedimmt), weil der Resolver in TS (UI-Zustand) lebt.

use super::overrides::{self, js_trim, Actions, Subject};
use super::prim::{HatchRender, Primitive, StampLine};
use super::style::*;
use crate::js_fmt::{js_number, to_fixed};
use crate::jsnum::{max, min, round};
use crate::model::*;
use crate::plan_walls::{ceiling_outline_lines, wall_footprint, WallFootprint};
use std::collections::{HashMap, HashSet};

/// Footprint-Farbe der Extrusionen (wie das 3D-Orange).
const EXTRUSION_STROKE: &str = "#d98c40";
/// Rückfall-Füllung einer Stütze ohne auflösbares Bauteil.
const COLUMN_FALLBACK_FILL: &str = "#3a3f47";
/// Alpha-Suffix der (unsichtbaren) Raumfüllung.
const ROOM_FILL_ALPHA: &str = "00";
/// Basis-Schriftgrösse des Raumstempels (pt).
const ROOM_STAMP_PT: f64 = 10.0;
const NAME_PT: f64 = 12.0;
const NUMBER_PT: f64 = 9.0;
const LINE2_PT: f64 = 9.0;

/// Eingabe einer Plan-Abfrage.
pub struct PlanArgs {
    pub floor: String,
    pub detail: Detail,
    pub show: HashSet<String>,
    pub grey: HashSet<String>,
    /// Wand-Achslinien zeichnen (Oberleiste).
    pub reference_lines: bool,
    /// Projektglobale Zutaten (Kontext, Schnittlinien) — nur der aktive Aufruf einer Überlagerung.
    pub global: bool,
    /// Papier-Massstab 1:N (Bemassung, Linienenden, Massstabsbalken in Papier-mm).
    pub scale: f64,
    /// Export: Zeichnungen mit `noPrint` entfallen.
    pub for_print: bool,
    /// Kompakte Linien-Unterlage: Linien der einfachen Zeichnungen entstehen bei Bedarf (`drawings.rs`).
    pub compact: bool,
}

impl PlanArgs {
    /// `detail`: 0 grob, 1 mittel, 2 fein; `text`: `{"floor": id, "show": [code…], "grey": [code…],
    /// "referenceLines": bool, "global": bool, "scale": N, "forPrint": bool, "compact": bool}`.
    pub fn parse(detail: f64, text: &str) -> Result<PlanArgs, String> {
        let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Plan-Argumente: {e}"))?;
        let set = |k: &str| -> HashSet<String> { v.get(k).and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default() };
        Ok(PlanArgs {
            floor: v.get("floor").and_then(|f| f.as_str()).unwrap_or_default().to_string(),
            detail: match detail as i64 {
                0 => Detail::Grob,
                2 => Detail::Fein,
                _ => Detail::Mittel,
            },
            show: set("show"),
            grey: set("grey"),
            reference_lines: v.get("referenceLines").and_then(|b| b.as_bool()).unwrap_or(false),
            global: v.get("global").and_then(|b| b.as_bool()).unwrap_or(false),
            scale: v.get("scale").and_then(|b| b.as_f64()).unwrap_or(super::drawings::DEFAULT_SCALE_DENOMINATOR),
            for_print: v.get("forPrint").and_then(|b| b.as_bool()).unwrap_or(false),
            compact: v.get("compact").and_then(|b| b.as_bool()).unwrap_or(false),
        })
    }
}

/// Gemeinsamer Zustand einer Plan-Erzeugung.
pub struct Ctx<'a> {
    pub p: &'a Project,
    pub a: &'a PlanArgs,
    /// Code → Kategorie (bei doppeltem Code gewinnt die letzte, wie `Map.set` in TS).
    cats: HashMap<&'a str, &'a LayerCategory>,
}

impl<'a> Ctx<'a> {
    pub fn new(p: &'a Project, a: &'a PlanArgs) -> Self {
        let mut cats = HashMap::new();
        for c in p.flat_categories() {
            cats.insert(c.code.as_str(), c);
        }
        Ctx { p, a, cats }
    }

    pub fn shown(&self, code: &str) -> bool {
        self.a.show.contains(code)
    }

    pub fn greyed(&self, code: &str) -> bool {
        self.a.grey.contains(code)
    }

    pub fn cat(&self, code: &str) -> Option<&'a LayerCategory> {
        self.cats.get(code).copied()
    }

    /// Effektive Override-Aktionen eines Elements (`overrideFor` in TS).
    pub fn overrides(&self, code: &str, object_name: Option<&str>) -> Actions {
        overrides::effective(self.p.override_rules.as_deref(), &Subject { layer_name: self.cat(code).map(|c| c.name.as_str()), layer_code: Some(code), object_name })
    }
}

/// Ergebnis der Plan-Erzeugung: Primitive je Domäne (TS setzt sie an ihre Stelle in der
/// Zeichenreihenfolge) und das Ausmass der Decken, Räume und Dach-Traufen. Über die Grenze geht es
/// als Plan-Puffer v2 ([`plan_domains_buf`]).
#[derive(Default)]
pub struct DomainPrims {
    pub ceilings: Vec<Primitive>,
    /// Wände (Poché, Referenzlinie) mit ihren Öffnungs-Symbolen, je Wand nacheinander.
    pub walls: Vec<Primitive>,
    /// Treppen-Symbole (`stairs.rs`).
    pub stairs: Vec<Primitive>,
    /// Kontext-Konturen und Schnittführungs-Symbole (`context.rs`), nur mit `global`.
    pub context: Vec<Primitive>,
    pub sections: Vec<Primitive>,
    pub roofs: Vec<Primitive>,
    pub rooms: Vec<Primitive>,
    pub columns: Vec<Primitive>,
    /// 2D-Zeichnungen (`drawings.rs`) samt Strichmuster-Kennungen für den Linienzug im Puffer.
    pub drawings: super::drawings::Out,
    pub solids: Vec<Primitive>,
    /// `[minX, minY, maxX, maxY]`; fehlt ohne Punkte.
    pub bounds: Option<[f64; 4]>,
}

pub struct Bounds([f64; 4]);

impl Bounds {
    pub fn new() -> Self {
        Bounds([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY])
    }
    pub fn acc(&mut self, x: f64, y: f64) {
        let b = &mut self.0;
        b[0] = min(b[0], x);
        b[1] = min(b[1], y);
        b[2] = max(b[2], x);
        b[3] = max(b[3], y);
    }
    fn get(&self) -> Option<[f64; 4]> {
        self.0[0].is_finite().then_some(self.0)
    }
    /// Rohwerte (auch ohne Punkte), s. [`Bounds::merge`].
    pub fn raw(&self) -> [f64; 4] {
        self.0
    }
    /// Ein anderes Ausmass einrechnen — gleich wie seine Punkte einzeln (JS-`min`/`max` sind
    /// vertauschbar und assoziativ, auch mit NaN und ±0).
    pub fn merge(&mut self, r: [f64; 4]) {
        let b = &mut self.0;
        b[0] = min(b[0], r[0]);
        b[1] = min(b[1], r[1]);
        b[2] = max(b[2], r[2]);
        b[3] = max(b[3], r[3]);
    }
}

/// Pick-Bezug eines Polygons.
enum Pick<'a> {
    Ceiling(&'a str),
    Roof(&'a str),
    Room(&'a str),
    Column(&'a str),
    Solid(&'a str),
}

#[allow(clippy::too_many_arguments)]
fn polygon(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, hatch: HatchRender, greyed: Option<bool>, no_stroke_edges: Option<Vec<f64>>, pick: Pick) -> Primitive {
    let (mut ceiling_id, mut roof_id, mut room_id, mut column_id, mut extruded_solid_id) = (None, None, None, None, None);
    match pick {
        Pick::Ceiling(s) => ceiling_id = Some(s.to_string()),
        Pick::Roof(s) => roof_id = Some(s.to_string()),
        Pick::Room(s) => room_id = Some(s.to_string()),
        Pick::Column(s) => column_id = Some(s.to_string()),
        Pick::Solid(s) => extruded_solid_id = Some(s.to_string()),
    }
    Primitive::Polygon {
        pts,
        fill: fill.into(),
        stroke: stroke.into(),
        stroke_width_mm: w,
        hatch,
        greyed,
        opacity: None,
        no_stroke_edges,
        wall_id: None,
        drawing_id: None,
        ceiling_id,
        opening_id: None,
        stair_id: None,
        room_id,
        extruded_solid_id,
        context_object_id: None,
        column_id,
        roof_id,
        section_line_id: None,
    }
}

fn line(a: Vec2, b: Vec2, cls: &str, w: f64, dash: super::prim::Dash, color: &str, greyed: Option<bool>) -> Primitive {
    Primitive::Line { a, b, cls: cls.into(), weight_mm: w, dash, zigzag: None, motif: None, color: Some(color.into()), drawing_id: None, opening_id: None, stair_id: None, greyed, opacity: None }
}

fn pv(p: [f64; 2]) -> Vec2 {
    Vec2 { x: p[0], y: p[1] }
}

/// `getComponent` (wirft in TS).
fn component<'a>(p: &'a Project, id: &str) -> Result<&'a Component, String> {
    p.component(id).ok_or_else(|| format!("Unbekanntes Bauteil-Material: {id}"))
}

/// `resolveHatch` mit der Fehlermeldung von TS (`getHatch`/`getLineStyle` werfen).
pub(super) fn resolve_hatch_or_err(p: &Project, hatch_id: &str, wall_angle_deg: Option<f64>, fg: Option<&str>) -> Result<HatchRender, String> {
    let h = p.hatch(hatch_id).ok_or_else(|| format!("Unbekannte Schraffur: {hatch_id}"))?;
    if let Some(ls) = h.line_style_id.as_deref().filter(|s| !s.is_empty()) {
        p.line_style(ls).ok_or_else(|| format!("Unbekannter Linienstil: {ls}"))?;
    }
    resolve_hatch(p, hatch_id, wall_angle_deg, fg, None).ok_or_else(|| format!("Unbekannte Schraffur: {hatch_id}"))
}

/// Footprints der gezeichneten Wände dieses Geschosses (`buildWallFootprints`).
pub fn wall_footprints(c: &Ctx) -> Vec<WallFootprint> {
    c.p.walls
        .iter()
        .filter(|w| w.floor_id == c.a.floor && c.shown(&w.category_code))
        .map(|w| {
            let t = c.p.wall_thickness(w, 0.2);
            let ref_off = crate::joins::reference_offset(crate::model3d::wall_reference(w), t);
            wall_footprint([w.start.x, w.start.y], [w.end.x, w.end.y], t, ref_off)
        })
        .collect()
}

// ── Decken ──────────────────────────────────────────────────────────────────

/// Schichten des Deckentyps (`getCeilingType`; wirft ohne Typ).
fn ceiling_layers<'a>(p: &'a Project, c: &Ceiling) -> Result<&'a [Layer], String> {
    if let Some(id) = c.ceiling_type_id.as_deref().filter(|s| !s.is_empty()) {
        if let Some(ct) = p.ceiling_types.as_deref().unwrap_or(&[]).iter().find(|t| t.id == id) {
            return Ok(&ct.layers);
        }
    }
    p.wall_types.iter().find(|t| t.id == c.wall_type_id).map(|t| t.layers.as_slice()).ok_or_else(|| format!("Unbekannter Deckentyp: {}", c.ceiling_type_id.as_deref().unwrap_or(&c.wall_type_id)))
}

/// Typname einer Decke für `object_name` (Maps in TS: letzter Eintrag je id gewinnt).
fn ceiling_type_name<'a>(p: &'a Project, c: &Ceiling) -> Option<&'a str> {
    let ct = c.ceiling_type_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.ceiling_types.as_deref().unwrap_or(&[]).iter().rev().find(|t| t.id == id));
    ct.map(|t| t.name.as_str()).or_else(|| p.wall_types.iter().rev().find(|t| t.id == c.wall_type_id).map(|t| t.name.as_str()))
}

fn ceilings(c: &Ctx, out: &mut Vec<Primitive>, bounds: &mut Bounds) -> Result<(), String> {
    let p = c.p;
    let list: Vec<&Ceiling> = p.ceilings.as_deref().unwrap_or(&[]).iter().filter(|x| x.floor_id == c.a.floor && c.shown(&x.category_code)).collect();
    if list.is_empty() {
        return Ok(());
    }
    let fps = wall_footprints(c);
    for ce in list {
        for q in &ce.outline {
            bounds.acc(q.x, q.y);
        }
        let ov = c.overrides(&ce.category_code, ceiling_type_name(p, ce));
        let color = ov.color.as_deref().or(ce.color.as_deref());
        let greyed = c.greyed(&ce.category_code);
        let category = c.cat(&ce.category_code);
        let lw = resolve_stroke_weight(ce.stroke_weight, ce.stroke_weight_source, category, category.map_or(LAYER_LINE_MM, |k| k.lw));
        if ce.outline.len() < 3 {
            continue;
        }
        let pts: Vec<[f64; 2]> = ce.outline.iter().map(|v| [v.x, v.y]).collect();
        let holes: Vec<Vec<[f64; 2]>> = ce.openings.as_deref().unwrap_or(&[]).iter().map(|h| h.iter().map(|v| [v.x, v.y]).collect()).collect();
        let merged = crate::polygon_holes::merge_holes(&pts, &holes, 1e-4);
        let layers = ceiling_layers(p, ce)?;
        let comp = match layers.first() {
            Some(l) => Some(component(p, &l.component_id)?),
            None => None,
        };
        let stroke = color.unwrap_or(POCHE_STROKE);
        let view_hatch_id = resolve_hatch_id(ce.hatch_id.as_deref(), ce.hatch_source, category, comp.and_then(|k| k.view_hatch_id.as_deref()));
        let hatch = match (c.a.detail != Detail::Grob, comp, view_hatch_id.filter(|s| !s.is_empty())) {
            (true, Some(k), Some(id)) => resolve_hatch_or_err(p, id, None, resolve_foreground(k, ce.foreground.as_deref(), category, ce.foreground_source))?,
            _ => no_hatch(),
        };
        let fill = match comp {
            Some(k) => resolve_background(k, ce.background.as_deref(), category, ce.background_source).unwrap_or(poche_fill(hatch.pattern)).to_string(),
            None => "none".to_string(),
        };
        let ring: Vec<Vec2> = merged.ring.iter().map(|q| pv(*q)).collect();
        let bridges = (!merged.bridge_edges.is_empty()).then(|| merged.bridge_edges.iter().map(|&k| k as f64).collect());
        out.push(polygon(ring, &fill, "none", 0.0, hatch, Some(greyed), bridges, Pick::Ceiling(&ce.id)));
        let w = lw * c.a.detail.layer_factor();
        for [a, b] in ceiling_outline_lines(&merged.ring, &merged.bridge_edges, &fps) {
            out.push(line(pv(a), pv(b), "ceiling-outline", w, Some(Some(OVERHEAD_DASH.to_vec())), stroke, Some(greyed)));
        }
    }
    Ok(())
}

// ── Dächer ──────────────────────────────────────────────────────────────────

fn roofs(c: &Ctx, out: &mut Vec<Primitive>, bounds: &mut Bounds) {
    let p = c.p;
    for roof in p.roofs.as_deref().unwrap_or(&[]).iter().filter(|r| r.floor_id == c.a.floor && c.shown(&r.category_code)) {
        let greyed = Some(c.greyed(&roof.category_code));
        let category = c.cat(&roof.category_code);
        let stroke = roof.color.as_deref().or(category.map(|k| k.color.as_str())).unwrap_or(POCHE_STROKE);
        let geo = crate::roof::roof_geometry(&roof.params(), 0.0);
        for q in &geo.eaves {
            bounds.acc(q[0], q[1]);
        }
        // Ansichts-Schraffur der äussersten Schicht (Eindeckung); Fehler → ohne.
        let layers = p.roof_layers(roof);
        let view_hatch = layers
            .first()
            .filter(|l| !l.component_id.is_empty())
            .and_then(|l| p.component(&l.component_id))
            .and_then(|k| k.view_hatch_id.as_deref().filter(|s| !s.is_empty()))
            .and_then(|id| resolve_hatch(p, id, None, None, None))
            .unwrap_or_else(no_hatch);
        let eaves: Vec<Vec2> = geo.eaves.iter().map(|q| pv(*q)).collect();
        if eaves.len() >= 3 {
            // Innenhöfe ([26]): als Loch in die Fläche eingebunden (Brücken-Kanten ohne Strich).
            let merged = crate::polygon_holes::merge_holes(&geo.eaves, &geo.eaves_holes, 1e-4);
            let ring: Vec<Vec2> = if geo.eaves_holes.is_empty() { eaves.clone() } else { merged.ring.iter().map(|q| pv(*q)).collect() };
            let bridges = (!merged.bridge_edges.is_empty()).then(|| merged.bridge_edges.iter().map(|&k| k as f64).collect());
            out.push(polygon(ring, "none", "none", 0.0, view_hatch, greyed, bridges, Pick::Roof(&roof.id)));
        }
        for ring in std::iter::once(&geo.eaves).chain(geo.eaves_holes.iter()) {
            let pts: Vec<Vec2> = ring.iter().map(|q| pv(*q)).collect();
            let n = pts.len();
            for i in 0..n {
                out.push(line(pts[i], pts[(i + 1) % n], "roof-eaves", ROOF_EAVES_MM, None, stroke, greyed));
            }
        }
        for l in &geo.ridges {
            out.push(line(pv(l[0]), pv(l[1]), "roof-ridge", ROOF_RIDGE_MM, None, stroke, greyed));
        }
        for l in &geo.hips {
            out.push(line(pv(l[0]), pv(l[1]), "roof-hip", ROOF_HIP_MM, None, stroke, greyed));
        }
        for l in &geo.breaks {
            out.push(line(pv(l[0]), pv(l[1]), "roof-break", ROOF_BREAK_MM, Some(Some(ROOF_BREAK_DASH.to_vec())), stroke, greyed));
        }
    }
}

// ── Räume ───────────────────────────────────────────────────────────────────

fn sia_key(s: SiaCategory) -> &'static str {
    match s {
        SiaCategory::HNF => "HNF",
        SiaCategory::NNF => "NNF",
        SiaCategory::VF => "VF",
        SiaCategory::FF => "FF",
        SiaCategory::KGF => "KGF",
        SiaCategory::AGF => "AGF",
        SiaCategory::Unknown => "undefined",
    }
}

fn sia_label(s: SiaCategory) -> &'static str {
    match s {
        SiaCategory::HNF => "Hauptnutzfläche",
        SiaCategory::NNF => "Nebennutzfläche",
        SiaCategory::VF => "Verkehrsfläche",
        SiaCategory::FF => "Funktionsfläche",
        SiaCategory::KGF => "Konstruktionsfläche",
        SiaCategory::AGF => "Aussengeschossfläche",
        SiaCategory::Unknown => "undefined",
    }
}

fn run(text: String, marks: Marks) -> TextRun {
    TextRun { text, marks, ..Default::default() }
}

/// `docFromText`: je Zeile ein Absatz (leere Zeile = ohne Run).
pub fn doc_from_text(text: &str) -> RichTextDoc {
    RichTextDoc {
        version: 1.0,
        paragraphs: text.split('\n').map(|l| Paragraph { runs: if l.is_empty() { vec![] } else { vec![run(l.into(), Marks::default())] }, ..Default::default() }).collect(),
        ..Default::default()
    }
}

/// `roomStampToDoc`: Zeile 1 = Nummer (klein) + Name (fett), Zeile 2 optional (kursiv).
pub fn room_stamp_to_doc(s: &RoomStamp) -> RichTextDoc {
    let mut line1 = Vec::new();
    let number = js_trim(s.number.as_deref().unwrap_or(""));
    if !number.is_empty() {
        line1.push(run(format!("{number} "), Marks { size_pt: Some(NUMBER_PT), ..Default::default() }));
    }
    line1.push(run(s.name.clone(), Marks { bold: Some(true), size_pt: Some(NAME_PT), ..Default::default() }));
    let mut paragraphs = vec![Paragraph { runs: line1, align: s.name_align, ..Default::default() }];
    let line2 = js_trim(s.name_line2.as_deref().unwrap_or(""));
    if !line2.is_empty() {
        paragraphs.push(Paragraph { runs: vec![run(line2.into(), Marks { italic: Some(true), size_pt: Some(LINE2_PT), ..Default::default() })], align: s.line2_align, ..Default::default() });
    }
    RichTextDoc { version: 1.0, paragraphs, ..Default::default() }
}

/// `formatStampArea`.
pub fn format_stamp_area(area: f64, step: Option<f64>) -> String {
    match step {
        Some(st) if st > 0.0 => {
            let rounded = round(area / st) * st;
            js_number(round(rounded * 100.0) / 100.0)
        }
        _ => to_fixed(area, 2),
    }
}

/// `roomStampExtraLines`.
pub fn room_stamp_extra_lines(s: &RoomStamp, net_area: f64, sia: SiaCategory) -> Vec<StampLine> {
    let mut lines = Vec::new();
    if s.show_floor_area {
        let prefix = s.floor_area_prefix.as_deref().unwrap_or("");
        lines.push(StampLine { text: format!("{prefix}{} m²", format_stamp_area(net_area, s.rounding_step)), align: s.floor_area_align.unwrap_or(Align::Center) });
    }
    if s.show_usage {
        lines.push(StampLine { text: format!("{} · {}", sia_key(sia), sia_label(sia)), align: s.usage_align.unwrap_or(Align::Center) });
    }
    if let Some(o) = s.occupancy {
        lines.push(StampLine { text: format!("{} Pers.", js_number(o)), align: Align::Center });
    }
    lines
}

/// Farbe mit Alpha-Suffix, nur bei 6-stelligem Hex (`/^#[0-9a-fA-F]{6}$/`).
fn with_alpha(color: &str, alpha: &str) -> String {
    let b = color.as_bytes();
    if b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit()) {
        format!("{color}{alpha}")
    } else {
        color.to_string()
    }
}

fn rooms(c: &Ctx, out: &mut Vec<Primitive>, bounds: &mut Bounds) {
    for room in c.p.rooms.as_deref().unwrap_or(&[]).iter().filter(|r| r.floor_id == c.a.floor && c.shown(&r.category_code)) {
        for q in &room.boundary {
            bounds.acc(q.x, q.y);
        }
        let ov = c.overrides(&room.category_code, Some(&room.name));
        let color = ov.color.as_deref().unwrap_or(&room.color);
        let greyed = Some(c.greyed(&room.category_code));
        if room.boundary.len() < 3 {
            continue;
        }
        let pts: Vec<[f64; 2]> = room.boundary.iter().map(|v| [v.x, v.y]).collect();
        let res = crate::room_area::evaluate(&pts, 0.0);
        out.push(polygon(room.boundary.clone(), &with_alpha(color, ROOM_FILL_ALPHA), color, LAYER_LINE_MM * c.a.detail.layer_factor(), no_hatch(), greyed, None, Pick::Room(&room.id)));
        if c.a.detail == Detail::Grob {
            continue;
        }
        let at = room.stamp_anchor.unwrap_or(pv(res.centroid));
        let (doc, extra_lines) = match &room.stamp {
            Some(s) => (room_stamp_to_doc(s), room_stamp_extra_lines(s, res.net, room.sia_category)),
            None => (
                room.stamp_doc.clone().unwrap_or_else(|| doc_from_text(&room.name)),
                vec![
                    StampLine { text: format!("{} m²", to_fixed(res.net, 2)), align: Align::Center },
                    StampLine { text: format!("{} · {}", sia_key(room.sia_category), sia_label(room.sia_category)), align: Align::Center },
                ],
            ),
        };
        out.push(Primitive::Text { at, doc, extra_lines, base_pt: ROOM_STAMP_PT, color: color.into(), room_id: Some(room.id.clone()), greyed, opacity: None });
    }
}

// ── Stützen ─────────────────────────────────────────────────────────────────

/// `columnLabel` (für `object_name`).
pub fn column_label(col: &Column) -> String {
    match &col.profile {
        ColumnProfile::Round { radius } => format!("Stütze Ø{}", to_fixed(radius * 200.0, 0)),
        ColumnProfile::Rect { width, depth } => format!("Stütze {}×{}", to_fixed(width * 100.0, 0), to_fixed(depth * 100.0, 0)),
    }
}

fn columns(c: &Ctx, out: &mut Vec<Primitive>) {
    let p = c.p;
    for col in p.columns.as_deref().unwrap_or(&[]).iter().filter(|k| k.floor_id == c.a.floor && c.shown(&k.category_code)) {
        let greyed = Some(c.greyed(&col.category_code));
        let category = c.cat(&col.category_code);
        let ov = c.overrides(&col.category_code, Some(&column_label(col)));
        let lw = ov.lineweight.unwrap_or_else(|| resolve_stroke_weight(col.stroke_weight, col.stroke_weight_source, category, category.map_or(WALL_FALLBACK_MM, |k| k.lw)));
        let color = ov.color.as_deref().or(col.color.as_deref());
        let cat_color = category.map(|k| k.color.as_str());
        let stroke = color.or(cat_color).unwrap_or(MONO_INK);
        let mut fill = color.or(cat_color).unwrap_or(COLUMN_FALLBACK_FILL).to_string();
        let mut hatch = no_hatch();
        if let Some(k) = col.component_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.component(id)) {
            let hatch_id = resolve_hatch_id(col.hatch_id.as_deref(), col.hatch_source, category, Some(&k.hatch_id)).unwrap_or(&k.hatch_id);
            if let Some(h) = resolve_hatch(p, hatch_id, None, resolve_foreground(k, col.foreground.as_deref(), category, col.foreground_source), None) {
                let bg = resolve_background(k, col.background.as_deref(), category, col.background_source);
                fill = bg.unwrap_or(if h.pattern == HatchPattern::Solid { HATCH_INK } else { HATCH_PAPER }).to_string();
                hatch = h;
            }
        }
        out.push(polygon(crate::model3d::column_footprint(col), &fill, stroke, lw, hatch, greyed, None, Pick::Column(&col.id)));
    }
}

// ── Extrusionen ─────────────────────────────────────────────────────────────

fn solids(c: &Ctx, out: &mut Vec<Primitive>) {
    for s in c.p.extruded_solids.as_deref().unwrap_or(&[]).iter().filter(|s| s.level_id == c.a.floor) {
        if s.operation.as_deref() == Some("subtract") {
            out.push(polygon(s.points.clone(), "none", "none", 0.0, no_hatch(), None, None, Pick::Solid(&s.id)));
            let n = s.points.len();
            let seg = |a: Vec2, b: Vec2, dash: Option<Vec<f64>>| line(a, b, "void", SYMBOL_HAIRLINE_MM, Some(dash), EXTRUSION_STROKE, None);
            for i in 0..n {
                out.push(seg(s.points[i], s.points[(i + 1) % n], Some(vec![2.0, 1.0])));
            }
            if n == 4 {
                out.push(seg(s.points[0], s.points[2], None));
                out.push(seg(s.points[1], s.points[3], None));
            }
        } else {
            out.push(polygon(s.points.clone(), "none", EXTRUSION_STROKE, SYMBOL_HAIRLINE_MM, no_hatch(), None, None, Pick::Solid(&s.id)));
        }
    }
}

/// Abfrage `planDomains`: Domänen als Listen (Tests); die 2D-Zeichnungen in `drawings`.
pub fn plan_domains(p: &Project, a: &PlanArgs) -> Result<DomainPrims, String> {
    let c = Ctx::new(p, a);
    let mut out = DomainPrims::default();
    let mut bounds = Bounds::new();
    domains_before(&c, &mut out, &mut bounds)?;
    let mut drawings = super::drawings::Out::default();
    super::drawings::plan_drawings(&c, &mut super::drawings::Sink::new(super::drawings::Target::Vec(&mut drawings), super::drawings::Keep::All), &mut bounds)?;
    out.drawings = drawings;
    domains_after(&c, &mut out);
    out.bounds = bounds.get();
    Ok(out)
}

/// Decken bis Extrusionen (alles vor den 2D-Zeichnungen gerechnet).
fn domains_before(c: &Ctx, out: &mut DomainPrims, bounds: &mut Bounds) -> Result<(), String> {
    ceilings(c, &mut out.ceilings, bounds)?;
    roofs(c, &mut out.roofs, bounds);
    rooms(c, &mut out.rooms, bounds);
    super::walls::plan_walls(c, c.a.reference_lines, &mut out.walls, bounds)?;
    super::stairs::plan_stairs(c, &mut out.stairs, bounds);
    columns(c, &mut out.columns);
    solids(c, &mut out.solids);
    Ok(())
}

/// Kontext und Schnittlinien (projektglobal, nur mit `global`).
fn domains_after(c: &Ctx, out: &mut DomainPrims) {
    if c.a.global {
        super::context::plan_context(c, &mut out.context);
        super::context::plan_section_lines(c, &mut out.sections);
    }
}

/// Reihenfolge der Gruppen im Plan-Puffer der Abfrage `planDomains`.
pub const GROUPS: [&str; 10] = ["ceilings", "roofs", "rooms", "walls", "stairs", "columns", "drawings", "solids", "context", "sections"];

/// Abfrage `planDomains` als Plan-Puffer v2 (s. `plan_buf.rs`): eine Gruppe je Domäne in der
/// Reihenfolge [`GROUPS`], Ausmass im Kopf, Inhalts-Hashes für den GPU-Chunk-Cache. Die
/// 2D-Zeichnungen schreiben direkt in den Puffer (keine Primitiv-Liste dazwischen).
pub fn plan_domains_buf(p: &Project, a: &PlanArgs) -> Result<Vec<u8>, String> {
    let c = Ctx::new(p, a);
    let mut d = DomainPrims::default();
    let mut bounds = Bounds::new();
    domains_before(&c, &mut d, &mut bounds)?;
    let mut w = crate::plan_buf::Writer::new(true);
    for g in [&d.ceilings, &d.roofs, &d.rooms, &d.walls, &d.stairs, &d.columns] {
        w.group(g);
    }
    let start = w.begin_group();
    super::drawings::plan_drawings(&c, &mut super::drawings::Sink::new(super::drawings::Target::Buf(&mut w), super::drawings::Keep::All), &mut bounds)?;
    w.end_group(start);
    domains_after(&c, &mut d);
    for g in [&d.solids, &d.context, &d.sections] {
        w.group(g);
    }
    w.bounds = bounds.get();
    Ok(w.finish())
}

/// Kennung der Antwort von `planDomains` mit Cache ("PLBm").
pub const MULTI_MAGIC: f64 = 1_347_175_021.0;

/// Ergebnis von [`plan_domains_cached`]: der Haupt-Puffer (Gruppen wie [`plan_domains_buf`], die
/// Gruppe der 2D-Zeichnungen leer, Ausmass über alles) und die Stücke der 2D-Zeichnungen in
/// Zeichenreihenfolge.
pub struct PlanOut {
    pub main: Vec<u8>,
    pub chunks: Vec<super::drawings::ChunkOut>,
}

impl PlanOut {
    /// Als Bytes: `[MULTI_MAGIC, nStücke, Länge Haupt-Puffer, (Schlüssel, Länge | −1) × nStücke]`
    /// (f64), dann der Haupt-Puffer und die mitgelieferten Stücke, je auf 8 Bytes aufgefüllt.
    /// Länge −1 = Stück fehlt (der Aufrufer hat es schon).
    pub fn encode(&self) -> Vec<u8> {
        let mut head = vec![MULTI_MAGIC, self.chunks.len() as f64, self.main.len() as f64];
        for (k, b) in &self.chunks {
            head.push(*k as f64);
            head.push(b.as_ref().map_or(-1.0, |b| b.len() as f64));
        }
        let pad = |n: usize| (8 - n % 8) % 8;
        let total = head.len() * 8 + self.main.len() + pad(self.main.len()) + self.chunks.iter().filter_map(|(_, b)| b.as_ref()).map(|b| b.len() + pad(b.len())).sum::<usize>();
        let mut out = Vec::with_capacity(total);
        for v in head {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for b in std::iter::once(&self.main).chain(self.chunks.iter().filter_map(|(_, b)| b.as_ref())) {
            out.extend_from_slice(b);
            out.resize(out.len() + pad(b.len()), 0);
        }
        out
    }
}

/// Wie [`plan_domains_buf`], mit den Caches des Dokuments (`plan/cache.rs`): die übrigen Domänen
/// als Ganzes, die 2D-Zeichnungen als Stücke ([`super::drawings::plan_drawings_chunked`]); Stücke
/// mit Schlüssel in `have` (hat der Aufrufer vom letzten Mal) kommen ohne Puffer. `revs` =
/// Änderungsstände des Dokuments (mit Element-Ständen der Zeichnungen, s. `Document::project_cached`).
/// Inhalt gleich [`plan_domains_buf`] (Haupt-Puffer mit den Stücken an Stelle der Gruppe 6).
pub fn plan_domains_cached(p: &Project, revs: &crate::document::Revs, cache: &mut super::cache::PlanCache, a: &PlanArgs, have: &HashSet<u64>) -> Result<PlanOut, String> {
    use super::cache::NOT_FOR_DRAWINGS;
    use crate::plan_buf::Writer;
    let c = Ctx::new(p, a);
    let cc = cache.context(a, revs.epoch());
    cc.trim();
    let draw_sig = revs.max_except(NOT_FOR_DRAWINGS);
    if cc.drawings.sig != draw_sig {
        cc.drawings = Default::default();
        cc.drawings.sig = draw_sig;
    }
    let fresh = cc.tables.units_len() == 0;
    let mut w = Writer::with_tables(std::mem::take(&mut cc.tables), true);
    let r = assemble_cached(&c, revs, cc, &mut w, have);
    let (main, tables) = w.finish_keep();
    cc.tables = tables;
    if fresh {
        cc.base_units = cc.tables.units_len();
    }
    match r {
        Ok(chunks) => Ok(PlanOut { main, chunks }),
        Err(e) => {
            // Gemerkte Teile könnten auf Tabellen-Einträge zeigen, die nicht mehr passen: neu beginnen.
            cc.reset();
            Err(e)
        }
    }
}

/// Gruppen in Puffer-Reihenfolge (die Zeichnungen als Stücke daneben), die übrigen Domänen aus dem
/// Cache bzw. neu (dann aufgenommen).
fn assemble_cached(c: &Ctx, revs: &crate::document::Revs, cc: &mut super::cache::CtxCache, w: &mut crate::plan_buf::Writer, have: &HashSet<u64>) -> Result<Vec<super::drawings::ChunkOut>, String> {
    use super::cache::{selection_sig, RestEntry, NOT_FOR_REST};
    let sig = (revs.max_except(NOT_FOR_REST), selection_sig(c.a));
    if cc.rest.as_ref().is_some_and(|r| r.sig != sig) {
        cc.rest = None;
    }
    let mut bounds = Bounds::new();
    let mut fresh: Option<(DomainPrims, Bounds)> = None;
    if cc.rest.is_none() {
        let mut d = DomainPrims::default();
        let mut b = Bounds::new();
        domains_before(c, &mut d, &mut b)?;
        domains_after(c, &mut d);
        fresh = Some((d, b));
    }
    let mut segs: Vec<crate::plan_buf::Segment> = Vec::new();
    let put = |w: &mut crate::plan_buf::Writer, k: usize, segs: &mut Vec<crate::plan_buf::Segment>| {
        let start = w.begin_group();
        match (&fresh, &cc.rest) {
            (Some((d, _)), _) => {
                let g = [&d.ceilings, &d.roofs, &d.rooms, &d.walls, &d.stairs, &d.columns, &d.solids, &d.context, &d.sections][k];
                w.mark();
                for x in g.iter() {
                    w.push(x);
                }
                segs.push(w.take_segment());
            }
            (None, Some(r)) => w.splice(&r.groups[k]),
            (None, None) => {}
        }
        w.end_group(start);
    };
    for k in 0..6 {
        put(w, k, &mut segs);
    }
    // Gruppe 6 bleibt im Haupt-Puffer leer; die Zeichnungen kommen als Stücke.
    let start = w.begin_group();
    w.end_group(start);
    let salt = {
        let mut h = revs.epoch() ^ 0x9E37_79B9_7F4A_7C15;
        for b in super::cache::ctx_key(c.a).bytes() {
            h = (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
        h ^ cc.drawings.sig.wrapping_mul(0xff51_afd7_ed55_8ccd)
    };
    let chunks = super::drawings::plan_drawings_chunked(c, revs.item_stamps("drawings2d").unwrap_or(&[]), &mut cc.drawings, salt, have, &mut bounds)?;
    for k in 6..9 {
        put(w, k, &mut segs);
    }
    match fresh {
        Some((_, b)) => {
            bounds.merge(b.raw());
            cc.rest = Some(RestEntry { sig, groups: segs, bounds: b.raw() });
        }
        None => bounds.merge(cc.rest.as_ref().map_or(Bounds::new().raw(), |r| r.bounds)),
    }
    w.bounds = bounds.get();
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
    }

    fn args(floor: &str, detail: f64, codes: &[&str]) -> PlanArgs {
        let t = serde_json::json!({ "floor": floor, "show": codes, "grey": [] }).to_string();
        PlanArgs::parse(detail, &t).unwrap()
    }

    #[test]
    fn beispiel_eg_decke_raum() {
        let p = sample();
        let r = plan_domains(&p, &args("eg", 1.0, &["20", "30", "60"])).unwrap();
        let s = serde_json::to_string(&r.ceilings).unwrap();
        assert!(s.contains("\"ceilingId\":\"C1\"") && s.contains("\"kind\":\"polygon\""), "{s}");
        // Decke deckungsgleich unter den Wänden: kein freier Umriss.
        assert!(!s.contains("ceiling-outline"));
        let rooms = serde_json::to_value(&r.rooms).unwrap();
        assert_eq!(rooms[1]["kind"], "text");
        assert_eq!(rooms[1]["extraLines"][0]["text"], "17.01 m²");
        assert_eq!(rooms[1]["extraLines"][1]["text"], "HNF · Hauptnutzfläche");
        assert!(r.bounds.is_some());
    }

    #[test]
    fn puffer_gruppen_wie_domaenen() {
        let p = sample();
        let a = args("eg", 1.0, &["20", "21", "30", "40", "60"]);
        let d = plan_domains(&p, &a).unwrap();
        let buf = plan_domains_buf(&p, &a).unwrap();
        let (prims, groups, bounds) = crate::plan_buf::decode(&buf).unwrap();
        assert_eq!(groups.len(), GROUPS.len());
        let lists = [&d.ceilings, &d.roofs, &d.rooms, &d.walls, &d.stairs, &d.columns, &d.drawings.prims, &d.solids, &d.context, &d.sections];
        for ((a, b), l) in groups.iter().zip(lists) {
            assert_eq!(serde_json::to_string(&prims[*a..*b]).unwrap(), serde_json::to_string(l).unwrap());
        }
        assert!(!d.walls.is_empty() && !d.rooms.is_empty());
        assert_eq!(bounds, d.bounds);
    }

    #[test]
    fn unsichtbare_codes_fehlen() {
        let p = sample();
        let r = plan_domains(&p, &args("eg", 1.0, &[])).unwrap();
        assert!(r.ceilings.is_empty() && r.rooms.is_empty() && r.bounds.is_none());
    }

    #[test]
    fn stempel_flaeche_und_personen() {
        assert_eq!(format_stamp_area(17.0125, None), "17.01");
        assert_eq!(format_stamp_area(17.26, Some(0.5)), "17.5");
        assert_eq!(format_stamp_area(17.26, Some(0.1)), "17.3");
        let s = RoomStamp { name: "Bad".into(), show_floor_area: false, show_usage: false, occupancy: Some(1e21), ..Default::default() };
        assert_eq!(room_stamp_extra_lines(&s, 1.0, SiaCategory::VF)[0].text, "1e+21 Pers.");
        let d = room_stamp_to_doc(&RoomStamp { number: Some("  2 ".into()), name: "Bad".into(), name_line2: Some("  ".into()), ..Default::default() });
        assert_eq!(d.paragraphs.len(), 1);
        assert_eq!(d.paragraphs[0].runs[0].text, "2 ");
    }

    fn stamp(name: &str) -> RoomStamp {
        RoomStamp { name: name.into(), show_floor_area: true, show_usage: true, ..Default::default() }
    }

    #[test]
    fn stempel_dokument() {
        assert_eq!(room_stamp_to_doc(&stamp("Bad")).paragraphs.len(), 1);
        assert_eq!(room_stamp_to_doc(&RoomStamp { name_line2: Some("WC".into()), ..stamp("Bad") }).paragraphs.len(), 2);
        let d = room_stamp_to_doc(&RoomStamp { number: Some("1.01".into()), ..stamp("Bad") });
        assert_eq!(d.paragraphs[0].runs.len(), 2);
        assert_eq!(d.paragraphs[0].runs[0].text, "1.01 ");
        assert_eq!(d.paragraphs[0].runs[1].text, "Bad");
        assert_eq!(d.paragraphs[0].runs[1].marks.bold, Some(true));
    }

    #[test]
    fn stempel_zeilen() {
        let l = room_stamp_extra_lines(&RoomStamp { floor_area_prefix: Some("BF ".into()), ..stamp("Bad") }, 12.345, SiaCategory::HNF);
        assert_eq!(l[0].text, "BF 12.35 m²");
        assert_eq!(l[1].text, "HNF · Hauptnutzfläche");
        let off = RoomStamp { show_floor_area: false, show_usage: false, ..stamp("Bad") };
        assert!(room_stamp_extra_lines(&off, 12.345, SiaCategory::HNF).is_empty());
        let r = room_stamp_extra_lines(&RoomStamp { show_usage: false, rounding_step: Some(0.5), ..stamp("Bad") }, 12.34, SiaCategory::HNF);
        assert_eq!(r[0].text, "12.5 m²");
        let o = room_stamp_extra_lines(&RoomStamp { occupancy: Some(4.0), ..off.clone() }, 12.345, SiaCategory::HNF);
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].text, "4 Pers.");
        assert_eq!(o[0].align, Align::Center);
        assert_eq!(format_stamp_area(12.345, None), "12.35");
        assert_eq!(format_stamp_area(12.0, None), "12.00");
        assert_eq!(format_stamp_area(12.24, Some(0.5)), "12");
        assert_eq!(format_stamp_area(12.26, Some(0.5)), "12.5");
        assert_eq!(format_stamp_area(12.3, Some(0.1)), "12.3");
        assert_eq!(format_stamp_area(12.34, Some(1.0)), "12");
    }

    #[test]
    fn stuetzen_label() {
        let col = Column { profile: ColumnProfile::Round { radius: 0.125 }, ..Default::default() };
        assert_eq!(column_label(&col), "Stütze Ø25");
    }

    /// Messung (von Hand): `PLAN_BIG=projekt.obp cargo test --release --lib messung_plan_puffer -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn messung_plan_puffer() {
        let Ok(path) = std::env::var("PLAN_BIG") else { return };
        let mut doc = crate::document::Document::from_json(&std::fs::read_to_string(path).unwrap()).unwrap();
        let p = doc.project().unwrap().clone();
        let codes: Vec<String> = p.flat_categories().iter().map(|c| c.code.clone()).collect();
        let t = serde_json::json!({ "floor": "eg", "show": codes, "grey": [], "global": true }).to_string();
        let a = PlanArgs::parse(1.0, &t).unwrap();
        let time = |name: &str, f: &mut dyn FnMut()| {
            f();
            let t0 = std::time::Instant::now();
            for _ in 0..5 {
                f();
            }
            println!("{name}: {:.1} ms", t0.elapsed().as_secs_f64() * 1000.0 / 5.0);
        };
        time("plan_domains", &mut || {
            plan_domains(&p, &a).unwrap();
        });
        let d = plan_domains(&p, &a).unwrap();
        time("Puffer schreiben", &mut || {
            let mut w = crate::plan_buf::Writer::new(true);
            for g in [&d.ceilings, &d.roofs, &d.rooms, &d.walls, &d.stairs, &d.columns, &d.drawings.prims, &d.solids, &d.context, &d.sections] {
                w.group(g);
            }
            w.finish();
        });
        time("JSON (früher)", &mut || {
            serde_json::to_string(&(&d.ceilings, &d.roofs, &d.rooms, &d.walls, &d.stairs, &d.columns, &d.drawings.prims, &d.solids, &d.context, &d.sections)).unwrap();
        });
    }
}
