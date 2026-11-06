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
const SECTION_HIDDEN_DASH: [f64; 2] = [0.12, 0.08];
/// [T6] gewachsenes Terrain im Schnitt: gestrichelt, dünner als das gestaltete.
const SECTION_NATURAL_MM: f64 = 0.25;
const SECTION_NATURAL_DASH: [f64; 2] = [0.4, 0.2];
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
    pub direction_sign: Option<f64>,
    pub depth: Option<f64>,
    pub shadows: bool,
    /// Verdeckte Kanten gestrichelt zeigen ([G4], Ansicht; der Schnitt liest es aus dem Aufruf).
    pub hidden_lines: bool,
    /// Skizzenstil ([67]).
    pub sketch: bool,
    /// [140] Schnittflächen auch ab 1:100 schraffiert statt schwarz (`style::solid_cut`).
    pub cut_hatch: bool,
}

impl LevelSpec {
    pub fn from_json(v: &serde_json::Value) -> LevelSpec {
        let num = |k: &str| v.get(k).and_then(|x| x.as_f64());
        let pt = |q: &serde_json::Value| -> Option<Vec2> { Some(Vec2 { x: q.get("x")?.as_f64()?, y: q.get("y")?.as_f64()? }) };
        let line = v.get("linePoints").and_then(|l| l.as_array()).and_then(|a| Some([pt(a.first()?)?, pt(a.get(1)?)?]));
        LevelSpec {
            kind: v.get("kind").and_then(|k| k.as_str()).unwrap_or_default().to_string(),
            line,
            direction_sign: num("directionSign"),
            depth: num("depth"),
            shadows: v.get("shadows").and_then(|b| b.as_bool()).unwrap_or(false),
            hidden_lines: v.get("hiddenLines").and_then(|b| b.as_bool()).unwrap_or(false),
            sketch: v.get("sketch").and_then(|b| b.as_bool()).unwrap_or(false),
            cut_hatch: v.get("cutHatch").and_then(|b| b.as_bool()).unwrap_or(false),
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
}

impl CutRules {
    /// `v`: Massstab und eingeschaltete Regeln der Darstellung ([`super::overrides::RuleView`]).
    pub fn of(p: &Project, out: &Output, v: RuleView) -> CutRules {
        let ts = crate::excavation::terrains(p);
        let t = out.terrain_id.as_deref().and_then(|id| ts.iter().find(|t| t.id == id)).or(ts.first());
        let terrain = if out.profiles.is_empty() && out.earth.is_empty() { None } else { t.and_then(|t| super::overrides::terrain_override(p, v, t.category_code.as_deref(), &t.name)) };
        let terrain_dash = terrain.as_ref().and_then(|(a, _)| super::overrides::linetype_dash(p, a.linetype_id.as_deref()));
        let terrain_hatch = terrain.as_ref().and_then(|(_, l)| l.hatch.as_deref()).filter(|h| !matches!(*h, "none" | "material")).and_then(|id| resolve_hatch(p, id, None, None, None));
        CutRules { loose: loose_fill_components(p), ov: cut_overrides(p, &out.cuts, v), terrain, terrain_dash, terrain_hatch }
    }
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

/// f32 aus render3d wie über JSON gereist: kürzeste Dezimaldarstellung, als f64 gelesen.
fn js_f32(x: f32) -> f64 {
    if !x.is_finite() {
        return 0.0; // JSON `null` → 0 in der Arithmetik
    }
    // serde_json schrieb f32 mit der kürzesten Darstellung (Gleichstand → gerade Ziffer), JS las sie.
    zmij::Buffer::new().format_finite(x).parse::<f64>().unwrap_or(0.0)
}

fn kind_of(k: render3d::ComponentKind) -> Kind {
    match k {
        render3d::ComponentKind::Wall => Kind::Wall,
        render3d::ComponentKind::Slab => Kind::Slab,
        render3d::ComponentKind::Roof => Kind::Roof,
    }
}

/// Zehnerpotenzen wie `POW10` in serde_json (Literale `1e0` … `1e308`).
fn pow10(k: usize) -> f64 {
    use std::sync::OnceLock;
    static T: OnceLock<Vec<f64>> = OnceLock::new();
    T.get_or_init(|| (0..=308).map(|i| format!("1e{i}").parse::<f64>().unwrap_or(f64::INFINITY)).collect())[k]
}

/// Zahl, wie sie früher über JSON in den render3d-Schnitt reiste: JS schreibt die kürzeste
/// Dezimaldarstellung, serde_json (dort ohne `float_roundtrip`) liest sie als Ganzzahl-Mantisse
/// mal Zehnerpotenz und rundet dann auf f32. Bitgleich zur alten Eingabe (auch wo die Lesung
/// um eine Stelle daneben liegt).
fn json_f32(x: f64) -> f32 {
    if x == 0.0 || !x.is_finite() {
        return 0.0;
    }
    if x.fract() == 0.0 && x.abs() < 1e21 {
        return x as f32; // JS schreibt eine Ganzzahl, serde liest u64/i64
    }
    // Schnellweg: im Bereich 1e-6..1e14 liegt die Lesung (≤ 17 Ziffern, Zehnerpotenz exakt) höchstens
    // wenige f64-Stellen neben `x`. Liegt `x` weit genug von jeder f32-Rundungsgrenze, rundet sie
    // genau wie `x` selbst.
    let ax = x.abs();
    let y = x as f32;
    if y.is_finite() && (1e-6..1e14).contains(&ax) {
        let yf = y as f64;
        let room = if x >= yf { (y.next_up() as f64 - yf) / 2.0 - (x - yf) } else { (yf - y.next_down() as f64) / 2.0 - (yf - x) };
        if room > 1e-13 * ax {
            return y;
        }
    }
    json_f32_read(x)
}

/// Die eigentliche Lesung (ohne Schnellweg).
fn json_f32_read(x: f64) -> f32 {
    // Ziffern und Exponent der kürzesten Darstellung (wie JS: Gleichstand → gerade Ziffer; zmij wie
    // in serde_json).
    let mut buf = zmij::Buffer::new();
    let s = buf.format_finite(x.abs());
    let (mant, exp) = s.split_once(['e', 'E']).unwrap_or((s, "0"));
    let (int_part, frac_part) = mant.split_once('.').unwrap_or((mant, ""));
    let digits = format!("{int_part}{frac_part}");
    let mut exponent: i32 = exp.parse::<i32>().unwrap_or(0) - frac_part.len() as i32;
    let sig: u64 = digits.parse().unwrap_or(0);
    let mut f = sig as f64;
    loop {
        let k = exponent.unsigned_abs() as usize;
        if k <= 308 {
            if exponent >= 0 {
                f *= pow10(k);
            } else {
                f /= pow10(k);
            }
            break;
        }
        if f == 0.0 || exponent >= 0 {
            break;
        }
        f /= 1e308;
        exponent += 308;
    }
    (if x < 0.0 { -f } else { f }) as f32
}

fn f32s2(v: [f64; 2]) -> [f32; 2] {
    [json_f32(v[0]), json_f32(v[1])]
}

fn f32s3(v: [f64; 3]) -> [f32; 3] {
    [json_f32(v[0]), json_f32(v[1]), json_f32(v[2])]
}

fn wall_input(w: &RWall) -> render3d::WallInput {
    render3d::WallInput {
        start: f32s2(w.start),
        end: f32s2(w.end),
        thickness: json_f32(w.thickness),
        height: json_f32(w.height),
        base_elevation: json_f32(w.base_elevation),
        top_drop: w.top_drop.map_or([0.0, 0.0], f32s2),
        top_plane: w.top_plane.map(f32s3),
        color: f32s3(w.color),
        openings: Vec::new(),
        layers: Some(Vec::new()),
        holes: w
            .holes
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|h| render3d::types::Hole { from: json_f32(h.from), to: json_f32(h.to), z_bottom: json_f32(h.z_bottom), z_top: json_f32(h.z_top) })
            .collect(),
        material_index: None,
        hatch: None,
        cut: None,
        start_cut: w.start_cut.map(f32s4),
        end_cut: w.end_cut.map(f32s4),
    }
}

fn f32s4(v: [f64; 4]) -> [f32; 4] {
    [json_f32(v[0]), json_f32(v[1]), json_f32(v[2]), json_f32(v[3])]
}

fn slab_input(s: &RSlab) -> render3d::SlabInput {
    render3d::SlabInput {
        outline: s.outline.iter().map(|q| f32s2(*q)).collect(),
        z_bottom: json_f32(s.z_bottom),
        z_top: json_f32(s.z_top),
        color: f32s3(s.color),
        hatch: None,
        cut: None,
        monolith: s.monolith.clone(),
    }
}

// ── Besitzer (Herkunft, die das Schnitt-Modell mitführt) ─────────────────────

// Öffnungs-Lage in der Wand (für die geschnittenen Fenster/Türen).
fn opening_extent(p: &Project, w: &Wall, o: &Opening) -> (f64, f64) {
    let (zb, zt) = p.wall_vertical_extent(w);
    let sill = max(0.0, o.sill_height);
    let ob = zb + sill;
    (ob, min(zt, ob + o.height))
}

/// [T2] Öffnung in der Bogenwand als gerade Ersatzwand: Sehne der Achse zwischen den Laibungen,
/// Öffnung ab 0 über die Sehnenlänge. `None` bei gerader Wand.
fn arc_chord_opening(wall: &Wall, o: &Opening) -> Option<(Wall, Opening)> {
    let a = crate::wall_arc::WallArc::of_wall(wall)?;
    let axis = a.length();
    let from = max(0.0, min(o.position, axis));
    let to = max(from, min(o.position + o.width, axis));
    let (ps, pe) = (a.point(from, 0.0), a.point(to, 0.0));
    let vw = Wall { start: Vec2 { x: ps.x, y: ps.y }, end: Vec2 { x: pe.x, y: pe.y }, bulge: None, ..wall.clone() };
    let vo = Opening { position: 0.0, width: hypot2(pe.x - ps.x, pe.y - ps.y), ..o.clone() };
    Some((vw, vo))
}

fn opening_interval(w: &Wall, o: &Opening) -> Option<(f64, f64)> {
    let axis = hypot2(w.end.x - w.start.x, w.end.y - w.start.y);
    let from = max(0.0, min(o.position, axis));
    let to = max(from, min(o.position + o.width, axis));
    if to - from < 1e-4 {
        return None;
    }
    Some((from, to))
}

/// [T2] Schnitt durch eine Bogenwand: quert die Ebene eine innere Stossfuge der Sehnen-Teilkörper,
/// liegt der Querschnitt in zwei Rechtecken nebeneinander — zu EINEM zusammenfassen, damit die
/// Schichtaufteilung (anteilig über die ganze Dicke) stimmt.
fn merge_arc_wall_cuts(cuts: Vec<Cut>, p: &Project, walls_r: &[RWall]) -> Vec<Cut> {
    let arc_ids: HashSet<&str> = p.walls.iter().filter(|w| crate::wall_arc::WallArc::of_wall(w).is_some()).map(|w| w.id.as_str()).collect();
    if arc_ids.is_empty() {
        return cuts;
    }
    let owner = |c: &Cut| -> Option<&str> { (c.kind == Kind::Wall).then(|| walls_r.get(c.index).map(|w| w.wall_id.as_str())).flatten().filter(|id| arc_ids.contains(id)) };
    let (mut arc, mut out): (Vec<Cut>, Vec<Cut>) = cuts.into_iter().partition(|c| owner(c).is_some() && c.pts.len() >= 3);
    arc.sort_by(|a, b| {
        let (ba, bb) = (bbox(&a.pts), bbox(&b.pts));
        owner(a).cmp(&owner(b)).then(cmp_num(ba[2] - bb[2])).then(cmp_num(ba[0] - bb[0]))
    });
    let mut merged: Vec<Cut> = Vec::new();
    for c in arc {
        let b = bbox(&c.pts);
        if let Some(last) = merged.last_mut() {
            let lb = bbox(&last.pts);
            let same = owner(last) == owner(&c) && (lb[2] - b[2]).abs() < 1e-6 && (lb[3] - b[3]).abs() < 1e-6;
            if same && b[0] <= lb[1] + 1e-3 && b[1] >= lb[0] - 1e-3 {
                let (u0, u1) = (lb[0].min(b[0]), lb[1].max(b[1]));
                last.pts = vec![[u0, lb[3]], [u1, lb[3]], [u1, lb[2]], [u0, lb[2]]];
                continue;
            }
        }
        merged.push(c);
    }
    out.extend(merged);
    out
}

/// Je emittiertem Wand-Teilquader die Quellwand (über `RWall::wall_id`).
fn wall_owners<'a>(p: &'a Project, walls: &[RWall]) -> Vec<Option<&'a Wall>> {
    let mut by_id: HashMap<&str, &Wall> = HashMap::with_capacity(p.walls.len());
    for w in &p.walls {
        by_id.entry(w.id.as_str()).or_insert(w);
    }
    walls.iter().map(|w| by_id.get(w.wall_id.as_str()).copied()).collect()
}

/// Herkunft eines Platten-Bandes: Decke (mit Schicht des Deckentyps) oder Treppe.
#[derive(Clone, Copy, Debug)]
pub enum SlabOwner<'a> {
    None,
    Ceiling(&'a Ceiling, Option<usize>),
    Stair(&'a Stair),
    Column(&'a Column),
}

/// Je emittierter Platte (Deckenschicht, Treppentritt, Podest) ihre Herkunft (`RSlab::source`).
pub fn slab_owners<'a>(p: &'a Project, slabs: &[RSlab]) -> Vec<SlabOwner<'a>> {
    let ceilings = p.ceilings.as_deref().unwrap_or(&[]);
    let stairs = p.stairs.as_deref().unwrap_or(&[]);
    slabs
        .iter()
        .map(|s| match s.source {
            SlabSource::Ceiling { index, layer } => ceilings.get(index).map_or(SlabOwner::None, |c| SlabOwner::Ceiling(c, layer)),
            SlabSource::Stair { index } => stairs.get(index).map_or(SlabOwner::None, SlabOwner::Stair),
            SlabSource::Column { index } => p.columns.as_deref().and_then(|c| c.get(index)).map_or(SlabOwner::None, SlabOwner::Column),
            SlabSource::None => SlabOwner::None,
        })
        .collect()
}

/// Ordnung eines JS-Vergleichs `(a, b) => d` (NaN/0 = gleich).
pub fn cmp_num(d: f64) -> std::cmp::Ordering {
    if d < 0.0 {
        std::cmp::Ordering::Less
    } else if d > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

// ── Stil-Auflösung ────────────────────────────────────────────────────────────

fn sum_thickness(layers: &[Layer]) -> f64 {
    layers.iter().fold(0.0, |s, l| s + l.thickness)
}

fn ceiling_layers<'a>(p: &'a Project, c: &Ceiling) -> Option<&'a [Layer]> {
    model3d::ceiling_type_ref(p, c).map(|t| t.2)
}

/// `resolveWallSectionStyle`.
fn wall_section_style(p: &Project, wall: &Wall) -> Option<(String, HatchRender)> {
    let wt = p.wall_type(wall)?;
    let mut best: Option<&Component> = None;
    for layer in &wt.layers {
        let comp = p.component(&layer.component_id)?;
        if best.is_none_or(|b| comp.join_priority > b.join_priority) {
            best = Some(comp);
        }
    }
    let best = best?;
    let category = p.layer_category(&wall.category_code);
    // Im Schnitt steht die geschnittene Wand senkrecht — wandbezogene Muster wie bei den Schicht-Bändern
    // (`split_wall_layers`), nicht nach dem Grundriss-Winkel der Wand ([109]).
    let angle = SECTION_WALL_AXIS_ANGLE_DEG;
    let hatch_id = resolve_hatch_id(wall.hatch_id.as_deref(), wall.hatch_source, category, Some(&best.hatch_id)).unwrap_or(&best.hatch_id);
    let hatch = resolve_hatch(p, hatch_id, Some(angle), resolve_foreground(best, wall.foreground.as_deref(), category, wall.foreground_source), None)?;
    Some((poche_fill(hatch.pattern).to_string(), hatch))
}

/// `resolveCeilingSectionStyle`.
fn ceiling_section_style(p: &Project, c: &Ceiling) -> Option<(String, HatchRender)> {
    let layers = ceiling_layers(p, c)?;
    let first = layers.first()?;
    let comp = p.component(&first.component_id)?;
    let category = p.layer_category(&c.category_code);
    let hatch_id = resolve_hatch_id(c.hatch_id.as_deref(), c.hatch_source, category, Some(&comp.hatch_id)).unwrap_or(&comp.hatch_id);
    let hatch = resolve_hatch(p, hatch_id, None, resolve_foreground(comp, c.foreground.as_deref(), category, c.foreground_source), None)?;
    Some((poche_fill(hatch.pattern).to_string(), hatch))
}

fn wall_representative_priority(p: &Project, wall: &Wall) -> Option<f64> {
    let wt = p.wall_type(wall)?;
    let mut best: Option<f64> = None;
    for layer in &wt.layers {
        let jp = p.component(&layer.component_id)?.join_priority;
        if best.is_none_or(|b| jp > b) {
            best = Some(jp);
        }
    }
    best
}

fn wall_representative_component_id(p: &Project, wall: &Wall) -> Option<String> {
    let wt = p.wall_type(wall)?;
    let mut best: Option<&str> = None;
    let mut best_prio = f64::NEG_INFINITY;
    for layer in &wt.layers {
        let jp = p.component(&layer.component_id)?.join_priority;
        if best.is_none() || jp > best_prio {
            best = Some(&layer.component_id);
            best_prio = jp;
        }
    }
    best.map(String::from)
}

fn ceiling_representative_component_id(p: &Project, c: &Ceiling) -> Option<String> {
    ceiling_layers(p, c)?.first().map(|l| l.component_id.clone())
}

fn ceiling_representative_priority(p: &Project, c: &Ceiling) -> Option<f64> {
    let first = ceiling_layers(p, c)?.first()?;
    Some(p.component(&first.component_id)?.join_priority)
}

/// Bounding-Box `[uMin, uMax, vMin, vMax]` über `Math.min(...)`/`Math.max(...)`.
fn bbox(pts: &[[f64; 2]]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY];
    for q in pts {
        b[0] = min(b[0], q[0]);
        b[1] = max(b[1], q[0]);
        b[2] = min(b[2], q[1]);
        b[3] = max(b[3], q[1]);
    }
    b
}

fn rect_of_band(c: &Cut) -> Option<[f64; 4]> {
    (c.pts.len() >= 3 && is_axis_rect(&c.pts)).then(|| bbox(&c.pts))
}

/// [G6] Liegt der Umriss genau auf seinem umgebenden Rechteck (achsparallel, Fläche = Rechteckfläche)?
/// Schräge Bänder (Dachschichten, schräge Wandoberkanten) gehen sonst als Rechteck in die Dominanz ein
/// und schneiden zu viel weg bzw. verlieren beim Beschneiden ihre Schräge.
fn is_axis_rect(pts: &[[f64; 2]]) -> bool {
    const E: f64 = 1e-6;
    let b = bbox(pts);
    if !(b[1] - b[0] > E && b[3] - b[2] > E) {
        return false;
    }
    let on_edge = pts.iter().all(|q| ((q[0] - b[0]).abs() < E || (q[0] - b[1]).abs() < E) || ((q[1] - b[2]).abs() < E || (q[1] - b[3]).abs() < E));
    let area = pts.iter().enumerate().map(|(i, a)| { let c = pts[(i + 1) % pts.len()]; a[0] * c[1] - c[0] * a[1] }).sum::<f64>().abs() / 2.0;
    on_edge && (area - (b[1] - b[0]) * (b[3] - b[2])).abs() < E * (b[1] - b[0] + b[3] - b[2])
}

/// Bauteil-Stil einer Schicht (Füllung, Schraffur) mit dem Override des Elements (`split*Layers`).
#[allow(clippy::too_many_arguments)]
fn layer_style(
    p: &Project,
    comp: &Component,
    hatch_id: Option<&str>,
    hatch_source: Option<AttributeSource>,
    fg: Option<&str>,
    fg_source: Option<AttributeSource>,
    bg: Option<&str>,
    bg_source: Option<AttributeSource>,
    category: Option<&LayerCategory>,
    angle: f64,
) -> Result<(String, HatchRender), String> {
    let hid = resolve_hatch_id(hatch_id, hatch_source, category, Some(&comp.hatch_id)).unwrap_or(&comp.hatch_id);
    // Hängende Schraffur (Datei/Import): ohne Muster statt Abbruch.
    let hatch = resolve_hatch(p, hid, Some(angle), resolve_foreground(comp, fg, category, fg_source), None).unwrap_or_else(no_hatch);
    let bg = resolve_background(comp, bg, category, bg_source);
    let fill = bg.map(String::from).unwrap_or_else(|| poche_fill(hatch.pattern).to_string());
    Ok((fill, hatch))
}

/// Stil einer geschnittenen Deckenschicht (Füllung, Schraffur, Verschneidung) mit dem Override der Decke.
/// Jede Schicht ist im Schnitt-Modell eine eigene Platte; ihr Band trägt so genau ihr Bauteil.
fn style_slab_layer(cp: &mut Cut, p: &Project, layer: &Layer, owner: &Ceiling) -> Result<(), String> {
    let category = p.layer_category(&owner.category_code);
    let comp = p.component_or_fallback(&layer.component_id);
    let (fill, hatch) = layer_style(p, comp, owner.hatch_id.as_deref(), owner.hatch_source, owner.foreground.as_deref(), owner.foreground_source, owner.background.as_deref(), owner.background_source, category, SECTION_SLAB_AXIS_ANGLE_DEG)?;
    cp.fill = Some(fill);
    cp.hatch = Some(hatch);
    cp.join_priority = Some(comp.join_priority);
    cp.component_id = Some(comp.id.clone());
    Ok(())
}

/// `wallLayersReversedInU`.
fn wall_layers_reversed_in_u(w: &Wall, u: (f64, f64)) -> bool {
    let (ax, ay) = (w.end.x - w.start.x, w.end.y - w.start.y);
    if hypot2(ax, ay) < 1e-9 {
        return false;
    }
    let l = hypot2(ax, ay);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let (nx, ny) = (ax / l, ay / l);
    let (bx, by) = (-ny, nx);
    bx * u.0 + by * u.1 < 0.0
}

/// `splitWallLayers`: stehende Teil-Rechtecke je Schicht quer zur Dicke (u).
fn split_wall_layers(cp: &Cut, p: &Project, layers: &[Layer], owner: &Wall, u_world: (f64, f64), plane: &Plane) -> Result<Vec<Cut>, String> {
    let total = sum_thickness(layers);
    let [u_min, u_max, v_min, v_max] = bbox(&cp.pts);
    let u_span = u_max - u_min;
    if total <= 1e-9 || u_span <= 1e-9 {
        return Ok(vec![cp.clone()]);
    }
    let scale = u_span / total;
    let reversed = wall_layers_reversed_in_u(owner, u_world);
    let ordered: Vec<&Layer> = if reversed { layers.iter().rev().collect() } else { layers.iter().collect() };
    let category = p.layer_category(&owner.category_code);
    let mut out = Vec::with_capacity(layers.len());
    // [106] Schichteinzug am Sturz (Stück liegt über der Öffnung) bzw. an der Brüstung (darunter),
    // [94] Anschlag: die Schichten vor dem Rahmen reichen um die Anschlagtiefe in die Öffnung.
    let (top, bottom) = section_reveal(p, owner, plane, v_min, v_max);
    let n = layers.len();
    let offsets: Vec<f64> = layers.iter().scan(0.0, |acc, l| { let o = *acc; *acc += l.thickness; Some(o) }).collect();
    let mut acc = 0.0;
    for (k, layer) in ordered.into_iter().enumerate() {
        let li = if reversed { n - 1 - k } else { k };
        let comp = p.component_or_fallback(&layer.component_id);
        let (fill, hatch) = layer_style(p, comp, owner.hatch_id.as_deref(), owner.hatch_source, owner.foreground.as_deref(), owner.foreground_source, owner.background.as_deref(), owner.background_source, category, SECTION_WALL_AXIS_ANGLE_DEG)?;
        let u_left = u_min + acc * scale;
        acc += layer.thickness;
        let u_right = u_min + acc * scale;
        let mk = |pts: Vec<[f64; 2]>| {
            let mut c = Cut::new(cp.kind, cp.index, pts);
            c.fill = Some(fill.clone());
            c.hatch = Some(hatch.clone());
            c.join_priority = Some(comp.join_priority);
            c.component_id = Some(comp.id.clone());
            c.source_id = cp.source_id.clone();
            c.category = cp.category.clone();
            c.layer_index = Some(li);
            c
        };
        let shift = |s: &Option<EdgeJoin>| s.as_ref().map_or(0.0, |e| e.shift(li));
        let (mut vb, mut vt) = (v_min + shift(&top), v_max - shift(&bottom));
        // Formöffnung ([G3]): Rücksprung senkrecht zum (versetzten) Umriss.
        if let Some(v) = top.as_ref().and_then(|e| e.shape.as_ref()).and_then(|s| s.layer_edge(li, true)) {
            vb = v;
        }
        if let Some(v) = bottom.as_ref().and_then(|e| e.shape.as_ref()).and_then(|s| s.layer_edge(li, false)) {
            vt = v;
        }
        let u_of = |o: f64| if reversed { u_max - o * scale } else { u_min + o * scale };
        let nibs = rebate_nibs(&top, &bottom, (offsets[li], offsets[li] + layer.thickness), (v_min, v_max), &u_of);
        // Zusatzstücke dieser Schicht in der Öffnung `[u0, u1, v0, v1]` (an der Kante des Wandstücks).
        let mut pieces: Vec<[f64; 4]> = Vec::new();
        for (side, below) in [(&top, true), (&bottom, false)] {
            let Some(e) = side else { continue };
            if let Some(sj) = &e.shape {
                for [o0, o1, z0, z1] in sj.pieces(li, below) {
                    let (ua, ub) = (min(u_of(o0), u_of(o1)), max(u_of(o0), u_of(o1)));
                    pieces.push([ua, ub, z0, z1]);
                }
                continue;
            }
            for a in e.adj.iter().filter(|a| a.layer == li) {
                for pc in &a.pieces {
                    // In der Anschlag-Zone deckt die Nase das Stück bis zur Anschlagtiefe schon ab.
                    let mut pc = *pc;
                    if let Some((d, _, _)) = e.rebate.filter(|r| pc[2] >= r.1 - 1e-6 && pc[3] <= r.2 + 1e-6) {
                        pc[0] = pc[0].max(d);
                        if pc[1] - pc[0] <= 1e-6 {
                            continue;
                        }
                    }
                    let (z0, z1) = if below { (v_min - pc[1], v_min - pc[0]) } else { (v_max + pc[0], v_max + pc[1]) };
                    let (ua, ub) = (min(u_of(pc[2]), u_of(pc[3])), max(u_of(pc[2]), u_of(pc[3])));
                    pieces.push([ua, ub, z0, z1]);
                }
            }
        }
        let rect_pts = |r: [f64; 4]| vec![[r[0], r[3]], [r[1], r[3]], [r[1], r[2]], [r[0], r[2]]];
        if nibs.is_empty() {
            if vt - vb > 1e-6 {
                out.push(mk(rect_pts([u_left, u_right, vb, vt])));
            }
            out.extend(pieces.into_iter().map(|r| mk(rect_pts(r))));
        } else {
            // Band, Nase(n) und Zusatzstücke der Schicht als EIN Umriss (keine Fuge an der Nase).
            let mut rects = nibs;
            if vt - vb > 1e-6 {
                rects.push([u_left, u_right, vb, vt]);
            }
            rects.extend(pieces);
            out.extend(union_rect_outlines(&rects).into_iter().map(mk));
        }
    }
    Ok(out)
}

/// Anschlag-Nasen eines einschaligen Wandbands (ganze Dicke als eine Schicht).
fn single_layer_nibs(p: &Project, owner: &Wall, cp: &Cut, u_world: (f64, f64), plane: &Plane) -> Vec<[f64; 4]> {
    let total = sum_thickness(&p.wall_type_or_fallback(owner).layers);
    let [u_min, u_max, v_min, v_max] = bbox(&cp.pts);
    if !(total > 1e-9 && u_max - u_min > 1e-9) {
        return Vec::new();
    }
    let (top, bottom) = section_reveal(p, owner, plane, v_min, v_max);
    if top.is_none() && bottom.is_none() {
        return Vec::new();
    }
    let scale = (u_max - u_min) / total;
    let reversed = wall_layers_reversed_in_u(owner, u_world);
    let u_of = |o: f64| if reversed { u_max - o * scale } else { u_min + o * scale };
    rebate_nibs(&top, &bottom, (0.0, total), (v_min, v_max), &u_of)
}

/// Anschluss eines Wandstücks an die Öffnung, deren Sturz (Stück darüber) bzw. Brüstung (darunter) es ist.
struct EdgeJoin {
    /// Schichteinzug [106].
    adj: Vec<crate::opening_detail::LayerAdjust>,
    /// Anschlag [94]/[105]: Tiefe in die Öffnung und Zone quer ab Aussenfläche (zwischen Fläche und Rahmen).
    rebate: Option<(f64, f64, f64)>,
    /// Formöffnung ([G3]): der Schichteinzug folgt dem Umriss statt Sturz/Brüstung.
    shape: Option<ShapeJoin>,
}

/// Schichteinzug [106] einer Formöffnung an der Schnittstelle `u` (Öffnungskoordinaten): Umriss,
/// Brüstungshöhe `zb` und die Anschlüsse aller vier Seiten (die Bogenkante gehört nach ihrer Normalen
/// zu einer Seite, `opening_shape::edge_side`).
struct ShapeJoin {
    poly: Vec<crate::opening_shape::P>,
    u: f64,
    zb: f64,
    sides: [Vec<crate::opening_detail::LayerAdjust>; 4],
}

impl ShapeJoin {
    /// Kante der Schicht `layer` an der Schnittstelle: oben (`top`) bzw. unten, um den Rücksprung je Seite
    /// versetzt (wie im 3D, `opening_shape::layer_fill_quads`).
    fn layer_edge(&self, layer: usize, top: bool) -> Option<f64> {
        let s: [f64; 4] = std::array::from_fn(|k| self.sides[k].iter().find(|a| a.layer == layer).map_or(0.0, |a| a.shift));
        let r = crate::opening_shape::v_range(&crate::opening_shape::outset_sides(&self.poly, s), self.u)?;
        Some(self.zb + if top { r.1 } else { r.0 })
    }

    /// Zusatzstücke der Schicht an der Schnittstelle `[o0, o1, z0, z1]`: senkrecht zum Umriss gemessen.
    fn pieces(&self, layer: usize, top: bool) -> Vec<[f64; 4]> {
        use crate::opening_shape as os;
        let n = self.poly.len();
        // Kante des Umrisses über bzw. unter der Schnittstelle.
        let Some(edge) = (0..n).filter(|&i| {
            let (a, b) = (self.poly[i], self.poly[(i + 1) % n]);
            (a[0].min(b[0]) <= self.u && self.u <= a[0].max(b[0])) && (b[0] - a[0]).abs() > 1e-9 && ((b[0] < a[0]) == top)
        }).next() else { return Vec::new() };
        let side = os::edge_side(&self.poly, edge);
        let at = |d: f64| os::v_range(&os::inset(&self.poly, d), self.u).map(|r| self.zb + if top { r.1 } else { r.0 });
        let mut out = Vec::new();
        for a in self.sides[side].iter().filter(|a| a.layer == layer) {
            for &[x0, x1, o0, o1] in &a.pieces {
                if let (Some(z0), Some(z1)) = (at(x0), at(x1)) {
                    out.push([o0, o1, min(z0, z1), max(z0, z1)]);
                }
            }
        }
        out
    }
}

