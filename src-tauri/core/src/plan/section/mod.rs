//! Schnitt auf dem Dokument ([K3c]): Rust-Gegenstück zu `src/plan/toSection.ts` (Besitzer-Zuordnung,
//! Schicht-Bänder, Stil-Auflösung, Decken-Terminierung, Dominanz, Treppen, Monolith-Vereinigung,
//! Abzugskörper, Körper, Gelände, Schnitt-Tiefe), `generateSectionPlan` (Primitive mit Pick-Ids) und
//! `sectionOpenings.ts` (geschnittene Fenster/Türen). Der analytische Prismen-Schnitt läuft über
//! `render3d::section::cut_polygons` (dieselbe Rechnung wie früher im render3d-WASM). Die Projektion
//! hinter der Ebene rechnet `projection_edges` mit exakter Sichtbarkeit (`hlr.rs`, [G4]).
//! Rechenreihenfolge und Zahlsemantik wie in TS (`jsnum`, `jsmath`), damit die Ausgabe bitgleich bleibt.
//!
//! Einheiten: Meter; Ausgabe in (u, v) = (entlang der Ebene, absolute Höhe).

use super::overrides::RuleView;
use super::prim::{HatchRender, Primitive};
use super::style::*;
use crate::jsmath::hypot2;
use crate::jsnum::{atan2, max, min, round};
use crate::model::*;
use crate::model3d::{self, RSlab, RWall, SlabSource};
use std::collections::{HashMap, HashSet};

// Teile des Schnitts ([162] aus einer Datei aufgeteilt; Reihenfolge = Rechenweg).
mod input;
mod bands;
mod shapes;
mod voids;
mod meshes;
mod projection;
mod primitives;
mod openings;
mod query;
pub mod unfold;

use input::*;
pub use bands::*;
use shapes::*;
use voids::*;
pub(crate) use meshes::*;
use projection::*;
pub use primitives::*;
pub use openings::*;
pub use query::*;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod bench;
#[cfg(test)]
mod ts_faelle;
#[cfg(test)]
mod dach_faelle;
#[cfg(test)]
mod abzug_faelle;
#[cfg(test)]
mod wand_an_dach;
#[cfg(test)]
mod mesh_tests;
#[cfg(test)]
mod unfold_tests;

/// Tinte der Schnitt-Poché-Umrisslinie (dunkles Grau).
const SECTION_INK: &str = "#1f242c";
const SECTION_VISIBLE_INK: &str = "#2b3039";
const SECTION_HIDDEN_INK: &str = "#8a929c";
/// [140] Umriss der geschnittenen Masse (Vereinigung aller Schnittflächen): schwer wie die Wand im Grundriss
/// (grösste Standard-Stärke 0.25 bei 1:100, Entscheid Maintainer).
const SECTION_CUT_OUTLINE_MM: f64 = 0.25;
/// [140] Fugen zwischen Schichten/Bauteilen innerhalb der geschnittenen Masse: fein.
const SECTION_JOINT_MM: f64 = 0.13;
const SECTION_VISIBLE_MM: f64 = 0.18;
const SECTION_GROUND_MM: f64 = 0.25;
const SECTION_HIDDEN_MM: f64 = 0.13;
const SECTION_HIDDEN_DASH: [f64; 2] = super::line_pattern::HIDDEN;
/// [T6] gewachsenes Terrain im Schnitt: gestrichelt, dünner als das gestaltete.
const SECTION_NATURAL_MM: f64 = 0.25;
const SECTION_NATURAL_DASH: [f64; 2] = super::line_pattern::DASHED_LONG;
/// Achswinkel geschnittener Wände/Decken für wandrelative Muster (s. `toSection.ts`).
const SECTION_WALL_AXIS_ANGLE_DEG: f64 = 90.0;
/// Decken liegen: wandbezogene Muster laufen waagrecht entlang der Schicht ([109]; vorher 90° wie Wände,
/// dann lagen Querstriche der Dämmung längs und die Dämmschlange stand quer).
const SECTION_SLAB_AXIS_ANGLE_DEG: f64 = 0.0;
/// Seitenrand (m) der Geländelinie um den Inhalt des Schnitts.
const TERRAIN_MARGIN: f64 = 6.0;
/// Neutrale Füllung geschnittener freier Körper.
pub(crate) const BODY_FILL: &str = "#d9dde2";

