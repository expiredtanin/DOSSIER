//! Zeichenbefehle im Kern ([K4] S3, vorher die Objekt-Literale in `commands/cmds/*.ts` und die
//! Werkzeug-Commits in `tools/tools.ts`): aus den Klickpunkten und Optionen eines Befehls entstehen hier
//! die neuen Elemente (Vorgaben aus Typen/Stilen, abgeleitete Felder, ids) samt der Live-Vorschau je
//! Mausschritt. Die Zustandsautomaten (Klicks, Tasten, Optionen) bleiben in der TS-Hülle.
//!
//! Drei Einstiege:
//! - [`ops`] — Ops des Commits (`cmdOps`/`doc_cmd_commit`, Anfrage `{cmd, …, ctx, stamp}`),
//! - [`preview`] — Vorschau-Formen je Mausschritt (`doc_create_preview`: Optionen als JSON, die Punkte
//!   flach), dazu `ok` (würde ein Commit hier etwas erzeugen?) und einige Zahlen für HUD/Zustand,
//! - [`query`] — Treffer zwischen den Schritten (Host-Wand, Profil, Tangenten-Objekt …).
//!
//! Dazu die Gruppen-Zuordnung beim Zeichnen in einer betretenen Gruppe ([`group_ops`], vorher
//! `activeGroupOps` in `state/groupActions.ts`).
//!
//! Zahlen wie in JS (`jsnum`, `jsmath`, `js_fmt`), Rechenreihenfolge wie die frühere TS-Fassung;
//! Elemente mit der Schlüsselreihenfolge der früheren Objekt-Literale.

use crate::cmd_transform::{IdGen, Shapes};
use crate::grips::{arr, field, js_num, num_of, pt, truthy, xy};
use crate::jsmath::hypot2;
use crate::jsnum;
use crate::ops::{id_of, Op};
use kernel2d::{self as k, Vec2 as P};
use serde_json::{json, Map, Value};

pub(crate) type V = (f64, f64);

/// Mindestlänge/-grösse der meisten Befehle (Modell-Meter).
pub(crate) const EPS: f64 = 1e-6;
/// Vorgabe-Höhe, wenn das Geschoss keine hat.
const DEF_HEIGHT: f64 = 2.6;

// ── Anfrage lesen ────────────────────────────────────────────────────────────

pub(crate) fn s_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Zahl der Anfrage (fehlend = NaN, `null` = 0 wie `num_of`).
pub(crate) fn n_of(v: &Value, k: &str) -> f64 {
    num_of(v.get(k))
}

/// Optionale Zahl (`null`/fehlend = keine).
pub(crate) fn opt_n(v: &Value, k: &str) -> Option<f64> {
    match v.get(k) {
        None | Some(Value::Null) => None,
        x => Some(num_of(x)),
    }
}

pub(crate) fn b_of(v: &Value, k: &str) -> bool {
    truthy(v.get(k))
}

/// Punkt der Anfrage: Paar `[x, y]` oder Objekt `{x, y}` (Zustands-Punkte der Hülle unverändert).
pub(crate) fn pair(x: &Value) -> V {
    if x.is_object() {
        return xy(x);
    }
    let n = |i: usize| x.get(i).map_or(f64::NAN, |c| num_of(Some(c)));
    (n(0), n(1))
}

/// Punkt `[x, y]` der Anfrage.
pub(crate) fn p_of(v: &Value, k: &str) -> V {
    v.get(k).map_or((f64::NAN, f64::NAN), pair)
}

/// Optionaler Punkt (`null`/fehlend = keiner).
pub(crate) fn opt_p(v: &Value, k: &str) -> Option<V> {
    match v.get(k) {
        None | Some(Value::Null) => None,
        Some(x) => Some(pair(x)),
    }
}

/// Punktliste `[[x, y], …]` der Anfrage.
pub(crate) fn pts_of(v: &Value, k: &str) -> Vec<V> {
    arr(v.get(k)).iter().map(pair).collect()
}

/// Flache Punkte `[x0, y0, …]` (Vorschau).
pub(crate) fn flat_pts(f: &[f64]) -> Vec<V> {
    f.chunks_exact(2).map(|c| (c[0], c[1])).collect()
}

/// Kontext der Hülle: aktive Ebene/Geschoss, Kategorie, Wandtyp.
pub struct Ctx<'a> {
    pub level: &'a str,
    /// `level.floorHeight`, falls > 0 (sonst Vorgabe).
    pub floor_height: Option<f64>,
    pub cat: &'a str,
    pub wall_type: &'a str,
    /// Schrifthöhe neuer Texte (Modell-Meter, `textHeight` im Kontext): im Grundriss die Vorgabe
    /// [`DEFAULT_TEXT_HEIGHT`], auf einem Layout-Blatt (Papier 1:1) die Papierhöhe.
    pub text_height: f64,
}

/// Schrifthöhe neuer Texte im Grundriss (Modell-Meter, 2.5 mm bei 1:100).
pub const DEFAULT_TEXT_HEIGHT: f64 = 0.25;

fn text_height_of(c: &Value) -> f64 {
    opt_n(c, "textHeight").filter(|h| *h > 0.0 && h.is_finite()).unwrap_or(DEFAULT_TEXT_HEIGHT)
}

pub(crate) fn ctx_of(v: &Value) -> Ctx<'_> {
    let c = v.get("ctx").unwrap_or(&Value::Null);
    let fh = opt_n(c, "floorHeight").filter(|h| *h > 0.0);
    Ctx { level: s_of(c, "level"), floor_height: fh, cat: s_of(c, "cat"), wall_type: s_of(c, "wallType"), text_height: text_height_of(c) }
}

// ── Werte bauen ──────────────────────────────────────────────────────────────

pub(crate) fn pv(p: V) -> Value {
    pt(p.0, p.1)
}

pub(crate) fn pvs(pts: &[V]) -> Value {
    Value::Array(pts.iter().map(|p| pv(*p)).collect())
}

pub(crate) fn s(x: &str) -> Value {
    Value::String(x.into())
}

/// Objekt in der gegebenen Schlüsselreihenfolge.
pub(crate) fn obj(fields: Vec<(&str, Value)>) -> Value {
    let mut m = Map::with_capacity(fields.len());
    for (k, v) in fields {
        m.insert(k.into(), v);
    }
    Value::Object(m)
}

pub(crate) fn add_op(collection: &str, items: Vec<Value>) -> Vec<Op> {
    if items.is_empty() {
        return Vec::new();
    }
    vec![Op::Add { collection: collection.into(), items, at: None }]
}