impl EdgeJoin {
    fn shift(&self, layer: usize) -> f64 {
        self.adj.iter().find(|a| a.layer == layer).map_or(0.0, |a| a.shift)
    }
}

/// Anschlag-Nasen `[u0, u1, v0, v1]` einer Schicht (quer `l0..l1` ab Aussenfläche) am Sturz (unter
/// `v_min`) und an der Brüstung (über `v_max`); `u_of` bildet die Lage ab Aussenfläche auf u ab.
fn rebate_nibs(top: &Option<EdgeJoin>, bottom: &Option<EdgeJoin>, (l0, l1): (f64, f64), (v_min, v_max): (f64, f64), u_of: &dyn Fn(f64) -> f64) -> Vec<[f64; 4]> {
    let mut out = Vec::new();
    for (side, below) in [(top, true), (bottom, false)] {
        let Some((d, z0, z1)) = side.as_ref().and_then(|e| e.rebate) else { continue };
        let (a, b) = (z0.max(l0), z1.min(l1));
        if b - a <= 1e-6 {
            continue;
        }
        let (ua, ub) = (min(u_of(a), u_of(b)), max(u_of(a), u_of(b)));
        out.push(if below { [ua, ub, v_min - d, v_min] } else { [ua, ub, v_max, v_max + d] });
    }
    out
}

/// Schichteinzug und Anschlag der Öffnung, deren Sturz (unten an `v_min`) bzw. Brüstung (oben an `v_max`)
/// dieses Wandstück ist und die die Schnittebene quert.
fn section_reveal(p: &Project, wall: &Wall, plane: &Plane, v_min: f64, v_max: f64) -> (Option<EdgeJoin>, Option<EdgeJoin>) {
    let (mut top, mut bottom) = (None, None);
    let u_raw = plane.u_model();
    let l = hypot2(u_raw.0, u_raw.1);
    if !(l > 1e-12) {
        return (None, None);
    }
    let u = (u_raw.0 / l, u_raw.1 / l);
    // Bogenwand: `wall` ist hier die Sehnen-Teilwand (mit Bulge) — die Öffnung sitzt auf der echten Wand.
    let host = p.walls.iter().find(|w| w.id == wall.id).unwrap_or(wall);
    for o in p.openings_of_wall(&wall.id) {
        // Bogenwand ([T2]): Einzug auf der Sehne zwischen den Laibungen.
        let chord = arc_chord_opening(host, o);
        let (wall, o) = match &chord {
            Some((vw, vo)) => (vw, vo),
            None => (wall, o),
        };
        // Lichte Höhe an der Schnittstelle (Formöffnungen: aus dem Umriss, wie die Wandbänder).
        let Ok(Some(c)) = cross_section(p, wall, o, plane.base(), u) else { continue };
        let at_top = (v_min - c.z_top).abs() < 1e-3;
        let at_bottom = (v_max - c.z_bottom).abs() < 1e-3;
        if !at_top && !at_bottom {
            continue;
        }
        let sides = crate::opening_detail::opening_reveal(p, wall, o).map(|r| r.sides).unwrap_or_default();
        let shaped = c.shape.as_ref().filter(|_| sides.iter().any(|s| !s.is_empty()));
        let shape = || shaped.map(|(poly, u, zb)| ShapeJoin { poly: poly.clone(), u: *u, zb: *zb, sides: sides.clone() });
        let [_, _, t, b] = sides.clone();
        // Anschlag: oben wie an der Leibung (Sturz-Nase), unten nach `rebates.bottom` (Türen: keiner).
        let h = c.z_top - c.z_bottom;
        let frame = crate::opening_detail::frame_of(p, o);
        let zone = frame.as_ref().and_then(|f| f.rebate_zone(c.face_max - c.face_min));
        let rebate = |d: f64| zone.map(|(z0, z1)| (min(d, h / 3.0), z0, z1)).filter(|r| r.0 > 1e-4);
        let (rt, rb) = match &frame {
            Some(f) => (rebate(f.rebate.top), if o.kind == ElementKind::Door { None } else { rebate(f.rebate.bottom) }),
            None => (None, None),
        };
        if at_top && (!t.is_empty() || rt.is_some() || shaped.is_some()) {
            top = Some(EdgeJoin { adj: t, rebate: rt, shape: shape() });
        }
        if at_bottom && (!b.is_empty() || rb.is_some() || shaped.is_some()) {
            bottom = Some(EdgeJoin { adj: b, rebate: rb, shape: shape() });
        }
    }
    (top, bottom)
}

/// `attachCutStyles`: Stil, Herkunft, Schicht-Bänder, Terminierung, Dominanz.
fn attach_cut_styles(cuts: Vec<Cut>, p: &Project, plane: &Plane, walls: &[Option<&Wall>], slabs: &[SlabOwner]) -> Result<Vec<Cut>, String> {
    if cuts.is_empty() {
        return Ok(cuts);
    }
    let u_world = plane.u_model();
    let roofs = p.roofs.as_deref().unwrap_or(&[]);
    let mut bands: Vec<Cut> = Vec::with_capacity(cuts.len());
    for mut cp in cuts {
        match cp.kind {
            Kind::Roof => {
                let owner = roofs.get(cp.index);
                cp.source_id = owner.map(|o| o.id.clone());
                cp.category = owner.map(|o| o.category_code.clone());
                bands.push(cp);
            }
            Kind::Wall => {
                let owner = walls.get(cp.index).copied().flatten();
                cp.source_id = owner.map(|o| o.id.clone());
                cp.category = owner.map(|o| o.category_code.clone());
                if let Some(o) = owner {
                    let wt = p.wall_type_or_fallback(o);
                    if wt.layers.len() > 1 {
                        bands.extend(split_wall_layers(&cp, p, &wt.layers, o, u_world, plane)?);
                        continue;
                    }
                }
                if let Some((fill, hatch)) = owner.and_then(|o| wall_section_style(p, o)) {
                    cp.fill = Some(fill);
                    cp.hatch = Some(hatch);
                }
                cp.join_priority = owner.and_then(|o| wall_representative_priority(p, o));
                cp.component_id = owner.and_then(|o| wall_representative_component_id(p, o));
                // [94] Anschlag-Nase der einschaligen Wand: Band und Nase als ein Umriss.
                let nibs = owner.map(|o| single_layer_nibs(p, o, &cp, u_world, plane)).unwrap_or_default();
                if !nibs.is_empty() {
                    let mut polys = vec![vec![cp.pts.clone()]];
                    polys.extend(nibs.iter().map(|r| vec![vec![[r[0], r[3]], [r[1], r[3]], [r[1], r[2]], [r[0], r[2]]]]));
                    for poly in crate::polygon_bool::union(&polys) {
                        if let Some(ring) = poly.into_iter().next().filter(|r| r.len() >= 3) {
                            bands.push(Cut { pts: ring, ..cp.clone() });
                        }
                    }
                    continue;
                }
                bands.push(cp);
            }
            _ => {
                match slabs.get(cp.index).copied().unwrap_or(SlabOwner::None) {
                    SlabOwner::Ceiling(o, layer) => {
                        cp.source_id = Some(o.id.clone());
                        cp.category = Some(o.category_code.clone());
                        let layers = ceiling_layers(p, o).unwrap_or(Project::fallback_layers());
                        if layers.len() > 1 {
                            // Schicht-Platte: Stil genau dieser Schicht; ohne Schicht (Dicke 0) ohne Stil.
                            if let Some(l) = layer.and_then(|i| layers.get(i)) {
                                style_slab_layer(&mut cp, p, l, o)?;
                                cp.layer_index = layer;
                            }
                        } else {
                            if let Some((fill, hatch)) = ceiling_section_style(p, o) {
                                cp.fill = Some(fill);
                                cp.hatch = Some(hatch);
                            }
                            cp.join_priority = ceiling_representative_priority(p, o);
                            cp.component_id = ceiling_representative_component_id(p, o);
                        }
                    }
                    // Treppen-Prismen: Herkunft + Kategorie; Stil = Rückfall-Schraffur (Treppen haben kein Bauteil).
                    SlabOwner::Stair(st) => {
                        cp.stair_id = Some(st.id.clone());
                        cp.category = Some(st.category_code.clone());
                    }
                    // [141] Stütze: Stil und Rang ihres Bauteils (wie im Grundriss); ohne Bauteil dominiert sie.
                    SlabOwner::Column(c) => {
                        cp.source_id = Some(c.id.clone());
                        cp.category = Some(c.category_code.clone());
                        let comp = c.component_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.component(id));
                        if let Some(k) = comp {
                            let category = p.layer_category(&c.category_code);
                            let hid = resolve_hatch_id(c.hatch_id.as_deref(), c.hatch_source, category, Some(&k.hatch_id)).unwrap_or(&k.hatch_id);
                            if let Some(h) = resolve_hatch(p, hid, None, resolve_foreground(k, c.foreground.as_deref(), category, c.foreground_source), None) {
                                cp.fill = Some(poche_fill(h.pattern).to_string());
                                cp.hatch = Some(h);
                            }
                            cp.component_id = Some(k.id.clone());
                        }
                        cp.join_priority = Some(comp.map_or(f64::MAX, |k| k.join_priority));
                    }
                    SlabOwner::None => {}
                }
                bands.push(cp);
            }
        }
    }
    let terminated = apply_wall_termination(bands, walls);
    Ok(subtract_dominant_bands(terminated))
}

/// `applyWallTermination`: Wände mit `sliceTermination` "below"/"above" enden an der Decke.
fn apply_wall_termination(bands: Vec<Cut>, walls: &[Option<&Wall>]) -> Vec<Cut> {
    const EPS_T: f64 = 1e-9;
    const TOUCH: f64 = 0.05;
    let slab_bands: Vec<([f64; 4], f64)> = bands.iter().filter(|b| b.kind == Kind::Slab).filter_map(|b| b.join_priority.map(|jp| (bbox(&b.pts), jp))).collect();
    if slab_bands.is_empty() {
        return bands;
    }
    let mut out = Vec::with_capacity(bands.len());
    for b in bands {
        if b.kind != Kind::Wall {
            out.push(b);
            continue;
        }
        let term = walls.get(b.index).copied().flatten().and_then(|w| w.slice_termination);
        let (Some(term @ (SliceTermination::Below | SliceTermination::Above)), Some(jp)) = (term, b.join_priority) else {
            out.push(b);
            continue;
        };
        let wb = bbox(&b.pts);
        let cutters: Vec<&([f64; 4], f64)> = slab_bands.iter().filter(|(sb, sjp)| *sjp > jp && sb[1] > wb[0] - TOUCH && sb[0] < wb[1] + TOUCH).collect();
        if cutters.is_empty() {
            out.push(b);
            continue;
        }
        if term == SliceTermination::Below {
            let mut clip_top = f64::INFINITY;
            for c in &cutters {
                clip_top = min(clip_top, c.0[2]);
            }
            let top = min(clip_top, wb[3]);
            if top > wb[2] + EPS_T {
                out.extend(clip_band(b, [wb[0], wb[1], wb[2], top]));
            }
            continue;
        }
        let mut clip_bottom = f64::NEG_INFINITY;
        for c in &cutters {
            clip_bottom = max(clip_bottom, c.0[3]);
        }
        let bottom = max(clip_bottom, wb[2]);
        if bottom < wb[3] - EPS_T {
            out.extend(clip_band(b, [wb[0], wb[1], bottom, wb[3]]));
        }
    }
    out
}

/// Band auf das Rechteck `[u0, u1, v0, v1]` beschnitten; ein Band mit Anschlag-Nase ([94], kein
/// Rechteck) behält seine Form.
fn clip_band(b: Cut, r: [f64; 4]) -> Vec<Cut> {
    let rect = vec![[r[0], r[3]], [r[1], r[3]], [r[1], r[2]], [r[0], r[2]]];
    if b.pts.len() <= 4 || is_axis_rect(&b.pts) {
        return vec![Cut { pts: rect, ..b }];
    }
    crate::polygon_bool::intersection(&[vec![b.pts.clone()]], &[vec![rect]])
        .into_iter()
        .filter_map(|poly| poly.into_iter().next().filter(|ring| ring.len() >= 3))
        .map(|ring| Cut { pts: ring, ..b.clone() })
        .collect()
}

/// `subtractDominantBands` (Rechnung: `dossier_hatch::section_dominance`, gemeinsam mit dem 3D-Live-Schnitt).
fn subtract_dominant_bands(bands: Vec<Cut>) -> Vec<Cut> {
    use dossier_hatch::section_dominance::{dominant_bands, Band};
    let mut ids: HashMap<&str, u32> = HashMap::new();
    let inp: Vec<Band> = bands
        .iter()
        .map(|band| {
            let comp = band.component_id.as_deref().map(|id| {
                let n = ids.len() as u32;
                *ids.entry(id).or_insert(n)
            });
            let rect = rect_of_band(band).map(|r| dossier_hatch::section_dominance::Rect { u_min: r[0], u_max: r[1], v_min: r[2], v_max: r[3] });
            Band { rect, prio: band.join_priority, comp }
        })
        .collect();
    let rect_out: Vec<Cut> = dominant_bands(&inp)
        .into_iter()
        .map(|piece| {
            let src = &bands[piece.src];
            let Some(r) = piece.rect else { return src.clone() };
            let mut c = Cut::new(src.kind, src.index, vec![[r.u_min, r.v_max], [r.u_max, r.v_max], [r.u_max, r.v_min], [r.u_min, r.v_min]]);
            c.fill = src.fill.clone();
            c.hatch = src.hatch.clone();
            c.join_priority = src.join_priority;
            c.component_id = src.component_id.clone();
            c.source_id = src.source_id.clone();
            // Herkunft bleibt am Stück (Ebenen-Sichtbarkeit, Treppen-Pick).
            c.category = src.category.clone();
            c.stair_id = src.stair_id.clone();
            c.layer_index = src.layer_index;
            c
        })
        .collect();
    subtract_dominant_polygons(rect_out, &bands)
}

/// [G6] Dominanz für Bänder, die keine achsparallelen Rechtecke sind (schräge Dachschichten …): Jedes Stück
/// verliert die Überlappung mit allen Bändern STRIKT höherer Priorität, wenn eines der beiden kein Rechteck ist
/// (Rechteck gegen Rechteck hat `dominant_bands` schon erledigt). Polygon-Booleans über den Kern (i_overlay).
/// Bleibt ein Loch übrig (Band ganz um ein dominantes herum), wird das Stück unverändert übernommen.
fn subtract_dominant_polygons(pieces: Vec<Cut>, bands: &[Cut]) -> Vec<Cut> {
    let cutters: Vec<(&Cut, bool, [f64; 4])> = bands.iter().filter(|b| b.pts.len() >= 3 && b.join_priority.is_some()).map(|b| (b, is_axis_rect(&b.pts), bbox(&b.pts))).collect();
    if cutters.iter().all(|c| c.1) {
        return pieces;
    }
    let mut out = Vec::with_capacity(pieces.len());
    for piece in pieces {
        let Some(jp) = piece.join_priority.filter(|_| piece.pts.len() >= 3) else {
            out.push(piece);
            continue;
        };
        let rect = is_axis_rect(&piece.pts);
        let pb = bbox(&piece.pts);
        let polys: Vec<crate::flat::Polygon> = cutters
            .iter()
            .filter(|(c, c_rect, cb)| c.join_priority.is_some_and(|q| q > jp) && !(rect && *c_rect) && cb[0] < pb[1] - 1e-9 && cb[1] > pb[0] + 1e-9 && cb[2] < pb[3] - 1e-9 && cb[3] > pb[2] + 1e-9)
            .map(|(c, _, _)| vec![c.pts.clone()])
            .collect();
        if polys.is_empty() {
            out.push(piece);
            continue;
        }
        let rest = crate::polygon_bool::difference(&[vec![piece.pts.clone()]], &polys);
        if rest.iter().any(|p| p.len() > 1) {
            out.push(piece);
            continue;
        }
        for poly in rest {
            let Some(ring) = poly.into_iter().next() else { continue };
            let area = ring.iter().enumerate().map(|(i, a)| { let c = ring[(i + 1) % ring.len()]; a[0] * c[1] - c[0] * a[1] }).sum::<f64>().abs() / 2.0;
            if ring.len() >= 3 && area > 1e-8 {
                out.push(Cut { pts: ring, ..piece.clone() });
            }
        }
    }
    out
}

// ── Dächer ────────────────────────────────────────────────────────────────────

/// `appendRoofSections`: Schnittspur der Dachflächen, je Schicht ein Band.
/// Formöffnungen ([G3]): Die Wand hat im Modell das Rechteck-Loch; an der Schnittstelle reicht die
/// Wand bis an den Umriss. Die geschnittenen Wandbänder über bzw. unter der Öffnung werden bis zur
/// lichten Höhe des Umrisses an dieser Stelle verlängert.
fn shaped_wall_cuts(cuts: &mut [Cut], p: &Project, walls_r: &[RWall], base: (f64, f64), u: (f64, f64)) {
    let ul = hypot2(u.0, u.1);
    if !(ul > 1e-12) {
        return;
    }
    let u = (u.0 / ul, u.1 / ul);
    for o in p.openings.as_deref().unwrap_or(&[]).iter().filter(|o| crate::opening_shape::is_shaped(o)) {
        let Some(host) = p.walls.iter().find(|w| w.id == o.host_wall_id) else { continue };
        // Bogenwand ([T2]): Umriss auf der Sehne zwischen den Laibungen.
        let chord = arc_chord_opening(host, o);
        let (wall, o) = match &chord {
            Some((vw, vo)) => (vw, vo),
            None => (host, o),
        };
        let Some((from, to)) = opening_interval(wall, o) else { continue };
        let (a, _) = axis_frame(wall);
        let den = a.0 * u.1 - a.1 * u.0;
        if den.abs() < MIN_CROSS {
            continue;
        }
        let (rx, ry) = (base.0 - wall.start.x, base.1 - wall.start.y);
        let along = (rx * u.1 - ry * u.0) / den;
        if along <= from + 1e-4 || along >= to - 1e-4 {
            continue;
        }
        let (zb, zt) = opening_extent(p, wall, o);
        let Some(poly) = crate::opening_shape::opening_outline(o, to - from, zt - zb) else { continue };
        let Some((lo, hi)) = crate::opening_shape::v_range(&poly, along - from) else { continue };
        let (new_bottom, new_top) = (zb + lo, zb + hi);
        const TOL: f64 = 2e-3;
        for c in cuts.iter_mut().filter(|c| c.kind == Kind::Wall && walls_r.get(c.index).is_some_and(|w| w.wall_id == wall.id)) {
            let (y_lo, y_hi) = c.pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), q| (l.min(q[1]), h.max(q[1])));
            let (from_y, to_y) = if (y_lo - zt).abs() < TOL && new_top < zt - 1e-6 {
                (zt, new_top)
            } else if (y_hi - zb).abs() < TOL && new_bottom > zb + 1e-6 {
                (zb, new_bottom)
            } else {
                continue;
            };
            for q in c.pts.iter_mut().filter(|q| (q[1] - from_y).abs() < TOL) {
                q[1] = to_y;
            }
        }
    }
}

/// Neigung (Grad) der längsten Kante eines Schnitt-Rings, auf −90…90 gefaltet.
fn ring_slope_deg(pts: &[[f64; 2]]) -> f64 {
    let n = pts.len();
    let mut best = (0.0, 0.0);
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = dx * dx + dy * dy;
        if l > best.0 {
            best = (l, if dx < 0.0 { atan2(-dy, -dx) } else { atan2(dy, dx) });
        }
    }
    best.1 * 180.0 / std::f64::consts::PI
}

/// Formöffnungen ([G3]) hinter der Schnittebene: die Wand trägt im Modell das Rechteck-Loch, die
/// Projektion zeigt aber den Umriss — Kanten der Wand im Loch-Rechteck fallen weg, der Umriss auf der
/// zugewandten Wandfläche kommt dazu.
fn shaped_projection(visible: &mut Vec<Edge>, p: &Project, walls_r: &[RWall], plane: &Plane) {
    let (base, u) = (plane.base(), plane.u_model());
    let ul = hypot2(u.0, u.1);
    if !(ul > 1e-12) {
        return;
    }
    let u = (u.0 / ul, u.1 / ul);
    let nrm = (plane.normal[0], plane.normal[2]);
    for o in p.openings.as_deref().unwrap_or(&[]).iter().filter(|o| crate::opening_shape::is_shaped(o)) {
        let Some(host) = p.walls.iter().find(|w| w.id == o.host_wall_id) else { continue };
        // Bogenwand ([T2]): Umriss auf der Sehne zwischen den Laibungen.
        let chord = arc_chord_opening(host, o);
        let (wall, o) = match &chord {
            Some((vw, vo)) => (vw, vo),
            None => (host, o),
        };
        let owners: Vec<usize> = walls_r.iter().enumerate().filter(|(_, w)| w.wall_id == wall.id).map(|(i, _)| i).collect();
        if owners.is_empty() || !visible.iter().any(|e| e.kind == Kind::Wall && owners.contains(&e.index)) {
            continue;
        }
        let Some((from, to)) = opening_interval(wall, o) else { continue };
        let (a, n) = axis_frame(wall);
        if (a.0 * u.0 + a.1 * u.1).abs() < 0.05 {
            continue;
        }
        let (zb, zt) = opening_extent(p, wall, o);
        let Some(poly) = crate::opening_shape::opening_outline(o, to - from, zt - zb) else { continue };
        let total = sum_thickness(&p.wall_type_or_fallback(wall).layers);
        let ref_off = crate::joins::reference_offset(model3d::wall_reference(wall), total);
        let at = |s: f64, off: f64| (wall.start.x + a.0 * s + n.0 * off, wall.start.y + a.1 * s + n.1 * off);
        let uu = |q: (f64, f64)| (q.0 - base.0) * u.0 + (q.1 - base.1) * u.1;
        let depth = |q: (f64, f64)| (q.0 - base.0) * nrm.0 + (q.1 - base.1) * nrm.1;
        let faces = [ref_off - total / 2.0, ref_off + total / 2.0];
        let us: Vec<f64> = faces.iter().flat_map(|&f| [uu(at(from, f)), uu(at(to, f))]).collect();
        let (u_lo, u_hi) = us.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), &x| (l.min(x), h.max(x)));
        const TOL: f64 = 1e-3;
        let inside = |q: [f64; 2]| q[0] >= u_lo - TOL && q[0] <= u_hi + TOL && q[1] >= zb - TOL && q[1] <= zt + TOL;
        visible.retain(|e| !(e.kind == Kind::Wall && owners.contains(&e.index) && inside(e.a) && inside(e.b)));
        // Senkrechte Stösse der Wandstücke neben dem Loch: der Teil auf Öffnungshöhe entfällt (dort
        // liegt der Umriss bzw. die durchgehende Wand).
        let mut split: Vec<Edge> = Vec::new();
        for e in visible.iter_mut().filter(|e| e.kind == Kind::Wall && owners.contains(&e.index) && (e.a[0] - e.b[0]).abs() < TOL && e.a[0] >= u_lo - TOL && e.a[0] <= u_hi + TOL) {
            let (lo, hi) = (e.a[1].min(e.b[1]), e.a[1].max(e.b[1]));
            if hi <= zb + TOL || lo >= zt - TOL {
                continue;
            }
            let x = e.a[0];
            if hi > zt + TOL {
                split.push(Edge { kind: e.kind, index: e.index, a: [x, zt], b: [x, hi] });
            }
            // Rest unten (oder leer: Länge 0 wird unten entfernt).
            (e.a, e.b) = ([x, lo], [x, lo.max(zb.min(hi))]);
        }
        visible.retain(|e| (e.a[0] - e.b[0]).abs() + (e.a[1] - e.b[1]).abs() > 1e-9);
        visible.extend(split);
        // Zugewandte Fläche: kleinere Tiefe hinter der Ebene.
        let mid = (from + to) / 2.0;
        let near = if depth(at(mid, faces[0])) <= depth(at(mid, faces[1])) { faces[0] } else { faces[1] };
        let pts: Vec<[f64; 2]> = poly.iter().map(|q| [uu(at(from + q[0], near)), zb + q[1]]).collect();
        for i in 0..pts.len() {
            visible.push(Edge { kind: Kind::Wall, index: owners[0], a: pts[i], b: pts[(i + 1) % pts.len()] });
        }
    }
}

fn append_roof_sections(cuts: &mut Vec<Cut>, p: &Project, plane: &Plane) {
    let roofs = p.roofs.as_deref().unwrap_or(&[]);
    if roofs.is_empty() {
        return;
    }
    let (bx, by) = plane.base();
    let (ux, uy) = plane.u_model();
    let nb = crate::roof_assembly::neighbors_rc(p);
    for (index, roof) in roofs.iter().enumerate() {
        // Verschnittene Dächer und Gauben ([G5]): Schnitt durch die Körper je Schicht.
        if let Some(solids) = crate::roof_assembly::roof_solids_with(p, index, &nb) {
            let rl = p.roof_layers(roof);
            for part in &solids.parts {
                let li = rl.iter().position(|l| !part.component_id.is_empty() && l.component_id == part.component_id);
                let rings = crate::roof_assembly::section_rings(&part.mesh, (bx, by), (ux, uy));
                if rings.is_empty() {
                    continue;
                }
                let wall = part.role == crate::roof_assembly::Role::DormerWall;
                for pts in rings {
                    // Muster der Dachschichten entlang der Neigung (Richtung der längsten Kante).
                    let slope = if wall { None } else { Some(ring_slope_deg(&pts)) };
                    let hatch = if part.component_id.is_empty() { None } else { p.component(&part.component_id).and_then(|comp| resolve_hatch(p, &comp.hatch_id, slope, None, None)) };
                    let mut c = Cut::new(Kind::Roof, index, pts);
                    c.layer_index = li;
                    if let Some(h) = &hatch {
                        c.fill = Some(poche_fill(h.pattern).to_string());
                        c.hatch = Some(h.clone());
                    }
                    cuts.push(c);
                }
            }
            continue;
        }
        let eaves = p.roof_base_elevation(roof);
        let geo = crate::roof::roof_geometry(&roof.params(), eaves);
        let layers = p.roof_layers(roof);
        let total = layers.iter().fold(0.0, |s, l| s + max(0.0, l.thickness));
        if total <= 1e-9 {
            continue;
        }
        let mut pl: Vec<f64> = vec![geo.planes.len() as f64];
        for plane in &geo.planes {
            pl.push(plane.len() as f64);
            for q in plane {
                pl.extend([q[0], q[1], q[2]]);
            }
        }
        let sg = crate::plan::section_bands::roof_segments(bx, by, ux, uy, &pl);
        // Dachfenster ([103]): Lochkörper in der Schnittebene, aus jeder Schicht ausgeschnitten.
        let holes: Vec<Vec<[f64; 2]>> = crate::opening_shape::roof_openings(p, index)
            .iter()
            .filter_map(|(o, f)| crate::opening_shape::box_section(&crate::opening_shape::surface_hole_box(o, f), (bx, by), (ux, uy)))
            .collect();
        let n = sg.first().copied().unwrap_or(0.0) as usize;
        for k in 0..n {
            let o = 1 + 5 * k;
            let (t_lo, t_hi, z0, z1, cos_t) = (sg[o], sg[o + 1], sg[o + 2], sg[o + 3], sg[o + 4]);
            let mut prefix = 0.0;
            for (li, layer) in layers.iter().enumerate() {
                let t = max(0.0, layer.thickness);
                if t <= 1e-9 {
                    continue;
                }
                let vt = t / max(cos_t, 1e-6);
                let top0 = z0 - prefix;
                let top1 = z1 - prefix;
                prefix += vt;
                let mut pieces = vec![vec![[t_lo, top0], [t_hi, top1], [t_hi, top1 - vt], [t_lo, top0 - vt]]];
                for h in &holes {
                    pieces = pieces.iter().flat_map(|pc| crate::opening_shape::subtract_convex(pc, h)).collect();
                }
                // Wandbezogene Muster laufen entlang der Dachneigung ([109]: Dämmschlange über die Schichtdicke).
                let slope_deg = atan2(z1 - z0, t_hi - t_lo) * 180.0 / std::f64::consts::PI;
                let hatch = if layer.component_id.is_empty() { None } else { p.component(&layer.component_id).and_then(|comp| resolve_hatch(p, &comp.hatch_id, Some(slope_deg), None, None)) };
                for pts in pieces {
                    let mut c = Cut::new(Kind::Roof, index, pts);
                    c.layer_index = Some(li);
                    if let Some(h) = &hatch {
                        c.fill = Some(poche_fill(h.pattern).to_string());
                        c.hatch = Some(h.clone());
                    }
                    cuts.push(c);
                }
            }
        }
    }
}

// ── Monolith, Abzugskörper, Körper, Gelände, Tiefe ───────────────────────────

/// `unionRectOutlines` (Rechnung: `plan::section_bands::union_outlines`).
fn union_rect_outlines(rects: &[[f64; 4]]) -> Vec<Vec<[f64; 2]>> {
    let mut b = vec![rects.len() as f64];
    for r in rects {
        b.extend(r);
    }
    let f = crate::plan::section_bands::union_outlines(&b);
    let mut rings = Vec::new();
    let mut i = 1;
    for _ in 0..f.first().copied().unwrap_or(0.0) as usize {
        let count = f[i] as usize;
        i += 1;
        rings.push((0..count).map(|j| [f[i + 2 * j], f[i + 2 * j + 1]]).collect());
        i += 2 * count;
    }
    rings
}

/// `mergeMonolithCuts`.
fn merge_monolith_cuts(cuts: Vec<Cut>, slabs: &[RSlab], exact: &HashMap<String, Vec<Vec<[f64; 2]>>>) -> Vec<Cut> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<Cut>> = HashMap::new();
    let mut out = Vec::new();
    for cp in cuts {
        let g = if cp.kind == Kind::Slab { slabs.get(cp.index).and_then(|s| s.monolith.clone()).filter(|g| !g.is_empty()) } else { None };
        match g {
            None => out.push(cp),
            Some(g) => {
                if !groups.contains_key(&g) {
                    order.push(g.clone());
                }
                groups.entry(g).or_default().push(cp);
            }
        }
    }
    for g in order {
        let list = groups.remove(&g).unwrap_or_default();
        // [G1] Exakte Fläche (gerade Betontreppe: Untersicht als Gerade statt Scheiben-Sägezahn).
        if let Some(rings) = exact.get(&g).filter(|r| !r.is_empty() && !list.is_empty()) {
            for ring in rings {
                out.push(Cut { pts: ring.clone(), nse: None, ..list[0].clone() });
            }
            continue;
        }
        if list.len() == 1 {
            out.extend(list);
            continue;
        }
        let rects: Vec<[f64; 4]> = list.iter().filter_map(rect_of_band).collect();
        if rects.len() != list.len() {
            out.extend(list);
            continue;
        }
        for ring in union_rect_outlines(&rects) {
            out.push(Cut { pts: ring, ..list[0].clone() });
        }
    }
    out
}

