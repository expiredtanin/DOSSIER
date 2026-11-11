//! Plan-Domänen auf dem Dokument ([K3d]): Decken, Dächer, Räume (mit Raumstempel-Daten), Wände mit
//! Öffnungen (`walls.rs`), Treppen (`stairs.rs`), Kontext und Schnittlinien (`context.rs`), Stützen und Extrusions-Umrisse als fertige [`Primitive`] — Rust-Gegenstück zu `generatePlan/{ceilings,roofs,
//! rooms,structures}.ts` samt Filter, Override-Regeln und Stil-Auflösung aus `generatePlan.ts`.
//! Die JSON-Ausgabe gleicht Feld für Feld der früheren TS-Ausgabe.
//!
//! Sichtbarkeit/Darstellungsmodus kommen als Code-Mengen vom Aufrufer (`show`: sichtbar und
//! gezeichnet, `grey`: gedimmt), weil der Resolver in TS (UI-Zustand) lebt.

use super::overrides::{self, js_trim, Actions, Subject};
use super::prim::{HatchRender, Primitive, StampLine};
use super::model_view::StampOpts;
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
pub(super) const ROOM_STAMP_PT: f64 = 10.0;
/// [140] Raumstempel ab 1:200 (2.5 mm statt 3.5 mm, ohne SIA-Zeile): kleine Räume überlappen sonst.
pub(super) const ROOM_STAMP_SMALL_PT: f64 = 7.0;
pub(super) const ROOM_STAMP_SMALL_FROM: f64 = 200.0;
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
    /// [173] Ausdrücklich angefragte Modelldarstellung (Id einer eigenen oder eingebauten Stufe); `None` =
    /// die der Ebene (`DrawingLevel.modelViewOptionId`), sonst nur der Detailgrad (`plan/model_view.rs`).
    pub model_view: Option<String>,
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
            model_view: v.get("modelView").and_then(|m| m.as_str()).filter(|m| !m.is_empty()).map(String::from),
        })
    }

    /// [173] Wie [`PlanArgs::parse`], dazu der Basis-Detailgrad der wirksamen Modelldarstellung (angefragt
    /// oder an der Ebene): er ersetzt den angefragten Detailgrad (eingebaute Stufe bzw. `baseDetail`).
    pub fn parse_in(p: &Project, detail: f64, text: &str) -> Result<PlanArgs, String> {
        let mut a = Self::parse(detail, text)?;
        a.apply_model_view(p);
        Ok(a)
    }

    /// [173] Basis-Detailgrad der wirksamen Modelldarstellung übernehmen (ohne Modelldarstellung unverändert).
    pub fn apply_model_view(&mut self, p: &Project) {
        let base = super::model_view::selected_id(p, &self.floor, self.model_view.as_deref()).and_then(|id| super::model_view::base_of(p, id));
        if let Some(d) = base {
            let (detail, auto_coarse) = effective_detail(d, self.scale);
            self.detail = detail;
            self.auto_coarse = auto_coarse;
        }
    }
}

/// Gemeinsamer Zustand einer Plan-Erzeugung.
pub struct Ctx<'a> {
    pub p: &'a Project,
    pub a: &'a PlanArgs,
    /// Code → Kategorie (bei doppeltem Code gewinnt die letzte, wie `Map.set` in TS).
    cats: HashMap<&'a str, &'a LayerCategory>,
    /// [33] Von einer Regel „Ausblenden“ ausgeblendete Elemente (`overrides::hidden_elements`).
    hidden: HashSet<String>,
    /// [173] Wirksame eigene Modelldarstellung (`None`: eingebaute Stufe bzw. nur der Detailgrad).
    mv_sel: Option<&'a ModelViewOption>,
    /// [173] Aufgelöste Darstellungsoptionen (Modelldarstellung über dem Detailgrad).
    mv: super::model_view::Options,
    /// [179] Je Plan-Erzeugung einmal gerechnet (mehrere Domänen und alle Raster brauchen sie): Gebäuderinge,
    /// Hindernisse der Masse/Koten, der übrigen Hindernis-Zeichnungen und der Achsblasen.
    house: std::cell::OnceCell<Vec<Vec<Vec2>>>,
    drawn_obst: std::cell::OnceCell<(super::stamp_place::Obstacles, super::stamp_place::Obstacles)>,
    bubble_obst: std::cell::OnceCell<super::stamp_place::Obstacles>,
}

impl<'a> Ctx<'a> {
    pub fn new(p: &'a Project, a: &'a PlanArgs) -> Self {
        let mut cats = HashMap::new();
        for c in p.flat_categories() {
            cats.insert(c.code.as_str(), c);
        }
        let hidden = overrides::hidden_elements(p, overrides::RuleView::at(a.scale, a.rules.as_ref()).view("plan"));
        let mv_sel = super::model_view::selected_id(p, &a.floor, a.model_view.as_deref()).and_then(|id| super::model_view::find(p, id));
        let mv = super::model_view::resolve(mv_sel, a.detail, a.scale);
        Ctx { p, a, cats, hidden, mv_sel, mv, house: Default::default(), drawn_obst: Default::default(), bubble_obst: Default::default() }
    }

    /// [179] Aussenringe der Gebäudegrundfläche (`context::building_rings`), einmal je Plan.
    pub(super) fn house_rings(&self) -> &[Vec<Vec2>] {
        self.house.get_or_init(|| super::context::building_rings(self.p))
    }

    /// [179] Masse und Höhenkoten des Geschosses als Hindernisse (Achsblasen weichen ihnen aus).
    pub(super) fn dims_obstacles(&self) -> &super::stamp_place::Obstacles {
        &self.drawn_obst.get_or_init(|| super::drawings::drawn_and_dimension_obstacles(self)).1
    }

    /// [179] Hindernisse der Zeichnungen des Geschosses (Bemassung, Koten, Texte, Symbole).
    pub(super) fn drawn_obstacles(&self) -> &super::stamp_place::Obstacles {
        &self.drawn_obst.get_or_init(|| super::drawings::drawn_and_dimension_obstacles(self)).0
    }

    /// [179] Blasen und Beschriftungen der Achsraster als Hindernisse.
    pub(super) fn bubble_obstacles(&self) -> &super::stamp_place::Obstacles {
        self.bubble_obst.get_or_init(|| {
            let mut o = super::stamp_place::Obstacles::default();
            for q in super::drawings::grid_bubble_prims(self) {
                o.add_prim(&q);
            }
            o
        })
    }

    /// [173] Aufgelöste Darstellungsoptionen dieser Plan-Erzeugung (`plan/model_view.rs`).
    pub fn mv(&self) -> &super::model_view::Options {
        &self.mv
    }

    /// [173] Optionen für ein Element mit eigenem Detailgrad (Modelldarstellung bleibt, Basis wechselt).
    pub fn mv_for(&self, detail: Detail) -> std::borrow::Cow<'_, super::model_view::Options> {
        if detail == self.mv.detail {
            std::borrow::Cow::Borrowed(&self.mv)
        } else {
            std::borrow::Cow::Owned(super::model_view::resolve(self.mv_sel, detail, self.a.scale))
        }
    }

    pub fn shown(&self, code: &str) -> bool {
        self.a.show.contains(code)
    }

    /// [180] Abgeleitete Darstellung auf einer Standard-Klasse (`standards::DERIVED_CATEGORIES`): eingeblendet, oder
    /// die Klasse fehlt im Projekt.
    pub fn derived_shown(&self, code: &str) -> bool {
        self.shown(code) || !self.cats.contains_key(code)
    }

    /// [33] Element sichtbar: Kategorie eingeblendet und keine Regel „Ausblenden“ trifft es.
    pub fn vis(&self, code: &str, id: &str) -> bool {
        self.shown(code) && !self.hidden.contains(id)
    }

    /// [33] Element von einer Regel „Ausblenden“ getroffen (unabhängig von der Kategorie-Sichtbarkeit).
    pub fn rule_hidden(&self, id: &str) -> bool {
        self.hidden.contains(id)
    }

    /// [140] Schnittflächen dieser Ebene schwarz (`style::solid_cut`; Feld `cutHatch` der Ebene).
    pub fn solid_cut(&self) -> bool {
        // [173] Ebene > Modelldarstellung > schwarz.
        let cut_hatch = self.mv.cut_hatch(self.p.floor(&self.a.floor).and_then(|l| l.cut_hatch));
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
        overrides::RuleView::at(self.a.scale, self.a.rules.as_ref()).view("plan")
    }

    /// Effektive Override-Aktionen eines Elements (`overrideFor` in TS); `kind` = Bauteilart ([33]).
    pub fn overrides(&self, kind: Option<&str>, code: &str, object_name: Option<&str>) -> Actions {
        overrides::effective(self.p.override_rules.as_deref(), &Subject { layer_name: self.cat(code).map(|c| c.name.as_str()), layer_code: Some(code), object_name, element_kind: kind, ..Default::default() }, self.rule_view())
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
        hatch: Box::new(hatch),
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
    wall_footprints_of(c.p, &c.a.floor, |w| c.vis(&w.category_code, &w.id))
}

/// Wandumrisse eines Geschosses (`keep` wählt die Wände vor; 3D: alle).
pub fn wall_footprints_of(p: &Project, floor: &str, keep: impl Fn(&Wall) -> bool) -> Vec<WallFootprint> {
    p.walls
        .iter()
        .filter(|w| w.floor_id == floor && keep(w))
        .map(|w| {
            let t = p.wall_thickness(w, 0.2);
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

/// [33] Bauteilart einer Decke für die Override-Regeln: "ground_slab" oder "slab".
pub(crate) fn ceiling_kind(p: &Project, c: &Ceiling) -> &'static str {
    if ceiling_layers(p, c).is_ok_and(|l| overrides::is_ground_slab(p, c, l)) { "ground_slab" } else { "slab" }
}

/// Typname einer Decke für `object_name` (Maps in TS: letzter Eintrag je id gewinnt).
pub(crate) fn ceiling_type_name<'a>(p: &'a Project, c: &Ceiling) -> Option<&'a str> {
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
/// und Räumen gezeichnet. [156] Massstabsgerecht (`floor_finish`): automatisch erst ab 1:50/„fein",
/// Einstellung der Ebene (`floorFinish`), Regeln der Bauteilart „floor_finish"; spart Treppen, Möbel/
/// Einbauten und die Raumstempel `rooms` (schon gesetzt) aus.
fn floor_finishes(c: &Ctx, rooms: &[Primitive], out: &mut Vec<Primitive>) {
    use super::floor_finish as ff;
    let p = c.p;
    // [157] Nur Geschoss-Grundrisse (nicht die 2D-Ebene eines Schnitts/einer Ansicht).
    if p.floor(&c.a.floor).is_none_or(|l| l.kind != DrawingLevelKind::Floor) {
        return;
    }
    // [173] Ebene > Modelldarstellung > automatisch.
    let setting = c.mv().floor_finish(p.floor(&c.a.floor).and_then(|l| l.floor_finish));
    let mode = ff::show(setting, c.a.detail, c.a.scale);
    let ceilings: Vec<&Ceiling> = {
        let base = p.floor(&c.a.floor).and_then(|f| f.base_elevation).unwrap_or(0.0);
        let cut = super::extras::cut_z(p, &c.a.floor);
        p.ceilings
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|x| c.vis(&x.category_code, &x.id))
            .filter(|ce| {
                let top = p.ceiling_vertical_extent(ce).1;
                top >= base - 0.3 && top <= cut
            })
            .collect()
    };
    // [158] Räume mit eigenem Bodenbelag (Bauteil-Material): dort gilt ihr Belag statt dem der Decke.
    let own = ff::own_finish_rooms(c);
    if ceilings.is_empty() && own.is_empty() {
        return;
    }
    let own_rings: Vec<Vec<[f64; 2]>> = own.iter().map(|(_, _, ring)| ring.clone()).collect();
    // Belag je Quelle nach Darstellung und Regeln: (Stücke, Stärke, Farbe, Ebene).
    let mut jobs: Vec<(Vec<([f64; 2], [f64; 2])>, f64, String, &str, Option<String>)> = Vec::new();
    let mut wet: Option<Vec<Vec<[f64; 2]>>> = None;
    for ce in ceilings {
        // [33] Schicht-Override mit eigener Schraffur bzw. ohne Muster: kein Belagsmuster.
        if view_hatch_override(p, ceiling_view_override(c, ce, true).as_ref(), no_hatch()).1 {
            continue;
        }
        let Some((segs, w, ink, comp)) = crate::surface_pattern3d::floor_finish_segments(p, ce, c.a.scale) else { continue };
        // [156] Regeln der Bauteilart „floor_finish": ausblenden, erzwingen (`hide: false`), Farbe/Stärke.
        let ov = c.overrides(Some("floor_finish"), &ce.category_code, Some(&comp.name));
        let mode = match ov.hide {
            Some(true) => ff::Show::Off,
            Some(false) => ff::Show::All,
            None => mode,
        };
        let segs = match mode {
            ff::Show::Off => continue,
            ff::Show::All => segs,
            ff::Show::Wet => {
                if !ff::is_tile(comp) {
                    continue;
                }
                ff::clip_inside_any(&segs, wet.get_or_insert_with(|| ff::wet_rooms(c)))
            }
        };
        let segs = if own_rings.is_empty() { segs } else { ff::clip_outside_all(segs, &own_rings) };
        let w = ov.lineweight.map_or(w, |x| ff::weight(Some(x)));
        jobs.push((segs, w, ov.color.unwrap_or(ink), &ce.category_code, ov.linetype_id));
    }
    for (room, comp, ring) in &own {
        let ov = c.overrides(Some("floor_finish"), &room.category_code, Some(&comp.name));
        let show = match ov.hide {
            Some(true) => false,
            Some(false) => true,
            None => match mode {
                ff::Show::Off => false,
                ff::Show::All => true,
                ff::Show::Wet => ff::is_tile(comp) && ff::is_wet_room(room),
            },
        };
        if !show {
            continue;
        }
        let Some((segs, w)) = ff::room_segments(comp, ring, c.a.scale) else { continue };
        let w = ov.lineweight.map_or(w, |x| ff::weight(Some(x)));
        jobs.push((segs, w, ov.color.unwrap_or_else(|| ff::INK.to_string()), &room.category_code, ov.linetype_id));
    }
    // Aussparungen erst rechnen, wenn ein Belag gezeichnet wird.
    let mut excl: Option<Vec<Vec<[f64; 2]>>> = None;
    for (segs, w, ink, cat, linetype) in jobs {
        if segs.is_empty() {
            continue;
        }
        let excl = excl.get_or_insert_with(|| {
            // [155] Treppen des Geschosses stehen auf dem Belag: ihre Grundfläche spart ihn aus.
            let mut v: Vec<Vec<[f64; 2]>> = p
                .stairs
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .filter(|s| s.floor_id == c.a.floor && c.vis(&s.category_code, &s.id))
                .filter_map(|s| crate::stair::decode_params(&s.encode()))
                .flat_map(|sp| super::stair_symbol::footprint(&sp))
                .collect();
            v.extend(ff::exclusions(c, rooms));
            v
        });
        let segs = ff::clip_outside_all(segs, excl);
        let dash = overrides::linetype_dash(p, linetype.as_deref());
        let greyed = Some(c.greyed(cat));
        for (a, b) in segs {
            out.push(line(pv(a), pv(b), "floor-finish-pattern", w, dash.clone(), &ink, greyed));
        }
    }
}

