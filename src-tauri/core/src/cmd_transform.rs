//! Transformation der Auswahl ([K4] S3, vorher `tools/transform.ts` und `geometry/geomTransform.ts`):
//! Verschieben/Drehen/Spiegeln/Skalieren mit den Vervielfältigungs-Modi (Original bewegen, Kopie,
//! Reihe, Verteilen) als Ops, die Live-Vorschau dazu, Ausrichten/Verteilen der 2D-Auswahl und
//! „Block definieren“.
//!
//! Die Abbildung reist als Beschreibung einer affinen Abbildung ([`Xf`]: Verschiebung, Drehung um
//! einen Punkt, Skalierung um einen Punkt, Spiegelung an einer Achse) statt als JS-Funktion. Bewusst
//! keine allgemeine 2×3-Matrix: je Art ist die Rechenreihenfolge die der früheren TS-Funktion
//! (`transformFn`), damit die Koordinaten bitgleich bleiben (`c.x + dx·cos − dy·sin` ist nicht
//! dasselbe wie `a·x + b·y + e`).
//!
//! Rechnung auf der rohen Projekt-Wurzel (verlustfrei, Schlüsselreihenfolge wie das Objekt-Spreizen in
//! TS); Zahlen wie in JS (`jsnum`, `jsmath`), nicht endliche Ergebnisse als Marken (`grips::js_num`).

use crate::grips::{arr, field, js_num, num_of, num_or, pt, truthy, with, with_all, with_opt, xy, N};
use crate::jsmath::hypot2;
use crate::jsnum;
use crate::ops::{id_of, Op};
use serde::Deserialize;
use serde_json::{Map, Value};

// ── Abbildung ────────────────────────────────────────────────────────────────

/// Affine Abbildung der Ebene (s. Modul-Doku).
#[derive(Clone, Copy, Debug)]
pub enum Xf {
    Move { vx: f64, vy: f64 },
    Rotate { cx: f64, cy: f64, cos: f64, sin: f64 },
    Scale { cx: f64, cy: f64, f: f64 },
    Mirror { ax: f64, ay: f64, dx: f64, dy: f64, len2: f64 },
}

/// Punkt `i` der Klickpunkte (fehlend = NaN).
fn p_at(pts: &[(f64, f64)], i: usize) -> (f64, f64) {
    pts.get(i).copied().unwrap_or((f64::NAN, f64::NAN))
}

/// `a || 1` für Zahlen (0 und NaN → 1).
fn or1(v: f64) -> f64 {
    if v == 0.0 || v.is_nan() {
        1.0
    } else {
        v
    }
}

/// Skalierungsfaktor eines `scale`-Punkte-Tripels (Basis, Referenz, Ziel) beim Anteil `t`.
pub fn scale_factor(pts: &[(f64, f64)], t: f64) -> f64 {
    let (c, a, b) = (p_at(pts, 0), p_at(pts, 1), p_at(pts, 2));
    let r = or1(hypot2(a.0 - c.0, a.1 - c.1));
    let tgt = hypot2(b.0 - c.0, b.1 - c.1);
    1.0 + (tgt / r - 1.0) * t
}

impl Xf {
    /// Abbildung der Operation `op` beim Anteil `t` (`transformFn`): move = Verschiebung um t·(p1 − p0),
    /// rotate = Drehung um p0 um t·(Winkel p2 − Winkel p1), scale = um p0 mit dem interpolierten Faktor,
    /// sonst Spiegelung an der Achse p0→p1 (t ohne Wirkung).
    pub fn of(op: &str, pts: &[(f64, f64)], t: f64) -> Xf {
        let (p0, p1) = (p_at(pts, 0), p_at(pts, 1));
        match op {
            "move" => Xf::Move { vx: (p1.0 - p0.0) * t, vy: (p1.1 - p0.1) * t },
            "rotate" => {
                let p2 = p_at(pts, 2);
                let a0 = jsnum::atan2(p1.1 - p0.1, p1.0 - p0.0);
                let a1 = jsnum::atan2(p2.1 - p0.1, p2.0 - p0.0);
                let ang = (a1 - a0) * t;
                Xf::Rotate { cx: p0.0, cy: p0.1, cos: jsnum::cos(ang), sin: jsnum::sin(ang) }
            }
            "scale" => Xf::Scale { cx: p0.0, cy: p0.1, f: scale_factor(pts, t) },
            _ => {
                let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
                Xf::Mirror { ax: p0.0, ay: p0.1, dx, dy, len2: or1(dx * dx + dy * dy) }
            }
        }
    }

    /// Verschiebung um `(dx, dy)` (wie `p => ({x: p.x + dx, y: p.y + dy})`).
    pub fn translate(dx: f64, dy: f64) -> Xf {
        Xf::Move { vx: dx, vy: dy }
    }

    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        match *self {
            Xf::Move { vx, vy } => (x + vx, y + vy),
            Xf::Rotate { cx, cy, cos, sin } => {
                let (dx, dy) = (x - cx, y - cy);
                (cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)
            }
            Xf::Scale { cx, cy, f } => (cx + (x - cx) * f, cy + (y - cy) * f),
            Xf::Mirror { ax, ay, dx, dy, len2 } => {
                let tt = ((x - ax) * dx + (y - ay) * dy) / len2;
                let (fx, fy) = (ax + dx * tt, ay + dy * tt);
                (2.0 * fx - x, 2.0 * fy - y)
            }
        }
    }

    /// Kehrt die Abbildung den Umlaufsinn um (Spiegelung)? Über das Flächenvorzeichen eines
    /// Test-Dreiecks (`reversesOrientation`).
    pub fn reverses(&self) -> bool {
        let (p0, p1, p2) = (self.apply(0.0, 0.0), self.apply(1.0, 0.0), self.apply(0.0, 1.0));
        (p1.0 - p0.0) * (p2.1 - p0.1) - (p2.0 - p0.0) * (p1.1 - p0.1) < 0.0
    }

    /// Punkt-Wert abbilden (neues `{x, y}`).
    fn pt(&self, v: &Value) -> Value {
        let (x, y) = xy(v);
        let (a, b) = self.apply(x, y);
        pt(a, b)
    }

    fn pt_of(&self, v: Option<&Value>) -> Value {
        self.pt(v.unwrap_or(&Value::Null))
    }

    fn pts(&self, v: Option<&Value>) -> Value {
        Value::Array(arr(v).iter().map(|q| self.pt(q)).collect())
    }
}

// ── Zeichengeometrie ─────────────────────────────────────────────────────────

fn shape(g: &Value) -> &str {
    field(g, "shape").and_then(Value::as_str).unwrap_or("")
}