/// `removeItems(p, collection, ids)`: nur vorhandene ids, je einmal.
pub(crate) fn remove_op(root: &Map<String, Value>, collection: &str, ids: &[&str]) -> Vec<Op> {
    let mut drop: Vec<String> = Vec::new();
    for e in arr(root.get(collection)) {
        if let Some(id) = id_of(e) {
            if ids.contains(&id) && !drop.iter().any(|d| d == id) {
                drop.push(id.into());
            }
        }
    }
    if drop.is_empty() {
        Vec::new()
    } else {
        vec![Op::Remove { collection: collection.into(), ids: drop }]
    }
}

// ── Geometrie-Helfer (wie die früheren TS-Einzeiler) ─────────────────────────

pub(crate) fn seg_len(a: V, b: V) -> f64 {
    hypot2(b.0 - a.0, b.1 - a.1)
}

/// `normalize` aus `model/geometry.ts` (`len || 1`).
pub(crate) fn normalize(a: V) -> V {
    let l = hypot2(a.0, a.1);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    (a.0 / l, a.1 / l)
}

/// Die vier Ecken eines Wandbands (`wallCorners`).
fn wall_corners(start: V, end: V, thickness: f64) -> [V; 4] {
    let h = thickness / 2.0;
    let u = normalize((end.0 - start.0, end.1 - start.1));
    let n = (-u.1, u.0);
    let off = |p: V, s: f64| (p.0 + n.0 * s, p.1 + n.1 * s);
    [off(start, h), off(end, h), off(end, -h), off(start, -h)]
}

/// Achsparalleles Rechteck aus zwei Gegenecken (CCW ab min).
pub(crate) fn rect_corners(a: V, b: V) -> [V; 4] {
    let (x0, x1) = (jsnum::min(a.0, b.0), jsnum::max(a.0, b.0));
    let (y0, y1) = (jsnum::min(a.1, b.1), jsnum::max(a.1, b.1));
    [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
}

/// `n` Punkte auf einem Kreis (`t = (i / n)·2π`, wie die Vorschau-Kreise der Befehle).
pub(crate) fn circle_pts(c: V, r: f64, n: usize) -> Vec<V> {
    (0..n)
        .map(|i| {
            let t = (i as f64 / n as f64) * std::f64::consts::PI * 2.0;
            (c.0 + r * jsnum::cos(t), c.1 + r * jsnum::sin(t))
        })
        .collect()
}

pub(crate) fn to_p(p: V) -> P {
    P::new(p.0, p.1)
}

/// Gerade Kanten eines Rings/Zugs (`polylineEdges`).
pub(crate) fn polyline_edges(pts: &[V], closed: bool) -> Vec<(V, V)> {
    let mut out: Vec<(V, V)> = pts.windows(2).map(|w| (w[0], w[1])).collect();
    if closed && pts.len() > 2 {
        out.push((pts[pts.len() - 1], pts[0]));
    }
    out
}

pub(crate) fn point_segment_distance(p: V, a: V, b: V) -> f64 {
    k::point_segment_distance(to_p(p), to_p(a), to_p(b))
}

// ── Projekt lesen ────────────────────────────────────────────────────────────

/// Gibt es die Kategorie `code` irgendwo im Ebenen-Baum (`layers`, rekursiv über `children`)?
pub(crate) fn has_category(root: &Map<String, Value>, code: &str) -> bool {
    fn walk(list: &[Value], code: &str) -> bool {
        list.iter().any(|c| field(c, "code").and_then(Value::as_str) == Some(code) || walk(arr(field(c, "children")), code))
    }
    walk(arr(root.get("layers")), code)
}

/// Kategorie `code`, falls vorhanden, sonst die aktive.
pub(crate) fn category_or(root: &Map<String, Value>, code: &str, ctx: &Ctx) -> Value {
    s(if has_category(root, code) { code } else { ctx.cat })
}

/// Farbe der Kategorie `code` (erste im Baum, Tiefensuche wie `flat.find`), sonst `def`.
fn category_color(root: &Map<String, Value>, code: &str, def: &str) -> Value {
    fn walk<'a>(list: &'a [Value], code: &str) -> Option<&'a Value> {
        for c in list {
            if field(c, "code").and_then(Value::as_str) == Some(code) {
                return Some(c);
            }
            if let Some(f) = walk(arr(field(c, "children")), code) {
                return Some(f);
            }
        }
        None
    }
    match walk(arr(root.get("layers")), code).and_then(|c| field(c, "color")) {
        None | Some(Value::Null) => s(def),
        Some(c) => c.clone(),
    }
}

pub(crate) fn wall_types(root: &Map<String, Value>) -> &[Value] {
    arr(root.get("wallTypes"))
}

/// Aktiver Wandtyp (Fallback: erster des Projekts).
fn active_wall_type<'a>(root: &'a Map<String, Value>, ctx: &Ctx) -> Option<&'a Value> {
    let list = wall_types(root);
    list.iter().find(|t| id_of(t) == Some(ctx.wall_type)).or(list.first())
}

/// id des aktiven Wandtyps (Fallback: die id aus dem Kontext).
fn active_wall_type_id(root: &Map<String, Value>, ctx: &Ctx) -> Value {
    match active_wall_type(root, ctx) {
        Some(t) => field(t, "id").cloned().unwrap_or(Value::Null),
        None => s(ctx.wall_type),
    }
}

/// Gesamtdicke eines Wand-/Deckentyps (`wallTypeThickness`: Summe der Schichten).
pub(crate) fn type_thickness(t: &Value) -> f64 {
    arr(field(t, "layers")).iter().fold(0.0, |sum, l| sum + num_of(field(l, "thickness")))
}

fn layers_len(t: &Value) -> usize {
    arr(field(t, "layers")).len()
}

pub(crate) fn find<'a>(root: &'a Map<String, Value>, collection: &str, id: &str) -> Option<&'a Value> {
    arr(root.get(collection)).iter().find(|e| id_of(e) == Some(id))
}

pub(crate) fn level_of(e: &Value) -> Option<&str> {
    field(e, "levelId").and_then(Value::as_str)
}

pub(crate) fn floor_of(e: &Value) -> Option<&str> {
    field(e, "floorId").and_then(Value::as_str)
}

// ═════════════════════════════════════════════════════════════════════════════
// Bauteile: Wand, Decke, Raum, Treppe, Öffnung, Dach, Stütze, Extrusion
// ═════════════════════════════════════════════════════════════════════════════

