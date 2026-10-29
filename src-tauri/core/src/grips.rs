//! Griff-, Kanten- und Grössen-Geometrie der Bauteile ([K4] S3, vorher `state/projectSlice.ts` und
//! `state/edgeGrips.ts`): Eckpunkt-Griff ziehen (`moveGrip`), Element verschieben (`moveElementBy`),
//! Kante parallel verschieben (`moveEdge`, winkeltreu an den Nachbarkanten), Grösse um einen Anker
//! (`resizeElement`), Decken-/Dach-/Treppen-/Raum-Griffe, Raumstempel, Polylinien-Punkt einfügen/
//! löschen und die Dicke einschichtiger Wände/Decken. Dazu die Griff-Listen (`drawingVertices`) und
//! die Kanten-Griffe (`ringEdges`/`openEdges`) für die Anzeige.
//!
//! Rechnung auf der rohen Projekt-Wurzel (`serde_json`, verlustfrei): ein geändertes Element behält
//! unbekannte Felder und die Schlüsselreihenfolge, genau wie das Objekt-Spreizen (`{...d, geom}`) in TS.
//! Ergebnis sind Ops (`replace`/`add`); keine Op, wo die TS-Fassung dasselbe Objekt zurückgab.
//! Zahlen wie in JS (`jsnum`, `jsmath`); nicht endliche Ergebnisse reisen als Marken (`"\u{1}NaN"`,
//! s. `ops.rs`), damit die Prüfung des Dokuments sie wie bisher zurückweist.
//!
//! Abweichung (gewollt): Ein Griff-Index, unter dem kein Punkt liegt (negativ, gebrochen, zu gross), ist
//! keine Änderung — TS warf dort beim Lesen von `undefined` einen Fehler.

use crate::jsmath::hypot2;
use crate::jsnum;
use crate::ops::{id_of, Op};
use serde_json::{Map, Value};

// ── JS-Zahlen in JSON ────────────────────────────────────────────────────────

/// Zahl als JSON-Wert wie nach `JSON.stringify` → `serde_json`: ganze Zahlen als Ganzzahl, sonst f64;
/// NaN/±∞ als Marke (`"\u{1}NaN"` …), −0 als 0.
pub fn js_num(x: f64) -> Value {
    if x.is_nan() {
        return Value::String("\u{1}NaN".into());
    }
    if x.is_infinite() {
        return Value::String(if x > 0.0 { "\u{1}Infinity" } else { "\u{1}-Infinity" }.into());
    }
    if x.fract() == 0.0 {
        if (0.0..18446744073709551616.0).contains(&x) {
            return Value::from(x as u64);
        }
        if x < 0.0 && x >= -9223372036854775808.0 {
            return Value::from(x as i64);
        }
    }
    Value::from(x)
}

/// Zahl eines JSON-Werts wie in JS-Arithmetik auf der Leseansicht: Zahl, Nicht-endlich-Marke, `null` = 0
/// (so rechnet JS mit `null`; das Dokument speichert ein tief liegendes NaN als `null`, eine geladene
/// Datei liest es so zurück); fehlend und alles andere NaN.
pub fn num_of(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        Some(m) => match crate::ops::non_finite_mark(m) {
            Some("Infinity") => f64::INFINITY,
            Some("-Infinity") => f64::NEG_INFINITY,
            _ => f64::NAN,
        },
        None => f64::NAN,
    }
}

/// `a ?? b` für Zahlen (fehlend/`null` → `b`).
fn num_or(v: Option<&Value>, b: f64) -> f64 {
    match v {
        None | Some(Value::Null) => b,
        v => num_of(v),
    }
}

/// JS-Wahrheitswert.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// Punkt `{x, y}` (wie ein neues Objekt-Literal in TS).
pub fn pt(x: f64, y: f64) -> Value {
    let mut m = Map::new();
    m.insert("x".into(), js_num(x));
    m.insert("y".into(), js_num(y));
    Value::Object(m)
}

/// `(x, y)` eines Punkt-Werts (fehlende Koordinaten NaN).
pub fn xy(v: &Value) -> (f64, f64) {
    (num_of(v.get("x")), num_of(v.get("y")))
}

/// `{...v, key: val}` (vorhandener Schlüssel behält seine Stelle). Der ersetzte Wert wird nicht kopiert
/// (eine grosse Polylinie kostet sonst je Mausschritt eine Kopie mehr).
fn with(v: &Value, key: &str, val: Value) -> Value {
    with_all(v, vec![(key, val)])
}

/// Wie [`with`] für mehrere Felder in einem Durchgang (`{...v, a, b}`).
fn with_all(v: &Value, fields: Vec<(&str, Value)>) -> Value {
    with_opt(v, fields.into_iter().map(|(k, x)| (k, Some(x))).collect())
}

/// Wie [`with_all`]; `None` = `undefined` (das Feld fällt weg, wie in JSON).
fn with_opt(v: &Value, fields: Vec<(&str, Option<Value>)>) -> Value {
    let mut fields: Vec<(&str, Option<Value>, bool)> = fields.into_iter().map(|(k, x)| (k, x, false)).collect();
    let src = v.as_object();
    let mut m = Map::with_capacity(src.map_or(0, Map::len) + fields.len());
    for (k, x) in src.into_iter().flatten() {
        match fields.iter_mut().find(|(f, _, _)| *f == k) {
            Some((_, new, done)) => {
                *done = true;
                if let Some(n) = new.take() {
                    m.insert(k.clone(), n);
                }
            }
            None => {
                m.insert(k.clone(), x.clone());
            }
        }
    }
    for (k, x, done) in fields {
        if let (false, Some(x)) = (done, x) {
            m.insert(k.into(), x);
        }
    }
    Value::Object(m)
}

/// Zahl, die TS teils unverändert durchreicht (`ry: g.ry`): Wert für die Rechnung und JSON-Wert
/// (`None` = fehlend/`undefined`; ein `null` bleibt `null`).
#[derive(Clone)]
struct Pass {
    f: f64,
    v: Option<Value>,
}

/// Unverändert durchgereichtes Feld.
fn pass(v: Option<&Value>) -> Pass {
    Pass { f: num_of(v), v: v.cloned() }
}

/// Neu gerechnete Zahl.
fn calc(f: f64) -> Pass {
    Pass { f, v: Some(js_num(f)) }
}

fn arr(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Ganzzahliger Index in `0..len` (JS: `list[i]` trifft nur dann ein Element).
fn index_in(i: f64, len: usize) -> Option<usize> {
    (i.fract() == 0.0 && i >= 0.0 && i < len as f64).then_some(i as usize)
}

fn eq_index(i: usize, index: f64) -> bool {
    i as f64 == index
}

/// `pts.map((p, i) => i === index ? new : p)`.
fn replace_at(list: &[Value], index: f64, new: &Value) -> Value {
    Value::Array(list.iter().enumerate().map(|(i, p)| if eq_index(i, index) { new.clone() } else { p.clone() }).collect())
}

fn moved(p: &Value, dx: f64, dy: f64) -> Value {
    let (x, y) = xy(p);
    pt(x + dx, y + dy)
}

fn moved_all(list: &[Value], dx: f64, dy: f64) -> Value {
    Value::Array(list.iter().map(|p| moved(p, dx, dy)).collect())
}

fn find<'a>(root: &'a Map<String, Value>, collection: &str, id: &str) -> Option<&'a Value> {
    arr(root.get(collection)).iter().find(|e| id_of(e) == Some(id))
}

fn replace(collection: &str, entity: Value) -> Op {
    Op::Replace { collection: collection.into(), entity }
}

