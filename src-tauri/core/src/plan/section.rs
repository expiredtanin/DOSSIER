//! Schnitt auf dem Dokument ([K3c]): Rust-Gegenstück zu `src/plan/toSection.ts` (Besitzer-Zuordnung,
//! Schicht-Bänder, Stil-Auflösung, Decken-Terminierung, Dominanz, Treppen, Monolith-Vereinigung,
//! Abzugskörper, Körper, Gelände, Schnitt-Tiefe), `generateSectionPlan` (Primitive mit Pick-Ids) und
//! `sectionOpenings.ts` (geschnittene Fenster/Türen). Der analytische Prismen-Schnitt läuft über
//! `render3d::section::cut_section` (dieselbe Rechnung wie früher im render3d-WASM). Rechenreihenfolge
//! und Zahlsemantik wie in TS (`jsnum`, `jsmath`), damit die Ausgabe bitgleich bleibt.
//!
//! Einheiten: Meter; Ausgabe in (u, v) = (entlang der Ebene, absolute Höhe).

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
const SECTION_CUT_OUTLINE_MM: f64 = 0.35;
const SECTION_VISIBLE_MM: f64 = 0.18;
const SECTION_GROUND_MM: f64 = 0.5;
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
const BODY_FILL: &str = "#d9dde2";

/// Rückfall-Schraffur der Cut-Flächen ohne auflösbares Bauteil.
fn section_hatch() -> HatchRender {
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
}

