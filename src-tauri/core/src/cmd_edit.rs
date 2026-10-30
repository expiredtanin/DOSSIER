//! Editier-Befehle der 2D-Zeichnungen im Kern ([K4] S3, vorher `commands/cmds/{trim,extend,fillet,
//! chamfer,break,offset,join}.ts` und `editors/explode.ts`): Treffer-Bestimmung (Kurve, offene Kurve,
//! Ecke), die Vorschau-Formen je Mausschritt und die Ops des Commits. Die Geometrie selbst steht in
//! `kernel2d` (Trim/Extend mit Bögen, Verrundung, Fasung, Bruch, Offset, Verketten); hier die
//! Übersetzung Zeichnung ↔ Kurve, die Auswahl und die Elemente des Ergebnisses.
//!
//! Wände ([113]): Trim, Extend, Bruch, Offset und Join nehmen auch Wände (gerade und Bogen); dazu Teilen
//! (`splitAt`/`splitInter`) und Verrunden zweier Wände (`filletWalls`). Die Wand-Rechnung steht in
//! `cmd_wall_edit.rs`; hier nur Treffer (Wände zählen mit, Abstand zum Wandkörper) und Verteilung.
//!
//! Rechnung auf der rohen Projekt-Wurzel (Attribute der Quelle bleiben samt Schlüsselreihenfolge;
//! unveränderte Punkte werden als dieselben JSON-Werte übernommen wie das Array-Spreizen in TS).

use crate::cmd_transform::{IdGen, Shapes};
use crate::cmd_wall_edit as wall_edit;
use crate::grips::{arr, field, js_num, num_of, num_or, pt, truthy, with, with_all, xy};
use crate::jsmath::hypot2;
use crate::jsnum;
use crate::ops::{id_of, Op};
use kernel2d::{self as k, Vec2 as P};
use serde_json::{Map, Value};

/// Pick-Toleranz für Kurven (Modell-Meter).
const HIT_TOL: f64 = 0.25;
/// Pick-Toleranz für Ecken (Verrunden/Fasen).
const CORNER_TOL: f64 = 0.3;
/// Punkt-Gleichheit (`kernel2d::EPS`, `vecEqual`).
const EPS_EQ: f64 = 1e-7;
/// Echter Bogen ab diesem |bulge| (`hasRealBulge`).
const EPS_BULGE: f64 = 1e-9;
/// Mindest-Radius/-Distanz der Vorschau (Verrunden/Fasen).
const EPS_R: f64 = 1e-6;

// ── Kurven ───────────────────────────────────────────────────────────────────

fn p_of(v: &Value) -> P {
    let (x, y) = xy(v);
    P::new(x, y)
}

fn ptv(p: P) -> Value {
    pt(p.x, p.y)
}

fn shape(g: &Value) -> &str {
    field(g, "shape").and_then(Value::as_str).unwrap_or("")
}

fn geom(d: &Value) -> &Value {
    field(d, "geom").unwrap_or(&Value::Null)
}

fn level_of(d: &Value) -> Option<&str> {
    field(d, "levelId").and_then(Value::as_str)
}

fn drawings(root: &Map<String, Value>) -> &[Value] {
    arr(root.get("drawings2d"))
}

fn find<'a>(root: &'a Map<String, Value>, id: &str) -> Option<&'a Value> {
    drawings(root).iter().find(|d| id_of(d) == Some(id))
}

/// Bogen-Werte wie `encBulge` (`b ?? 0`).
fn nums(b: &[Value]) -> Vec<f64> {
    b.iter().map(|x| num_of(Some(x))).collect()
}

fn real(b: &[f64]) -> bool {
    b.iter().any(|x| x.abs() > EPS_BULGE)
}

/// Eine Zeichnung als Kurve: Punkte (roh und als Zahlen), geschlossen, Bogen-Werte (roh).
#[derive(Clone)]
struct Curve {
    pts: Vec<P>,
    raw: Vec<Value>,
    closed: bool,
    /// `closed` wie in der Quelle (fehlend = `None`), für Ergebnisse `closed: curve.closed`.
    closed_raw: Option<Value>,
    bulge: Option<Vec<Value>>,
}

impl Curve {
    fn bulge_nums(&self) -> Vec<f64> {
        self.bulge.as_deref().map(nums).unwrap_or_default()
    }
    fn has_bulge(&self) -> bool {
        real(&self.bulge_nums())
    }
    fn of_pts(pts: Vec<P>, closed: bool, bulge: Option<&[f64]>) -> Curve {
        Curve {
            raw: pts.iter().map(|p| ptv(*p)).collect(),
            pts,
            closed,
            closed_raw: Some(Value::Bool(closed)),
            bulge: bulge.map(|b| b.iter().map(|x| js_num(*x)).collect()),
        }
    }
}

/// Welche Formen ein Befehl als Kurve nimmt.
#[derive(Clone, Copy, PartialEq)]
enum Take {
    /// Linie, Polylinie (mit Bögen), Rechteck (Trim, Bruch, Offset).
    Curve,
    /// Linie, offene Polylinie (mit Bögen) (Extend).
    Open,
    /// Polylinie ohne Bögen, Rechteck (Verrunden, Fasen).
    Corner,
}

fn rect_curve(g: &Value) -> Curve {
    let (min, max) = (field(g, "min").cloned().unwrap_or(Value::Null), field(g, "max").cloned().unwrap_or(Value::Null));
    let (a, b) = (p_of(&min), p_of(&max));
    let raw = vec![min, pt(b.x, a.y), max, pt(a.x, b.y)];
    Curve { pts: raw.iter().map(p_of).collect(), raw, closed: true, closed_raw: Some(Value::Bool(true)), bulge: None }
}

fn curve(g: &Value, take: Take) -> Option<Curve> {
    let poly = || {
        let raw: Vec<Value> = arr(field(g, "pts")).to_vec();
        let bulge = field(g, "bulge").and_then(Value::as_array).cloned();
        Curve { pts: raw.iter().map(p_of).collect(), raw, closed: truthy(field(g, "closed")), closed_raw: field(g, "closed").cloned(), bulge }
    };
    match (shape(g), take) {
        ("line", Take::Curve | Take::Open) => {
            let raw = vec![field(g, "a").cloned().unwrap_or(Value::Null), field(g, "b").cloned().unwrap_or(Value::Null)];
            Some(Curve { pts: raw.iter().map(p_of).collect(), raw, closed: false, closed_raw: Some(Value::Bool(false)), bulge: None })
        }
        ("polyline", Take::Curve) => Some(poly()),
        ("polyline", Take::Open) => (!truthy(field(g, "closed"))).then(poly),
        ("polyline", Take::Corner) => Some(poly()).filter(|c| !c.has_bulge()),
        ("rect", Take::Curve | Take::Corner) => Some(rect_curve(g)),
        _ => None,
    }
}

