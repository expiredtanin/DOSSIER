//! IFC-Import zu echten Bauteilen ([B4], [K4] S4; vorher `io/ifcElements.ts`): baut aus dem, was das
//! Format-Modul erkannt hat (`fileio/src/ifc_semantic.rs`: Achse, Dicke, Höhe, Umriss … in Metern; dazu Dächer
//! auch mit Neigung je Kante, Treppen gerade/L/Wendel, Träger als Extrusionskörper, gedrehte Georeferenz),
//! Dossier-Objekte — Geschosse, Wände (Wandtyp aus den Materialschichten, wiederverwendet oder neu),
//! Türen/Fenster/Wanddurchbrüche, Decken (Deckentyp), Stützen, Räume; der Rest kommt als Kontext-Mesh
//! (`import_context`). Ergebnis sind Ops auf dem Projekt (ein Undo-Schritt) und eine Zusammenfassung.
//!
//! Zuordnung wie in der TS-Fassung: Geschoss nach Höhe (±5 mm) wiederverwenden oder anlegen, Wand- und
//! Deckentypen nach Schichten (Material + Dicke, ±0.5 mm), Materialien nach Namen; Zahlen auf 1e-9 m bzw.
//! 1e-6 gerundet (`Math.round(x / step) * step`).

use crate::json_util::js_num;
use crate::import_context::{color_hex, color_of, context_ops, geo_shift, ifc_meshes, project_geo_origin, stamp36, IfcProduct};
use crate::import_drawing::next_seq;
use crate::js_fmt::js_number;
use crate::jsnum;
use crate::ops::Op;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

const WALL_CATEGORY: &str = "20";
const OPENING_CATEGORY: &str = "21";
const CEILING_CATEGORY: &str = "30";
const COLUMN_CATEGORY: &str = "50";
const ROOM_CATEGORY: &str = "60";
const ROOF_CATEGORY: &str = "35";
const STAIR_CATEGORY: &str = "40";
const ROOM_COLOR: &str = "#6b7280";
const SIA: [&str; 6] = ["HNF", "NNF", "VF", "FF", "KGF", "AGF"];
const LEVEL_TOL: f64 = 0.005;
const LAYER_TOL: f64 = 0.0005;

fn round(x: f64, step: f64) -> f64 {
    jsnum::round(x / step) * step
}

// ── Erkannte Bauteile ────────────────────────────────────────────────────────

struct MatLayer {
    material: String,
    thickness: f64,
    color: Option<Vec<f64>>,
}

struct Info {
    storey: Option<usize>,
    color: Option<Vec<f64>>,
    type_name: Option<String>,
    layers: Vec<MatLayer>,
    classified: bool,
    /// Eigenschaften aus `Pset_*Common` (Text).
    common: Map<String, Value>,
}

impl Info {
    fn flag(&self, key: &str) -> Option<bool> {
        match self.common.get(key).and_then(Value::as_str) {
            Some("true") => Some(true),
            Some("false") => Some(false),
            _ => None,
        }
    }
    fn text(&self, key: &str) -> Option<String> {
        self.common.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    }
}

struct WallData {
    info: Info,
    start: [f64; 2],
    end: [f64; 2],
    z0: f64,
    z1: f64,
    thickness: f64,
    /// Bogenwand ([T2]), 0 = gerade.
    bulge: f64,
}

struct OpeningData {
    info: Info,
    host: usize,
    kind: String,
    position: f64,
    width: f64,
    sill: f64,
    height: f64,
    operation: Option<String>,
    swing: f64,
    hinge: f64,
    /// Umriss in der Wandebene (`Opening.shape`), z. B. "rund".
    shape: Option<String>,
}

struct SlabData {
    info: Info,
    outline: Vec<[f64; 2]>,
    holes: Vec<Vec<[f64; 2]>>,
    z0: f64,
    z1: f64,
}

struct ColumnData {
    info: Info,
    center: [f64; 2],
    rotation: f64,
    round: bool,
    a: f64,
    b: f64,
    z0: f64,
    z1: f64,
}

struct SpaceData {
    info: Info,
    name: Option<String>,
    long_name: Option<String>,
    sia: Option<String>,
    boundary: Vec<[f64; 2]>,
    z0: f64,
}

struct RoofData {
    info: Info,
    outline: Vec<[f64; 2]>,
    shape: String,
    ridge_axis: String,
    pitch_deg: f64,
    eave_z: f64,
    thickness: f64,
    /// Neigung je Umrisskante (`None` = Giebel); gilt, wenn `custom` (Form dann Sattel bzw. Walm).
    edge_pitch: Vec<Option<f64>>,
    custom: bool,
}

struct StairData {
    info: Info,
    /// "straight", "L", "spiral", "U", "straightLanding".
    shape: String,
    start: [f64; 2],
    dir: [f64; 2],
    run_length: f64,
    width: f64,
    step_count: f64,
    z0: f64,
    total_rise: f64,
    run2_length: f64,
    turn: f64,
    center: [f64; 2],
    radius: f64,
    sweep: f64,
    center_column: f64,
    /// [151] U: Treppenauge; U/gerade mit Podest: Podesttiefe; Tritte Lauf 1 (0 = nach Lauflängen); U:
    /// Tritte Mittellauf (0 = Halbpodest), Versatz des letzten Laufs.
    gap: f64,
    landing_length: f64,
    run1_steps: f64,
    mid_steps: f64,
    run2_offset: f64,
    mid_offset: f64,
}

/// Träger als senkrechtes Prisma → Extrusionskörper.
struct BeamData {
    info: Info,
    outline: Vec<[f64; 2]>,
    z0: f64,
    z1: f64,
}

struct Storey {
    name: String,
    elevation: f64,
}

#[derive(Default)]
struct Elements {
    storeys: Vec<Storey>,
    walls: Vec<WallData>,
    openings: Vec<OpeningData>,
    slabs: Vec<SlabData>,
    columns: Vec<ColumnData>,
    spaces: Vec<SpaceData>,
    roofs: Vec<RoofData>,
    stairs: Vec<StairData>,
    beams: Vec<BeamData>,
    kept: Map<String, Value>,
    /// Je Klasse die Gründe, weshalb Kandidaten Mesh blieben (`{"IfcWall": {"slopedTop": 3}}`).
    kept_reasons: Map<String, Value>,
}

fn s_of(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string)
}

fn info_of(e: &Value) -> Info {
    let layers = e
        .get("layers")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|l| MatLayer {
                    material: s_of(l.get("material")).unwrap_or_default(),
                    thickness: l.get("thickness").and_then(Value::as_f64).unwrap_or(f64::NAN),
                    color: color_of(l.get("color")),
                })
                .collect()
        })
        .unwrap_or_default();
    Info {
        storey: e.get("storey").and_then(Value::as_f64).filter(|s| *s >= 0.0 && s.fract() == 0.0).map(|s| s as usize),
        color: color_of(e.get("color")),
        type_name: s_of(e.get("typeName")),
        layers,
        classified: e.get("classifications").and_then(Value::as_array).is_some_and(|a| !a.is_empty()),
        common: e.get("common").and_then(Value::as_object).cloned().unwrap_or_default(),
    }
}

/// Ringe ab `start` (je Anzahl + Punkte); `None` bei kaputten Daten.
fn rings(v: &[f64], start: usize, count: f64) -> Option<Vec<Vec<[f64; 2]>>> {
    let mut out = Vec::new();
    let mut i = start;
    let mut r = 0.0;
    while r < count {
        let n = *v.get(i)?;
        i += 1;
        if !(n >= 3.0) || i as f64 + 2.0 * n > v.len() as f64 {
            return None;
        }
        let n = n as usize;
        out.push((0..n).map(|k| [v[i + 2 * k], v[i + 2 * k + 1]]).collect());
        i += 2 * n;
        r += 1.0;
    }
    Some(out)
}

