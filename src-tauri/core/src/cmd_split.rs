//! Split und Segment löschen für 2D-Zeichnungen im Kern ([K4] S3, vorher `editors/splitJoin.ts`
//! und die Aufrufer in `App.tsx`):
//!
//! - **Split** (`{cmd: "split", ids, stamp}`): jede gewählte Zeichnung (Linie, Polylinie ohne Bögen,
//!   Rechteck) wird an ihren Schnittpunkten mit den übrigen Zeichnungen desselben Geschosses geteilt
//!   (geschlossen + zwei Schnitte → zwei geschlossene Hälften über die Sehne); ohne Schnitt an der
//!   Mitte (offen: längste Kante; geschlossen: Kante 0 und die gegenüberliegende). Die Stücke ersetzen
//!   das Original an seiner Stelle (`remove` + `add` mit Position), neue ids `d2d-stamp-k`; Stil,
//!   Kategorie und Geschoss werden geerbt (Füllung/Schraffur nur an geschlossene Stücke).
//! - **Segment löschen** (`{cmd: "cutSegment", id, at}`, Alt+Klick): die dem Punkt `at` nächste Kante
//!   (bei Bögen gegen die tessellierte Kurve gemessen) fällt weg; geschlossen → offene Polylinie,
//!   Bögen bleiben an ihrem Punktepaar. Das Element behält id und alle Attribute (nur `geom` neu;
//!   Füllung/Schraffur fallen weg, weil das Ergebnis offen ist). Bleiben weniger als zwei Punkte,
//!   wird es gelöscht. (Die TS-Fassung erzeugte ein Element mit NEUER id und schickte es als
//!   `replace` — das traf nichts, hängte die Kopie an und liess das Original stehen.)
//!
//! Rechnung auf der rohen Projekt-Wurzel; Geometrie aus `kernel2d` (dieselben Funktionen wie
//! vorher über die Bindungen).

use crate::cmd_transform::IdGen;
use crate::grips::{arr, field, js_num, num_of, pt, truthy, with_opt, xy};
use crate::jsmath::hypot2;
use crate::jsnum;
use crate::ops::{id_of, Op};
use kernel2d::{self as k, Vec2 as P};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// Echter Bogen ab diesem |bulge| (`hasRealBulge`).
const EPS_BULGE: f64 = 1e-9;
const DRAWINGS: &str = "drawings2d";

fn p_of(v: &Value) -> P {
    let (x, y) = xy(v);
    P::new(x, y)
}

fn real(b: &[f64]) -> bool {
    b.iter().any(|x| x.abs() > EPS_BULGE)
}

/// Polylinien-Form einer Zeichnung (`toPolyForm` / `toPolyFormAllowBulge`).
struct Form {
    pts: Vec<P>,
    /// `closed` roh (fehlend = `None`; Rechteck `true`, Linie `false`).
    closed: Option<Value>,
    /// Bogen-Werte roh (nur Polylinie mit `allow_bulge`).
    bulge: Option<Vec<Value>>,
}

impl Form {
    fn is_closed(&self) -> bool {
        truthy(self.closed.as_ref())
    }
    fn bulge_nums(&self) -> Vec<f64> {
        self.bulge.as_deref().map(|b| b.iter().map(|x| num_of(Some(x))).collect()).unwrap_or_default()
    }
}

fn poly_form(g: &Value, allow_bulge: bool) -> Option<Form> {
    let pts_of = |k: &str| arr(field(g, k)).iter().map(p_of).collect::<Vec<P>>();
    match field(g, "shape").and_then(Value::as_str).unwrap_or("") {
        "line" => {
            let (a, b) = (field(g, "a").map_or(P::new(f64::NAN, f64::NAN), p_of), field(g, "b").map_or(P::new(f64::NAN, f64::NAN), p_of));
            Some(Form { pts: vec![a, b], closed: Some(Value::Bool(false)), bulge: None })
        }
        "polyline" => {
            let bulge = field(g, "bulge").and_then(Value::as_array).cloned();
            let has = bulge.as_deref().is_some_and(|b| real(&b.iter().map(|x| num_of(Some(x))).collect::<Vec<_>>()));
            if has && !allow_bulge {
                return None;
            }
            Some(Form { pts: pts_of("pts"), closed: field(g, "closed").cloned(), bulge: if allow_bulge { bulge } else { None } })
        }
        "rect" => {
            let (a, b) = (field(g, "min").map_or(P::new(f64::NAN, f64::NAN), p_of), field(g, "max").map_or(P::new(f64::NAN, f64::NAN), p_of));
            Some(Form { pts: vec![a, P::new(b.x, a.y), b, P::new(a.x, b.y)], closed: Some(Value::Bool(true)), bulge: None })
        }
        _ => None,
    }
}