/// `polylineEdges`: Kanten als Paare (Schlusskante bei `closed` und mehr als zwei Punkten).
fn polyline_edges(pts: &[P], closed: bool) -> Vec<(P, P)> {
    let mut out: Vec<(P, P)> = pts.windows(2).map(|w| (w[0], w[1])).collect();
    if closed && pts.len() > 2 {
        out.push((pts[pts.len() - 1], pts[0]));
    }
    out
}

/// `bulgePolylinePoints` über dieselbe Hülle wie die Bindung (nicht endliche Punkte → leer).
fn bulge_points(pts: &[P], bulge: &[f64], closed: bool) -> Vec<P> {
    let flat: Vec<f64> = pts.iter().flat_map(|p| [p.x, p.y]).collect();
    crate::bulge::polyline_points(&flat, bulge, closed).chunks_exact(2).map(|c| P::new(c[0], c[1])).collect()
}

/// Trefferkanten: Bögen tesselliert (Klick-/Seiten-Tests entlang der echten Kontur).
fn hit_edges(c: &Curve) -> Vec<(P, P)> {
    let b = c.bulge_nums();
    if !real(&b) {
        return polyline_edges(&c.pts, c.closed);
    }
    let mut chain = bulge_points(&c.pts, &b, c.closed);
    if c.closed {
        if let Some(p0) = c.pts.first() {
            chain.push(*p0);
        }
    }
    polyline_edges(&chain, false)
}

/// Kanten → Punktfolge (`[e0.a, e0.b, e1.b, …]`).
fn chain_of(edges: &[(P, P)]) -> Vec<P> {
    let mut out = Vec::with_capacity(edges.len() + 1);
    for (i, (a, b)) in edges.iter().enumerate() {
        if i == 0 {
            out.push(*a);
        }
        out.push(*b);
    }
    out
}

fn tuples(pts: &[P]) -> Vec<(f64, f64)> {
    pts.iter().map(|p| (p.x, p.y)).collect()
}

/// Nächste Kurve der Ebene zum Punkt (innerhalb `HIT_TOL`).
fn pick_curve<'a>(root: &'a Map<String, Value>, level: &str, at: P, take: Take) -> Option<&'a Value> {
    let mut best = None;
    let mut best_d = HIT_TOL;
    for d in drawings(root) {
        if level_of(d) != Some(level) {
            continue;
        }
        let Some(c) = curve(geom(d), take) else { continue };
        for (a, b) in hit_edges(&c) {
            let dd = k::point_segment_distance(at, a, b);
            if dd < best_d {
                best_d = dd;
                best = Some(d);
            }
        }
    }
    if take != Take::Corner {
        if let Some((w, dd)) = wall_edit::pick_wall(root, level, at) {
            if dd < best_d {
                best = Some(w);
            }
        }
    }
    best
}

fn is_wall(v: &Value) -> bool {
    field(v, "type").and_then(Value::as_str) == Some("wall")
}

/// Kette → Zeichengeometrie (`chainToGeom`/`fromPolyForm`): zwei Punkte offen ohne Bogen = Linie.
fn chain_geom(pts: Vec<Value>, closed: Value, bulge: Option<Vec<Value>>) -> Value {
    let b = bulge.as_deref().map(nums).unwrap_or_default();
    let mut m = Map::new();
    if pts.len() == 2 && !truthy(Some(&closed)) && !real(&b) {
        m.insert("shape".into(), "line".into());
        let mut it = pts.into_iter();
        m.insert("a".into(), it.next().unwrap_or(Value::Null));
        m.insert("b".into(), it.next().unwrap_or(Value::Null));
        return Value::Object(m);
    }
    m.insert("shape".into(), "polyline".into());
    m.insert("pts".into(), Value::Array(pts));
    m.insert("closed".into(), closed);
    if real(&b) {
        m.insert("bulge".into(), Value::Array(bulge.unwrap_or_default()));
    }
    Value::Object(m)
}

fn pts_v(pts: &[P]) -> Vec<Value> {
    pts.iter().map(|p| ptv(*p)).collect()
}

fn bulge_v(b: &[f64]) -> Vec<Value> {
    b.iter().map(|x| js_num(*x)).collect()
}

/// `{...src, id, geom}`.
fn copy_with(src: &Value, id: String, geom: Value) -> Value {
    with_all(src, vec![("id", Value::String(id)), ("geom", geom)])
}

fn remove(ids: Vec<String>) -> Op {
    Op::Remove { collection: "drawings2d".into(), ids }
}

fn add(items: Vec<Value>) -> Option<Op> {
    (!items.is_empty()).then(|| Op::Add { collection: "drawings2d".into(), items, at: None })
}

fn replace(entity: Value) -> Op {
    Op::Replace { collection: "drawings2d".into(), entity }
}

/// `{...first(id), geom}` als Ersetzung (`patchItem`).
fn patch_geom(root: &Map<String, Value>, id: &str, g: Value) -> Vec<Op> {
    find(root, id).map(|d| vec![replace(with(d, "geom", g))]).unwrap_or_default()
}

// ── Trim ─────────────────────────────────────────────────────────────────────

/// Schneider des Trims: alle anderen Kurven der Ebene des Ziels (Bögen zählen mit).
fn trim_rest(root: &Map<String, Value>, target: &Value, at: P) -> Option<(Curve, Vec<k::BulgePolyline>)> {
    let c = curve(geom(target), Take::Curve)?;
    let (tid, level) = (id_of(target), level_of(target));
    let cutters: Vec<k::BulgePolyline> = drawings(root)
        .iter()
        .filter(|d| id_of(d) != tid && level_of(d) == level && level.is_some())
        .filter_map(|d| curve(geom(d), Take::Curve))
        .map(|c| k::BulgePolyline { bulge: c.bulge_nums(), pts: c.pts, closed: c.closed })
        .collect();
    let rest = k::trim_polyline_with_bulge(&c.pts, &c.bulge_nums(), c.closed, &cutters, at);
    Some((c, rest))
}

fn same_chain(a: &k::BulgePolyline, b: &Curve) -> bool {
    a.closed == b.closed && a.pts.len() == b.pts.len() && a.pts.iter().zip(&b.pts).all(|(p, q)| k::vec_equal(*p, *q, EPS_EQ))
}

/// Trim: das getroffene Stück von Zeichnung `id` entfällt, die Reste ersetzen sie (hinten angehängt).
pub fn trim_ops(root: &Map<String, Value>, id: &str, at: P, ids: &mut IdGen) -> Vec<Op> {
    let Some(target) = find(root, id) else { return vec![] };
    let Some((c, rest)) = trim_rest(root, target, at) else { return vec![] };
    if rest.len() == 1 && same_chain(&rest[0], &c) {
        return vec![];
    }
    let parts: Vec<Value> = rest
        .iter()
        .filter(|r| r.pts.len() >= 2)
        .map(|r| copy_with(target, ids.next("dr2d"), chain_geom(pts_v(&r.pts), Value::Bool(r.closed), Some(bulge_v(&r.bulge)))))
        .collect();
    let mut ops = vec![remove(vec![id.to_string()])];
    ops.extend(add(parts));
    ops
}