/// Erkannte Bauteile aus dem Bericht (`meta.elements`) und den Zahlen (vorher `decodeIfcElements`).
fn decode_elements(meta: &Value, data: &[f64]) -> Elements {
    let mut out = Elements::default();
    let Some(raw) = meta.get("elements") else { return out };
    out.storeys = raw
        .get("storeys")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|s| Storey { name: s_of(s.get("name")).unwrap_or_default(), elevation: s.get("elevation").and_then(Value::as_f64).unwrap_or(f64::NAN) })
                .collect()
        })
        .unwrap_or_default();
    out.kept = raw.get("kept").and_then(Value::as_object).cloned().unwrap_or_default();
    out.kept_reasons = raw.get("keptReasons").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut wall_index: HashMap<i64, usize> = HashMap::new();
    let mut rust_wall: i64 = 0;
    for e in raw.get("elements").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let kind = e.get("kind").and_then(Value::as_str).unwrap_or("");
        let at = e.get("at").and_then(Value::as_f64).unwrap_or(-1.0);
        let n = e.get("n").and_then(Value::as_f64).unwrap_or(-1.0);
        let ok = at >= 0.0 && n >= 0.0 && at.fract() == 0.0 && n.fract() == 0.0 && (at + n) as usize <= data.len();
        let v: &[f64] = if ok { &data[at as usize..(at + n) as usize] } else { &[] };
        if !ok || !v.iter().all(|x| x.is_finite()) {
            if kind == "wall" {
                rust_wall += 1;
            }
            continue;
        }
        let info = info_of(e);
        match kind {
            "wall" => {
                if v.len() == 7 || v.len() == 8 {
                    wall_index.insert(rust_wall, out.walls.len());
                    let bulge = v.get(7).copied().filter(|b| b.abs() <= 1e6).unwrap_or(0.0);
                    out.walls.push(WallData { info, start: [v[0], v[1]], end: [v[2], v[3]], z0: v[4], z1: v[5], thickness: v[6], bulge });
                }
                rust_wall += 1;
            }
            "opening" => {
                let host = e.get("host").and_then(Value::as_f64).unwrap_or(-1.0);
                let host = if host.fract() == 0.0 { wall_index.get(&(host as i64)).copied() } else { None };
                if let (Some(host), 6) = (host, v.len()) {
                    out.openings.push(OpeningData {
                        info,
                        host,
                        kind: s_of(e.get("openingKind")).unwrap_or_else(|| "hole".into()),
                        position: v[0],
                        width: v[1],
                        sill: v[2],
                        height: v[3],
                        operation: s_of(e.get("operation")),
                        swing: v[4].signum() * (v[4] != 0.0) as u8 as f64,
                        hinge: v[5].signum() * (v[5] != 0.0) as u8 as f64,
                        shape: s_of(e.get("shape")),
                    });
                }
            }
            "slab" => {
                if let Some(r) = v.get(2).and_then(|&c| rings(v, 3, c)) {
                    if let Some((outline, holes)) = r.split_first() {
                        out.slabs.push(SlabData { info, z0: v[0], z1: v[1], outline: outline.clone(), holes: holes.to_vec() });
                    }
                }
            }
            "column" => {
                if v.len() == 7 {
                    let round = e.get("profile").and_then(Value::as_str) == Some("round");
                    out.columns.push(ColumnData { info, center: [v[0], v[1]], rotation: v[2], z0: v[3], z1: v[4], round, a: v[5], b: v[6] });
                }
            }
            "roof" => {
                if let Some(mut r) = rings(v, 3, 1.0) {
                    let shape = s_of(e.get("shape")).filter(|x| ["flach", "pult", "sattel", "walm"].contains(&x.as_str()));
                    let axis = s_of(e.get("ridgeAxis")).filter(|x| x == "x" || x == "y");
                    let outline = r.remove(0);
                    // Neigung je Kante: Zahl ≥ 0 (Traufe) oder null (Giebel), eine je Umrisskante.
                    let edge_pitch: Option<Vec<Option<f64>>> = e.get("edgePitch").and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_f64().filter(|p| p.is_finite() && *p >= 0.0 && *p < 89.0)).collect());
                    let edge_pitch = edge_pitch.filter(|a| a.len() == outline.len()).unwrap_or_default();
                    let custom = e.get("custom").and_then(Value::as_bool).unwrap_or(false) && !edge_pitch.is_empty();
                    if let (Some(shape), Some(ridge_axis)) = (shape, axis) {
                        out.roofs.push(RoofData { info, outline, shape, ridge_axis, eave_z: v[0], pitch_deg: v[1], thickness: v[2], edge_pitch, custom });
                    }
                }
            }
            "stair" => {
                let shape = s_of(e.get("shape")).unwrap_or_else(|| "straight".into());
                let ok = (v.len() == 9 || v.len() == 16 || v.len() == 21 || v.len() == 22) && v[6] >= 2.0 && v[6] <= 200.0 && v[4] > 0.0 && v[5] > 0.0;
                let x = |i: usize| v.get(i).copied().unwrap_or(0.0);
                let shape_ok = match shape.as_str() {
                    "straight" => true,
                    "L" => x(9) > 0.0 && x(10).abs() == 1.0,
                    "spiral" => x(13) > 0.0 && x(14) != 0.0 && x(14).abs() <= 3600.0,
                    "U" => x(9) > 0.0 && x(10).abs() == 1.0 && x(16) >= 0.0 && x(17) > 0.0 && x(19) >= 0.0 && x(18) + x(19) < v[6],
                    "straightLanding" => x(9) > 0.0 && x(17) > 0.0 && x(18) < v[6],
                    _ => false,
                };
                if ok && shape_ok {
                    out.stairs.push(StairData {
                        info,
                        shape,
                        start: [v[0], v[1]],
                        dir: [v[2], v[3]],
                        run_length: v[4],
                        width: v[5],
                        step_count: v[6].round(),
                        z0: v[7],
                        total_rise: v[8],
                        run2_length: x(9),
                        turn: x(10),
                        center: [x(11), x(12)],
                        radius: x(13),
                        sweep: x(14),
                        center_column: x(15),
                        gap: x(16),
                        landing_length: x(17),
                        run1_steps: x(18).round(),
                        mid_steps: x(19).round(),
                        run2_offset: x(20),
                        mid_offset: x(21),
                    });
                }
            }
            "beam" => {
                if let (Some(mut r), true) = (rings(v, 2, 1.0), v.len() >= 2 && v[1] > v[0]) {
                    out.beams.push(BeamData { info, outline: r.remove(0), z0: v[0], z1: v[1] });
                }
            }
            "space" => {
                if let Some(mut r) = rings(v, 2, 1.0) {
                    out.spaces.push(SpaceData {
                        info,
                        name: s_of(e.get("name")),
                        long_name: s_of(e.get("longName")),
                        sia: s_of(e.get("sia")),
                        z0: v[0],
                        boundary: r.remove(0),
                    });
                }
            }
            _ => {}
        }
    }
    out
}

// ── Aufbau ───────────────────────────────────────────────────────────────────

/// Optionen: Dateiname (Namen der Kontext-Meshes), Gruppierung der Meshes.
#[derive(serde::Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct IfcOptions {
    pub file_name: String,
    pub group: Option<String>,
    /// Bauteile erkennen ([B4]); sonst nur Kontext-Meshes ([B3]).
    pub elements: bool,
}

pub struct IfcResult {
    pub ops: Vec<Op>,
    /// Zusammenfassung (nur mit `elements`).
    pub summary: Option<Value>,
    /// Bericht des Lesers (ohne Bauteil-Liste), Bauteile je Klasse, Dreiecke.
    pub report: Value,
    pub kept: Map<String, Value>,
    pub context_objects: usize,
}

fn floor_base(l: &Value) -> f64 {
    l.get("baseElevation").and_then(Value::as_f64).unwrap_or(0.0)
}

fn is_floor(l: &Value) -> bool {
    l.get("kind").and_then(Value::as_str) == Some("floor")
}

fn id_of(v: &Value) -> &str {
    v.get("id").and_then(Value::as_str).unwrap_or("")
}

fn pt(p: [f64; 2]) -> Value {
    json!({"x": js_num(p[0]), "y": js_num(p[1])})
}

/// Ops für eine Liste, an die nur neue Elemente (`is_new`) angefügt bzw. eingeschoben wurden (`fieldOps`).
fn grown_list_ops(key: &str, old: Option<&Value>, list: Vec<(Value, bool)>) -> Vec<Op> {
    let unique_ids = |a: &[Value]| {
        let mut seen = HashSet::new();
        a.iter().all(|e| e.get("id").and_then(Value::as_str).is_some_and(|id| seen.insert(id.to_string())))
    };
    match old.and_then(Value::as_array) {
        Some(a) if unique_ids(a) => {
            let mut ops = Vec::new();
            let mut i = 0;
            while i < list.len() {
                if !list[i].1 {
                    i += 1;
                    continue;
                }
                let at = i;
                let mut run = Vec::new();
                while i < list.len() && list[i].1 {
                    run.push(list[i].0.clone());
                    i += 1;
                }
                ops.push(Op::Add { collection: key.into(), items: run, at: Some(at) });
            }
            ops
        }
        _ => {
            if old.is_some_and(|o| o.as_array().is_some()) && !list.iter().any(|x| x.1) {
                return Vec::new();
            }
            vec![Op::SetField { key: key.into(), value: Some(Value::Array(list.into_iter().map(|x| x.0).collect())), at: None }]
        }
    }
}

struct Ctx<'a> {
    stamp: String,
    summary: Map<String, Value>,
    levels: Vec<(Value, bool)>,
    components: Vec<(Value, bool)>,
    hatch_id: String,
    root: &'a Map<String, Value>,
}