/// `mvGeom`: jeden Punkt einer 2D-Zeichengeometrie unter `xf` abbilden. `None` bei unbekannter Form
/// (TS lieferte dort `undefined`, das Feld fiel weg).
pub fn mv_geom(g: &Value, xf: &Xf) -> Option<Value> {
    let p = |k: &str| xf.pt_of(field(g, k));
    let ps = |k: &str| xf.pts(field(g, k));
    Some(match shape(g) {
        "line" | "xline" | "ray" => with_all(g, vec![("a", p("a")), ("b", p("b"))]),
        "polyline" => {
            let pts = ps("pts");
            if !truthy(field(g, "bulge")) {
                return Some(with(g, "pts", pts));
            }
            // Das Bogen-Vorzeichen hängt an der Zeichenrichtung: eine Spiegelung kehrt jeden Bogen um.
            let bulge = if xf.reverses() {
                Value::Array(arr(field(g, "bulge")).iter().map(|b| js_num(-num_of(Some(b)))).collect())
            } else {
                g["bulge"].clone()
            };
            with_all(g, vec![("pts", pts), ("bulge", bulge)])
        }
        "rect" => {
            // Achsparallel nur bei reiner Verschiebung erhaltbar; sonst eine geschlossene Polylinie.
            let (min, max) = (xy(field(g, "min").unwrap_or(&Value::Null)), xy(field(g, "max").unwrap_or(&Value::Null)));
            let c = [min, (max.0, min.1), max, (min.0, max.1)].map(|q| xf.apply(q.0, q.1));
            let aligned = (c[0].1 - c[1].1).abs() < 1e-6 && (c[1].0 - c[2].0).abs() < 1e-6 && (c[2].1 - c[3].1).abs() < 1e-6;
            let mut m = Map::new();
            if aligned {
                let fold = |k: fn(f64, f64) -> f64, s: fn(&(f64, f64)) -> f64| c.iter().map(s).reduce(k).unwrap_or(f64::NAN);
                m.insert("shape".into(), "rect".into());
                m.insert("min".into(), pt(fold(jsnum::min, |q| q.0), fold(jsnum::min, |q| q.1)));
                m.insert("max".into(), pt(fold(jsnum::max, |q| q.0), fold(jsnum::max, |q| q.1)));
            } else {
                m.insert("shape".into(), "polyline".into());
                m.insert("pts".into(), Value::Array(c.iter().map(|q| pt(q.0, q.1)).collect()));
                m.insert("closed".into(), Value::Bool(true));
            }
            Value::Object(m)
        }
        "circle" | "arc" | "ellipse" => with(g, "center", p("center")),
        "bezier" | "spline" | "dimension" => with(g, "pts", ps("pts")),
        "kote" | "detailref" | "scalebar" | "pointmarker" => with(g, "at", p("at")),
        "text" => {
            // Hinweis-Ziel, Knicke und Pfadpunkte wandern mit.
            let mut f = vec![("at", Some(p("at")))];
            for k in ["leaderTarget", "leaderBendPoints", "pathPts"] {
                if truthy(field(g, k)) {
                    f.push((k, Some(if k == "leaderTarget" { p(k) } else { ps(k) })));
                }
            }
            with_opt(g, f)
        }
        "block" => {
            // Winkel aus einem mit abgebildeten Richtungspunkt: Drehen/Spiegeln nehmen die Ausrichtung mit.
            let (ax, ay) = xy(field(g, "at").unwrap_or(&Value::Null));
            let rot = num_of(field(g, "rotation"));
            let nb = xf.apply(ax, ay);
            let nt = xf.apply(ax + jsnum::cos(rot), ay + jsnum::sin(rot));
            with_all(g, vec![("at", pt(nb.0, nb.1)), ("rotation", js_num(jsnum::atan2(nt.1 - nb.1, nt.0 - nb.0)))])
        }
        "image" => {
            // Nur die Lage folgt (die Box bleibt achsparallel und unverzerrt).
            let (min, max) = (xy(field(g, "min").unwrap_or(&Value::Null)), xy(field(g, "max").unwrap_or(&Value::Null)));
            let old = ((min.0 + max.0) / 2.0, (min.1 + max.1) / 2.0);
            let new = xf.apply(old.0, old.1);
            let (dx, dy) = (new.0 - old.0, new.1 - old.1);
            with_all(g, vec![("min", pt(min.0 + dx, min.1 + dy)), ("max", pt(max.0 + dx, max.1 + dy))])
        }
        _ => return None,
    })
}

/// `scaleGeom`: wie [`mv_geom`], dazu die Grössenfelder (Radien, Schrift, Masslinien-Abstand,
/// Massstabsbalken, Block-Faktor) um `k`. Papier-mm-Felder und `bulge` bleiben.
pub fn scale_geom(g: &Value, xf: &Xf, k: f64) -> Option<Value> {
    let g = mv_geom(g, xf)?;
    let times = |key: &str| js_num(num_of(field(&g, key)) * k);
    Some(match shape(&g) {
        "circle" | "arc" => with(&g, "r", times("r")),
        "ellipse" => with_all(&g, vec![("rx", times("rx")), ("ry", times("ry"))]),
        "dimension" => with(&g, "offset", times("offset")),
        "text" => {
            let mut f = vec![("height", times("height"))];
            if field(&g, "width").is_some() {
                f.push(("width", times("width")));
            }
            with_all(&g, f)
        }
        "scalebar" => with(&g, "segmentLength", times("segmentLength")),
        "block" => with(&g, "scale", js_num(num_or(field(&g, "scale"), 1.0) * k)),
        _ => g,
    })
}

/// `{...d, geom}`; eine unbekannte Form lässt `geom` wegfallen (wie `geom: undefined` in TS).
fn with_geom(d: &Value, g: Option<Value>) -> Value {
    with_opt(d, vec![("geom", g)])
}

// ── Bauteile ─────────────────────────────────────────────────────────────────

fn mv_wall(w: &Value, xf: &Xf) -> Value {
    // Bogenwand ([T2]): eine Spiegelung kehrt den Bogen um (Bulge-Vorzeichen hängt an der Laufrichtung).
    match field(w, "bulge").and_then(Value::as_f64) {
        Some(b) if xf.reverses() => with_all(w, vec![("start", xf.pt_of(field(w, "start"))), ("end", xf.pt_of(field(w, "end"))), ("bulge", js_num(-b))]),
        _ => with_all(w, vec![("start", xf.pt_of(field(w, "start"))), ("end", xf.pt_of(field(w, "end")))]),
    }
}

