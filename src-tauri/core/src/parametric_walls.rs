//! Parametrische Wand-Engine ([K4] S3, vorher `src/model/parametricWalls.ts`): löst `ParametricWall`-Regelwerke
//! (Raster, Modul, bedingte Dicke, Referenzlinie, Sequenz) zu Wänden auf. Rechnung auf `serde_json::Value`
//! (die bestehenden Wände behalten ihre unbekannten Felder), Zahlen wie in JS (`Math.round/min/max/atan2`
//! über `jsnum`). Die laufende Nummer der erzeugten Wand-ids (`pw-<Geschoss>-<Art>-<n>`) ist Zustand der
//! TS-Fassade: sie reicht den Zähler hinein und bekommt den neuen zurück.
//!
//! Abweichung zur TS-Fassung: Achspositionen sind auf 1 000 000 je Aufruf begrenzt (TS rechnete bei
//! absurd kleinem Abstand praktisch endlos bzw. bis zum Speicherende).

use crate::jsnum;
use serde_json::{json, Map, Value};

const MAX_AXES: usize = 1_000_000;

/// Arbeitskontext (`RuleCtx`): Geschoss-id, Standard-Wandtyp, Kontext (Geschoss, Rasterachsen, Grenze) und
/// die bisher erzeugten bzw. vorhandenen Wände.
pub struct Ctx<'a> {
    pub floor_id: &'a Value,
    pub default_wall_type: &'a Value,
    pub context: &'a Value,
    pub existing: Vec<Value>,
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

fn present<'a>(v: Option<&'a Value>) -> Option<&'a Value> {
    v.filter(|v| !v.is_null())
}

/// `${x}` für ids: Text, sonst `undefined` wie in JS.
fn floor_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "undefined".into(),
        other => other.to_string(),
    }
}

/// Zähler für Wand-ids (`makeWallId`): erhöht und liefert `pw-<prefix>-<n>`.
fn make_wall_id(counter: &mut u64, prefix: &str) -> String {
    *counter += 1;
    format!("pw-{prefix}-{counter}")
}

fn point(v: Option<&Value>) -> (f64, f64) {
    (num(v.and_then(|p| p.get("x"))).unwrap_or(f64::NAN), num(v.and_then(|p| p.get("y"))).unwrap_or(f64::NAN))
}

fn dist2(a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = a.0 - b.0;
    let dy = a.1 - b.1;
    (dx * dx + dy * dy).sqrt()
}

