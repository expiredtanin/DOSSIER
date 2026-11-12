//! [187] Höhen-Griffe im Schnitt und in der Ansicht: Kante des gewählten Bauteils auf die Blatt-Höhe `y` (absolutes Z,
//! Meter) ziehen. Der Kern rechnet aus der Höhe die Änderung am Bauteil — wie im Grundriss, nicht in der Hülle:
//!
//! | Griff | Wirkung |
//! |---|---|
//! | `wallTop` | Wandhöhe (`height`); ist die Oberkante gebunden (`top`), wandert die Bindung mit |
//! | `wallBottom` | Unterkante (`bottom`-Bindung), die Oberkante bleibt stehen (`height` rechnet nach) |
//! | `openingTop` | lichte Höhe (`height`) |
//! | `openingBottom` | Brüstung (`sillHeight`) bei gleicher Oberkante (Fenster) |
//! | `ceilingTop` | Höhenlage: Oberkante-Bindung (`top`); ohne UK-Bindung zieht die Dicke die Unterkante mit |
//! | `ceilingBottom` | Dicke (über den Deckentyp, wie die Objekt-Info) bzw. die UK-Bindung, falls es eine gibt |
//! | `roofEave` | Traufhöhe (`baseElevation`); das ganze Dach wandert, die Firsthöhe über der Traufe bleibt |
//! | `roofTop` | Firsthöhe: die Neigung (`pitchDeg`) wird so gerechnet, dass der First auf der Kote liegt |
//! | `parapetTop` | Attika-Höhe (`parapetHeight`, Flachdach): Oberkante über der Traufe |
//! | `stairTop` | Austrittshöhe (`totalRise`, ab Geschoss-Basis; der Antritt liegt im Modell fest auf der Basis) |
//! | `contextTop`, `contextBottom` | Gelände (Netz, Baugrube, Höhenlinien): alle Höhen um die Differenz zur Griffhöhe `b` versetzen |
//! | `contourLine` | Höhe der Höhenlinie `index` eines Höhenlinien-Satzes |
//!
//! Raster 1 cm (`free` = ohne), Mindestmasse: Wand 0.30 m, Öffnung 0.20 m, Decke 0.05 m. Bindungen bleiben in ihrer
//! Art (Geschoss + Versatz bleibt Geschoss + Versatz, absolut bleibt absolut); ohne Bindung entsteht eine
//! Geschoss-Bindung des eigenen Geschosses. Gesperrte Bauteile ändern sich nicht.

use crate::document::Lookup;
use crate::json_util::{arr, field, js_num, num_of, truthy, with, with_all};
use crate::jsnum;
use crate::ops::Op;
use crate::selection_info::{anchor, ceiling_extent, ceiling_thickness as ceiling_thickness_of, vertical_extent};
use serde_json::{json, Map, Value};

const MIN_WALL: f64 = 0.3;
const MIN_OPENING: f64 = 0.2;
const MIN_CEILING: f64 = 0.05;
const MIN_RIDGE: f64 = 0.1;
const MIN_STAIR: f64 = 0.3;

/// Art eines Höhen-Griffs (Reihenfolge = Index der Bindung `grip_sheet_height`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    WallTop,
    OpeningTop,
    OpeningBottom,
    WallBottom,
    /// Decke OK, UK nicht gebunden: die ganze Platte wandert (Dicke bleibt).
    CeilingTop,
    /// Decke OK bei gebundener UK: die Dicke ändert sich.
    CeilingTopFixed,
    CeilingBottom,
    /// Traufe: das Dach wandert (Firsthöhe über der Traufe bleibt); `bottom` = Traufe, `top` = First.
    RoofEave,
    /// First: `bottom` = Traufe bleibt, `top` mindestens 0.10 m darüber.
    RoofTop,
    /// Attika-Oberkante: `bottom` = Dachhaut, `top` darüber (mindestens gleich).
    ParapetTop,
    /// Treppen-Austritt: `bottom` = Basis, `top` mindestens 0.30 m darüber.
    StairTop,
}

impl Kind {
    pub fn from_index(i: u32) -> Option<Kind> {
        use Kind::*;
        [WallTop, OpeningTop, OpeningBottom, WallBottom, CeilingTop, CeilingTopFixed, CeilingBottom, RoofEave, RoofTop, ParapetTop, StairTop].get(i as usize).copied()
    }
}