/// Stütze: Einfügepunkt und Profil-Drehung (über einen mit abgebildeten Richtungspunkt).
fn mv_column(c: &Value, xf: &Xf) -> Value {
    let (bx, by) = xy(field(c, "position").unwrap_or(&Value::Null));
    let rot = num_or(field(c, "rotation"), 0.0);
    let nb = xf.apply(bx, by);
    let nt = xf.apply(bx + jsnum::cos(rot), by + jsnum::sin(rot));
    with_all(c, vec![("position", pt(nb.0, nb.1)), ("rotation", js_num(jsnum::atan2(nt.1 - nb.1, nt.0 - nb.0)))])
}

fn mv_ceiling(c: &Value, xf: &Xf) -> Value {
    let mut f = vec![("outline", xf.pts(field(c, "outline")))];
    if truthy(field(c, "openings")) {
        f.push(("openings", Value::Array(arr(field(c, "openings")).iter().map(|h| xf.pts(Some(h))).collect())));
    }
    with_all(c, f)
}

fn mv_roof(r: &Value, xf: &Xf) -> Value {
    with(r, "outline", xf.pts(field(r, "outline")))
}

fn mv_room(r: &Value, xf: &Xf) -> Value {
    let mut f = vec![("boundary", xf.pts(field(r, "boundary")))];
    if truthy(field(r, "stampAnchor")) {
        f.push(("stampAnchor", xf.pt_of(field(r, "stampAnchor"))));
    }
    with_all(r, f)
}

/// Treppe (Skalierungsfaktor `k`): Antritt und Wendel-Zentrum wandern mit, die Laufrichtung über einen
/// mit abgebildeten Richtungspunkt; `turn`/`sweep` kippen unter einer Spiegelung; Längen mal `k`.
fn mv_stair(s: &Value, xf: &Xf, k: f64) -> Value {
    let (sx, sy) = xy(field(s, "start").unwrap_or(&Value::Null));
    let (dx0, dy0) = xy(field(s, "dir").unwrap_or(&Value::Null));
    let start = xf.apply(sx, sy);
    let tip = xf.apply(sx + dx0, sy + dy0);
    let (dx, dy) = (tip.0 - start.0, tip.1 - start.1);
    let len = or1(hypot2(dx, dy));
    let flips = xf.reverses();
    let times = |key: &str| js_num(num_of(field(s, key)) * k);
    let flip = |key: &str| if flips { js_num(-num_of(field(s, key))) } else { s[key].clone() };
    let mut f = vec![
        ("start", Some(pt(start.0, start.1))),
        ("dir", Some(pt(dx / len, dy / len))),
        ("runLength", Some(times("runLength"))),
        ("width", Some(times("width"))),
    ];
    if field(s, "run2Length").is_some() {
        f.push(("run2Length", Some(times("run2Length"))));
    }
    if field(s, "turn").is_some() {
        f.push(("turn", Some(flip("turn"))));
    }
    if truthy(field(s, "center")) {
        f.push(("center", Some(xf.pt_of(field(s, "center")))));
    }
    if field(s, "radius").is_some() {
        f.push(("radius", Some(times("radius"))));
    }
    if field(s, "sweep").is_some() {
        f.push(("sweep", Some(flip("sweep"))));
    }
    with_opt(s, f)
}

/// Extrudierter Körper (`transformSolid`): Umriss und Kreis-Profil (Radius mal `k`); ein B-Rep-Körper
/// bekommt seine Spezifikation als `transform` um die bisherige Verschiebung gewickelt (Z bleibt), der
/// Ursprung wandert auf den neuen ersten Umrisspunkt.
fn mv_solid(s: &Value, xf: &Xf, k: f64) -> Value {
    let points = xf.pts(field(s, "points"));
    let circle = field(s, "circle").filter(|c| truthy(Some(c))).map(|c| {
        with_all(c, vec![("center", xf.pt_of(field(c, "center"))), ("r", js_num(num_of(field(c, "r")) * k))])
    });
    let first = points.get(0).cloned();
    let base = with_opt(s, vec![("points", Some(points)), ("circle", circle)]);
    let Some(brep) = field(s, "brep").filter(|b| truthy(Some(b))) else { return base };
    let o = xf.apply(0.0, 0.0);
    let ex = xf.apply(1.0, 0.0);
    let ey = xf.apply(0.0, 1.0);
    let (ox, oy) = xy(field(brep, "origin").unwrap_or(&Value::Null));
    let d = match arr(field(s, "points")).first().filter(|p0| truthy(Some(p0))) {
        Some(p0) => {
            let (x, y) = xy(p0);
            [x - ox, y - oy, 0.0]
        }
        None => [0.0, 0.0, 0.0],
    };
    let mut inner = Map::new();
    inner.insert("kind".into(), "translate".into());
    inner.insert("v".into(), Value::Array(d.iter().map(|x| js_num(*x)).collect()));
    if let Some(spec) = field(brep, "spec") {
        inner.insert("solid".into(), spec.clone());
    }
    let m = [ex.0 - o.0, ey.0 - o.0, 0.0, o.0, ex.1 - o.1, ey.1 - o.1, 0.0, o.1, 0.0, 0.0, k, 0.0];
    let mut spec = Map::new();
    spec.insert("kind".into(), "transform".into());
    spec.insert("m".into(), Value::Array(m.iter().map(|x| js_num(*x)).collect()));
    spec.insert("solid".into(), Value::Object(inner));
    let origin = first.or_else(|| field(brep, "origin").cloned());
    let brep = with_opt(brep, vec![("spec", Some(Value::Object(spec))), ("origin", origin)]);
    with_all(&base, vec![("height", js_num(num_of(field(s, "height")) * k)), ("brep", brep)])
}

// ── Auswahl ──────────────────────────────────────────────────────────────────

/// Auswahl einer Transformation (`TransformSelection` in TS).
#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Sel {
    pub wall_ids: Vec<String>,
    pub drawing_id: Option<String>,
    pub drawing_ids: Option<Vec<String>>,
    pub extruded_solid_id: Option<String>,
    pub column_id: Option<String>,
    pub ceiling_ids: Option<Vec<String>>,
    pub roof_ids: Option<Vec<String>>,
    pub stair_ids: Option<Vec<String>>,
    pub room_ids: Option<Vec<String>>,
}

fn nonempty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

impl Sel {
    /// `drawingIds` ∪ `drawingId`.
    fn drawings(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self.drawing_ids.iter().flatten().map(String::as_str).collect();
        if let Some(d) = nonempty(&self.drawing_id) {
            v.push(d);
        }
        v
    }
}

/// id-Menge der Auswahl (schneller Hash, s. `commands::Fnv`).
struct Ids<'a>(crate::commands::FastSet<&'a str>);