/// Vorschau des Trims am Punkt: die verbleibenden Ketten der getroffenen Kurve.
pub fn trim_preview(root: &Map<String, Value>, level: &str, at: P, face: bool, out: &mut Shapes) -> bool {
    let Some(target) = pick_curve(root, level, at, Take::Curve) else { return false };
    if is_wall(target) {
        if let Some(e) = wall_edit::trim(root, target, at, face) {
            wall_edit::preview(root, &e, out);
        }
        return true;
    }
    let Some((_, rest)) = trim_rest(root, target, at) else { return true };
    for r in rest.iter().filter(|r| r.pts.len() >= 2) {
        let pts = if real(&r.bulge) { chain_of(&hit_edges(&Curve::of_pts(r.pts.clone(), r.closed, Some(&r.bulge)))) } else { r.pts.clone() };
        if pts.len() == 2 && !r.closed {
            out.line((pts[0].x, pts[0].y), (pts[1].x, pts[1].y));
        } else if r.closed {
            out.poly(&tuples(&pts));
        } else {
            out.poly_open(&tuples(&pts));
        }
    }
    true
}

// ── Extend ───────────────────────────────────────────────────────────────────

/// Schneider der Verlängerung: Linien, Polylinien ohne Bögen und Rechtecke der Ebene (ausser dem Ziel).
fn extend_cutters(root: &Map<String, Value>, target: &Value) -> Vec<k::Polyline> {
    let (tid, level) = (id_of(target), level_of(target));
    let mut out = Vec::new();
    for d in drawings(root) {
        if id_of(d) == tid || level_of(d) != level || level.is_none() {
            continue;
        }
        let g = geom(d);
        match shape(g) {
            "line" => out.push(k::Polyline { pts: vec![p_of(field(g, "a").unwrap_or(&Value::Null)), p_of(field(g, "b").unwrap_or(&Value::Null))], closed: false }),
            "polyline" => {
                let c = curve(g, Take::Curve).expect("Polylinie");
                if !c.has_bulge() {
                    out.push(k::Polyline { pts: c.pts, closed: c.closed });
                }
            }
            "rect" => {
                let c = rect_curve(g);
                out.push(k::Polyline { pts: c.pts, closed: true });
            }
            _ => {}
        }
    }
    out
}

/// Verlängert das dem Punkt nähere Ende bis zum nächsten Schneider (Bogen-Ende: gleicher Kreis).
fn extend_curve(c: &Curve, cutters: &[k::Polyline], at: P) -> Option<Curve> {
    let n = c.pts.len();
    if n < 2 {
        return None;
    }
    let ds = hypot2(at.x - c.pts[0].x, at.y - c.pts[0].y);
    let de = hypot2(at.x - c.pts[n - 1].x, at.y - c.pts[n - 1].y);
    let start = ds <= de;
    let seg = if start { 0 } else { n - 2 };
    let bv = num_or(c.bulge.as_ref().and_then(|b| b.get(seg)), 0.0);
    let mut next = c.clone();
    next.closed = false;
    if bv.abs() > EPS_BULGE {
        let (p, b) = k::extend_bulge_segment(c.pts[seg], c.pts[seg + 1], bv, !start, cutters)?;
        let mut bulge = c.bulge.clone().unwrap_or_else(|| vec![Value::from(0); n - 1]);
        let (pi, bi) = if start { (0, 0) } else { (n - 1, n - 2) };
        next.raw[pi] = ptv(p);
        next.pts[pi] = p;
        if bi >= bulge.len() {
            bulge.resize(bi + 1, Value::Null);
        }
        bulge[bi] = js_num(b);
        next.bulge = Some(bulge);
        return Some(next);
    }
    let (ia, ib) = if start { (1, 0) } else { (n - 2, n - 1) };
    let (_, b) = k::extend_segment(c.pts[ia], c.pts[ib], "end", cutters)?;
    next.raw[ib] = ptv(b);
    next.pts[ib] = b;
    Some(next)
}

/// Extend: die Kurve `id` am Ende nahe `at` bis zum nächsten Schneider verlängern.
pub fn extend_ops(root: &Map<String, Value>, id: &str, at: P) -> Vec<Op> {
    let Some(target) = find(root, id) else { return vec![] };
    let Some(c) = curve(geom(target), Take::Open) else { return vec![] };
    let Some(next) = extend_curve(&c, &extend_cutters(root, target), at) else { return vec![] };
    let g = if next.raw.len() == 2 && shape(geom(target)) == "line" && !next.has_bulge() {
        chain_geom(next.raw, Value::Bool(false), None)
    } else {
        let mut m = Map::new();
        m.insert("shape".into(), "polyline".into());
        m.insert("pts".into(), Value::Array(next.raw.clone()));
        m.insert("closed".into(), Value::Bool(false));
        if next.has_bulge() {
            m.insert("bulge".into(), Value::Array(next.bulge.clone().unwrap_or_default()));
        }
        Value::Object(m)
    };
    patch_geom(root, id, g)
}

/// Vorschau der Verlängerung (Bögen tesselliert).
pub fn extend_preview(root: &Map<String, Value>, level: &str, at: P, face: bool, out: &mut Shapes) -> bool {
    let Some(target) = pick_curve(root, level, at, Take::Open) else { return false };
    if is_wall(target) {
        if let Some(e) = wall_edit::extend(root, target, at, face) {
            wall_edit::preview(root, &e, out);
        }
        return true;
    }
    let Some(c) = curve(geom(target), Take::Open) else { return true };
    let Some(next) = extend_curve(&c, &extend_cutters(root, target), at) else { return true };
    let pts = if next.has_bulge() { chain_of(&hit_edges(&next)) } else { next.pts.clone() };
    out.poly_open(&tuples(&pts));
    true
}

// ── Verrunden / Fasen ────────────────────────────────────────────────────────

/// Treffer einer Ecke: Zeichnung, Kurve, Eckpunkt-Index.
pub struct Corner<'a> {
    pub drawing: &'a Value,
    c: Curve,
    pub index: usize,
}

impl Corner<'_> {
    pub fn point(&self) -> P {
        self.c.pts[self.index]
    }
    fn neighbors(&self) -> (P, P, P) {
        let n = self.c.pts.len();
        (self.c.pts[self.index], self.c.pts[(self.index + n - 1) % n], self.c.pts[(self.index + 1) % n])
    }
}