/// Geometrie aus einer Polylinien-Form (`fromPolyForm`): zwei Punkte, offen, ohne Bogen → Linie.
fn from_form(pts: &[P], closed: Option<Value>, bulge: Option<&[f64]>) -> Value {
    let has_bulge = bulge.is_some_and(real);
    let mut m = Map::new();
    if pts.len() == 2 && !truthy(closed.as_ref()) && !has_bulge {
        m.insert("shape".into(), "line".into());
        m.insert("a".into(), pt(pts[0].x, pts[0].y));
        m.insert("b".into(), pt(pts[1].x, pts[1].y));
        return Value::Object(m);
    }
    m.insert("shape".into(), "polyline".into());
    m.insert("pts".into(), Value::Array(pts.iter().map(|p| pt(p.x, p.y)).collect()));
    if let Some(c) = closed {
        m.insert("closed".into(), c);
    }
    if let (true, Some(b)) = (has_bulge, bulge) {
        m.insert("bulge".into(), Value::Array(b.iter().map(|x| js_num(*x)).collect()));
    }
    Value::Object(m)
}

/// Neues Element mit Stil/Kategorie/Geschoss der Quelle (`inherit`).
fn inherit(src: &Value, geom: Value, id: String) -> Value {
    let closed = field(&geom, "shape").and_then(Value::as_str) == Some("polyline") && truthy(field(&geom, "closed"));
    let mut m = Map::new();
    m.insert("id".into(), Value::String(id));
    m.insert("type".into(), "drawing2d".into());
    for k in ["levelId", "categoryCode"] {
        if let Some(v) = field(src, k) {
            m.insert(k.into(), v.clone());
        }
    }
    m.insert("geom".into(), geom);
    let mut copy = |k: &str| {
        if let Some(v) = field(src, k) {
            m.insert(k.into(), v.clone());
        }
    };
    copy("lineStyleId");
    copy("color");
    copy("weightMm");
    if closed {
        copy("hatchId");
        copy("fillColor");
    }
    Value::Object(m)
}

/// Teilung ohne Schnitt (`fallbackSplit`).
fn fallback_split(f: &Form) -> Vec<Vec<P>> {
    let pts = &f.pts;
    let n = pts.len();
    if n < 2 {
        return vec![pts.clone()];
    }
    if !f.is_closed() {
        let (mut best, mut best_len) = (0, -1.0);
        for i in 0..n - 1 {
            let d = hypot2(pts[i].x - pts[i + 1].x, pts[i].y - pts[i + 1].y);
            if d > best_len {
                best_len = d;
                best = i;
            }
        }
        return k::split_polyline_at_param(pts, false, best, 0.5);
    }
    let j = 1.max(n / 2) % n;
    if j == 0 {
        return vec![pts.clone()];
    }
    match k::split_closed_by_chord(pts, 0, 0.5, j, 0.5) {
        Some((a, b)) => vec![a, b],
        None => vec![pts.clone()],
    }
}

