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
use crate::plan::wall_poche::{ceiling_outline_lines, wall_footprint, WallFootprint};
use std::collections::{HashMap, HashSet};

/// Footprint-Farbe der Extrusionen (wie das 3D-Orange).
/// [140] Tusche statt Orange.
const EXTRUSION_STROKE: &str = "#3a3f47";
/// Rückfall-Füllung einer Stütze ohne auflösbares Bauteil.
const COLUMN_FALLBACK_FILL: &str = "#3a3f47";
/// Alpha-Suffix der (unsichtbaren) Raumfüllung.
const ROOM_FILL_ALPHA: &str = "00";
/// Basis-Schriftgrösse des Raumstempels (pt).
const ROOM_STAMP_PT: f64 = 10.0;
/// [140] Raumstempel ab 1:200 (2.5 mm statt 3.5 mm, ohne SIA-Zeile): kleine Räume überlappen sonst.
const ROOM_STAMP_SMALL_PT: f64 = 7.0;
const ROOM_STAMP_SMALL_FROM: f64 = 200.0;
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
    /// Schwarz-Weiss (`extras.rs`).
    pub mono: bool,
    /// Zeitpunkt der Schattenstudie (Unix-ms; fehlt/ungültig = kein Schatten).
    pub sun_when: Option<f64>,
    /// [140] Detailgrad „mittel" ab 1:200 automatisch als „grob" gezeichnet (Raumstempel bleiben, nur
    /// knapper; ab 1:500 ohne Masslinien).
    pub auto_coarse: bool,
    /// [33] Eingeschaltete Override-Regeln (ids) eines Ausschnitts/einer Ansichtsvorlage (Blatt-Viewport);
    /// `None` = Schalter `enabled` der Regeln im Projekt.
    pub rules: Option<HashSet<String>>,
}

/// [140] Ab diesem Massstab (1:N) zeichnet der Detailgrad „mittel" wie „grob".
pub const AUTO_COARSE_FROM: f64 = 200.0;
/// [140] Ab diesem Massstab (1:N) im automatisch groben Plan: Raumstempel nur mit Namen, keine Masslinien.
pub const OVERVIEW_FROM: f64 = 500.0;

/// [140] Wirksamer Detailgrad: „mittel" ab 1:200 wie „grob" (zweiter Wert: automatisch vergröbert).
pub fn effective_detail(requested: Detail, scale: f64) -> (Detail, bool) {
    if requested == Detail::Mittel && scale >= AUTO_COARSE_FROM {
        (Detail::Grob, true)
    } else {
        (requested, false)
    }
}

impl PlanArgs {
    /// `detail`: 0 grob, 1 mittel, 2 fein; `text`: `{"floor": id, "show": [code…], "grey": [code…],
    /// "referenceLines": bool, "global": bool, "scale": N, "forPrint": bool, "compact": bool,
    /// "mono": bool, "sunWhen": ms | null, "rules": [id…] (optional, [33])}`.
    pub fn parse(detail: f64, text: &str) -> Result<PlanArgs, String> {
        let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Plan-Argumente: {e}"))?;
        let set = |k: &str| -> HashSet<String> { v.get(k).and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default() };
        let scale = v.get("scale").and_then(|b| b.as_f64()).unwrap_or(super::drawings::DEFAULT_SCALE_DENOMINATOR);
        let requested = match detail as i64 {
            0 => Detail::Grob,
            2 => Detail::Fein,
            _ => Detail::Mittel,
        };
        let (detail, auto_coarse) = effective_detail(requested, scale);
        Ok(PlanArgs {
            floor: v.get("floor").and_then(|f| f.as_str()).unwrap_or_default().to_string(),
            detail,
            show: set("show"),
            grey: set("grey"),
            reference_lines: v.get("referenceLines").and_then(|b| b.as_bool()).unwrap_or(false),
            global: v.get("global").and_then(|b| b.as_bool()).unwrap_or(false),
            scale,
            for_print: v.get("forPrint").and_then(|b| b.as_bool()).unwrap_or(false),
            compact: v.get("compact").and_then(|b| b.as_bool()).unwrap_or(false),
            mono: v.get("mono").and_then(|b| b.as_bool()).unwrap_or(false),
            sun_when: v.get("sunWhen").and_then(|b| b.as_f64()),
            auto_coarse,
            rules: v.get("rules").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()),
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

    /// [140] Schnittflächen dieser Ebene schwarz (`style::solid_cut`; Feld `cutHatch` der Ebene).
    pub fn solid_cut(&self) -> bool {
        let cut_hatch = self.p.floor(&self.a.floor).and_then(|l| l.cut_hatch).unwrap_or(false);
        solid_cut(self.a.detail, self.a.scale, cut_hatch)
    }

    pub fn greyed(&self, code: &str) -> bool {
        self.a.grey.contains(code)
    }

    pub fn cat(&self, code: &str) -> Option<&'a LayerCategory> {
        self.cats.get(code).copied()
    }

    /// [33] Massstab und eingeschaltete Regeln dieser Plan-Erzeugung für die Override-Auswertung.
    pub fn rule_view(&self) -> overrides::RuleView<'_> {
        overrides::RuleView::at(self.a.scale, self.a.rules.as_ref())
    }