/// [G1] Schnittflächen der Laufplatten gerader Betontreppen (je Treppen-ID vereinigt, Löcher als
/// Schlüsselloch) aus ihren Netzen mit exakter Untersicht.
fn stair_flight_sections(p: &Project, base: (f64, f64), u: (f64, f64)) -> HashMap<String, Vec<Vec<[f64; 2]>>> {
    let stairs = p.stairs.as_deref().unwrap_or(&[]);
    let mut polys: HashMap<String, Vec<crate::flat::Polygon>> = HashMap::new();
    for (si, m) in model3d::stair_flight_meshes(p) {
        let Some(st) = stairs.get(si) else { continue };
        let idx: Vec<f64> = m.indices.iter().map(|&i| i as f64).collect();
        let (rings, _) = cut_mesh(&m.positions, &idx, base, u);
        polys.entry(st.id.clone()).or_default().extend(rings_to_polygons(&rings));
    }
    polys
        .into_iter()
        .map(|(id, list)| {
            let rings = crate::polygon_bool::union(&list).into_iter().map(|poly| if poly.len() > 1 { keyhole(&poly).0 } else { poly.into_iter().next().unwrap_or_default() }).map(drop_collinear).filter(|r| r.len() >= 3).collect();
            (id, rings)
        })
        .collect()
}

/// Ecken ohne Knick weglassen (Tritt-Fugen auf der Untersicht).
fn drop_collinear(r: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    let n = r.len();
    if n < 4 {
        return r;
    }
    let keep = |i: usize| {
        let (a, b, c) = (r[(i + n - 1) % n], r[i], r[(i + 1) % n]);
        let (ux, uy, vx, vy) = (b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]);
        let l = hypot2(ux, uy) * hypot2(vx, vy);
        !(l > 0.0) || (ux * vy - uy * vx).abs() > 1e-6 * l || ux * vx + uy * vy < 0.0
    };
    (0..n).filter(|&i| keep(i)).map(|i| r[i]).collect()
}

fn is_void_solid(s: &ExtrudedSolid) -> bool {
    s.operation.as_deref() == Some("subtract") && s.brep.is_none() && s.taper.unwrap_or(0.0) < 1e-6 && s.points.len() >= 3 && s.height > 0.0
}

/// [106] Schnitt parallel zur Wand durch die Leibungen: Die geschnittene Schicht springt an den
/// Öffnungen um ihren Rücksprung zurück (Loch geweitet), ihre Zusatzstücke (Leibungsdämmung, Putz,
/// Überdämmung), die die Schnittebene quert, kommen als Schnittfläche im Stil der Schicht dazu.
fn parallel_reveal_cuts(mut cuts: Vec<Cut>, p: &Project, plane: &Plane, walls: &[Option<&Wall>]) -> Result<Vec<Cut>, String> {
    use crate::opening_detail::SIDES;
    let (base, u_raw) = (plane.base(), plane.u_model());
    let l = hypot2(u_raw.0, u_raw.1);
    if !(l > 1e-12) {
        return Ok(cuts);
    }
    let u = (u_raw.0 / l, u_raw.1 / l);
    let mut seen: Vec<&str> = Vec::new();
    for w in walls.iter().flatten() {
        if seen.contains(&w.id.as_str()) {
            continue;
        }
        seen.push(&w.id);
        // Bogenwand: Ebene parallel zur gekrümmten Wand gibt es nicht (nur Sehnen-Teilwände).
        if crate::wall_arc::is_arc_bulge(w.bulge) {
            continue;
        }
        let (a, n) = axis_frame(w);
        let (un, ua) = (u.0 * n.0 + u.1 * n.1, u.0 * a.0 + u.1 * a.1);
        if un.abs() > 0.05 || ua.abs() < 0.5 {
            continue;
        }
        let Some(wt) = p.wall_type(w) else { continue };
        let total = sum_thickness(&wt.layers);
        let ref_off = crate::joins::reference_offset(model3d::wall_reference(w), total);
        let rel = (base.0 - w.start.x, base.1 - w.start.y);
        let d = rel.0 * n.0 + rel.1 * n.1 - (ref_off - total / 2.0);
        if d <= 1e-6 || d >= total - 1e-6 {
            continue;
        }
        let mut acc = 0.0;
        let Some(li) = wt.layers.iter().position(|ly| {
            acc += ly.thickness;
            d < acc
        }) else {
            continue;
        };
        let a0 = rel.0 * a.0 + rel.1 * a.1;
        let u_of = |s: f64| (s - a0) / ua;
        let owners: Vec<usize> = walls.iter().enumerate().filter(|(_, x)| x.is_some_and(|x| x.id == w.id)).map(|(i, _)| i).collect();
        let mut voids: Vec<Vec<[f64; 2]>> = Vec::new();
        let mut pieces: Vec<Vec<[f64; 2]>> = Vec::new();
        let rect = |s0: f64, s1: f64, z0: f64, z1: f64| {
            let (ua, ub) = (u_of(s0).min(u_of(s1)), u_of(s0).max(u_of(s1)));
            vec![[ua, z0], [ub, z0], [ub, z1], [ua, z1]]
        };
        for o in p.openings_of_wall(&w.id) {
            let Some(r) = crate::opening_detail::opening_reveal(p, w, o) else { continue };
            let (zb, zt) = opening_extent(p, w, o);
            // Rücksprung je Seite dieser Schicht; die seitlichen reichen in die Ecken oben/unten.
            let sh: Vec<f64> = (0..4).map(|k| r.sides[k].iter().filter(|x| x.layer == li).map(|x| x.shift).fold(0.0, f64::max)).collect();
            for (k, side) in SIDES.iter().enumerate() {
                for adj in r.sides[k].iter().filter(|x| x.layer == li) {
                    let s = adj.shift;
                    if s > 1e-6 {
                        voids.push(match side {
                            crate::opening_detail::Side::Left => rect(r.from - s, r.from, zb - sh[3], zt + sh[2]),
                            crate::opening_detail::Side::Right => rect(r.to, r.to + s, zb - sh[3], zt + sh[2]),
                            crate::opening_detail::Side::Top => rect(r.from, r.to, zt, zt + s),
                            crate::opening_detail::Side::Bottom => rect(r.from, r.to, zb - s, zb),
                        });
                    }
                    for pc in adj.pieces.iter().filter(|pc| d >= pc[2] - 1e-9 && d <= pc[3] + 1e-9 && pc[1] - pc[0] > 1e-6) {
                        pieces.push(match side {
                            crate::opening_detail::Side::Left => rect(r.from + pc[0], r.from + pc[1], zb, zt),
                            crate::opening_detail::Side::Right => rect(r.to - pc[1], r.to - pc[0], zb, zt),
                            crate::opening_detail::Side::Top => rect(r.from, r.to, zt - pc[1], zt - pc[0]),
                            crate::opening_detail::Side::Bottom => rect(r.from, r.to, zb + pc[0], zb + pc[1]),
                        });
                    }
                }
            }
        }
        if voids.is_empty() && pieces.is_empty() {
            continue;
        }
        if !voids.is_empty() {
            let refs: Vec<&[[f64; 2]]> = voids.iter().map(|r| r.as_slice()).collect();
            let cutters = encode_rings(&refs);
            let mut out = Vec::with_capacity(cuts.len());
            for cp in cuts {
                if cp.kind != Kind::Wall || !owners.contains(&cp.index) || cp.pts.len() < 3 {
                    out.push(cp);
                    continue;
                }
                let ring = &encode_rings(&[cp.pts.as_slice()])[1..];
                let f = crate::voids::subtract_rings_flat(ring, &cutters, &[0.0]);
                if f.is_empty() || f[0] < 0.0 {
                    out.push(cp);
                    continue;
                }
                let mut i = 1;
                for _ in 0..f[0] as usize {
                    let k = f[i] as usize;
                    i += 1;
                    let pts: Vec<[f64; 2]> = (0..k).map(|j| [f[i + 2 * j], f[i + 2 * j + 1]]).collect();
                    i += 2 * k;
                    let m = f[i] as usize;
                    i += 1 + m;
                    out.push(Cut { pts, nse: None, ..cp.clone() });
                }
            }
            cuts = out;
        }
        let Some(&idx) = owners.first() else { continue };
        let layer = &wt.layers[li];
        let comp = p.component_or_fallback(&layer.component_id);
        let category = p.layer_category(&w.category_code);
        let (fill, hatch) = layer_style(p, comp, w.hatch_id.as_deref(), w.hatch_source, w.foreground.as_deref(), w.foreground_source, w.background.as_deref(), w.background_source, category, SECTION_WALL_AXIS_ANGLE_DEG)?;
        for pts in pieces {
            let mut c = Cut::new(Kind::Wall, idx, pts);
            c.fill = Some(fill.clone());
            c.hatch = Some(hatch.clone());
            c.join_priority = Some(comp.join_priority);
            c.component_id = Some(comp.id.clone());
            c.source_id = Some(w.id.clone());
            c.category = Some(w.category_code.clone());
            c.layer_index = Some(li);
            cuts.push(c);
        }
    }
    Ok(cuts)
}

fn encode_rings(rings: &[&[[f64; 2]]]) -> Vec<f64> {
    let mut b = vec![rings.len() as f64];
    for r in rings {
        b.push(r.len() as f64);
        for q in *r {
            b.extend(q);
        }
    }
    b
}

/// `subtractVoidsInSection`.
fn subtract_voids_in_section(cuts: Vec<Cut>, p: &Project, base: (f64, f64), u: (f64, f64)) -> Vec<Cut> {
    let mut rects: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut any = false;
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if !is_void_solid(s) {
            continue;
        }
        any = true;
        let z0 = p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0)) + s.base_offset.unwrap_or(0.0);
        let z1 = z0 + s.height;
        let mut pts = vec![s.points.len() as f64];
        for q in &s.points {
            pts.extend([q.x, q.y]);
        }
        let f = crate::voids::section_rects_flat(&pts, &[base.0, base.1, u.0, u.1]);
        for k in 0..f.first().copied().unwrap_or(0.0) as usize {
            let (u0, u1) = (f[1 + 2 * k], f[2 + 2 * k]);
            rects.push(vec![[u0, z0], [u1, z0], [u1, z1], [u0, z1]]);
        }
    }
    if !any || rects.is_empty() {
        return cuts;
    }
    subtract_rings_from_cuts(cuts, &rects)
}

/// [G1] Ob ein Körper-Netz zu einem Abzugskörper gehört.
fn is_subtract_body(p: &Project, b: &BodyMesh) -> bool {
    p.extruded_solids.as_deref().and_then(|s| s.get(b.index)).is_some_and(|s| s.operation.as_deref() == Some("subtract"))
}

/// [G1] Abzugskörper beliebiger Form: Netz mit der Ebene schneiden, Flächen (Löcher als Schlüsselloch)
/// von allen bisherigen Schnittflächen abziehen.
fn subtract_body_voids_in_section(cuts: Vec<Cut>, voids: &[&BodyMesh], base: (f64, f64), u: (f64, f64)) -> Vec<Cut> {
    let mut rings: Vec<Vec<[f64; 2]>> = Vec::new();
    for b in voids {
        let (r, _) = cut_mesh(&b.positions, &b.indices, base, u);
        for poly in rings_to_polygons(&r) {
            rings.push(if poly.len() > 1 { keyhole(&poly).0 } else { poly[0].clone() });
        }
    }
    rings.retain(|r| r.len() >= 3);
    if rings.is_empty() {
        return cuts;
    }
    subtract_rings_from_cuts(cuts, &rings)
}

/// Zieht `rings` von jeder Schnittfläche ab (Ränder auf den Schnittkanten ohne Strich); Fehlschlag ⇒ unverändert.
fn subtract_rings_from_cuts(cuts: Vec<Cut>, rings: &[Vec<[f64; 2]>]) -> Vec<Cut> {
    let refs: Vec<&[[f64; 2]]> = rings.iter().map(|r| r.as_slice()).collect();
    let cutters = encode_rings(&refs);
    let mut out = Vec::with_capacity(cuts.len());
    for cp in cuts {
        if cp.pts.len() < 3 {
            out.push(cp);
            continue;
        }
        let ring = &encode_rings(&[cp.pts.as_slice()])[1..];
        let nse = cp.nse.as_deref().unwrap_or(&[]);
        let mut ns = vec![nse.len() as f64];
        ns.extend(nse);
        let f = crate::voids::subtract_rings_flat(ring, &cutters, &ns);
        if f.is_empty() || f[0] < 0.0 {
            out.push(cp);
            continue;
        }
        let mut i = 1;
        for _ in 0..f[0] as usize {
            let n = f[i] as usize;
            i += 1;
            let pts: Vec<[f64; 2]> = (0..n).map(|j| [f[i + 2 * j], f[i + 2 * j + 1]]).collect();
            i += 2 * n;
            let m = f[i] as usize;
            i += 1;
            let nse: Vec<f64> = f[i..i + m].to_vec();
            i += m;
            out.push(Cut { pts, nse: (!nse.is_empty()).then_some(nse), ..cp.clone() });
        }
    }
    out
}

/// [95] Taschen der Taschen-Schiebetüren aus den geschnittenen Wandschichten aussparen (Hohlraum samt
/// Blattbahn über die Türhöhe, wie im 3D-Körper).
fn subtract_pockets_in_section(cuts: Vec<Cut>, p: &Project, base: (f64, f64), u: (f64, f64)) -> Vec<Cut> {
    let by_wall = p.openings_by_wall();
    let mut rects: Vec<Vec<[f64; 2]>> = Vec::new();
    for w in &p.walls {
        let Some(ops) = by_wall.get(w.id.as_str()) else { continue };
        let arc = crate::wall_arc::WallArc::of_wall(w);
        let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
        let l = hypot2(dx, dy);
        if !(l > 1e-9) {
            continue;
        }
        let (ux, uy) = (dx / l, dy / l);
        for [u0, u1, n0, n1, z0, z1] in model3d::wall_pocket_cuts(p, w, ops) {
            // Grundriss der Tasche; Bogenwand ([T2]): Ring entlang des Bogens (Achsmass = Bogenlänge).
            let ring: Vec<[f64; 2]> = match arc {
                Some(a) => {
                    let st = a.stations(u0, u1, a.r_max(n0, n1));
                    let side = |n: f64| st.iter().map(move |&s| a.point(s, n)).map(|q| [q.x, q.y]);
                    side(n0).chain(side(n1).rev()).collect()
                }
                None => {
                    let at = |a: f64, n: f64| [w.start.x + ux * a - uy * n, w.start.y + uy * a + ux * n];
                    vec![at(u0, n0), at(u1, n0), at(u1, n1), at(u0, n1)]
                }
            };
            let mut pts = vec![ring.len() as f64];
            for q in ring {
                pts.extend(q);
            }
            let f = crate::voids::section_rects_flat(&pts, &[base.0, base.1, u.0, u.1]);
            for k in 0..f.first().copied().unwrap_or(0.0) as usize {
                let (a, b) = (f[1 + 2 * k], f[2 + 2 * k]);
                rects.push(vec![[a, z0], [b, z0], [b, z1], [a, z1]]);
            }
        }
    }
    if rects.is_empty() {
        return cuts;
    }
    let refs: Vec<&[[f64; 2]]> = rects.iter().map(|r| r.as_slice()).collect();
    let cutters = encode_rings(&refs);
    let mut out = Vec::with_capacity(cuts.len());
    for cp in cuts {
        if cp.pts.len() < 3 || cp.kind != Kind::Wall {
            out.push(cp);
            continue;
        }
        let ring = &encode_rings(&[cp.pts.as_slice()])[1..];
        let nse = cp.nse.as_deref().unwrap_or(&[]);
        let mut ns = vec![nse.len() as f64];
        ns.extend(nse);
        let f = crate::voids::subtract_rings_flat(ring, &cutters, &ns);
        if f.is_empty() || f[0] < 0.0 {
            out.push(cp);
            continue;
        }
        let mut i = 1;
        for _ in 0..f[0] as usize {
            let n = f[i] as usize;
            i += 1;
            let pts: Vec<[f64; 2]> = (0..n).map(|j| [f[i + 2 * j], f[i + 2 * j + 1]]).collect();
            i += 2 * n;
            let m = f[i] as usize;
            i += 1;
            let nse: Vec<f64> = f[i..i + m].to_vec();
            i += m;
            out.push(Cut { pts, nse: (!nse.is_empty()).then_some(nse), ..cp.clone() });
        }
    }
    out
}

/// Liest `[n, (k, u, v …) × n]` ab `i`.
fn read_rings(f: &[f64], i: &mut usize) -> Vec<Vec<[f64; 2]>> {
    let mut out = Vec::new();
    let n = f[*i] as usize;
    *i += 1;
    for _ in 0..n {
        let k = f[*i] as usize;
        *i += 1;
        out.push((0..k).map(|j| [f[*i + 2 * j], f[*i + 2 * j + 1]]).collect());
        *i += 2 * k;
    }
    out
}

/// `cutMeshWithPlane` (senkrecht): (Ringe, Linienzüge).
fn cut_mesh(positions: &[f64], indices: &[f64], base: (f64, f64), u: (f64, f64)) -> (Vec<Vec<[f64; 2]>>, Vec<Vec<[f64; 2]>>) {
    let f = crate::mesh_section::cut(positions, indices, &[0.0, base.0, base.1, u.0, u.1]);
    if f.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let mut i = 0;
    let rings = read_rings(&f, &mut i);
    let lines = read_rings(&f, &mut i);
    (rings, lines)
}

/// `ringsToPolygons`.
fn rings_to_polygons(rings: &[Vec<[f64; 2]>]) -> Vec<Vec<Vec<[f64; 2]>>> {
    let refs: Vec<&[[f64; 2]]> = rings.iter().map(|r| r.as_slice()).collect();
    let f = crate::mesh_section::rings_to_polygons(&encode_rings(&refs));
    if f.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 1;
    for _ in 0..f[0] as usize {
        let nr = f[i] as usize;
        i += 1;
        let mut set = Vec::with_capacity(nr);
        for _ in 0..nr {
            let count = f[i] as usize;
            i += 1;
            set.push((0..count).map(|j| [f[i + 2 * j], f[i + 2 * j + 1]]).collect());
            i += 2 * count;
        }
        out.push(set);
    }
    out
}

/// `keyhole` (Rechnung: `voids::keyhole_flat`).
fn keyhole(poly: &[Vec<[f64; 2]>]) -> (Vec<[f64; 2]>, Vec<f64>) {
    let refs: Vec<&[[f64; 2]]> = poly.iter().map(|r| r.as_slice()).collect();
    let f = crate::voids::keyhole_flat(&encode_rings(&refs));
    let n = f.first().copied().unwrap_or(0.0) as usize;
    let pts = (0..n).map(|i| [f[1 + 2 * i], f[2 + 2 * i]]).collect();
    let nb = f.get(1 + 2 * n).copied().unwrap_or(0.0) as usize;
    let bridges = (0..nb).map(|i| f[2 + 2 * n + i]).collect();
    (pts, bridges)
}

/// `appendBodySections` + `attachBodyOwners`: geschnittene freie Körper.
fn append_body_sections(cuts: &mut Vec<Cut>, p: &Project, bodies: &[&BodyMesh], base: (f64, f64), u: (f64, f64)) {
    let solids = p.extruded_solids.as_deref().unwrap_or(&[]);
    for b in bodies {
        let (rings, _) = cut_mesh(&b.positions, &b.indices, base, u);
        for poly in rings_to_polygons(&rings) {
            let (pts, nse) = if poly.len() > 1 {
                let (pts, bridges) = keyhole(&poly);
                let n = pts.len() as f64;
                (pts, Some(bridges.into_iter().filter(|&i| i < n).collect()))
            } else {
                (poly[0].clone(), None)
            };
            let mut c = Cut::new(Kind::Body, b.index, pts);
            c.fill = Some(BODY_FILL.into());
            c.nse = nse;
            c.source_id = solids.get(b.index).map(|s| s.id.clone());
            cuts.push(c);
        }
    }
}