fn with_geom(d: &Value, g: Value) -> Value {
    with(d, "geom", g)
}

// ── Anfrage ──────────────────────────────────────────────────────────────────

/// Eine Änderung aus den Griff-Aktionen des Stores (JSON, Zahlen mit Nicht-endlich-Marken).
pub struct Request<'a>(&'a Value);

impl<'a> Request<'a> {
    fn n(&self, k: &str) -> f64 {
        num_of(self.0.get(k))
    }
    fn s(&self, k: &str) -> Option<&'a str> {
        self.0.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
    }
    /// Punkt als `[x, y]`.
    fn p(&self, k: &str) -> (f64, f64) {
        let a = arr(self.0.get(k));
        (num_of(a.first()), num_of(a.get(1)))
    }
}

/// Ergebnis: Ops und ggf. ein Hinweis-Schlüssel für die Hülle (i18n, z. B. zu wenige Punkte).
#[derive(Default)]
pub struct GripResult {
    pub ops: Vec<Op>,
    pub notice: Option<&'static str>,
}

impl From<Vec<Op>> for GripResult {
    fn from(ops: Vec<Op>) -> Self {
        GripResult { ops, notice: None }
    }
}

/// Antwort-JSON `{"ops": […], "notice": …}` (Ops wie `CoreOp` in TS; `replace` ohne Kopie des Elements).
pub fn result_json(r: &GripResult) -> String {
    let mut out = String::from("{\"ops\":[");
    for (i, op) in r.ops.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        match op {
            Op::Replace { collection, entity } => {
                out.push_str("{\"kind\":\"replace\",\"collection\":");
                out.push_str(&Value::from(collection.as_str()).to_string());
                out.push_str(",\"entity\":");
                out.push_str(&entity.to_string());
                out.push('}');
            }
            op => out.push_str(&op.to_json().to_string()),
        }
    }
    out.push(']');
    if let Some(n) = r.notice {
        out.push_str(",\"notice\":");
        out.push_str(&Value::from(n).to_string());
    }
    out.push('}');
    out
}

/// Führt eine Griff-Änderung aus (`req.op` wählt die Art, s. `src/state/gripOps.ts`).
pub fn run(root: &Map<String, Value>, req: &Value) -> Result<GripResult, String> {
    let r = Request(req);
    let op = req.get("op").and_then(Value::as_str).unwrap_or("");
    let patch = |coll: &str, id: Option<&str>, f: &dyn Fn(&Value) -> Option<Value>| -> Vec<Op> {
        id.and_then(|id| find(root, coll, id)).and_then(f).map(|e| vec![replace(coll, e)]).unwrap_or_default()
    };
    Ok(match op {
        "moveGrip" | "moveBy" | "moveEdge" => {
            let (did, wid) = (r.s("drawingId"), r.s("wallId"));
            // Jedes Element nur einmal suchen (lineare Suche, je Mausschritt).
            let d = did.and_then(|i| find(root, "drawings2d", i));
            let w = wid.and_then(|i| find(root, "walls", i));
            // Objekt-Sperre: gesperrte Elemente lassen sich anwählen, aber nicht ziehen.
            if d.is_some_and(|d| truthy(d.get("locked"))) || w.is_some_and(|w| truthy(w.get("locked"))) {
                return Ok(GripResult::default());
            }
            let f: Box<dyn Fn(&Value, bool) -> Option<Value>> = match op {
                "moveGrip" => {
                    let (index, (x, y), scale) = (r.n("index"), r.p("pt"), r.n("scale"));
                    Box::new(move |e, wall| if wall { Some(wall_grip(e, index, x, y)) } else { drawing_grip(e, index, x, y, scale) })
                }
                "moveBy" => {
                    let (dx, dy) = r.p("delta");
                    Box::new(move |e, wall| if wall { Some(wall_moved(e, dx, dy)) } else { drawing_moved(e, dx, dy) })
                }
                _ => {
                    let (a, b, (dx, dy)) = (r.n("a"), r.n("b"), r.p("delta"));
                    Box::new(move |e, wall| if wall { Some(wall_moved(e, dx, dy)) } else { drawing_edge(e, a, b, dx, dy) })
                }
            };
            // Mit Zeichnung wird nur sie geändert (die Wand zählt dann nur für die Sperre).
            let (coll, e, wall) = if did.is_some() { ("drawings2d", d, false) } else { ("walls", w, true) };
            e.and_then(|e| f(e, wall)).map(|e| vec![replace(coll, e)]).unwrap_or_default().into()
        }
        "resize" => {
            let (w, h, fx, fy) = (r.n("w"), r.n("h"), r.n("fx"), r.n("fy"));
            if r.s("kind") == Some("drawing2d") {
                patch("drawings2d", r.s("id"), &|d| resize_geom(d.get("geom")?, w, h, fx, fy).map(|g| with_geom(d, g))).into()
            } else {
                patch("walls", r.s("id"), &|wall| {
                    let s = xy(wall.get("start").unwrap_or(&Value::Null));
                    let e = xy(wall.get("end").unwrap_or(&Value::Null));
                    let (ax, ay, sx, sy) = scale_around(bbox(&[s, e]), w, h, fx, fy);
                    let f = |p: (f64, f64)| pt(ax + (p.0 - ax) * sx, ay + (p.1 - ay) * sy);
                    Some(with_all(wall, vec![("start", f(s)), ("end", f(e))]))
                })
                .into()
            }
        }
        "ceilingGrip" | "roomGrip" => {
            let (coll, field) = if op == "ceilingGrip" { ("ceilings", "outline") } else { ("rooms", "boundary") };
            let (index, (x, y)) = (r.n("index"), r.p("pt"));
            patch(coll, r.s("id"), &|e| Some(with(e, field, replace_at(e.get(field)?.as_array()?, index, &pt(x, y))))).into()
        }
        "ceilingBy" | "roofBy" => {
            let coll = if op == "ceilingBy" { "ceilings" } else { "roofs" };
            let (dx, dy) = r.p("delta");
            patch(coll, r.s("id"), &|e| Some(with(e, "outline", moved_all(e.get("outline")?.as_array()?, dx, dy)))).into()
        }
        "ceilingEdge" | "roomEdge" => {
            let (coll, field) = if op == "ceilingEdge" { ("ceilings", "outline") } else { ("rooms", "boundary") };
            let (a, b, (dx, dy)) = (r.n("a"), r.n("b"), r.p("delta"));
            patch(coll, r.s("id"), &|e| Some(with(e, field, move_polygon_edge(e.get(field)?.as_array()?, a, b, dx, dy, true)?))).into()
        }
        "roofGrip" => {
            let (index, (x, y)) = (r.n("index"), r.p("pt"));
            patch("roofs", r.s("id"), &|e| roof_grip(e, index, x, y)).into()
        }
        "stairBy" => {
            let (dx, dy) = r.p("delta");
            patch("stairs", r.s("id"), &|s| {
                let mut out = with(s, "start", moved(s.get("start").unwrap_or(&Value::Null), dx, dy));
                if truthy(s.get("center")) {
                    out = with(&out, "center", moved(&s["center"], dx, dy));
                }
                Some(out)
            })
            .into()
        }
        "roomBy" => {
            let (dx, dy) = r.p("delta");
            patch("rooms", r.s("id"), &|rm| {
                let mut out = with(rm, "boundary", moved_all(rm.get("boundary")?.as_array()?, dx, dy));
                if truthy(rm.get("stampAnchor")) {
                    out = with(&out, "stampAnchor", moved(&rm["stampAnchor"], dx, dy));
                }
                Some(out)
            })
            .into()
        }
        "roomStamp" => {
            let (dx, dy) = r.p("delta");
            patch("rooms", r.s("id"), &|rm| {
                let base = match rm.get("stampAnchor") {
                    Some(a) if !a.is_null() => xy(a),
                    _ => {
                        let ring: Vec<[f64; 2]> = arr(rm.get("boundary")).iter().map(|p| xy(p).into()).collect();
                        let c = crate::room_area::evaluate(&ring, 0.0).centroid;
                        (c[0], c[1])
                    }
                };
                Some(with(rm, "stampAnchor", pt(base.0 + dx, base.1 + dy)))
            })
            .into()
        }
        "insertPoint" => {
            let (seg, (x, y)) = (r.n("seg"), r.p("pt"));
            patch("drawings2d", r.s("id"), &|d| insert_point(d, seg, x, y)).into()
        }
        "deletePoint" => {
            let index = r.n("index");
            let Some(d) = r.s("id").and_then(|i| find(root, "drawings2d", i)) else { return Ok(GripResult::default()) };
            let g = d.get("geom").unwrap_or(&Value::Null);
            if g.get("shape").and_then(Value::as_str) != Some("polyline") {
                return Ok(GripResult::default());
            }
            let pts = arr(g.get("pts"));
            let min = if truthy(g.get("closed")) { 4 } else { 3 };
            if pts.len() < min {
                return Ok(GripResult { ops: vec![], notice: Some("alert.polylineMinPoints") });
            }
            let Some(k) = index_in(index, pts.len()) else { return Ok(GripResult::default()) };
            // Zwei Segmente werden eins: der Bogen des entfernten Segments fällt weg, das verbleibende behält
            // seinen (die genaue Bogenform lässt sich ohne den Stützpunkt nicht erhalten).
            let drop = |l: &[Value]| Value::Array(l.iter().enumerate().filter(|(i, _)| *i != k).map(|(_, v)| v.clone()).collect());
            let mut fields = vec![("pts", drop(pts))];
            if truthy(g.get("bulge")) {
                fields.push(("bulge", drop(arr(g.get("bulge")))));
            }
            vec![replace("drawings2d", with_geom(d, with_all(g, fields)))].into()
        }
        "wallThickness" => wall_thickness(root, r.s("id").unwrap_or(""), r.n("thickness"), r.s("newId").unwrap_or(""), req.get("newName").cloned().unwrap_or(Value::Null)).into(),
        "ceilingThickness" => ceiling_thickness(root, r.s("id").unwrap_or(""), r.n("thickness"), r.s("newId").unwrap_or(""), req.get("newName").cloned().unwrap_or(Value::Null)).into(),
        other => return Err(format!("Unbekannte Griff-Änderung: {other}")),
    })
}

