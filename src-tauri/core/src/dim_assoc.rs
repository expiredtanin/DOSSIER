//! Assoziative Bemassung ([38]): Bemassungspunkte, die beim Zeichnen auf ein Merkmal eines Elements
//! gefangen wurden, tragen einen Bezug ([`DimRef`], `Dimension.refs`) und folgen dem Element.
//!
//! - **Anhängen** ([`attach`]): ein gefangener Punkt wird über Deckungsgleichheit (Toleranz [`TOL`])
//!   einem Merkmal zugeordnet — Öffnungs-Leibung/-Mitte, Wandende, Wandecke (Schnitt zweier
//!   Wandlinien), Punkt auf Wandachse/Schichtgrenze, Stütze (Mitte, Ecken, Kanten), Decken-/Dach-/
//!   Raum-Umriss (Ecken, Kanten), 2D-Zeichnung (Eckpunkte, Mittelpunkte, Kanten), Treppe (Umriss
//!   und Podest: Ecken, Kanten), Bogenwand (Enden, Punkt auf Achse/Fläche, Mittelpunkt), Rasterachse
//!   und Achsschnittpunkt ([112]). Freie Klicks decken sich praktisch nie und bleiben frei.
//! - **Radius/Durchmesser/Bogenlänge** ([`refs_for_round`]): Mittelpunkt und Punkte auf dem Rand
//!   (`DimFeature::Rim`, Winkel) von 2D-Kreis, -Bogen oder Bogenwand; sie werden einzeln (ohne
//!   Kettenprojektion) nachgeführt.
//! - **Nachführen** ([`sync_ops`]): nach jeder Benutzer-Änderung (`Document::commit`) löst der Kern
//!   die Bezüge auf und schreibt die Lage in `pts` zurück (dieselbe Undo-Stufe). Damit lesen alle
//!   Ableitungen (Plan, DXF, Griffe, Auswahl-Info) einfach `pts`, und `pts` ist immer die zuletzt
//!   aufgelöste Lage. Ein ungültiger Bezug (Element gelöscht, Eckpunkt weg) behält den Punkt an
//!   dieser Lage und wird `lost` markiert (Bildschirm: Marke, Druck: nichts; Objekt-Info: Hinweis).
//! - **Kette**: Masspunkte bleiben kollinear. Richtung = aufgelöster Punkt 0 → 1, wenn beide hängen,
//!   sonst die gespeicherte; Lage der Linie durch Punkt 0 (bzw. den ersten hängenden Punkt); jeder
//!   Punkt wird darauf projiziert. `d` (Normalabstand Merkmal → Masslinie) hält Ketten wie die
//!   Aussenbemassung, deren Punkte nicht auf dem Merkmal liegen, in ihrer Flucht.
//! - **Transformieren** ([`transformed_refs`]): wird die Bemassung zusammen mit allen Elementen ihrer
//!   Bezüge verschoben/gedreht/gespiegelt, bleiben die Bezüge; Bezüge auf nicht mittransformierte
//!   Elemente werden gelöst (sonst zöge das Nachführen den Punkt sofort zurück). Kopien behalten
//!   Bezüge nur, wenn das Element mitkopiert wird (auf die Kopie umgeschrieben).
//! - **Lösen** ([`detach_ops`], Befehl „Bemassung lösen"): `refs` weg, `pts` bleibt.

use crate::document::Lookup;
use crate::model::{DimFeature, DimRef};
use crate::ops::Op;
use serde_json::{Map, Value};

type P = (f64, f64);

/// Toleranz der Deckungsgleichheit beim Anhängen (Meter).
pub const TOL: f64 = 1e-5;
/// Änderungen unterhalb davon schreibt das Nachführen nicht zurück.
const MOVE_EPS: f64 = 1e-9;

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}
fn pt(v: Option<&Value>) -> Option<P> {
    let v = v?;
    Some((num(v.get("x"))?, num(v.get("y"))?))
}
fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}
fn dist(a: P, b: P) -> f64 {
    (b.0 - a.0).hypot(b.1 - a.1)
}
fn lerp(a: P, b: P, t: f64) -> P {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}
fn unit(a: P, b: P) -> Option<P> {
    let l = dist(a, b);
    (l > 1e-12 && l.is_finite()).then(|| ((b.0 - a.0) / l, (b.1 - a.1) / l))
}
fn dot(a: P, b: P) -> f64 {
    a.0 * b.0 + a.1 * b.1
}
fn sub(a: P, b: P) -> P {
    (a.0 - b.0, a.1 - b.1)
}
fn add(a: P, b: P, k: f64) -> P {
    (a.0 + b.0 * k, a.1 + b.1 * k)
}
fn left(u: P) -> P {
    (-u.1, u.0)
}
fn finite(p: P) -> bool {
    p.0.is_finite() && p.1.is_finite()
}

// ── Element-Geometrie aus dem JSON-Dokument ─────────────────────────────────

/// Wand: Achse und Abstände der Schichtgrenzen (linke Normale, wie `snap_model::wall_layer_segments`).
struct WallGeo {
    a: P,
    b: P,
    offs: Vec<f64>,
    total: f64,
    arc: bool,
    warc: Option<crate::wall_arc::WallArc>,
}

fn wall_geo(lk: &Lookup, w: &Value) -> Option<WallGeo> {
    let (a, b) = (pt(w.get("start"))?, pt(w.get("end"))?);
    let layers: Vec<f64> = str_of(w, "wallTypeId")
        .and_then(|id| lk.find("wallTypes", id))
        .and_then(|t| t.get("layers"))
        .and_then(Value::as_array)
        .map(|ls| ls.iter().map(|l| num(l.get("thickness")).unwrap_or(0.0)).collect())
        .unwrap_or_default();
    let total: f64 = layers.iter().sum();
    let half = total / 2.0;
    let ref_off = match (num(w.get("referenceOffset")), str_of(w, "referenceLine")) {
        (Some(v), _) => v.clamp(-half, half),
        (None, Some("left")) => half,
        (None, Some("right")) => -half,
        _ => 0.0,
    };
    let mut offs = Vec::new();
    if !layers.is_empty() {
        let mut off = ref_off - half;
        offs.push(off);
        for t in &layers {
            off += t;
            offs.push(off);
        }
    }
    let arc = crate::wall_arc::is_arc_bulge(num(w.get("bulge")));
    let warc = if arc { crate::wall_arc::WallArc::of(kernel2d::Vec2 { x: a.0, y: a.1 }, kernel2d::Vec2 { x: b.0, y: b.1 }, num(w.get("bulge"))) } else { None };
    Some(WallGeo { a, b, offs, total, arc, warc })
}

impl WallGeo {
    fn offset(&self, index: Option<u32>) -> Option<f64> {
        match index {
            None => Some(0.0),
            Some(k) => self.offs.get(k as usize).copied(),
        }
    }

    /// Punkt auf Linie `index` beim Anteil `t` (Bogenwand: entlang der Bogenlänge auf dem Versatzbogen).
    fn point(&self, index: Option<u32>, t: f64) -> Option<P> {
        let o = self.offset(index)?;
        match &self.warc {
            Some(w) => {
                let q = w.point(t * w.length(), o);
                Some((q.x, q.y))
            }
            None => {
                let (a, b) = self.line(index)?;
                Some(lerp(a, b, t))
            }
        }
    }