impl Cut {
    fn new(kind: Kind, index: usize, pts: Vec<[f64; 2]>) -> Cut {
        Cut { kind, index, pts, nse: None, fill: None, hatch: None, join_priority: None, component_id: None, source_id: None, category: None, stair_id: None }
    }
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

fn opening_interval(w: &Wall, o: &Opening) -> Option<(f64, f64)> {
    let axis = hypot2(w.end.x - w.start.x, w.end.y - w.start.y);
    let from = max(0.0, min(o.position, axis));
    let to = max(from, min(o.position + o.width, axis));
    if to - from < 1e-4 {
        return None;
    }
    Some((from, to))
}


/// Senkrechte Kanten eines Bogen-Teilkörpers, die an einer inneren Stossfuge liegen (Ecken auf der
/// Gehrung, in Schnitt-u projiziert), entfallen.
fn drop_arc_seams(visible: Vec<Edge>, hidden: Vec<Edge>, walls_r: &[RWall], base: (f64, f64), u: (f64, f64)) -> (Vec<Edge>, Vec<Edge>) {
    let ul = hypot2(u.0, u.1);
    if !walls_r.iter().any(|r| r.joint != [false; 2]) || !(ul > 1e-12) {
        return (visible, hidden);
    }
    let u = (u.0 / ul, u.1 / ul);
    let seams: HashMap<usize, Vec<f64>> = walls_r
        .iter()
        .enumerate()
        .filter(|(_, r)| r.joint != [false; 2])
        .map(|(i, r)| {
            let (dx, dy) = (r.end[0] - r.start[0], r.end[1] - r.start[1]);
            let l = hypot2(dx, dy).max(1e-12);
            let (ax, ay) = (dx / l, dy / l);
            let (nx, ny) = (ay, -ax);
            let ht = r.thickness / 2.0;
            let sh = super::elevation::corner_shifts(r);
            let mut us = Vec::new();
            for (k, (p, t, s)) in [(r.start, ht, sh[0]), (r.start, -ht, sh[1]), (r.end, ht, sh[2]), (r.end, -ht, sh[3])].into_iter().enumerate() {
                if !r.joint[k / 2] {
                    continue;
                }
                let (x, y) = (p[0] + nx * t + ax * s, p[1] + ny * t + ay * s);
                us.push((x - base.0) * u.0 + (y - base.1) * u.1);
            }
            (i, us)
        })
        .collect();
    // Umriss (Silhouette) bleibt: senkrechte Kanten am äussersten u der ganzen Wand.
    let vertical = |e: &Edge| e.kind == Kind::Wall && (e.a[0] - e.b[0]).abs() < 1e-4 && seams.contains_key(&e.index);
    let mut extent: HashMap<&str, (f64, f64)> = HashMap::new();
    for e in visible.iter().chain(&hidden).filter(|e| vertical(e)) {
        let Some(r) = walls_r.get(e.index) else { continue };
        let x = extent.entry(r.wall_id.as_str()).or_insert((f64::INFINITY, f64::NEG_INFINITY));
        *x = (x.0.min(e.a[0]), x.1.max(e.a[0]));
    }
    let keep = |e: &Edge| {
        if !vertical(e) {
            return true;
        }
        let silhouette = walls_r.get(e.index).and_then(|r| extent.get(r.wall_id.as_str())).is_some_and(|x| (e.a[0] - x.0).abs() < 1e-3 || (e.a[0] - x.1).abs() < 1e-3);
        silhouette || !seams.get(&e.index).is_some_and(|us| us.iter().any(|x| (x - e.a[0]).abs() < 1e-2))
    };
    (visible.into_iter().filter(keep).collect(), hidden.into_iter().filter(keep).collect())
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
    (c.pts.len() >= 3).then(|| bbox(&c.pts))
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
    // [106] Schichteinzug am Sturz (Stück liegt über der Öffnung) bzw. an der Brüstung (darunter).
    let (top, bottom) = section_reveal(p, owner, plane, v_min, v_max);
    let n = layers.len();
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
            c
        };
        let shift = |s: &Option<(f64, Vec<crate::opening_detail::LayerAdjust>)>| s.as_ref().and_then(|(_, v)| v.iter().find(|a| a.layer == li)).map_or(0.0, |a| a.shift);
        let (vb, vt) = (v_min + shift(&top), v_max - shift(&bottom));
        if vt - vb > 1e-6 {
            out.push(mk(vec![[u_left, vt], [u_right, vt], [u_right, vb], [u_left, vb]]));
        }
        // Zusatzstücke dieser Schicht in der Öffnung.
        let u_of = |o: f64| if reversed { u_max - o * scale } else { u_min + o * scale };
        for (side, below) in [(&top, true), (&bottom, false)] {
            let Some((z, adj)) = side else { continue };
            for a in adj.iter().filter(|a| a.layer == li) {
                for pc in &a.pieces {
                    let (z0, z1) = if below { (z - pc[1], z - pc[0]) } else { (z + pc[0], z + pc[1]) };
                    let (ua, ub) = (min(u_of(pc[2]), u_of(pc[3])), max(u_of(pc[2]), u_of(pc[3])));
                    out.push(mk(vec![[ua, z1], [ub, z1], [ub, z0], [ua, z0]]));
                }
            }
        }
    }
    Ok(out)
}