fn ceilings(c: &Ctx, out: &mut Vec<Primitive>, bounds: &mut Bounds) -> Result<(), String> {
    let p = c.p;
    let range = super::view_range::ViewRange::of(p, &c.a.floor);
    // Ansichtsbereich ([36]): Decken anderer Geschosse „über Schnitt“ (bis Oberkante, z. B. Galerie
    // darüber) bzw. „unter Schnitt“ (bis „darunter sichtbar bis“) kommen dazu.
    let list: Vec<(&Ceiling, super::view_range::Zone)> = p
        .ceilings
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|x| c.vis(&x.category_code, &x.id))
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
        let ov = c.overrides(Some(ceiling_kind(p, ce)), &ce.category_code, ceiling_type_name(p, ce));
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
        // [155] Eigene Decke über der Schnittebene: nur der strichpunktierte Umriss, die Fläche deckt nicht
        // (sonst verschwänden Bodenbelag und Treppen darunter ausser im Deckenloch); Regeln wirken weiter.
        let overhead = ce.floor_id == c.a.floor && zone == super::view_range::Zone::Above;
        // [173] Ansichtsschraffur nach der Modelldarstellung (Basis: ausser „grob").
        let hatch = match (c.mv().slab.view_hatch && !overhead, comp, view_hatch_id.filter(|s| !s.is_empty())) {
            (true, Some(k), Some(id)) => resolve_hatch_or_none(p, id, None, resolve_foreground(k, ce.foreground.as_deref(), category, ce.foreground_source)),
            _ => no_hatch(),
        };
        let fill = match comp {
            _ if overhead => "none".to_string(),
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
        let outline = lov.as_ref().and_then(|o| o.outline).unwrap_or(c.mv().slab.outline);
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

/// Teil des ebenen 3D-Polygons `poly` mit z ≥ `z` (`above`) bzw. z ≤ `z` (Sutherland–Hodgman).
fn clip_z(poly: &[[f64; 3]], z: f64, above: bool) -> Vec<[f64; 3]> {
    let inside = |q: &[f64; 3]| if above { q[2] >= z } else { q[2] <= z };
    let n = poly.len();
    let mut out = Vec::with_capacity(n + 2);
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        let (ia, ib) = (inside(&a), inside(&b));
        if ia {
            out.push(a);
        }
        if ia != ib {
            let t = (z - a[2]) / (b[2] - a[2]);
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z]);
        }
    }
    out
}

/// [173] Geschnittenes Dach im Grundriss: je Dachfläche der Streifen, den die Schnittebene `cut_z` aus einer
/// Schichtlage schneidet (Lage = Dachfläche um die Normale nach innen versetzt, wie
/// `model3d::emit_roof_cut_layers`; die Punkte x der Oberfläche mit Tiefe s = (x_z − cut_z)/n_z in der Lage,
/// verschoben um −s·n). Schichten nach der Stufe: alle, vereinfacht (dünne gehen in der Nachbarschicht auf,
/// wie bei Wänden) oder nur die tragende ([`super::model_view::core_layer`]); ab 1:100 schwarz
/// (`solid_cut`) eine Fläche. Dachfenster und verschnittene Dächer/Gauben bleiben unberücksichtigt.
fn roof_cut(c: &Ctx, roof: &Roof, cut_z: f64, stroke: &str, greyed: Option<bool>, out: &mut Vec<Primitive>) {
    use super::model_view::LayerMode;
    let p = c.p;
    let layers: Vec<Layer> = p.roof_layers(roof).into_iter().filter(|l| l.thickness.is_finite() && l.thickness > 1e-6).collect();
    if layers.is_empty() || !cut_z.is_finite() {
        return;
    }
    let geo = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
    let thick: Vec<f64> = layers.iter().map(|l| l.thickness).collect();
    let mut d0 = Vec::with_capacity(thick.len());
    let mut acc = 0.0;
    for t in &thick {
        d0.push(acc);
        acc += t;
    }
    let o = c.mv();
    let black = c.solid_cut();
    // Bereiche (Schicht von..bis, Stil-Schicht).
    let ranges: Vec<(usize, usize, usize)> = match (o.roof.layers, black) {
        (LayerMode::Core, _) => match super::model_view::core_layer(p, &layers) {
            Some(k) => vec![(k, k + 1, k)],
            None => return,
        },
        (_, true) => vec![(0, layers.len(), 0)],
        (mode, false) => {
            let target = super::walls::thin_targets(&thick, o.simplify_thin_in(mode, c.a.scale), c.a.scale, o.wall.thin_mm);
            let mut r: Vec<(usize, usize, usize)> = Vec::new();
            for (i, &t) in target.iter().enumerate() {
                match r.last_mut() {
                    Some(last) if last.2 == t => last.1 = i + 1,
                    _ => r.push((i, i + 1, t)),
                }
            }
            r
        }
    };
    let category = c.cat(&roof.category_code);
    let lw = resolve_stroke_weight(None, None, category, category.map_or(WALL_FALLBACK_MM, |k| k.lw));
    for plane in &geo.planes {
        if plane.len() < 3 {
            continue;
        }
        let n = crate::model3d::plane_normal_up(plane);
        if !(n[2] > 1e-6) || n.iter().any(|v| !v.is_finite()) {
            continue;
        }
        // Schraffur längs der Traufe der Dachfläche.
        let angle = crate::jsnum::atan2(n[0], -n[1]).to_degrees();
        for &(a, b, s) in &ranges {
            let (lo, hi) = (cut_z + d0[a] * n[2], cut_z + (d0[b - 1] + thick[b - 1]) * n[2]);
            let strip = clip_z(&clip_z(plane, lo, true), hi, false);
            if strip.len() < 3 {
                continue;
            }
            let pts: Vec<Vec2> = strip
                .iter()
                .map(|x| {
                    let d = (x[2] - cut_z) / n[2];
                    Vec2 { x: x[0] - d * n[0], y: x[1] - d * n[1] }
                })
                .collect();
            let (fill, hatch) = if black {
                (HATCH_INK.to_string(), no_hatch())
            } else {
                let k = p.component_or_fallback(&layers[s].component_id);
                match resolve_hatch(p, &k.hatch_id, Some(angle), resolve_foreground(k, None, category, None), None) {
                    Some(h) => (resolve_background(k, None, category, None).unwrap_or(if h.pattern == HatchPattern::Solid { HATCH_INK } else { HATCH_PAPER }).to_string(), h),
                    None => (HATCH_PAPER.to_string(), no_hatch()),
                }
            };
            out.push(polygon(pts, &fill, stroke, lw, hatch, greyed, None, Pick::Roof(&roof.id)));
        }
    }
}