/// Kleinste sinnvolle Wanddicke (Dicke-Feld des Wand-Befehls).
const MIN_THICKNESS: f64 = 0.01;

/// Wirksame Banddicke der Wand-Vorschau: gelockte Dicke (nur einschichtig) oder Wandtyp-Dicke.
fn wall_thickness(root: &Map<String, Value>, ctx: &Ctx, thick: Option<f64>) -> f64 {
    let wt = active_wall_type(root, ctx);
    if let (Some(t), Some(w)) = (thick, wt) {
        if t >= MIN_THICKNESS && layers_len(w) == 1 {
            return t;
        }
    }
    wt.map_or(0.2, type_thickness)
}

/// Einschichtiger Wandtyp mit Dicke `thickness` (gleiches Bauteil wie `base`): vorhanden oder neu.
fn wall_type_for_thickness(root: &Map<String, Value>, base: &Value, thickness: f64, ids: &mut IdGen) -> (Vec<Op>, Value) {
    let layer0 = &arr(field(base, "layers"))[0];
    let component = field(layer0, "componentId");
    let near = |a: f64, b: f64| (a - b).abs() < 1e-4;
    let same_component = |c: Option<&Value>| match (c, component) {
        (None, None) => true,
        (Some(a), Some(b)) => a == b && !a.is_object() && !a.is_array(),
        _ => false,
    };
    for t in wall_types(root) {
        let ls = arr(field(t, "layers"));
        if ls.len() == 1 && same_component(field(&ls[0], "componentId")) && near(num_of(field(&ls[0], "thickness")), thickness) {
            return (Vec::new(), field(t, "id").cloned().unwrap_or(Value::Null));
        }
    }
    let name = match field(base, "name") {
        Some(n) => crate::js_fmt::js_string(n),
        None => "undefined".into(),
    };
    let id = ids.next("WT");
    let mut layer = Vec::new();
    if let Some(c) = component {
        layer.push(("componentId", c.clone()));
    }
    layer.push(("thickness", js_num(thickness)));
    let nt = obj(vec![
        ("id", s(&id)),
        ("name", s(&format!("{name} {} cm", crate::js_fmt::to_fixed(thickness * 100.0, 0)))),
        ("layers", Value::Array(vec![obj(layer)])),
    ]);
    (add_op("wallTypes", vec![nt]), s(&id))
}

/// Wand-Befehl: je Achssegment eine Wand des aktiven Typs (Null-Strecken übersprungen); eine gelockte
/// Dicke (einschichtig) wählt/erzeugt den passenden Wandtyp.
fn wall_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let pts = pts_of(v, "pts");
    let height = ctx.floor_height.unwrap_or(DEF_HEIGHT);
    let mut type_ops = Vec::new();
    let mut type_id = active_wall_type_id(root, ctx);
    if let (Some(base), Some(t)) = (active_wall_type(root, ctx), opt_n(v, "thick")) {
        if layers_len(base) == 1 && t >= MIN_THICKNESS && (t - type_thickness(base)).abs() > 1e-4 {
            let (o, id) = wall_type_for_thickness(root, base, t, ids);
            type_ops = o;
            type_id = id;
        }
    }
    let mut walls = Vec::new();
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        if seg_len(a, b) < EPS {
            continue;
        }
        walls.push(obj(vec![
            ("id", s(&ids.next("W"))),
            ("type", s("wall")),
            ("floorId", s(ctx.level)),
            ("categoryCode", s(ctx.cat)),
            ("start", pv(a)),
            ("end", pv(b)),
            ("wallTypeId", type_id.clone()),
            ("height", js_num(height)),
        ]));
    }
    if walls.is_empty() {
        return Vec::new();
    }
    type_ops.extend(add_op("walls", walls));
    type_ops
}

/// Wand-Vorschau: je Segment das Band (Dicke wie beim Commit) und die Achse.
fn wall_preview(root: &Map<String, Value>, v: &Value, ctx: &Ctx, pts: &[V], out: &mut Shapes) {
    let t = wall_thickness(root, ctx, opt_n(v, "thick"));
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        if seg_len(a, b) < EPS {
            continue;
        }
        out.poly(&wall_corners(a, b, t));
        out.line(a, b);
    }
}

/// `normalizeOutline`: doppelte Folgepunkte und den schliessenden Duplikat-Punkt weg, CCW erzwingen.
fn normalize_outline(pts: &[V]) -> Option<Vec<V>> {
    let eq = |a: V, b: V| (a.0 - b.0).abs() <= k::EPS && (a.1 - b.1).abs() <= k::EPS;
    let mut clean: Vec<V> = Vec::new();
    for p in pts {
        if clean.last().is_none_or(|l| !eq(*l, *p)) {
            clean.push(*p);
        }
    }
    if clean.len() > 1 && eq(clean[0], clean[clean.len() - 1]) {
        clean.pop();
    }
    if clean.len() < 3 {
        return None;
    }
    let ps: Vec<P> = clean.iter().map(|p| to_p(*p)).collect();
    if !k::is_ccw(&ps) {
        clean.reverse();
    }
    Some(clean)
}

fn abs_area(pts: &[V]) -> f64 {
    let ps: Vec<P> = pts.iter().map(|p| to_p(*p)).collect();
    k::signed_area(&ps).abs()
}

/// Decke aus einem geschlossenen Umriss (entartet → nichts).
fn ceiling_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let Some(outline) = normalize_outline(&pts_of(v, "pts")) else { return Vec::new() };
    if abs_area(&outline) < 1e-4 {
        return Vec::new();
    }
    add_op(
        "ceilings",
        vec![obj(vec![
            ("id", s(&ids.next("C"))),
            ("type", s("ceiling")),
            ("floorId", s(ctx.level)),
            ("categoryCode", category_or(root, "30", ctx)),
            ("outline", pvs(&outline)),
            ("wallTypeId", active_wall_type_id(root, ctx)),
        ])],
    )
}

/// Wände des Geschosses als `[n, (ax, ay, bx, by, dicke)…]` für die Raumerkennung.
fn floor_walls_flat(root: &Map<String, Value>, level: &str) -> Vec<f64> {
    let types = wall_types(root);
    let mut out = vec![0.0];
    let mut n = 0;
    for w in arr(root.get("walls")) {
        if floor_of(w) != Some(level) {
            continue;
        }
        let tid = field(w, "wallTypeId").and_then(Value::as_str);
        let wt = types.iter().find(|t| id_of(t) == tid);
        let (a, b) = (xy(field(w, "start").unwrap_or(&Value::Null)), xy(field(w, "end").unwrap_or(&Value::Null)));
        out.extend([a.0, a.1, b.0, b.1, wt.map_or(0.2, type_thickness)]);
        n += 1;
    }
    out[0] = n as f64;
    out
}