/// Rückfall-Schraffur der Cut-Flächen ohne auflösbares Bauteil.
pub(crate) fn section_hatch() -> HatchRender {
    HatchRender { pattern: HatchPattern::Diagonal, scale: 1.0, angle: 45.0, color: HATCH_INK.into(), line_weight: 0.13, ..no_hatch_base() }
}

fn no_hatch_base() -> HatchRender {
    HatchRender { dash: None, ..no_hatch() }
}

// ── Ebene ─────────────────────────────────────────────────────────────────────

/// Schnitt-/Ansichtsebene einer Zeichnungsebene (`sectionPlaneFromLevel`): Punkt (x, 0, y) und
/// horizontale Normale (Blickrichtung).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plane {
    pub point: [f64; 3],
    pub normal: [f64; 3],
}

impl Plane {
    /// u-Achse in Grundriss-Koordinaten (`sectionUAxisModel`): Blickrichtungs-RECHTS.
    pub fn u_model(&self) -> (f64, f64) {
        (self.normal[2], -self.normal[0])
    }
    pub fn base(&self) -> (f64, f64) {
        (self.point[0], self.point[2])
    }
}

/// Die Felder einer Schnitt-/Ansichtsebene, die die Projektion bestimmen (aus dem Aufruf).
#[derive(Clone, Debug, Default)]
pub struct LevelSpec {
    pub kind: String,
    pub line: Option<[Vec2; 2]>,
    /// [176] Knickpunkte zwischen `line[0]` und `line[1]` (geknickter Schnitt, s. `unfold.rs`); leer = gerade.
    pub bends: Vec<Vec2>,
    pub direction_sign: Option<f64>,
    pub depth: Option<f64>,
    pub shadows: bool,
    /// Verdeckte Kanten gestrichelt zeigen ([G4], Ansicht; der Schnitt liest es aus dem Aufruf).
    pub hidden_lines: bool,
    /// Skizzenstil ([67]).
    pub sketch: bool,
    /// [140] Schnittflächen auch ab 1:100 schraffiert statt schwarz (`style::solid_cut`).
    pub cut_hatch: bool,
    /// [173] Modelldarstellung der Ebene (`modelViewOptionId`; Ansicht: Öffnungslinien der Fenster).
    pub model_view: Option<String>,
}

impl LevelSpec {
    pub fn from_json(v: &serde_json::Value) -> LevelSpec {
        let num = |k: &str| v.get(k).and_then(|x| x.as_f64());
        let pt = |q: &serde_json::Value| -> Option<Vec2> { Some(Vec2 { x: q.get("x")?.as_f64()?, y: q.get("y")?.as_f64()? }) };
        let line = v.get("linePoints").and_then(|l| l.as_array()).and_then(|a| Some([pt(a.first()?)?, pt(a.get(1)?)?]));
        LevelSpec {
            kind: v.get("kind").and_then(|k| k.as_str()).unwrap_or_default().to_string(),
            line,
            bends: v.get("bendPoints").and_then(|b| b.as_array()).map(|a| a.iter().filter_map(pt).collect()).unwrap_or_default(),
            direction_sign: num("directionSign"),
            depth: num("depth"),
            shadows: v.get("shadows").and_then(|b| b.as_bool()).unwrap_or(false),
            hidden_lines: v.get("hiddenLines").and_then(|b| b.as_bool()).unwrap_or(false),
            sketch: v.get("sketch").and_then(|b| b.as_bool()).unwrap_or(false),
            cut_hatch: v.get("cutHatch").and_then(|b| b.as_bool()).unwrap_or(false),
            model_view: v.get("modelViewOptionId").and_then(|m| m.as_str()).filter(|m| !m.is_empty()).map(String::from),
        }
    }