    /// Linie `index` (fehlt = Achse): Anfang und Ende (Bogenwand: Sehne zwischen den Bogenenden).
    fn line(&self, index: Option<u32>) -> Option<(P, P)> {
        let o = self.offset(index)?;
        if let Some(w) = &self.warc {
            let (p0, p1) = (w.point(0.0, o), w.point(w.length(), o));
            return Some(((p0.x, p0.y), (p1.x, p1.y)));
        }
        let n = left(unit(self.a, self.b)?);
        Some((add(self.a, n, o), add(self.b, n, o)))
    }
    /// Alle Linien: Achse, dann die Schichtgrenzen.
    fn lines(&self) -> Vec<(Option<u32>, P, P)> {
        std::iter::once(None).chain((0..self.offs.len() as u32).map(Some)).filter_map(|k| self.line(k).map(|(a, b)| (k, a, b))).collect()
    }
}

/// Leibungs-/Mittelpunkt einer Öffnung auf der Linie `layer` der Wirtswand (wie `autodim`).
fn opening_point(lk: &Lookup, o: &Value, side: u32, layer: Option<u32>) -> Option<P> {
    let w = lk.find("walls", str_of(o, "hostWallId")?)?;
    let g = wall_geo(lk, w)?;
    let (a, b) = g.line(layer)?;
    let axis = dist(g.a, g.b);
    let (pos, width) = (num(o.get("position"))?, num(o.get("width"))?);
    let from = pos.min(axis).max(0.0);
    let to = (pos + width).min(axis).max(from);
    let s = match side {
        0 => from,
        1 => to,
        2 => (from + to) / 2.0,
        _ => return None,
    };
    let u = unit(a, b)?;
    Some(add(a, u, s))
}

/// Punkte (Umriss/Kette), geschlossen?, Mittelpunkt eines Elements für Ecke/Kante/Mitte.
struct Shape {
    pts: Vec<P>,
    closed: bool,
    center: Option<P>,
    /// Weitere geschlossene Umrisse (Treppenpodest): Ecken/Kanten zählen nach denen von `pts` weiter.
    more: Vec<Vec<P>>,
}

impl Shape {
    fn new(pts: Vec<P>, closed: bool, center: Option<P>) -> Shape {
        Shape { pts, closed, center, more: Vec::new() }
    }

    fn vertex(&self, mut i: usize) -> Option<P> {
        if i < self.pts.len() {
            return Some(self.pts[i]);
        }
        i -= self.pts.len();
        for m in &self.more {
            if i < m.len() {
                return Some(m[i]);
            }
            i -= m.len();
        }
        None
    }

    fn vertex_count(&self) -> usize {
        self.pts.len() + self.more.iter().map(Vec::len).sum::<usize>()
    }
}

fn pts_list(v: Option<&Value>) -> Vec<P> {
    v.and_then(Value::as_array).map(|l| l.iter().filter_map(|p| pt(Some(p))).collect()).unwrap_or_default()
}

fn column_shape(c: &Value) -> Option<Shape> {
    let at = pt(c.get("position"))?;
    let prof = c.get("profile")?;
    if str_of(prof, "kind") == Some("rect") {
        let (hw, hd) = (num(prof.get("width"))? / 2.0, num(prof.get("depth"))? / 2.0);
        let rot = num(c.get("rotation")).unwrap_or(0.0);
        let (co, si) = (crate::jsnum::cos(rot), crate::jsnum::sin(rot));
        let pts = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)].iter().map(|&(x, y)| (at.0 + x * co - y * si, at.1 + x * si + y * co)).collect();
        return Some(Shape::new(pts, true, Some(at)));
    }
    Some(Shape::new(Vec::new(), false, Some(at)))
}

fn drawing_shape(d: &Value) -> Option<Shape> {
    let g = d.get("geom")?;
    let p = |k: &str| pt(g.get(k));
    Some(match str_of(g, "shape")? {
        "line" => Shape::new(vec![p("a")?, p("b")?], false, None),
        "polyline" => Shape::new(pts_list(g.get("pts")), g.get("closed").and_then(Value::as_bool).unwrap_or(false), None),
        "rect" => {
            let (lo, hi) = (p("min")?, p("max")?);
            Shape::new(vec![lo, (hi.0, lo.1), hi, (lo.0, hi.1)], true, None)
        }
        "circle" | "arc" | "ellipse" => Shape::new(Vec::new(), false, Some(p("center")?)),
        _ => return None,
    })
}

/// Listen, in denen Ecke/Kante/Mitte ihr Element suchen (in dieser Reihenfolge).
const SHAPE_LISTS: [&str; 6] = ["columns", "ceilings", "roofs", "rooms", "drawings2d", "stairs"];

/// Treppe: Umriss (gerade/L: Aussenlinie; Wendel: die vier Ecken der Schliesslinien), Podest als
/// weiterer Umriss, Mittelpunkt nur bei der Wendel.
fn stair_shape(e: &Value) -> Option<Shape> {
    let s: crate::model::Stair = serde_json::from_value(e.clone()).ok()?;
    let sp = crate::stair::decode_params(&s.encode())?;
    let o = kernel2d::stair_outline(&sp);
    let t = |q: &kernel2d::Vec2| (q.x, q.y);
    if let Some(poly) = o.polygon {
        let mut sh = Shape::new(poly.iter().map(t).collect(), true, None);
        if let Some(l) = kernel2d::stair_geometry(&sp, 3.0).landing {
            sh.more.push(l.iter().map(t).collect());
        }
        return Some(sh);
    }
    let sp2 = o.spiral?;
    let [(i0, o0), (i1, o1)] = sp2.lines;
    Some(Shape::new(vec![t(&i0), t(&o0), t(&o1), t(&i1)], true, Some((sp2.arcs[0].0.x, sp2.arcs[0].0.y))))
}

fn shape_of(coll: &str, e: &Value) -> Option<Shape> {
    match coll {
        "columns" => column_shape(e),
        "ceilings" | "roofs" => Some(Shape::new(pts_list(e.get("outline")), true, None)),
        "rooms" => Some(Shape::new(pts_list(e.get("boundary")), true, None)),
        "drawings2d" => drawing_shape(e),
        "stairs" => stair_shape(e),
        _ => None,
    }
}

fn find_shape(lk: &Lookup, id: &str) -> Option<Shape> {
    SHAPE_LISTS.iter().find_map(|c| lk.find(c, id).map(|e| (*c, e))).and_then(|(c, e)| shape_of(c, e))
}

fn ring_edge(pts: &[P], closed: bool, i: usize) -> Option<(P, P)> {
    let n = pts.len();
    if i + 1 < n {
        Some((pts[i], pts[i + 1]))
    } else if closed && n > 2 && i + 1 == n {
        Some((pts[i], pts[0]))
    } else {
        None
    }
}

fn ring_edges(pts: &[P], closed: bool) -> usize {
    if closed && pts.len() > 2 {
        pts.len()
    } else {
        pts.len().saturating_sub(1)
    }
}

fn edge(s: &Shape, mut i: usize) -> Option<(P, P)> {
    let n = ring_edges(&s.pts, s.closed);
    if i < n {
        return ring_edge(&s.pts, s.closed, i);
    }
    i -= n;
    for m in &s.more {
        let k = ring_edges(m, true);
        if i < k {
            return ring_edge(m, true, i);
        }
        i -= k;
    }
    None
}

fn edge_count(s: &Shape) -> usize {
    ring_edges(&s.pts, s.closed) + s.more.iter().map(|m| ring_edges(m, true)).sum::<usize>()
}