/// Lichter Umriss der Zelle um `at` (Raum „innen“), `None` = keine geschlossene Zelle.
fn room_inside(root: &Map<String, Value>, level: &str, at: V) -> Option<Vec<V>> {
    let f = crate::room_boundary::from_point(at.0, at.1, &floor_walls_flat(root, level), 0.05, true);
    if f.is_empty() {
        return None;
    }
    let n = f[0] as usize;
    Some((0..n).map(|i| (f[1 + 2 * i], f[2 + 2 * i])).collect())
}

/// Raum aus Umriss (Modus „manuell“: `pts`; „innen“: `at` → Zelle).
fn room_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let boundary = match opt_p(v, "at") {
        Some(at) => match room_inside(root, ctx.level, at) {
            Some(b) if b.len() >= 3 => b,
            _ => return Vec::new(),
        },
        None => pts_of(v, "pts"),
    };
    let ring: Vec<[f64; 2]> = boundary.iter().map(|p| [p.0, p.1]).collect();
    let e = crate::room_area::evaluate(&ring, 0.0);
    if boundary.len() < 3 || e.gross < 1e-4 {
        return Vec::new();
    }
    let code = if has_category(root, "60") { "60" } else { ctx.cat };
    let name = format!("Raum {}", arr(root.get("rooms")).len() + 1);
    let doc = json!({ "version": 1, "paragraphs": [{ "runs": [{ "text": name, "marks": {} }], "align": "center" }] });
    add_op(
        "rooms",
        vec![obj(vec![
            ("id", s(&ids.next("RM"))),
            ("type", s("room")),
            ("floorId", s(ctx.level)),
            ("categoryCode", s(code)),
            ("siaCategory", s("HNF")),
            ("name", s(&name)),
            ("boundary", pvs(&boundary)),
            ("color", category_color(root, code, "#5a7a9a")),
            ("stampAnchor", pt(e.centroid[0], e.centroid[1])),
            ("stampDoc", doc),
        ])],
    )
}

// ── Treppe ───────────────────────────────────────────────────────────────────

const MIN_STEPS: f64 = 2.0;

/// Stufenzahl aus Soll-Auftritt und Lauflänge (`stepsFromTread`; mindestens 0.24 m Auftritt).
pub fn steps_from_tread(auftritt: f64, run_length: f64) -> f64 {
    let a = jsnum::max(0.05, auftritt);
    let raw = jsnum::round(run_length / a);
    let max_by_run = if run_length > 0.0 { jsnum::max(MIN_STEPS, (run_length / 0.24).floor() + 1.0) } else { raw };
    jsnum::max(MIN_STEPS, jsnum::min(raw, max_by_run))
}

/// Aufgelöste Treppe des Befehls (`buildStair`): Felder in der Reihenfolge des früheren Literals.
struct StairBuilt {
    fields: Vec<(&'static str, Value)>,
    params: [f64; 16],
    rise: f64,
    steps: f64,
}

fn build_stair(root: &Map<String, Value>, v: &Value, ctx: &Ctx, id: Value) -> StairBuilt {
    let shape = s_of(v, "shape");
    let start = p_of(v, "start");
    let cursor = p_of(v, "cursor");
    let width = n_of(v, "width");
    let referenz = s_of(v, "referenz");
    let rise = opt_n(v, "rise").unwrap_or(ctx.floor_height.unwrap_or(DEF_HEIGHT));
    let d = (cursor.0 - start.0, cursor.1 - start.1);
    let dist = jsnum::max(0.1, hypot2(d.0, d.1));
    let dir = if dist > EPS {
        let l = hypot2(d.0, d.1);
        let l = if l == 0.0 || l.is_nan() { 1e-9 } else { l };
        (d.0 / l, d.1 / l)
    } else {
        (1.0, 0.0)
    };
    let run_length = if shape == "spiral" { jsnum::max(0.5, dist) } else { dist };
    let steps = if s_of(v, "treadMode") == "with" {
        steps_from_tread(n_of(v, "auftritt"), run_length)
    } else {
        opt_n(v, "steps").unwrap_or_else(|| crate::stair::default_step_count(rise, run_length) as f64)
    };
    let up = b_of(v, "up");
    let mut f: Vec<(&'static str, Value)> = vec![
        ("id", id),
        ("type", s("stair")),
        ("floorId", s(ctx.level)),
        ("categoryCode", category_or(root, "40", ctx)),
        ("shape", s(shape)),
        ("start", pv(start)),
        ("dir", pv(dir)),
        ("runLength", js_num(run_length)),
        ("width", js_num(width)),
        ("referenz", s(referenz)),
        ("totalRise", js_num(rise)),
        ("stepCount", js_num(steps)),
        ("up", Value::Bool(up)),
    ];
    let nan = f64::NAN;
    let form = match shape {
        "L" => 1.0,
        "spiral" => 2.0,
        _ => 0.0,
    };
    let refz = match referenz {
        "links" => 1.0,
        "rechts" => 2.0,
        _ => 0.0,
    };
    let mut params = [form, start.0, start.1, dir.0, dir.1, run_length, nan, nan, nan, nan, nan, nan, width, steps, if up { 1.0 } else { 0.0 }, refz];
    if shape == "L" {
        f.push(("run2Length", js_num(run_length)));
        f.push(("turn", js_num(1.0)));
        params[6] = run_length;
        params[7] = 1.0;
    } else if shape == "spiral" {
        f.push(("center", pv(start)));
        f.push(("radius", js_num(dist)));
        f.push(("sweep", js_num(270.0)));
        // Startpunkt am äusseren Rand: die Lauflinie beginnt hier (Schlüssel bleibt an seiner Stelle).
        f[5].1 = pv(cursor);
        params[1] = cursor.0;
        params[2] = cursor.1;
        params[8] = start.0;
        params[9] = start.1;
        params[10] = dist;
        params[11] = 270.0;
    }
    StairBuilt { fields: f, params, rise, steps }
}

fn stair_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let b = build_stair(root, v, ctx, s(&ids.next("ST")));
    add_op("stairs", vec![obj(b.fields)])
}