impl<'a> Ids<'a> {
    fn of<I: IntoIterator<Item = &'a str>>(it: I) -> Self {
        Ids(it.into_iter().collect())
    }
    fn opt(v: &'a Option<Vec<String>>) -> Self {
        Ids::of(v.iter().flatten().map(String::as_str))
    }
    fn has(&self, v: &Value) -> bool {
        !self.0.is_empty() && id_of(v).is_some_and(|id| self.0.contains(id))
    }
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

fn locked(v: &Value) -> bool {
    truthy(field(v, "locked"))
}

fn list<'a>(root: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    arr(root.get(key))
}

/// Ein gewähltes Element mit seiner Liste.
#[derive(Clone, Copy)]
enum Kind {
    Wall,
    Drawing,
    Solid,
    Column,
    Ceiling,
    Roof,
    Stair,
    Room,
}

/// Dächer nur bei Verschieben/Skalieren (der Umriss ist an die Weltachsen gebunden, der First folgt
/// `ridgeAxis`; Drehen/Spiegeln würden diese Invariante brechen).
fn roof_allowed(op: &str) -> bool {
    op != "rotate" && op != "mirror"
}

/// `gatherItems`: gewählte, nicht gesperrte Elemente in Listen-Reihenfolge (Körper und Stütze: das
/// erste mit der id).
fn gather<'a>(root: &'a Map<String, Value>, sel: &Sel, op: &str, ignore_lock: bool) -> Vec<(Kind, &'a Value)> {
    let free = |v: &Value| ignore_lock || !locked(v);
    let mut out = Vec::new();
    let walls = Ids::of(sel.wall_ids.iter().map(String::as_str));
    out.extend(list(root, "walls").iter().filter(|w| walls.has(w) && free(w)).map(|w| (Kind::Wall, w)));
    let draw = Ids::of(sel.drawings());
    out.extend(list(root, "drawings2d").iter().filter(|d| draw.has(d) && free(d)).map(|d| (Kind::Drawing, d)));
    if let Some(id) = nonempty(&sel.extruded_solid_id) {
        if let Some(s) = list(root, "extrudedSolids").iter().find(|s| id_of(s) == Some(id)) {
            out.push((Kind::Solid, s));
        }
    }
    if let Some(id) = nonempty(&sel.column_id) {
        if let Some(c) = list(root, "columns").iter().find(|c| id_of(c) == Some(id)).filter(|c| free(c)) {
            out.push((Kind::Column, c));
        }
    }
    let mut each = |key: &str, set: Ids, kind: Kind| out.extend(list(root, key).iter().filter(|e| set.has(e) && free(e)).map(|e| (kind, e)));
    each("ceilings", Ids::opt(&sel.ceiling_ids), Kind::Ceiling);
    if roof_allowed(op) {
        each("roofs", Ids::opt(&sel.roof_ids), Kind::Roof);
    }
    each("stairs", Ids::opt(&sel.stair_ids), Kind::Stair);
    each("rooms", Ids::opt(&sel.room_ids), Kind::Room);
    out
}

/// `copyTs`: die Anteile t der Kopien (ohne Original) je Modus. Spiegeln ergibt immer genau eine Kopie.
pub fn copy_ts(op: &str, mode: &str, count: f64) -> Vec<f64> {
    if mode == "move" {
        return vec![];
    }
    if op == "mirror" || mode == "copy" {
        return vec![1.0];
    }
    let n = jsnum::max(1.0, count.floor());
    // `Array.from({length: n})` (NaN → 0); begrenzt, damit Unsinn nicht endlos läuft.
    let n = if n.is_nan() { 0 } else { n.min(100_000.0) as usize };
    if mode == "array" {
        (0..n).map(|k| (k + 1) as f64).collect()
    } else {
        (0..n).map(|k| (k + 1) as f64 / n as f64).collect()
    }
}

// ── Ops ──────────────────────────────────────────────────────────────────────

/// Neue ids `prefix-stamp-k` (der Stempel kommt aus der Hülle, `uniqueStamp`: Zeit + Zähler).
pub struct IdGen<'a> {
    stamp: &'a str,
    k: u32,
}

impl<'a> IdGen<'a> {
    pub fn new(stamp: &'a str) -> Self {
        IdGen { stamp, k: 0 }
    }
    pub fn next(&mut self, prefix: &str) -> String {
        self.k += 1;
        format!("{prefix}-{}-{}", self.stamp, self.k)
    }
}

/// Anfrage einer Transformation (s. `transformOps` in `tools/transform.ts`).
#[derive(Deserialize, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct TransformReq {
    pub sel: Sel,
    pub op: String,
    pub pts: Vec<[N; 2]>,
    pub mode: String,
    pub count: N,
    pub stamp: String,
    /// Vorschau: Sperre nicht beachten (Griff-Vorschau eines einzelnen Elements).
    pub ignore_lock: bool,
    /// Vorschau: Massstab der Zeichnungs-Primitive und Grundlinie→Oberkante der Schrift (Hülle).
    pub scale: N,
    pub top: N,
}

impl TransformReq {
    fn points(&self) -> Vec<(f64, f64)> {
        self.pts.iter().map(|[x, y]| (x.0, y.0)).collect()
    }
}

fn replace(collection: &str, entity: Value) -> Op {
    Op::Replace { collection: collection.into(), entity }
}

fn add(collection: &str, items: Vec<Value>) -> Option<Op> {
    (!items.is_empty()).then(|| Op::Add { collection: collection.into(), items, at: None })
}