    pub fn plane(&self) -> Option<Plane> {
        let [p0, p1] = self.line?;
        let dx = p1.x - p0.x;
        let dy = p1.y - p0.y;
        let len = hypot2(dx, dy);
        if len < 1e-9 {
            return None;
        }
        let ux = dx / len;
        let uy = dy / len;
        let sign = self.direction_sign.unwrap_or(1.0);
        Some(Plane { point: [p0.x, 0.0, p0.y], normal: [-uy * sign, 0.0, ux * sign] })
    }
}

/// Sichtbarkeit der Kategorien (UI-Zustand des Aufrufers): `vis` = Codes, die in `visibleCodes`
/// fehlen (nur mit `has_vis`), `norender`/`grey` aus dem Darstellungsmodus (nur mit `has_display`).
#[derive(Clone, Debug, Default)]
pub struct Visibility {
    pub has_vis: bool,
    pub invisible: HashSet<String>,
    pub has_display: bool,
    pub norender: HashSet<String>,
    pub grey: HashSet<String>,
}

impl Visibility {
    pub fn from_json(v: &serde_json::Value) -> Visibility {
        let set = |k: &str| -> HashSet<String> { v.get(k).and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default() };
        Visibility {
            has_vis: v.get("hasVis").and_then(|b| b.as_bool()).unwrap_or(false),
            invisible: set("invisible"),
            has_display: v.get("hasDisplay").and_then(|b| b.as_bool()).unwrap_or(false),
            norender: set("norender"),
            grey: set("grey"),
        }
    }
    /// `visibleCodes.has(code)` (ohne `visibleCodes`: wahr).
    pub fn visible(&self, code: &str) -> bool {
        !self.has_vis || !self.invisible.contains(code)
    }
    /// `categoryDisplay(code).render` (Rückfall SHOW_ALL).
    pub fn render(&self, code: &str) -> bool {
        !self.norender.contains(code)
    }
    pub fn greyed(&self, code: &str) -> bool {
        self.grey.contains(code)
    }
}

// ── Cut-Bänder ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Wall,
    Slab,
    Roof,
    Body,
    /// [152] Importiertes Netz (`ImportedMesh`); `index` zeigt in `Output::meshes`.
    Mesh,
}

/// Ein geschnittenes Band (`SectionCutPolygon`).
#[derive(Clone, Debug)]
pub struct Cut {
    pub kind: Kind,
    pub index: usize,
    pub pts: Vec<[f64; 2]>,
    pub nse: Option<Vec<f64>>,
    pub fill: Option<String>,
    pub hatch: Option<HatchRender>,
    pub join_priority: Option<f64>,
    pub component_id: Option<String>,
    pub source_id: Option<String>,
    pub category: Option<String>,
    pub stair_id: Option<String>,
    /// [33] Index der Schicht im Aufbau des Bauteils (Wand-, Decken-, Dachtyp), wo bekannt.
    pub layer_index: Option<usize>,
    /// [33] Override der Schicht (nur beim Zeichnen gesetzt, [`cut_overrides`]).
    pub ov: Option<CutOv>,
}

impl Cut {
    fn new(kind: Kind, index: usize, pts: Vec<[f64; 2]>) -> Cut {
        Cut { kind, index, pts, nse: None, fill: None, hatch: None, join_priority: None, component_id: None, source_id: None, category: None, stair_id: None, layer_index: None, ov: None }
    }
}

/// [33] Schraffur-Aktion eines Overrides auf eine Schnittfläche.
#[derive(Clone, Debug, PartialEq)]
pub enum HatchOv {
    /// Wie ohne Regel (schwarz ab 1:100 nur, wenn die Regel auch keine Füllung setzt).
    Keep,
    /// Ohne Muster.
    None,
    /// Schraffur des Baustoffs, auch ab 1:100.
    Material,
    /// Eine Schraffur des Projekts.
    Pattern(HatchRender),
}

/// [33] Override einer Schnittfläche (aus `plan::overrides::layer_actions`).
#[derive(Clone, Debug, PartialEq)]
pub struct CutOv {
    pub fill: Option<String>,
    pub hatch: HatchOv,
    pub outline: Option<bool>,
    /// [33] Linienstil der Fugen/Umrisse (Schicht-Regel): `Some(None)` durchgezogen, `Some(Some(m))` Muster.
    pub dash: Option<Option<Vec<f64>>>,
}