// ── Wand ─────────────────────────────────────────────────────────────────────

fn wall_grip(w: &Value, index: f64, x: f64, y: f64) -> Value {
    with(w, if index == 0.0 { "start" } else { "end" }, pt(x, y))
}

fn wall_moved(w: &Value, dx: f64, dy: f64) -> Value {
    let s = moved(w.get("start").unwrap_or(&Value::Null), dx, dy);
    let e = moved(w.get("end").unwrap_or(&Value::Null), dx, dy);
    with_all(w, vec![("start", s), ("end", e)])
}

// ── 2D-Zeichnungen ───────────────────────────────────────────────────────────

fn shape(g: &Value) -> &str {
    g.get("shape").and_then(Value::as_str).unwrap_or("")
}

/// Kreis, solange rx≈ry (relative Toleranz 0.5 %) — sonst Ellipse (rotation 0). Neues Objekt (weitere
/// Felder der alten Form entfallen, wie in TS).
fn ellipse_or_circle(center: Option<&Value>, rx: Pass, ry: Pass) -> Value {
    let mut m = Map::new();
    let mut put = |k: &str, v: Option<Value>| {
        if let Some(v) = v {
            m.insert(k.into(), v);
        }
    };
    if (rx.f - ry.f).abs() <= 0.005 * jsnum::max(rx.f, ry.f) {
        put("shape", Some("circle".into()));
        put("center", center.cloned());
        put("r", Some(js_num((rx.f + ry.f) / 2.0)));
    } else {
        put("shape", Some("ellipse".into()));
        put("center", center.cloned());
        put("rx", rx.v);
        put("ry", ry.v);
        put("rotation", Some(Value::from(0u64)));
    }
    Value::Object(m)
}

/// `mmToModel`: Papier-mm → Modell-Meter beim Massstab 1:N.
fn mm_to_model(mm: f64, scale: f64) -> f64 {
    (mm / 1000.0) * scale
}

fn model_to_mm(m: f64, scale: f64) -> f64 {
    (m * 1000.0) / scale
}

/// Standard-Schrifthöhe der Masszahl (Papier-mm, `DIM_DEFAULTS_MM.textHeight`).
const DIM_TEXT_HEIGHT_MM: f64 = 4.0;

/// `dimTextFrame` der TS-Fassade: bei nicht endlichen Eingaben alles NaN.
fn dim_frame(a: (f64, f64), b: (f64, f64), offset: f64, h: f64) -> ((f64, f64), (f64, f64), (f64, f64)) {
    if ![a.0, a.1, b.0, b.1, offset, h].iter().all(|v| v.is_finite()) {
        let n = (f64::NAN, f64::NAN);
        return (n, n, n);
    }
    let v = |p: (f64, f64)| crate::model::Vec2 { x: p.0, y: p.1 };
    let (base, read, up, _) = crate::plan::drawings::dim_text_frame(v(a), v(b), offset, h);
    ((base.x, base.y), (read.x, read.y), (up.x, up.y))
}

/// `dimTextPos`: Lage der Masszahl inkl. Versatz (Modell-Meter).
fn dim_text_pos(a: (f64, f64), b: (f64, f64), offset: f64, h: f64, along: f64, perp: f64) -> (f64, f64) {
    let (base, read, up) = dim_frame(a, b, offset, h);
    (base.0 + read.0 * along + up.0 * perp, base.1 + read.1 * along + up.1 * perp)
}

/// Schrifthöhe der Masszahl in Modell-Metern.
fn dim_height(g: &Value, scale: f64) -> f64 {
    mm_to_model(num_or(g.get("textHeightMm"), DIM_TEXT_HEIGHT_MM), scale)
}