/// `clipLineToU`.
fn clip_line_to_u(pts: &[[f64; 2]], lo: f64, hi: f64) -> Vec<Vec<[f64; 2]>> {
    let mut out = Vec::new();
    let mut cur: Vec<[f64; 2]> = Vec::new();
    fn flush(cur: &mut Vec<[f64; 2]>, out: &mut Vec<Vec<[f64; 2]>>) {
        if cur.len() >= 2 {
            out.push(std::mem::take(cur));
        }
        cur.clear();
    }
    for i in 0..pts.len().saturating_sub(1) {
        let a = pts[i];
        let b = pts[i + 1];
        let (u0, u1) = (a[0], b[0]);
        if (u0 < lo && u1 < lo) || (u0 > hi && u1 > hi) {
            flush(&mut cur, &mut out);
            continue;
        }
        let at = |u: f64| -> [f64; 2] {
            let t = if u1 == u0 { 0.0 } else { (u - u0) / (u1 - u0) };
            [u, a[1] + (b[1] - a[1]) * t]
        };
        let pa = if u0 < lo { at(lo) } else if u0 > hi { at(hi) } else { a };
        let pb = if u1 < lo { at(lo) } else if u1 > hi { at(hi) } else { b };
        if cur.is_empty() {
            cur.push(pa);
        }
        cur.push(pb);
        if u1 < lo || u1 > hi {
            flush(&mut cur, &mut out);
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// `appendTerrainProfiles`.
fn append_terrain_profiles(out: &mut Output, p: &Project, base: (f64, f64), u: (f64, f64)) {
    let terrains: Vec<&TerrainMesh> = p.context.as_deref().unwrap_or(&[]).iter().filter_map(|c| if let ContextObject::TerrainMesh(t) = c { Some(t) } else { None }).collect();
    if terrains.is_empty() {
        return;
    }
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for cp in &out.cuts {
        for q in &cp.pts {
            lo = min(lo, q[0]);
            hi = max(hi, q[0]);
        }
    }
    for e in out.visible.iter().chain(out.hidden.iter()) {
        lo = min(min(lo, e.a[0]), e.b[0]);
        hi = max(max(hi, e.a[0]), e.b[0]);
    }
    let range = lo.is_finite().then_some((lo, hi));
    for t in terrains {
        // [137] Einzeln ausgeblendetes Gelände.
        if t.positions.len() < 9 || t.hidden == Some(true) {
            continue;
        }
        out.terrain_id.get_or_insert_with(|| t.id.clone());
        // [T6] Gelände samt Baugruben, Höhen im Modellbezug; das gewachsene Terrain gestrichelt dazu.
        let st = crate::excavation::site_terrain(p, t);
        let mut meshes = vec![(st.current().to_flat(-st.datum), false)];
        if st.modified.is_some() {
            meshes.push((st.orig.to_flat(-st.datum), true));
        }
        for ((pos, idx), natural) in meshes {
            let (_, lines) = cut_mesh(&pos, &idx, base, u);
            for line in lines {
                let parts = match range {
                    Some((lo, hi)) => clip_line_to_u(&line, lo - TERRAIN_MARGIN, hi + TERRAIN_MARGIN),
                    None => vec![line],
                };
                for pts in parts {
                    out.profiles.push(Profile { category: t.category_code.clone(), pts, natural });
                }
            }
        }
    }
    append_earth(out, p, base, u);
}

/// Tiefe des Erdreich-Bands unter der Geländelinie (m), wenn das Gelände keine `earthDepth` trägt.
const EARTH_BAND: f64 = 1.5;

/// Tiefe des Erdreich-Bands: `earthDepth` des ersten Geländes, das eine positive Tiefe setzt.
fn earth_band(p: &Project) -> f64 {
    crate::excavation::terrains(p).iter().find_map(|t| t.earth_depth.filter(|d| d.is_finite() && *d > 0.0)).unwrap_or(EARTH_BAND)
}

/// [T6]/[109] Erdreich: Band unter dem gestalteten Terrain mit SIA-Erdreich-Schraffur, ohne das
/// Gebäude-Innere (Grundfläche im Schnitt, von der tiefsten Schnittfläche aufwärts); die geschnittenen
/// Bauteile selbst liegen ohnehin darüber.
fn append_earth(out: &mut Output, p: &Project, base: (f64, f64), u: (f64, f64)) {
    let depth = earth_band(p);
    let mut band: Vec<crate::flat::Polygon> = Vec::new();
    for pr in out.profiles.iter().filter(|pr| !pr.natural && pr.pts.len() >= 2) {
        let mut ring = pr.pts.clone();
        ring.extend(pr.pts.iter().rev().map(|q| [q[0], q[1] - depth]));
        band.push(vec![ring]);
    }
    if band.is_empty() {
        return;
    }
    let mut band = crate::polygon_bool::union(&band);
    // Gebäude-Inneres: Abschnitte der Schnittlinie in der Grundfläche.
    let mut holes: Vec<crate::flat::Polygon> = Vec::new();
    for poly in crate::site_rules::building_footprint(p) {
        let mut ts: Vec<f64> = Vec::new();
        for ring in &poly {
            let n = ring.len();
            for i in 0..n {
                let (a, b) = (ring[i], ring[(i + 1) % n]);
                // Schnitt der Geraden base + s·u mit der Kante a–b.
                let (ex, ey) = (b.x - a.x, b.y - a.y);
                let den = u.0 * ey - u.1 * ex;
                if den.abs() < 1e-12 {
                    continue;
                }
                let (wx, wy) = (a.x - base.0, a.y - base.1);
                let s_ = (wx * ey - wy * ex) / den;
                let t_ = (wx * u.1 - wy * u.0) / den;
                if (0.0..1.0).contains(&t_) {
                    ts.push(s_);
                }
            }
        }
        ts.sort_by(|a, b| a.total_cmp(b));
        for w in ts.chunks_exact(2) {
            let (u0, u1) = (w[0], w[1]);
            let low = out.cuts.iter().flat_map(|c| c.pts.iter()).filter(|q| q[0] >= u0 - 1e-6 && q[0] <= u1 + 1e-6).map(|q| q[1]).fold(f64::INFINITY, f64::min);
            if low.is_finite() {
                holes.push(vec![vec![[u0, low], [u1, low], [u1, 1e4], [u0, 1e4]]]);
            }
        }
    }
    if !holes.is_empty() {
        band = crate::polygon_bool::difference(&band, &holes);
    }
    let hatch = super::style::resolve_hatch(p, "std-h-erdreich", None, None, None)
        .unwrap_or(HatchRender { pattern: HatchPattern::Earth, scale: 1.0, angle: 45.0, color: HATCH_INK.into(), line_weight: 0.1, ..no_hatch_base() });
    for poly in band {
        if let Some(outer) = poly.into_iter().next() {
            if outer.len() >= 3 {
                out.earth.push((outer, hatch.clone()));
            }
        }
    }
}

/// Ansichtsbereich ([36]): Flächen der Eigentümer weglassen, deren nächster Punkt (Tiefe `q[2]` hinter
/// der Ebene) weiter als `depth` liegt. Ein Bauteil zählt als Ganzes: was in den Bereich hineinragt,
/// bleibt vollständig.
fn drop_far_owners(faces: Vec<crate::hlr::Face>, owners: usize, depth: f64) -> Vec<crate::hlr::Face> {
    let mut near = vec![f64::INFINITY; owners];
    for f in &faces {
        if let Some(m) = near.get_mut(f.owner as usize) {
            *m = f.pts.iter().fold(*m, |m, q| m.min(q[2]));
        }
    }
    faces.into_iter().filter(|f| near.get(f.owner as usize).is_none_or(|&m| m <= depth + 1e-6)).collect()
}

// ── Schnitt ───────────────────────────────────────────────────────────────────

/// Viereck aus dem Dreieck `t` und dem folgenden Dreieck `next`, wenn beide dieselbe Normale haben und
/// genau eine Kante teilen (die gemeinsame Diagonale entfällt).
fn quad_of(t: &[[f64; 3]; 3], n: [f64; 3], next: &[u32], vert: &dyn Fn(u32) -> ([f64; 3], [f64; 3])) -> Option<[[f64; 3]; 4]> {
    let (p0, n0) = vert(next[0]);
    if n0 != n {
        return None;
    }
    let u = [p0, vert(next[1]).0, vert(next[2]).0];
    let shared: Vec<usize> = (0..3).filter(|&i| u.contains(&t[i])).collect();
    let extra = u.iter().find(|q| !t.contains(q))?;
    if shared.len() != 2 {
        return None;
    }
    // Gemeinsame Kante (i, i+1) im Umlauf von t: das neue Eck dazwischen einsetzen.
    let i = if shared == [0, 1] { 0 } else if shared == [1, 2] { 1 } else { 2 };
    let mut q = [[0.0; 3]; 4];
    for (k, slot) in q.iter_mut().enumerate() {
        *slot = match k.cmp(&(i + 1)) {
            std::cmp::Ordering::Less => t[k],
            std::cmp::Ordering::Equal => *extra,
            std::cmp::Ordering::Greater => t[k - 1],
        };
    }
    Some(q)
}

/// Ansichtskanten hinter der Schnittebene mit exakter Sichtbarkeit ([G4], `hlr.rs`; verdeckte nur mit
/// `hidden`, wie `hiddenLines` der Ebene): die Körper als
/// Dreiecke (Wände samt Gehrung und Löchern wie im 3D-Modell, Platten, Treppen, Dächer, Körper),
/// auf die Seite hinter der Ebene zugeschnitten; die Schnittflächen verdecken in Tiefe 0. Bogenwände,
/// verschnittene Dächer und Körper glätten ihre Facetten (keine Fugen, nur Knicke und Silhouetten).
fn projection_edges(p: &Project, plane: &Plane, walls_r: &[RWall], wi: &[render3d::WallInput], slabs_r: &[RSlab], bodies: &[&BodyMesh], cuts: &[Cut], hidden: bool, max_depth: Option<f64>) -> (Vec<Edge>, Vec<Edge>) {
    use crate::hlr;
    let nl = crate::jsmath::hypot(&plane.normal);
    if !(nl > 1e-12) {
        return (Vec::new(), Vec::new());
    }
    let n = [plane.normal[0] / nl, plane.normal[1] / nl, plane.normal[2] / nl];
    let ul = hypot2(n[2], n[0]);
    let u = if ul > 1e-12 { [n[2] / ul, 0.0, -n[0] / ul] } else { [1.0, 0.0, 0.0] };
    let o = plane.point;
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let view = |w: [f64; 3]| {
        let r = [w[0] - o[0], w[1] - o[1], w[2] - o[2]];
        [dot(r, u), w[1], dot(r, n)]
    };
    let mut faces: Vec<hlr::Face> = Vec::new();
    let mut owners: Vec<(Kind, usize)> = Vec::new();
    // Fläche (Welt, Y oben) hinter die Ebene zuschneiden und anhängen.
    let mut push = |faces: &mut Vec<hlr::Face>, world: &[[f64; 3]], normal: [f64; 3], owner: u32, smooth: u32, two_sided: bool| {
        let pts: Vec<[f64; 3]> = world.iter().map(|&w| view(w)).collect();
        if pts.iter().all(|q| q[2] <= 0.0) {
            return;
        }
        let Some((pts, no_edge)) = hlr::clip_front(&pts) else { return };
        let mut f = hlr::Face::new(pts, [dot(normal, u), normal[1], dot(normal, n)], owner);
        f.no_edge = no_edge;
        f.smooth = smooth;
        f.two_sided = two_sided;
        faces.push(f);
    };
    let tri_normal = |t: &[[f64; 3]; 3]| {
        let (a, b) = ([t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]], [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]]);
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    };
    // render3d-Netz (Welt, f32; Normale je Ecke).
    let mesh_faces = |faces: &mut Vec<hlr::Face>, m: &render3d::Mesh, range: std::ops::Range<usize>, owner: u32, smooth: u32| {
        let vert = |i: u32| {
            let j = i as usize * render3d::FLOATS_PER_VERTEX;
            let v = &m.verts[j..j + 6];
            ([v[0] as f64, v[1] as f64, v[2] as f64], [v[3] as f64, v[4] as f64, v[5] as f64])
        };
        // Zwei aufeinanderfolgende Dreiecke einer Ebene mit gemeinsamer Kante (ein Viereck) als eine Fläche.
        let tris: Vec<&[u32]> = m.indices[range].chunks_exact(3).collect();
        let mut k = 0;
        while k < tris.len() {
            let (a, na) = vert(tris[k][0]);
            let t = [a, vert(tris[k][1]).0, vert(tris[k][2]).0];
            if let Some(q) = tris.get(k + 1).and_then(|n| quad_of(&t, na, n, &vert)) {
                push(faces, &q, na, owner, smooth, false);
                k += 2;
                continue;
            }
            push(faces, &t, na, owner, smooth, false);
            k += 1;
        }
    };
    // Wände: Bogen-Teilkörper derselben Wand bilden eine Glättungsgruppe.
    let wall_of = wall_owners(p, walls_r);
    let (wmesh, ends) = render3d::mesh::build_walls_mesh_owned(wi);
    let mut start = 0;
    for (i, &end) in ends.iter().enumerate() {
        let arc = wall_of.get(i).copied().flatten().filter(|w| crate::wall_arc::WallArc::of_wall(w).is_some());
        let smooth = arc.and_then(|w| p.walls.iter().position(|x| std::ptr::eq(x, w))).map_or(0, |k| k as u32 + 1);
        owners.push((Kind::Wall, i));
        mesh_faces(&mut faces, &wmesh, start..end, owners.len() as u32 - 1, smooth);
        start = end;
    }
    // Platten und Treppenstufen: Prismen (Deckel, Boden, Seiten) direkt aus dem Umriss.
    for (i, s) in slabs_r.iter().enumerate() {
        owners.push((Kind::Slab, i));
        let owner = owners.len() as u32 - 1;
        let (o, n) = (&s.outline, s.outline.len());
        let (y0, y1) = (s.z_bottom.min(s.z_top), s.z_bottom.max(s.z_top));
        if n < 3 || y1 - y0 < 1e-6 {
            continue;
        }
        let area: f64 = (0..n).map(|k| o[k][0] * o[(k + 1) % n][1] - o[(k + 1) % n][0] * o[k][1]).sum();
        let sign = if area >= 0.0 { 1.0 } else { -1.0 };
        let top: Vec<[f64; 3]> = o.iter().map(|q| [q[0], y1, q[1]]).collect();
        let bottom: Vec<[f64; 3]> = o.iter().rev().map(|q| [q[0], y0, q[1]]).collect();
        push(&mut faces, &top, [0.0, 1.0, 0.0], owner, 0, false);
        push(&mut faces, &bottom, [0.0, -1.0, 0.0], owner, 0, false);
        for k in 0..n {
            let (a, b) = (o[k], o[(k + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            if dx.abs() + dy.abs() < 1e-12 {
                continue;
            }
            let side = [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]];
            push(&mut faces, &side, [dy * sign, 0.0, -dx * sign], owner, 0, false);
        }
    }
    let mut group = p.walls.len() as u32 + 1;
    // Modell [x, y, Höhe] → Welt [x, Höhe, y].
    let model_tris = |faces: &mut Vec<hlr::Face>, pos: &[f64], idx: &mut dyn Iterator<Item = usize>, owner: u32, smooth: u32, push: &mut dyn FnMut(&mut Vec<hlr::Face>, &[[f64; 3]], [f64; 3], u32, u32, bool)| {
        let q = |i: usize| -> Option<[f64; 3]> { Some([*pos.get(3 * i)?, *pos.get(3 * i + 2)?, *pos.get(3 * i + 1)?]) };
        while let (Some(a), Some(b), Some(c)) = (idx.next(), idx.next(), idx.next()) {
            let (Some(a), Some(b), Some(c)) = (q(a), q(b), q(c)) else { continue };
            let t = [a, b, c];
            // Spiegelung durch den Achsentausch: Umlauf umkehren, damit die Normale aussen bleibt.
            let m = tri_normal(&t);
            push(faces, &t, [-m[0], -m[1], -m[2]], owner, smooth, false);
        }
    };
    for (ri, roof) in p.roofs.as_deref().unwrap_or(&[]).iter().enumerate() {
        owners.push((Kind::Roof, ri));
        let owner = owners.len() as u32 - 1;
        if let Some(solids) = crate::roof_assembly::roof_solids(p, ri) {
            model_tris(&mut faces, &solids.skin.positions, &mut solids.skin.indices.iter().map(|&i| i as usize), owner, 0, &mut push);
            continue;
        }
        // Dachhaut ohne Dicke: beidseitig.
        let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
        // Stirnflächen der Ränder ([132]): Flachdächer zeigen sonst hinter dem Schnitt nur eine Linie.
        let total: f64 = p.roof_layers(roof).iter().map(|l| l.thickness.max(0.0)).sum();
        let fascia: Vec<Vec<[f64; 3]>> = super::elevation::fascia_quads(&g.planes, total).into_iter().map(|q| q.to_vec()).collect();
        for poly in g.planes.iter().chain(&g.gables).chain(&fascia) {
            let w: Vec<[f64; 3]> = poly.iter().map(|q| [q[0], q[2], q[1]]).collect();
            if w.len() >= 3 {
                push(&mut faces, &w, [0.0; 3], owner, 0, true);
            }
        }
    }
    for b in bodies {
        owners.push((Kind::Body, b.index));
        let owner = owners.len() as u32 - 1;
        let mut idx = b.indices.iter().filter(|&&i| i >= 0.0 && i.fract() == 0.0).map(|&i| i as usize);
        model_tris(&mut faces, &b.positions, &mut idx, owner, group, &mut push);
        group += 1;
    }
    // Ansichtsbereich ([36]): Bauteile, deren nächster Punkt weiter als `max_depth` hinter der Ebene
    // liegt, entfallen ganz (auch als Verdecker — sie liegen ohnehin hinter allem Gezeigten).
    if let Some(d) = max_depth.filter(|d| *d > 0.0) {
        faces = drop_far_owners(faces, owners.len(), d);
    }
    // Schnittflächen (Tiefe 0) verdecken nur.
    for c in cuts {
        if c.pts.len() >= 3 {
            let mut f = hlr::Face::new(c.pts.iter().map(|q| [q[0], q[1], 0.0]).collect(), [0.0, 0.0, -1.0], 0);
            f.edges = false;
            faces.push(f);
        }
    }
    let opts = hlr::Opts { tol: 1e-4, depth_eps: 1e-4, hidden, ..hlr::Opts::default() };
    let (mut visible, mut hidden) = (Vec::new(), Vec::new());
    for sg in hlr::hidden_lines(&faces, &opts) {
        let (kind, index) = owners[sg.owner as usize];
        let e = Edge { kind, index, a: sg.a, b: sg.b };
        if sg.hidden {
            hidden.push(e);
        } else {
            visible.push(e);
        }
    }
    (visible, hidden)
}

/// `computeSection` (ohne den asynchronen Teil: die Körper-Netze kommen fertig aus TS).
pub fn compute_section(p: &Project, level: &LevelSpec, bodies: &[BodyMesh]) -> Result<Option<Output>, String> {
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
    // Projektion hinter der Ebene exakt ([G4]); die Schnittflächen verdecken, was hinter ihnen liegt.
    let (mut visible, hidden) = projection_edges(p, &plane, &walls_r, &wi, &slabs_r, &bodies, &cuts, level.hidden_lines, level.depth);
    shaped_projection(&mut visible, p, &walls_r, &plane);
    let mut out = Output { cuts, visible, hidden, profiles: Vec::new(), earth: Vec::new(), terrain_id: None };
    append_terrain_profiles(&mut out, p, base, u);
    Ok(Some(out))
}

// ── Primitive ─────────────────────────────────────────────────────────────────

pub(crate) fn polygon(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, hatch: HatchRender) -> Primitive {
    Primitive::Polygon {
        pts,
        fill: fill.into(),
        stroke: stroke.into(),
        stroke_width_mm: w,
        hatch,
        greyed: None,
        opacity: None,
        no_stroke_edges: None,
        wall_id: None,
        drawing_id: None,
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

pub(crate) fn line(a: Vec2, b: Vec2, cls: &str, w: f64, color: &str) -> Primitive {
    Primitive::Line { a, b, cls: cls.into(), weight_mm: w, dash: None, zigzag: None, motif: None, color: Some(color.into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None }
}

pub(crate) fn v2(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Ausmass wie `acc` in TS (`<`/`>`-Vergleiche, NaN bleibt draussen).
#[derive(Clone, Copy)]
pub(crate) struct Acc {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Acc {
    pub fn new() -> Acc {
        Acc { min_x: f64::INFINITY, min_y: f64::INFINITY, max_x: f64::NEG_INFINITY, max_y: f64::NEG_INFINITY }
    }
    pub fn add(&mut self, x: f64, y: f64) {
        if x < self.min_x {
            self.min_x = x;
        }
        if y < self.min_y {
            self.min_y = y;
        }
        if x > self.max_x {
            self.max_x = x;
        }
        if y > self.max_y {
            self.max_y = y;
        }
    }
    pub fn bounds(&self) -> [f64; 4] {
        if !self.min_x.is_finite() {
            [0.0, 0.0, 1.0, 1.0]
        } else {
            [self.min_x, self.min_y, self.max_x, self.max_y]
        }
    }
}

fn ring_len(r: &[[f64; 2]]) -> f64 {
    (0..r.len()).map(|i| { let (a, b) = (r[i], r[(i + 1) % r.len()]); hypot2(b[0] - a[0], b[1] - a[1]) }).sum()
}

fn ring_area(r: &[[f64; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..r.len() {
        let (p, q) = (r[i], r[(i + 1) % r.len()]);
        a += p[0] * q[1] - q[0] * p[1];
    }
    (a / 2.0).abs()
}

fn ring_bbox(r: &[[f64; 2]]) -> [f64; 4] {
    r.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])])
}

/// [140] Dämmschichten (Dämmschlange, Zickzack, Welle) unter der gemeinsamen Schwelle (`style::is_thin_layer`, 0.5 mm Papier) ab 1:75
/// ohne Muster (nur Füllung und feine Fuge): die Schlange einer 3–4 cm Trittschalldämmung wäre in 1:100 ein
/// dichter Zickzack-Balken. 1:50 (und `scale` 0) zeichnet sie immer.
pub fn plain_thin_insulation(mut cuts: Vec<Cut>, scale: f64) -> Vec<Cut> {
    if !simplify_thin_layers(Detail::Mittel, scale) {
        return cuts;
    }
    for c in &mut cuts {
        let Some(h) = c.hatch.as_mut() else { continue };
        if !matches!(h.pattern, HatchPattern::Insulation | HatchPattern::InsulationHard | HatchPattern::InsulationWave) || h.kind.is_some() {
            continue;
        }
        let half = ring_len(&c.pts) / 2.0;
        let thick = if half > 0.0 { ring_area(&c.pts) / half } else { 0.0 };
        if is_thin_layer(thick, scale) {
            h.pattern = HatchPattern::None;
        }
    }
    cuts
}

/// [140] Dünne Schnitt-Schichten (Putz, Parkett, Trittschall, Folien) bei 1:`scale` zusammenfassen: eine Schicht
/// unter 0.5 mm Papierdicke (`style::is_thin_layer`; Dicke ≈ Fläche / halber Umfang) übernimmt Füllung und
/// Schraffur der dickeren Nachbarschicht desselben Bauteils, mit der sie die längste Kante teilt, und wird mit
/// ihr zu einer Fläche vereinigt (keine Fuge dazwischen). Unter 1:75 (oder `scale` 0) unverändert.
pub fn merge_thin_cuts(cuts: &[Cut], scale: f64) -> Vec<Cut> {
    if !simplify_thin_layers(Detail::Mittel, scale) {
        return cuts.to_vec();
    }
    let n = cuts.len();
    let mergeable = |c: &Cut| matches!(c.kind, Kind::Wall | Kind::Slab | Kind::Roof) && c.stair_id.is_none() && c.pts.len() >= 3;
    let thick: Vec<f64> = cuts.iter().map(|c| { let half = ring_len(&c.pts) / 2.0; if half > 0.0 { ring_area(&c.pts) / half } else { 0.0 } }).collect();
    let thin: Vec<bool> = (0..n).map(|i| mergeable(&cuts[i]) && thick[i] > 0.0 && is_thin_layer(thick[i], scale)).collect();
    if !thin.iter().any(|t| *t) {
        return cuts.to_vec();
    }
    let bbox: Vec<[f64; 4]> = cuts.iter().map(|c| ring_bbox(&c.pts)).collect();
    // [33] Nur Schichten mit gleichem Override (eine weisse Schicht geht nicht in der schwarzen auf).
    let same_part = |a: &Cut, b: &Cut| a.kind == b.kind && a.index == b.index && a.source_id == b.source_id && a.ov == b.ov;
    let touch = |i: usize, j: usize| {
        let (a, b) = (bbox[i], bbox[j]);
        a[0] <= b[2] + 1e-4 && b[0] <= a[2] + 1e-4 && a[1] <= b[3] + 1e-4 && b[1] <= a[3] + 1e-4
    };
    // Gemeinsame Kantenlänge zweier Flächen über die Vereinigung (0, wenn sie nicht zu einer Fläche verschmelzen).
    let shared = |i: usize, j: usize| -> f64 {
        let u = crate::polygon_bool::union(&[vec![cuts[i].pts.clone()], vec![cuts[j].pts.clone()]]);
        if u.len() != 1 || u[0].len() != 1 {
            return 0.0;
        }
        (ring_len(&cuts[i].pts) + ring_len(&cuts[j].pts) - ring_len(&u[0][0])) / 2.0
    };
    // Ziel je Fläche; dünne Ketten (dünn an dünn an dick) in wenigen Durchgängen.
    let mut target: Vec<Option<usize>> = (0..n).map(|i| (!thin[i]).then_some(i)).collect();
    for _ in 0..3 {
        let mut changed = false;
        let open: Vec<usize> = (0..n).filter(|&i| thin[i] && target[i].is_none()).collect();
        for i in open {
            let best = (0..n)
                .filter(|&j| j != i && target[j].is_some() && mergeable(&cuts[j]) && same_part(&cuts[i], &cuts[j]) && touch(i, j))
                .map(|j| (j, shared(i, j)))
                .filter(|(_, l)| *l > 1e-4)
                // Längste gemeinsame Kante; bei gleicher Länge die dickere Schicht (wie `thin_layer_targets`).
                .max_by(|a, b| {
                    if (a.1 - b.1).abs() <= 1e-3 * a.1.max(b.1) {
                        thick[a.0].total_cmp(&thick[b.0])
                    } else {
                        a.1.total_cmp(&b.1)
                    }
                });
            if let Some((j, _)) = best {
                target[i] = target[j];
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut groups: Vec<Vec<usize>> = vec![Vec::new(); n];
    for i in 0..n {
        groups[target[i].unwrap_or(i)].push(i);
    }
    let mut out = Vec::with_capacity(n);
    for (t, g) in groups.into_iter().enumerate() {
        match g.len() {
            0 => {}
            1 => out.push(cuts[g[0]].clone()),
            _ => {
                let polys: Vec<crate::flat::Polygon> = g.iter().map(|&i| vec![cuts[i].pts.clone()]).collect();
                let u = crate::polygon_bool::union(&polys);
                if u.iter().all(|poly| poly.len() == 1) {
                    for poly in u {
                        out.push(Cut { pts: poly.into_iter().next().unwrap_or_default(), nse: None, ..cuts[t].clone() });
                    }
                } else {
                    // Löcher: Flächen einzeln lassen, nur den Stil der Zielschicht übernehmen.
                    for &i in &g {
                        out.push(Cut { fill: cuts[t].fill.clone(), hatch: cuts[t].hatch.clone(), ..cuts[i].clone() });
                    }
                }
            }
        }
    }
    out
}

/// [33] Schichten desselben Bauteils mit gleichem Override ohne Muster (Schraffur "none", z. B. „Deckenaufbau
/// weiss“) zu einer Fläche vereinigen: ein Umriss um den ganzen Aufbau, keine Fugen dazwischen. Flächen mit
/// Loch bleiben einzeln.
fn merge_override_groups(cuts: Vec<Cut>) -> Vec<Cut> {
    let plain = |c: &Cut| c.ov.as_ref().is_some_and(|o| o.hatch == HatchOv::None) && c.stair_id.is_none() && c.pts.len() >= 3;
    if !cuts.iter().any(plain) {
        return cuts;
    }
    // Gleiches Bauteil: Decken-Schichten sind je eine eigene Platte (eigener `index`), darum über `source_id`.
    let same = |a: &Cut, b: &Cut| a.kind == b.kind && a.source_id.is_some() && a.source_id == b.source_id && a.ov == b.ov;
    let n = cuts.len();
    let mut group: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        if !plain(&cuts[i]) || group[i].is_some() {
            continue;
        }
        group[i] = Some(i);
        for j in i + 1..n {
            if group[j].is_none() && plain(&cuts[j]) && same(&cuts[i], &cuts[j]) {
                group[j] = Some(i);
            }
        }
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        match group[i] {
            None => out.push(cuts[i].clone()),
            Some(g) if g != i => {}
            Some(_) => {
                let members: Vec<usize> = (i..n).filter(|&j| group[j] == Some(i)).collect();
                if members.len() == 1 {
                    out.push(cuts[i].clone());
                    continue;
                }
                let polys: Vec<crate::flat::Polygon> = members.iter().map(|&j| vec![cuts[j].pts.clone()]).collect();
                let u = crate::polygon_bool::union(&polys);
                if !u.is_empty() && u.iter().all(|poly| poly.len() == 1) {
                    for poly in u {
                        out.push(Cut { pts: poly.into_iter().next().unwrap_or_default(), nse: None, ..cuts[i].clone() });
                    }
                } else {
                    out.extend(members.iter().map(|&j| cuts[j].clone()));
                }
            }
        }
    }
    out
}

/// `generateSectionPlan`: Primitive (u → x, Höhe → y) und Ausmass.
pub fn section_primitives(out: &Output, mono: bool, hidden_lines: bool, vis: &Visibility) -> (Vec<Primitive>, [f64; 4]) {
    section_primitives_at(out, mono, hidden_lines, vis, 0.0, Detail::Mittel, false, &CutRules::default())
}

/// [140] Bauteile (ids) aus losen Schüttungen/Unterbau (`standards::is_loose_fill`: Kies, Magerbeton,
/// Erdreich …): im Schnitt ab 1:100 nicht schwarz.
pub fn loose_fill_components(p: &Project) -> HashSet<String> {
    p.components.iter().filter(|c| crate::standards::is_loose_fill(c)).map(|c| c.id.clone()).collect()
}

/// [140] Bleibt eine Schnittfläche ab 1:100 schraffiert? Schichten aus losen Schüttungen/Unterbau
/// (`loose`, Bauteil-ids) bzw. mit Schraffur Erdreich/Kies — sie tragen nicht und bilden keinen Raum.
fn loose_cut(cp: &Cut, loose: &HashSet<String>) -> bool {
    cp.component_id.as_deref().is_some_and(|id| loose.contains(id)) || cp.hatch.as_ref().is_some_and(|h| matches!(h.pattern, HatchPattern::Earth | HatchPattern::Gravel))
}

/// [`section_primitives`] beim Massstab 1:`scale` (dünne Schichten zusammengefasst, [`merge_thin_cuts`];
/// Detail „fein" zeigt alle Schichten, `style::simplify_thin_layers`). Ab 1:100 (`style::solid_cut`, ausser
/// `cut_hatch`/„fein") sind die geschnittenen Flächen schwarz ohne Fugen und Schraffur, nur mit dem Umriss —
/// ausser Schichten aus losen Schüttungen/Unterbau (`rules.loose`, s. [`loose_cut`]): die bleiben schraffiert.
/// [33] Overrides (`rules.ov`) haben Vorrang vor beidem: Füllung, Schraffur und Umriss der Regel.
#[allow(clippy::too_many_arguments)]
pub fn section_primitives_at(out: &Output, mono: bool, hidden_lines: bool, vis: &Visibility, scale: f64, detail: Detail, cut_hatch: bool, rules: &CutRules) -> (Vec<Primitive>, [f64; 4]) {
    let loose = &rules.loose;
    let black = solid_cut(detail, scale, cut_hatch);
    let thin_scale = if simplify_thin_layers(detail, scale) && !black { scale } else { 0.0 };
    let with_ov: Vec<Cut>;
    let cuts: &[Cut] = if rules.ov.is_empty() {
        &out.cuts
    } else {
        with_ov = out.cuts.iter().zip(rules.ov.iter().chain(std::iter::repeat(&None))).map(|(c, o)| Cut { ov: o.clone(), ..c.clone() }).collect();
        &with_ov
    };
    let merged = merge_override_groups(plain_thin_insulation(merge_thin_cuts(cuts, thin_scale), thin_scale));
    let mut prims = Vec::new();
    let mut acc = Acc::new();
    let shown = |code: &str| vis.visible(code) && vis.render(code);
    let mut cut_rings: Vec<crate::flat::Polygon> = Vec::new();
    let mut late_joints: Vec<Primitive> = Vec::new();
    // [T6] Erdreich zuerst (unter allem), ohne Umriss; Kategorie wie das Gelände.
    // [33] Regel für Gelände: Ausblenden, Füllung/Schraffur des Erdreichs, Linie der Geländelinie.
    let tov = rules.terrain.as_ref();
    let terrain_shown = out.profiles.iter().all(|pr| pr.category.as_deref().is_none_or(shown)) && !tov.is_some_and(|(a, _)| a.hidden());
    if terrain_shown {
        for (ring, hatch) in &out.earth {
            let hatch = match tov.and_then(|(_, l)| l.hatch.as_deref()) {
                Some("none") => no_hatch(),
                Some("material") | None => hatch.clone(),
                Some(_) => rules.terrain_hatch.clone().unwrap_or_else(|| hatch.clone()),
            };
            let hatch = if mono { HatchRender { color: SECTION_INK.into(), ..hatch } } else { hatch };
            let fill = tov.and_then(|(_, l)| l.fill_color.as_deref()).unwrap_or("none");
            let mut q = polygon(ring.iter().map(|q| v2(q[0], q[1])).collect(), fill, "none", 0.0, hatch);
            if let Primitive::Polygon { context_object_id, .. } = &mut q {
                *context_object_id = out.terrain_id.clone();
            }
            prims.push(q);
        }
    }
    for cp in &merged {
        if cp.pts.len() < 3 {
            continue;
        }
        if let Some(code) = cp.category.as_deref() {
            if !shown(code) {
                continue;
            }
        }
        let pts: Vec<Vec2> = cp
            .pts
            .iter()
            .map(|q| {
                acc.add(q[0], q[1]);
                v2(q[0], q[1])
            })
            .collect();
        let fill = cp.fill.as_deref().unwrap_or(HATCH_PAPER);
        let hatch = cp.hatch.clone().unwrap_or_else(section_hatch);
        let solid = hatch.pattern == HatchPattern::Solid;
        let ov = cp.ov.as_ref();
        // Ohne Override: schwarz ab 1:100 (ausser lose Schüttungen). Mit Override, der Füllung oder Schraffur
        // setzt, gilt die Regel ([33]); eine Regel, die nur den Umriss setzt, lässt die Fläche schwarz.
        let base_black = black && !loose_cut(cp, loose);
        let black = base_black && !ov.is_some_and(|o| o.styles());
        let (mut fill, mut hatch) = if black {
            (HATCH_INK.to_string(), no_hatch())
        } else if mono {
            let mono_fill = if solid { HATCH_INK } else { HATCH_PAPER };
            let mono_hatch = if !solid && hatch.pattern != HatchPattern::None { HatchRender { color: SECTION_INK.into(), ..hatch } } else { hatch };
            (mono_fill.to_string(), mono_hatch)
        } else {
            (fill.to_string(), hatch)
        };
        if let Some(o) = ov.filter(|o| o.styles()) {
            match &o.hatch {
                // Nur Füllung gesetzt: ab 1:100 (sonst schwarz) ohne Muster, sonst Muster wie gehabt.
                HatchOv::Keep if base_black => hatch = no_hatch(),
                HatchOv::Keep | HatchOv::Material => {}
                HatchOv::None => hatch = no_hatch(),
                HatchOv::Pattern(h) => hatch = if mono { HatchRender { color: SECTION_INK.into(), ..h.clone() } } else { h.clone() },
            }
            if let Some(f) = &o.fill {
                fill = f.clone();
            }
        }
        let outline = ov.and_then(|o| o.outline);
        let src = cp.source_id.clone();
        let stroked = if black { outline == Some(true) } else { outline != Some(false) };
        // [33] Linienstil aus einer Schicht-Regel: Fugen der Fläche als eigene Linien mit Strichmuster.
        let dash = ov.and_then(|o| o.dash.clone()).filter(|_| stroked);
        if let Some(d) = &dash {
            let n = cp.pts.len();
            let skip: Vec<usize> = cp.nse.iter().flatten().map(|x| *x as usize).collect();
            for i in (0..n).filter(|i| !skip.contains(i)) {
                let (a, b) = (cp.pts[i], cp.pts[(i + 1) % n]);
                let mut l = line(v2(a[0], a[1]), v2(b[0], b[1]), "section-joint", SECTION_JOINT_MM, SECTION_INK);
                if let Primitive::Line { dash: ld, .. } = &mut l {
                    *ld = Some(d.clone());
                }
                late_joints.push(l);
            }
        }
        let mut pr = if stroked && dash.is_none() { polygon(pts, &fill, SECTION_INK, SECTION_JOINT_MM, hatch) } else { polygon(pts, &fill, "none", 0.0, hatch) };
        if let Primitive::Polygon { wall_id, ceiling_id, roof_id, stair_id, extruded_solid_id, no_stroke_edges, greyed, .. } = &mut pr {
            *wall_id = if cp.kind == Kind::Wall { src.clone() } else { None };
            *ceiling_id = if cp.kind == Kind::Slab && cp.stair_id.is_none() { src.clone() } else { None };
            *roof_id = if cp.kind == Kind::Roof { src.clone() } else { None };
            *stair_id = cp.stair_id.clone();
            *extruded_solid_id = if cp.kind == Kind::Body { src } else { None };
            *no_stroke_edges = cp.nse.clone();
            *greyed = Some(cp.category.as_deref().is_some_and(|c| vis.greyed(c)));
        }
        cut_rings.push(vec![cp.pts.clone()]);
        prims.push(pr);
    }
    prims.append(&mut late_joints);
    // [140] Schnittkante: Umriss der vereinigten Schnittflächen schwer, Fugen dazwischen bleiben fein.
    for poly in crate::polygon_bool::union(&cut_rings) {
        for ring in &poly {
            for i in 0..ring.len() {
                let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
                prims.push(line(v2(a[0], a[1]), v2(b[0], b[1]), "section-cut-outline", SECTION_CUT_OUTLINE_MM, SECTION_INK));
            }
        }
    }
    for pr in &out.profiles {
        if let Some(code) = pr.category.as_deref() {
            if !shown(code) {
                continue;
            }
        }
        if !terrain_shown {
            continue;
        }
        for w in pr.pts.windows(2) {
            acc.add(w[0][0], w[0][1]);
            acc.add(w[1][0], w[1][1]);
            let mut l = line(v2(w[0][0], w[0][1]), v2(w[1][0], w[1][1]), "section-terrain", if pr.natural { SECTION_NATURAL_MM } else { SECTION_GROUND_MM }, SECTION_INK);
            if pr.natural {
                if let Primitive::Line { dash, .. } = &mut l {
                    *dash = Some(Some(SECTION_NATURAL_DASH.to_vec()));
                }
            }
            if let Some((a, _)) = tov.filter(|_| !pr.natural) {
                if let Primitive::Line { color, weight_mm, dash, .. } = &mut l {
                    if let Some(c) = &a.color {
                        *color = Some(c.clone());
                    }
                    if let Some(w) = a.lineweight.filter(|w| w.is_finite() && *w >= 0.0) {
                        *weight_mm = w;
                    }
                    if let Some(d) = &rules.terrain_dash {
                        *dash = Some(d.clone());
                    }
                }
            }
            prims.push(l);
        }
    }
    if hidden_lines {
        for e in &out.hidden {
            acc.add(e.a[0], e.a[1]);
            acc.add(e.b[0], e.b[1]);
            let mut l = line(v2(e.a[0], e.a[1]), v2(e.b[0], e.b[1]), "section-hidden", SECTION_HIDDEN_MM, SECTION_HIDDEN_INK);
            if let Primitive::Line { dash, .. } = &mut l {
                *dash = Some(Some(SECTION_HIDDEN_DASH.to_vec()));
            }
            prims.push(l);
        }
    }
    for e in &out.visible {
        acc.add(e.a[0], e.a[1]);
        acc.add(e.b[0], e.b[1]);
        prims.push(line(v2(e.a[0], e.a[1]), v2(e.b[0], e.b[1]), "section-visible", SECTION_VISIBLE_MM, SECTION_VISIBLE_INK));
    }
    // Mit Gelände ersetzt die Geländelinie die Grundlinie ([T6]).
    if acc.min_x.is_finite() && acc.max_x > acc.min_x && !(terrain_shown && !out.profiles.is_empty()) {
        prims.push(line(v2(acc.min_x, acc.min_y), v2(acc.max_x, acc.min_y), "section-ground", SECTION_GROUND_MM, SECTION_INK));
    }
    (prims, acc.bounds())
}

// ── Geschnittene Fenster/Türen (`sectionOpenings.ts`) ────────────────────────

const OPENING_INK: &str = "#1f242c";
const FRAME_MM: f64 = 0.25;
const GLASS_MM: f64 = super::style::GLASS_LINE_MM;
const DEFAULT_FRAME_DEPTH: f64 = 0.07;
const DEFAULT_FRAME_WIDTH: f64 = 0.06;
const DOOR_LEAF_THICKNESS: f64 = 0.04;
const MIN_CROSS: f64 = 0.15;
const LINTEL_FILL: &str = "#d4d7db";
const SHADING_PACK_FILL: &str = "#e6e8eb";

fn rect(u0: f64, u1: f64, v0: f64, v1: f64) -> Vec<Vec2> {
    vec![v2(min(u0, u1), v0), v2(max(u0, u1), v0), v2(max(u0, u1), v1), v2(min(u0, u1), v1)]
}

fn opening_poly(pts: Vec<Vec2>, profile: bool, id: &str) -> Primitive {
    let mut pr = if profile { polygon(pts, "#ffffff", OPENING_INK, FRAME_MM, no_hatch_base()) } else { polygon(pts, "none", "none", 0.0, no_hatch_base()) };
    if let Primitive::Polygon { opening_id, .. } = &mut pr {
        *opening_id = Some(id.into());
    }
    pr
}

struct CrossSection {
    n0: f64,
    un: f64,
    z_bottom: f64,
    z_top: f64,
    face_min: f64,
    face_max: f64,
    /// Formöffnung ([G3]): Umriss (Öffnungskoordinaten), Lage der Schnittstelle darin und Brüstungshöhe.
    shape: Option<(Vec<crate::opening_shape::P>, f64, f64)>,
}

impl CrossSection {
    fn u_at(&self, s: f64) -> f64 {
        (s - self.n0) / self.un
    }
}

fn axis_frame(w: &Wall) -> ((f64, f64), (f64, f64)) {
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let l = hypot2(dx, dy);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let u = (dx / l, dy / l);
    (u, (-u.1, u.0))
}

fn cross_section(p: &Project, wall: &Wall, o: &Opening, p0: (f64, f64), u: (f64, f64)) -> Result<Option<CrossSection>, String> {
    let Some((from, to)) = opening_interval(wall, o) else { return Ok(None) };
    let (a, n) = axis_frame(wall);
    let un = u.0 * n.0 + u.1 * n.1;
    if un.abs() < MIN_CROSS {
        return Ok(None);
    }
    let rel = (p0.0 - wall.start.x, p0.1 - wall.start.y);
    let n0 = rel.0 * n.0 + rel.1 * n.1;
    let a0 = rel.0 * a.0 + rel.1 * a.1;
    let ua = u.0 * a.0 + u.1 * a.1;
    let total = sum_thickness(&p.wall_type_or_fallback(wall).layers);
    let ref_off = crate::joins::reference_offset(model3d::wall_reference(wall), total);
    let along = a0 + ((ref_off - n0) / un) * ua;
    if along < from + 1e-4 || along > to - 1e-4 {
        return Ok(None);
    }
    let (mut z_bottom, mut z_top) = opening_extent(p, wall, o);
    // Formöffnung ([G3]): lichte Höhe an der Schnittstelle aus dem Umriss.
    let mut shape = None;
    if let Some(poly) = crate::opening_shape::opening_outline(o, to - from, z_top - z_bottom) {
        let Some((lo, hi)) = crate::opening_shape::v_range(&poly, along - from) else { return Ok(None) };
        shape = Some((poly, along - from, z_bottom));
        (z_bottom, z_top) = (z_bottom + lo, z_bottom + hi);
    }
    if z_top - z_bottom < 1e-3 {
        return Ok(None);
    }
    Ok(Some(CrossSection { n0, un, z_bottom, z_top, face_min: ref_off - total / 2.0, face_max: ref_off + total / 2.0, shape }))
}

/// Sash-Liste eines Fenstertyps (`sashesOfWindowType`) für das Fenster-Symbol.
pub(crate) fn sashes_of_window_type(wt: &WindowType) -> Vec<crate::opening_geom::Sash> {
    if let Some(s) = wt.sashes.as_deref().filter(|s| !s.is_empty()) {
        return s
            .iter()
            .map(|s| crate::opening_geom::Sash {
                post: s.kind == SashDefKind::Pfosten,
                auto_width: s.auto_width != Some(false),
                width: s.width.unwrap_or(f64::NAN),
                post_width: s.post_width.unwrap_or(f64::NAN),
                operable: s.opening.is_some_and(|o| o != OpeningKind::Fest),
            })
            .collect();
    }
    let wc = if wt.wing_count == 0.0 || wt.wing_count.is_nan() { 1.0 } else { wt.wing_count };
    let n = max(1.0, round(wc)) as usize;
    let operable = wt.kind != OpeningKind::Fest;
    (0..n).map(|_| crate::opening_geom::Sash { post: false, auto_width: true, width: f64::NAN, post_width: f64::NAN, operable }).collect()
}

fn window_cut(p: &Project, wall: &Wall, o: &Opening, c: &CrossSection) -> Result<Vec<Primitive>, String> {
    let wt = p.window_type(o);
    let fw = max(0.02, wt.and_then(|t| t.frame_width).unwrap_or(DEFAULT_FRAME_WIDTH));
    let (_, n) = axis_frame(wall);
    let off_of = |q: crate::opening_geom::V| (q.x - wall.start.x) * n.0 + (q.y - wall.start.y) * n.1;
    let mut f_min = (c.face_min + c.face_max) / 2.0 - DEFAULT_FRAME_DEPTH / 2.0;
    let mut f_max = f_min + DEFAULT_FRAME_DEPTH;
    let mut glass: Vec<f64> = vec![(f_min + f_max) / 2.0];
    // `windowSymbol(project, wall, o, 1, spec, "mittel")`.
    let total = sum_thickness(&p.wall_type_or_fallback(wall).layers);
    let ref_off = crate::joins::reference_offset(model3d::wall_reference(wall), total);
    let spec = wt.map(|t| crate::opening_geom::WindowSpec {
        sashes: sashes_of_window_type(t),
        frame_width: t.frame_width.unwrap_or(DEFAULT_FRAME_WIDTH),
        frame_depth: t.frame_depth.unwrap_or(f64::NAN),
        inset_from_face: t.inset_from_face.unwrap_or(f64::NAN),
        inset_inner: t.inset_face == Some(WindowTypeInsetFace::Innen),
        inset_mid: t.inset_face == Some(WindowTypeInsetFace::Mitte),
        frame_width_end: f64::NAN,
    });
    // [105] Rahmen-Detail: Lage/Tiefe übersteuert, Breite oben/unten, Anschlussprofile.
    let det = crate::opening_detail::frame_of(p, o).filter(|f| f.detailed);
    let spec = spec.map(|s| match &det {
        Some(f) => crate::opening_geom::WindowSpec {
            frame_depth: f.depth,
            inset_from_face: f.inset,
            inset_inner: f.face == crate::opening_detail::Face::Innen,
            inset_mid: f.face == crate::opening_detail::Face::Mitte,
            ..s
        },
        None => s,
    });
    let finite = [wall.start.x, wall.start.y, wall.end.x, wall.end.y, total, ref_off, o.position, o.width].iter().all(|x| x.is_finite());
    let sym = if finite {
        let wr = crate::opening_geom::WallRef { start: crate::opening_geom::v(wall.start.x, wall.start.y), end: crate::opening_geom::v(wall.end.x, wall.end.y), total, ref_off };
        crate::opening_geom::window_symbol(&wr, o.position, o.width, 1.0, spec.as_ref(), o.wing_count.unwrap_or(f64::NAN), crate::opening_geom::Detail::Mittel)
    } else {
        None
    };
    if let (Some(sym), true) = (sym, spec.is_some()) {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for q in &sym.frame {
            let s = off_of(*q);
            lo = min(lo, s);
            hi = max(hi, s);
        }
        f_min = lo;
        f_max = hi;
        if !sym.glass_lines.is_empty() {
            let mut seen: Vec<f64> = Vec::new();
            for (q, _) in &sym.glass_lines {
                let x = round(off_of(*q) * 1e6) / 1e6;
                // `new Set` (SameValueZero: 0 = -0, NaN = NaN).
                if !seen.iter().any(|&s| s == x || (s.is_nan() && x.is_nan())) {
                    seen.push(x);
                }
            }
            glass = seen;
        }
    }
    let u0 = c.u_at(f_min);
    let u1 = c.u_at(f_max);
    let h = c.z_top - c.z_bottom;
    let fwv = min(fw, h / 3.0);
    let (sp, sh) = det.as_ref().map_or((0.0, 0.0), |f| (min(f.sill_profile, h / 4.0), min(f.shading_profile, h / 4.0)));
    let (fwb, fwt) = det.as_ref().map_or((fwv, fwv), |f| (min(max(0.02, f.sides.bottom), h / 3.0), min(max(0.02, f.sides.top), h / 3.0)));
    let (zb0, zt0) = (c.z_bottom + sp, c.z_top - sh);
    let mut out = vec![opening_poly(rect(c.u_at(c.face_min), c.u_at(c.face_max), c.z_bottom, c.z_top), false, &o.id)];
    out.push(opening_poly(rect(u0, u1, zb0, zb0 + fwb), true, &o.id));
    out.push(opening_poly(rect(u0, u1, zt0 - fwt, zt0), true, &o.id));
    // Fensterbank- und Storen-Anschlussprofil.
    if sp > 1e-4 {
        out.push(opening_poly(rect(u0, u1, c.z_bottom, zb0), true, &o.id));
    }
    if sh > 1e-4 {
        out.push(opening_poly(rect(u0, u1, zt0, c.z_top), true, &o.id));
    }
    for s in glass {
        let u = c.u_at(s);
        let mut l = line(v2(u, zb0 + fwb), v2(u, zt0 - fwt), "section-window-glass", GLASS_MM, OPENING_INK);
        if let Primitive::Line { opening_id, .. } = &mut l {
            *opening_id = Some(o.id.clone());
        }
        out.push(l);
    }
    // [105] Kämpfer (Oberlicht) und waagrechte Sprossen-Riegel geschnitten, in ihrer Breite.
    if let Some(t) = wt.filter(|_| !crate::opening_shape::is_shaped(o)) {
        let (lo, hi) = (zb0 + fwb, zt0 - fwt);
        let tw = det.as_ref().map(|f| f.transom_width).filter(|v| v.is_finite()).unwrap_or(fw);
        let mw = det.as_ref().map(|f| f.mullion_width).filter(|v| v.is_finite()).unwrap_or(fw);
        let mut bars: Vec<(f64, f64)> = Vec::new();
        let mut top = hi;
        let tr = t.transom_height.unwrap_or(0.0);
        if tr > 1e-4 && c.z_top - tr > lo + tw && c.z_top - tr < hi - tw / 2.0 {
            let z = c.z_top - tr;
            bars.push((z - tw / 2.0, z + tw / 2.0));
            top = z - tw / 2.0;
        }
        let rows = t.mullion_rows.unwrap_or(1.0).round().clamp(1.0, 20.0) as usize;
        for r in 1..rows {
            let z = lo + (top - lo) * r as f64 / rows as f64;
            bars.push((z - mw / 2.0, z + mw / 2.0));
        }
        for (z0, z1) in bars {
            out.push(opening_poly(rect(u0, u1, z0, z1), true, &o.id));
        }
    }
    if let Some(t) = wt {
        // Formöffnung ([G3]): kein Sturz-Querschnitt, kein Storenkasten (Bogen/Schräge statt Sturz).
        let shaped = crate::opening_shape::is_shaped(o);
        let shading = t.shading.as_ref().filter(|s| s.create && !shaped);
        let sturz_box = shading.filter(|s| s.mount == Some(WindowShadingMount::Sturz)).map_or(0.0, |s| max(0.0, s.r#box.depth));
        if !shaped {
            lintel_cut(&mut out, o, c, t.lintel_height, sturz_box);
        }
        // Fensterbänke nur bei ausdrücklicher Wahl (bisherige Schnitte bleiben gleich).
        let zb = c.z_bottom;
        if matches!(t.sill_board, Some(WindowTypeSillBoard::Aussen | WindowTypeSillBoard::Beide)) {
            // Aussen: mit Gefälle, bis 4 cm vor die Aussenfläche.
            let out_s = min(f_min, c.face_min) - 0.04;
            let pts = vec![v2(c.u_at(f_min), zb), v2(c.u_at(out_s), zb - 0.015), v2(c.u_at(out_s), zb - 0.045), v2(c.u_at(f_min), zb - 0.03)];
            out.push(opening_poly(pts, true, &o.id));
        }
        if matches!(t.sill_board, Some(WindowTypeSillBoard::Innen | WindowTypeSillBoard::Beide)) {
            let in_s = max(f_max, c.face_max) + 0.02;
            out.push(opening_poly(rect(c.u_at(f_max), c.u_at(in_s), zb - 0.025, zb), true, &o.id));
        }
        if let Some(sh) = shading {
            let h = max(0.0, sh.r#box.height);
            let d = max(0.0, sh.r#box.depth);
            if h > 1e-4 && d > 1e-4 {
                // Im Sturz: ab der Aussenfläche in die Wand; vorgesetzt: vor der Rahmen-Vorderkante.
                let (s0, s1) = if sturz_box > 0.0 { (c.face_min, c.face_min + d) } else { (f_min - d, f_min) };
                out.push(opening_poly(rect(c.u_at(s0), c.u_at(s1), c.z_top, c.z_top + h), true, &o.id));
                // Lamellen-/Rollpaket im Kasten.
                let m = min(0.02, d / 4.0);
                let mut pack = polygon(rect(c.u_at(s0 + m), c.u_at(s1 - m), c.z_top + m, c.z_top + h * 0.6), SHADING_PACK_FILL, OPENING_INK, super::style::SYMBOL_LINE_MM, no_hatch_base());
                if let Primitive::Polygon { opening_id, .. } = &mut pack {
                    *opening_id = Some(o.id.clone());
                }
                out.push(pack);
            }
        }
    }
    Ok(out)
}

/// Sturz im Schnitt ([94]): eigener Querschnitt über der Öffnung (Beton grau), neben einem
/// Storenkasten im Sturz (`box_depth` ab der Aussenfläche) nur über den Rest der Wanddicke.
fn lintel_cut(out: &mut Vec<Primitive>, o: &Opening, c: &CrossSection, height: Option<f64>, box_depth: f64) {
    let h = height.unwrap_or(0.0);
    if !(h > 1e-4) {
        return;
    }
    let s0 = min(c.face_max, c.face_min + box_depth);
    if c.face_max - s0 <= 1e-4 {
        return;
    }
    let mut pr = polygon(rect(c.u_at(s0), c.u_at(c.face_max), c.z_top, c.z_top + h), LINTEL_FILL, OPENING_INK, FRAME_MM, no_hatch_base());
    if let Primitive::Polygon { opening_id, .. } = &mut pr {
        *opening_id = Some(o.id.clone());
    }
    out.push(pr);
}

fn door_cut(p: &Project, o: &Opening, c: &CrossSection) -> Vec<Primitive> {
    let mut out = vec![opening_poly(rect(c.u_at(c.face_min), c.u_at(c.face_max), c.z_bottom, c.z_top), false, &o.id)];
    if !crate::opening_shape::is_shaped(o) {
        lintel_cut(&mut out, o, c, p.door_type(o).and_then(|t| t.lintel_height), 0.0);
    }
    let kind = p.door_type(o).map(|t| t.kind);
    // [105] Zargen-Arten: Sturz-Profil der Zarge und Blatt im Falz.
    if let Some(df) = crate::opening_detail::door_frame_of(p, o).filter(|_| matches!(kind, Some(DoorTypeKind::Dreh | DoorTypeKind::Pendel | DoorTypeKind::Unknown))) {
        door_frame_cut(&mut out, o, c, &df);
        return out;
    }
    if o.door_type == Some(OpeningDoorType::Wandoeffnung) || kind == Some(DoorTypeKind::Wandoeffnung) {
        return out;
    }
    let mid = (c.face_min + c.face_max) / 2.0;
    let fw = min(DEFAULT_FRAME_WIDTH, (c.z_top - c.z_bottom) / 4.0);
    if kind == Some(DoorTypeKind::Schiebe) {
        // Schiebetür vor der Wand ([95]): Blatt vor der Fläche auf der Aufschlagseite (linke Normale wie im Grundriss).
        let swing = if matches!(o.swing, None | Some(SwingSide::Left)) { 1.0 } else { -1.0 };
        let dir = if matches!(o.opening_dir, None | Some(OpeningOpeningDir::In)) { 1.0 } else { -1.0 };
        let face = if swing * dir > 0.0 { c.face_max } else { c.face_min };
        let s = swing * dir;
        out.push(opening_poly(rect(c.u_at(face + s * 0.01), c.u_at(face + s * (0.01 + DOOR_LEAF_THICKNESS)), c.z_bottom + 0.01, c.z_top + 0.03), true, &o.id));
        return out;
    }
    out.push(opening_poly(rect(c.u_at(mid - DEFAULT_FRAME_DEPTH / 2.0), c.u_at(mid + DEFAULT_FRAME_DEPTH / 2.0), c.z_top - fw, c.z_top), true, &o.id));
    if kind == Some(DoorTypeKind::Hebeschiebe) {
        // Zwei Flügel auf versetzten Gleisen, je mit Glaslinie.
        for off in [-0.035, 0.035] {
            let (a, b) = (mid + off - 0.02, mid + off + 0.02);
            out.push(opening_poly(rect(c.u_at(a), c.u_at(b), c.z_bottom + 0.03, c.z_top - fw), true, &o.id));
            let mut l = line(v2(c.u_at(mid + off), c.z_bottom + 0.03 + fw), v2(c.u_at(mid + off), c.z_top - 2.0 * fw), "section-window-glass", GLASS_MM, OPENING_INK);
            if let Primitive::Line { opening_id, .. } = &mut l {
                *opening_id = Some(o.id.clone());
            }
            out.push(l);
        }
        return out;
    }
    out.push(opening_poly(rect(c.u_at(mid - DOOR_LEAF_THICKNESS / 2.0), c.u_at(mid + DOOR_LEAF_THICKNESS / 2.0), c.z_bottom + 0.01, c.z_top - fw), true, &o.id));
    out
}

/// Türzarge im Schnitt ([105]): Profil am Sturz (gleiches Profil wie im Grundriss, `x` nach unten)
/// und Türblatt im Falz der Aufschlagseite.
fn door_frame_cut(out: &mut Vec<Primitive>, o: &Opening, c: &CrossSection, df: &crate::opening_detail::DoorFrame) {
    use crate::opening_detail as od;
    let total = c.face_max - c.face_min;
    let innen = od::aufschlag_innen(o);
    let s_of = |d: f64| c.face_min + if innen { total - d } else { d };
    let profile = od::door_frame_profile(df, total, innen);
    let clear = od::profile_clear_x(&profile);
    for (_, poly) in &profile {
        let pts: Vec<Vec2> = poly.iter().map(|q| v2(c.u_at(s_of(q[1])), c.z_top - q[0])).collect();
        let mut pr = if df.steel { polygon(pts, OPENING_INK, OPENING_INK, FRAME_MM, no_hatch_base()) } else { polygon(pts, "#ffffff", OPENING_INK, FRAME_MM, no_hatch_base()) };
        if let Primitive::Polygon { opening_id, .. } = &mut pr {
            *opening_id = Some(o.id.clone());
        }
        out.push(pr);
    }
    let (d0, d1) = od::leaf_band(df, total, innen);
    let top = c.z_top - max(clear - df.falz_width, 0.0);
    out.push(opening_poly(rect(c.u_at(s_of(d0)), c.u_at(s_of(d1)), c.z_bottom + 0.01, top), true, &o.id));
}

/// `sectionOpeningPrimitives`.
pub fn section_opening_primitives(p: &Project, level: &LevelSpec, vis: &Visibility) -> Result<Vec<Primitive>, String> {
    let Some(plane) = level.plane() else { return Ok(Vec::new()) };
    if level.kind != "section" {
        return Ok(Vec::new());
    }
    let u_raw = plane.u_model();
    let l = hypot2(u_raw.0, u_raw.1);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let u = (u_raw.0 / l, u_raw.1 / l);
    let p0 = plane.base();
    let mut walls_by_id: HashMap<&str, &Wall> = HashMap::new();
    for w in &p.walls {
        walls_by_id.insert(w.id.as_str(), w);
    }
    let mut out = Vec::new();
    for o in p.openings.as_deref().unwrap_or(&[]) {
        if !vis.visible(&o.category_code) || !vis.render(&o.category_code) {
            continue;
        }
        // Dach-/Deckenfenster ([103]): Schnitt durch Rahmen, Glas und Eindeckrahmen.
        if let Some(f) = crate::opening_shape::host_frame(p, o) {
            let greyed = vis.greyed(&o.category_code);
            for (part, corners) in crate::opening_shape::surface_window_boxes(p, o, &f) {
                let Some(pts) = crate::opening_shape::box_section(&corners, p0, u) else { continue };
                let pr = opening_poly(pts.iter().map(|q| v2(q[0], q[1])).collect(), part != 0, &o.id);
                out.push(if greyed { pr.with_greyed(true) } else { pr });
            }
            continue;
        }
        let Some(wall) = walls_by_id.get(o.host_wall_id.as_str()).copied() else { continue };
        if !vis.visible(&wall.category_code) {
            continue;
        }
        // Bogenwand ([T2]): Öffnung auf der Sehne zwischen den Laibungen (gerades Einbauteil).
        let chord = arc_chord_opening(wall, o);
        let (wall, o) = match &chord {
            Some((vw, vo)) => (vw, vo),
            None => (wall, o),
        };
        let Some(c) = cross_section(p, wall, o, p0, u)? else { continue };
        let prims = if o.kind == ElementKind::Window { window_cut(p, wall, o, &c)? } else { door_cut(p, o, &c) };
        let greyed = vis.greyed(&o.category_code);
        for pr in prims {
            out.push(if greyed { pr.with_greyed(true) } else { pr });
        }
    }
    Ok(out)
}

// ── Abfrage ───────────────────────────────────────────────────────────────────

/// Zuletzt berechnete Schnitte je Schlüssel (> 0), wenige, älteste fallen weg.
const CACHE_SLOTS: usize = 6;

thread_local! {
    static CACHE: std::cell::RefCell<Vec<((f64, u64), std::rc::Rc<Output>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Schlüssel: (Schlüssel des Aufrufers, [33] Kennung der ausgeblendeten Elemente, 0 = keine).
fn cache_get(key: (f64, u64)) -> Option<std::rc::Rc<Output>> {
    if !(key.0 > 0.0) {
        return None;
    }
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        let i = c.iter().position(|e| e.0 == key)?;
        let e = c.remove(i);
        let o = e.1.clone();
        c.push(e);
        Some(o)
    })
}

fn cache_put(key: (f64, u64), o: std::rc::Rc<Output>) {
    if !(key.0 > 0.0) {
        return;
    }
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        c.retain(|e| e.0 != key);
        if c.len() >= CACHE_SLOTS {
            c.remove(0);
        }
        c.push((key, o));
    });
}

/// Abfrage `sectionPlan`: `args` = `[mono, openings, key, bodies…]` (Körper s. [`read_bodies`]; `key` > 0
/// = Schlüssel des vorbereiteten Schnitts, s. Cache unten, 0 = immer rechnen),
/// `text` = `{"level": {...}, "hiddenLines", "hasVis", "invisible", "hasDisplay", "norender", "grey"}`.
/// Puffer: Gruppe 0 Schnitt, Gruppe 1 geschnittene Öffnungen; Ausmass ohne die Öffnungen.
/// Ohne gültige Schnittlinie: leerer Puffer ohne Gruppen.
pub fn section_plan_buf(p: &Project, args: &[f64], text: &str) -> Result<Vec<u8>, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Schnitt-Argumente: {e}"))?;
    let level = LevelSpec::from_json(v.get("level").unwrap_or(&serde_json::Value::Null));
    let vis = Visibility::from_json(&v);
    let mono = args.first().is_some_and(|&x| x != 0.0);
    let openings = args.get(1).is_some_and(|&x| x != 0.0);
    let key = args.get(2).copied().unwrap_or(0.0);
    let scale = v.get("scale").and_then(|s| s.as_f64()).filter(|s| *s > 0.0 && s.is_finite()).unwrap_or(100.0);
    // [33] Eingeschaltete Override-Regeln eines Blatt-Viewports (`rules`: ids; fehlt = Schalter im Projekt).
    let on: Option<HashSet<String>> = v.get("rules").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect());
    let rv = RuleView::at(scale, on.as_ref()).view("section");
    // [33] Regel „Ausblenden“: Schnitt ohne diese Elemente (sie verdecken nichts, Wände samt Öffnungen).
    let hidden_ids = super::overrides::hidden_elements(p, rv);
    let filtered = (!hidden_ids.is_empty()).then(|| without_elements(p, &hidden_ids));
    let p = filtered.as_ref().unwrap_or(p);
    let hkey = {
        let mut ids: Vec<&String> = hidden_ids.iter().collect();
        ids.sort();
        ids.iter().flat_map(|s| s.bytes().chain([0u8])).fold(if ids.is_empty() { 0 } else { 0xcbf2_9ce4_8422_2325u64 }, |h, b| (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3))
    };
    let key = (key, hkey);
    let mut w = crate::plan::buf::Writer::new(true);
    // Der Schnitt selbst hängt nur am Projektstand, an der Ebene und den Körpern (= ein Aufruf von
    // `computeSection` in TS, Schlüssel `key`); Schwarz-Weiss, Sichtbarkeit und verdeckte Kanten nur an
    // der Darstellung. Darum die zuletzt berechneten Schnitte merken (Umschalten ohne Neurechnen).
    let out = match cache_get(key) {
        Some(o) => o,
        None => {
            let bodies = read_bodies(args.get(3..).unwrap_or(&[])).ok_or("Schnitt: Körper-Netze unlesbar")?;
            let Some(o) = compute_section(p, &level, &bodies)? else { return Ok(w.finish()) };
            let o = std::rc::Rc::new(o);
            cache_put(key, o.clone());
            o
        }
    };
    let hidden = v.get("hiddenLines").and_then(|b| b.as_bool()).unwrap_or(false);
    let detail = Detail::parse(v.get("detail").and_then(|d| d.as_str()).unwrap_or("mittel"));
    let (mut prims, bounds) = section_primitives_at(&out, mono, hidden, &vis, scale, detail, level.cut_hatch, &CutRules::of(p, &out, rv));
    w.post = super::extras::sketch_post(Some(level.sketch), scale);
    // Strichstärken nach Massstab ([32]) wie im Grundriss.
    super::extras::scale_line_weights(p, scale, &mut prims);
    // [149] Bäume hinter der Schnittebene: transparente Silhouette unter dem Schnitt (Bauteile verdecken sie).
    let mut trees: Vec<Primitive> = super::trees::view_trees(p, &level, &vis, None).into_iter().flat_map(|(_, t)| t).collect();
    let bounds = super::trees::union_bounds(bounds, &trees);
    super::extras::scale_line_weights(p, scale, &mut trees);
    trees.extend(prims);
    let prims = trees;
    w.group(&prims);
    let mut ops = if openings { section_opening_primitives(p, &level, &vis)? } else { Vec::new() };
    super::extras::scale_line_weights(p, scale, &mut ops);
    w.group(&ops);
    // Achsraster ([112]): Achsen quer zur Schnittebene.
    let grid = super::grid_view::grid_prims(p, &level, bounds, scale);
    if !grid.is_empty() {
        w.group(&grid);
    }
    w.bounds = Some(super::grid_view::union_bounds(bounds, &grid));
    Ok(w.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
    }

    fn level(p: &Project, id: &str) -> LevelSpec {
        let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
        LevelSpec::from_json(&serde_json::to_value(l).unwrap())
    }

    #[test]
    fn ebene_wie_section_plane_from_level() {
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: -1.0, y: 2.0 }, Vec2 { x: 6.0, y: 2.0 }]), ..Default::default() };
        let pl = l.plane().unwrap();
        assert_eq!(pl.point, [-1.0, 0.0, 2.0]);
        assert_eq!(pl.normal, [-0.0, 0.0, 1.0]);
        assert_eq!(pl.u_model(), (1.0, 0.0));
        let l0 = LevelSpec { line: Some([Vec2 { x: 1.0, y: 1.0 }, Vec2 { x: 1.0, y: 1.0 }]), ..Default::default() };
        assert!(l0.plane().is_none());
    }

    #[test]
    fn json_zahlen_wie_frueher() {
        // JS schreibt die kürzeste Darstellung, serde_json (ohne float_roundtrip) liest Mantisse/10^k.
        assert_eq!(json_f32(2.6), 2.6f32);
        assert_eq!(json_f32(-0.0), 0.0f32);
        assert_eq!(json_f32(3.0), 3.0f32);
        assert_eq!(json_f32(1e-9), 1e-9f32);
        // Gleichstand der kürzesten Darstellung → gerade Ziffer (wie serde_json beim Schreiben).
        assert_eq!(js_f32(5.00390625f32), 5.0039062f64);
        // Schnellweg = Lesung (gerechnete Zahlen mit 16–17 Ziffern, Rundungsgrenzen)
        let mut x = 0.123456789f64;
        for i in 0..200_000 {
            x = (x * 1.6180339887 + 0.37).fract() * [1e-5, 0.3, 7.0, 123.0, 4567.0, 1e9][i % 6];
            let v = if i % 7 == 0 { -x } else { x };
            assert_eq!(json_f32(v).to_bits(), json_f32_read(v).to_bits(), "{v}");
            let mid = ((v as f32) as f64 + ((v as f32).next_up() as f64)) / 2.0;
            assert_eq!(json_f32(mid).to_bits(), json_f32_read(mid).to_bits(), "{mid}");
        }
    }

    /// [95] Schnitt quer durch die Tasche einer Taschen-Schiebetür: die Wandschichten fehlen dort über
    /// die Türhöhe (7 cm × 2.0 m), ausserhalb der Tasche bleibt der Schnitt voll.
    #[test]
    fn schnitt_durch_die_tasche() {
        use crate::plan::walls::tests::pocket_project;
        let wall_area = |p: &Project, x: f64| {
            let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x, y: -1.0 }, Vec2 { x, y: 1.0 }]), ..Default::default() };
            let out = compute_section(p, &l, &[]).unwrap().unwrap();
            out.cuts
                .iter()
                .filter(|c| c.kind == Kind::Wall)
                .map(|c| {
                    let n = c.pts.len();
                    (0..n).map(|i| c.pts[i][0] * c.pts[(i + 1) % n][1] - c.pts[(i + 1) % n][0] * c.pts[i][1]).sum::<f64>().abs() / 2.0
                })
                .sum::<f64>()
        };
        let p = pocket_project(DoorTypeKind::Tasche, Some(OpeningHinge::End), 1.0);
        let full = wall_area(&p, 3.5);
        assert!((full - 0.16 * 2.6).abs() < 1e-4, "{full}");
        assert!((full - wall_area(&p, 2.4) - 0.07 * 2.0).abs() < 1e-4);
        // Gegenseite (Anschlag, x = 0.5) ohne Tasche.
        assert!((full - wall_area(&p, 0.5)).abs() < 1e-4);
    }

    /// [G1] Abzugskörper beliebiger Form (Netz, hier dreieckiges Prisma quer durch die Wand): seine
    /// Schnittfläche wird aus der Wand-Poché ausgespart; er selbst erscheint weder als Schnittfläche
    /// noch in der Projektion.
    #[test]
    fn abzugskoerper_beliebiger_form_im_schnitt() {
        use crate::plan::walls::tests::pocket_project;
        let mut p = pocket_project(DoorTypeKind::Tasche, Some(OpeningHinge::End), 1.0);
        // Profil/Verjüngung nur, damit es kein senkrechtes Prisma ist (das ginge über `section_rects`).
        let pts = vec![Vec2 { x: 3.2, y: -1.0 }, Vec2 { x: 3.8, y: -1.0 }, Vec2 { x: 3.8, y: 1.0 }, Vec2 { x: 3.2, y: 1.0 }];
        p.extruded_solids = Some(vec![ExtrudedSolid { id: "v".into(), level_id: "eg".into(), points: pts, height: 1.0, base_offset: Some(1.0), taper: Some(0.5), operation: Some("subtract".into()), ..Default::default() }]);
        // Dreieckiges Prisma längs x: Querschnitt (y, z) = (−1, 1), (1, 1), (0, 2).
        let tri = [[-1.0, 1.0], [1.0, 1.0], [0.0, 2.0]];
        let mut positions = Vec::new();
        for x in [3.2, 3.8] {
            for q in tri {
                positions.extend([x, q[0], q[1]]);
            }
        }
        let indices: Vec<f64> = [0, 2, 1, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5].iter().map(|&i| i as f64).collect();
        let body = BodyMesh { index: 0, positions, indices };
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 3.5, y: -1.0 }, Vec2 { x: 3.5, y: 1.0 }]), ..Default::default() };
        let area = |c: &Cut| {
            let n = c.pts.len();
            (0..n).map(|i| c.pts[i][0] * c.pts[(i + 1) % n][1] - c.pts[(i + 1) % n][0] * c.pts[i][1]).sum::<f64>().abs() / 2.0
        };
        let full: f64 = compute_section(&p, &l, &[]).unwrap().unwrap().cuts.iter().filter(|c| c.kind == Kind::Wall).map(area).sum();
        let out = compute_section(&p, &l, std::slice::from_ref(&body)).unwrap().unwrap();
        let cut: f64 = out.cuts.iter().filter(|c| c.kind == Kind::Wall).map(area).sum();
        // Wand 16 cm mittig auf y = 0: ∫ min(0.16, 2·(2 − z)) dz über 1…2 = 0.16·0.92 + 0.08².
        assert!((full - cut - (0.16 * 0.92 + 0.0064)).abs() < 1e-5, "{full} {cut}");
        assert!(out.cuts.iter().all(|c| c.kind != Kind::Body));
        // Keine Kante des Abzugskörpers in der Projektion (Prisma-Enden bei x = 3.8 liegen hinter der Ebene).
        let apex = |q: [f64; 2]| (q[0] - 1.0).abs() < 1e-6 && (q[1] - 2.0).abs() < 1e-6;
        assert!(!out.visible.iter().chain(&out.hidden).any(|e| apex(e.a) || apex(e.b)));
    }

    /// [G1] Treppenuntersicht: gerade Betontreppe längs geschnitten — die Laufplatte unten als gerade
    /// Linie (exakt, aus dem Laufplatten-Netz), nicht mehr als Sägezahn aus 1.5-cm-Scheiben.
    #[test]
    fn treppenuntersicht_exakt() {
        let p = sample();
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 3.2, y: -1.0 }, Vec2 { x: 3.2, y: 5.0 }]), ..Default::default() };
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        let st: Vec<&Cut> = out.cuts.iter().filter(|c| c.stair_id.as_deref() == Some("ST1")).collect();
        assert_eq!(st.len(), 1, "{:?}", out.cuts.iter().map(|c| (c.kind, c.index, c.stair_id.clone(), c.pts.len())).collect::<Vec<_>>());
        let pts = &st[0].pts;
        // ST1: Lauf 3.2 m ab y = 0.4, Steigung 2.6 m, 15 Stufen ⇒ Laufplatte 0.208 m senkrecht.
        let soffit = |u: f64| (((u - 1.4) / 3.2) * 2.6 - 0.208).max(0.0);
        assert!(pts.iter().all(|q| q[1] >= soffit(q[0]) - 1e-6), "{pts:?}");
        assert!(pts.iter().filter(|q| q[1] > 0.1 && (q[1] - soffit(q[0])).abs() < 1e-6).count() >= 2, "{pts:?}");
        assert!(pts.len() < 2 * 15 + 10, "{pts:?}");
    }

    /// [95][T2] Schnitt durch die Tasche in der Bogenwand (radial) und unter schräger Oberkante.
    #[test]
    fn schnitt_durch_die_tasche_bogen_und_dach() {
        use crate::plan::walls::tests::{pocket_project_with, POCKET_BULGE};
        let wall_area = |p: &Project, a: Vec2, b: Vec2| {
            let l = LevelSpec { kind: "section".into(), line: Some([a, b]), ..Default::default() };
            let out = compute_section(p, &l, &[]).unwrap().unwrap();
            out.cuts
                .iter()
                .filter(|c| c.kind == Kind::Wall)
                .map(|c| {
                    let n = c.pts.len();
                    (0..n).map(|i| c.pts[i][0] * c.pts[(i + 1) % n][1] - c.pts[(i + 1) % n][0] * c.pts[i][1]).sum::<f64>().abs() / 2.0
                })
                .sum::<f64>()
        };
        let arc = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(0.0, 0.0), kernel2d::Vec2::new(4.0, 0.0), Some(POCKET_BULGE)).unwrap();
        let radial = |s: f64| {
            let (c, n) = (arc.point(s, 0.0), arc.normal(s));
            (Vec2 { x: c.x - n.x, y: c.y - n.y }, Vec2 { x: c.x + n.x, y: c.y + n.y })
        };
        let flat = |x: f64| (Vec2 { x, y: -1.0 }, Vec2 { x, y: 1.0 });
        for (bulge, roof) in [(Some(POCKET_BULGE), false), (None, true)] {
            let line = |s: f64| if bulge.is_some() { radial(s) } else { flat(s) };
            let full = pocket_project_with(DoorTypeKind::Schiebe, None, 1.0, bulge, roof);
            let p = pocket_project_with(DoorTypeKind::Tasche, None, 1.0, bulge, roof);
            for (s, k) in [(0.5, 0.07 * 2.0), (3.5, 0.0)] {
                let (a, b) = line(s);
                let (fa, pa) = (wall_area(&full, a, b), wall_area(&p, a, b));
                assert!(fa > 0.3, "{bulge:?} {roof} {fa}");
                assert!((fa - pa - k).abs() < 1e-3, "{bulge:?} {roof} s={s}: {fa} {pa}");
            }
        }
    }

    /// [140] Dünne Schichten (Parkett, Putz) im Schnitt ab 1:100 in der Nachbarschicht, 1:50 alle; der
    /// Umriss der Fläche bleibt gleich (nur die Fuge entfällt).
    #[test]
    fn duenne_schnittschichten_je_massstab_zusammengefasst() {
        let rect = |v0: f64, v1: f64| vec![[0.0, v1], [5.0, v1], [5.0, v0], [0.0, v0]];
        let mk = |v0: f64, v1: f64, fill: &str| {
            let mut c = Cut::new(Kind::Slab, 0, rect(v0, v1));
            c.fill = Some(fill.into());
            c.source_id = Some("D1".into());
            c
        };
        // Parkett 1 cm, Unterlagsboden 8 cm, Trittschall 2 cm, Beton 22 cm, Putz 1 cm
        let cuts = vec![mk(0.32, 0.33, "#a"), mk(0.24, 0.32, "#b"), mk(0.22, 0.24, "#c"), mk(0.0, 0.22, "#d"), mk(-0.01, 0.0, "#e")];
        assert_eq!(merge_thin_cuts(&cuts, 20.0).len(), 5, "1:20: alle Schichten");
        assert_eq!(merge_thin_cuts(&cuts, 50.0).len(), 2, "1:50 (Teil 5): dünne Schichten zusammengefasst");
        let m = merge_thin_cuts(&cuts, 100.0);
        assert_eq!(m.len(), 2, "{:?}", m.iter().map(|c| (c.fill.clone(), ring_bbox(&c.pts))).collect::<Vec<_>>());
        let total: f64 = m.iter().map(|c| ring_area(&c.pts)).sum();
        assert!((total - 5.0 * 0.34).abs() < 1e-4, "{total}");
        let b = m.iter().find(|c| c.fill.as_deref() == Some("#b")).unwrap();
        let bb = ring_bbox(&b.pts);
        assert!((bb[1] - 0.24).abs() < 1e-5 && (bb[3] - 0.33).abs() < 1e-5, "Parkett geht im Unterlagsboden auf: {bb:?}");
        let d = m.iter().find(|c| c.fill.as_deref() == Some("#d")).unwrap();
        let bd = ring_bbox(&d.pts);
        assert!((bd[1] + 0.01).abs() < 1e-5 && (bd[3] - 0.24).abs() < 1e-5, "Putz und Trittschall im Beton: {bd:?}");
        // Trittschall 2 cm = 0.2 mm bei 1:100 → dünn, gleich lange Kanten: zur dickeren Nachbarschicht (Beton).
        assert!(m.iter().all(|c| c.fill.as_deref() != Some("#c")));
        // Anderes Bauteil verschmilzt nicht.
        let mut other = cuts.clone();
        other[0].source_id = Some("D2".into());
        assert!(merge_thin_cuts(&other, 100.0).iter().any(|c| c.fill.as_deref() == Some("#a")));
        // [140] Teil 5: Trittschall 4 cm (0.4 mm Papier) geht in 1:100 auf, Unterlagsboden 6.5 cm bleibt.
        let cuts = vec![mk(0.30, 0.315, "#a"), mk(0.235, 0.30, "#b"), mk(0.195, 0.235, "#c"), mk(0.0, 0.195, "#d")];
        let m = merge_thin_cuts(&cuts, 100.0);
        assert_eq!(m.len(), 2);
        assert!(m.iter().all(|c| c.fill.as_deref() != Some("#c") && c.fill.as_deref() != Some("#a")));
        assert_eq!(merge_thin_cuts(&cuts, 50.0).len(), 3, "1:50: Trittschall (0.8 mm) bleibt, Parkett nicht");
        assert_eq!(merge_thin_cuts(&cuts, 20.0).len(), 4);
    }

    /// [140] Teil 6: Unterbau-Schichten (Kies, Magerbeton, Erdreich) bleiben im Schnitt 1:100 schraffiert mit
    /// Fuge; die Bodenplatte darüber schwarz. Erkannt am Bauteil (`loose_fill_components`) oder an der Schraffur.
    #[test]
    fn unterbau_im_schnitt_1_100_nicht_schwarz() {
        let rect = |v0: f64, v1: f64| vec![[0.0, v1], [5.0, v1], [5.0, v0], [0.0, v0]];
        let cut = |comp: &str, v0: f64, v1: f64, pattern: HatchPattern| {
            let mut c = Cut::new(Kind::Slab, 0, rect(v0, v1));
            c.component_id = Some(comp.into());
            c.source_id = Some("c-bodenplatte".into());
            c.hatch = Some(HatchRender { pattern, ..section_hatch() });
            c.fill = Some(HATCH_PAPER.into());
            c
        };
        let out = Output {
            cuts: vec![cut("std-c-stahlbeton", -0.25, 0.0, HatchPattern::Diagonal), cut("mager", -0.3, -0.25, HatchPattern::Diagonal), cut("std-c-kies", -0.4, -0.3, HatchPattern::Gravel)],
            ..Default::default()
        };
        let loose: HashSet<String> = ["mager".to_string()].into();
        let fills = |scale: f64, loose: &HashSet<String>| -> Vec<(String, HatchPattern, String)> {
            let (prims, _) = section_primitives_at(&out, true, false, &Visibility::default(), scale, Detail::Mittel, false, &CutRules { loose: loose.clone(), ..Default::default() });
            prims.iter().filter_map(|q| match q { Primitive::Polygon { fill, hatch, stroke, ceiling_id: Some(_), .. } => Some((fill.clone(), hatch.pattern, stroke.clone())), _ => None }).collect()
        };
        let f = fills(100.0, &loose);
        assert_eq!(f[0], (HATCH_INK.to_string(), HatchPattern::None, "none".to_string()), "Platte schwarz");
        assert_eq!(f[1].1, HatchPattern::Diagonal, "Magerbeton (Bauteil) schraffiert");
        assert_ne!(f[1].0, HATCH_INK);
        assert_eq!(f[2].1, HatchPattern::Gravel, "Kies (Schraffur) schraffiert");
        assert_ne!(f[2].2, "none", "mit Fuge");
        // Ohne Bauteil-Liste: nur die Kies-Schraffur erkannt.
        let f = fills(100.0, &HashSet::new());
        assert_eq!(f[1].0, HATCH_INK);
        assert_eq!(f[2].1, HatchPattern::Gravel);
        // Musterhaus komplex: die Kies-Schicht der Bodenplatte ist ein loses Bauteil.
        let p = sample();
        assert!(loose_fill_components(&p).iter().all(|id| p.components.iter().any(|c| &c.id == id && crate::standards::is_loose_fill(c))));
    }

    /// [140] Teil 5: Schnitt 1:100 — geschnittene Flächen schwarz ohne Fuge/Schraffur, Umriss bleibt;
    /// 1:50, „fein" und `cutHatch` mit Schraffur und Fugen.
    #[test]
    fn schnittflaechen_schwarz_ab_1_100() {
        let p = sample();
        let l = level(&p, "schnitt-a");
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        let vis = Visibility::default();
        let stat = |scale: f64, detail: Detail, cut_hatch: bool| {
            let (prims, _) = section_primitives_at(&out, true, false, &vis, scale, detail, cut_hatch, &CutRules::of(&p, &out, RuleView::at(scale, None)));
            let cuts: Vec<_> = prims.iter().filter_map(|q| match q { Primitive::Polygon { fill, hatch, stroke, wall_id, ceiling_id, .. } if wall_id.is_some() || ceiling_id.is_some() => Some((fill.clone(), hatch.pattern, stroke.clone())), _ => None }).collect();
            let outline = prims.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "section-cut-outline")).count();
            (cuts, outline)
        };
        let (c, o) = stat(100.0, Detail::Mittel, false);
        assert!(!c.is_empty() && o > 0);
        assert!(c.iter().all(|(f, h, s)| f == HATCH_INK && *h == HatchPattern::None && s == "none"), "{c:?}");
        for (scale, detail, ch) in [(50.0, Detail::Mittel, false), (100.0, Detail::Fein, false), (100.0, Detail::Mittel, true)] {
            let (c, _) = stat(scale, detail, ch);
            assert!(c.iter().any(|(f, h, s)| f != HATCH_INK && *h != HatchPattern::None && s != "none"), "{scale} {detail:?} {ch}");
        }
    }

    /// [33] „Deckenaufbau weiss“ (Standardregel, über eine Ansichtsvorlage eingeschaltet): im Schnitt 1:100 sind
    /// Unterlagsboden und Dämmung über der Betondecke EINE weisse Fläche ohne Schraffur mit Umriss, die Decke
    /// selbst und die Wände bleiben schwarz; 1:50 ebenso weiss statt schraffiert. Ohne Regel (oder Regel aus)
    /// unverändert. Eine Regel nach Baustoff-Kategorie mit Schraffur „material“ zeigt die Schraffur auch ab 1:100.
    #[test]
    fn override_deckenaufbau_weiss() {
        let mut p = sample();
        let l = level(&p, "schnitt-a");
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        let vis = Visibility::default();
        let slab = |p: &Project, scale: f64| {
            let (prims, _) = section_primitives_at(&out, true, false, &vis, scale, Detail::Mittel, false, &CutRules::of(p, &out, RuleView::at(scale, None)));
            prims.iter().filter_map(|q| match q { Primitive::Polygon { fill, hatch, stroke, ceiling_id: Some(_), .. } => Some((fill.clone(), hatch.pattern, stroke.clone())), _ => None }).collect::<Vec<_>>()
        };
        let before = slab(&p, 100.0);
        // Estrich-Stücke (Dämmung liegt jeweils darunter, gleich breit oder fehlt am Wandanschluss) und Beton.
        let n = |comp: &str| out.cuts.iter().filter(|c| c.kind == Kind::Slab && c.component_id.as_deref() == Some(comp)).count();
        let (screed, insulation, concrete) = (n("screed"), n("insulation"), n("concrete"));
        assert!(screed >= insulation && insulation > 0 && concrete > 0);
        assert_eq!(before.len(), screed + insulation + concrete);
        assert!(before.iter().all(|(f, _, s)| f == HATCH_INK && s == "none"));
        // Standardregel geladen, aber aus: nichts ändert sich.
        p.override_rules = Some(crate::standards::override_rules().into_iter().map(|v| serde_json::from_value(v).unwrap()).collect());
        assert_eq!(slab(&p, 100.0), before);
        assert!(cut_overrides(&p, &out.cuts, RuleView::at(100.0, None)).is_empty());
        p.override_rules.as_mut().unwrap()[0].enabled = true;
        let after = slab(&p, 100.0);
        let white: Vec<_> = after.iter().filter(|(f, _, _)| f == "#ffffff").collect();
        assert_eq!(white.len(), screed, "Estrich + Dämmung je Stück als eine Fläche: {after:?}");
        assert!(white.iter().all(|w| (w.1, w.2.as_str()) == (HatchPattern::None, SECTION_INK)));
        assert_eq!(after.iter().filter(|(f, _, s)| f == HATCH_INK && s == "none").count(), concrete, "Betondecke bleibt schwarz");
        // Massstab-Kriterium der Standardregel: erst ab 1:100 — im 1:50 bleibt der Aufbau schraffiert.
        let at50 = slab(&p, 50.0);
        assert!(at50.iter().all(|(f, _, _)| f != "#ffffff"), "1:50 ohne Regel: {at50:?}");
        p.override_rules.as_mut().unwrap()[0].min_scale = None;
        let at50 = slab(&p, 50.0);
        assert_eq!(at50.iter().filter(|(f, h, _)| f == "#ffffff" && *h == HatchPattern::None).count(), screed);
        assert!(at50.iter().any(|(f, h, _)| f != "#ffffff" && *h != HatchPattern::None), "Beton 1:50 schraffiert");
        // Wände unberührt (Regel gilt nur für Decken).
        let walls = |p: &Project| {
            let (prims, _) = section_primitives_at(&out, true, false, &vis, 100.0, Detail::Mittel, false, &CutRules::of(p, &out, RuleView::at(100.0, None)));
            prims.iter().filter(|q| matches!(q, Primitive::Polygon { wall_id: Some(_), fill, .. } if fill != HATCH_INK)).count()
        };
        assert_eq!(walls(&p), 0);
        // Baustoff-Kategorie „insulation“ mit Materialschraffur: Dämmung der Wände auch 1:100 schraffiert.
        let mut r: OverrideRule = serde_json::from_value(serde_json::json!({"id": "d", "name": "Dämmung", "enabled": true,
            "condition": {"type": "material_category", "operator": "equals", "value": "insulation"}, "actions": {"hatch": "material"}})).unwrap();
        p.override_rules = Some(vec![r.clone()]);
        assert!(walls(&p) > 0);
        r.enabled = false;
        p.override_rules = Some(vec![r]);
        assert_eq!(walls(&p), 0);
    }

    /// [140] Trittschall 4 cm: 1:100 (0.4 mm Papier) ohne Zickzack, 1:50 mit; dicke Dämmung bleibt.
    #[test]
    fn duenne_daemmung_ohne_muster_ab_1_100() {
        let rect = |v0: f64, v1: f64| vec![[0.0, v1], [5.0, v1], [5.0, v0], [0.0, v0]];
        let mk = |v0: f64, v1: f64, pattern: HatchPattern| {
            let mut c = Cut::new(Kind::Slab, 0, rect(v0, v1));
            c.hatch = Some(HatchRender { pattern, ..section_hatch() });
            c
        };
        let cuts = vec![mk(0.0, 0.04, HatchPattern::Insulation), mk(0.1, 0.26, HatchPattern::Insulation), mk(0.3, 0.33, HatchPattern::InsulationHard), mk(0.4, 0.43, HatchPattern::Diagonal)];
        let pat = |cs: &[Cut]| cs.iter().map(|c| c.hatch.as_ref().unwrap().pattern).collect::<Vec<_>>();
        use HatchPattern as P;
        assert_eq!(pat(&plain_thin_insulation(cuts.clone(), 50.0)), [P::Insulation, P::Insulation, P::InsulationHard, P::Diagonal], "1:50 alle Muster");
        assert_eq!(pat(&plain_thin_insulation(cuts.clone(), 100.0)), [P::None, P::Insulation, P::None, P::Diagonal], "1:100");
        assert_eq!(pat(&plain_thin_insulation(cuts, 0.0)), [P::Insulation, P::Insulation, P::InsulationHard, P::Diagonal]);
    }

    #[test]
    fn beispiel_schnitt_mit_pick_ids() {
        let p = sample();
        let l = level(&p, "schnitt-a");
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        let (prims, b) = section_primitives(&out, false, false, &Visibility::default());
        let json = serde_json::to_string(&prims).unwrap();
        assert!(json.contains("\"wallId\":\"W2\"") && json.contains("\"roofId\":\"RF1\""), "{json}");
        assert!(json.contains("section-ground"));
        assert!(b[2] > b[0] && b[3] > b[1]);
        // Kategorie ausgeblendet → keine Dach-Schnittflächen mehr.
        let vis = Visibility { has_vis: true, invisible: ["31".to_string()].into_iter().collect(), ..Default::default() };
        let (hidden, _) = section_primitives(&out, false, false, &vis);
        assert!(!serde_json::to_string(&hidden).unwrap().contains("\"roofId\""));
    }

    /// [94] Sturz, Fensterbänke und Storenkasten im Sturz erscheinen im Schnitt nur, wenn gesetzt.
    #[test]
    fn sturz_baenke_und_storenkasten_im_schnitt() {
        let mut p = sample();
        // Schnittlinie quer durch die Mitte von O1 (Wand W1).
        let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
        let w1 = p.walls.iter().find(|w| w.id == o1.host_wall_id).unwrap().clone();
        let (u, n) = axis_frame(&w1);
        let m = o1.position + o1.width / 2.0;
        let c = (w1.start.x + u.0 * m, w1.start.y + u.1 * m);
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.0 - n.0 * 3.0, y: c.1 - n.1 * 3.0 }, Vec2 { x: c.0 + n.0 * 3.0, y: c.1 + n.1 * 3.0 }]), ..Default::default() };
        let vis = Visibility::default();
        let base = section_opening_primitives(&p, &l, &vis).unwrap();
        assert!(!base.is_empty());
        let typed = p.openings.as_deref().unwrap_or(&[]).iter().filter(|o| o.type_id.is_some()).count();
        assert!(typed > 0);
        for t in p.window_types.iter_mut().flatten() {
            t.lintel_height = Some(0.2);
            t.sill_board = Some(WindowTypeSillBoard::Beide);
            t.shading = Some(WindowShading { create: true, kind: WindowShadingKind::Raffstore, r#box: WindowShadingBox { width: 0.0, height: 0.3, depth: 0.18, ..Default::default() }, mount: Some(WindowShadingMount::Sturz), ..Default::default() });
        }
        for t in p.door_types.iter_mut().flatten() {
            t.lintel_height = Some(0.2);
        }
        let more = section_opening_primitives(&p, &l, &vis).unwrap();
        assert!(more.len() > base.len(), "{} {}", more.len(), base.len());
        let json = serde_json::to_string(&more).unwrap();
        assert!(json.contains(LINTEL_FILL) && json.contains(SHADING_PACK_FILL), "{json}");
    }

    /// [94] Anschlag im Schnitt: Die Schichten vor dem Rahmen (Aussenputz, Dämmung) reichen am Sturz um die
    /// Anschlagtiefe unter die Öffnungs-OK (Sturz-Nase) und an der Brüstung darüber — als Teil des Schicht-
    /// Bands (ein Umriss, keine Fuge), nicht als eigenes Öffnungs-Stück. Ohne Anschlag bleibt das Loch glatt.
    #[test]
    fn anschlag_im_schnitt_sturz_nase_und_bruestung() {
        let mut p = sample();
        let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
        let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap().clone();
        let (u, n) = axis_frame(&w1);
        let m = o1.position + o1.width / 2.0;
        let c = (w1.start.x + u.0 * m, w1.start.y + u.1 * m);
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.0 - n.0 * 3.0, y: c.1 - n.1 * 3.0 }, Vec2 { x: c.0 + n.0 * 3.0, y: c.1 + n.1 * 3.0 }]), ..Default::default() };
        let (zb, zt) = opening_extent(&p, &w1, &o1);
        // (Sturz-UK, Brüstungs-OK, Anzahl Bänder über der Öffnung) einer Schicht.
        let edges = |p: &Project, comp: &str| -> (f64, f64, usize) {
            let out = compute_section(p, &l, &[]).unwrap().unwrap();
            let mine: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1") && c.component_id.as_deref() == Some(comp)).collect();
            let above: Vec<&&Cut> = mine.iter().filter(|c| c.pts.iter().all(|q| q[1] > zb + 0.3)).collect();
            let head = above.iter().flat_map(|c| c.pts.iter().map(|q| q[1])).fold(f64::INFINITY, f64::min);
            let sill = mine.iter().flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y < zt - 0.3).fold(f64::NEG_INFINITY, f64::max);
            (head, sill, above.len())
        };
        // Ohne Anschlag (Rahmen aussen bündig): glattes Loch durch alle Schichten.
        let mut count = HashMap::new();
        for comp in ["render-ext", "insulation", "brick"] {
            let (h, s, k) = edges(&p, comp);
            assert!((h - zt).abs() < 1e-6 && (s - zb).abs() < 1e-6, "{comp}: {h} {s}");
            count.insert(comp, k);
        }
        // Rahmen 18 cm hinter der Aussenfläche (hinter der Dämmung), Anschlag 5 cm.
        for t in p.window_types.iter_mut().flatten() {
            t.inset_face = Some(WindowTypeInsetFace::Aussen);
            t.inset_from_face = Some(0.18);
            t.rebate_depth = Some(0.05);
        }
        for comp in ["render-ext", "insulation"] {
            let (h, s, k) = edges(&p, comp);
            assert!((h - (zt - 0.05)).abs() < 1e-6, "{comp}: Sturz-Nase {h} vs {}", zt - 0.05);
            assert!((s - (zb + 0.05)).abs() < 1e-6, "{comp}: Brüstung {s} vs {}", zb + 0.05);
            assert_eq!(k, count[comp], "{comp}: Nase gehört zum Band (keine Fuge)");
        }
        // Mauerwerk hinter dem Rahmen: unverändert.
        let (h, s, _) = edges(&p, "brick");
        assert!((h - zt).abs() < 1e-6 && (s - zb).abs() < 1e-6, "brick: {h} {s}");
        // Überdämmt [106] innerhalb der Nase: kein doppeltes Stück; darüber hinaus Teil desselben Umrisses.
        let reveal = |a: f64| vec![crate::model::LayerReveal { layer: 1.0, mode: crate::model::RevealMode::Ueberdaemmt, amount: Some(a), ..Default::default() }];
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.layer_reveals = Some(reveal(0.03));
        }
        let (h, _, k) = edges(&p, "insulation");
        assert!((h - (zt - 0.05)).abs() < 1e-6 && k == count["insulation"], "{h} {k}");
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.layer_reveals = Some(reveal(0.08));
        }
        let (h, _, k) = edges(&p, "insulation");
        assert!((h - (zt - 0.08)).abs() < 1e-6 && k == count["insulation"], "{h} {k}");
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.layer_reveals = None;
        }
        // Anschlag unten eigens (Rahmen-Detail): Brüstung 2 cm, Sturz bleibt 5 cm.
        for t in p.window_types.iter_mut().flatten() {
            t.frame_detail = Some(crate::model::FrameDetail { rebates: Some(crate::model::OpeningSides { bottom: Some(0.02), ..Default::default() }), ..Default::default() });
        }
        let (h, s, _) = edges(&p, "render-ext");
        assert!((h - (zt - 0.05)).abs() < 1e-6 && (s - (zb + 0.02)).abs() < 1e-6, "{h} {s}");
        // Die Nase ist kein eigenes Öffnungs-Stück mehr (sonst doppelt).
        let with = section_opening_primitives(&p, &l, &Visibility::default()).unwrap().len();
        for t in p.window_types.iter_mut().flatten() {
            t.frame_detail = None;
            t.rebate_depth = Some(0.0);
        }
        let without = section_opening_primitives(&p, &l, &Visibility::default()).unwrap().len();
        assert_eq!(with, without);
    }

    /// [G3] Rundbogen-Fenster: an der Schnittstelle reicht die Wand bis an den Bogen, Rahmen/Glas folgen.
    #[test]
    fn rundbogen_im_schnitt() {
        let mut p = sample();
        let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
        let w1 = p.walls.iter().find(|w| w.id == o1.host_wall_id).unwrap().clone();
        let (u, n) = axis_frame(&w1);
        // Viertel der Breite: Bogen 0,5 m Radius, Kämpfer 0,7 m über der Brüstung.
        let m = o1.position + o1.width / 4.0;
        let c = (w1.start.x + u.0 * m, w1.start.y + u.1 * m);
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.0 - n.0 * 3.0, y: c.1 - n.1 * 3.0 }, Vec2 { x: c.0 + n.0 * 3.0, y: c.1 + n.1 * 3.0 }]), ..Default::default() };
        let (zb, zt) = opening_extent(&p, &w1, &o1);
        let top_of = |p: &Project| -> f64 {
            let out = compute_section(p, &l, &[]).unwrap().unwrap();
            out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1")).flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y > zb + 0.1).fold(f64::INFINITY, f64::min)
        };
        assert!((top_of(&p) - zt).abs() < 1e-3, "Rechteck: Sturz bei {zt}");
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.shape = Some(OpeningShape::Rundbogen);
        }
        let want = zb + 0.7 + (0.25f64 - 0.0625).sqrt();
        assert!((top_of(&p) - want).abs() < 5e-3, "{} vs {want}", top_of(&p));
        let prims = section_opening_primitives(&p, &l, &Visibility::default()).unwrap();
        let ys: Vec<f64> = prims.iter().filter_map(|pr| if let Primitive::Polygon { pts, opening_id: Some(id), .. } = pr { (id == "O1").then(|| pts.iter().map(|q| q.y).fold(f64::NEG_INFINITY, f64::max)) } else { None }).collect();
        assert!(!ys.is_empty() && ys.iter().all(|y| *y < want + 5e-3), "kein Sturz/Kasten über dem Bogen: {ys:?}");
    }

    /// [T2]/[G3]/[106] Bogenwand: Rundbogen-Fenster im Schnitt (Wand bis an den Bogen) und Schichteinzug
    /// am Sturz (Sehne zwischen den Laibungen).
    #[test]
    fn rundbogen_und_einzug_in_bogenwand() {
        let mut p = sample();
        p.walls.iter_mut().find(|w| w.id == "W1").unwrap().bulge = Some(-0.3);
        let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
        let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap().clone();
        let a = crate::wall_arc::WallArc::of_wall(&w1).unwrap();
        let m = o1.position + o1.width / 4.0;
        let (c, n) = (a.point(m, 0.0), a.normal(m));
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.x - n.x * 3.0, y: c.y - n.y * 3.0 }, Vec2 { x: c.x + n.x * 3.0, y: c.y + n.y * 3.0 }]), ..Default::default() };
        let (zb, zt) = opening_extent(&p, &w1, &o1);
        let top_of = |p: &Project| -> f64 {
            let out = compute_section(p, &l, &[]).unwrap().unwrap();
            out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1")).flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y > zb + 0.1).fold(f64::INFINITY, f64::min)
        };
        assert!((top_of(&p) - zt).abs() < 1e-3, "Rechteck: Sturz bei {zt}");
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.shape = Some(OpeningShape::Rundbogen);
        }
        let want = zb + 0.7 + (0.25f64 - 0.0625).sqrt();
        assert!((top_of(&p) - want).abs() < 1e-2, "{} vs {want}", top_of(&p));
        // Schichteinzug: innerste Schicht springt am Sturz 5 cm zurück.
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.shape = None;
            o.layer_reveals = Some(vec![crate::model::LayerReveal { layer: -1.0, mode: crate::model::RevealMode::Zurueck, amount: Some(0.05), ..Default::default() }]);
        }
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        let inner_top = out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1") && c.component_id.as_deref() == Some("render-int")).flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y > zb + 0.1).fold(f64::INFINITY, f64::min);
        assert!((inner_top - (zt + 0.05)).abs() < 1e-3, "Innenputz am Sturz zurück: {inner_top} vs {}", zt + 0.05);
    }

    /// [106]/[G3] Schnitt quer durch einen Rundbogen nahe der Leibung: der zurückspringende Innenputz
    /// folgt dem um 5 cm versetzten Bogen (senkrecht zum Umriss, nicht 5 cm lotrecht über dem Bogen).
    #[test]
    fn rundbogen_schichteinzug_folgt_dem_bogen() {
        let mut p = sample();
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.shape = Some(OpeningShape::Rundbogen);
            o.layer_reveals = Some(vec![crate::model::LayerReveal { layer: -1.0, mode: crate::model::RevealMode::Zurueck, amount: Some(0.05), ..Default::default() }]);
        }
        let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
        let w1 = p.walls.iter().find(|w| w.id == o1.host_wall_id).unwrap().clone();
        let (from, to) = opening_interval(&w1, &o1).unwrap();
        let (zb, zt) = opening_extent(&p, &w1, &o1);
        let (u, n) = axis_frame(&w1);
        let at = from + 0.1;
        let c = (w1.start.x + u.0 * at, w1.start.y + u.1 * at);
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: c.0 - n.0 * 3.0, y: c.1 - n.1 * 3.0 }, Vec2 { x: c.0 + n.0 * 3.0, y: c.1 + n.1 * 3.0 }]), ..Default::default() };
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        let low = |comp: Option<&str>| out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some(w1.id.as_str()) && (comp.is_none() || c.component_id.as_deref() == comp)).flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y > zb + 0.1).fold(f64::INFINITY, f64::min);
        let (r, spring) = ((to - from) / 2.0, zt - (to - from) / 2.0);
        let dx = r - 0.1;
        let arch = spring + (r * r - dx * dx).sqrt();
        assert!((low(None) - arch).abs() < 5e-3, "Wand bis an den Bogen: {} vs {arch}", low(None));
        let want = spring + ((r + 0.05) * (r + 0.05) - dx * dx).sqrt();
        let inner = low(Some("render-int"));
        assert!((inner - want).abs() < 5e-3, "Innenputz am versetzten Bogen: {inner} vs {want} (lotrecht wäre {})", arch + 0.05);
        // Innenputz in die Leibung (2 cm): das Stück hängt unter dem Bogen, senkrecht zum Umriss gemessen.
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.layer_reveals = Some(vec![crate::model::LayerReveal { layer: -1.0, mode: crate::model::RevealMode::Leibung, amount: Some(0.02), ..Default::default() }]);
        }
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        let lowest = out.cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some(w1.id.as_str())).flat_map(|c| c.pts.iter().map(|q| q[1])).filter(|y| *y > zb + 0.1).fold(f64::INFINITY, f64::min);
        let want = spring + ((r - 0.02) * (r - 0.02) - dx * dx).sqrt();
        assert!((lowest - want).abs() < 5e-3, "Leibungsstück am Bogen: {lowest} vs {want} (lotrecht wäre {})", arch - 0.02);
    }

    /// [G3] Projektion hinter der Schnittebene: Rundfenster zeigt den Umriss statt des Rechteck-Lochs.
    #[test]
    fn formoeffnung_in_der_projektion() {
        let mut p = sample();
        let o1 = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
        let w1 = p.walls.iter().find(|w| w.id == o1.host_wall_id).unwrap().clone();
        let (u, n) = axis_frame(&w1);
        let edges_of = |p: &Project, sign: f64| -> usize {
            let (a, b) = ((w1.start.x + n.0 * sign * 1.5, w1.start.y + n.1 * sign * 1.5), (w1.end.x + n.0 * sign * 1.5, w1.end.y + n.1 * sign * 1.5));
            let mut best = 0;
            for (s, e) in [(a, b), (b, a)] {
                let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: s.0 - u.0, y: s.1 - u.1 }, Vec2 { x: e.0 + u.0, y: e.1 + u.1 }]), ..Default::default() };
                let out = compute_section(p, &l, &[]).unwrap().unwrap();
                let (zb, zt) = opening_extent(p, &w1, &o1);
                best = best.max(out.visible.iter().filter(|e| e.kind == Kind::Wall && e.a[1] > zb + 0.01 && e.a[1] < zt - 0.01 && e.b[1] > zb + 0.01 && e.b[1] < zt - 0.01).count());
            }
            best
        };
        let rect = edges_of(&p, 1.0).max(edges_of(&p, -1.0));
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.shape = Some(OpeningShape::Rund);
        }
        let round = edges_of(&p, 1.0).max(edges_of(&p, -1.0));
        assert!(round >= rect + 20, "Umriss als Kantenzug: {rect} → {round}");
    }

    /// [103] Dachfenster: Lücke in allen Dachschichten, Rahmen/Glas geschnitten.
    #[test]
    fn dachfenster_im_schnitt() {
        let mut p = sample();
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 2.5, y: -2.0 }, Vec2 { x: 2.5, y: 6.0 }]), ..Default::default() };
        let roof_cuts = |p: &Project| compute_section(p, &l, &[]).unwrap().unwrap().cuts.iter().filter(|c| c.kind == Kind::Roof).count();
        let before = roof_cuts(&p);
        assert!(before > 0);
        p.openings.as_mut().unwrap().push(Opening {
            id: "DF".into(),
            kind: ElementKind::Window,
            category_code: "21".into(),
            width: 0.78,
            height: 1.18,
            host_roof_id: Some("RF1".into()),
            host_point: Some(Vec2 { x: 2.5, y: 1.0 }),
            ..Default::default()
        });
        assert!(roof_cuts(&p) > before, "Schichten links und rechts des Fensters");
        let prims = section_opening_primitives(&p, &l, &Visibility::default()).unwrap();
        let df: Vec<_> = prims.iter().filter(|pr| matches!(pr, Primitive::Polygon { opening_id: Some(id), .. } if id == "DF")).collect();
        assert!(df.len() >= 4, "Rahmen beidseits, Glas, Eindeckrahmen: {}", df.len());
    }

    /// [T2] Schräger Schnitt durch eine Bogenwand: je Durchstoss genau ein Band je Schicht (auch wenn die
    /// Ebene eine Stossfuge der Sehnen-Teilkörper quert), Schichtfolge vollständig.
    #[test]
    fn bogenwand_im_schnitt_je_schicht_ein_band() {
        let mut p = sample();
        p.walls.retain(|w| w.id == "W1");
        p.openings = Some(vec![]);
        p.ceilings = Some(vec![]);
        p.roofs = Some(vec![]);
        p.stairs = Some(vec![]);
        p.walls[0].bulge = Some(-1.0); // Halbkreis nach Süden, Mitte (2.5, 0), r 2.5
        for l in p.drawing_levels.iter_mut().filter(|l| l.id == "schnitt-a") {
            l.line_points = Some([Vec2 { x: -1.0, y: -1.5 }, Vec2 { x: 6.0, y: -1.5 }]);
        }
        let out = compute_section(&p, &level(&p, "schnitt-a"), &[]).unwrap().unwrap();
        let walls: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Wall).collect();
        assert_eq!(walls.len(), 8, "2 Durchstösse × 4 Schichten: {:#?}", walls.iter().map(|c| (bbox(&c.pts), c.component_id.clone())).collect::<Vec<_>>());
        let mut us: Vec<[f64; 4]> = walls.iter().map(|c| bbox(&c.pts)).collect();
        us.sort_by(|a, b| cmp_num(a[0] - b[0]));
        // Lückenlos je Durchstoss.
        for k in [0usize, 4] {
            for i in k..k + 3 {
                assert!((us[i][1] - us[i + 1][0]).abs() < 1e-6, "{us:?}");
            }
        }
        // Hinter der Ebene keine Facetten-Fugen der Sehnen-Teilkörper (nur Umriss).
        let seams = out.visible.iter().chain(&out.hidden).filter(|e| e.kind == Kind::Wall && (e.a[0] - e.b[0]).abs() < 1e-4).count();
        assert!(seams <= 4, "senkrechte Kanten: {seams}");
    }

    /// [G4] Projektion exakt: Dach hinter der Ebene sichtbar, keine Kante im Inneren einer Schnittfläche
    /// (die Schnittflächen verdecken), Fenster der Rückwand als Umriss ohne die Stossfugen der
    /// Wandstücke darunter, verdeckte Kanten nur mit `hiddenLines`.
    #[test]
    fn projektion_exakt_sichtbar() {
        let p = sample();
        let mut l = level(&p, "schnitt-a");
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        assert!(out.visible.iter().any(|e| e.kind == Kind::Roof), "Dach hinter der Ebene fehlt");
        assert!(out.hidden.is_empty());
        let inside = |c: &Cut, q: [f64; 2]| {
            let b = bbox(&c.pts);
            q[0] > b[0] + 1e-3 && q[0] < b[1] - 1e-3 && q[1] > b[2] + 1e-3 && q[1] < b[3] - 1e-3
        };
        for e in &out.visible {
            let m = [(e.a[0] + e.b[0]) / 2.0, (e.a[1] + e.b[1]) / 2.0];
            assert!(!out.cuts.iter().filter(|c| c.pts.len() == 4).any(|c| inside(c, m)), "Kante in einer Schnittfläche: {e:?}");
        }
        l.hidden_lines = true;
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        assert!(!out.hidden.is_empty());
        let (prims, _) = section_primitives(&out, false, true, &Visibility::default());
        assert!(serde_json::to_string(&prims).unwrap().contains("section-hidden"));
    }

    /// [T6]/[68] Gelände mit Baugrube: gestaltetes + gewachsenes Terrain, Erdreich ohne Gebäude-Inneres;
    /// Fassaden-Geländehöhen fürs Baurecht.
    #[test]
    fn gelaende_mit_baugrube_im_schnitt() {
        let mut p = sample();
        let flat = TerrainMesh {
            id: "t".into(),
            positions: vec![-50.0, -50.0, 0.0, 50.0, -50.0, 0.0, 50.0, 50.0, 0.0, -50.0, 50.0, 0.0],
            indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
            category_code: Some("02".into()),
            ..Default::default()
        };
        let pit = Excavation {
            id: "bg".into(),
            outline: vec![Vec2 { x: -1.0, y: -1.0 }, Vec2 { x: 6.0, y: -1.0 }, Vec2 { x: 6.0, y: 5.0 }, Vec2 { x: -1.0, y: 5.0 }],
            bottom: -2.0,
            ..Default::default()
        };
        p.context = Some(vec![ContextObject::TerrainMesh(flat), ContextObject::Excavation(pit)]);
        let out = compute_section(&p, &level(&p, "schnitt-a"), &[]).unwrap().unwrap();
        assert!(out.profiles.iter().any(|pr| pr.natural) && out.profiles.iter().any(|pr| !pr.natural));
        let designed_min = out.profiles.iter().filter(|pr| !pr.natural).flat_map(|pr| pr.pts.iter().map(|q| q[1])).fold(f64::INFINITY, f64::min);
        assert!((designed_min + 2.0).abs() < 1e-6, "{designed_min}");
        assert!(!out.earth.is_empty());
        let (prims, _) = section_primitives(&out, false, false, &Visibility::default());
        // [137] Das Erdreich-Band und die Geländefläche der Ansicht wählen das Gelände.
        assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { hatch, context_object_id: Some(id), .. } if hatch.pattern == HatchPattern::Earth && id == "t")));
        assert!(prims.iter().any(|q| matches!(q, Primitive::Line { cls, dash: Some(Some(_)), .. } if cls == "section-terrain")));
        let (ep, _) = super::super::elevation::elevation_primitives(&p, &level(&p, "ansicht-sued"), false, false, &Visibility::default(), 100.0).unwrap().unwrap();
        let sil: Vec<f64> = ep.iter().filter_map(|q| if let Primitive::Line { cls, a, b, .. } = q { (cls == "elevation-terrain").then_some(a.y.min(b.y)) } else { None }).collect();
        // Die Ansichtslinie (y = −2) liegt in der Böschung: die Silhouette taucht vor dem Gebäude ein, nie unter die Sohle.
        assert!(!sil.is_empty() && sil.iter().all(|z| *z <= 1e-6 && *z >= -2.0 - 1e-6) && sil.iter().any(|z| *z < -0.5), "{sil:?}");
        assert!(ep.iter().any(|q| matches!(q, Primitive::Polygon { fill, context_object_id: Some(id), .. } if fill == "#ffffff" && id == "t")));
        assert!(!ep.iter().any(|q| matches!(q, Primitive::Line { cls, .. } if cls == "elevation-ground")));
        let f = crate::site_rules::facade_terrain(&p);
        assert!(!f.is_empty() && f.iter().all(|q| q.natural == Some(0.0) && q.designed.is_some_and(|z| (z + 2.0).abs() < 1e-6)));
    }

    fn ov_rule(conds: serde_json::Value, actions: serde_json::Value) -> OverrideRule {
        let c = conds.as_array().unwrap();
        serde_json::from_value(serde_json::json!({"id": "r", "name": "r", "enabled": true, "condition": c[0], "conditions": c[1..].to_vec(), "actions": actions})).unwrap()
    }

    /// [33] „Ausblenden“ im Schnitt: Wände samt Öffnungen weg (auch nicht im Schnitt-Cache vom Lauf ohne Regel),
    /// Decken bleiben; Gelände über Regeln (ausblenden, Linie, Füllung); Linienstil einer Schicht-Regel als
    /// gestrichelte Fugen.
    #[test]
    fn ausblenden_gelaende_und_linienstil_im_schnitt() {
        let mut p = sample();
        p.context = Some(vec![ContextObject::TerrainMesh(TerrainMesh {
            id: "t".into(),
            name: "Gelände".into(),
            positions: vec![-50.0, -50.0, 0.0, 50.0, -50.0, 0.0, 50.0, 50.0, 0.0, -50.0, 50.0, 0.0],
            indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
            ..Default::default()
        })]);
        let l = p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap();
        let text = serde_json::json!({ "level": serde_json::to_value(l).unwrap(), "scale": 50 }).to_string();
        // Gleicher Schlüssel (7) wie ein vorbereiteter Schnitt: die Regel darf nicht den gemerkten Schnitt treffen.
        let run = |p: &Project| -> Vec<Vec<Primitive>> {
            let (prims, groups, _) = crate::plan::buf::decode(&section_plan_buf(p, &[0.0, 1.0, 7.0, 0.0], &text).unwrap()).unwrap();
            groups.iter().map(|&(a, b)| prims[a..b].to_vec()).collect()
        };
        let walls = |g: &[Vec<Primitive>]| g[0].iter().filter(|q| matches!(q, Primitive::Polygon { wall_id: Some(_), .. })).count();
        let slabs = |g: &[Vec<Primitive>]| g[0].iter().filter(|q| matches!(q, Primitive::Polygon { ceiling_id: Some(_), .. })).count();
        let before = run(&p);
        assert!(walls(&before) > 0 && slabs(&before) > 0);
        p.override_rules = Some(vec![ov_rule(serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "wall"}, {"type": "view_kind", "operator": "equals", "value": "section"}]), serde_json::json!({"hide": true}))]);
        let g = run(&p);
        assert_eq!(walls(&g), 0, "Wände ausgeblendet");
        assert!(slabs(&g) > 0);
        assert!(g.get(1).is_none_or(|ops| ops.is_empty()), "Öffnungen der Wände mit");
        p.override_rules.as_mut().unwrap()[0].enabled = false;
        assert_eq!(walls(&run(&p)), walls(&before));
        // Gelände: Linie und Erdreich-Füllung, dann ausblenden.
        let terrain = |g: &[Vec<Primitive>]| g[0].iter().filter_map(|q| match q { Primitive::Line { cls, color, weight_mm, .. } if cls == "section-terrain" => Some((color.clone(), *weight_mm)), _ => None }).collect::<Vec<_>>();
        let earth = |g: &[Vec<Primitive>]| g[0].iter().filter_map(|q| match q { Primitive::Polygon { context_object_id: Some(id), fill, .. } if id == "t" => Some(fill.clone()), _ => None }).collect::<Vec<_>>();
        assert!(!terrain(&before).is_empty() && !earth(&before).is_empty());
        p.override_rules = Some(vec![ov_rule(serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "terrain"}]), serde_json::json!({"color": "#00aa00", "lineweight": 0.7, "fillColor": "#eeeeee"}))]);
        let g = run(&p);
        assert!(terrain(&g).iter().all(|(c, w)| c.as_deref() == Some("#00aa00") && (*w - 0.7).abs() < 1e-9));
        assert!(earth(&g).iter().all(|f| f == "#eeeeee"));
        p.override_rules = Some(vec![ov_rule(serde_json::json!([{"type": "element_kind", "operator": "equals", "value": "terrain"}]), serde_json::json!({"hide": true}))]);
        let g = run(&p);
        assert!(terrain(&g).is_empty() && earth(&g).is_empty());
        assert!(g[0].iter().any(|q| matches!(q, Primitive::Line { cls, .. } if cls == "section-ground")), "ohne Gelände die Grundlinie");
        // Linienstil einer Schicht-Regel (Dämmung): Fugen der Schicht gestrichelt.
        let dashed = |g: &[Vec<Primitive>]| g[0].iter().filter(|q| matches!(q, Primitive::Line { cls, dash: Some(Some(m)), .. } if cls == "section-joint" && m == &vec![0.35, 0.3])).count();
        assert_eq!(dashed(&before), 0);
        p.override_rules = Some(vec![ov_rule(serde_json::json!([{"type": "material_category", "operator": "equals", "value": "insulation"}]), serde_json::json!({"linetypeId": "hatch-dash"}))]);
        assert!(dashed(&run(&p)) > 0);
    }

    #[test]
    fn beschnittene_baender_behalten_ihre_ebene() {
        // Von der Dominanz beschnittene Wand-/Deckenstücke tragen ihre Kategorie weiter: Ebene aus → weg.
        let p = sample();
        let out = compute_section(&p, &level(&p, "schnitt-a"), &[]).unwrap().unwrap();
        assert!(out.cuts.iter().filter(|c| c.kind != Kind::Body).all(|c| c.category.is_some()), "{:#?}", out.cuts);
        let codes: Vec<String> = out.cuts.iter().filter_map(|c| c.category.clone()).collect();
        let vis = Visibility { has_vis: true, invisible: codes.into_iter().collect(), ..Default::default() };
        let (prims, _) = section_primitives(&out, false, false, &vis);
        assert!(prims.iter().all(|p| !matches!(p, Primitive::Polygon { .. })));
    }

    /// Mehrschichtige Decke + Treppe im Schnitt: je Deckenschicht genau ein Band mit ihrem Bauteil und
    /// ihrer Dicke (nicht jedes Schicht-Prisma nochmals in alle Schichten geteilt), Treppen-Tritte ohne
    /// Decken-Besitzer (früher: Besitzer per Zählung, Index-Versatz).
    #[test]
    fn mehrschichtige_decke_und_treppe_im_schnitt() {
        let p = sample();
        let l = level(&p, "schnitt-a");
        let out = compute_section(&p, &l, &[]).unwrap().unwrap();
        let slab: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Slab && c.stair_id.is_none()).collect();
        // Je Schicht ein Band (von stärkeren Wandschichten in Stücke geteilt): Bauteil + Höhenlage.
        let mut layers: Vec<(&str, f64, f64)> = Vec::new();
        for c in &slab {
            let b = bbox(&c.pts);
            let comp = c.component_id.as_deref().expect("Schicht-Bauteil");
            match layers.iter().find(|l| l.0 == comp) {
                Some(l) => assert!((l.1 - b[2]).abs() < 1e-5 && (l.2 - b[3]).abs() < 1e-5, "{comp}: {b:?} statt {l:?}"),
                None => layers.push((comp, b[2], b[3])),
            }
        }
        assert!(slab.iter().all(|c| c.source_id.as_deref() == Some("C1") && c.category.as_deref() == Some("30")));
        layers.sort_by(|a, b| b.2.total_cmp(&a.2));
        let names: Vec<&str> = layers.iter().map(|l| l.0).collect();
        assert_eq!(names, ["screed", "insulation", "concrete"], "{slab:#?}");
        // Schichtdicken 0.06 / 0.04 / 0.20 von oben nach unten, aneinander anschliessend.
        for (l, t) in layers.iter().zip([0.06, 0.04, 0.2]) {
            assert!((l.2 - l.1 - t).abs() < 1e-5, "{layers:?}");
        }
        assert!((layers[0].1 - layers[1].2).abs() < 1e-5 && (layers[1].1 - layers[2].2).abs() < 1e-5, "{layers:?}");
        // Stil der Schicht (Füllung + Schraffur des Bauteils), nicht die Rückfall-Schraffur ohne Füllung.
        assert!(slab.iter().all(|c| c.fill.is_some() && c.hatch.is_some() && c.join_priority.is_some()), "{slab:#?}");
        // Treppe: alle Tritt-Bänder mit Treppen-Herkunft, ohne Decken-Bauteil.
        let stair: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Slab && c.stair_id.is_some()).collect();
        assert!(!stair.is_empty());
        assert!(stair.iter().all(|c| c.stair_id.as_deref() == Some("ST1") && c.category.as_deref() == Some("40") && c.component_id.is_none()), "{stair:#?}");
        // Kein Decken-/Treppenband bleibt ohne Herkunft.
        assert!(out.cuts.iter().filter(|c| c.kind == Kind::Slab).all(|c| c.source_id.is_some() || c.stair_id.is_some()));
    }

    #[test]
    fn puffer_hat_zwei_gruppen() {
        let p = sample();
        let text = serde_json::json!({ "level": serde_json::to_value(p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap()).unwrap() }).to_string();
        let buf = section_plan_buf(&p, &[0.0, 1.0, 0.0, 0.0], &text).unwrap();
        let (prims, groups, bounds) = crate::plan::buf::decode(&buf).unwrap();
        assert_eq!(groups.len(), 2);
        assert!(bounds.is_some() && !prims.is_empty());
        // Ohne Schnittlinie: leerer Puffer ohne Gruppen.
        let none = section_plan_buf(&p, &[0.0, 0.0], r#"{"level":{"kind":"section"}}"#).unwrap();
        assert!(crate::plan::buf::decode(&none).unwrap().1.is_empty());
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use std::time::Instant;

    /// Messung je Stufe (nativ): `SECTION_BENCH_FILE=projekt.obp cargo test --release --lib section::bench -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn stufen() {
        let Ok(path) = std::env::var("SECTION_BENCH_FILE") else { return };
        let p: Project = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for l in p.drawing_levels.iter().filter(|l| l.line_points.is_some()) {
            let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
            let t = Instant::now();
            let walls = model3d::emit_walls(&p, false).unwrap();
            let t_walls = t.elapsed();
            let t = Instant::now();
            let mut slabs = model3d::emit_slabs(&p);
            slabs.extend(model3d::emit_stairs(&p, true));
            let t_rest = t.elapsed();
            let t = Instant::now();
            let wi: Vec<render3d::WallInput> = walls.iter().map(wall_input).collect();
            let si: Vec<render3d::SlabInput> = slabs.iter().map(slab_input).collect();
            let t_conv = t.elapsed();
            let pl = level.plane().unwrap();
            let fr = |v: [f64; 3]| [v[0] as f32, v[1] as f32, v[2] as f32];
            let t = Instant::now();
            let raw = render3d::section::cut_polygons(&render3d::SectionPlane::new(fr(pl.point), fr(pl.normal)), &wi, &si, &[]);
            let t_cut = t.elapsed();
            let t = Instant::now();
            let buf = if l.kind == DrawingLevelKind::Section {
                section_plan_buf(&p, &[0.0, 1.0, 0.0, 0.0], &serde_json::json!({ "level": serde_json::to_value(l).unwrap() }).to_string()).unwrap()
            } else {
                crate::plan::elevation::elevation_plan_buf(&p, &[0.0, 0.0], &serde_json::json!({ "level": serde_json::to_value(l).unwrap() }).to_string()).unwrap()
            };
            let t_all = t.elapsed();
            println!(
                "{} {:?}: Wände {:?} Platten/Dach {:?} Umwandlung {:?} cut_polygons {:?} ({} Cut) | gesamt {:?} ({} Bytes)",
                l.id, l.kind, t_walls, t_rest, t_conv, t_cut, raw.len(), t_all, buf.len()
            );
        }
    }
}