/// Treppen-Vorschau: Tritte, Podest, Lauflinie; `info = [Stufenzahl]`.
fn stair_preview(root: &Map<String, Value>, v: &Value, ctx: &Ctx, out: &mut Shapes, info: &mut Vec<f64>) {
    let b = build_stair(root, v, ctx, Value::Null);
    info.push(b.steps);
    let f = crate::stair::geometry(&b.params, b.rise);
    if f.len() < 4 {
        return;
    }
    let at = |i: usize| (f[i], f[i + 1]);
    let pts_at = |i: usize, n: usize| -> Vec<V> { (0..n).map(|k| at(i + 2 * k)).collect() };
    let n_treads = f[3] as usize;
    let mut i = 4;
    for _ in 0..n_treads {
        out.poly(&pts_at(i + 3, 4));
        i += 11;
    }
    let nl = f[i];
    i += 1;
    if nl >= 0.0 {
        let n = nl as usize;
        out.poly(&pts_at(i, n));
        i += 2 * n;
    }
    let n_run = f[i] as usize;
    i += 1;
    if n_run >= 2 {
        out.poly_open(&pts_at(i, n_run));
    }
}

// ── Öffnung ──────────────────────────────────────────────────────────────────

/// Pick-Toleranz der Host-Wand.
const WALL_PICK_DIST: f64 = 0.6;

/// Auf die Wandachse projizierter Fusspunkt: (Abstand vom Wandanfang, Fusspunkt, Distanz).
fn project_onto_wall(start: V, end: V, p: V) -> (f64, V, f64) {
    let ax = (end.0 - start.0, end.1 - start.1);
    let d = ax.0 * ax.0 + ax.1 * ax.1;
    let len2 = if d == 0.0 || d.is_nan() { 1e-9 } else { d };
    let raw = ((p.0 - start.0) * ax.0 + (p.1 - start.1) * ax.1) / len2;
    let t = jsnum::max(0.0, jsnum::min(1.0, raw));
    let foot = (start.0 + ax.0 * t, start.1 + ax.1 * t);
    let dist = hypot2(p.0 - foot.0, p.1 - foot.1);
    (t * len2.sqrt(), foot, dist)
}

/// Nächste Wand des Geschosses zum Klickpunkt (innerhalb der Toleranz).
fn pick_wall<'a>(root: &'a Map<String, Value>, level: &str, p: V) -> Option<(&'a Value, V, V)> {
    let mut best: Option<(&Value, V, V, f64)> = None;
    for w in arr(root.get("walls")) {
        if floor_of(w) != Some(level) {
            continue;
        }
        let (a, b) = (xy(field(w, "start").unwrap_or(&Value::Null)), xy(field(w, "end").unwrap_or(&Value::Null)));
        let (_, _, dist) = project_onto_wall(a, b, p);
        if dist <= WALL_PICK_DIST && best.is_none_or(|x| dist < x.3) {
            best = Some((w, a, b, dist));
        }
    }
    best.map(|(w, a, b, _)| (w, a, b))
}

/// Öffnung in eine Wand (`start`/`end` der Host-Wand beim Picken, `pos` = Abstand vom Wandanfang).
fn opening_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let (st, en) = (p_of(v, "start"), p_of(v, "end"));
    let len = hypot2(en.0 - st.0, en.1 - st.1);
    let width = jsnum::max(0.1, jsnum::min(n_of(v, "width"), len));
    let position = jsnum::max(0.0, jsnum::min(n_of(v, "pos"), jsnum::max(0.0, len - width)));
    let door = s_of(v, "kind") == "door";
    let lib = arr(root.get(if door { "doorTypes" } else { "windowTypes" }));
    let type_id = lib.first().and_then(|t| field(t, "id")).filter(|id| truthy(Some(id)));
    let mut f = vec![
        ("id", s(&ids.next("O"))),
        ("type", s("opening")),
        ("hostWallId", s(s_of(v, "wall"))),
        ("categoryCode", category_or(root, "21", ctx)),
        ("kind", s(s_of(v, "kind"))),
        ("position", js_num(position)),
        ("width", js_num(width)),
        ("height", js_num(n_of(v, "height"))),
        ("sillHeight", js_num(if door { 0.0 } else { n_of(v, "sill") })),
    ];
    if let Some(t) = type_id {
        f.push(("typeId", t.clone()));
    }
    if door {
        f.push(("hinge", s(s_of(v, "hinge"))));
        f.push(("swing", s(s_of(v, "side"))));
        f.push(("openingDir", s(s_of(v, "dir"))));
        f.push(("swingAngle", js_num(n_of(v, "swingAngle"))));
    }
    add_op("openings", vec![obj(f)])
}

/// Öffnungs-Vorschau (Lücken-Balken + Symbol). `pos` fehlt → aus dem Cursor projiziert.
/// `info = [pos, von, ax, ay, bx, by, mx, my]` (Position für den Zustand, HUD/Stützpunkte).
fn opening_preview(v: &Value, cursor: Option<V>, out: &mut Shapes, info: &mut Vec<f64>) {
    let (st, en) = (p_of(v, "start"), p_of(v, "end"));
    let pos = match (opt_n(v, "pos"), cursor) {
        (Some(p), _) => p,
        (None, Some(c)) => project_onto_wall(st, en, c).0,
        (None, None) => 0.0,
    };
    let ax = (en.0 - st.0, en.1 - st.1);
    let l = hypot2(ax.0, ax.1);
    let len = if l == 0.0 || l.is_nan() { 1e-9 } else { l };
    let u = (ax.0 / len, ax.1 / len);
    let n = (-u.1, u.0);
    let width = n_of(v, "width");
    let from = jsnum::max(0.0, jsnum::min(pos, len));
    let to = jsnum::max(from, jsnum::min(from + width, len));
    let a = (st.0 + u.0 * from, st.1 + u.1 * from);
    let b = (st.0 + u.0 * to, st.1 + u.1 * to);
    let half = 0.15;
    let off = |p: V, s: f64| (p.0 + n.0 * s, p.1 + n.1 * s);
    out.poly(&[off(a, half), off(b, half), off(b, -half), off(a, -half)]);
    if s_of(v, "kind") == "door" {
        let swing = if s_of(v, "side") == "left" { 1.0 } else { -1.0 };
        let dir = if s_of(v, "dir") == "in" { 1.0 } else { -1.0 };
        let hinge = if s_of(v, "hinge") == "start" { a } else { b };
        out.line(hinge, off(hinge, swing * dir * width));
    } else {
        out.line(a, b);
    }
    let m = (to - from) / 2.0;
    info.extend([pos, from, a.0, a.1, b.0, b.1, a.0 + u.0 * m, a.1 + u.1 * m]);
}