/// Nächste Ecke (mit zwei Nachbarn) einer Polylinie/eines Rechtecks der Ebene (innerhalb `CORNER_TOL`).
pub fn pick_corner<'a>(root: &'a Map<String, Value>, level: &str, at: P) -> Option<Corner<'a>> {
    let mut best: Option<(&Value, usize)> = None;
    let mut best_c = None;
    let mut best_d = CORNER_TOL;
    for d in drawings(root) {
        if level_of(d) != Some(level) {
            continue;
        }
        let Some(c) = curve(geom(d), Take::Corner) else { continue };
        let n = c.pts.len();
        let mut hit = false;
        for i in 0..n {
            if !c.closed && (i == 0 || i == n - 1) {
                continue;
            }
            let dd = hypot2(c.pts[i].x - at.x, c.pts[i].y - at.y);
            if dd < best_d {
                best_d = dd;
                best = Some((d, i));
                hit = true;
            }
        }
        if hit {
            best_c = Some(c);
        }
    }
    let (drawing, index) = best?;
    Some(Corner { drawing, c: best_c?, index })
}

/// Die Ecke `index` der Zeichnung `id` (Zustand des Befehls zwischen den Schritten).
fn corner_of<'a>(root: &'a Map<String, Value>, id: &str, index: f64) -> Option<Corner<'a>> {
    let d = find(root, id)?;
    let c = curve(geom(d), Take::Corner)?;
    let i = (index.fract() == 0.0 && index >= 0.0 && index < c.pts.len() as f64).then_some(index as usize)?;
    Some(Corner { drawing: d, c, index: i })
}

fn fillet_of(h: &Corner, r: f64) -> Option<k::Fillet> {
    let (corner, prev, next) = h.neighbors();
    k::fillet_corner(corner, prev, next, r)
}

fn chamfer_of(h: &Corner, d: f64) -> Option<k::Chamfer> {
    let (corner, prev, next) = h.neighbors();
    k::chamfer_corner(corner, prev, next, d)
}

/// Kürzester Schwenk start → end in (−π, π].
fn short_delta(f: &k::Fillet) -> f64 {
    let tau = std::f64::consts::PI * 2.0;
    let mut delta = f.end_angle - f.start_angle;
    while delta > std::f64::consts::PI {
        delta -= tau;
    }
    while delta < -std::f64::consts::PI {
        delta += tau;
    }
    delta
}

/// Verrundungs-Bogen als Punktfolge (12 Segmente, kürzester Bogen).
fn tessellate(f: &k::Fillet) -> Vec<(f64, f64)> {
    let delta = short_delta(f);
    (0..=12)
        .map(|i| {
            let a = f.start_angle + (delta * i as f64) / 12.0;
            (f.center.x + f.radius * jsnum::cos(a), f.center.y + f.radius * jsnum::sin(a))
        })
        .collect()
}

/// Ersetzt den Eckpunkt durch zwei Punkte (die übrigen Punkte bleiben die Werte der Quelle).
fn split_corner(h: &Corner, a: P, b: P) -> Vec<Value> {
    let mut pts: Vec<Value> = h.c.raw[..h.index].to_vec();
    pts.push(ptv(a));
    pts.push(ptv(b));
    pts.extend_from_slice(&h.c.raw[h.index + 1..]);
    pts
}

fn polyline_geom(pts: Vec<Value>, closed: Option<Value>, bulge: Option<Vec<Value>>) -> Value {
    let mut m = Map::new();
    m.insert("shape".into(), "polyline".into());
    m.insert("pts".into(), Value::Array(pts));
    if let Some(c) = closed {
        m.insert("closed".into(), c);
    }
    if let Some(b) = bulge {
        m.insert("bulge".into(), Value::Array(b));
    }
    Value::Object(m)
}

/// Verrunden der Ecke `index` von `id` mit Radius `r` (Bogen als bulge zwischen den Tangentenpunkten).
pub fn fillet_ops(root: &Map<String, Value>, id: &str, index: f64, r: f64) -> Vec<Op> {
    let Some(h) = corner_of(root, id, index) else { return vec![] };
    let Some(f) = fillet_of(&h, r) else { return vec![] };
    let pts = split_corner(&h, f.tangent_a, f.tangent_b);
    let edges = if h.c.closed { pts.len() } else { pts.len() - 1 };
    let mut bulge = vec![Value::from(0); edges];
    let mid = f.start_angle + short_delta(&f) / 2.0;
    let apex = (f.center.x + f.radius * jsnum::cos(mid), f.center.y + f.radius * jsnum::sin(mid));
    let b = crate::bulge::from_sagitta_point(f.tangent_a.x, f.tangent_a.y, f.tangent_b.x, f.tangent_b.y, apex.0, apex.1);
    if h.index < bulge.len() {
        bulge[h.index] = js_num(b);
    }
    patch_geom(root, id, polyline_geom(pts, h.c.closed_raw.clone(), Some(bulge)))
}

/// Fasen der Ecke `index` von `id` um `d`.
pub fn chamfer_ops(root: &Map<String, Value>, id: &str, index: f64, d: f64) -> Vec<Op> {
    let Some(h) = corner_of(root, id, index) else { return vec![] };
    let Some(c) = chamfer_of(&h, d) else { return vec![] };
    patch_geom(root, id, polyline_geom(split_corner(&h, c.a, c.b), h.c.closed_raw.clone(), None))
}

/// Vorschau Verrunden/Fasen einer Ecke (`fillet`: Bogen, sonst die Fasung).
fn corner_preview(h: &Corner, fillet: bool, r: f64, out: &mut Shapes) {
    if r <= EPS_R {
        return;
    }
    if fillet {
        if let Some(f) = fillet_of(h, r) {
            out.poly_open(&tessellate(&f));
        }
    } else if let Some(c) = chamfer_of(h, r) {
        out.poly_open(&[(c.a.x, c.a.y), (c.b.x, c.b.y)]);
    }
}

// ── Bruch ────────────────────────────────────────────────────────────────────

/// Offene, bogenfreie Kurve unter dem Punkt (die nächste Kurve muss es sein).
pub fn pick_breakable<'a>(root: &'a Map<String, Value>, level: &str, at: P) -> Option<&'a Value> {
    let d = pick_curve(root, level, at, Take::Curve)?;
    if is_wall(d) {
        return Some(d);
    }
    let c = curve(geom(d), Take::Curve)?;
    (!c.closed && !c.has_bulge()).then_some(d)
}

fn break_pieces<'a>(root: &'a Map<String, Value>, id: &str, p1: P, p2: P) -> Option<(&'a Value, Vec<Vec<P>>)> {
    let target = find(root, id)?;
    let c = curve(geom(target), Take::Curve)?;
    let h1 = k::nearest_on_polyline(&c.pts, false, p1)?;
    let h2 = k::nearest_on_polyline(&c.pts, false, p2)?;
    Some((target, k::break_curve(&c.pts, h1, h2)))
}