/// Stücke einer Zeichnung (`splitDrawing`); `None` = unverändert.
fn split_drawing(src: &Value, others: &[Vec<P>], ids: &mut IdGen) -> Option<Vec<Value>> {
    let form = poly_form(field(src, "geom").unwrap_or(&Value::Null), false)?;
    let mut pieces = k::split_at_intersections(&form.pts, form.is_closed(), others);
    if pieces.len() < 2 {
        pieces = fallback_split(&form);
    }
    if pieces.len() < 2 {
        return None;
    }
    // `form.closed && pieces.length === 2` (JS: ein falscher Wert bleibt, wie er ist).
    let closed = if form.is_closed() { Some(Value::Bool(pieces.len() == 2)) } else { form.closed.clone() };
    Some(pieces.iter().map(|p| inherit(src, from_form(p, closed.clone(), None), ids.next("d2d"))).collect())
}

/// Split der Zeichnungen `ids`: Stücke ersetzen das Original an seiner Stelle (`replaceWithMany`).
pub fn split_ops(root: &Map<String, Value>, ids: &[String], stamp: &str) -> Vec<Op> {
    let list = arr(root.get(DRAWINGS));
    let want: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut gen = IdGen::new(stamp);
    // id → (Stücke, Position der unveränderten Quelle); spätere gleiche ids überschreiben (wie `Map.set`).
    let mut repl: HashMap<&str, (Vec<Value>, Option<usize>)> = HashMap::new();
    for (i, d) in list.iter().enumerate() {
        let Some(id) = id_of(d).filter(|x| want.contains(x)) else { continue };
        let level = field(d, "levelId");
        let others: Vec<Vec<P>> = list
            .iter()
            .filter(|o| id_of(o) != Some(id) && field(o, "levelId") == level)
            .filter_map(|o| poly_form(field(o, "geom").unwrap_or(&Value::Null), false))
            .map(|f| {
                let mut pts = f.pts;
                if f.closed.as_ref().is_some_and(|c| truthy(Some(c))) && pts.len() > 2 {
                    pts.push(pts[0]);
                }
                pts
            })
            .collect();
        let entry = match split_drawing(d, &others, &mut gen) {
            Some(pieces) => (pieces, None),
            None => (vec![d.clone()], Some(i)),
        };
        repl.insert(id, entry);
    }
    let mut dropped: Vec<String> = Vec::new();
    let mut inserts: Vec<(usize, Vec<Value>)> = Vec::new();
    let mut len = 0;
    for (i, e) in list.iter().enumerate() {
        let Some((id, (items, same))) = id_of(e).and_then(|id| repl.get(id).map(|r| (id, r))) else {
            len += 1;
            continue;
        };
        if *same == Some(i) {
            len += 1;
            continue;
        }
        dropped.push(id.to_owned());
        if !items.is_empty() {
            inserts.push((len, items.clone()));
        }
        len += items.len();
    }
    if dropped.is_empty() {
        return vec![];
    }
    let mut ops = vec![Op::Remove { collection: DRAWINGS.into(), ids: dropped }];
    ops.extend(inserts.into_iter().map(|(at, items)| Op::Add { collection: DRAWINGS.into(), items, at: Some(at) }));
    ops
}

/// Punkt-Argument `{x, y}` einer Anfrage (fehlend = NaN).
pub fn point_arg(v: &Value, k: &str) -> P {
    v.get(k).map_or(P::new(f64::NAN, f64::NAN), p_of)
}