    /// Effektive Override-Aktionen eines Elements (`overrideFor` in TS).
    pub fn overrides(&self, code: &str, object_name: Option<&str>) -> Actions {
        overrides::effective(self.p.override_rules.as_deref(), &Subject { layer_name: self.cat(code).map(|c| c.name.as_str()), layer_code: Some(code), object_name, ..Default::default() }, self.rule_view())
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
    pub(crate) fn get(&self) -> Option<[f64; 4]> {
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
pub(super) enum Pick<'a> {
    Ceiling(&'a str),
    Roof(&'a str),
    Room(&'a str),
    Column(&'a str),
    Solid(&'a str),
}

#[allow(clippy::too_many_arguments)]
pub(super) fn polygon(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, hatch: HatchRender, greyed: Option<bool>, no_stroke_edges: Option<Vec<f64>>, pick: Pick) -> Primitive {
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

pub(super) fn line(a: Vec2, b: Vec2, cls: &str, w: f64, dash: super::prim::Dash, color: &str, greyed: Option<bool>) -> Primitive {
    Primitive::Line { a, b, cls: cls.into(), weight_mm: w, dash, zigzag: None, motif: None, color: Some(color.into()), drawing_id: None, opening_id: None, stair_id: None, greyed, opacity: None }
}

pub(super) fn pv(p: [f64; 2]) -> Vec2 {
    Vec2 { x: p[0], y: p[1] }
}

/// `getComponent`; hängender Verweis (Datei/Import) → neutrales Rückfall-Bauteil statt Abbruch.
pub(super) fn component<'a>(p: &'a Project, id: &str) -> Result<&'a Component, String> {
    Ok(p.component_or_fallback(id))
}

/// `resolveHatch`; hängende Schraffur (Datei/Import) → ohne Muster statt Abbruch (ein hängender
/// Linienstil der Schraffur fällt in `resolve_hatch` auf die Vorgabe-Strichstärke zurück).
pub(super) fn resolve_hatch_or_none(p: &Project, hatch_id: &str, wall_angle_deg: Option<f64>, fg: Option<&str>) -> HatchRender {
    resolve_hatch(p, hatch_id, wall_angle_deg, fg, None).unwrap_or_else(no_hatch)
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
pub(super) fn ceiling_layers<'a>(p: &'a Project, c: &Ceiling) -> Result<&'a [Layer], String> {
    if let Some(id) = c.ceiling_type_id.as_deref().filter(|s| !s.is_empty()) {
        if let Some(ct) = p.ceiling_types.as_deref().unwrap_or(&[]).iter().find(|t| t.id == id) {
            return Ok(&ct.layers);
        }
    }
    // Hängender Typ (Datei/Import): Rückfall-Schicht statt Abbruch.
    Ok(p.wall_types.iter().find(|t| t.id == c.wall_type_id).map_or(Project::fallback_layers(), |t| t.layers.as_slice()))
}

/// Typname einer Decke für `object_name` (Maps in TS: letzter Eintrag je id gewinnt).
fn ceiling_type_name<'a>(p: &'a Project, c: &Ceiling) -> Option<&'a str> {
    let ct = c.ceiling_type_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.ceiling_types.as_deref().unwrap_or(&[]).iter().rev().find(|t| t.id == id));
    ct.map(|t| t.name.as_str()).or_else(|| p.wall_types.iter().rev().find(|t| t.id == c.wall_type_id).map(|t| t.name.as_str()))
}

/// [33] Schicht-Override der sichtbaren Schicht einer nicht geschnittenen Decke (Grundriss: oberste
/// Schicht `top`, Deckenspiegel: unterste) — dieselben Regeln wie für die Schnittflächen im Schnitt
/// (Bauteilart Decke/Bodenplatte, Funktion, Lage, Baustoff). `None` ohne wirksame Regel (Schnellpfad).
pub(super) fn ceiling_view_override(c: &Ctx, ce: &Ceiling, top: bool) -> Option<overrides::LayerActions> {
    let p = c.p;
    let v = c.rule_view();
    if !overrides::has_layer_actions(p, v) {
        return None;
    }
    let layers = ceiling_layers(p, ce).ok()?;
    let li = if top { 0 } else { layers.len().checked_sub(1)? };
    let kind = if overrides::is_ground_slab(p, ce, layers) { "ground_slab" } else { "slab" };
    overrides::layer_actions(p, v, kind, &ce.category_code, ceiling_type_name(p, ce), layers).into_iter().nth(li).filter(|a| a.any())
}

/// [33] Ansichtsschraffur `hatch` einer Fläche mit Schicht-Override: "none" ohne, "material" wie ohne
/// Regel, sonst die Schraffur des Projekts. Zweiter Wert: Ansichtsmuster (Linien) weglassen?
pub(super) fn view_hatch_override(p: &Project, o: Option<&overrides::LayerActions>, hatch: HatchRender) -> (HatchRender, bool) {
    match o.and_then(|o| o.hatch.as_deref()) {
        None | Some("material") => (hatch, false),
        Some("none") => (no_hatch(), true),
        Some(id) => (resolve_hatch_or_none(p, id, None, None), true),
    }
}

/// Bodenbeläge ([100]): Ansichtsmuster der obersten Schicht der Decke, auf der das Geschoss steht (OK
/// Decke zwischen 0.3 m unter dem Geschossboden und der Schnitthöhe) — von oben gesehen, unter Wänden
/// und Räumen gezeichnet.
fn floor_finishes(c: &Ctx, out: &mut Vec<Primitive>) {
    let p = c.p;
    let base = p.floor(&c.a.floor).and_then(|f| f.base_elevation).unwrap_or(0.0);
    let cut = super::extras::cut_z(p, &c.a.floor);
    for ce in p.ceilings.as_deref().unwrap_or(&[]).iter().filter(|x| c.shown(&x.category_code)) {
        let top = p.ceiling_vertical_extent(ce).1;
        if !(top >= base - 0.3 && top <= cut) {
            continue;
        }
        // [33] Schicht-Override mit eigener Schraffur bzw. ohne Muster: kein Belagsmuster.
        if view_hatch_override(p, ceiling_view_override(c, ce, true).as_ref(), no_hatch()).1 {
            continue;
        }
        let Some((segs, w, ink)) = crate::surface_pattern3d::floor_finish_segments(p, ce, c.a.scale) else { continue };
        let greyed = Some(c.greyed(&ce.category_code));
        for (a, b) in segs {
            out.push(line(pv(a), pv(b), "floor-finish-pattern", w, None, &ink, greyed));
        }
    }
}

fn ceilings(c: &Ctx, out: &mut Vec<Primitive>, bounds: &mut Bounds) -> Result<(), String> {
    let p = c.p;
    floor_finishes(c, out);
    let range = super::view_range::ViewRange::of(p, &c.a.floor);
    // Ansichtsbereich ([36]): Decken anderer Geschosse „über Schnitt“ (bis Oberkante, z. B. Galerie
    // darüber) bzw. „unter Schnitt“ (bis „darunter sichtbar bis“) kommen dazu.
    let list: Vec<(&Ceiling, super::view_range::Zone)> = p
        .ceilings
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|x| c.shown(&x.category_code))
        .filter_map(|x| {
            let (zb, zt) = p.ceiling_vertical_extent(x);
            let zone = range.classify(zb, zt);
            let keep = zone != super::view_range::Zone::Hidden && (x.floor_id == c.a.floor || range.admits_other_floor(zone));
            keep.then_some((x, zone))
        })
        .collect();
    if list.is_empty() {
        return Ok(());
    }
    let fps = wall_footprints(c);
    for (ce, zone) in list {
        let out_start = out.len();
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
        let holes: Vec<Vec<[f64; 2]>> = crate::opening_shape::ceiling_hole_rings(p, ce).iter().map(|h| h.iter().map(|v| [v.x, v.y]).collect()).collect();
        let merged = crate::polygon_holes::merge_holes(&pts, &holes, 1e-4);
        let layers = ceiling_layers(p, ce)?;
        let comp = match layers.first() {
            Some(l) => Some(component(p, &l.component_id)?),
            None => None,
        };
        let stroke = color.unwrap_or(POCHE_STROKE);
        let view_hatch_id = resolve_hatch_id(ce.hatch_id.as_deref(), ce.hatch_source, category, comp.and_then(|k| k.view_hatch_id.as_deref()));
        let hatch = match (c.a.detail != Detail::Grob, comp, view_hatch_id.filter(|s| !s.is_empty())) {
            (true, Some(k), Some(id)) => resolve_hatch_or_none(p, id, None, resolve_foreground(k, ce.foreground.as_deref(), category, ce.foreground_source)),
            _ => no_hatch(),
        };
        let fill = match comp {
            Some(k) => resolve_background(k, ce.background.as_deref(), category, ce.background_source).unwrap_or(poche_fill(hatch.pattern)).to_string(),
            None => "none".to_string(),
        };
        // [33] Schicht-Override der obersten (von oben sichtbaren) Schicht: Füllung, Schraffur, Umriss.
        let lov = ceiling_view_override(c, ce, true);
        let (hatch, _) = view_hatch_override(p, lov.as_ref(), hatch);
        let fill = lov.as_ref().and_then(|o| o.fill_color.clone()).unwrap_or(fill);
        let ring: Vec<Vec2> = merged.ring.iter().map(|q| pv(*q)).collect();
        let bridges = (!merged.bridge_edges.is_empty()).then(|| merged.bridge_edges.iter().map(|&k| k as f64).collect());
        out.push(polygon(ring, &fill, "none", 0.0, hatch, Some(greyed), bridges, Pick::Ceiling(&ce.id)));
        let w = lw * c.a.detail.layer_factor();
        let outline = lov.as_ref().and_then(|o| o.outline) != Some(false);
        for [a, b] in ceiling_outline_lines(&merged.ring, &merged.bridge_edges, &fps).into_iter().filter(|_| outline) {
            out.push(line(pv(a), pv(b), "ceiling-outline", w, Some(Some(OVERHEAD_DASH.to_vec())), stroke, Some(greyed)));
        }
        // Eigene Decke „über Schnitt“ bleibt wie bisher (Umriss ist schon strichpunktiert, die Fläche
        // deckt wie gewohnt); umgezeichnet werden Decken unter dem Schnitt und solche anderer Geschosse.
        if ce.floor_id != c.a.floor || zone != super::view_range::Zone::Above {
            if let Some(d) = range.restyle_dash(zone) {
                super::view_range::restyle(out, out_start, d);
            }
        }
    }
    Ok(())
}

// ── Dächer ──────────────────────────────────────────────────────────────────

/// Dach im Grundriss von oben gesehen (Dachaufsicht): ganz unter der Schnittebene des Geschosses
/// (First ≤ Schnitthöhe). Nur dann zeigt der Grundriss Ansichtsschraffur und Ansichtsmuster der
/// Eindeckung; liegt das Dach darüber (z. B. Satteldach über dem OG-Schnitt), bleiben nur die Kanten.
fn roof_seen_from_above(p: &Project, roof: &Roof, geo: &crate::roof::RoofGeometry, cut_z: f64) -> bool {
    p.roof_base_elevation(roof) + max(0.0, geo.ridge_height) <= cut_z + 1e-6
}

fn roofs(c: &Ctx, out: &mut Vec<Primitive>, bounds: &mut Bounds) {
    let p = c.p;
    let cut_z = super::extras::cut_z(p, &c.a.floor);
    let range = super::view_range::ViewRange::of(p, &c.a.floor);
    let floor_base = p.floor(&c.a.floor).and_then(|f| f.base_elevation).unwrap_or(0.0);
    let below = |r: &Roof| r.floor_id != c.a.floor && p.floor(&r.floor_id).is_some_and(|f| f.base_elevation.unwrap_or(0.0) < floor_base - 1e-6);
    // Ansichtsbereich ([36]): Dächer höherer Geschosse bis zur Oberkante „über Schnitt“ (Vordach, Dach darüber).
    let above = |r: &Roof| range.custom && range.top.is_some() && r.floor_id != c.a.floor && p.floor(&r.floor_id).is_some_and(|f| f.base_elevation.unwrap_or(0.0) > floor_base + 1e-6);
    for roof in p.roofs.as_deref().unwrap_or(&[]).iter().filter(|r| (r.floor_id == c.a.floor || below(r) || above(r)) && c.shown(&r.category_code)) {
        let greyed = Some(c.greyed(&roof.category_code));
        let category = c.cat(&roof.category_code);
        let stroke = roof.color.as_deref().or(category.map(|k| k.color.as_str())).unwrap_or(POCHE_STROKE);
        let geo = crate::roof::roof_geometry(&roof.params(), 0.0);
        let from_above = roof_seen_from_above(p, roof, &geo, cut_z);
        // Dach über der Schnittebene: Kanten als Strich-Punkt-Linie (SIA „darüberliegend“), Dachaufsicht darunter ausgezogen.
        let overhead: Option<Option<Vec<f64>>> = (!from_above).then(|| Some(OVERHEAD_DASH.to_vec()));
        // Ansichtsbereich ([36]): Dach ganz über der Oberkante bzw. unter der Unterkante entfällt.
        let rb = p.roof_base_elevation(roof);
        let zone = range.classify(rb, rb + max(0.0, geo.ridge_height));
        if zone == super::view_range::Zone::Hidden {
            continue;
        }
        // Dächer tieferer Geschosse nur als Dachaufsicht (ganz unter der Schnittebene), höherer nur „über Schnitt“.
        if below(roof) && !from_above || above(roof) && !range.admits_other_floor(zone) {
            continue;
        }
        let out_start = out.len();
        // Eigenes Dach über dem Schnitt ist schon strichpunktiert (Bruchkanten, Dachfenster bleiben wie bisher).
        let dash = if roof.floor_id == c.a.floor && zone == super::view_range::Zone::Above { None } else { range.restyle_dash(zone) };
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
            .filter(|_| from_above)
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
        // Ansichtsschraffur ([100]) der Eindeckung je Dachfläche (traufparallel/Falllinie, verkürzt projiziert).
        if let Some(comp) = layers.first().filter(|l| from_above && dash.is_none() && !l.component_id.is_empty()).and_then(|l| p.component(&l.component_id)) {
            if let Some((pat, spec)) = comp.surface_pattern.as_ref().and_then(|sp| Some((sp, crate::surface_pattern::spec_of(sp, roof.surface_pattern_angle.unwrap_or(0.0))?))) {
                let off = roof.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
                let w = pat.weight_mm.filter(|w| w.is_finite() && *w > 0.0).unwrap_or(0.1);
                let ink = pat.color.as_deref().or(comp.foreground.as_deref()).filter(|c| !c.trim().is_empty()).unwrap_or("#3a3f47");
                for plane in &geo.planes {
                    for (a, b) in crate::surface_pattern::segments_3d(plane, &spec, off, c.a.scale) {
                        out.push(line(pv([a[0], a[1]]), pv([b[0], b[1]]), "roof-surface-pattern", w, None, ink, greyed));
                    }
                }
            }
        }
        // Verschnittene Dächer und Gauben ([G5]): Dachaufsicht aus den Körpern (Traufen, Firste,
        // Grate/Kehlen, verdeckte Teile weg).
        let ri = p.roofs.as_deref().and_then(|r| r.iter().position(|x| x.id == roof.id));
        if let Some(ri) = ri.filter(|&ri| crate::roof_assembly::is_assembled(p, ri)) {
            use crate::roof_assembly::EdgeKind;
            for (owner, a, b, kind) in crate::roof_assembly::assembly_edges(p).iter() {
                if *owner != ri {
                    continue;
                }
                let (cls, w) = match kind {
                    EdgeKind::Eaves => ("roof-eaves", ROOF_EAVES_MM),
                    EdgeKind::Ridge => ("roof-ridge", ROOF_RIDGE_MM),
                    EdgeKind::Hip => ("roof-hip", ROOF_HIP_MM),
                };
                out.push(line(pv(*a), pv(*b), cls, w, overhead.clone(), stroke, greyed));
            }
            roof_windows(c, out, roof);
            if let Some(d) = dash {
                super::view_range::restyle(out, out_start, d);
            }
            continue;
        }
        for ring in std::iter::once(&geo.eaves).chain(geo.eaves_holes.iter()) {
            let pts: Vec<Vec2> = ring.iter().map(|q| pv(*q)).collect();
            let n = pts.len();
            for i in 0..n {
                out.push(line(pts[i], pts[(i + 1) % n], "roof-eaves", ROOF_EAVES_MM, overhead.clone(), stroke, greyed));
            }
        }
        for l in &geo.ridges {
            out.push(line(pv(l[0]), pv(l[1]), "roof-ridge", ROOF_RIDGE_MM, overhead.clone(), stroke, greyed));
        }
        for l in &geo.hips {
            out.push(line(pv(l[0]), pv(l[1]), "roof-hip", ROOF_HIP_MM, overhead.clone(), stroke, greyed));
        }
        for l in &geo.breaks {
            out.push(line(pv(l[0]), pv(l[1]), "roof-break", ROOF_BREAK_MM, Some(Some(ROOF_BREAK_DASH.to_vec())), stroke, greyed));
        }
        roof_windows(c, out, roof);
        if let Some(d) = dash {
            super::view_range::restyle(out, out_start, d);
        }
    }
}

/// Dachfenster ([103]) im Grundriss des Dach-Geschosses: Rahmen-Umriss und Glas als Projektion der
/// Dachfläche, gestrichelt (über der Schnitthöhe); Pick über die Öffnungs-id.
pub(super) fn roof_windows(c: &Ctx, out: &mut Vec<Primitive>, roof: &Roof) {
    let p = c.p;
    let Some(ri) = p.roofs.as_deref().and_then(|r| r.iter().position(|x| x.id == roof.id)) else { return };
    for (o, f) in crate::opening_shape::roof_openings(p, ri) {
        if !c.shown(&o.category_code) {
            continue;
        }
        let greyed = Some(c.greyed(&o.category_code));
        let category = c.cat(&o.category_code);
        let stroke = o.color.as_deref().or(category.map(|k| k.color.as_str())).unwrap_or(POCHE_STROKE);
        let fw = crate::opening_shape::surface_frame_width(p, o);
        for (inset, cls, w) in [(0.0, "roof-window-frame", ROOF_EAVES_MM), (fw, "roof-window-glass", ROOF_BREAK_MM)] {
            let (hw, hh) = (o.width / 2.0 - inset, o.height / 2.0 - inset);
            let r = [f.at(-hw, -hh, 0.0), f.at(hw, -hh, 0.0), f.at(hw, hh, 0.0), f.at(-hw, hh, 0.0)];
            for k in 0..4 {
                let (a, b) = (r[k], r[(k + 1) % 4]);
                let mut l = line(Vec2 { x: a[0], y: a[1] }, Vec2 { x: b[0], y: b[1] }, cls, w, Some(Some(OVERHEAD_DASH.to_vec())), stroke, greyed);
                if let Primitive::Line { opening_id, .. } = &mut l {
                    *opening_id = Some(o.id.clone());
                }
                out.push(l);
            }
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

/// [140] Kleinste Stempelschrift (2 mm Papier) für enge Räume.
const ROOM_STAMP_MIN_PT: f64 = 2.0 / PT_MM;
const PT_MM: f64 = crate::text_layout::PT_TO_MM;
/// [140] Rand um den Stempel: 5 % der Blockgrösse plus 0.5 mm Papier je Seite (Bildschirm-/Druckschrift
/// weicht von Inter ab, z. B. Helvetica schmaler, DejaVu breiter).
const STAMP_MARGIN: f64 = 1.05;
const STAMP_PAD_MM: f64 = 0.5;

/// [140] Ausmass des Stempels in Metern bei 1:`scale` (echte Schriftmetrik, `text_layout::stamp_block_size`)
/// samt Rand.
fn stamp_size_m(doc: &RichTextDoc, extra: &[StampLine], pt: f64, scale: f64) -> (f64, f64) {
    let rows: Vec<(&str, crate::text_layout::LineAlign)> = extra.iter().map(|l| (l.text.as_str(), crate::text_layout::LineAlign::of(Some(l.align)))).collect();
    let (w, h) = crate::text_layout::stamp_block_size(doc, &rows, pt, PT_MM * scale / 1000.0);
    let pad = 2.0 * STAMP_PAD_MM * scale / 1000.0;
    (w * STAMP_MARGIN + pad, h * STAMP_MARGIN + pad)
}

/// [140] Raumstempel einpassen. `place(breite, höhe)` sucht eine Lage im Raum, an der das Rechteck des
/// Stempels ganz im Raumumriss liegt (auch L-förmige Räume, `room_area::rect_in_ring`), und gibt sie zurück.
/// Passt der Stempel (Breite aus der Schriftmetrik, Höhe aus den Zeilen) bei `pt` nirgends, entfallen erst
/// die Nutzungszeile, dann die Flächenzeile (Zusatzzeilen von hinten), danach sinkt die Schrift auf 2 mm
/// Papier (je Schrift zuerst der Name mit, dann ohne eigene Schriftgrössen; mit kleinerer Schrift dürfen
/// Zusatzzeilen wieder dazu), zuletzt wird der Name gekürzt. Ergebnis: Zusatzzeilen,
/// Schriftgrösse (pt), Ersatz für den Namen (`Some`: ohne Auszeichnungen bzw. gekürzt, „Trep.") und die
/// Lage (`None`: passt nirgends, der Aufrufer behält seinen Anker).
fn fit_room_stamp(doc: &RichTextDoc, extra: Vec<StampLine>, pt: f64, scale: f64, place: &dyn Fn(f64, f64) -> Option<Vec2>) -> (Vec<StampLine>, f64, Option<RichTextDoc>, Option<Vec2>) {
    if !(scale > 0.0) || !scale.is_finite() {
        return (extra, pt, None, None);
    }
    let at = |doc: &RichTextDoc, extra: &[StampLine], pt: f64| {
        let (w, h) = stamp_size_m(doc, extra, pt, scale);
        place(w, h)
    };
    let text = crate::text_layout::plain_text(doc);
    // Name mit eigenen Schriftgrössen (Stempel: Name 12 pt fett) schrumpft nicht mit `pt`: dann ohne
    // Auszeichnungen in der Grundschrift (Ersatz `Some`).
    let plain = doc_from_text(&text);
    let mut steps: Vec<(Option<&RichTextDoc>, f64)> = vec![(None, pt), (Some(&plain), pt)];
    if pt > ROOM_STAMP_MIN_PT {
        steps.extend([(None, ROOM_STAMP_MIN_PT), (Some(&plain), ROOM_STAMP_MIN_PT)]);
    }
    for (variant, pt) in steps {
        let mut e = extra.clone();
        loop {
            if let Some(q) = at(variant.unwrap_or(doc), &e, pt) {
                return (e, pt, variant.cloned(), Some(q));
            }
            if e.pop().is_none() {
                break;
            }
        }
    }
    let pt = pt.min(ROOM_STAMP_MIN_PT);
    let longest = text.split('\n').map(|l| l.chars().count()).max().unwrap_or(0);
    for n in (2..longest).rev() {
        let d = doc_from_text(&abbreviate(&text, n));
        if let Some(q) = at(&d, &[], pt) {
            return (Vec::new(), pt, Some(d), Some(q));
        }
    }
    (Vec::new(), pt, Some(doc_from_text(&abbreviate(&text, 2))), None)
}

/// [140] Lagen für einen Raumstempel ohne eigenen Anker: zuerst der Pol der Unzugänglichkeit, dann Punkte
/// eines Rasters über dem Raum (nach Abstand zum Pol) — passt der Stempel am Pol nicht (L-Raum, Name breiter
/// als der Flügel um den Pol), rückt er dorthin, wo er ganz im Raum liegt.
fn stamp_candidates(ring: &[[f64; 2]], pole: Vec2) -> Vec<Vec2> {
    const N: usize = 24;
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for q in ring {
        x0 = x0.min(q[0]);
        y0 = y0.min(q[1]);
        x1 = x1.max(q[0]);
        y1 = y1.max(q[1]);
    }
    let mut out = vec![pole];
    if !(x1 > x0 && y1 > y0) {
        return out;
    }
    let mut grid: Vec<Vec2> = (0..N)
        .flat_map(|i| (0..N).map(move |j| Vec2 { x: x0 + (x1 - x0) * (i as f64 + 0.5) / N as f64, y: y0 + (y1 - y0) * (j as f64 + 0.5) / N as f64 }))
        .filter(|q| crate::room_area::rect_in_ring(ring, q.x, q.y, 0.0, 0.0))
        .collect();
    let d = |q: &Vec2| (q.x - pole.x) * (q.x - pole.x) + (q.y - pole.y) * (q.y - pole.y);
    grid.sort_by(|a, b| d(a).total_cmp(&d(b)));
    out.extend(grid);
    out
}

/// Ausmass eines Rings `[x0, y0, x1, y1]`.
fn ring_bounds(ring: &[[f64; 2]]) -> [f64; 4] {
    ring.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])])
}