/// Griff `index` einer 2D-Zeichnung auf (x, y) (`moveGrip`); `None` = keine Änderung.
fn drawing_grip(d: &Value, index: f64, x: f64, y: f64, scale: f64) -> Option<Value> {
    let g = d.get("geom")?;
    let p = pt(x, y);
    let set = |k: &str, v: Value| Some(with_geom(d, with(g, k, v)));
    match shape(g) {
        "line" | "xline" | "ray" => set(if index == 0.0 { "a" } else { "b" }, p),
        "polyline" => {
            let pts = arr(g.get("pts"));
            let n = pts.len();
            if index < n as f64 {
                return set("pts", replace_at(pts, index, &p));
            }
            // Bulge-Griff (Index ≥ n): Segment-Mitte senkrecht zur Sehne → Bogen dieses Segments.
            let seg = index - n as f64;
            let k = index_in(seg, n)?;
            let a = xy(&pts[k]);
            let b = xy(if k == n - 1 { &pts[0] } else { &pts[k + 1] });
            let val = crate::bulge::from_sagitta_point(a.0, a.1, b.0, b.1, x, y);
            let mut bulge: Vec<Value> = arr(g.get("bulge")).to_vec();
            while bulge.len() <= k {
                bulge.push(Value::from(0u64));
            }
            bulge[k] = js_num(val);
            set("bulge", Value::Array(bulge))
        }
        "bezier" | "spline" => set("pts", replace_at(arr(g.get("pts")), index, &p)),
        "dimension" => {
            let pts = arr(g.get("pts"));
            let n = pts.len();
            if index < n as f64 {
                return set("pts", replace_at(pts, index, &p));
            }
            if index == n as f64 {
                // Griff auf der Masslinie: nur `offset` (Normalabstand zur Punktreihe).
                let (a, b) = (xy(pts.first()?), xy(pts.last()?));
                let (dx, dy) = (b.0 - a.0, b.1 - a.1);
                let len = or1(hypot2(dx, dy));
                let (nx, ny) = (-dy / len, dx / len);
                return set("offset", js_num((x - a.0) * nx + (y - a.1) * ny));
            }
            // Masszahl-Griff: nur die Zahl des Segments, rastet nahe der Standardlage ein.
            let seg = index - n as f64 - 1.0;
            if seg < 0.0 || seg >= n as f64 - 1.0 {
                return None;
            }
            let k = index_in(seg, n)?;
            let h = dim_height(g, scale);
            let (base, read, up) = dim_frame(xy(&pts[k]), xy(&pts[k + 1]), num_of(g.get("offset")), h);
            let (vx, vy) = (x - base.0, y - base.1);
            let snap = h * 0.5;
            let along = vx * read.0 + vy * read.1;
            let perp = vx * up.0 + vy * up.1;
            let along = if along.abs() < snap { 0.0 } else { along };
            let perp = if perp.abs() < snap { 0.0 } else { perp };
            let mut next = Map::new();
            next.insert("along".into(), js_num(model_to_mm(along, scale)));
            next.insert("perp".into(), js_num(model_to_mm(perp, scale)));
            let old = arr(g.get("textOffsetsMm"));
            let offs: Vec<Value> = (0..n - 1)
                .map(|i| {
                    if i == k {
                        Value::Object(next.clone())
                    } else {
                        match old.get(i) {
                            Some(v) if !v.is_null() => v.clone(),
                            _ => serde_json::json!({"along": 0, "perp": 0}),
                        }
                    }
                })
                .collect();
            set("textOffsetsMm", Value::Array(offs))
        }
        "rect" | "image" => {
            let corners = rect_corners(g);
            let r = (index + 2.0) % 4.0;
            let opp = corners[index_in(r, 4)?];
            let min = pt(jsnum::min(x, opp.0), jsnum::min(y, opp.1));
            let max = pt(jsnum::max(x, opp.0), jsnum::max(y, opp.1));
            Some(with_geom(d, with_all(g, vec![("min", min), ("max", max)])))
        }
        "text" => {
            if truthy(g.get("pathPts")) {
                return set("pathPts", replace_at(arr(g.get("pathPts")), index, &p));
            }
            if truthy(g.get("leaderTarget")) {
                let bends = arr(g.get("leaderBendPoints"));
                let tip = bends.len() as f64 + 1.0;
                if index == 0.0 {
                    return set("at", p);
                }
                if index == tip {
                    return set("leaderTarget", p);
                }
                if index > 0.0 && index < tip {
                    let v = Value::Array(bends.iter().enumerate().map(|(i, bp)| if i as f64 == index - 1.0 { p.clone() } else { bp.clone() }).collect());
                    return set("leaderBendPoints", v);
                }
                return None;
            }
            let width = num_of(g.get("width"));
            if truthy(g.get("width")) && width > 0.0 && index >= 0.0 && index < 4.0 {
                // Nur die Spaltenbreite ändert sich (InDesign-Textrahmen); Zug auf die lokale x-Achse.
                let angle = num_of(g.get("angle"));
                let (cos, sin) = (jsnum::cos(angle), jsnum::sin(angle));
                let (ax, ay) = xy(g.get("at").unwrap_or(&Value::Null));
                let local_x = (x - ax) * cos + (y - ay) * sin;
                const MIN_WIDTH: f64 = 0.1;
                if index == 0.0 || index == 3.0 {
                    let w = jsnum::max(MIN_WIDTH, width - local_x);
                    let at = pt(ax + local_x * cos, ay + local_x * sin);
                    return Some(with_geom(d, with_all(g, vec![("at", at), ("width", js_num(w))])));
                }
                return set("width", js_num(jsnum::max(MIN_WIDTH, local_x)));
            }
            set("at", p)
        }
        "kote" | "detailref" | "scalebar" | "pointmarker" | "block" => set("at", p),
        "circle" => {
            let (cx, cy) = xy(g.get("center").unwrap_or(&Value::Null));
            let r = pass(g.get("r"));
            let (rx, ry) = if index == 0.0 { (calc(jsnum::max(1e-3, (x - cx).abs())), r) } else { (r, calc(jsnum::max(1e-3, (y - cy).abs()))) };
            Some(with_geom(d, ellipse_or_circle(g.get("center"), rx, ry)))
        }
        "arc" => {
            let (cx, cy) = xy(g.get("center").unwrap_or(&Value::Null));
            if index == 2.0 {
                return set("r", js_num(jsnum::max(1e-3, hypot2(x - cx, y - cy))));
            }
            set(if index == 0.0 { "a0" } else { "a1" }, js_num(jsnum::atan2(y - cy, x - cx)))
        }
        "ellipse" => {
            let rot = num_of(g.get("rotation"));
            let (c, s) = (jsnum::cos(rot), jsnum::sin(rot));
            let (cx, cy) = xy(g.get("center").unwrap_or(&Value::Null));
            let (dx, dy) = (x - cx, y - cy);
            let lx = dx * c + dy * s;
            let ly = -dx * s + dy * c;
            let rx = if index == 0.0 { calc(jsnum::max(1e-3, lx.abs())) } else { pass(g.get("rx")) };
            let ry = if index == 0.0 { pass(g.get("ry")) } else { calc(jsnum::max(1e-3, ly.abs())) };
            // Nur ungedreht (`rotation === 0`) kann eine (fast) gleichseitige Ellipse wieder zum Kreis werden.
            if g.get("rotation").and_then(Value::as_f64) == Some(0.0) {
                return Some(with_geom(d, ellipse_or_circle(g.get("center"), rx, ry)));
            }
            Some(with_geom(d, with_opt(g, vec![("rx", rx.v), ("ry", ry.v)])))
        }
        _ => None,
    }
}

/// `x || 1` für eine Länge (0 und NaN → 1).
fn or1(l: f64) -> f64 {
    if l == 0.0 || l.is_nan() {
        1.0
    } else {
        l
    }
}

/// Ecken eines Rechtecks/Bilds in Griff-Reihenfolge: min, (max.x, min.y), max, (min.x, max.y).
fn rect_corners(g: &Value) -> [(f64, f64); 4] {
    let mn = xy(g.get("min").unwrap_or(&Value::Null));
    let mx = xy(g.get("max").unwrap_or(&Value::Null));
    [mn, (mx.0, mn.1), mx, (mn.0, mx.1)]
}