impl CutOv {
    /// Hebt die Regel „schwarz ab 1:100“ auf?
    fn styles(&self) -> bool {
        self.fill.is_some() || self.hatch != HatchOv::Keep
    }
}

/// [33] Zeichen-Regeln der Schnittflächen: lose Schüttungen (Bauteil-ids, s. [`loose_fill_components`]) und
/// Overrides je Fläche von `Output::cuts` (gleiche Reihenfolge; leer = keine).
#[derive(Default)]
pub struct CutRules {
    pub loose: HashSet<String>,
    pub ov: Vec<Option<CutOv>>,
    /// [33] Regeln für Gelände (Geländelinie, Erdreich): Ausblenden, Linie, Füllung/Schraffur.
    pub terrain: Option<(super::overrides::Actions, super::overrides::LayerActions)>,
    /// [33] Strichmuster der Gelände-Regel (Linienstil).
    pub terrain_dash: Option<Option<Vec<f64>>>,
    /// [33] Projekt-Schraffur der Gelände-Regel fürs Erdreich.
    pub terrain_hatch: Option<HatchRender>,
    /// [152] Linien-Aktionen (Farbe, Stärke, Linienstil) je importiertem Netz (`Output::meshes`-Index).
    pub mesh: HashMap<usize, MeshLineStyle>,
}

impl CutRules {
    /// `v`: Massstab und eingeschaltete Regeln der Darstellung ([`super::overrides::RuleView`]).
    pub fn of(p: &Project, out: &Output, v: RuleView) -> CutRules {
        let ts = crate::excavation::terrains(p);
        let t = out.terrain_id.as_deref().and_then(|id| ts.iter().find(|t| t.id == id)).or(ts.first());
        let terrain = if out.profiles.is_empty() && out.earth.is_empty() { None } else { t.and_then(|t| super::overrides::terrain_override(p, v, Some(&t.category_code), &t.name)) };
        let terrain_dash = terrain.as_ref().and_then(|(a, _)| super::overrides::linetype_dash(p, a.linetype_id.as_deref()));
        let terrain_hatch = terrain.as_ref().and_then(|(_, l)| l.hatch.as_deref()).filter(|h| !matches!(*h, "none" | "material")).and_then(|id| resolve_hatch(p, id, None, None, None));
        let mut ov = cut_overrides(p, &out.cuts, v);
        let mut mesh = HashMap::new();
        // [152] Importierte Netze: Regeln über Ebene, Name und Bauteilart „mesh" (Fläche und Linien).
        if !out.meshes.is_empty() && super::overrides::has_active(p, v) {
            let rules: Vec<Option<(super::overrides::Actions, Option<CutOv>)>> = out.meshes.iter().map(|m| mesh_override(p, m, v)).collect();
            if out.cuts.iter().any(|c| c.kind == Kind::Mesh && rules.get(c.index).is_some_and(|r| r.as_ref().is_some_and(|r| r.1.is_some()))) {
                ov.resize(out.cuts.len(), None);
                for (i, c) in out.cuts.iter().enumerate().filter(|(_, c)| c.kind == Kind::Mesh) {
                    ov[i] = rules.get(c.index).and_then(|r| r.as_ref()).and_then(|r| r.1.clone());
                }
            }
            mesh = rules.into_iter().enumerate().filter_map(|(i, r)| r.filter(|r| r.0.any()).map(|r| (i, MeshLineStyle { color: r.0.color.clone(), weight: r.0.lineweight.filter(|w| w.is_finite() && *w >= 0.0), dash: super::overrides::linetype_dash(p, r.0.linetype_id.as_deref()) }))).collect();
        }
        CutRules { loose: loose_fill_components(p), ov, terrain, terrain_dash, terrain_hatch, mesh }
    }
}

/// [152] Linien-Stil einer Regel für ein importiertes Netz (Schnittlinien, Projektion).
#[derive(Clone, Debug, Default)]
pub struct MeshLineStyle {
    pub color: Option<String>,
    pub weight: Option<f64>,
    pub dash: Option<Option<Vec<f64>>>,
}

