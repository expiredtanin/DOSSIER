//! Assoziative Bemassung ([38]): Bemassungspunkte, die beim Zeichnen auf ein Merkmal eines Elements
//! gefangen wurden, tragen einen Bezug ([`DimRef`], `Dimension.refs`) und folgen dem Element.
//!
//! - **Anhängen** ([`attach`]): ein gefangener Punkt wird über Deckungsgleichheit (Toleranz [`TOL`])
//!   einem Merkmal zugeordnet — Öffnungs-Leibung/-Mitte, Wandende, Wandecke (Schnitt zweier
//!   Wandlinien), Punkt auf Wandachse/Schichtgrenze, Stütze (Mitte, Ecken, Kanten), Decken-/Dach-/
//!   Raum-Umriss (Ecken, Kanten), 2D-Zeichnung (Eckpunkte, Mittelpunkte, Kanten). Bogenwände
//!   werden nicht angehängt. Freie Klicks decken sich praktisch nie und bleiben frei.
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
    Some(WallGeo { a, b, offs, total, arc })
}

impl WallGeo {
    /// Linie `index` (fehlt = Achse): Anfang und Ende.
    fn line(&self, index: Option<u32>) -> Option<(P, P)> {
        let o = match index {
            None => 0.0,
            Some(k) => *self.offs.get(k as usize)?,
        };
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
        return Some(Shape { pts, closed: true, center: Some(at) });
    }
    Some(Shape { pts: Vec::new(), closed: false, center: Some(at) })
}

fn drawing_shape(d: &Value) -> Option<Shape> {
    let g = d.get("geom")?;
    let p = |k: &str| pt(g.get(k));
    Some(match str_of(g, "shape")? {
        "line" => Shape { pts: vec![p("a")?, p("b")?], closed: false, center: None },
        "polyline" => Shape { pts: pts_list(g.get("pts")), closed: g.get("closed").and_then(Value::as_bool).unwrap_or(false), center: None },
        "rect" => {
            let (lo, hi) = (p("min")?, p("max")?);
            Shape { pts: vec![lo, (hi.0, lo.1), hi, (lo.0, hi.1)], closed: true, center: None }
        }
        "circle" | "arc" | "ellipse" => Shape { pts: Vec::new(), closed: false, center: Some(p("center")?) },
        _ => return None,
    })
}

/// Listen, in denen Ecke/Kante/Mitte ihr Element suchen (in dieser Reihenfolge).
const SHAPE_LISTS: [&str; 5] = ["columns", "ceilings", "roofs", "rooms", "drawings2d"];

fn shape_of(coll: &str, e: &Value) -> Option<Shape> {
    match coll {
        "columns" => column_shape(e),
        "ceilings" | "roofs" => Some(Shape { pts: pts_list(e.get("outline")), closed: true, center: None }),
        "rooms" => Some(Shape { pts: pts_list(e.get("boundary")), closed: true, center: None }),
        "drawings2d" => drawing_shape(e),
        _ => None,
    }
}

fn find_shape(lk: &Lookup, id: &str) -> Option<Shape> {
    SHAPE_LISTS.iter().find_map(|c| lk.find(c, id).map(|e| (*c, e))).and_then(|(c, e)| shape_of(c, e))
}

fn edge(s: &Shape, i: usize) -> Option<(P, P)> {
    let n = s.pts.len();
    if i + 1 < n {
        Some((s.pts[i], s.pts[i + 1]))
    } else if s.closed && n > 2 && i + 1 == n {
        Some((s.pts[i], s.pts[0]))
    } else {
        None
    }
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
        DimFeature::Wall => {
            let (a, b) = wall_line(&r.id, r.index)?;
            lerp(a, b, r.t?)
        }
        DimFeature::Opening => opening_point(lk, lk.find("openings", &r.id)?, r.index?, r.index2)?,
        DimFeature::Vertex => *find_shape(lk, &r.id)?.pts.get(r.index? as usize)?,
        DimFeature::Edge => {
            let (a, b) = edge(&find_shape(lk, &r.id)?, r.index? as usize)?;
            lerp(a, b, r.t?)
        }
        DimFeature::Center => find_shape(lk, &r.id)?.center?,
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
        .filter(|(_, g)| !g.arc)
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
    // 3) Wandecken: auf den Linien zweier Wände (Verlängerung bis zur Wanddicke über das Ende).
    let mut hits: Vec<(&str, Option<u32>, P, P, f64)> = Vec::new();
    for (id, g) in &walls {
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
    // 5) Stützen, Decken, Dächer, Räume, 2D-Zeichnungen: Mitte, Ecken, Kanten.
    for coll in SHAPE_LISTS {
        let key = if coll == "drawings2d" { "levelId" } else { "floorId" };
        for e in list(lk, coll).iter().filter(|e| on_level(e, key, level)) {
            let (Some(id), Some(sh)) = (str_of(e, "id"), shape_of(coll, e)) else { continue };
            if sh.center.is_some_and(|c| dist(c, s) <= tol) {
                return Some(rf(id, DimFeature::Center));
            }
            if let Some(i) = sh.pts.iter().position(|p| dist(*p, s) <= tol) {
                return Some(DimRef { index: Some(i as u32), ..rf(id, DimFeature::Vertex) });
            }
            for i in 0..sh.pts.len() {
                let Some((a, b)) = edge(&sh, i) else { continue };
                if let Some((t, d)) = param(a, b, s) {
                    if d <= tol && (0.0..=1.0).contains(&t) {
                        return Some(DimRef { index: Some(i as u32), t: Some(t), ..rf(id, DimFeature::Edge) });
                    }
                }
            }
        }
    }
    None
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
        let (np, lost) = resolve_chain(lk, &pts, &refs);
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