/// Fälle der früheren TS-Tests (`toSection.boolean/monolith/termination/depth/roof/layerOverride/
/// orientation`, `generateSectionPlan.category/select`), jetzt gegen die Kern-Fassung.
#[cfg(test)]
mod ts_faelle {
    use super::*;

    fn band(u0: f64, u1: f64, v0: f64, v1: f64, jp: Option<f64>, tag: &str) -> Cut {
        let mut c = Cut::new(Kind::Wall, 0, vec![[u0, v1], [u1, v1], [u1, v0], [u0, v0]]);
        c.fill = Some(tag.into());
        c.join_priority = jp;
        c
    }

    fn ring_area(pts: &[[f64; 2]]) -> f64 {
        pts.iter().enumerate().map(|(i, a)| { let c = pts[(i + 1) % pts.len()]; a[0] * c[1] - c[0] * a[1] }).sum::<f64>().abs() / 2.0
    }

    /// [G6] Schräges Band hoher Priorität (Parallelogramm) schneidet nur, wo es wirklich überlappt — nicht
    /// sein umgebendes Rechteck.
    #[test]
    fn schraeges_band_schneidet_nur_seine_flaeche() {
        let mut roof = Cut::new(Kind::Roof, 1, vec![[0.0, 2.0], [4.0, 4.0], [4.0, 4.5], [0.0, 2.5]]);
        roof.join_priority = Some(100.0);
        roof.fill = Some("beton".into());
        // Putzband unten links: berührt das Dach-Rechteck (bbox v 2..4.5), nicht aber das Dach selbst.
        let out = subtract_dominant_bands(vec![band(3.0, 4.0, 0.0, 2.9, Some(10.0), "putz"), roof]);
        let putz: Vec<&Cut> = out.iter().filter(|c| c.fill.as_deref() == Some("putz")).collect();
        assert_eq!(putz.len(), 1);
        assert!((ring_area(&putz[0].pts) - 2.9).abs() < 1e-6, "{:?}", putz[0].pts);
    }