impl Ctx<'_> {
    fn new_id(&self, kind: &str) -> String {
        format!("ifc-{kind}-{}-{}", self.stamp, next_seq())
    }
    fn bump(&mut self, k: &str) {
        let n = self.summary.get(k).and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
        self.summary.insert(k.into(), js_num(n));
    }
    /// Geschosse aufsteigend nach Höhe (Index in `levels`), stabil.
    fn floors_sorted(&self) -> Vec<usize> {
        let mut f: Vec<usize> = (0..self.levels.len()).filter(|&i| is_floor(&self.levels[i].0)).collect();
        f.sort_by(|&a, &b| floor_base(&self.levels[a].0).partial_cmp(&floor_base(&self.levels[b].0)).unwrap_or(std::cmp::Ordering::Equal));
        f
    }
    fn component_for(&mut self, name: &str, color: Option<String>) -> String {
        let key = name.trim().to_lowercase();
        if let Some((c, _)) = self.components.iter().find(|(c, _)| c.get("name").and_then(Value::as_str).unwrap_or("").trim().to_lowercase() == key) {
            return id_of(c).to_string();
        }
        let id = self.new_id("component");
        let n = if name.trim().is_empty() { "IFC".to_string() } else { name.trim().to_string() };
        self.components.push((json!({"id": id, "name": n, "color": color.unwrap_or_else(|| "#b0b0b0".into()), "hatchId": self.hatch_id, "joinPriority": 50}), true));
        self.bump("components");
        id
    }
    fn component_name(&self, id: &str) -> String {
        self.components.iter().find(|(c, _)| id_of(c) == id).and_then(|(c, _)| c.get("name").and_then(Value::as_str)).unwrap_or("").trim().to_lowercase()
    }
}

struct Spec {
    material: String,
    thickness: f64,
    color: Option<String>,
}

fn layer_spec(e: &Info, t: f64) -> Vec<Spec> {
    let ls = &e.layers;
    let sum = ls.iter().fold(0.0, |s, l| s + l.thickness);
    if !ls.is_empty() && ls.iter().all(|l| l.thickness > 0.0) && (sum - t).abs() <= 0.005 {
        return ls.iter().map(|l| Spec { material: l.material.clone(), thickness: round(l.thickness, 1e-6), color: color_hex(l.color.as_deref()) }).collect();
    }
    let first = if ls.len() == 1 { Some(&ls[0]) } else { None };
    let color = first.and_then(|f| f.color.as_deref()).or(e.color.as_deref());
    vec![Spec { material: first.map(|f| f.material.clone()).unwrap_or_default(), thickness: round(t, 1e-6), color: color_hex(color) }]
}

fn type_name(e: &Info, t: f64) -> String {
    match e.type_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => n.to_string(),
        None => format!("IFC {} cm", js_number(round(t * 100.0, 0.1))),
    }
}

/// Wand- bzw. Deckentyp mit diesen Schichten (vorhanden oder neu); `kind` = `walltype`/`ceilingtype`.
fn type_for(ctx: &mut Ctx, types: &mut Vec<(Value, bool)>, e: &Info, t: f64, kind: &str, counter: &str) -> String {
    let spec = layer_spec(e, t);
    let name = type_name(e, t);
    let any_material = spec.iter().any(|l| !l.material.is_empty());
    let found = types.iter().find(|(ty, _)| {
        let have = ty.get("layers").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let same = have.len() == spec.len()
            && have.iter().zip(&spec).all(|(l, w)| {
                let th = l.get("thickness").and_then(Value::as_f64).unwrap_or(f64::NAN);
                if (th - w.thickness).abs() > LAYER_TOL {
                    return false;
                }
                let cname = ctx.component_name(l.get("componentId").and_then(Value::as_str).unwrap_or(""));
                w.material.is_empty() || cname == w.material.trim().to_lowercase()
            });
        same && (any_material || ty.get("name").and_then(Value::as_str) == Some(name.as_str()))
    });
    if let Some((ty, _)) = found {
        return id_of(ty).to_string();
    }
    let id = ctx.new_id(kind);
    let layers: Vec<Value> = spec.into_iter().map(|l| json!({"componentId": ctx.component_for(&l.material, l.color), "thickness": js_num(l.thickness)})).collect();
    types.push((json!({"id": id, "name": name, "layers": layers}), true));
    ctx.bump(counter);
    id
}

/// Allgemeiner Name eines Tür-/Fensterstils (eigener Export: "Tür", "Fenster SINGLE_PANEL" …).
fn generic_fill_name(n: &str) -> bool {
    let rest = n.strip_prefix("Tür").or_else(|| n.strip_prefix("Fenster")).or_else(|| n.strip_prefix("Door")).or_else(|| n.strip_prefix("Window"));
    rest.is_some_and(|r| r.is_empty() || (r.starts_with(' ') && r.trim().chars().all(|c| c.is_ascii_uppercase() || c == '_')))
}

/// Tür-/Fenstertyp nach Namen: vorhanden (ohne Gross-/Kleinschreibung) oder neu als Kopie von `template`.
fn typed_by_name(ctx: &mut Ctx, types: &mut Vec<(Value, bool)>, name: Option<&str>, template: Option<&Value>, kind: &str, counter: &str) -> Option<String> {
    let Some(name) = name else { return template.and_then(|t| t.get("id")).and_then(Value::as_str).map(str::to_string) };
    let key = name.to_lowercase();
    if let Some((t, _)) = types.iter().find(|(t, _)| t.get("name").and_then(Value::as_str).is_some_and(|n| n.trim().to_lowercase() == key)) {
        return Some(id_of(t).to_string());
    }
    let mut t = template?.clone();
    let id = ctx.new_id(kind);
    t["id"] = id.clone().into();
    t["name"] = name.into();
    types.push((t, true));
    ctx.bump(counter);
    Some(id)
}

fn list_of(root: &Map<String, Value>, key: &str) -> Vec<(Value, bool)> {
    root.get(key).and_then(Value::as_array).map(|a| a.iter().map(|v| (v.clone(), false)).collect()).unwrap_or_default()
}