#[derive(Clone, Copy)]
struct Bounds {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

/// Bounding-Box des Kontexts (`computeBounds`): Grenzpolygon oder Standardbereich `0 … spacing × 10`.
fn compute_bounds(context: &Value, spacing: f64) -> Bounds {
    if let Some(pts) = context.get("boundaryGeometry").and_then(|b| b.get("boundary")).and_then(Value::as_array) {
        if pts.len() >= 2 {
            let mut b = Bounds { min_x: f64::INFINITY, max_x: f64::NEG_INFINITY, min_y: f64::INFINITY, max_y: f64::NEG_INFINITY };
            for p in pts {
                let (x, y) = point(Some(p));
                if x < b.min_x {
                    b.min_x = x;
                }
                if x > b.max_x {
                    b.max_x = x;
                }
                if y < b.min_y {
                    b.min_y = y;
                }
                if y > b.max_y {
                    b.max_y = y;
                }
            }
            return b;
        }
    }
    let extent = spacing * 10.0;
    Bounds { min_x: 0.0, max_x: extent, min_y: 0.0, max_y: extent }
}

/// Gleichmässige Achspositionen in `[min, max]` (`generateAxisPositions`).
fn axis_positions(min: f64, max: f64, spacing: f64) -> Vec<f64> {
    // `!(max > min)` fängt auch NaN ab (TS: die Schleife lief dann nicht)
    if spacing <= 0.0 || max <= min || spacing.is_nan() || min.is_nan() || max.is_nan() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut pos = min;
    while pos <= max + 1e-6 && out.len() < MAX_AXES {
        out.push(jsnum::round(pos * 1e6) / 1e6);
        pos += spacing;
    }
    out
}

/// Wand „aussen" = beide Endpunkte am Rand der Bounding-Box (`isExteriorWall`).
fn is_exterior(wall: &Value, ctx: &Ctx) -> bool {
    let b = compute_bounds(ctx.context, 1.0);
    let tol = 0.1;
    let on_edge = |p: (f64, f64)| (p.0 - b.min_x).abs() <= tol || (p.0 - b.max_x).abs() <= tol || (p.1 - b.min_y).abs() <= tol || (p.1 - b.max_y).abs() <= tol;
    on_edge(point(wall.get("start"))) && on_edge(point(wall.get("end")))
}

/// Erfüllt die Wand die Bedingung einer Regel „bedingte Dicke" (`matchesCondition`)?
pub fn matches_condition(wall: &Value, condition: &str, ctx: &Ctx) -> bool {
    match condition {
        "exterior" => is_exterior(wall, ctx),
        "interior" => !is_exterior(wall, ctx),
        "bearing" => {
            let (s, e) = (point(wall.get("start")), point(wall.get("end")));
            let dx = (e.0 - s.0).abs();
            let dy = (e.1 - s.1).abs();
            let len = (dx * dx + dy * dy).sqrt();
            if len < 1e-6 {
                return false;
            }
            let angle = jsnum::atan2(dy, dx);
            let ten = (10.0 * std::f64::consts::PI) / 180.0;
            angle <= ten || angle >= std::f64::consts::PI / 2.0 - ten
        }
        _ => false,
    }
}

/// Entspricht die Wand dem Ziel einer Referenzlinien-Regel (`matchesTarget`)?
pub fn matches_target(wall: &Value, target: &str, ctx: &Ctx) -> bool {
    match target {
        "all" => true,
        "exterior" => is_exterior(wall, ctx),
        _ => false,
    }
}

/// Neue Wand `{id, type, floorId, categoryCode, start, end, wallTypeId, height, referenceLine?}`.
#[allow(clippy::too_many_arguments)]
fn new_wall(id: String, floor_id: &Value, start: (f64, f64), end: (f64, f64), wall_type_id: Option<&Value>, height: f64, reference_line: Option<&Value>) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), Value::String(id));
    m.insert("type".into(), json!("wall"));
    m.insert("floorId".into(), floor_id.clone());
    m.insert("categoryCode".into(), json!("20"));
    m.insert("start".into(), json!({"x": start.0, "y": start.1}));
    m.insert("end".into(), json!({"x": end.0, "y": end.1}));
    if let Some(w) = wall_type_id {
        m.insert("wallTypeId".into(), w.clone());
    }
    m.insert("height".into(), json!(height));
    if let Some(r) = reference_line {
        m.insert("referenceLine".into(), r.clone());
    }
    Value::Object(m)
}

/// Wandtyp-id der Regel oder des Standard-Wandtyps (`rule.wallTypeId ?? defaultWallType.id`).
fn wall_type_id<'a>(rule: &'a Value, ctx: &'a Ctx) -> Option<&'a Value> {
    present(rule.get("wallTypeId")).or_else(|| present(ctx.default_wall_type.get("id")))
}

/// Höhe der Regel oder des Geschosses (`rule.height ?? floor.floorHeight ?? 2.6`).
fn rule_height(rule: &Value, ctx: &Ctx) -> f64 {
    num(present(rule.get("height"))).or_else(|| num(present(ctx.context.get("floor").and_then(|f| f.get("floorHeight"))))).unwrap_or(2.6)
}

/// Raster-Regel: Wände entlang gleichmässiger X-/Y-Achsen (`applyGridRule`).
fn apply_grid(rule: &Value, ctx: &Ctx, counter: &mut u64) -> Vec<Value> {
    let spacing = num(present(rule.get("spacing"))).unwrap_or(3.0);
    let type_id = wall_type_id(rule, ctx);
    let reference = present(rule.get("referenceLine"));
    let height = rule_height(rule, ctx);
    let floor = floor_text(ctx.floor_id);
    let b = compute_bounds(ctx.context, spacing);
    let dirs = rule.get("directions").and_then(Value::as_str);
    let grid_axes = present(ctx.context.get("gridAxes"));
    let use_grid = present(rule.get("gridId")).is_some() && grid_axes.is_some();
    let axes_of = |key: &str| -> Vec<f64> { grid_axes.and_then(|g| g.get(key)).and_then(Value::as_array).map(|a| a.iter().map(|v| num(Some(v)).unwrap_or(f64::NAN)).collect()).unwrap_or_default() };
    let mut walls = Vec::new();
    if dirs == Some("x") || dirs == Some("both") {
        let axes = if use_grid { axes_of("x") } else { axis_positions(b.min_x, b.max_x, spacing) };
        for ax in axes {
            let id = make_wall_id(counter, &format!("{floor}-gx"));
            walls.push(new_wall(id, ctx.floor_id, (ax, b.min_y), (ax, b.max_y), type_id, height, reference));
        }
    }
    if dirs == Some("y") || dirs == Some("both") {
        let axes = if use_grid { axes_of("y") } else { axis_positions(b.min_y, b.max_y, spacing) };
        for ay in axes {
            let id = make_wall_id(counter, &format!("{floor}-gy"));
            walls.push(new_wall(id, ctx.floor_id, (b.min_x, ay), (b.max_x, ay), type_id, height, reference));
        }
    }
    walls
}

