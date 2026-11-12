//! [227] Kontextgebäude aufs Gelände setzen: jedes zusammenhängende Gebäude eines Netzes (Kataster-Extrusion,
//! swisstopo/OSM, importierte Körper) wird senkrecht so verschoben, dass sein Fuss auf dem tiefsten Geländepunkt
//! unter dem Grundriss liegt. Auf der Hangseite verschwindet der Sockel im Boden, talseitig bleibt kein Spalt.
//! Gelände = gewachsenes Terrain im Modellbezug (`excavation::terrain_z_many`), Baugruben zählen nicht.

use crate::excavation::terrain_z_many;
use crate::model::Project;
use crate::terrain::P2;
use serde_json::Value;
use std::collections::HashMap;

/// Höchstens so viele Rasterschritte je Richtung unter dem Grundriss.
const MAX_GRID: f64 = 40.0;
/// Fusshöhe: Punkte höchstens so viel über dem tiefsten Punkt gehören zum Fuss.
const FOOT_TOL: f64 = 0.05;

fn find(parent: &mut [usize], mut a: usize) -> usize {
    while parent[a] != a {
        parent[a] = parent[parent[a]];
        a = parent[a];
    }
    a
}

fn in_tri(p: P2, a: P2, b: P2, c: P2) -> bool {
    let s = |p: P2, q: P2, r: P2| (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
    let (d1, d2, d3) = (s(p, a, b), s(p, b, c), s(p, c, a));
    !((d1 < 0.0 || d2 < 0.0 || d3 < 0.0) && (d1 > 0.0 || d2 > 0.0 || d3 > 0.0))
}

/// Höhenversatz je Vertex: Gebäude (Komponenten, Vertices auf 1 mm verschweisst) auf den tiefsten Geländepunkt unter
/// ihrem Grundriss. `0.0` für Gebäude ohne Gelände darunter. Leer bei unbrauchbarem Netz.
pub fn ground_offsets(p: &Project, pos: &[f64], idx: &[f64]) -> Vec<f64> {
    let n = pos.len() / 3;
    if n == 0 || idx.len() < 3 || pos.iter().any(|v| !v.is_finite()) {
        return Vec::new();
    }
    let tris: Vec<[usize; 3]> = idx
        .chunks_exact(3)
        .filter(|c| c.iter().all(|v| v.is_finite() && *v >= 0.0 && (*v as usize) < n))
        .map(|c| [c[0] as usize, c[1] as usize, c[2] as usize])
        .collect();
    let mut parent: Vec<usize> = (0..n).collect();
    let mut seen: HashMap<(i64, i64, i64), usize> = HashMap::new();
    for i in 0..n {
        let k = ((pos[3 * i] * 1000.0).round() as i64, (pos[3 * i + 1] * 1000.0).round() as i64, (pos[3 * i + 2] * 1000.0).round() as i64);
        let first = *seen.entry(k).or_insert(i);
        let (a, b) = (find(&mut parent, first), find(&mut parent, i));
        parent[b] = a;
    }
    for t in &tris {
        let (a, b) = (find(&mut parent, t[0]), find(&mut parent, t[1]));
        parent[b] = a;
        let (a, c) = (find(&mut parent, t[0]), find(&mut parent, t[2]));
        parent[c] = a;
    }
    let comp: Vec<usize> = (0..n).map(|i| find(&mut parent, i)).collect();
    let mut groups: HashMap<usize, (Vec<usize>, Vec<usize>)> = HashMap::new();
    for (i, &c) in comp.iter().enumerate() {
        groups.entry(c).or_default().0.push(i);
    }
    for (ti, t) in tris.iter().enumerate() {
        groups.entry(comp[t[0]]).or_default().1.push(ti);
    }
    let xy = |i: usize| -> P2 { [pos[3 * i], pos[3 * i + 1]] };
    let mut out = vec![0.0; n];
    for (verts, tri_ids) in groups.values() {
        let zmin = verts.iter().map(|&i| pos[3 * i + 2]).fold(f64::INFINITY, f64::min);
        let foot = |i: usize| pos[3 * i + 2] <= zmin + FOOT_TOL;
        // Abfragepunkte: Fusspunkte, Fusskanten (alle <= 1 m) und ein Raster innerhalb des Grundrisses.
        let mut q: Vec<P2> = verts.iter().filter(|&&i| foot(i)).map(|&i| xy(i)).collect();
        for &ti in tri_ids {
            let t = tris[ti];
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                if foot(a) && foot(b) {
                    let (pa, pb) = (xy(a), xy(b));
                    let steps = (pa[0] - pb[0]).hypot(pa[1] - pb[1]).ceil().clamp(1.0, 200.0) as usize;
                    for s in 1..steps {
                        let f = s as f64 / steps as f64;
                        q.push([pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f]);
                    }
                }
            }
        }
        let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
        for &i in verts {
            for k in 0..2 {
                lo[k] = lo[k].min(pos[3 * i + k]);
                hi[k] = hi[k].max(pos[3 * i + k]);
            }
        }
        let step = ((hi[0] - lo[0]).max(hi[1] - lo[1]) / MAX_GRID).max(1.0);
        let mut x = lo[0] + step / 2.0;
        while x < hi[0] {
            let mut y = lo[1] + step / 2.0;
            while y < hi[1] {
                let g = [x, y];
                if tri_ids.iter().any(|&ti| in_tri(g, xy(tris[ti][0]), xy(tris[ti][1]), xy(tris[ti][2]))) {
                    q.push(g);
                }
                y += step;
            }
            x += step;
        }
        let zt = terrain_z_many(p, &q).iter().filter_map(|(orig, _)| *orig).fold(f64::INFINITY, f64::min);
        if zt.is_finite() {
            let dz = zt - zmin;
            for &i in verts {
                out[i] = dz;
            }
        }
    }
    out
}