/// Ganze 2D-Zeichnung verschieben (`moveElementBy`); `None` = Form ohne Verschiebung.
fn drawing_moved(d: &Value, dx: f64, dy: f64) -> Option<Value> {
    let g = d.get("geom")?;
    let mv = |k: &str| moved(g.get(k).unwrap_or(&Value::Null), dx, dy);
    let ng = match shape(g) {
        "line" => with_all(g, vec![("a", mv("a")), ("b", mv("b"))]),
        "polyline" | "bezier" | "spline" | "dimension" => with(g, "pts", moved_all(arr(g.get("pts")), dx, dy)),
        "rect" | "image" => with_all(g, vec![("min", mv("min")), ("max", mv("max"))]),
        "circle" | "arc" | "ellipse" => with(g, "center", mv("center")),
        "kote" | "detailref" | "scalebar" | "pointmarker" | "text" => with(g, "at", mv("at")),
        _ => return None,
    };
    Some(with_geom(d, ng))
}

/// Kante (a, b) einer 2D-Zeichnung verschieben (`moveEdge`); `None` = keine Änderung.
fn drawing_edge(d: &Value, a: f64, b: f64, dx: f64, dy: f64) -> Option<Value> {
    let g = d.get("geom")?;
    let ng = match shape(g) {
        "line" => with_all(g, vec![("a", moved(g.get("a").unwrap_or(&Value::Null), dx, dy)), ("b", moved(g.get("b").unwrap_or(&Value::Null), dx, dy))]),
        "polyline" | "spline" => with(g, "pts", move_polygon_edge(arr(g.get("pts")), a, b, dx, dy, truthy(g.get("closed")))?),
        "rect" | "image" => {
            // Die zwei Kanten-Ecken verschieben, dann die bbox neu bilden (achsparallel).
            let corners = rect_corners(g);
            let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            for (i, c) in corners.iter().enumerate() {
                let c = if eq_index(i, a) || eq_index(i, b) { (c.0 + dx, c.1 + dy) } else { *c };
                x0 = jsnum::min(x0, c.0);
                y0 = jsnum::min(y0, c.1);
                x1 = jsnum::max(x1, c.0);
                y1 = jsnum::max(y1, c.1);
            }
            with_all(g, vec![("min", pt(x0, y0)), ("max", pt(x1, y1))])
        }
        _ => return None,
    };
    Some(with_geom(d, ng))
}

/// Schnittpunkt der Geraden a + t·da mit b + s·db (`lineIntersect`); `None` bei (fast) parallelen.
fn line_intersect(a: (f64, f64), da: (f64, f64), b: (f64, f64), db: (f64, f64)) -> Option<(f64, f64)> {
    let cross = |p: (f64, f64), q: (f64, f64)| p.0 * q.1 - p.1 * q.0;
    let denom = cross(da, db);
    if denom.abs() < 1e-9 {
        return None;
    }
    let t = cross((b.0 - a.0, b.1 - a.1), db) / denom;
    Some((a.0 + da.0 * t, a.1 + da.1 * t))
}

/// Neue Lage eines Eckpunkts, dessen eine Kante parallel verschoben wird: er wandert entlang seiner
/// anderen (unverschobenen) Nachbarkante (`edgeMoveVertex`); ohne Nachbarn oder bei paralleler
/// Nachbarkante einfach um das Delta.
fn edge_move_vertex(v: (f64, f64), neighbor: Option<(f64, f64)>, shifted: (f64, f64), edge_dir: (f64, f64), dx: f64, dy: f64) -> (f64, f64) {
    let fallback = (v.0 + dx, v.1 + dy);
    let Some(nb) = neighbor else { return fallback };
    let nd = (v.0 - nb.0, v.1 - nb.1);
    if hypot2(nd.0, nd.1) < 1e-9 {
        return fallback;
    }
    line_intersect(nb, nd, shifted, edge_dir).unwrap_or(fallback)
}

/// Nachbar-Index von `i` in Richtung `dir` (`ringNeighbor`): `None` am offenen Ende oder wenn er auf
/// die andere Kanten-Ecke fiele.
fn ring_neighbor(i: usize, n: usize, closed: bool, dir: i64, excluding: usize) -> Option<usize> {
    let j = i as i64 + dir;
    let k = if j >= 0 && j < n as i64 {
        Some(j as usize)
    } else if closed {
        Some(j.rem_euclid(n as i64) as usize)
    } else {
        None
    };
    k.filter(|&k| k != excluding)
}

/// Kante (a, b) eines Rings/einer Kette um das Delta verschieben, winkeltreu an den Nachbar-Ecken
/// (`movePolygonEdge`); `None`, wenn a oder b kein Punkt ist.
pub fn move_polygon_edge(pts: &[Value], a: f64, b: f64, dx: f64, dy: f64, closed: bool) -> Option<Value> {
    let n = pts.len();
    let (ai, bi) = (index_in(a, n)?, index_in(b, n)?);
    let (pa, pb) = (xy(&pts[ai]), xy(&pts[bi]));
    let shifted = (pa.0 + dx, pa.1 + dy);
    let edge_dir = (pb.0 - pa.0, pb.1 - pa.1);
    let prev = ring_neighbor(ai, n, closed, -1, bi).map(|k| xy(&pts[k]));
    let next = ring_neighbor(bi, n, closed, 1, ai).map(|k| xy(&pts[k]));
    Some(Value::Array(
        pts.iter()
            .enumerate()
            .map(|(i, p)| {
                if i == ai {
                    let q = edge_move_vertex(pa, prev, shifted, edge_dir, dx, dy);
                    pt(q.0, q.1)
                } else if i == bi {
                    let q = edge_move_vertex(pb, next, shifted, edge_dir, dx, dy);
                    pt(q.0, q.1)
                } else {
                    p.clone()
                }
            })
            .collect(),
    ))
}

// ── Grösse um einen Anker ────────────────────────────────────────────────────

type BBox = (f64, f64, f64, f64);

/// bbox einer Punktliste (`bbox2`; nicht endlich → Null-Box).
fn bbox(pts: &[(f64, f64)]) -> BBox {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in pts {
        x0 = jsnum::min(x0, p.0);
        y0 = jsnum::min(y0, p.1);
        x1 = jsnum::max(x1, p.0);
        y1 = jsnum::max(y1, p.1);
    }
    if !x0.is_finite() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    (x0, y0, x1, y1)
}

/// Anker und Faktoren, um eine bbox auf w × h zu bringen (`scaleAround`; Null-Ausdehnung → Faktor 1).
fn scale_around(b: BBox, w: f64, h: f64, fx: f64, fy: f64) -> (f64, f64, f64, f64) {
    let bw = b.2 - b.0;
    let bh = b.3 - b.1;
    let ax = b.0 + fx * bw;
    let ay = b.1 + fy * bh;
    let sx = if bw > 1e-9 { w / bw } else { 1.0 };
    let sy = if bh > 1e-9 { h / bh } else { 1.0 };
    (ax, ay, sx, sy)
}

