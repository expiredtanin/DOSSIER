//! [173] Modelldarstellung (≙ Archicad „Modelldarstellung"/Model View Options): zentrale Auflösung der
//! Darstellungsoptionen je Bauteilart.
//!
//! Rangfolge (hoch → tief): **Element-Einstellung > Typ-Einstellung > Modelldarstellung der Ansicht >
//! Basis-Detailgrad**. Diese Datei löst die beiden unteren Stufen auf ([`resolve`]: Modelldarstellung über
//! dem Basis-Detailgrad); Element und Typ setzt der Aufrufer davor (Helfer wie [`DoorOpts::lintel`]).
//!
//! Welche Modelldarstellung gilt: ausdrücklich angefragt (`PlanArgs`, CLI `--model-view`, Blatt-Ausschnitt)
//! oder das Feld `modelViewOptionId` der Ebene (Ansichtsvorlage, Werkzeugleiste). Die Stufen „grob",
//! „mittel", „fein" sind eingebaut: ohne Optionen, nur der Detailgrad ([`base_of`]). Eine eigene Stufe
//! (`Project.modelViewOptions`) kann den Detailgrad ersetzen (`baseDetail`); jede Option ohne Wert heisst
//! „wie Basis" und zeichnet exakt wie bisher.
//!
//! Etappe 1 bindet Türen, Fenster, Treppen und Wände (Schichten) an, dazu die Ebenen-Schalter Schnittflächen,
//! Bodenbelag und Gelände (die Felder der Ebene gehen der Modelldarstellung vor). Etappe 2: Schnitt (Schichten
//! von Wänden, Decken, Dächern; Tür-/Fensterdetail; Bodenaufbau; Treppen hinter dem Schnitt, Handlauf),
//! Decken/Dächer/Stützen im Grundriss, Ansicht (Schatten, Materialschraffur, Fensterteilung), Schwelle und
//! Sturzlinie der Fenster im Grundriss, „nur Kern" als echte Kerndicke, 3D (Handlauf, Öffnungsdetail).

use super::style::{simplify_thin_layers, Detail, THIN_LAYER_PAPER_MM};
use crate::model::*;

/// Ids der eingebauten Stufen (stehen nicht in `Project.modelViewOptions`).
pub const BUILTIN: [&str; 3] = ["grob", "mittel", "fein"];

/// Detailgrad einer eingebauten Stufe.
pub fn builtin_detail(id: &str) -> Option<Detail> {
    match id {
        "grob" => Some(Detail::Grob),
        "mittel" => Some(Detail::Mittel),
        "fein" => Some(Detail::Fein),
        _ => None,
    }
}

pub fn detail_of(d: DetailLevel) -> Option<Detail> {
    match d {
        DetailLevel::Grob => Some(Detail::Grob),
        DetailLevel::Mittel => Some(Detail::Mittel),
        DetailLevel::Fein => Some(Detail::Fein),
        DetailLevel::Unknown => None,
    }
}

/// Eigene Modelldarstellung nach Id; eine eingebaute Stufe oder eine unbekannte Id ⇒ `None`.
pub fn find<'a>(p: &'a Project, id: &str) -> Option<&'a ModelViewOption> {
    p.model_view_options.as_deref()?.iter().find(|m| m.id == id)
}

/// Eigene Modelldarstellung nach Name (CLI `--model-view <Name>`), ohne Gross-/Kleinschreibung; auch die Id.
pub fn find_by_name<'a>(p: &'a Project, name: &str) -> Option<&'a ModelViewOption> {
    let list = p.model_view_options.as_deref()?;
    list.iter().find(|m| m.name == name).or_else(|| list.iter().find(|m| m.name.to_lowercase() == name.to_lowercase())).or_else(|| list.iter().find(|m| m.id == name))
}

/// Die wirksame Modelldarstellungs-Id einer Plan-Erzeugung: ausdrücklich angefragt, sonst die der Ebene.
pub fn selected_id<'a>(p: &'a Project, level_id: &str, requested: Option<&'a str>) -> Option<&'a str> {
    requested.filter(|s| !s.is_empty()).or_else(|| p.floor(level_id).and_then(|l| l.model_view_option_id.as_deref()).filter(|s| !s.is_empty()))
}

/// Basis-Detailgrad einer Modelldarstellung (eingebaut: ihre Stufe; eigen: `baseDetail`); `None` = der
/// angefragte Detailgrad bleibt.
pub fn base_of(p: &Project, id: &str) -> Option<Detail> {
    builtin_detail(id).or_else(|| find(p, id).and_then(|m| m.base_detail).and_then(detail_of))
}