/// Bruch zwischen zwei Punkten: die Zeichnung wird durch die Reststücke ersetzt (hinten angehängt).
pub fn break_ops(root: &Map<String, Value>, id: &str, p1: P, p2: P, ids: &mut IdGen) -> Vec<Op> {
    let Some((target, pieces)) = break_pieces(root, id, p1, p2) else { return vec![] };
    let parts: Vec<Value> = pieces.iter().map(|pts| copy_with(target, ids.next("dr2d"), chain_geom(pts_v(pts), Value::Bool(false), None))).collect();
    let mut ops = vec![remove(vec![id.to_string()])];
    ops.extend(add(parts));
    ops
}

fn break_preview(root: &Map<String, Value>, id: &str, p1: P, p2: P, out: &mut Shapes) {
    if let Some(w) = wall_edit::find_wall(root, id) {
        if let Some(e) = wall_edit::break_at(w, p1, p2) {
            wall_edit::preview(root, &e, out);
        }
        return;
    }
    let Some((_, pieces)) = break_pieces(root, id, p1, p2) else { return };
    for pts in pieces.iter().filter(|p| p.len() >= 2) {
        if pts.len() == 2 {
            out.line((pts[0].x, pts[0].y), (pts[1].x, pts[1].y));
        } else {
            out.poly_open(&tuples(pts));
        }
    }
}

// ── Offset ───────────────────────────────────────────────────────────────────

/// Seite des Punkts zur Kurve (+1 links, −1 rechts) über die nächste Kante; ohne Kante `last`.
fn side_sign(c: &Curve, at: P, last: f64) -> f64 {
    let mut best = f64::INFINITY;
    let mut sign = last;
    for (a, b) in hit_edges(c) {
        let mid = P::new((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
        let dd = k::point_segment_distance(at, a, b);
        if dd < best {
            best = dd;
            let (ux, uy) = (b.x - a.x, b.y - a.y);
            let l = hypot2(ux, uy);
            let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
            let (nx, ny) = (-(uy / l), ux / l);
            let s = (at.x - mid.x) * nx + (at.y - mid.y) * ny;
            sign = if s >= 0.0 { 1.0 } else { -1.0 };
        }
    }
    sign
}

/// Versetzte Kurve um `d` (links positiv; Bögen bleiben konzentrisch).
fn offset_curve(c: &Curve, d: f64) -> (Vec<P>, Option<Vec<f64>>) {
    if !c.closed && c.pts.len() == 2 && !c.has_bulge() {
        let (a, b) = k::offset_segment(c.pts[0], c.pts[1], d);
        return (vec![a, b], None);
    }
    if c.has_bulge() {
        let (p, b) = k::offset_polyline_with_bulge(&c.pts, &c.bulge_nums(), d, c.closed);
        return (p, Some(b));
    }
    (k::offset_polyline(&c.pts, d, c.closed), None)
}

/// Offset: eine versetzte Kopie von `id` um `d` anhängen.
pub fn offset_ops(root: &Map<String, Value>, id: &str, d: f64, ids: &mut IdGen) -> Vec<Op> {
    let Some(src) = find(root, id) else { return vec![] };
    let Some(c) = curve(geom(src), Take::Curve) else { return vec![] };
    let (pts, bulge) = offset_curve(&c, d);
    let g = if shape(geom(src)) == "line" && pts.len() == 2 {
        chain_geom(pts_v(&pts), Value::Bool(false), None)
    } else {
        polyline_geom(pts_v(&pts), c.closed_raw.clone(), bulge.filter(|b| real(b)).map(|b| bulge_v(&b)))
    };
    add(vec![copy_with(src, ids.next("dr2d"), g)]).into_iter().collect()
}

fn offset_preview(c: &Curve, d: f64, out: &mut Shapes) {
    let (pts, bulge) = offset_curve(c, d);
    if pts.len() < 2 {
        return;
    }
    let has = bulge.as_deref().is_some_and(real);
    if !c.closed && pts.len() == 2 && !has {
        out.line((pts[0].x, pts[0].y), (pts[1].x, pts[1].y));
        return;
    }
    let tess = if has { chain_of(&hit_edges(&Curve::of_pts(pts, c.closed, bulge.as_deref()))) } else { pts };
    if c.closed {
        out.poly(&tuples(&tess));
    } else {
        out.poly_open(&tuples(&tess));
    }
}

// ── Verketten / Auflösen ─────────────────────────────────────────────────────

/// Übernimmt Ebene, Kategorie und Stil der Quelle auf ein neues Element (`inherit`); Schraffur/Füllung
/// nur bei geschlossenen Ergebnissen.
fn inherit(src: &Value, g: Value, ids: &mut IdGen) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), ids.next("d2d").into());
    m.insert("type".into(), "drawing2d".into());
    for k in ["levelId", "categoryCode"] {
        if let Some(v) = field(src, k) {
            m.insert(k.into(), v.clone());
        }
    }
    let closed = match shape(&g) {
        "polyline" => truthy(field(&g, "closed")),
        "rect" => true,
        _ => false,
    };
    m.insert("geom".into(), g);
    for k in ["lineStyleId", "color", "weightMm"] {
        if let Some(v) = field(src, k) {
            m.insert(k.into(), v.clone());
        }
    }
    if closed {
        for k in ["hatchId", "fillColor"] {
            if let Some(v) = field(src, k) {
                m.insert(k.into(), v.clone());
            }
        }
    }
    Value::Object(m)
}

/// Join: die gewählten Zeichnungen (ab zwei) an gemeinsamen Endpunkten zu Polylinien verketten (Bögen
/// bleiben); nicht verkettbare Formen bleiben und rücken hinter das Ergebnis.
pub fn join_ops(root: &Map<String, Value>, ids_sel: &[String], ids: &mut IdGen) -> Vec<Op> {
    let set: crate::commands::FastSet<&str> = ids_sel.iter().map(String::as_str).collect();
    let srcs: Vec<&Value> = drawings(root).iter().filter(|d| id_of(d).is_some_and(|i| set.contains(i))).collect();
    if srcs.len() < 2 {
        return vec![];
    }
    let mut joinable: Vec<(k::BulgeChainInput, &Value)> = Vec::new();
    let mut pass: Vec<Value> = Vec::new();
    for d in &srcs {
        let g = geom(d);
        let form = match shape(g) {
            "polyline" => curve(g, Take::Curve).map(|c| k::BulgeChainInput { bulge: c.bulge.as_deref().map(nums), pts: c.pts, closed: c.closed }),
            "line" | "rect" => curve(g, Take::Curve).map(|c| k::BulgeChainInput { pts: c.pts, closed: c.closed, bulge: None }),
            _ => None,
        };
        match form {
            Some(f) => joinable.push((f, d)),
            None => pass.push((*d).clone()),
        }
    }
    let joined: Vec<Value> = if joinable.is_empty() {
        srcs.iter().map(|d| (*d).clone()).collect()
    } else {
        let inputs: Vec<k::BulgeChainInput> = joinable.iter().map(|(f, _)| k::BulgeChainInput { pts: f.pts.clone(), closed: f.closed, bulge: f.bulge.clone() }).collect();
        let template = joinable[0].1;
        let mut out: Vec<Value> = k::join_chains_with_bulge(&inputs)
            .iter()
            .map(|c| inherit(template, chain_geom(pts_v(&c.pts), Value::Bool(c.closed), Some(bulge_v(&c.bulge))), ids))
            .collect();
        out.extend(pass);
        out
    };
    let mut seen = crate::commands::FastSet::default();
    let drop: Vec<String> = srcs.iter().filter_map(|d| id_of(d)).filter(|i| seen.insert(*i)).map(str::to_owned).collect();
    let mut ops = vec![remove(drop)];
    ops.extend(add(joined));
    ops
}