/// Die Transformation als Ops: `replace` je bewegtem Original (Modus „move“), dann `add` der Kopien je
/// Liste (Wände, 2D, Körper, Stützen, Decken, Dächer, Treppen, Räume).
pub fn transform_ops(root: &Map<String, Value>, req: &TransformReq) -> Vec<Op> {
    let (sel, op) = (&req.sel, req.op.as_str());
    let items = gather(root, sel, op, false);
    if items.is_empty() {
        return vec![];
    }
    let pts = req.points();
    let scaling = op == "scale";
    let k_at = |t: f64| if scaling { scale_factor(&pts, t) } else { 1.0 };
    let geom_at = |g: &Value, xf: &Xf, t: f64| if scaling { scale_geom(g, xf, scale_factor(&pts, t)) } else { mv_geom(g, xf) };
    let mut ops = Vec::new();

    if req.mode == "move" {
        let xf = Xf::of(op, &pts, 1.0);
        let mut patch = |key: &str, hit: &dyn Fn(&Value) -> bool, f: &dyn Fn(&Value) -> Value| {
            ops.extend(list(root, key).iter().filter(|e| hit(e)).map(|e| replace(key, f(e))));
        };
        let walls = Ids::of(sel.wall_ids.iter().map(String::as_str));
        patch("walls", &|w| walls.has(w) && !locked(w), &|w| mv_wall(w, &xf));
        let draw = Ids::of(sel.drawings());
        if !draw.is_empty() {
            patch("drawings2d", &|d| draw.has(d) && !locked(d), &|d| with_geom(d, geom_at(field(d, "geom").unwrap_or(&Value::Null), &xf, 1.0)));
        }
        if let Some(id) = nonempty(&sel.extruded_solid_id) {
            patch("extrudedSolids", &|s| id_of(s) == Some(id), &|s| mv_solid(s, &xf, k_at(1.0)));
        }
        if let Some(id) = nonempty(&sel.column_id) {
            patch("columns", &|c| id_of(c) == Some(id) && !locked(c), &|c| mv_column(c, &xf));
        }
        let (ceil, roofs, stairs, rooms) = (Ids::opt(&sel.ceiling_ids), Ids::opt(&sel.roof_ids), Ids::opt(&sel.stair_ids), Ids::opt(&sel.room_ids));
        if !ceil.is_empty() {
            patch("ceilings", &|c| ceil.has(c) && !locked(c), &|c| mv_ceiling(c, &xf));
        }
        if !roofs.is_empty() && roof_allowed(op) {
            patch("roofs", &|r| roofs.has(r) && !locked(r), &|r| mv_roof(r, &xf));
        }
        if !stairs.is_empty() {
            patch("stairs", &|s| stairs.has(s) && !locked(s), &|s| mv_stair(s, &xf, k_at(1.0)));
        }
        if !rooms.is_empty() {
            patch("rooms", &|r| rooms.has(r) && !locked(r), &|r| mv_room(r, &xf));
        }
    }

    // Kopien (Kopie/Reihe/Verteilen bzw. gespiegelte Kopie).
    let mut ids = IdGen::new(&req.stamp);
    let mut new: [Vec<Value>; 8] = Default::default();
    for t in copy_ts(op, &req.mode, req.count.0) {
        let xf = Xf::of(op, &pts, t);
        for (kind, e) in &items {
            let (slot, prefix, v) = match kind {
                Kind::Wall => (0, "W", mv_wall(e, &xf)),
                Kind::Drawing => (1, "dr2d", with_geom(e, geom_at(field(e, "geom").unwrap_or(&Value::Null), &xf, t))),
                Kind::Solid => (2, "extrude", mv_solid(e, &xf, k_at(t))),
                Kind::Column => (3, "column", mv_column(e, &xf)),
                Kind::Ceiling => (4, "C", mv_ceiling(e, &xf)),
                Kind::Roof => (5, "RF", mv_roof(e, &xf)),
                Kind::Stair => (6, "ST", mv_stair(e, &xf, k_at(t))),
                Kind::Room => (7, "RM", mv_room(e, &xf)),
            };
            new[slot].push(with(&v, "id", Value::String(ids.next(prefix))));
        }
    }
    let keys = ["walls", "drawings2d", "extrudedSolids", "columns", "ceilings", "roofs", "stairs", "rooms"];
    for (key, items) in keys.iter().zip(new) {
        ops.extend(add(key, items));
    }
    ops
}

// ── Ausrichten/Verteilen, Block definieren ───────────────────────────────────

/// Verschiebt die Zeichnungen um je einen eigenen Vektor (in Listen-Reihenfolge; Vektor 0 = keine Op).
fn move_drawings(root: &Map<String, Value>, deltas: &std::collections::HashMap<String, (f64, f64)>) -> Vec<Op> {
    if deltas.is_empty() {
        return vec![];
    }
    let mut ops = Vec::new();
    for d in list(root, "drawings2d") {
        let Some(&(dx, dy)) = id_of(d).and_then(|id| deltas.get(id)) else { continue };
        if dx == 0.0 && dy == 0.0 {
            continue;
        }
        ops.push(replace("drawings2d", with_geom(d, mv_geom(field(d, "geom").unwrap_or(&Value::Null), &Xf::translate(dx, dy)))));
    }
    ops
}

/// Rahmen der gewählten Zeichnungen in Listen-Reihenfolge: (id, [minX, minY, maxX, maxY]) über
/// `selection_info::geom_bbox` (wie die Objekt-Info).
fn boxes(root: &Map<String, Value>, ids: &[String]) -> Vec<(String, [f64; 4])> {
    let wanted: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    list(root, "drawings2d")
        .iter()
        .filter_map(|d| id_of(d).filter(|i| wanted.contains(i)).map(|i| (i.to_string(), crate::selection_info::geom_bbox(field(d, "geom").unwrap_or(&Value::Null)))))
        .collect()
}

/// Ausrichten an der gemeinsamen Kante/Mitte der Hülle aller gewählten Zeichnungen (ab zwei).
pub fn align_ops(root: &Map<String, Value>, ids: &[String], mode: &str) -> Vec<Op> {
    let bx = boxes(root, ids);
    if bx.len() < 2 {
        return vec![];
    }
    let fold = |k: fn(f64, f64) -> f64, i: usize, init: f64| bx.iter().fold(init, |m, b| k(m, b.1[i]));
    let (min_x, max_x) = (fold(jsnum::min, 0, f64::INFINITY), fold(jsnum::max, 2, f64::NEG_INFINITY));
    let (min_y, max_y) = (fold(jsnum::min, 1, f64::INFINITY), fold(jsnum::max, 3, f64::NEG_INFINITY));
    let (cx, cy) = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
    let mut deltas = std::collections::HashMap::new();
    for (id, b) in &bx {
        let [x0, y0, x1, y1] = *b;
        let d = match mode {
            "left" => (min_x - x0, 0.0),
            "right" => (max_x - x1, 0.0),
            "centerX" => (cx - (x0 + x1) / 2.0, 0.0),
            "top" => (0.0, max_y - y1),
            "bottom" => (0.0, min_y - y0),
            "centerY" => (0.0, cy - (y0 + y1) / 2.0),
            _ => (0.0, 0.0),
        };
        deltas.insert(id.clone(), d);
    }
    move_drawings(root, &deltas)
}