// ── Aufgelöste Optionen ─────────────────────────────────────────────────────

/// Türen.
#[derive(Clone, Debug, PartialEq)]
pub struct DoorOpts {
    /// Sturzlinie der Modelldarstellung (Element und Typ gehen vor, s. [`DoorOpts::lintel`]).
    pub lintel_mv: Option<LintelLineStyle>,
    /// Öffnungswinkel der Modelldarstellung (das Element geht vor, s. [`DoorOpts::swing_angle`]).
    pub swing_angle_mv: Option<f64>,
    /// Aufschlagbogen zeichnen; `None` = wie Basis (der Massstab entscheidet in `walls.rs`: Übersicht ohne).
    pub swing_arc: Option<bool>,
    /// Zarge/Rahmen zeichnen.
    pub frame: bool,
    /// Türblatt als Rechteck mit Blattdicke (sonst Strich).
    pub leaf_rect: bool,
    /// Schwelle im Grundriss.
    pub threshold: Threshold,
    /// Zarge, Blatt und Sturz im Schnitt (sonst nur das Blatt).
    pub section_detail: bool,
}

/// Schwelle der Türen im Grundriss.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Threshold {
    Off,
    LiftSlide,
    All,
}

impl Threshold {
    /// Schwelle bei dieser Tür (`lift_slide`: Hebeschiebetür)?
    pub fn at(self, lift_slide: bool) -> bool {
        match self {
            Threshold::Off => false,
            Threshold::LiftSlide => lift_slide,
            Threshold::All => true,
        }
    }
}

impl DoorOpts {
    /// Sturzlinie: Element > Türtyp > Modelldarstellung > gestrichelt.
    pub fn lintel(&self, element: Option<LintelLineStyle>, ty: Option<LintelLineStyle>) -> LintelLineStyle {
        element.or(ty).or(self.lintel_mv).filter(|s| *s != LintelLineStyle::Unknown).unwrap_or(LintelLineStyle::Gestrichelt)
    }
    /// Öffnungswinkel in Grad: Element > Modelldarstellung; `None` = Basis (90°).
    pub fn swing_angle(&self, element: Option<f64>) -> Option<f64> {
        element.or(self.swing_angle_mv).filter(|a| a.is_finite())
    }
}

/// Fenster.
#[derive(Clone, Debug, PartialEq)]
pub struct WindowOpts {
    pub sash_symbols_mv: Option<bool>,
    pub plan_swing_arcs_mv: Option<bool>,
    /// Fensterbank im Grundriss.
    pub sill: bool,
    /// Flügelrahmen im Grundriss.
    pub sash_frames: bool,
    /// Sturzlinie im Grundriss.
    pub lintel_line: bool,
    /// Rahmen, Kämpfer, Sturz, Fensterbank und Storen im Schnitt (sonst Rahmen und Glas).
    pub section_detail: bool,
    /// Fensterteilung (Flügel, Sprossen, Kämpfer) in der Ansicht.
    pub elevation_division: bool,
}

impl WindowOpts {
    /// Öffnungslinien in der Ansicht: Element > Fenstertyp > Modelldarstellung > ja.
    pub fn sash_symbols(&self, element: Option<bool>, ty: Option<bool>) -> bool {
        element.or(ty).or(self.sash_symbols_mv).unwrap_or(true)
    }
    /// Aufschlagbögen im Grundriss: Element > Fenstertyp > Modelldarstellung > nein.
    pub fn plan_swing_arcs(&self, element: Option<bool>, ty: Option<bool>) -> bool {
        element.or(ty).or(self.plan_swing_arcs_mv).unwrap_or(false)
    }
}

/// Treppen.
#[derive(Clone, Debug, PartialEq)]
pub struct StairOpts {
    pub walk_line: bool,
    pub arrow: bool,
    pub break_line: bool,
    /// Stufen, Wange und Handlauf über der Schnitthöhe (gestrichelt) zeichnen.
    pub above_cut: bool,
    /// Handlauf: `None` aus, `Some(false)` einfach, `Some(true)` doppelt (aus: auch im Schnitt und im 3D).
    pub handrail: Option<bool>,
    /// Treppen hinter der Schnittebene im Schnitt (Stufen, Wangen, Geländer).
    pub section_beyond: bool,
    /// Versatz der Lauflinie an Anfang und Ende (Papier-mm).
    pub run_start_mm: f64,
    pub run_end_mm: f64,
    /// Antrittspunkt am Anfang der Lauflinie.
    pub start_mark: bool,
}