impl MeshLineStyle {
    fn apply(&self, l: &mut Primitive) {
        if let Primitive::Line { color, weight_mm, dash, .. } = l {
            if let Some(c) = &self.color {
                *color = Some(c.clone().into());
            }
            if let Some(w) = self.weight {
                *weight_mm = w;
            }
            if let Some(d) = &self.dash {
                *dash = Some(d.clone());
            }
        }
    }
}

/// [152] Bauteilart importierter Netze in Override-Regeln.
pub const MESH_KIND: &str = "mesh";

/// [152] Regeln eines importierten Netzes: die Fläche ist das Netz selbst, Element- und Schicht-Regeln zählen
/// gleich (`effective_surface`, Bauteilart „mesh", Ebene, Name). (Linien-Aktionen, Override der Schnittfläche).
fn mesh_override(p: &Project, m: &MeshMeta, v: RuleView) -> Option<(super::overrides::Actions, Option<CutOv>)> {
    let code = m.category.as_deref();
    let s = super::overrides::Subject { layer_name: code.and_then(|k| p.layer_category(k)).map(|k| k.name.as_str()), layer_code: code, object_name: Some(&m.name), element_kind: Some(MESH_KIND), ..Default::default() };
    let (el, ly, _) = super::overrides::effective_surface(p.override_rules.as_deref(), &s, v);
    let dash = super::overrides::linetype_dash(p, el.linetype_id.as_deref());
    let cut = ly.any().then(|| {
        let hatch = match ly.hatch.as_deref() {
            None | Some("material") => HatchOv::Keep,
            Some("none") => HatchOv::None,
            Some(id) => resolve_hatch(p, id, Some(SECTION_SLAB_AXIS_ANGLE_DEG), None, None).map_or(HatchOv::Keep, HatchOv::Pattern),
        };
        CutOv { fill: ly.fill_color.clone(), hatch, outline: ly.outline, dash: dash.clone() }
    });
    (el.any() || cut.is_some()).then_some((el, cut))
}

/// [33] Projekt ohne die Elemente `ids` (Regel „Ausblenden“ im Schnitt): verdecken dann auch nichts.
pub fn without_elements(p: &Project, ids: &HashSet<String>) -> Project {
    let mut q = p.clone();
    q.walls.retain(|w| !ids.contains(&w.id));
    if let Some(v) = &mut q.openings {
        v.retain(|x| !ids.contains(&x.id));
    }
    if let Some(v) = &mut q.ceilings {
        v.retain(|x| !ids.contains(&x.id));
    }
    if let Some(v) = &mut q.roofs {
        v.retain(|x| !ids.contains(&x.id));
    }
    if let Some(v) = &mut q.stairs {
        v.retain(|x| !ids.contains(&x.id));
    }
    if let Some(v) = &mut q.columns {
        v.retain(|x| !ids.contains(&x.id));
    }
    if let Some(v) = &mut q.rooms {
        v.retain(|x| !ids.contains(&x.id));
    }
    // [152] Importierte Netze.
    if let Some(v) = &mut q.context {
        v.retain(|x| !matches!(x, ContextObject::ImportedMesh(m) if ids.contains(&m.id)));
    }
    q
}