/// Modul-Regel: Querwände an den Teilungspunkten einer Referenzspanne (`applyModuleRule`).
fn apply_module(rule: &Value, ctx: &Ctx, counter: &mut u64) -> Vec<Value> {
    let type_id = wall_type_id(rule, ctx);
    let reference = present(rule.get("referenceLine"));
    let height = rule_height(rule, ctx);
    let floor = floor_text(ctx.floor_id);
    let module_size = num(rule.get("moduleSize")).unwrap_or(f64::NAN);
    let b = compute_bounds(ctx.context, module_size);
    let dir_x = rule.get("direction").and_then(Value::as_str) == Some("x");
    let bbox = if dir_x { (b.min_x, b.max_x, b.min_y, b.max_y) } else { (b.min_y, b.max_y, b.min_x, b.max_x) };
    let ref_wall = present(rule.get("referenceWallId")).and_then(|id| ctx.existing.iter().find(|w| w.get("id") == Some(id)));
    let (span_start, span_end, perp_start, perp_end) = match ref_wall {
        Some(w) => {
            let (s, e) = (point(w.get("start")), point(w.get("end")));
            if dir_x {
                (jsnum::min(s.0, e.0), jsnum::max(s.0, e.0), b.min_y, b.max_y)
            } else {
                (jsnum::min(s.1, e.1), jsnum::max(s.1, e.1), b.min_x, b.max_x)
            }
        }
        None => bbox,
    };
    let dividers: Vec<f64> = axis_positions(span_start, span_end, module_size).into_iter().filter(|p| *p > span_start + 1e-6 && *p < span_end - 1e-6).collect();
    dividers
        .into_iter()
        .map(|pos| {
            if dir_x {
                let id = make_wall_id(counter, &format!("{floor}-mx"));
                new_wall(id, ctx.floor_id, (pos, perp_start), (pos, perp_end), type_id, height, reference)
            } else {
                let id = make_wall_id(counter, &format!("{floor}-my"));
                new_wall(id, ctx.floor_id, (perp_start, pos), (perp_end, pos), type_id, height, reference)
            }
        })
        .collect()
}

/// Kopie von `w` mit gesetzten Feldern (`{...w, id, key: v}`).
fn copy_with(w: &Value, fields: &[(&str, Value)]) -> Value {
    let mut m = w.as_object().cloned().unwrap_or_default();
    for (k, v) in fields {
        m.insert((*k).to_string(), v.clone());
    }
    Value::Object(m)
}

fn text(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}