/// 2D-Form auf w × h um den Anker skalieren (`resizeGeom`); `None` = Form bleibt (Kote, Bemassung …).
fn resize_geom(g: &Value, w: f64, h: f64, fx: f64, fy: f64) -> Option<Value> {
    let p = |k: &str| xy(g.get(k).unwrap_or(&Value::Null));
    let pts_of = |k: &str| arr(g.get(k)).iter().map(xy).collect::<Vec<_>>();
    let scaled = |(ax, ay, sx, sy): (f64, f64, f64, f64), q: (f64, f64)| (ax + (q.0 - ax) * sx, ay + (q.1 - ay) * sy);
    let ptv = |q: (f64, f64)| pt(q.0, q.1);
    Some(match shape(g) {
        "line" | "xline" | "ray" => {
            let (a, b) = (p("a"), p("b"));
            let s = scale_around(bbox(&[a, b]), w, h, fx, fy);
            with_all(g, vec![("a", ptv(scaled(s, a))), ("b", ptv(scaled(s, b)))])
        }
        "polyline" | "bezier" | "spline" => {
            let pts = pts_of("pts");
            let s = scale_around(bbox(&pts), w, h, fx, fy);
            with(g, "pts", Value::Array(pts.iter().map(|q| ptv(scaled(s, *q))).collect()))
        }
        "rect" | "image" => {
            let (mn, mx) = (p("min"), p("max"));
            let s = scale_around(bbox(&[mn, mx]), w, h, fx, fy);
            let (a, b) = (scaled(s, mn), scaled(s, mx));
            with_all(g, vec![("min", pt(jsnum::min(a.0, b.0), jsnum::min(a.1, b.1))), ("max", pt(jsnum::max(a.0, b.0), jsnum::max(a.1, b.1)))])
        }
        "circle" | "arc" => {
            // bbox eines Kreises ist 2r × 2r; Radius = grössere Zielhälfte, Mitte nicht-uniform um den Anker.
            let c = p("center");
            let r = num_of(g.get("r"));
            let ax = (c.0 - r) + fx * (2.0 * r);
            let ay = (c.1 - r) + fy * (2.0 * r);
            let half = jsnum::max(w, h) / 2.0;
            let nr = if half > 0.0 { Some(js_num(half)) } else { g.get("r").cloned() };
            let sx = if r > 1e-9 { (w / 2.0) / r } else { 1.0 };
            let sy = if r > 1e-9 { (h / 2.0) / r } else { 1.0 };
            with_opt(g, vec![("center", Some(pt(ax + (c.0 - ax) * sx, ay + (c.1 - ay) * sy))), ("r", nr)])
        }
        "ellipse" => {
            let c = p("center");
            let (rx, ry) = (num_of(g.get("rx")), num_of(g.get("ry")));
            let (ax, ay, sx, sy) = scale_around((c.0 - rx, c.1 - ry, c.0 + rx, c.1 + ry), w, h, fx, fy);
            with_all(g, vec![("center", pt(ax + (c.0 - ax) * sx, ay + (c.1 - ay) * sy)), ("rx", js_num(jsnum::max(1e-3, rx * sx))), ("ry", js_num(jsnum::max(1e-3, ry * sy)))])
        }
        "text" | "block" => {
            // Nur die Einfügeposition wandert (Schrifthöhe bzw. Symbol bleiben).
            let at = p("at");
            let s = scale_around((at.0, at.1, at.0, at.1), w, h, fx, fy);
            with(g, "at", ptv(scaled(s, at)))
        }
        _ => return None,
    })
}

// ── Dach, Polylinien-Punkte, Dicken ──────────────────────────────────────────

/// Dach-Eckgriff: die gegenüberliegende Ecke bleibt fix, der Umriss bleibt ein achsparalleles Rechteck.
fn roof_grip(r: &Value, index: f64, x: f64, y: f64) -> Option<Value> {
    let outline = r.get("outline")?.as_array()?;
    let n = outline.len();
    if n < 4 {
        return None;
    }
    let k = index_in((index + 2.0) % n as f64, n)?;
    let opp = xy(&outline[k]);
    let (x0, x1) = (jsnum::min(x, opp.0), jsnum::max(x, opp.0));
    let (y0, y1) = (jsnum::min(y, opp.1), jsnum::max(y, opp.1));
    Some(with(r, "outline", Value::Array(vec![pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)])))
}

/// Punkt in Segment `seg` einer Polylinie einfügen. Ein Bogen wird exakt über die Kreisgeometrie in der
/// Winkel-Mitte geteilt (wie `kernel2d` Bogen-Segmente zuschneidet); eine Näherung über tessellierte
/// Punkte wäre zu ungenau. Die Bulge-Liste wird nur mitgeführt, wenn es eine gab.
fn insert_point(d: &Value, seg: f64, x: f64, y: f64) -> Option<Value> {
    let g = d.get("geom")?;
    if shape(g) != "polyline" {
        return None;
    }
    let pts = arr(g.get("pts"));
    let n = pts.len();
    let k = index_in(seg, n)?;
    let last = k == n - 1;
    if last && !truthy(g.get("closed")) {
        return None;
    }
    let a = xy(&pts[k]);
    let b = xy(if last { &pts[0] } else { &pts[k + 1] });
    let bulge = num_or(arr(g.get("bulge")).get(k), 0.0);
    // `bulgeArc` der Fassade: gerade (|bulge| < 1e-9 oder NaN) ohne Bogen.
    let arc = if bulge.abs() >= 1e-9 { crate::bulge::arc(a.0, a.1, b.0, b.1, bulge) } else { vec![] };
    let (insert, b1, b2) = if arc.len() >= 6 {
        let (cx, cy, r, a0, a1, sweep) = (arc[0], arc[1], arc[2], arc[3], arc[4], arc[5]);
        let mid = a0 + sweep / 2.0;
        let sign = if sweep < 0.0 { -1.0 } else { 1.0 };
        (
            pt(cx + r * jsnum::cos(mid), cy + r * jsnum::sin(mid)),
            crate::bulge::between_angles(cx, cy, r, a0, mid, sign),
            crate::bulge::between_angles(cx, cy, r, mid, a1, sign),
        )
    } else {
        (pt(x, y), 0.0, 0.0)
    };
    let mut np: Vec<Value> = pts[..=k].to_vec();
    np.push(insert);
    np.extend_from_slice(&pts[k + 1..]);
    let mut fields = vec![("pts", Value::Array(np))];
    if truthy(g.get("bulge")) {
        let old = arr(g.get("bulge"));
        let mut nb: Vec<Value> = old.iter().take(k).cloned().collect();
        nb.push(js_num(b1));
        nb.push(js_num(b2));
        nb.extend(old.iter().skip(k + 1).cloned());
        fields.push(("bulge", Value::Array(nb)));
    }
    Some(with_geom(d, with_all(g, fields)))
}

/// `{...layers[0], thickness}` als einzige Schicht.
fn single_layer(layers: &[Value], thickness: f64) -> Value {
    Value::Array(vec![with(&layers[0], "thickness", js_num(thickness))])
}

/// Neuer einschichtiger Typ `{id, name, layers}`.
fn new_type(id: &str, name: Value, layers: &[Value], thickness: f64) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), id.into());
    m.insert("name".into(), name);
    m.insert("layers".into(), single_layer(layers, thickness));
    Value::Object(m)
}

fn add(collection: &str, item: Value) -> Op {
    Op::Add { collection: collection.into(), items: vec![item], at: None }
}

/// Dicke einer einschichtigen Wand (`setWallThickness`): exklusiven einschichtigen Wandtyp direkt
/// ändern, sonst einen eigenen Typ `new_id`/`new_name` anlegen und der Wand zuweisen.
fn wall_thickness(root: &Map<String, Value>, wall_id: &str, thickness: f64, new_id: &str, new_name: Value) -> Vec<Op> {
    if !thickness.is_finite() || thickness <= 0.0 {
        return vec![];
    }
    let Some(wall) = find(root, "walls", wall_id) else { return vec![] };
    let wt_id = wall.get("wallTypeId");
    let Some(wt) = arr(root.get("wallTypes")).iter().find(|t| t.get("id") == wt_id) else { return vec![] };
    let layers = arr(wt.get("layers"));
    if layers.is_empty() {
        return vec![];
    }
    let wt_idv = wt.get("id");
    let used_by_others = arr(root.get("walls")).iter().any(|w| id_of(w) != Some(wall_id) && w.get("wallTypeId") == wt_idv);
    if layers.len() == 1 && !used_by_others {
        let tid = id_of(wt).unwrap_or("");
        return find(root, "wallTypes", tid).map(|t| vec![replace("wallTypes", with(t, "layers", single_layer(arr(t.get("layers")), thickness)))]).unwrap_or_default();
    }
    vec![add("wallTypes", new_type(new_id, new_name, layers, thickness)), replace("walls", with(wall, "wallTypeId", new_id.into()))]
}

