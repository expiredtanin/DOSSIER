//! Verschiebung des ganzen Projekts um einen festen Vektor ([K4] S3, vorher `translateProject` in
//! `src/model/geoRebase.ts`; Befehl „Neuer Bezugspunkt", Welt-Koordinaten für DXF/IFC-Export): reine
//! Translation aller Modell-Koordinaten (Wände, Decken, Dächer, Treppen, Räume, Stützen, Extrusionen,
//! 2D-Zeichnungen, Kontext-Schicht, Schnitt-/Ansichtslinien, Geo-Anker). Richtungsvektoren und Winkel
//! bleiben, Höhen (z) auch. Rechnung auf der rohen Projekt-Wurzel (`serde_json`).
//!
//! Wie in TS bestehen verschobene Punkte nur aus `x`/`y` (weitere Felder eines Punkts entfallen).

use serde_json::{json, Map, Value};

/// Projekt-Listen, die verschoben werden (jedes Element hat eine `id`), in Op-Reihenfolge.
pub const TRANSLATED_LISTS: [&str; 10] = ["walls", "ceilings", "roofs", "stairs", "rooms", "columns", "extrudedSolids", "drawings2d", "context", "drawingLevels"];

fn shift(p: &Value, dx: f64, dy: f64) -> Value {
    let c = |k: &str| p.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN);
    json!({"x": c("x") + dx, "y": c("y") + dy})
}

fn shift_all(v: Option<&Value>, dx: f64, dy: f64) -> Value {
    Value::Array(v.and_then(Value::as_array).map(|a| a.iter().map(|p| shift(p, dx, dy)).collect()).unwrap_or_default())
}

use crate::grips::truthy;

/// `{...m, key: v}` — ein vorhandener Schlüssel behält seine Stelle; `None` = `undefined` (Feld entfällt).
fn set(m: &mut Map<String, Value>, key: &str, v: Option<Value>) {
    match v {
        Some(v) => {
            m.insert(key.to_string(), v);
        }
        None => {
            m.shift_remove(key);
        }
    }
}