/// Namenszeilen auf `n` Zeichen kürzen (n − 1 Zeichen und Punkt), Leerzeichen am Schnitt weg.
fn abbreviate(text: &str, n: usize) -> String {
    text.split('\n')
        .map(|l| if l.chars().count() <= n { l.to_string() } else { format!("{}.", l.chars().take(n.saturating_sub(1).max(1)).collect::<String>().trim_end()) })
        .collect::<Vec<_>>()
        .join("\n")
}

/// [140] Hindernisse für Raumstempel aus den schon erzeugten Domänen: Treppen (alle Striche), Türschwenk-Bögen,
/// Stützen, Beschriftungen des Kontexts (Höhenlinien-Koten) und die Zeichnungen, denen Stempel ausweichen
/// (Bemassung, Koten, Texte, Symbole; `drawings::stamp_obstacle_prims`).
fn stamp_obstacles(c: &Ctx, d: &DomainPrims) -> super::stamp_place::Obstacles {
    let mut o = super::stamp_place::Obstacles::default();
    for q in d.stairs.iter().chain(&d.columns) {
        o.add_prim(q);
    }
    for q in &d.walls {
        if matches!(q, Primitive::Arc { opening_id: Some(_), .. }) {
            o.add_prim(q);
        }
    }
    for q in &d.context {
        if matches!(q, Primitive::DrawingText { .. }) {
            o.add_prim(q);
        }
    }
    for q in super::drawings::stamp_obstacle_prims(c) {
        o.add_prim(&q);
    }
    o
}

/// [140] Bis zu diesem Abstand (Papier-mm) zum nächsten Hindernis zählt eine Stempel-Lage als frei; freiere
/// Lagen gewinnen nichts mehr (der Stempel bleibt am Pol, wenn er dort so viel Luft hat).
const STAMP_CLEAR_MM: f64 = 2.0;

/// [140] Lage eines Stempels (`w` × `h`) unter `candidates` (Pol zuerst, dann nach Abstand zum Pol): erst mit
/// Luft (1.3 × Breite/Höhe), dann knapp im Raum; unter diesen die freieste Lage (Abstand zu `obst` bis
/// `clear`, Gleichstand → näher am Pol). Liegt jede Lage auf einem Hindernis, die mit der geringsten
/// Überdeckung (`Obstacles::overlap`, Gleichstand → mit Luft, dann näher am Pol); ohne Hindernisse wie bisher.
fn place_stamp(ring: &[[f64; 2]], candidates: &[Vec2], obst: &super::stamp_place::Obstacles, clear: f64, w: f64, h: f64) -> Option<Vec2> {
    let inside = |q: &Vec2, k: f64| crate::room_area::rect_in_ring(ring, q.x, q.y, k * w / 2.0, k * h / 2.0);
    if !obst.is_empty() {
        for k in [1.3, 1.0] {
            let mut best: Option<(f64, Vec2)> = None;
            for q in candidates.iter().filter(|q| inside(q, k)) {
                let d = obst.clearance(*q, w / 2.0, h / 2.0).min(clear);
                if d > 0.0 && best.is_none_or(|(b, _)| d > b) {
                    best = Some((d, *q));
                }
            }
            if let Some((_, q)) = best {
                return Some(q);
            }
        }
        let mut best: Option<(f64, Vec2)> = None;
        for k in [1.3, 1.0] {
            for q in candidates.iter().filter(|q| inside(q, k)) {
                let n = obst.overlap(*q, w / 2.0, h / 2.0);
                if best.is_none_or(|(b, _)| n < b) {
                    best = Some((n, *q));
                }
            }
        }
        if let Some((_, q)) = best {
            return Some(q);
        }
    }
    let fit = |k: f64| candidates.iter().copied().find(|q| inside(q, k));
    fit(1.3).or_else(|| fit(1.0))
}