/// Wände.
#[derive(Clone, Debug, PartialEq)]
pub struct WallOpts {
    pub layers: LayerMode,
    /// Papierdicke (mm), unter der eine Schicht als dünn gilt.
    pub thin_mm: f64,
    pub reveals: bool,
    /// Schnittflächen schraffiert (die Ebene geht vor, s. [`Options::cut_hatch`]).
    pub cut_hatch_mv: Option<bool>,
}

/// Decken und Böden.
#[derive(Clone, Debug, PartialEq)]
pub struct SlabOpts {
    /// Schichten im Schnitt.
    pub layers: LayerMode,
    /// Bodenaufbau (Schichten über der tragenden) im Schnitt als eine Fläche.
    pub build_up_merged: bool,
    /// Umriss im Grundriss.
    pub outline: bool,
    /// Ansichtsschraffur im Grundriss.
    pub view_hatch: bool,
}

/// Dächer.
#[derive(Clone, Debug, PartialEq)]
pub struct RoofOpts {
    /// Schichten im Schnitt.
    pub layers: LayerMode,
    /// Dachrand, First, Grate über der Schnitthöhe im Grundriss.
    pub overhead: bool,
    /// Ansichtsschraffur und Muster der Eindeckung in der Dachaufsicht.
    pub view_hatch: bool,
}

/// Geschnittene Stütze: `None` = wie Basis (Schraffur, ab 1:100 schwarz).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CutFill {
    Material,
    Solid,
    Empty,
}

/// Ansicht (Fassade).
#[derive(Clone, Debug, PartialEq)]
pub struct ElevOpts {
    /// Schlagschatten der Modelldarstellung (die Ebene geht vor, s. [`Options::shadows`]).
    pub shadows_mv: Option<bool>,
    /// Ansichtsschraffur der Baustoffe.
    pub material_hatch: bool,
}

/// Schichten einer geschnittenen Wand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayerMode {
    /// Alle Schichten mit Fugen.
    All,
    /// Dünne Schichten (unter `thin_mm` Papier) gehen in der Nachbarschicht auf — `force`: auch in „fein"
    /// und in jedem Massstab (sonst die heutige Regel `style::simplify_thin_layers`).
    Simplified { force: bool },
    /// Nur die tragende Schicht in ihrer echten Dicke (übrige Schichten entfallen; `overrides::layer_positions`).
    Core,
}

/// Alle aufgelösten Optionen einer Ansicht (Modelldarstellung über dem Basis-Detailgrad).
#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub detail: Detail,
    pub door: DoorOpts,
    pub window: WindowOpts,
    pub stair: StairOpts,
    pub wall: WallOpts,
    pub slab: SlabOpts,
    pub roof: RoofOpts,
    pub column_fill: Option<CutFill>,
    pub elevation: ElevOpts,
    pub floor_finish_mv: Option<FloorFinishDisplay>,
    pub terrain_mv: Option<bool>,
    /// [176] Markentyp der Schnitte laut Modelldarstellung (die Ebene geht vor, s. [`Options::section_marker`]).
    pub section_marker_mv: Option<SectionMarkerStyle>,
}

impl Options {
    /// Schnittflächen schraffiert: Ebene > Modelldarstellung > nein.
    pub fn cut_hatch(&self, level: Option<bool>) -> bool {
        level.or(self.wall.cut_hatch_mv).unwrap_or(false)
    }
    /// Bodenbelag: Ebene > Modelldarstellung > automatisch (`None`).
    pub fn floor_finish(&self, level: Option<FloorFinishDisplay>) -> Option<FloorFinishDisplay> {
        level.or(self.floor_finish_mv)
    }
    /// Gelände: Ebene > Modelldarstellung > automatisch (`None`).
    pub fn terrain(&self, level: Option<bool>) -> Option<bool> {
        level.or(self.terrain_mv)
    }
    /// [176] Schnittmarke: Ebene > Modelldarstellung > Pfeil.
    pub fn section_marker(&self, level: Option<SectionMarkerStyle>) -> SectionMarkerStyle {
        level.filter(|s| *s != SectionMarkerStyle::Unknown).or(self.section_marker_mv).unwrap_or(SectionMarkerStyle::Arrow)
    }
    /// Schlagschatten der Ansicht: Ebene > Modelldarstellung > aus.
    pub fn shadows(&self, level: Option<bool>) -> bool {
        level.or(self.elevation.shadows_mv).unwrap_or(false)
    }
    /// Werden bei 1:`scale` dünne Wandschichten vereinfacht?
    pub fn simplify_thin(&self, scale: f64) -> bool {
        self.simplify_thin_in(self.wall.layers, scale)
    }
    /// Werden bei 1:`scale` dünne Schichten im Modus `m` vereinfacht?
    pub fn simplify_thin_in(&self, m: LayerMode, scale: f64) -> bool {
        match m {
            LayerMode::All | LayerMode::Core => false,
            LayerMode::Simplified { force: true } => scale.is_finite() && scale > 0.0,
            LayerMode::Simplified { force: false } => simplify_thin_layers(self.detail, scale),
        }
    }
}