fn obj(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// Felder `keys` (je ein Punkt) einer Geometrie verschieben.
fn shift_pts_fields(g: &mut Map<String, Value>, keys: &[&str], dx: f64, dy: f64, lists: &[&str]) {
    for k in keys {
        if let Some(p) = g.get(*k) {
            let n = shift(p, dx, dy);
            g.insert((*k).to_string(), n);
        }
    }
    for k in lists {
        if g.contains_key(*k) {
            let n = shift_all(g.get(*k), dx, dy);
            g.insert((*k).to_string(), n);
        }
    }
}

/// Geometrie einer 2D-Zeichnung verschieben (`switch (g.shape)`).
fn shift_geom(g: &Value, dx: f64, dy: f64) -> Value {
    let mut m = obj(g);
    match g.get("shape").and_then(Value::as_str).unwrap_or("") {
        "line" | "xline" | "ray" => shift_pts_fields(&mut m, &["a", "b"], dx, dy, &[]),
        "polyline" | "bezier" | "spline" | "dimension" => shift_pts_fields(&mut m, &[], dx, dy, &["pts"]),
        "rect" | "image" => shift_pts_fields(&mut m, &["min", "max"], dx, dy, &[]),
        "circle" | "arc" | "ellipse" => shift_pts_fields(&mut m, &["center"], dx, dy, &[]),
        "kote" | "detailref" | "scalebar" | "pointmarker" | "block" => shift_pts_fields(&mut m, &["at"], dx, dy, &[]),
        "text" => {
            shift_pts_fields(&mut m, &["at"], dx, dy, &[]);
            if truthy(g.get("leaderTarget")) {
                shift_pts_fields(&mut m, &["leaderTarget"], dx, dy, &[]);
            }
            for k in ["leaderBendPoints", "pathPts"] {
                if truthy(g.get(k)) {
                    shift_pts_fields(&mut m, &[], dx, dy, &[k]);
                }
            }
        }
        _ => {}
    }
    Value::Object(m)
}

/// Kontur: Punkte und Mitte eines Kreisbogens (`curve.cx/cy`).
fn shift_contour(c: &Value, dx: f64, dy: f64) -> Value {
    let mut m = obj(c);
    set(&mut m, "pts", Some(shift_all(c.get("pts"), dx, dy)));
    let curve = if truthy(c.get("curve")) {
        let mut cv = obj(&c["curve"]);
        let n = |k: &str, d: f64| cv.get(k).and_then(Value::as_f64).map_or(f64::NAN, |v| v + d);
        let (cx, cy) = (n("cx", dx), n("cy", dy));
        cv.insert("cx".into(), json!(cx));
        cv.insert("cy".into(), json!(cy));
        Some(Value::Object(cv))
    } else {
        None
    };
    set(&mut m, "curve", curve);
    Value::Object(m)
}

/// Kontext-Objekt: Konturen-Satz, Bild (min/max) oder Mesh (`positions` = flache `[x, y, z]`-Tripel, nur x/y).
fn shift_context(o: &Value, dx: f64, dy: f64) -> Value {
    let mut m = obj(o);
    match o.get("type").and_then(Value::as_str) {
        Some("contourSet") => {
            let cs: Vec<Value> = o.get("contours").and_then(Value::as_array).map(|a| a.iter().map(|c| shift_contour(c, dx, dy)).collect()).unwrap_or_default();
            set(&mut m, "contours", Some(Value::Array(cs)));
        }
        Some("image") => shift_pts_fields(&mut m, &["min", "max"], dx, dy, &[]),
        _ => {
            let mut pos: Vec<Value> = o.get("positions").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut i = 0;
            while i + 2 < pos.len() {
                let a = pos[i].as_f64().unwrap_or(f64::NAN) + dx;
                let b = pos[i + 1].as_f64().unwrap_or(f64::NAN) + dy;
                pos[i] = json!(a);
                pos[i + 1] = json!(b);
                i += 3;
            }
            set(&mut m, "positions", Some(Value::Array(pos)));
        }
    }
    Value::Object(m)
}

/// Ein Listen-Element verschieben; `false` = unverändert (nur Zeichenebenen ohne `linePoints`).
fn shift_element(key: &str, e: &Value, dx: f64, dy: f64) -> (Value, bool) {
    let mut m = obj(e);
    match key {
        "walls" => shift_pts_fields(&mut m, &["start", "end"], dx, dy, &[]),
        "ceilings" => {
            shift_pts_fields(&mut m, &[], dx, dy, &["outline"]);
            if let Some(h) = e.get("openings").and_then(Value::as_array) {
                let n: Vec<Value> = h.iter().map(|h| shift_all(Some(h), dx, dy)).collect();
                m.insert("openings".into(), Value::Array(n));
            }
        }
        "roofs" => {
            shift_pts_fields(&mut m, &[], dx, dy, &["outline"]);
            if truthy(e.get("holes")) {
                if let Some(h) = e.get("holes").and_then(Value::as_array) {
                    let n: Vec<Value> = h.iter().map(|h| shift_all(Some(h), dx, dy)).collect();
                    m.insert("holes".into(), Value::Array(n));
                }
            }
        }
        "stairs" => {
            shift_pts_fields(&mut m, &["start"], dx, dy, &[]);
            let c = if truthy(e.get("center")) { Some(shift(&e["center"], dx, dy)) } else { None };
            set(&mut m, "center", c);
        }
        "rooms" => {
            shift_pts_fields(&mut m, &[], dx, dy, &["boundary"]);
            let c = if truthy(e.get("stampAnchor")) { Some(shift(&e["stampAnchor"], dx, dy)) } else { None };
            set(&mut m, "stampAnchor", c);
        }
        "columns" => shift_pts_fields(&mut m, &["position"], dx, dy, &[]),
        "extrudedSolids" => {
            shift_pts_fields(&mut m, &[], dx, dy, &["points"]);
            let c = if truthy(e.get("circle")) {
                let mut c = obj(&e["circle"]);
                let n = shift(c.get("center").unwrap_or(&Value::Null), dx, dy);
                c.insert("center".into(), n);
                Some(Value::Object(c))
            } else {
                None
            };
            set(&mut m, "circle", c);
        }
        "drawings2d" => {
            let g = shift_geom(e.get("geom").unwrap_or(&Value::Null), dx, dy);
            m.insert("geom".into(), g);
        }
        "context" => return (shift_context(e, dx, dy), true),
        "drawingLevels" => {
            let lp = e.get("linePoints").and_then(Value::as_array).filter(|a| !a.is_empty());
            return match lp {
                Some(a) if truthy(e.get("linePoints")) => {
                    let n = vec![shift(&a[0], dx, dy), shift(a.get(1).unwrap_or(&Value::Null), dx, dy)];
                    m.insert("linePoints".into(), Value::Array(n));
                    (Value::Object(m), true)
                }
                _ => (e.clone(), false),
            };
        }
        _ => {}
    }
    (Value::Object(m), true)
}

/// Verschobene Listen und Geo-Anker (nur Schlüssel, die es im Projekt gibt); `None` bei `dx = dy = 0`
/// (nichts zu tun). Jedes Element mit Änderungs-Kennzeichen (`false`: dasselbe Element wie vorher).
pub fn translate(root: &Map<String, Value>, dx: f64, dy: f64) -> Option<Vec<(&'static str, Vec<(Value, bool)>)>> {
    if dx == 0.0 && dy == 0.0 {
        return None;
    }
    Some(
        TRANSLATED_LISTS
            .iter()
            .filter_map(|key| root.get(*key).and_then(Value::as_array).map(|a| (*key, a.iter().map(|e| shift_element(key, e, dx, dy)).collect())))
            .collect(),
    )
}

/// Geo-Anker verschoben (`geoAnchor.model`), `None` ohne Anker.
pub fn translate_anchor(root: &Map<String, Value>, dx: f64, dy: f64) -> Option<Value> {
    let a = root.get("geoAnchor").filter(|v| truthy(Some(v)))?;
    let mut m = obj(a);
    m.insert("model".into(), shift(a.get("model").unwrap_or(&Value::Null), dx, dy));
    Some(Value::Object(m))
}

/// Patch für `{...project, ...patch}`: verschobene Listen und Geo-Anker (`translateProject`). Leer bei `dx = dy = 0`.
pub fn project_patch(root: &Map<String, Value>, dx: f64, dy: f64) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(lists) = translate(root, dx, dy) else { return out };
    for (key, els) in lists {
        out.insert(key.to_string(), Value::Array(els.into_iter().map(|(v, _)| v).collect()));
    }
    if let Some(a) = translate_anchor(root, dx, dy) {
        out.insert("geoAnchor".into(), a);
    }
    out
}