/// [33] Overrides je Schnittfläche: Bauteil (Wand, Decke/Bodenplatte, Dach) und Schicht der Fläche, dann
/// `overrides::layer_actions`. Ohne aktive Regel mit Schicht-Aktionen leer.
pub fn cut_overrides(p: &Project, cuts: &[Cut], v: RuleView) -> Vec<Option<CutOv>> {
    use super::overrides::{has_layer_actions, is_ground_slab, layer_actions, LayerActions};
    if !has_layer_actions(p, v) {
        return Vec::new();
    }
    let mut memo: HashMap<(u8, String), (Vec<Layer>, Vec<LayerActions>)> = HashMap::new();
    let roofs = p.roofs.as_deref().unwrap_or(&[]);
    let ceilings = p.ceilings.as_deref().unwrap_or(&[]);
    cuts.iter()
        .map(|c| {
            let src = c.source_id.as_deref()?;
            if c.stair_id.is_some() {
                return None;
            }
            let tag = match c.kind {
                Kind::Wall => 0u8,
                Kind::Slab => 1,
                Kind::Roof => 2,
                Kind::Body => return None,
                Kind::Mesh => return None,
            };
            let key = (tag, src.to_string());
            if !memo.contains_key(&key) {
                let entry = match c.kind {
                    Kind::Wall => {
                        let w = p.walls.iter().find(|w| w.id == src)?;
                        let wt = p.wall_type_or_fallback(w);
                        (wt.layers.clone(), layer_actions(p, v, "wall", &w.category_code, Some(&wt.name), &wt.layers))
                    }
                    Kind::Slab => {
                        let ce = ceilings.iter().find(|x| x.id == src)?;
                        let (name, layers) = model3d::ceiling_type_ref(p, ce).map_or((None, Project::fallback_layers()), |t| (Some(t.1), t.2));
                        let kind = if is_ground_slab(p, ce, layers) { "ground_slab" } else { "slab" };
                        (layers.to_vec(), layer_actions(p, v, kind, &ce.category_code, name, layers))
                    }
                    _ => {
                        let r = roofs.iter().find(|x| x.id == src)?;
                        let layers = p.roof_layers(r);
                        let acts = layer_actions(p, v, "roof", &r.category_code, None, &layers);
                        (layers, acts)
                    }
                };
                memo.insert(key.clone(), entry);
            }
            let (layers, acts) = memo.get(&key)?;
            let li = c.layer_index.or_else(|| if layers.len() == 1 { Some(0) } else { c.component_id.as_deref().and_then(|id| layers.iter().position(|l| l.component_id == id)) })?;
            let a = acts.get(li).filter(|a| a.any())?;
            let angle = if c.kind == Kind::Wall { Some(SECTION_WALL_AXIS_ANGLE_DEG) } else { Some(SECTION_SLAB_AXIS_ANGLE_DEG) };
            let hatch = match a.hatch.as_deref() {
                None => HatchOv::Keep,
                Some("none") => HatchOv::None,
                Some("material") => HatchOv::Material,
                Some(id) => resolve_hatch(p, id, angle, None, None).map_or(HatchOv::Keep, HatchOv::Pattern),
            };
            Some(CutOv { fill: a.fill_color.clone(), hatch, outline: a.outline, dash: super::overrides::linetype_dash(p, a.linetype_id.as_deref()) })
        })
        .collect()
}

/// Eine projizierte Kante (`SectionEdge`).
#[derive(Clone, Copy, Debug)]
pub struct Edge {
    pub kind: Kind,
    pub index: usize,
    pub a: [f64; 2],
    pub b: [f64; 2],
    /// [173] Treppenteil der Kante (Modelldarstellung: Treppen hinter dem Schnitt, Handlauf).
    pub stair: StairPart,
}

/// [173] Treppenteil einer Projektionskante im Schnitt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StairPart {
    /// Kein Treppenteil.
    #[default]
    None,
    /// Stufen, Laufplatte, Wangen.
    Body,
    /// Handlauf und Pfosten.
    Rail,
}

/// Geländelinie.
#[derive(Clone, Debug)]
pub struct Profile {
    pub category: Option<String>,
    pub pts: Vec<[f64; 2]>,
    /// [T6] gewachsenes Terrain (gestrichelt), nur wenn Baugruben das Gelände ändern.
    pub natural: bool,
}

/// Ergebnis eines Schnitts (`SectionOutput`).
#[derive(Clone, Debug, Default)]
pub struct Output {
    pub cuts: Vec<Cut>,
    pub visible: Vec<Edge>,
    pub hidden: Vec<Edge>,
    pub profiles: Vec<Profile>,
    /// [T6] Erdreich unter dem gestalteten Terrain (Band, ohne Gebäude-Inneres), mit Schraffur.
    pub earth: Vec<(Vec<[f64; 2]>, HatchRender)>,
    /// [137] Gelände, zu dem das Erdreich-Band gehört (Pick-Id: Klick ins Band wählt das Gelände).
    pub terrain_id: Option<String>,
    /// [152] Importierte Netze im Schnitt (Index = `Cut::index`/`Edge::index` bei `Kind::Mesh`).
    pub meshes: Vec<MeshMeta>,
    /// [152] Offene Schnittlinien importierter Netze (offene/nicht-mannigfaltige Netze): Netz-Index, Linienzug.
    pub mesh_lines: Vec<(usize, Vec<[f64; 2]>)>,
}

