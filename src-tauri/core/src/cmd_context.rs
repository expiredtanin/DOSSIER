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


/// Doppelte Fläche des Dreiecks (x,y), positiv = gegen den Uhrzeigersinn.
fn area2(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

/// Ohr-Triangulation eines Polygons (Punktnummern `poly` in Umlaufrichtung, Drehsinn `sign` = ±1 wie die Netz-Dreiecke).
/// Findet sich kein Ohr (entartet), wird der Rest als Fächer vom ersten Punkt aus gefüllt.
fn ear_clip(pts: &[(f64, f64)], poly: &[usize], sign: f64) -> Vec<[usize; 3]> {
    let mut rest: Vec<usize> = poly.to_vec();
    let mut out = Vec::new();
    while rest.len() > 3 {
        let n = rest.len();
        let ear = (0..n).find(|&k| {
            let (a, b, c) = (rest[(k + n - 1) % n], rest[k], rest[(k + 1) % n]);
            if area2(pts[a], pts[b], pts[c]) * sign <= 1e-12 {
                return false;
            }
            !rest.iter().any(|&q| {
                q != a && q != b && q != c && {
                    let (d1, d2, d3) = (area2(pts[a], pts[b], pts[q]) * sign, area2(pts[b], pts[c], pts[q]) * sign, area2(pts[c], pts[a], pts[q]) * sign);
                    d1 >= 0.0 && d2 >= 0.0 && d3 >= 0.0
                }
            })
        });
        match ear {
            Some(k) => {
                out.push([rest[(k + n - 1) % n], rest[k], rest[(k + 1) % n]]);
                rest.remove(k);
            }
            None => {
                for w in 1..n - 1 {
                    out.push([rest[0], rest[w], rest[w + 1]]);
                }
                return out;
            }
        }
    }
    if rest.len() == 3 && area2(pts[rest[0]], pts[rest[1]], pts[rest[2]]).abs() > 1e-12 {
        out.push([rest[0], rest[1], rest[2]]);
    }
    out
}

/// Netzpunkt `index` löschen: seine Dreiecke fallen weg, das entstehende Loch (Rand der Dreiecke um den Punkt) wird
/// per Ohr-Triangulation neu vernetzt (am Netzrand schliesst die Sehne zwischen den beiden Randpunkten). Ist der Rand
/// um den Punkt nicht eine einfache Kette/Schleife (nicht-mannigfaltig), bleibt das Loch offen. Punkt, `vertexColors`
/// und Indizes werden nachgeführt; ein Netz mit weniger als drei Punkten danach = keine Änderung.
pub fn mesh_point_delete(e: &Value, index: usize) -> Option<Value> {
    if !matches!(kind(e), "terrainMesh" | "importedMesh") {
        return None;
    }
    let pos: Vec<f64> = arr(field(e, "positions")).iter().map(|v| num_of(Some(v))).collect();
    let idx: Vec<usize> = arr(field(e, "indices")).iter().map(|v| num_of(Some(v))).map(|f| if f >= 0.0 && f.fract() == 0.0 { f as usize } else { usize::MAX }).collect();
    let nv = pos.len() / 3;
    if index >= nv || nv <= 3 || idx.len() % 3 != 0 || idx.iter().any(|&i| i >= nv) || pos.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let xy: Vec<(f64, f64)> = (0..nv).map(|i| (pos[3 * i], pos[3 * i + 1])).collect();
    let mut tris: Vec<[usize; 3]> = Vec::new();
    let mut rim: Vec<(usize, usize)> = Vec::new(); // gerichtete Randkanten a->b der Dreiecke (v, a, b)
    let mut sign_sum = 0.0;
    for t in idx.chunks_exact(3) {
        let Some(k) = t.iter().position(|&i| i == index) else {
            tris.push([t[0], t[1], t[2]]);
            continue;
        };
        let (a, b) = (t[(k + 1) % 3], t[(k + 2) % 3]);
        sign_sum += area2(xy[index], xy[a], xy[b]);
        rim.push((a, b));
    }
    if !rim.is_empty() && sign_sum != 0.0 {
        // Kanten zu einer Kette (offen, Rand) bzw. Schleife (innen) verbinden; jeder Punkt darf nur einmal beginnen/enden.
        let mut next = std::collections::HashMap::new();
        let mut has_in = std::collections::HashSet::new();
        let mut simple = true;
        for &(a, b) in &rim {
            simple &= next.insert(a, b).is_none() && has_in.insert(b);
        }
        let start = rim.iter().map(|r| r.0).find(|a| !has_in.contains(a)).unwrap_or(rim[0].0);
        let mut poly = vec![start];
        while let Some(&n) = next.get(poly.last().unwrap()) {
            if n == start || poly.len() > rim.len() {
                break;
            }
            poly.push(n);
        }
        if simple && poly.len() == rim.len() {
            tris.extend(ear_clip(&xy, &poly, sign_sum.signum()));
        }
    }
    let remap = |i: usize| if i > index { i - 1 } else { i };
    let new_idx: Vec<Value> = tris.iter().flatten().map(|&i| js_num(remap(i) as f64)).collect();
    let drop3 = |src: &[Value]| -> Vec<Value> { src.iter().enumerate().filter(|(i, _)| i / 3 != index).map(|(_, v)| v.clone()).collect() };
    let mut out = with(&with(e, "positions", Value::Array(drop3(arr(field(e, "positions"))))), "indices", Value::Array(new_idx));
    if let Some(vc) = field(e, "vertexColors").and_then(Value::as_array).filter(|c| c.len() == nv * 3) {
        out = with(&out, "vertexColors", Value::Array(drop3(vc)));
    }
    Some(out)
}

/// Ops der Höhen-/Netz-Befehle (`None` = fremder Befehl).
pub fn ops(root: &Map<String, Value>, v: &Value) -> Option<Vec<Op>> {
    let cmd = v.get("cmd").and_then(Value::as_str)?;
    if !matches!(cmd, "contextOffset" | "contourZ" | "meshPointZ" | "meshCrop" | "meshPointDelete") {
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
        "meshPointDelete" => mesh_point_delete(e, index()?),
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
    fn netzpunkt_loeschen_vernetzt_das_loch() {
        let mut r = root();
        // Innenpunkt 4 (Mitte) eines Quadrats 0..2 mit vier Dreiecken -> Loch = Quadrat, zwei Dreiecke, Punkt weg.
        r.insert("context".into(), json!([{"id":"q","type":"terrainMesh",
            "positions":[0,0,0, 2,0,0, 2,2,0, 0,2,0, 1,1,9],
            "indices":[0,1,4, 1,2,4, 2,3,4, 3,0,4], "vertexColors":[0,0,0, 1,1,1, 2,2,2, 3,3,3, 4,4,4]}]));
        let del = |r: &Map<String, Value>, i: usize| ops(r, &json!({"cmd":"meshPointDelete","id":"q","index":i})).unwrap().iter().map(|o| o.to_json()).collect::<Vec<_>>();
        let o = del(&r, 4);
        let e = &o[0]["entity"];
        assert_eq!(e["positions"].as_array().unwrap().len(), 12);
        assert_eq!(e["vertexColors"].as_array().unwrap().len(), 12);
        let ix: Vec<f64> = e["indices"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        assert_eq!(ix.len(), 6);
        // Fläche bleibt 4, Drehsinn (gegen den Uhrzeigersinn) bleibt.
        let p: Vec<f64> = e["positions"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let a2: f64 = ix.chunks(3).map(|t| area2((p[3 * t[0] as usize], p[3 * t[0] as usize + 1]), (p[3 * t[1] as usize], p[3 * t[1] as usize + 1]), (p[3 * t[2] as usize], p[3 * t[2] as usize + 1]))).sum();
        assert!((a2 - 8.0).abs() < 1e-9, "{a2}");
        // Eckpunkt 0 am Netzrand: Dreiecke (0,1,4) und (3,0,4) fallen weg, Sehne 1-4-3 ist entartet (kollinear) und entfällt -> 2 Dreiecke, kein Index >= 4.
        let o = del(&r, 0);
        let e = &o[0]["entity"];
        let ix: Vec<f64> = e["indices"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        assert_eq!(ix.len(), 6);
        assert!(ix.iter().all(|&i| i < 4.0));
        assert_eq!(e["positions"].as_array().unwrap().len(), 12);
        // ungültig: Index ausserhalb, Netz mit nur drei Punkten, fremde Art
        assert!(del(&r, 5).is_empty());
        assert!(run(json!({"cmd":"meshPointDelete","id":"tm","index":0})).is_empty());
        assert!(run(json!({"cmd":"meshPointDelete","id":"hl","index":0})).is_empty());
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