/// Rasterachse `index` des Rasters `id` und das Raster selbst.
fn with_grid<T>(lk: &Lookup, id: &str, f: impl FnOnce(&crate::grid::Spec) -> Option<T>) -> Option<T> {
    let d = lk.find("drawings2d", id)?;
    let g: crate::model::Drawing2DGeom = serde_json::from_value(d.get("geom")?.clone()).ok()?;
    f(&crate::grid::Spec::of(&g)?)
}

/// Kreis/Bogen (2D-Zeichnung) oder Bogenwand-Schicht: Mittelpunkt, Radius.
fn round_of(lk: &Lookup, id: &str, index: Option<u32>) -> Option<(P, f64)> {
    if let Some(d) = lk.find("drawings2d", id) {
        let g = d.get("geom")?;
        if matches!(str_of(g, "shape"), Some("circle" | "arc")) {
            return Some((pt(g.get("center"))?, num(g.get("r"))?));
        }
        return None;
    }
    let g = wall_geo(lk, lk.find("walls", id)?)?;
    let w = g.warc?;
    Some(((w.center.x, w.center.y), w.radius_at(g.offset(index)?)))
}

/// Schnitt zweier unendlicher Geraden (parallel → `None`).
fn intersect(a: (P, P), b: (P, P)) -> Option<P> {
    let r = sub(a.1, a.0);
    let s = sub(b.1, b.0);
    let den = r.0 * s.1 - r.1 * s.0;
    let scale = dist(a.0, a.1) * dist(b.0, b.1);
    if den.abs() <= 1e-9 * scale || scale == 0.0 {
        return None;
    }
    let q = sub(b.0, a.0);
    let t = (q.0 * s.1 - q.1 * s.0) / den;
    Some(add(a.0, r, t))
}

/// Lage des Merkmals eines Bezugs (`None` = ungültig).
pub fn resolve(lk: &Lookup, r: &DimRef) -> Option<P> {
    let wall_line = |id: &str, idx: Option<u32>| -> Option<(P, P)> { wall_geo(lk, lk.find("walls", id)?)?.line(idx) };
    let p = match r.feature {
        DimFeature::Wall => wall_geo(lk, lk.find("walls", &r.id)?)?.point(r.index, r.t?)?,
        DimFeature::Opening => opening_point(lk, lk.find("openings", &r.id)?, r.index?, r.index2)?,
        DimFeature::Vertex => find_shape(lk, &r.id)?.vertex(r.index? as usize)?,
        DimFeature::Edge => {
            let (a, b) = edge(&find_shape(lk, &r.id)?, r.index? as usize)?;
            lerp(a, b, r.t?)
        }
        DimFeature::Center => match find_shape(lk, &r.id) {
            Some(sh) => sh.center?,
            None => {
                let w = wall_geo(lk, lk.find("walls", &r.id)?)?.warc?;
                (w.center.x, w.center.y)
            }
        },
        DimFeature::Axis => with_grid(lk, &r.id, |g| g.point_at(r.index?, r.t?))?,
        DimFeature::AxisCross => with_grid(lk, &r.id, |g| g.cross(r.index?, r.index2?))?,
        DimFeature::Rim => {
            let (c, rad) = round_of(lk, &r.id, r.index)?;
            let a = r.t?;
            (c.0 + rad * a.cos(), c.1 + rad * a.sin())
        }
        DimFeature::Intersection => intersect(wall_line(&r.id, r.index)?, wall_line(r.id2.as_deref()?, r.index2)?)?,
    };
    finite(p).then_some(p)
}

// ── Anhängen ────────────────────────────────────────────────────────────────

fn on_level(e: &Value, key: &str, level: &str) -> bool {
    str_of(e, key) == Some(level)
}

fn list<'a>(lk: &Lookup<'a>, key: &str) -> &'a [Value] {
    lk.root.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn rf(id: &str, feature: DimFeature) -> DimRef {
    DimRef { id: id.to_owned(), feature, index: None, t: None, id2: None, index2: None, d: None, lost: None }
}

/// Parameter von `s` auf a→b und Normalabstand zur Geraden.
fn param(a: P, b: P, s: P) -> Option<(f64, f64)> {
    let u = unit(a, b)?;
    let l = dist(a, b);
    let q = sub(s, a);
    Some((dot(q, u) / l, dot(q, left(u)).abs()))
}

/// Merkmal des Geschosses `level`, auf dem `s` liegt (Toleranz `tol`), sonst `None`.
pub fn attach(lk: &Lookup, level: &str, s: P, tol: f64) -> Option<DimRef> {
    if !finite(s) {
        return None;
    }
    let walls: Vec<(&str, WallGeo)> = list(lk, "walls")
        .iter()
        .filter(|w| on_level(w, "floorId", level))
        .filter_map(|w| Some((str_of(w, "id")?, wall_geo(lk, w)?)))
        .collect();
    // 1) Öffnungen: Leibungen und Mitte auf jeder Linie der Wirtswand.
    for o in list(lk, "openings") {
        let (Some(id), Some(host)) = (str_of(o, "id"), str_of(o, "hostWallId")) else { continue };
        let Some((_, g)) = walls.iter().find(|(wid, _)| *wid == host) else { continue };
        for (layer, _, _) in g.lines() {
            for side in 0..3 {
                if opening_point(lk, o, side, layer).is_some_and(|p| dist(p, s) <= tol) {
                    return Some(DimRef { index: Some(side), index2: layer, ..rf(id, DimFeature::Opening) });
                }
            }
        }
    }
    // 2) Wandenden.
    for (id, g) in &walls {
        for (k, a, b) in g.lines() {
            for (t, p) in [(0.0, a), (1.0, b)] {
                if dist(p, s) <= tol {
                    return Some(DimRef { index: k, t: Some(t), ..rf(id, DimFeature::Wall) });
                }
            }
        }
    }
    // 2b) Bogenwände: Mittelpunkt, Punkt auf Achse/Schichtgrenze (Anteil der Bogenlänge).
    for (id, g) in walls.iter().filter(|(_, g)| g.warc.is_some()) {
        let Some(w) = &g.warc else { continue };
        if dist((w.center.x, w.center.y), s) <= tol {
            return Some(rf(id, DimFeature::Center));
        }
        let (ls, ln) = w.local(kernel2d::Vec2 { x: s.0, y: s.1 });
        let len = w.length();
        for (k, _, _) in g.lines() {
            let Some(o) = g.offset(k) else { continue };
            if (ln - o).abs() <= tol && ls >= -tol && ls <= len + tol {
                return Some(DimRef { index: k, t: Some((ls / len).clamp(0.0, 1.0)), ..rf(id, DimFeature::Wall) });
            }
        }
    }
    // 3) Wandecken: auf den Linien zweier Wände (Verlängerung bis zur Wanddicke über das Ende).
    let mut hits: Vec<(&str, Option<u32>, P, P, f64)> = Vec::new();
    for (id, g) in walls.iter().filter(|(_, g)| !g.arc) {
        let len = dist(g.a, g.b);
        let m = (g.total.max(0.3) + tol) / len;
        for (k, a, b) in g.lines() {
            if let Some((t, d)) = param(a, b, s) {
                if d <= tol && t >= -m && t <= 1.0 + m {
                    hits.push((id, k, a, b, t));
                }
            }
        }
    }
    for (i, h) in hits.iter().enumerate() {
        for h2 in &hits[i + 1..] {
            if h2.0 != h.0 && intersect((h.2, h.3), (h2.2, h2.3)).is_some_and(|p| dist(p, s) <= tol) {
                return Some(DimRef { index: h.1, id2: Some(h2.0.to_owned()), index2: h2.1, ..rf(h.0, DimFeature::Intersection) });
            }
        }
    }
    // 4) Punkt auf einer Wandlinie.
    if let Some(h) = hits.iter().find(|h| (0.0..=1.0).contains(&h.4)) {
        return Some(DimRef { index: h.1, t: Some(h.4), ..rf(h.0, DimFeature::Wall) });
    }
    // 5) Stützen, Decken, Dächer, Räume, 2D-Zeichnungen, Treppen: Mitte, Ecken, Kanten.
    for coll in SHAPE_LISTS {
        let key = if coll == "drawings2d" { "levelId" } else { "floorId" };
        for e in list(lk, coll).iter().filter(|e| on_level(e, key, level)) {
            let (Some(id), Some(sh)) = (str_of(e, "id"), shape_of(coll, e)) else { continue };
            if sh.center.is_some_and(|c| dist(c, s) <= tol) {
                return Some(rf(id, DimFeature::Center));
            }
            if let Some(i) = (0..sh.vertex_count()).find(|&i| sh.vertex(i).is_some_and(|p| dist(p, s) <= tol)) {
                return Some(DimRef { index: Some(i as u32), ..rf(id, DimFeature::Vertex) });
            }
            for i in 0..edge_count(&sh) {
                let Some((a, b)) = edge(&sh, i) else { continue };
                if let Some((t, d)) = param(a, b, s) {
                    if d <= tol && (0.0..=1.0).contains(&t) {
                        return Some(DimRef { index: Some(i as u32), t: Some(t), ..rf(id, DimFeature::Edge) });
                    }
                }
            }
        }
    }
    // 6) Achsraster ([112]): Achsschnittpunkt, sonst Punkt auf einer Achse.
    for d in list(lk, "drawings2d") {
        let Some(id) = str_of(d, "id") else { continue };
        let Some(g) = d.get("geom").filter(|g| str_of(g, "shape") == Some("grid")) else { continue };
        let Ok(geom) = serde_json::from_value::<crate::model::Drawing2DGeom>(g.clone()) else { continue };
        let Some(spec) = crate::grid::Spec::of(&geom) else { continue };
        let visible = serde_json::from_value::<crate::model::Drawing2D>(d.clone()).map(|dd| crate::grid::visible_on(&dd, level)).unwrap_or(false);
        if !visible {
            continue;
        }
        let n = (spec.a.len() + spec.b.len()) as u32;
        for i in 0..spec.a.len() as u32 {
            for j in spec.a.len() as u32..n {
                if spec.cross(i, j).is_some_and(|p| dist(p, s) <= tol) {
                    return Some(DimRef { index: Some(i), index2: Some(j), ..rf(id, DimFeature::AxisCross) });
                }
            }
        }
        for i in 0..n {
            if let Some((t, d)) = spec.project(i, s) {
                if d <= tol && (-1e-9..=1.0 + 1e-9).contains(&t) {
                    return Some(DimRef { index: Some(i), t: Some(t.clamp(0.0, 1.0)), ..rf(id, DimFeature::Axis) });
                }
            }
        }
    }
    None
}