/// Punkte einer Teilgeometrie abbilden (Block-Auflösung; nur Punkte, keine Grössen).
fn map_points(g: &Value, f: &dyn Fn(P) -> P) -> Value {
    let m = |k: &str| ptv(f(p_of(field(g, k).unwrap_or(&Value::Null))));
    let ms = |k: &str| Value::Array(arr(field(g, k)).iter().map(|q| ptv(f(p_of(q)))).collect());
    match shape(g) {
        "line" | "xline" | "ray" => with_all(g, vec![("a", m("a")), ("b", m("b"))]),
        "polyline" | "bezier" | "spline" | "dimension" => with(g, "pts", ms("pts")),
        "rect" | "image" => with_all(g, vec![("min", m("min")), ("max", m("max"))]),
        "circle" | "arc" | "ellipse" => with(g, "center", m("center")),
        "text" | "kote" | "detailref" | "scalebar" | "pointmarker" | "block" => with(g, "at", m("at")),
        "grid" => with(g, "origin", m("origin")),
        _ => g.clone(),
    }
}

/// Teilgeometrien eines zerlegbaren Elements (Block-Instanz, Polylinie, Rechteck), sonst `None`.
fn explode_geom(g: &Value, root: &Map<String, Value>) -> Option<Vec<Value>> {
    match shape(g) {
        "block" => {
            let def_id = field(g, "blockDefId");
            let def = arr(root.get("blockDefs")).iter().find(|b| def_id.is_some() && field(b, "id") == def_id)?;
            let parts = arr(field(def, "geom2d"));
            if parts.is_empty() {
                return None;
            }
            let rot = num_of(field(g, "rotation"));
            let (c, s) = (jsnum::cos(rot), jsnum::sin(rot));
            let at = p_of(field(g, "at").unwrap_or(&Value::Null));
            let xf = move |p: P| P::new(at.x + p.x * c - p.y * s, at.y + p.x * s + p.y * c);
            Some(parts.iter().map(|sub| map_points(sub, &xf)).collect())
        }
        "polyline" => {
            let raw = arr(field(g, "pts"));
            let n = raw.len();
            if n < 2 {
                return None;
            }
            let segs = if truthy(field(g, "closed")) && n > 2 { n } else { n - 1 };
            let bulge = field(g, "bulge").and_then(Value::as_array);
            let mut out = Vec::with_capacity(segs);
            for i in 0..segs {
                let (a, b) = (&raw[i], &raw[(i + 1) % n]);
                let bv = num_or(bulge.and_then(|b| b.get(i)), 0.0);
                let (pa, pb) = (p_of(a), p_of(b));
                let arc = if bv.abs() >= EPS_BULGE { crate::bulge::arc(pa.x, pa.y, pb.x, pb.y, bv) } else { vec![] };
                let mut m = Map::new();
                if arc.len() >= 6 {
                    let fwd = arc[5] >= 0.0;
                    m.insert("shape".into(), "arc".into());
                    m.insert("center".into(), pt(arc[0], arc[1]));
                    m.insert("r".into(), js_num(arc[2]));
                    m.insert("a0".into(), js_num(if fwd { arc[3] } else { arc[4] }));
                    m.insert("a1".into(), js_num(if fwd { arc[4] } else { arc[3] }));
                } else {
                    m.insert("shape".into(), "line".into());
                    m.insert("a".into(), a.clone());
                    m.insert("b".into(), b.clone());
                }
                out.push(Value::Object(m));
            }
            Some(out)
        }
        "rect" => {
            let c = rect_curve(g).raw;
            let line = |a: &Value, b: &Value| {
                let mut m = Map::new();
                m.insert("shape".into(), "line".into());
                m.insert("a".into(), a.clone());
                m.insert("b".into(), b.clone());
                Value::Object(m)
            };
            Some(vec![line(&c[0], &c[1]), line(&c[1], &c[2]), line(&c[2], &c[3]), line(&c[3], &c[0])])
        }
        _ => None,
    }
}

/// Auflösen: jedes zerlegbare gewählte Element wird an seiner Stelle durch seine Teile ersetzt
/// (`replaceWithMany`: ein `remove`, dann je ein `add` an der Endposition).
pub fn explode_ops(root: &Map<String, Value>, ids_sel: &[String], ids: &mut IdGen) -> Vec<Op> {
    let set: crate::commands::FastSet<&str> = ids_sel.iter().map(String::as_str).collect();
    let mut repl: std::collections::HashMap<&str, Vec<Value>> = std::collections::HashMap::new();
    for d in drawings(root) {
        let Some(id) = id_of(d).filter(|i| set.contains(i)) else { continue };
        let Some(parts) = explode_geom(geom(d), root).filter(|p| !p.is_empty()) else { continue };
        repl.insert(id, parts.into_iter().map(|g| copy_with(d, ids.next("dr2d"), g)).collect());
    }
    replace_with_many(drawings(root), "drawings2d", &repl)
}

/// `replaceWithMany`: Elemente durch je eine Liste neuer Elemente an derselben Stelle ersetzen.
fn replace_with_many(list: &[Value], collection: &str, repl: &std::collections::HashMap<&str, Vec<Value>>) -> Vec<Op> {
    let mut dropped = Vec::new();
    let mut inserts = Vec::new();
    let mut len = 0;
    for e in list {
        let Some((id, items)) = id_of(e).and_then(|id| repl.get(id).map(|it| (id, it))) else {
            len += 1;
            continue;
        };
        dropped.push(id.to_string());
        if !items.is_empty() {
            inserts.push((len, items.clone()));
        }
        len += items.len();
    }
    if dropped.is_empty() {
        return vec![];
    }
    let mut ops = vec![Op::Remove { collection: collection.into(), ids: dropped }];
    for (at, items) in inserts {
        ops.push(Op::Add { collection: collection.into(), items, at: Some(at) });
    }
    ops
}

// ── Anfragen der Hülle ───────────────────────────────────────────────────────

fn p_arg(v: &Value, k: &str) -> P {
    let a = v.get(k);
    let n = |i: usize| a.and_then(|a| a.get(i)).map_or(f64::NAN, |x| num_of(Some(x)));
    P::new(n(0), n(1))
}