/// [152] Ein importiertes Netz im Schnitt.
#[derive(Clone, Debug)]
pub struct MeshMeta {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
}

/// Ein truck-Körper (aus TS, asynchron gebaut): Index in `extrudedSolids` + Netz.
pub struct BodyMesh {
    pub index: usize,
    pub positions: Vec<f64>,
    pub indices: Vec<f64>,
}

/// Liest `[n, (index, nPos, pos…, nIdx, idx…) × n]`; Unsinn → `None`.
pub fn read_bodies(buf: &[f64]) -> Option<Vec<BodyMesh>> {
    if buf.is_empty() {
        return Some(Vec::new());
    }
    let mut r = crate::flat_read::Reader::new(buf);
    let n = r.count()?;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let index = r.count()?;
        let np = r.count()?;
        let positions = (0..np).map(|_| r.num()).collect::<Option<Vec<f64>>>()?;
        let ni = r.count()?;
        let indices = (0..ni).map(|_| r.num()).collect::<Option<Vec<f64>>>()?;
        out.push(BodyMesh { index, positions, indices });
    }
    Some(out)
}


// ── Gesamtrechnung ───────────────────────────────────────────────────────────

/// `computeSection` (ohne den asynchronen Teil: die Körper-Netze kommen fertig aus TS).
pub fn compute_section(p: &Project, level: &LevelSpec, bodies: &[BodyMesh]) -> Result<Option<Output>, String> {
    // [176] Geknickter Schnitt: je Segment, aneinander abgewickelt.
    match unfold::segments(level) {
        Some(segs) => unfold::compute_unfolded(p, &segs, bodies),
        None => compute_plane(p, level, bodies, None),
    }
}