/// Bauteile + übrige Kontext-Meshes ins Projekt `root` (vorher `ifcElementsToProject`).
fn elements_ops(root: &Map<String, Value>, meta: &Value, products: &[IfcProduct], el: &Elements, opts: &IfcOptions, now: f64) -> (Vec<Op>, Value, usize) {
    let kept: f64 = el.kept.values().map(|v| v.as_f64().unwrap_or(f64::NAN)).sum();
    let mut summary = Map::new();
    for k in ["walls", "openings", "ceilings", "columns", "rooms", "roofs", "stairs", "beams", "floors", "wallTypes", "ceilingTypes", "roofTypes", "doorTypes", "windowTypes", "components", "meshes", "classified"] {
        summary.insert(k.into(), 0.into());
    }
    summary.insert("kept".into(), js_num(kept));
    summary.insert("keptReasons".into(), Value::Object(el.kept_reasons.clone()));
    let hatches = root.get("hatches").and_then(Value::as_array).cloned().unwrap_or_default();
    let hatch_id = hatches.iter().find(|h| id_of(h) == "none").or(hatches.first()).and_then(|h| h.get("id").and_then(Value::as_str)).unwrap_or("none").to_string();
    let mut ctx = Ctx { stamp: stamp36(now), summary, levels: list_of(root, "drawingLevels"), components: list_of(root, "components"), hatch_id, root };

    // Verschiebung bei Landeskoordinaten: gemeinsam für Bauteile und Meshes.
    let mut extra = Vec::new();
    for w in &el.walls {
        extra.extend([w.start[0], w.start[1], w.end[0], w.end[1]]);
    }
    for s in &el.slabs {
        s.outline.iter().for_each(|p| extra.extend(p));
    }
    for c in &el.columns {
        extra.extend(c.center);
    }
    for s in &el.spaces {
        s.boundary.iter().for_each(|p| extra.extend(p));
    }
    for r in &el.roofs {
        r.outline.iter().for_each(|p| extra.extend(p));
    }
    for s in &el.stairs {
        extra.extend(s.start);
    }
    for b in &el.beams {
        b.outline.iter().for_each(|p| extra.extend(p));
    }
    let [dx, dy] = map_shift(meta, root).unwrap_or_else(|| geo_shift(products, project_geo_origin(root), &extra));
    let mv = |p: [f64; 2]| pt([round(p[0] + dx, 1e-9), round(p[1] + dy, 1e-9)]);

    // ── Geschosse ──
    let mut top_of: HashMap<usize, f64> = HashMap::new();
    for (s, z) in el.walls.iter().map(|w| (w.info.storey, w.z1)).chain(el.columns.iter().map(|c| (c.info.storey, c.z1))) {
        if let Some(s) = s {
            let t = top_of.get(&s).copied().unwrap_or(f64::NEG_INFINITY);
            top_of.insert(s, jsnum::max(t, z));
        }
    }
    let mut storey_floor: Vec<String> = Vec::new();
    for (i, s) in el.storeys.iter().enumerate() {
        if let Some((l, _)) = ctx.levels.iter().find(|(l, _)| is_floor(l) && (floor_base(l) - s.elevation).abs() <= LEVEL_TOL) {
            storey_floor.push(id_of(l).to_string());
            continue;
        }
        let height = match (el.storeys.get(i + 1), top_of.get(&i)) {
            (Some(next), _) => next.elevation - s.elevation,
            (None, Some(&top)) if top > s.elevation + 0.5 => top - s.elevation,
            _ => 2.6,
        };
        let id = ctx.new_id("floor");
        let name = if s.name.is_empty() { format!("IFC {}", js_number(round(s.elevation, 0.001))) } else { s.name.clone() };
        let level = json!({
            "id": id, "name": name, "kind": "floor", "visible": true, "locked": false,
            "floorHeight": js_num(round(height, 1e-6)), "cutHeight": 1, "baseElevation": js_num(round(s.elevation, 1e-6)),
        });
        let floors = ctx.floors_sorted();
        let higher = floors.iter().find(|&&f| floor_base(&ctx.levels[f].0) > s.elevation).copied();
        let at = match (higher, floors.last()) {
            (Some(h), _) => h,
            (None, Some(&last)) => last + 1,
            (None, None) => 0,
        };
        ctx.levels.insert(at, (level, true));
        ctx.bump("floors");
        storey_floor.push(id);
    }
    // Geschoss eines Bauteils: aus der Datei, sonst das höchste mit OK FB ≤ Unterkante. Ergebnis: (id, Basis, Höhe).
    let floor_of = |ctx: &mut Ctx, storey: Option<usize>, z0: f64| -> (String, f64, f64) {
        let fields = |l: &Value| (id_of(l).to_string(), floor_base(l), l.get("floorHeight").and_then(Value::as_f64).unwrap_or(0.0));
        if let Some(id) = storey.and_then(|s| storey_floor.get(s)) {
            if let Some((l, _)) = ctx.levels.iter().find(|(l, _)| id_of(l) == id) {
                return fields(l);
            }
        }
        let floors = ctx.floors_sorted();
        let below: Vec<usize> = floors.iter().copied().filter(|&f| floor_base(&ctx.levels[f].0) <= z0 + LEVEL_TOL).collect();
        if let Some(&f) = below.last().or(floors.first()) {
            return fields(&ctx.levels[f].0);
        }
        let id = ctx.new_id("floor");
        let level = json!({"id": id, "name": "IFC", "kind": "floor", "visible": true, "locked": false, "floorHeight": 2.6, "cutHeight": 1, "baseElevation": 0});
        let out = fields(&level);
        ctx.levels.push((level, true));
        ctx.bump("floors");
        out
    };
    let anchor_offset = |z: f64, base: f64| round(z - base, 1e-6);

    // ── Typen ──
    let mut wall_types = list_of(root, "wallTypes");
    let mut ceiling_types = list_of(root, "ceilingTypes");

    // ── Wände und Öffnungen ──
    let mut walls: Vec<Value> = Vec::new();
    for w in &el.walls {
        let (fid, base, _) = floor_of(&mut ctx, w.info.storey, w.z0);
        let height = round(w.z1 - w.z0, 1e-6);
        let bottom = anchor_offset(w.z0, base);
        let id = ctx.new_id("wall");
        let wt = type_for(&mut ctx, &mut wall_types, &w.info, w.thickness, "walltype", "wallTypes");
        let mut o = json!({"id": id, "type": "wall", "floorId": fid, "categoryCode": WALL_CATEGORY, "start": mv(w.start), "end": mv(w.end), "wallTypeId": wt, "height": js_num(height)});
        if w.bulge.abs() > 1e-9 {
            o["bulge"] = js_num(round(w.bulge, 1e-9));
        }
        if bottom.abs() > LEVEL_TOL {
            o["bottom"] = json!({"mode": "floor", "floorId": fid, "offset": js_num(bottom)});
        }
        if let Some(b) = w.info.flag("IsExternal") {
            o["isExternal"] = b.into();
        }
        if let Some(b) = w.info.flag("LoadBearing") {
            o["loadBearing"] = b.into();
        }
        walls.push(o);
    }
    let mut door_types: Vec<(Value, bool)> = list_of(root, "doorTypes");
    let mut window_types: Vec<(Value, bool)> = list_of(root, "windowTypes");
    let mut openings: Vec<Value> = Vec::new();
    for o in &el.openings {
        let Some(host) = walls.get(o.host) else { continue };
        let kind = if o.kind == "window" { "window" } else { "door" };
        let op = o.operation.as_deref().unwrap_or("");
        let sliding = op.contains("SLIDING");
        let leaves = if op.starts_with("DOUBLE_DOOR") { 2.0 } else { 1.0 };
        let door_type = (!op.is_empty())
            .then(|| {
                door_types.iter().map(|x| &x.0).find(|t| {
                    t.get("kind").and_then(Value::as_str) == Some(if sliding { "schiebe" } else { "dreh" }) && t.get("leafCount").and_then(Value::as_f64) == Some(leaves)
                })
            })
            .flatten()
            .or(door_types.first().map(|x| &x.0))
            .cloned();
        let wings: Option<f64> = match op {
            "SINGLE_PANEL" => Some(1.0),
            "DOUBLE_PANEL_VERTICAL" => Some(2.0),
            "TRIPLE_PANEL_VERTICAL" => Some(3.0),
            _ => None,
        };
        let window_type = wings
            .and_then(|w| window_types.iter().map(|x| &x.0).find(|t| t.get("wingCount").and_then(Value::as_f64) == Some(w)))
            .or(window_types.first().map(|x| &x.0))
            .cloned();
        // Typ aus der Datei (IfcDoorType/IfcWindowType, IFC2x3 Style): gleichnamiger Dossier-Typ, sonst ein
        // neuer nach dem Vorbild des passenden ([B4]). Allgemeine Namen ("Tür", "Fenster SINGLE_PANEL" aus
        // dem eigenen Export) zählen nicht.
        let named = o.info.type_name.as_deref().map(str::trim).filter(|n| !n.is_empty() && !generic_fill_name(n)).map(str::to_string);
        let type_id: Option<String> = match o.kind.as_str() {
            "door" => typed_by_name(&mut ctx, &mut door_types, named.as_deref(), door_type.as_ref(), "doortype", "doorTypes"),
            "window" => typed_by_name(&mut ctx, &mut window_types, named.as_deref(), window_type.as_ref(), "windowtype", "windowTypes"),
            _ => None,
        };
        let window_type = match (&type_id, o.kind.as_str()) {
            (Some(id), "window") => window_types.iter().map(|x| &x.0).find(|t| id_of(t) == id).cloned(),
            _ => window_type,
        };
        let mut v = Map::new();
        v.insert("id".into(), ctx.new_id("opening").into());
        v.insert("type".into(), "opening".into());
        v.insert("hostWallId".into(), host["id"].clone());
        v.insert("categoryCode".into(), OPENING_CATEGORY.into());
        v.insert("kind".into(), kind.into());
        v.insert("position".into(), js_num(round(o.position, 1e-6)));
        v.insert("width".into(), js_num(round(o.width, 1e-6)));
        v.insert("height".into(), js_num(round(o.height, 1e-6)));
        v.insert("sillHeight".into(), js_num(round(o.sill, 1e-6)));
        if o.kind == "hole" {
            v.insert("doorType".into(), "wandoeffnung".into());
        }
        if let Some(sh) = o.shape.as_deref().filter(|x| ["rund", "rundbogen", "segmentbogen", "spitzbogen", "schraeg", "giebel"].contains(x)) {
            v.insert("shape".into(), sh.into());
        }
        if let Some(t) = type_id.filter(|t| !t.is_empty()) {
            v.insert("typeId".into(), t.into());
        }
        if o.kind == "door" {
            if o.hinge != 0.0 {
                v.insert("hinge".into(), if o.hinge > 0.0 { "start" } else { "end" }.into());
            }
            if o.swing != 0.0 {
                v.insert("swing".into(), if o.swing > 0.0 { "left" } else { "right" }.into());
            }
        }
        if let (true, Some(w)) = (o.kind == "window", wings) {
            if window_type.as_ref().and_then(|t| t.get("wingCount")).and_then(Value::as_f64).unwrap_or(1.0) != w {
                v.insert("wingCount".into(), js_num(w));
            }
        }
        if o.kind != "hole" {
            if let Some(b) = o.info.flag("IsExternal") {
                v.insert("isExternal".into(), b.into());
            }
            for (key, field) in [("FireRating", "fireRating"), ("AcousticRating", "soundClass"), ("SecurityRating", "burglaryClass")] {
                if let Some(t) = o.info.text(key) {
                    v.insert(field.into(), t.into());
                }
            }
            if let Some(u) = o.info.common.get("ThermalTransmittance").and_then(Value::as_str).and_then(|t| t.parse::<f64>().ok()).filter(|u| *u > 0.0) {
                v.insert("uValue".into(), js_num(u));
            }
        }
        openings.push(Value::Object(v));
    }

    // ── Decken, Stützen, Räume ──
    let mut ceilings: Vec<Value> = Vec::new();
    let first_wall_type = root.get("wallTypes").and_then(Value::as_array).and_then(|a| a.first()).and_then(|t| t.get("id")).and_then(Value::as_str).map(str::to_string);
    for s in &el.slabs {
        let (fid, base, fh) = floor_of(&mut ctx, s.info.storey, s.z0);
        let t = s.z1 - s.z0;
        let floor_top = base + fh;
        let mut v = Map::new();
        v.insert("id".into(), ctx.new_id("ceiling").into());
        v.insert("type".into(), "ceiling".into());
        v.insert("floorId".into(), fid.clone().into());
        v.insert("categoryCode".into(), CEILING_CATEGORY.into());
        v.insert("outline".into(), s.outline.iter().map(|&p| mv(p)).collect());
        if !s.holes.is_empty() {
            v.insert("openings".into(), s.holes.iter().map(|h| h.iter().map(|&p| mv(p)).collect::<Value>()).collect());
        }
        let wt = first_wall_type.clone().or_else(|| wall_types.first().map(|(t, _)| id_of(t).to_string())).unwrap_or_default();
        v.insert("wallTypeId".into(), wt.into());
        let ct = type_for(&mut ctx, &mut ceiling_types, &s.info, t, "ceilingtype", "ceilingTypes");
        v.insert("ceilingTypeId".into(), ct.into());
        if let Some(b) = s.info.flag("IsExternal") {
            v.insert("isExternal".into(), b.into());
        }
        if let Some(b) = s.info.flag("LoadBearing") {
            v.insert("loadBearing".into(), b.into());
        }
        if (s.z1 - floor_top).abs() > LEVEL_TOL {
            v.insert("top".into(), json!({"mode": "floor", "floorId": fid, "offset": js_num(anchor_offset(s.z1, base))}));
        }
        ceilings.push(Value::Object(v));
    }
    let mut columns: Vec<Value> = Vec::new();
    for c in &el.columns {
        let (fid, base, _) = floor_of(&mut ctx, c.info.storey, c.z0);
        let bottom = anchor_offset(c.z0, base);
        let material = c.info.layers.first().map(|l| l.material.clone()).filter(|m| !m.is_empty());
        let mut v = Map::new();
        v.insert("id".into(), ctx.new_id("column").into());
        v.insert("type".into(), "column".into());
        v.insert("floorId".into(), fid.clone().into());
        v.insert("categoryCode".into(), COLUMN_CATEGORY.into());
        v.insert("position".into(), mv(c.center));
        v.insert(
            "profile".into(),
            if c.round {
                json!({"kind": "round", "radius": js_num(round(c.a, 1e-6))})
            } else {
                json!({"kind": "rect", "width": js_num(round(c.a, 1e-6)), "depth": js_num(round(c.b, 1e-6))})
            },
        );
        v.insert("rotation".into(), js_num(c.rotation));
        v.insert("height".into(), js_num(round(c.z1 - c.z0, 1e-6)));
        if let Some(m) = material {
            let l0 = &c.info.layers[0];
            let color = color_hex(l0.color.as_deref().or(c.info.color.as_deref()));
            v.insert("componentId".into(), ctx.component_for(&m, color).into());
        }
        if bottom.abs() > LEVEL_TOL {
            v.insert("bottom".into(), json!({"mode": "floor", "floorId": fid, "offset": js_num(bottom)}));
        }
        columns.push(Value::Object(v));
    }
    let room_color = crate::layers::flatten(root.get("layers").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]))
        .into_iter()
        .find(|c| c.get("code").and_then(Value::as_str) == Some(ROOM_CATEGORY))
        .and_then(|c| c.get("color"))
        .filter(|c| !c.is_null())
        .cloned()
        .unwrap_or_else(|| ROOM_COLOR.into());
    let rooms_before = root.get("rooms").and_then(Value::as_array).map_or(0, Vec::len);
    let mut rooms: Vec<Value> = Vec::new();
    for s in &el.spaces {
        let (fid, _, _) = floor_of(&mut ctx, s.info.storey, s.z0);
        let boundary: Vec<Value> = s.boundary.iter().map(|&p| mv(p)).collect();
        let sia_key = s.sia.as_deref().map(|x| x.trim().to_uppercase());
        let sia = SIA.iter().find(|c| Some(**c) == sia_key.as_deref()).copied().unwrap_or("HNF");
        let n = boundary.len() as f64;
        let (sx, sy) = boundary.iter().fold((0.0, 0.0), |(a, b), p| (a + p["x"].as_f64().unwrap_or(f64::NAN), b + p["y"].as_f64().unwrap_or(f64::NAN)));
        let name = [s.long_name.as_deref(), s.name.as_deref()].into_iter().flatten().find(|x| !x.is_empty()).map(str::to_string).unwrap_or_else(|| format!("Raum {}", rooms_before + rooms.len() + 1));
        let mut room = json!({
            "id": ctx.new_id("room"), "type": "room", "floorId": fid, "categoryCode": ROOM_CATEGORY, "siaCategory": sia,
            "name": name, "boundary": boundary, "color": room_color, "stampAnchor": {"x": js_num(sx / n), "y": js_num(sy / n)},
        });
        // [158] Raumbuch aus den Psets: Nutzung (bekannte Kennung), Oberflächen (Material gleichen Namens →
        // seine Kennung, sonst Freitext), Bodenaufbau.
        if let Some(u) = s.info.text("Usage").and_then(|u| crate::model::RoomUsage::from_key(&u)) {
            room["usage"] = u.key().into();
        }
        for (prop, field) in [("FloorCovering", "floorFinish"), ("WallCovering", "wallFinish"), ("CeilingCovering", "ceilingFinish")] {
            if let Some(t) = s.info.text(prop) {
                let comp = root.get("components").and_then(Value::as_array).and_then(|cs| cs.iter().find(|c| c.get("name").and_then(Value::as_str).map(str::trim) == Some(t.as_str()))).and_then(|c| c.get("id")).and_then(Value::as_str);
                room[field] = comp.map_or_else(|| t.clone(), str::to_string).into();
            }
        }
        if let Some(t) = s.info.text("FloorBuildUp") {
            room["floorBuildUp"] = t.into();
        }
        rooms.push(room);
    }

    let mut roof_types = list_of(root, "roofTypes");
    let mut roofs: Vec<Value> = Vec::new();
    for r in &el.roofs {
        let (fid, _, _) = floor_of(&mut ctx, r.info.storey, r.eave_z);
        let mut v = json!({
            "id": ctx.new_id("roof"), "type": "roof", "floorId": fid, "categoryCode": ROOF_CATEGORY,
            "outline": r.outline.iter().map(|&p| mv(p)).collect::<Vec<_>>(),
            "shape": r.shape, "pitchDeg": js_num(round(r.pitch_deg, 1e-6)), "overhang": 0, "ridgeAxis": r.ridge_axis,
            "baseElevation": js_num(round(r.eave_z, 1e-6)), "thickness": js_num(round(r.thickness, 1e-6)),
        });
        // Standardform passt nicht (gedreht, Pult fallend …): Neigung je Kante, Giebel wo keine Traufe ist.
        if r.custom && r.shape != "flach" {
            v["shape"] = (if r.edge_pitch.iter().all(Option::is_some) { "walm" } else { "sattel" }).into();
            v["edgePitchDeg"] = r.edge_pitch.iter().map(|p| p.map_or(Value::Null, |x| js_num(round(x, 1e-6)))).collect();
        }
        // Dachtyp nur mit Material aus der Datei; sonst einschichtig über `thickness`.
        if r.info.layers.iter().any(|l| !l.material.trim().is_empty()) {
            v["roofTypeId"] = type_for(&mut ctx, &mut roof_types, &r.info, r.thickness, "rooftype", "roofTypes").into();
        }
        roofs.push(v);
    }
    let mut stairs: Vec<Value> = Vec::new();
    for s in &el.stairs {
        let (fid, _, _) = floor_of(&mut ctx, s.info.storey, s.z0);
        let mut v = json!({
            "id": ctx.new_id("stair"), "type": "stair", "floorId": fid, "categoryCode": STAIR_CATEGORY, "shape": s.shape,
            "start": mv(s.start), "dir": {"x": js_num(round(s.dir[0], 1e-9)), "y": js_num(round(s.dir[1], 1e-9))},
            "runLength": js_num(round(s.run_length, 1e-6)), "width": js_num(round(s.width, 1e-6)),
            "totalRise": js_num(round(s.total_rise, 1e-6)), "stepCount": js_num(s.step_count), "up": true,
        });
        match s.shape.as_str() {
            "L" => {
                v["run2Length"] = js_num(round(s.run2_length, 1e-6));
                v["turn"] = js_num(s.turn.signum());
                if s.run1_steps >= 1.0 {
                    v["run1Steps"] = js_num(s.run1_steps);
                }
            }
            // [151] U (Halbpodest oder Mittellauf) und gerade mit Zwischenpodest.
            "U" | "straightLanding" => {
                v["run2Length"] = js_num(round(s.run2_length, 1e-6));
                v["landingLength"] = js_num(round(s.landing_length, 1e-6));
                if s.run1_steps >= 1.0 {
                    v["run1Steps"] = js_num(s.run1_steps);
                }
                if s.shape == "U" {
                    v["turn"] = js_num(s.turn.signum());
                    v["gap"] = js_num(round(s.gap, 1e-6));
                    if s.mid_steps >= 1.0 {
                        v["midSteps"] = js_num(s.mid_steps);
                    }
                    if s.run2_offset.abs() > 1e-6 {
                        v["run2Offset"] = js_num(round(s.run2_offset, 1e-6));
                    }
                    if s.mid_steps >= 1.0 && s.mid_offset.abs() > 1e-6 {
                        v["midOffset"] = js_num(round(s.mid_offset, 1e-6));
                    }
                }
            }
            "spiral" => {
                v["center"] = mv(s.center);
                v["radius"] = js_num(round(s.radius, 1e-6));
                v["sweep"] = js_num(round(s.sweep, 1e-6));
                if s.center_column > 0.0 {
                    v["centerColumn"] = js_num(round(s.center_column, 1e-6));
                }
            }
            _ => {}
        }
        stairs.push(v);
    }
    // Träger als Extrusionskörper (Grundriss + Höhe über der Geschoss-UK).
    let mut solids: Vec<Value> = Vec::new();
    for b in &el.beams {
        let (fid, base, _) = floor_of(&mut ctx, b.info.storey, b.z0);
        let mut v = json!({
            "id": ctx.new_id("solid"), "type": "extrudedSolid", "levelId": fid,
            "points": b.outline.iter().map(|&p| mv(p)).collect::<Vec<_>>(), "height": js_num(round(b.z1 - b.z0, 1e-6)),
        });
        let off = anchor_offset(b.z0, base);
        if off.abs() > 1e-9 {
            v["baseOffset"] = js_num(off);
        }
        solids.push(v);
    }

    // ── Übrige Bauteile als Kontext-Mesh ──
    let meshes = ifc_meshes(products, &opts.file_name, opts.group.as_deref().unwrap_or("auto"), [dx, dy], now);
    let n_meshes = meshes.len();
    let classified = el.walls.iter().filter(|w| w.info.classified).count()
        + el.openings.iter().filter(|o| o.kind != "hole" && o.info.classified).count()
        + el.slabs.iter().filter(|s| s.info.classified).count()
        + el.columns.iter().filter(|c| c.info.classified).count()
        + el.spaces.iter().filter(|s| s.info.classified).count()
        + el.roofs.iter().filter(|r| r.info.classified).count()
        + el.stairs.iter().filter(|s| s.info.classified).count()
        + products.iter().filter(|p| !p.classifications.is_empty()).count();
    for (k, n) in [("walls", walls.len()), ("openings", openings.len()), ("ceilings", ceilings.len()), ("columns", columns.len()), ("rooms", rooms.len()), ("roofs", roofs.len()), ("stairs", stairs.len()), ("beams", solids.len()), ("meshes", n_meshes), ("classified", classified)] {
        ctx.summary.insert(k.into(), n.into());
    }

    let mut ops = Vec::new();
    ops.extend(grown_list_ops("drawingLevels", root.get("drawingLevels"), std::mem::take(&mut ctx.levels)));
    ops.extend(grown_list_ops("components", root.get("components"), std::mem::take(&mut ctx.components)));
    ops.extend(grown_list_ops("wallTypes", root.get("wallTypes"), wall_types));
    if !ceiling_types.is_empty() || root.get("ceilingTypes").is_some_and(|v| crate::json_util::truthy(Some(v))) {
        ops.extend(grown_list_ops("ceilingTypes", root.get("ceilingTypes"), ceiling_types));
    }
    for (key, list) in [("roofTypes", roof_types), ("doorTypes", door_types), ("windowTypes", window_types)] {
        if list.iter().any(|x| x.1) {
            ops.extend(grown_list_ops(key, root.get(key), list));
        }
    }
    if !walls.is_empty() {
        ops.push(Op::Add { collection: "walls".into(), items: walls, at: None });
    }
    for (key, items) in [("openings", openings), ("ceilings", ceilings), ("columns", columns), ("rooms", rooms), ("roofs", roofs), ("stairs", stairs), ("extrudedSolids", solids)] {
        if root.get(key).is_some_and(|v| crate::json_util::truthy(Some(v))) {
            if !items.is_empty() {
                ops.push(Op::Add { collection: key.into(), items, at: None });
            }
        } else if !(key == "extrudedSolids" && items.is_empty()) {
            ops.push(Op::SetField { key: key.into(), value: Some(Value::Array(items)), at: None });
        }
    }
    if n_meshes > 0 {
        ops.extend(context_ops(root, meshes));
    }
    let _ = ctx.root;
    (ops, Value::Object(ctx.summary), n_meshes)
}