    /// [G6] Schräges Band niedriger Priorität behält beim Beschneiden seine Schräge (kein Rechteck-Ersatz).
    #[test]
    fn schraeges_band_behaelt_schraege() {
        let mut roof = Cut::new(Kind::Roof, 1, vec![[0.0, 2.0], [4.0, 4.0], [4.0, 4.5], [0.0, 2.5]]);
        roof.join_priority = Some(10.0);
        roof.fill = Some("daemmung".into());
        let out = subtract_dominant_bands(vec![roof, band(1.0, 2.0, 0.0, 5.0, Some(100.0), "beton")]);
        let d: Vec<&Cut> = out.iter().filter(|c| c.fill.as_deref() == Some("daemmung")).collect();
        assert_eq!(d.len(), 2, "links und rechts der Stütze");
        // Fläche: Parallelogramm 4 × 0.5 = 2.0, minus der Streifen 1..2 (0.5) = 1.5; Stücke nicht rechteckig.
        assert!((d.iter().map(|c| ring_area(&c.pts)).sum::<f64>() - 1.5).abs() < 1e-6);
        assert!(d.iter().all(|c| !is_axis_rect(&c.pts)));
    }

    fn cband(u0: f64, u1: f64, v0: f64, v1: f64, jp: f64, comp: &str, tag: &str) -> Cut {
        Cut { component_id: Some(comp.into()), ..band(u0, u1, v0, v1, Some(jp), tag) }
    }