/// Führt eine Regel aus (`applyRule`); unbekannter Typ → leer.
pub fn apply_rule(rule: &Value, ctx: &Ctx, counter: &mut u64) -> Vec<Value> {
    match rule.get("type").and_then(Value::as_str) {
        Some("grid") => apply_grid(rule, ctx, counter),
        Some("module") => apply_module(rule, ctx, counter),
        Some("conditional-thickness") => {
            let floor = floor_text(ctx.floor_id);
            let cond = text(rule.get("condition"));
            ctx.existing
                .iter()
                .filter(|w| matches_condition(w, cond, ctx))
                .map(|w| {
                    let id = make_wall_id(counter, &format!("{floor}-ct"));
                    let mut fields = vec![("id", Value::String(id))];
                    if let Some(t) = rule.get("wallTypeId") {
                        fields.push(("wallTypeId", t.clone()));
                    } else {
                        fields.push(("wallTypeId", Value::Null));
                    }
                    let mut out = copy_with(w, &fields);
                    // `wallTypeId: undefined` entfernt das Feld (JSON), ein Wert bleibt
                    if rule.get("wallTypeId").is_none() {
                        out.as_object_mut().map(|m| m.shift_remove("wallTypeId"));
                    }
                    out
                })
                .collect()
        }
        Some("reference-line") => {
            let floor = floor_text(ctx.floor_id);
            let target = text(rule.get("target"));
            ctx.existing
                .iter()
                .filter(|w| matches_target(w, target, ctx))
                .map(|w| {
                    let id = make_wall_id(counter, &format!("{floor}-rl"));
                    let mut fields = vec![("id", Value::String(id))];
                    if let Some(r) = rule.get("referenceLine") {
                        fields.push(("referenceLine", r.clone()));
                    }
                    let mut out = copy_with(w, &fields);
                    if rule.get("referenceLine").is_none() {
                        out.as_object_mut().map(|m| m.shift_remove("referenceLine"));
                    }
                    out
                })
                .collect()
        }
        Some("sequence") => {
            let mut result: Vec<Value> = Vec::new();
            for sub in rule.get("rules").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
                let sub_ctx = Ctx { floor_id: ctx.floor_id, default_wall_type: ctx.default_wall_type, context: ctx.context, existing: ctx.existing.iter().chain(result.iter()).cloned().collect() };
                let walls = apply_rule(sub, &sub_ctx, counter);
                let produced = !walls.is_empty();
                result.extend(walls);
                if rule.get("stopOnMatch") == Some(&Value::Bool(true)) && produced {
                    break;
                }
            }
            result
        }
        _ => Vec::new(),
    }
}

/// Entfernt doppelte Wände (gleicher Start/Ende innerhalb `tolerance`, auch umgekehrt); die erste bleibt.
pub fn deduplicate(walls: Vec<Value>, tolerance: f64) -> Vec<Value> {
    let mut unique: Vec<Value> = Vec::new();
    for c in walls {
        let (cs, ce) = (point(c.get("start")), point(c.get("end")));
        let dup = unique.iter().any(|u| {
            let (us, ue) = (point(u.get("start")), point(u.get("end")));
            let fwd = dist2(cs, us) <= tolerance && dist2(ce, ue) <= tolerance;
            let rev = dist2(cs, ue) <= tolerance && dist2(ce, us) <= tolerance;
            fwd || rev
        });
        if !dup {
            unique.push(c);
        }
    }
    unique
}