/// Dicke einer einschichtigen Decke (`setCeilingThickness`), analog zur Wand; der geteilte
/// Alt-Wandtyp (`Ceiling.wallTypeId`) wird nie verändert.
fn ceiling_thickness(root: &Map<String, Value>, ceiling_id: &str, thickness: f64, new_id: &str, new_name: Value) -> Vec<Op> {
    if !thickness.is_finite() || thickness <= 0.0 {
        return vec![];
    }
    let Some(c) = find(root, "ceilings", ceiling_id) else { return vec![] };
    let active = |c: &Value| -> Option<Value> {
        let v = c.get("ceilingTypeId");
        if nullish(v) { c.get("wallTypeId").cloned() } else { v.cloned() }
    };
    let active_id = active(c);
    let by_id = |coll: &str, id: Option<&Value>| arr(root.get(coll)).iter().find(|t| t.get("id") == id).cloned();
    let Some(ct) = by_id("ceilingTypes", c.get("ceilingTypeId")).or_else(|| by_id("wallTypes", c.get("wallTypeId"))) else { return vec![] };
    let layers = arr(ct.get("layers"));
    if layers.is_empty() {
        return vec![];
    }
    let used_by_others = arr(root.get("ceilings")).iter().any(|o| id_of(o) != Some(ceiling_id) && active(o) == active_id);
    if layers.len() == 1 && !used_by_others && truthy(c.get("ceilingTypeId")) {
        let tid = id_of(&ct).unwrap_or("");
        return find(root, "ceilingTypes", tid).map(|t| vec![replace("ceilingTypes", with(t, "layers", single_layer(arr(t.get("layers")), thickness)))]).unwrap_or_default();
    }
    let mut nc = with(c, "ceilingTypeId", new_id.into());
    if let Value::Object(m) = &mut nc {
        m.shift_remove("thickness");
    }
    vec![add("ceilingTypes", new_type(new_id, new_name, layers, thickness)), replace("ceilings", nc)]
}

// ── Griff-Listen für die Anzeige ─────────────────────────────────────────────

/// Editier-Griffe einer 2D-Zeichnung in Modell-Metern (`drawingVertices`, gleiche Reihenfolge wie
/// [`drawing_grip`]): Ecken; Polylinie zusätzlich je Segment ein Bogen-Mitten-Griff; Kreis Ost/Nord;
/// Bogen Start/Ende/Mitte; Ellipse je Halbachse; Bemassung Kettenpunkte · Masslinie · je Segment die
/// Masszahl; Text Anker · Knicke · Spitze bzw. Pfadpunkte. `None` für die Textspalte (Rahmen-Ecken
/// brauchen die Schrift-Metrik der Hülle, `text/textFrame.ts`).
pub fn drawing_vertices(g: &Value, scale: f64) -> Option<Vec<(f64, f64)>> {
    let p = |k: &str| xy(g.get(k).unwrap_or(&Value::Null));
    let pts = |k: &str| arr(g.get(k)).iter().map(xy).collect::<Vec<_>>();
    Some(match shape(g) {
        "line" | "xline" | "ray" => vec![p("a"), p("b")],
        "polyline" => {
            let bulge = arr(g.get("bulge"));
            polyline_vertices(pts("pts"), truthy(g.get("closed")), |i| num_or(bulge.get(i), 0.0))
        }
        "rect" | "image" => rect_corners(g).to_vec(),
        "circle" => {
            let (c, r) = (p("center"), num_of(g.get("r")));
            vec![(c.0 + r, c.1), (c.0, c.1 + r)]
        }
        "arc" => {
            let (c, r) = (p("center"), num_of(g.get("r")));
            let (a0, a1) = (num_of(g.get("a0")), num_of(g.get("a1")));
            let mid = (a0 + a1) / 2.0;
            [a0, a1, mid].iter().map(|a| (c.0 + r * jsnum::cos(*a), c.1 + r * jsnum::sin(*a))).collect()
        }
        "ellipse" => {
            let rot = num_of(g.get("rotation"));
            let (c, s) = (jsnum::cos(rot), jsnum::sin(rot));
            let ctr = p("center");
            let (rx, ry) = (num_of(g.get("rx")), num_of(g.get("ry")));
            vec![(ctr.0 + rx * c, ctr.1 + rx * s), (ctr.0 - ry * s, ctr.1 + ry * c)]
        }
        "bezier" | "spline" => pts("pts"),
        "dimension" => {
            let mut out = pts("pts");
            let n = out.len();
            let nan = (f64::NAN, f64::NAN);
            let (a, b) = (out.first().copied().unwrap_or(nan), out.last().copied().unwrap_or(nan));
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let len = or1(hypot2(dx, dy));
            let offset = num_of(g.get("offset"));
            let (nx, ny) = ((-dy / len) * offset, (dx / len) * offset);
            out.push(((a.0 + b.0) / 2.0 + nx, (a.1 + b.1) / 2.0 + ny));
            let h = dim_height(g, scale);
            let offs = arr(g.get("textOffsetsMm"));
            for i in 0..n.saturating_sub(1) {
                let (along, perp) = match offs.get(i) {
                    Some(o) if truthy(Some(o)) => (mm_to_model(num_of(o.get("along")), scale), mm_to_model(num_of(o.get("perp")), scale)),
                    _ => (0.0, 0.0),
                };
                out.push(dim_text_pos(out[i], out[i + 1], offset, h, along, perp));
            }
            out
        }
        "kote" | "detailref" | "scalebar" | "pointmarker" | "block" => vec![p("at")],
        "text" => {
            if truthy(g.get("pathPts")) {
                pts("pathPts")
            } else if truthy(g.get("leaderTarget")) {
                let mut out = vec![p("at")];
                out.extend(pts("leaderBendPoints"));
                out.push(p("leaderTarget"));
                out
            } else if truthy(g.get("width")) && num_of(g.get("width")) > 0.0 {
                return None;
            } else {
                vec![p("at")]
            }
        }
        _ => vec![],
    })
}

/// Griffe einer Polylinie: die Eckpunkte, dahinter je Segment ein Bogen-Mitten-Griff (Scheitel des
/// Bogens bzw. Sehnen-Mitte); `bulge(i)` = Bogen von Segment `i` (fehlend 0).
pub fn polyline_vertices(mut out: Vec<(f64, f64)>, closed: bool, bulge: impl Fn(usize) -> f64) -> Vec<(f64, f64)> {
    let n = out.len();
    let close = closed && n > 2;
    let seg_count = n.saturating_sub(1) + usize::from(close);
    for i in 0..seg_count {
        let a = out[i];
        let b = if i == n - 1 { out[0] } else { out[i + 1] };
        let q = crate::bulge::point_at(a.0, a.1, b.0, b.1, bulge(i), 0.5);
        out.push((q[0], q[1]));
    }
    out
}