/// Griff auf die Blatt-Höhe `y` ziehen (1-cm-Raster, `free` = ohne): neue `(Oberkante, Unterkante)` im Blatt.
/// `top`/`bottom` = heutige Kanten, `base` = tiefste erlaubte Brüstungskante (UK der Wand; nur `OpeningBottom`).
/// Mindestmasse: Wand 0.30 m, Öffnung 0.20 m, Decke 0.05 m.
pub fn drag(kind: Kind, base: f64, top: f64, bottom: f64, y: f64, free: bool) -> (f64, f64) {
    let v = if free { y } else { jsnum::round(y * 100.0) / 100.0 };
    match kind {
        Kind::WallTop => (jsnum::max(bottom + MIN_WALL, v), bottom),
        Kind::WallBottom => (top, jsnum::min(top - MIN_WALL, v)),
        Kind::OpeningTop => (jsnum::max(bottom + MIN_OPENING, v), bottom),
        Kind::OpeningBottom => (top, jsnum::min(top - MIN_OPENING, jsnum::max(base, v))),
        Kind::CeilingTop => (v, bottom + (v - top)),
        Kind::CeilingTopFixed => (jsnum::max(bottom + MIN_CEILING, v), bottom),
        Kind::CeilingBottom => (top, jsnum::min(top - MIN_CEILING, v)),
        Kind::RoofEave => (top + (v - bottom), v),
        Kind::RoofTop => (jsnum::max(bottom + MIN_RIDGE, v), bottom),
        Kind::ParapetTop => (jsnum::max(bottom, v), bottom),
        Kind::StairTop => (jsnum::max(bottom + MIN_STAIR, v), bottom),
    }
}

fn mm(x: f64) -> f64 {
    jsnum::round(x * 1000.0) / 1000.0
}

fn replace(collection: &str, entity: Value) -> Op {
    Op::Replace { collection: collection.into(), entity }
}

/// Bindung auf das absolute Z `z` setzen, in der Art der bisherigen: Geschoss + Versatz bleibt Geschoss (Versatz zur
/// Basis des Geschosses), absolut bleibt absolut; ohne Bindung (oder unbekanntes Geschoss) das eigene Geschoss.
fn anchor_to(root: &Map<String, Value>, existing: Option<&Value>, own_floor: Option<&Value>, z: f64) -> Value {
    let base_of = |floor_id: Option<&Value>| {
        let id = floor_id?.as_str()?;
        let f = root.get("drawingLevels")?.as_array()?.iter().find(|l| field(l, "id").and_then(Value::as_str) == Some(id))?;
        Some((id.to_string(), field(f, "baseElevation").map_or(0.0, |b| num_of(Some(b)))))
    };
    let existing = existing.filter(|a| truthy(Some(a)));
    if existing.and_then(|a| field(a, "mode")).and_then(Value::as_str) == Some("custom") {
        return json!({ "mode": "custom", "z": js_num(mm(z)) });
    }
    match base_of(existing.and_then(|a| field(a, "floorId"))).or_else(|| base_of(own_floor)) {
        Some((floor_id, base)) => json!({ "mode": "floor", "floorId": floor_id, "offset": js_num(mm(z - base)) }),
        None => json!({ "mode": "custom", "z": js_num(mm(z)) }),
    }
}

/// Fang an die nächste Kote (Geschoss-Basis/-Oberkante …) innerhalb `tol` Metern; sonst `y` selbst.
pub fn snap_level(y: f64, levels: &[f64], tol: f64) -> f64 {
    if !y.is_finite() || !tol.is_finite() {
        return y;
    }
    levels.iter().copied().filter(|l| l.is_finite() && (l - y).abs() <= tol).min_by(|a, b| (a - y).abs().total_cmp(&(b - y).abs())).unwrap_or(y)
}