// ── Dach, Stütze ─────────────────────────────────────────────────────────────

fn roof_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let (a, b) = (p_of(v, "a"), p_of(v, "b"));
    let (w, d) = ((b.0 - a.0).abs(), (b.1 - a.1).abs());
    if w < 0.1 || d < 0.1 {
        return Vec::new();
    }
    let shape = s_of(v, "shape");
    add_op(
        "roofs",
        vec![obj(vec![
            ("id", s(&ids.next("RF"))),
            ("type", s("roof")),
            ("floorId", s(ctx.level)),
            ("categoryCode", category_or(root, "31", ctx)),
            ("outline", pvs(&rect_corners(a, b))),
            ("shape", s(shape)),
            ("pitchDeg", js_num(if shape == "flach" { 0.0 } else { 30.0 })),
            ("overhang", js_num(0.4)),
            ("ridgeAxis", s(if w >= d { "x" } else { "y" })),
            ("thickness", js_num(0.2)),
        ])],
    )
}

/// Stützen-Profil: rund (Durchmesser `size`) oder quadratisch (Kante `size`).
fn column_profile(v: &Value) -> Value {
    let size = n_of(v, "size");
    if s_of(v, "kind") == "round" {
        obj(vec![("kind", s("round")), ("radius", js_num(size / 2.0))])
    } else {
        obj(vec![("kind", s("rect")), ("width", js_num(size)), ("depth", js_num(size))])
    }
}

fn column_ops(v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    add_op(
        "columns",
        vec![obj(vec![
            ("id", s(&ids.next("column"))),
            ("type", s("column")),
            ("floorId", s(ctx.level)),
            ("categoryCode", s("50")),
            ("position", pv(p_of(v, "at"))),
            ("profile", column_profile(v)),
            ("rotation", js_num(0.0)),
            ("height", js_num(ctx.floor_height.unwrap_or(DEF_HEIGHT))),
        ])],
    )
}

/// Grundriss einer Stütze ohne Drehung (`columnFootprint`: rund 32 Punkte, sonst 4 Ecken).
fn column_footprint(at: V, v: &Value) -> Vec<V> {
    let size = n_of(v, "size");
    if s_of(v, "kind") == "round" {
        return circle_pts(at, size / 2.0, 32);
    }
    let (hw, hd) = (size / 2.0, size / 2.0);
    let (cos, sin) = (jsnum::cos(0.0), jsnum::sin(0.0));
    [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)].iter().map(|p| (at.0 + p.0 * cos - p.1 * sin, at.1 + p.0 * sin + p.1 * cos)).collect()
}

// ── Extrusion ────────────────────────────────────────────────────────────────

/// Profil-Pick-Toleranz.
const PROFILE_HIT_TOL: f64 = 0.25;

/// Extrudierbares Profil einer Zeichnung: geschlossene Polylinie (≥ 3 Punkte), Rechteck, Kreis.
/// Punkte als JSON-Werte (Polylinie: die gespeicherten), dazu `circle` beim Kreis.
fn profile_of(d: &Value) -> Option<(Vec<Value>, Option<Value>)> {
    let g = field(d, "geom")?;
    match field(g, "shape").and_then(Value::as_str)? {
        "polyline" => {
            let pts = arr(field(g, "pts"));
            (truthy(field(g, "closed")) && pts.len() >= 3).then(|| (pts.to_vec(), None))
        }
        "rect" => {
            let (mn, mx) = (field(g, "min")?, field(g, "max")?);
            let (a, b) = (xy(mn), xy(mx));
            Some((vec![mn.clone(), pt(b.0, a.1), mx.clone(), pt(a.0, b.1)], None))
        }
        "circle" => {
            let c = field(g, "center")?;
            let r = field(g, "r").cloned().unwrap_or(Value::Null);
            let pts = circle_pts(xy(c), num_of(Some(&r)), 48).into_iter().map(pv).collect();
            Some((pts, Some(obj(vec![("center", c.clone()), ("r", r)]))))
        }
        _ => None,
    }
}

fn profile_json(d: &Value) -> Value {
    match profile_of(d) {
        Some((pts, circle)) => json!({ "id": id_of(d), "pts": pts, "circle": circle }),
        None => Value::Null,
    }
}

/// Nächstes Profil (Kantenabstand < Toleranz) der Ebene am Punkt.
fn pick_profile<'a>(root: &'a Map<String, Value>, level: &str, at: V) -> Option<&'a Value> {
    let mut best = None;
    let mut best_d = PROFILE_HIT_TOL;
    for d in arr(root.get("drawings2d")) {
        if level_of(d) != Some(level) {
            continue;
        }
        let Some((pts, _)) = profile_of(d) else { continue };
        let pts: Vec<V> = pts.iter().map(xy).collect();
        for (a, b) in polyline_edges(&pts, true) {
            let dd = point_segment_distance(at, a, b);
            if dd < best_d {
                best_d = dd;
                best = Some(d);
            }
        }
    }
    best
}

/// Extrusion eines Profils (die Quelle verschwindet, der Körper kommt dazu).
fn extrude_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let src = s_of(v, "source");
    let Some((pts, circle)) = find(root, "drawings2d", src).and_then(profile_of) else { return Vec::new() };
    let taper = n_of(v, "taper");
    let mut f = vec![
        ("id", s(&ids.next("extrude"))),
        ("type", s("extrudedSolid")),
        ("levelId", s(ctx.level)),
        ("points", Value::Array(pts)),
        ("height", js_num(n_of(v, "height"))),
    ];
    if let Some(c) = circle {
        f.push(("circle", c));
    }
    if taper > 0.0 {
        f.push(("taper", js_num(taper)));
    }
    let mut ops = remove_op(root, "drawings2d", &[src]);
    ops.extend(add_op("extrudedSolids", vec![obj(f)]));
    ops
}

// ═════════════════════════════════════════════════════════════════════════════
// Einstiege
// ═════════════════════════════════════════════════════════════════════════════