fn rooms(c: &Ctx, out: &mut Vec<Primitive>, bounds: &mut Bounds, obstacles: &super::stamp_place::Obstacles) {
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
        if c.a.detail == Detail::Grob && !c.a.auto_coarse {
            continue;
        }
        // [140] Ohne eigenen Anker: Pol der Unzugänglichkeit (liegt auch in L-Räumen im Raum); passt der
        // Stempel dort nicht, rückt er im Raum dorthin, wo er passt (`stamp_candidates`).
        let pole = pv(crate::room_area::label_point(&pts));
        let at = room.stamp_anchor.unwrap_or(pole);
        let small = c.a.scale >= ROOM_STAMP_SMALL_FROM;
        // [140] Übersicht (ab 1:500, automatisch grob): nur der Name.
        let overview = c.a.auto_coarse && c.a.scale >= OVERVIEW_FROM;
        // [140] Raumstempel in Tinte (Druck ohne Schwarz-Weiss); Farbe nur aus einer Darstellungsregel
        // oder aus den Auszeichnungen des Stempel-Texts.
        let text_color = ov.color.as_deref().unwrap_or(MONO_INK);
        let (doc, extra_lines) = match &room.stamp {
            _ if overview => (doc_from_text(room.stamp.as_ref().map_or(&room.name, |s| &s.name)), vec![]),
            // [140] ab 1:200 auch eigene Stempel ohne Nutzungs-/Personenzeile.
            Some(s) if small => (room_stamp_to_doc(s), room_stamp_extra_lines(&RoomStamp { show_usage: false, occupancy: None, ..s.clone() }, res.net, room.sia_category)),
            Some(s) => (room_stamp_to_doc(s), room_stamp_extra_lines(s, res.net, room.sia_category)),
            None => {
                let mut lines = vec![StampLine { text: format!("{} m²", to_fixed(res.net, 2)), align: Align::Center }];
                if !small {
                    lines.push(StampLine { text: format!("{} · {}", sia_key(room.sia_category), sia_label(room.sia_category)), align: Align::Center });
                }
                (room.stamp_doc.clone().unwrap_or_else(|| doc_from_text(&room.name)), lines)
            }
        };
        let candidates = if room.stamp_anchor.is_some() { vec![at] } else { stamp_candidates(&pts, pole) };
        // [140] Teil 6: ohne eigenen Anker weicht der Stempel anderem Planinhalt im Raum aus (`place_stamp`).
        let obst = if room.stamp_anchor.is_some() { Default::default() } else { obstacles.within(ring_bounds(&pts)) };
        let clear = STAMP_CLEAR_MM * c.a.scale / 1000.0;
        let place = |w: f64, h: f64| place_stamp(&pts, &candidates, &obst, clear, w, h);
        let (extra_lines, base_pt, name, placed) = fit_room_stamp(&doc, extra_lines, if small { ROOM_STAMP_SMALL_PT } else { ROOM_STAMP_PT }, c.a.scale, &place);
        let at = placed.unwrap_or(at);
        let doc = name.unwrap_or(doc);
        out.push(Primitive::Text { at, doc, extra_lines, base_pt, color: text_color.into(), room_id: Some(room.id.clone()), greyed, opacity: None });
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

pub(super) fn columns(c: &Ctx, out: &mut Vec<Primitive>) {
    let p = c.p;
    let range = super::view_range::ViewRange::of(p, &c.a.floor);
    for col in p.columns.as_deref().unwrap_or(&[]).iter().filter(|k| k.floor_id == c.a.floor && c.shown(&k.category_code)) {
        let (zb, zt) = p.column_vertical_extent(col);
        let zone = range.classify(zb, zt);
        if zone == super::view_range::Zone::Hidden {
            continue;
        }
        let out_start = out.len();
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
        // [140] Geschnittene Stütze ab 1:100 schwarz ohne Schraffur (`style::solid_cut`).
        if zone == super::view_range::Zone::Cut && c.solid_cut() {
            fill = HATCH_INK.to_string();
            hatch = no_hatch();
        }
        let fp = crate::model3d::column_footprint(col);
        // [141] Geschnittene Wände, die in der (geschnittenen) Stütze enden: prioritärere Wand beschneidet
        // die Stütze, gleiches Bauteil verschmilzt (Kontur über diesen Schichten fehlt).
        let (mut clip, mut merge): (Vec<Vec<Vec2>>, Vec<crate::plan::wall_poche::WallFootprint>) = (Vec::new(), Vec::new());
        if zone == super::view_range::Zone::Cut {
            use super::wall_columns::{band_polys, end_in_column, relation, Rel};
            for w in p.walls.iter().filter(|w| w.floor_id == c.a.floor && c.shown(&w.category_code)) {
                let (zb, zt) = p.wall_vertical_extent(w);
                if range.classify(zb, zt) != super::view_range::Zone::Cut || end_in_column(w, &fp).is_none() {
                    continue;
                }
                match relation(p, w, col) {
                    Rel::Column => {}
                    Rel::Wall => {
                        let total = p.wall_thickness(w, 0.2);
                        let ro = crate::joins::reference_offset(crate::model3d::wall_reference(w), total);
                        clip.extend(band_polys(w, ro - total / 2.0, ro + total / 2.0, false));
                    }
                    Rel::Merge(lo, hi) if crate::wall_arc::WallArc::of_wall(w).is_some() => {
                        // Bogenwand: schmaler Streifen um das Stück der Schnittlinie über diesen Schichten.
                        merge.extend(super::wall_columns::arc_merge_footprint(p, w, &fp, lo, hi));
                    }
                    Rel::Merge(lo, hi) => {
                        // Footprint ohne Verlängerung über die Achsenden, knapp schmaler (bündige Stützenseiten bleiben).
                        let h = (hi - lo) / 2.0 - 1e-6;
                        let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
                        let l = dx.hypot(dy);
                        if l > 2.0 * h && h > 0.0 {
                            let (ux, uy) = (dx / l, dy / l);
                            merge.push(crate::plan::wall_poche::wall_footprint([w.start.x + ux * h, w.start.y + uy * h], [w.end.x - ux * h, w.end.y - uy * h], 2.0 * h, (lo + hi) / 2.0));
                        }
                    }
                }
            }
        }
        let pieces: Vec<Vec<Vec2>> = if clip.is_empty() {
            vec![fp]
        } else {
            let to = |q: &Vec<Vec2>| vec![q.iter().map(|v| [v.x, v.y]).collect::<Vec<[f64; 2]>>()];
            crate::polygon_bool::difference(&[to(&fp)], &clip.iter().map(to).collect::<Vec<_>>())
                .into_iter()
                .map(|pl| pl[0].iter().map(|v| Vec2 { x: v[0], y: v[1] }).collect())
                .collect()
        };
        for piece in pieces {
            if merge.is_empty() {
                out.push(polygon(piece, &fill, stroke, lw, hatch.clone(), greyed, None, Pick::Column(&col.id)));
                continue;
            }
            let ring: Vec<[f64; 2]> = piece.iter().map(|v| [v.x, v.y]).collect();
            out.push(polygon(piece, &fill, "none", 0.0, hatch.clone(), greyed, None, Pick::Column(&col.id)));
            for [a, b] in crate::plan::wall_poche::ceiling_outline_lines(&ring, &[], &merge) {
                out.push(Primitive::Line {
                    a: Vec2 { x: a[0], y: a[1] },
                    b: Vec2 { x: b[0], y: b[1] },
                    cls: "column-outline".into(),
                    weight_mm: lw,
                    dash: None,
                    zigzag: None,
                    motif: None,
                    color: Some(stroke.to_string()),
                    drawing_id: None,
                    opening_id: None,
                    stair_id: None,
                    greyed,
                    opacity: None,
                });
            }
        }
        if let Some(d) = range.restyle_dash(zone) {
            super::view_range::restyle(out, out_start, d);
        }
    }
}

// ── Extrusionen ─────────────────────────────────────────────────────────────

fn solids(c: &Ctx, out: &mut Vec<Primitive>) {
    let range = super::view_range::ViewRange::of(c.p, &c.a.floor);
    let base = c.p.floor(&c.a.floor).and_then(|f| f.base_elevation).unwrap_or(0.0);
    for s in c.p.extruded_solids.as_deref().unwrap_or(&[]).iter().filter(|s| s.level_id == c.a.floor) {
        let subtract = s.operation.as_deref() == Some("subtract");
        let zb = base + s.base_offset.unwrap_or(0.0);
        let zone = if subtract { super::view_range::Zone::Cut } else { range.classify(zb, zb + s.height) };
        if zone == super::view_range::Zone::Hidden {
            continue;
        }
        let out_start = out.len();
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
            // [G1] Schnittfläche auf Schnitthöhe (Poché); der Umriss darunter bleibt als Projektion.
            if zone == super::view_range::Zone::Cut {
                if let Some(ring) = body_cut_ring(s, zb, range.cut) {
                    let (fill, hatch) = if c.solid_cut() { (HATCH_INK, no_hatch()) } else { (super::section::BODY_FILL, super::section::section_hatch()) };
                    out.push(polygon(ring, fill, POCHE_STROKE, WALL_FALLBACK_MM, hatch, None, None, Pick::Solid(&s.id)));
                }
            }
        }
        if let Some(d) = range.restyle_dash(zone) {
            super::view_range::restyle(out, out_start, d);
        }
    }
}

/// [G1] Schnittfläche eines Körpers (Profil-Extrusion, auch verjüngt) auf der Höhe `cut` (UK `zb`):
/// das Profil, linear zum Ecken-Schwerpunkt gestaucht wie die truck-Verjüngung (`extruded_solid_spec`).
/// `None` für B-Rep-Körper (kein Netz im Kern), Abzugskörper, entartete Profile und ausserhalb.
fn body_cut_ring(s: &ExtrudedSolid, zb: f64, cut: f64) -> Option<Vec<Vec2>> {
    let n = s.points.len();
    if s.brep.is_some() || s.operation.as_deref() == Some("subtract") || n < 3 || !(s.height > 0.0) || !(cut > zb && cut < zb + s.height) {
        return None;
    }
    let t = min(1.0, max(0.0, s.taper.unwrap_or(0.0)));
    let k = 1.0 - t * (cut - zb) / s.height;
    if !(k > 1e-9) || s.points.iter().any(|q| !q.x.is_finite() || !q.y.is_finite()) {
        return None;
    }
    if t < 1e-6 {
        return Some(s.points.clone());
    }
    let cx = s.points.iter().fold(0.0, |a, q| a + q.x) / n as f64;
    let cy = s.points.iter().fold(0.0, |a, q| a + q.y) / n as f64;
    Some(s.points.iter().map(|q| Vec2 { x: cx + (q.x - cx) * k, y: cy + (q.y - cy) * k }).collect())
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
    domains_after(&c, &mut out, &mut bounds);
    out.bounds = bounds.get();
    Ok(out)
}

/// Decken bis Extrusionen (alles vor den 2D-Zeichnungen gerechnet).
fn domains_before(c: &Ctx, out: &mut DomainPrims, bounds: &mut Bounds) -> Result<(), String> {
    // Deckenspiegel ([100]): eigene Domänen aus dem Bezugsgeschoss.
    if super::ceiling_plan::domains(c, out, bounds)? {
        return Ok(());
    }
    ceilings(c, &mut out.ceilings, bounds)?;
    roofs(c, &mut out.roofs, bounds);
    super::walls::plan_walls(c, c.a.reference_lines, &mut out.walls, bounds)?;
    super::stairs::plan_stairs(c, &mut out.stairs, bounds);
    columns(c, &mut out.columns);
    solids(c, &mut out.solids);
    Ok(())
}

/// Kontext und Schnittlinien (projektglobal, nur mit `global`), zuletzt die Räume: ihre Stempel weichen dem
/// übrigen Inhalt aus ([`stamp_obstacles`]), darum nach allen anderen Domänen (Gruppen-Reihenfolge bleibt).
fn domains_after(c: &Ctx, out: &mut DomainPrims, bounds: &mut Bounds) {
    let ceiling = super::ceiling_plan::is_ceiling_level(c.p, &c.a.floor);
    if c.a.global && !ceiling {
        super::context::plan_context(c, &mut out.context);
        super::context::plan_section_lines(c, &mut out.sections);
    }
    if !ceiling {
        let obstacles = stamp_obstacles(c, out);
        rooms(c, &mut out.rooms, bounds, &obstacles);
    }
}

/// Reihenfolge der Gruppen im Plan-Puffer der Abfrage `planDomains`: Schatten und Baurecht
/// zuunterst, die Domänen, die Baurechts-Verstösse zuoberst (`extras.rs`).
pub const GROUPS: [&str; 12] = ["under", "ceilings", "roofs", "rooms", "walls", "stairs", "columns", "drawings", "solids", "context", "sections", "violations"];

/// Abfrage `planDomains` als Plan-Puffer v2 (s. `plan_buf.rs`): eine Gruppe je Domäne in der
/// Reihenfolge [`GROUPS`], Ausmass im Kopf, Inhalts-Hashes für den GPU-Chunk-Cache. Die
/// 2D-Zeichnungen schreiben direkt in den Puffer (keine Primitiv-Liste dazwischen).
pub fn plan_domains_buf(p: &Project, a: &PlanArgs) -> Result<Vec<u8>, String> {
    let c = Ctx::new(p, a);
    let mut d = DomainPrims::default();
    let mut bounds = Bounds::new();
    domains_before(&c, &mut d, &mut bounds)?;
    domains_after(&c, &mut d, &mut bounds);
    let mut w = crate::plan::buf::Writer::new(true);
    w.post = super::extras::post_for(p, a);
    let (under, violations) = extras_of(p, a);
    group_refs(&mut w, &under);
    apply_voids(p, a, &mut d);
    for g in [&d.ceilings, &d.roofs, &d.rooms, &d.walls, &d.stairs, &d.columns] {
        w.group(g);
    }
    let start = w.begin_group();
    super::drawings::plan_drawings(&c, &mut super::drawings::Sink::new(super::drawings::Target::Buf(&mut w), super::drawings::Keep::All), &mut bounds)?;
    w.end_group(start);
    for g in [&d.solids, &d.context, &d.sections] {
        w.group(g);
    }
    w.group(&violations);
    w.bounds = Some(super::extras::plan_bounds(&bounds, &super::extras::extra_bounds(p, &under, |k| c.shown(k))));
    Ok(w.finish())
}

/// Schatten/Baurecht (unterste Gruppe, mit Strichmuster-Kennungen) und Verstösse (oberste); nur
/// beim projektglobalen Aufruf (`global`).
fn extras_of(p: &Project, a: &PlanArgs) -> (Vec<(Primitive, u32)>, Vec<Primitive>) {
    if a.global {
        // [66] Baurecht (Parzelle, Baubereich, Verstösse) gehört zur Vermessung: ausgeblendete Kategorie „01" ⇒ ohne.
        let site = !(p.flat_categories().iter().any(|c| c.code == super::extras::SITE_CATEGORY) && !a.show.contains(super::extras::SITE_CATEGORY));
        super::extras::site_and_shadow(p, &a.floor, a.sun_when, a.scale, site)
    } else {
        (Vec::new(), Vec::new())
    }
}