/// Die Ops für den Zug von `kind` an Bauteil `id` auf die Blatt-Höhe `y`. `new_id`/`new_name`: Deckentyp, falls die
/// Dicke einen eigenen braucht (`ceilingThickness`). Leer bei unbekanntem Bauteil/Art, Sperre, Unsinn oder wenn sich
/// nichts ändert.
/// `b` = Höhe, auf der der Griff vor dem Zug stand (Dach, Treppe, `contextTop`: der Zug zählt dann relativ), `index` = Höhenlinie (nur `contourLine`).
#[allow(clippy::too_many_arguments)]
pub fn ops(lk: &Lookup, kind: &str, id: &str, y: f64, free: bool, new_id: &str, new_name: &Value, b: f64, index: f64) -> Vec<Op> {
    if !y.is_finite() {
        return vec![];
    }
    let root = lk.root;
    let locked = |e: &Value| truthy(field(e, "locked"));
    match kind {
        "wallTop" | "wallBottom" => {
            let Some(w) = lk.find("walls", id).filter(|w| !locked(w)) else { return vec![] };
            let (zb, zt) = vertical_extent(root, w);
            let floor = field(w, "floorId");
            let new = if kind == "wallTop" {
                let z = drag(Kind::WallTop, zb, zt, zb, y, free).0;
                let mut f = vec![("height", js_num(mm(z - zb)))];
                if truthy(field(w, "top")) {
                    f.push(("top", anchor_to(root, field(w, "top"), floor, z)));
                }
                with_all(w, f)
            } else {
                let z = drag(Kind::WallBottom, zb, zt, zb, y, free).1;
                with_all(w, vec![("height", js_num(mm(zt - z))), ("bottom", anchor_to(root, field(w, "bottom"), floor, z))])
            };
            if new == *w { vec![] } else { vec![replace("walls", new)] }
        }
        "openingTop" | "openingBottom" => {
            let Some(o) = lk.find("openings", id).filter(|o| !locked(o)) else { return vec![] };
            let Some(w) = field(o, "hostWallId").and_then(Value::as_str).and_then(|h| lk.find("walls", h)) else { return vec![] };
            let base = vertical_extent(root, w).0;
            let sill = Some(num_of(field(o, "sillHeight"))).filter(|s| s.is_finite()).map_or(0.0, |s| s.max(0.0));
            let (bottom, top) = (base + sill, base + sill + num_of(field(o, "height")));
            let new = if kind == "openingTop" {
                let t = drag(Kind::OpeningTop, base, top, bottom, y, free).0;
                with(o, "height", js_num(mm(t - bottom)))
            } else {
                if field(o, "kind").and_then(Value::as_str) == Some("door") {
                    return vec![];
                }
                let b = drag(Kind::OpeningBottom, base, top, bottom, y, free).1;
                with_all(o, vec![("sillHeight", js_num(mm(b - base))), ("height", js_num(mm(top - b)))])
            };
            if new == *o { vec![] } else { vec![replace("openings", new)] }
        }
        "ceilingTop" | "ceilingBottom" => {
            let Some(c) = lk.find("ceilings", id).filter(|c| !locked(c)) else { return vec![] };
            let (zb, zt) = ceiling_extent(root, c, ceiling_thickness_of(root, c));
            let floor = field(c, "floorId");
            let bound_bottom = truthy(field(c, "bottom")) && anchor(root, field(c, "bottom")).is_some();
            if kind == "ceilingTop" {
                // Mit fester UK-Bindung ändert sich die Dicke, die UK bleibt; sonst wandert die ganze Platte.
                let z = drag(if bound_bottom { Kind::CeilingTopFixed } else { Kind::CeilingTop }, zb, zt, zb, y, free).0;
                let new = with(c, "top", anchor_to(root, field(c, "top"), floor, z));
                return if new == *c { vec![] } else { vec![replace("ceilings", new)] };
            }
            let z = drag(Kind::CeilingBottom, zb, zt, zb, y, free).1;
            if bound_bottom {
                let new = with(c, "bottom", anchor_to(root, field(c, "bottom"), floor, z));
                return if new == *c { vec![] } else { vec![replace("ceilings", new)] };
            }
            let t = mm(zt - z);
            if (t - mm(zt - zb)).abs() < 1e-9 {
                return vec![];
            }
            // Eigenes `thickness` der Decke übersteuert den Typ: dann nur dieses Feld.
            if num_of(field(c, "thickness")) > 0.0 {
                return vec![replace("ceilings", with(c, "thickness", js_num(t)))];
            }
            // `{t}` im Namen des neuen Typs = die Dicke (zwei Stellen).
            let name = new_name.as_str().map_or_else(|| new_name.clone(), |n| Value::from(n.replace("{t}", &format!("{t:.2}"))));
            crate::grips::ceiling_thickness(root, id, t, new_id, name)
        }
        "roofEave" | "roofTop" | "parapetTop" => {
            let Some(r) = lk.find("roofs", id).filter(|r| !locked(r)) else { return vec![] };
            let eave = roof_eave(root, r);
            let new = match kind {
                "roofEave" => {
                    let z = target(y, free, b, eave);
                    with(r, "baseElevation", js_num(mm(drag(Kind::RoofEave, 0.0, eave, eave, z, true).1)))
                }
                "parapetTop" => {
                    if field(r, "shape").and_then(Value::as_str) != Some("flach") {
                        return vec![];
                    }
                    let h = jsnum::max(0.0, num_of(field(r, "parapetHeight")));
                    let h = if h.is_finite() { h } else { 0.0 };
                    let z = target(y, free, b, eave + h);
                    with(r, "parapetHeight", js_num(mm(drag(Kind::ParapetTop, 0.0, eave, eave, z, true).0 - eave)))
                }
                _ => {
                    // Ist der Zug relativ (`b`), zählt die heutige Firsthöhe als Ausgang.
                    let h0 = crate::selection_info::roof_ridge_height(r, eave).unwrap_or(0.0);
                    let z = target(y, free, b, eave + h0);
                    match ridge_pitch(r, eave, drag(Kind::RoofTop, 0.0, eave, eave, z, true).0 - eave) {
                        Some(p) => with(r, "pitchDeg", js_num(p)),
                        None => return vec![],
                    }
                }
            };
            if new == *r { vec![] } else { vec![replace("roofs", new)] }
        }
        "stairTop" => {
            let Some(st) = lk.find("stairs", id).filter(|s| !locked(s)) else { return vec![] };
            let f = field(st, "floorId").and_then(Value::as_str).and_then(|i| lk.find("drawingLevels", i));
            let base = Some(f.map_or(0.0, |f| num_of(field(f, "baseElevation")))).filter(|b| b.is_finite()).unwrap_or(0.0);
            let floor_h = f.map_or(0.0, |f| num_of(field(f, "floorHeight")));
            let cur = match num_of(field(st, "totalRise")) {
                r if r > 0.0 => r,
                _ if floor_h > 0.0 => floor_h,
                _ => 2.6,
            };
            let z = target(y, free, b, base + cur);
            let top = drag(Kind::StairTop, base, base + cur, base, z, true).0;
            let new = with(st, "totalRise", js_num(mm(top - base)));
            if new == *st { vec![] } else { vec![replace("stairs", new)] }
        }
        "contextTop" | "contextBottom" | "contourLine" => {
            let Some(e) = lk.find("context", id).filter(|e| !locked(e)) else { return vec![] };
            let v = if free { y } else { jsnum::round(y * 100.0) / 100.0 };
            let new = if kind != "contourLine" {
                crate::cmd_context::height_offset(e, v - b)
            } else if index.is_finite() && index >= 0.0 {
                crate::cmd_context::contour_height(e, index as usize, v)
            } else {
                None
            };
            new.map(|entity| vec![replace("context", entity)]).unwrap_or_default()
        }
        _ => vec![],
    }
}