/// Rand-Bezug (Winkel `a`) auf dem Kreis/Bogen `id` ([38]).
fn rim(id: &str, index: Option<u32>, a: f64) -> DimRef {
    DimRef { index, t: Some(a), ..rf(id, DimFeature::Rim) }
}

/// Kreis/Bogen (2D-Zeichnung des Geschosses) oder Bogenwand-Schicht, auf deren Rand `s` liegt
/// (Toleranz `tol`): Kennung, Schichtgrenze, Mittelpunkt, Radius.
pub fn find_round(lk: &Lookup, level: &str, s: P, tol: f64) -> Option<(String, Option<u32>, P, f64)> {
    // Nächster Rand innerhalb der Toleranz (bei konzentrischen Kreisen/Schichten der genaueste).
    let mut best: Option<(f64, (String, Option<u32>, P, f64))> = None;
    let mut offer = |err: f64, hit: (String, Option<u32>, P, f64)| {
        if err <= tol && best.as_ref().is_none_or(|(e, _)| err < *e) {
            best = Some((err, hit));
        }
    };
    for d in list(lk, "drawings2d").iter().filter(|d| on_level(d, "levelId", level)) {
        let (Some(id), Some(g)) = (str_of(d, "id"), d.get("geom")) else { continue };
        if !matches!(str_of(g, "shape"), Some("circle" | "arc")) {
            continue;
        }
        let (Some(c), Some(r)) = (pt(g.get("center")), num(g.get("r"))) else { continue };
        offer((dist(c, s) - r).abs(), (id.to_owned(), None, c, r));
    }
    for w in list(lk, "walls").iter().filter(|w| on_level(w, "floorId", level)) {
        let (Some(id), Some(g)) = (str_of(w, "id"), wall_geo(lk, w)) else { continue };
        let Some(arc) = g.warc else { continue };
        let c = (arc.center.x, arc.center.y);
        let mut ks: Vec<Option<u32>> = vec![None];
        ks.extend((0..g.offs.len() as u32).map(Some));
        for k in ks {
            let Some(o) = g.offset(k) else { continue };
            let r = arc.radius_at(o);
            offer((dist(c, s) - r).abs(), (id.to_owned(), k, c, r));
        }
    }
    best.map(|(_, h)| h)
}

/// Radius-/Durchmesser-/Bogenlängen-Bemassung ([38]): aus den Klickpunkten `clicks` (ein Punkt auf
/// dem Rand; bei der Bogenlänge Anfang und Ende) die Punkte `pts` (Mittelpunkt, Randpunkt[e]) und
/// ihre Bezüge. `None`, wenn kein Kreis/Bogen/Bogenwand getroffen wird.
pub fn round_dimension(lk: &Lookup, level: &str, kind: crate::model::DimKind, clicks: &[P], tol: f64) -> Option<(Vec<P>, Vec<Option<DimRef>>)> {
    use crate::model::DimKind;
    let first = *clicks.first()?;
    let (id, idx, c, r) = find_round(lk, level, first, tol)?;
    let ang = |p: P| (p.1 - c.1).atan2(p.0 - c.0);
    let on_rim = |a: f64| (c.0 + r * a.cos(), c.1 + r * a.sin());
    let a0 = ang(first);
    let mut pts = vec![c, on_rim(a0)];
    let mut refs = vec![Some(rf(&id, DimFeature::Center)), Some(rim(&id, idx, a0))];
    if kind == DimKind::Arc {
        let a1 = ang(*clicks.get(1)?);
        pts.push(on_rim(a1));
        refs.push(Some(rim(&id, idx, a1)));
    }
    Some((pts, refs))
}

/// Bezüge einer neuen Kette `pts`: je Punkt der erste Fangpunkt aus `snaps`, der auf ihn projiziert
/// (Kette = Gerade pts[0]→pts[1]) und an einem Merkmal hängt; `d` = Normalabstand Fangpunkt → Punkt.
/// `keep(i)` liefert einen schon bekannten Bezug (Ergänzen einer Kette). Kein Bezug → `None`.
pub fn refs_for_chain(lk: &Lookup, level: &str, pts: &[P], snaps: &[P], keep: &dyn Fn(P) -> Option<DimRef>) -> Option<Vec<Option<DimRef>>> {
    if pts.len() < 2 {
        return None;
    }
    let u = unit(pts[0], pts[1])?;
    let n = left(u);
    let refs: Vec<Option<DimRef>> = pts
        .iter()
        .map(|&p| {
            if let Some(r) = keep(p) {
                return Some(r);
            }
            snaps.iter().chain(std::iter::once(&p)).find_map(|&s| {
                let along = add(pts[0], u, dot(sub(s, pts[0]), u));
                if dist(along, p) > 1e-6 {
                    return None;
                }
                let mut r = attach(lk, level, s, TOL)?;
                let d = dot(sub(s, p), n);
                r.d = (d.abs() > 1e-9).then_some(d);
                Some(r)
            })
        })
        .collect();
    refs.iter().any(Option::is_some).then_some(refs)
}