/// Verteilen mit gleichen Mittenabständen entlang `axis` (ab drei; die äussersten bleiben stehen).
pub fn distribute_ops(root: &Map<String, Value>, ids: &[String], axis: &str) -> Vec<Op> {
    let bx = boxes(root, ids);
    if bx.len() < 3 {
        return vec![];
    }
    let center = |b: &[f64; 4]| if axis == "x" { (b[0] + b[2]) / 2.0 } else { (b[1] + b[3]) / 2.0 };
    let mut sorted: Vec<&(String, [f64; 4])> = bx.iter().collect();
    // Wie `Array.prototype.sort` mit `a − b` (stabil; NaN gilt als gleich).
    sorted.sort_by(|a, b| {
        let d = center(&a.1) - center(&b.1);
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else if d > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let first = center(&sorted[0].1);
    let last = center(&sorted[sorted.len() - 1].1);
    let step = (last - first) / (sorted.len() - 1) as f64;
    let mut deltas = std::collections::HashMap::new();
    for (i, b) in sorted.iter().enumerate() {
        if i == 0 || i == sorted.len() - 1 {
            continue;
        }
        let shift = first + step * i as f64 - center(&b.1);
        deltas.insert(b.0.clone(), if axis == "x" { (shift, 0.0) } else { (0.0, shift) });
    }
    move_drawings(root, &deltas)
}

/// Anfrage „Block definieren“.
#[derive(Deserialize, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct DefBlockReq {
    pub ids: Vec<String>,
    pub at: [N; 2],
    pub level_id: String,
    pub category_code: String,
    pub stamp: String,
}

/// Macht aus den gewählten Zeichnungen (ohne Block-Instanzen) eine Block-Definition mit Ursprung `at`
/// und ersetzt sie durch eine Instanz an `at`.
pub fn defblock_ops(root: &Map<String, Value>, r: &DefBlockReq) -> Vec<Op> {
    let wanted: std::collections::HashSet<&str> = r.ids.iter().map(String::as_str).collect();
    let srcs: Vec<&Value> = list(root, "drawings2d")
        .iter()
        .filter(|d| id_of(d).is_some_and(|i| wanted.contains(i)) && shape(field(d, "geom").unwrap_or(&Value::Null)) != "block")
        .collect();
    if srcs.is_empty() {
        return vec![];
    }
    let (ax, ay) = (r.at[0].0, r.at[1].0);
    let to_local = Xf::translate(-ax, -ay);
    let mut ids = IdGen::new(&r.stamp);
    let def_id = ids.next("blk");
    let mut def = Map::new();
    def.insert("id".into(), def_id.clone().into());
    def.insert("name".into(), format!("Block {}", list(root, "blockDefs").len() + 1).into());
    def.insert("geom2d".into(), Value::Array(srcs.iter().map(|d| mv_geom(field(d, "geom").unwrap_or(&Value::Null), &to_local).unwrap_or(Value::Null)).collect()));
    let mut geom = Map::new();
    geom.insert("shape".into(), "block".into());
    geom.insert("blockDefId".into(), def_id.into());
    geom.insert("at".into(), pt(ax, ay));
    geom.insert("rotation".into(), 0.into());
    let mut inst = Map::new();
    inst.insert("id".into(), ids.next("dr2d").into());
    inst.insert("type".into(), "drawing2d".into());
    inst.insert("levelId".into(), r.level_id.clone().into());
    inst.insert("categoryCode".into(), r.category_code.clone().into());
    inst.insert("geom".into(), Value::Object(geom));
    let mut seen = std::collections::HashSet::new();
    let drop: Vec<String> = srcs.iter().filter_map(|d| id_of(d)).filter(|i| seen.insert(*i)).map(str::to_owned).collect();
    vec![
        Op::Add { collection: "blockDefs".into(), items: vec![Value::Object(def)], at: None },
        Op::Remove { collection: "drawings2d".into(), ids: drop },
        Op::Add { collection: "drawings2d".into(), items: vec![Value::Object(inst)], at: None },
    ]
}

// ── Vorschau ─────────────────────────────────────────────────────────────────

/// Vorschau-Formen als flacher Puffer: je Form `[art, n, x0, y0, …]` (art 0 = Linie mit n = 2,
/// 1 = geschlossenes Polygon, 2 = offener Linienzug).
#[derive(Default)]
pub struct Shapes {
    pub buf: Vec<f64>,
    pub count: usize,
}

impl Shapes {
    pub fn line(&mut self, a: (f64, f64), b: (f64, f64)) {
        self.count += 1;
        self.buf.extend([0.0, 2.0, a.0, a.1, b.0, b.1]);
    }
    pub fn poly(&mut self, pts: &[(f64, f64)]) {
        self.poly_as(1.0, pts);
    }
    /// Offener Linienzug (art 2).
    pub fn poly_open(&mut self, pts: &[(f64, f64)]) {
        self.poly_as(2.0, pts);
    }
    fn poly_as(&mut self, kind: f64, pts: &[(f64, f64)]) {
        self.count += 1;
        self.buf.extend([kind, pts.len() as f64]);
        for p in pts {
            self.buf.extend([p.0, p.1]);
        }
    }
}

/// Obergrenze je Element (Schraffur-Muster u. Ä. erzeugen sehr viele Linien).
const MAX_SHAPES_PER_ITEM: usize = 4000;

fn ring_lines(c: (f64, f64), r: f64, a0: f64, a1: f64, out: &mut Shapes) {
    let sweep = a1 - a0;
    let n = jsnum::max(8.0, ((sweep.abs() / (std::f64::consts::PI * 2.0)) * 48.0).ceil());
    let at = |a: f64| (c.0 + r * jsnum::cos(a), c.1 + r * jsnum::sin(a));
    let mut prev = at(a0);
    let mut i = 1.0;
    while i <= n {
        let p = at(a0 + (sweep * i) / n);
        out.line(prev, p);
        prev = p;
        i += 1.0;
    }
}

/// Plan-Primitive → Vorschau-Formen (`primitivesToDraftShapes`); `top` = Grundlinie→Oberkante der Schrift.
fn prims_to_shapes(prims: &[crate::plan::prim::Primitive], top: f64, out: &mut Shapes) {
    use crate::plan::prim::Primitive as P;
    let start = out.count;
    let v = |q: &crate::model::Vec2| (q.x, q.y);
    for p in prims {
        if out.count - start >= MAX_SHAPES_PER_ITEM {
            break;
        }
        match p {
            P::Line { a, b, .. } => out.line(v(a), v(b)),
            P::Polygon { pts, .. } => {
                if pts.len() >= 2 {
                    out.poly(&pts.iter().map(v).collect::<Vec<_>>());
                }
            }
            P::DrawingCircle { center, r, .. } => ring_lines(v(center), *r, 0.0, std::f64::consts::PI * 2.0, out),
            P::DrawingArc { center, r, a0, a1, .. } => {
                let tau = std::f64::consts::PI * 2.0;
                let s = (((a1 - a0) % tau) + tau) % tau;
                let sweep = if s == 0.0 || s.is_nan() { tau } else { s };
                ring_lines(v(center), *r, *a0, a0 + sweep, out);
            }
            P::Arc { center, from, to, .. } => {
                let a0 = jsnum::atan2(from.y - center.y, from.x - center.x);
                let a1 = jsnum::atan2(to.y - center.y, to.x - center.x);
                let mut d = a1 - a0;
                while d <= -std::f64::consts::PI {
                    d += 2.0 * std::f64::consts::PI;
                }
                while d > std::f64::consts::PI {
                    d -= 2.0 * std::f64::consts::PI;
                }
                let r = hypot2(from.x - center.x, from.y - center.y);
                ring_lines(v(center), r, a0, a0 + d, out);
            }
            P::DrawingText { at, text, height_m, angle, marks, wrap_width, doc, .. } => {
                let doc = doc.clone().unwrap_or_else(|| crate::text_layout::doc_from_text(text, &marks.clone().unwrap_or_default()));
                let c = crate::text_layout::text_frame_corners(&doc, (at.x, at.y), *height_m, *angle, Some(wrap_width.unwrap_or(f64::NAN)), top);
                out.poly(&c);
            }
            P::DrawingTextPath { path_pts, .. } => {
                for w in path_pts.windows(2) {
                    out.line(v(&w[0]), v(&w[1]));
                }
            }
            P::DrawingImage { min, max, .. } => out.poly(&[(min.x, min.y), (max.x, min.y), (max.x, max.y), (min.x, max.y)]),
            _ => {}
        }
    }
}

/// Vorschau, bevor die typisierte Sicht gelesen wird (getrennte Ausleihen des Dokuments): die Formen der
/// Bauteile in einem Puffer, die abgebildeten Zeichnungen mit ihrer Einfügestelle (Primitive erst danach).
#[derive(Default)]
pub struct Pending {
    shapes: Shapes,
    /// (Stelle im Puffer, abgebildete Zeichnung) in Reihenfolge.
    drawings: Vec<(usize, Value)>,
}

impl Pending {
    pub fn has_drawings(&self) -> bool {
        !self.drawings.is_empty()
    }
}

fn pts_of(v: Option<&Value>) -> Vec<(f64, f64)> {
    arr(v).iter().map(xy).collect()
}

fn mapped(pts: &[(f64, f64)], xf: &Xf) -> Vec<(f64, f64)> {
    pts.iter().map(|p| xf.apply(p.0, p.1)).collect()
}

/// Wand-Dicke über den Wandtyp (`wallTypeThickness`), ohne Typ 0.2 m.
fn wall_thickness(root: &Map<String, Value>, w: &Value) -> f64 {
    let tid = field(w, "wallTypeId");
    match list(root, "wallTypes").iter().find(|t| tid.is_some() && field(t, "id") == tid) {
        Some(t) => arr(field(t, "layers")).iter().fold(0.0, |s, l| s + num_of(field(l, "thickness"))),
        None => 0.2,
    }
}

fn item_preview(root: &Map<String, Value>, kind: Kind, e: &Value, xf: &Xf, out: &mut Pending) {
    let s = &mut out.shapes;
    let pt = |k: &str| xy(field(e, k).unwrap_or(&Value::Null));
    match kind {
        Kind::Wall => {
            let th = wall_thickness(root, e);
            let (sx, sy) = pt("start");
            let (ex, ey) = pt("end");
            let (a, b) = (xf.apply(sx, sy), xf.apply(ex, ey));
            let bulge = field(e, "bulge").and_then(Value::as_f64).map(|b| if xf.reverses() { -b } else { b });
            if let Some((band, axis)) = crate::wall_arc::band_preview(a, b, bulge, th) {
                s.poly(&band);
                s.poly_open(&axis);
                return;
            }
            let v = |p: (f64, f64)| crate::model::Vec2 { x: p.0, y: p.1 };
            let c = crate::site_rules::wall_corners(v(a), v(b), th);
            s.poly(&[(c[0][0], c[0][1]), (c[1][0], c[1][1]), (c[2][0], c[2][1]), (c[3][0], c[3][1])]);
            s.line(a, b);
        }
        Kind::Solid => s.poly(&mapped(&pts_of(field(e, "points")), xf)),
        Kind::Column => {
            if let Ok(c) = serde_json::from_value::<crate::model::Column>(e.clone()) {
                let fp: Vec<(f64, f64)> = crate::model3d::column_footprint(&c).iter().map(|q| (q.x, q.y)).collect();
                s.poly(&mapped(&fp, xf));
            }
        }
        Kind::Ceiling | Kind::Roof => s.poly(&mapped(&pts_of(field(e, "outline")), xf)),
        Kind::Room => s.poly(&mapped(&pts_of(field(e, "boundary")), xf)),
        Kind::Stair => stair_preview(e, xf, s),
        Kind::Drawing => {
            let at = s.buf.len();
            out.drawings.push((at, with_geom(e, mv_geom(field(e, "geom").unwrap_or(&Value::Null), xf))));
        }
    }
}

/// Treppe: gerade/L über den echten Umriss; Wendel als grob abgetasteter Innen-/Aussenring.
fn stair_preview(e: &Value, xf: &Xf, out: &mut Shapes) {
    let Ok(st) = serde_json::from_value::<crate::model::Stair>(e.clone()) else { return };
    if st.shape != crate::model::StairShape::Spiral {
        let o = crate::stair::decode_params(&st.encode()).map(|p| kernel2d::stair_outline(&p));
        if let Some(poly) = o.and_then(|o| o.polygon) {
            out.poly(&poly.iter().map(|q| xf.apply(q.x, q.y)).collect::<Vec<_>>());
        }
        return;
    }
    let c = st.center.unwrap_or(st.start);
    let r_in = jsnum::max(0.0, st.radius.unwrap_or(0.0));
    let r_out = r_in + st.width;
    let sweep = st.sweep.unwrap_or(360.0);
    let a0 = jsnum::atan2(st.start.y - c.y, st.start.x - c.x);
    let steps = jsnum::max(4.0, jsnum::round(sweep.abs() / 15.0));
    let (mut outer, mut inner) = (Vec::new(), Vec::new());
    let mut i = 0.0;
    while i <= steps {
        let a = a0 + ((sweep * std::f64::consts::PI) / 180.0) * (i / steps);
        let (co, si) = (jsnum::cos(a), jsnum::sin(a));
        outer.push(xf.apply(c.x + co * r_out, c.y + si * r_out));
        inner.push(xf.apply(c.x + co * r_in, c.y + si * r_in));
        i += 1.0;
    }
    inner.reverse();
    outer.extend(inner);
    out.poly(&outer);
}

/// Vorschau aller Instanzen (Kopien, dann das bewegte Original im Modus „move“) — Teil 1 auf der Wurzel.
pub fn preview_pending(root: &Map<String, Value>, req: &TransformReq) -> Pending {
    let op = req.op.as_str();
    let items = gather(root, &req.sel, op, req.ignore_lock);
    let pts = req.points();
    let mut ts = copy_ts(op, &req.mode, req.count.0);
    if req.mode == "move" {
        ts.push(1.0);
    }
    let mut out = Pending::default();
    for t in ts {
        let xf = Xf::of(op, &pts, t);
        for (kind, e) in &items {
            item_preview(root, *kind, e, &xf, &mut out);
        }
    }
    out
}

/// Teil 2: Zeichnungen über dieselbe Primitiv-Erzeugung wie der Plan (ohne Override-Regeln), Rückfall
/// auf einfache Formen, wenn daraus nichts entsteht.
pub fn preview_finish(p: Option<&crate::model::Project>, pending: Pending, scale: f64, top: f64) -> Vec<f64> {
    use crate::plan::{domains, drawings};
    if pending.drawings.is_empty() {
        return pending.shapes.buf;
    }
    let args = domains::PlanArgs::parse(1.0, "{}").ok();
    let ctx = p.zip(args.as_ref()).map(|(p, a)| domains::Ctx::new(p, a));
    let src = pending.shapes.buf;
    let mut out = Shapes::default();
    let mut from = 0;
    for (at, v) in pending.drawings {
        out.buf.extend_from_slice(&src[from..at]);
        from = at;
        let before = out.count;
        if let (Some(c), Ok(d)) = (&ctx, serde_json::from_value::<crate::model::Drawing2D>(v.clone())) {
            let mut prims = drawings::Out::default();
            let ok = drawings::emit(c, &d, drawings::Attrs::of(c, &d), &d.geom, false, scale, &mut drawings::Sink::new(drawings::Target::Vec(&mut prims), drawings::Keep::All), 0);
            if ok.is_ok() {
                prims_to_shapes(&prims.prims, top, &mut out);
            }
        }
        if out.count == before {
            fallback_shapes(field(&v, "geom").unwrap_or(&Value::Null), &mut out);
        }
    }
    out.buf.extend_from_slice(&src[from..]);
    out.buf
}

fn fallback_shapes(g: &Value, out: &mut Shapes) {
    let p = |k: &str| xy(field(g, k).unwrap_or(&Value::Null));
    match shape(g) {
        "line" => out.line(p("a"), p("b")),
        "polyline" => {
            let pts = pts_of(field(g, "pts"));
            for w in pts.windows(2) {
                out.line(w[0], w[1]);
            }
            if truthy(field(g, "closed")) && pts.len() > 2 {
                out.line(pts[pts.len() - 1], pts[0]);
            }
        }
        "rect" | "image" => {
            let (min, max) = (p("min"), p("max"));
            out.poly(&[min, (max.0, min.1), max, (min.0, max.1)]);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    /// [T2] Bogenwand: Verschieben/Drehen behalten den Bulge, Spiegeln kehrt ihn um.
    #[test]
    fn bogenwand_spiegeln_kehrt_bulge() {
        let r = root(json!({"walls":[{"id":"a","start":{"x":0,"y":0},"end":{"x":4,"y":0},"bulge":0.5}]}));
        let run = |op: &str, pts: Value| {
            let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":["a"]},"op":op,"pts":pts,"mode":"move","count":1,"stamp":"s"})).unwrap();
            transform_ops(&r, &req)[0].to_json()["entity"].clone()
        };
        assert_eq!(run("move", json!([[0, 0], [1, 1]]))["bulge"], json!(0.5));
        assert_eq!(run("rotate", json!([[0, 0], [1, 0], [0, 1]]))["bulge"], json!(0.5));
        assert_eq!(run("mirror", json!([[0, 0], [0, 1]]))["bulge"], json!(-0.5));
    }

    #[test]
    fn verschieben_und_kopieren() {
        let r = root(json!({"walls":[{"id":"a","start":{"x":0,"y":0},"end":{"x":1,"y":0},"locked":false},{"id":"b","start":{"x":0,"y":0},"end":{"x":1,"y":0},"locked":true}]}));
        let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":["a","b"]},"op":"move","pts":[[0,0],[2,3]],"mode":"move","count":1,"stamp":"s"})).unwrap();
        let ops = transform_ops(&r, &req);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].to_json()["entity"]["start"], json!({"x":2,"y":3}));
        let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":["a"]},"op":"move","pts":[[0,0],[1,0]],"mode":"array","count":3,"stamp":"s"})).unwrap();
        let ops = transform_ops(&r, &req);
        let items = &ops[0].to_json()["items"];
        assert_eq!(items.as_array().unwrap().len(), 3);
        assert_eq!(items[2]["id"], "W-s-3");
        assert_eq!(items[2]["end"], json!({"x":4,"y":0}));
    }

    #[test]
    fn spiegeln_kehrt_bogen_und_rechteck() {
        let g = json!({"shape":"polyline","pts":[{"x":0,"y":0},{"x":1,"y":0}],"bulge":[0.5]});
        let xf = Xf::of("mirror", &[(0.0, 0.0), (1.0, 0.0)], 1.0);
        assert_eq!(mv_geom(&g, &xf).unwrap()["bulge"], json!([-0.5]));
        let rect = json!({"shape":"rect","min":{"x":0,"y":0},"max":{"x":2,"y":1},"extra":1});
        let rot = Xf::of("rotate", &[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)], 1.0);
        assert_eq!(mv_geom(&rect, &rot).unwrap()["shape"], "polyline");
        assert_eq!(mv_geom(&rect, &Xf::translate(1.0, 1.0)).unwrap(), json!({"shape":"rect","min":{"x":1,"y":1},"max":{"x":3,"y":2}}));
        assert!(mv_geom(&json!({"shape":"?"}), &xf).is_none());
    }

    #[test]
    fn skalieren_zieht_groessen_nach() {
        let g = json!({"shape":"circle","center":{"x":1,"y":0},"r":1});
        let pts = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)];
        let xf = Xf::of("scale", &pts, 1.0);
        assert_eq!(scale_geom(&g, &xf, scale_factor(&pts, 1.0)).unwrap(), json!({"shape":"circle","center":{"x":2,"y":0},"r":2}));
    }

    #[test]
    fn ausrichten_links() {
        let d = |id: &str, x: f64| json!({"id":id,"geom":{"shape":"line","a":{"x":x,"y":0},"b":{"x":x+1.0,"y":1}}});
        let r = root(json!({"drawings2d":[d("a", 0.0), d("b", 5.0)]}));
        let ops = align_ops(&r, &["a".into(), "b".into()], "left");
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].to_json()["entity"]["geom"]["a"], json!({"x":0,"y":0}));
    }
}