    fn area(items: &[&Cut]) -> f64 {
        items.iter().map(|c| {
            let b = bbox(&c.pts);
            (b[1] - b[0]) * (b[3] - b[2])
        }).sum()
    }

    fn by<'a>(out: &'a [Cut], tag: &str) -> Vec<&'a Cut> {
        out.iter().filter(|c| c.fill.as_deref() == Some(tag)).collect()
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn dominanz_stärkere_schicht_schneidet_schwächere() {
        let out = subtract_dominant_bands(vec![band(0.0, 2.0, 0.0, 3.0, Some(10.0), "putz"), band(0.0, 2.0, 2.0, 4.0, Some(100.0), "beton")]);
        assert_eq!(bbox(&by(&out, "beton")[0].pts), [0.0, 2.0, 2.0, 4.0]);
        let putz = by(&out, "putz");
        assert_eq!(putz.len(), 1);
        assert_eq!(bbox(&putz[0].pts), [0.0, 2.0, 0.0, 2.0]);
    }

    #[test]
    fn dominanz_gestaffelte_kette() {
        let out = subtract_dominant_bands(vec![
            band(0.0, 1.0, 3.0, 4.0, Some(100.0), "beton"),
            band(0.0, 1.0, 2.5, 3.5, Some(50.0), "backstein"),
            band(0.0, 1.0, 2.0, 3.0, Some(20.0), "daemmung"),
            band(0.0, 1.0, 0.0, 3.2, Some(10.0), "putz"),
        ]);
        assert!(close(area(&by(&out, "beton")), 1.0));
        assert!(close(area(&by(&out, "backstein")), 0.5));
        assert!(close(area(&by(&out, "daemmung")), 0.5));
        assert!(close(area(&by(&out, "putz")), 2.0));
    }

    #[test]
    fn dominanz_gleiche_prioritaet_und_ohne_prioritaet_koexistieren() {
        let out = subtract_dominant_bands(vec![band(0.0, 1.0, 0.0, 3.0, Some(100.0), "wand"), band(0.0, 1.0, 2.0, 4.0, Some(100.0), "decke")]);
        assert!(close(area(&by(&out, "wand")), 3.0) && close(area(&by(&out, "decke")), 2.0));
        let out = subtract_dominant_bands(vec![band(0.0, 2.0, 0.0, 2.0, Some(100.0), "stark"), band(0.0, 2.0, 0.0, 2.0, None, "ohne")]);
        assert!(close(area(&by(&out, "stark")), 4.0) && close(area(&by(&out, "ohne")), 4.0));
        let out = subtract_dominant_bands(vec![band(0.0, 3.0, 0.0, 3.0, Some(100.0), "stark"), band(1.0, 2.0, 1.0, 2.0, Some(10.0), "schwach")]);
        assert!(by(&out, "schwach").is_empty());
    }

    #[test]
    fn verschmelzen_gleicher_komponente() {
        let out = subtract_dominant_bands(vec![cband(0.0, 1.0, 0.0, 3.0, 100.0, "beton", "wand"), cband(0.0, 1.0, 2.0, 4.0, 100.0, "beton", "decke")]);
        assert_eq!(out.len(), 1);
        assert_eq!(bbox(&out[0].pts), [0.0, 1.0, 0.0, 4.0]);
        let out = subtract_dominant_bands(vec![cband(0.0, 1.0, 0.0, 3.0, 100.0, "b", "u"), cband(0.0, 1.0, 3.0, 5.0, 100.0, "b", "o")]);
        assert_eq!(out.len(), 1);
        let out = subtract_dominant_bands(vec![cband(0.0, 1.0, 0.0, 3.0, 100.0, "w", "wand"), cband(0.0, 1.0, 2.0, 4.0, 100.0, "d", "decke")]);
        assert_eq!(out.len(), 2);
        let out = subtract_dominant_bands(vec![cband(0.0, 1.0, 0.0, 2.0, 10.0, "putz", "pu"), cband(0.0, 1.0, 2.0, 4.0, 10.0, "putz", "po"), cband(0.0, 1.0, 3.0, 5.0, 100.0, "beton", "beton")]);
        let putz: Vec<&Cut> = out.iter().filter(|c| c.component_id.as_deref() == Some("putz")).collect();
        assert_eq!(putz.len(), 1);
        assert_eq!(bbox(&putz[0].pts), [0.0, 1.0, 0.0, 3.0]);
        let out = subtract_dominant_bands(vec![cband(0.0, 2.0, 0.0, 2.0, 100.0, "x", "a"), cband(1.0, 3.0, 1.0, 3.0, 100.0, "x", "b")]);
        assert_eq!(out.len(), 2, "Eck-Überlapp verschmilzt nicht");
    }

    #[test]
    fn monolith_tritte_zu_einem_saegezahn() {
        let rings = union_rect_outlines(&[[0.0, 1.0, 0.0, 0.2], [0.3, 1.0, 0.0, 0.4], [0.6, 1.0, 0.0, 0.6]]);
        assert_eq!(rings.len(), 1);
        assert!(rings[0].len() >= 8);
        assert_eq!(union_rect_outlines(&[[0.0, 1.0, 0.0, 1.0], [2.0, 3.0, 0.0, 1.0]]).len(), 2);
        let slab = |m: Option<&str>| RSlab { outline: vec![], z_bottom: 0.0, z_top: 1.0, color: [0.0; 3], ceiling_id: String::new(), hatch: None, cut: None, monolith: m.map(String::from), source: SlabSource::None };
        let slabs = vec![slab(None), slab(Some("ST1")), slab(Some("ST1"))];
        let mk = |i: usize, u0: f64| Cut::new(Kind::Slab, i, vec![[u0, 0.0], [u0 + 1.0, 0.0], [u0 + 1.0, 1.0], [u0, 1.0]]);
        let out = merge_monolith_cuts(vec![mk(0, 0.0), mk(1, 0.0), mk(2, 0.5)], &slabs, &HashMap::new());
        assert_eq!(out.len(), 2, "nur Bänder derselben Gruppe werden vereint");
    }

    fn wall(term: Option<SliceTermination>) -> Wall {
        Wall { id: "W".into(), slice_termination: term, ..Default::default() }
    }

    fn slab_band(u0: f64, u1: f64, v0: f64, v1: f64, jp: f64) -> Cut {
        Cut { kind: Kind::Slab, ..band(u0, u1, v0, v1, Some(jp), "decke") }
    }

    #[test]
    fn terminierung_unter_und_ueber_der_decke() {
        let below = wall(Some(SliceTermination::Below));
        let above = wall(Some(SliceTermination::Above));
        let both = wall(None);
        let run = |w: &Wall, wb: Cut, sb: Cut| apply_wall_termination(vec![wb, sb], &[Some(w)]);
        let out = run(&below, band(0.0, 0.3, 0.0, 3.0, Some(10.0), "w"), slab_band(-1.0, 4.0, 2.6, 2.9, 100.0));
        assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.0, 2.6]);
        let out = run(&above, band(0.0, 0.3, 0.0, 3.0, Some(10.0), "w"), slab_band(-1.0, 4.0, 0.0, 0.3, 100.0));
        assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.3, 3.0]);
        let out = run(&both, band(0.0, 0.3, 0.0, 3.0, Some(10.0), "w"), slab_band(-1.0, 4.0, 2.6, 2.9, 100.0));
        assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.0, 3.0]);
        // nur strikt dominante Decken; ohne u-Überlapp (über 5 cm Anschluss hinaus) keine Terminierung
        let out = run(&below, band(0.0, 0.3, 0.0, 3.0, Some(10.0), "w"), slab_band(-1.0, 4.0, 2.6, 2.9, 10.0));
        assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.0, 3.0]);
        let out = run(&below, band(0.0, 0.3, 0.0, 3.0, Some(10.0), "w"), slab_band(1.0, 4.0, 2.6, 2.9, 100.0));
        assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.0, 3.0]);
        // ohne joinPriority unangetastet
        let out = run(&below, band(0.0, 0.3, 0.0, 3.0, None, "w"), slab_band(-1.0, 4.0, 2.6, 2.9, 100.0));
        assert_eq!(bbox(&by(&out, "w")[0].pts), [0.0, 0.3, 0.0, 3.0]);
    }

    /// [36] Ansichtsbereich im Schnitt: Bauteile ganz hinter der Tiefe entfallen in der Projektion, der
    /// Schnitt selbst bleibt; ohne Tiefe unverändert.
    #[test]
    fn tiefe_blendet_ferne_bauteile_aus() {
        let wall = |id: &str, a: (f64, f64), b: (f64, f64), h: f64| Wall {
            id: id.into(),
            start: Vec2 { x: a.0, y: a.1 },
            end: Vec2 { x: b.0, y: b.1 },
            height: h,
            ..Default::default()
        };
        let mut p = Project::default();
        // quer: von der Ebene geschnitten und weit nach hinten; nah: 3 m, fern: 10 m hinter der Ebene (höher).
        p.walls = vec![wall("quer", (0.0, -1.0), (0.0, 12.0), 2.5), wall("nah", (2.0, 3.0), (6.0, 3.0), 2.5), wall("fern", (2.0, 10.0), (6.0, 10.0), 4.0)];
        let lv = |depth: Option<f64>| LevelSpec { sketch: false, cut_hatch: false, kind: "section".into(), line: Some([Vec2 { x: -1.0, y: 0.0 }, Vec2 { x: 8.0, y: 0.0 }]), direction_sign: Some(1.0), depth, shadows: false, hidden_lines: false };
        let top = |o: &Output| o.visible.iter().map(|e| e.a[1].max(e.b[1])).fold(f64::NEG_INFINITY, f64::max);
        let all = compute_section(&p, &lv(None), &[]).unwrap().unwrap();
        assert!(top(&all) > 3.9, "ohne Tiefe ist die ferne Wand sichtbar: {}", top(&all));
        let near = compute_section(&p, &lv(Some(5.0)), &[]).unwrap().unwrap();
        assert!(top(&near) < 2.5 + 1e-6, "ferne Wand hinter der Tiefe: {}", top(&near));
        assert!(!near.visible.is_empty(), "nahe Wand bleibt");
        assert_eq!(near.cuts.len(), all.cuts.len(), "Schnitt bleibt");
        // Tiefe 0 ist kein Filter.
        let zero = compute_section(&p, &lv(Some(0.0)), &[]).unwrap().unwrap();
        assert_eq!(zero.visible.len(), all.visible.len());
    }

    /// [140] Rangfolge im Schnitt: Umriss der geschnittenen Masse schwer (0.5), Fuge zwischen zwei
    /// aneinanderstossenden Bauteilen fein (0.13), Ansichtskanten dazwischen (0.18).
    #[test]
    fn schnittkante_schwer_fugen_fein() {
        let out = Output { cuts: vec![band(0.0, 1.0, 0.0, 1.0, None, "#fff"), band(1.0, 2.0, 0.0, 1.0, None, "#fff")], ..Default::default() };
        let (prims, _) = section_primitives(&out, false, false, &Visibility::default());
        let joints: Vec<f64> = prims.iter().filter_map(|q| match q { Primitive::Polygon { stroke_width_mm, .. } => Some(*stroke_width_mm), _ => None }).collect();
        assert_eq!(joints, [SECTION_JOINT_MM, SECTION_JOINT_MM]);
        let outline: Vec<(Vec2, Vec2)> = prims.iter().filter_map(|q| match q { Primitive::Line { a, b, cls, weight_mm, .. } if cls == "section-cut-outline" => { assert_eq!(*weight_mm, SECTION_CUT_OUTLINE_MM); Some((*a, *b)) } _ => None }).collect();
        // Umriss = Rechteck 2 × 1 (die Fuge bei x = 1 gehört nicht dazu).
        let len: f64 = outline.iter().map(|(a, b)| (b.x - a.x).hypot(b.y - a.y)).sum();
        assert!((len - 6.0).abs() < 1e-6, "{len}");
        assert!(outline.iter().all(|(a, b)| !((a.x - 1.0).abs() < 1e-6 && (b.x - 1.0).abs() < 1e-6)));
        assert!(SECTION_CUT_OUTLINE_MM > SECTION_VISIBLE_MM && SECTION_VISIBLE_MM > SECTION_JOINT_MM);
    }

    #[test]
    fn primitive_pick_ids_und_kategorien() {
        let mut w = band(0.0, 1.0, 0.0, 1.0, None, "#fff");
        w.source_id = Some("W1".into());
        w.category = Some("20".into());
        let mut s = Cut { kind: Kind::Slab, ..band(0.0, 1.0, 1.0, 2.0, None, "#fff") };
        s.source_id = Some("C1".into());
        let mut st = s.clone();
        st.stair_id = Some("ST1".into());
        let mut r = Cut { kind: Kind::Roof, ..band(0.0, 1.0, 2.0, 3.0, None, "#fff") };
        r.source_id = Some("R1".into());
        r.category = Some("31".into());
        let anon = band(2.0, 3.0, 0.0, 1.0, None, "#fff");
        let out = Output { cuts: vec![w, s, st, r, anon], ..Default::default() };
        let (prims, _) = section_primitives(&out, false, false, &Visibility::default());
        let json = serde_json::to_value(&prims).unwrap();
        assert_eq!(json[0]["wallId"], "W1");
        assert_eq!(json[1]["ceilingId"], "C1");
        assert!(json[2].get("ceilingId").is_none() && json[2]["stairId"] == "ST1");
        assert_eq!(json[3]["roofId"], "R1");
        assert!(json[4].get("wallId").is_none());
        // ausgeblendet, nicht gezeichnet, gedimmt; ohne Kategorie immer sichtbar
        let vis = Visibility { has_vis: true, invisible: ["20".to_string()].into(), norender: ["31".to_string()].into(), ..Default::default() };
        let (prims, _) = section_primitives(&out, false, false, &vis);
        assert_eq!(prims.iter().filter(|p| matches!(p, Primitive::Polygon { .. })).count(), 3);
        let grey = Visibility { grey: ["20".to_string()].into(), ..Default::default() };
        let (prims, _) = section_primitives(&out, false, false, &grey);
        assert!(matches!(&prims[0], Primitive::Polygon { greyed: Some(true), .. }));
        assert!(matches!(&prims[4], Primitive::Polygon { greyed: Some(false), .. }));
    }

    #[test]
    fn dach_schnitt_flach_und_sattel() {
        let mut p: Project = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        let roof = p.roofs.as_mut().unwrap().get_mut(0).unwrap();
        roof.shape = RoofShape::Flach;
        roof.overhang = 0.0;
        roof.base_elevation = Some(5.0);
        roof.roof_type_id = None;
        roof.thickness = 0.3;
        let plane = LevelSpec { line: Some([Vec2 { x: -1.0, y: 2.0 }, Vec2 { x: 6.0, y: 2.0 }]), ..Default::default() }.plane().unwrap();
        let mut cuts = Vec::new();
        append_roof_sections(&mut cuts, &p, &plane);
        assert_eq!(cuts.len(), 1);
        let b = bbox(&cuts[0].pts);
        assert!(close(b[3], 5.0) && close(b[3] - b[2], 0.3) && close(b[1] - b[0], 5.0), "{b:?}");
        // Sattel quer zum First: zwei Bänder; Spur ausserhalb: keine
        p.roofs.as_mut().unwrap()[0].shape = RoofShape::Sattel;
        let cross = LevelSpec { line: Some([Vec2 { x: 2.0, y: -1.0 }, Vec2 { x: 2.0, y: 5.0 }]), ..Default::default() }.plane().unwrap();
        let mut cuts = Vec::new();
        append_roof_sections(&mut cuts, &p, &cross);
        assert_eq!(cuts.len(), 2);
        let outside = LevelSpec { line: Some([Vec2 { x: -1.0, y: 9.0 }, Vec2 { x: 6.0, y: 9.0 }]), ..Default::default() }.plane().unwrap();
        let mut cuts = Vec::new();
        append_roof_sections(&mut cuts, &p, &outside);
        assert!(cuts.is_empty());
    }

    #[test]
    fn schichten_aussen_aussen_und_override_auf_allen_schichten() {
        let mut p: Project = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        let layers = p.wall_types.iter().find(|t| t.id == "aw").unwrap().layers.clone();
        assert!(layers.len() > 1);
        let cp = Cut::new(Kind::Wall, 0, vec![[0.0, 2.6], [0.345, 2.6], [0.345, 0.0], [0.0, 0.0]]);
        let w2 = p.walls.iter().find(|w| w.id == "W2").unwrap().clone();
        let w4 = p.walls.iter().find(|w| w.id == "W4").unwrap().clone();
        let u = (1.0, 0.0);
        let b2 = split_wall_layers(&cp, &p, &layers, &w2, u, &Plane { point: [0.0; 3], normal: [1.0, 0.0, 0.0] }).unwrap();
        let b4 = split_wall_layers(&cp, &p, &layers, &w4, u, &Plane { point: [0.0; 3], normal: [1.0, 0.0, 0.0] }).unwrap();
        // W4 (Aussenseite −x): layers[0] an uMin; W2 gespiegelt: layers[0] an uMax.
        assert_eq!(b4[0].component_id.as_deref(), Some(layers[0].component_id.as_str()));
        assert!(close(bbox(&b4[0].pts)[0], 0.0));
        assert_eq!(b2.last().unwrap().component_id.as_deref(), Some(layers[0].component_id.as_str()));
        // Override der Wand gilt für jede Schicht
        p.walls[1].background = Some("#123456".into());
        let w = p.walls[1].clone();
        let bands = split_wall_layers(&cp, &p, &layers, &w, u, &Plane { point: [0.0; 3], normal: [1.0, 0.0, 0.0] }).unwrap();
        assert!(bands.iter().all(|b| b.fill.as_deref() == Some("#123456")));
    }
}

