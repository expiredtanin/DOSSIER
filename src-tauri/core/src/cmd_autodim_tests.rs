//! [81] Automatische Aussenbemassung über den Befehl `autodim`: Ketten dürfen sich nicht kreuzen,
//! Bogenwände bekommen ein Radiusmass, eine umgelegte Klasse bleibt beim erneuten Ausführen.
//! Das grosse Beispiel prüft `MK_FILE=mk.obp cargo test --lib autodim_musterhaus -- --ignored --nocapture`
//! (`mk.obp` aus `dossier-cli :musterhaus-komplex migrate --out mk.obp`).

use crate::ops::Op;
use serde_json::{json, Map, Value};

type P = [f64; 2];

pub(crate) fn run(r: &Map<String, Value>, level: &str, scale: f64) -> Vec<Op> {
    let cmd = json!({"cmd": "autodim", "ctx": {"level": level, "cat": "50"}, "scale": scale, "stamp": "s"}).to_string();
    crate::commands::ops(r, &crate::model::lenient::typed_for_test(r), &cmd).unwrap()
}

pub(crate) fn added(ops: &[Op]) -> Vec<Value> {
    ops.iter().filter_map(|o| if let Op::Add { items, .. } = o { Some(items.clone()) } else { None }).flatten().collect()
}

fn pt(v: &Value) -> P {
    [v["x"].as_f64().unwrap(), v["y"].as_f64().unwrap()]
}

/// Strecken einer geraden Kette (Masslinie samt Überstand, Hilfslinien), wie die Darstellung sie zeichnet.
fn segments(d: &Value, scale: f64) -> Vec<(P, P)> {
    let pts: Vec<P> = d["geom"]["pts"].as_array().unwrap().iter().map(pt).collect();
    let off = d["geom"]["offset"].as_f64().unwrap();
    crate::auto_dimensions::segments_of(&pts, off, scale)
}

fn crosses(a: (P, P), b: (P, P)) -> bool {
    let cr = |o: P, p: P, q: P| (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    let e = 1e-9;
    let (c1, c2, c3, c4) = (cr(a.0, a.1, b.0), cr(a.0, a.1, b.1), cr(b.0, b.1, a.0), cr(b.0, b.1, a.1));
    c1 * c2 < -e && c3 * c4 < -e
}

/// Gruppe einer Kette: Kennung ohne die letzte Stelle (`autodim-eg-south-total` → `autodim-eg-south`).
fn group(id: &str) -> &str {
    id.rsplit_once('-').map_or(id, |x| x.0)
}

/// Alle Paare gerader Auto-Ketten verschiedener Gruppen, die sich kreuzen.
pub(crate) fn crossing_pairs(dims: &[Value], scale: f64) -> Vec<(String, String)> {
    let straight: Vec<&Value> = dims
        .iter()
        .filter(|d| d["geom"]["kind"].is_null() && d["geom"]["arcCenter"].is_null() && !d["id"].as_str().unwrap().contains("-arc-") && !d["id"].as_str().unwrap().contains("-radius-"))
        .collect();
    let mut out = vec![];
    for (i, a) in straight.iter().enumerate() {
        for b in &straight[i + 1..] {
            let (ia, ib) = (a["id"].as_str().unwrap(), b["id"].as_str().unwrap());
            if group(ia) == group(ib) {
                continue;
            }
            let (sa, sb) = (segments(a, scale), segments(b, scale));
            if sa.iter().any(|&x| sb.iter().any(|&y| crosses(x, y))) {
                out.push((ia.to_string(), ib.to_string()));
            }
        }
    }
    out
}

#[test]
#[ignore]
fn autodim_musterhaus() {
    let Ok(path) = std::env::var("MK_FILE") else { return };
    let mut r: Map<String, Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    // MK_OUT=datei: Projekt mit der Aussenbemassung aller Geschosse (1:100) schreiben, zum Ansehen mit der CLI.
    if let Ok(out) = std::env::var("MK_OUT") {
        let mut all = r["drawings2d"].as_array().cloned().unwrap_or_default();
        all.retain(|d| !d["id"].as_str().is_some_and(|i| i.starts_with("autodim-")));
        for level in r["drawingLevels"].as_array().unwrap().iter().filter_map(|l| l["id"].as_str()) {
            all.extend(added(&run(&r, level, 100.0)));
        }
        r.insert("drawings2d".into(), Value::Array(all));
        std::fs::write(out, serde_json::to_string(&r).unwrap()).unwrap();
    }
    for level in r["drawingLevels"].as_array().unwrap().iter().filter_map(|l| l["id"].as_str()) {
        for scale in [100.0, 50.0] {
            let dims = added(&run(&r, level, scale));
            let bad = crossing_pairs(&dims, scale);
            println!("{level} 1:{scale}: {} Ketten, Kreuzungen {bad:?}", dims.len());
            assert!(bad.is_empty(), "{level} 1:{scale}: {bad:?}");
        }
    }
}

/// Musterprojekt mit nach aussen gewölbter Südwand (W1) und den Klassen der abgeleiteten Darstellung.
fn bogenhaus() -> Map<String, Value> {
    let mut v: Value = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
    v["layers"].as_array_mut().unwrap().extend(crate::standards::derived_categories());
    for w in v["walls"].as_array_mut().unwrap() {
        if w["id"] == "W1" {
            w["bulge"] = json!(-0.4);
        }
    }
    serde_json::from_value(v).unwrap()
}

fn cat_of<'a>(dims: &'a [Value], id: &str) -> Option<&'a str> {
    dims.iter().find(|d| d["id"] == id).and_then(|d| d["categoryCode"].as_str())
}