// ── Auflösen einer Kette ────────────────────────────────────────────────────

/// Aufgelöste Kette: neue Punkte und je Bezug „ungültig".
pub fn resolve_chain(lk: &Lookup, pts: &[P], refs: &[Option<DimRef>]) -> (Vec<P>, Vec<bool>) {
    let q: Vec<Option<P>> = (0..pts.len()).map(|i| refs.get(i).and_then(Option::as_ref).and_then(|r| resolve(lk, r))).collect();
    let lost: Vec<bool> = (0..refs.len()).map(|i| refs[i].is_some() && q.get(i).copied().flatten().is_none()).collect();
    let Some(mut u) = (pts.len() >= 2).then(|| unit(pts[0], pts[1])).flatten() else { return (pts.to_vec(), lost) };
    let d_of = |i: usize| refs.get(i).and_then(Option::as_ref).and_then(|r| r.d).unwrap_or(0.0);
    let base = |u: P, i: usize| q[i].map(|p| add(p, left(u), -d_of(i)));
    if let (Some(_), Some(_)) = (q[0], q[1]) {
        for _ in 0..2 {
            if let (Some(b0), Some(b1)) = (base(u, 0), base(u, 1)) {
                if let Some(nu) = unit(b0, b1) {
                    u = nu;
                }
            }
        }
    }
    let n = left(u);
    let origin = match (0..pts.len()).find_map(|i| base(u, i).map(|b| (i, b))) {
        Some((0, b)) => b,
        Some((_, b)) => add(pts[0], n, dot(sub(b, pts[0]), n)),
        None => pts[0],
    };
    let out = (0..pts.len())
        .map(|i| {
            let target = base(u, i).unwrap_or(pts[i]);
            add(origin, u, dot(sub(target, origin), u))
        })
        .collect();
    (out, lost)
}

/// Punkte ohne Kettenprojektion (Radius-/Bogenmass): jeder hängende Punkt an seiner Lage.
fn resolve_each(lk: &Lookup, pts: &[P], refs: &[Option<DimRef>]) -> (Vec<P>, Vec<bool>) {
    let q: Vec<Option<P>> = (0..pts.len()).map(|i| refs.get(i).and_then(Option::as_ref).and_then(|r| resolve(lk, r))).collect();
    let lost = (0..refs.len()).map(|i| refs[i].is_some() && q.get(i).copied().flatten().is_none()).collect();
    (pts.iter().zip(&q).map(|(p, n)| n.unwrap_or(*p)).collect(), lost)
}

fn refs_of(g: &Value) -> Option<Vec<Option<DimRef>>> {
    let r = g.get("refs")?;
    let refs: Vec<Option<DimRef>> = serde_json::from_value(r.clone()).ok()?;
    refs.iter().any(Option::is_some).then_some(refs)
}

fn pv(p: P) -> Value {
    crate::grips::pt(p.0, p.1)
}

fn with(v: &Value, key: &str, x: Value) -> Value {
    let mut m = v.as_object().cloned().unwrap_or_default();
    m.insert(key.to_owned(), x);
    Value::Object(m)
}

/// Felder, deren Änderung Bezüge verschieben kann.
pub const SOURCE_FIELDS: [&str; 8] = ["walls", "wallTypes", "openings", "columns", "ceilings", "roofs", "rooms", "drawings2d"];

/// Nachführ-Ops: je Bemassung mit Bezügen, deren aufgelöste Lage oder Gültigkeit sich geändert hat,
/// ein `replace` mit neuen `pts`/`refs`.
pub fn sync_ops(lk: &Lookup) -> Vec<Op> {
    let mut ops = Vec::new();
    for d in list(lk, "drawings2d") {
        let Some(g) = d.get("geom").filter(|g| str_of(g, "shape") == Some("dimension")) else { continue };
        let Some(refs) = refs_of(g) else { continue };
        let pts = pts_list(g.get("pts"));
        if pts.len() != g.get("pts").and_then(Value::as_array).map_or(0, Vec::len) {
            continue;
        }
        let round = str_of(g, "kind").is_some();
        let (np, lost) = if round { resolve_each(lk, &pts, &refs) } else { resolve_chain(lk, &pts, &refs) };
        let moved = np.iter().zip(&pts).any(|(a, b)| dist(*a, *b) > MOVE_EPS);
        let flags_changed = refs.iter().zip(&lost).any(|(r, l)| r.as_ref().is_some_and(|r| r.lost.unwrap_or(false) != *l));
        if !moved && !flags_changed {
            continue;
        }
        let mut ng = g.clone();
        if moved {
            ng = with(&ng, "pts", Value::Array(np.iter().map(|p| pv(*p)).collect()));
        }
        if flags_changed {
            let nr: Vec<Option<DimRef>> = refs.into_iter().zip(&lost).map(|(r, l)| r.map(|r| DimRef { lost: l.then_some(true), ..r })).collect();
            ng = with(&ng, "refs", serde_json::to_value(nr).unwrap_or(Value::Null));
        }
        ops.push(Op::Replace { collection: "drawings2d".into(), entity: with(d, "geom", ng) });
    }
    ops
}

/// Betrifft eine der Ops ein Feld, aus dem Bezüge lesen?
pub fn touches_sources(ops: &[Op]) -> bool {
    ops.iter().any(|o| SOURCE_FIELDS.contains(&o.key()))
}

/// „Bemassung lösen": `refs` der gewählten Bemassungen entfernen (Punkte bleiben, wo sie sind).
pub fn detach_ops(root: &Map<String, Value>, ids: &[String]) -> Vec<Op> {
    let lk = Lookup::plain(root);
    list(&lk, "drawings2d")
        .iter()
        .filter(|d| str_of(d, "id").is_some_and(|id| ids.iter().any(|x| x == id)))
        .filter_map(|d| {
            let g = d.get("geom")?.as_object()?;
            g.get("refs")?;
            let mut ng = g.clone();
            ng.remove("refs");
            Some(Op::Replace { collection: "drawings2d".into(), entity: with(d, "geom", Value::Object(ng)) })
        })
        .collect()
}

/// Bemassungs-Geometrie `g` ohne den Bezug von Punkt `i` (`None` = alle); ohne verbleibenden Bezug
/// entfällt das Feld. Für Griffe: ein von Hand gezogener Punkt ist frei.
pub fn without_ref(g: &Value, i: Option<usize>) -> Value {
    let Some(mut refs) = refs_of(g) else { return g.clone() };
    match i {
        Some(i) if i < refs.len() => refs[i] = None,
        Some(_) => return g.clone(),
        None => refs.clear(),
    }
    let mut m = g.as_object().cloned().unwrap_or_default();
    if refs.iter().any(Option::is_some) {
        m.insert("refs".into(), serde_json::to_value(refs).unwrap_or(Value::Null));
    } else {
        m.remove("refs");
    }
    Value::Object(m)
}