fn n_arg(v: &Value, k: &str) -> f64 {
    v.get(k).map_or(f64::NAN, |x| num_of(Some(x)))
}

fn s_arg<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Ops eines Editier-Befehls (`None` = kein Editier-Befehl).
pub fn ops(root: &Map<String, Value>, v: &Value) -> Option<Vec<Op>> {
    let cmd = s_arg(v, "cmd");
    let mut ids = IdGen::new(s_arg(v, "stamp"));
    let list = |k: &str| -> Vec<String> { v.get(k).and_then(|x| serde_json::from_value(x.clone()).ok()).unwrap_or_default() };
    if let Some(w) = wall_edit::find_wall(root, s_arg(v, "id")) {
        if let Some(e) = wall_edit_of(root, w, v) {
            return Some(e.map(|e| wall_edit::commit(root, &e, &mut ids)).unwrap_or_default());
        }
    }
    Some(match cmd {
        "trim" => trim_ops(root, s_arg(v, "id"), p_arg(v, "pt"), &mut ids),
        "extend" => extend_ops(root, s_arg(v, "id"), p_arg(v, "pt")),
        "fillet" => fillet_ops(root, s_arg(v, "id"), n_arg(v, "index"), n_arg(v, "r")),
        "chamfer" => chamfer_ops(root, s_arg(v, "id"), n_arg(v, "index"), n_arg(v, "d")),
        "break" => break_ops(root, s_arg(v, "id"), p_arg(v, "p1"), p_arg(v, "p2"), &mut ids),
        "offset" => offset_ops(root, s_arg(v, "id"), n_arg(v, "d"), &mut ids),
        "join" => {
            let mut ops = join_ops(root, &list("ids"), &mut ids);
            ops.extend(wall_edit::join_ops(root, &list("ids")));
            ops
        }
        "splitAt" => break_ops(root, s_arg(v, "id"), p_arg(v, "pt"), p_arg(v, "pt"), &mut ids),
        "splitInter" => crate::cmd_split::split_ops(root, &[s_arg(v, "id").to_string()], s_arg(v, "stamp")),
        "explode" => explode_ops(root, &list("ids"), &mut ids),
        "dimdetach" => crate::dim_assoc::detach_ops(root, &list("ids")),
        _ => return None,
    })
}

/// Wand-Änderung einer Anfrage an die Wand `w` (`None` = kein Wand-Befehl; `Some(None)` = Befehl ohne
/// Ergebnis, z. B. keine Grenze getroffen).
fn wall_edit_of<'a>(root: &'a Map<String, Value>, w: &'a Value, v: &Value) -> Option<Option<wall_edit::Edit<'a>>> {
    let face = truthy(v.get("face"));
    Some(match s_arg(v, "cmd") {
        "trim" => wall_edit::trim(root, w, p_arg(v, "pt"), face),
        "extend" => wall_edit::extend(root, w, p_arg(v, "pt"), face),
        "break" => wall_edit::break_at(w, p_arg(v, "p1"), p_arg(v, "p2")),
        "splitAt" => wall_edit::break_at(w, p_arg(v, "pt"), p_arg(v, "pt")),
        "splitInter" => wall_edit::split_at_intersections(root, w),
        "offset" => wall_edit::offset(w, n_arg(v, "d")),
        "filletWalls" => wall_edit::find_wall(root, s_arg(v, "id2")).and_then(|w2| wall_edit::fillet(w, p_arg(v, "p1"), w2, p_arg(v, "p2"), n_arg(v, "r"))),
        _ => return None,
    })
}