/// Schichteinzug der Öffnung, deren Sturz (unten an `v_min`) bzw. Brüstung (oben an `v_max`) dieses
/// Wandstück ist und die die Schnittebene quert: `(Öffnungs-OK bzw. -UK, Anschlüsse)`.
#[allow(clippy::type_complexity)]
fn section_reveal(p: &Project, wall: &Wall, plane: &Plane, v_min: f64, v_max: f64) -> (Option<(f64, Vec<crate::opening_detail::LayerAdjust>)>, Option<(f64, Vec<crate::opening_detail::LayerAdjust>)>) {
    let (mut top, mut bottom) = (None, None);
    // Bogenwände: kein Schichteinzug ([106] gilt nur gerade).
    if crate::wall_arc::is_arc_bulge(wall.bulge) {
        return (None, None);
    }
    let u_raw = plane.u_model();
    let l = hypot2(u_raw.0, u_raw.1);
    if !(l > 1e-12) {
        return (None, None);
    }
    let u = (u_raw.0 / l, u_raw.1 / l);
    let (a, n) = axis_frame(wall);
    let un = u.0 * n.0 + u.1 * n.1;
    if un.abs() < MIN_CROSS {
        return (None, None);
    }
    let p0 = plane.base();
    let rel = (p0.0 - wall.start.x, p0.1 - wall.start.y);
    let n0 = rel.0 * n.0 + rel.1 * n.1;
    let a0 = rel.0 * a.0 + rel.1 * a.1;
    let ua = u.0 * a.0 + u.1 * a.1;
    let along = a0 + ((0.0 - n0) / un) * ua;
    let (zb, zt) = p.wall_vertical_extent(wall);
    for o in p.openings_of_wall(&wall.id) {
        let Some(r) = crate::opening_detail::opening_reveal(p, wall, o) else { continue };
        if along < r.from + 1e-4 || along > r.to - 1e-4 {
            continue;
        }
        let o_bottom = zb + o.sill_height.max(0.0);
        let o_top = zt.min(o_bottom + o.height);
        let [_, _, t, b] = r.sides;
        if (v_min - o_top).abs() < 1e-3 {
            top = Some((o_top, t));
        }
        if (v_max - o_bottom).abs() < 1e-3 {
            bottom = Some((o_bottom, b));
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
                out.push(Cut { pts: vec![[wb[0], top], [wb[1], top], [wb[1], wb[2]], [wb[0], wb[2]]], ..b });
            }
            continue;
        }
        let mut clip_bottom = f64::NEG_INFINITY;
        for c in &cutters {
            clip_bottom = max(clip_bottom, c.0[3]);
        }
        let bottom = max(clip_bottom, wb[2]);
        if bottom < wb[3] - EPS_T {
            out.push(Cut { pts: vec![[wb[0], wb[3]], [wb[1], wb[3]], [wb[1], bottom], [wb[0], bottom]], ..b });
        }
    }
    out
}

