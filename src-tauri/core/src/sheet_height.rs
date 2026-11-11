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
//!
//! Raster 1 cm (`free` = ohne), Mindestmasse: Wand 0.30 m, Öffnung 0.20 m, Decke 0.05 m. Bindungen bleiben in ihrer
//! Art (Geschoss + Versatz bleibt Geschoss + Versatz, absolut bleibt absolut); ohne Bindung entsteht eine
//! Geschoss-Bindung des eigenen Geschosses. Gesperrte Bauteile ändern sich nicht.

use crate::document::Lookup;
use crate::json_util::{field, js_num, num_of, truthy, with, with_all};
use crate::jsnum;
use crate::ops::Op;
use crate::selection_info::{anchor, ceiling_extent, ceiling_thickness as ceiling_thickness_of, vertical_extent};
use serde_json::{json, Map, Value};

const MIN_WALL: f64 = 0.3;
const MIN_OPENING: f64 = 0.2;
const MIN_CEILING: f64 = 0.05;

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
}

impl Kind {
    pub fn from_index(i: u32) -> Option<Kind> {
        use Kind::*;
        [WallTop, OpeningTop, OpeningBottom, WallBottom, CeilingTop, CeilingTopFixed, CeilingBottom].get(i as usize).copied()
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
pub fn ops(lk: &Lookup, kind: &str, id: &str, y: f64, free: bool, new_id: &str, new_name: &Value) -> Vec<Op> {
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
        _ => vec![],
    }
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
        ops(&Lookup::plain(&r), kind, id, y, false, "ct-neu", &json!("Neu"))
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

}
