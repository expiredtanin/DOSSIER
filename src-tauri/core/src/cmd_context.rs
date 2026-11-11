//! [193] Höhe von Gelände-/Umgebungs-Elementen als Befehle (vorher `src/state/contextHeight.ts`):
//! `contextOffset` versetzt alle Höhen eines Elements um `dz` (Netz-z, Höhenlinien-z, Baugruben-Sohle),
//! `contourZ` setzt die Höhe einer einzelnen Höhenlinie. Ergebnis: ein `Replace` des Elements in `context`
//! (leer = Art ohne Höhe, keine Änderung oder ungültige Eingabe).

use crate::json_util::{arr, field, js_num, num_of, with};
use crate::ops::{id_of, Op};
use serde_json::{Map, Value};

fn element<'a>(root: &'a Map<String, Value>, id: &str) -> Option<&'a Value> {
    arr(root.get("context")).iter().find(|e| id_of(e) == Some(id))
}

fn kind(e: &Value) -> &str {
    field(e, "type").and_then(Value::as_str).unwrap_or("")
}

/// Alle Höhen von `e` um `dz` Meter versetzt; `None` bei Art ohne Höhe oder `dz` = 0/ungültig.
pub fn height_offset(e: &Value, dz: f64) -> Option<Value> {
    if !dz.is_finite() || dz == 0.0 {
        return None;
    }
    match kind(e) {
        "terrainMesh" | "importedMesh" => {
            let pos: Vec<Value> = arr(field(e, "positions"))
                .iter()
                .enumerate()
                .map(|(i, v)| if i % 3 == 2 { js_num(num_of(Some(v)) + dz) } else { v.clone() })
                .collect();
            Some(with(e, "positions", Value::Array(pos)))
        }
        "contourSet" => {
            let cs: Vec<Value> = arr(field(e, "contours")).iter().map(|c| with(c, "z", js_num(num_of(field(c, "z")) + dz))).collect();
            Some(with(e, "contours", Value::Array(cs)))
        }
        "excavation" => Some(with(e, "bottom", js_num(num_of(field(e, "bottom")) + dz))),
        _ => None,
    }
}

/// Höhe der Höhenlinie `index` eines Höhenlinien-Satzes auf `z` setzen.
pub fn contour_height(e: &Value, index: usize, z: f64) -> Option<Value> {
    if kind(e) != "contourSet" || !z.is_finite() {
        return None;
    }
    let cs = arr(field(e, "contours"));
    let c = cs.get(index)?;
    if num_of(field(c, "z")) == z {
        return None;
    }
    let mut out = cs.to_vec();
    out[index] = with(c, "z", js_num(z));
    Some(with(e, "contours", Value::Array(out)))
}

/// Ops der Höhen-Befehle (`None` = fremder Befehl).
pub fn ops(root: &Map<String, Value>, v: &Value) -> Option<Vec<Op>> {
    let cmd = v.get("cmd").and_then(Value::as_str)?;
    if cmd != "contextOffset" && cmd != "contourZ" {
        return None;
    }
    let num = |k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN);
    let patched = v.get("id").and_then(Value::as_str).and_then(|id| element(root, id)).and_then(|e| {
        if cmd == "contextOffset" {
            height_offset(e, num("dz"))
        } else {
            let i = num("index");
            if i.is_finite() && i >= 0.0 { contour_height(e, i as usize, num("z")) } else { None }
        }
    });
    Some(patched.map(|entity| vec![Op::Replace { collection: "context".into(), entity }]).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root() -> Map<String, Value> {
        json!({"context":[
            {"id":"tm","type":"terrainMesh","positions":[0,0,5, 1,0,6, 0,1,7],"indices":[0,1,2]},
            {"id":"hl","type":"contourSet","contours":[{"z":500,"pts":[],"closed":false},{"z":501,"pts":[],"closed":false}]},
            {"id":"bg","type":"excavation","bottom":-3,"outline":[]},
            {"id":"im","type":"image"}]})
        .as_object()
        .unwrap()
        .clone()
    }

    fn run(v: Value) -> Vec<Value> {
        ops(&root(), &v).unwrap().iter().map(|o| o.to_json()).collect()
    }

    #[test]
    fn versatz_je_art() {
        let o = run(json!({"cmd":"contextOffset","id":"tm","dz":-1.5}));
        assert_eq!(o[0]["entity"]["positions"], json!([0, 0, 3.5, 1, 0, 4.5, 0, 1, 5.5]));
        assert_eq!(o[0]["entity"]["indices"], json!([0, 1, 2]));
        let o = run(json!({"cmd":"contextOffset","id":"hl","dz":2}));
        assert_eq!(o[0]["entity"]["contours"][0]["z"], json!(502));
        assert_eq!(o[0]["entity"]["contours"][1]["z"], json!(503));
        let o = run(json!({"cmd":"contextOffset","id":"bg","dz":0.5}));
        assert_eq!(o[0]["entity"]["bottom"], json!(-2.5));
        assert_eq!(o[0]["collection"], "context");
    }

    #[test]
    fn keine_aenderung() {
        assert!(run(json!({"cmd":"contextOffset","id":"hl","dz":0})).is_empty());
        assert!(run(json!({"cmd":"contextOffset","id":"im","dz":1})).is_empty());
        assert!(run(json!({"cmd":"contextOffset","id":"nix","dz":1})).is_empty());
        assert!(run(json!({"cmd":"contextOffset","id":"hl"})).is_empty());
    }

    #[test]
    fn hoehe_einer_linie() {
        let o = run(json!({"cmd":"contourZ","id":"hl","index":1,"z":510}));
        assert_eq!(o[0]["entity"]["contours"][0]["z"], json!(500));
        assert_eq!(o[0]["entity"]["contours"][1]["z"], json!(510));
        assert!(run(json!({"cmd":"contourZ","id":"hl","index":1,"z":501})).is_empty());
        assert!(run(json!({"cmd":"contourZ","id":"hl","index":7,"z":1})).is_empty());
        assert!(run(json!({"cmd":"contourZ","id":"tm","index":0,"z":1})).is_empty());
    }
}