/// Rückschub über die Georeferenz der Datei (IfcMapConversion, [B4]): die Datei liegt lokal, die Karte
/// = lokal + (Ost, Nord). Hat das Projekt einen LV95-Bezug, landet das Modell an seinem Kartenort
/// relativ zum Projekt-Nullpunkt. Nur ungedreht und Massstab 1 und nur bei LV95 (EPSG:2056) oder ohne
/// Angabe des Systems; sonst `None` (dann wie bisher über die Lage der Punkte).
fn map_shift(meta: &Value, root: &Map<String, Value>) -> Option<[f64; 2]> {
    let m = meta.get("mapConversion")?;
    let num = |k: &str| m.get(k).and_then(Value::as_f64);
    let (e, n) = (num("eastings")?, num("northings")?);
    let axis = m.get("xAxis").and_then(Value::as_array)?;
    let ax = [axis.first()?.as_f64()?, axis.get(1)?.as_f64()?];
    let crs = m.get("crs").and_then(Value::as_str).unwrap_or("");
    let lv95 = crs.is_empty() || crs.contains("2056") || crs.to_uppercase().contains("LV95");
    let plain = ax[0].is_finite() && ax[1].is_finite() && ax[0].hypot(ax[1]) > 1e-12 && (num("scale").unwrap_or(1.0) - 1.0).abs() < 1e-9;
    let o = project_geo_origin(root)?;
    (lv95 && plain && o[0].is_finite() && o[1].is_finite() && e.is_finite() && n.is_finite()).then(|| [e - o[0], n - o[1]])
}