/// Bezüge einer transformierten Bemassung: Bezüge, deren Element(e) `map` kennt, bleiben (id auf die
/// Kopie umgeschrieben); die übrigen fallen weg. Kein Bezug mehr → `None` (Feld entfällt).
pub fn transformed_refs(g: &Value, map: &dyn Fn(&str) -> Option<String>) -> Option<Option<Value>> {
    let refs = refs_of(g)?;
    let host_ok = |r: &DimRef| -> Option<DimRef> {
        let id = map(&r.id)?;
        let id2 = match &r.id2 {
            Some(x) => Some(map(x)?),
            None => None,
        };
        Some(DimRef { id, id2, ..r.clone() })
    };
    let nr: Vec<Option<DimRef>> = refs.iter().map(|r| r.as_ref().and_then(host_ok)).collect();
    Some(nr.iter().any(Option::is_some).then(|| serde_json::to_value(nr).unwrap_or(Value::Null)))
}

/// Indizes der Punkte mit ungültigem Bezug einer Bemassung (für Marke und Objekt-Info).
pub fn lost_points(refs: Option<&Vec<Option<DimRef>>>) -> Vec<usize> {
    refs.map(|r| r.iter().enumerate().filter(|(_, r)| r.as_ref().is_some_and(|r| r.lost == Some(true))).map(|(i, _)| i).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    /// Zwei Wände (0.3 m, zwei Schichten 0.1/0.2) im L, Öffnung, Stütze, Decke, Zeichnungen.
    fn project() -> Map<String, Value> {
        root(json!({
            "wallTypes": [{"id": "T", "layers": [{"thickness": 0.1}, {"thickness": 0.2}]}],
            "walls": [
                {"id": "A", "floorId": "eg", "wallTypeId": "T", "start": {"x": 0, "y": 0}, "end": {"x": 10, "y": 0}},
                {"id": "B", "floorId": "eg", "wallTypeId": "T", "start": {"x": 10, "y": 0}, "end": {"x": 10, "y": 6}}
            ],
            "openings": [{"id": "O", "hostWallId": "A", "position": 2, "width": 1.5}],
            "columns": [{"id": "S", "floorId": "eg", "position": {"x": 5, "y": 3}, "profile": {"kind": "rect", "width": 0.4, "depth": 0.2}, "rotation": 0}],
            "ceilings": [{"id": "C", "floorId": "eg", "outline": [{"x": 0, "y": 0}, {"x": 4, "y": 0}, {"x": 4, "y": 4}]}],
            "drawings2d": [
                {"id": "L", "levelId": "eg", "geom": {"shape": "line", "a": {"x": 20, "y": 0}, "b": {"x": 24, "y": 0}}},
                {"id": "K", "levelId": "eg", "geom": {"shape": "circle", "center": {"x": 30, "y": 0}, "r": 1}}
            ]
        }))
    }

    fn at(r: &Map<String, Value>, s: P) -> DimRef {
        attach(&Lookup::plain(r), "eg", s, TOL).unwrap_or_else(|| panic!("kein Merkmal bei {s:?}"))
    }

    fn close(a: P, b: P) {
        assert!(dist(a, b) < 1e-9, "{a:?} != {b:?}");
    }

    #[test]
    fn anhaengen_und_aufloesen_je_merkmal() {
        let r = project();
        let lk = Lookup::plain(&r);
        // Fläche rechts der Achse (Grenze 0 bei −0.15), Ende → Wandende.
        let cases: Vec<(P, DimFeature)> = vec![
            ((0.0, 0.0), DimFeature::Wall),
            ((10.0, -0.15), DimFeature::Wall),
            ((3.0, 0.15), DimFeature::Wall),
            ((2.0, -0.15), DimFeature::Opening),
            ((2.75, 0.0), DimFeature::Opening),
            ((10.15, -0.15), DimFeature::Intersection),
            ((5.0, 3.0), DimFeature::Center),
            ((5.2, 3.1), DimFeature::Vertex),
            ((5.0, 2.9), DimFeature::Edge),
            ((4.0, 2.0), DimFeature::Edge),
            ((24.0, 0.0), DimFeature::Vertex),
            ((22.0, 0.0), DimFeature::Edge),
            ((30.0, 0.0), DimFeature::Center),
        ];
        for (s, f) in cases {
            let rf = at(&r, s);
            assert_eq!(rf.feature, f, "{s:?}: {rf:?}");
            close(resolve(&lk, &rf).unwrap(), s);
        }
        assert!(attach(&lk, "eg", (7.0, 7.0), TOL).is_none());
        assert!(attach(&lk, "og", (0.0, 0.0), TOL).is_none());
    }

    fn set(r: &mut Map<String, Value>, coll: &str, id: &str, key: &str, v: Value) {
        let e = r.get_mut(coll).unwrap().as_array_mut().unwrap().iter_mut().find(|e| e["id"] == id).unwrap();
        e[key] = v;
    }

    #[test]
    fn folgt_dem_element() {
        let mut r = project();
        let refs = {
            let lk = Lookup::plain(&r);
            vec![attach(&lk, "eg", (0.0, -0.15), TOL), attach(&lk, "eg", (2.0, -0.15), TOL), attach(&lk, "eg", (10.15, -0.15), TOL)]
        };
        // Wand A strecken: Ende nach x = 12 (Ecke folgt dem Schnitt, Wand B mitverschoben).
        set(&mut r, "walls", "A", "end", json!({"x": 12, "y": 0}));
        set(&mut r, "walls", "B", "start", json!({"x": 12, "y": 0}));
        set(&mut r, "walls", "B", "end", json!({"x": 12, "y": 6}));
        set(&mut r, "openings", "O", "position", json!(3));
        let (np, lost) = resolve_chain(&Lookup::plain(&r), &[(0.0, -0.15), (2.0, -0.15), (10.15, -0.15)], &refs);
        assert_eq!(lost, vec![false; 3]);
        close(np[1], (3.0, -0.15));
        close(np[2], (12.15, -0.15));
        // Wand drehen (beide Punkte an derselben Wand): Kette dreht mit.
        set(&mut r, "walls", "A", "end", json!({"x": 0, "y": 5}));
        let (np, _) = resolve_chain(&Lookup::plain(&r), &[(0.0, 0.0), (10.0, 0.0)], &[Some(at(&project(), (0.0, 0.0))), Some(at(&project(), (10.0, 0.0)))]);
        close(np[0], (0.0, 0.0));
        close(np[1], (0.0, 5.0));
    }

    #[test]
    fn ungueltig_faellt_zurueck_und_wird_markiert() {
        let mut r = project();
        let pts = vec![(0.0, 0.0), (24.0, 0.0)];
        let refs = vec![Some(at(&r, (0.0, 0.0))), Some(at(&r, (24.0, 0.0)))];
        r.insert("drawings2d".into(), json!([
            {"id": "D", "levelId": "eg", "geom": {"shape": "dimension", "pts": [{"x": 0, "y": 0}, {"x": 24, "y": 0}], "offset": 1, "refs": refs}}
        ]));
        // Linie L weg: Punkt 1 bleibt, wird markiert; nochmals nachführen ändert nichts.
        let ops = sync_ops(&Lookup::plain(&r));
        assert_eq!(ops.len(), 1);
        let Op::Replace { entity, .. } = &ops[0] else { panic!() };
        assert_eq!(entity["geom"]["refs"][1]["lost"], json!(true));
        assert!(entity["geom"]["refs"][0].get("lost").is_none());
        assert_eq!(pts_list(entity["geom"].get("pts")), pts);
        r.insert("drawings2d".into(), json!([entity]));
        assert!(sync_ops(&Lookup::plain(&r)).is_empty());
        assert_eq!(lost_points(refs_of(&r["drawings2d"][0]["geom"]).as_ref()), vec![1]);
        // Wand weg, Vertex-Index ausserhalb, Schichtgrenze weg: ungültig.
        let lk = Lookup::plain(&r);
        assert!(resolve(&lk, &DimRef { index: Some(9), ..rf("C", DimFeature::Vertex) }).is_none());
        assert!(resolve(&lk, &DimRef { index: Some(7), t: Some(0.0), ..rf("A", DimFeature::Wall) }).is_none());
        assert!(resolve(&lk, &DimRef { t: Some(0.0), ..rf("X", DimFeature::Wall) }).is_none());
        // Parallele Linien schneiden sich nicht.
        assert!(resolve(&lk, &DimRef { id2: Some("A".into()), ..rf("A", DimFeature::Intersection) }).is_none());
    }

    #[test]
    fn kette_mit_abstand_bleibt_in_flucht() {
        let mut r = project();
        // Kette auf y = −2 (Aussenbemassung), Merkmale auf der Wandfläche: d = +1.85.
        let pts = [(0.0, -2.0), (2.0, -2.0)];
        let refs = refs_for_chain(&Lookup::plain(&r), "eg", &pts, &[(0.0, -0.15), (2.0, -0.15)], &|_| None).unwrap();
        assert!((refs[0].as_ref().unwrap().d.unwrap() - 1.85).abs() < 1e-12);
        let (np, _) = resolve_chain(&Lookup::plain(&r), &pts, &refs);
        close(np[0], pts[0]);
        close(np[1], pts[1]);
        // Öffnung verschoben → Punkt 1 wandert entlang, die Linie bleibt auf y = −2.
        set(&mut r, "openings", "O", "position", json!(4));
        let (np, _) = resolve_chain(&Lookup::plain(&r), &pts, &refs);
        close(np[1], (4.0, -2.0));
    }

    #[test]
    fn loesen_und_transformieren() {
        let r = root(json!({"drawings2d": [{"id": "D", "geom": {"shape": "dimension", "pts": [], "offset": 0, "refs": [{"id": "A", "feature": "wall", "t": 0}, null]}}]}));
        let ops = detach_ops(&r, &["D".into()]);
        let Op::Replace { entity, .. } = &ops[0] else { panic!() };
        assert!(entity["geom"].get("refs").is_none());
        let g = &r["drawings2d"][0]["geom"];
        assert_eq!(transformed_refs(g, &|_| None), Some(None));
        let kept = transformed_refs(g, &|id| Some(format!("{id}2"))).unwrap().unwrap();
        assert_eq!(kept[0]["id"], json!("A2"));
    }

    #[test]
    fn commit_fuehrt_nach_ein_undo_schritt() {
        use crate::document::Document;
        let mut r = project();
        let refs = vec![Some(at(&r, (0.0, 0.0))), Some(at(&r, (10.0, 0.0)))];
        r.insert("drawings2d".into(), json!([{"id": "D", "levelId": "eg", "geom": {"shape": "dimension", "pts": [{"x": 0, "y": 0}, {"x": 10, "y": 0}], "offset": 1, "refs": refs}}]));
        let mut d = Document::from_json(&Value::Object(r).to_string()).unwrap();
        let mut w = d.lookup().find("walls", "A").unwrap().clone();
        w["end"] = json!({"x": 13, "y": 0});
        let ops = crate::ops::ops_from_json(&json!([{"kind": "replace", "collection": "walls", "entity": w}])).unwrap();
        d.commit(ops, None, 0.0, false).unwrap();
        assert_eq!(d.last_extra().len(), 1);
        let x = |d: &Document| d.lookup().find("drawings2d", "D").unwrap()["geom"]["pts"][1]["x"].as_f64().unwrap();
        assert_eq!(x(&d), 13.0);
        d.undo().unwrap();
        assert_eq!(x(&d), 10.0);
        d.redo().unwrap();
        assert_eq!(x(&d), 13.0);
        // Ohne Bezugsänderung (Feld ausserhalb): nichts nachzuführen.
        d.commit(crate::ops::ops_from_json(&json!([{"kind": "setField", "key": "name", "value": "X"}])).unwrap(), None, 1.0, false).unwrap();
        assert!(d.last_extra().is_empty());
    }

    fn grid_project() -> Map<String, Value> {
        root(json!({
            "drawings2d": [
                {"id": "G", "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "grid", "origin": {"x": 0, "y": 0}, "angle": 0,
                    "a": [{"label": "1", "pos": 0}, {"label": "2", "pos": 6}], "b": [{"label": "A", "pos": 0}, {"label": "B", "pos": 4}], "extend": 1}}
            ]
        }))
    }

    /// [112] Rasterachsen: Punkt auf Achse, Achsschnittpunkt; die Bemassung folgt der verschobenen Achse.
    #[test]
    fn rasterachsen_bezuege_folgen_der_achse() {
        let mut r = grid_project();
        let lk = Lookup::plain(&r);
        // Achsschnittpunkt 2/B (index 1 × index 3), Punkt auf Achse 1.
        let cross = attach(&lk, "eg", (6.0, 4.0), TOL).unwrap();
        assert_eq!((cross.feature, cross.index, cross.index2), (DimFeature::AxisCross, Some(1), Some(3)));
        let on1 = attach(&lk, "eg", (0.0, 2.5), TOL).unwrap();
        assert_eq!((on1.feature, on1.index), (DimFeature::Axis, Some(0)));
        close(resolve(&lk, &on1).unwrap(), (0.0, 2.5));
        // Bemassung zwischen Achse 1 und Achse 2 (Kette bei y = 1): Länge 6; Achse 2 nach x = 7.5 → 7.5.
        let pts = [(0.0, 1.0), (6.0, 1.0)];
        let refs = vec![attach(&lk, "eg", (0.0, 1.0), TOL), attach(&lk, "eg", (6.0, 1.0), TOL)];
        assert!(refs.iter().all(|x| x.as_ref().is_some_and(|x| x.feature == DimFeature::Axis)));
        set(&mut r, "drawings2d", "G", "geom", json!({"shape": "grid", "origin": {"x": 0, "y": 0}, "angle": 0,
            "a": [{"label": "1", "pos": 0}, {"label": "2", "pos": 7.5}], "b": [{"label": "A", "pos": 0}, {"label": "B", "pos": 4}], "extend": 1}));
        let (np, lost) = resolve_chain(&Lookup::plain(&r), &pts, &refs);
        assert_eq!(lost, vec![false, false]);
        close(np[0], (0.0, 1.0));
        close(np[1], (7.5, 1.0));
        // Raster gelöscht → ungültig.
        r.insert("drawings2d".into(), json!([]));
        assert!(resolve(&Lookup::plain(&r), refs[1].as_ref().unwrap()).is_none());
    }

    fn arc_project() -> Map<String, Value> {
        root(json!({
            "wallTypes": [{"id": "T", "layers": [{"thickness": 0.1}, {"thickness": 0.2}]}],
            // Halbkreis: Mittelpunkt (5, 0), Achsradius 5, Scheitel (5, 5).
            "walls": [{"id": "A", "floorId": "eg", "wallTypeId": "T", "start": {"x": 0, "y": 0}, "end": {"x": 10, "y": 0}, "bulge": 1}],
            "drawings2d": [{"id": "K", "levelId": "eg", "geom": {"shape": "circle", "center": {"x": 30, "y": 0}, "r": 2}}]
        }))
    }

    /// [38] Bogenwand: Enden, Punkt auf Achse/Fläche (Anteil der Bogenlänge), Mittelpunkt, Rand-Bezug.
    #[test]
    fn bogenwand_bezuege() {
        let mut r = arc_project();
        let lk = Lookup::plain(&r);
        let apex = attach(&lk, "eg", (5.0, 5.0), TOL).unwrap();
        assert_eq!((apex.feature, apex.index), (DimFeature::Wall, None));
        assert!((apex.t.unwrap() - 0.5).abs() < 1e-9);
        let face = attach(&lk, "eg", (5.0, 5.15), TOL).unwrap();
        assert_eq!((face.feature, face.index), (DimFeature::Wall, Some(2)));
        let end = attach(&lk, "eg", (10.0, 0.0), TOL).unwrap();
        assert_eq!((end.feature, end.t), (DimFeature::Wall, Some(1.0)));
        let centre = attach(&lk, "eg", (5.0, 0.0), TOL).unwrap();
        assert_eq!(centre.feature, DimFeature::Center);
        close(resolve(&lk, &centre).unwrap(), (5.0, 0.0));
        close(resolve(&lk, &face).unwrap(), (5.0, 5.15));
        // Rand-Bezug (Winkel 90°) auf der Fläche 2: Radius 5.15; Mittelpunkt und Winkel bleiben beim Strecken.
        let rim_ref = DimRef { index: Some(2), t: Some(std::f64::consts::FRAC_PI_2), ..rf("A", DimFeature::Rim) };
        close(resolve(&lk, &rim_ref).unwrap(), (5.0, 5.15));
        // Wand verlängern (Ende x = 12 → Mittelpunkt (6, 0), Radius 6): Scheitel folgt.
        set(&mut r, "walls", "A", "end", json!({"x": 12, "y": 0}));
        let lk = Lookup::plain(&r);
        close(resolve(&lk, &apex).unwrap(), (6.0, 6.0));
        close(resolve(&lk, &centre).unwrap(), (6.0, 0.0));
    }

    /// [38] Radius-, Durchmesser- und Bogenlängen-Bemassung hängen an Kreis und Bogenwand.
    #[test]
    fn radius_und_bogenmass_assoziativ() {
        use crate::model::DimKind;
        let mut r = arc_project();
        let lk = Lookup::plain(&r);
        let (pts, refs) = round_dimension(&lk, "eg", DimKind::Radius, &[(30.0, 2.0)], 0.1).unwrap();
        close(pts[0], (30.0, 0.0));
        close(pts[1], (30.0, 2.0));
        assert_eq!(refs[0].as_ref().unwrap().feature, DimFeature::Center);
        // Kreis verschieben und vergrössern → Mittelpunkt und Randpunkt folgen (ohne Kettenprojektion).
        set(&mut r, "drawings2d", "K", "geom", json!({"shape": "circle", "center": {"x": 40, "y": 5}, "r": 3}));
        let (np, lost) = resolve_each(&Lookup::plain(&r), &pts, &refs);
        assert_eq!(lost, vec![false, false]);
        close(np[0], (40.0, 5.0));
        close(np[1], (40.0, 8.0));
        // Bogenlänge auf der Aussenfläche der Bogenwand (Radius 5.15): Viertelkreis von 90° bis 0°.
        let lk = Lookup::plain(&r);
        let (pts, refs) = round_dimension(&lk, "eg", DimKind::Arc, &[(5.0, 5.15), (5.15, 0.0)], 0.04).unwrap();
        assert_eq!(pts.len(), 3);
        close(pts[0], (5.0, 0.0));
        assert_eq!(refs[1].as_ref().unwrap().index, Some(2));
        // Nichts getroffen.
        assert!(round_dimension(&lk, "eg", DimKind::Radius, &[(100.0, 100.0)], 0.1).is_none());
    }

    /// [38] Treppe: Umriss-Ecken/-Kanten und Podest-Kanten der L-Treppe sind anhängbar.
    #[test]
    fn treppe_bezuege() {
        let stair = |shape: &str| json!({"id": "S", "type": "stair", "floorId": "eg", "categoryCode": "20", "shape": shape,
            "start": {"x": 0, "y": 0}, "dir": {"x": 1, "y": 0}, "runLength": 3, "run2Length": 2, "turn": 1, "width": 1, "stepCount": 16});
        let r = root(json!({"stairs": [stair("straight")]}));
        let lk = Lookup::plain(&r);
        let sh = find_shape(&lk, "S").unwrap();
        assert_eq!(sh.pts.len(), 4);
        // Eck 0 und Mitte der Kante 1 (Auftrittsende) hängen an und lösen auf.
        let v0 = sh.pts[0];
        let rv = attach(&lk, "eg", v0, TOL).unwrap();
        assert_eq!((rv.feature, rv.id.as_str(), rv.index), (DimFeature::Vertex, "S", Some(0)));
        let (a, b) = edge(&sh, 1).unwrap();
        let mid = lerp(a, b, 0.5);
        let re = attach(&lk, "eg", mid, TOL).unwrap();
        assert_eq!((re.feature, re.index), (DimFeature::Edge, Some(1)));
        close(resolve(&lk, &re).unwrap(), mid);
        // L-Treppe: zusätzlich Podest-Ecken und -Kanten (Indizes nach dem Umriss).
        let r = root(json!({"stairs": [stair("L")]}));
        let lk = Lookup::plain(&r);
        let sh = find_shape(&lk, "S").unwrap();
        assert_eq!(sh.pts.len(), 6);
        assert_eq!(sh.more.len(), 1);
        let n = sh.pts.len();
        let landing_corner = sh.vertex(n).unwrap();
        let rl = attach(&lk, "eg", landing_corner, TOL).unwrap();
        assert_eq!(rl.feature, DimFeature::Vertex);
        close(resolve(&lk, &rl).unwrap(), landing_corner);
        assert!(edge_count(&sh) > n);
    }

    #[test]
    fn befehl_bemassung_haengt_gefangene_punkte_an() {
        let r = project();
        let req = json!({"cmd": "dimension", "pts": [[0, -2], [2, -2], [5, -2]], "snaps": [[0, -0.15], [2, -0.15]], "offset": -0.5, "ctx": {"level": "eg"}, "stamp": "s"});
        let ops = crate::commands::ops(&r, &req.to_string()).unwrap();
        let Op::Add { items, .. } = &ops[0] else { panic!("{ops:?}") };
        let refs = &items[0]["geom"]["refs"];
        assert_eq!(refs[0]["feature"], json!("wall"));
        assert_eq!(refs[1]["feature"], json!("opening"));
        assert_eq!(refs[2], Value::Null);
        // Aussenbemassung: Ketten hängen an Ecken und Leibungen.
        let ops = crate::commands::ops(&r, &json!({"cmd": "autodim", "ctx": {"level": "eg"}, "stamp": "s"}).to_string()).unwrap();
        let n_refs: usize = ops
            .iter()
            .filter_map(|o| if let Op::Add { items, .. } = o { Some(items) } else { None })
            .flatten()
            .map(|d| d["geom"]["refs"].as_array().map_or(0, |a| a.iter().filter(|x| !x.is_null()).count()))
            .sum();
        assert!(n_refs >= 4, "{n_refs}");
    }
}