fn roofs(c: &Ctx, out: &mut Vec<Primitive>, bounds: &mut Bounds) {
    let p = c.p;
    let cut_z = super::extras::cut_z(p, &c.a.floor);
    let range = super::view_range::ViewRange::of(p, &c.a.floor);
    let floor_base = p.floor(&c.a.floor).and_then(|f| f.base_elevation).unwrap_or(0.0);
    let below = |r: &Roof| r.floor_id != c.a.floor && p.floor(&r.floor_id).is_some_and(|f| f.base_elevation.unwrap_or(0.0) < floor_base - 1e-6);
    // Ansichtsbereich ([36]): Dächer höherer Geschosse bis zur Oberkante „über Schnitt“ (Vordach, Dach darüber).
    let above = |r: &Roof| range.custom && range.top.is_some() && r.floor_id != c.a.floor && p.floor(&r.floor_id).is_some_and(|f| f.base_elevation.unwrap_or(0.0) > floor_base + 1e-6);
    for roof in p.roofs.as_deref().unwrap_or(&[]).iter().filter(|r| (r.floor_id == c.a.floor || below(r) || above(r)) && c.vis(&r.category_code, &r.id)) {
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
        if zone == super::view_range::Zone::Cut && roof.floor_id == c.a.floor {
            roof_cut(c, roof, cut_z, stroke, greyed, out);
        }
        // [173] Dachrand, First und Grate über der Schnitthöhe nach der Modelldarstellung (Basis: strichpunktiert).
        if overhead.is_some() && !c.mv().roof.overhead {
            continue;
        }
        let from_above = from_above && c.mv().roof.view_hatch;
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
        // Attika ([148]): Innenkante des Ringkörpers (Aussenkante = Traufe).
        if let Some(pp) = crate::roof_parapet::parapet(roof, &geo) {
            let n = pp.inner.len();
            for i in 0..n {
                out.push(line(pv(pp.inner[i]), pv(pp.inner[(i + 1) % n]), "roof-parapet", ROOF_EAVES_MM, overhead.clone(), stroke, greyed));
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
        if !c.vis(&o.category_code, &o.id) {
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

/// `roomStampToDoc` ([177], Archicad-Zonenstempel): Zeile 1 = Name (gross, fett), optional Zeile 2 (kursiv),
/// darunter die Raumnummer (klein). Ausrichtung je Absatz (Vorgabe links).
pub fn room_stamp_to_doc(s: &RoomStamp) -> RichTextDoc {
    let mut paragraphs = vec![Paragraph { runs: vec![run(s.name.clone(), Marks { bold: Some(true), size_pt: Some(NAME_PT), ..Default::default() })], align: s.name_align, ..Default::default() }];
    let line2 = js_trim(s.name_line2.as_deref().unwrap_or(""));
    if !line2.is_empty() {
        paragraphs.push(Paragraph { runs: vec![run(line2.into(), Marks { italic: Some(true), size_pt: Some(LINE2_PT), ..Default::default() })], align: s.line2_align, ..Default::default() });
    }
    let number = js_trim(s.number.as_deref().unwrap_or(""));
    if !number.is_empty() {
        paragraphs.push(Paragraph { runs: vec![run(number.into(), Marks { size_pt: Some(NUMBER_PT), ..Default::default() })], align: s.name_align, ..Default::default() });
    }
    RichTextDoc { version: 1.0, paragraphs, ..Default::default() }
}

/// [177] Anzahl Namens-Absätze (Name und Zeile 2) im Stempel-Dokument: darunter sitzt die Trennlinie.
fn room_stamp_name_paragraphs(s: &RoomStamp) -> usize {
    1 + usize::from(!js_trim(s.name_line2.as_deref().unwrap_or("")).is_empty())
}

/// `formatStampArea`.
pub fn format_stamp_area(area: f64, step: Option<f64>) -> String {
    match step {
        Some(st) if st > 0.0 => {
            let rounded = round(area / st) * st;
            // [171] So viele Stellen wie der Schritt (0.1 → 1, 0.25 → 2, 1 → 0; höchstens 2): gleich breite
            // Flächenzeilen im Plan („16.0 m²“ statt „16 m²“ neben „3.9 m²“).
            let decimals = [1.0, 10.0].iter().position(|&k: &f64| (st * k - round(st * k)).abs() < 1e-9).unwrap_or(2);
            to_fixed(round(rounded * 100.0) / 100.0, decimals)
        }
        _ => to_fixed(area, 2),
    }
}

/// `roomStampExtraLines`.
pub fn room_stamp_extra_lines(s: &RoomStamp, net_area: f64, sia: SiaCategory) -> Vec<StampLine> {
    room_stamp_extra_lines_mv(s, net_area, sia, &StampOpts::default())
}

/// [173] Wie `room_stamp_extra_lines`, Fläche/Kategorie: Stempel (falls gesetzt) > Stufe > Basis (Fläche ja, Kategorie nein).
pub fn room_stamp_extra_lines_mv(s: &RoomStamp, net_area: f64, sia: SiaCategory, st: &StampOpts) -> Vec<StampLine> {
    let mut lines = Vec::new();
    if StampOpts::line(s.show_floor_area, st.area, true) {
        let prefix = s.floor_area_prefix.as_deref().unwrap_or("");
        lines.push(StampLine { text: format!("{prefix}{} m²", format_stamp_area(net_area, s.rounding_step)), align: s.floor_area_align.unwrap_or(Align::Left) });
    }
    if StampOpts::line(s.show_usage, st.usage, false) {
        lines.push(StampLine { text: format!("{} · {}", sia_key(sia), sia_label(sia)), align: s.usage_align.unwrap_or(Align::Left) });
    }
    if let Some(o) = s.occupancy {
        lines.push(StampLine { text: format!("{} Pers.", js_number(o)), align: Align::Left });
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

/// [140] Eigene Schriftgrössen eines Stempel-Texts (`Marks::size_pt`) mit `k` verkleinern.
fn scale_doc_pt(mut doc: RichTextDoc, k: f64) -> RichTextDoc {
    for r in doc.paragraphs.iter_mut().flat_map(|q| q.runs.iter_mut()) {
        if let Some(pt) = r.marks.size_pt.as_mut() {
            *pt *= k;
        }
    }
    doc
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
pub(super) fn stamp_size_m(doc: &RichTextDoc, extra: &[StampLine], pt: f64, scale: f64) -> (f64, f64) {
    let rows: Vec<(&str, crate::text_layout::LineAlign)> = extra.iter().map(|l| (l.text.as_str(), crate::text_layout::LineAlign::of(Some(l.align)))).collect();
    let (w, h) = crate::text_layout::stamp_block_size(doc, &rows, pt, PT_MM * scale / 1000.0);
    let pad = 2.0 * STAMP_PAD_MM * scale / 1000.0;
    (w * STAMP_MARGIN + pad, h * STAMP_MARGIN + pad)
}

/// [140] Raumstempel einpassen. `place(breite, höhe)` sucht eine Lage im Raum, an der das Rechteck des
/// Stempels ganz im Raumumriss liegt (auch L-förmige Räume, `room_area::rect_in_ring`), und gibt sie zurück.
/// Passt der Stempel (Breite aus der Schriftmetrik, Höhe aus den Zeilen) bei `pt` nirgends, entfallen erst
/// die Nutzungszeile, dann die Flächenzeile (Zusatzzeilen von hinten). Danach, je Stufe mit allen Zusatzzeilen
/// neu ([171]): der Name auf zwei Zeilen umbrochen (an `/`, `-`, Leerzeichen; die schmalste Teilung zuerst),
/// dann die Schrift auf 2 mm Papier (je Schrift zuerst der Name mit, dann ohne eigene Schriftgrössen, dann
/// umbrochen). Passt auch das nicht, zeigt der Stempel nur die Raumnummer (`number`), erst zuletzt wird der
/// Name gekürzt (`abbreviate`: nur Wortenden, je Wort mindestens 3 Buchstaben und Punkt). Ergebnis:
/// Zusatzzeilen, Schriftgrösse (pt), Ersatz für den Namen (`Some`: ohne Auszeichnungen, umbrochen, Nummer
/// oder gekürzt, „Trep.") und die Lage (`None`: passt nirgends, der Aufrufer behält seinen Anker).
///
/// `place(breite, höhe, frei)`: mit `frei` nur Lagen ohne Überdeckung anderen Planinhalts ([140] Teil 6).
/// Zuerst sucht die ganze Reihenfolge (ohne Nummer/Kürzen) eine freie Lage — weniger Zeilen und kleinere
/// Schrift gehen vor Überdeckung; erst wenn keine Stufe frei liegt, dieselbe Reihenfolge mit Überdeckung.
fn fit_room_stamp(doc: &RichTextDoc, number: Option<&str>, extra: Vec<StampLine>, pt: f64, scale: f64, place: &dyn Fn(f64, f64, bool) -> Option<Vec2>) -> (Vec<StampLine>, f64, Option<RichTextDoc>, Option<Vec2>) {
    if !(scale > 0.0) || !scale.is_finite() {
        return (extra, pt, None, None);
    }
    let at = |doc: &RichTextDoc, extra: &[StampLine], pt: f64, free: bool| {
        let (w, h) = stamp_size_m(doc, extra, pt, scale);
        place(w, h, free)
    };
    let text = crate::text_layout::plain_text(doc);
    // Name mit eigenen Schriftgrössen (Stempel: Name 12 pt fett) schrumpft nicht mit `pt`: dann ohne
    // Auszeichnungen in der Grundschrift (Ersatz `Some`).
    let plain = doc_from_text(&text);
    // Umbrüche, schmalste Teilung zuerst.
    let mut wraps: Vec<RichTextDoc> = wrap_variants(&text).iter().map(|t| doc_from_text(t)).collect();
    let width = |d: &RichTextDoc| stamp_size_m(d, &[], ROOM_STAMP_MIN_PT, scale).0;
    wraps.sort_by(|a, b| width(a).total_cmp(&width(b)));
    let wrapped: Vec<Option<&RichTextDoc>> = wraps.iter().map(Some).collect();
    let mut steps: Vec<(Vec<Option<&RichTextDoc>>, f64)> = vec![(vec![None], pt), (vec![Some(&plain)], pt), (wrapped.clone(), pt)];
    if pt > ROOM_STAMP_MIN_PT {
        steps.extend([(vec![None], ROOM_STAMP_MIN_PT), (vec![Some(&plain)], ROOM_STAMP_MIN_PT), (wrapped, ROOM_STAMP_MIN_PT)]);
    }
    // [157] Zeilen gehen nicht für Ausweichen verloren: erst alle Zeilen frei, dann alle Zeilen mit geringster
    // Überdeckung (der Block rückt im Raum), erst wenn das Rechteck im Raum nirgends passt, entfallen Zeilen.
    for (free, drop_lines) in [(true, false), (false, false), (true, true), (false, true)] {
        for (variants, pt) in &steps {
            for &variant in variants {
                let mut e = extra.clone();
                loop {
                    if let Some(q) = at(variant.unwrap_or(doc), &e, *pt, free) {
                        return (e, *pt, variant.cloned(), Some(q));
                    }
                    if !drop_lines || e.pop().is_none() {
                        break;
                    }
                }
            }
        }
    }
    let pt = pt.min(ROOM_STAMP_MIN_PT);
    if let Some(n) = number.map(str::trim).filter(|n| !n.is_empty()) {
        let d = doc_from_text(n);
        if let Some(q) = at(&d, &[], pt, false) {
            return (Vec::new(), pt, Some(d), Some(q));
        }
    }
    let longest = text.split('\n').map(|l| l.chars().count()).max().unwrap_or(0);
    let mut shortest = None;
    for n in (2..longest).rev() {
        let Some(t) = abbreviate(&text, n) else { continue };
        let d = doc_from_text(&t);
        if let Some(q) = at(&d, &[], pt, false) {
            return (Vec::new(), pt, Some(d), Some(q));
        }
        shortest = Some(d);
    }
    (Vec::new(), pt, Some(shortest.unwrap_or(plain)), None)
}

/// [171] Namen auf zwei Zeilen umbrochen: die längste Zeile an jedem Trenner geteilt (nach `/` und `-`
/// bleibt das Zeichen am Zeilenende, ein Leerzeichen entfällt). Eine Zeile ohne Trenner gibt keine Variante.
fn wrap_variants(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let Some((li, line)) = lines.iter().enumerate().max_by_key(|(i, l)| (l.chars().count(), std::cmp::Reverse(*i))) else { return Vec::new() };
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    for (i, ch) in chars.iter().enumerate() {
        let (cut, skip) = match ch {
            '/' | '-' => (i + 1, 0),
            ' ' => (i, 1),
            _ => continue,
        };
        let (a, b): (String, String) = (chars[..cut].iter().collect(), chars[cut + skip..].iter().collect());
        if a.trim().is_empty() || b.trim().is_empty() {
            continue;
        }
        let mut ls: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        ls.splice(li..=li, [a, b]);
        out.push(ls.join("\n"));
    }
    out
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

/// Namenszeilen auf höchstens `n` Zeichen kürzen, nur am Ende eines Wortes und mit sinnvollen Längen
/// ([171]): ein gekürztes Wort zeigt mindestens 3 Buchstaben und einen Punkt. Einzelne Wörter: `n − 1`
/// Zeichen und Punkt, Leerzeichen am Schnitt weg. Zeilen aus mehreren Wörtern (Trenner Leerzeichen, `/`,
/// `-`) kürzen die Wörter der Reihe nach (jeweils das längste um ein Zeichen; kurze Wörter von höchstens
/// 4 Zeichen bleiben) — „Wohnen/Essen/Küche" wird bei Platz „Wohn./Ess./Küche", nie „Wo./Es.". `None`:
/// so kurz geht es nicht mehr sinnvoll.
fn abbreviate(text: &str, n: usize) -> Option<String> {
    text.split('\n').map(|l| abbreviate_line(l, n)).collect::<Option<Vec<_>>>().map(|v| v.join("\n"))
}

fn abbreviate_line(l: &str, n: usize) -> Option<String> {
    if l.chars().count() <= n {
        return Some(l.to_string());
    }
    // Mindestens 3 Buchstaben und ein Punkt.
    let chop = |l: &str| (n >= 4).then(|| format!("{}.", l.chars().take(n - 1).collect::<String>().trim_end()));
    // Wörter und Trenner abwechselnd: (Text, ist_Trenner).
    let mut parts: Vec<(String, bool)> = Vec::new();
    for ch in l.chars() {
        let sep = matches!(ch, ' ' | '/' | '-');
        match parts.last_mut() {
            Some((t, s)) if *s == sep && !sep => t.push(ch),
            _ => parts.push((ch.to_string(), sep)),
        }
    }
    let words: Vec<usize> = (0..parts.len()).filter(|&i| !parts[i].1).collect();
    if words.len() < 2 {
        return chop(l);
    }
    // Behaltene Zeichen je Wort; ein gekürztes Wort zeigt `keep` Zeichen und einen Punkt.
    let full: Vec<usize> = parts.iter().map(|(t, _)| t.chars().count()).collect();
    let mut keep = full.clone();
    let shown = |i: usize, keep: &[usize]| if keep[i] == full[i] { full[i] } else { keep[i] + 1 };
    let total = |keep: &[usize]| (0..parts.len()).map(|i| if parts[i].1 { full[i] } else { shown(i, keep) }).sum::<usize>();
    while total(&keep) > n {
        // Kürzbar: nach dem Schritt bleiben mindestens 3 Buchstaben.
        let next = |i: usize, keep: &[usize]| if keep[i] == full[i] { full[i].saturating_sub(2) } else { keep[i] - 1 };
        let i = *words.iter().filter(|&&i| full[i] > 4 && next(i, &keep) >= 3).max_by_key(|&&i| (shown(i, &keep), keep[i] == full[i], std::cmp::Reverse(i)))?;
        keep[i] = next(i, &keep);
    }
    Some(
        parts
            .iter()
            .enumerate()
            .map(|(i, (t, sep))| if *sep || keep[i] == full[i] { t.clone() } else { format!("{}.", t.chars().take(keep[i]).collect::<String>()) })
            .collect(),
    )
}

/// [140] Hindernisse für Raumstempel aus den schon erzeugten Domänen: Treppen (alle Striche), Türschwenk-Bögen,
/// Stützen, Beschriftungen des Kontexts (Höhenlinien-Koten), Schnittführungen und Dachlinien ([157]) und die Zeichnungen, denen Stempel ausweichen
/// (Bemassung, Koten, Texte, Symbole; `drawings::stamp_obstacle_prims`).
#[cfg(test)]
fn stamp_obstacles(c: &Ctx, d: &DomainPrims) -> super::stamp_place::Obstacles {
    stamp_obstacles_with(d, drawing_obstacles(c))
}

/// [150] Hindernisse der Zeichnungen des Geschosses (Bemassung, Koten, Texte, Symbole) — für Raumstempel und
/// Höhenlinien-Beschriftungen, einmal gerechnet.
fn drawing_obstacles(c: &Ctx) -> super::stamp_place::Obstacles {
    c.drawn_obstacles().clone()
}

/// Hindernisse der Raumstempel: `drawn` (Zeichnungen) und die Domänen.
fn stamp_obstacles_with(d: &DomainPrims, drawn: super::stamp_place::Obstacles) -> super::stamp_place::Obstacles {
    let mut o = drawn;
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
    // [157] Dachlinien (First, Grat, Kehle, Traufe, Bruch; ohne Flächenmuster): kein Stempel auf dem First.
    for q in &d.roofs {
        if matches!(q, Primitive::Line { cls, .. } if cls.starts_with("roof-") && cls != "roof-surface-pattern") {
            o.add_prim(q);
        }
    }
    // [157] Schnittführungen (Linie, Marken, Beschriftung): der Stempel steht neben der Linie, nicht darauf.
    for q in &d.sections {
        if matches!(q, Primitive::Line { .. } | Primitive::DrawingText { .. }) {
            o.add_prim(q);
        }
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
/// `free`: nur eine freie Lage (Abstand > 0), sonst `None`.
fn place_stamp(ring: &[[f64; 2]], candidates: &[Vec2], obst: &super::stamp_place::Obstacles, clear: f64, w: f64, h: f64, free: bool) -> Option<Vec2> {
    let inside = |q: &Vec2, k: f64| crate::room_area::rect_in_ring(ring, q.x, q.y, k * w / 2.0, k * h / 2.0);
    if !obst.is_empty() {
        for k in [1.3, 1.0] {
            let mut best: Option<(f64, Vec2)> = None;
            for q in candidates.iter().filter(|q| inside(q, k)) {
                // [179] Wie `obst.clearance(..).min(clear)`, aber ohne ferne Hindernisse und ohne Lagen, die `best` nicht schlagen.
                let d = obst.clearance_capped(*q, w / 2.0, h / 2.0, clear, best.map_or(0.0, |(b, _)| b));
                if d > 0.0 && best.is_none_or(|(b, _)| d > b) {
                    best = Some((d, *q));
                    // Mehr als `clear` zählt nicht: keine spätere Lage schlägt das (strikt grösser).
                    if d >= clear {
                        break;
                    }
                }
            }
            if let Some((_, q)) = best {
                return Some(q);
            }
        }
        if free {
            return None;
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
    for room in c.p.rooms.as_deref().unwrap_or(&[]).iter().filter(|r| r.floor_id == c.a.floor && c.vis(&r.category_code, &r.id)) {
        for q in &room.boundary {
            bounds.acc(q.x, q.y);
        }
        let ov = c.overrides(Some("room"), &room.category_code, Some(&room.name));
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
        // [173] Zeilen nach der Modelldarstellung: die Einstellung am Stempel geht vor (`StampOpts::line`); die
        // Raumnummer zeigt die Stufe (Basis ja), der Stempel liefert nur den Text.
        let st = &c.mv().stamp;
        let stamp: Option<std::borrow::Cow<RoomStamp>> = room.stamp.as_ref().map(|s| if st.show_number() { std::borrow::Cow::Borrowed(s) } else { std::borrow::Cow::Owned(RoomStamp { number: None, ..s.clone() }) });
        let (doc, extra_lines) = match stamp.as_deref() {
            _ if overview => (doc_from_text(room.stamp.as_ref().map_or(&room.name, |s| &s.name)), vec![]),
            // [140] ab 1:200 auch eigene Stempel ohne Nutzungs-/Personenzeile.
            Some(s) if small => (room_stamp_to_doc(s), room_stamp_extra_lines_mv(&RoomStamp { show_usage: Some(false), occupancy: None, ..s.clone() }, res.net, room.sia_category, st)),
            Some(s) => (room_stamp_to_doc(s), room_stamp_extra_lines_mv(s, res.net, room.sia_category, st)),
            None => {
                // [177] Ohne Stempel-Einstellungen: Name, Fläche, linksbündig; die SIA-Kategorie ist Attribut des Raums.
                // [173] Fläche und SIA-Kategorie nach der Stufe (Basis: Fläche ja, Kategorie nein).
                let mut lines = Vec::new();
                if StampOpts::line(None, st.area, true) {
                    lines.push(StampLine { text: format!("{} m²", to_fixed(res.net, 2)), align: Align::Left });
                }
                if StampOpts::line(None, st.usage, false) {
                    lines.push(StampLine { text: format!("{} · {}", sia_key(room.sia_category), sia_label(room.sia_category)), align: Align::Left });
                }
                (room.stamp_doc.clone().unwrap_or_else(|| doc_from_text(&room.name)), lines)
            }
        };
        // [140] Ab 1:200 auch eigene Stempel verkleinert wie automatische: eigene Schriftgrössen (Name 12 pt,
        // Nummer 9 pt, Auszeichnungen) im Verhältnis der Grundschrift 7/10, keine Belagszeile.
        let doc = if small && !overview { scale_doc_pt(doc, ROOM_STAMP_SMALL_PT / ROOM_STAMP_PT) } else { doc };
        // [158] Belagszeile (Einstellung am Stempel, Vorgabe aus): Bodenbelag des Raums.
        let mut extra_lines = extra_lines;
        // [173] Lichte Höhe nach der Stufe (Basis nein; auch ab 1:200, wenn die Stufe sie verlangt).
        if !overview && StampOpts::line(None, st.height, false) {
            extra_lines.push(StampLine { text: format!("LH {} m", to_fixed(crate::room_book::clear_height(c.p, room), 2)), align: Align::Left });
        }
        // Belag: Stempel (nicht ab 1:200) > Stufe > nein.
        let finish = match room.stamp.as_ref().and_then(|s| s.show_finish) {
            Some(v) => v && !small,
            None => StampOpts::line(None, st.finish, false),
        };
        if !overview && finish {
            let label = crate::room_book::finish_label(c.p, room.floor_finish.as_deref());
            if !label.is_empty() {
                extra_lines.push(StampLine { text: label, align: Align::Left });
            }
        }
        let candidates = if room.stamp_anchor.is_some() { vec![at] } else { stamp_candidates(&pts, pole) };
        // [140] Teil 6: ohne eigenen Anker weicht der Stempel anderem Planinhalt im Raum aus (`place_stamp`).
        let obst = if room.stamp_anchor.is_some() { Default::default() } else { obstacles.within(ring_bounds(&pts)) };
        let clear = STAMP_CLEAR_MM * c.a.scale / 1000.0;
        let place = |w: f64, h: f64, free: bool| place_stamp(&pts, &candidates, &obst, clear, w, h, free);
        let number = stamp.as_deref().and_then(|s| s.number.clone());
        let (extra_lines, base_pt, name, placed) = fit_room_stamp(&doc, number.as_deref(), extra_lines, if small { ROOM_STAMP_SMALL_PT } else { ROOM_STAMP_PT }, c.a.scale, &place);
        let at = placed.unwrap_or(at);
        let name_replaced = name.clone();
        let doc = name.unwrap_or(doc);
        // [177] Trennlinie unter dem Namen (Einstellung am Stempel, Vorgabe aus), nur im unveränderten Block.
        if let (Some(s), None, false, false) = (stamp.as_deref(), &name_replaced, overview, small) {
            if StampOpts::line(s.show_divider, st.divider, false) {
                let rows: Vec<(&str, crate::text_layout::LineAlign)> = extra_lines.iter().map(|l| (l.text.as_str(), crate::text_layout::LineAlign::of(Some(l.align)))).collect();
                let placed = crate::text_layout::stamp_block(&doc, &rows, base_pt, PT_MM, "#000000", 0.0);
                let np = room_stamp_name_paragraphs(s);
                if placed.len() > np {
                    let (w, _) = crate::text_layout::stamp_block_size(&doc, &rows, base_pt, PT_MM);
                    let k = c.a.scale / 1000.0;
                    let next = &placed[np];
                    let fs = next.line.tspans.first().map_or(0.0, |t| t.font_size);
                    // Mitte zwischen Grundlinie des Namens und Oberkante der nächsten Zeile.
                    // Modell-y zeigt nach oben, die Blockzeilen wachsen nach unten.
                    let y = at.y - (placed[np - 1].y + (next.y - placed[np - 1].y - 0.7 * fs).max(0.0) / 2.0 + 0.15 * fs) * k;
                    out.push(line(Vec2 { x: at.x - w / 2.0 * k, y }, Vec2 { x: at.x + w / 2.0 * k, y }, "void", DIVIDER_MM, Some(None), text_color, greyed));
                }
            }
        }
        out.push(Primitive::Text { at, doc, extra_lines, base_pt, color: text_color.into(), room_id: Some(room.id.clone()), greyed, opacity: None });
    }
}

/// [177] Strichstärke der Trennlinie im Raumstempel (Papier-mm).
const DIVIDER_MM: f64 = 0.13;

/// [140] Gezeichnete Lage der Raumstempel ohne eigenen Anker (Geschoss `floor`, sichtbare Ebenen `show`,
/// Massstab 1:`scale`, Detail „mittel"): dieselbe Einpassung wie im Grundriss (`rooms`, weicht Hindernissen aus).
/// Für den Fang-Punkt des Stempels (`snap_model`). Leer, wenn alle Räume des Geschosses einen Anker haben.
pub fn room_stamp_spots(p: &Project, floor: &str, show: &HashSet<String>, scale: f64) -> HashMap<String, Vec2> {
    let mut out = HashMap::new();
    let free = |r: &&Room| r.floor_id == floor && r.stamp_anchor.is_none() && r.boundary.len() >= 3 && show.contains(&r.category_code);
    if !(scale.is_finite() && scale > 0.0) || !p.rooms.as_deref().unwrap_or(&[]).iter().any(|r| free(&r)) {
        return out;
    }
    let (detail, auto_coarse) = effective_detail(Detail::Mittel, scale);
    let a = PlanArgs { floor: floor.to_string(), detail, show: show.clone(), grey: HashSet::new(), reference_lines: false, global: true, scale, for_print: false, compact: false, mono: false, sun_when: None, auto_coarse, rules: None, model_view: None };
    let Ok(d) = plan_domains(p, &a) else { return out };
    for q in &d.rooms {
        if let Primitive::Text { at, room_id: Some(id), .. } = q {
            out.insert(id.clone(), *at);
        }
    }
    out
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
    for col in p.columns.as_deref().unwrap_or(&[]).iter().filter(|k| k.floor_id == c.a.floor && c.vis(&k.category_code, &k.id)) {
        let (zb, zt) = p.column_vertical_extent(col);
        let zone = range.classify(zb, zt);
        if zone == super::view_range::Zone::Hidden {
            continue;
        }
        let out_start = out.len();
        let greyed = Some(c.greyed(&col.category_code));
        let category = c.cat(&col.category_code);
        let ov = c.overrides(Some("column"), &col.category_code, Some(&column_label(col)));
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
        // [140] Geschnittene Stütze ab 1:100 schwarz ohne Schraffur (`style::solid_cut`); [173] die
        // Modelldarstellung wählt Schraffur, schwarz oder leer.
        use super::model_view::CutFill;
        match c.mv().column_fill {
            Some(CutFill::Material) => {}
            Some(CutFill::Solid) => {
                fill = HATCH_INK.to_string();
                hatch = no_hatch();
            }
            Some(CutFill::Empty) => {
                fill = HATCH_PAPER.to_string();
                hatch = no_hatch();
            }
            None if zone == super::view_range::Zone::Cut && c.solid_cut() => {
                fill = HATCH_INK.to_string();
                hatch = no_hatch();
            }
            None => {}
        }
        let fp = crate::model3d::column_footprint(col);
        // [141] Nach Schnitthöhe: eine Stütze ganz unter (oder über) der Schnittebene ist nicht geschnitten —
        // Ansichtskante ohne Füllung und Schraffur (unsichtbare Pick-Fläche), unter geschnittenen Wänden
        // verdeckt (`hide_column_views`).
        if zone != super::view_range::Zone::Cut {
            let n = fp.len();
            out.push(polygon(fp.clone(), "none", "none", 0.0, no_hatch(), greyed, None, Pick::Column(&col.id)));
            for i in 0..n {
                out.push(line(fp[i], fp[(i + 1) % n], "column-view", LAYER_JOINT_MM * c.a.detail.layer_factor(), None, stroke, greyed));
            }
            if let Some(d) = range.restyle_dash(zone) {
                super::view_range::restyle(out, out_start, d);
            }
            continue;
        }
        // [141] Geschnittene Wände, die in der (geschnittenen) Stütze enden: prioritärere Wand beschneidet
        // die Stütze, gleiches Bauteil verschmilzt (Kontur über diesen Schichten fehlt).
        let (mut clip, mut merge): (Vec<Vec<Vec2>>, Vec<crate::plan::wall_poche::WallFootprint>) = (Vec::new(), Vec::new());
        if zone == super::view_range::Zone::Cut {
            use super::wall_columns::{band_polys, relation, wall_meets_column, Rel};
            for w in p.walls.iter().filter(|w| w.floor_id == c.a.floor && c.vis(&w.category_code, &w.id)) {
                let (zb, zt) = p.wall_vertical_extent(w);
                if range.classify(zb, zt) != super::view_range::Zone::Cut || !wall_meets_column(p, w, &fp) {
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
                    color: Some(stroke.to_string().into()),
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
    // [180] Körper und Abzugskörper liegen wie jedes Bauteil auf ihrer Klasse (die Aussparung wirkt unabhängig davon).
    for s in c.p.extruded_solids.as_deref().unwrap_or(&[]).iter().filter(|s| s.level_id == c.a.floor && c.vis(&s.category_code, &s.id)) {
        let greyed = c.greyed(&s.category_code).then_some(true);
        let subtract = s.operation.as_deref() == Some("subtract");
        let zb = base + s.base_offset.unwrap_or(0.0);
        let zone = if subtract { super::view_range::Zone::Cut } else { range.classify(zb, zb + s.height) };
        if zone == super::view_range::Zone::Hidden {
            continue;
        }
        let out_start = out.len();
        if s.operation.as_deref() == Some("subtract") {
            out.push(polygon(s.points.clone(), "none", "none", 0.0, no_hatch(), greyed, None, Pick::Solid(&s.id)));
            let n = s.points.len();
            let seg = |a: Vec2, b: Vec2, dash: Option<Vec<f64>>| line(a, b, "void", SYMBOL_HAIRLINE_MM, Some(dash), EXTRUSION_STROKE, greyed);
            for i in 0..n {
                out.push(seg(s.points[i], s.points[(i + 1) % n], Some(vec![2.0, 1.0])));
            }
            if n == 4 {
                out.push(seg(s.points[0], s.points[2], None));
                out.push(seg(s.points[1], s.points[3], None));
            }
        } else {
            out.push(polygon(s.points.clone(), "none", EXTRUSION_STROKE, SYMBOL_HAIRLINE_MM, no_hatch(), greyed, None, Pick::Solid(&s.id)));
            // [G1] Schnittfläche auf Schnitthöhe (Poché); der Umriss darunter bleibt als Projektion.
            if zone == super::view_range::Zone::Cut {
                if let Some(ring) = body_cut_ring(s, zb, range.cut) {
                    let (fill, hatch) = if c.solid_cut() { (HATCH_INK, no_hatch()) } else { (super::section::BODY_FILL, super::section::section_hatch()) };
                    out.push(polygon(ring, fill, POCHE_STROKE, WALL_FALLBACK_MM, hatch, greyed, None, Pick::Solid(&s.id)));
                }
            }
        }
        // [152] Über der Schnitthöhe immer als Überkopf-Linie (Träger, Pfetten), auch ohne eigenen Ansichtsbereich.
        let dash = if zone == super::view_range::Zone::Above { Some(&super::view_range::ABOVE_DASH[..]) } else { range.restyle_dash(zone) };
        if let Some(d) = dash {
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
    // [141] Wandflächen unter geschnittenen Stützen ausgespart; Ansichtskanten nicht geschnittener Stützen
    // unter geschnittenen Wänden verdeckt.
    let filled = |ps: &[Primitive], col: bool| -> Vec<Vec<Vec2>> {
        ps.iter()
            .filter_map(|q| match q {
                Primitive::Polygon { pts, fill, column_id, wall_id, .. } if fill != "none" && (if col { column_id.is_some() } else { wall_id.is_some() }) => Some(pts.clone()),
                _ => None,
            })
            .collect()
    };
    super::wall_columns::carve_walls_under_columns(&mut out.walls, &filled(&out.columns, true));
    super::wall_columns::hide_column_views(&mut out.columns, &filled(&out.walls, false));
    // [149] Bäume (Planzeichen) mit den Stützen in einer Gruppe.
    super::trees::plan_trees(c, &mut out.columns);
    solids(c, &mut out.solids);
    Ok(())
}

/// Kontext und Schnittlinien (projektglobal, nur mit `global`), zuletzt die Räume: ihre Stempel weichen dem
/// übrigen Inhalt aus ([`stamp_obstacles`]), darum nach allen anderen Domänen (Gruppen-Reihenfolge bleibt).
fn domains_after(c: &Ctx, out: &mut DomainPrims, bounds: &mut Bounds) {
    let ceiling = super::ceiling_plan::is_ceiling_level(c.p, &c.a.floor);
    if ceiling {
        return;
    }
    let drawn = drawing_obstacles(c);
    if c.a.global {
        // [150] Schnittführungen zuerst: ihre Beschriftungen sind Hindernisse der Höhenlinien-Beschriftungen.
        super::context::plan_section_lines(c, &mut out.sections);
        // [157] Marken und Beschriftungen der Schnittführungen gehören zum Ausmass (sonst oben abgeschnitten).
        for q in &out.sections {
            match q {
                Primitive::Line { a, b, .. } => {
                    bounds.acc(a.x, a.y);
                    bounds.acc(b.x, b.y);
                }
                Primitive::DrawingText { at, text, height_m, .. } => {
                    bounds.acc(at.x, at.y);
                    bounds.acc(at.x + crate::text_layout::text_width_em(text, false) * height_m, at.y + height_m);
                }
                _ => {}
            }
        }
    }
    // Räume vor dem Kontext: Stempel ausserhalb ihres Raums (eigener Anker im Gelände) sind Hindernisse der
    // Höhenlinien-Beschriftungen; Stempel im Raum liegen im Fussabdruck, wo keine Beschriftung steht.
    let obstacles = stamp_obstacles_with(out, drawn.clone());
    rooms(c, &mut out.rooms, bounds, &obstacles);
    if c.a.global {
        let mut o = drawn;
        for q in out.sections.iter().filter(|q| matches!(q, Primitive::DrawingText { .. })) {
            o.add_prim(q);
        }
        for r in outside_stamps(c, &out.rooms) {
            o.area(r);
        }
        super::context::plan_context_with(c, &mut out.context, &o);
    }
    // [156] Bodenbelag nach den Raumstempeln (spart sie aus), zuunterst in der Gruppe der Decken.
    let mut finish = Vec::new();
    floor_finishes(c, &out.rooms, &mut finish);
    if !finish.is_empty() {
        out.ceilings.splice(0..0, finish);
    }
}

/// [150] Rechtecke der Raumstempel, deren Mitte ausserhalb ihres Raums liegt (eigener Anker im Gelände).
fn outside_stamps(c: &Ctx, rooms: &[Primitive]) -> Vec<Vec<[f64; 2]>> {
    let mut out = Vec::new();
    for q in rooms {
        let Primitive::Text { at, doc, extra_lines, base_pt, room_id: Some(id), .. } = q else { continue };
        let Some(room) = c.p.rooms.as_deref().unwrap_or(&[]).iter().find(|r| &r.id == id) else { continue };
        let ring: Vec<[f64; 2]> = room.boundary.iter().map(|v| [v.x, v.y]).collect();
        if ring.len() < 3 || crate::surface_pattern::point_in([at.x, at.y], &ring) {
            continue;
        }
        let (w, h) = stamp_size_m(doc, extra_lines, *base_pt, c.a.scale);
        if w.is_finite() && h.is_finite() {
            out.push(vec![[at.x - w / 2.0, at.y - h / 2.0], [at.x + w / 2.0, at.y - h / 2.0], [at.x + w / 2.0, at.y + h / 2.0], [at.x - w / 2.0, at.y + h / 2.0]]);
        }
    }
    out
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
        let site = crate::standards::derived_visible(p, super::extras::SITE_CATEGORY, |k| a.show.contains(k));
        // [180] Sonnenschatten auf der Klasse „Schatten".
        let sun_when = a.sun_when.filter(|_| crate::standards::derived_visible(p, crate::standards::SHADOW_CATEGORY, |k| a.show.contains(k)));
        super::extras::site_and_shadow(p, &a.floor, sun_when, a.scale, site)
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
    let obstacle_sig = c.p.drawings2d.iter().enumerate().filter(|(_, d)| super::drawings::is_stamp_obstacle(&d.geom) || matches!(d.geom, Drawing2DGeom::Grid { .. })).fold(0u64, |h, (i, d)| {
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
#[path = "perf_tests.rs"]
mod perf_tests;

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

    /// [177] Archicad-Zonenstempel: Name (gross, fett), darunter Nummer, darunter Fläche, alles linksbündig;
    /// SIA-Kategorie nur auf Wunsch; Trennlinie nur auf Wunsch.
    #[test]
    fn raumstempel_archicad_aufbau() {
        let p = sample();
        let run = |s: Option<RoomStamp>| {
            let mut q = p.clone();
            for r in q.rooms.as_mut().unwrap() {
                r.stamp = s.clone().map(|s| RoomStamp { name: r.name.clone(), ..s });
            }
            let t = serde_json::json!({ "floor": "eg", "show": ["20", "60"], "grey": [], "scale": 100 }).to_string();
            let d = plan_domains(&q, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
            let text = d.rooms.iter().find_map(|q| match q { Primitive::Text { doc, extra_lines, .. } => Some((doc.clone(), extra_lines.clone())), _ => None }).unwrap();
            let lines = d.rooms.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "void")).count();
            (text, lines)
        };
        let base = RoomStamp { number: Some("E.03".into()), show_floor_area: Some(true), ..Default::default() };
        let ((doc, extra), lines) = run(Some(base.clone()));
        let paras: Vec<String> = doc.paragraphs.iter().map(|p| p.runs.iter().map(|r| r.text.clone()).collect::<String>()).collect();
        assert_eq!(paras.len(), 2);
        assert_eq!(paras[1], "E.03", "Nummer unter dem Namen");
        assert!(doc.paragraphs.iter().all(|p| p.align.is_none() || p.align == Some(Align::Left)));
        assert_eq!(extra.len(), 1);
        assert!(extra[0].text.ends_with(" m²") && extra[0].align == Align::Left, "{extra:?}");
        assert!(extra.iter().all(|l| !l.text.contains('·')), "keine SIA-Kategorie im Stempel");
        assert_eq!(lines, 0, "keine Trennlinie");
        // Ohne Stempel: Fläche links, keine Kategorie.
        let ((_, extra), _) = run(None);
        assert!(extra.iter().all(|l| l.align == Align::Left && !l.text.contains('·')));
        // Kategorie nur eingeschaltet.
        let ((_, extra), _) = run(Some(RoomStamp { show_usage: Some(true), ..base.clone() }));
        assert_eq!(extra.len(), 2);
        assert!(extra[1].text.contains('·') && extra[1].align == Align::Left);
        // Trennlinie eingeschaltet: je Raum eine Linie.
        let (_, with) = run(Some(RoomStamp { show_divider: Some(true), ..base }));
        assert_eq!(with, 1, "eine Linie je Raum (ein Raum sichtbar)");
        // Die Linie liegt zwischen Namen und Nummer (Modell-y nach oben: unter dem Namen = kleineres y).
        let mut q = p.clone();
        for r in q.rooms.as_mut().unwrap() {
            r.stamp = Some(RoomStamp { name: r.name.clone(), show_divider: Some(true), number: Some("E.03".into()), show_floor_area: Some(true), ..Default::default() });
        }
        let t = serde_json::json!({ "floor": "eg", "show": ["20", "60"], "grey": [], "scale": 100 }).to_string();
        let d = plan_domains(&q, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
        let at = d.rooms.iter().find_map(|q| match q { Primitive::Text { at, .. } => Some(*at), _ => None }).unwrap();
        let ly = d.rooms.iter().find_map(|q| match q { Primitive::Line { a, .. } => Some(a.y), _ => None }).unwrap();
        // Name 12 pt: Grundlinie 3.53 mm Papier über dem Blockmittelpunkt; Nummer 1.06 mm darunter (1:100 → ×0.1 m).
        assert!(ly < at.y + 0.353 && ly > at.y - 0.106, "{ly} {}", at.y);
    }

    /// [140] Raumstempel ab 1:200 kleiner (7 pt); bis 1:100 10 pt mit der Flächenzeile.
    #[test]
    fn raumstempel_je_massstab() {
        let p = sample();
        let stamp = |scale: f64| {
            let t = serde_json::json!({ "floor": "eg", "show": ["20", "60"], "grey": [], "scale": scale }).to_string();
            let r = plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
            r.rooms.iter().find_map(|q| match q { Primitive::Text { base_pt, extra_lines, .. } => Some((*base_pt, extra_lines.len())), _ => None }).unwrap()
        };
        // [177] Ohne Stempel-Einstellungen nur die Fläche: die SIA-Kategorie ist Attribut des Raums, nicht des Stempels.
        assert_eq!(stamp(100.0), (ROOM_STAMP_PT, 1));
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
            r.stamp = Some(RoomStamp { name: r.name.clone(), show_floor_area: Some(true), show_usage: Some(true), occupancy: Some(3.0), ..Default::default() });
        }
        let lines = |scale: f64| {
            let t = serde_json::json!({ "floor": "eg", "show": ["20", "60"], "grey": [], "scale": scale }).to_string();
            plan_domains(&q, &PlanArgs::parse(1.0, &t).unwrap()).unwrap().rooms.iter().find_map(|q| match q { Primitive::Text { extra_lines, .. } => Some(extra_lines.len()), _ => None }).unwrap()
        };
        assert_eq!((lines(100.0), lines(200.0), lines(500.0)), (3, 1, 0));
        // [140] Eigene Stempel ab 1:200 wie automatische verkleinert: eigene Schriftgrössen (Name 12 pt) im
        // Verhältnis 7/10, Belagszeile entfällt (nur Name und Fläche).
        for r in q.rooms.as_mut().unwrap() {
            r.stamp.as_mut().unwrap().show_finish = Some(true);
            r.floor_finish = Some("Parkett".into());
        }
        let name_pt = |scale: f64| {
            let t = serde_json::json!({ "floor": "eg", "show": ["20", "60"], "grey": [], "scale": scale }).to_string();
            let r = plan_domains(&q, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
            r.rooms
                .iter()
                .filter_map(|q| match q {
                    Primitive::Text { doc, extra_lines, .. } => Some((doc.paragraphs.iter().flat_map(|p| &p.runs).filter_map(|r| r.marks.size_pt).fold(0.0, f64::max), extra_lines.len())),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        let big = name_pt(100.0);
        assert!(big.iter().any(|&(pt, n)| pt == NAME_PT && n == 4), "1:100 mit Belagszeile: {big:?}");
        for (pt, n) in name_pt(200.0) {
            assert!(pt == 0.0 || (pt - NAME_PT * ROOM_STAMP_SMALL_PT / ROOM_STAMP_PT).abs() < 1e-9, "Name 1:200 {pt}");
            assert!(n <= 1, "1:200 nur die Fläche: {n}");
        }
    }

    /// [140] Enger Raum: erst ohne Nutzungszeile, dann ohne Fläche, dann 2 mm Schrift; grosser Raum unverändert.
    /// Breite aus der Schriftmetrik (Inter), Platz aus dem Raumumriss um den Anker.
    #[test]
    fn raumstempel_passt_in_engen_raum() {
        let extra = || vec![StampLine { text: "4.6 m²".into(), align: Align::Center }, StampLine { text: "NNF · Nebennutzfläche".into(), align: Align::Center }];
        let name = doc_from_text("E.04 Bad");
        let room = |w: f64, h: f64| move |sw: f64, sh: f64, _free: bool| (sw <= w && sh <= h).then_some(Vec2 { x: 0.0, y: 0.0 });
        let (e, pt, d, _) = fit_room_stamp(&name, None, extra(), ROOM_STAMP_PT, 100.0, &room(6.0, 4.0));
        assert_eq!((e.len(), pt, d.is_none()), (2, ROOM_STAMP_PT, true));
        let (e, pt, _, _) = fit_room_stamp(&name, None, extra(), ROOM_STAMP_PT, 100.0, &room(1.8, 2.4));
        assert_eq!((e.len(), pt), (1, ROOM_STAMP_PT), "ohne Nutzung");
        let (e, pt, _, _) = fit_room_stamp(&name, None, extra(), ROOM_STAMP_PT, 100.0, &room(1.8, 0.6));
        assert_eq!((e.len(), pt), (0, ROOM_STAMP_PT), "nur der Name");
        let (e, pt, d, at) = fit_room_stamp(&name, None, extra(), ROOM_STAMP_PT, 100.0, &room(1.2, 0.8));
        // In 2 mm passt die Flächenzeile wieder dazu.
        assert_eq!((e.len(), d.is_none(), at.is_some()), (1, true, true));
        assert!((pt * PT_MM - 2.0).abs() < 1e-9, "2 mm Papier");
        // 1:500, „Treppenhaus" in 3 m: auch 2 mm (1 m Schrift) zu breit → gekürzt, so dass es passt.
        let (_, _, d, _) = fit_room_stamp(&doc_from_text("Treppenhaus"), None, vec![], ROOM_STAMP_SMALL_PT, 500.0, &room(3.0, 4.0));
        let t = crate::text_layout::plain_text(&d.unwrap());
        assert!(t.ends_with('.') && t.len() >= 4 && t.len() <= 7, "{t}");
        let (w, _) = stamp_size_m(&doc_from_text(&t), &[], ROOM_STAMP_MIN_PT, 500.0);
        assert!(w <= 3.0, "{w}");
        // Name mit eigener Grösse (12 pt fett) schrumpft nicht mit der Schrift: in 2 mm ohne Auszeichnung.
        let s = RoomStamp { number: Some("E.03".into()), name: "Wohnen/Essen".into(), ..Default::default() };
        let (_, _, d, _) = fit_room_stamp(&room_stamp_to_doc(&s), None, vec![], ROOM_STAMP_PT, 100.0, &room(3.0, 2.0));
        assert_eq!(crate::text_layout::plain_text(&d.unwrap()).replace('\n', ""), "Wohnen/EssenE.03", "ohne Auszeichnung, ggf. umbrochen");
        // Schmale Zeichen passen besser als breite (echte Metrik statt fester Zeichenbreite).
        let (wi, _) = stamp_size_m(&doc_from_text("Lift"), &[], ROOM_STAMP_PT, 100.0);
        let (ww, _) = stamp_size_m(&doc_from_text("WMWM"), &[], ROOM_STAMP_PT, 100.0);
        assert!(wi < 0.6 * ww, "{wi} {ww}");
        assert_eq!(abbreviate("Treppenhaus", 5).as_deref(), Some("Trep."));
        // [157] Frei liegt nur ein niedriger Stempel (neben der Treppe), überdeckt passt alles an den Pol: die
        // Zeilen bleiben (der Stempel verliert keine Zeile durch Ausweichen), erst Schrift/Umbruch frei, dann Überdeckung.
        let pole = Vec2 { x: 0.0, y: 0.0 };
        let side = Vec2 { x: 3.0, y: 0.0 };
        let narrow = move |h_free: f64| move |_w: f64, h: f64, free: bool| if free { (h <= h_free).then_some(side) } else { Some(pole) };
        let (_, h_small) = stamp_size_m(&name, &extra(), ROOM_STAMP_MIN_PT, 100.0);
        // Frei liegt der ganze Stempel erst in kleinerer Schrift: dort, mit allen Zeilen (keine Zeile fällt weg).
        for h_free in [h_small + 1e-9, h_small * 1.2] {
            let (e, pt, _, at) = fit_room_stamp(&name, None, extra(), ROOM_STAMP_PT, 100.0, &narrow(h_free));
            assert!(pt < ROOM_STAMP_PT && at == Some(side) && e.len() == 2, "kleinere Schrift frei: {pt} {at:?} {}", e.len());
        }
        // Auch 2 mm mit allen Zeilen zu hoch: ganzer Stempel an den Pol mit Überdeckung, statt Zeilen zu verlieren.
        let (e, pt, _, at) = fit_room_stamp(&name, None, extra(), ROOM_STAMP_PT, 100.0, &narrow(h_small * 0.5));
        assert_eq!((e.len(), pt, at), (2, ROOM_STAMP_PT, Some(pole)), "alle Zeilen, notfalls mit Überdeckung");
        let (e, pt, _, at) = fit_room_stamp(&name, None, extra(), ROOM_STAMP_PT, 100.0, &narrow(0.0));
        assert_eq!((e.len(), pt, at), (2, ROOM_STAMP_PT, Some(pole)), "nirgends frei: ganzer Stempel mit Überdeckung");
        assert_eq!(abbreviate("Bad", 5).as_deref(), Some("Bad"));
        // [171] Mehrere Wörter: alle bleiben sichtbar, nur Wortenden fallen weg, je Wort mindestens 3 Buchstaben + Punkt.
        assert_eq!(abbreviate("Wohnen/Essen/Küche", 16).as_deref(), Some("Wohn./Ess./Küche"));
        assert_eq!(abbreviate("Wohnen/Essen/Küche", 14).as_deref(), Some("Woh./Ess./Küc."));
        assert_eq!(abbreviate("Wohnen/Essen/Küche", 13), None, "darunter wäre ein Wort unter 3 Buchstaben");
        assert_eq!(abbreviate("Treppenhaus", 3), None);
        assert_eq!(abbreviate("Wohnen/Essen/Küche\nE.03", 20).map(|t| t.ends_with("\nE.03")), Some(true));
        assert_eq!(abbreviate("Abstellraum Keller", 40).as_deref(), Some("Abstellraum Keller"));
    }

    /// [171] Platzmangel: erst auf zwei Zeilen umbrechen, dann Schrift bis 2 mm, dann nur die Raumnummer,
    /// erst zuletzt Wortenden kürzen.
    #[test]
    fn raumstempel_platzmangel_reihenfolge() {
        let s = RoomStamp { number: Some("E.03".into()), name: "Wohnen/Essen/Küche".into(), ..Default::default() };
        let doc = room_stamp_to_doc(&s);
        let plain_of = |d: Option<RichTextDoc>| d.map(|d| crate::text_layout::plain_text(&d));
        let room = |w: f64, h: f64| move |sw: f64, sh: f64, _free: bool| (sw <= w && sh <= h).then_some(Vec2 { x: 0.0, y: 0.0 });
        let (_, _, d, _) = fit_room_stamp(&doc, Some("E.03"), vec![], ROOM_STAMP_PT, 100.0, &room(50.0, 50.0));
        assert!(d.is_none(), "genug Platz: unverändert");
        // (a) Zu schmal für eine Zeile, aber hoch genug für zwei: Umbruch an einem Trenner, volle Schrift, kein Kürzen.
        let (w1, _) = stamp_size_m(&doc_from_text("Wohnen/Essen/Küche\nE.03"), &[], ROOM_STAMP_PT, 100.0);
        let (w2, h2) = stamp_size_m(&doc_from_text("Wohnen/\nEssen/Küche\nE.03"), &[], ROOM_STAMP_PT, 100.0);
        assert!(w2 < w1);
        let (e, pt, d, at) = fit_room_stamp(&doc, Some("E.03"), vec![], ROOM_STAMP_PT, 100.0, &room(w2.max(w1 * 0.8), h2 + 1.0));
        let t = plain_of(d).unwrap();
        assert!(at.is_some() && pt == ROOM_STAMP_PT && e.is_empty() && t.lines().count() == 3, "{t:?} {pt}");
        assert_eq!(t.replace('\n', "").replace(' ', ""), "Wohnen/Essen/KücheE.03");
        // (b) Nur in 2 mm breit genug, einzeilig: kleinere Schrift, Name vollständig.
        let (wmin, hmin) = stamp_size_m(&doc_from_text("Wohnen/Essen/Küche\nE.03"), &[], ROOM_STAMP_MIN_PT, 100.0);
        let (_, pt, d, at) = fit_room_stamp(&doc, Some("E.03"), vec![], ROOM_STAMP_PT, 100.0, &room(wmin + 1e-6, hmin + 1e-6));
        assert!(at.is_some() && pt < ROOM_STAMP_PT, "{pt}");
        assert_eq!(plain_of(d).unwrap().replace('\n', ""), "Wohnen/Essen/KücheE.03", "nicht gekürzt");
        // (c) Auch 2 mm umbrochen zu gross: nur die Raumnummer.
        let (wn, hn) = stamp_size_m(&doc_from_text("E.03"), &[], ROOM_STAMP_MIN_PT, 100.0);
        let (e, pt, d, at) = fit_room_stamp(&doc, Some("E.03"), vec![], ROOM_STAMP_PT, 100.0, &room(wn + 1e-6, hn + 1e-6));
        assert!(at.is_some() && e.is_empty() && pt < ROOM_STAMP_PT);
        assert_eq!(plain_of(d).as_deref(), Some("E.03"));
        // (d) Ohne Nummer: gekürzt an Wortenden, mindestens 3 Buchstaben + Punkt je Wort.
        let nm = room_stamp_to_doc(&RoomStamp { name: "Wohnen/Essen/Küche".into(), ..Default::default() });
        let (w14, h14) = stamp_size_m(&doc_from_text("Woh./Ess./Küc."), &[], ROOM_STAMP_MIN_PT, 500.0);
        let (_, _, d, at) = fit_room_stamp(&nm, None, vec![], ROOM_STAMP_PT, 500.0, &room(w14 + 1e-6, h14 + 1e-6));
        let t = plain_of(d).unwrap();
        assert!(at.is_some(), "{t}");
        assert!(t.split('/').all(|w| w.trim_end_matches('.').chars().count() >= 3) && t.contains('.'), "{t}");
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
        assert_eq!(extra.len(), 1, "Stempel bleibt vollständig");
        // Eigener Anker: bleibt, auch auf dem Hindernis.
        p.rooms.as_mut().unwrap().iter_mut().find(|r| r.id == id).unwrap().stamp_anchor = Some(pole);
        assert_eq!(stamp(&p).0, pole);
        // Kein freier Platz (Text über den ganzen Raum): wie bisher am Pol.
        p.rooms.as_mut().unwrap().iter_mut().find(|r| r.id == id).unwrap().stamp_anchor = None;
        p.drawings2d.clear();
        p.drawings2d.push(mk(serde_json::json!({ "shape": "text", "at": { "x": 49.0, "y": 49.0 }, "text": "XXXXXXXXXXXXXXXXXXXXXXXXXX", "height": 6.0, "angle": 0.0 })));
        assert_eq!(stamp(&p).0, pole);
    }

    /// [157] Schnittführung quer durch den Raum: der Stempel steht neben der strichpunktierten Linie, nicht
    /// darauf (vorher lief „A-A“ durch Raumnamen und Fläche, Musterhaus komplex OG/DG).
    #[test]
    fn raumstempel_weicht_schnittlinie_aus() {
        let mut p = sample();
        let r = p.rooms.as_mut().unwrap().iter_mut().find(|r| r.floor_id == "eg").unwrap();
        let q = [(0.0, 0.0), (7.0, 0.0), (7.0, 5.0), (0.0, 5.0)];
        r.boundary = q.iter().map(|&(x, y)| Vec2 { x: x + 50.0, y: y + 50.0 }).collect();
        r.stamp_anchor = None;
        r.stamp = None;
        let id = r.id.clone();
        p.drawing_levels.retain(|l| !matches!(l.kind, DrawingLevelKind::Section | DrawingLevelKind::Elevation));
        let t = serde_json::json!({ "floor": "eg", "show": ["20", "60", "80", "90"], "grey": [], "scale": 100, "global": true }).to_string();
        let a = PlanArgs::parse(1.0, &t).unwrap();
        let stamp = |p: &Project| {
            let out = plan_domains(p, &a).unwrap();
            out.rooms.iter().find_map(|q| match q { Primitive::Text { at, room_id: Some(rid), doc, extra_lines, base_pt, .. } if *rid == id => Some((*at, doc.clone(), extra_lines.clone(), *base_pt)), _ => None }).unwrap()
        };
        let (pole, ..) = stamp(&p);
        // Schnitt A-A senkrecht durch den Pol (x = 53.5), über den Raum hinaus.
        let level: DrawingLevel = serde_json::from_value(serde_json::json!({ "id": "sx", "name": "Schnitt A-A", "kind": "section", "visible": true, "locked": false,
            "linePoints": [{ "x": 53.5, "y": 44.0 }, { "x": 53.5, "y": 61.0 }] })).unwrap();
        p.drawing_levels.push(level);
        let (at, doc, extra, pt) = stamp(&p);
        let (w, _) = stamp_size_m(&doc, &extra, pt, 100.0);
        assert!((at.x - 53.5).abs() > w / 2.0, "Stempel auf der Schnittlinie: {at:?} (Pol {pole:?}, Breite {w})");
    }

    /// [157] Firstlinie quer durch den Raum: der Stempel steht neben dem First (vorher „D.03 Galerie“ auf der
    /// Firstlinie, Musterhaus komplex DG).
    #[test]
    fn raumstempel_weicht_firstlinie_aus() {
        let mut p = sample();
        let r = p.rooms.as_mut().unwrap().iter_mut().find(|r| r.floor_id == "eg").unwrap();
        let q = [(0.0, 0.0), (7.0, 0.0), (7.0, 5.0), (0.0, 5.0)];
        r.boundary = q.iter().map(|&(x, y)| Vec2 { x: x + 50.0, y: y + 50.0 }).collect();
        r.stamp_anchor = None;
        r.stamp = None;
        let id = r.id.clone();
        p.drawing_levels.retain(|l| !matches!(l.kind, DrawingLevelKind::Section | DrawingLevelKind::Elevation));
        let t = serde_json::json!({ "floor": "eg", "show": ["20", "31", "60", "80"], "grey": [], "scale": 100 }).to_string();
        let a = PlanArgs::parse(1.0, &t).unwrap();
        let stamp = |p: &Project| {
            let out = plan_domains(p, &a).unwrap();
            out.rooms.iter().find_map(|q| match q { Primitive::Text { at, room_id: Some(rid), doc, extra_lines, base_pt, .. } if *rid == id => Some((*at, doc.clone(), extra_lines.clone(), *base_pt)), _ => None }).unwrap()
        };
        p.roofs = None;
        let (pole, ..) = stamp(&p);
        // Satteldach über dem Raum, First waagrecht durch den Pol.
        let roof: Roof = serde_json::from_value(serde_json::json!({ "id": "RFx", "type": "roof", "floorId": "eg", "categoryCode": "31",
            "outline": [{ "x": 49.0, "y": pole.y - 3.0 }, { "x": 58.0, "y": pole.y - 3.0 }, { "x": 58.0, "y": pole.y + 3.0 }, { "x": 49.0, "y": pole.y + 3.0 }],
            "shape": "sattel", "pitchDeg": 30, "overhang": 0.0, "ridgeAxis": "x", "thickness": 0.2 })).unwrap();
        p.roofs = Some(vec![roof]);
        let out = plan_domains(&p, &a).unwrap();
        let ridge_y: Vec<f64> = out.roofs.iter().filter_map(|q| match q { Primitive::Line { a, b, cls, .. } if cls == "roof-ridge" && (a.y - b.y).abs() < 1e-6 => Some(a.y), _ => None }).collect();
        assert!(!ridge_y.is_empty(), "kein First");
        let (at, doc, extra, pt) = stamp(&p);
        let (_, h) = stamp_size_m(&doc, &extra, pt, 100.0);
        for y in ridge_y {
            assert!((at.y - y).abs() > h / 2.0, "Stempel auf dem First: {at:?} (Pol {pole:?}, Höhe {h}, First {y})");
        }
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

    /// [155] Treppen-Linien (Lauflinie, gestrichelt wie ausgezogen, Pfeil, Tritte, Bruchlinie) sind Hindernisse der Raumstempel.
    #[test]
    fn stempel_weichen_den_treppenlinien_aus() {
        let p = sample();
        let t = serde_json::json!({ "floor": "eg", "show": ["20", "21", "30", "40", "50", "60"], "grey": [], "scale": 100 }).to_string();
        let a = PlanArgs::parse(1.0, &t).unwrap();
        let c = Ctx::new(&p, &a);
        let d = plan_domains(&p, &a).unwrap();
        let o = stamp_obstacles(&c, &d);
        let mut seen = std::collections::BTreeSet::new();
        for q in &d.stairs {
            if let Primitive::Line { a, b, cls, .. } = q {
                if matches!(cls.as_str(), "stair-run" | "stair-arrow" | "stair-tread" | "stair-break") {
                    seen.insert(cls.to_string());
                    let m = Vec2 { x: (a.x + b.x) / 2.0, y: (a.y + b.y) / 2.0 };
                    assert_eq!(o.clearance(m, 0.001, 0.001), 0.0, "{cls}");
                }
            }
        }
        assert!(seen.contains("stair-run") && seen.contains("stair-arrow"), "{seen:?}");
        // Lauflinie: Schnitthöhe liegt in der Treppe, also ein ausgezogenes und ein gestricheltes Stück; Pfeil ausgezogen.
        let dashed = |cls: &str| d.stairs.iter().filter(|q| matches!(q, Primitive::Line { cls: c, dash: Some(Some(_)), .. } if c == cls)).count();
        assert!(dashed("stair-run") >= 1, "Lauflinie hinter der Bruchlinie gestrichelt");
        assert_eq!(dashed("stair-arrow"), 0);
    }

    /// [140] Schatten der Sonnenstudie liegt unter Bemassung, Texten und Raumstempeln: im Plan-Puffer (Quelle
    /// für Bildschirm, Druck-SVG/PDF und CLI-SVG) kommen alle Schattenflächen vor der ersten Zeichnung, dem
    /// ersten Stempel und jedem Raum — in Tusche und farbig.
    #[test]
    fn schatten_unter_bemassung_und_stempeln() {
        let mut p = sample();
        p.sun_study = Some(SunStudy { when: "2026-12-21T09:00:00Z".into(), show: true, ..Default::default() });
        p.drawings2d.push(serde_json::from_value(serde_json::json!({ "id": "dim1", "type": "drawing2d", "levelId": "eg", "categoryCode": "20",
            "geom": {"shape": "dimension", "pts": [{"x": -1, "y": -1}, {"x": 8, "y": -1}], "offset": 0.5} })).unwrap());
        for mono in [true, false] {
            let t = serde_json::json!({ "floor": "eg", "show": ["20", "60"], "grey": [], "scale": 100, "global": true, "mono": mono, "sunWhen": 1_797_843_600_000.0_f64 }).to_string();
            let a = PlanArgs::parse(1.0, &t).unwrap();
            let check = |prims: &[Primitive]| {
                let is_shadow = |q: &Primitive| matches!(q, Primitive::Polygon { context_object_id: Some(id), .. } if id == super::super::extras::SITE_PICK_SUN);
                let last_shadow = prims.iter().rposition(is_shadow).expect("Schatten");
                let first_top = prims
                    .iter()
                    .position(|q| match q {
                        Primitive::Text { .. } | Primitive::DrawingText { .. } => true,
                        Primitive::Line { drawing_id: Some(_), .. } | Primitive::Polygon { drawing_id: Some(_), .. } => true,
                        Primitive::Polygon { room_id: Some(_), .. } => true,
                        _ => false,
                    })
                    .expect("Bemassung/Stempel");
                assert!(last_shadow < first_top, "mono {mono}: Schatten {last_shadow} nach Inhalt {first_top}");
            };
            let (prims, _, _) = crate::plan::buf::decode(&plan_domains_buf(&p, &a).unwrap()).unwrap();
            check(&prims);
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

    /// [33] „Ausblenden“ im Grundriss: Wände samt ihren Öffnungen (Symbole) weg, Decken/Räume bleiben; eine
    /// Regel nur für den Schnitt wirkt nicht; Bauteilart wirkt auch auf Farbe; Linienstil einer Schicht-Regel
    /// auf die Fugen der Wandschicht.
    #[test]
    fn ausblenden_und_linienstil_im_grundriss() {
        let mut p = sample();
        let run = |p: &Project| {
            let t = serde_json::json!({ "floor": "eg", "show": ["20", "21", "30", "60"], "grey": [], "scale": 50 }).to_string();
            plan_domains(p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap()
        };
        let wall_polys = |d: &DomainPrims| d.walls.iter().filter(|q| matches!(q, Primitive::Polygon { wall_id: Some(_), .. })).count();
        let opening_prims = |d: &DomainPrims| d.walls.iter().filter(|q| matches!(q, Primitive::Line { opening_id: Some(_), .. } | Primitive::Arc { opening_id: Some(_), .. } | Primitive::Polygon { opening_id: Some(_), .. })).count();
        let before = run(&p);
        assert!(wall_polys(&before) > 0 && opening_prims(&before) > 0);
        let rule = |view: &str, actions: serde_json::Value| -> OverrideRule {
            serde_json::from_value(serde_json::json!({"id": "h", "name": "h", "enabled": true,
                "condition": {"type": "element_kind", "operator": "equals", "value": "wall"},
                "conditions": [{"type": "view_kind", "operator": "equals", "value": view}], "actions": actions})).unwrap()
        };
        p.override_rules = Some(vec![rule("section", serde_json::json!({"hide": true}))]);
        assert_eq!(wall_polys(&run(&p)), wall_polys(&before), "Regel nur für den Schnitt");
        p.override_rules = Some(vec![rule("plan", serde_json::json!({"hide": true}))]);
        let d = run(&p);
        assert_eq!(wall_polys(&d), 0, "Wände ausgeblendet");
        assert_eq!(opening_prims(&d), 0, "Öffnungen der Wände mit");
        // Decken bleiben (ihre Umrisslinien laufen ohne die Wände durch).
        let ceiling_polys = |d: &DomainPrims| d.ceilings.iter().filter(|q| matches!(q, Primitive::Polygon { ceiling_id: Some(_), .. })).count();
        assert!(ceiling_polys(&d) > 0 && ceiling_polys(&d) == ceiling_polys(&before));
        assert_eq!(d.rooms.len(), before.rooms.len());
        // Bauteilart wirkt im Grundriss auch auf die Farbe.
        p.override_rules = Some(vec![rule("plan", serde_json::json!({"color": "#ff0000"}))]);
        assert!(run(&p).walls.iter().any(|q| matches!(q, Primitive::Line { color: Some(c), .. } if c == "#ff0000") || matches!(q, Primitive::Polygon { stroke, .. } if stroke == "#ff0000")));
        // Linienstil aus einer Schicht-Regel: Fugen an der Dämmschicht gestrichelt.
        let dashed = |d: &DomainPrims| d.walls.iter().filter(|q| matches!(q, Primitive::Line { cls, dash: Some(Some(m)), .. } if cls == "layer-joint" && m == &vec![0.35, 0.3])).count();
        assert_eq!(dashed(&before), 0);
        p.override_rules = Some(vec![serde_json::from_value(serde_json::json!({"id": "l", "name": "l", "enabled": true,
            "condition": {"type": "material_category", "operator": "equals", "value": "insulation"}, "actions": {"linetypeId": "hatch-dash"}})).unwrap()]);
        assert!(dashed(&run(&p)) > 0);
    }

    /// [33] Eine per Regel ausgeblendete Öffnung schliesst ihr Wandloch (Wand-Poché ohne Lücke); eine
    /// ausgeblendete Öffnungs-Kategorie lässt das Loch stehen.
    #[test]
    fn ausgeblendete_oeffnung_schliesst_wandloch() {
        let mut p = sample();
        let run = |p: &Project, show: &[&str]| {
            let t = serde_json::json!({ "floor": "eg", "show": show, "grey": [], "scale": 50 }).to_string();
            plan_domains(p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap()
        };
        let area = |d: &DomainPrims| -> f64 {
            d.walls
                .iter()
                .filter_map(|q| match q {
                    Primitive::Polygon { pts, wall_id: Some(_), fill, .. } if fill != "none" => Some(pts),
                    _ => None,
                })
                .map(|pts| (0..pts.len()).map(|i| { let (a, b) = (&pts[i], &pts[(i + 1) % pts.len()]); a.x * b.y - b.x * a.y }).sum::<f64>().abs() / 2.0)
                .sum()
        };
        let opening_prims = |d: &DomainPrims| d.walls.iter().filter(|q| matches!(q, Primitive::Line { opening_id: Some(_), .. } | Primitive::Arc { opening_id: Some(_), .. } | Primitive::Polygon { opening_id: Some(_), .. })).count();
        let all = ["20", "21", "30", "60"];
        let before = run(&p, &all);
        assert!(opening_prims(&before) > 0);
        let a0 = area(&before);
        // Kategorie aus: Symbol weg, Loch bleibt.
        let codes: Vec<&str> = all.iter().copied().filter(|c| p.openings.iter().flatten().all(|o| o.category_code != *c)).collect();
        let off = run(&p, &codes);
        assert_eq!(opening_prims(&off), 0);
        assert!((area(&off) - a0).abs() < 1e-9, "Loch bleibt bei ausgeblendeter Kategorie");
        p.override_rules = Some(vec![serde_json::from_value(serde_json::json!({"id": "h", "name": "h", "enabled": true,
            "condition": {"type": "element_kind", "operator": "equals", "value": "opening"}, "actions": {"hide": true}})).unwrap()]);
        let d = run(&p, &all);
        assert_eq!(opening_prims(&d), 0, "Symbole weg");
        assert!(area(&d) > a0 + 0.1, "Wandloch geschlossen: {} → {}", a0, area(&d));
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
        assert_eq!(rooms[1]["extraLines"].as_array().unwrap().len(), 1, "[177] ohne SIA-Kategorie");
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
            category_code: "20".into(),
            points: vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 1.0, y: 0.0 }, Vec2 { x: 1.0, y: 1.0 }, Vec2 { x: 0.0, y: 1.0 }],
            height: h,
            base_offset: Some(off),
            ..Default::default()
        };
        p.extruded_solids = Some(vec![mk("oben", 1.4, 0.6), mk("unten", 0.0, 0.5)]);
        // Standard: Wände unverändert; [152] der Schrank über der Schnitthöhe gestrichelt (Überkopf), der Sockel nicht.
        let (w0, s0) = walls(&p);
        assert!(!w0.contains("view-range"));
        let r = plan_domains(&p, &args("eg", 1.0, &["20", "30", "60"])).unwrap();
        let dashed: Vec<&str> = r.solids.iter().filter_map(|q| match q {
            Primitive::Line { cls, dash: Some(Some(d)), .. } if cls == "view-range" && d[..] == super::super::view_range::ABOVE_DASH[..] => Some("x"),
            _ => None,
        }).collect();
        assert_eq!(dashed.len(), 4, "{s0}");
        assert!(r.solids.iter().any(|q| matches!(q, Primitive::Polygon { stroke, extruded_solid_id: Some(id), .. } if id == "unten" && stroke != "none")), "Sockel als Aufsicht");
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
        assert!(s4.contains("\"unten\"") && s4.contains("[0.0,1.0]"), "{s4}");
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
        assert!(e1.contains("\"GAL\"") && e1.contains("[6.0,1.5,0.0,1.5]"), "{e1}");
        // OG mit Unterkante 0.1 m und Tiefe: EG-Decke (bis OK OG-Boden) gepunktet „unter Schnitt“.
        set_range(&mut p, "og", None, Some(0.1), Some(0.5));
        let o1 = ceil(&p, "og");
        assert!(o1.contains("\"GAL\"") && o1.contains("[0.0,1.0]") && !o1.contains("[6.0,1.5,0.0,1.5]"), "{o1}");
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
        assert!(e1.contains("RF1") && e1.contains("roof-eaves") && e1.contains("[6.0,1.5,0.0,1.5]"), "{e1}");
        assert!(!e1.contains("[0.0,1.0]"));
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
        assert!(d0.contains("RF1") && !d0.contains("[0.0,1.0]"), "{d0}");
        set_range(&mut p, "dg", None, Some(0.0), Some(9.0));
        let d1 = roofs(&p, "dg");
        assert!(d1.contains("RF1") && d1.contains("[0.0,1.0]"), "{d1}");
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
        let dashed = |xs: &[serde_json::Value]| xs.iter().filter(|x| x["kind"] == "line").all(|x| x["dash"] == serde_json::json!([6.0, 1.5, 0.0, 1.5]));
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
        let dotted = |xs: &[serde_json::Value]| xs.iter().filter(|x| x["kind"] == "line").all(|x| x["dash"] == serde_json::json!([0.0, 1.0]));
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

    /// [156] Beispiel mit Belagsmuster auf C1 (Boden des OG) und einem Raum im OG.
    fn belag_projekt(kind: SurfacePatternKind, spacing: f64, height: f64) -> Project {
        let mut p = sample();
        let ce = p.ceilings.as_ref().unwrap()[0].clone();
        let top = crate::model3d::ceiling_type_ref(&p, &ce).unwrap().2[0].component_id.clone();
        let c = p.components.iter_mut().find(|c| c.id == top).unwrap();
        c.surface_pattern = Some(SurfacePattern { kind, spacing, height: Some(height), ..Default::default() });
        p
    }

    /// [156] Belagslinien des Grundrisses `floor` (Detail 0/1/2, Massstab, weitere Argumente).
    fn belag(p: &Project, floor: &str, detail: f64, scale: f64, extra: serde_json::Value) -> Vec<(Vec2, Vec2, f64, String)> {
        let mut t = serde_json::json!({ "floor": floor, "show": ["30", "40", "50", "60", "20"], "grey": [], "scale": scale });
        if let (Some(o), Some(e)) = (t.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
        }
        let r = plan_domains(p, &PlanArgs::parse(detail, &t.to_string()).unwrap()).unwrap();
        r.ceilings
            .iter()
            .filter_map(|q| match q {
                Primitive::Line { a, b, cls, weight_mm, color, .. } if cls == "floor-finish-pattern" => Some((*a, *b, *weight_mm, color.as_ref().map(|c| c.to_string()).unwrap_or_default())),
                _ => None,
            })
            .collect()
    }

    fn set_finish(p: &mut Project, floor: &str, v: Option<FloorFinishDisplay>) {
        p.drawing_levels.iter_mut().find(|l| l.id == floor).unwrap().floor_finish = v;
    }

    /// [156] Belagsmuster automatisch nur ab 1:50 bzw. Detail „fein"; 1:100 ohne, „alle" zeigt es auch dort.
    #[test]
    fn belag_nur_ab_1_50_oder_fein() {
        let mut p = belag_projekt(SurfacePatternKind::Grid, 0.3, 0.3);
        let none = serde_json::json!({});
        assert!(belag(&p, "og", 1.0, 50.0, none.clone()).len() > 10);
        assert!(belag(&p, "og", 1.0, 100.0, none.clone()).is_empty());
        assert!(belag(&p, "og", 2.0, 100.0, none.clone()).len() > 10, "fein auch im 1:100");
        assert!(belag(&p, "og", 0.0, 50.0, none.clone()).is_empty(), "ausdrücklich grob");
        set_finish(&mut p, "og", Some(FloorFinishDisplay::All));
        assert!(belag(&p, "og", 1.0, 100.0, none.clone()).len() > 10);
        set_finish(&mut p, "og", Some(FloorFinishDisplay::Off));
        assert!(belag(&p, "og", 1.0, 50.0, none.clone()).is_empty());
        // Bildschirm wie Druck (forPrint, kompakte Unterlage).
        set_finish(&mut p, "og", None);
        let screen = belag(&p, "og", 1.0, 50.0, serde_json::json!({ "compact": true }));
        let print = belag(&p, "og", 1.0, 50.0, serde_json::json!({ "forPrint": true }));
        assert_eq!(screen.len(), print.len());
        assert!(!screen.is_empty());
        // [157] Nur in Geschoss-Grundrissen: die 2D-Ebene eines Schnitts (Bezugshöhe ±0.00) bekam sonst im 1:50 das
        // Belagsmuster der Decke auf ±0.00 (Musterhaus komplex Schnitt A-A 1:50).
        let sec = p.drawing_levels.iter().find(|l| l.kind == DrawingLevelKind::Section).map(|l| l.id.clone()).unwrap();
        let og_base = p.floor("og").and_then(|l| l.base_elevation);
        p.drawing_levels.iter_mut().find(|l| l.id == sec).unwrap().base_elevation = og_base;
        assert!(belag(&p, &sec, 1.0, 50.0, none.clone()).is_empty());
    }

    /// [156] „Nassräume": im 1:100 nur Plattenbeläge, nur in Bad/WC/Dusche; Parkett nicht.
    #[test]
    fn belag_nassraeume_im_1_100() {
        let mut p = belag_projekt(SurfacePatternKind::Grid, 0.3, 0.3);
        let mut bad = p.rooms.as_ref().unwrap()[0].clone();
        bad.id = "R-bad".into();
        bad.floor_id = "og".into();
        bad.name = "Bad".into();
        bad.stamp_anchor = Some(Vec2 { x: 4.4, y: 3.6 });
        bad.boundary = vec![Vec2 { x: 3.0, y: 2.0 }, Vec2 { x: 4.8, y: 2.0 }, Vec2 { x: 4.8, y: 3.8 }, Vec2 { x: 3.0, y: 3.8 }];
        let mut wohnen = bad.clone();
        wohnen.id = "R-wohnen".into();
        wohnen.name = "Wohnen".into();
        wohnen.stamp_anchor = Some(Vec2 { x: 1.0, y: 1.0 });
        wohnen.boundary = vec![Vec2 { x: 0.2, y: 0.2 }, Vec2 { x: 2.8, y: 0.2 }, Vec2 { x: 2.8, y: 3.8 }, Vec2 { x: 0.2, y: 3.8 }];
        p.rooms.as_mut().unwrap().extend([bad.clone(), wohnen]);
        set_finish(&mut p, "og", Some(FloorFinishDisplay::Wet));
        let wet = belag(&p, "og", 1.0, 100.0, serde_json::json!({}));
        assert!(wet.len() >= 4, "{}", wet.len());
        let ring: Vec<[f64; 2]> = bad.boundary.iter().map(|v| [v.x, v.y]).collect();
        for (a, b, ..) in &wet {
            let m = [(a.x + b.x) / 2.0, (a.y + b.y) / 2.0];
            assert!(crate::surface_pattern::point_in(m, &ring), "Belag ausserhalb des Bads: {a:?}–{b:?}");
        }
        // 1:50: alle Räume.
        assert!(belag(&p, "og", 1.0, 50.0, serde_json::json!({})).len() > wet.len());
        // Parkett (Verband, kein Plattenname) im Nassraum-Modus: kein Belag im 1:100.
        let mut q = belag_projekt(SurfacePatternKind::RunningBond, 0.6, 0.1);
        let ce = q.ceilings.as_ref().unwrap()[0].clone();
        let top = crate::model3d::ceiling_type_ref(&q, &ce).unwrap().2[0].component_id.clone();
        let comp = q.components.iter_mut().find(|c| c.id == top).unwrap();
        comp.name = "Parkett".into();
        assert!(!super::super::floor_finish::is_tile(comp), "{}", comp.id);
        q.rooms = p.rooms.clone();
        set_finish(&mut q, "og", Some(FloorFinishDisplay::Wet));
        assert!(belag(&q, "og", 1.0, 100.0, serde_json::json!({})).is_empty());
        assert!(!belag(&q, "og", 1.0, 50.0, serde_json::json!({})).is_empty());
    }

    /// [156] Teilung auf dem Papier nicht enger als 1.5 mm; Strich fein (0.02–0.05 mm) in Tusche-Grau.
    #[test]
    fn belag_mindestteilung_und_feiner_strich() {
        let p = belag_projekt(SurfacePatternKind::Lines, 0.05, 0.05);
        let gaps = |scale: f64| {
            let mut xs: Vec<f64> = belag(&p, "og", 1.0, scale, serde_json::json!({})).iter().filter(|(a, b, ..)| (a.x - b.x).abs() < 1e-9).map(|(a, ..)| a.x).collect();
            xs.sort_by(f64::total_cmp);
            xs.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
            assert!(xs.len() > 3, "{scale}: {xs:?}");
            xs.windows(2).map(|w| w[1] - w[0]).fold(f64::INFINITY, f64::min)
        };
        // 1:20: 5 cm = 2.5 mm auf dem Papier, volle Teilung.
        assert!((gaps(20.0) - 0.05).abs() < 1e-6);
        // 1:50: 5 cm = 1 mm → jede 2. Linie (2 mm).
        let g = gaps(50.0);
        assert!(g * 1000.0 / 50.0 >= super::super::floor_finish::MIN_PAPER_MM - 1e-9, "{g}");
        for (_, _, w, color) in belag(&p, "og", 1.0, 50.0, serde_json::json!({})) {
            assert!((0.02..=0.05).contains(&w), "{w}");
            assert_eq!(color, super::super::floor_finish::INK);
        }
    }

    /// [156] Belag spart Raumstempel und Möbel/Einbauten (Blöcke, Körper) aus.
    #[test]
    fn belag_spart_stempel_und_moebel_aus() {
        let mut p = belag_projekt(SurfacePatternKind::Grid, 0.1, 0.1);
        let mut r = p.rooms.as_ref().unwrap()[0].clone();
        r.floor_id = "og".into();
        r.id = "R-og".into();
        p.rooms.as_mut().unwrap().push(r);
        p.block_defs = Some(vec![serde_json::from_value(serde_json::json!({ "id": "tisch", "name": "Tisch", "geom2d": [
            { "shape": "rect", "min": {"x": -0.4, "y": -0.4}, "max": {"x": 0.4, "y": 0.4} } ] })).unwrap()]);
        p.drawings2d.push(serde_json::from_value(serde_json::json!({ "id": "m1", "type": "drawing2d", "levelId": "og", "categoryCode": "20",
            "geom": {"shape": "block", "blockDefId": "tisch", "at": {"x": 1.0, "y": 1.0}, "rotation": 0} })).unwrap());
        p.extruded_solids = Some(vec![serde_json::from_value(serde_json::json!({ "id": "kueche", "type": "extrudedSolid", "levelId": "og",
            "points": [{"x": 3.6, "y": 0.2}, {"x": 4.8, "y": 0.2}, {"x": 4.8, "y": 0.8}, {"x": 3.6, "y": 0.8}], "height": 0.9 })).unwrap()]);
        let t = serde_json::json!({ "floor": "og", "show": ["30", "60", "20"], "grey": [], "scale": 50 }).to_string();
        let d = plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
        let stamp = d.rooms.iter().find_map(|q| match q { Primitive::Text { at, doc, extra_lines, base_pt, .. } => Some((*at, stamp_size_m(doc, extra_lines, *base_pt, 50.0))), _ => None }).unwrap();
        let (at, (w, h)) = stamp;
        let inside = |m: [f64; 2], x0: f64, y0: f64, x1: f64, y1: f64| m[0] > x0 + 1e-6 && m[0] < x1 - 1e-6 && m[1] > y0 + 1e-6 && m[1] < y1 - 1e-6;
        let lines = belag(&p, "og", 1.0, 50.0, serde_json::json!({}));
        assert!(lines.len() > 20);
        for (a, b, ..) in &lines {
            for k in 1..10 {
                let t = k as f64 / 10.0;
                let m = [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
                assert!(!inside(m, at.x - w / 2.0, at.y - h / 2.0, at.x + w / 2.0, at.y + h / 2.0), "Belag im Stempel {m:?}");
                assert!(!inside(m, 0.6, 0.6, 1.4, 1.4), "Belag unter dem Möbel {m:?}");
                assert!(!inside(m, 3.6, 0.2, 4.8, 0.8), "Belag unter dem Einbau {m:?}");
            }
        }
    }

    /// [156] Geschlossene 2D-Formen der Kategorie „Möbel“ (Rechteck, Kreis, Polylinie) sparen den Belag aus,
    /// gleiche Formen in anderen Kategorien nicht.
    #[test]
    fn belag_spart_geschlossene_moebelformen_aus() {
        let p0 = belag_projekt(SurfacePatternKind::Grid, 0.1, 0.1);
        assert!(p0.flat_categories().iter().any(|c| c.code == "22" && c.name == "Möbel"));
        let shape = |id: &str, cat: &str, geom: serde_json::Value| serde_json::from_value(serde_json::json!({ "id": id, "type": "drawing2d", "levelId": "og", "categoryCode": cat, "geom": geom })).unwrap();
        let mk = |cat: &str| {
            let mut p = p0.clone();
            p.drawings2d.push(shape("r", cat, serde_json::json!({"shape": "rect", "min": {"x": 0.6, "y": 0.6}, "max": {"x": 1.4, "y": 1.4}})));
            p.drawings2d.push(shape("c", cat, serde_json::json!({"shape": "circle", "center": {"x": 3.0, "y": 1.0}, "r": 0.4})));
            p.drawings2d.push(shape("pl", cat, serde_json::json!({"shape": "polyline", "closed": true, "pts": [{"x": 3.6, "y": 0.2}, {"x": 4.8, "y": 0.2}, {"x": 4.8, "y": 0.8}, {"x": 3.6, "y": 0.8}]})));
            belag(&p, "og", 1.0, 50.0, serde_json::json!({"show": ["30", "40", "60", "20", "22", "10"]}))
        };
        let inside = |l: &[(Vec2, Vec2, f64, String)], x0: f64, y0: f64, x1: f64, y1: f64| {
            l.iter().any(|(a, b, ..)| (1..10).any(|k| {
                let t = k as f64 / 10.0;
                let m = [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
                m[0] > x0 + 1e-6 && m[0] < x1 - 1e-6 && m[1] > y0 + 1e-6 && m[1] < y1 - 1e-6
            }))
        };
        let mobel = mk("22");
        assert!(mobel.len() > 20);
        assert!(!inside(&mobel, 0.6, 0.6, 1.4, 1.4), "Belag unter dem Möbel-Rechteck");
        assert!(!inside(&mobel, 2.7, 0.7, 3.3, 1.3), "Belag unter dem Möbel-Kreis");
        assert!(!inside(&mobel, 3.6, 0.2, 4.8, 0.8), "Belag unter der Möbel-Polylinie");
        let fremd = mk("60");
        assert!(inside(&fremd, 0.6, 0.6, 1.4, 1.4) && inside(&fremd, 3.6, 0.2, 4.8, 0.8), "andere Kategorie spart nicht aus");
    }

    /// [158] Raum mit eigenem Bodenbelag (Material mit Muster): im Raum gilt sein Muster, auf den Raum
    /// beschnitten, statt des Deckenbelags; ausserhalb bleibt der Deckenbelag.
    #[test]
    fn belag_aus_raum_statt_decke() {
        let mut p = belag_projekt(SurfacePatternKind::Grid, 0.3, 0.3);
        p.components.push(Component { id: "fliese".into(), name: "Feinsteinzeug".into(), surface_pattern: Some(SurfacePattern { kind: SurfacePatternKind::Grid, spacing: 0.6, height: Some(0.6), ..Default::default() }), ..Default::default() });
        let mut bad = p.rooms.as_ref().unwrap()[0].clone();
        bad.id = "R-bad".into();
        bad.floor_id = "og".into();
        bad.name = "Raum 7".into();
        bad.stamp_anchor = Some(Vec2 { x: 4.5, y: 3.6 });
        bad.boundary = vec![Vec2 { x: 3.0, y: 2.0 }, Vec2 { x: 4.8, y: 2.0 }, Vec2 { x: 4.8, y: 3.8 }, Vec2 { x: 3.0, y: 3.8 }];
        p.rooms.as_mut().unwrap().push(bad.clone());
        let before = belag(&p, "og", 1.0, 50.0, serde_json::json!({}));
        let ring: Vec<[f64; 2]> = bad.boundary.iter().map(|v| [v.x, v.y]).collect();
        let inside = |l: &[(Vec2, Vec2, f64, String)]| l.iter().filter(|(a, b, ..)| crate::surface_pattern::point_in([(a.x + b.x) / 2.0, (a.y + b.y) / 2.0], &ring)).count();
        let n_before = inside(&before);
        p.rooms.as_mut().unwrap().last_mut().unwrap().floor_finish = Some("fliese".into());
        let after = belag(&p, "og", 1.0, 50.0, serde_json::json!({}));
        let n_after = inside(&after);
        assert!(n_after > 0 && n_before > 0, "{n_after} / {n_before}");
        // Im Raum nur noch Linien des 0.6-Rasters (x bzw. y auf 3.0 + k·0.6).
        for (a, b, ..) in after.iter().filter(|(a, b, ..)| crate::surface_pattern::point_in([(a.x + b.x) / 2.0, (a.y + b.y) / 2.0], &ring)) {
            let on = |v: f64| ((v - 3.0) / 0.6 - ((v - 3.0) / 0.6).round()).abs() < 1e-6 || ((v - 2.0) / 0.6 - ((v - 2.0) / 0.6).round()).abs() < 1e-6;
            assert!((a.x - b.x).abs() < 1e-9 && on(a.x) || (a.y - b.y).abs() < 1e-9 && on(a.y), "{a:?}–{b:?}");
        }
        // Ausserhalb unverändert der Deckenbelag (gleiche Linienlänge ausserhalb des Raums).
        let outside_len = |l: &[(Vec2, Vec2, f64, String)]| {
            let mut rest = Vec::new();
            for (a, b, ..) in l {
                crate::surface_pattern::clip_outside_poly([a.x, a.y], [b.x, b.y], &ring, &mut rest);
            }
            rest.iter().map(|(a, b)| ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt()).sum::<f64>()
        };
        assert!((outside_len(&before) - outside_len(&after)).abs() < 1e-6, "{} {}", outside_len(&before), outside_len(&after));
        // Freitext-Belag: kein Muster bekannt, der Deckenbelag bleibt.
        p.rooms.as_mut().unwrap().last_mut().unwrap().floor_finish = Some("Linoleum".into());
        assert_eq!(belag(&p, "og", 1.0, 50.0, serde_json::json!({})).len(), before.len());
    }

    /// [158] Nassraum aus der Nutzung: im Modus „Nassräume" (1:100) zeigt der Raum mit Nutzung „Dusche"
    /// und Plattenbelag sein Muster, auch ohne Deckenbelag und ohne passenden Namen.
    #[test]
    fn belag_nassraum_aus_nutzung() {
        let mut p = belag_projekt(SurfacePatternKind::RunningBond, 0.6, 0.1);
        p.components.push(Component { id: "fliese".into(), name: "Feinsteinzeug".into(), surface_pattern: Some(SurfacePattern { kind: SurfacePatternKind::Grid, spacing: 0.3, height: Some(0.3), ..Default::default() }), ..Default::default() });
        let mut r = p.rooms.as_ref().unwrap()[0].clone();
        r.id = "R-d".into();
        r.floor_id = "og".into();
        r.name = "Raum 7".into();
        r.stamp_anchor = Some(Vec2 { x: 4.5, y: 3.6 });
        r.boundary = vec![Vec2 { x: 3.0, y: 2.0 }, Vec2 { x: 4.8, y: 2.0 }, Vec2 { x: 4.8, y: 3.8 }, Vec2 { x: 3.0, y: 3.8 }];
        r.floor_finish = Some("fliese".into());
        p.rooms.as_mut().unwrap().push(r);
        set_finish(&mut p, "og", Some(FloorFinishDisplay::Wet));
        assert!(belag(&p, "og", 1.0, 100.0, serde_json::json!({})).is_empty(), "ohne Nutzung, Name kein Nassraum");
        p.rooms.as_mut().unwrap().last_mut().unwrap().usage = Some(RoomUsage::Shower);
        let l = belag(&p, "og", 1.0, 100.0, serde_json::json!({}));
        assert!(l.len() >= 4, "{}", l.len());
        // Nutzung „Lager" schlägt den Namen „Bad".
        let last = p.rooms.as_mut().unwrap().last_mut().unwrap();
        last.usage = Some(RoomUsage::Storage);
        last.name = "Bad".into();
        assert!(belag(&p, "og", 1.0, 100.0, serde_json::json!({})).is_empty());
    }

    /// [158] Belagszeile im Raumstempel nur mit Einstellung (Vorgabe aus).
    #[test]
    fn stempel_belagszeile() {
        let mut p = sample();
        p.components.push(Component { id: "par".into(), name: "Parkett Eiche".into(), ..Default::default() });
        let r = &mut p.rooms.as_mut().unwrap()[0];
        r.floor_finish = Some("par".into());
        r.stamp = Some(RoomStamp { name: "Wohnen".into(), show_floor_area: Some(true), ..Default::default() });
        let (floor, cat) = (r.floor_id.clone(), r.category_code.clone());
        let lines = |p: &Project| {
            let t = serde_json::json!({ "floor": floor, "show": [cat], "grey": [], "scale": 50 }).to_string();
            let d = plan_domains(p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
            d.rooms.iter().find_map(|q| match q { Primitive::Text { extra_lines, room_id: Some(_), .. } => Some(extra_lines.iter().map(|l| l.text.clone()).collect::<Vec<_>>()), _ => None }).unwrap()
        };
        assert!(!lines(&p).iter().any(|l| l == "Parkett Eiche"));
        p.rooms.as_mut().unwrap()[0].stamp.as_mut().unwrap().show_finish = Some(true);
        assert!(lines(&p).iter().any(|l| l == "Parkett Eiche"), "{:?}", lines(&p));
    }

    /// [156] Override-Regeln der Bauteilart „floor_finish": ausblenden, erzwingen, färben.
    #[test]
    fn belag_regeln() {
        let mut p = belag_projekt(SurfacePatternKind::Grid, 0.3, 0.3);
        let rule = |actions: serde_json::Value| -> OverrideRule {
            serde_json::from_value(serde_json::json!({"id": "b", "name": "b", "enabled": true, "condition": {"type": "element_kind", "operator": "equals", "value": "floor_finish"}, "actions": actions})).unwrap()
        };
        p.override_rules = Some(vec![rule(serde_json::json!({"hide": true}))]);
        assert!(belag(&p, "og", 1.0, 50.0, serde_json::json!({})).is_empty());
        p.override_rules = Some(vec![rule(serde_json::json!({"hide": false, "color": "#336699", "lineweight": 0.5}))]);
        let l = belag(&p, "og", 1.0, 100.0, serde_json::json!({}));
        assert!(l.len() > 10);
        assert!(l.iter().all(|(_, _, w, c)| c == "#336699" && (*w - 0.05).abs() < 1e-12));
        // Eine allgemeine Regel (Ebene) färbt den Belag nicht.
        p.override_rules = Some(vec![serde_json::from_value(serde_json::json!({"id": "x", "name": "x", "enabled": true, "condition": {"type": "layer_name", "operator": "not_equals", "value": "zzz"}, "actions": {"color": "#ff0000"}})).unwrap()]);
        assert!(belag(&p, "og", 1.0, 50.0, serde_json::json!({})).iter().all(|(.., c)| c == super::super::floor_finish::INK));
    }

    /// [155] Die eigene Decke über der Schnittebene deckt nicht (Bodenbelag und Treppen bleiben sichtbar).
    #[test]
    fn eigene_decke_ueber_schnitt_deckt_nicht() {
        let p = sample();
        let poly = |floor: &str| {
            let t = serde_json::json!({ "floor": floor, "show": ["30"], "grey": [], "scale": 50 }).to_string();
            let r = plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
            let v = serde_json::to_value(&r.ceilings).unwrap();
            v.as_array().unwrap().iter().find(|q| q["ceilingId"] == "C1" && q["kind"] == "polygon").map(|q| q["fill"].as_str().unwrap_or("").to_string())
        };
        assert_eq!(poly("eg").as_deref(), Some("none"));
    }

    /// [155] Treppen sparen den Bodenbelag aus: kein Musterstück schneidet die Treppen-Grundfläche.
    #[test]
    fn belag_ausgespart_unter_treppe() {
        let mut p = sample();
        let ce = p.ceilings.as_ref().unwrap()[0].clone();
        let top = crate::model3d::ceiling_type_ref(&p, &ce).unwrap().2[0].component_id.clone();
        let c = p.components.iter_mut().find(|c| c.id == top).unwrap();
        c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Grid, spacing: 0.3, height: Some(0.3), ..Default::default() });
        // Treppe im OG (steht auf C1)
        let mut st = p.stairs.as_ref().unwrap()[0].clone();
        st.id = "ST2".into();
        st.floor_id = "og".into();
        p.stairs.as_mut().unwrap().push(st.clone());
        let t = serde_json::json!({ "floor": "og", "show": ["30", "40"], "grey": [], "scale": 50 }).to_string();
        let r = plan_domains(&p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap();
        let fp = super::super::stair_symbol::footprint(&crate::stair::decode_params(&st.encode()).unwrap()).remove(0);
        let mut n = 0;
        for q in &r.ceilings {
            if let Primitive::Line { a, b, cls, .. } = q {
                if cls != "floor-finish-pattern" {
                    continue;
                }
                n += 1;
                for k in 1..10 {
                    let t = k as f64 / 10.0;
                    let m = [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
                    let edge = (0..fp.len()).any(|i| {
                        let (u, w) = (fp[i], fp[(i + 1) % fp.len()]);
                        let d = [w[0] - u[0], w[1] - u[1]];
                        let s = (((m[0] - u[0]) * d[0] + (m[1] - u[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1])).clamp(0.0, 1.0);
                        (m[0] - u[0] - d[0] * s).hypot(m[1] - u[1] - d[1] * s) < 1e-6
                    });
                    assert!(!crate::surface_pattern::point_in(m, &fp) || edge, "Belag in der Treppe: {a:?}–{b:?}");
                }
            }
        }
        assert!(n > 10, "Belag ausserhalb bleibt");
    }

    /// [155] Treppe aus dem Geschoss darunter im Deckenloch: ausgezogen, auf das Loch beschnitten, mit
    /// Absturzsicherung an den freien Lochrändern, nicht an der Austrittskante.
    #[test]
    fn ankommende_treppe_im_deckenloch_mit_absturzsicherung() {
        let mut p = sample();
        // ST1: x 3.2 … 4.2, y 0.4 → 3.6 (Austritt bei y = 3.6); Loch in C1 darüber
        let hole = vec![Vec2 { x: 3.2, y: 1.6 }, Vec2 { x: 4.2, y: 1.6 }, Vec2 { x: 4.2, y: 3.6 }, Vec2 { x: 3.2, y: 3.6 }];
        p.ceilings.as_mut().unwrap()[0].openings = Some(vec![hole]);
        let run = |p: &Project| {
            let t = serde_json::json!({ "floor": "og", "show": ["30", "40"], "grey": [], "scale": 50 }).to_string();
            plan_domains(p, &PlanArgs::parse(1.0, &t).unwrap()).unwrap().stairs
        };
        let st = run(&p);
        let lines: Vec<(String, Vec2, Vec2, bool)> = st
            .iter()
            .filter_map(|q| match q {
                Primitive::Line { a, b, cls, dash, stair_id, .. } if stair_id.as_deref() == Some("ST1") => Some((cls.to_string(), *a, *b, dash.as_ref().is_some_and(|d| d.is_some()))),
                _ => None,
            })
            .collect();
        let sym: Vec<_> = lines.iter().filter(|l| l.0 != "stair-guard").collect();
        assert!(sym.iter().any(|l| l.0 == "stair-tread"), "Tritte im Loch sichtbar");
        assert!(sym.iter().all(|l| !l.3), "von oben: alles ausgezogen");
        assert!(sym.iter().all(|l| l.1.y >= 1.6 - 1e-9 && l.2.y >= 1.6 - 1e-9), "auf das Loch beschnitten");
        assert!(sym.iter().all(|l| l.0 != "stair-break"));
        let guard: Vec<_> = lines.iter().filter(|l| l.0 == "stair-guard").collect();
        assert!(!guard.is_empty(), "Absturzsicherung");
        // nicht an der Austrittskante (y = 3.6), aber an der Lochkante y = 1.6 (ausserhalb des Lochs)
        assert!(guard.iter().all(|l| !((l.1.y - 3.6).abs() < 0.1 && (l.2.y - 3.6).abs() < 0.1 && (l.1.x - l.2.x).abs() > 0.2)), "{guard:?}");
        assert!(guard.iter().any(|l| l.1.y < 1.6 && l.2.y < 1.6 && (l.1.x - l.2.x).abs() > 0.5));
        // ohne Loch: nichts von ST1 im OG
        let mut q = p.clone();
        q.ceilings.as_mut().unwrap()[0].openings = None;
        assert!(run(&q).iter().all(|x| !matches!(x, Primitive::Line { stair_id, .. } if stair_id.as_deref() == Some("ST1"))));
        // [157] Nur in Geschoss-Grundrissen: die 2D-Ebene eines Schnitts (Bezugshöhe wie das OG) zeigt keine
        // ankommende Treppe (vorher Wendeltreppen-Symbol mitten im Schnitt A-A, Musterhaus komplex).
        let mut q = p.clone();
        q.drawing_levels.iter_mut().find(|l| l.id == "schnitt-a").unwrap().base_elevation = Some(2.6);
        let t = serde_json::json!({ "floor": "schnitt-a", "show": ["30", "40"], "grey": [], "scale": 50 }).to_string();
        let st = plan_domains(&q, &PlanArgs::parse(1.0, &t).unwrap()).unwrap().stairs;
        assert!(st.iter().all(|x| !matches!(x, Primitive::Line { stair_id, .. } if stair_id.as_deref() == Some("ST1"))), "{st:?}");
    }

    /// [150] Nur der Stempel mit Anker ausserhalb seines Raums wird Hindernis der Höhenlinien-Beschriftungen.
    #[test]
    fn stempel_ausserhalb_des_raums_ist_hindernis() {
        let mut p = sample();
        let t = serde_json::json!({ "floor": "eg", "show": ["20", "21", "30", "40", "50", "60"], "grey": [], "scale": 100 }).to_string();
        let a = PlanArgs::parse(1.0, &t).unwrap();
        let rooms = |p: &Project| plan_domains(p, &a).unwrap().rooms;
        let idx = p.rooms.as_ref().unwrap().iter().position(|r| r.floor_id == "eg" && r.boundary.len() >= 3).unwrap();
        assert!(outside_stamps(&Ctx::new(&p, &a), &rooms(&p)).is_empty(), "Stempel im Raum: kein Hindernis");
        p.rooms.as_mut().unwrap()[idx].stamp_anchor = Some(Vec2 { x: -30.0, y: -30.0 });
        let r = rooms(&p);
        let out = outside_stamps(&Ctx::new(&p, &a), &r);
        assert_eq!(out.len(), 1);
        assert!(out[0].iter().all(|q| (q[0] + 30.0).abs() < 5.0 && (q[1] + 30.0).abs() < 5.0), "{out:?}");
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
        let s = RoomStamp { name: "Bad".into(), show_floor_area: Some(false), show_usage: Some(false), occupancy: Some(1e21), ..Default::default() };
        assert_eq!(room_stamp_extra_lines(&s, 1.0, SiaCategory::VF)[0].text, "1e+21 Pers.");
        let d = room_stamp_to_doc(&RoomStamp { number: Some("  2 ".into()), name: "Bad".into(), name_line2: Some("  ".into()), ..Default::default() });
        assert_eq!(d.paragraphs.len(), 2);
        assert_eq!(d.paragraphs[1].runs[0].text, "2");
    }

    fn stamp(name: &str) -> RoomStamp {
        RoomStamp { name: name.into(), show_floor_area: Some(true), show_usage: Some(true), ..Default::default() }
    }

    #[test]
    fn stempel_dokument() {
        assert_eq!(room_stamp_to_doc(&stamp("Bad")).paragraphs.len(), 1);
        assert_eq!(room_stamp_to_doc(&RoomStamp { name_line2: Some("WC".into()), ..stamp("Bad") }).paragraphs.len(), 2);
        let d = room_stamp_to_doc(&RoomStamp { number: Some("1.01".into()), ..stamp("Bad") });
        // [177] Name (fett) in Zeile 1, Nummer in einer eigenen Zeile darunter.
        assert_eq!(d.paragraphs.len(), 2);
        assert_eq!(d.paragraphs[0].runs[0].text, "Bad");
        assert_eq!(d.paragraphs[0].runs[0].marks.bold, Some(true));
        assert_eq!(d.paragraphs[1].runs[0].text, "1.01");
    }

    #[test]
    fn stempel_zeilen() {
        let l = room_stamp_extra_lines(&RoomStamp { floor_area_prefix: Some("BF ".into()), ..stamp("Bad") }, 12.345, SiaCategory::HNF);
        assert_eq!(l[0].text, "BF 12.35 m²");
        assert_eq!(l[1].text, "HNF · Hauptnutzfläche");
        let off = RoomStamp { show_floor_area: Some(false), show_usage: Some(false), ..stamp("Bad") };
        assert!(room_stamp_extra_lines(&off, 12.345, SiaCategory::HNF).is_empty());
        let r = room_stamp_extra_lines(&RoomStamp { show_usage: Some(false), rounding_step: Some(0.5), ..stamp("Bad") }, 12.34, SiaCategory::HNF);
        assert_eq!(r[0].text, "12.5 m²");
        let o = room_stamp_extra_lines(&RoomStamp { occupancy: Some(4.0), ..off.clone() }, 12.345, SiaCategory::HNF);
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].text, "4 Pers.");
        assert_eq!(o[0].align, Align::Left);
        assert_eq!(format_stamp_area(12.345, None), "12.35");
        assert_eq!(format_stamp_area(12.0, None), "12.00");
        // [171] Stellen nach dem Rundungsschritt: „16.0 m²" neben „3.9 m²", nicht „16 m²".
        assert_eq!(format_stamp_area(12.24, Some(0.5)), "12.0");
        assert_eq!(format_stamp_area(16.02, Some(0.1)), "16.0");
        assert_eq!(format_stamp_area(16.02, Some(0.25)), "16.00");
        assert_eq!(format_stamp_area(16.02, Some(0.05)), "16.00");
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
            category_code: "20".into(),
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