/// Die tragende Schicht eines Aufbaus ([33] `overrides::layer_positions`: Funktion „tragend", Rang, Dicke).
pub fn core_layer(p: &Project, layers: &[Layer]) -> Option<usize> {
    super::overrides::layer_positions(p, layers).iter().position(|s| *s == "structure")
}

/// Die aufgelösten Optionen einer Ansicht: Modelldarstellung `id` (eingebaut oder eigen; fehlt/unbekannt =
/// nur der Detailgrad) über dem Detailgrad `detail` — ihre Basis ersetzt ihn, s. [`base_of`].
pub fn for_view(p: &Project, id: Option<&str>, detail: Detail, scale: f64) -> Options {
    let id = id.filter(|s| !s.is_empty());
    let detail = id.and_then(|id| base_of(p, id)).unwrap_or(detail);
    resolve(id.and_then(|id| find(p, id)), detail, scale)
}

fn layer_mode(m: Option<ModelViewLayers>) -> LayerMode {
    match m {
        Some(ModelViewLayers::All) => LayerMode::All,
        Some(ModelViewLayers::Simplified) => LayerMode::Simplified { force: true },
        Some(ModelViewLayers::Core) => LayerMode::Core,
        _ => LayerMode::Simplified { force: false },
    }
}

/// Bauteilart für [`resolve_kind`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Door,
    Window,
    Stair,
    Wall,
}

/// Die Optionen einer Bauteilart.
#[derive(Clone, Debug, PartialEq)]
pub enum KindOpts {
    Door(DoorOpts),
    Window(WindowOpts),
    Stair(StairOpts),
    Wall(WallOpts),
}