/// Schnitt an einer geraden Ebene; mit `strip` ([176]) auf den Streifen eines Segments begrenzt (lokale u).
fn compute_plane(p: &Project, level: &LevelSpec, bodies: &[BodyMesh], strip: Option<&unfold::Strip>) -> Result<Option<Output>, String> {
    let Some(plane) = level.plane() else { return Ok(None) };
    let walls_r = model3d::emit_walls_with(p, false, false)?;
    let mut slabs_r = model3d::emit_slabs(p);
    slabs_r.extend(model3d::emit_stairs(p, true));
    // [141] Stützen: geschnitten mit Bauteil-Stil (Rang gegen die Wände wie im Grundriss) und in der Projektion.
    slabs_r.extend(model3d::column_slabs(p));
    let wi: Vec<render3d::WallInput> = walls_r.iter().map(wall_input).collect();
    let si: Vec<render3d::SlabInput> = slabs_r.iter().map(slab_input).collect();
    // Die Ebene ging als Zahl-Argument (wasm-bindgen, `Math.fround`) hinein, nicht über JSON.
    let fr = |v: [f64; 3]| [v[0] as f32, v[1] as f32, v[2] as f32];
    let rp = render3d::SectionPlane::new(fr(plane.point), fr(plane.normal));
    // Dächer nicht durch render3d: deren Bänder (je Schicht × Dachfläche, ohne Stil) lagen unter den
    // gestylten aus `append_roof_sections` (doppelte Kontur, Rückfall-Schraffur, Besitzer per Index falsch).
    let raw = render3d::section::cut_polygons(&rp, &wi, &si, &[]);

    // Gleiche f32 kommen oft vor (gemeinsame Ecken, Höhen): Umwandlung je Wert nur einmal.
    let mut conv: HashMap<u32, f64> = HashMap::new();
    let mut jf = |x: f32| -> f64 { *conv.entry(x.to_bits()).or_insert_with(|| js_f32(x)) };
    let mut cuts: Vec<Cut> = Vec::with_capacity(raw.len());
    for cp in &raw {
        cuts.push(Cut::new(kind_of(cp.component.kind), cp.component.index, cp.pts.iter().map(|q| [jf(q[0]), jf(q[1])]).collect()));
    }
    shaped_wall_cuts(&mut cuts, p, &walls_r, plane.base(), plane.u_model());
    let mut cuts = merge_arc_wall_cuts(cuts, p, &walls_r);
    append_roof_sections(&mut cuts, p, &plane);
    let owners = wall_owners(p, &walls_r);
    // Bogenwand ([T2]): Schichtfolge quer zum Schnitt aus der Richtung des Sehnen-Teilkörpers.
    let virt: Vec<Option<Wall>> = walls_r
        .iter()
        .zip(&owners)
        .map(|(r, o)| {
            o.filter(|w| crate::wall_arc::WallArc::of_wall(w).is_some()).map(|w| Wall { start: Vec2 { x: r.start[0], y: r.start[1] }, end: Vec2 { x: r.end[0], y: r.end[1] }, ..w.clone() })
        })
        .collect();
    let walls: Vec<Option<&Wall>> = owners.iter().zip(&virt).map(|(o, v)| v.as_ref().or(*o)).collect();
    let slabs = slab_owners(p, &slabs_r);
    let cuts = attach_cut_styles(cuts, p, &plane, &walls, &slabs)?;
    let cuts = merge_monolith_cuts(cuts, &slabs_r, &stair_flight_sections(p, plane.base(), plane.u_model()));
    let base = plane.base();
    let u = plane.u_model();
    let cuts = subtract_voids_in_section(cuts, p, base, u);
    // [G1] Abzugskörper beliebiger Form kommen als Netz mit (wie freie Körper): ausgespart, nicht gezeichnet.
    let (void_bodies, bodies): (Vec<&BodyMesh>, Vec<&BodyMesh>) = bodies.iter().partition(|b| is_subtract_body(p, b));
    let cuts = subtract_body_voids_in_section(cuts, &void_bodies, base, u);
    let cuts = subtract_pockets_in_section(cuts, p, base, u);
    let mut cuts = parallel_reveal_cuts(cuts, p, &plane, &walls)?;
    append_body_sections(&mut cuts, p, &bodies, base, u);
    // [152] Netzkörper: geschnitten (Flächen bzw. offene Linien) und in der Projektion. Gelände ist ein eigenes
    // Element (`terrainMesh`, auch IFC-Gelände seit dem Import, [181]) und wird Geländelinie (`append_terrain_profiles`).
    let meshes = crate::mesh_view::meshes(p);
    let mut mesh_lines = Vec::new();
    append_mesh_sections(&mut cuts, &mut mesh_lines, &meshes, base, u);
    // [176] Segment eines geknickten Schnitts: Schnittflächen auf den Streifen (sie verdecken nur dort).
    if let Some(s) = strip {
        let mut part = Output { cuts, mesh_lines, ..Output::default() };
        unfold::clip_output(&mut part, s);
        (cuts, mesh_lines) = (part.cuts, part.mesh_lines);
    }
    // Projektion hinter der Ebene exakt ([G4]); die Schnittflächen verdecken, was hinter ihnen liegt.
    let (mut visible, hidden) = projection_edges(p, &plane, &walls_r, &wi, &slabs_r, &bodies, &meshes, &cuts, level.hidden_lines, level.depth, strip.map_or(&[][..], |s| &s.half[..]));
    shaped_projection(&mut visible, p, &walls_r, &plane);
    let meshes = meshes.iter().map(|m| MeshMeta { id: m.mesh.id.clone(), name: m.mesh.name.clone(), category: Some(m.mesh.category_code.clone()) }).collect();
    let mut out = Output { cuts, visible, hidden, profiles: Vec::new(), earth: Vec::new(), terrain_id: None, meshes, mesh_lines };
    append_terrain_profiles(&mut out, p, base, u);
    if let Some(s) = strip {
        unfold::clip_output(&mut out, s);
    }
    Ok(Some(out))
}