/// Radiusmass je Bogenwand der Hülle, an der Wand verankert, auf der Klasse „Auto-Bemassung".
#[test]
fn bogenwand_bekommt_radiusmass() {
    let r = bogenhaus();
    let dims = added(&run(&r, "eg", 100.0));
    let rad: Vec<&Value> = dims.iter().filter(|d| d["id"].as_str().unwrap().contains("-radius-")).collect();
    assert_eq!(rad.len(), 1, "{:?}", dims.iter().map(|d| d["id"].clone()).collect::<Vec<_>>());
    let d = rad[0];
    assert_eq!(d["id"], "autodim-eg-radius-W1");
    assert_eq!(d["geom"]["kind"], "radius");
    assert_eq!(d["categoryCode"], crate::standards::AUTO_DIM_CATEGORY);
    let pts: Vec<P> = d["geom"]["pts"].as_array().unwrap().iter().map(pt).collect();
    assert_eq!(pts.len(), 2);
    // Mittelpunkt → Rand der gewölbten Fläche: Aussenfläche einer 5 m langen Bogenwand mit Pfeil rund 1.0 m, Rand unter y = 0.
    let (c, q) = (pts[0], pts[1]);
    let radius = (q[0] - c[0]).hypot(q[1] - c[1]);
    assert!(radius > 3.5 && radius < 4.2 && q[1] < -1.0, "{radius} {q:?}");
    assert!(d["geom"]["refs"].as_array().is_some_and(|r| r.iter().any(|x| !x.is_null())), "verankert: {d}");
    // Gerade Wände: kein Radiusmass.
    let mut g = Value::Object(r);
    for w in g["walls"].as_array_mut().unwrap() {
        w["bulge"] = Value::Null;
    }
    let g = g.as_object().unwrap().clone();
    assert!(added(&run(&g, "eg", 100.0)).iter().all(|d| !d["id"].as_str().unwrap().contains("-radius-")));
}

/// Beim erneuten Ausführen bleibt eine auf eine andere Klasse gelegte Auto-Kette dort.
#[test]
fn umgelegte_klasse_bleibt() {
    let mut r = bogenhaus();
    let first = added(&run(&r, "eg", 100.0));
    assert!(first.iter().all(|d| d["categoryCode"] == crate::standards::AUTO_DIM_CATEGORY));
    // Nutzer legt eine Kette und das Radiusmass auf Klasse „60".
    let moved: Vec<Value> = first
        .iter()
        .map(|d| {
            let mut d = d.clone();
            if d["id"] == "autodim-eg-south-total" || d["id"] == "autodim-eg-radius-W1" {
                d["categoryCode"] = json!("60");
            }
            d
        })
        .collect();
    r.insert("drawings2d".into(), Value::Array(moved));
    let again = added(&run(&r, "eg", 100.0));
    assert_eq!(cat_of(&again, "autodim-eg-south-total"), Some("60"));
    assert_eq!(cat_of(&again, "autodim-eg-radius-W1"), Some("60"));
    assert_eq!(cat_of(&again, "autodim-eg-north-total"), Some(crate::standards::AUTO_DIM_CATEGORY));
}

/// Hat die Bogenwand schon ein eigenes Radiusmass, setzt die Auto-Bemassung keins dazu.
#[test]
fn eigenes_radiusmass_genuegt() {
    let mut r = bogenhaus();
    let own = json!({"id": "mass-r", "type": "drawing2d", "levelId": "eg", "categoryCode": "60",
        "geom": {"shape": "dimension", "pts": [{"x": 2.5, "y": 2.0}, {"x": 2.5, "y": -1.2}], "offset": 0, "kind": "radius",
            "refs": [{"id": "W1", "feature": "center"}, {"id": "W1", "feature": "rim", "t": 0}]}});
    r.insert("drawings2d".into(), json!([own]));
    assert!(added(&run(&r, "eg", 100.0)).iter().all(|d| !d["id"].as_str().unwrap().contains("-radius-")));
}