/// `subtractDominantBands` (Rechnung: `plan_section::dominant_bands`).
fn subtract_dominant_bands(bands: Vec<Cut>) -> Vec<Cut> {
    let mut ids: HashMap<&str, usize> = HashMap::new();
    let mut b: Vec<f64> = Vec::with_capacity(1 + 7 * bands.len());
    b.push(bands.len() as f64);
    for band in &bands {
        let r = rect_of_band(band);
        let mut comp = -1.0;
        if let Some(id) = band.component_id.as_deref() {
            let n = ids.len();
            let k = *ids.entry(id).or_insert(n);
            comp = k as f64;
        }
        let r4 = r.unwrap_or([0.0; 4]);
        b.extend([if r.is_some() { 1.0 } else { 0.0 }, r4[0], r4[1], r4[2], r4[3], band.join_priority.unwrap_or(f64::NAN), comp]);
    }
    let f = crate::plan_section::dominant_bands(&b);
    let mut out = Vec::new();
    let Some(&n) = f.first() else { return out };
    let mut i = 1;
    for _ in 0..n as usize {
        let src = &bands[f[i] as usize];
        if f[i + 1] == 0.0 {
            out.push(src.clone());
        } else {
            let mut c = Cut::new(src.kind, src.index, vec![[f[i + 2], f[i + 5]], [f[i + 3], f[i + 5]], [f[i + 3], f[i + 4]], [f[i + 2], f[i + 4]]]);
            c.fill = src.fill.clone();
            c.hatch = src.hatch.clone();
            c.join_priority = src.join_priority;
            c.component_id = src.component_id.clone();
            c.source_id = src.source_id.clone();
            // Herkunft bleibt am Stück (Ebenen-Sichtbarkeit, Treppen-Pick).
            c.category = src.category.clone();
            c.stair_id = src.stair_id.clone();
            out.push(c);
        }
        i += 6;
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
        // Formöffnungen in Bogenwänden bleiben im Schnitt rechteckig ([T2], offen).
        let Some(wall) = p.walls.iter().find(|w| w.id == o.host_wall_id && !crate::wall_arc::is_arc_bulge(w.bulge)) else { continue };
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
        let Some(wall) = p.walls.iter().find(|w| w.id == o.host_wall_id) else { continue };
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
    for (index, roof) in roofs.iter().enumerate() {
        // Verschnittene Dächer und Gauben ([G5]): Schnitt durch die Körper je Schicht.
        if let Some(solids) = crate::roof_assembly::roof_solids(p, index) {
            for part in &solids.parts {
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
        let sg = crate::plan_section::roof_segments(bx, by, ux, uy, &pl);
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
            for layer in &layers {
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

/// `unionRectOutlines` (Rechnung: `plan_section::union_outlines`).
fn union_rect_outlines(rects: &[[f64; 4]]) -> Vec<Vec<[f64; 2]>> {
    let mut b = vec![rects.len() as f64];
    for r in rects {
        b.extend(r);
    }
    let f = crate::plan_section::union_outlines(&b);
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
fn merge_monolith_cuts(cuts: Vec<Cut>, slabs: &[RSlab]) -> Vec<Cut> {
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
    let refs: Vec<&[[f64; 2]]> = rects.iter().map(|r| r.as_slice()).collect();
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
fn append_body_sections(cuts: &mut Vec<Cut>, p: &Project, bodies: &[BodyMesh], base: (f64, f64), u: (f64, f64)) {
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
        if t.positions.len() < 9 {
            continue;
        }
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

/// Tiefe des Erdreich-Bands unter der Geländelinie (m).
const EARTH_BAND: f64 = 1.5;

/// [T6]/[109] Erdreich: Band unter dem gestalteten Terrain mit SIA-Erdreich-Schraffur, ohne das
/// Gebäude-Innere (Grundfläche im Schnitt, von der tiefsten Schnittfläche aufwärts); die geschnittenen
/// Bauteile selbst liegen ohnehin darüber.
fn append_earth(out: &mut Output, p: &Project, base: (f64, f64), u: (f64, f64)) {
    let mut band: Vec<crate::flat::Polygon> = Vec::new();
    for pr in out.profiles.iter().filter(|pr| !pr.natural && pr.pts.len() >= 2) {
        let mut ring = pr.pts.clone();
        ring.extend(pr.pts.iter().rev().map(|q| [q[0], q[1] - EARTH_BAND]));
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

fn centroid(pts: &[Vec2]) -> Option<(f64, f64)> {
    if pts.is_empty() {
        return None;
    }
    let (mut x, mut y) = (0.0, 0.0);
    for q in pts {
        x += q.x;
        y += q.y;
    }
    let n = pts.len() as f64;
    Some((x / n, y / n))
}

/// `filterByDepth`: Ansichtskanten weiter als `depth` hinter der Ebene ausblenden.
fn filter_by_depth(out: &mut Output, p: &Project, plane: &Plane, depth: f64, walls: &[Option<&Wall>], slabs: &[SlabOwner], slabs_r: &[RSlab]) {
    if !(depth > 0.0) {
        return;
    }
    let (nx, ny) = (plane.normal[0], plane.normal[2]);
    let l = hypot2(nx, ny);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let blick = (nx / l, ny / l);
    let origin = plane.base();
    let roofs = p.roofs.as_deref().unwrap_or(&[]);
    let owner_point = |e: &Edge| -> Option<(f64, f64)> {
        match e.kind {
            Kind::Wall => walls.get(e.index).copied().flatten().map(|w| ((w.start.x + w.end.x) / 2.0, (w.start.y + w.end.y) / 2.0)),
            Kind::Slab => match slabs.get(e.index) {
                Some(SlabOwner::Ceiling(c, _)) => centroid(&c.outline),
                // Treppe: Mitte des Tritts bzw. Podests selbst.
                Some(SlabOwner::Stair(_)) => slabs_r.get(e.index).and_then(|s| centroid(&s.outline.iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect::<Vec<_>>())),
                _ => None,
            },
            _ => roofs.get(e.index).and_then(|r| centroid(&r.outline)),
        }
    };
    let keep = |e: &Edge| -> bool {
        match owner_point(e) {
            None => true,
            Some(q) => (q.0 - origin.0) * blick.0 + (q.1 - origin.1) * blick.1 <= depth + 1e-6,
        }
    };
    out.visible.retain(keep);
    out.hidden.retain(keep);
}

// ── Schnitt ───────────────────────────────────────────────────────────────────

/// `computeSection` (ohne den asynchronen Teil: die Körper-Netze kommen fertig aus TS).
pub fn compute_section(p: &Project, level: &LevelSpec, bodies: &[BodyMesh]) -> Result<Option<Output>, String> {
    let Some(plane) = level.plane() else { return Ok(None) };
    let walls_r = model3d::emit_walls(p, false)?;
    let mut slabs_r = model3d::emit_slabs(p);
    slabs_r.extend(model3d::emit_stairs(p, true));
    let wi: Vec<render3d::WallInput> = walls_r.iter().map(wall_input).collect();
    let si: Vec<render3d::SlabInput> = slabs_r.iter().map(slab_input).collect();
    // Die Ebene ging als Zahl-Argument (wasm-bindgen, `Math.fround`) hinein, nicht über JSON.
    let fr = |v: [f64; 3]| [v[0] as f32, v[1] as f32, v[2] as f32];
    let rp = render3d::SectionPlane::new(fr(plane.point), fr(plane.normal));
    // Dächer nicht durch render3d: deren Bänder (je Schicht × Dachfläche, ohne Stil) lagen unter den
    // gestylten aus `append_roof_sections` (doppelte Kontur, Rückfall-Schraffur, Besitzer per Index falsch).
    let raw = render3d::cut_section(&rp, &wi, &si, &[]);

    // Gleiche f32 kommen oft vor (gemeinsame Ecken, Höhen): Umwandlung je Wert nur einmal.
    let mut conv: HashMap<u32, f64> = HashMap::new();
    let mut jf = |x: f32| -> f64 { *conv.entry(x.to_bits()).or_insert_with(|| js_f32(x)) };
    let mut cut_owners: HashSet<(Kind, usize)> = HashSet::new();
    let mut cuts: Vec<Cut> = Vec::with_capacity(raw.cut_polygons.len());
    for cp in &raw.cut_polygons {
        let kind = kind_of(cp.component.kind);
        cut_owners.insert((kind, cp.component.index));
        cuts.push(Cut::new(kind, cp.component.index, cp.pts.iter().map(|q| [jf(q[0]), jf(q[1])]).collect()));
    }
    let mut edge = |e: &render3d::SectionEdge| Edge { kind: kind_of(e.component.kind), index: e.component.index, a: [jf(e.a[0]), jf(e.a[1])], b: [jf(e.b[0]), jf(e.b[1])] };
    let not_cut = |e: &&render3d::SectionEdge| !cut_owners.contains(&(kind_of(e.component.kind), e.component.index));
    let visible: Vec<Edge> = raw.visible_edges.iter().filter(not_cut).map(&mut edge).collect();
    let hidden: Vec<Edge> = raw.hidden_edges.iter().filter(not_cut).map(&mut edge).collect();
    // [T2] Bogenwände: senkrechte Kanten an den inneren Stossfugen der Sehnen-Teilkörper nicht zeigen.
    let (visible, hidden) = drop_arc_seams(visible, hidden, &walls_r, plane.base(), plane.u_model());

    shaped_wall_cuts(&mut cuts, p, &walls_r, plane.base(), plane.u_model());
    let mut cuts = merge_arc_wall_cuts(cuts, p, &walls_r);
    let mut visible = visible;
    shaped_projection(&mut visible, p, &walls_r, &plane);
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
    let cuts = merge_monolith_cuts(cuts, &slabs_r);
    let base = plane.base();
    let u = plane.u_model();
    let cuts = subtract_voids_in_section(cuts, p, base, u);
    let mut cuts = parallel_reveal_cuts(cuts, p, &plane, &walls)?;
    append_body_sections(&mut cuts, p, bodies, base, u);
    let mut out = Output { cuts, visible, hidden, profiles: Vec::new(), earth: Vec::new() };
    append_terrain_profiles(&mut out, p, base, u);
    if let Some(d) = level.depth {
        filter_by_depth(&mut out, p, &plane, d, &walls, &slabs, &slabs_r);
    }
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

/// `generateSectionPlan`: Primitive (u → x, Höhe → y) und Ausmass.
pub fn section_primitives(out: &Output, mono: bool, hidden_lines: bool, vis: &Visibility) -> (Vec<Primitive>, [f64; 4]) {
    let mut prims = Vec::new();
    let mut acc = Acc::new();
    let shown = |code: &str| vis.visible(code) && vis.render(code);
    // [T6] Erdreich zuerst (unter allem), ohne Umriss; Kategorie wie das Gelände.
    let terrain_shown = out.profiles.iter().all(|pr| pr.category.as_deref().is_none_or(shown));
    if terrain_shown {
        for (ring, hatch) in &out.earth {
            let hatch = if mono { HatchRender { color: SECTION_INK.into(), ..hatch.clone() } } else { hatch.clone() };
            prims.push(polygon(ring.iter().map(|q| v2(q[0], q[1])).collect(), "none", "none", 0.0, hatch));
        }
    }
    for cp in &out.cuts {
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
        let (fill, hatch) = if mono {
            let mono_fill = if solid { HATCH_INK } else { HATCH_PAPER };
            let mono_hatch = if !solid && hatch.pattern != HatchPattern::None { HatchRender { color: SECTION_INK.into(), ..hatch } } else { hatch };
            (mono_fill.to_string(), mono_hatch)
        } else {
            (fill.to_string(), hatch)
        };
        let src = cp.source_id.clone();
        let mut pr = polygon(pts, &fill, SECTION_INK, SECTION_CUT_OUTLINE_MM, hatch);
        if let Primitive::Polygon { wall_id, ceiling_id, roof_id, stair_id, extruded_solid_id, no_stroke_edges, greyed, .. } = &mut pr {
            *wall_id = if cp.kind == Kind::Wall { src.clone() } else { None };
            *ceiling_id = if cp.kind == Kind::Slab && cp.stair_id.is_none() { src.clone() } else { None };
            *roof_id = if cp.kind == Kind::Roof { src.clone() } else { None };
            *stair_id = cp.stair_id.clone();
            *extruded_solid_id = if cp.kind == Kind::Body { src } else { None };
            *no_stroke_edges = cp.nse.clone();
            *greyed = Some(cp.category.as_deref().is_some_and(|c| vis.greyed(c)));
        }
        prims.push(pr);
    }
    for pr in &out.profiles {
        if let Some(code) = pr.category.as_deref() {
            if !shown(code) {
                continue;
            }
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
const GLASS_MM: f64 = 0.13;
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
    if let Some(poly) = crate::opening_shape::opening_outline(o, to - from, z_top - z_bottom) {
        let Some((lo, hi)) = crate::opening_shape::v_range(&poly, along - from) else { return Ok(None) };
        (z_bottom, z_top) = (z_bottom + lo, z_bottom + hi);
    }
    if z_top - z_bottom < 1e-3 {
        return Ok(None);
    }
    Ok(Some(CrossSection { n0, un, z_bottom, z_top, face_min: ref_off - total / 2.0, face_max: ref_off + total / 2.0 }))
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
                let mut pack = polygon(rect(c.u_at(s0 + m), c.u_at(s1 - m), c.z_top + m, c.z_top + h * 0.6), SHADING_PACK_FILL, OPENING_INK, GLASS_MM, no_hatch_base());
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

/// Anschlag im Schnitt ([105]/[94]): Wandnase oben (Sturz) und unten (Brüstung) über die Zone
/// zwischen gewählter Fläche und Rahmen, je Wandschicht in deren Schnitt-Darstellung.
fn rebate_cut(p: &Project, wall: &Wall, o: &Opening, c: &CrossSection) -> Result<Vec<Primitive>, String> {
    let mut out = Vec::new();
    let Some(f) = crate::opening_detail::frame_of(p, o) else { return Ok(out) };
    let wt = p.wall_type_or_fallback(wall);
    let total = sum_thickness(&wt.layers);
    let Some((z0, z1)) = f.rebate_zone(total) else { return Ok(out) };
    let h = c.z_top - c.z_bottom;
    let category = p.layer_category(&wall.category_code);
    for (rd, top) in [(f.rebate.top, true), (if o.kind == ElementKind::Door { 0.0 } else { f.rebate.bottom }, false)] {
        let rd = min(rd, h / 3.0);
        if !(rd > 1e-4) {
            continue;
        }
        let (v0, v1) = if top { (c.z_top - rd, c.z_top) } else { (c.z_bottom, c.z_bottom + rd) };
        let mut l0 = 0.0;
        for layer in &wt.layers {
            let l1 = l0 + layer.thickness;
            let (a, b) = (z0.max(l0), z1.min(l1));
            l0 = l1;
            if b - a <= 1e-6 {
                continue;
            }
            let comp = p.component_or_fallback(&layer.component_id);
            let (fill, hatch) = layer_style(p, comp, wall.hatch_id.as_deref(), wall.hatch_source, wall.foreground.as_deref(), wall.foreground_source, wall.background.as_deref(), wall.background_source, category, SECTION_WALL_AXIS_ANGLE_DEG)?;
            let mut pr = polygon(rect(c.u_at(c.face_min + a), c.u_at(c.face_min + b), v0, v1), &fill, OPENING_INK, FRAME_MM, hatch);
            if let Primitive::Polygon { opening_id, .. } = &mut pr {
                *opening_id = Some(o.id.clone());
            }
            out.push(pr);
        }
    }
    Ok(out)
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
        let chord = crate::wall_arc::WallArc::of_wall(wall).map(|a| {
            let axis = a.length();
            let from = max(0.0, min(o.position, axis));
            let to = max(from, min(o.position + o.width, axis));
            let (ps, pe) = (a.point(from, 0.0), a.point(to, 0.0));
            let vw = Wall { start: Vec2 { x: ps.x, y: ps.y }, end: Vec2 { x: pe.x, y: pe.y }, bulge: None, ..wall.clone() };
            let vo = Opening { position: 0.0, width: hypot2(pe.x - ps.x, pe.y - ps.y), ..o.clone() };
            (vw, vo)
        });
        let (wall, o) = match &chord {
            Some((vw, vo)) => (vw, vo),
            None => (wall, o),
        };
        let Some(c) = cross_section(p, wall, o, p0, u)? else { continue };
        let mut prims = if o.kind == ElementKind::Window { window_cut(p, wall, o, &c)? } else { door_cut(p, o, &c) };
        prims.extend(rebate_cut(p, wall, o, &c)?);
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
    static CACHE: std::cell::RefCell<Vec<(f64, std::rc::Rc<Output>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn cache_get(key: f64) -> Option<std::rc::Rc<Output>> {
    if !(key > 0.0) {
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

fn cache_put(key: f64, o: std::rc::Rc<Output>) {
    if !(key > 0.0) {
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
    let mut w = crate::plan_buf::Writer::new(true);
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
    let (prims, bounds) = section_primitives(&out, mono, hidden, &vis);
    w.group(&prims);
    let ops = if openings { section_opening_primitives(p, &level, &vis)? } else { Vec::new() };
    w.group(&ops);
    w.bounds = Some(bounds);
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
        assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { hatch, .. } if hatch.pattern == HatchPattern::Earth)));
        assert!(prims.iter().any(|q| matches!(q, Primitive::Line { cls, dash: Some(Some(_)), .. } if cls == "section-terrain")));
        let (ep, _) = super::super::elevation::elevation_primitives(&p, &level(&p, "ansicht-sued"), false, false, &Visibility::default(), 100.0).unwrap().unwrap();
        let sil: Vec<f64> = ep.iter().filter_map(|q| if let Primitive::Line { cls, a, b, .. } = q { (cls == "elevation-terrain").then_some(a.y.min(b.y)) } else { None }).collect();
        // Die Ansichtslinie (y = −2) liegt in der Böschung: die Silhouette taucht vor dem Gebäude ein, nie unter die Sohle.
        assert!(!sil.is_empty() && sil.iter().all(|z| *z <= 1e-6 && *z >= -2.0 - 1e-6) && sil.iter().any(|z| *z < -0.5), "{sil:?}");
        assert!(ep.iter().any(|q| matches!(q, Primitive::Polygon { fill, .. } if fill == "#ffffff")));
        assert!(!ep.iter().any(|q| matches!(q, Primitive::Line { cls, .. } if cls == "elevation-ground")));
        let f = crate::site_rules::facade_terrain(&p);
        assert!(!f.is_empty() && f.iter().all(|q| q.natural == Some(0.0) && q.designed.is_some_and(|z| (z + 2.0).abs() < 1e-6)));
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
        let (prims, groups, bounds) = crate::plan_buf::decode(&buf).unwrap();
        assert_eq!(groups.len(), 2);
        assert!(bounds.is_some() && !prims.is_empty());
        // Ohne Schnittlinie: leerer Puffer ohne Gruppen.
        let none = section_plan_buf(&p, &[0.0, 0.0], r#"{"level":{"kind":"section"}}"#).unwrap();
        assert!(crate::plan_buf::decode(&none).unwrap().1.is_empty());
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
            let raw = render3d::cut_section(&render3d::SectionPlane::new(fr(pl.point), fr(pl.normal)), &wi, &si, &[]);
            let t_cut = t.elapsed();
            let t = Instant::now();
            let buf = if l.kind == DrawingLevelKind::Section {
                section_plan_buf(&p, &[0.0, 1.0, 0.0, 0.0], &serde_json::json!({ "level": serde_json::to_value(l).unwrap() }).to_string()).unwrap()
            } else {
                crate::plan::elevation::elevation_plan_buf(&p, &[0.0, 0.0], &serde_json::json!({ "level": serde_json::to_value(l).unwrap() }).to_string()).unwrap()
            };
            let t_all = t.elapsed();
            println!(
                "{} {:?}: Wände {:?} Platten/Dach {:?} Umwandlung {:?} cut_section {:?} ({} Cut, {} Kanten) | gesamt {:?} ({} Bytes)",
                l.id, l.kind, t_walls, t_rest, t_conv, t_cut, raw.cut_polygons.len(), raw.visible_edges.len() + raw.hidden_edges.len(), t_all, buf.len()
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
        let out = merge_monolith_cuts(vec![mk(0, 0.0), mk(1, 0.0), mk(2, 0.5)], &slabs);
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

    #[test]
    fn tiefe_blendet_ferne_kanten_aus() {
        let mut p = Project::default();
        p.walls = vec![
            Wall { id: "nah".into(), start: Vec2 { x: 0.0, y: 1.0 }, end: Vec2 { x: 4.0, y: 1.0 }, ..Default::default() },
            Wall { id: "fern".into(), start: Vec2 { x: 0.0, y: 9.0 }, end: Vec2 { x: 4.0, y: 9.0 }, ..Default::default() },
        ];
        let walls: Vec<Option<&Wall>> = p.walls.iter().map(Some).collect();
        let plane = Plane { point: [0.0, 0.0, 0.0], normal: [0.0, 0.0, 1.0] };
        let e = |i: usize| Edge { kind: Kind::Wall, index: i, a: [0.0, 0.0], b: [1.0, 0.0] };
        let mut out = Output { visible: vec![e(0), e(1)], hidden: vec![e(1)], ..Default::default() };
        filter_by_depth(&mut out, &p, &plane, 3.0, &walls, &[], &[]);
        assert_eq!(out.visible.len(), 1);
        assert_eq!(out.visible[0].index, 0);
        assert!(out.hidden.is_empty());
        let mut all = Output { visible: vec![e(0), e(1)], ..Default::default() };
        filter_by_depth(&mut all, &p, &plane, 0.0, &walls, &[], &[]);
        assert_eq!(all.visible.len(), 2, "Tiefe 0 ist kein Filter");
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