/// Abstand Punkt → Strecke (`segDist` in `splitJoin.ts`).
fn seg_dist(p: P, a: P, b: P) -> f64 {
    let (abx, aby) = (b.x - a.x, b.y - a.y);
    let l2 = abx * abx + aby * aby;
    let t = if l2 > 0.0 { ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2 } else { 0.0 };
    let t = jsnum::max(0.0, jsnum::min(1.0, t));
    hypot2(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
}

/// Index der Kante, die `p` am nächsten liegt (`nearestEdgeIndex`); Bögen gegen die Kurve gemessen.
fn nearest_edge(f: &Form, p: P) -> Option<usize> {
    let n = f.pts.len();
    if n < 2 {
        return None;
    }
    let edges = if f.is_closed() { n } else { n - 1 };
    let bulged = real(&f.bulge_nums());
    let (mut best, mut best_d) = (None, f64::INFINITY);
    for i in 0..edges {
        let (a, b) = (f.pts[i], f.pts[(i + 1) % n]);
        let arc: Vec<P> = match f.bulge.as_deref().and_then(|bl| bl.get(i)).filter(|_| bulged) {
            // `bulgeArcPoints`: undefined/0 → Gerade, sonst über die Bogen-Formel (null → 0).
            Some(v) if v.as_f64() != Some(0.0) => {
                crate::bulge::arc_points(a.x, a.y, b.x, b.y, num_of(Some(v))).chunks_exact(2).map(|c| P::new(c[0], c[1])).collect()
            }
            _ => vec![a, b],
        };
        for w in arc.windows(2) {
            let d = seg_dist(p, w[0], w[1]);
            if d < best_d {
                best_d = d;
                best = Some(i);
            }
        }
    }
    best
}

/// Segment löschen: Kante nächst `at` aus der Zeichnung `id` entfernen (s. Modul-Doku).
pub fn cut_segment_ops(root: &Map<String, Value>, id: &str, at: P) -> Vec<Op> {
    let Some(d) = arr(root.get(DRAWINGS)).iter().find(|d| id_of(d) == Some(id)) else { return vec![] };
    let Some(form) = poly_form(field(d, "geom").unwrap_or(&Value::Null), true) else { return vec![] };
    let Some(edge) = nearest_edge(&form, at) else { return vec![] };
    let bulge = form.bulge_nums();
    let (pts, bulge) = if real(&bulge) {
        let r = k::remove_segment_with_bulge(&form.pts, &bulge, form.is_closed(), edge);
        (r.pts, Some(r.bulge))
    } else {
        (k::remove_segment(&form.pts, form.is_closed(), edge).pts, None)
    };
    if pts.len() < 2 {
        return vec![Op::Remove { collection: DRAWINGS.into(), ids: vec![id.to_owned()] }];
    }
    let geom = from_form(&pts, Some(Value::Bool(false)), bulge.as_deref());
    let entity = with_opt(d, vec![("geom", Some(geom)), ("hatchId", None), ("fillColor", None)]);
    vec![Op::Replace { collection: DRAWINGS.into(), entity }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }
    fn poly(id: &str, pts: &[(f64, f64)], closed: bool) -> Value {
        let pts: Vec<Value> = pts.iter().map(|p| json!({"x": p.0, "y": p.1})).collect();
        json!({"id": id, "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "polyline", "pts": pts, "closed": closed}})
    }
    fn json_ops(ops: &[Op]) -> Vec<Value> {
        ops.iter().map(Op::to_json).collect()
    }

    #[test]
    fn segment_loeschen_ersetzt_an_ort_und_stelle_mit_derselben_id() {
        let mut d = poly("p", &[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (2.0, 1.0)], false);
        d["color"] = json!("#f00");
        d["locked"] = json!(false);
        let r = root(json!({"drawings2d": [poly("x", &[(5.0, 5.0), (6.0, 5.0)], false), d]}));
        let ops = json_ops(&cut_segment_ops(&r, "p", P::new(1.9, 1.0)));
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["kind"], "replace");
        let e = &ops[0]["entity"];
        assert_eq!(e["id"], "p");
        assert_eq!(e["color"], "#f00");
        assert_eq!(e["locked"], false);
        assert_eq!(e["geom"], json!({"shape": "polyline", "pts": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "closed": false}));
        // Angewendet: gleich viele Elemente, das Original ist ersetzt.
        let mut doc = crate::document::Document::from_json(&serde_json::to_string(&Value::Object(r)).unwrap()).unwrap();
        doc.apply(&cut_segment_ops(doc.root(), "p", P::new(1.9, 1.0))).unwrap();
        let after = arr(doc.root().get("drawings2d"));
        assert_eq!(after.len(), 2);
        assert_eq!(after[1]["geom"]["pts"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn segment_loeschen_geschlossen_wird_offen_ohne_fuellung_linie_wird_geloescht() {
        let mut sq = poly("q", &[(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)], true);
        sq["fillColor"] = json!("#0f0");
        sq["hatchId"] = json!("h1");
        let line = json!({"id": "l", "levelId": "eg", "geom": {"shape": "line", "a": {"x": 0, "y": 5}, "b": {"x": 3, "y": 5}}});
        let r = root(json!({"drawings2d": [sq, line]}));
        let e = &json_ops(&cut_segment_ops(&r, "q", P::new(1.0, 0.1)))[0]["entity"];
        assert_eq!(e["id"], "q");
        assert!(e.get("fillColor").is_none() && e.get("hatchId").is_none());
        assert_eq!(e["geom"]["closed"], false);
        assert_eq!(e["geom"]["pts"], json!([{"x": 2, "y": 0}, {"x": 2, "y": 2}, {"x": 0, "y": 2}, {"x": 0, "y": 0}]));
        assert_eq!(json_ops(&cut_segment_ops(&r, "l", P::new(1.0, 5.0))), vec![json!({"kind": "remove", "collection": "drawings2d", "ids": ["l"]})]);
        assert!(cut_segment_ops(&r, "fehlt", P::new(0.0, 0.0)).is_empty());
    }

    #[test]
    fn segment_loeschen_misst_boegen_gegen_die_kurve_und_behaelt_sie() {
        // Halbkreis-Bogen auf Kante 0 (bulge 1, Ausbuchtung nach -y), gerade Kante 1.
        let d = json!({"id": "b", "levelId": "eg", "geom": {"shape": "polyline", "pts": [{"x": -1, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 3}], "closed": false, "bulge": [1, 0]}});
        let r = root(json!({"drawings2d": [d]}));
        // Punkt nahe am Bogen-Scheitel (0, -1): Kante 0 (gegen die Sehne gemessen wäre Kante 1 näher).
        let e = &json_ops(&cut_segment_ops(&r, "b", P::new(0.9, -0.5)))[0]["entity"];
        assert_eq!(e["geom"], json!({"shape": "line", "a": {"x": 1, "y": 0}, "b": {"x": 1, "y": 3}}));
        let e = &json_ops(&cut_segment_ops(&r, "b", P::new(1.1, 2.0)))[0]["entity"];
        assert_eq!(e["geom"]["shape"], "polyline");
        assert_eq!(e["geom"]["bulge"], json!([1]));
    }

    #[test]
    fn split_an_schnittpunkten_ersetzt_an_der_stelle() {
        let a = json!({"id": "a", "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "color": "#123", "geom": {"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 10, "y": 0}}});
        let b = json!({"id": "b", "levelId": "eg", "geom": {"shape": "line", "a": {"x": 5, "y": -1}, "b": {"x": 5, "y": 1}}});
        let other_level = json!({"id": "c", "levelId": "og", "geom": {"shape": "line", "a": {"x": 2, "y": -1}, "b": {"x": 2, "y": 1}}});
        let r = root(json!({"drawings2d": [b.clone(), a, other_level]}));
        let ops = json_ops(&split_ops(&r, &["a".into()], "s"));
        assert_eq!(ops[0], json!({"kind": "remove", "collection": "drawings2d", "ids": ["a"]}));
        assert_eq!(ops[1]["at"], 1);
        let items = ops[1]["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], json!({"id": "d2d-s-1", "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 5, "y": 0}}, "color": "#123"}));
        assert_eq!(items[1]["geom"]["b"], json!({"x": 10, "y": 0}));
    }

    #[test]
    fn split_ohne_schnitt_an_der_mitte_geschlossen_in_zwei_geschlossene() {
        let mut sq = poly("q", &[(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)], true);
        sq["hatchId"] = json!("h");
        let r = root(json!({"drawings2d": [sq, json!({"id": "t", "geom": {"shape": "text"}})]}));
        let ops = json_ops(&split_ops(&r, &["q".into(), "t".into()], "s"));
        assert_eq!(ops.len(), 2);
        let items = ops[1]["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        for it in items {
            assert_eq!(it["geom"]["closed"], true);
            assert_eq!(it["hatchId"], "h");
        }
        // Nicht teilbar (Text) → keine Op.
        assert!(split_ops(&r, &["t".into()], "s").is_empty());
    }
}
