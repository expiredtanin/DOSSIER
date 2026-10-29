//! IFC-Import zu echten Bauteilen ([B4], [K4] S4; vorher `io/ifcElements.ts`): baut aus dem, was das
//! Format-Modul erkannt hat (`fileio/src/ifc_semantic.rs`: Achse, Dicke, Höhe, Umriss … in Metern),
//! Dossier-Objekte — Geschosse, Wände (Wandtyp aus den Materialschichten, wiederverwendet oder neu),
//! Türen/Fenster/Wanddurchbrüche, Decken (Deckentyp), Stützen, Räume; der Rest kommt als Kontext-Mesh
//! (`import_context`). Ergebnis sind Ops auf dem Projekt (ein Undo-Schritt) und eine Zusammenfassung.
//!
//! Zuordnung wie in der TS-Fassung: Geschoss nach Höhe (±5 mm) wiederverwenden oder anlegen, Wand- und
//! Deckentypen nach Schichten (Material + Dicke, ±0.5 mm), Materialien nach Namen; Zahlen auf 1e-9 m bzw.
//! 1e-6 gerundet (`Math.round(x / step) * step`).

use crate::grips::js_num;
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
    kept: Map<String, Value>,
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
                if v.len() == 7 {
                    wall_index.insert(rust_wall, out.walls.len());
                    out.walls.push(WallData { info, start: [v[0], v[1]], end: [v[2], v[3]], z0: v[4], z1: v[5], thickness: v[6] });
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

fn list_of(root: &Map<String, Value>, key: &str) -> Vec<(Value, bool)> {
    root.get(key).and_then(Value::as_array).map(|a| a.iter().map(|v| (v.clone(), false)).collect()).unwrap_or_default()
}

/// Bauteile + übrige Kontext-Meshes ins Projekt `root` (vorher `ifcElementsToProject`).
fn elements_ops(root: &Map<String, Value>, products: &[IfcProduct], el: &Elements, opts: &IfcOptions, now: f64) -> (Vec<Op>, Value, usize) {
    let kept: f64 = el.kept.values().map(|v| v.as_f64().unwrap_or(f64::NAN)).sum();
    let mut summary = Map::new();
    for k in ["walls", "openings", "ceilings", "columns", "rooms", "floors", "wallTypes", "ceilingTypes", "components", "meshes", "classified"] {
        summary.insert(k.into(), 0.into());
    }
    summary.insert("kept".into(), js_num(kept));
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
    let [dx, dy] = geo_shift(products, project_geo_origin(root), &extra);
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
    let door_types = root.get("doorTypes").and_then(Value::as_array).cloned().unwrap_or_default();
    let window_types = root.get("windowTypes").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut openings: Vec<Value> = Vec::new();
    for o in &el.openings {
        let Some(host) = walls.get(o.host) else { continue };
        let kind = if o.kind == "window" { "window" } else { "door" };
        let op = o.operation.as_deref().unwrap_or("");
        let sliding = op.contains("SLIDING");
        let leaves = if op.starts_with("DOUBLE_DOOR") { 2.0 } else { 1.0 };
        let door_type = (!op.is_empty())
            .then(|| {
                door_types.iter().find(|t| {
                    t.get("kind").and_then(Value::as_str) == Some(if sliding { "schiebe" } else { "dreh" }) && t.get("leafCount").and_then(Value::as_f64) == Some(leaves)
                })
            })
            .flatten()
            .or(door_types.first());
        let wings: Option<f64> = match op {
            "SINGLE_PANEL" => Some(1.0),
            "DOUBLE_PANEL_VERTICAL" => Some(2.0),
            "TRIPLE_PANEL_VERTICAL" => Some(3.0),
            _ => None,
        };
        let window_type = wings.and_then(|w| window_types.iter().find(|t| t.get("wingCount").and_then(Value::as_f64) == Some(w))).or(window_types.first());
        let type_id = match o.kind.as_str() {
            "door" => door_type.and_then(|t| t.get("id")).and_then(Value::as_str),
            "window" => window_type.and_then(|t| t.get("id")).and_then(Value::as_str),
            _ => None,
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
            if window_type.and_then(|t| t.get("wingCount")).and_then(Value::as_f64).unwrap_or(1.0) != w {
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
        rooms.push(json!({
            "id": ctx.new_id("room"), "type": "room", "floorId": fid, "categoryCode": ROOM_CATEGORY, "siaCategory": sia,
            "name": name, "boundary": boundary, "color": room_color, "stampAnchor": {"x": js_num(sx / n), "y": js_num(sy / n)},
        }));
    }

    // ── Übrige Bauteile als Kontext-Mesh ──
    let meshes = ifc_meshes(products, &opts.file_name, opts.group.as_deref().unwrap_or("auto"), [dx, dy], now);
    let n_meshes = meshes.len();
    let classified = el.walls.iter().filter(|w| w.info.classified).count()
        + el.openings.iter().filter(|o| o.kind != "hole" && o.info.classified).count()
        + el.slabs.iter().filter(|s| s.info.classified).count()
        + el.columns.iter().filter(|c| c.info.classified).count()
        + el.spaces.iter().filter(|s| s.info.classified).count()
        + products.iter().filter(|p| !p.classifications.is_empty()).count();
    for (k, n) in [("walls", walls.len()), ("openings", openings.len()), ("ceilings", ceilings.len()), ("columns", columns.len()), ("rooms", rooms.len()), ("meshes", n_meshes), ("classified", classified)] {
        ctx.summary.insert(k.into(), n.into());
    }

    let mut ops = Vec::new();
    ops.extend(grown_list_ops("drawingLevels", root.get("drawingLevels"), std::mem::take(&mut ctx.levels)));
    ops.extend(grown_list_ops("components", root.get("components"), std::mem::take(&mut ctx.components)));
    ops.extend(grown_list_ops("wallTypes", root.get("wallTypes"), wall_types));
    if !ceiling_types.is_empty() || root.get("ceilingTypes").is_some_and(|v| crate::grips::truthy(Some(v))) {
        ops.extend(grown_list_ops("ceilingTypes", root.get("ceilingTypes"), ceiling_types));
    }
    if !walls.is_empty() {
        ops.push(Op::Add { collection: "walls".into(), items: walls, at: None });
    }
    for (key, items) in [("openings", openings), ("ceilings", ceilings), ("columns", columns), ("rooms", rooms)] {
        if root.get(key).is_some_and(|v| crate::grips::truthy(Some(v))) {
            if !items.is_empty() {
                ops.push(Op::Add { collection: key.into(), items, at: None });
            }
        } else {
            ops.push(Op::SetField { key: key.into(), value: Some(Value::Array(items)), at: None });
        }
    }
    if n_meshes > 0 {
        ops.extend(context_ops(root, meshes));
    }
    let _ = ctx.root;
    (ops, Value::Object(ctx.summary), n_meshes)
}

/// IFC ins Projekt `root`: als Kontext-Meshes oder (mit `opts.elements`) als Bauteile.
pub fn ifc_import(root: &Map<String, Value>, meta_json: &str, positions: &[f64], indices: &[f64], element_data: &[f64], opts: &IfcOptions, now: f64) -> Result<IfcResult, String> {
    let meta: Value = serde_json::from_str(meta_json).map_err(|e| format!("IFC-Bericht: {e}"))?;
    let products = crate::import_context::decode_ifc_products(&meta, positions, indices)?;
    let report = crate::import_context::ifc_report(&meta, &products);
    if opts.elements {
        let el = decode_elements(&meta, element_data);
        let kept = el.kept.clone();
        let (ops, summary, n) = elements_ops(root, &products, &el, opts, now);
        // Statt der Roh-Bauteile die Zusammenfassung (an derselben Stelle des Berichts).
        let mut report = report;
        if let Some(r) = report.as_object_mut() {
            r.insert("elements".into(), summary.clone());
        }
        return Ok(IfcResult { ops, summary: Some(summary), report, kept, context_objects: n });
    }
    let shift = geo_shift(&products, project_geo_origin(root), &[]);
    let meshes = ifc_meshes(&products, &opts.file_name, opts.group.as_deref().unwrap_or("auto"), shift, now);
    let n = meshes.len();
    Ok(IfcResult { ops: context_ops(root, meshes), summary: None, report, kept: Map::new(), context_objects: n })
}