/// Abfragen der Befehle zwischen den Schritten (Treffer, Vorschau): Antwort-JSON. Formen flach wie
/// `doc_cmd_preview` (`shapes`), Treffer als `hit` (`null` = keiner).
pub fn query(root: &Map<String, Value>, v: &Value) -> Result<Value, String> {
    use serde_json::json;
    let q = s_arg(v, "q");
    let at = p_arg(v, "pt");
    let level = s_arg(v, "level");
    let mut s = Shapes::default();
    let shapes = |s: Shapes| Value::Array(s.buf.iter().map(|x| js_num(*x)).collect());
    let hit_id = |d: Option<&Value>| d.and_then(id_of).map_or(Value::Null, |i| Value::String(i.into()));
    Ok(match q {
        "pickCurve" => json!({ "hit": hit_id(pick_curve(root, level, at, Take::Curve)) }),
        "pickOpen" => json!({ "hit": hit_id(pick_curve(root, level, at, Take::Open)) }),
        "pickBreakable" => json!({ "hit": hit_id(pick_breakable(root, level, at)) }),
        "pickCorner" => {
            let fillet = s_arg(v, "kind") == "fillet";
            match pick_corner(root, level, at) {
                Some(h) => {
                    if v.get("r").is_some() {
                        corner_preview(&h, fillet, n_arg(v, "r"), &mut s);
                    }
                    let p = h.point();
                    json!({ "hit": { "id": id_of(h.drawing), "index": h.index, "corner": [js_num(p.x), js_num(p.y)] }, "shapes": shapes(s) })
                }
                None => json!({ "hit": null, "shapes": [] }),
            }
        }
        "corner" => {
            if let Some(h) = corner_of(root, s_arg(v, "id"), n_arg(v, "index")) {
                corner_preview(&h, s_arg(v, "kind") == "fillet", n_arg(v, "r"), &mut s);
            }
            json!({ "shapes": shapes(s) })
        }
        "trim" | "extend" => {
            let face = truthy(v.get("face"));
            let hit = if q == "trim" { trim_preview(root, level, at, face, &mut s) } else { extend_preview(root, level, at, face, &mut s) };
            json!({ "hit": hit, "shapes": shapes(s) })
        }
        "break" => {
            break_preview(root, s_arg(v, "id"), p_arg(v, "p1"), at, &mut s);
            json!({ "shapes": shapes(s) })
        }
        "offset" if wall_edit::find_wall(root, s_arg(v, "id")).is_some() => {
            let w = wall_edit::find_wall(root, s_arg(v, "id")).unwrap_or(&Value::Null);
            let sign = wall_edit::side(w, at).unwrap_or(n_arg(v, "lastSign"));
            let dist = n_arg(v, "dist");
            if let Some(e) = wall_edit::offset(w, sign * dist) {
                wall_edit::preview(root, &e, &mut s);
            }
            json!({ "hit": true, "sign": sign, "shapes": shapes(s) })
        }
        "pickWall" => json!({ "hit": hit_id(wall_edit::pick_wall(root, level, at).map(|w| w.0)) }),
        "filletWalls" => {
            let e = match (wall_edit::find_wall(root, s_arg(v, "id")), wall_edit::pick_wall(root, level, at)) {
                (Some(w1), Some((w2, _))) => wall_edit::fillet(w1, p_arg(v, "p1"), w2, at, n_arg(v, "r")),
                _ => None,
            };
            if let Some(e) = &e {
                wall_edit::preview(root, e, &mut s);
            }
            json!({ "hit": e.is_some(), "shapes": shapes(s) })
        }
        "split" => {
            let inter = truthy(v.get("inter"));
            let target = if inter { pick_curve(root, level, at, Take::Curve) } else { pick_breakable(root, level, at) };
            let mut hit = Value::Null;
            if let Some(t) = target {
                hit = hit_id(Some(t));
                if is_wall(t) {
                    let e = if inter { wall_edit::split_at_intersections(root, t) } else { wall_edit::break_at(t, at, at) };
                    if let Some(e) = e {
                        wall_edit::preview(root, &e, &mut s);
                    }
                } else if !inter {
                    // Teilstelle der Zeichnung: kleines Kreuz.
                    let d = 0.15;
                    s.line((at.x - d, at.y - d), (at.x + d, at.y + d));
                    s.line((at.x - d, at.y + d), (at.x + d, at.y - d));
                }
            }
            json!({ "hit": hit, "shapes": shapes(s) })
        }
        "offset" => {
            let c = find(root, s_arg(v, "id")).and_then(|d| curve(geom(d), Take::Curve));
            match c {
                Some(c) => {
                    let sign = side_sign(&c, at, n_arg(v, "lastSign"));
                    let dist = n_arg(v, "dist");
                    if dist.is_finite() {
                        offset_preview(&c, sign * dist, &mut s);
                    }
                    json!({ "hit": true, "sign": sign, "shapes": shapes(s) })
                }
                None => json!({ "hit": false, "shapes": [] }),
            }
        }
        other => return Err(format!("Unbekannte Befehls-Abfrage: {other}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }
    fn line(id: &str, a: (f64, f64), b: (f64, f64)) -> Value {
        json!({"id": id, "type": "drawing2d", "levelId": "L", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": a.0, "y": a.1}, "b": {"x": b.0, "y": b.1}}})
    }

    #[test]
    fn trim_schneidet_das_getroffene_stueck_weg() {
        let r = root(json!({"drawings2d": [line("a", (0.0, 0.0), (10.0, 0.0)), line("b", (5.0, -1.0), (5.0, 1.0))]}));
        let ops = trim_ops(&r, "a", P::new(8.0, 0.0), &mut IdGen::new("s"));
        assert_eq!(ops.len(), 2);
        let items = &ops[1].to_json()["items"];
        assert_eq!(items[0]["geom"], json!({"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 5, "y": 0}}));
        assert_eq!(items[0]["id"], "dr2d-s-1");
    }

    #[test]
    fn extend_bis_zum_schneider() {
        let r = root(json!({"drawings2d": [line("a", (0.0, 0.0), (4.0, 0.0)), line("b", (5.0, -1.0), (5.0, 1.0))]}));
        let ops = extend_ops(&r, "a", P::new(3.9, 0.0));
        assert_eq!(ops[0].to_json()["entity"]["geom"]["b"], json!({"x": 5, "y": 0}));
    }

    #[test]
    fn verrunden_setzt_bogen() {
        let poly = json!({"id": "p", "levelId": "L", "geom": {"shape": "polyline", "pts": [{"x": 0, "y": 0}, {"x": 2, "y": 0}, {"x": 2, "y": 2}], "closed": false}});
        let r = root(json!({ "drawings2d": [poly] }));
        let h = pick_corner(&r, "L", P::new(2.1, 0.1)).unwrap();
        assert_eq!(h.index, 1);
        let ops = fillet_ops(&r, "p", 1.0, 0.5);
        let g = &ops[0].to_json()["entity"]["geom"];
        assert_eq!(g["pts"].as_array().unwrap().len(), 4);
        assert!(g["bulge"][1].as_f64().unwrap().abs() > 0.1);
    }

    #[test]
    fn aufloesen_rechteck_an_ort_und_stelle() {
        let rect = json!({"id": "r", "geom": {"shape": "rect", "min": {"x": 0, "y": 0}, "max": {"x": 1, "y": 1}}});
        let r = root(json!({"drawings2d": [line("a", (0.0, 0.0), (1.0, 0.0)), rect]}));
        let ops = explode_ops(&r, &["r".into()], &mut IdGen::new("s"));
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[1].to_json()["at"], 1);
        assert_eq!(ops[1].to_json()["items"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn wand_befehle_ueber_die_anfrage() {
        let w = |id: &str, a: (f64, f64), b: (f64, f64)| json!({"id": id, "type": "wall", "floorId": "L", "start": {"x": a.0, "y": a.1}, "end": {"x": b.0, "y": b.1}, "wallTypeId": "t", "height": 2.5});
        let r = root(json!({"wallTypes": [{"id": "t", "layers": [{"thickness": 0.2}]}], "walls": [w("a", (0.0, 0.0), (10.0, 0.0)), w("b", (6.0, -3.0), (6.0, 3.0))], "drawings2d": [], "openings": []}));
        // Treffer: Klick in den Wandkörper trifft die Wand (auch für Bruch/Teilen).
        assert_eq!(query(&r, &json!({"q": "pickCurve", "level": "L", "pt": [8.0, 0.05]})).unwrap()["hit"], "a");
        assert_eq!(query(&r, &json!({"q": "pickBreakable", "level": "L", "pt": [8.0, 0.05]})).unwrap()["hit"], "a");
        let pv = query(&r, &json!({"q": "trim", "level": "L", "pt": [8.0, 0.0]})).unwrap();
        assert_eq!(pv["hit"], true);
        assert!(!pv["shapes"].as_array().unwrap().is_empty());
        let o = super::ops(&r, &json!({"cmd": "trim", "id": "a", "pt": [8.0, 0.0], "stamp": "s"})).unwrap();
        assert_eq!(o[0].to_json()["entity"]["end"], json!({"x": 6, "y": 0}));
        let o = super::ops(&r, &json!({"cmd": "splitAt", "id": "a", "pt": [2.0, 0.0], "stamp": "s"})).unwrap();
        assert_eq!(o.len(), 2);
        let o = super::ops(&r, &json!({"cmd": "splitInter", "id": "a", "stamp": "s"})).unwrap();
        assert_eq!(o[1].to_json()["items"][0]["start"], json!({"x": 6, "y": 0}));
        let o = super::ops(&r, &json!({"cmd": "offset", "id": "a", "d": -1.0, "stamp": "s"})).unwrap();
        assert_eq!(o[0].to_json()["items"][0]["start"], json!({"x": 0, "y": -1}));
        let pv = query(&r, &json!({"q": "filletWalls", "level": "L", "id": "a", "p1": [2.0, 0.0], "pt": [6.0, 2.0], "r": 0.5})).unwrap();
        assert_eq!(pv["hit"], true);
    }
}