/// Kanten-Griffe (`ringEdges`/`openEdges`): je Kante `(a, b, Mitte, Normale)`. Ring: Normale nach
/// aussen (vom Eckpunkt-Mittel weg), auch die Schlusskante; Kette: linke Normale, ohne Schlusskante.
/// `bulge` (Polylinie): Kanten an Bogen-Segmenten fallen weg (die haben ihren Bogen-Mitten-Griff).
pub fn edge_grips(verts: &[(f64, f64)], closed: bool, bulge: Option<&[f64]>) -> Vec<(usize, usize, (f64, f64), (f64, f64))> {
    let n = verts.len();
    if (closed && n < 3) || n < 2 {
        return vec![];
    }
    let (mut cx, mut cy) = (0.0, 0.0);
    for v in verts {
        cx += v.0;
        cy += v.1;
    }
    let ctr = (cx / n as f64, cy / n as f64);
    let count = if closed { n } else { n - 1 };
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let j = (i + 1) % n;
        if bulge.is_some_and(|b| !(b.get(i).copied().unwrap_or(0.0).abs() <= 1e-9)) {
            continue;
        }
        let (a, b) = (verts[i], verts[j]);
        let mid = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
        let (lx, ly) = (-(b.1 - a.1), b.0 - a.0);
        let l = or1(hypot2(lx, ly));
        let mut nrm = (lx / l, ly / l);
        if closed {
            let out_dir = (mid.0 - ctr.0, mid.1 - ctr.1);
            if nrm.0 * out_dir.0 + nrm.1 * out_dir.1 < 0.0 {
                nrm = (nrm.0 * -1.0, nrm.1 * -1.0);
            }
        }
        out.push((i, j, mid, nrm));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn entity(r: &GripResult) -> &Value {
        match &r.ops[0] {
            Op::Replace { entity, .. } => entity,
            _ => panic!("replace erwartet"),
        }
    }

    #[test]
    fn js_zahlen() {
        assert_eq!(js_num(5.0).to_string(), "5");
        assert_eq!(js_num(-0.0).to_string(), "0");
        assert_eq!(js_num(-3.0).to_string(), "-3");
        assert_eq!(js_num(0.5).to_string(), "0.5");
        assert_eq!(js_num(f64::NAN), json!("\u{1}NaN"));
        assert_eq!(js_num(f64::NEG_INFINITY), json!("\u{1}-Infinity"));
        assert_eq!(num_of(Some(&json!("\u{1}Infinity"))), f64::INFINITY);
        assert_eq!(num_of(Some(&Value::Null)), 0.0);
        assert!(num_of(None).is_nan());
    }

    #[test]
    fn wand_griff_und_sperre() {
        let r = root(json!({"walls": [{"id": "w", "start": {"x": 0, "y": 0}, "end": {"x": 1, "y": 0}, "extra": 1}]}));
        let res = run(&r, &json!({"op": "moveGrip", "wallId": "w", "index": 1, "pt": [2, 3]})).unwrap();
        assert_eq!(entity(&res).to_string(), r#"{"id":"w","start":{"x":0,"y":0},"end":{"x":2,"y":3},"extra":1}"#);
        let locked = root(json!({"walls": [{"id": "w", "locked": true, "start": {"x": 0, "y": 0}, "end": {"x": 1, "y": 0}}]}));
        assert!(run(&locked, &json!({"op": "moveGrip", "wallId": "w", "index": 1, "pt": [2, 3]})).unwrap().ops.is_empty());
        // Fehlendes Element: keine Op.
        assert!(run(&r, &json!({"op": "moveGrip", "wallId": "x", "index": 1, "pt": [2, 3]})).unwrap().ops.is_empty());
    }

    #[test]
    fn kreis_wird_ellipse() {
        let r = root(json!({"drawings2d": [{"id": "d", "geom": {"shape": "circle", "center": {"x": 0, "y": 0}, "r": 1}}]}));
        let res = run(&r, &json!({"op": "moveGrip", "drawingId": "d", "index": 0, "pt": [2, 0]})).unwrap();
        assert_eq!(entity(&res)["geom"].to_string(), r#"{"shape":"ellipse","center":{"x":0,"y":0},"rx":2,"ry":1,"rotation":0}"#);
    }

    #[test]
    fn kante_winkeltreu() {
        // Trapez: die obere Kante nach oben ziehen, die Ecken wandern entlang der Schrägen.
        let pts: Vec<Value> = [(0.0, 0.0), (4.0, 0.0), (3.0, 1.0), (1.0, 1.0)].iter().map(|p| pt(p.0, p.1)).collect();
        let out = move_polygon_edge(&pts, 2.0, 3.0, 0.0, 1.0, true).unwrap();
        assert_eq!(out.to_string(), r#"[{"x":0,"y":0},{"x":4,"y":0},{"x":2,"y":2},{"x":2,"y":2}]"#);
        assert!(move_polygon_edge(&pts, 4.0, 0.0, 0.0, 1.0, true).is_none());
    }

    #[test]
    fn nan_als_marke() {
        let r = root(json!({"walls": [{"id": "w", "start": {"x": 0, "y": 0}, "end": {"x": 1, "y": 0}}]}));
        let res = run(&r, &json!({"op": "moveBy", "wallId": "w", "delta": ["\u{1}NaN", 0]})).unwrap();
        assert_eq!(entity(&res)["start"]["x"], json!("\u{1}NaN"));
    }

    #[test]
    fn punkt_loeschen_mindestzahl() {
        let r = root(json!({"drawings2d": [{"id": "d", "geom": {"shape": "polyline", "closed": false, "pts": [{"x": 0, "y": 0}, {"x": 1, "y": 0}]}}]}));
        let res = run(&r, &json!({"op": "deletePoint", "id": "d", "index": 0})).unwrap();
        assert_eq!(res.notice, Some("alert.polylineMinPoints"));
        assert!(res.ops.is_empty());
    }

    #[test]
    fn deckendicke_neuer_typ() {
        let r = root(json!({
            "wallTypes": [{"id": "wt", "name": "W", "layers": [{"componentId": "c", "thickness": 0.2}]}],
            "ceilings": [{"id": "c1", "wallTypeId": "wt", "thickness": 0.3}, {"id": "c2", "wallTypeId": "wt"}],
        }));
        let ops = run(&r, &json!({"op": "ceilingThickness", "id": "c1", "thickness": 0.25, "newId": "ct-1", "newName": "Decke"})).unwrap().ops;
        assert_eq!(crate::ops::ops_to_json(&ops), r#"[{"kind":"add","collection":"ceilingTypes","items":[{"id":"ct-1","name":"Decke","layers":[{"componentId":"c","thickness":0.25}]}]},{"kind":"replace","collection":"ceilings","entity":{"id":"c1","wallTypeId":"wt","ceilingTypeId":"ct-1"}}]"#);
    }

    #[test]
    fn griffe_und_kanten() {
        let g = json!({"shape": "polyline", "closed": true, "pts": [{"x": 0, "y": 0}, {"x": 2, "y": 0}, {"x": 2, "y": 2}], "bulge": [0, 0.5, 0]});
        let v = drawing_vertices(&g, 100.0).unwrap();
        assert_eq!(v.len(), 6);
        assert_eq!(v[3], (1.0, 0.0));
        let e = edge_grips(&v[..3], true, Some(&[0.0, 0.5, 0.0]));
        assert_eq!(e.iter().map(|x| (x.0, x.1)).collect::<Vec<_>>(), vec![(0, 1), (2, 0)]);
        assert_eq!(e[0].3, (0.0, -1.0));
        let text = json!({"shape": "text", "at": {"x": 0, "y": 0}, "width": 2});
        assert!(drawing_vertices(&text, 100.0).is_none());
    }
}
