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

/// Höhe des Netzpunkts `index` (Vertex-Nummer) eines Geländes/Netzes auf `z` setzen.
pub fn mesh_point_height(e: &Value, index: usize, z: f64) -> Option<Value> {
    if !matches!(kind(e), "terrainMesh" | "importedMesh") || !z.is_finite() {
        return None;
    }
    let pos = arr(field(e, "positions"));
    let k = index.checked_mul(3)?.checked_add(2)?;
    if k >= pos.len() || num_of(Some(&pos[k])) == z {
        return None;
    }
    let mut out = pos.to_vec();
    out[k] = js_num(z);
    Some(with(e, "positions", Value::Array(out)))
}

/// Netz auf ein Polygon (`poly` = flach x,y,…) zuschneiden: Dreiecke bleiben, deren Schwerpunkt im Polygon liegt; nicht
/// mehr genutzte Punkte (samt `vertexColors`) fallen weg. Nichts übrig oder nichts abgeschnitten = keine Änderung.
pub fn mesh_crop(e: &Value, poly: &[f64]) -> Option<Value> {
    if !matches!(kind(e), "terrainMesh" | "importedMesh") || poly.len() < 6 || poly.len() % 2 != 0 || poly.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let pos: Vec<f64> = arr(field(e, "positions")).iter().map(|v| num_of(Some(v))).collect();
    let idx: Vec<usize> = arr(field(e, "indices")).iter().map(|v| num_of(Some(v))).map(|f| if f >= 0.0 && f.fract() == 0.0 { f as usize } else { usize::MAX }).collect();
    let nv = pos.len() / 3;
    if idx.len() < 3 || idx.iter().any(|&i| i >= nv) {
        return None;
    }
    let keep: Vec<&[usize]> = idx
        .chunks_exact(3)
        .filter(|t| {
            let (cx, cy) = t.iter().fold((0.0, 0.0), |a, &i| (a.0 + pos[3 * i] / 3.0, a.1 + pos[3 * i + 1] / 3.0));
            crate::plan::pick::point_in_polygon(cx, cy, poly)
        })
        .collect();
    if keep.is_empty() || keep.len() == idx.len() / 3 {
        return None;
    }
    let mut map = vec![usize::MAX; nv];
    let mut order: Vec<usize> = Vec::new();
    let mut new_idx: Vec<Value> = Vec::with_capacity(keep.len() * 3);
    for t in keep {
        for &i in t {
            if map[i] == usize::MAX {
                map[i] = order.len();
                order.push(i);
            }
            new_idx.push(js_num(map[i] as f64));
        }
    }
    let new_pos: Vec<Value> = order.iter().flat_map(|&i| (0..3).map(move |c| (i, c))).map(|(i, c)| js_num(pos[3 * i + c])).collect();
    let mut out = with(&with(e, "positions", Value::Array(new_pos)), "indices", Value::Array(new_idx));
    if let Some(vc) = field(e, "vertexColors").and_then(Value::as_array).filter(|c| c.len() == nv * 3) {
        let nc: Vec<Value> = order.iter().flat_map(|&i| vc[3 * i..3 * i + 3].iter().cloned()).collect();
        out = with(&out, "vertexColors", Value::Array(nc));
    }
    Some(out)
}

/// Ops der Höhen-/Netz-Befehle (`None` = fremder Befehl).
pub fn ops(root: &Map<String, Value>, v: &Value) -> Option<Vec<Op>> {
    let cmd = v.get("cmd").and_then(Value::as_str)?;
    if !matches!(cmd, "contextOffset" | "contourZ" | "meshPointZ" | "meshCrop") {
        return None;
    }
    let num = |k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN);
    let index = || {
        let i = num("index");
        (i.is_finite() && i >= 0.0).then_some(i as usize)
    };
    let patched = v.get("id").and_then(Value::as_str).and_then(|id| element(root, id)).and_then(|e| match cmd {
        "contextOffset" => height_offset(e, num("dz")),
        "contourZ" => contour_height(e, index()?, num("z")),
        "meshPointZ" => mesh_point_height(e, index()?, num("z")),
        _ => {
            let poly: Vec<f64> = v.get("poly").and_then(Value::as_array)?.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect();
            mesh_crop(e, &poly)
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
    fn netzpunkt_hoehe_und_zuschnitt() {
        let o = run(json!({"cmd":"meshPointZ","id":"tm","index":1,"z":9}));
        assert_eq!(o[0]["entity"]["positions"], json!([0, 0, 5, 1, 0, 9, 0, 1, 7]));
        assert!(run(json!({"cmd":"meshPointZ","id":"tm","index":1,"z":6})).is_empty());
        assert!(run(json!({"cmd":"meshPointZ","id":"tm","index":3,"z":6})).is_empty());
        assert!(run(json!({"cmd":"meshPointZ","id":"hl","index":0,"z":6})).is_empty());
        // Zwei Dreiecke (Quadrat 0..2); Zuschnitt auf die linke Hälfte behält eines, verwirft Punkte und Farben.
        let mut r = root();
        r.insert("context".into(), json!([{"id":"q","type":"terrainMesh","positions":[0,0,1, 2,0,2, 2,2,3, 0,2,4],"indices":[0,1,2, 0,2,3],"vertexColors":[0,0,0, 1,1,1, 2,2,2, 3,3,3]}]));
        let cut = |poly: Value| ops(&r, &json!({"cmd":"meshCrop","id":"q","poly":poly})).unwrap().iter().map(|o| o.to_json()).collect::<Vec<_>>();
        let o = cut(json!([-1.0, -1.0, 1.5, -1.0, 1.5, 3.0, -1.0, 3.0]));
        // Schwerpunkte: (4/3, 2/3) und (2/3, 4/3) -> beide liegen links von 1.5: nichts abgeschnitten.
        assert!(o.is_empty());
        let o = cut(json!([-1.0, -1.0, 1.0, -1.0, 1.0, 3.0, -1.0, 3.0]));
        assert_eq!(o[0]["entity"]["indices"], json!([0, 1, 2]));
        assert_eq!(o[0]["entity"]["positions"], json!([0, 0, 1, 2, 2, 3, 0, 2, 4]));
        assert_eq!(o[0]["entity"]["vertexColors"], json!([0, 0, 0, 2, 2, 2, 3, 3, 3]));
        // ausserhalb von allem / kaputtes Polygon
        assert!(cut(json!([10, 10, 11, 10, 11, 11])).is_empty());
        assert!(cut(json!([0, 0, 1])).is_empty());
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