/// Ops für die Verschiebung (`translateOps`): je geändertem Element ein `replace` (Listen-Reihenfolge), der Geo-Anker als Feld.
pub fn translate_ops(root: &Map<String, Value>, dx: f64, dy: f64) -> Vec<Value> {
    let mut ops = Vec::new();
    let Some(lists) = translate(root, dx, dy) else { return ops };
    for (key, els) in lists {
        for (v, changed) in els {
            if changed {
                ops.push(json!({"kind": "replace", "collection": key, "entity": v}));
            }
        }
    }
    if let Some(a) = translate_anchor(root, dx, dy) {
        ops.push(json!({"kind": "setField", "key": "geoAnchor", "value": a}));
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn verschiebt_alles_und_laesst_hoehen() {
        let p = root(json!({
            "walls": [{"id": "w", "start": {"x": 1, "y": 2}, "end": {"x": 3, "y": 4}, "height": 2.6}],
            "stairs": [{"id": "s", "start": {"x": 0, "y": 0}, "dir": {"x": 1, "y": 0}}],
            "drawings2d": [{"id": "d", "geom": {"shape": "text", "at": {"x": 1, "y": 1}, "leaderTarget": {"x": 2, "y": 2}, "pathPts": [{"x": 5, "y": 5}]}}],
            "context": [{"id": "c", "type": "terrainMesh", "positions": [1, 2, 9, 4, 5, 8, 7]}, {"id": "i", "type": "image", "min": {"x": 0, "y": 0}, "max": {"x": 1, "y": 1}}],
            "drawingLevels": [{"id": "l1"}, {"id": "l2", "linePoints": [{"x": 0, "y": 0}, {"x": 1, "y": 1}]}],
            "geoAnchor": {"lv95": {"e": 1, "n": 2}, "model": {"x": 5, "y": 6}},
        }));
        let patch = project_patch(&p, 10.0, -1.0);
        assert_eq!(patch["walls"][0]["start"], json!({"x": 11.0, "y": 1.0}));
        assert_eq!(patch["walls"][0]["height"], 2.6);
        assert_eq!(patch["stairs"][0]["dir"], json!({"x": 1, "y": 0}));
        assert!(patch["stairs"][0].get("center").is_none());
        assert_eq!(patch["drawings2d"][0]["geom"]["leaderTarget"], json!({"x": 12.0, "y": 1.0}));
        assert_eq!(patch["drawings2d"][0]["geom"]["pathPts"][0], json!({"x": 15.0, "y": 4.0}));
        assert_eq!(patch["context"][0]["positions"], json!([11.0, 1.0, 9, 14.0, 4.0, 8, 7]));
        assert_eq!(patch["context"][1]["max"], json!({"x": 11.0, "y": 0.0}));
        assert_eq!(patch["geoAnchor"]["model"], json!({"x": 15.0, "y": 5.0}));
        assert_eq!(patch["geoAnchor"]["lv95"], json!({"e": 1, "n": 2}));
        assert!(project_patch(&p, 0.0, 0.0).is_empty());
    }

    #[test]
    fn ops_ohne_unveraenderte_ebenen() {
        let p = root(json!({
            "walls": [{"id": "w", "start": {"x": 0, "y": 0}, "end": {"x": 1, "y": 0}}],
            "drawingLevels": [{"id": "l1"}, {"id": "l2", "linePoints": [{"x": 0, "y": 0}, {"x": 1, "y": 1}]}],
        }));
        let ops = translate_ops(&p, 1.0, 1.0);
        let ids: Vec<&str> = ops.iter().map(|o| o["entity"]["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["w", "l2"]);
        assert!(translate_ops(&p, 0.0, 0.0).is_empty());
    }
}