/// Modelldarstellung `mv` (fehlt = eingebaute Stufe) über dem Basis-Detailgrad `detail` bei 1:`scale`.
pub fn resolve(mv: Option<&ModelViewOption>, detail: Detail, scale: f64) -> Options {
    let fein = detail == Detail::Fein;
    let d = mv.and_then(|m| m.doors.as_ref());
    let w = mv.and_then(|m| m.windows.as_ref());
    let s = mv.and_then(|m| m.stairs.as_ref());
    let wl = mv.and_then(|m| m.walls.as_ref());
    let sl = mv.and_then(|m| m.slabs.as_ref());
    let rf = mv.and_then(|m| m.roofs.as_ref());
    let el = mv.and_then(|m| m.elevation.as_ref());
    let handrail = match s.and_then(|s| s.handrail) {
        Some(ModelViewHandrail::Off) => None,
        Some(ModelViewHandrail::Single) => Some(false),
        Some(ModelViewHandrail::Double) => Some(true),
        // [151] Basis: doppelt ab 1:50 bzw. fein.
        _ => Some(scale <= 50.0 || fein),
    };
    Options {
        detail,
        door: DoorOpts {
            lintel_mv: d.and_then(|d| d.lintel_line_style).filter(|s| *s != LintelLineStyle::Unknown),
            swing_angle_mv: d.and_then(|d| d.swing_angle).filter(|a| a.is_finite()),
            swing_arc: d.and_then(|d| d.swing_arc),
            frame: d.and_then(|d| d.frame).unwrap_or(true),
            leaf_rect: match d.and_then(|d| d.leaf) {
                Some(ModelViewLeaf::Rect) => true,
                Some(ModelViewLeaf::Line) => false,
                _ => fein,
            },
            threshold: match d.and_then(|d| d.threshold) {
                Some(ModelViewThreshold::LiftSlide) => Threshold::LiftSlide,
                Some(ModelViewThreshold::All) => Threshold::All,
                _ => Threshold::Off,
            },
            section_detail: d.and_then(|d| d.section_detail).unwrap_or(true),
        },
        window: WindowOpts {
            sash_symbols_mv: w.and_then(|w| w.sash_symbols),
            plan_swing_arcs_mv: w.and_then(|w| w.plan_swing_arcs),
            sill: w.and_then(|w| w.sill).unwrap_or(fein),
            sash_frames: w.and_then(|w| w.sash_frames).unwrap_or(fein),
            lintel_line: w.and_then(|w| w.lintel_line).unwrap_or(false),
            section_detail: w.and_then(|w| w.section_detail).unwrap_or(true),
            elevation_division: w.and_then(|w| w.elevation_division).unwrap_or(true),
        },
        stair: StairOpts {
            walk_line: s.and_then(|s| s.walk_line).unwrap_or(true),
            arrow: s.and_then(|s| s.arrow).unwrap_or(true),
            break_line: s.and_then(|s| s.break_line).unwrap_or(true),
            above_cut: s.and_then(|s| s.above_cut) != Some(ModelViewAboveCut::Off),
            handrail,
            section_beyond: s.and_then(|s| s.section_beyond).unwrap_or(true),
            run_start_mm: s.and_then(|s| s.run_start_mm).filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(0.0),
            run_end_mm: s.and_then(|s| s.run_end_mm).filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(0.0),
            start_mark: s.and_then(|s| s.start_mark).unwrap_or(false),
        },
        wall: WallOpts {
            layers: layer_mode(wl.and_then(|w| w.layers)),
            thin_mm: wl.and_then(|w| w.thin_layer_mm).filter(|t| t.is_finite() && *t >= 0.0).unwrap_or(THIN_LAYER_PAPER_MM),
            reveals: wl.and_then(|w| w.reveals).unwrap_or(true),
            cut_hatch_mv: wl.and_then(|w| w.cut_hatch),
        },
        slab: SlabOpts {
            layers: layer_mode(sl.and_then(|s| s.layers)),
            build_up_merged: sl.and_then(|s| s.build_up) == Some(ModelViewBuildUp::Merged),
            outline: sl.and_then(|s| s.outline).unwrap_or(true),
            view_hatch: sl.and_then(|s| s.view_hatch).unwrap_or(detail != Detail::Grob),
        },
        roof: RoofOpts {
            layers: layer_mode(rf.and_then(|r| r.layers)),
            overhead: rf.and_then(|r| r.overhead).unwrap_or(true),
            view_hatch: rf.and_then(|r| r.view_hatch).unwrap_or(true),
        },
        column_fill: match mv.and_then(|m| m.columns.as_ref()).and_then(|c| c.cut_fill) {
            Some(ModelViewCutFill::Material) => Some(CutFill::Material),
            Some(ModelViewCutFill::Solid) => Some(CutFill::Solid),
            Some(ModelViewCutFill::Empty) => Some(CutFill::Empty),
            _ => None,
        },
        elevation: ElevOpts { shadows_mv: el.and_then(|e| e.shadows), material_hatch: el.and_then(|e| e.material_hatch).unwrap_or(true) },
        floor_finish_mv: mv.and_then(|m| m.slabs.as_ref()).and_then(|s| s.floor_finish).filter(|f| *f != FloorFinishDisplay::Unknown),
        terrain_mv: mv.and_then(|m| m.site.as_ref()).and_then(|s| s.terrain),
        section_marker_mv: mv.and_then(|m| m.section_marks.as_ref()).and_then(|s| s.style).filter(|s| *s != SectionMarkerStyle::Unknown),
    }
}

/// `resolve(ctx, element_kind)`: die Optionen einer Bauteilart in einer Plan-Erzeugung.
pub fn resolve_kind(c: &super::domains::Ctx, kind: Kind) -> KindOpts {
    let o = c.mv();
    match kind {
        Kind::Door => KindOpts::Door(o.door.clone()),
        Kind::Window => KindOpts::Window(o.window.clone()),
        Kind::Stair => KindOpts::Stair(o.stair.clone()),
        Kind::Wall => KindOpts::Wall(o.wall.clone()),
    }
}

/// Die eingebauten Stufen als Modelldarstellungen (für Listen in UI/CLI): Id, Name, Basis.
pub fn builtins() -> Vec<ModelViewOption> {
    [("grob", "Grob", DetailLevel::Grob), ("mittel", "Mittel", DetailLevel::Mittel), ("fein", "Fein", DetailLevel::Fein)]
        .into_iter()
        .map(|(id, name, d)| ModelViewOption { id: id.into(), name: name.into(), base_detail: Some(d), ..Default::default() })
        .collect()
}

#[cfg(test)]
#[path = "model_view_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "model_view_tests2.rs"]
mod tests2;