/// Drehung der Georeferenz ([B4], XAxisAbscissa/-Ordinate: Richtung der lokalen x-Achse in der Karte) als
/// (cos, sin), wenn [`map_shift`] gilt und die Datei gedreht ist; das Dossier-Modell ist kartenparallel
/// (+y = Nord), die Bauteile werden also vor dem Rückschub um diesen Winkel gedreht.
fn map_rotation(meta: &Value, root: &Map<String, Value>) -> Option<[f64; 2]> {
    map_shift(meta, root)?;
    let axis = meta.get("mapConversion")?.get("xAxis").and_then(Value::as_array)?;
    let (x, y) = (axis.first()?.as_f64()?, axis.get(1)?.as_f64()?);
    let l = x.hypot(y);
    let (c, s) = (x / l, y / l);
    (s.abs() > 1e-12 || c < 0.0).then_some([c, s])
}

/// Alle erkannten Bauteile um den Nullpunkt drehen (`cs` = cos, sin). Dächer mit Neigung werden „je Kante"
/// (die Standardformen hängen an den Achsen); Stützen drehen mit.
fn rotate_elements(el: &mut Elements, cs: [f64; 2]) {
    let [c, s] = cs;
    let rot = |p: &mut [f64; 2]| *p = [c * p[0] - s * p[1], s * p[0] + c * p[1]];
    let ring = |r: &mut Vec<[f64; 2]>| r.iter_mut().for_each(rot);
    for w in &mut el.walls {
        rot(&mut w.start);
        rot(&mut w.end);
    }
    for sl in &mut el.slabs {
        ring(&mut sl.outline);
        sl.holes.iter_mut().for_each(ring);
    }
    for col in &mut el.columns {
        rot(&mut col.center);
        col.rotation += s.atan2(c);
    }
    for sp in &mut el.spaces {
        ring(&mut sp.boundary);
    }
    for r in &mut el.roofs {
        ring(&mut r.outline);
        if r.shape != "flach" && r.edge_pitch.len() == r.outline.len() {
            r.custom = true;
        }
    }
    for st in &mut el.stairs {
        rot(&mut st.start);
        rot(&mut st.dir);
        rot(&mut st.center);
    }
    for b in &mut el.beams {
        ring(&mut b.outline);
    }
}