/// Eine Gruppe aus Primitiven mit Strichmuster-Kennung.
fn group_refs(w: &mut crate::plan::buf::Writer, prims: &[(Primitive, u32)]) {
    let start = w.begin_group();
    for (q, r) in prims {
        w.push_ref(q, *r);
    }
    w.end_group(start);
}

/// Abzugskörper von allen Domänen-Listen abziehen (`extras::subtract_voids`).
fn apply_voids(p: &Project, a: &PlanArgs, d: &mut DomainPrims) {
    let z = super::extras::cut_z(p, &a.floor);
    for g in [&mut d.ceilings, &mut d.roofs, &mut d.rooms, &mut d.walls, &mut d.stairs, &mut d.columns, &mut d.solids, &mut d.context, &mut d.sections] {
        *g = super::extras::subtract_voids(std::mem::take(g), p, z);
    }
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
    use crate::plan::buf::Writer;
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
    w.post = super::extras::post_for(p, a);
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
fn assemble_cached(c: &Ctx, revs: &crate::document::Revs, cc: &mut super::cache::CtxCache, w: &mut crate::plan::buf::Writer, have: &HashSet<u64>) -> Result<Vec<super::drawings::ChunkOut>, String> {
    use super::cache::{selection_sig, RestEntry, NOT_FOR_REST};
    // [140] Raumstempel weichen Zeichnungen aus (Bemassung, Koten, Texte, Symbole): deren Stand gehört in den
    // Schlüssel, die übrigen Zeichnungen nicht.
    let stamps = revs.item_stamps("drawings2d").filter(|s| s.len() == c.p.drawings2d.len());
    let obstacle_sig = c.p.drawings2d.iter().enumerate().filter(|(_, d)| super::drawings::is_stamp_obstacle(&d.geom)).fold(0u64, |h, (i, d)| {
        let v = match stamps {
            Some(s) => s[i],
            None => serde_json::to_string(d).map_or(0, |t| t.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3))),
        };
        (h ^ v).wrapping_mul(0x9E37_79B9_7F4A_7C15).rotate_left(17)
    });
    let sig = (revs.max_except(NOT_FOR_REST), format!("{}\u{3}{}\u{3}{obstacle_sig}", selection_sig(c.a), c.a.sun_when.unwrap_or(f64::NAN).to_bits()));
    if cc.rest.as_ref().is_some_and(|r| r.sig != sig) {
        cc.rest = None;
    }
    let mut bounds = Bounds::new();
    // Neu zu erzeugen: Domänen-Listen (mit Strichmuster-Kennung), Ausmass der Domänen und der Zutaten.
    let mut fresh: Option<(Vec<Vec<(Primitive, u32)>>, Bounds, Bounds)> = None;
    if cc.rest.is_none() {
        let mut d = DomainPrims::default();
        let mut b = Bounds::new();
        domains_before(c, &mut d, &mut b)?;
        domains_after(c, &mut d, &mut b);
        let (under, violations) = extras_of(c.p, c.a);
        let extra = super::extras::extra_bounds(c.p, &under, |k| c.shown(k));
        apply_voids(c.p, c.a, &mut d);
        let plain = |g: Vec<Primitive>| g.into_iter().map(|q| (q, 0)).collect::<Vec<_>>();
        let mut lists = vec![under];
        for g in [d.ceilings, d.roofs, d.rooms, d.walls, d.stairs, d.columns, d.solids, d.context, d.sections] {
            lists.push(plain(g));
        }
        lists.push(plain(violations));
        fresh = Some((lists, b, extra));
    }
    let mut segs: Vec<crate::plan::buf::Segment> = Vec::new();
    // Liste `k`: 0 Schatten/Baurecht, 1–9 Domänen (ohne Zeichnungen), 10 Verstösse.
    let put = |w: &mut crate::plan::buf::Writer, k: usize, segs: &mut Vec<crate::plan::buf::Segment>| {
        let start = w.begin_group();
        match (&fresh, &cc.rest) {
            (Some((lists, _, _)), _) => {
                w.mark();
                for (x, r) in lists[k].iter() {
                    w.push_ref(x, *r);
                }
                segs.push(w.take_segment());
            }
            (None, Some(r)) => w.splice(&r.groups[k]),
            (None, None) => {}
        }
        w.end_group(start);
    };
    for k in 0..7 {
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
    // [140] Achsraster enden an der Gebäudegrundfläche: ihr Stand folgt auch Wänden, Körpern und Dächern.
    let stamps = revs.item_stamps("drawings2d").unwrap_or(&[]);
    let house_rev = ["walls", "extrudedSolids", "roofs"].iter().fold(0u64, |h, k| (h ^ revs.field(k)).wrapping_mul(0x0000_0100_0000_01b3));
    let stamps: std::borrow::Cow<[u64]> = if house_rev != 0 && c.p.drawings2d.iter().any(|d| matches!(d.geom, crate::model::Drawing2DGeom::Grid { .. })) {
        c.p.drawings2d.iter().zip(stamps).map(|(d, &st)| if matches!(d.geom, crate::model::Drawing2DGeom::Grid { .. }) { st ^ house_rev.rotate_left(17) } else { st }).collect::<Vec<_>>().into()
    } else {
        stamps.into()
    };
    let chunks = super::drawings::plan_drawings_chunked(c, &stamps, &mut cc.drawings, salt, have, &mut bounds)?;
    for k in 7..11 {
        put(w, k, &mut segs);
    }
    let extra = match fresh {
        Some((_, b, extra)) => {
            bounds.merge(b.raw());
            cc.rest = Some(RestEntry { sig, groups: segs, bounds: b.raw(), extra: extra.raw() });
            extra.raw()
        }
        None => {
            let r = cc.rest.as_ref().expect("Cache vorhanden");
            bounds.merge(r.bounds);
            r.extra
        }
    };
    let mut e = Bounds::new();
    e.merge(extra);
    w.bounds = Some(super::extras::plan_bounds(&bounds, &e));
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

    /// [140] Raumstempel ab 1:200 kleiner (7 pt) und ohne SIA-Zeile; bis 1:100 10 pt mit zwei Zusatzzeilen.
    #[test]
    fn raumstempel_je_massstab() {
        let p = sample();
        let stamp = |scale: f64| {
            let t = serde_json::json!({ "floor": "eg", "show": ["20", "60"], "grey": [], "scale": scale }).to_string();
            let r = plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
            r.rooms.iter().find_map(|q| match q { Primitive::Text { base_pt, extra_lines, .. } => Some((*base_pt, extra_lines.len())), _ => None }).unwrap()
        };
        assert_eq!(stamp(100.0), (ROOM_STAMP_PT, 2));
        assert_eq!(stamp(200.0), (ROOM_STAMP_SMALL_PT, 1));
        // [140] 1:500 (mittel → automatisch grob): nur der Name; Stempel in Tinte. „Wohnen" ist in 7 pt
        // (Inter-Metrik 3.9 em ≈ 9.7 mm) breiter als der 9.3 mm breite Raum → 2 mm Schrift.
        assert_eq!(stamp(500.0), (ROOM_STAMP_MIN_PT, 0));
        let t = serde_json::json!({ "floor": "eg", "show": ["20", "60"], "grey": [], "scale": 100 }).to_string();
        let r = plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
        assert!(r.rooms.iter().all(|q| !matches!(q, Primitive::Text { color, .. } if color != MONO_INK)), "Stempel in Tinte");
        // Eigener Stempel ab 1:200 ohne Nutzungszeile.
        let mut q = p.clone();
        for r in q.rooms.as_mut().unwrap() {
            r.stamp = Some(RoomStamp { name: r.name.clone(), show_floor_area: true, show_usage: true, occupancy: Some(3.0), ..Default::default() });
        }
        let lines = |scale: f64| {
            let t = serde_json::json!({ "floor": "eg", "show": ["20", "60"], "grey": [], "scale": scale }).to_string();
            plan_domains(&q, &PlanArgs::parse(1.0, &t).unwrap()).unwrap().rooms.iter().find_map(|q| match q { Primitive::Text { extra_lines, .. } => Some(extra_lines.len()), _ => None }).unwrap()
        };
        assert_eq!((lines(100.0), lines(200.0), lines(500.0)), (3, 1, 0));
    }

    /// [140] Enger Raum: erst ohne Nutzungszeile, dann ohne Fläche, dann 2 mm Schrift; grosser Raum unverändert.
    /// Breite aus der Schriftmetrik (Inter), Platz aus dem Raumumriss um den Anker.
    #[test]
    fn raumstempel_passt_in_engen_raum() {
        let extra = || vec![StampLine { text: "4.6 m²".into(), align: Align::Center }, StampLine { text: "NNF · Nebennutzfläche".into(), align: Align::Center }];
        let name = doc_from_text("E.04 Bad");
        let room = |w: f64, h: f64| move |sw: f64, sh: f64| (sw <= w && sh <= h).then_some(Vec2 { x: 0.0, y: 0.0 });
        let (e, pt, d, _) = fit_room_stamp(&name, extra(), ROOM_STAMP_PT, 100.0, &room(6.0, 4.0));
        assert_eq!((e.len(), pt, d.is_none()), (2, ROOM_STAMP_PT, true));
        let (e, pt, _, _) = fit_room_stamp(&name, extra(), ROOM_STAMP_PT, 100.0, &room(1.8, 2.4));
        assert_eq!((e.len(), pt), (1, ROOM_STAMP_PT), "ohne Nutzung");
        let (e, pt, _, _) = fit_room_stamp(&name, extra(), ROOM_STAMP_PT, 100.0, &room(1.8, 0.6));
        assert_eq!((e.len(), pt), (0, ROOM_STAMP_PT), "nur der Name");
        let (e, pt, d, at) = fit_room_stamp(&name, extra(), ROOM_STAMP_PT, 100.0, &room(1.2, 0.8));
        // In 2 mm passt die Flächenzeile wieder dazu.
        assert_eq!((e.len(), d.is_none(), at.is_some()), (1, true, true));
        assert!((pt * PT_MM - 2.0).abs() < 1e-9, "2 mm Papier");
        // 1:500, „Treppenhaus" in 3 m: auch 2 mm (1 m Schrift) zu breit → gekürzt, so dass es passt.
        let (_, _, d, _) = fit_room_stamp(&doc_from_text("Treppenhaus"), vec![], ROOM_STAMP_SMALL_PT, 500.0, &room(3.0, 4.0));
        let t = crate::text_layout::plain_text(&d.unwrap());
        assert!(t.ends_with('.') && t.len() >= 4 && t.len() <= 7, "{t}");
        let (w, _) = stamp_size_m(&doc_from_text(&t), &[], ROOM_STAMP_MIN_PT, 500.0);
        assert!(w <= 3.0, "{w}");
        // Name mit eigener Grösse (12 pt fett) schrumpft nicht mit der Schrift: in 2 mm ohne Auszeichnung.
        let s = RoomStamp { number: Some("E.03".into()), name: "Wohnen/Essen".into(), ..Default::default() };
        let (_, _, d, _) = fit_room_stamp(&room_stamp_to_doc(&s), vec![], ROOM_STAMP_PT, 100.0, &room(3.0, 2.0));
        assert_eq!(crate::text_layout::plain_text(&d.unwrap()), "E.03 Wohnen/Essen");
        // Schmale Zeichen passen besser als breite (echte Metrik statt fester Zeichenbreite).
        let (wi, _) = stamp_size_m(&doc_from_text("Lift"), &[], ROOM_STAMP_PT, 100.0);
        let (ww, _) = stamp_size_m(&doc_from_text("WMWM"), &[], ROOM_STAMP_PT, 100.0);
        assert!(wi < 0.6 * ww, "{wi} {ww}");
        assert_eq!(abbreviate("Treppenhaus", 5), "Trep.");
        assert_eq!(abbreviate("Bad", 5), "Bad");
    }

    /// [140] L-förmiger Raum ohne eigenen Anker: Stempel im Raum (Pol der Unzugänglichkeit), nicht am
    /// Schwerpunkt ausserhalb; Platz für den Stempel aus dem Flügel, nicht aus der Bounding-Box.
    #[test]
    fn raumstempel_im_l_raum() {
        let mut p = sample();
        let rooms = p.rooms.as_mut().unwrap();
        let r = rooms.iter_mut().find(|r| r.floor_id == "eg").unwrap();
        let l = [(0.0, 0.0), (8.0, 0.0), (8.0, 1.2), (1.2, 1.2), (1.2, 8.0), (0.0, 8.0)];
        r.boundary = l.iter().map(|&(x, y)| Vec2 { x: x + 50.0, y: y + 50.0 }).collect();
        r.stamp_anchor = None;
        r.stamp = None;
        let id = r.id.clone();
        let t = serde_json::json!({ "floor": "eg", "show": ["20", "60"], "grey": [], "scale": 100 }).to_string();
        let out = plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
        let (at, extra) = out.rooms.iter().find_map(|q| match q { Primitive::Text { at, room_id: Some(rid), extra_lines, .. } if *rid == id => Some((*at, extra_lines.len())), _ => None }).unwrap();
        let ring: Vec<[f64; 2]> = l.iter().map(|&(x, y)| [x + 50.0, y + 50.0]).collect();
        assert!(crate::room_area::rect_in_ring(&ring, at.x, at.y, 0.01, 0.01), "Anker im Raum: {at:?}");
        // Die Bounding-Box (8 × 8 m) hätte alle Zeilen erlaubt; der 1.2 m breite Flügel weniger.
        assert!(extra < 2, "{extra}");
        // Langer Name: rückt im Flügel vom Pol weg, bis er ganz im Raum liegt (statt gekürzt zu werden).
        p.rooms.as_mut().unwrap().iter_mut().find(|r| r.id == id).unwrap().name = "Wohnen Essen Kochen".into();
        let out = plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
        let (at, doc) = out.rooms.iter().find_map(|q| match q { Primitive::Text { at, room_id: Some(rid), doc, .. } if *rid == id => Some((*at, doc.clone())), _ => None }).unwrap();
        assert_eq!(crate::text_layout::plain_text(&doc), "Wohnen Essen Kochen");
        let (w, _) = stamp_size_m(&doc, &[], ROOM_STAMP_PT, 100.0);
        assert!(crate::room_area::rect_in_ring(&ring, at.x, at.y, w / 2.0, 0.1), "{at:?} {w}");
    }

    /// [140] Teil 6: Raumstempel ohne eigenen Anker weichen Koten, Texten, Bemassung und Treppen im Raum aus;
    /// ohne Hindernis bleibt er am Pol, mit eigenem Anker auch mit Hindernis.
    #[test]
    fn raumstempel_weicht_hindernissen_aus() {
        let mut p = sample();
        let r = p.rooms.as_mut().unwrap().iter_mut().find(|r| r.floor_id == "eg").unwrap();
        let q = [(0.0, 0.0), (7.0, 0.0), (7.0, 5.0), (0.0, 5.0)];
        r.boundary = q.iter().map(|&(x, y)| Vec2 { x: x + 50.0, y: y + 50.0 }).collect();
        r.stamp_anchor = None;
        r.stamp = None;
        let id = r.id.clone();
        let t = serde_json::json!({ "floor": "eg", "show": ["20", "60", "80"], "grey": [], "scale": 100 }).to_string();
        let a = PlanArgs::parse(1.0, &t).unwrap();
        let stamp = |p: &Project| {
            let out = plan_domains(p, &a).unwrap();
            out.rooms.iter().find_map(|q| match q { Primitive::Text { at, room_id: Some(rid), doc, extra_lines, base_pt, .. } if *rid == id => Some((*at, doc.clone(), extra_lines.clone(), *base_pt)), _ => None }).unwrap()
        };
        let (pole, ..) = stamp(&p);
        assert!((pole.x - 53.5).abs() < 1e-9 && (pole.y - 52.5).abs() < 1e-9, "ohne Hindernis am Pol: {pole:?}");
        let mk = |geom: serde_json::Value| -> Drawing2D { serde_json::from_value(serde_json::json!({ "id": "k", "type": "drawing2d", "levelId": "eg", "categoryCode": "80", "geom": geom })).unwrap() };
        // Kote und Text mitten im Raum, eine Bemassung quer durch den Raum knapp unter der Mitte.
        p.drawings2d.push(mk(serde_json::json!({ "shape": "kote", "at": { "x": 53.4, "y": 52.4 }, "value": 0.0, "kind": "okFertig", "rotation": 0.0 })));
        p.drawings2d.push(mk(serde_json::json!({ "shape": "text", "at": { "x": 53.0, "y": 52.7 }, "text": "Hinweis", "height": 0.25, "angle": 0.0 })));
        p.drawings2d.push(mk(serde_json::json!({ "shape": "dimension", "pts": [{ "x": 50.0, "y": 52.0 }, { "x": 57.0, "y": 52.0 }], "offset": 0.0 })));
        let (at, doc, extra, pt) = stamp(&p);
        assert!((at.x - pole.x).hypot(at.y - pole.y) > 0.3, "weggerückt: {at:?}");
        let (w, h) = stamp_size_m(&doc, &extra, pt, 100.0);
        let ring: Vec<[f64; 2]> = q.iter().map(|&(x, y)| [x + 50.0, y + 50.0]).collect();
        assert!(crate::room_area::rect_in_ring(&ring, at.x, at.y, w / 2.0, h / 2.0));
        let c = Ctx::new(&p, &a);
        let mut o = super::super::stamp_place::Obstacles::default();
        for q in super::super::drawings::stamp_obstacle_prims(&c) {
            o.add_prim(&q);
        }
        assert!(!o.is_empty());
        assert!(o.clearance(at, w / 2.0, h / 2.0) > 0.0, "frei: {at:?}");
        assert_eq!(extra.len(), 2, "Stempel bleibt vollständig");
        // Eigener Anker: bleibt, auch auf dem Hindernis.
        p.rooms.as_mut().unwrap().iter_mut().find(|r| r.id == id).unwrap().stamp_anchor = Some(pole);
        assert_eq!(stamp(&p).0, pole);
        // Kein freier Platz (Text über den ganzen Raum): wie bisher am Pol.
        p.rooms.as_mut().unwrap().iter_mut().find(|r| r.id == id).unwrap().stamp_anchor = None;
        p.drawings2d.clear();
        p.drawings2d.push(mk(serde_json::json!({ "shape": "text", "at": { "x": 49.0, "y": 49.0 }, "text": "XXXXXXXXXXXXXXXXXXXXXXXXXX", "height": 6.0, "angle": 0.0 })));
        assert_eq!(stamp(&p).0, pole);
    }

    /// [140] Teil 6: Treppe und Türschwenk sind Hindernisse (Strecken bzw. Sektor), Bogenwände nicht.
    #[test]
    fn stempel_hindernisse_aus_domaenen() {
        let p = sample();
        let t = serde_json::json!({ "floor": "eg", "show": ["20", "21", "30", "40", "50", "60"], "grey": [], "scale": 100 }).to_string();
        let a = PlanArgs::parse(1.0, &t).unwrap();
        let c = Ctx::new(&p, &a);
        let d = plan_domains(&p, &a).unwrap();
        let o = stamp_obstacles(&c, &d);
        let doors = d.walls.iter().filter(|q| matches!(q, Primitive::Arc { opening_id: Some(_), .. })).count();
        assert!(doors > 0 && !o.is_empty());
        // Jeder Schwenk-Mittelpunkt (Bogenmitte zur Angel hin) liegt im Hindernis.
        for q in &d.walls {
            if let Primitive::Arc { center, from, to, opening_id: Some(_), .. } = q {
                let m = Vec2 { x: (center.x * 2.0 + from.x + to.x) / 4.0, y: (center.y * 2.0 + from.y + to.y) / 4.0 };
                assert_eq!(o.clearance(m, 0.001, 0.001), 0.0);
            }
        }
    }

    /// [140] Teil 5: Schnittflächen ab 1:100 schwarz (Wände als Sammelfläche ohne Fugen/Schraffur, Stützen
    /// schwarz), 1:50 mit Schichten und Schraffur; Ebene „Schnittflächen schraffiert" übersteuert das 1:100.
    #[test]
    fn schnittflaechen_schwarz_ab_1_100() {
        let mut p = sample();
        p.columns = Some(vec![Column { id: "S1".into(), floor_id: "eg".into(), category_code: "20".into(), position: Vec2 { x: 2.0, y: 2.0 }, profile: ColumnProfile::Rect { width: 0.3, depth: 0.3 }, height: 2.6, component_id: p.components.first().map(|c| c.id.clone()), ..Default::default() }]);
        let run = |p: &Project, scale: f64| {
            let t = serde_json::json!({ "floor": "eg", "show": ["20"], "grey": [], "scale": scale }).to_string();
            plan_domains(p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap()
        };
        let walls = |r: &DomainPrims| {
            let hatched = r.walls.iter().filter(|q| matches!(q, Primitive::Polygon { hatch, .. } if hatch.pattern != HatchPattern::None)).count();
            let ink = r.walls.iter().filter(|q| matches!(q, Primitive::Polygon { fill, .. } if fill == HATCH_INK)).count();
            let joints = r.walls.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls.starts_with("layer-joint"))).count();
            (hatched, ink, joints)
        };
        let col_fill = |r: &DomainPrims| r.columns.iter().find_map(|q| match q { Primitive::Polygon { fill, hatch, column_id: Some(_), .. } => Some((fill.clone(), hatch.pattern)), _ => None }).unwrap();
        let r100 = run(&p, 100.0);
        let (h, ink, j) = walls(&r100);
        assert!(h == 0 && ink > 0 && j == 0, "1:100 schwarz: {h} {ink} {j}");
        assert_eq!(col_fill(&r100), (HATCH_INK.to_string(), HatchPattern::None));
        let r50 = run(&p, 50.0);
        let (h, ink, _) = walls(&r50);
        assert!(h > 0 && ink == 0, "1:50 schraffiert: {h} {ink}");
        assert_ne!(col_fill(&r50).0, HATCH_INK);
        p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().cut_hatch = Some(true);
        let (h, ink, _) = walls(&run(&p, 100.0));
        assert!(h > 0 && ink == 0, "Ebene schraffiert: {h} {ink}");
    }

    /// [33] Override auf Wandschichten im Grundriss: „Dämmung weiss, ohne Schraffur“ (Baustoff-Kategorie) zeigt
    /// im 1:100 die Dämmschicht als weisses Band, die übrigen Schichten schwarz ohne Fugen dazwischen; im 1:50
    /// ohne Schraffur statt der Dämmschlange. Ausgeschaltet bzw. ohne Regel wie bisher (Sammelfläche).
    #[test]
    fn override_auf_wandschichten_im_grundriss() {
        let mut p = sample();
        let run = |p: &Project, scale: f64| {
            let t = serde_json::json!({ "floor": "eg", "show": ["20"], "grey": [], "scale": scale }).to_string();
            plan_domains(p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap().walls
        };
        let fills = |prims: &[Primitive]| prims.iter().filter_map(|q| match q { Primitive::Polygon { fill, hatch, .. } => Some((fill.clone(), hatch.pattern)), _ => None }).collect::<Vec<_>>();
        let before100 = fills(&run(&p, 100.0));
        let before50 = fills(&run(&p, 50.0));
        let mut rule: OverrideRule = serde_json::from_value(serde_json::json!({"id": "d", "name": "Dämmung weiss", "enabled": false,
            "condition": {"type": "material_category", "operator": "equals", "value": "insulation"},
            "conditions": [{"type": "element_kind", "operator": "equals", "value": "wall"}],
            "actions": {"fillColor": "#ffffff", "hatch": "none"}})).unwrap();
        p.override_rules = Some(vec![rule.clone()]);
        assert_eq!(fills(&run(&p, 100.0)), before100, "Regel aus");
        rule.enabled = true;
        p.override_rules = Some(vec![rule]);
        let r100 = run(&p, 100.0);
        let f = fills(&r100);
        assert!(f.iter().any(|(c, h)| c == "#ffffff" && *h == HatchPattern::None), "{f:?}");
        assert!(f.iter().any(|(c, _)| c == HATCH_INK));
        assert!(f.iter().all(|(_, h)| *h == HatchPattern::None), "1:100 ohne Schraffur");
        // Fugen nur an der weissen Schicht (Backstein|Putz schwarz an schwarz ohne Fuge).
        let joints = r100.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "layer-joint")).count();
        assert!(joints > 0);
        let f50 = fills(&run(&p, 50.0));
        assert_eq!(f50.len(), before50.len());
        assert!(f50.iter().zip(&before50).any(|(a, b)| a.0 == "#ffffff" && a.1 == HatchPattern::None && b.1 != HatchPattern::None));
    }

    /// [140] „mittel" ab 1:200 wie „grob" (Wände als Sammelfläche), „fein" bleibt; explizit „grob" ohne Stempel.
    #[test]
    fn mittel_ab_1_200_automatisch_grob() {
        assert_eq!(effective_detail(Detail::Mittel, 100.0), (Detail::Mittel, false));
        assert_eq!(effective_detail(Detail::Mittel, 200.0), (Detail::Grob, true));
        assert_eq!(effective_detail(Detail::Fein, 500.0), (Detail::Fein, false));
        assert_eq!(effective_detail(Detail::Grob, 500.0), (Detail::Grob, false));
        let p = sample();
        let rooms = |detail: f64| {
            let t = serde_json::json!({ "floor": "eg", "show": ["20", "60"], "grey": [], "scale": 200 }).to_string();
            plan_domains(&p, &PlanArgs::parse(detail, &t).unwrap()).unwrap().rooms.iter().filter(|q| matches!(q, Primitive::Text { .. })).count()
        };
        assert!(rooms(1.0) > 0 && rooms(0.0) == 0);
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
    fn dach_ueber_schnittebene_strichpunkt() {
        let mut p = sample();
        let dashes = |p: &Project| {
            let t = serde_json::json!({ "floor": "og", "show": ["31"], "grey": [] }).to_string();
            let r = plan_domains(p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
            let v = serde_json::to_value(&r.roofs).unwrap();
            let lines: Vec<_> = v.as_array().unwrap().iter().filter(|x| x["kind"] == "line" && x["cls"].as_str().is_some_and(|c| c == "roof-eaves" || c == "roof-ridge")).cloned().collect();
            assert!(!lines.is_empty());
            lines.iter().filter(|x| !x["dash"].is_null()).count() == lines.len()
        };
        // Dach über dem Schnitt: alle Kanten strichpunktiert.
        assert!(dashes(&p));
        // Schnitt über dem First: Dachaufsicht, ausgezogen.
        p.drawing_levels.iter_mut().find(|l| l.id == "og").unwrap().cut_height = Some(9.0);
        assert!(!dashes(&p));
    }

    #[test]
    fn dachaufsicht_mit_ansichtsschraffur() {
        let mut p = sample();
        p.roofs.as_mut().unwrap()[0].roof_type_id = Some("roof-warm".into());
        let roof = p.roofs.as_ref().unwrap()[0].clone();
        let outer = p.roof_layers(&roof)[0].component_id.clone();
        let count_on = |p: &Project, floor: &str, scale: f64| {
            let t = serde_json::json!({ "floor": floor, "show": ["31"], "grey": [], "scale": scale }).to_string();
            let r = plan_domains(p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
            serde_json::to_string(&r.roofs).unwrap().matches("roof-surface-pattern").count()
        };
        let count = |p: &Project, scale: f64| count_on(p, "og", scale);
        assert_eq!(count(&p, 100.0), 0);
        let c = p.components.iter_mut().find(|c| c.id == outer).unwrap();
        c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, direction: Some(SurfacePatternDirection::Horizontal), spacing: 0.34, ..Default::default() });
        // OG-Grundriss: Schnitt 1 m über OG-Boden, das Dach liegt darüber → keine Dachaufsicht (Muster, Ansichtsschraffur).
        assert_eq!(count(&p, 100.0), 0);
        let og = p.drawing_levels.iter_mut().find(|l| l.id == "og").unwrap();
        og.cut_height = Some(9.0);
        // Schnitt über dem First: Dach von oben gesehen.
        let n = count(&p, 100.0);
        assert!(n > 10, "{n}");
        assert_eq!(count(&p, 5000.0), 0);
        // Geschoss über dem Dach: Dachaufsicht des tieferen Geschosses.
        p.drawing_levels.iter_mut().find(|l| l.id == "og").unwrap().cut_height = None;
        let mut dg = p.drawing_levels.iter().find(|l| l.id == "og").unwrap().clone();
        dg.id = "dg".into();
        dg.base_elevation = Some(5.2);
        dg.cut_height = Some(3.0);
        p.drawing_levels.push(dg);
        assert!(count_on(&p, "dg", 100.0) > 10);
        assert_eq!(count(&p, 100.0), 0);
    }

    #[test]
    fn ansichtsbereich_blendet_aus_und_strichelt() {
        let mut p = sample();
        let walls = |p: &Project| {
            let r = plan_domains(p, &args("eg", 1.0, &["20", "30", "60"])).unwrap();
            (serde_json::to_string(&r.walls).unwrap(), serde_json::to_string(&r.solids).unwrap())
        };
        let mk = |id: &str, off: f64, h: f64| ExtrudedSolid {
            id: id.into(),
            level_id: "eg".into(),
            points: vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 1.0, y: 0.0 }, Vec2 { x: 1.0, y: 1.0 }, Vec2 { x: 0.0, y: 1.0 }],
            height: h,
            base_offset: Some(off),
            ..Default::default()
        };
        p.extruded_solids = Some(vec![mk("oben", 1.4, 0.6), mk("unten", 0.0, 0.5)]);
        // Standard: unverändert, kein „view-range“.
        let (w0, s0) = walls(&p);
        assert!(!w0.contains("view-range") && !s0.contains("view-range"));
        // Oberkante 1.2 m: Schrank (ab 1.4) fällt weg.
        p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().view_top = Some(1.2);
        let (_, s1) = walls(&p);
        assert!(!s1.contains("\"oben\"") && s1.contains("\"unten\""), "{s1}");
        // Oberkante 2.0 m: Schrank bleibt, gestrichelt „über Schnitt“.
        p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().view_top = Some(2.0);
        let (_, s2) = walls(&p);
        assert!(s2.contains("\"oben\"") && s2.contains("view-range"), "{s2}");
        // Unterkante 0.6 m ohne Tiefe: Sockel (bis 0.5) entfällt; mit Tiefe gepunktet.
        let l = p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap();
        l.view_bottom = Some(0.6);
        let (_, s3) = walls(&p);
        assert!(!s3.contains("\"unten\""), "{s3}");
        p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().view_depth = Some(0.3);
        let (_, s4) = walls(&p);
        assert!(s4.contains("\"unten\"") && s4.contains("[0.04,0.08]"), "{s4}");
    }

    fn set_range(p: &mut Project, floor: &str, top: Option<f64>, bottom: Option<f64>, depth: Option<f64>) {
        let l = p.drawing_levels.iter_mut().find(|l| l.id == floor).unwrap();
        (l.view_top, l.view_bottom, l.view_depth) = (top, bottom, depth);
    }

    #[test]
    fn ansichtsbereich_decke_ueber_und_unter_schnitt() {
        let mut p = sample();
        // Galerie-Decke im EG (OK Geschoss), frei von den Wänden.
        let mut g = p.ceilings.as_ref().unwrap()[0].clone();
        g.id = "GAL".into();
        g.outline = vec![Vec2 { x: 20.0, y: 0.0 }, Vec2 { x: 22.0, y: 0.0 }, Vec2 { x: 22.0, y: 2.0 }, Vec2 { x: 20.0, y: 2.0 }];
        p.ceilings.as_mut().unwrap().push(g);
        let ceil = |p: &Project, floor: &str| serde_json::to_string(&plan_domains(p, &args(floor, 1.0, &["20", "30", "60"])).unwrap().ceilings).unwrap();
        // Ohne Grenzen: wie bisher (Umriss strichpunktiert, kein „view-range“, nicht im OG).
        let e0 = ceil(&p, "eg");
        assert!(e0.contains("\"GAL\"") && e0.contains("ceiling-outline") && !e0.contains("view-range"), "{e0}");
        assert!(!ceil(&p, "og").contains("\"GAL\""));
        // Oberkante unter der Decke: entfällt; darüber: „über Schnitt“ strichpunktiert, ohne Füllung.
        set_range(&mut p, "eg", Some(2.0), None, None);
        assert!(!ceil(&p, "eg").contains("\"GAL\""));
        set_range(&mut p, "eg", Some(3.0), None, None);
        let e1 = ceil(&p, "eg");
        assert!(e1.contains("\"GAL\"") && e1.contains("[0.4,0.12,0.0,0.12]"), "{e1}");
        // OG mit Unterkante 0.1 m und Tiefe: EG-Decke (bis OK OG-Boden) gepunktet „unter Schnitt“.
        set_range(&mut p, "og", None, Some(0.1), Some(0.5));
        let o1 = ceil(&p, "og");
        assert!(o1.contains("\"GAL\"") && o1.contains("[0.04,0.08]") && !o1.contains("[0.4,0.12,0.0,0.12]"), "{o1}");
        // Ohne Tiefe: entfällt wieder.
        set_range(&mut p, "og", None, Some(0.1), None);
        assert!(!ceil(&p, "og").contains("\"GAL\""));
    }

    #[test]
    fn ansichtsbereich_dach_ueber_und_unter_schnitt() {
        let mut p = sample();
        let roofs = |p: &Project, floor: &str| serde_json::to_string(&plan_domains(p, &args(floor, 1.0, &["31"])).unwrap().roofs).unwrap();
        // Ohne Grenzen: das OG-Dach erscheint im EG nicht.
        assert!(!roofs(&p, "eg").contains("RF1"));
        // EG mit Oberkante bis über die Traufe: Dach des OG strichpunktiert (Vordach/Dach darüber).
        set_range(&mut p, "eg", Some(9.0), None, None);
        let e1 = roofs(&p, "eg");
        assert!(e1.contains("RF1") && e1.contains("roof-eaves") && e1.contains("[0.4,0.12,0.0,0.12]"), "{e1}");
        assert!(!e1.contains("[0.04,0.08]"));
        // Oberkante darunter: weiterhin nicht.
        set_range(&mut p, "eg", Some(3.0), None, None);
        assert!(!roofs(&p, "eg").contains("RF1"));
        // Dachaufsicht eines tieferen Geschosses unter der Unterkante, innerhalb der Tiefe: gepunktet.
        let mut dg = p.drawing_levels.iter().find(|l| l.id == "og").unwrap().clone();
        dg.id = "dg".into();
        dg.base_elevation = Some(9.0);
        dg.cut_height = Some(1.0);
        p.drawing_levels.push(dg);
        let d0 = roofs(&p, "dg");
        assert!(d0.contains("RF1") && !d0.contains("[0.04,0.08]"), "{d0}");
        set_range(&mut p, "dg", None, Some(0.0), Some(9.0));
        let d1 = roofs(&p, "dg");
        assert!(d1.contains("RF1") && d1.contains("[0.04,0.08]"), "{d1}");
        set_range(&mut p, "dg", None, Some(0.0), None);
        assert!(!roofs(&p, "dg").contains("RF1"));
    }

    #[test]
    fn ansichtsbereich_oberlicht_eigene_zone() {
        let mut p = sample();
        // O1 als Oberlicht ganz über der Schnittebene (1.5–2.1 m).
        let o1 = p.openings.as_mut().unwrap().iter_mut().find(|o| o.id == "O1").unwrap();
        (o1.sill_height, o1.height) = (1.5, 0.6);
        let codes = ["20", "21", "30", "60"];
        let run = |p: &Project| {
            let r = plan_domains(p, &args("eg", 1.0, &codes)).unwrap();
            (serde_json::to_value(&r.walls).unwrap(), serde_json::to_string(&r.rooms).unwrap())
        };
        let of = |v: &serde_json::Value, id: &str| -> Vec<serde_json::Value> { v.as_array().unwrap().iter().filter(|x| x["openingId"] == id).cloned().collect() };
        let w1_polys = |v: &serde_json::Value| v.as_array().unwrap().iter().filter(|x| x["kind"] == "polygon" && x["wallId"] == "W1").count();
        let dashed = |xs: &[serde_json::Value]| xs.iter().filter(|x| x["kind"] == "line").all(|x| x["dash"] == serde_json::json!([0.4, 0.12, 0.0, 0.12]));
        // Ohne Grenzen: wie bisher (Lücke in der Wand, Symbol ausgezogen).
        let (w0, r0) = run(&p);
        assert!(!of(&w0, "O1").is_empty() && !dashed(&of(&w0, "O1")));
        assert!(!w0.to_string().contains("view-range"));
        // Oberkante 2.5 m: Oberlicht „über Schnitt“ strichpunktiert, Wand im Schnitt ohne Lücke.
        set_range(&mut p, "eg", Some(2.5), None, None);
        let (w1, r1) = run(&p);
        let s1 = of(&w1, "O1");
        assert!(s1.iter().any(|x| x["kind"] == "line") && dashed(&s1), "{s1:?}");
        assert!(w1_polys(&w1) < w1_polys(&w0), "{} {}", w1_polys(&w1), w1_polys(&w0));
        // Tür und Fenster im Schnitt bleiben ausgezogen.
        assert!(!dashed(&of(&w1, "D1")) && !dashed(&of(&w1, "O2")));
        // Oberkante 1.2 m: Oberlicht entfällt, Wand bleibt geschlossen.
        set_range(&mut p, "eg", Some(1.2), None, None);
        let (w2, r2) = run(&p);
        assert!(of(&w2, "O1").is_empty());
        assert_eq!(w1_polys(&w2), w1_polys(&w1));
        // Räume unberührt.
        assert_eq!(r0, r1);
        assert_eq!(r0, r2);
    }

    /// Gegenstück zum Oberlicht: Lüftungsschlitz ganz unter der Schnittebene (0.1–0.4 m) schliesst die
    /// geschnittene Wand, Symbol gepunktet; unter „darunter sichtbar bis“ hinaus entfällt er.
    #[test]
    fn ansichtsbereich_lueftungsschlitz_unter_schnitt() {
        let mut p = sample();
        let o1 = p.openings.as_mut().unwrap().iter_mut().find(|o| o.id == "O1").unwrap();
        (o1.sill_height, o1.height) = (0.1, 0.3);
        let codes = ["20", "21", "30", "60"];
        let run = |p: &Project| serde_json::to_value(&plan_domains(p, &args("eg", 1.0, &codes)).unwrap().walls).unwrap();
        let of = |v: &serde_json::Value, id: &str| -> Vec<serde_json::Value> { v.as_array().unwrap().iter().filter(|x| x["openingId"] == id).cloned().collect() };
        let w1_polys = |v: &serde_json::Value| v.as_array().unwrap().iter().filter(|x| x["kind"] == "polygon" && x["wallId"] == "W1").count();
        let dotted = |xs: &[serde_json::Value]| xs.iter().filter(|x| x["kind"] == "line").all(|x| x["dash"] == serde_json::json!([0.04, 0.08]));
        let w0 = run(&p);
        assert!(!of(&w0, "O1").is_empty() && !dotted(&of(&w0, "O1")));
        // Unterkante 0 m: Schlitz liegt im Bereich unter dem Schnitt → Wand geschlossen, Symbol gepunktet.
        set_range(&mut p, "eg", None, Some(0.0), None);
        let w1 = run(&p);
        let s1 = of(&w1, "O1");
        assert!(s1.iter().any(|x| x["kind"] == "line") && dotted(&s1), "{s1:?}");
        assert!(w1_polys(&w1) < w1_polys(&w0), "{} {}", w1_polys(&w1), w1_polys(&w0));
        assert!(!dotted(&of(&w1, "D1")) && !dotted(&of(&w1, "O2")));
        // Unterkante 0.5 m ohne „darunter sichtbar bis“: Schlitz entfällt, Wand bleibt geschlossen.
        set_range(&mut p, "eg", None, Some(0.5), None);
        let w2 = run(&p);
        assert!(of(&w2, "O1").is_empty());
        assert_eq!(w1_polys(&w2), w1_polys(&w1));
    }

    #[test]
    fn bodenbelag_im_og_grundriss() {
        let mut p = sample();
        let ce = p.ceilings.as_ref().unwrap()[0].clone();
        let top = crate::model3d::ceiling_type_ref(&p, &ce).unwrap().2[0].component_id.clone();
        let c = p.components.iter_mut().find(|c| c.id == top).unwrap();
        c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Grid, spacing: 0.3, height: Some(0.3), ..Default::default() });
        let count = |floor: &str| {
            let t = serde_json::json!({ "floor": floor, "show": ["30"], "grey": [], "scale": 50 }).to_string();
            let r = plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
            serde_json::to_string(&r.ceilings).unwrap().matches("floor-finish-pattern").count()
        };
        // Decke C1 (über dem EG) ist der Boden des OG: Belag im OG, nicht im EG.
        assert!(count("og") > 10);
        assert_eq!(count("eg"), 0);
    }

    #[test]
    fn puffer_gruppen_wie_domaenen() {
        let p = sample();
        let a = args("eg", 1.0, &["20", "21", "30", "40", "60"]);
        let d = plan_domains(&p, &a).unwrap();
        let buf = plan_domains_buf(&p, &a).unwrap();
        let (prims, groups, bounds) = crate::plan::buf::decode(&buf).unwrap();
        assert_eq!(groups.len(), GROUPS.len());
        let lists = [&d.ceilings, &d.roofs, &d.rooms, &d.walls, &d.stairs, &d.columns, &d.drawings.prims, &d.solids, &d.context, &d.sections];
        for ((a, b), l) in groups[1..11].iter().zip(lists) {
            assert_eq!(serde_json::to_string(&prims[*a..*b]).unwrap(), serde_json::to_string(l).unwrap());
        }
        assert!(groups[0].0 == groups[0].1 && groups[11].0 == groups[11].1, "ohne Studie und Baurecht leer");
        assert!(!d.walls.is_empty() && !d.rooms.is_empty());
        // Ausmass: Domänen und Kontext.
        let mut db = Bounds::new();
        db.merge(d.bounds.unwrap());
        assert_eq!(bounds, Some(super::super::extras::plan_bounds(&db, &super::super::extras::extra_bounds(&p, &[], |_| true))));
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
            let mut w = crate::plan::buf::Writer::new(true);
            for g in [&d.ceilings, &d.roofs, &d.rooms, &d.walls, &d.stairs, &d.columns, &d.drawings.prims, &d.solids, &d.context, &d.sections] {
                w.group(g);
            }
            w.finish();
        });
        time("JSON (früher)", &mut || {
            serde_json::to_string(&(&d.ceilings, &d.roofs, &d.rooms, &d.walls, &d.stairs, &d.columns, &d.drawings.prims, &d.solids, &d.context, &d.sections)).unwrap();
        });
    }

    /// [T2] Bogenwand im Grundriss: alle Poché-Punkte im Kreisring, Schichtflächen = Ringsektor,
    /// Umriss als Bögen (DXF-tauglich).
    #[test]
    fn bogenwand_poche_im_kreisring() {
        let mut p = sample();
        p.walls.retain(|w| w.id == "W1");
        p.openings = Some(vec![]);
        p.ceilings = Some(vec![]);
        p.rooms = Some(vec![]);
        p.walls[0].bulge = Some(1.0); // Halbkreis (0,0)→(5,0), Mitte (2.5,0), r 2.5, Scheitel oben
        // Detail „fein": alle Schichten (mittel fasst ab 1:50 dünne Schichten zusammen, [140]).
        let t = serde_json::json!({ "floor": "eg", "show": ["20"], "grey": [], "scale": 50 }).to_string();
        let r = plan_domains(&p, &PlanArgs::parse(2.0, &t).unwrap()).unwrap();
        let (r_in, r_out) = (2.5 - 0.345 / 2.0, 2.5 + 0.345 / 2.0);
        let mut band_area = 0.0;
        let mut arcs = 0;
        let mut polar = 0;
        for pr in &r.walls {
            match pr {
                Primitive::Polygon { pts, stroke, hatch, .. } => {
                    // Schichtbänder: EIN Band je Schicht mit polarer Schraffur um die Bogenmitte.
                    if let Some(c) = hatch.polar {
                        polar += 1;
                        assert!((c[0] - 2.5).abs() < 1e-9 && c[1].abs() < 1e-9 && (c[2] - 2.5).abs() < 1e-9, "{c:?}");
                    }
                    for q in pts {
                        let d = ((q.x - 2.5).powi(2) + q.y.powi(2)).sqrt();
                        assert!(d > r_in - 1e-6 && d < r_out + 1e-6 && q.y > -1e-6, "{q:?} d={d}");
                    }
                    if stroke == "none" {
                        let mut a = 0.0;
                        for i in 0..pts.len() {
                            let (u, v) = (pts[i], pts[(i + 1) % pts.len()]);
                            a += u.x * v.y - v.x * u.y;
                        }
                        band_area += a.abs() / 2.0;
                    }
                }
                Primitive::Arc { center, r: rr, .. } => {
                    arcs += 1;
                    assert!((center.x - 2.5).abs() < 1e-9 && center.y.abs() < 1e-9 && *rr > r_in - 1e-9 && *rr < r_out + 1e-9);
                }
                Primitive::Line { a, b, .. } => panic!("Gerade an der Bogenwand: {a:?} {b:?}"),
                _ => {}
            }
        }
        let exact = std::f64::consts::PI / 2.0 * (r_out * r_out - r_in * r_in);
        assert!((band_area - exact).abs() < exact * 2e-3, "{band_area} ≠ {exact}");
        assert!(arcs >= 2 * 2, "Umriss innen/aussen als Bögen (≤ 90° je Stück): {arcs}");
        assert_eq!(polar, 4, "ein polar schraffiertes Band je Schicht");
    }

    /// [G1] Körper, die die Schnitthöhe durchdringen: Poché (Schnittfläche auf Schnitthöhe, Schraffur,
    /// Schnitt-Strichstärke) über dem Umriss; verjüngt ⇒ kleinere Fläche; darüber/Abzug ⇒ keine Poché.
    #[test]
    fn koerper_poche_auf_schnitthoehe() {
        let mut p = sample();
        let mk = |id: &str, off: f64, h: f64, taper: Option<f64>, op: Option<&str>| ExtrudedSolid {
            id: id.into(),
            level_id: "eg".into(),
            points: vec![Vec2 { x: 20.0, y: 0.0 }, Vec2 { x: 22.0, y: 0.0 }, Vec2 { x: 22.0, y: 2.0 }, Vec2 { x: 20.0, y: 2.0 }],
            height: h,
            base_offset: Some(off),
            taper,
            operation: op.map(Into::into),
            ..Default::default()
        };
        p.extruded_solids = Some(vec![mk("block", 0.0, 2.0, None, None), mk("pyr", 0.0, 2.0, Some(1.0), None), mk("hoch", 1.5, 1.0, None, None), mk("void", 0.0, 2.0, None, Some("subtract"))]);
        // [140] Ebene „Schnittflächen schraffiert" (sonst ab 1:100 schwarz, s. unten).
        p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().cut_hatch = Some(true);
        let cut = super::super::extras::cut_z(&p, "eg");
        let base = p.floor("eg").and_then(|f| f.base_elevation).unwrap_or(0.0);
        assert!(cut > base && cut < base + 1.5, "Schnitthöhe {cut}");
        let r = plan_domains(&p, &args("eg", 1.0, &["20", "30", "60"])).unwrap();
        let poche: Vec<(&str, Vec<Vec2>, f64)> = r
            .solids
            .iter()
            .filter_map(|q| match q {
                Primitive::Polygon { pts, hatch, stroke_width_mm, extruded_solid_id: Some(id), .. } if hatch.pattern != HatchPattern::None => Some((id.as_str(), pts.clone(), *stroke_width_mm)),
                _ => None,
            })
            .collect();
        let ids: Vec<&str> = poche.iter().map(|q| q.0).collect();
        assert_eq!(ids, vec!["block", "pyr"], "{ids:?}");
        let area = |pts: &[Vec2]| (pts.iter().enumerate().fold(0.0, |a, (i, q)| { let n = pts[(i + 1) % pts.len()]; a + q.x * n.y - n.x * q.y }) / 2.0).abs();
        assert!((area(&poche[0].1) - 4.0).abs() < 1e-9);
        // Pyramide (Spitze bei 2 m): auf Schnitthöhe um (1 − t) gestaucht.
        let k = 1.0 - (cut - base) / 2.0;
        assert!((area(&poche[1].1) - 4.0 * k * k).abs() < 1e-9, "{}", area(&poche[1].1));
        assert!(poche.iter().all(|q| q.2 == WALL_FALLBACK_MM));
        // Darunter bleibt der Umriss (Projektion) aller vier.
        let s = serde_json::to_string(&r.solids).unwrap();
        for id in ["block", "pyr", "hoch", "void"] {
            assert!(s.contains(&format!("\"{id}\"")), "{id}");
        }
    }
}