/// Früher `toSection.roof.test.ts` (mehrschichtiges Dach, Nähte deckungsgleicher Teilflächen).
#[cfg(test)]
mod dach_faelle {
    use super::*;

    fn project(roof: serde_json::Value, extra: serde_json::Value) -> Project {
        let mut v = serde_json::json!({
            "id": "t", "name": "T", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
            "drawingLevels": [], "layers": [], "walls": [], "roofs": [roof]
        });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        serde_json::from_value(v).unwrap()
    }

    fn roof(over: serde_json::Value) -> serde_json::Value {
        let mut r = serde_json::json!({
            "id": "R1", "type": "roof", "floorId": "eg", "categoryCode": "35",
            "outline": [{"x": -3, "y": 0}, {"x": 3, "y": 0}, {"x": 3, "y": 4}, {"x": -3, "y": 4}],
            "shape": "sattel", "pitchDeg": 30, "overhang": 0, "ridgeAxis": "x", "baseElevation": 5, "thickness": 0.3
        });
        for (k, x) in over.as_object().unwrap() {
            r[k] = x.clone();
        }
        r
    }

    fn plane(point: [f64; 3], normal: [f64; 3]) -> Plane {
        Plane { point, normal }
    }

    #[test]
    fn mehrschichtiges_dach_je_schicht_ein_band_aussen_oben() {
        let p = project(
            roof(serde_json::json!({ "shape": "flach", "pitchDeg": 0, "roofTypeId": "rt1" })),
            serde_json::json!({
                "hatches": [{ "id": "h1", "name": "H", "pattern": "diagonal", "scale": 1, "angle": 45, "color": "#111111" }],
                "components": [
                    { "id": "tile", "name": "Ziegel", "color": "#a03a2a", "hatchId": "h1", "joinPriority": 1 },
                    { "id": "ins", "name": "Dämmung", "color": "#ffffff", "hatchId": "h1", "joinPriority": 2 }
                ],
                "roofTypes": [{ "id": "rt1", "name": "Aufbau", "layers": [{ "componentId": "tile", "thickness": 0.05 }, { "componentId": "ins", "thickness": 0.25 }] }]
            }),
        );
        let mut cuts = Vec::new();
        append_roof_sections(&mut cuts, &p, &plane([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]));
        assert_eq!(cuts.len(), 2);
        let tops: Vec<f64> = cuts.iter().map(|c| bbox(&c.pts)[3]).collect();
        assert!((tops[0] - 5.0).abs() < 1e-6 && (tops[1] - 4.95).abs() < 1e-6, "{tops:?}");
        assert!(cuts.iter().all(|c| c.hatch.as_ref().is_some_and(|h| h.pattern == HatchPattern::Diagonal)));
    }

    #[test]
    fn l_walmdach_deckungsgleiche_teilflaechen_ein_band() {
        let l = serde_json::json!([{"x": 0, "y": 0}, {"x": 11, "y": 0}, {"x": 11, "y": 4}, {"x": 8, "y": 4}, {"x": 8, "y": 6}, {"x": 0, "y": 6}]);
        for y in [1.0, 2.0] {
            let p = project(roof(serde_json::json!({ "outline": l, "shape": "walm" })), serde_json::json!({}));
            let mut cuts = Vec::new();
            append_roof_sections(&mut cuts, &p, &plane([0.0, 0.0, y], [0.0, 0.0, 1.0]));
            assert_eq!(cuts.len(), 3, "Schnitt bei y = {y}");
        }
    }
}

/// Früher `voids.test.ts` (Schnitt): Abzugskörper = Grundfläche × Höhenbereich, aus den Cut-Bändern
/// abgezogen.
#[cfg(test)]
mod abzug_faelle {
    use super::*;

    #[test]
    fn abzugskoerper_wird_aus_dem_schnittband_gezogen() {
        let mut p: Project = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        let (mx, my) = (2.5, 0.0);
        let solid: ExtrudedSolid = serde_json::from_value(serde_json::json!({
            "id": "void1", "type": "extrudedSolid", "levelId": "eg", "operation": "subtract", "height": 1.0, "baseOffset": 0.5,
            "points": [{"x": mx - 0.3, "y": my - 1.0}, {"x": mx + 0.3, "y": my - 1.0}, {"x": mx + 0.3, "y": my + 1.0}, {"x": mx - 0.3, "y": my + 1.0}]
        }))
        .unwrap();
        p.extruded_solids = Some(vec![solid]);
        let band = Cut::new(Kind::Wall, 0, vec![[mx - 2.0, 0.0], [mx + 2.0, 0.0], [mx + 2.0, 2.5], [mx - 2.0, 2.5]]);
        let out = subtract_voids_in_section(vec![band], &p, (0.0, my), (1.0, 0.0));
        assert_eq!(out.len(), 1);
        let pts: Vec<(f64, f64)> = out[0].pts.iter().map(|q| (q[0], q[1])).collect();
        let area = (0..pts.len()).map(|i| { let (a, b) = (pts[i], pts[(i + 1) % pts.len()]); a.0 * b.1 - b.0 * a.1 }).sum::<f64>().abs() / 2.0;
        assert!((area - (4.0 * 2.5 - 0.6 * 1.0)).abs() < 1e-6, "{area}");
        assert_eq!(out[0].nse.as_ref().map(|n| n.len()), Some(2), "Schlüsselloch-Stege ungestrichen");
    }
}

/// [G2] Wand an Dach: Schnitt und 3D-Körper der Wände unter einem Satteldach.
#[cfg(test)]
mod wand_an_dach {
    use super::*;

    fn haus() -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [],
            "drawingLevels": [
                {"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
                {"id": "q", "name": "Q", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": 2, "y": -2}, {"x": 2, "y": 10}], "directionSign": 1},
                {"id": "l", "name": "L", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": -2, "y": 4}, {"x": 12, "y": 4}], "directionSign": 1}
            ],
            "walls": [
                {"id": "WS", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 10, "y": 0}, "height": 3.5},
                {"id": "WW", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 0, "y": 8}, "end": {"x": 0, "y": 0}, "height": 9.0},
                {"id": "WB", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 6, "y": 1}, "end": {"x": 6, "y": 7}, "height": 9.0, "bulge": 0.4}
            ],
            "openings": [{"id": "F1", "type": "opening", "hostWallId": "WW", "categoryCode": "21", "kind": "window", "position": 3.5, "width": 1.0, "height": 1.2, "sillHeight": 3.6}],
            "roofs": [{"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35",
                "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}],
                "shape": "sattel", "pitchDeg": 45, "overhang": 0.5, "ridgeAxis": "x", "thickness": 0.3}]
        }))
        .unwrap()
    }

    /// Dach-Unterkante (Traufkante 3.0 bei y = −0.5, 45°, Dicke 0.3 senkrecht).
    fn under(y: f64) -> f64 {
        3.0 + (4.5 - (y - 4.0).abs()) - 0.3 * 2f64.sqrt()
    }

    #[test]
    fn schnitt_endet_an_der_dachunterkante() {
        let p = haus();
        for id in ["q", "l"] {
            let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
            let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
            let out = compute_section(&p, &level, &[]).unwrap().unwrap();
            let walls: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Wall).collect();
            assert!(!walls.is_empty());
            let top = walls.iter().flat_map(|c| c.pts.iter().map(|q| q[1])).fold(f64::NEG_INFINITY, f64::max);
            // Nie über der First-Unterkante.
            assert!(top <= under(4.0) + 1e-4, "{id}: {top}");
        }
        // Querschnitt quer zum First: Traufwand mit schräger Krone.
        let l = p.drawing_levels.iter().find(|l| l.id == "q").unwrap();
        let out = compute_section(&p, &LevelSpec::from_json(&serde_json::to_value(l).unwrap()), &[]).unwrap().unwrap();
        let sloped = out.cuts.iter().filter(|c| c.kind == Kind::Wall).any(|c| {
            let ys: Vec<f64> = c.pts.iter().map(|q| q[1]).filter(|v| *v > 2.0).collect();
            ys.len() >= 2 && (ys.iter().copied().fold(f64::NEG_INFINITY, f64::max) - ys.iter().copied().fold(f64::INFINITY, f64::min)) > 0.1
        });
        assert!(sloped, "Traufwand im Querschnitt mit schräger Krone");
    }

    #[test]
    fn koerper_dicht_und_volumen_exakt() {
        let p = haus();
        let walls = model3d::emit_walls(&p, true).unwrap();
        let ww: Vec<&RWall> = walls.iter().filter(|w| w.wall_id == "WW").collect();
        let mut vol = 0.0;
        for w in walls.iter().filter(|w| w.top_plane.is_some()) {
            let m = model3d::wall_piece_mesh(w).unwrap();
            assert!(m.is_closed(), "{w:?}");
            assert!((m.volume().abs() - model3d::wall_piece_volume(w)).abs() < 1e-9);
        }
        for w in &ww {
            assert!(w.holes.as_ref().is_none_or(|h| h.is_empty()), "Fenster unter dem Dach als Teilkörper: {w:?}");
            vol += model3d::wall_piece_volume(w);
        }
        // Giebelwand: Fünfeck unter der Unterkante × Dicke, minus Fenster.
        let t = p.wall_thickness(&p.walls[1], 0.2);
        let area = |y0: f64, y1: f64| (y1 - y0) * (under(y0) + under(y1)) / 2.0;
        let expect = t * (area(0.0, 4.0) + area(4.0, 8.0) - 1.2);
        // Gehrungen an den Ecken ändern das Volumen nur an den Enden.
        assert!((vol - expect).abs() < t * t * 7.0, "{vol} vs {expect}");
        // Bogenwand ([T2]): Sehnen-Teilwände ebenfalls unter dem Dach.
        let wb: Vec<&RWall> = walls.iter().filter(|w| w.wall_id == "WB").collect();
        assert!(wb.len() > 4 && wb.iter().all(|w| w.base_elevation + w.height <= under(4.0) + 1e-6), "{}", wb.len());
    }

    /// [132] T-Dach: Hauptdach (First in x, Traufe 3.0, 45°) und Anbau (First in y, Traufe 3.0) auf
    /// demselben Geschoss; der Anbau beginnt unter dem Hauptdach. Schnitt bei y = 1 mit Blick auf den Anbau.
    fn t_dach(dir: f64, ys: f64) -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [], "openings": [], "walls": [],
            "drawingLevels": [
                {"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
                {"id": "s", "name": "S", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": -2, "y": 1}, {"x": 12, "y": 1}], "directionSign": dir}
            ],
            "roofs": [
                {"id": "H", "type": "roof", "floorId": "F", "categoryCode": "35",
                 "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}],
                 "shape": "sattel", "pitchDeg": 45, "overhang": 0, "overhangGable": 0, "ridgeAxis": "x", "thickness": 0.3},
                {"id": "A", "type": "roof", "floorId": "F", "categoryCode": "35",
                 "outline": [{"x": 3, "y": ys}, {"x": 7, "y": ys}, {"x": 7, "y": 14}, {"x": 3, "y": 14}],
                 "shape": "sattel", "pitchDeg": 45, "overhang": 0, "overhangGable": 0, "ridgeAxis": "y", "thickness": 0.3}
            ]
        }))
        .unwrap()
    }

    /// [132] Was vom Anbaudach unter dem Hauptdach liegt, ist vom Schnitt aus verdeckt: Im Dachraum bei
    /// y = 1 deckt die Unterseite der Hauptdach-Fläche alles über ihrer Höhe an der Schnittebene; sichtbare
    /// Anbau-Kanten gibt es dort nicht (auch keine durch die Öffnung im Hauptdach unter dem Anbau).
    #[test]
    fn t_dach_anbau_unter_dem_hauptdach_verdeckt() {
        // Unterkante der Hauptdach-Südfläche an der Schnittebene y = 1.
        let z_cut = 3.0 + 1.0 - 0.3 * 2f64.sqrt();
        for (dir, ys) in [(1.0, 5.5), (-1.0, 5.5), (1.0, 6.3), (-1.0, 6.3)] {
            let p = t_dach(dir, ys);
            let l = p.drawing_levels.iter().find(|l| l.id == "s").unwrap();
            let out = compute_section(&p, &LevelSpec::from_json(&serde_json::to_value(l).unwrap()), &[]).unwrap().unwrap();
            let bad: Vec<_> = out.visible.iter().filter(|e| e.kind == Kind::Roof && e.index == 1 && e.a[1].max(e.b[1]) > z_cut + 1e-3).map(|e| (e.a, e.b)).collect();
            assert!(bad.is_empty(), "dir {dir} ys {ys}: sichtbare Anbau-Kanten über {z_cut}: {bad:?}");
        }
    }

    /// [132] Flachdach hinter dem Schnitt: Stirn als Band (Ober- und Unterkante), nicht nur eine Linie.
    #[test]
    fn flachdach_hinter_dem_schnitt_mit_stirn() {
        let p: Project = serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [], "openings": [], "walls": [],
            "drawingLevels": [
                {"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
                {"id": "s", "name": "S", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": -2, "y": -1}, {"x": 12, "y": -1}], "directionSign": 1},
                {"id": "t", "name": "T", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": 12, "y": -1}, {"x": -2, "y": -1}], "directionSign": 1}
            ],
            "roofs": [{"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35",
                "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}],
                "shape": "flach", "pitchDeg": 0, "overhang": 0, "ridgeAxis": "x", "baseElevation": 3.0, "thickness": 0.4}]
        }))
        .unwrap();
        // Eine der beiden Blickrichtungen sieht das Dach (die andere schaut weg).
        let mut seen = false;
        for id in ["s", "t"] {
            let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
            let out = compute_section(&p, &LevelSpec::from_json(&serde_json::to_value(l).unwrap()), &[]).unwrap().unwrap();
            let hz = |z: f64| out.visible.iter().any(|e| e.kind == Kind::Roof && (e.a[1] - z).abs() < 1e-6 && (e.b[1] - z).abs() < 1e-6 && (e.a[0] - e.b[0]).abs() > 9.9);
            if hz(3.0) || hz(2.6) {
                assert!(hz(3.0) && hz(2.6), "{id}: Ober- und Unterkante der Stirn");
                seen = true;
            }
        }
        assert!(seen, "Flachdach fehlt im Schnitt");
    }

    /// [148] Flachdach auf L-Umriss: der Schnitt trifft nur die Schenkel, nie die Aussparung (früher
    /// Bounding-Box). Schnitte quer durch beide Schenkel, durch einen Schenkel neben der Aussparung.
    #[test]
    fn flachdach_l_schnitt_durch_die_schenkel() {
        let line = |id: &str, a: (f64, f64), b: (f64, f64)| serde_json::json!({"id": id, "name": id, "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": a.0, "y": a.1}, {"x": b.0, "y": b.1}], "directionSign": 1});
        let p: Project = serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [], "openings": [], "walls": [],
            "drawingLevels": [
                {"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
                line("beide", (4.0, -2.0), (4.0, 9.0)),
                line("oben", (-2.0, 5.0), (14.0, 5.0)),
                line("rechts", (9.5, -2.0), (9.5, 9.0))
            ],
            "roofs": [{"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35",
                "outline": [{"x": 0, "y": 0}, {"x": 11, "y": 0}, {"x": 11, "y": 4}, {"x": 8, "y": 4}, {"x": 8, "y": 6}, {"x": 0, "y": 6}],
                "shape": "flach", "pitchDeg": 0, "overhang": 0, "ridgeAxis": "x", "baseElevation": 3.0, "thickness": 0.4}]
        }))
        .unwrap();
        for (id, len) in [("beide", 6.0), ("oben", 8.0), ("rechts", 4.0)] {
            let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
            let out = compute_section(&p, &LevelSpec::from_json(&serde_json::to_value(l).unwrap()), &[]).unwrap().unwrap();
            let roof: Vec<&Cut> = out.cuts.iter().filter(|c| c.kind == Kind::Roof).collect();
            assert!(!roof.is_empty(), "{id}: Dach geschnitten");
            let us = roof.iter().flat_map(|c| c.pts.iter().map(|q| q[0]));
            let (lo, hi) = us.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), u| (lo.min(u), hi.max(u)));
            assert!(((hi - lo) - len).abs() < 1e-6, "{id}: Schnittlänge {} statt {len}", hi - lo);
            let area: f64 = roof.iter().map(|c| crate::roof_skeleton::signed_area(&c.pts).abs()).sum();
            assert!((area - len * 0.4).abs() < 1e-6, "{id}: Schnittfläche {area}");
        }
    }

}