/// IFC ins Projekt `root`: als Kontext-Meshes oder (mit `opts.elements`) als Bauteile.
pub fn ifc_import(root: &Map<String, Value>, meta_json: &str, positions: &[f64], indices: &[f64], element_data: &[f64], opts: &IfcOptions, now: f64) -> Result<IfcResult, String> {
    let meta: Value = serde_json::from_str(meta_json).map_err(|e| format!("IFC-Bericht: {e}"))?;
    // Gedrehte Georeferenz: Meshes und Bauteile kartenparallel drehen.
    let rotation = map_rotation(&meta, root);
    let rotated: Vec<f64>;
    let positions = match rotation {
        Some([c, s]) => {
            rotated = positions.chunks(3).flat_map(|p| if p.len() == 3 { vec![c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]] } else { p.to_vec() }).collect();
            &rotated[..]
        }
        None => positions,
    };
    let products = crate::import_context::decode_ifc_products(&meta, positions, indices)?;
    let report = crate::import_context::ifc_report(&meta, &products);
    if opts.elements {
        let mut el = decode_elements(&meta, element_data);
        if let Some(cs) = rotation {
            rotate_elements(&mut el, cs);
        }
        let kept = el.kept.clone();
        let (ops, summary, n) = elements_ops(root, &meta, &products, &el, opts, now);
        // Statt der Roh-Bauteile die Zusammenfassung (an derselben Stelle des Berichts).
        let mut report = report;
        if let Some(r) = report.as_object_mut() {
            r.insert("elements".into(), summary.clone());
        }
        return Ok(IfcResult { ops, summary: Some(summary), report, kept, context_objects: n });
    }
    let shift = map_shift(&meta, root).unwrap_or_else(|| geo_shift(&products, project_geo_origin(root), &[]));
    let meshes = ifc_meshes(&products, &opts.file_name, opts.group.as_deref().unwrap_or("auto"), shift, now);
    let n = meshes.len();
    Ok(IfcResult { ops: context_ops(root, meshes), summary: None, report, kept: Map::new(), context_objects: n })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn added<'a>(ops: &'a [Op], key: &str) -> Vec<&'a Value> {
        let mut out = Vec::new();
        for op in ops {
            match op {
                Op::Add { collection, items, .. } if collection == key => out.extend(items.iter()),
                Op::SetField { key: k, value: Some(Value::Array(a)), .. } if k == key => out.extend(a.iter()),
                _ => {}
            }
        }
        out
    }

    fn at(v: &Value, x: f64, y: f64) -> bool {
        (v["x"].as_f64().unwrap_or(f64::NAN) - x).abs() < 1e-9 && (v["y"].as_f64().unwrap_or(f64::NAN) - y).abs() < 1e-9
    }

    /// Erkannte Bauteile wie aus `fileio` (`ifc_semantic::encode`): Bogenwand mit runder Öffnung,
    /// Satteldach, gerade Treppe, Tür mit eigenem Typnamen; Georeferenz LV95.
    fn meta(door_type: &str) -> (Value, Vec<f64>) {
        let data = vec![
            // Wand: sx, sy, ex, ey, z0, z1, t, bulge
            5.0, 0.0, 0.0, 5.0, 0.0, 2.5, 0.3, -0.41421356237,
            // Öffnung: position, width, sill, height, swing, hinge
            1.0, 1.0, 1.0, 1.0, 0.0, 0.0,
            // Gerade Wand für die Tür
            0.0, -2.0, 4.0, -2.0, 0.0, 2.5, 0.2, 0.0,
            1.0, 0.9, 0.0, 2.1, 0.0, 0.0,
            // Dach: eaveZ, pitch, t, n, Ring
            3.0, 45.0, 0.2, 4.0, 0.0, 0.0, 10.0, 0.0, 10.0, 8.0, 0.0, 8.0,
            // Treppe: sx, sy, dx, dy, lauf, breite, stufen, z0, steighöhe
            1.0, 2.55, 1.0, 0.0, 1.68, 1.1, 6.0, 0.0, 1.05,
        ];
        let info = |kind: &str, at: usize, n: usize| json!({"kind": kind, "at": at, "n": n, "storey": 0, "layers": [], "classifications": [], "common": {}});
        let mut op1 = info("opening", 8, 6);
        op1["host"] = 0.into();
        op1["openingKind"] = "hole".into();
        op1["shape"] = "rund".into();
        let mut op2 = info("opening", 22, 6);
        op2["host"] = 1.into();
        op2["openingKind"] = "door".into();
        op2["typeName"] = door_type.into();
        let mut roof = info("roof", 28, 12);
        roof["shape"] = "sattel".into();
        roof["ridgeAxis"] = "x".into();
        let meta = json!({
            "schema": "IFC4", "lengthScale": 1, "products": [], "skippedItems": {}, "skippedProducts": {},
            "productsWithoutGeometry": 0, "simplifiedBooleans": 0, "voidsApplied": 0, "voidsIgnored": 0, "parseErrors": 0, "truncated": false,
            "mapConversion": {"eastings": 2600100.0, "northings": 1200050.0, "height": 0.0, "xAxis": [1.0, 0.0], "scale": 1.0, "crs": "EPSG:2056"},
            "elements": {
                "storeys": [{"globalId": "s", "name": "EG", "elevation": 0.0}],
                "elements": [info("wall", 0, 8), op1, info("wall", 14, 8), op2, roof, info("stair", 40, 9)],
                "kept": {"IfcStair": 1},
                "keptReasons": {"IfcStair": {"stairForm": 1}},
            },
        });
        (meta, data)
    }

    fn root() -> Map<String, Value> {
        json!({
            "drawingLevels": [], "components": [], "wallTypes": [], "hatches": [{"id": "none"}],
            "doorTypes": [{"id": "dt1", "name": "Drehtür", "kind": "dreh", "leafCount": 1, "leafStyle": "glatt", "frameThickness": 0.05}],
            "windowTypes": [{"id": "wt1", "name": "Fenster", "kind": "dreh", "wingCount": 1}],
            "geoAnchor": {"lv95": {"e": 2600000.0, "n": 1200000.0}, "model": {"x": 0.0, "y": 0.0}},
        })
        .as_object()
        .cloned()
        .unwrap()
    }

    /// [158] Raumbuch-Eigenschaften eines IfcSpace: Nutzung, Oberflächen (Material gleichen Namens → Kennung,
    /// sonst Freitext), Bodenaufbau; unbekannte Nutzung fällt weg.
    #[test]
    fn space_room_book_props() {
        let data = vec![0.0, 2.6, 4.0, 0.0, 0.0, 3.0, 0.0, 3.0, 2.0, 0.0, 2.0];
        let mut sp = json!({"kind": "space", "at": 0, "n": 11, "storey": 0, "layers": [], "classifications": [], "longName": "Bad",
            "common": {"Usage": "bath", "FloorCovering": "Feinsteinzeug", "WallCovering": "Abrieb 1 mm", "FloorBuildUp": "UB 80"}});
        let meta = |sp: &Value| json!({
            "schema": "IFC4", "lengthScale": 1, "products": [], "skippedItems": {}, "skippedProducts": {},
            "productsWithoutGeometry": 0, "simplifiedBooleans": 0, "voidsApplied": 0, "voidsIgnored": 0, "parseErrors": 0, "truncated": false,
            "elements": {"storeys": [{"globalId": "s", "name": "EG", "elevation": 0.0}], "elements": [sp], "kept": {}, "keptReasons": {}},
        });
        let mut base = root();
        base.remove("geoAnchor");
        base.insert("components".into(), json!([{"id": "fl", "name": "Feinsteinzeug", "color": "#ccc"}]));
        let opts = IfcOptions { file_name: "a.ifc".into(), group: None, elements: true };
        let r = ifc_import(&base, &meta(&sp).to_string(), &[], &[], &data, &opts, 0.0).unwrap();
        let rooms = added(&r.ops, "rooms");
        assert_eq!(rooms.len(), 1);
        let room = &rooms[0];
        assert_eq!((room["usage"].as_str(), room["floorFinish"].as_str(), room["wallFinish"].as_str(), room["floorBuildUp"].as_str()), (Some("bath"), Some("fl"), Some("Abrieb 1 mm"), Some("UB 80")));
        assert!(room.get("ceilingFinish").is_none());
        sp["common"] = json!({"Usage": "sauna"});
        let r = ifc_import(&base, &meta(&sp).to_string(), &[], &[], &data, &opts, 0.0).unwrap();
        assert!(added(&r.ops, "rooms")[0].get("usage").is_none());
    }

    #[test]
    fn roof_stair_arc_wall_round_opening_type_by_name_and_map_shift() {
        let (m, data) = meta("Haustür Eiche");
        let opts = IfcOptions { file_name: "a.ifc".into(), group: None, elements: true };
        let r = ifc_import(&root(), &m.to_string(), &[], &[], &data, &opts, 0.0).unwrap();
        let walls = added(&r.ops, "walls");
        assert_eq!(walls.len(), 2);
        // Verschiebung aus der Georeferenz: Karte − Projekt-Nullpunkt = (100, 50).
        assert!(at(&walls[0]["start"], 105.0, 50.0), "{}", walls[0]);
        assert!((walls[0]["bulge"].as_f64().unwrap() + 0.41421356237).abs() < 1e-9);
        assert!(walls[1].get("bulge").is_none());
        let openings = added(&r.ops, "openings");
        assert_eq!(openings[0]["shape"], "rund");
        // Neuer Türtyp mit dem Namen aus der Datei, nach dem Vorbild des vorhandenen.
        let doors = added(&r.ops, "doorTypes");
        assert_eq!(doors.len(), 1, "{:?}", r.ops);
        assert_eq!((doors[0]["name"].as_str(), doors[0]["kind"].as_str()), (Some("Haustür Eiche"), Some("dreh")));
        assert_eq!(openings[1]["typeId"], doors[0]["id"]);
        let roofs = added(&r.ops, "roofs");
        assert_eq!(roofs.len(), 1);
        assert_eq!(
            (roofs[0]["shape"].as_str(), roofs[0]["ridgeAxis"].as_str(), roofs[0]["pitchDeg"].as_f64(), roofs[0]["baseElevation"].as_f64()),
            (Some("sattel"), Some("x"), Some(45.0), Some(3.0))
        );
        assert!(at(&roofs[0]["outline"][2], 110.0, 58.0));
        // Ohne Material in der Datei: kein Dachtyp, einschichtig über die Dicke.
        assert!(added(&r.ops, "roofTypes").is_empty() && roofs[0].get("roofTypeId").is_none());
        assert!((roofs[0]["thickness"].as_f64().unwrap() - 0.2).abs() < 1e-9);
        let stairs = added(&r.ops, "stairs");
        assert_eq!((stairs[0]["stepCount"].as_f64(), stairs[0]["shape"].as_str()), (Some(6.0), Some("straight")));
        assert!(at(&stairs[0]["start"], 101.0, 52.55));
        let s = r.summary.unwrap();
        assert_eq!((s["roofs"].as_f64(), s["stairs"].as_f64(), s["doorTypes"].as_f64()), (Some(1.0), Some(1.0), Some(1.0)));
        assert_eq!(s["keptReasons"], json!({"IfcStair": {"stairForm": 1}}));

        // Allgemeiner Stilname aus dem eigenen Export: kein neuer Typ; vorhandener Name: wiederverwendet.
        for name in ["Tür SINGLE_SWING_LEFT", "drehtür"] {
            let (m, data) = meta(name);
            let r = ifc_import(&root(), &m.to_string(), &[], &[], &data, &opts, 0.0).unwrap();
            assert!(added(&r.ops, "doorTypes").is_empty(), "{name}");
            assert_eq!(added(&r.ops, "openings")[1]["typeId"], "dt1");
        }
        // Ohne Projekt-Bezug: lokal (keine Verschiebung).
        let mut bare = root();
        bare.remove("geoAnchor");
        let r = ifc_import(&bare, &m.to_string(), &[], &[], &data, &opts, 0.0).unwrap();
        assert!(at(&added(&r.ops, "walls")[0]["start"], 5.0, 0.0));
    }

    /// L- und Wendeltreppe, Dach mit Neigung je Kante, Träger; Georeferenz um 90° gedreht (lokal x = Nord).
    fn meta_rotated(x_axis: [f64; 2]) -> (Value, Vec<f64>) {
        let data = vec![
            // Wand
            0.0, 0.0, 4.0, 0.0, 0.0, 2.5, 0.2, 0.0,
            // Pultdach fallend nach +y: Traufe an Kante 2 (y = 8), sonst Giebel
            3.0, 30.0, 0.2, 4.0, 0.0, 0.0, 10.0, 0.0, 10.0, 8.0, 0.0, 8.0,
            // L-Treppe: sx, sy, dx, dy, lauf1, breite, stufen, z0, steighöhe, lauf2, turn, cx, cy, r, sweep, spindel
            1.0, 2.0, 1.0, 0.0, 1.12, 1.0, 9.0, 0.0, 1.53, 1.12, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            // Wendeltreppe
            2.8, 3.0, 0.0, 1.0, 4.54, 1.0, 13.0, 0.0, 2.34, 0.0, 0.0, 2.0, 3.0, 0.8, 325.0, 0.3,
            // Träger: z0, z1, Ring
            2.6, 3.0, 4.0, 0.0, 0.0, 4.0, 0.0, 4.0, 0.2, 0.0, 0.2,
            // [151] U-Treppe mit Mittellauf: … wie L, dazu Auge, Podesttiefe, Tritte Lauf 1, Mittellauf, Versatz,
            // Versatz des Mittellaufs
            5.0, 0.0, 0.0, 1.0, 2.1, 1.2, 18.0, 0.0, 3.06, 1.5, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.6, 1.2, 7.0, 4.0, 0.0, 0.09,
        ];
        let info = |kind: &str, at: usize, n: usize| json!({"kind": kind, "at": at, "n": n, "storey": 0, "layers": [], "classifications": [], "common": {}});
        let mut roof = info("roof", 8, 12);
        roof["shape"] = "sattel".into();
        roof["ridgeAxis"] = "x".into();
        roof["edgePitch"] = json!([null, null, 30.0, null]);
        roof["custom"] = true.into();
        let mut l = info("stair", 20, 16);
        l["shape"] = "L".into();
        let mut sp = info("stair", 36, 16);
        sp["shape"] = "spiral".into();
        let mut u = info("stair", 63, 22);
        u["shape"] = "U".into();
        let meta = json!({
            "schema": "IFC4", "lengthScale": 1, "products": [], "skippedItems": {}, "skippedProducts": {},
            "productsWithoutGeometry": 0, "simplifiedBooleans": 0, "voidsApplied": 0, "voidsIgnored": 0, "parseErrors": 0, "truncated": false,
            "mapConversion": {"eastings": 2600100.0, "northings": 1200050.0, "height": 0.0, "xAxis": x_axis, "scale": 1.0, "crs": "EPSG:2056"},
            "elements": {
                "storeys": [{"globalId": "s", "name": "EG", "elevation": 0.0}],
                "elements": [info("wall", 0, 8), roof, l, sp, info("beam", 52, 11), u],
                "kept": {}, "keptReasons": {},
            },
        });
        (meta, data)
    }

    #[test]
    fn l_and_spiral_stair_edge_pitch_roof_beam_and_rotated_map() {
        let opts = IfcOptions { file_name: "a.ifc".into(), group: None, elements: true };
        // Ungedreht: Werte wie erkannt.
        let (m, data) = meta_rotated([1.0, 0.0]);
        let r = ifc_import(&root(), &m.to_string(), &[], &[], &data, &opts, 0.0).unwrap();
        let roofs = added(&r.ops, "roofs");
        assert_eq!((roofs[0]["shape"].as_str(), &roofs[0]["edgePitchDeg"]), (Some("sattel"), &json!([null, null, 30, null])));
        let stairs = added(&r.ops, "stairs");
        let l = stairs[0];
        assert_eq!((l["shape"].as_str(), l["turn"].as_f64(), l["stepCount"].as_f64()), (Some("L"), Some(1.0), Some(9.0)));
        assert!((l["run2Length"].as_f64().unwrap() - 1.12).abs() < 1e-9);
        assert!(at(&l["start"], 101.0, 52.0));
        let s = stairs[1];
        assert_eq!((s["shape"].as_str(), s["sweep"].as_f64()), (Some("spiral"), Some(325.0)));
        assert!((s["radius"].as_f64().unwrap() - 0.8).abs() < 1e-9 && (s["centerColumn"].as_f64().unwrap() - 0.3).abs() < 1e-9);
        assert!(at(&s["center"], 102.0, 53.0) && at(&s["start"], 102.8, 53.0));
        // [151] U mit zwei Viertelpodesten
        let u = stairs[2];
        assert_eq!((u["shape"].as_str(), u["turn"].as_f64(), u["midSteps"].as_f64(), u["run1Steps"].as_f64()), (Some("U"), Some(-1.0), Some(4.0), Some(7.0)), "{u}");
        assert!((u["gap"].as_f64().unwrap() - 1.6).abs() < 1e-9 && (u["landingLength"].as_f64().unwrap() - 1.2).abs() < 1e-9 && u.get("run2Offset").is_none());
        assert!((u["midOffset"].as_f64().unwrap() - 0.09).abs() < 1e-9, "{u}");
        let typed: crate::model::Stair = serde_json::from_value(u.clone()).unwrap();
        assert_eq!(typed.shape, crate::model::StairShape::U);
        let solids = added(&r.ops, "extrudedSolids");
        assert_eq!(solids.len(), 1);
        assert_eq!(solids[0]["type"].as_str(), Some("extrudedSolid"));
        assert!((solids[0]["height"].as_f64().unwrap() - 0.4).abs() < 1e-9 && (solids[0]["baseOffset"].as_f64().unwrap() - 2.6).abs() < 1e-9);
        assert!(at(&solids[0]["points"][2], 104.0, 50.2));
        assert_eq!(r.summary.unwrap()["beams"].as_f64(), Some(1.0));

        // Lokal x zeigt nach Norden (90°): alles um 90° gedreht, dann verschoben.
        let (m, data) = meta_rotated([0.0, 1.0]);
        let r = ifc_import(&root(), &m.to_string(), &[], &[], &data, &opts, 0.0).unwrap();
        let w = added(&r.ops, "walls")[0];
        assert!(at(&w["start"], 100.0, 50.0) && at(&w["end"], 100.0, 54.0), "{w}");
        let roof = added(&r.ops, "roofs")[0];
        assert!(at(&roof["outline"][2], 92.0, 60.0) && at(&roof["outline"][3], 92.0, 50.0), "{roof}");
        assert_eq!((roof["shape"].as_str(), &roof["edgePitchDeg"]), (Some("sattel"), &json!([null, null, 30, null])));
        let stairs = added(&r.ops, "stairs");
        assert!(at(&stairs[0]["start"], 98.0, 51.0) && at(&stairs[0]["dir"], 0.0, 1.0), "{}", stairs[0]);
        assert!(at(&stairs[1]["center"], 97.0, 52.0) && at(&stairs[1]["start"], 97.0, 52.8), "{}", stairs[1]);
        assert!(at(&added(&r.ops, "extrudedSolids")[0]["points"][2], 99.8, 54.0));
        // Ohne Projekt-Bezug bleibt die Datei lokal und ungedreht.
        let mut bare = root();
        bare.remove("geoAnchor");
        let r = ifc_import(&bare, &m.to_string(), &[], &[], &data, &opts, 0.0).unwrap();
        assert!(at(&added(&r.ops, "walls")[0]["end"], 4.0, 0.0));
    }
}