/// Zielhöhe des Zugs: mit bekannter Ausgangshöhe des Griffs `b` relativ (heutige Kante `cur` + Zug, 1-cm-Raster auf
/// dem Zug), sonst absolut `y`. Die Hülle zieht die sichtbare Kante des Schnitts (inkl. Überstand, Dicke), nicht
/// die Modell-Kante — darum der Zug als Differenz.
fn target(y: f64, free: bool, b: f64, cur: f64) -> f64 {
    let v = if free { y } else { jsnum::round(y * 100.0) / 100.0 };
    if b.is_finite() { cur + (v - b) } else { v }
}

/// Traufhöhe (absolutes Z) eines Dachs: `baseElevation`, sonst Oberkante des Geschosses.
fn roof_eave(root: &Map<String, Value>, r: &Value) -> f64 {
    if let Some(b) = field(r, "baseElevation").filter(|b| !b.is_null()) {
        return num_of(Some(b));
    }
    let id = field(r, "floorId").and_then(Value::as_str);
    arr(root.get("drawingLevels")).iter().find(|l| field(l, "id").and_then(Value::as_str) == id).map_or(0.0, |f| num_of(field(f, "baseElevation")) + num_of(field(f, "floorHeight")))
}

/// Neigung (Grad, 0.01°), bei der der First `rise` Meter über der Traufe liegt; `None` bei Flachdach, Fehler oder
/// unveränderter Neigung. Die Firsthöhe wächst mit tan(Neigung): Sekantenverfahren auf dem Kern, höchstens 8 Schritte.
fn ridge_pitch(r: &Value, eave: f64, rise: f64) -> Option<f64> {
    if field(r, "shape").and_then(Value::as_str) == Some("flach") || !rise.is_finite() {
        return None;
    }
    let p0 = num_of(field(r, "pitchDeg"));
    let mut p = if p0.is_finite() && p0 > 0.0 { p0 } else { 10.0 };
    for _ in 0..8 {
        let h = crate::selection_info::roof_ridge_height(&with(r, "pitchDeg", js_num(p)), eave).ok()?;
        if !(h > 1e-9) || (h - rise).abs() < 1e-4 {
            break;
        }
        p = ((p.to_radians().tan() * rise / h).atan().to_degrees()).clamp(0.5, 85.0);
    }
    let p = jsnum::round(p * 100.0) / 100.0;
    if p == p0 { None } else { Some(p) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> Map<String, Value> {
        json!({
            "drawingLevels": [
                {"id": "eg", "kind": "floor", "baseElevation": 0.0, "floorHeight": 2.6},
                {"id": "og", "kind": "floor", "baseElevation": 3.0, "floorHeight": 2.6}
            ],
            "walls": [
                {"id": "w1", "floorId": "eg", "height": 2.6},
                {"id": "w2", "floorId": "eg", "height": 2.6, "top": {"mode": "floor", "floorId": "og", "offset": 0}},
                {"id": "w3", "floorId": "eg", "height": 2.6, "locked": true}
            ],
            "openings": [
                {"id": "f1", "hostWallId": "w1", "kind": "window", "sillHeight": 0.9, "height": 1.2},
                {"id": "t1", "hostWallId": "w1", "kind": "door", "sillHeight": 0, "height": 2.1}
            ],
            "wallTypes": [{"id": "wt", "layers": [{"thickness": 0.2}]}],
            "ceilingTypes": [{"id": "ct", "layers": [{"thickness": 0.25}]}, {"id": "ct2", "layers": [{"thickness": 0.25}]}],
            "ceilings": [
                {"id": "c1", "floorId": "eg", "wallTypeId": "wt", "ceilingTypeId": "ct"},
                {"id": "c2", "floorId": "eg", "wallTypeId": "wt", "ceilingTypeId": "ct2", "bottom": {"mode": "custom", "z": 2.3}},
                {"id": "c3", "floorId": "eg", "wallTypeId": "wt", "thickness": 0.3}
            ]
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn run(kind: &str, id: &str, y: f64) -> Vec<Op> {
        let r = root();
        ops(&Lookup::plain(&r), kind, id, y, false, "ct-neu", &json!("Neu"), f64::NAN, f64::NAN)
    }

    fn entity(ops: &[Op]) -> Value {
        match ops.first() {
            Some(Op::Replace { entity, .. }) => entity.clone(),
            other => panic!("replace erwartet, war {other:?}"),
        }
    }

    #[test]
    fn wand_oberkante_setzt_hoehe_und_bindung() {
        let e = entity(&run("wallTop", "w1", 3.0449));
        assert_eq!(e["height"], json!(3.04));
        assert!(e.get("top").is_none(), "ohne Bindung keine neue");
        // gebundene OK: Bindung wandert mit (Versatz zur Geschoss-Basis des Bezugsgeschosses).
        let e = entity(&run("wallTop", "w2", 3.5));
        assert_eq!(e["top"], json!({"mode": "floor", "floorId": "og", "offset": 0.5}));
        assert_eq!(e["height"], json!(3.5));
        // Mindesthöhe 0.30
        assert_eq!(entity(&run("wallTop", "w1", -2.0))["height"], json!(0.3));
    }

    #[test]
    fn wand_unterkante_haelt_die_oberkante() {
        let e = entity(&run("wallBottom", "w1", -0.5));
        assert_eq!(e["bottom"], json!({"mode": "floor", "floorId": "eg", "offset": -0.5}));
        assert_eq!(e["height"], json!(3.1)); // OK bleibt bei 2.6
        assert_eq!(entity(&run("wallBottom", "w1", 9.0))["height"], json!(0.3));
    }

    #[test]
    fn vorschau_und_fang() {
        // Wand: Mindesthöhe 0.30 über der UK, 1-cm-Raster; Strg ohne Raster.
        assert_eq!(drag(Kind::WallTop, 3.0, 5.6, 3.0, 5.7349, false), (5.73, 3.0));
        assert_eq!(drag(Kind::WallTop, 3.0, 5.6, 3.0, 2.0, false).0, 3.3);
        assert_eq!(drag(Kind::WallTop, 0.0, 2.0, 0.0, 2.3456, true).0, 2.3456);
        // Fenster unten: zwischen Wand-UK und Oberkante − 0.20, Oberkante bleibt.
        assert_eq!(drag(Kind::OpeningBottom, 0.0, 2.1, 0.9, 0.6, false), (2.1, 0.6));
        assert_eq!(drag(Kind::OpeningBottom, 0.0, 2.1, 0.9, -1.0, false).1, 0.0);
        // Decke OK: Platte wandert / UK gebunden bleibt.
        assert_eq!(drag(Kind::CeilingTop, 0.0, 2.6, 2.35, 2.8, false), (2.8, 2.55));
        assert_eq!(drag(Kind::CeilingTopFixed, 0.0, 2.6, 2.35, 2.0, false), (2.4, 2.35));
        assert_eq!(snap_level(2.63, &[0.0, 2.6, 3.0], 0.05), 2.6);
        assert_eq!(snap_level(2.8, &[0.0, 2.6, 3.0], 0.05), 2.8);
        assert_eq!(snap_level(f64::NAN, &[0.0], 0.05).is_nan(), true);
    }

    #[test]
    fn gesperrt_unbekannt_unsinn() {
        assert!(run("wallTop", "w3", 3.0).is_empty());
        assert!(run("wallTop", "nix", 3.0).is_empty());
        assert!(run("wallTop", "w1", f64::NAN).is_empty());
        assert!(run("unbekannt", "w1", 3.0).is_empty());
        assert!(run("wallTop", "w1", 2.6).is_empty(), "keine Änderung = keine Op");
    }

    #[test]
    fn oeffnung_bruestung_und_sturz() {
        let e = entity(&run("openingTop", "f1", 2.4));
        assert_eq!(e["height"], json!(1.5));
        let e = entity(&run("openingBottom", "f1", 0.6));
        assert_eq!((e["sillHeight"].clone(), e["height"].clone()), (json!(0.6), json!(1.5)));
        // Brüstung nie unter die Wand-UK, Höhe mindestens 0.20.
        assert_eq!(entity(&run("openingBottom", "f1", -1.0))["sillHeight"], json!(0));
        assert_eq!(entity(&run("openingBottom", "f1", 5.0))["height"], json!(0.2));
        assert!(run("openingBottom", "t1", 0.5).is_empty(), "Türen haben keine Brüstung");
    }

    #[test]
    fn decke_oberkante_ist_hoehenlage() {
        // Ohne UK-Bindung wandert die Platte (Dicke bleibt): OK 2.6 → 2.8 als Versatz zur Geschoss-Basis.
        let e = entity(&run("ceilingTop", "c1", 2.8));
        assert_eq!(e["top"], json!({"mode": "floor", "floorId": "eg", "offset": 2.8}));
        // Mit UK-Bindung bleibt die UK, Mindestdicke 0.05.
        let e = entity(&run("ceilingTop", "c2", 2.0));
        assert_eq!(e["top"]["offset"], json!(2.35));
    }

    #[test]
    fn decke_unterkante_ist_dicke() {
        // UK 2.35 → 2.2: Dicke 0.25 → 0.4 über den (exklusiven) Typ.
        let ops = run("ceilingBottom", "c1", 2.2);
        let Op::Replace { collection, entity: ty } = &ops[0] else { panic!() };
        assert_eq!(collection, "ceilingTypes");
        assert_eq!(ty["layers"][0]["thickness"], json!(0.4));
        // Eigenes `thickness` der Decke: nur dieses Feld.
        let e = entity(&run("ceilingBottom", "c3", 2.0));
        assert_eq!(e["thickness"], json!(0.6));
        // UK gebunden: Bindung versetzen.
        let e = entity(&run("ceilingBottom", "c2", 2.1));
        assert_eq!(e["bottom"], json!({"mode": "custom", "z": 2.1}));
    }

    fn roof_root() -> Map<String, Value> {
        json!({
            "drawingLevels": [{"id": "eg", "kind": "floor", "baseElevation": 0.0, "floorHeight": 2.6}],
            "roofs": [
                {"id": "r1", "type": "roof", "floorId": "eg", "categoryCode": "35", "shape": "sattel", "pitchDeg": 30, "ridgeAxis": "x",
                 "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}], "overhang": 0, "thickness": 0.2},
                {"id": "r2", "type": "roof", "floorId": "eg", "categoryCode": "35", "shape": "flach", "pitchDeg": 0, "baseElevation": 3.5,
                 "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}], "overhang": 0, "thickness": 0.2},
                {"id": "r3", "type": "roof", "floorId": "eg", "shape": "sattel", "pitchDeg": 30, "locked": true, "outline": []}
            ],
            "stairs": [{"id": "s1", "floorId": "eg", "stepCount": 14}, {"id": "s2", "floorId": "eg", "stepCount": 14, "totalRise": 2.8, "locked": true}],
            "context": [
                {"id": "tm", "type": "terrainMesh", "positions": [0, 0, 500, 1, 0, 501, 0, 1, 502]},
                {"id": "hl", "type": "contourSet", "contours": [{"z": 500, "pts": [], "closed": false}, {"z": 501, "pts": [], "closed": false}]},
                {"id": "im", "type": "image"}
            ]
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn run_roof(kind: &str, id: &str, y: f64, b: f64, index: f64) -> Vec<Op> {
        let r = roof_root();
        ops(&Lookup::plain(&r), kind, id, y, false, "", &Value::Null, b, index)
    }

    #[test]
    fn dach_traufe_verschiebt_das_dach() {
        let e = entity(&run_roof("roofEave", "r1", 2.7449, f64::NAN, f64::NAN));
        assert_eq!(e["baseElevation"], json!(2.74));
        assert_eq!(e["pitchDeg"], json!(30));
        assert!(run_roof("roofEave", "r2", 3.5, f64::NAN, f64::NAN).is_empty(), "gleiche Traufe: keine Änderung");
        assert!(run_roof("roofEave", "r3", 3.0, f64::NAN, f64::NAN).is_empty(), "gesperrt");
    }

    #[test]
    fn dach_first_rechnet_die_neigung() {
        // Spannweite 8 m: First bei 30° = 4 * tan 30° = 2.309 m über der Traufe (2.6).
        let r = roof_root();
        let r1 = r["roofs"][0].clone();
        let h0 = crate::selection_info::roof_ridge_height(&r1, 2.6).unwrap();
        assert!((h0 - 4.0 * 30f64.to_radians().tan()).abs() < 1e-6, "{h0}");
        let e = entity(&run_roof("roofTop", "r1", 2.6 + 3.0, f64::NAN, f64::NAN));
        let p = e["pitchDeg"].as_f64().unwrap();
        assert!(p > 30.0);
        let h = crate::selection_info::roof_ridge_height(&e, 2.6).unwrap();
        assert!((h - 3.0).abs() < 0.01, "First liegt auf der Kote: {h}");
        // Mindesthöhe: nie flacher als 0.10 m über der Traufe; Flachdach hat keinen First.
        let p_min = entity(&run_roof("roofTop", "r1", 0.0, f64::NAN, f64::NAN))["pitchDeg"].as_f64().unwrap();
        assert!(p_min < 2.0 && p_min >= 0.5);
        assert!(run_roof("roofTop", "r2", 6.0, f64::NAN, f64::NAN).is_empty());
    }

    #[test]
    fn dach_attika_nur_beim_flachdach() {
        let e = entity(&run_roof("parapetTop", "r2", 3.95, f64::NAN, f64::NAN));
        assert_eq!(e["parapetHeight"], json!(0.45));
        assert_eq!(entity(&run_roof("parapetTop", "r2", 1.0, f64::NAN, f64::NAN))["parapetHeight"], json!(0));
        assert!(run_roof("parapetTop", "r1", 4.0, f64::NAN, f64::NAN).is_empty());
    }

    #[test]
    fn treppe_austritt_setzt_die_steighoehe() {
        assert_eq!(entity(&run_roof("stairTop", "s1", 2.9, f64::NAN, f64::NAN))["totalRise"], json!(2.9));
        assert_eq!(entity(&run_roof("stairTop", "s1", -4.0, f64::NAN, f64::NAN))["totalRise"], json!(0.3));
        assert!(run_roof("stairTop", "s2", 3.0, f64::NAN, f64::NAN).is_empty(), "gesperrt");
    }

    #[test]
    fn gelaende_versatz_und_hoehenlinie() {
        // Netz: höchster Punkt stand auf 502, Zug auf 503.5 → alle z um 1.5 höher.
        let e = entity(&run_roof("contextTop", "tm", 503.5, 502.0, f64::NAN));
        assert_eq!(e["positions"], json!([0, 0, 501.5, 1, 0, 502.5, 0, 1, 503.5]));
        // Höhenlinie 1 auf 510.
        let e = entity(&run_roof("contourLine", "hl", 510.0, f64::NAN, 1.0));
        assert_eq!(e["contours"][1]["z"], json!(510));
        assert_eq!(e["contours"][0]["z"], json!(500));
        assert!(run_roof("contourLine", "hl", 510.0, f64::NAN, 7.0).is_empty());
        assert!(run_roof("contextTop", "im", 5.0, 4.0, f64::NAN).is_empty(), "Luftbild hat keine Höhe");
        assert!(run_roof("contextTop", "tm", 502.0, 502.0, f64::NAN).is_empty());
    }

    #[test]
    fn dach_und_treppe_relativ_zur_griffhoehe() {
        // Sichtbare Kante stand auf 5.0 (Überstand/Dicke), Zug auf 5.5 → Traufe 2.6 + 0.5.
        let e = entity(&run_roof("roofEave", "r1", 5.5, 5.0, f64::NAN));
        assert_eq!(e["baseElevation"], json!(3.1));
        // Treppe ohne totalRise: Geschosshöhe 2.6; Griff stand auf 2.7, Zug auf 2.9 → 2.8.
        assert_eq!(entity(&run_roof("stairTop", "s1", 2.9, 2.7, f64::NAN))["totalRise"], json!(2.8));
        // First: Zug um +1 m über den heutigen First hebt die Neigung.
        let r = roof_root();
        let h0 = crate::selection_info::roof_ridge_height(&r["roofs"][0], 2.6).unwrap();
        let e = entity(&run_roof("roofTop", "r1", 6.0, 5.0, f64::NAN));
        let h = crate::selection_info::roof_ridge_height(&e, 2.6).unwrap();
        assert!((h - (h0 + 1.0)).abs() < 0.01, "{h} vs {h0}+1");
    }

    #[test]
    fn vorschau_dach_und_treppe() {
        assert_eq!(drag(Kind::RoofEave, 0.0, 5.0, 2.6, 3.0, false), (5.4, 3.0));
        assert_eq!(drag(Kind::RoofTop, 0.0, 5.0, 2.6, 2.0, false), (2.7, 2.6));
        assert_eq!(drag(Kind::ParapetTop, 0.0, 3.0, 3.0, 2.0, false), (3.0, 3.0));
        assert_eq!(drag(Kind::StairTop, 0.0, 2.6, 0.0, 0.1, false), (0.3, 0.0));
    }

    #[test]
    fn wand_unterkante_unter_geschoss_erlaubt() {
        // Kellerwand: UK unter der Geschoss-Basis (0.0) ist erlaubt; über OK bleibt die Mindesthöhe.
        let e = entity(&run("wallBottom", "w1", -1.2));
        assert_eq!(e["bottom"], json!({"mode": "floor", "floorId": "eg", "offset": -1.2}));
        assert_eq!(e["height"], json!(3.8));
        assert_eq!(entity(&run("wallBottom", "w1", 4.0))["height"], json!(0.3));
    }
}