/// Löst ein Regelwerk zu Wänden für ein Geschoss auf (`resolveParametricWall`): jede Regel sieht die
/// vorhandenen und die bisher erzeugten Wände, danach werden Duplikate entfernt.
pub fn resolve(parametric_wall: &Value, ctx: &Ctx, tolerance: f64, counter: &mut u64) -> Vec<Value> {
    let mut generated: Vec<Value> = Vec::new();
    for rule in parametric_wall.get("rules").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
        let rc = Ctx { floor_id: ctx.floor_id, default_wall_type: ctx.default_wall_type, context: ctx.context, existing: ctx.existing.iter().chain(generated.iter()).cloned().collect() };
        let walls = apply_rule(rule, &rc, counter);
        generated.extend(walls);
    }
    deduplicate(generated, tolerance)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_of<'a>(floor_id: &'a Value, wt: &'a Value, context: &'a Value, existing: Vec<Value>) -> Ctx<'a> {
        Ctx { floor_id, default_wall_type: wt, context, existing }
    }

    #[test]
    fn raster_in_beide_richtungen() {
        let (f, wt, cx) = (json!("f1"), json!({"id": "wt0"}), json!({"floor": {"floorHeight": 3.0}}));
        let mut n = 0;
        let w = apply_rule(&json!({"type": "grid", "spacing": 3, "directions": "both"}), &ctx_of(&f, &wt, &cx, vec![]), &mut n);
        assert_eq!(w.len(), 22); // 0..30 je Richtung (11 Achsen)
        assert_eq!(n, 22);
        assert_eq!(w[0]["id"], "pw-f1-gx-1");
        assert_eq!(w[0]["start"], json!({"x": 0.0, "y": 0.0}));
        assert_eq!(w[0]["end"], json!({"x": 0.0, "y": 30.0}));
        assert_eq!(w[0]["wallTypeId"], "wt0");
        assert_eq!(w[0]["height"], 3.0);
        assert_eq!(w[11]["id"], "pw-f1-gy-12");
    }

    #[test]
    fn modul_mit_referenzwand_und_begrenzung() {
        let (f, wt) = (json!("f"), json!({"id": "w"}));
        let cx = json!({"floor": {}, "boundaryGeometry": {"boundary": [{"x": 0, "y": 0}, {"x": 10, "y": 6}]}});
        let ref_wall = json!({"id": "r", "start": {"x": 2, "y": 0}, "end": {"x": 8, "y": 0}});
        let mut n = 0;
        let rule = json!({"type": "module", "direction": "x", "moduleSize": 2, "referenceWallId": "r", "referenceLine": "center"});
        let w = apply_rule(&rule, &ctx_of(&f, &wt, &cx, vec![ref_wall]), &mut n);
        let xs: Vec<f64> = w.iter().map(|w| w["start"]["x"].as_f64().unwrap()).collect();
        assert_eq!(xs, vec![4.0, 6.0]); // 2 und 8 sind Spannenenden
        assert_eq!(w[0]["start"]["y"], 0.0);
        assert_eq!(w[0]["end"]["y"], 6.0);
        assert_eq!(w[0]["referenceLine"], "center");
        assert_eq!(w[0]["height"], 2.6);
    }

    #[test]
    fn bedingte_dicke_und_referenzlinie_kopieren() {
        let (f, wt, cx) = (json!("f"), json!({"id": "w"}), json!({"floor": {}, "boundaryGeometry": {"boundary": [{"x": 0, "y": 0}, {"x": 10, "y": 10}]}}));
        let outer = json!({"id": "a", "start": {"x": 0, "y": 0}, "end": {"x": 10, "y": 0}, "extra": 1});
        let inner = json!({"id": "b", "start": {"x": 5, "y": 3}, "end": {"x": 5, "y": 7}});
        let mut n = 10;
        let c = ctx_of(&f, &wt, &cx, vec![outer.clone(), inner.clone()]);
        let ct = apply_rule(&json!({"type": "conditional-thickness", "condition": "exterior", "wallTypeId": "dick"}), &c, &mut n);
        assert_eq!(ct.len(), 1);
        assert_eq!(ct[0]["id"], "pw-f-ct-11");
        assert_eq!(ct[0]["wallTypeId"], "dick");
        assert_eq!(ct[0]["extra"], 1);
        let rl = apply_rule(&json!({"type": "reference-line", "target": "all", "referenceLine": "left"}), &c, &mut n);
        assert_eq!(rl.len(), 2);
        assert_eq!(rl[1]["referenceLine"], "left");
        assert!(apply_rule(&json!({"type": "reference-line", "target": "tag"}), &c, &mut n).is_empty());
        assert!(matches_condition(&inner, "interior", &c));
        assert!(matches_condition(&inner, "bearing", &c));
        assert!(!matches_condition(&json!({"start": {"x": 0, "y": 0}, "end": {"x": 5, "y": 5}}), "bearing", &c));
    }

    #[test]
    fn sequenz_und_duplikate() {
        let (f, wt, cx) = (json!("f"), json!({"id": "w"}), json!({"floor": {}}));
        let mut n = 0;
        let seq = json!({"type": "sequence", "stopOnMatch": true, "rules": [
            {"type": "conditional-thickness", "condition": "exterior", "wallTypeId": "x"},
            {"type": "grid", "spacing": 5, "directions": "x"},
            {"type": "grid", "spacing": 5, "directions": "y"},
        ]});
        let w = apply_rule(&seq, &ctx_of(&f, &wt, &cx, vec![]), &mut n);
        // Die erste Regel findet keine Wand; die x-Regel liefert 0, 5 … 50 (11 Achsen) und stoppt die Sequenz.
        assert_eq!(w.len(), 11);
        assert!(w.iter().all(|w| w["start"]["y"] == 0.0 && w["end"]["y"] == 50.0));
        assert_eq!(deduplicate(vec![w[0].clone(), w[0].clone(), w[1].clone()], 0.01).len(), 2);
    }
}