/// Ops eines Zeichenbefehls (`None` = kein Zeichenbefehl).
pub fn ops(root: &Map<String, Value>, v: &Value) -> Option<Vec<Op>> {
    let ctx = ctx_of(v);
    let mut ids = IdGen::new(s_of(v, "stamp"));
    let ids = &mut ids;
    Some(match s_of(v, "cmd") {
        "wall" => wall_ops(root, v, &ctx, ids),
        "ceiling" => ceiling_ops(root, v, &ctx, ids),
        "room" => room_ops(root, v, &ctx, ids),
        "stair" => stair_ops(root, v, &ctx, ids),
        "opening" => opening_ops(root, v, &ctx, ids),
        "roof" => roof_ops(root, v, &ctx, ids),
        "column" => column_ops(v, &ctx, ids),
        "extrude" => extrude_ops(root, v, &ctx, ids),
        _ => return crate::cmd_draw::ops(root, v, &ctx, ids).or_else(|| crate::cmd_solid::ops(root, v, &ctx, ids)),
    })
}

/// Ergebnis einer Vorschau: Formen, ob ein Commit hier etwas erzeugte, Zusatzzahlen (je Befehl).
#[derive(Default)]
pub struct Preview {
    pub shapes: Shapes,
    pub ok: bool,
    pub info: Vec<f64>,
}

impl Preview {
    /// Flach: `[ok, nInfo, info…, Formen…]` (Formen wie `doc_cmd_preview`).
    pub fn flat(self) -> Vec<f64> {
        let mut out = Vec::with_capacity(2 + self.info.len() + self.shapes.buf.len());
        out.push(if self.ok { 1.0 } else { 0.0 });
        out.push(self.info.len() as f64);
        out.extend(self.info);
        out.extend(self.shapes.buf);
        out
    }
}

/// Vorschau eines Zeichenbefehls: `v` = Optionen (`cmd`, …, `ctx`), `pts` = die Punkte flach (je Befehl
/// die gesetzten Punkte und zuletzt der Cursor).
pub fn preview(root: &Map<String, Value>, v: &Value, pts: &[f64]) -> Preview {
    preview_req(root, &Req::new(v.clone()), pts)
}

/// Gelesene Vorschau-Anfrage: die Optionen und, für den Mausschritt ohne Hash-Suchen, Befehl und Kontext.
pub struct Req {
    pub v: Value,
    cmd: String,
    level: String,
    floor_height: Option<f64>,
    cat: String,
    wall_type: String,
    text_height: f64,
}

impl Req {
    pub fn new(v: Value) -> Req {
        let c = ctx_of(&v);
        let (level, floor_height, cat, wall_type) = (c.level.to_string(), c.floor_height, c.cat.to_string(), c.wall_type.to_string());
        let text_height = c.text_height;
        Req { cmd: s_of(&v, "cmd").to_string(), v, level, floor_height, cat, wall_type, text_height }
    }
}

/// Wie [`preview`] mit gelesener Anfrage (Mausschritt: dieselbe Anfrage, neue Punkte).
pub fn preview_req(root: &Map<String, Value>, req: &Req, pts: &[f64]) -> Preview {
    let v = &req.v;
    let ctx = Ctx { level: &req.level, floor_height: req.floor_height, cat: &req.cat, wall_type: &req.wall_type, text_height: req.text_height };
    let pts = flat_pts(pts);
    let mut p = Preview { ok: true, ..Default::default() };
    let out = &mut p.shapes;
    match req.cmd.as_str() {
        "wall" => wall_preview(root, v, &ctx, &pts, out),
        "stair" => stair_preview(root, v, &ctx, out, &mut p.info),
        "opening" => opening_preview(v, pts.first().copied(), out, &mut p.info),
        "roomInside" => p.ok = pts.first().and_then(|at| room_inside(root, ctx.level, *at)).is_some_and(|b| b.len() >= 3),
        "column" => {
            if let Some(at) = pts.first() {
                out.poly(&column_footprint(*at, v));
            }
        }
        "rect4" => {
            // Aufgezogenes Rechteck (Dach, Deckenaussparung, Textrahmen …): erste Ecke + Cursor.
            if pts.len() >= 2 {
                out.poly(&rect_corners(pts[0], pts[1]));
            }
        }
        _ => {
            if !crate::cmd_draw::preview(root, v, &ctx, &pts, &mut p) && !crate::cmd_solid::preview(root, v, &pts, &mut p) {
                p.ok = false;
            }
        }
    }
    p
}

/// Treffer-Abfragen der Zeichenbefehle (`None` = keine Abfrage dieses Moduls).
pub fn query(root: &Map<String, Value>, v: &Value) -> Option<Result<Value, String>> {
    let at = p_of(v, "pt");
    let level = s_of(v, "level");
    Some(Ok(match s_of(v, "q") {
        "pickWall" => match pick_wall(root, level, at) {
            Some((w, a, b)) => json!({ "hit": { "id": id_of(w), "start": [js_num(a.0), js_num(a.1)], "end": [js_num(b.0), js_num(b.1)], "t": js_num(project_onto_wall(a, b, at).0) } }),
            None => json!({ "hit": null }),
        },
        "pickProfile" => json!({ "hit": pick_profile(root, level, at).map_or(Value::Null, profile_json) }),
        "profile" => json!({ "hit": find(root, "drawings2d", s_of(v, "id")).map_or(Value::Null, profile_json) }),
        _ => return crate::cmd_draw::query(root, v).or_else(|| crate::cmd_solid::query(root, v)).map(Ok),
    }))
}

// ── Gruppen-Zuordnung ────────────────────────────────────────────────────────

/// Mitglieds-Listen einer Gruppe und ihre Element-Listen (Reihenfolge wie `KEYS` in der Hülle).
const MEMBER_KEYS: [(&str, &str); 8] = [
    ("wallIds", "walls"),
    ("drawingIds", "drawings2d"),
    ("ceilingIds", "ceilings"),
    ("roomIds", "rooms"),
    ("stairIds", "stairs"),
    ("columnIds", "columns"),
    ("roofIds", "roofs"),
    ("openingIds", "openings"),
];