/// Das Netz-Element `e` (`importedMesh`) aufs Gelände gesetzt; `None` ohne Änderung (keine Netzart, kein Gelände,
/// schon aufgesetzt).
pub fn ground_element(p: &Project, e: &Value) -> Option<Value> {
    if e.get("type").and_then(Value::as_str) != Some("importedMesh") {
        return None;
    }
    let num = |v: &Value| v.as_f64().unwrap_or(f64::NAN);
    let pos: Vec<f64> = e.get("positions")?.as_array()?.iter().map(num).collect();
    let idx: Vec<f64> = e.get("indices")?.as_array()?.iter().map(num).collect();
    let dz = ground_offsets(p, &pos, &idx);
    if dz.iter().all(|d| d.abs() < 1e-6) {
        return None;
    }
    let moved: Vec<Value> = pos.iter().enumerate().map(|(i, &v)| crate::json_util::js_num(if i % 3 == 2 { v + dz[i / 3] } else { v })).collect();
    Some(crate::json_util::with(e, "positions", Value::Array(moved)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ContextObject, TerrainMesh};

    /// Gelände 100 × 100 m, steigt nach +x um 0.1 m/m (z = 0.1·x).
    fn sloped() -> Project {
        let pos = vec![-50.0, -50.0, -5.0, 50.0, -50.0, 5.0, 50.0, 50.0, 5.0, -50.0, 50.0, -5.0];
        let t = TerrainMesh { id: "g".into(), positions: pos, indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], ..Default::default() };
        Project { context: Some(vec![ContextObject::TerrainMesh(t)]), ..Default::default() }
    }

    fn house(x0: f64, x1: f64, h: f64) -> Value {
        let (y0, y1) = (0.0, 6.0);
        let mut pos = vec![];
        for z in [0.0, h] {
            for (x, y) in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)] {
                pos.extend([x, y, z]);
            }
        }
        let idx: Vec<f64> = vec![0., 1., 2., 0., 2., 3., 4., 6., 5., 4., 7., 6., 0., 1., 5., 0., 5., 4., 1., 2., 6., 1., 6., 5.];
        serde_json::json!({"type":"importedMesh","id":"h","positions":pos,"indices":idx})
    }

    fn zs(e: &Value) -> Vec<f64> {
        e["positions"].as_array().unwrap().chunks(3).map(|c| c[2].as_f64().unwrap()).collect()
    }

    #[test]
    fn haus_steht_auf_dem_tiefsten_punkt() {
        // 10 m breit am Hang: tiefster Punkt bei x = 10, dort liegt das Gelände auf z = 1.0.
        let e = ground_element(&sloped(), &house(10.0, 20.0, 8.0)).unwrap();
        let z = zs(&e);
        assert!((z.iter().cloned().fold(f64::INFINITY, f64::min) - 1.0).abs() < 1e-9, "{z:?}");
        assert!((z.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - 9.0).abs() < 1e-9);
        // zweites Mal: nichts mehr zu tun.
        assert!(ground_element(&sloped(), &e).is_none());
    }

    #[test]
    fn zwei_haeuser_unabhaengig() {
        let (a, b) = (house(-30.0, -20.0, 5.0), house(20.0, 30.0, 5.0));
        let mut pos = a["positions"].as_array().unwrap().clone();
        pos.extend(b["positions"].as_array().unwrap().clone());
        let mut idx = a["indices"].as_array().unwrap().clone();
        idx.extend(b["indices"].as_array().unwrap().iter().map(|v| serde_json::json!(v.as_f64().unwrap() + 8.0)));
        let e = serde_json::json!({"type":"importedMesh","id":"n","positions":pos,"indices":idx});
        let z = zs(&ground_element(&sloped(), &e).unwrap());
        // Westhaus auf x = -30 (z = -3), Osthaus auf x = 20 (z = 2).
        assert!((z[0] + 3.0).abs() < 1e-9 && (z[8] - 2.0).abs() < 1e-9, "{z:?}");
    }

    #[test]
    fn ohne_gelaende_oder_art_keine_aenderung() {
        assert!(ground_element(&Project::default(), &house(0.0, 5.0, 3.0)).is_none());
        assert!(ground_element(&sloped(), &serde_json::json!({"type":"terrainMesh","id":"g"})).is_none());
    }
}