/// Zeichnet man in einer betretenen Gruppe (`group` = innerste aktive Gruppe), werden die neu
/// eingefügten Elemente (`add`-Ops) ihr Mitglied: eine `replace`-Op der Gruppe mit den ergänzten Listen
/// (Vereinigung, erste Vorkommen in Reihenfolge). Leer ohne neue Elemente oder ohne die Gruppe.
pub fn group_ops(root: &Map<String, Value>, ops: &[Op], group: &str) -> Vec<Op> {
    let Some(g) = find(root, "groups", group) else { return Vec::new() };
    let mut added: Vec<(&str, Vec<String>)> = Vec::new();
    for (key, coll) in MEMBER_KEYS {
        let existing = arr(root.get(coll));
        let mut ids: Vec<String> = Vec::new();
        for op in ops {
            if let Op::Add { collection, items, .. } = op {
                if collection != coll {
                    continue;
                }
                for e in items {
                    if let Some(id) = id_of(e) {
                        if !existing.iter().any(|x| id_of(x) == Some(id)) {
                            ids.push(id.into());
                        }
                    }
                }
            }
        }
        if !ids.is_empty() {
            added.push((key, ids));
        }
    }
    if added.is_empty() {
        return Vec::new();
    }
    let mut m = g.as_object().cloned().unwrap_or_default();
    for (key, _) in MEMBER_KEYS {
        let mut list: Vec<Value> = Vec::new();
        let mut push = |x: &Value| {
            if !list.contains(x) {
                list.push(x.clone());
            }
        };
        arr(m.get(key)).iter().for_each(&mut push);
        if let Some((_, ids)) = added.iter().find(|(k, _)| *k == key) {
            ids.iter().for_each(|id| push(&Value::String(id.clone())));
        }
        m.insert(key.into(), Value::Array(list));
    }
    vec![Op::Replace { collection: "groups".into(), entity: Value::Object(m) }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }
    fn items(ops: &[Op], i: usize) -> Value {
        ops[i].to_json()["items"].clone()
    }
    const CTX: &str = r#"{"level":"F1","floorHeight":3,"cat":"20","wallType":"WT1"}"#;
    fn req(extra: Value) -> Value {
        let mut v = extra;
        v["ctx"] = serde_json::from_str(CTX).unwrap();
        v["stamp"] = json!("s");
        v
    }

    #[test]
    fn waende_je_segment_mit_typ_und_hoehe() {
        let r = root(json!({"wallTypes": [{"id": "WT1", "name": "Beton", "layers": [{"componentId": "c", "thickness": 0.2}]}]}));
        let o = ops(&r, &req(json!({"cmd": "wall", "pts": [[0, 0], [4, 0], [4, 0], [4, 3]], "thick": null}))).unwrap();
        let w = items(&o, 0);
        assert_eq!(w.as_array().unwrap().len(), 2);
        assert_eq!(w[0], json!({"id": "W-s-1", "type": "wall", "floorId": "F1", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 4, "y": 0}, "wallTypeId": "WT1", "height": 3}));
        // Gelockte Dicke → neuer einschichtiger Typ vor den Wänden.
        let o = ops(&r, &req(json!({"cmd": "wall", "pts": [[0, 0], [4, 0]], "thick": 0.3}))).unwrap();
        assert_eq!(items(&o, 0)[0], json!({"id": "WT-s-1", "name": "Beton 30 cm", "layers": [{"componentId": "c", "thickness": 0.3}]}));
        assert_eq!(items(&o, 1)[0]["wallTypeId"], "WT-s-1");
    }

    #[test]
    fn treppe_stufen_aus_auftritt() {
        assert_eq!(steps_from_tread(0.29, 3.0), 10.0);
        assert_eq!(steps_from_tread(0.29, 3.1), 11.0);
        assert_eq!(steps_from_tread(0.29, 0.01), MIN_STEPS);
        assert_eq!(steps_from_tread(0.29, -1.0), MIN_STEPS);
        assert_eq!(steps_from_tread(0.25, 2.5), 10.0);
        // Auftritt nie unter 0.24 m.
        let s = steps_from_tread(0.01, 10.0);
        assert!(10.0 / (s - 1.0) >= 0.24 - 1e-9);
        assert_eq!(steps_from_tread(0.29, 10.0 * 0.29), 10.0);
    }

    #[test]
    fn raum_innen_und_gruppe() {
        let wt = json!([{"id": "WT1", "layers": [{"thickness": 0.2}]}]);
        let wall = |id: &str, a: (f64, f64), b: (f64, f64)| json!({"id": id, "floorId": "F1", "wallTypeId": "WT1", "start": {"x": a.0, "y": a.1}, "end": {"x": b.0, "y": b.1}});
        let r = root(json!({"wallTypes": wt, "rooms": [], "layers": [{"code": "60", "color": "#abc"}], "walls": [
            wall("a", (0.0, 0.0), (5.0, 0.0)), wall("b", (5.0, 0.0), (5.0, 4.0)), wall("c", (5.0, 4.0), (0.0, 4.0)), wall("d", (0.0, 4.0), (0.0, 0.0))],
            "groups": [{"id": "g", "name": "G", "wallIds": ["a"], "drawingIds": []}]}));
        let o = ops(&r, &req(json!({"cmd": "room", "at": [2, 2]}))).unwrap();
        let room = &items(&o, 0)[0];
        assert_eq!(room["name"], "Raum 1");
        assert_eq!(room["color"], "#abc");
        assert_eq!(room["boundary"].as_array().unwrap().len(), 4);
        let g = group_ops(&r, &o, "g");
        let e = g[0].to_json()["entity"].clone();
        assert_eq!(e["roomIds"], json!(["RM-s-1"]));
        assert_eq!(e["wallIds"], json!(["a"]));
        assert!(group_ops(&r, &o, "x").is_empty());
        assert!(group_ops(&r, &[], "g").is_empty());
    }

    #[test]
    fn oeffnung_pick_und_vorschau() {
        let r = root(json!({"walls": [{"id": "w", "floorId": "F1", "start": {"x": 0, "y": 0}, "end": {"x": 6, "y": 0}}], "windowTypes": [{"id": "FT"}]}));
        let q = query(&r, &json!({"q": "pickWall", "level": "F1", "pt": [2, 0.3]})).unwrap().unwrap();
        assert_eq!(q["hit"]["id"], "w");
        assert_eq!(q["hit"]["t"], 2);
        let o = ops(&r, &req(json!({"cmd": "opening", "wall": "w", "start": [0, 0], "end": [6, 0], "kind": "window", "pos": 5.5, "width": 1.2, "height": 1.2, "sill": 0.9}))).unwrap();
        let op = &items(&o, 0)[0];
        assert_eq!(op["position"], 4.8);
        assert_eq!(op["typeId"], "FT");
        let p = preview(&r, &json!({"cmd": "opening", "start": [0, 0], "end": [6, 0], "kind": "window", "width": 1.2, "pos": null}), &[2.0, 1.0]);
        assert_eq!(p.info[0], 2.0);
        assert_eq!(p.shapes.count, 2);
    }
}

